// Scenes: named bundles of browser commands (§9.10 steps) run through hub.handle, so validation,
// safety and read-back apply to every step. Persisted in scenes.json; state key `scenes`.
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { LumenError } from '../errors.js';

const FILE = 'scenes.json';
const MAX_SCENES = 50;
const MAX_STEPS = 30;
const MAX_STEP_BYTES = 2048;
const MAX_WAIT_MS = 10000;
const MAX_NAME = 40;

// Commands a scene may contain (no scenes, macros, AI, pairing, presence or holds inside scenes).
const STEP_COMMANDS = new Set([
  'key', 'volume.set', 'volume.step', 'mute.set', 'power', 'app.launch', 'input.set', 'setting.set',
  'tracked.set', 'settings.refresh', 'text.send', 'sleep.set', 'cast.url',
]);

// Created only when scenes.json does not exist yet.
const DEFAULT_SCENES = [
  {
    id: 'night',
    name: 'Night',
    steps: [
      { cmd: 'setting.set', key: 'picture.backlight', value: 4 },
      { cmd: 'volume.set', value: 8, atMost: true },
    ],
  },
  {
    id: 'cinema',
    name: 'Cinema',
    steps: [
      { cmd: 'setting.set', key: 'picture.mode', value: 'Movie', waitMs: 800 },
      { cmd: 'setting.set', key: 'picture.backlight', value: 8 },
      { cmd: 'setting.set', key: 'picture.localDimming', value: 'High' },
    ],
  },
];

// Scenes act on the hub as their own client (no browser socket to answer).
const SCENE_CLIENT = Object.freeze({ id: 'scene', kind: 'scene', send() {} });

const invalid = (message) => new LumenError('INVALID', message);

function cleanStep(step, index) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) throw invalid(`Step ${index + 1} is not a command`);
  const { t, id, ...rest } = step;
  if (!STEP_COMMANDS.has(rest.cmd)) throw invalid(`Step ${index + 1}: ${rest.cmd ?? 'a command'} cannot be used in a scene`);
  if (rest.waitMs !== undefined && (!Number.isInteger(rest.waitMs) || rest.waitMs < 0 || rest.waitMs > MAX_WAIT_MS)) {
    throw invalid(`Step ${index + 1}: waitMs must be 0–${MAX_WAIT_MS}`);
  }
  if (Buffer.byteLength(JSON.stringify(rest)) > MAX_STEP_BYTES) throw invalid(`Step ${index + 1} is too large`);
  return rest;
}

function stepLabel(step) {
  return step.key ?? step.cmd;
}

export function createScenes({ data, log: rootLog, store }) {
  const log = rootLog.child('scenes');
  let scenes = [];
  let running = null;
  let stopped = false;

  function publish() {
    store.set('scenes', scenes, { src: 'tracked', via: 'lumen' });
  }

  function persist() {
    data.writeJson(FILE, scenes);
    publish();
  }

  function find(id) {
    const scene = scenes.find((s) => s.id === id);
    if (!scene) throw invalid('Unknown scene');
    return scene;
  }

  return {
    start() {
      stopped = false;
      const saved = data.readJson(FILE, null);
      if (Array.isArray(saved)) {
        scenes = saved.filter((s) => s && typeof s.id === 'string' && Array.isArray(s.steps));
        publish();
      } else {
        const createdAt = Date.now();
        scenes = DEFAULT_SCENES.map((s) => ({ ...structuredClone(s), createdAt }));
        persist();
        log.info('created the default scenes');
      }
    },
    stop() {
      stopped = true;
    },
    setDemand() {},

    list: () => scenes,

    save(scene) {
      if (!scene || typeof scene !== 'object') throw invalid('Scene missing');
      const name = typeof scene.name === 'string' ? scene.name.trim() : '';
      if (!name || name.length > MAX_NAME) throw invalid(`Scene name must be 1–${MAX_NAME} characters`);
      if (!Array.isArray(scene.steps) || !scene.steps.length || scene.steps.length > MAX_STEPS) {
        throw invalid(`A scene needs 1–${MAX_STEPS} steps`);
      }
      const steps = scene.steps.map(cleanStep);
      const existing = typeof scene.id === 'string' ? scenes.find((s) => s.id === scene.id) : null;
      if (!existing && scenes.length >= MAX_SCENES) throw invalid(`At most ${MAX_SCENES} scenes`);
      const saved = existing
        ? { ...existing, name, steps }
        : { id: `scene-${randomBytes(4).toString('hex')}`, name, steps, createdAt: Date.now() };
      scenes = existing ? scenes.map((s) => (s.id === saved.id ? saved : s)) : [...scenes, saved];
      persist();
      return { value: saved };
    },

    remove(id) {
      find(id);
      scenes = scenes.filter((s) => s.id !== id);
      persist();
      return { value: { id } };
    },

    // Runs every step even when one fails; any failure makes the whole run reject with a summary.
    async run(id, { hub }) {
      const scene = find(id);
      if (running) throw new LumenError('RATE_LIMIT', `${running} is still running`);
      running = scene.name;
      const results = [];
      try {
        for (const { waitMs, ...cmd } of scene.steps) {
          if (stopped) break;
          const res = await hub.handle(cmd, SCENE_CLIENT);
          results.push({ step: stepLabel(cmd), ...res });
          if (waitMs) await sleep(waitMs);
        }
      } finally {
        running = null;
      }
      const failed = results.filter((r) => !r.ok);
      log.info(`ran ${scene.name}`, { steps: results.length, failed: failed.length });
      if (failed.length) {
        const first = failed[0];
        throw new LumenError(failed.length === results.length ? first.error.code : 'FAILED',
          `${scene.name}: ${failed.length} of ${results.length} steps failed (${first.step}: ${first.error.message})`);
      }
      return { value: { id, name: scene.name, results } };
    },
  };
}
