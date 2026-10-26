// Lumen Eyes ingress: the windowless .NET app org.lumen.eyes (companion/eyes) connects out to the
// TV-facing listener at ws://<pc>:<lanPort>/eyes?key=<agentKey> and answers capture requests with one
// NV12 still of the screen (video and UI composited). Lumen starts it on demand through the TV agent's
// app-control launch, passing that URL, so nothing secret is built into the package.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { LumenError } from '../errors.js';
import { createQueue } from '../util/queue.js';
import { nv12ToPng } from '../util/image.js';

export const EYES_APP_ID = 'org.lumen.eyes';
const CONNECT_TIMEOUT_MS = 15000;
const CAPTURE_TIMEOUT_MS = 6000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_HEADER_BYTES = 1024;
const WATCH_RETRY_MS = 5000;

// Bluetooth actions (Eyes 0.4.0+): scan, pair, connect, disconnect through Tizen.Network.Bluetooth.
const BT_ACTIONS_VERSION = '0.4.0';
const BT_ADDRESS = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/i;
const BT_TIMEOUT_MS = { 'bt-pair': 90000, 'bt-connect': 35000, 'bt-disconnect': 25000 };
const BT_REPLIES = new Set(['bluetooth', 'procs', 'bt-scan', 'bt-pair', 'bt-connect', 'bt-disconnect']);
// An Eyes error that means the TV refused the Bluetooth API itself, not that one device failed.
const BT_REFUSED = /permission|privilege|notsupported|not supported|unsupported|unauthori[sz]ed|security/i;
const BT_REASONS = [
  [/AuthRejected/i, 'the device turned the pairing down'],
  [/AuthFailed/i, 'the code did not match, or the device left pairing mode'],
  [/TimedOut/i, 'the device did not answer in time; keep it in pairing mode and near the TV'],
  [/RemoteDeviceNotFound/i, 'the device was not found; put it in pairing mode and keep it near the TV'],
  [/RemoteDeviceNotBonded/i, 'the device is not paired with the TV'],
  [/Cancelled/i, 'pairing was cancelled'],
  [/ResourceBusy|NowInProgress/i, "the TV's Bluetooth is busy; try again in a moment"],
  [/OperationFailed|refused the connection/i, 'the device refused; make sure it is on and not connected to a phone or PC'],
];
/** Where the TV's own menu pairs devices (Samsung 2020 e-Manual, Tizen 5.5). */
export const BT_MENU = Object.freeze({
  audio: 'Settings → Sound → Sound Output → Bluetooth Speaker List',
  other: 'Settings → General → External Device Manager → Input Device Manager → Bluetooth Device List',
});

const digest = (s) => createHash('sha256').update(s).digest();

// '0.4.0' ≥ '0.3.3': numeric, part by part.
function atLeast(version, min) {
  const a = String(version ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = min.split('.').map(Number);
  for (let i = 0; i < b.length; i += 1) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i];
  return true;
}

const cleanWord = (v) => (typeof v === 'string' && v ? v.replace(/[^A-Za-z_]/g, '').slice(0, 40) || null : null);

/** A device as Eyes reports it → { address, name, kind, minor, rssi, paired, connected } (nothing else). */
export function btDevice(d) {
  if (!d || typeof d !== 'object') return null;
  return {
    address: typeof d.address === 'string' && BT_ADDRESS.test(d.address) ? d.address.toUpperCase() : null,
    name: typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 60) : null,
    kind: cleanWord(d.kind),
    minor: cleanWord(d.minor),
    rssi: Number.isInteger(d.rssi) && d.rssi < 0 && d.rssi > -128 ? d.rssi : null,
    paired: d.paired === true || d.bonded === true,
    connected: d.connected === true,
  };
}

/** True for the TV's own remote (a Bluetooth remote control); Lumen never disconnects it. */
export function isTvRemote(d) {
  return Boolean(d && ((d.kind === 'Peripheral' && /RemoteControl/i.test(d.minor ?? '')) || /\bremote\b|smart control/i.test(d.name ?? '')));
}

// The TV menu list for a device: audio unless it is known to be something else (most pairing is headphones).
const menuFor = (d) => (d?.kind && d.kind !== 'AudioVideo' ? BT_MENU.other : BT_MENU.audio);

