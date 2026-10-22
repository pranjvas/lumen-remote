// Key macros: record the keys a client clicks (with their timing) and replay them later.
// Persisted in macros.json as [{ id, name, steps: [{ key, gapMs }], createdAt }]; state key `macros`.
// KEY_POWER is never recorded or replayed: it toggles, so a replay could turn the TV on or off.
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { LumenError } from '../errors.js';
import { isAllowedKey } from '../catalog/keys.js';

const FILE = 'macros.json';
const MIN_GAP_MS = 150;
const MAX_GAP_MS = 10000;
const MAX_STEPS = 100;
const MAX_MACROS = 50;
const MAX_NAME = 40;

const invalid = (message) => new LumenError('INVALID', message);
const clampGap = (ms) => Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, Math.round(Number(ms) || 0)));
const replayable = (key) => key !== 'KEY_POWER' && isAllowedKey(key);

export function createMacros({ data, log: rootLog, store, remote }) {
  const log = rootLog.child('macros');
  const recordings = new Map(); // client → { name, steps, last }
  let macros = [];
  let running = null;
  let stopped = false;

  function publish() {
    store.set('macros', macros, { src: 'tracked', via: 'lumen' });
  }

  function persist() {
    data.writeJson(FILE, macros);
    publish();
  }

  function find(id) {
    const macro = macros.find((m) => m.id === id);
    if (!macro) throw invalid('Unknown macro');
    return macro;
  }

  function cleanName(name, fallback) {
    const text = typeof name === 'string' ? name.trim().slice(0, MAX_NAME) : '';
    return text || fallback;
  }

  return {
    start() {
      stopped = false;
      const saved = data.readJson(FILE, []);
      macros = Array.isArray(saved) ? saved.filter((m) => m && typeof m.id === 'string' && Array.isArray(m.steps)) : [];
      publish();
    },
    stop() {
      stopped = true;
      recordings.clear();
    },
    setDemand() {},

    list: () => macros,
    isRecording: (client) => recordings.has(client),

    record(client, phase, name) {
      if (phase === 'start') {
        recordings.set(client, { name, steps: [], last: Date.now() });
        return { value: { recording: true } };
      }
      if (phase !== 'stop') throw invalid("phase must be 'start' or 'stop'");
      const session = recordings.get(client);
      if (!session) throw invalid('Not recording');
      recordings.delete(client);
      if (!session.steps.length) throw invalid('No keys were recorded');
      if (macros.length >= MAX_MACROS) throw invalid(`At most ${MAX_MACROS} macros`);
      const macro = {
        id: `macro-${randomBytes(4).toString('hex')}`,
        name: cleanName(name ?? session.name, `Macro ${macros.length + 1}`),
        steps: session.steps,
        createdAt: Date.now(),
      };
      macros = [...macros, macro];
      persist();
      log.info(`recorded ${macro.name}`, { steps: macro.steps.length });
      return { value: macro };
    },

    // Called by the hub after each successful key click from `client`.
    capture(client, key) {
      const session = recordings.get(client);
      if (!session || !replayable(key) || session.steps.length >= MAX_STEPS) return;
      const now = Date.now();
      session.steps.push({ key, gapMs: clampGap(now - session.last) });
      session.last = now;
    },

    // Drops an unfinished recording (the client went away).
    discard(client) {
      recordings.delete(client);
    },

    remove(id) {
      find(id);
      macros = macros.filter((m) => m.id !== id);
      persist();
      return { value: { id } };
    },

    async run(id) {
      const macro = find(id);
      if (running) throw new LumenError('RATE_LIMIT', `${running} is still running`);
      const blocked = macro.steps.find((step) => !replayable(step.key));
      if (blocked) throw invalid(`${blocked.key} cannot be replayed`);
      running = macro.name;
      let sent = 0;
      try {
        for (const step of macro.steps) {
          if (stopped) break;
          await sleep(clampGap(step.gapMs));
          await remote.click(step.key);
          sent += 1;
        }
      } finally {
        running = null;
      }
      return { value: { id, name: macro.name, sent } };
    },
  };
}
