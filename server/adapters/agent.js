// On-TV agent ingress: the Lumen Agent page (companion/agent) connects out to the TV-facing listener at
// ws://<pc>:<lanPort>/agent?key=<agentKey>, reports TV state, and answers requests (apps, icon, exit, open-url).
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { LumenError } from '../errors.js';
import { createQueue } from '../util/queue.js';
import { APPS } from '../catalog/apps.js';

const STATE_TTL_MS = 3 * 5000;
const OFFLINE_AFTER_MS = 15000;
const STARTUP_GRACE_MS = 35000; // longer than the agent's longest reconnect backoff (30 s)
const LAUNCH_TIMEOUT_MS = 20000;
const AUTO_LAUNCH_GAP_MS = 10 * 60 * 1000; // the agent is started again by itself at most this often
const AUTO_CHECK_GAP_MS = 30 * 1000; // after the TV did not answer, it is not asked again for this long
const OFFLINE_RECHECK_MS = 8000; // an agent gone offline: how long before deciding to start it again
const REQUEST_TIMEOUT_MS = 8000;
const ICON_RETRY_MS = 10 * 60 * 1000;
const MAX_ICON_BYTES = 512 * 1024;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
// Browser-screen frames on their way to the TV at once (each confirmed by a ping's pong; see sendFrame).
const FRAME_WINDOW = 1;
const FRAME_PONG_TIMEOUT_MS = 1500;
const REQUEST_TYPES = new Set(['apps', 'icon', 'exit', 'open-url', 'launch', 'meta', 'screen', 'caps']);
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const URL_MAX_LENGTH = 4096;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SOURCE_ORDER = ['TV', 'HDMI', 'AV', 'COMPONENT'];
const CATALOG = new Map(APPS.map((app, rank) => [app.id, { ...app, rank }]));

// The agent sees Tizen app ids; REST launches store ids and <10-char package>.<name> ids and rejects
// org.tizen.* / com.samsung.* ids. These pairs were matched by name and version on this Q95T (probe 2026-10-21).
const STORE_IDS = new Map([
  ['org.tizen.netflix-app', '3201907018807'],
  ['9Ur5IzDKqV.TizenYouTube', '111299001912'],
  ['org.tizen.primevideo', '3201910019365'],
  ['com.samsung.tv.aria-video', '3201807016597'],
  ['org.tizen.browser', '3201907018784'],
  ['org.tizen.apple.apple-music', '3201908019041'],
  ['rJeHak5zRg.Spotify', '3201606009684'],
  ['kIciSQlYEM.plex', '3201512006963'],
  ['com.samsung.tv.iot-dashboard', '3201910019378'],
  ['com.samsung.tv.gallery', '3201710015037'],
  ['AQKO41xyKP.AmazonAlexa', '3202004020626'],
]);
const TIZEN_IDS = new Map([...STORE_IDS].map(([tizenId, storeId]) => [storeId, tizenId]));
const REST_LAUNCHABLE = /^(\d+|[A-Za-z0-9]{10}\.[A-Za-z0-9_-]+)$/;
const BACKGROUND_SERVICE = /service$/i;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max = 200) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const digest = (s) => createHash('sha256').update(s).digest();

// The version build.ps1 stamps into the agent comes from companion/agent/config.xml.
function bundledAgentVersion() {
  try {
    const xml = readFileSync(new URL('../../companion/agent/config.xml', import.meta.url), 'utf8');
    const match = /<widget\b[^>]*\sversion="([^"]+)"/.exec(xml);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Spec §9.5: { type: 'TV' } → 'TV', HDMI n → 'HDMIn', AV n → 'AVn', COMP n → 'COMPONENTn', other → type + number.
function sourceName(source) {
  if (!source || typeof source.type !== 'string' || !source.type) return null;
  const type = source.type.toUpperCase();
  const number = Number.isInteger(source.number) ? String(source.number) : '';
  if (type === 'TV') return 'TV';
  return `${type === 'COMP' ? 'COMPONENT' : type}${number}`.slice(0, 32);
}

function sortSources(names) {
  const rank = (name) => {
    const [, type, n] = /^(\D*)(\d*)$/.exec(name) || [name, name, ''];
    const order = SOURCE_ORDER.indexOf(type);
    return [order < 0 ? SOURCE_ORDER.length : order, type, Number(n) || 0];
  };
  return [...new Set(names.filter(Boolean))].sort((a, b) => {
    const [oa, ta, na] = rank(a);
    const [ob, tb, nb] = rank(b);
    return oa - ob || ta.localeCompare(tb) || na - nb;
  });
}

