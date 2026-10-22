// Proof-of-concept host runtime: TV clients (REST, 8002 channel via `ws`, UPnP SOAP, GENA with polling fallback)
// + web server (static, REST, SSE) with Host allowlist, Origin check and CSRF token. Only dependency: ws.
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const WS = createRequire(import.meta.url)('C:/Users/pranj/AppData/Roaming/npm/node_modules/@jackwener/opencli/node_modules/ws');
const RCS = 'urn:schemas-upnp-org:service:RenderingControl:1';
const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const xmlUnesc = (s) => s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (_, n, d, h) =>
  d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[n.toLowerCase()]);

// ---------------- UPnP SOAP ----------------
export async function soap(controlUrl, serviceType, action, args = {}) {
  const argXml = Object.entries(args).map(([k, v]) => `<${k}>${xmlEsc(v)}</${k}>`).join('');
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${serviceType}">${argXml}</u:${action}></s:Body></s:Envelope>`;
  const res = await fetch(controlUrl, { method: 'POST', body, signal: AbortSignal.timeout(3000),
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${serviceType}#${action}"` } });
  const text = await res.text();
  if (!res.ok) {
    const code = /<errorCode>(\d+)<\/errorCode>/.exec(text)?.[1];
    const desc = /<errorDescription>([^<]*)<\/errorDescription>/.exec(text)?.[1];
    throw Object.assign(new Error(`${action}: HTTP ${res.status} UPnP ${code} ${desc}`), { upnpCode: code && +code });
  }
  const inner = new RegExp(`<(?:[\\w-]+:)?${action}Response\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${action}Response>`).exec(text)?.[1] ?? '';
  const out = {};
  for (const [, k, v] of inner.matchAll(/<([\w-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) out[k] = xmlUnesc(v);
  return out;
}

// LastChange: escaped XML inside <LastChange>; returns { Volume: { Master: '7' }, Mute: { Master: '0' } }
export function parseLastChange(propertysetXml) {
  const raw = /<LastChange>([\s\S]*?)<\/LastChange>/.exec(propertysetXml)?.[1];
  if (!raw) return {};
  const xml = xmlUnesc(raw), out = {};
  for (const [, tag, attrs] of xml.matchAll(/<([\w-]+)((?:\s+[\w:-]+="[^"]*")*)\s*\/?>/g)) {
    if (tag === 'Event' || tag === 'InstanceID') continue;
    const a = Object.fromEntries([...attrs.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, k, v]) => [k, xmlUnesc(v)]));
    if ('val' in a) (out[tag] ??= {})[a.channel ?? '_'] = a.val;
  }
  return out;
}

// ---------------- GENA subscriber with "are NOTIFYs reaching us?" detection ----------------
export class GenaSubscriber extends EventEmitter {
  constructor({ eventUrl, callbackHost, callbackPort, path = '/gena/rc', timeoutSec = 300, firstEventMs = 5000 }) {
    super(); Object.assign(this, { eventUrl: new URL(eventUrl), callbackHost, callbackPort, path, timeoutSec, firstEventMs });
    this.sid = null; this.lastSeq = -1; this.delivering = false;
  }
  handleNotify(req, body) { // wire into the HTTP server that listens on callbackHost:callbackPort
    if (!this.sid && this.inFlight) { (this.backlog ??= []).push([{ headers: req.headers }, body]); return 200; } // some devices NOTIFY before the SUBSCRIBE response (async_upnp_client backlog)
    if (req.headers.sid !== this.sid) return 412;
    const seq = +req.headers.seq;
    if (seq !== this.lastSeq + 1 && seq !== 0) this.emit('gap', { expected: this.lastSeq + 1, got: seq }); // resync via Get*
    this.lastSeq = seq; this.delivering = true; clearTimeout(this.firstTimer);
    this.emit('change', parseLastChange(body)); return 200;
  }
  #request(method, headers) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: this.eventUrl.hostname, port: this.eventUrl.port, path: this.eventUrl.pathname, method,
        headers: { HOST: this.eventUrl.host, ...headers }, timeout: 3000 }, (res) => { res.resume(); resolve(res); });
      req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end();
    });
  }
  async subscribe() {
    this.sid = null; this.inFlight = true;
    const res = await this.#request('SUBSCRIBE', { CALLBACK: `<http://${this.callbackHost}:${this.callbackPort}${this.path}>`, NT: 'upnp:event', TIMEOUT: `Second-${this.timeoutSec}` });
    if (res.statusCode !== 200) throw new Error('SUBSCRIBE ' + res.statusCode);
    this.sid = res.headers.sid; this.lastSeq = -1; this.delivering = false; this.inFlight = false;
    for (const [r, b] of (this.backlog ?? []).splice(0)) if (r.headers.sid === this.sid) this.handleNotify(r, b);
    const granted = +(/Second-(\d+)/i.exec(res.headers.timeout || '')?.[1] ?? this.timeoutSec);
    clearTimeout(this.renewTimer); this.renewTimer = setTimeout(() => this.renew(), granted * 800); // renew at 80%
    clearTimeout(this.firstTimer);
    this.firstTimer = setTimeout(() => { if (!this.delivering) this.emit('blocked'); }, this.firstEventMs); // UDA: initial event follows SUBSCRIBE
    return this.sid;
  }
  async renew() {
    try { const r = await this.#request('SUBSCRIBE', { SID: this.sid, TIMEOUT: `Second-${this.timeoutSec}` }); if (r.statusCode !== 200) throw new Error('renew ' + r.statusCode);
      this.renewTimer = setTimeout(() => this.renew(), this.timeoutSec * 800); }
    catch { this.subscribe().catch((e) => this.emit('error', e)); } // 412 => fresh subscription
  }
  async unsubscribe() { clearTimeout(this.renewTimer); clearTimeout(this.firstTimer); if (this.sid) await this.#request('UNSUBSCRIBE', { SID: this.sid }).catch(() => {}); this.sid = null; }
}

// ---------------- 8002 remote channel ----------------
export class RemoteChannel extends EventEmitter {
  constructor({ host, port = 8002, name = 'WebRemote', token, pinFingerprint }) {
    super(); Object.assign(this, { host, port, name, token, pinFingerprint }); this.backoff = 1000; this.ws = null; this.ready = false;
  }
  connect() {
    const q = new URLSearchParams({ name: Buffer.from(this.name).toString('base64') }); if (this.token) q.set('token', this.token);
    const ws = (this.ws = new WS(`wss://${this.host}:${this.port}/api/v2/channels/samsung.remote.control?${q}`, { rejectUnauthorized: false, handshakeTimeout: 35000 }));
    ws.on('upgrade', (res) => { // TOFU pin: chain is self-signed, so verify the leaf fingerprint ourselves
      const fp = res.socket.getPeerCertificate().fingerprint256;
      if (this.pinFingerprint && fp !== this.pinFingerprint) { this.emit('pin-mismatch', fp); ws.terminate(); }
      else if (!this.pinFingerprint) { this.pinFingerprint = fp; this.emit('pin', fp); }
    });
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.event === 'ms.channel.connect') {
        this.ready = true; this.backoff = 1000;
        if (msg.data?.token && msg.data.token !== this.token) { this.token = msg.data.token; this.emit('token', this.token); } // persist!
        this.emit('ready');
      } else if (msg.event === 'ms.channel.unauthorized') this.emit('unauthorized');
      else this.emit('event', msg);
    });
    ws.on('open', () => {
      ws._socket.setKeepAlive(true, 10000);
      this.alive = true; ws.on('pong', () => (this.alive = true));
      this.hb = setInterval(() => { if (!this.alive) return ws.terminate(); this.alive = false; ws.ping(); }, 20000);
    });
    ws.on('error', (e) => this.emit('log', 'ws error ' + e.code));
    ws.on('close', () => {
      clearInterval(this.hb); this.ready = false; this.emit('down');
      if (this.closing) return;
      const delay = this.backoff * (0.8 + Math.random() * 0.4); this.backoff = Math.min(this.backoff * 2, 30000);
      this.retry = setTimeout(() => this.connect(), delay);
    });
  }
  sendKey(key, cmd = 'Click') {
    if (!this.ready) throw new Error('channel not ready');
    this.ws.send(JSON.stringify({ method: 'ms.remote.control', params: { Cmd: cmd, DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' } }));
  }
  close() { this.closing = true; clearTimeout(this.retry); clearInterval(this.hb); this.ws?.close(); }
}

export function localAddressTowards(host, port) { // the PC's LAN address as seen by the TV, without enumerating adapters
  return new Promise((resolve, reject) => { const s = net.connect({ host, port, timeout: 3000 }, () => { resolve(s.localAddress); s.destroy(); }); s.on('error', reject); s.on('timeout', () => s.destroy(new Error('timeout'))); });
}

// ---------------- Web server: static + REST + SSE ----------------
export function createWebServer({ port, bindHost = '127.0.0.1', extraHosts = [], onCommand, getState, gena }) {
  const csrf = crypto.randomBytes(24).toString('base64url');
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...extraHosts.map((h) => `${h}:${port}`)]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  const clients = new Set();
  const broadcast = (type, data) => { const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(frame); };

  const server = http.createServer(async (req, res) => {
    // GENA NOTIFY can share this listener (only needed when the server listens on the LAN address)
    if (req.method === 'NOTIFY' && gena && req.url === gena.path) {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { res.writeHead(gena.handleNotify(req, b)); res.end(); }); return;
    }
    const host = (req.headers.host || '').toLowerCase();
    if (!allowedHosts.has(host)) { res.writeHead(421, { 'content-type': 'text/plain' }); return res.end('misdirected request'); } // DNS rebinding guard
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) { res.writeHead(403); return res.end('bad origin'); }
    const url = new URL(req.url, `http://${host}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'" });
      return res.end(`<!doctype html><meta name="tvr-csrf" content="${csrf}"><title>TV</title><body>remote</body>`);
    }
    if (req.method === 'GET' && url.pathname === '/api/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(getState())); }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(getState())}\n\n`);
      clients.add(res); const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => { clients.delete(res); clearInterval(ka); }); return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (req.headers['x-tvr-csrf'] !== csrf) { res.writeHead(403); return res.end('csrf'); } // custom header => cross-site forms/no-cors fetches can't set it
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) { res.writeHead(415); return res.end(); }
      let b = ''; for await (const d of req) { b += d; if (b.length > 16384) return req.destroy(); }
      try { const r = await onCommand(url.pathname, JSON.parse(b || '{}')); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(r ?? { ok: true })); }
      catch (e) { res.writeHead(502, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
    }
    res.writeHead(404); res.end();
  });
  server.requestTimeout = 2000; // deliberately short in the PoC to prove it does not cut SSE streams (it only bounds receiving the request)
  return { server, broadcast, csrf, listen: () => new Promise((r, j) => { server.once('error', j); server.listen(port, bindHost, r); }) };
}
