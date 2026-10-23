// Provenance store (spec §5.1, §9.4). Every state key holds a record; changes are emitted as
// flat merge patches batched every 50 ms; real TV readings are cached to disk for instant first
// paint and come back after a restart as `src: 'cache', stale: true`.
import fs from 'node:fs';
import { writeJsonAtomic } from './config.js';

const SOURCES = new Set(['live', 'agent', 'tracked', 'cache', 'derived']);
// Writes from these sources never replace a fresh live record (§9.4 ranking rule).
const WEAK_SOURCES = new Set(['agent', 'derived', 'cache']);
const PERSISTED_SOURCES = new Set(['live', 'agent', 'cache']);
// Connection state, live interaction state and feature-owned keys are never cached.
const EPHEMERAL = /^(?:conn\.|power\.|ime$|touch\.|sleep$|scenes$|macros$|cast\.|browser\.|vpn\.|screen\.|tvscreen\.)/;
const MARKABLE = ['stale', 'note'];

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

function matcher(pattern) {
  if (pattern === '*') return () => true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1);
    return (key) => key.startsWith(prefix);
  }
  return (key) => key === pattern;
}

function cloneValue(v) {
  if (v === undefined) return null;
  return v !== null && typeof v === 'object' ? structuredClone(v) : v;
}

export function createStore({ cachePath, log, batchMs = 50, persistMs = 10000 } = {}) {
  const records = new Map();
  const listeners = new Set();
  let pending = null;
  let batchTimer = null;
  let dirty = false;
  let stopped = false;

  restore();
  const persistTimer = cachePath ? setInterval(persist, persistMs) : null;
  persistTimer?.unref();

  function makeRecord(v, meta, prev) {
    return Object.freeze({
      v: cloneValue(v),
      src: meta.src,
      via: meta.via ?? null,
      at: meta.at ?? Date.now(),
      ttlMs: meta.ttlMs ?? null,
      stale: meta.stale ?? false,
      range: meta.range ?? prev?.range ?? null,
      options: meta.options ?? prev?.options ?? null,
      scope: meta.scope ?? null,
      pending: null,
      note: meta.note ?? null,
    });
  }

  function isFreshLive(rec) {
    return rec.src === 'live' && !rec.stale && rec.ttlMs > 0 && Date.now() - rec.at < rec.ttlMs;
  }

  function queue(key, rec) {
    (pending ??= {})[key] = rec;
    if (!EPHEMERAL.test(key)) dirty = true;
    if (!batchTimer && !stopped) batchTimer = setTimeout(flush, batchMs);
  }

  function flush() {
    clearTimeout(batchTimer);
    batchTimer = null;
    if (!pending) return;
    const patch = pending;
    pending = null;
    for (const fn of listeners) {
      try {
        fn(patch);
      } catch (err) {
        log?.error('patch listener failed', err);
      }
    }
  }

  // Stores a value; returns true when the value itself changed.
  function set(key, v, meta = {}) {
    if (typeof key !== 'string' || !key) throw new TypeError('store.set needs a key');
    const src = meta.src ?? 'live';
    if (!SOURCES.has(src)) throw new TypeError(`Unknown src "${src}" for ${key}`);
    const prev = records.get(key);
    if (prev && WEAK_SOURCES.has(src) && isFreshLive(prev)) return false;
    const rec = makeRecord(v, { ...meta, src }, prev);
    records.set(key, rec);
    queue(key, rec);
    return !prev || !deepEqual(prev.v, rec.v);
  }

  // Applies { stale?, note? } to every key matching 'x.*', '*' or an exact key.
  function mark(pattern, changes = {}) {
    const matches = matcher(pattern);
    let count = 0;
    for (const [key, rec] of records) {
      if (!matches(key)) continue;
      const update = {};
      for (const field of MARKABLE) if (field in changes && rec[field] !== changes[field]) update[field] = changes[field];
      if (!Object.keys(update).length) continue;
      const next = Object.freeze({ ...rec, ...update });
      records.set(key, next);
      queue(key, next);
      count += 1;
    }
    return count;
  }

  function remove(key) {
    if (!records.delete(key)) return false;
    queue(key, null);
    return true;
  }

  function restore() {
    if (!cachePath) return;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      return;
    }
    for (const [key, rec] of Object.entries(doc?.records ?? {})) {
      if (EPHEMERAL.test(key) || !rec || typeof rec !== 'object' || !('v' in rec)) continue;
      records.set(key, makeRecord(rec.v, { ...rec, src: 'cache', stale: true, at: Number(rec.at) || Date.now() }));
    }
  }

  function persist() {
    if (!cachePath || !dirty) return;
    dirty = false;
    const out = {};
    for (const [key, rec] of records) {
      if (!EPHEMERAL.test(key) && PERSISTED_SOURCES.has(rec.src)) out[key] = rec;
    }
    try {
      writeJsonAtomic(cachePath, { version: 1, savedAt: Date.now(), records: out });
    } catch (err) {
      dirty = true;
      log?.warn('state cache not saved', err);
    }
  }

  return {
    set,
    mark,
    delete: remove,
    get: (key) => records.get(key),
    has: (key) => records.has(key),
    snapshot: () => Object.fromEntries(records),
    on(event, fn) {
      if (event !== 'patch') throw new TypeError(`Unknown store event ${event}`);
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    off(event, fn) {
      listeners.delete(fn);
    },
    flush,
    persist,
    async stop({ save = true } = {}) {
      if (stopped) return;
      stopped = true;
      clearInterval(persistTimer);
      flush();
      if (save) persist();
    },
  };
}
