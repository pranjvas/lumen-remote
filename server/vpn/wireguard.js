// In-process WireGuard tunnel (follow-up 3, Part A). A port of CineHD's wg-core worker loop
// (wasm/loader.js) and tunnel hub (service/tunnel-hub.js) to Node 22 ESM; protocol facts live in
// docs/build-notes/followup-3-vpn-port-plan.md §5–§7 and third_party/wg-core/src/mux.h.
//
// Main thread: createTunnel() owns a loopback listener (the "hub") that speaks the mux frame
// protocol with the wasm and turns mux streams into Duplex objects. Worker thread (this same file,
// started with workerData.role): instantiates wg-core.wasm through the Tizen sockets shim and runs
// the poll loop; the real UDP/TCP sockets live in the shim's own I/O worker. The wasm dials the hub
// over loopback TCP, so the only thing that ever crosses from main to worker is the conf text.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { serializeWireGuardConf } from './conf.js';

const WORKER_ROLE = 'lumen-vpn-tunnel';
const MUX_HOST = '127.0.0.1';

// Mux frame protocol: u8 type | u32be stream | u32be len | payload.
export const FRAME_TYPES = Object.freeze({
  OPEN: 1, OPENED: 2, DATA: 3, EOF: 4, RST: 5, CREDIT: 6, DNS: 7, DNSANSWER: 8, STATUS: 9, HELLO: 10,
});
const T = FRAME_TYPES;
const HEADER_BYTES = 9;
const MAX_PAYLOAD = 1024 * 1024; // decoder cap; anything larger is a protocol violation
const TX_INITIAL_CREDIT = 65536; // per stream toward the wasm: lwIP's send buffer holds 88,320 bytes
const MAX_DATA_FRAME = 32768; // tcp_write takes a u16 length; small frames keep unacked bytes under TCP_SND_BUF
const CREDIT_GRANT = 32768; // consumed bytes are granted back to the wasm in steps of this size
export const MAX_STREAMS = 250; // the core allows 260 (MUX_MAX_STREAMS, rebuilt for Lumen); keep headroom
const MAX_STREAM_ID = 4294967000;
const HELLO_TIMEOUT_MS = 2000;
const STOP_GRACE_MS = 1000;
const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1', '::1']);
const IPV4_LITERAL = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
// In-tunnel DNS in front of OPEN. lwIP holds DNS_TABLE_SIZE lookups at once (8 in the original
// core, 64 in Lumen's rebuild) and fails the next one at once ("dns-failed"), so the hub keeps
// fewer than that in flight, shares one lookup per name, and remembers answers briefly. Names are
// still resolved only inside the tunnel (DNS frames to the core); nothing here touches node:dns.
export const DNS_MAX_INFLIGHT = 6; // below the original core's 8, so either core works
export const DNS_CACHE_TTL_MS = 60000; // lwIP does not hand the record TTL over the mux
export const DNS_NEGATIVE_TTL_MS = 15000; // a name the DNS server refused (e.g. a filtered ad host)
const DNS_CACHE_MAX = 1024;

// Worker side.
const POLL_MS = 20;
const STATUS_INTERVAL_MS = 1000;
const STATUS_READ_MS = 50; // wg_status at most this often (state changes still reach the hub within it)
const REDIAL_MS = 500;
const STATUS_BUFFER = 2048;

const NOOP_LOG = { debug() {}, info() {}, warn() {}, error() {} };

function codedError(code, message) {
  const err = new Error(message ?? code);
  err.code = code;
  return err;
}

export function encodeFrame(type, stream, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > MAX_PAYLOAD) throw new RangeError('frame payload exceeds 1 MiB');
  const out = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  out[0] = type;
  out.writeUInt32BE(stream, 1);
  out.writeUInt32BE(body.length, 5);
  body.copy(out, HEADER_BYTES);
  return out;
}

