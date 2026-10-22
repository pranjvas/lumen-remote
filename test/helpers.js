// Shared test helpers: the mock TV + server stack, a browser WebSocket client, a fake on-TV agent,
// a minimal TV-facing listener for adapter-level tests, and polling utilities.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startMockTv } from './mock-tv.js';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Timings that keep the suites fast while preserving every ordering the spec relies on. */
export const FAST_TIMING = {
  restVisibleMs: 250,
  restIdleMs: 400,
  ipcStatesMs: 300,
  ipcPictureMs: 500,
  volumePollVisibleMs: 250,
  volumePollIdleMs: 500,
  genaTimeoutS: 1800,
  genaFallbackMs: 1500,
  powerPollMs: 150,
  powerPollTotalMs: 8000,
  holdRepeatMs: 120,
  holdWatchdogMs: 1500,
  holdMaxMs: 8000,
  reconnectBackoffMs: [100, 200, 400, 800, 1600],
};
export const FAST_SAFETY = { volumeCap: 60, powerCooldownMs: 300, keyGapMs: 20 };

/** Repo-relative files that do not exist yet; used to skip suites whose module is still being written. */
export function missingFiles(...files) {
  return files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
}
/** `false`, or a skip reason naming the missing modules (for `describe(name, { skip })`). */
export function skipUnless(...files) {
  const missing = missingFiles(...files);
  return missing.length ? `waits on ${missing.join(', ')}` : false;
}

/**
 * Polls `predicate` until it returns a truthy value (which is returned) or the timeout expires.
 * Errors thrown by the predicate count as "not yet" and are reported on timeout.
 */
export async function waitFor(predicate, { timeout = 5000, interval = 20, message } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      const detail = [message, lastError && `last error: ${lastError.message}`].filter(Boolean).join('; ');
      throw new Error(`waitFor timed out after ${timeout} ms${detail ? ` (${detail})` : ''}`);
    }
    await sleep(interval);
  }
}

const hex32 = () => crypto.randomBytes(32).toString('hex');

