// Samsung Consumer IP Control: JSON-RPC 2.0 over HTTPS on port 1516.
// The TV serves one connection at a time, so every call goes through one queue and one socket.
// A call whose params hold only AccessToken is a GET; any extra key makes it a SET.
// Picture values belong to the current input × picture mode and are re-read when either changes.
import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { LumenError } from '../errors.js';
import { createQueue } from '../util/queue.js';
import { SETTINGS, getSetting } from '../catalog/settings.js';

const MIN_GAP_MS = 150;
const TIMEOUT_MS = 6000;
const PAIR_TIMEOUT_MS = 45000;
const RETRY_DELAY_MS = 300;
const POLL_BACKOFF_MS = 10000;
const MAX_REPLY_BYTES = 1 << 20;
const POWER = { on: 'powerOn', off: 'powerOff' };

// Values this adapter reads and writes that are driven by dedicated commands (volume.set, mute.set),
// so they are deliberately not in the Settings catalogue (the hub applies the volume cap).
const AUDIO = [
  { key: 'audio.volume', label: 'Volume', type: 'range', range: [0, 100], step: 1,
    ipc: { method: 'directVolumeControl', field: 'volume' }, writable: true },
  { key: 'audio.mute', label: 'Mute', type: 'toggle', ipc: { method: 'muteControl', field: 'mute' }, writable: true },
];

const ENTRIES = new Map([...SETTINGS, ...AUDIO].filter((entry) => entry.ipc).map((entry) => [entry.key, entry]));
const BY_METHOD = new Map([...ENTRIES.values()].map((entry) => [entry.ipc.method, entry]));

// Bulk getters (result field → state key). Both are verified on this TV; the per-field getters
// they cover are only used for writes.
const BULK = {
  getTVStates: {
    inputSource: 'input.source', mute: 'audio.mute', pictureMode: 'picture.mode', pictureSize: 'picture.size',
    soundMode: 'audio.soundMode', speakerSelect: 'audio.speaker', volume: 'audio.volume',
  },
  getVideoStates: {
    brightness: 'picture.shadowDetail', color: 'picture.color', contrast: 'picture.contrast',
    sharpness: 'picture.sharpness', tint: 'picture.tint',
  },
};

// The call that reads each key: a bulk getter when one covers it, else the key's own method.
const READER = new Map([...ENTRIES.values()].map((entry) => [entry.key, entry.ipc.method]));
for (const [method, fields] of Object.entries(BULK)) for (const key of Object.values(fields)) READER.set(key, method);

const STATE_KEYS = new Set(Object.values(BULK.getTVStates));
const SCOPED_KEYS = [...ENTRIES.values()].filter((entry) => entry.scoped).map((entry) => entry.key);
const PICTURE_READS = [...new Set([...ENTRIES.values()]
  .filter((entry) => entry.group === 'picture' || entry.group === 'pictureAdvanced')
  .map((entry) => READER.get(entry.key))
  .filter((method) => method !== 'getTVStates'))];

// The picture values the desktop "Now" dashboard shows at a glance (view 'now'): two cheap reads
// instead of the full sweep, which only runs while Settings is on screen.
const GLANCE_READS = ['backlightControl', 'getVideoStates'];

const RETRYABLE = new Set(['ECONNRESET', 'EPIPE']);

const paramOf = (entry) => entry.ipc.param ?? entry.ipc.field;
const invalid = (message) => new LumenError('INVALID', message);

function toNumber(raw) {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : raw;
}

// TV value → UI units (spec §9.3): mute boolean, speaker Internal/External, numbers as numbers,
// enums in the TV's spelling, tint clamped to its range.
function toUi(entry, raw) {
  if (entry.key === 'audio.mute') return typeof raw === 'boolean' ? raw : /^(muteon|on|true|1)$/i.test(String(raw));
  if (entry.key === 'audio.speaker') return /^internal$/i.test(String(raw)) ? 'Internal' : 'External';
  if (entry.ipc.field === null) {
    return Object.fromEntries(Object.entries(raw ?? {}).map(([name, value]) => [name, toNumber(value)]));
  }
  if (entry.range) {
    const n = toNumber(raw);
    if (entry.display === 'gr' && typeof n === 'number') return Math.min(entry.range[1], Math.max(entry.range[0], n));
    return n;
  }
  return raw == null ? null : String(raw);
}

function optionsFor(entry, value) {
  if (!entry.options) return null;
  return typeof value === 'string' && !entry.options.includes(value) ? [...entry.options, value] : entry.options;
}

