// Browser-facing server on 127.0.0.1 (spec §3.3): static UI from an in-memory map, /api/health,
// /api/icon/<appId>, /api/screen.png, POST /api/cast/upload, /mcp (loopback only) and the WebSocket /live.
// Host and Origin allowlists (built from the bound port) guard every request and upgrade.
import http from 'node:http';
import { discoverLanAddress } from './lan.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { REPO_ROOT, VERSION } from './config.js';

const WEB_DIR = path.join(REPO_ROOT, 'web');
const PING_MS = 20000;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const CLOSE_GRACE_MS = 300;
const APP_ID = /^[\w.-]{1,64}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// Every file under web/ keyed by URL path ('/css/app.css'); '/' is index.html. Requests are
// answered from this map only, so a URL can never reach the disk.
export function loadStatic(dir = WEB_DIR) {
  const files = new Map();
  let entries;
  try {
    entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    const rel = path.relative(dir, full).split(path.sep).join('/');
    if (rel.split('/').some((part) => part.startsWith('.'))) continue;
    const body = fs.readFileSync(full);
    files.set(`/${rel}`, {
      body,
      type: MIME[path.extname(rel).toLowerCase()] ?? 'application/octet-stream',
      etag: `"${createHash('sha1').update(body).digest('base64url')}"`,
    });
  }
  if (files.has('/index.html')) files.set('/', files.get('/index.html'));
  return files;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const isLoopback = (address) => /^(?:127\.|::1$|::ffff:127\.)/.test(String(address ?? ''));

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function ackId(id) {
  if (typeof id === 'string' && id.length <= 128) return id;
  return Number.isFinite(id) ? id : null;
}

export async function createHttp({ config, log: rootLog, store, lan, hub, adapters = {}, features = {} }) {
  const log = rootLog.child('http');
  const files = loadStatic();
  if (!files.has('/')) log.warn('web/index.html not found; the UI will not load');
  const startedAt = Date.now();
  const sockets = new Set();
  const alive = new WeakMap();
  let allowedHosts = new Set();
  let allowedOrigins = new Set();
  let csp = '';

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  const server = http.createServer((req, res) => {
    onRequest(req, res).catch((err) => {
      log.error('request failed', err);
      if (!res.headersSent) reply(res, 500, 'Internal error');
      else res.destroy();
    });
  });
  server.requestTimeout = 0; // uploads of large files must not be cut off
  server.headersTimeout = 20000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', onUpgrade);
  server.on('clientError', (err, socket) => socket.destroy());

  // With lanAccess the server listens on every interface, but only the PC's LAN address (the one that
  // routes to the TV, i.e. the home Wi-Fi) joins the Host/Origin allowlists.
  const bindHost = config.http.lanAccess ? '0.0.0.0' : config.http.host;
  await listen(server, config.http.port, bindHost);
  const port = server.address().port;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!['127.0.0.1', 'localhost', '0.0.0.0', '::'].includes(config.http.host)) hosts.push(`${config.http.host}:${port}`);
  let lanUrl = null;
  if (config.http.lanAccess) {
    const address = (await lan?.ready?.catch(() => null))?.address ?? await discoverLanAddress(config.tv.host).catch(() => null);
    if (address && !hosts.includes(`${address}:${port}`)) hosts.push(`${address}:${port}`);
    lanUrl = address ? `http://${address}:${port}` : null;
    if (!address) log.warn('lanAccess is on but the LAN address could not be found; only localhost is allowed');
  }
  allowedHosts = new Set(hosts);
  allowedOrigins = new Set(hosts.map((host) => `http://${host}`));
  csp = [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${hosts.map((host) => `ws://${host}`).join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');

  function reply(res, status, body = '', headers = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(text);
  }

  async function onRequest(req, res) {
    if (!allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) return reply(res, 421, 'Misdirected request');
    const { origin } = req.headers;
    if (origin !== undefined && !allowedOrigins.has(origin)) return reply(res, 403, 'Forbidden');
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://lumen').pathname);
    } catch {
      return reply(res, 400, 'Bad request');
    }
    if (pathname === '/api/health') return health(req, res);
    if (pathname.startsWith('/api/icon/')) return icon(req, res, pathname.slice('/api/icon/'.length));
    if (pathname === '/api/screen.png') return screen(req, res);
    if (pathname === '/api/cast/upload') return upload(req, res);
    if (pathname === '/api/vpn/config') return vpnConfig(req, res);
    if (pathname === '/mcp') return mcp(req, res);
    if (pathname.startsWith('/api/')) return reply(res, 404, 'Not found');
    return serveStatic(req, res, pathname);
  }

  function readOnly(req, res) {
    if (req.method === 'GET' || req.method === 'HEAD') return true;
    reply(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return false;
  }

  function health(req, res) {
    if (!readOnly(req, res)) return;
    reply(res, 200, {
      ok: true,
      app: 'lumen',
      version: VERSION,
      pid: process.pid,
      uptimeS: Math.round((Date.now() - startedAt) / 1000),
      tv: store.get('conn.tv')?.v ?? 'unknown',
    });
  }

  async function icon(req, res, appId) {
    if (!readOnly(req, res)) return;
    if (!APP_ID.test(appId) || typeof adapters.agent?.getIcon !== 'function') return reply(res, 404, 'Not found');
    let found = null;
    try {
      found = await adapters.agent.getIcon(appId);
    } catch (err) {
      log.debug('icon lookup failed', { code: err?.code, message: err?.message });
    }
    if (!found?.buffer) return reply(res, 404, 'Not found');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': found.type ?? 'image/png',
      'Content-Length': found.buffer.length,
      'Cache-Control': 'private, max-age=86400',
    });
    res.end(req.method === 'HEAD' ? undefined : found.buffer);
  }

  // The latest still of the TV screen from Lumen Eyes (taken by the screen.capture command or the AI).
  function screen(req, res) {
    if (!readOnly(req, res)) return;
    const latest = adapters.eyes?.latest?.();
    if (!latest?.png) return reply(res, 404, 'Not found');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'image/png',
      'Content-Length': latest.png.length,
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : latest.png);
  }

  // "Use a config file" for the VPN: the .conf text in the body (same-origin, CSRF header, 8 KB max).
  // The reply carries only the summary (endpoint, tunnel address), never key material.
  async function vpnConfig(req, res) {
    if (req.method !== 'POST') return reply(res, 405, 'Method not allowed', { Allow: 'POST' });
    if (!allowedOrigins.has(req.headers.origin) || !safeEqual(req.headers['x-lumen-csrf'], config.csrf)) {
      return reply(res, 403, 'Forbidden');
    }
    if (typeof features.vpn?.saveConfig !== 'function') return reply(res, 503, 'The VPN is not available');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) return reply(res, 413, { ok: false, error: { code: 'INVALID', message: 'That is not a WireGuard config (too large)' } });
      chunks.push(chunk);
    }
    try {
      const { value } = await features.vpn.saveConfig(Buffer.concat(chunks).toString('utf8'));
      await features.browser?.applyProxy?.();
      return reply(res, 200, { ok: true, value });
    } catch (err) {
      const code = err?.code ?? 'FAILED';
      return reply(res, code === 'INVALID' ? 400 : 500, { ok: false, error: { code, message: err?.message ?? 'Could not save the config' } });
    }
  }

  async function upload(req, res) {
    if (req.method !== 'POST') return reply(res, 405, 'Method not allowed', { Allow: 'POST' });
    if (!allowedOrigins.has(req.headers.origin) || !safeEqual(req.headers['x-lumen-csrf'], config.csrf)) {
      return reply(res, 403, 'Forbidden');
    }
    if (typeof features.cast?.acceptUpload !== 'function') return reply(res, 503, 'Cast is not available');
    await features.cast.acceptUpload(req, res);
  }

  async function mcp(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) return reply(res, 403, 'Forbidden');
    if (typeof features.ai?.mcpHandler !== 'function') return reply(res, 503, 'Ask Lumen is not available');
    await features.ai.mcpHandler(req, res);
  }

  function serveStatic(req, res, pathname) {
    if (!readOnly(req, res)) return;
    const last = pathname.slice(pathname.lastIndexOf('/') + 1);
    const file = files.get(pathname) ?? (last.includes('.') ? null : files.get('/'));
    if (!file) return reply(res, 404, 'Not found');
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Security-Policy': csp,
      'Cache-Control': 'no-cache',
      ETag: file.etag,
    };
    // Browsers ignore (and warn about) COOP on plain-http LAN origins; only localhost honours it.
    if (!/^(127\.0\.0\.1|localhost):/.test(String(req.headers.host ?? ''))) delete headers['Cross-Origin-Opener-Policy'];
    if (req.headers['if-none-match'] === file.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Type': file.type, 'Content-Length': file.body.length });
    res.end(req.method === 'HEAD' ? undefined : file.body);
  }

  // ---------- WebSocket /live ----------

  function refuse(socket, status, text) {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  function onUpgrade(req, socket, head) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://lumen').pathname;
    } catch {
      return refuse(socket, 400, 'Bad Request');
    }
    if (pathname !== '/live') return refuse(socket, 404, 'Not Found');
    if (!allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) return refuse(socket, 421, 'Misdirected Request');
    if (!allowedOrigins.has(req.headers.origin)) return refuse(socket, 403, 'Forbidden');
    wss.handleUpgrade(req, socket, head, connect);
  }

  async function onMessage(client, data, isBinary) {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      client.send({ t: 'toast', level: 'error', text: 'Lumen could not read that message' });
      return;
    }
    if (msg?.t !== 'cmd') return;
    const result = await hub.handle(msg, client);
    client.send({ t: 'ack', id: ackId(msg.id), ...result });
  }

  function connect(ws) {
    const client = {
      id: randomUUID(),
      kind: 'browser',
      send(msg) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          ws.terminate();
          return;
        }
        ws.send(JSON.stringify(msg));
      },
      close: (code = 1000, reason = '') => ws.close(code, reason),
    };
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    ws.on('message', (data, isBinary) => {
      onMessage(client, data, isBinary).catch((err) => log.error('message handling failed', err));
    });
    ws.on('close', () => hub.detach(client));
    ws.on('error', (err) => log.debug('browser socket error', err));
    Promise.resolve(hub.attach(client)).catch((err) => log.error('attach failed', err));
  }

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, PING_MS);
  pinger.unref();

  let stopping = null;
  function stop() {
    stopping ??= (async () => {
      clearInterval(pinger);
      for (const ws of wss.clients) ws.close(1001, 'Lumen is stopping');
      await new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS));
      for (const ws of wss.clients) ws.terminate();
      const closed = new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await closed;
    })();
    return stopping;
  }

  log.info(`listening on http://${hosts[0]}${lanUrl ? ` and ${lanUrl}` : ''}`);
  return { port, lanUrl, server, stop };
}
