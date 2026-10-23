// Command router between browsers (and internal callers: scenes, the AI) and the adapters.
// It validates every command, applies safety, routes with fallbacks (spec §5.3, §8.5, §10, §11),
// answers with acks, owns presence → setDemand, and emits changedOnTv (§9.4).
import { isLoopbackHost } from './features/browser.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { LumenError, toErrorPayload } from './errors.js';
import { VERSION } from './config.js';
import { deepEqual } from './store.js';
import { createSafety } from './safety.js';
import { createQueue } from './util/queue.js';
import { KEYS } from './catalog/keys.js';
import { SETTINGS } from './catalog/settings.js';
import { APPS } from './catalog/apps.js';

const SETTING_BY_KEY = new Map(SETTINGS.map((entry) => [entry.key, entry]));
const KEY_BY_NAME = new Map(KEYS.map((entry) => [entry.key, entry]));

const TOUCH_WINDOW_MS = 3000; // a command "owns" the keys it touched for this long
const CHANGE_DEBOUNCE_MS = 1000;
const HOLD_CHECK_MS = 250;
const MAX_VOLUME_KEY_STEPS = 25;
const SCREEN_DEFAULT_EVERY_MS = 1000;
const SCREEN_MIN_EVERY_MS = 500;
const AI_STATUS_TIMEOUT_MS = 1500;
const OPEN_ON_TV_TIMEOUT_MS = 10_000;
const MAX_URL_LENGTH = 2048;

const APP_ID = /^[\w.-]{1,64}$/;
const SOURCE = /^[A-Z][A-Z0-9]{0,15}$/;
const VIEW_NAME = /^[a-z][a-z-]{0,23}$/;
const ITEM_ID = /^[\w-]{1,64}$/;
const READ_SOURCES = new Set(['live', 'agent']);
// Commands that stream while the user moves a pointer: they share the roomier pointer rate bucket.
const STREAMED = new Set(['pointer.move', 'browser.input', 'browser.ack']);
const BROWSER_INPUT_KINDS = ['move', 'down', 'up', 'click', 'wheel', 'key', 'text'];
const MOUSE_BUTTONS = ['left', 'right', 'middle'];
const KEY_MODIFIERS = ['alt', 'ctrl', 'meta', 'shift'];

// State keys a key click can change, so its echo is not reported as "changed on the TV".
const KEY_TOUCHES = {
  KEY_VOLUP: ['audio.volume', 'audio.mute'],
  KEY_VOLDOWN: ['audio.volume', 'audio.mute'],
  KEY_MUTE: ['audio.mute'],
  KEY_SOURCE: ['input.source'],
  KEY_HDMI: ['input.source'],
  KEY_TV: ['input.source'],
};

const NAMES = {
  rest: 'The TV', remote: 'The remote channel', upnp: 'UPnP', ipc: 'IP Control', agent: 'The TV agent', eyes: 'Lumen Eyes',
  wol: 'Wake-on-LAN', avtransport: 'Media casting', dial: 'App casting', sleep: 'The sleep timer', scenes: 'Scenes',
  tracked: 'Tracked settings', macros: 'Macros', cast: 'Cast', ai: 'Ask Lumen', browser: 'The browser', vpn: 'The VPN',
};

// The caller used when hub.handle is given no client (internal use, tests).
const INTERNAL = Object.freeze({ id: 'internal', kind: 'internal', send() {} });

const isWatched = (key) => key === 'audio.volume' || key === 'audio.mute' || key === 'input.source' || key.startsWith('picture.');

const invalid = (message) => new LumenError('INVALID', message);

function text(value, name, { max = 200, pattern, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value) || value.length > max || (pattern && !pattern.test(value))) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(`${name} must be a whole number from ${min} to ${max}`);
  return value;
}