function readField(entry, result) {
  return entry.ipc.field === null ? result : result?.[entry.ipc.field];
}

function parseReply({ status, text }) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new LumenError('FAILED', `Unexpected IP Control reply (HTTP ${status})`);
  }
  const error = body?.error && typeof body.error === 'object' ? body.error
    : body && typeof body === 'object' && 'code' in body && !('result' in body) ? body
      : null;
  if (error) return { error: { code: Number(error.code), message: String(error.message ?? '') } };
  return { result: body?.result ?? {} };
}

// A self-rescheduling poll: the next run starts intervalMs after the previous one finished.
function createLoop(run, intervalMs, onError) {
  let active = false;
  let busy = false;
  let timer = null;
  async function tick() {
    timer = null;
    busy = true;
    try {
      await run();
    } catch (err) {
      onError(err);
    } finally {
      busy = false;
    }
    if (active) timer = setTimeout(tick, intervalMs);
  }
  return {
    set(on) {
      if (on === active) return;
      active = on;
      if (on && !busy) tick();
      if (!on && timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    kick() {
      if (!active || busy) return;
      clearTimeout(timer);
      tick();
    },
  };
}

export function createIpControl({ config, data, log: rootLog, store }) {
  const log = rootLog.child('ipc');
  const host = config.tv.host;
  const port = config.tv.ports?.ipc ?? 1516;
  const statesMs = config.timing?.ipcStatesMs ?? 2500;
  const pictureMs = config.timing?.ipcPictureMs ?? 4000;

  const agent = new https.Agent({
    keepAlive: false, maxSockets: 1, rejectUnauthorized: false, ciphers: 'DEFAULT@SECLEVEL=0', minVersion: 'TLSv1',
  });
  const queue = createQueue({ concurrency: 1, minGapMs: MIN_GAP_MS });

  let seq = 0;
  let started = false;
  let stopped = false;
  let pairing = false;
  let token = null;
  let rejectedToken = null;
  let connState = null;
  let downUntil = 0;
  let wasOn = false;
  let scope = { input: null, mode: null };
  let demand = { clients: 0, visible: false, settings: false, glance: false };
  let pictureJob = null;
  let pictureNext = null;
  let sweepMs = PICTURE_READS.length * 400; // duration of the last full picture sweep (estimate until measured)
  const unavailable = new Set(); // methods that answered -32601; re-probed after a mode, input or power change

  const tvState = () => store.get('conn.tv')?.v;

  function setConn(state) {
    if (connState === state) return;
    connState = state;
    store.set('conn.ipc', state, { src: 'live', via: 'ipc' });
    log.info(`IP Control ${state}`);
  }

  async function usableToken() {
    if (!token || token === rejectedToken) {
      try {
        const saved = await data.readJson('ipcontrol.json', null);
        token = typeof saved?.token === 'string' && saved.token ? saved.token : null;
      } catch {
        token = null;
      }
    }
    return token && token !== rejectedToken ? token : null;
  }

  // One HTTPS POST; resolves { status, text } or rejects with a network error.
  function post(method, params, timeoutMs) {
    const message = { jsonrpc: '2.0', id: String(++seq), method };
    if (params) message.params = params;
    const body = JSON.stringify(message);
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const req = https.request({
        host, port, path: '/', method: 'POST', agent,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_REPLY_BYTES) req.destroy(Object.assign(new Error('IP Control reply too large'), { code: 'EMSGSIZE' }));
          else chunks.push(chunk);
        });
        res.on('end', () => settle(resolve, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (err) => settle(reject, err));
        res.on('close', () => {
          if (!res.complete) settle(reject, Object.assign(new Error('IP Control reply cut short'), { code: 'ECONNRESET' }));
        });
      });
      const timer = setTimeout(() => req.destroy(Object.assign(new Error('IP Control timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
      req.on('error', (err) => settle(reject, err));
      req.end(body);
    });
  }

  function networkFailure(err) {
    setConn('down');
    downUntil = Date.now() + POLL_BACKOFF_MS;
    log.debug('IP Control unreachable', { code: err.code, message: err.message });
    const off = tvState() === 'standby' || tvState() === 'off';
    return new LumenError(off ? 'TV_OFF' : 'FAILED', off ? 'The TV is off' : `IP Control did not answer (${err.code ?? err.message})`);
  }

  function rpcFailure(method, { code, message }) {
    log.debug('IP Control refused', { method, code, message });
    switch (code) {
      case -32601:
      case -32001:
        return new LumenError('UNAVAILABLE', 'Not available on this TV right now');
      case -32002:
        return new LumenError('LOCKED_IN_MODE', scope.mode ? `Locked in ${scope.mode} mode` : 'Locked in this mode');
      case -32003:
        return new LumenError('FAILED', 'The TV refused this operation');
      case -32011:
        return new LumenError('FAILED', 'All IP Remote slots are in use');
      case -32602:
        return new LumenError('INVALID', 'The TV rejected these parameters');
      default:
        return new LumenError('FAILED', `IP Control error ${code}${message ? `: ${message}` : ''}`);
    }
  }

  // Runs inside the queue: token, POST (one retry on a reset, which the one-connection server
  // sends when another client holds it), error rules, connection state and latency.
  async function exchange(method, params, priority) {
    if (stopped) throw new LumenError('FAILED', 'IP Control is stopped');
    const current = await usableToken();
    if (!current) {
      setConn('unpaired');
      throw new LumenError('NOT_PAIRED', 'Pair IP Control first');
    }
    const startedAt = Date.now();
    let reply;
    try {
      reply = await post(method, { AccessToken: current, ...params }, TIMEOUT_MS);
    } catch (err) {
      if (!RETRYABLE.has(err.code) || stopped) throw networkFailure(err);
      await sleep(RETRY_DELAY_MS);
      try {
        reply = await post(method, { AccessToken: current, ...params }, TIMEOUT_MS);
      } catch (again) {
        throw networkFailure(again);
      }
    }
    const ms = Date.now() - startedAt;
    const { result, error } = parseReply(reply);
    if (error && (error.code === -32010 || error.code === -32700)) {
      rejectedToken = current;
      setConn('unpaired');
      throw new LumenError('NOT_PAIRED', 'The TV no longer accepts the IP Control token; pair again');
    }
    setConn('paired');
    store.set('conn.latency.ipc', ms, { src: 'derived', via: `ipc:${method}` });
    log.debug(`${params ? 'SET' : 'GET'} ${method}`, { ms, priority });
    if (error) throw rpcFailure(method, error);
    return result;
  }

  const call = (method, params, priority) => queue.push(() => exchange(method, params, priority), { priority });

  function recordMeta(entry, via, value, note = null) {
    return {
      src: 'live',
      via: `ipc:${via}`,
      // Picture values are re-read once per sweep, so their freshness window includes the sweep itself.
      ttlMs: note ? null : 3 * (STATE_KEYS.has(entry.key) ? statesMs : pictureMs + sweepMs),
      range: entry.range ?? null,
      options: optionsFor(entry, value),
      scope: entry.scoped ? { ...scope } : null,
      note,
    };
  }

  function publish(key, raw, via) {
    const entry = ENTRIES.get(key);
    const value = toUi(entry, raw);
    store.set(key, value, recordMeta(entry, via, value));
    return value;
  }

  function keysReadBy(method) {
    return BULK[method] ? Object.values(BULK[method]) : [BY_METHOD.get(method)?.key].filter(Boolean);
  }

  // A getter that answered -32601 / -32002: the value is unknown right now, not stale.
  function publishUnreadable(method, code) {
    const note = code === 'UNAVAILABLE' ? 'unavailable' : 'locked';
    for (const key of keysReadBy(method)) store.set(key, null, recordMeta(ENTRIES.get(key), method, null, note));
  }

  // Publishes a getter's result in UI units; returns the value (single getters) or a flat map (bulk).
  function publishResult(method, result) {
    if (BULK[method]) {
      const out = {};
      for (const [field, key] of Object.entries(BULK[method])) {
        if (result?.[field] !== undefined) out[key] = publish(key, result[field], method);
      }
      noteScope(out);
      return out;
    }
    const entry = BY_METHOD.get(method);
    const raw = readField(entry, result);
    if (raw === undefined) return undefined;
    const value = publish(entry.key, raw, method);
    noteScope({ [entry.key]: value });
    return value;
  }

  function noteScope(values) {
    const input = values['input.source'] ?? scope.input;
    const mode = values['picture.mode'] ?? scope.mode;
    const changed = (scope.input !== null && input !== scope.input) || (scope.mode !== null && mode !== scope.mode);
    scope = { input, mode };
    if (!changed) return;
    log.debug('picture scope changed; re-reading picture values', { input, mode });
    for (const key of SCOPED_KEYS) store.mark(key, { stale: true });
    unavailable.clear();
    if (!stopped) readPicture('poll').catch(quiet);
  }

  const readStates = async (priority) => publishResult('getTVStates', await call('getTVStates', null, priority));

  async function ensureScope(priority) {
    if (scope.input === null || scope.mode === null) await readStates(priority);
  }

  async function sweepPicture(priority, reprobe) {
    const startedAt = Date.now();
    await ensureScope(priority);
    for (const method of PICTURE_READS) {
      if (stopped || (priority === 'poll' && tvState() !== 'on')) return;
      if (!reprobe && unavailable.has(method)) continue;
      try {
        publishResult(method, await call(method, null, priority));
        unavailable.delete(method);
      } catch (err) {
        if (err.code !== 'UNAVAILABLE' && err.code !== 'LOCKED_IN_MODE') throw err;
        if (err.code === 'UNAVAILABLE') unavailable.add(method);
        publishUnreadable(method, err.code);
      }
    }
    sweepMs = Date.now() - startedAt;
  }

  async function readGlance(priority) {
    await ensureScope(priority);
    for (const method of GLANCE_READS) {
      if (stopped || tvState() !== 'on' || unavailable.has(method)) continue;
      try {
        publishResult(method, await call(method, null, priority));
      } catch (err) {
        if (err.code !== 'UNAVAILABLE' && err.code !== 'LOCKED_IN_MODE') throw err;
        if (err.code === 'UNAVAILABLE') unavailable.add(method);
        publishUnreadable(method, err.code);
      }
    }
  }

  // All picture getters one at a time; requests made while a sweep runs fold into one more sweep.
  function readPicture(priority, reprobe = false) {
    if (pictureJob) {
      pictureNext = {
        priority: priority === 'user' || pictureNext?.priority === 'user' ? 'user' : 'poll',
        reprobe: reprobe || Boolean(pictureNext?.reprobe),
      };
      return pictureJob;
    }
    pictureJob = (async () => {
      let next = { priority, reprobe };
      try {
        while (next && !stopped) {
          pictureNext = null;
          await sweepPicture(next.priority, next.reprobe);
          next = pictureNext;
        }
      } finally {
        pictureJob = null;
        pictureNext = null;
      }
    })();
    return pictureJob;
  }

  async function readBack(entry, priority) {
    const method = READER.get(entry.key);
    if (entry.scoped) await ensureScope(priority);
    const out = publishResult(method, await call(method, null, priority));
    return BULK[method] ? out[entry.key] : out;
  }

  // UI value (or the TV's own spelling) → validated TV parameter value.
  function toTv(entry, value) {
    if (entry.key === 'audio.mute') {
      if (typeof value === 'boolean') return value ? 'muteOn' : 'muteOff';
      if (value === 'muteOn' || value === 'muteOff') return value;
      throw invalid('Mute must be true or false');
    }
    if (entry.key === 'audio.speaker') {
      const wanted = String(value).toLowerCase();
      if (wanted === 'internal') return 'Internal';
      if (wanted === 'external' || wanted === 'audioout/optical') return 'AudioOut/Optical';
      throw invalid('Sound Output must be Internal or External');
    }
    if (entry.type === 'range') {
      const n = toNumber(value);
      if (typeof n !== 'number') throw invalid(`${entry.label} needs a number`);
      const step = entry.step ?? 1;
      const rounded = Math.round(n / step) * step;
      const [min, max] = entry.range;
      if (rounded < min || rounded > max) throw invalid(`${entry.label} must be between ${min} and ${max}`);
      return rounded;
    }
    const options = optionsFor(entry, store.get(entry.key)?.v);
    const match = options.find((option) => option.toLowerCase() === String(value).toLowerCase());
    if (!match) throw invalid(`${entry.label} must be one of ${options.join(', ')}`);
    return match;
  }

  async function write(entry, value) {
    const tvValue = toTv(entry, value);
    await call(entry.ipc.method, { [paramOf(entry)]: tvValue }, 'user');
    try {
      return { value: await readBack(entry, 'user') };
    } catch (err) {
      log.warn(`read-back after ${entry.ipc.method} failed`, { code: err.code });
      return {};
    }
  }

  function quiet(err) {
    if (!(err instanceof LumenError)) log.error('IP Control poll failed', { message: err.message });
  }

  async function pollable() {
    if (stopped || tvState() !== 'on' || Date.now() < downUntil) return false;
    if (await usableToken()) return true;
    setConn('unpaired');
    return false;
  }

  const statesLoop = createLoop(async () => {
    const on = tvState() === 'on';
    if (on && !wasOn) unavailable.clear();
    wasOn = on;
    if (await pollable()) await readStates('poll');
  }, statesMs, quiet);

  const pictureLoop = createLoop(async () => {
    if (await pollable()) await readPicture('poll');
  }, pictureMs, quiet);

  const glanceLoop = createLoop(async () => {
    if (await pollable()) await readGlance('poll');
  }, pictureMs, quiet);

  function applyDemand() {
    const live = started && !stopped && demand.clients > 0;
    statesLoop.set(live && (demand.visible || demand.settings));
    pictureLoop.set(live && demand.settings);
    glanceLoop.set(live && demand.glance && !demand.settings);
  }

  async function start() {
    if (started || stopped) return;
    started = true;
    if (!(await usableToken())) setConn('unpaired');
    applyDemand();
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    applyDemand();
    queue.clear(new LumenError('FAILED', 'IP Control is stopped'));
    agent.destroy();
  }

  function setDemand({ clients = 0, visible = false, views } = {}) {
    const showing = (name) => (views instanceof Set ? views.has(name) : Array.isArray(views) && views.includes(name));
    demand = { clients, visible: Boolean(visible), settings: showing('settings'), glance: showing('now') };
    applyDemand();
  }

  // GET: params carry only the token. Only known getters, published in UI units
  // (other methods, e.g. getDeviceInformation, can return identifiers).
  async function get(method) {
    if (!BULK[method] && !BY_METHOD.has(method)) throw invalid(`${method} is not an allowed IP Control read`);
    return { value: publishResult(method, await call(method, null, 'user')) };
  }

  // SET with read-back. Only writable catalogue methods, volume, mute and powerControl on/off
  // (never reboot, never a param-less powerControl).
  async function set(method, params = {}) {
    if (method === 'powerControl') {
      if (params.power !== POWER.on && params.power !== POWER.off) throw invalid('powerControl accepts only powerOn or powerOff');
      await call('powerControl', { power: params.power }, 'user');
      return {};
    }
    const entry = BY_METHOD.get(method);
    if (!entry?.writable) throw invalid(`${method} is not an allowed IP Control write`);
    if (!(paramOf(entry) in params)) throw invalid(`${method} needs ${paramOf(entry)}`);
    return write(entry, params[paramOf(entry)]);
  }

  async function setSetting(key, value) {
    const entry = getSetting(key);
    if (!entry) throw invalid(`Unknown setting ${key}`);
    if (entry.type === 'tracked') throw invalid(`${entry.label} is tracked; set it with Calibrate`);
    if (!entry.writable) throw invalid(`${entry.label} is read-only`);
    return write(entry, value);
  }

  async function refresh(group = 'all') {
    if (!['picture', 'sound', 'all'].includes(group)) throw invalid(`Unknown settings group ${group}`);
    await readStates('user');
    if (group !== 'sound') {
      unavailable.clear();
      await readPicture('user', true);
    }
    return {};
  }

  async function power(action) {
    if (!Object.hasOwn(POWER, action)) throw invalid("power action must be 'on' or 'off'");
    return set('powerControl', { power: POWER[action] });
  }

  // createAccessToken shows the Allow prompt on the TV; only ever called from pair.ipcontrol.
  // The token is persisted before anything else happens.
  async function pair() {
    if (pairing) throw new LumenError('FAILED', 'Pairing is already waiting for the TV');
    pairing = true;
    try {
      await queue.push(async () => {
        let reply;
        try {
          reply = await post('createAccessToken', null, PAIR_TIMEOUT_MS);
        } catch (err) {
          if (err.code === 'ETIMEDOUT') throw new LumenError('FAILED', 'No answer from the TV. Accept the IP Remote prompt on the TV, then try again');
          throw networkFailure(err);
        }
        const { result, error } = parseReply(reply);
        if (error?.code === -32011) throw rpcFailure('createAccessToken', error);
        if (error) throw new LumenError('FAILED', `The TV did not allow pairing (${error.code})`);
        const fresh = result?.AccessToken;
        if (typeof fresh !== 'string' || !fresh) throw new LumenError('FAILED', 'The TV did not issue a token');
        try {
          await data.writeJson('ipcontrol.json', { token: fresh, pairedAt: new Date().toISOString() });
        } finally {
          token = fresh;
          rejectedToken = null;
          downUntil = 0;
        }
        setConn('paired');
      }, { priority: 'user' });
    } finally {
      pairing = false;
    }
    statesLoop.kick();
    return {};
  }

  return { start, stop, setDemand, get, set, setSetting, refresh, power, pair };
}
