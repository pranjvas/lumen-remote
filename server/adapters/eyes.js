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

const digest = (s) => createHash('sha256').update(s).digest();

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
  function setDemand({ screenEveryMs = 0 } = {}) {
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
    latest: () => latest,
    status: () => ({ online: online(), version, lastCaptureAt: latest?.at ?? null }),
  };
}