// Incremental decoder: onFrame(type, stream, payload) per frame; onError(err) once on a
// protocol violation, after which everything is ignored.
export function createFrameDecoder(onFrame, onError) {
  let pending = Buffer.alloc(0);
  let dead = false;
  return {
    push(chunk) {
      if (dead || !chunk?.length) return;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (!dead && pending.length >= HEADER_BYTES) {
        const type = pending[0];
        const stream = pending.readUInt32BE(1);
        const length = pending.readUInt32BE(5);
        if (type < 1 || type > 10 || length > MAX_PAYLOAD) {
          dead = true;
          pending = Buffer.alloc(0);
          const reason = type < 1 || type > 10 ? `unknown frame type ${type}` : `frame payload exceeds 1 MiB (${length} bytes)`;
          onError(codedError('mux-protocol-error', reason));
          return;
        }
        if (pending.length < HEADER_BYTES + length) return;
        const payload = pending.subarray(HEADER_BYTES, HEADER_BYTES + length);
        pending = pending.subarray(HEADER_BYTES + length);
        onFrame(type, stream, payload);
      }
    },
  };
}

// Duplex with the net.Socket surface http.request() and proxy code touch.
class SocketLikeDuplex extends Duplex {
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
}

// A stream that fails on the next tick: what connect() hands out when the tunnel cannot open one.
class FailedStream extends SocketLikeDuplex {
  constructor(err) {
    super({ allowHalfOpen: true });
    this.failure = err;
    this.pendingCb = null;
    process.nextTick(() => this.destroy(this.listenerCount('error') ? err : undefined));
  }
  _read() {}
  _write(chunk, encoding, cb) { this.pendingCb = cb; }
  _destroy(err, cb) {
    this.pendingCb?.(err ?? this.failure);
    cb(err);
  }
}

// One mux stream: an lwIP TCP connection inside the tunnel, opened by the hub.
class TunnelStream extends SocketLikeDuplex {
  constructor(hub, id, openTimeoutMs) {
    super({ allowHalfOpen: true });
    this.hub = hub;
    this.id = id;
    this.opened = false;
    this.released = false; // the id is gone on the far side (RST, both EOFs, link lost): no frames may follow
    this.txCredit = TX_INITIAL_CREDIT;
    this.rxUnacked = 0;
    this.remoteEof = false;
    this.localEof = false;
    this.pending = null;
    this.failure = null;
    this.openSent = false; // OPEN went to the core (after the hub's DNS lookup for a hostname)
    this.dnsName = null; // the hostname this stream was opened by, if any
    this.openTimer = setTimeout(() => this.fail('vpn-open-timeout', 'tunnel stream open timed out'), openTimeoutMs);
  }

  _write(chunk, encoding, cb) {
    this.pending = { chunk, cb };
    this.flushWrites();
  }

  // DATA frames of at most MAX_DATA_FRAME bytes while credit remains; CREDIT frames refill it.
  flushWrites() {
    const p = this.pending;
    if (!p || !this.opened || this.released) return;
    while (p.chunk.length && this.txCredit > 0) {
      const n = Math.min(p.chunk.length, this.txCredit, MAX_DATA_FRAME);
      this.hub.send(T.DATA, this.id, p.chunk.subarray(0, n));
      p.chunk = p.chunk.subarray(n);
      this.txCredit -= n;
    }
    if (!p.chunk.length) {
      this.pending = null;
      p.cb();
    }
  }

  _final(cb) {
    this.localEof = true;
    if (!this.released) this.hub.send(T.EOF, this.id);
    cb();
    this.maybeRelease();
  }

  // The consumer wants more: grant the wasm credit for what it has already taken.
  _read() {
    if (this.rxUnacked >= CREDIT_GRANT && !this.released && !this.remoteEof) {
      const credit = Buffer.allocUnsafe(4);
      credit.writeUInt32BE(this.rxUnacked, 0);
      this.hub.send(T.CREDIT, this.id, credit);
      this.rxUnacked = 0;
    }
  }