function channelOf(channel) {
  if (!channel || typeof channel !== 'object') return null;
  return {
    name: str(channel.name, 80),
    number: channel.number === null || channel.number === undefined ? null : String(channel.number).slice(0, 20),
    type: str(channel.type, 40),
  };
}

// Only http(s) pages may be sent to the TV browser (spec §11.3: no javascript: or file:).
function isWebUrl(url) {
  if (typeof url !== 'string' || !url || url.length > URL_MAX_LENGTH) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const clock = (t) => (typeof t === 'number' && Number.isFinite(t) ? new Date(t).toISOString().slice(11, 23) : null);
const boxKey = (e) => `${e?.t}|${String(e?.k ?? '').slice(0, 24)}`;
const BOX_DATA_MAX = 300;
const BOX_CONTEXT = 3;

/**
 * The agent's black box (the hello's `box`, oldest first) as one log line: the entries the PC has
 * not logged already as they happened (`streamed`: `${t}|${k}` keys of the 'box' notes), plus the
 * last few it has for context, in time order. Whole entries are dropped oldest first until the
 * entries' JSON fits in `max` characters, so the newest ones (just before a cut-off) always stay
 * and the line is always valid JSON. → { count, fresh, alreadyLogged, dropped, entries }
 */
export function formatBox(box, streamed = new Set(), max = 4000) {
  const all = (Array.isArray(box) ? box : []).filter((e) => e && typeof e === 'object')
    .map((e, i) => ({ e, i })).sort((x, y) => ((x.e.t ?? 0) - (y.e.t ?? 0)) || (x.i - y.i)).map(({ e }) => e);
  const seen = [];
  const fresh = [];
  all.forEach((e, i) => (streamed.has(boxKey(e)) ? seen : fresh).push(i));
  const keep = new Set([...fresh, ...seen.slice(-BOX_CONTEXT)]);
  const chosen = all.filter((e, i) => keep.has(i)).map((e) => {
    let d = e.d ?? null;
    const text = JSON.stringify(d) ?? 'null';
    if (text.length > BOX_DATA_MAX) d = `${text.slice(0, BOX_DATA_MAX)}…`;
    return { t: clock(e.t), k: String(e.k ?? '').slice(0, 24), d };
  });
  const out = [];
  let length = 2; // []
  for (let i = chosen.length - 1; i >= 0; i--) {
    const size = JSON.stringify(chosen[i]).length + (out.length ? 1 : 0);
    if (length + size > max) break;
    out.push(chosen[i]);
    length += size;
  }
  out.reverse();
  return { count: all.length, fresh: fresh.length, alreadyLogged: seen.length, dropped: chosen.length - out.length, entries: out };
}

// The screen state an agent (0.8.7+) reports in its hello: { active, hidden?, video: { state, mode, position, id } | null }.
function screenStateOf(screen) {
  if (!screen || typeof screen !== 'object') return { active: false, hidden: null, video: null };
  const v = screen.video && typeof screen.video === 'object' ? screen.video : null;
  return {
    active: screen.active === true,
    hidden: typeof screen.hidden === 'boolean' ? screen.hidden : null,
    video: v ? { state: str(v.state, 20), mode: str(v.mode, 10), position: num(v.position), id: num(v.id) } : null,
  };
}

function decodeIcon(dataUrl) {
  const match = typeof dataUrl === 'string' ? /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl) : null;
  if (!match) return null;
  const buffer = Buffer.from(match[1], 'base64');
  const valid = buffer.length > PNG_MAGIC.length && buffer.length <= MAX_ICON_BYTES
    && buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
  return valid ? buffer : null;
}