/** A fresh data directory seeded with tokens the mock accepts and a complete secrets.json. */
export function makeDataDir({ remoteToken, ipcToken, secrets = {}, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-test-'));
  const all = { genaSecret: hex32(), agentKey: hex32(), castSecret: hex32(), mcpToken: hex32(), ...secrets };
  const write = (name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2));
  if (remoteToken) write('tv.json', { token: remoteToken });
  if (ipcToken) write('ipcontrol.json', { token: ipcToken });
  write('secrets.json', all);
  for (const [name, obj] of Object.entries(files)) write(name, obj);
  return {
    dir,
    secrets: all,
    read: (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')),
    exists: (name) => fs.existsSync(path.join(dir, name)),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) out[k] = isPlain(v) && isPlain(out[k]) ? merge(out[k], v) : v;
  return out;
}

/** `startServer` overrides that point Lumen at the mock (spec §8.1, §9.2). */
export function testConfig(mock, dataDir, overrides = {}) {
  return merge({
    dataDir,
    tv: mock.tv,
    http: { host: '127.0.0.1', port: 0 },
    lan: { enabled: true, port: 0 },
    wol: { targets: ['127.0.0.1'], ports: [mock.ports.wolUdp] },
    timing: FAST_TIMING,
    safety: FAST_SAFETY,
    ai: { backend: 'off' }, // never spend the user's API credit or Claude Code usage in tests
    log: { level: 'warn', console: false },
  }, overrides);
}

/**
 * Starts the mock TV and the real server (`server/app.js`) wired to it.
 * `opts.mock` → mock options, `opts.config` → extra server overrides, `opts.seed` → makeDataDir options.
 */
export async function startStack({ mock: mockOptions, config, seed } = {}) {
  const mock = await startMockTv(mockOptions);
  const data = makeDataDir({ remoteToken: mock.tokens.remote, ipcToken: mock.tokens.ipc, ...seed });
  const clients = [];
  let server;
  try {
    const { startServer } = await import('../server/app.js');
    server = await startServer(testConfig(mock, data.dir, config));
  } catch (err) {
    await mock.stop();
    data.cleanup();
    throw err;
  }
  const track = (client) => { clients.push(client); return client; };
  return {
    mock,
    server,
    data,
    dataDir: data.dir,
    secrets: data.secrets,
    httpPort: server.httpPort,
    lanPort: server.lanPort,
    url: (p = '/') => `http://127.0.0.1:${server.httpPort}${p}`,
    browser: (opts) => track(connectBrowser(server.httpPort, opts)),
    agent: (opts) => track(connectAgent({ port: server.lanPort, key: server.agentKey, ...opts })),
    async stop() {
      for (const c of clients) c.close();
      await server.stop();
      await mock.stop();
      data.cleanup();
    },
  };
}

/**
 * A browser-like client of WS /live (right Host and Origin by default). It mirrors the flat state
 * from hello + patches and collects acks, toasts, changedOnTv and ai events.
 */
export function connectBrowser(port, { origin = `http://127.0.0.1:${port}`, host = '127.0.0.1', headers = {} } = {}) {
  const ws = new WebSocket(`ws://${host}:${port}/live`, { origin, headers });
  const messages = [];
  const listeners = new Set();
  const state = {};
  let resolveHello, rejectHello;
  const hello = new Promise((resolve, reject) => { resolveHello = resolve; rejectHello = reject; });
  hello.catch(() => {});
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('unexpected-response', (req, res) => {
      res.resume();
      reject(Object.assign(new Error(`upgrade refused with HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
    });
    ws.once('error', reject);
  });
  opened.catch((err) => rejectHello(err));
  ws.on('error', () => {});

  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    messages.push(msg);
    if (msg.t === 'hello') {
      Object.assign(state, msg.state);
      resolveHello(msg);
    } else if (msg.t === 'patch') {
      for (const [key, rec] of Object.entries(msg.patch ?? {})) {
        if (rec === null) delete state[key];
        else state[key] = rec;
      }
    }
    for (const fn of listeners) fn(msg);
  });

  function waitForMessage(predicate, { timeout = 5000, since = 0, message } = {}) {
    const existing = messages.slice(since).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`no matching message within ${timeout} ms${message ? ` (${message})` : ''}`));
      }, timeout);
      function check(msg) {
        if (!predicate(msg)) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(msg);
      }
      listeners.add(check);
    });
  }

  return {
    ws,
    messages,
    state,
    hello,
    opened,
    value: (key) => state[key]?.v,
    of: (t) => messages.filter((m) => m.t === t),
    patchesFor: (key) => messages.filter((m) => m.t === 'patch' && Object.hasOwn(m.patch ?? {}, key)).map((m) => m.patch[key]),
    waitForMessage,
    /** Waits until state[key] satisfies `predicate(record)`; returns the record. */
    waitForState(key, predicate = (rec) => rec != null, { timeout = 5000 } = {}) {
      return waitFor(() => (predicate(state[key]) ? state[key] : null), { timeout, message: `state ${key} (now ${JSON.stringify(state[key]?.v)})` });
    },
    /** Sends `{ t:'cmd', id, cmd, ...args }` and resolves with its ack. */
    async send(cmd, args = {}, { timeout = 10000 } = {}) {
      await opened;
      const id = crypto.randomUUID();
      const since = messages.length;
      ws.send(JSON.stringify({ t: 'cmd', id, cmd, ...args }));
      return waitForMessage((m) => m.t === 'ack' && m.id === id, { timeout, since, message: `ack for ${cmd}` });
    },
    /** Sends a command without waiting for its ack; returns the id. */
    fire(cmd, args = {}) {
      const id = crypto.randomUUID();
      ws.send(JSON.stringify({ t: 'cmd', id, cmd, ...args }));
      return id;
    },
    close: () => ws.terminate(),
  };
}

/**
 * Plain HTTP(S) request → `{ status, headers, body }`; rejects on socket errors (e.g. a reset).
 * Pass `tls: true` (self-signed, any cipher) or a custom `agent` for HTTPS.
 */
export function request({ port, path: urlPath = '/', method = 'GET', headers = {}, body, tls = false, agent, timeout = 5000 }) {
  const lib = tls ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      host: '127.0.0.1', port, path: urlPath, method, headers,
      agent: agent ?? (tls ? new https.Agent({ rejectUnauthorized: false, ciphers: 'DEFAULT@SECLEVEL=0', keepAlive: false }) : false),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.end(body);
  });
}

/** Attempts a WebSocket upgrade with explicit headers; resolves `{ status }` (101 on success) or `{ error }`. */
export function tryUpgrade(port, { path: urlPath = '/live', host = `127.0.0.1:${port}`, origin } = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'GET',
      headers: {
        Host: host, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), ...(origin ? { Origin: origin } : {}),
      },
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode }); });
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', (err) => resolve({ error: err.code ?? err.message }));
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** A realistic agent snapshot (values from the live agent probe, identifiers excluded). */
export const AGENT_SNAPSHOT = Object.freeze({
  source: { type: 'TV', number: 1 },
  connected: [{ type: 'TV', number: 1 }, { type: 'HDMI', number: 1 }],
  disconnected: [{ type: 'AV', number: 1 }, { type: 'HDMI', number: 2 }, { type: 'HDMI', number: 3 }, { type: 'HDMI', number: 4 }],
  channel: { name: 'Ace TV', number: 1927, type: 'TVPLUS' },
  audio: { volume: 2, mute: false, outputCodec: 'PCM' },
  caption: 'off',
  build: 'TIZEN-TRUNK2020-NikeM-HOTFIX-RELEASE_20260703.2',
  panel: { w: 3840, h: 2160 },
  system: { cpuLoad: 0.23, memAvailable: 88_080_384, memTotal: 2_115_207_168, storageFree: 1_610_612_736, storageTotal: 4_294_967_296 },
  foreground: null,
});
export const AGENT_APPS = Object.freeze([
  { id: '3201907018807', name: 'Netflix', show: true, iconPath: '/opt/usr/apps/3201907018807/shared/res/icon.png' },
  { id: '111299001912', name: 'YouTube', show: true, iconPath: '/opt/usr/apps/111299001912/shared/res/icon.png' },
  { id: 'pvcinehd01.CineHDTV', name: 'CineHD TV', show: true, iconPath: '/opt/usr/apps/pvcinehd01/shared/res/icon.png' },
  { id: 'LumenTest0.Sideloaded', name: 'Sideloaded Test App', show: true, iconPath: '/opt/usr/apps/LumenTest0/shared/res/icon.png' },
]);
/** 1×1 PNG. */
export const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * A fake Lumen Agent (spec §5.5): connects to the TV-facing listener, says hello with a snapshot
 * and answers `apps` / `icon` / `exit` requests.
 */
export function connectAgent({
  port, key, host = '127.0.0.1', snapshot = AGENT_SNAPSHOT, apps = AGENT_APPS, icons = { '3201907018807': TINY_PNG },
  version = '0.2.0', pcHost = host, autoHello = true,
} = {}) {
  const ws = new WebSocket(`ws://${host}:${port}/agent?key=${encodeURIComponent(key ?? '')}`);
  const requests = [];
  const listeners = new Set();
  const send = (msg) => ws.send(JSON.stringify(msg));
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('unexpected-response', (req, res) => { res.resume(); reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode })); });
    ws.once('error', reject);
  });
  opened.catch(() => {});
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  ws.on('error', () => {});
  ws.on('open', () => { if (autoHello) send({ t: 'hello', agent: version, version, pcHost, snapshot }); });
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.t !== 'req') return;
    requests.push(msg);
    for (const fn of listeners) fn(msg);
    if (msg.type === 'apps') send({ t: 'reply', rid: msg.rid, ok: true, data: apps });
    else if (msg.type === 'icon') {
      const icon = icons[msg.appId];
      send(icon ? { t: 'reply', rid: msg.rid, ok: true, data: icon } : { t: 'reply', rid: msg.rid, ok: false, error: 'no icon' });
    } else if (msg.type === 'exit') {
      send({ t: 'reply', rid: msg.rid, ok: true, data: null });
      ws.close();
    } else send({ t: 'reply', rid: msg.rid, ok: false, error: `unknown request ${msg.type}` });
  });
  return {
    ws,
    requests,
    opened,
    closed,
    hello: (snap = snapshot) => send({ t: 'hello', agent: version, version, pcHost, snapshot: snap }),
    sendState: (snap) => send({ t: 'state', snapshot: snap }),
    sendEvent: (kind, value) => send({ t: 'event', kind, value }),
    waitForRequest: (type, timeout = 5000) => waitFor(() => requests.find((r) => r.type === type), { timeout, message: `agent request ${type}` }),
    close: () => ws.terminate(),
  };
}