  _destroy(err, cb) {
    clearTimeout(this.openTimer);
    if (!this.released) {
      this.released = true;
      if (this.openSent) this.hub.send(T.RST, this.id, err?.code ? String(err.code) : 'closed');
      this.hub.release(this.id);
    }
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.cb(err ?? this.failure ?? codedError('vpn-stream-closed', 'tunnel stream destroyed'));
    }
    cb(err);
  }

  onOpened() {
    if (this.released || this.opened) return;
    this.opened = true;
    clearTimeout(this.openTimer);
    this.emit('connect');
    this.flushWrites();
  }

  onData(payload) {
    if (this.released || this.remoteEof) return;
    this.rxUnacked += payload.length;
    this.push(payload);
  }

  onEof() {
    if (this.released || this.remoteEof) return;
    this.remoteEof = true;
    this.push(null);
    this.maybeRelease();
  }

  onCredit(bytes) {
    this.txCredit += bytes;
    this.flushWrites();
  }

  maybeRelease() {
    if (this.remoteEof && this.localEof && !this.released) {
      this.released = true;
      this.hub.release(this.id);
    }
  }

  // Remote RST or link loss: the far side already forgot the stream, so no RST goes back.
  fail(code, message) {
    if (this.released) return;
    this.released = true;
    clearTimeout(this.openTimer);
    this.hub.release(this.id);
    if (!this.opened && this.openSent && this.dnsName) this.hub.forgetDns(this.dnsName); // maybe a stale address
    this.failure = codedError(code, message ?? `tunnel stream reset: ${code}`);
    this.destroy(this.listenerCount('error') ? this.failure : undefined);
  }
}

class Tunnel extends EventEmitter {
  #conf;
  #log;
  #openTimeoutMs;
  #dnsTimeoutMs;
  #startTimeoutMs;
  #phase = 'stopped'; // 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  #state = 'stopped';
  #server = null;
  #worker = null;
  #workerAlive = false;
  #workerStarted = false;
  #link = null;
  #linked = false;
  #core = null; // latest wg_status JSON from the worker (postMessage) or the mux (STATUS frame)
  #wasUp = false;
  #lastError = null;
  #streams = new Map();
  #nextId = 1;
  #dnsPending = new Map(); // name -> waiters [{ resolve, reject, timer }]
  #dnsCache = new Map(); // name -> { ip | null, expires } (insertion order = age)
  #dnsQueue = []; // names waiting for an in-flight slot
  #dnsInflight = new Set(); // names sent to the core, answer not yet back
  #pendingStart = null;
  #startPromise = null;
  #stopPromise = null;
  #shutdownPromise = null;

  constructor({ conf, log, openTimeoutMs, dnsTimeoutMs, startTimeoutMs }) {
    super();
    this.#conf = conf;
    this.#log = log?.child ? log.child('vpn') : NOOP_LOG;
    this.#openTimeoutMs = openTimeoutMs;
    this.#dnsTimeoutMs = dnsTimeoutMs;
    this.#startTimeoutMs = startTimeoutMs;
  }

  // Loopback port of the hub listener (tests only).
  get port() {
    return this.#server?.address()?.port ?? null;
  }

