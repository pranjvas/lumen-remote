// Shared app context handed to every view: state, live link, catalogue lookups and commands.

import { toast } from '../ui/toast.js';
import { haptic } from '../ui/haptics.js';
import { flash } from '../ui/dom.js';

const ERRORS = {
  LOCKED_IN_MODE: 'Locked in this picture mode',
  UNAVAILABLE: 'Not available on this TV',
  NOT_PAIRED: 'Not paired yet — pair in Settings › Connection',
  TV_OFF: 'The TV is off',
  RATE_LIMIT: 'Easy — too many commands at once',
  INVALID: 'That request was not valid',
  FAILED: 'The TV refused that',
  OFFLINE: 'Not connected to Lumen',
  TIMEOUT: 'The TV did not answer in time',
};

const DEFAULT_HOLD = {
  KEY_UP: 'repeat', KEY_DOWN: 'repeat', KEY_LEFT: 'repeat', KEY_RIGHT: 'repeat',
  KEY_VOLUP: 'repeat', KEY_VOLDOWN: 'repeat', KEY_CHUP: 'repeat', KEY_CHDOWN: 'repeat',
  KEY_ENTER: 'press', KEY_RETURN: 'press', KEY_HOME: 'press',
  KEY_REWIND: 'press', KEY_FF: 'press',
};

function errorText(error) {
  if (!error) return 'Something went wrong';
  const base = ERRORS[error.code];
  if (error.message && (error.code === 'FAILED' || error.code === 'INVALID' || !base)) return error.message;
  return base || error.message || 'Something went wrong';
}

export function createContext({ live, state }) {
  const listeners = new Map();
  const locks = new Map();
  let catalog = { keys: [], settings: [], apps: [] };
  let keyIndex = new Map();
  let settingIndex = new Map();
  let appIndex = new Map();

  const ctx = {
    live,
    state,
    csrf: null,
    ai: null,
    version: null,
    webBuild: undefined,
    staleBuild: null, // set when Lumen now serves another web build than this page's (main.js)

    get catalog() { return catalog; },

    // Catalogue, CSRF token and AI status from hello (state is loaded separately, after this).
    setHello(hello) {
      catalog = {
        keys: hello.catalog?.keys || [],
        settings: hello.catalog?.settings || [],
        apps: hello.catalog?.apps || [],
      };
      keyIndex = new Map(catalog.keys.map((k) => [k.key, k]));
      settingIndex = new Map(catalog.settings.map((s) => [s.key, s]));
      appIndex = new Map(catalog.apps.map((a) => [a.id, a]));
      ctx.csrf = hello.csrf || null;
      ctx.ai = hello.ai || null;
      ctx.version = hello.version || null;
      // The web build this page was loaded with: the first hello's only ('' when it named none), so a
      // later hello from a redeployed Lumen can be told apart (core/build.js).
      if (ctx.webBuild === undefined) ctx.webBuild = typeof hello.webBuild === 'string' ? hello.webBuild : '';
    },

    keyInfo: (key) => keyIndex.get(key),
    hasKey: (key) => !catalog.keys.length || keyIndex.has(key),
    holdPolicy: (key) => keyIndex.get(key)?.hold || DEFAULT_HOLD[key] || 'none',
    setting: (key) => settingIndex.get(key),

    // Installed apps (agent or curated seed) merged with catalogue colours and glyphs.
    apps() {
      const installed = state.value('app.installed', null);
      const list = Array.isArray(installed) && installed.length ? installed : catalog.apps;
      return list.map((a) => ({ ...(appIndex.get(a.id) || {}), ...a, color: a.color || appIndex.get(a.id)?.color, short: a.short || appIndex.get(a.id)?.short }));
    },

    app(id) {
      if (!id) return null;
      return ctx.apps().find((a) => a.id === id) || appIndex.get(id) || null;
    },

    isLocked: (key) => {
      if (!locks.has(key)) return false;
      const scope = locks.get(key);
      return scope === `${state.value('input.source', '')}|${state.value('picture.mode', '')}`;
    },
    lock(key) {
      locks.set(key, `${state.value('input.source', '')}|${state.value('picture.mode', '')}`);
      ctx.emit('locks', key);
    },

    async cmd(name, args = {}, { el, silent = false, timeoutMs } = {}) {
      const ack = await live.send(name, args, timeoutMs ? { timeoutMs } : undefined);
      if (!ack.ok) {
        haptic('error');
        if (el) flash(el, 'shake', 400);
        if (ack.error?.code === 'LOCKED_IN_MODE' && args.key) ctx.lock(args.key);
        if (!silent) toast(errorText(ack.error), { level: ack.error?.code === 'OFFLINE' ? 'warn' : 'error' });
      }
      return ack;
    },

    key(key) {
      return ctx.cmd('key', { key });
    },

    navigate(view) {
      ctx.emit('navigate', view);
    },

    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    emit(type, payload) {
      for (const fn of listeners.get(type) || []) {
        try { fn(payload); } catch (err) { console.error(`ctx listener "${type}" failed`, err); }
      }
    },
  };
  return ctx;
}