export function createAgent({ config, data, log: rootLog, store, lan, rest }) {
  const log = rootLog.child('agent');
  const appId = config.agent.appId;
  const expectedVersion = config.agent.version || bundledAgentVersion();
  const iconsDir = path.join(config.dataDir, 'icons');
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const queue = createQueue({ concurrency: 1, minGapMs: 0 });
  const pending = new Map(); // rid → { resolve, reject, timer }
  const icons = new Map(); // appId → PNG buffer
  const iconFailures = new Map(); // appId → time of the last failed fetch
  const iconQueued = new Set();

  let started = false;
  let stopped = false;
  let active = null;
  let connState = 'unknown';
  let installed = [];
  let unroute = null;
  let diskIcons = null;
  let silenceTimer = null;
  let launchTimer = null;
  let graceTimer = null;
  let publishTimer = null;

  const meta = (field, extra) => ({ src: 'agent', via: `agent:${field}`, ttlMs: STATE_TTL_MS, ...extra });

  function setConn(state) {
    connState = state;
    store.set('conn.agent', state, { src: 'derived', via: 'agent:link' });
    // Gone while a phone shows Lumen and the TV is on (killed for memory): a moment later, so a TV
    // that is going to sleep has said so first. Not when it was showing Lumen's browser: the TV screen
    // feature recovers that agent itself, and leaves it closed behind another app.
    if (state === 'offline' && store.get('tvscreen.on')?.v !== true) {
      setTimeout(() => autoLaunch('the agent went offline'), OFFLINE_RECHECK_MS).unref?.();
    }
  }

  function setNote(note) {
    store.set('conn.agentNote', note, { src: 'derived', via: 'agent:hello' });
  }

  // ---- authentication ----

  function agentKey() {
    const key = config.secrets?.agentKey ?? data.readJson('secrets.json', {})?.agentKey;
    return typeof key === 'string' && key ? key : null;
  }

  // Hashing both sides first makes the comparison constant-time regardless of length.
  function keyMatches(given) {
    const expected = agentKey();
    return Boolean(expected && typeof given === 'string' && given && timingSafeEqual(digest(given), digest(expected)));
  }

  function onUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://agent.invalid');
    if (stopped || url.pathname !== '/agent' || !keyMatches(url.searchParams.get('key'))) {
      log.warn('agent connection rejected', { path: url.pathname });
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, onConnection);
  }

  // ---- connection lifecycle ----

  function onConnection(ws) {
    if (active) {
      failPending('The TV agent reconnected');
      active.close(4000, 'replaced by a newer connection');
    }
    active = ws;
    clearTimeout(graceTimer);
    touch(ws);
    // A new connection has not been told to show the browser screen (features/tvscreen.js).
    dispatchScreen({ t: 'screen-link' });
    ws.on('message', (raw, isBinary) => {
      if (ws !== active || isBinary) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      touch(ws);
      handleMessage(msg);
    });
    ws.on('pong', (data) => { onFramePong(ws, data); onVideoPong(ws, data); });
    ws.on('close', () => {
      clearTimeout(frameQueues.get(ws)?.timer);
      if (ws === active) log.info('agent disconnected');
      drop(ws);
    });
    ws.on('error', (err) => log.debug('agent socket error', { message: err.message }));
  }

  function drop(ws) {
    if (ws !== active) return;
    active = null;
    clearTimeout(silenceTimer);
    failPending('The TV agent disconnected');
    if (!stopped && connState !== 'launching') setConn('offline');
  }

  // Any message counts as a sign of life; 15 s of silence means the agent is gone.
  function touch(ws) {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (ws !== active) return;
      log.info('agent silent for 15 s');
      drop(ws);
      ws.terminate();
    }, OFFLINE_AFTER_MS);
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      onHello(msg).catch((err) => log.warn('agent hello handling failed', { message: err.message }));
    } else if (msg.t === 'state') {
      if (connState !== 'online') setConn('online');
      applySnapshot(msg.snapshot);
    } else if (msg.t === 'event') {
      const volume = num(msg.value);
      if (msg.kind === 'volume' && volume !== null && volume >= 0 && volume <= 100) {
        store.set('audio.volume', volume, meta('event', { range: [0, 100] }));
      }
    } else if (msg.t === 'box') {
      // A black-box note as it happens (agent 0.8.6+), so the log has it even if the TV kills the page.
      const e = msg.e && typeof msg.e === 'object' ? msg.e : {};
      noteStreamed(e);
      log.info('agent note', { t: clock(e.t), k: String(e.k ?? '').slice(0, 24), d: (JSON.stringify(e.d ?? null) ?? 'null').slice(0, 300) });
    } else if (msg.t === 'reply') {
      onReply(msg);
    } else if (typeof msg.t === 'string' && msg.t.startsWith('screen-') && msg.t !== 'screen-sync' && msg.t !== 'screen-link') {
      // The browser screen on the TV (agent 0.6.0+): remote keys, pointer, video player state.
      dispatchScreen(msg);
    }
  }

  const screenListeners = new Set();
  function dispatchScreen(msg) {
    for (const listener of screenListeners) {
      try { listener(msg); } catch (err) { log.debug('screen listener failed', { message: err.message }); }
    }
  }

  // Black-box notes logged as they happened on this connection: the next hello's box skips them.
  const streamed = new Set();
  function noteStreamed(e) {
    streamed.add(boxKey(e));
    while (streamed.size > 300) streamed.delete(streamed.values().next().value);
  }
  const isOpen = () => Boolean(active && active.readyState === WebSocket.OPEN);
  /** JSON to the agent's screen module (screen-cursor, screen-play, screen-toast). */
  function sendScreen(msg) {
    if (!isOpen()) return false;
    active.send(JSON.stringify(msg));
    return true;
  }
  /** One JPEG frame for the browser screen. At most FRAME_WINDOW frames are on their way to the TV:
   *  each is followed by a WebSocket ping, and the TV's pong (its browser answers on its own, after
   *  everything sent before the ping arrived) frees its place. A newer frame replaces one still
   *  waiting, so a slow TV link shows the newest frame instead of working through seconds of old ones
   *  held in socket buffers, and control messages such as screen-play stay quick. A TV that never
   *  pongs gets one frame per completed socket write instead. */
  const frameQueues = new WeakMap(); // agent socket → { next, writing, inFlight: [{ id, at }], lastId, pongs, timer }
  function sendFrame(bytes) {
    if (!isOpen()) return false;
    const ws = active;
    let queue = frameQueues.get(ws);
    if (!queue) frameQueues.set(ws, (queue = { next: null, writing: false, inFlight: [], lastId: 0, pongs: null, timer: null }));
    queue.next = bytes;
    writeFrame(ws, queue);
    return true;
  }
  function writeFrame(ws, queue) {
    clearTimeout(queue.timer);
    queue.timer = null;
    if (!queue.next || ws !== active || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (queue.inFlight.length && now - queue.inFlight[0].at > FRAME_PONG_TIMEOUT_MS) {
      if (queue.pongs === null) queue.pongs = false; // no pong ever: pace on socket writes only
      queue.inFlight = queue.inFlight.filter((f) => now - f.at <= FRAME_PONG_TIMEOUT_MS);
    }
    if (queue.writing) return;
    if (queue.pongs !== false && queue.inFlight.length >= FRAME_WINDOW) {
      queue.timer = setTimeout(() => writeFrame(ws, queue), queue.inFlight[0].at + FRAME_PONG_TIMEOUT_MS + 1 - now);
      return;
    }
    const bytes = queue.next;
    queue.next = null;
    queue.writing = true;
    ws.send(bytes, { binary: true }, () => {
      queue.writing = false;
      writeFrame(ws, queue);
    });
    // Pinged even without pongs so far: one arriving late turns the window back on.
    queue.lastId = (queue.lastId + 1) >>> 0;
    const id = Buffer.alloc(4);
    id.writeUInt32BE(queue.lastId);
    queue.inFlight.push({ id: queue.lastId, at: now });
    ws.ping(id);
  }
  function onFramePong(ws, data) {
    const queue = frameQueues.get(ws);
    if (!queue || !Buffer.isBuffer(data) || data.length !== 4) return;
    const id = data.readUInt32BE(0);
    queue.pongs = true;
    queue.inFlight = queue.inFlight.filter((f) => f.id > id);
    writeFrame(ws, queue);
  }

  /** Live video (features/livevideo.js): one init segment or fragment message, followed by a ping
   *  ('V' + id) whose pong says the TV's page has taken everything before it. Not sent while more than
   *  `limit` bytes are on their way (the caller then skips to the next key frame). */
  const videoFlights = new WeakMap(); // agent socket → { list: [{ id, at, bytes }], lastId, pongs }
  function videoFlight(ws) {
    let f = videoFlights.get(ws);
    if (!f) videoFlights.set(ws, (f = { list: [], lastId: 0, pongs: false }));
    return f;
  }
  function videoBacklog() {
    if (!isOpen()) return { bytes: 0, oldestMs: 0 };
    const f = videoFlight(active);
    // Without pongs (a TV that never answers) only the socket's own queue is known.
    if (!f.pongs) return { bytes: active.bufferedAmount, oldestMs: 0 };
    const now = Date.now();
    f.list = f.list.filter((x) => now - x.at < 30000);
    return { bytes: f.list.reduce((n, x) => n + x.bytes, 0), oldestMs: f.list.length ? now - f.list[0].at : 0 };
  }
  function sendVideo(bytes, { limit = Infinity } = {}) {
    if (!isOpen() || videoBacklog().bytes > limit) return false;
    const ws = active;
    const f = videoFlight(ws);
    ws.send(bytes, { binary: true });
    f.lastId = (f.lastId + 1) >>> 0;
    const id = Buffer.alloc(5);
    id[0] = 0x56; // 'V'
    id.writeUInt32BE(f.lastId, 1);
    f.list.push({ id: f.lastId, at: Date.now(), bytes: bytes.length });
    ws.ping(id);
    return true;
  }
  function onVideoPong(ws, data) {
    if (!Buffer.isBuffer(data) || data.length !== 5 || data[0] !== 0x56) return;
    const f = videoFlight(ws);
    const id = data.readUInt32BE(1);
    f.pongs = true;
    f.list = f.list.filter((x) => x.id > id);
  }
  /** Bytes of live video sent but not yet taken by the TV (or waiting in the socket). */
  const bufferedAmount = () => videoBacklog().bytes;

  async function onHello(msg) {
    // The agent's black box: what happened on the TV before it was last cut off.
    if (Array.isArray(msg.box) && msg.box.length) log.info('agent black box', formatBox(msg.box, streamed));
    streamed.clear();
    clearTimeout(launchTimer);
    const version = str(msg.agent, 40);
    const pcHost = str(msg.pcHost, 64);
    setConn('online');
    log.info('agent connected', { version, pcHost });
    applySnapshot(msg.snapshot);
    // What the agent's browser screen shows (agent 0.8.7+; known: false for older agents), so the TV
    // screen feature can carry on after a reconnect, or turn off a screen this server did not open.
    dispatchScreen({ t: 'screen-sync', known: Boolean(msg.screen && typeof msg.screen === 'object'), ...screenStateOf(msg.screen) });
    setNote(await rebuildNote(version, pcHost));
    await refreshApps();
  }

  async function rebuildNote(version, pcHost) {
    const reasons = [];
    if (expectedVersion && version !== expectedVersion) {
      reasons.push(`it runs ${version || 'an unknown version'}, this server expects ${expectedVersion}`);
    }
    const listener = lan ? await lan.ready : null;
    if (listener && listener.address && pcHost !== listener.address) {
      reasons.push(`it was built for ${pcHost || 'an unknown address'}, this PC is now ${listener.address}`);
    }
    return reasons.length ? `Rebuild the TV agent: ${reasons.join('; ')}` : null;
  }

  // ---- state mapping (spec §8.3, §9.5) ----

  function applySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    const put = (key, value, field, extra) => {
      if (value !== null && value !== undefined) store.set(key, value, meta(field, extra));
    };

    put('input.source', sourceName(snap.source), 'source');
    if (Array.isArray(snap.connected)) {
      const connected = sortSources(snap.connected.map(sourceName));
      put('input.connected', connected, 'connected');
      if (Array.isArray(snap.disconnected)) {
        put('input.available', sortSources([...connected, ...snap.disconnected.map(sourceName)]), 'disconnected');
      }
    }
    if ('channel' in snap) store.set('channel.current', channelOf(snap.channel), meta('channel'));

    const audio = snap.audio && typeof snap.audio === 'object' ? snap.audio : {};
    const volume = num(audio.volume);
    if (volume !== null && volume >= 0 && volume <= 100) put('audio.volume', volume, 'audio.volume', { range: [0, 100] });
    if (typeof audio.mute === 'boolean') put('audio.mute', audio.mute, 'audio.mute');
    put('audio.outputCodec', str(audio.outputCodec, 40), 'audio.outputCodec');

    if (snap.caption === 'on' || snap.caption === 'off') put('caption.state', snap.caption, 'caption');

    // Firmware and panel size are facts about the set, not live readings, so they carry no TTL.
    const build = str(snap.build);
    if (build) store.set('device.firmware', build, { src: 'agent', via: 'agent:build' });
    if (snap.panel && num(snap.panel.w) && num(snap.panel.h)) {
      store.set('device.panel', `${snap.panel.w}x${snap.panel.h}`, { src: 'agent', via: 'agent:panel' });
    }

    // Network and Bluetooth (agent 0.6.3+): read-only facts for Settings.
    if (snap.network && typeof snap.network === 'object') {
      const n = snap.network;
      const pick = (o, fields) => (o && typeof o === 'object' ? Object.fromEntries(fields.map((f) => [f, typeof o[f] === 'number' ? o[f] : str(o[f], 80)])) : null);
      put('network.type', str(n.type, 20), 'network');
      store.set('network.wifi', pick(n.wifi, ['status', 'ssid', 'ip', 'signal', 'gateway', 'dns', 'mac']), meta('network'));
      store.set('network.ethernet', pick(n.ethernet, ['status', 'cable', 'ip', 'gateway', 'dns', 'mac']), meta('network'));
    }
    // TV web apps get no Bluetooth API on this firmware (null); Lumen Eyes (.NET) reports it instead.
    if (snap.bluetooth && typeof snap.bluetooth === 'object') {
      const bt = snap.bluetooth;
      store.set('bluetooth.state', bt && typeof bt === 'object' ? {
        name: str(bt.name, 60), powered: typeof bt.powered === 'boolean' ? bt.powered : null,
        devices: Array.isArray(bt.devices) ? bt.devices.slice(0, 20).map((d) => ({ name: str(d?.name, 60) ?? 'Unnamed device', bonded: d?.bonded === true, connected: d?.connected === true, kind: str(d?.kind, 30) })) : null,
      } : null, meta('bluetooth'));
    }

    const system = snap.system && typeof snap.system === 'object' ? snap.system : {};
    const cpuLoad = num(system.cpuLoad);
    if (cpuLoad !== null) put('system.cpuLoad', Math.min(1, Math.max(0, cpuLoad)), 'system.cpuLoad', { range: [0, 1] });
    for (const field of ['memAvailable', 'memTotal', 'storageFree', 'storageTotal']) {
      const bytes = num(system[field]);
      if (bytes !== null && bytes >= 0) put(`system.${field}`, bytes, `system.${field}`);
    }
  }

  // ---- requests ----

  function request(type, args = {}) {
    if (!REQUEST_TYPES.has(type)) return Promise.reject(new LumenError('INVALID', `Unknown agent request "${type}"`));
    if (type === 'open-url' && !isWebUrl(args.url)) {
      return Promise.reject(new LumenError('INVALID', 'Open on TV needs an http(s) URL'));
    }
    const ws = active;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new LumenError('UNAVAILABLE', 'The TV agent is not connected'));
    }
    const rid = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(rid);
        reject(new LumenError('FAILED', 'The TV agent did not answer in time'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(rid, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...args, t: 'req', rid, type }), (err) => {
        if (err) settle(rid, null, new LumenError('UNAVAILABLE', 'The TV agent connection dropped'));
      });
    });
  }

  function settle(rid, value, error) {
    const entry = pending.get(rid);
    if (!entry) return;
    pending.delete(rid);
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve({ value });
  }

  function onReply(msg) {
    if (typeof msg.rid !== 'string') return;
    if (msg.ok) settle(msg.rid, msg.data);
    else settle(msg.rid, null, new LumenError('FAILED', `The TV agent could not do that: ${str(msg.error) || 'unknown error'}`));
  }

  function failPending(message) {
    for (const rid of [...pending.keys()]) settle(rid, null, new LumenError('UNAVAILABLE', message));
  }

  // ---- installed apps ----

  // Keeps the apps a user can launch over REST (store ids or <10-char package> ids, minus background
  // services), keyed by that launch id; the Tizen id is kept for icon requests.
  async function refreshApps() {
    const { value } = await request('apps');
    if (!Array.isArray(value)) throw new LumenError('FAILED', 'The TV agent sent an invalid app list');
    await loadDiskIcons();
    const byId = new Map();
    for (const app of value) {
      if (!app || typeof app.id !== 'string' || !APP_ID.test(app.id) || BACKGROUND_SERVICE.test(app.id)) continue;
      const id = STORE_IDS.get(app.id) || app.id;
      if (!REST_LAUNCHABLE.test(id) || byId.has(id)) continue;
      byId.set(id, { id, tizenId: app.id, name: str(app.name, 80) || id, hasIcon: Boolean(app.iconPath) });
    }
    installed = [...byId.values()];
    log.info('agent app list', { reported: value.length, launchable: installed.length });
    publishInstalled();
    for (const app of installed) {
      if (app.hasIcon && !iconKnown(app.id)) queueIcon(app.id, 'poll').catch(() => {});
    }
  }

  function tizenIdOf(id) {
    const app = installed.find((a) => a.id === id);
    return app ? app.tizenId : TIZEN_IDS.get(id) || id;
  }

  function publishInstalled() {
    clearTimeout(publishTimer);
    publishTimer = null;
    if (!installed.length) return;
    const list = installed.map((app) => {
      const curated = CATALOG.get(app.id);
      return {
        id: app.id,
        name: curated ? curated.name : app.name,
        color: curated ? curated.color : null,
        short: curated ? curated.short : null,
        icon: iconKnown(app.id) ? `/api/icon/${app.id}` : null,
        rank: curated ? curated.rank : Infinity,
      };
    });
    list.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    store.set('app.installed', list.map(({ rank, ...app }) => app), { src: 'agent', via: 'agent:apps' });
  }

  function schedulePublish() {
    publishTimer ??= setTimeout(publishInstalled, 1000);
  }

  // ---- icons: memory → data/icons/<id>.png → agent request ----

  async function loadDiskIcons() {
    if (diskIcons) return;
    const names = await fs.readdir(iconsDir).catch(() => []);
    diskIcons = new Set(names.filter((n) => n.endsWith('.png')).map((n) => n.slice(0, -4)));
  }

  function iconKnown(id) {
    return icons.has(id) || Boolean(diskIcons && diskIcons.has(id));
  }

  async function readIconFile(id) {
    try {
      const buffer = await fs.readFile(path.join(iconsDir, `${id}.png`));
      return buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) ? buffer : null;
    } catch {
      return null;
    }
  }

  async function saveIconFile(id, buffer) {
    const file = path.join(iconsDir, `${id}.png`);
    try {
      await fs.mkdir(iconsDir, { recursive: true });
      await fs.writeFile(`${file}.tmp`, buffer);
      await fs.rename(`${file}.tmp`, file);
      if (diskIcons) diskIcons.add(id);
    } catch (err) {
      log.warn('could not save app icon', { id, message: err.message });
    }
  }

  function queueIcon(id, priority) {
    if (priority === 'poll') {
      if (iconQueued.has(id)) return Promise.resolve(null);
      iconQueued.add(id);
    }
    return queue.push(() => fetchIcon(id), { priority }).finally(() => {
      if (priority === 'poll') iconQueued.delete(id);
    });
  }

  async function fetchIcon(id) {
    if (icons.has(id)) return icons.get(id);
    const failedAt = iconFailures.get(id);
    if (failedAt && Date.now() - failedAt < ICON_RETRY_MS) return null;
    try {
      const { value } = await request('icon', { appId: tizenIdOf(id) });
      const buffer = decodeIcon(value);
      if (!buffer) throw new LumenError('FAILED', 'The TV agent sent an invalid icon');
      icons.set(id, buffer);
      await saveIconFile(id, buffer);
      schedulePublish();
      return buffer;
    } catch (err) {
      if (err.code !== 'UNAVAILABLE') iconFailures.set(id, Date.now());
      log.debug('app icon unavailable', { id, message: err.message });
      return null;
    }
  }

  async function getIcon(id) {
    if (typeof id !== 'string' || !APP_ID.test(id)) return null;
    let buffer = icons.get(id);
    if (!buffer) {
      buffer = await readIconFile(id);
      if (buffer) icons.set(id, buffer);
    }
    if (!buffer && active) buffer = await queueIcon(id, 'user').catch(() => null);
    return buffer ? { type: 'image/png', buffer } : null;
  }

  // ---- launch (explicit user action only) ----

  async function launch() {
    if (connState === 'online') return { value: 'online' };
    const tv = store.get('conn.tv');
    if (tv && (tv.v === 'standby' || tv.v === 'off')) throw new LumenError('TV_OFF', 'Turn the TV on first');
    clearTimeout(graceTimer);
    clearTimeout(launchTimer);
    setConn('launching');
    launchTimer = setTimeout(() => {
      if (connState !== 'launching') return;
      setConn('offline');
      setNote("The TV agent did not connect within 20 s. If this PC's network address changed, rebuild the TV agent.");
    }, LAUNCH_TIMEOUT_MS);
    try {
      await rest.launch(appId);
    } catch (err) {
      if (connState === 'online') return { value: 'online' };
      clearTimeout(launchTimer);
      setConn('offline');
      log.warn('agent launch failed', { message: err.message });
      throw new LumenError('FAILED', 'Open "Lumen Agent" from the TV Apps screen');
    }
    return { value: connState };
  }

  // ---- lifecycle ----

  function start() {
    if (started) return;
    started = true;
    if (lan) unroute = lan.route('/agent', { upgrade: onUpgrade });
    setConn('unknown');
    setNote(null);
    graceTimer = setTimeout(() => {
      if (connState === 'unknown') setConn('offline');
    }, STARTUP_GRACE_MS);
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    for (const timer of [silenceTimer, launchTimer, graceTimer, publishTimer]) clearTimeout(timer);
    publishTimer = null;
    if (typeof unroute === 'function') unroute();
    failPending('Lumen is stopping');
    if (active) active.close(1001, 'server stopping');
    active = null;
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(() => resolve()));
  }

  // ---- coming back by itself: the agent quits when the TV sleeps, and channel, input and app updates
  // stop with it (seen 25 Oct: the phone's channel stayed on last night's). While a phone shows Lumen
  // and the TV is on, an agent that is offline is started again (it steps aside on the TV in a moment),
  // at most once per AUTO_LAUNCH_GAP_MS.
  let watched = false; // a phone shows Lumen
  let lastAutoLaunch = 0; // the last launch the TV accepted
  let lastCheck = 0;
  let checking = false;
  async function autoLaunch(why) {
    // 'unknown': the start-up grace, in which a running agent reconnects by itself (a launch then
    // would only flash it on the TV). Lumen's browser on the TV recovers its agent itself (tvscreen).
    if (checking || stopped || !started || !watched || connState !== 'offline') return;
    if (store.get('conn.tv')?.v !== 'on' || store.get('tvscreen.on')?.v === true) return;
    const now = Date.now();
    if (now - lastAutoLaunch < AUTO_LAUNCH_GAP_MS || now - lastCheck < AUTO_CHECK_GAP_MS) return;
    if (typeof rest?.foregroundSweep !== 'function') return;
    checking = true;
    try {
      // Never over another app (Netflix, YouTube): the card would cover it. The polled foreground can
      // lag minutes and misses apps outside the catalog, so every app Lumen knows is asked now; a TV
      // that does not answer (going to sleep) gets no launch.
      const front = await rest.foregroundSweep();
      if (front) { log.debug('TV agent not started: an app is in front', { app: front.name ?? front.id }); return; }
      if (stopped || !watched || connState !== 'offline' || store.get('tvscreen.on')?.v === true) return;
      log.info('starting the TV agent again', { why });
      await launch();
      lastAutoLaunch = Date.now();
    } catch (err) {
      lastCheck = Date.now(); // the TV did not answer or refused: not asked again straight away
      log.debug('TV agent auto-start skipped', { message: err.message });
    } finally {
      checking = false;
    }
  }
  // The TV waking (conn.tv is published on every poll: only the change to 'on' counts).
  let tvWas = store.get('conn.tv')?.v ?? null;
  const unpatch = store.on?.('patch', (patch) => {
    if (!('conn.tv' in patch)) return;
    const now = patch['conn.tv']?.v ?? null;
    const woke = now === 'on' && tvWas !== null && tvWas !== 'on';
    tvWas = now;
    if (woke) autoLaunch('the TV is on');
  });

  return {
    start,
    async stop() {
      unpatch?.();
      return stop();
    },
    setDemand({ visible = false } = {}) {
      const opened = visible && !watched;
      watched = visible;
      if (opened) autoLaunch('a phone opened Lumen');
    },
    launch,
    request,
    getIcon,
    /** The Tizen app id behind an app.installed (launch) id; Eyes and the TV report running apps by it. */
    tizenIdOf,
    sendScreen,
    sendFrame,
    sendVideo,
    bufferedAmount,
    onScreen: (fn) => { screenListeners.add(fn); return () => screenListeners.delete(fn); },
  };
}
