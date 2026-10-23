// The VPN's local HTTP proxy for the Browser view's headless Edge: CONNECT host:port for https and
// absolute URIs for http, on 127.0.0.1 only. Every byte goes through tunnel.connect(host, port) with
// the hostname untouched, so names are resolved inside the tunnel; while the tunnel is not up every
// request gets a 502. Fail closed by construction: this file imports neither node:net nor node:dns.
import http from 'node:http';

const HOP_BY_HOP = ['proxy-connection', 'connection', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'upgrade'];
// Hostnames and IPv4 literals; the tunnel is IPv4-only, so bracketed IPv6 literals are refused.
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const REASONS = { 400: 'Bad Request', 502: 'Bad Gateway' };

function tagged(code, message) {
  return Object.assign(new Error(message ?? code), { code });
}

function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** `host:port` from a CONNECT request line → `{ host, port }`, or null when it is not acceptable. */
export function parseAuthority(text) {
  const m = /^([^:/?#@[\]\s]+):(\d{1,5})$/.exec(text ?? '');
  if (!m) return null;
  const port = Number(m[2]);
  return HOST.test(m[1]) && validPort(port) ? { host: m[1], port } : null;
}

/** An absolute `http://` request target → `{ host, port, path }`; relative targets and https are refused. */
export function parseAbsoluteUrl(raw) {
  if (!/^http:\/\//i.test(raw ?? '')) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || url.username || url.password) return null;
  const port = url.port ? Number(url.port) : 80;
  if (!HOST.test(url.hostname) || !validPort(port)) return null;
  return { host: url.hostname, port, path: `${url.pathname}${url.search}` };
}

// Drops hop-by-hop headers, including those the Connection header names (RFC 7230 §6.1).
function endToEndHeaders(headers) {
  const drop = new Set(HOP_BY_HOP);
  for (const name of String(headers.connection ?? '').split(',')) {
    const trimmed = name.trim().toLowerCase();
    if (trimmed) drop.add(trimmed);
  }
  const out = {};
  for (const [name, value] of Object.entries(headers)) if (!drop.has(name)) out[name] = value;
  return out;
}

// A browser keeps idle keep-alive sockets open through the proxy; when every slot is taken, the one
// silent the longest (at least idleEvictMs) is closed for the newcomer and the browser reopens it later.
export function createVpnProxy({ tunnel, log: rootLog, maxStreams = 150, queueMs = 10000, idleEvictMs = 2000 }) {
  const log = rootLog.child('vpn-proxy');
  const server = http.createServer();
  const sockets = new Set(); // client connections (Edge)
  const streams = new Set(); // open tunnel streams
  const waiting = []; // requests queued for a stream slot: { grant, reject, timer }
  const tunnels = new Set(); // established CONNECT tunnels: { socket, up, last } (eviction candidates)
  let evictTimer = null;
  let active = 0;
  let port = null;

  const tunnelUp = () => tunnel.status().state === 'up';

  // ---------- stream slots ----------

  function acquire() {
    if (active < maxStreams) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((grant, reject) => {
      const entry = { grant, reject, timer: null };
      entry.timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(entry), 1);
        reject(tagged('busy', `more than ${maxStreams} connections are open through the VPN`));
      }, queueMs);
      waiting.push(entry);
      evictForWaiters();
    });
  }

  // Closes idle tunnels (oldest silence first) until each waiter has one coming free; while anyone
  // still waits, it looks again as tunnels go quiet.
  function evictForWaiters() {
    clearTimeout(evictTimer);
    evictTimer = null;
    if (!waiting.length) return;
    const now = Date.now();
    const idle = [...tunnels].filter((t) => !t.evicted && now - t.last >= idleEvictMs).sort((a, b) => a.last - b.last);
    const closing = [...tunnels].filter((t) => t.evicted).length;
    for (const t of idle.slice(0, Math.max(0, waiting.length - closing))) {
      t.evicted = true;
      log.debug('closing an idle tunnel for a waiting request', { idleMs: now - t.last });
      t.socket.destroy();
      t.up.destroy();
    }
    if (waiting.length) evictTimer = setTimeout(evictForWaiters, Math.max(100, Math.min(idleEvictMs, 500)));
  }

  // A freed slot passes straight to the next waiter.
  function release() {
    const next = waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant();
    } else {
      active -= 1;
    }
  }

  // Reserves a slot (queued while maxStreams are open) and opens the tunnel stream to host:port.
  async function openStream(host, targetPort) {
    await acquire();
    let up;
    try {
      if (!tunnelUp()) throw tagged('vpn-tunnel-down', 'VPN tunnel is not up');
      up = tunnel.connect(host, targetPort);
    } catch (err) {
      release();
      throw err.code ? err : tagged('vpn-tunnel-down', err.message);
    }
    streams.add(up);
    let released = false;
    const done = () => {
      if (released) return;
      released = true;
      streams.delete(up);
      release();
    };
    up.once('close', done);
    up.once('error', done);
    return up;
  }

  // ---------- replies ----------

  function refuse(socket, status, code) {
    if (socket.destroyed || socket.writableEnded) return;
    const body = `vpn: ${code}\n`;
    socket.end(`HTTP/1.1 ${status} ${REASONS[status]}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  }

  function reply(res, status, code) {
    if (res.headersSent || res.destroyed) return;
    const body = `vpn: ${code}\n`;
    res.writeHead(status, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body), connection: 'close' });
    res.end(body);
  }

  // ---------- CONNECT host:port (https and anything else Edge tunnels) ----------

  async function onConnect(req, socket, head) {
    socket.on('error', () => {}); // a reset from the browser is routine
    const target = parseAuthority(req.url);
    if (!target) return refuse(socket, 400, 'bad-request');
    if (!tunnelUp()) return refuse(socket, 502, 'vpn-tunnel-down');

    let up;
    try {
      up = await openStream(target.host, target.port);
    } catch (err) {
      log.debug('CONNECT refused', { host: target.host, port: target.port, code: err.code });
      return refuse(socket, 502, err.code);
    }
    if (socket.destroyed) return up.destroy();

    let established = false;
    up.once('connect', () => {
      established = true;
      socket.setNoDelay(true);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      const entry = { socket, up, last: Date.now(), evicted: false };
      const touch = () => { entry.last = Date.now(); };
      tunnels.add(entry);
      socket.on('data', touch);
      up.on('data', touch);
      up.once('close', () => tunnels.delete(entry));
      socket.pipe(up).pipe(socket);
      log.debug('CONNECT established', { host: target.host, port: target.port });
    });
    up.once('error', (err) => {
      log.debug('CONNECT failed', { host: target.host, port: target.port, code: err.code, established });
      if (established) socket.destroy();
      else refuse(socket, 502, err.code ?? 'vpn-connect-failed');
    });
    up.once('close', () => {
      if (!established) refuse(socket, 502, 'vpn-stream-closed');
      else if (!socket.destroyed && !socket.writableEnded) socket.end();
    });
    socket.once('close', () => up.destroy());
  }

  // ---------- absolute-URI http requests ----------

  async function onRequest(req, res) {
    const target = parseAbsoluteUrl(req.url);
    if (!target) return reply(res, 400, 'bad-request');
    if (!tunnelUp()) return reply(res, 502, 'vpn-tunnel-down');

    let up;
    try {
      up = await openStream(target.host, target.port);
    } catch (err) {
      log.debug(`${req.method} refused`, { host: target.host, port: target.port, code: err.code });
      return reply(res, 502, err.code);
    }
    if (req.socket.destroyed) return up.destroy();

    const headers = endToEndHeaders(req.headers);
    headers.host ??= target.port === 80 ? target.host : `${target.host}:${target.port}`;
    const upReq = http.request({
      createConnection: () => up,
      host: target.host,
      port: target.port,
      method: req.method,
      path: target.path,
      headers,
      setHost: false,
    });
    upReq.on('response', (upRes) => {
      log.debug(`${req.method} ${upRes.statusCode}`, { host: target.host, port: target.port });
      // The upstream reason phrase and headers are untrusted: Node throws on invalid ones, so use the
      // standard phrase and turn anything Node rejects into a 502 instead of an uncaught exception.
      try {
        res.writeHead(upRes.statusCode, endToEndHeaders(upRes.headers));
      } catch (err) {
        log.debug('invalid upstream response', { host: target.host, code: err.code });
        upRes.destroy();
        if (!res.headersSent) reply(res, 502, 'vpn-bad-upstream-response');
        else res.destroy();
        return;
      }
      upRes.on('error', () => res.destroy());
      upRes.pipe(res);
    });
    upReq.on('error', (err) => {
      log.debug(`${req.method} failed`, { host: target.host, port: target.port, code: err.code });
      if (res.headersSent) res.destroy();
      else reply(res, 502, err.code ?? 'vpn-connect-failed');
    });
    res.on('close', () => { if (!res.writableFinished) upReq.destroy(); });
    req.on('error', () => upReq.destroy());
    req.pipe(upReq);
  }

  server.on('connect', onConnect);
  server.on('request', onRequest);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (err, socket) => {
    if (err.code === 'ECONNRESET' || !socket.writable) return socket.destroy();
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return {
    get port() {
      return port;
    },
    start() {
      if (port !== null) return Promise.resolve({ port });
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          port = server.address().port;
          log.info('vpn proxy listening', { port, maxStreams });
          resolve({ port });
        });
      });
    },
    async stop() {
      clearTimeout(evictTimer);
      for (const entry of waiting.splice(0)) {
        clearTimeout(entry.timer);
        entry.reject(tagged('vpn-proxy-stopped', 'VPN proxy is stopping'));
      }
      for (const socket of sockets) socket.destroy();
      for (const up of streams) up.destroy();
      if (port === null) return;
      await new Promise((resolve) => server.close(() => resolve()));
      log.info('vpn proxy stopped', { port });
      port = null;
    },
  };
}
