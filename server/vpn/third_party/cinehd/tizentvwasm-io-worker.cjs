'use strict';
/* I/O worker behind tizentvwasm-shim.js. Owns the real dgram/net sockets, runs
 * its own event loop while the caller thread is blocked in Atomics.wait, and
 * answers each request through the shared control/data buffers:
 *   control[0] = 1 when the answer is ready, control[1] = rc (>= 0 ok, < 0 is -errno),
 *   control[2] = payload length in data, control[3..] = aux ints (port, ip bytes, revents...). */
const { parentPort, workerData } = require('node:worker_threads');
const dgram = require('node:dgram');
const net = require('node:net');
const dns = require('node:dns');

const control = new Int32Array(workerData.control);
const data = new Uint8Array(workerData.data);
const E = workerData.errorCodes;
const WRITE_HIGH_WATER = 4 * 1024 * 1024;
const DEBUG = !!process.env.WG_SHIM_DEBUG;
function dbg() { if (DEBUG) require('node:fs').appendFileSync(process.env.WG_SHIM_DEBUG, '[io-worker ' + (Date.now() % 100000) + '] ' + Array.from(arguments).join(' ') + String.fromCharCode(10)); }

const sockets = new Map();
let nextFd = 3;

function errnoOf(error) {
  const code = error && error.code;
  if (code && E[code]) return E[code];
  if (code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') return E.EBADF;
  return E.EIO;
}

function reply(rc, payload, aux) {
  let len = 0;
  if (payload && payload.length) { len = Math.min(payload.length, data.length); data.set(payload.subarray(0, len), 0); }
  control[1] = rc; control[2] = len;
  for (let i = 3; i < control.length; i++) control[i] = 0;
  if (aux) aux.slice(0, control.length - 3).forEach((v, i) => { control[3 + i] = v | 0; });
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
}

function wake(s) { const waiters = s.waiters; s.waiters = []; for (const w of waiters) w(); }

function newSocket(type, nonblock) {
  const fd = nextFd++;
  const s = { fd, type, nonblock, udp: null, tcp: null, server: null, rx: [], rxBytes: 0, eof: false, err: 0, connecting: false, connected: false, bound: null, peer: null, accepts: [], waiters: [], opts: new Map(), pendingConnectError: 0 };
  sockets.set(fd, s);
  return s;
}

function attachTcp(s, socket) {
  s.tcp = socket;
  socket.on('data', chunk => { s.rx.push(chunk); s.rxBytes += chunk.length; wake(s); });
  socket.on('end', () => { s.eof = true; wake(s); });
  socket.on('error', error => { s.err = errnoOf(error); if (s.connecting) s.pendingConnectError = s.err; s.connecting = false; wake(s); });
  socket.on('close', () => { s.eof = true; s.connected = false; wake(s); });
  socket.on('drain', () => wake(s));
}

function ensureUdp(s, cb) {
  if (s.udp) { cb(null); return; }
  const socket = dgram.createSocket('udp4');
  s.udp = socket;
  socket.on('message', (msg, rinfo) => { dbg('udp message', s.fd, msg.length, rinfo.address, rinfo.port); s.rx.push({ buf: msg, ip: rinfo.address, port: rinfo.port }); s.rxBytes += msg.length; wake(s); });
  socket.on('error', error => { s.err = errnoOf(error); wake(s); });
  socket.once('listening', () => cb(null));
  socket.once('error', error => cb(error));
  const b = s.bound || { ip: '0.0.0.0', port: 0 };
  try { socket.bind(b.port, b.ip); } catch (error) { cb(error); }
}

function readiness(s, events) {
  if (!s) return PF.POLLNVAL;
  let r = 0;
  if ((events & (PF.POLLIN | PF.POLLRDNORM)) && (s.rx.length || s.eof || s.err || s.accepts.length)) r |= events & (PF.POLLIN | PF.POLLRDNORM);
  if ((events & (PF.POLLOUT | PF.POLLWRNORM)) && (s.type === 'udp' || s.connected || s.err) && !(s.tcp && s.tcp.writableLength > WRITE_HIGH_WATER)) r |= events & (PF.POLLOUT | PF.POLLWRNORM);
  if (s.err) r |= PF.POLLERR;
  if (s.eof) r |= PF.POLLHUP;
  return r;
}
const PF = { POLLIN: 1, POLLRDNORM: 2, POLLRDBAND: 4, POLLPRI: 8, POLLOUT: 16, POLLWRNORM: 32, POLLWRBAND: 64, POLLERR: 128, POLLHUP: 256, POLLNVAL: 512 };

function takeTcp(s, max, peek) {
  const parts = []; let got = 0; let i = 0;
  while (got < max && i < s.rx.length) {
    const chunk = s.rx[i]; const take = Math.min(max - got, chunk.length);
    parts.push(chunk.subarray(0, take)); got += take;
    if (!peek) { if (take === chunk.length) { s.rx.shift(); } else { s.rx[0] = chunk.subarray(take); } } else i++;
  }
  if (!peek) s.rxBytes -= got;
  return Buffer.concat(parts, got);
}

const ops = {
  create(m) {
    if (m.family !== 'af_inet') return reply(-E.EAFNOSUPPORT);
    if (m.type !== 'sock_stream' && m.type !== 'sock_dgram') return reply(-E.ESOCKTNOSUPPORT);
    const s = newSocket(m.type === 'sock_dgram' ? 'udp' : 'tcp', m.nonblock);
    reply(s.fd);
  },
  bind(m, s) {
    s.bound = { ip: m.ip, port: m.port };
    if (s.type === 'udp') ensureUdp(s, error => reply(error ? -errnoOf(error) : 0));
    else reply(0);
  },
  connect(m, s) {
    if (s.type === 'udp') { s.peer = { ip: m.ip, port: m.port }; ensureUdp(s, error => reply(error ? -errnoOf(error) : 0)); return; }
    if (s.connected) return reply(-E.EISCONN);
    if (s.connecting) return reply(-E.EALREADY);
    s.connecting = true; s.pendingConnectError = 0;
    const socket = net.connect({ host: m.ip, port: m.port, localAddress: s.bound && s.bound.ip !== '0.0.0.0' ? s.bound.ip : undefined });
    attachTcp(s, socket);
    socket.once('connect', () => { s.connecting = false; s.connected = true; wake(s); });
    if (s.nonblock) return reply(-E.EINPROGRESS);
    const finish = () => { if (s.connected) reply(0); else if (s.err) reply(-s.err); else s.waiters.push(finish); };
    s.waiters.push(finish);
  },
  listen(m, s) {
    if (s.type !== 'tcp') return reply(-E.EOPNOTSUPP);
    const server = net.createServer(conn => { const c = newSocket('tcp', s.nonblock); c.connected = true; attachTcp(c, conn); s.accepts.push(c.fd); wake(s); });
    s.server = server;
    server.once('error', error => reply(-errnoOf(error)));
    const b = s.bound || { ip: '0.0.0.0', port: 0 };
    server.listen(b.port, b.ip, () => { s.bound = { ip: b.ip, port: server.address().port }; reply(0); });
  },
  accept(m, s) {
    const attempt = () => {
      if (s.accepts.length) return reply(s.accepts.shift());
      if (s.err) return reply(-s.err);
      if (s.nonblock) return reply(-E.EAGAIN);
      s.waiters.push(attempt);
    };
    attempt();
  },
  close(m, s) {
    sockets.delete(s.fd);
    try { if (s.udp) s.udp.close(); } catch (e) {}
    try { if (s.tcp) s.tcp.destroy(); } catch (e) {}
    try { if (s.server) s.server.close(); } catch (e) {}
    reply(0);
  },
  send(m, s, payload) {
    if (s.type === 'udp') {
      const target = m.ip ? { ip: m.ip, port: m.port } : s.peer;
      if (!target) return reply(-E.EDESTADDRREQ);
      ensureUdp(s, error => {
        if (error) return reply(-errnoOf(error));
        s.udp.send(payload, target.port, target.ip, err => { dbg('udp send cb', err && err.message); if (err) { s.err = errnoOf(err); } });
        reply(payload.length);
      });
      return;
    }
    if (s.err) return reply(-s.err);
    if (!s.connected) return reply(-(s.connecting ? E.EAGAIN : E.ENOTCONN));
    if (s.tcp.writableLength > WRITE_HIGH_WATER) {
      if (s.nonblock) return reply(-E.EAGAIN);
      s.waiters.push(() => ops.send(m, s, payload));
      return;
    }
    s.tcp.write(payload);
    reply(payload.length);
  },
  recv(m, s) {
    const attempt = () => {
      if (s.rx.length) {
        if (s.type === 'udp') {
          const d = m.peek ? s.rx[0] : s.rx.shift();
          if (!m.peek) s.rxBytes -= d.buf.length;
          const out = d.buf.subarray(0, Math.min(m.max, d.buf.length));
          return reply(out.length, out, m.from ? [d.port, ...d.ip.split('.').map(Number)] : null);
        }
        const out = takeTcp(s, m.max, m.peek);
        return reply(out.length, out);
      }
      if (s.err) { const e = s.err; s.err = 0; return reply(-e); }
      if (s.eof) return reply(0);
      if (s.nonblock) return reply(-E.EAGAIN);
      s.waiters.push(attempt);
    };
    attempt();
  },
  // Lumen: a poll that finishes (ready or timed out) takes its evaluate closure off every socket it
  // waited on, and registers at most once per socket. Without this, once poll really blocks (the
  // glue patch in tools/vpn/patch-wg-glue.cjs), an idle socket's waiter list grows ~50 entries/s.
  poll(m) {
    let timer = null; let done = false;
    const watched = [];
    const finish = (count, revents) => {
      done = true;
      if (timer) clearTimeout(timer);
      for (const s of watched) { const i = s.waiters.indexOf(evaluate); if (i >= 0) s.waiters.splice(i, 1); }
      reply(count, null, revents);
    };
    const evaluate = () => {
      if (done) return;
      let count = 0; const revents = [];
      for (const f of m.fds) { const r = readiness(sockets.get(f.fd), f.events); revents.push(r); if (r) count++; }
      if (count > 0 || m.timeout === 0) return finish(count, revents);
      for (const f of m.fds) {
        const s = sockets.get(f.fd);
        if (!s || s.waiters.includes(evaluate)) continue;
        s.waiters.push(evaluate);
        if (!watched.includes(s)) watched.push(s);
      }
    };
    if (m.timeout > 0) timer = setTimeout(() => { if (!done) finish(0, m.fds.map(() => 0)); }, m.timeout);
    evaluate();
  },
  sockname(m, s) {
    const a = s.type === 'udp' ? (s.udp ? s.udp.address() : null) : (s.server ? s.server.address() : s.tcp ? { address: s.tcp.localAddress, port: s.tcp.localPort } : null);
    const ip = a && a.address && a.address !== '::' ? a.address : (s.bound ? s.bound.ip : '0.0.0.0');
    reply(0, null, [a ? a.port : (s.bound ? s.bound.port : 0), ...ip.split('.').map(Number)]);
  },
  peername(m, s) {
    const p = s.type === 'udp' ? s.peer : (s.tcp && s.tcp.remoteAddress ? { ip: s.tcp.remoteAddress.replace(/^::ffff:/, ''), port: s.tcp.remotePort } : null);
    if (!p) return reply(-E.ENOTCONN);
    reply(0, null, [p.port, ...p.ip.split('.').map(Number)]);
  },
  setsockopt(m, s) { s.opts.set(m.level + '/' + m.option, m.value); reply(0); },
  getsockopt(m, s) {
    if (m.option === 'so_error') { const e = s.pendingConnectError || 0; s.pendingConnectError = 0; return reply(e); }
    const v = s.opts.get(m.level + '/' + m.option);
    reply(typeof v === 'number' ? v : 0);
  },
  shutdown(m, s) {
    if (s.tcp && (m.how === 'shut_wr' || m.how === 'shut_rdwr')) s.tcp.end();
    reply(0);
  },
  resolve(m) {
    dns.lookup(m.name, { all: true, family: 4 }, (error, records) => {
      if (error) return reply(-E.ENOENT);
      reply(0, Buffer.from(JSON.stringify(records.map(r => r.address))));
    });
  },
};

parentPort.on('message', m => {
  dbg('op', JSON.stringify(m));
  const payload = m.len ? Buffer.from(data.slice(0, m.len)) : null;
  try {
    if (m.op === 'create' || m.op === 'poll' || m.op === 'resolve') return ops[m.op](m, null, payload);
    const s = sockets.get(m.fd);
    if (!s) return reply(-E.EBADF);
    ops[m.op](m, s, payload);
  } catch (error) { reply(-errnoOf(error)); }
});