function number(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw invalid(`${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

function boolean(value, name) {
  if (typeof value !== 'boolean') throw invalid(`${name} must be true or false`);
  return value;
}

// The id of the thing a command acts on (scene, macro, AI run). Browser frames already use `id`
// for the command itself ({ t, id, cmd, ...args }), so browsers send `target`; internal callers
// may pass `id`.
const subject = (cmd) => cmd.target ?? cmd.id;

function oneOf(value, name, options) {
  if (!options.includes(value)) throw invalid(`${name} must be one of ${options.join(', ')}`);
  return value;
}

function webUrl(value, name = 'url', allowLoopback = false) {
  text(value, name, { max: MAX_URL_LENGTH });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid('That is not a link');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw invalid('Only http and https links can be opened');
  if (!allowLoopback && isLoopbackHost(parsed.hostname)) throw invalid('Pages on this PC itself cannot be opened');
  return parsed.href;
}

// Rejects with FAILED when `work` takes longer than `ms`.
function timed(work, ms, message) {
  let timer;
  return Promise.race([
    work,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new LumenError('FAILED', message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// The validated `browser.input` event (spec §11.3): coordinates in frame pixels, keys as DOM names.
function browserInput(cmd) {
  const kind = oneOf(cmd.kind, 'kind', BROWSER_INPUT_KINDS);
  const event = { kind };
  if (kind !== 'key' && kind !== 'text') {
    event.x = number(cmd.x, 'x', 0, 8192);
    event.y = number(cmd.y, 'y', 0, 8192);
  }
  if (kind === 'down' || kind === 'up' || kind === 'click') event.button = oneOf(cmd.button ?? 'left', 'button', MOUSE_BUTTONS);
  if (kind === 'wheel') {
    event.deltaX = number(cmd.deltaX ?? 0, 'deltaX', -10000, 10000);
    event.deltaY = number(cmd.deltaY ?? 0, 'deltaY', -10000, 10000);
  }
  if (kind === 'key') {
    event.key = text(cmd.key, 'key', { max: 32 });
    if (cmd.code !== undefined) event.code = text(cmd.code, 'code', { max: 32 });
  }
  if (kind === 'text') event.text = text(cmd.text, 'text', { max: 2000 });
  if (cmd.modifiers !== undefined) {
    if (Array.isArray(cmd.modifiers)) event.modifiers = cmd.modifiers.map((m) => oneOf(m, 'modifiers', KEY_MODIFIERS));
    else event.modifiers = integer(cmd.modifiers, 'modifiers', 0, 15);
  }
  return event;
}

export function createHub({ config, log: rootLog, store, adapters = {}, features = {} }) {
  const log = rootLog.child('hub');
  const safety = createSafety({ config });
  const timing = config.timing;
  const clients = new Map(); // attached browser client → { view, visible }
  const detached = new WeakSet();
  const holds = new Map(); // client → Map(key → hold session)
  const touched = new Map(); // state key → when a command last touched it
  const seen = new Map(); // watched state key → last record seen in a patch
  const pendingChanges = new Map(); // watched state key → { from, timer }
  const volumeLane = createQueue({ concurrency: 1 }); // volume and mute commands run one at a time
  const lifetime = new AbortController();
  let lastDemand = '';
  let browserViewers = new Set(); // clients last reported to features.browser.viewers
  let lastVolume = null; // { v, at } from our own read-backs
  let stopped = false;

  // ---------- helpers ----------

  async function call(name, method, ...args) {
    const target = adapters[name];
    if (typeof target?.[method] !== 'function') throw new LumenError('UNAVAILABLE', `${NAMES[name] ?? name} is not available`);
    return (await target[method](...args)) ?? {};
  }

  async function feature(name, method, ...args) {
    const target = features[name];
    if (typeof target?.[method] !== 'function') throw new LumenError('UNAVAILABLE', `${NAMES[name] ?? name} is not available`);
    return (await target[method](...args)) ?? {};
  }

  const valueOf = (key) => store.get(key)?.v;

  // The value of a fresh TV reading, or undefined when unknown, stale or not from the TV.
  function trusted(key) {
    const rec = store.get(key);
    if (!rec || rec.stale || !READ_SOURCES.has(rec.src)) return undefined;
    if (rec.ttlMs > 0 && Date.now() - rec.at > rec.ttlMs) return undefined;
    return rec.v;
  }

  const ipcDown = () => ['unpaired', 'down'].includes(valueOf('conn.ipc'));
  const upnpDown = () => valueOf('conn.upnp') === 'down';

  function requireTvOn() {
    const tv = valueOf('conn.tv');
    if (tv === 'standby' || tv === 'off') throw new LumenError('TV_OFF', 'The TV is off');
  }

  function send(client, msg) {
    try {
      client.send(msg);
    } catch (err) {
      log.debug('send to client failed', err);
    }
  }

  function broadcast(msg) {
    for (const client of clients.keys()) send(client, msg);
  }

  // Sends to the clients currently showing `view` with a visible tab (browser frames, §11.3);
  // `shouldSend(client)` can drop individual clients.
  function sendToView(view, msg, shouldSend = () => true) {
    for (const [client, presence] of clients) {
      if (presence.visible && presence.view === view && shouldSend(client)) send(client, msg);
    }
  }

  function touch(...keys) {
    const now = Date.now();
    for (const key of keys) {
      touched.set(key, now);
      const pending = pendingChanges.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        pendingChanges.delete(key);
      }
    }
  }

  async function touching(keys, run) {
    touch(...keys);
    try {
      return await run();
    } finally {
      touch(...keys);
    }
  }

  const recentlyTouched = (key) => Date.now() - (touched.get(key) ?? 0) < TOUCH_WINDOW_MS;

  // Tries each attempt in order; INVALID and TV_OFF stop the chain, other errors fall through.
  async function firstWorking(attempts) {
    let lastError = null;
    for (const attempt of attempts.filter(Boolean)) {
      try {
        return await attempt();
      } catch (err) {
        if (err?.code === 'INVALID' || err?.code === 'TV_OFF') throw err;
        log.debug('falling back', { code: err?.code, message: err?.message });
        lastError = err;
      }
    }
    throw lastError ?? new LumenError('UNAVAILABLE', 'Lumen cannot reach the TV right now');
  }

  // ---------- volume and mute ----------

  function currentVolume() {
    const rec = store.get('audio.volume');
    if (lastVolume && Date.now() - lastVolume.at < TOUCH_WINDOW_MS && (!rec || rec.at <= lastVolume.at)) return lastVolume.v;
    const v = trusted('audio.volume');
    return typeof v === 'number' ? v : null;
  }

  // The current level, asking the TV when the store has no fresh reading.
  async function readVolume() {
    const known = currentVolume();
    if (known !== null) return known;
    const reads = [
      !upnpDown() && (() => call('upnp', 'getVolume')),
      !ipcDown() && (() => call('ipc', 'get', 'directVolumeControl')),
    ].filter(Boolean);
    for (const read of reads) {
      try {
        const { value } = await read();
        if (typeof value === 'number') return value;
      } catch (err) {
        log.debug('volume read failed', { code: err?.code });
      }
    }
    return null;
  }

  async function volumeByKeys(delta) {
    const key = delta > 0 ? 'KEY_VOLUP' : 'KEY_VOLDOWN';
    for (let i = 0; i < Math.min(Math.abs(delta), MAX_VOLUME_KEY_STEPS); i += 1) await call('remote', 'click', key);
    return {};
  }

  async function writeVolume(target, current) {
    const res = await firstWorking([
      !ipcDown() && (() => call('ipc', 'set', 'directVolumeControl', { volume: target })),
      !upnpDown() && (() => call('upnp', 'setVolume', target)),
      current !== null && (() => volumeByKeys(target - current)),
    ]);
    if (typeof res.value !== 'number') return {};
    lastVolume = { v: res.value, at: Date.now() };
    return { value: res.value };
  }

  const capped = () => invalid(`Volume is capped at ${safety.volumeCap} (Settings › Safety)`);

  async function volumeSet({ value, atMost }) {
    const wanted = Math.round(number(value, 'Volume', 0, 100));
    return volumeLane.push(() => touching(['audio.volume', 'audio.mute'], async () => {
      const needsCurrent = atMost === true || wanted > safety.volumeCap;
      const current = needsCurrent ? await readVolume() : currentVolume();
      if (atMost === true && current !== null && current <= wanted) return { value: current };
      const target = safety.limitVolume(wanted, current);
      if (current !== null && target === current) {
        if (target < wanted) throw capped();
        return { value: current };
      }
      return writeVolume(target, current);
    }));
  }

  async function volumeStep({ delta }) {
    integer(delta, 'delta', -5, 5);
    if (delta === 0) throw invalid('delta must not be 0');
    return volumeLane.push(() => touching(['audio.volume', 'audio.mute'], async () => {
      const current = await readVolume();
      if (current === null) return volumeByKeys(delta);
      const target = safety.limitVolume(current + delta, current);
      if (target === current) {
        if (delta > 0 && current < 100) throw capped();
        return { value: current };
      }
      return writeVolume(target, current);
    }));
  }

  async function muteSet({ value }) {
    const wanted = boolean(value, 'value');
    return volumeLane.push(() => touching(['audio.mute'], async () => {
      const current = trusted('audio.mute');
      const res = await firstWorking([
        !ipcDown() && (() => call('ipc', 'set', 'muteControl', { mute: wanted })),
        !upnpDown() && (() => call('upnp', 'setMute', wanted)),
        typeof current === 'boolean' && (async () => {
          if (current === wanted) return { value: current };
          await call('remote', 'click', 'KEY_MUTE');
          return {};
        }),
      ]);
      return typeof res.value === 'boolean' ? { value: res.value } : {};
    }));
  }

  // ---------- power ----------

  async function wake() {
    const mac = adapters.rest?.getWakeMac?.();
    const attempts = [
      mac && ['Wake-on-LAN', () => call('wol', 'wake', mac)],
      valueOf('conn.remote') === 'paired' && ['KEY_POWER', () => call('remote', 'click', 'KEY_POWER')],
      ['IP Control powerOn', () => call('ipc', 'power', 'on')],
    ].filter(Boolean);
    let sent = 0;
    for (const [name, run] of attempts) {
      try {
        await run();
        sent += 1;
      } catch (err) {
        log.debug(`${name} did not go through`, { code: err?.code, message: err?.message });
      }
    }
    return sent;
  }

  async function waitForPowerOn() {
    const deadline = Date.now() + timing.powerPollTotalMs;
    while (Date.now() < deadline) {
      try {
        await sleep(timing.powerPollMs, undefined, { signal: lifetime.signal });
      } catch {
        throw new LumenError('UNAVAILABLE', 'Lumen is stopping');
      }
      try {
        await call('rest', 'getDevice');
      } catch (err) {
        log.debug('power poll failed', { code: err?.code });
      }
      if (valueOf('conn.tv') === 'on') return { value: 'on' };
    }
    throw new LumenError('FAILED', 'The TV did not wake up. Check that "Power On with Mobile" is enabled on the TV');
  }

  async function power({ action }) {
    oneOf(action, 'action', ['on', 'off']);
    const tv = valueOf('conn.tv');
    if (action === 'off') {
      if (tv === 'standby' || tv === 'off') return { value: tv };
      if (tv !== 'on') throw new LumenError('UNAVAILABLE', 'Lumen cannot tell yet whether the TV is on');
      safety.checkPower();
      safety.notePower();
      await firstWorking([() => call('remote', 'click', 'KEY_POWER'), () => call('ipc', 'power', 'off')]);
      return {};
    }
    if (tv === 'on') return { value: 'on' };
    safety.checkPower();
    safety.notePower();
    if (!(await wake())) {
      throw new LumenError('UNAVAILABLE', 'Lumen could not send a wake-up. Turn the TV on once with its remote so Lumen learns its address');
    }
    return waitForPowerOn();
  }

  // ---------- keys and holds ----------

  async function key({ key: name, action = 'click' }, client) {
    oneOf(action, 'action', ['click']);
    safety.checkKey(name);
    requireTvOn();
    if (name === 'KEY_POWER') {
      safety.checkPower();
      safety.notePower();
    }
    const res = await touching(KEY_TOUCHES[name] ?? [], () => call('remote', 'click', name));
    features.macros?.capture?.(client, name);
    return res;
  }

  function holdsOf(client) {
    let sessions = holds.get(client);
    if (!sessions) holds.set(client, (sessions = new Map()));
    return sessions;
  }

  function arm(session) {
    session.timer = setTimeout(() => tick(session), session.mode === 'repeat' ? timing.holdRepeatMs : HOLD_CHECK_MS);
  }

  async function tick(session) {
    if (session.ended) return;
    const now = Date.now();
    if (now - session.lastBeat > timing.holdWatchdogMs || now - session.startedAt > timing.holdMaxMs) {
      await endHold(session);
      return;
    }
    if (session.mode === 'repeat') {
      try {
        touch(...(KEY_TOUCHES[session.key] ?? []));
        await call('remote', 'click', session.key);
      } catch (err) {
        send(session.client, { t: 'toast', level: 'warn', text: `${KEY_BY_NAME.get(session.key)?.label ?? session.key} stopped: ${err.message}` });
        await endHold(session);
        return;
      }
    }
    if (!session.ended) arm(session);
  }

  async function endHold(session) {
    if (session.ended) return;
    session.ended = true;
    clearTimeout(session.timer);
    holds.get(session.client)?.delete(session.key);
    if (session.mode !== 'press') return;
    try {
      await call('remote', 'release', session.key);
    } catch (err) {
      log.warn(`release ${session.key} failed`, { code: err?.code, message: err?.message });
    }
  }

  // Repeatable keys: clicks every holdRepeatMs while beats arrive. Other holdable keys: a real
  // Press … Release. A watchdog ends holds without beats and after holdMaxMs in total.
  async function hold({ key: name, phase }, client) {
    oneOf(phase, 'phase', ['start', 'beat', 'end']);
    const sessions = holdsOf(client);
    const current = sessions.get(name);
    if (phase === 'end') {
      if (current) await endHold(current);
      return {};
    }
    if (current || phase === 'beat') {
      if (current) current.lastBeat = Date.now();
      return {};
    }
    safety.checkKey(name, 'hold');
    requireTvOn();
    const mode = KEY_BY_NAME.get(name)?.hold === 'repeat' ? 'repeat' : 'press';
    const now = Date.now();
    const session = { key: name, mode, client, startedAt: now, lastBeat: now, timer: null, ended: false };
    sessions.set(name, session);
    try {
      touch(...(KEY_TOUCHES[name] ?? []));
      await call('remote', mode === 'repeat' ? 'click' : 'press', name);
    } catch (err) {
      sessions.delete(name);
      throw err;
    }
    if (!session.ended) arm(session);
    return {};
  }

  // ---------- presence ----------

  // Tells the browser feature who is watching its frames whenever that set changes (it starts the
  // idle shutdown when nobody is, and sends newcomers the current page).
  function updateBrowserViewers() {
    if (typeof features.browser?.viewers !== 'function') return;
    const next = new Set();
    for (const [client, presence] of clients) if (presence.visible && presence.view === 'browser') next.add(client);
    if (next.size === browserViewers.size && [...next].every((client) => browserViewers.has(client))) return;
    browserViewers = next;
    try {
      features.browser.viewers(new Set(next));
    } catch (err) {
      log.warn('browser viewers update failed', err);
    }
  }

  function updateDemand() {
    updateBrowserViewers();
    const views = new Set();
    let visible = false;
    // The Screen view's capture cadence: the fastest any visible viewer asked for (0 = all paused).
    let screenEveryMs = 0;
    for (const presence of clients.values()) {
      if (!presence.visible) continue;
      visible = true;
      if (presence.view) views.add(presence.view);
      const every = presence.screenEveryMs ?? SCREEN_DEFAULT_EVERY_MS;
      if (presence.view === 'screen' && every > 0) screenEveryMs = screenEveryMs ? Math.min(screenEveryMs, every) : every;
    }
    const signature = `${clients.size}|${visible}|${[...views].sort().join(',')}|${screenEveryMs}`;
    if (signature === lastDemand) return;
    lastDemand = signature;
    for (const target of [...Object.values(adapters), ...Object.values(features)]) {
      if (typeof target?.setDemand !== 'function') continue;
      try {
        target.setDemand({ clients: clients.size, visible, views: new Set(views), screenEveryMs });
      } catch (err) {
        log.warn('setDemand failed', err);
      }
    }
  }

  // A client shows one view at a time; visible:false for that view means the tab is hidden.
  function view({ name, visible }, client) {
    text(name, 'name', { max: 24, pattern: VIEW_NAME });
    boolean(visible, 'visible');
    const presence = clients.get(client);
    if (!presence) return {};
    if (visible) {
      presence.view = name;
      presence.visible = true;
    } else if (presence.view === name) {
      presence.visible = false;
    }
    updateDemand();
    return {};
  }

  // ---------- AI ----------

  function aiAsk(cmd, client) {
    const ai = features.ai;
    if (typeof ai?.ask !== 'function') throw new LumenError('UNAVAILABLE', 'Ask Lumen is not available');
    const question = text(cmd.text?.trim?.(), 'text', { max: 2000 });
    const id = typeof cmd.id === 'string' && cmd.id ? cmd.id : randomUUID();
    const thread = cmd.thread === undefined ? undefined : text(cmd.thread, 'thread', { max: 64, pattern: /^[A-Za-z0-9_-]+$/ });
    const emit = (event) => send(client, { ...event, t: 'ai', id });
    Promise.resolve()
      .then(() => ai.ask(question, { id, emit, thread }))
      .catch((err) => {
        log.warn('ai.ask failed', err);
        emit({ kind: 'error', message: toErrorPayload(err).message });
        emit({ kind: 'done' });
      });
    return { value: { id } };
  }

  async function aiCancel(cmd) {
    return feature('ai', 'cancel', text(subject(cmd), 'target', { max: 128 }));
  }

  // ---------- browser (§11.3) ----------

  // The TV agent opens the link in the TV browser; without the agent, the REST browser launch does.
  async function openOnTv({ url }) {
    const target = url === undefined ? valueOf('browser.url') : url;
    if (typeof target !== 'string' || !target) throw invalid('Open a page first, or pass a link');
    const href = webUrl(target, 'url', !!config.browser?.allowLoopback);
    requireTvOn();
    try {
      const res = await timed(call('agent', 'request', 'open-url', { url: href }), OPEN_ON_TV_TIMEOUT_MS, 'The TV agent did not answer in time');
      return { value: { url: href, via: 'agent', method: res.value?.method ?? null } };
    } catch (err) {
      if (err?.code === 'INVALID' || err?.code === 'TV_OFF') throw err;
      log.debug('agent open-url failed; using the TV browser launch', { code: err?.code, message: err?.message });
    }
    await feature('cast', 'openOnTv', href);
    return { value: { url: href, via: 'rest', method: null } };
  }

  // ---------- command table ----------

  const COMMANDS = {
    key,
    hold,
    'volume.set': volumeSet,
    'volume.step': volumeStep,
    'mute.set': muteSet,
    power,

    'app.launch': async ({ appId }) => {
      text(appId, 'appId', { max: 64, pattern: APP_ID });
      requireTvOn();
      return touching(['app.foreground'], () => call('rest', 'launch', appId));
    },

    // App skills the AI uses and learns (server/ai/skills.js): list, read, forget a learned one.
    'skills.list': async () => ({ value: features.ai?.skills?.list() ?? [] }),
    'skills.get': async ({ slug }) => {
      text(slug, 'slug', { max: 41, pattern: /^[a-z0-9-]+$/ });
      const skill = features.ai?.skills?.get(slug);
      if (!skill) throw new LumenError('NOT_FOUND', 'No such skill');
      return { value: skill };
    },
    'skills.forget': async ({ slug }) => {
      text(slug, 'slug', { max: 41, pattern: /^[a-z0-9-]+$/ });
      return { value: features.ai?.skills?.remove(slug) === true };
    },

    // Whether an app is running / visible (REST), for skills that behave differently on a cold start.
    'app.status': async ({ appId }) => {
      text(appId, 'appId', { max: 64, pattern: APP_ID });
      requireTvOn();
      return call('rest', 'getApp', appId);
    },

    'input.set': async ({ source }) => {
      text(source, 'source', { max: 16, pattern: SOURCE });
      requireTvOn();
      return touching(['input.source'], () => call('ipc', 'setSetting', 'input.source', source));
    },

    'setting.set': async ({ key: name, value }) => {
      const entry = SETTING_BY_KEY.get(name);
      if (!entry) throw invalid(`Unknown setting ${String(name).slice(0, 40)}`);
      if (entry.type === 'tracked') return feature('tracked', 'set', name, value);
      if (entry.type === 'readonly' || entry.writable === false) throw invalid(`${entry.label} is read-only`);
      if (value === null || typeof value === 'object') throw invalid(`${entry.label} needs a value`);
      requireTvOn();
      return touching([name], () => call('ipc', 'setSetting', name, value));
    },

    'tracked.set': async ({ key: name, value }) => {
      if (SETTING_BY_KEY.get(name)?.type !== 'tracked') throw invalid(`${String(name).slice(0, 40)} is not a tracked setting`);
      return feature('tracked', 'set', name, value);
    },

    'settings.refresh': async ({ group = 'all' }) => {
      oneOf(group, 'group', ['picture', 'sound', 'all']);
      requireTvOn();
      return call('ipc', 'refresh', group);
    },

    'input.label': async ({ source, label }) => {
      text(source, 'source', { max: 16, pattern: SOURCE });
      text(label, 'label', { max: 64, allowEmpty: true });
      return feature('tracked', 'setLabel', source, label);
    },

    'text.send': async ({ text: value, submit = false }) => {
      text(value, 'text', { max: 1000, allowEmpty: true });
      boolean(submit, 'submit');
      requireTvOn();
      return call('remote', 'text', value, submit);
    },

    'pointer.move': async ({ dx, dy }) => {
      number(dx, 'dx', -1000, 1000);
      number(dy, 'dy', -1000, 1000);
      requireTvOn();
      return call('remote', 'pointerMove', Math.round(dx), Math.round(dy));
    },

    'pointer.click': async ({ button = 'left' }) => {
      oneOf(button, 'button', ['left', 'right']);
      requireTvOn();
      return call('remote', 'pointerClick', button);
    },

    'pointer.scroll': async ({ dy }) => {
      number(dy, 'dy', -2400, 2400);
      requireTvOn();
      return call('remote', 'pointerScroll', dy);
    },

    'sleep.set': async ({ minutes }) => feature('sleep', 'set', integer(minutes, 'minutes', 0, 720)),

    'scene.run': async (cmd) => feature('scenes', 'run', text(subject(cmd), 'target', { max: 64, pattern: ITEM_ID }), { hub }),
    'scene.save': async ({ scene }) => feature('scenes', 'save', scene),
    'scene.delete': async (cmd) => feature('scenes', 'remove', text(subject(cmd), 'target', { max: 64, pattern: ITEM_ID })),

    'macro.record': async ({ phase, name }, client) => {
      oneOf(phase, 'phase', ['start', 'stop']);
      if (name !== undefined) text(name, 'name', { max: 40, allowEmpty: true });
      return feature('macros', 'record', client, phase, name);
    },
    'macro.run': async (cmd) => {
      requireTvOn();
      return feature('macros', 'run', text(subject(cmd), 'target', { max: 64, pattern: ITEM_ID }));
    },
    'macro.delete': async (cmd) => feature('macros', 'remove', text(subject(cmd), 'target', { max: 64, pattern: ITEM_ID })),

    'agent.connect': async () => {
      if (valueOf('conn.agent') === 'online') return { value: 'online' };
      requireTvOn();
      try {
        return await call('agent', 'launch');
      } catch (err) {
        if (err?.code === 'TV_OFF') throw err;
        log.warn('agent launch failed', { code: err?.code, message: err?.message });
        throw new LumenError('FAILED', 'Open "Lumen Agent" from the TV Apps screen');
      }
    },

    // Starts a TV app through the agent with app-control data (operation + extra keys), the way
    // Smart Hub tiles and other apps deep-link; the agent bounds the key count and size.
    'agent.launch': async ({ appId, operation, data }) => {
      requireTvOn();
      text(appId, 'appId', { max: 128, pattern: /^[A-Za-z0-9._-]+$/ });
      if (operation !== undefined) text(operation, 'operation', { max: 200, pattern: /^https?:\/\/[A-Za-z0-9./_-]+$/ });
      if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) {
        throw new LumenError('INVALID', 'data must be an object of app-control keys');
      }
      const res = await call('agent', 'request', 'launch', { appId, operation, data });
      return { value: res.value ?? res };
    },

    // An installed app's declared metadata (deep-link templates and the like) through the agent.
    'agent.meta': async ({ appId }) => {
      requireTvOn();
      text(appId, 'appId', { max: 128, pattern: /^[A-Za-z0-9._-]+$/ });
      const res = await call('agent', 'request', 'meta', { appId });
      return { value: res.value ?? res };
    },

    // One still of the TV screen via Lumen Eyes; the PNG is served at /api/screen.png.
    'screen.capture': async ({ mode }) => {
      requireTvOn();
      const shot = await call('eyes', 'capture', { mode: mode === undefined ? 0 : integer(mode, 'mode', 0, 2) });
      return { value: { at: shot.at, width: shot.width, height: shot.height, ms: shot.ms, url: `/api/screen.png?at=${shot.at}` } };
    },

    // How often this client's Screen view wants a fresh still: 0 pauses it.
    'screen.watch': async ({ everyMs }, client) => {
      const presence = clients.get(client);
      const every = integer(everyMs, 'everyMs', 0, 60000);
      if (every !== 0 && every < SCREEN_MIN_EVERY_MS) throw invalid(`everyMs is 0 or at least ${SCREEN_MIN_EVERY_MS}`);
      if (presence) presence.screenEveryMs = every;
      updateDemand();
      return { value: { everyMs: every } };
    },

    'pair.remote': async () => {
      requireTvOn();
      return call('remote', 'pair');
    },
    'pair.ipcontrol': async () => {
      requireTvOn();
      return call('ipc', 'pair');
    },

    view,

    // A relay URL the TV can play a stream from (fetched through the VPN when it is on).
    'stream.relay': async ({ url, referer }) => {
      text(url, 'url', { max: 4096 });
      if (referer !== undefined) text(referer, 'referer', { max: 2048 });
      return { value: await feature('relay', 'register', url, { referer }) };
    },

    'cast.url': async ({ url }) => {
      text(url, 'url', { max: 2048 });
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw invalid('That is not a link');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw invalid('Only http and https links can be cast');
      if (!config.browser?.allowLoopback && isLoopbackHost(parsed.hostname)) throw invalid('Links to this PC itself cannot be cast');
      // A plain web page opens in Lumen's own browser (§11.3), so only the TV-bound kinds need the
      // TV on; the cast feature checks after classifying the link.
      return feature('cast', 'castUrl', url);
    },
    'cast.file': async ({ fileId, name }) => {
      text(fileId, 'fileId', { max: 64, pattern: ITEM_ID });
      text(name, 'name', { max: 255 });
      requireTvOn();
      return feature('cast', 'castFile', fileId, name);
    },
    'cast.control': async ({ action, position }) => {
      oneOf(action, 'action', ['play', 'pause', 'stop', 'seek']);
      if (action === 'seek') number(position, 'position', 0, 24 * 3600);
      return feature('cast', 'control', action, action === 'seek' ? position : undefined);
    },

    'ai.ask': aiAsk,
    'ai.cancel': aiCancel,

    'browser.open': async ({ url }) => feature('browser', 'open', webUrl(url, 'url', !!config.browser?.allowLoopback)),
    'browser.nav': async ({ action }) => feature('browser', 'nav', oneOf(action, 'action', ['back', 'forward', 'reload', 'stop', 'home'])),
    'browser.input': async (cmd) => feature('browser', 'input', browserInput(cmd)),
    'browser.viewport': async ({ w, h }) => feature('browser', 'setViewport', number(w, 'w', 1, 16384), number(h, 'h', 1, 16384)),
    'browser.ack': async ({ seq }, client) => {
      integer(seq, 'seq', 0, Number.MAX_SAFE_INTEGER);
      features.browser?.ack?.(client, seq);
      return {};
    },
    'browser.close': async () => feature('browser', 'close'),
    // "On TV": Lumen's own browser shown full screen on the TV (the TV's built-in browser stays
    // available as browser.openInTvBrowser).
    'browser.openOnTv': async ({ url }) => {
      requireTvOn();
      const target = url === undefined ? valueOf('browser.url') : webUrl(url, 'url', !!config.browser?.allowLoopback);
      return feature('tvscreen', 'open', { url: target === valueOf('browser.url') ? undefined : target });
    },
    'browser.openInTvBrowser': openOnTv,
    'tvscreen.open': async ({ url }) => {
      requireTvOn();
      return feature('tvscreen', 'open', { url: url === undefined ? undefined : webUrl(url, 'url', !!config.browser?.allowLoopback) });
    },
    'tvscreen.close': async () => feature('tvscreen', 'close'),
    'tvscreen.playVideo': async () => {
      requireTvOn();
      return feature('tvscreen', 'playVideo');
    },

    // The VPN switch: Lumen's browser restarts with (or without) the tunnel proxy after every change.
    'vpn.set': async ({ on }) => {
      try {
        return await feature('vpn', boolean(on, 'on') ? 'enable' : 'disable');
      } finally {
        await features.browser?.applyProxy?.();
      }
    },
    'vpn.restoreBackup': async () => {
      try {
        return await feature('vpn', 'restoreBackup');
      } finally {
        await features.browser?.applyProxy?.();
      }
    },
    'vpn.reload': async () => {
      try {
        return await feature('vpn', 'reload');
      } finally {
        await features.browser?.applyProxy?.();
      }
    },
  };

  async function handle(msg, client = INTERNAL) {
    const startedAt = Date.now();
    const name = msg?.cmd;
    try {
      if (stopped) throw new LumenError('UNAVAILABLE', 'Lumen is stopping');
      const run = typeof name === 'string' && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
      if (!run) throw invalid(`Unknown command ${String(name).slice(0, 40)}`);
      safety.checkRate(client, STREAMED.has(name) ? 'pointer.move' : name);
      const res = await run(msg, client);
      const ack = { ok: true, ms: Date.now() - startedAt };
      if (res?.value !== undefined) ack.value = res.value;
      return ack;
    } catch (err) {
      const error = toErrorPayload(err);
      if (err instanceof LumenError) log.debug(`${name} → ${error.code}`, { message: error.message });
      else log.warn(`${name} failed unexpectedly`, err);
      return { ok: false, ms: Date.now() - startedAt, error };
    }
  }

  // ---------- clients ----------

  async function aiStatus() {
    if (typeof features.ai?.status !== 'function') return null;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => features.ai.status()),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), AI_STATUS_TIMEOUT_MS); }),
      ]);
    } catch (err) {
      log.warn('ai status failed', err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // Sends hello, then includes the client in broadcasts (so no patch can precede its hello).
  async function attach(client) {
    const ai = await aiStatus();
    if (stopped || detached.has(client)) return;
    send(client, {
      t: 'hello',
      version: VERSION,
      state: store.snapshot(),
      catalog: { keys: KEYS, settings: SETTINGS, apps: APPS },
      csrf: config.csrf,
      ai,
    });
    clients.set(client, { view: 'remote', visible: true });
    updateDemand();
  }

  function detach(client) {
    detached.add(client);
    if (!clients.delete(client)) return;
    for (const session of [...(holds.get(client)?.values() ?? [])]) endHold(session);
    holds.delete(client);
    features.macros?.discard?.(client);
    updateDemand();
  }

  // ---------- changedOnTv ----------

  function settleChange(key) {
    const pending = pendingChanges.get(key);
    pendingChanges.delete(key);
    const to = store.get(key)?.v;
    if (!pending || recentlyTouched(key) || to === undefined || to === null || deepEqual(pending.from, to)) return;
    broadcast({ t: 'changedOnTv', key, from: pending.from, to });
  }

  function observe(key, rec) {
    const prev = seen.get(key);
    if (rec) seen.set(key, rec);
    else seen.delete(key);
    if (!rec || !prev || rec.v === null || prev.v === null) return;
    if (!READ_SOURCES.has(rec.src) || !READ_SOURCES.has(prev.src) || rec.stale || prev.stale) return;
    if (!deepEqual(prev.scope, rec.scope) || deepEqual(prev.v, rec.v) || recentlyTouched(key)) return;
    const pending = pendingChanges.get(key);
    clearTimeout(pending?.timer);
    pendingChanges.set(key, {
      from: pending ? pending.from : prev.v,
      timer: setTimeout(() => settleChange(key), CHANGE_DEBOUNCE_MS),
    });
  }

  function onPatch(patch) {
    broadcast({ t: 'patch', patch });
    for (const [key, rec] of Object.entries(patch)) if (isWatched(key)) observe(key, rec);
  }

  const unsubscribe = store.on('patch', onPatch);

  async function stop() {
    if (stopped) return;
    stopped = true;
    lifetime.abort();
    unsubscribe();
    for (const pending of pendingChanges.values()) clearTimeout(pending.timer);
    pendingChanges.clear();
    const ending = [];
    for (const sessions of holds.values()) for (const session of sessions.values()) ending.push(endHold(session));
    await Promise.allSettled(ending);
    volumeLane.clear();
    clients.clear();
  }

  const hub = { handle, attach, detach, broadcast, sendToView, stop };
  return hub;
}