/** An Eyes Bluetooth error → LumenError: UNAVAILABLE when the TV refuses the API (finish on the TV), else FAILED. */
export function btError(raw, verb, device) {
  const text = String(raw ?? 'unknown').replace(/\s+/g, ' ').slice(0, 160);
  const menu = menuFor(device);
  if (/NotEnabled|is off/i.test(text)) return new LumenError('UNAVAILABLE', `Bluetooth is off on the TV. Turn it on in ${menu.split(' → ').slice(0, 2).join(' → ')}`);
  if (/Lumen (dis)?connects/.test(text)) return new LumenError('FAILED', `${text.replace(/^\w+: /, '')}.`.replace(/^\w/, (c) => c.toUpperCase()));
  if (BT_REFUSED.test(text)) return new LumenError('UNAVAILABLE', `The TV does not let Lumen ${verb} Bluetooth devices (${text}). Finish on the TV: ${menu}`);
  const reason = BT_REASONS.find(([re]) => re.test(text))?.[1] ?? text.replace(/^\w+Exception: /, '');
  return new LumenError('FAILED', `Could not ${verb} ${device?.name ?? (verb === 'scan for' ? 'devices' : 'the device')}: ${reason}`);
}

export function createEyes({ config, data, log: rootLog, store, lan, agent }) {
  const log = rootLog.child('eyes');
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const queue = createQueue({ concurrency: 1, minGapMs: 0 });
  const pending = new Map(); // id → { resolve, reject, timer }
  const waiters = new Set(); // resolved when a connection says hello

  let started = false;
  let stopped = false;
  let active = null;
  let version = null;
  let unroute = null;
  let latest = null; // { png, width, height, at, ms }
  let watchEveryMs = 0; // the Screen view's cadence (hub setDemand); 0 = nobody is watching
  let watchTimer = null;
  let watchBusy = false;
  const btPending = new Map(); // id → { resolve, reject, timer }
  let btAt = 0;
  let scan = null; // the last Bluetooth scan: { id, startedAt, until, devices: Map(address → device) }
  let scanRunning = null; // its promise while it runs

  function setConn(state) {
    store.set('conn.eyes', state, { src: 'derived', via: 'eyes:link' });
  }

  function key() {
    const k = config.secrets?.agentKey ?? data?.readJson?.('secrets.json', {})?.agentKey;
    return typeof k === 'string' && k ? k : null;
  }

  function keyMatches(given) {
    const expected = key();
    return Boolean(expected && typeof given === 'string' && given && timingSafeEqual(digest(given), digest(expected)));
  }

  const online = () => Boolean(active && active.readyState === WebSocket.OPEN && version);

  // ---- connection ----

  function onUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://eyes.invalid');
    if (stopped || url.pathname !== '/eyes' || !keyMatches(url.searchParams.get('key'))) {
      log.warn('eyes connection rejected', { path: url.pathname });
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, onConnection);
  }

  function onConnection(ws) {
    if (active) {
      failPending('Lumen Eyes reconnected');
      active.close(4000, 'replaced by a newer connection');
    }
    active = ws;
    version = null;
    ws.on('message', (raw, isBinary) => {
      if (ws !== active) return;
      if (isBinary) onFrame(raw);
      else onText(raw);
    });
    ws.on('close', () => {
      if (ws !== active) return;
      active = null;
      version = null;
      failPending('Lumen Eyes disconnected');
      if (!stopped) setConn('offline');
      log.info('eyes disconnected');
    });
    ws.on('error', () => {});
  }

  function onText(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (msg?.t === 'hello') {
      version = typeof msg.version === 'string' ? msg.version.slice(0, 20) : '?';
      setConn('online');
      log.info('eyes connected', { version });
      for (const resolve of waiters) resolve();
      waiters.clear();
    } else if (msg?.t === 'bt-found') {
      // A device seen while a scan runs: shown at once (bluetooth.scan), before the scan ends.
      const device = btDevice(msg.device);
      if (scan && String(msg.id) === scan.id && device?.address) {
        scan.devices.set(device.address, device);
        publishScan('scanning');
      }
    } else if (BT_REPLIES.has(msg?.t)) {
      const entry = btPending.get(String(msg.id));
      if (entry) { btPending.delete(String(msg.id)); clearTimeout(entry.timer); entry.resolve(msg); }
    } else if (msg?.t === 'frame' && msg.ok === false) {
      settle(String(msg.id), null, new LumenError('FAILED', `The TV could not capture the screen: ${String(msg.error ?? 'unknown').slice(0, 120)}`));
    }
  }

  // [4-byte big-endian header length][header JSON][NV12 payload]
  function onFrame(raw) {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.concat(raw);
    if (buffer.length < 4) return;
    const headerLength = buffer.readUInt32BE(0);
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES || buffer.length < 4 + headerLength) return;
    let header;
    try {
      header = JSON.parse(buffer.subarray(4, 4 + headerLength).toString('utf8'));
    } catch {
      return;
    }
    const id = String(header?.id ?? '');
    const { w, h } = header ?? {};
    const payload = buffer.subarray(4 + headerLength);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 16 || h < 16 || w > 1920 || h > 1080 || header.format !== 'nv12'
      || payload.length !== w * h * 1.5) {
      settle(id, null, new LumenError('FAILED', 'Lumen Eyes sent a malformed frame'));
      return;
    }
    try {
      const image = nv12ToPng(payload, w, h);
      settle(id, { ...image, captureMs: Number.isFinite(header.ms) ? header.ms : null, source: { width: w, height: h } });
    } catch (err) {
      settle(id, null, new LumenError('FAILED', `Could not decode the screen frame: ${err.message}`));
    }
  }

  function settle(id, value, error) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(value);
  }

  function failPending(message) {
    for (const id of [...pending.keys()]) settle(id, null, new LumenError('UNAVAILABLE', message));
    // Bluetooth and memory requests too, so they do not wait out their timeouts after a disconnect.
    for (const [id, entry] of [...btPending]) {
      btPending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new LumenError('UNAVAILABLE', message));
    }
  }

  // ---- launch on demand ----

  function lumenUrl() {
    const k = key();
    if (!k || !lan?.address || !lan?.port) return null;
    return `ws://${lan.address}:${lan.port}/eyes?key=${k}`;
  }

  async function ensureOnline() {
    if (online()) return;
    const tv = store.get('conn.tv')?.v;
    if (tv === 'standby' || tv === 'off') throw new LumenError('TV_OFF', 'The TV is off');
    const a = agent?.();
    const url = lumenUrl();
    if (!a?.request || store.get('conn.agent')?.v !== 'online' || !url) {
      throw new LumenError('UNAVAILABLE', 'Seeing the screen needs the TV agent (Settings → TV agent)');
    }
    setConn('connecting');
    const hello = new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        waiters.delete(done);
        reject(new LumenError('UNAVAILABLE', 'Lumen Eyes did not connect; is it installed on the TV?'));
      }, CONNECT_TIMEOUT_MS);
      waiters.add(done);
    });
    try {
      await a.request('launch', { appId: EYES_APP_ID, data: { lumen: url } });
    } catch (err) {
      setConn(online() ? 'online' : 'offline');
      throw new LumenError('UNAVAILABLE', `Could not start Lumen Eyes on the TV: ${err.message}`);
    }
    try {
      await hello;
    } catch (err) {
      setConn('offline');
      throw err;
    }
  }

  // ---- capture ----

  async function captureOnce(mode, timeoutMs) {
    await ensureOnline();
    const id = randomUUID();
    const t0 = Date.now();
    const frame = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new LumenError('FAILED', 'The TV did not send the screen in time'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      active.send(JSON.stringify({ t: 'capture', id, mode }), (err) => {
        if (err) settle(id, null, new LumenError('UNAVAILABLE', 'Lumen Eyes connection dropped'));
      });
    });
    latest = { ...frame, at: Date.now(), ms: Date.now() - t0 };
    store.set('screen.meta', { width: latest.width, height: latest.height, ms: latest.ms, captureMs: latest.captureMs }, { src: 'derived', via: 'eyes:capture' });
    store.set('screen.at', latest.at, { src: 'derived', via: 'eyes:capture' });
    return latest;
  }

  /** One still of the TV screen as PNG (16:9, about 960x540): { png, width, height, at, ms, captureMs }. */
  function capture({ mode = 0, timeoutMs = CAPTURE_TIMEOUT_MS } = {}) {
    if (!Number.isInteger(mode) || mode < 0 || mode > 2) return Promise.reject(new LumenError('INVALID', 'mode is 0, 1 or 2'));
    return queue.push(() => captureOnce(mode, timeoutMs));
  }

  // ---- Bluetooth (TV web apps have no Bluetooth API; Eyes reads it through Tizen .NET) ----

  /** Reads the TV's Bluetooth adapter and paired devices into bluetooth.state. */
  async function bluetooth() {
    await ensureOnline();
    const id = randomUUID();
    const msg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { btPending.delete(id); reject(new LumenError('FAILED', 'Lumen Eyes did not answer about Bluetooth')); }, 8000);
      btPending.set(id, { resolve, reject, timer });
      active.send(JSON.stringify({ t: 'bluetooth', id }));
    });
    btAt = Date.now();
    if (msg.ok === false) {
      log.info('bluetooth read failed', { error: String(msg.error ?? '').slice(0, 120) });
      throw new LumenError('UNAVAILABLE', `The TV did not report Bluetooth: ${String(msg.error ?? '').slice(0, 80)}`);
    }
    const value = {
      name: typeof msg.name === 'string' ? msg.name.slice(0, 60) : null,
      powered: msg.powered === true,
      // address and minor come from Eyes 0.4.0; Connect / Disconnect need the address.
      devices: Array.isArray(msg.devices) ? msg.devices.slice(0, 20).map((d) => {
        const device = btDevice(d) ?? {};
        return {
          name: device.name ?? 'Unnamed device',
          connected: d?.connected === true, bonded: d?.bonded !== false,
          kind: typeof d?.kind === 'string' ? d.kind.replace(/[^A-Za-z_]/g, '').slice(0, 30) : null,
          minor: device.minor ?? null,
          address: device.address ?? null,
        };
      }) : [],
    };
    store.set('bluetooth.state', value, { src: 'live', via: 'eyes:bluetooth', ttlMs: 10 * 60 * 1000 });
    return value;
  }

  // ---- Bluetooth actions (Eyes 0.4.0): scan, pair, connect, disconnect ----

  async function requireBtActions() {
    await ensureOnline();
    if (!atLeast(version, BT_ACTIONS_VERSION)) {
      throw new LumenError('UNAVAILABLE', `Pairing from Lumen needs Lumen Eyes ${BT_ACTIONS_VERSION} on the TV (it has ${version}). Reinstall Eyes, or pair on the TV: ${BT_MENU.audio}`);
    }
  }

  // One request/answer over the Eyes link, answered by a text message with the same id.
  function btRequest(t, fields, timeoutMs, what) {
    const id = randomUUID();
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { btPending.delete(id); reject(new LumenError('FAILED', `Lumen Eyes did not answer about ${what} in time`)); }, timeoutMs);
      btPending.set(id, { resolve, reject, timer });
      active.send(JSON.stringify({ t, id, ...fields }), (err) => {
        if (err && btPending.has(id)) { btPending.delete(id); clearTimeout(timer); reject(new LumenError('UNAVAILABLE', 'Lumen Eyes connection dropped')); }
      });
    });
    return { id, answer };
  }

  function publishScan(state, error = null) {
    if (!scan) return;
    store.set('bluetooth.scan', {
      state, id: scan.id, startedAt: scan.startedAt, until: scan.until,
      devices: [...scan.devices.values()].slice(0, 40),
      error: error ? { code: error.code ?? 'FAILED', message: String(error.message ?? error).slice(0, 240) } : null,
    }, { src: 'derived', via: 'eyes:bt-scan' });
  }

  /**
   * Looks for discoverable devices for `secs` (4-30) seconds. Devices appear in bluetooth.scan as they
   * are found; resolves with { devices } when the scan ends. A second call joins the running scan.
   */
  function scanBluetooth({ secs = 15 } = {}) {
    if (scanRunning) return scanRunning;
    const seconds = Math.max(4, Math.min(30, Number.isInteger(secs) ? secs : 15));
    scanRunning = (async () => {
      await requireBtActions();
      const { id, answer } = btRequest('bt-scan', { secs: seconds }, seconds * 1000 + 15000, 'the Bluetooth scan');
      scan = { id, startedAt: Date.now(), until: Date.now() + seconds * 1000, devices: new Map() };
      publishScan('scanning');
      let msg;
      try {
        msg = await answer;
      } catch (err) {
        publishScan('error', err);
        throw err;
      }
      if (msg.ok === false) {
        const err = btError(msg.error, 'scan for', null);
        log.info('bluetooth scan failed', { error: String(msg.error ?? '').slice(0, 120) });
        publishScan('error', err);
        throw err;
      }
      for (const raw of Array.isArray(msg.devices) ? msg.devices : []) {
        const device = btDevice(raw);
        if (device?.address && !scan.devices.has(device.address)) scan.devices.set(device.address, device);
      }
      publishScan('done');
      return { devices: [...scan.devices.values()] };
    })().finally(() => { scanRunning = null; });
    return scanRunning;
  }

  /** Ends a running scan early (the pairing sheet was closed). */
  function stopBluetoothScan() {
    const running = Boolean(scanRunning);
    if (running && online()) active.send(JSON.stringify({ t: 'bt-scan-stop' }));
    return { stopped: running };
  }

  // The device behind an address, as last seen by a scan or in the paired list.
  function knownDevice(address) {
    const fromScan = scan?.devices.get(address);
    const paired = (store.get('bluetooth.state')?.v?.devices ?? []).find((d) => d.address === address);
    return fromScan ?? (paired ? { ...paired, paired: true } : null);
  }

  async function btAction(t, address, verb) {
    if (typeof address !== 'string' || !BT_ADDRESS.test(address)) throw new LumenError('INVALID', 'That is not a Bluetooth device address');
    const addr = address.toUpperCase();
    const known = knownDevice(addr);
    if (t === 'bt-disconnect' && isTvRemote(known)) throw new LumenError('INVALID', 'Lumen leaves the TV’s own remote connected');
    await requireBtActions();
    const msg = await btRequest(t, { address: addr }, BT_TIMEOUT_MS[t], 'Bluetooth').answer;
    const device = btDevice(msg.device) ?? known ?? { address: addr };
    if (msg.ok === false) {
      log.info(`bluetooth ${verb} failed`, { error: String(msg.error ?? '').slice(0, 120) });
      throw btError(msg.error, verb, { ...known, ...device, name: device.name ?? known?.name });
    }
    const name = device.name ?? known?.name ?? null;
    const result = {
      address: addr, name, kind: device.kind ?? known?.kind ?? null,
      paired: t === 'bt-pair' ? true : (msg.paired ?? true) === true,
      connected: msg.connected === true,
      profile: typeof msg.profile === 'string' && msg.profile ? msg.profile.slice(0, 10) : null,
    };
    // Paired, but the audio/input link did not come up: still a success, with the reason.
    if (msg.connectError) result.connectError = btError(msg.connectError, 'connect', { ...device, name }).message;
    if (scan?.devices.has(addr)) {
      scan.devices.set(addr, { ...scan.devices.get(addr), name: name ?? scan.devices.get(addr).name, paired: result.paired, connected: result.connected });
      publishScan(scanRunning ? 'scanning' : 'done');
    }
    try {
      await bluetooth();
    } catch (err) {
      log.debug('bluetooth refresh after an action failed', { message: err.message });
    }
    return result;
  }

  /** Pairs a discoverable device, then connects it when it is an audio or input device. */
  const pairBluetooth = (address) => btAction('bt-pair', address, 'pair');
  /** Connects an already paired device (A2DP for audio, HID for input). */
  const connectBluetooth = (address) => btAction('bt-connect', address, 'connect');
  /** Disconnects a paired device (never the TV's own remote); it stays paired. */
  const disconnectBluetooth = (address) => btAction('bt-disconnect', address, 'disconnect');

  // ---- memory (TV web apps see only totals; Eyes reads apps and processes through Tizen .NET) ----

  /**
   * → { meminfo (kB), apps [{ id, pid, state }] }; with detail also apps' rssKb/pssKb and
   * procs [{ pid, name, rssKb }], seen, unreadable. Detail costs the TV a PSS pass over every app and a
   * /proc walk, so only an explicit tv.processes asks for it. Command lines are dropped even if an older
   * Eyes (0.3.2) sends them: they can carry launch bundles and keyed URLs, and every /live client sees this.
   */
  async function processes({ detail = false } = {}) {
    await ensureOnline();
    const id = randomUUID();
    const msg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { btPending.delete(id); reject(new LumenError('FAILED', 'Lumen Eyes did not answer about memory (it needs Eyes 0.3.2)')); }, detail ? 20000 : 10000);
      btPending.set(id, { resolve, reject, timer });
      active.send(JSON.stringify({ t: 'procs', id, detail: detail ? 1 : 0 }));
    });
    const { t, id: _id, procs, seen, unreadable, apps, ...rest } = msg;
    const out = { ...rest };
    if (Array.isArray(apps)) {
      out.apps = apps.map((a) => {
        if (!a || typeof a !== 'object' || a.error) return a;
        const { id: appId, pid, state, rssKb, pssKb } = a;
        return detail ? { id: appId, pid, state, rssKb, pssKb } : { id: appId, pid, state };
      });
    }
    if (detail) {
      if (Array.isArray(procs)) out.procs = procs.map((p) => ({ pid: p?.pid, name: p?.name, rssKb: p?.rssKb }));
      if (seen !== undefined) out.seen = seen;
      if (unreadable !== undefined) out.unreadable = unreadable;
    }
    return out;
  }

  // ---- watching (the Screen view) ----

  function setError(err) {
    const value = err ? { code: err.code ?? 'FAILED', message: String(err.message ?? err).slice(0, 200) } : null;
    if (JSON.stringify(store.get('screen.error')?.v ?? null) !== JSON.stringify(value)) {
      store.set('screen.error', value, { src: 'derived', via: 'eyes:watch' });
    }
  }

  function schedule(ms) {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(watchTick, ms);
  }

  async function watchTick() {
    if (!watchEveryMs || stopped || watchBusy) return;
    watchBusy = true;
    const t0 = Date.now();
    let failed = false;
    try {
      await capture({ mode: 0 });
      setError(null);
    } catch (err) {
      failed = true;
      setError(err);
    } finally {
      watchBusy = false;
    }
    if (!watchEveryMs || stopped) return;
    schedule(failed ? Math.max(watchEveryMs, WATCH_RETRY_MS) : Math.max(0, watchEveryMs - (Date.now() - t0)));
  }

  // hub presence: screenEveryMs > 0 while a visible client shows the Screen view.
  function setDemand({ screenEveryMs = 0, views } = {}) {
    // Settings shows Bluetooth: refresh it when someone opens Settings, at most once a minute.
    if (views?.has?.('settings') && Date.now() - btAt > 60000) {
      btAt = Date.now();
      bluetooth().catch((err) => log.debug('bluetooth refresh failed', { message: err.message }));
    }
    const next = Number.isInteger(screenEveryMs) && screenEveryMs > 0 ? screenEveryMs : 0;
    if (next === watchEveryMs) return;
    watchEveryMs = next;
    store.set('screen.watching', next, { src: 'derived', via: 'eyes:watch' });
    if (!next) {
      clearTimeout(watchTimer);
      setError(null);
    } else if (!watchBusy) {
      schedule(0); // a new or faster cadence starts with a fresh still
    }
  }

  // ---- lifecycle ----

  return {
    /** Eyes' version while connected (null otherwise). */
    version: () => version,
    start() {
      if (started) return;
      started = true;
      if (lan) unroute = lan.route('/eyes', { upgrade: onUpgrade });
      setConn('offline');
    },
    setDemand,
    async stop() {
      stopped = true;
      clearTimeout(watchTimer);
      unroute?.();
      queue.clear(new LumenError('UNAVAILABLE', 'Lumen is stopping'));
      failPending('Lumen is stopping');
      for (const resolve of waiters) resolve();
      waiters.clear();
      active?.close(1001, 'Lumen is stopping');
      active = null;
      for (const client of wss.clients) client.terminate();
    },
    capture,
    bluetooth,
    scanBluetooth,
    stopBluetoothScan,
    pairBluetooth,
    connectBluetooth,
    disconnectBluetooth,
    processes,
    latest: () => latest,
    status: () => ({ online: online(), version, lastCaptureAt: latest?.at ?? null }),
  };
}