/**
 * A stand-in for `server/lan.js` with the same surface (`ready`, `address`, `port`, `route`, `stop`),
 * bound to 127.0.0.1 — for adapter tests that should not depend on the core listener.
 */
export async function createTestLan() {
  const routes = [];
  const find = (req) => routes.find((r) => new URL(req.url, 'http://lan').pathname.startsWith(r.prefix))?.handlers;
  const server = http.createServer((req, res) => {
    const handlers = find(req);
    if (handlers?.request) return handlers.request(req, res);
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    const handlers = find(req);
    if (handlers?.upgrade) return handlers.upgrade(req, socket, head);
    socket.destroy();
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    address: '127.0.0.1',
    port,
    ready: Promise.resolve({ address: '127.0.0.1', port }),
    route(prefix, handlers) { routes.push({ prefix, handlers }); },
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** A logger with the `child(tag)` surface that records every line (for "never logs a token" checks). */
export function createTestLog() {
  const lines = [];
  const make = (tag) => {
    const at = (level) => (msg, obj) => lines.push({ level, tag, msg: String(msg), obj });
    return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: (t) => make(tag ? `${tag}:${t}` : t) };
  };
  const log = make('');
  log.lines = lines;
  log.text = () => lines.map((l) => `${l.msg} ${l.obj === undefined ? '' : safeJson(l.obj)}`).join('\n');
  return log;
}
function safeJson(v) {
  try { return JSON.stringify(v, (k, val) => (val instanceof Error ? { message: val.message, code: val.code } : val)); } catch { return String(v); }
}