  start() {
    if (this.#startPromise) return this.#startPromise;
    if (this.#phase === 'running' || this.#phase === 'starting') return Promise.resolve();
    this.#startPromise = this.#start().finally(() => { this.#startPromise = null; });
    return this.#startPromise;
  }

  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = this.#stop().finally(() => { this.#stopPromise = null; });
    return this.#stopPromise;
  }

  status() {
    const core = this.#core ?? {};
    return {
      state: this.#state,
      handshake: core.handshake ?? 'pending',
      handshakeAgeMs: core.handshakeAgeMs ?? 0,
      retries: core.retries ?? 0,
      rx: core.rx ?? 0,
      tx: core.tx ?? 0,
      endpoint: this.#conf.peer.endpoint,
      uptimeMs: core.uptimeMs ?? 0,
      linked: this.#linked,
      streams: this.#streams.size,
      lastError: this.#lastError ?? (core.lastError || null),
    };
  }

  // Opens host:port inside the tunnel. A hostname is first resolved through the tunnel's DNS
  // (resolve(): shared, limited, briefly cached), then OPEN carries "port:ip"; the hostname still
  // reaches the far side in TLS SNI and the Host header. Lookup failures reset the stream with
  // the same "dns-failed" code the core uses.
  connect(host, port) {
    if (this.#state !== 'up') return new FailedStream(codedError('vpn-tunnel-down', `VPN tunnel is not up (${this.#state})`));
    if (this.#streams.size >= MAX_STREAMS) return new FailedStream(codedError('vpn-too-many-streams', `tunnel already has ${MAX_STREAMS} open streams`));
    const id = this.#nextId;
    this.#nextId = id >= MAX_STREAM_ID ? 1 : id + 1;
    const stream = new TunnelStream(this, id, this.#openTimeoutMs);
    this.#streams.set(id, stream);
    this.#log.debug('stream open', { id, host, port });
    if (IPV4_LITERAL.test(host)) {
      stream.openSent = true;
      this.send(T.OPEN, id, `${port}:${host}`);
      return stream;
    }
    stream.dnsName = host;
    this.resolve(host).then(
      (ip) => {
        if (stream.released) return;
        stream.openSent = true;
        this.send(T.OPEN, id, `${port}:${ip}`);
      },
      (err) => {
        const code = err.code === 'vpn-dns-failed' || err.code === 'vpn-dns-timeout' ? 'dns-failed' : err.code;
        stream.fail(code, err.message);
      },
    );
    return stream;
  }

  resolve(host) {
    if (IPV4_LITERAL.test(host)) return Promise.resolve(host);
    if (this.#state !== 'up') return Promise.reject(codedError('vpn-tunnel-down', `VPN tunnel is not up (${this.#state})`));
    const cached = this.#dnsCache.get(host);
    if (cached) {
      if (cached.expires > Date.now()) {
        return cached.ip ? Promise.resolve(cached.ip) : Promise.reject(codedError('vpn-dns-failed', `tunnel DNS could not resolve ${host}`));
      }
      this.#dnsCache.delete(host);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#settleDns(host, codedError('vpn-dns-timeout', `tunnel DNS timed out for ${host}`)), this.#dnsTimeoutMs);
      const waiting = this.#dnsPending.get(host);
      if (waiting) {
        waiting.push({ resolve, reject, timer });
      } else {
        this.#dnsPending.set(host, [{ resolve, reject, timer }]);
        this.#queueDns(host);
      }
    });
  }

  // A stream opened by name failed before OPENED: the cached address may be stale, ask again next time.
  forgetDns(name) {
    this.#dnsCache.delete(name);
  }

  // Sends a DNS frame when fewer than DNS_MAX_INFLIGHT names are in the core, else queues the name.
  #queueDns(name) {
    if (this.#dnsInflight.has(name)) return; // an earlier lookup (timed out here) is still in the core
    if (this.#dnsInflight.size >= DNS_MAX_INFLIGHT) {
      this.#dnsQueue.push(name);
      return;
    }
    this.#dnsInflight.add(name);
    if (!this.send(T.DNS, 0, name)) this.#dnsInflight.delete(name);
  }

  #pumpDns() {
    while (this.#dnsQueue.length && this.#dnsInflight.size < DNS_MAX_INFLIGHT) {
      const name = this.#dnsQueue.shift();
      if (this.#dnsPending.has(name)) this.#queueDns(name); // skipped when every waiter already timed out
    }
  }

  #cacheDns(name, ip) {
    this.#dnsCache.delete(name);
    if (!ip && this.#state !== 'up') return; // the core answers "no address" while it is not up: not a real answer
    if (this.#dnsCache.size >= DNS_CACHE_MAX) this.#dnsCache.delete(this.#dnsCache.keys().next().value);
    this.#dnsCache.set(name, { ip, expires: Date.now() + (ip ? DNS_CACHE_TTL_MS : DNS_NEGATIVE_TTL_MS) });
  }

  #resetDns() {
    for (const name of [...this.#dnsPending.keys()]) this.#settleDns(name, codedError('vpn-link-lost', 'tunnel link lost'));
    this.#dnsQueue = [];
    this.#dnsInflight.clear();
    this.#dnsCache.clear();
  }

  // Used by TunnelStream.
  send(type, id, payload) {
    if (!this.#link || this.#link.destroyed) return false;
    this.#link.write(encodeFrame(type, id, payload));
    return true;
  }

  release(id) {
    this.#streams.delete(id);
  }

  async #start() {
    if (this.#stopPromise) await this.#stopPromise;
    if (this.#worker) await this.#shutdownWorker(); // leftovers of a failed run
    this.#phase = 'starting';
    this.#wasUp = false;
    this.#core = null;
    this.#lastError = null;
    this.#resetDns();
    this.#workerStarted = false;
    this.#setState();
    try {
      await this.#listen();
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { role: WORKER_ROLE, confText: serializeWireGuardConf(this.#conf), muxPort: this.port },
      });
      this.#worker = worker;
      this.#workerAlive = true;
      worker.on('message', (msg) => this.#onWorkerMessage(worker, msg));
      worker.on('error', (err) => this.#onWorkerFailure(worker, codedError('worker-crashed', err?.message ?? String(err))));
      worker.on('exit', (code) => this.#onWorkerExit(worker, code));
      this.#log.debug('tunnel worker spawned', { hubPort: this.port });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(codedError('vpn-start-timeout', `tunnel did not start within ${this.#startTimeoutMs} ms`)), this.#startTimeoutMs);
        this.#pendingStart = {
          resolve: () => { clearTimeout(timer); resolve(); },
          reject: (err) => { clearTimeout(timer); reject(err); },
        };
      });
      this.#phase = 'running';
      this.#setState();
    } catch (err) {
      this.#pendingStart = null;
      await this.#shutdownWorker();
      if (this.#phase === 'starting') {
        this.#phase = 'error';
        this.#lastError = err.message;
      }
      this.#setState();
      this.#log.warn('tunnel start failed', err);
      throw err;
    }
  }

  async #stop() {
    const pending = this.#pendingStart;
    this.#pendingStart = null;
    this.#phase = this.#worker ? 'stopping' : 'stopped';
    this.#setState();
    pending?.reject(codedError('vpn-tunnel-down', 'tunnel stopped'));
    this.#failStreams('vpn-tunnel-down', 'tunnel stopped');
    await this.#shutdownWorker();
    this.#phase = 'stopped';
    this.#core = null;
    this.#wasUp = false;
    this.#setState();
    this.#log.info('tunnel stopped');
  }

  // Ends the worker (gracefully, else terminate()), drops the link and closes the listener.
  #shutdownWorker() {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdownPromise = (async () => {
      const worker = this.#worker;
      if (worker && this.#workerAlive) {
        const exited = new Promise((resolve) => worker.once('exit', resolve));
        const timer = setTimeout(() => worker.terminate().catch(() => {}), STOP_GRACE_MS);
        try { worker.postMessage({ cmd: 'stop' }); } catch { /* port already closed: the timer terminates it */ }
        await exited;
        clearTimeout(timer);
      }
      this.#worker = null;
      this.#dropLink('tunnel stopped');
      const server = this.#server;
      this.#server = null;
      if (server) await new Promise((resolve) => server.close(() => resolve()));
    })().finally(() => { this.#shutdownPromise = null; });
    return this.#shutdownPromise;
  }

  #listen() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.#onConnection(socket));
      server.once('error', reject);
      server.listen(0, MUX_HOST, () => {
        server.off('error', reject);
        server.on('error', (err) => this.#log.warn('hub listener error', err));
        this.#server = server;
        resolve();
      });
    });
  }

  // The wasm dials once per start (and every 500 ms until linked). Anything else on this port is
  // another local process: refuse it. The first frame must be HELLO within 2 s.
  #onConnection(socket) {
    const accepting = this.#phase === 'starting' || this.#phase === 'running';
    if (!accepting || this.#link || !LOOPBACK.has(socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    this.#link = socket;
    this.#linked = false;
    socket.setNoDelay(true);
    const decoder = createFrameDecoder(
      (type, id, payload) => this.#onFrame(socket, type, id, payload),
      (err) => { if (this.#link === socket) this.#dropLink(err.message); },
    );
    const helloTimer = setTimeout(() => {
      if (this.#link === socket && !this.#linked) this.#dropLink('no HELLO within 2 s');
    }, HELLO_TIMEOUT_MS);
    socket.on('data', (chunk) => { if (this.#link === socket) decoder.push(chunk); });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (this.#link === socket) this.#dropLink('link closed');
    });
    socket.write(encodeFrame(T.HELLO, 0, JSON.stringify({ muxVersion: 1 })));
  }

  #onFrame(socket, type, id, payload) {
    if (this.#link !== socket) return;
    if (!this.#linked) {
      if (type !== T.HELLO) {
        this.#dropLink('first frame was not HELLO');
        return;
      }
      this.#linked = true;
      this.#log.debug('mux link up');
      this.#setState();
      this.#maybeStarted();
      return;
    }
    switch (type) {
      case T.HELLO:
        return;
      case T.STATUS:
        try { this.#onCoreStatus(JSON.parse(payload.toString('utf8')), false); } catch { /* malformed status: keep the last one */ }
        return;
      case T.DNSANSWER:
        this.#onDnsAnswer(payload.toString('utf8'));
        return;
      default:
    }
    const stream = this.#streams.get(id);
    if (!stream) {
      if (type !== T.RST && type !== T.EOF) this.send(T.RST, id, 'unknown-stream');
      return;
    }
    switch (type) {
      case T.OPENED: stream.onOpened(); break;
      case T.DATA: stream.onData(payload); break;
      case T.EOF: stream.onEof(); break;
      case T.RST: stream.fail(payload.length ? payload.toString('utf8', 0, 64) : 'reset'); break;
      case T.CREDIT: stream.onCredit(payload.length >= 4 ? payload.readUInt32BE(0) : 0); break;
      default: // OPEN and DNS only travel hub → wasm
    }
  }

  #onDnsAnswer(text) {
    const eq = text.indexOf('=');
    if (eq < 0) return;
    const name = text.slice(0, eq);
    const ip = text.slice(eq + 1);
    this.#dnsInflight.delete(name);
    const ok = IPV4_LITERAL.test(ip);
    this.#cacheDns(name, ok ? ip : null);
    if (ok) this.#settleDns(name, null, ip);
    else this.#settleDns(name, codedError('vpn-dns-failed', `tunnel DNS could not resolve ${name}`));
    this.#pumpDns();
  }

  #settleDns(name, err, ip) {
    const waiting = this.#dnsPending.get(name);
    if (!waiting) return;
    this.#dnsPending.delete(name);
    for (const entry of waiting) {
      clearTimeout(entry.timer);
      if (err) entry.reject(err); else entry.resolve(ip);
    }
  }

  #dropLink(reason) {
    const socket = this.#link;
    if (!socket) return;
    this.#link = null;
    this.#linked = false;
    this.#failStreams('vpn-link-lost', `tunnel link lost (${reason})`);
    this.#resetDns();
    socket.destroy();
    this.#log.debug('mux link down', { reason });
    this.#setState();
  }

  #failStreams(code, message) {
    for (const stream of [...this.#streams.values()]) stream.fail(code, message);
    this.#streams.clear();
  }

  #onWorkerMessage(worker, msg) {
    if (worker !== this.#worker || !msg) return;
    switch (msg.t) {
      case 'ready': this.#log.debug('wasm ready', { selftest: msg.selftest }); break;
      case 'started': this.#workerStarted = true; this.#maybeStarted(); break;
      case 'status': this.#onCoreStatus(msg.status, true); break;
      case 'log': this.#log.debug(`wasm: ${msg.line}`); break;
      case 'error': {
        const err = codedError(msg.code, msg.message);
        if (msg.rc !== undefined) err.rc = msg.rc;
        this.#onWorkerFailure(worker, err);
        break;
      }
      default: // 'stopped' precedes the worker's own exit
    }
  }

  #onCoreStatus(status, fromWorker) {
    if (!status || typeof status !== 'object') return;
    this.#core = status;
    this.#setState();
    if (fromWorker) this.emit('status', this.status());
  }

  #maybeStarted() {
    if (this.#workerStarted && this.#linked && this.#pendingStart) {
      const pending = this.#pendingStart;
      this.#pendingStart = null;
      pending.resolve();
    }
  }

  // Worker posted an error, threw, or exited on its own.
  #onWorkerFailure(worker, err) {
    if (worker !== this.#worker) return;
    if (this.#phase === 'stopping' || this.#phase === 'stopped' || this.#phase === 'error') return;
    const wasRunning = this.#phase === 'running';
    this.#phase = 'error';
    this.#lastError = err.message;
    this.#log.error('tunnel failed', err);
    this.#dropLink('worker failed');
    this.#setState();
    if (this.#pendingStart) {
      const pending = this.#pendingStart;
      this.#pendingStart = null;
      pending.reject(err);
      return;
    }
    void this.#shutdownWorker();
    if (!wasRunning) return;
    if (err.code === 'vpn-worker-exit') this.emit('exit', { code: err.exitCode });
    else if (this.listenerCount('error')) this.emit('error', err);
  }

  #onWorkerExit(worker, code) {
    if (worker !== this.#worker) return;
    this.#workerAlive = false;
    const err = codedError('vpn-worker-exit', `tunnel worker exited (code ${code})`);
    err.exitCode = code;
    this.#onWorkerFailure(worker, err);
  }

  #deriveState() {
    if (this.#phase === 'stopped' || this.#phase === 'stopping') return 'stopped';
    if (this.#phase === 'error') return 'error';
    if (this.#linked && this.#core?.handshake === 'ok') return 'up';
    if (this.#wasUp) return 'down';
    return this.#core?.state === 'handshaking' ? 'handshaking' : 'starting';
  }

  #setState() {
    const next = this.#deriveState();
    if (next === this.#state) return;
    const from = this.#state;
    this.#state = next;
    if (next === 'up') this.#wasUp = true;
    this.#log.info(`tunnel ${next}`, { from, endpoint: this.#conf.peer.endpoint });
    if (next === 'up') this.emit('up');
    else if (next === 'down') this.emit('down');
  }
}

export function createTunnel({ conf, log, openTimeoutMs = 15000, dnsTimeoutMs = 10000, startTimeoutMs = 15000 } = {}) {
  if (!conf?.peer?.endpoint) throw new TypeError('createTunnel needs a parsed WireGuard conf');
  return new Tunnel({ conf, log, openTimeoutMs, dnsTimeoutMs, startTimeoutMs });
}

// ---------------------------------------------------------------------------------------------
// Worker body: wg-core.wasm + Tizen sockets shim + poll loop. Runs only in the Worker that
// createTunnel() spawns. workerData.confText never leaves this thread.

async function runWorker() {
  const { confText, muxPort } = workerData;
  const post = (msg) => parentPort.postMessage(msg);
  let shim = null;
  let Module = null;
  let running = false;
  let failed = false;

  const exit = (code) => {
    try { shim?.shutdownShim(); } catch { /* I/O worker already gone */ }
    setImmediate(() => process.exit(code)); // ends this thread only
  };
  const fail = (code, message, extra = {}) => {
    if (failed) return;
    failed = true;
    running = false;
    post({ t: 'error', code, message: String(message ?? code), ...extra });
    exit(1);
  };
  const readStatus = () => {
    const ptr = Module._malloc(STATUS_BUFFER);
    try {
      const rc = Module.ccall('wg_status', 'number', ['number', 'number'], [ptr, STATUS_BUFFER]);
      return rc === 0 ? JSON.parse(Module.UTF8ToString(ptr)) : null;
    } catch {
      return null;
    } finally {
      Module._free(ptr);
    }
  };
  const dialHub = () => Module.ccall('wg_mux_connect', 'number', ['string', 'number'], [MUX_HOST, muxPort]);

  try {
    globalThis.self = globalThis; // the Samsung fork references the worker global `self` on the node target too
    const require = createRequire(import.meta.url);
    shim = require('./third_party/cinehd/tizentvwasm-shim.cjs');
    shim.installTizenSocketsShim(globalThis); // must precede createWgCore(): the glue reads `tizentvwasm` at instantiation
    const createWgCore = require('./third_party/wg-core/wg-core.cjs');
    Module = await new Promise((resolve, reject) => {
      let initialised = false;
      const m = {
        wasmBinary: fs.readFileSync(new URL('./third_party/wg-core/wg-core.wasm', import.meta.url)),
        print: (line) => post({ t: 'log', line: String(line) }),
        printErr: (line) => post({ t: 'log', line: `ERR ${line}` }),
        onRuntimeInitialized() {
          initialised = true;
          delete m.then; // MODULARIZE makes the module a thenable; resolving with it would recurse
          resolve(m);
        },
        onAbort(reason) {
          if (initialised) fail('wasm-abort', reason);
          else reject(new Error(`wasm abort: ${reason}`));
        },
      };
      createWgCore(m);
    });
  } catch (err) {
    fail('load-failed', err?.message ?? err);
    return;
  }

  const selftest = Module.ccall('wg_selftest', 'number', [], []);
  post({ t: 'ready', selftest });
  if (selftest !== 0) {
    fail('selftest-failed', `wg_selftest reported ${selftest} failing vectors`);
    return;
  }

  const rc = Module.ccall('wg_start', 'number', ['string'], [confText]);
  if (rc !== 0) {
    fail('start-failed', `wg_start returned ${rc}: ${readStatus()?.lastError ?? ''}`, { rc });
    return;
  }
  const mrc = dialHub();
  if (mrc !== 0) {
    Module.ccall('wg_stop', null, [], []);
    fail('mux-connect-failed', `wg_mux_connect returned ${mrc}`, { rc: mrc });
    return;
  }
  running = true;
  post({ t: 'started' });

  let lastPost = 0;
  let lastRead = 0;
  let lastKey = '';
  let lastDial = Date.now();
  const postStatus = (status) => {
    lastPost = Date.now();
    post({ t: 'status', status, heap: Module.HEAP8.length });
  };

  parentPort.on('message', (msg) => {
    if (msg?.cmd === 'status') {
      postStatus(readStatus());
    } else if (msg?.cmd === 'stop') {
      running = false;
      try { Module.ccall('wg_stop', null, [], []); } catch { /* already down */ }
      post({ t: 'stopped' });
      exit(0);
    }
  });

  // wg_poll(20) blocks this thread for up to 20 ms; setImmediate lets parentPort messages in between.
  const loop = () => {
    if (!running) return;
    try {
      Module.ccall('wg_poll', 'number', ['number'], [POLL_MS]);
    } catch (err) {
      fail('poll-failed', err?.message ?? err);
      return;
    }
    if (!running) return;
    const now = Date.now();
    // wg_status costs a malloc, a JSON snprintf in the wasm and a JSON.parse; under load wg_poll
    // returns hundreds of times a second, so read it at most every STATUS_READ_MS.
    if (now - lastRead < STATUS_READ_MS) {
      setImmediate(loop);
      return;
    }
    lastRead = now;
    const status = readStatus();
    if (status) {
      const key = `${status.state}|${status.handshake}|${status.mux?.linked}`;
      if (key !== lastKey || now - lastPost >= STATUS_INTERVAL_MS) {
        lastKey = key;
        postStatus(status);
      }
      if (status.mux && !status.mux.linked && now - lastDial > REDIAL_MS) {
        lastDial = now;
        try { dialHub(); } catch { /* retried on the next slice */ }
      }
    }
    setImmediate(loop);
  };
  loop();
}

if (!isMainThread && workerData?.role === WORKER_ROLE) runWorker();
