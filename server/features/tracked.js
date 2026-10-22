// Tracked settings: values this firmware cannot report (catalogue type 'tracked') plus the
// user's names for inputs. Lumen only knows them because the user told it, so they are
// published as src 'tracked', via 'user', with `at` = when they were set.
import { LumenError } from '../errors.js';
import { SETTINGS } from '../catalog/settings.js';

const FILE = 'tracked.json';
const SOURCE_NAME = /^[A-Z][A-Z0-9]{0,15}$/;
const MAX_LABEL = 32;

const TRACKED = new Map(SETTINGS.filter((s) => s.type === 'tracked').map((s) => [s.key, s]));
const invalid = (message) => new LumenError('INVALID', message);

function validValue(entry, value) {
  if (entry.options) {
    const match = entry.options.find((option) => option.toLowerCase() === String(value).toLowerCase());
    if (!match) throw invalid(`${entry.label} must be one of ${entry.options.join(', ')}`);
    return match;
  }
  if (entry.range) {
    const n = Number(value);
    const [min, max] = entry.range;
    if (!Number.isFinite(n) || n < min || n > max) throw invalid(`${entry.label} must be between ${min} and ${max}`);
    return Math.round(n);
  }
  if (typeof value === 'boolean') return value;
  throw invalid(`${entry.label} has no valid values`);
}

export function createTracked({ data, log: rootLog, store }) {
  const log = rootLog.child('tracked');
  let state = { values: {}, labels: {}, labelsAt: null };

  function load() {
    const saved = data.readJson(FILE, {});
    state = {
      values: saved?.values && typeof saved.values === 'object' ? saved.values : {},
      labels: saved?.labels && typeof saved.labels === 'object' ? saved.labels : {},
      labelsAt: Number(saved?.labelsAt) || null,
    };
  }

  function save() {
    data.writeJson(FILE, state);
  }

  function publishValue(key) {
    const entry = TRACKED.get(key);
    const saved = state.values[key];
    if (!entry || !saved) return;
    store.set(key, saved.v, { src: 'tracked', via: 'user', at: saved.at, range: entry.range ?? null, options: entry.options ?? null });
  }

  function publishLabels() {
    store.set('input.labels', state.labels, { src: 'tracked', via: 'user', at: state.labelsAt ?? Date.now() });
  }

  return {
    start() {
      load();
      for (const key of Object.keys(state.values)) publishValue(key);
      publishLabels();
    },
    stop() {},
    setDemand() {},

    // value null forgets the setting.
    set(key, value) {
      const entry = TRACKED.get(key);
      if (!entry) throw invalid(`${key} is not a tracked setting`);
      if (value === null) {
        delete state.values[key];
        save();
        store.delete(key);
        log.info(`forgot ${key}`);
        return { value: null };
      }
      const v = validValue(entry, value);
      state.values[key] = { v, at: Date.now() };
      save();
      publishValue(key);
      log.info(`${key} tracked`, { value: v });
      return { value: v };
    },

    // An empty label removes the name.
    setLabel(source, label) {
      if (typeof source !== 'string' || !SOURCE_NAME.test(source)) throw invalid('Unknown input');
      if (typeof label !== 'string') throw invalid('Label must be text');
      const name = label.trim().slice(0, MAX_LABEL);
      if (name) state.labels[source] = name;
      else delete state.labels[source];
      state.labelsAt = Date.now();
      save();
      publishLabels();
      return { value: { ...state.labels } };
    },
  };
}
