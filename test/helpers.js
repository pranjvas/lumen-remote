// Shared test helpers: the mock TV + server stack, a browser WebSocket client, a fake on-TV agent,
// a minimal TV-facing listener for adapter-level tests, and polling utilities.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
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
    // Edge's helper processes can hold its profile (under the data dir) a few seconds after it closed
    // on a busy PC: retried for about 5 s.
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
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
    browser: { allowLoopback: true }, // the browser tests serve their pages on 127.0.0.1
    log: { level: 'warn', console: false },
  }, overrides);
}

/**
 * Starts the mock TV and the real server (`server/app.js`) wired to it.
 * `opts.mock` → mock options, `opts.config` → extra server overrides, `opts.seed` → makeDataDir options,
 * `opts.seams` → startServer seams (e.g. { aiBackends } for a scripted Ask Lumen).
 */
export async function startStack({ mock: mockOptions, config, seed, seams } = {}) {
  const mock = await startMockTv(mockOptions);
  const data = makeDataDir({ remoteToken: mock.tokens.remote, ipcToken: mock.tokens.ipc, ...seed });
  const clients = [];
  let server;
  try {
    const { startServer } = await import('../server/app.js');
    server = await startServer(testConfig(mock, data.dir, config), seams);
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
export function connectBrowser(port, { origin = `http://127.0.0.1:${port}`, host = '127.0.0.1', headers = {}, binaryFrames = false } = {}) {
  // binaryFrames: browser frames as binary messages, as the web UI asks for them; recorded as
  // { t: 'browser.frame', seq, w, h, bytes, binary: true }.
  const ws = new WebSocket(`ws://${host}:${port}/live${binaryFrames ? '?frames=bin' : ''}`, { origin, headers });
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

  ws.on('message', (data, isBinary) => {
    const msg = isBinary
      ? { t: data[0] === 1 ? 'browser.frame' : 'binary', seq: data.readUInt32BE(4), w: data.readUInt16BE(8), h: data.readUInt16BE(10), bytes: data.subarray(data[1]), binary: true }
      : JSON.parse(String(data));
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
    /** Calls `fn(msg)` for every message from now on; returns the unsubscribe function. */
    onMessage(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
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
 * and answers `apps` / `icon` / `exit` / `open-url` requests.
 */
export function connectAgent({
  port, key, host = '127.0.0.1', snapshot = AGENT_SNAPSHOT, apps = AGENT_APPS, icons = { '3201907018807': TINY_PNG },
  version = '0.2.0', pcHost = host, autoHello = true, keepAlive = true,
} = {}) {
  const ws = new WebSocket(`ws://${host}:${port}/agent?key=${encodeURIComponent(key ?? '')}`);
  const requests = [];
  const listeners = new Set();
  const frames = []; // binary messages (browser-screen JPEG frames)
  const screen = []; // screen-* JSON messages from the PC
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
  // The real agent sends its state every few seconds; the adapter drops an agent silent for 15 s, which
  // long suites on a busy PC otherwise hit. keepAlive: false lets a test exercise that drop.
  const pulse = keepAlive ? setInterval(() => { if (ws.readyState === WebSocket.OPEN) send({ t: 'state', snapshot }); }, 5000) : null;
  pulse?.unref?.();
  ws.once('close', () => clearInterval(pulse));
  ws.on('message', (data, isBinary) => {
    if (isBinary) { frames.push(data); return; }
    const msg = JSON.parse(String(data));
    if (typeof msg.t === 'string' && msg.t.startsWith('screen-')) { screen.push(msg); return; }
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
    } else if (msg.type === 'open-url') {
      // Agent 0.3.0 (spec §11.3): the view app control opened the URL on the TV.
      send({ t: 'reply', rid: msg.rid, ok: true, data: { method: 'view' } });
    } else if (msg.type === 'screen') {
      send({ t: 'reply', rid: msg.rid, ok: true, data: { on: msg.on === true } });
    } else if (msg.type === 'launch') {
      // Agent 0.4.0: an app-control launch (Smart Hub-style deep link).
      send({ t: 'reply', rid: msg.rid, ok: true, data: { appId: msg.appId, operation: msg.operation ?? null, keys: Object.keys(msg.data ?? {}) } });
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
    onRequest: (fn) => listeners.add(fn),
    frames,
    screen,
    sendScreenInput: (input) => send({ t: 'screen-input', ...input }),
    close: () => ws.terminate(),
  };
}

/**
 * A scripted TV Bluetooth stack for the fake Eyes below. `bonded` are paired devices, `nearby` the ones in
 * pairing mode a scan finds. `refuse` (an Eyes error string, e.g. 'NotSupportedException: Unsupported')
 * makes every action fail the way a TV that refuses the API would; `failPair` / `failConnect` map an
 * address to the error that one device gives.
 */
export function fakeBluetooth({
  powered = true,
  bonded = [
    { address: '00:1A:7D:DA:71:13', name: 'Samsung Smart Remote', kind: 'Peripheral', minor: 'PeripheralRemoteControl', connected: true },
    { address: 'F4:4E:FD:00:11:22', name: 'Living Room Soundbar', kind: 'AudioVideo', minor: 'AudioVideoLoudspeaker', connected: false },
  ],
  nearby = [
    { address: 'ac:80:0a:12:34:56', name: 'WH-1000XM4', kind: 'AudioVideo', minor: 'AudioVideoHeadphones', rssi: -52 },
    { address: '9C:2E:A1:65:43:21', name: 'Xbox Wireless Controller', kind: 'Peripheral', minor: 'PeripheralGamePad', rssi: -71 },
  ],
  refuse = null, failPair = {}, failConnect = {}, scanMs = 150,
} = {}) {
  const key = (a) => String(a).toUpperCase();
  return {
    powered,
    bonded: bonded.map((d) => ({ ...d, address: key(d.address) })),
    nearby: nearby.map((d) => ({ ...d })),
    refuse, failPair, failConnect, scanMs,
    find(address) { return this.bonded.find((d) => d.address === key(address)); },
  };
}

/**
 * A fake org.lumen.eyes: dials the URL Lumen passed at launch, says hello with `version` and answers the
 * Bluetooth protocol (bluetooth, bt-scan with bt-found as it goes, bt-scan-stop, bt-pair, bt-connect,
 * bt-disconnect) from `bt` (fakeBluetooth()). Every text message it received is in `received`.
 */
export function connectEyes(url, { version = '0.4.0', bt = fakeBluetooth() } = {}) {
  const ws = new WebSocket(url);
  const received = [];
  const send = (msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  const device = (d, extra = {}) => ({ address: d.address, name: d.name, kind: d.kind, minor: d.minor, rssi: d.rssi ?? 0, paired: !!d.paired, connected: !!d.connected, ...extra });
  let scanTimer = null;
  let scanEnd = null;
  ws.on('open', () => send({ t: 'hello', version }));
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(String(raw));
    received.push(msg);
    const { t, id } = msg;
    if (t === 'bluetooth') {
      send({ t, id, ok: true, powered: bt.powered, name: '[TV] Samsung Q95T',
        devices: bt.bonded.map((d) => ({ name: d.name, connected: d.connected, bonded: true, kind: d.kind, minor: d.minor, address: d.address })) });
    } else if (t === 'bt-scan') {
      if (bt.refuse) { send({ t, id, ok: false, error: bt.refuse }); return; }
      const found = bt.nearby.map((d) => device(d, { paired: Boolean(bt.find(d.address)) }));
      found.forEach((d, i) => setTimeout(() => send({ t: 'bt-found', id, device: d }), 20 + i * 20));
      scanEnd = () => { clearTimeout(scanTimer); scanEnd = null; send({ t, id, ok: true, devices: found }); };
      scanTimer = setTimeout(() => scanEnd?.(), bt.scanMs);
    } else if (t === 'bt-scan-stop') {
      scanEnd?.();
    } else if (t === 'bt-pair' || t === 'bt-connect' || t === 'bt-disconnect') {
      if (bt.refuse) { send({ t, id, ok: false, error: bt.refuse }); return; }
      const address = String(msg.address).toUpperCase();
      let known = bt.find(address);
      if (t === 'bt-pair') {
        if (bt.failPair[address]) { send({ t, id, ok: false, error: bt.failPair[address] }); return; }
        if (!known) {
          const seen = bt.nearby.find((d) => d.address.toUpperCase() === address);
          if (!seen) { send({ t, id, ok: false, error: 'RemoteDeviceNotFound: the device is not in pairing mode or is out of range' }); return; }
          known = { ...seen, address, connected: false };
          bt.bonded.push(known);
        }
      }
      if (!known) { send({ t, id, ok: false, error: 'RemoteDeviceNotBonded: pair the device first' }); return; }
      if (t !== 'bt-disconnect' && bt.failConnect[address]) {
        if (t === 'bt-pair') { send({ t, id, ok: true, paired: true, connected: false, connectError: bt.failConnect[address], device: device(known, { paired: true }) }); return; }
        send({ t, id, ok: false, error: bt.failConnect[address] });
        return;
      }
      known.connected = t !== 'bt-disconnect';
      send({ t, id, ok: true, ...(t === 'bt-pair' ? { paired: true } : {}), connected: known.connected,
        ...(known.connected ? { profile: known.kind === 'AudioVideo' ? 'a2dp' : 'hid' } : {}), device: device(known, { paired: true }) });
    }
  });
  ws.on('error', () => {});
  return { ws, received, bt, close: () => ws.terminate() };
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

// ---------------------------------------------------------------------------------------------
// VPN (follow-up 3): the Go user-space WireGuard test peer on 127.0.0.1 and synthetic confs.
// Every key below is generated per call and thrown away; helpers never print or persist one.
// ---------------------------------------------------------------------------------------------

/** Fallback location of the CineHD build of the peer (read-only worktree). */
const WORKTREE_TESTPEER = 'C:/Users/pranj/Documents/Codex/2026-09-16/how-x20/.worktrees/proton-wg-tunnel/work/wg-tunnel/bin/testpeer.exe';
/** Addresses inside the test tunnel: the peer serves HTTP :80 and DNS :53 on TUNNEL_PEER_IP. */
export const TUNNEL_PEER_IP = '10.66.0.1';
export const TUNNEL_CLIENT_IP = '10.66.0.2';

/** Absolute path of `testpeer.exe` (env `LUMEN_TESTPEER`, the fixture copy, the worktree) or `null`. */
export function testpeerPath() {
  const candidates = [process.env.LUMEN_TESTPEER, path.join(ROOT, 'test', 'fixtures', 'vpn', 'bin', 'testpeer.exe'), WORKTREE_TESTPEER];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}
/** `false`, or the reason to skip suites that need the peer binary. */
export function skipWithoutTestpeer() {
  return testpeerPath() ? false : 'testpeer.exe not found (test/fixtures/vpn/bin, LUMEN_TESTPEER or the CineHD worktree)';
}

const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

/** A fresh X25519 key pair from `testpeer genkey`: `{ privateKey, publicKey }` (44-char base64 each). */
export function genTestpeerKeys(bin = testpeerPath()) {
  if (!bin) throw new Error('testpeer.exe not found');
  const r = spawnSync(bin, ['genkey'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const m = /private=(\S+) public=(\S+)/.exec(r.stdout ?? '');
  if (r.status !== 0 || !m || !KEY_RE.test(m[1]) || !KEY_RE.test(m[2])) {
    throw new Error(`testpeer genkey failed (exit ${r.status}): ${(r.stderr ?? '').trim() || 'no key pair on stdout'}`);
  }
  return { privateKey: m[1], publicKey: m[2] };
}

/**
 * wg-quick client text for the test peer (port plan §10.5). `keepalive: null` omits the
 * PersistentKeepalive line; `eol` lets a test produce CRLF files.
 */
export function clientConf(keys, peerPublicKey, port, { address = TUNNEL_CLIENT_IP, dns = TUNNEL_PEER_IP, keepalive = 25, eol = '\n' } = {}) {
  const lines = [
    '[Interface]', `PrivateKey = ${keys.privateKey}`, `Address = ${address}/32`, `DNS = ${dns}`, '',
    '[Peer]', `PublicKey = ${peerPublicKey}`, 'AllowedIPs = 0.0.0.0/0', `Endpoint = 127.0.0.1:${port}`,
  ];
  if (keepalive !== null) lines.push(`PersistentKeepalive = ${keepalive}`);
  return lines.join(eol) + eol;
}

/**
 * Spawns `testpeer serve` on 127.0.0.1:<random UDP port> with throwaway keys and resolves once it
 * prints its listening line. Inside the tunnel it serves `http://10.66.0.1/hello`,
 * `/blob?bytes=N` and a DNS responder (every A question → 10.66.0.1). Never pass `exit` mode.
 *   → { port, conf, wrongPeerConf, log(), waitForLog(re, ms), containsKey(text), exited, close() }
 * `conf` / `wrongPeerConf` take the `clientConf` options (`keepalive`, `address`, `dns`, `eol`).
 */
export function startTestPeer({ bin = testpeerPath(), startTimeoutMs = 10000, ...confOptions } = {}) {
  if (!bin) return Promise.reject(new Error('testpeer.exe not found'));
  const peer = genTestpeerKeys(bin);
  const client = genTestpeerKeys(bin);
  const stranger = genTestpeerKeys(bin);
  const secrets = [peer.privateKey, peer.publicKey, client.privateKey, client.publicKey, stranger.publicKey];
  const child = spawn(bin, [
    'serve', '-listen', '127.0.0.1:0', '-private', peer.privateKey, '-peer', client.publicKey,
    '-ip', TUNNEL_PEER_IP, '-client', TUNNEL_CLIENT_IP,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const lines = [];
  const feed = (prefix) => {
    let rest = '';
    return (chunk) => {
      rest += chunk.toString();
      const parts = rest.split(/\r?\n/);
      rest = parts.pop();
      for (const line of parts) if (line.trim()) lines.push(prefix + line.trim());
    };
  };
  child.stdout.on('data', feed(''));
  child.stderr.on('data', feed('stderr: '));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const text = () => lines.join('\n');

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`testpeer did not start within ${startTimeoutMs} ms:\n${text()}`)); }, startTimeoutMs);
    exited.then(({ code }) => { clearTimeout(timer); reject(new Error(`testpeer exited with ${code} before listening:\n${text()}`)); });
    const onLine = () => {
      const m = /listening on udp :(\d+)/.exec(text());
      if (!m) return;
      child.stdout.off('data', onLine);
      clearTimeout(timer);
      const port = Number(m[1]);
      let closing = null;
      resolve({
        port,
        conf: clientConf(client, peer.publicKey, port, confOptions),
        wrongPeerConf: clientConf(client, stranger.publicKey, port, confOptions),
        log: text,
        waitForLog: (re, ms = 3000) => waitFor(() => re.test(text()), { timeout: ms, message: `peer log to match ${re}` }),
        /** True when `value` carries any full key of this run (status, logs and summaries must never). */
        containsKey: (value) => secrets.some((k) => String(value).includes(k)),
        exited,
        close() {
          if (!closing) {
            closing = child.exitCode === null && child.signalCode === null
              ? new Promise((done) => { exited.then(() => done()); child.kill(); })
              : Promise.resolve();
          }
          return closing;
        },
      });
    };
    child.stdout.on('data', onLine);
  });
}

/** 44-char base64 of 32 random bytes: key-shaped, never a usable key (parse tests only). */
export const randomKeyString = () => crypto.randomBytes(32).toString('base64');

/**
 * A Proton-shaped WireGuard conf with random key strings: CRLF by default, comments, a trailing
 * comment on Endpoint and an IPv6 AllowedIPs entry. `omit` drops keys (e.g. ['DNS']); `extraLines`
 * are appended verbatim. → { text, privateKey, publicKey, presharedKey }
 */
export function syntheticConf({
  privateKey = randomKeyString(), publicKey = randomKeyString(), presharedKey = null,
  address = '10.2.0.2/32', dns = '10.2.0.1', endpoint = '185.107.56.1:51820', keepalive = 25,
  eol = '\r\n', omit = [], extraLines = [],
} = {}) {
  const skip = new Set(omit);
  const lines = [
    '[Interface]', '# Key for Lumen Remote', '# Bouncing = 0', '# NetShield = 1',
    ['PrivateKey', `PrivateKey = ${privateKey}`], ['Address', `Address = ${address}`], ['DNS', `DNS = ${dns}`], '',
    '[Peer]', '# NL-FREE#123',
    ['PublicKey', `PublicKey = ${publicKey}`],
    ...(presharedKey ? [['PresharedKey', `PresharedKey = ${presharedKey}`]] : []),
    'AllowedIPs = 0.0.0.0/0, ::/0',
    ['Endpoint', `Endpoint = ${endpoint}  # trailing comment`],
    ...(keepalive === null ? [] : [['PersistentKeepalive', `PersistentKeepalive = ${keepalive}`]]),
    ...extraLines,
  ];
  const text = lines
    .filter((l) => !(Array.isArray(l) && skip.has(l[0])))
    .map((l) => (Array.isArray(l) ? l[1] : l))
    .join(eol) + eol;
  return { text, privateKey, publicKey, presharedKey };
}
