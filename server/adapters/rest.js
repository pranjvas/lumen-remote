// REST adapter (TV port 8001): device info, the power state machine, the foreground app and app launch.
// The TV answers one request at a time (~1.3 s per app query) and never answers paths without a trailing slash,
// so every call goes through one queue with hard timeouts.
import http from 'node:http';
import { createQueue } from '../util/queue.js';
import { LumenError } from '../errors.js';
import { APPS } from '../catalog/apps.js';

const DEVICE_PATH = '/api/v2/';
const DEVICE_TIMEOUT_MS = 6000;
const APP_TIMEOUT_MS = 10000;
const CONNECT_TIMEOUT_MS = 3000;
const MAX_BODY = 256 * 1024;
const OFF_AFTER_FAILURES = 3;
const OFF_POLL_MS = 30000;
const LAUNCH_CONFIRM_MS = 6000;
const LAUNCH_CHECK_GAP_MS = 500;

const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAC = /^[0-9A-Fa-f]{2}([:-]?[0-9A-Fa-f]{2}){5}$/;
// Connect-level failures: the TV's network stack is asleep (deep standby) or gone. ECONNREFUSED is handled apart.
const UNREACHABLE = new Set(['ECONNTIMEOUT', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN']);
const TIZEN_BY_YEAR = { 2016: '2.4', 2017: '3.0', 2018: '4.0', 2019: '5.0', 2020: '5.5', 2021: '6.0', 2022: '6.5', 2023: '7.0', 2024: '8.0', 2025: '9.0' };

const flag = (v) => (v === 'true' || v === '1' || v === true ? true : v === 'false' || v === '0' || v === false ? false : undefined);

// Keeps only display-safe fields: no ids, DUID/UDN, MACs, SSID or IP addresses.
export function normaliseDevice(d = {}) {
  const yy = /^(\d{2})_/.exec(d.model ?? '')?.[1];
  const year = yy ? `20${yy}` : undefined;
  const tizen = d.OS === 'Tizen' && TIZEN_BY_YEAR[year];
  return {
    name: typeof d.name === 'string' ? d.name.replace(/^\[TV\]\s*/, '') : undefined,
    modelName: d.modelName,
    model: d.model,
    os: d.OS,
    platform: tizen ? `Tizen ${tizen}` : undefined,
    resolution: d.resolution,
    language: d.Language,
    country: d.countryCode,
    networkType: d.networkType,
    developerMode: flag(d.developerMode),
    frameTV: flag(d.FrameTVSupport),
    year,
  };
}

export function createRest({ config, data, log: rootLog, store }) {
  const log = rootLog.child('rest');
  const { host } = config.tv;
  const port = config.tv.ports.rest;
  const t = config.timing;
  const queue = createQueue({ concurrency: 1, minGapMs: 50 });
  const appNames = new Map(APPS.map((a) => [a.id, a.name]));
  const candidates = APPS.map((a) => a.id);
  const active = new Set();

  let started = false;
  let stopped = false;
  let visible = false;
  let power = 'unknown';
  let failures = 0;
  let device = {};
  // Kept in data/wake.json (never in the store or the UI) so Lumen can wake the TV after a restart
  // while the TV is off.
  let wakeMac = (() => {
    const saved = data?.readJson?.('wake.json', {})?.mac;
    return typeof saved === 'string' && MAC.test(saved) ? saved : null;
  })();
  let foregroundId = null;
  let foregroundPublished;
  let lastProbeWasForeground = false;
  let roundRobin = 0;
  let misses = 0;

  // A restored cache must never read as "on": other adapters gate their connections on conn.tv.
  publishPower('unknown');

  const deviceInterval = () => (power === 'off' ? OFF_POLL_MS : visible ? t.restVisibleMs : t.restIdleMs);
  const foregroundInterval = () => (visible ? t.restVisibleMs : t.restIdleMs);
  const deviceLoop = createLoop(() => readDevice('poll'), deviceInterval, log);
  const foregroundLoop = createLoop(() => (power === 'on' ? foregroundCheck() : null), foregroundInterval, log);

  function call(method, path, timeoutMs, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request({
        host, port, method, path, agent: false,
        headers: { Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
      });
      let done = false;
      const settle = (fn, value) => { if (done) return; done = true; clearTimeout(timer); active.delete(req); fn(value); };
      const abort = (code, message) => req.destroy(Object.assign(new Error(message), { code }));
      const timer = setTimeout(() => abort('ERESPONSETIMEOUT', `no answer within ${timeoutMs} ms`), timeoutMs);
      req.on('socket', (socket) => {
        if (!socket.connecting) return;
        const connectTimer = setTimeout(() => abort('ECONNTIMEOUT', 'connect timed out'), CONNECT_TIMEOUT_MS);
        socket.once('connect', () => clearTimeout(connectTimer));
        socket.once('close', () => clearTimeout(connectTimer));
      });
      req.on('response', (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY) abort('ETOOBIG', 'response too large');
          else chunks.push(chunk);
        });
        res.on('end', () => settle(resolve, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (err) => settle(reject, err));
      });
      req.on('error', (err) => settle(reject, err));
      active.add(req);
      req.end(payload);
    });
  }

  // Runs one TV request through the queue and records its latency.
  function run(method, path, { priority, timeoutMs, body }) {
    return queue.push(async () => {
      if (stopped) throw new LumenError('UNAVAILABLE', 'Lumen is shutting down');
      const t0 = Date.now();
      const res = await call(method, path, timeoutMs, body);
      store.set('conn.latency.rest', Date.now() - t0, { src: 'derived', via: 'rest', ttlMs: 3 * deviceInterval() });
      return res;
    }, { priority });
  }

  function publishPower(next) {
    const meta = { src: 'live', via: 'rest:/api/v2/', ttlMs: Math.max(10000, 3 * (next === 'off' ? OFF_POLL_MS : t.restIdleMs)) };
    store.set('conn.tv', next, meta);
    store.set('power.state', next, meta);
  }

  function setPower(next) {
    const previous = power;
    power = next;
    publishPower(next);
    if (previous === next) return;
    log.info(`TV power ${previous} -> ${next}`);
    if (next !== 'on') setForeground(null);
    deviceLoop.reschedule();
    if (next === 'on' && started) foregroundLoop.kick();
  }

  function onDeviceError(err) {
    if (err instanceof LumenError) return;
    if (err.code === 'ECONNREFUSED') {
      failures = 0;
      setPower('standby');
    } else if (UNREACHABLE.has(err.code)) {
      failures += 1;
      if (failures >= OFF_AFTER_FAILURES) setPower('off');
    } else {
      log.debug(`device info failed: ${err.code ?? err.message}`);
    }
  }

  function publishDevice(raw) {
    device = normaliseDevice(raw);
    const ttlMs = Math.max(60000, 3 * deviceInterval());
    for (const [key, value] of Object.entries(device)) {
      if (value === undefined) continue;
      const derived = key === 'platform' || key === 'year';
      store.set(`device.${key}`, value, { src: derived ? 'derived' : 'live', via: 'rest:/api/v2/', ttlMs });
    }
    if (typeof raw.wifiMac === 'string' && MAC.test(raw.wifiMac) && raw.wifiMac !== wakeMac) {
      wakeMac = raw.wifiMac;
      try { data?.writeJson?.('wake.json', { mac: wakeMac }); } catch { /* best effort */ }
    }
  }

  async function readDevice(priority) {
    let reachable = false;
    try {
      const res = await run('GET', DEVICE_PATH, { priority, timeoutMs: DEVICE_TIMEOUT_MS });
      failures = 0;
      if (res.status !== 200) {
        log.warn(`device info answered HTTP ${res.status}`);
      } else {
        const raw = JSON.parse(res.body)?.device ?? {};
        reachable = true;
        setPower(raw.PowerState === 'on' ? 'on' : 'standby');
        publishDevice(raw);
      }
    } catch (err) {
      onDeviceError(err);
    }
    return { power, reachable, ...device };
  }

  function setForeground(id, name) {
    foregroundId = id;
    const value = id ? { id, name: appNames.get(id) ?? name ?? id } : null;
    if (id) misses = 0;
    foregroundPublished = value;
    store.set('app.foreground', value, { src: 'live', via: 'rest:applications', ttlMs: Math.max(15000, 4 * foregroundInterval()) });
  }

  function noteApp(app) {
    if (app.visible) setForeground(app.id, app.name);
    else if (app.id === foregroundId) setForeground(null);
  }

  function checkId(id) {
    if (typeof id !== 'string' || !APP_ID.test(id)) throw new LumenError('INVALID', 'Invalid app id');
  }

  function networkError(err) {
    if (err instanceof LumenError) return err;
    if (power === 'off' || power === 'standby') return new LumenError('TV_OFF', 'The TV is off');
    return new LumenError('FAILED', `The TV did not answer (${err.code ?? err.message})`);
  }

  // → app record, or null when the TV says the id is not installed (404).
  async function fetchApp(id, priority, timeoutMs = APP_TIMEOUT_MS) {
    let res;
    try {
      res = await run('GET', `/api/v2/applications/${encodeURIComponent(id)}/`, { priority, timeoutMs });
    } catch (err) {
      throw networkError(err);
    }
    if (res.status === 404) return null;
    if (res.status !== 200) throw new LumenError('FAILED', `The TV answered HTTP ${res.status}`);
    let json;
    try { json = JSON.parse(res.body); } catch { throw new LumenError('FAILED', 'The TV sent an unreadable app status'); }
    const app = { id, name: json.name ?? id, running: json.running === true, version: json.version ?? null, visible: json.visible === true };
    noteApp(app);
    return app;
  }

  function nextCandidate() {
    if (foregroundId && !lastProbeWasForeground) {
      lastProbeWasForeground = true;
      return foregroundId;
    }
    lastProbeWasForeground = false;
    const pool = candidates.filter((id) => id !== foregroundId);
    if (!pool.length) return foregroundId;
    roundRobin %= pool.length;
    return pool[roundRobin++];
  }

  // One probe: alternates the last foreground app with the next curated app.
  async function foregroundCheck() {
    if (power !== 'on' || stopped) return { value: foregroundPublished ?? null };
    try {
      const app = await fetchApp(nextCandidate(), 'poll');
      if (!foregroundId && !app?.visible && ++misses >= candidates.length && foregroundPublished !== null) setForeground(null);
    } catch (err) {
      log.debug(`foreground probe failed: ${err.message}`);
    }
    return { value: foregroundPublished ?? null };
  }

  async function getApp(id) {
    checkId(id);
    const app = await fetchApp(id, 'user');
    if (!app) throw new LumenError('UNAVAILABLE', 'That app is not installed on this TV');
    return { value: app };
  }

  async function launch(id) {
    checkId(id);
    if (power === 'off' || power === 'standby') throw new LumenError('TV_OFF', 'The TV is off');
    let res;
    try {
      res = await run('POST', `/api/v2/applications/${encodeURIComponent(id)}/`, { priority: 'user', timeoutMs: APP_TIMEOUT_MS, body: {} });
    } catch (err) {
      throw networkError(err);
    }
    if (res.status === 404) throw new LumenError('UNAVAILABLE', 'That app is not installed on this TV');
    if (res.status < 200 || res.status >= 300) throw new LumenError('FAILED', `The TV refused the launch (HTTP ${res.status})`);
    log.info(`launched ${id}`);

    const deadline = Date.now() + LAUNCH_CONFIRM_MS;
    let visibleNow = false;
    while (!stopped && !visibleNow && deadline - Date.now() > LAUNCH_CHECK_GAP_MS) {
      await new Promise((r) => setTimeout(r, LAUNCH_CHECK_GAP_MS));
      try {
        visibleNow = (await fetchApp(id, 'user', Math.max(1500, deadline - Date.now())))?.visible === true;
      } catch (err) {
        log.debug(`launch confirm failed: ${err.message}`);
      }
    }
    return { value: { id, visible: visibleNow } };
  }

  // Closes a running app (the same as quitting it on the TV); it starts fresh next time.
  async function close(id) {
    checkId(id);
    if (power === 'off' || power === 'standby') throw new LumenError('TV_OFF', 'The TV is off');
    let res;
    try {
      res = await run('DELETE', `/api/v2/applications/${encodeURIComponent(id)}/`, { priority: 'user', timeoutMs: APP_TIMEOUT_MS });
    } catch (err) {
      throw networkError(err);
    }
    if (res.status === 404) throw new LumenError('UNAVAILABLE', 'That app is not installed on this TV');
    if (res.status < 200 || res.status >= 300) throw new LumenError('FAILED', `The TV refused to close it (HTTP ${res.status})`);
    log.info(`closed ${id}`);
    return { value: { id, closed: String(res.body).trim() === 'true' } };
  }

  async function getDevice() {
    return { value: await readDevice('user') };
  }

  return {
    baseUrl: `http://${host}:${port}${DEVICE_PATH}`,
    start() {
      if (started || stopped) return;
      started = true;
      deviceLoop.kick();
      foregroundLoop.reschedule(true);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      deviceLoop.stop();
      foregroundLoop.stop();
      queue.clear(new LumenError('UNAVAILABLE', 'Lumen is shutting down'));
      for (const req of active) req.destroy();
    },
    setDemand({ visible: v } = {}) {
      const next = Boolean(v);
      if (next === visible) return;
      visible = next;
      if (!started || stopped) return;
      if (visible) { deviceLoop.kick(); foregroundLoop.kick(); } else { deviceLoop.reschedule(); foregroundLoop.reschedule(); }
    },
    getDevice,
    getApp,
    launch,
    close,
    foregroundCheck,
    getWakeMac: () => wakeMac,
  };
}

// setTimeout chain that never overlaps itself and never lets an error escape a timer.
function createLoop(task, interval, log) {
  let timer = null;
  let running = false;
  let stopped = false;
  async function tick() {
    timer = null;
    if (stopped) return;
    running = true;
    try { await task(); } catch (err) { log.warn(`poll failed: ${err.message}`); }
    running = false;
    if (!stopped) timer = setTimeout(tick, interval());
  }
  return {
    kick() { if (running || stopped) return; clearTimeout(timer); tick(); },
    reschedule(force = false) {
      if (running || stopped || (!timer && !force)) return;
      clearTimeout(timer);
      timer = setTimeout(tick, interval());
    },
    stop() { stopped = true; clearTimeout(timer); timer = null; },
  };
}
