// Flat map of provenance records from hello.state + patches, with prefix watchers
// and a UI-only optimistic overlay (the server never sends pending values).

const isRecord = (o) => o && typeof o === 'object' && !Array.isArray(o) && ('v' in o || 'src' in o);

// The spec promises a flat snapshot; flatten defensively in case a nested one arrives.
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || isRecord(v)) out[key] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
  }
  return out;
}

function matches(pattern, key) {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return key.startsWith(pattern.slice(0, -1));
  return pattern === key;
}

export function createState() {
  const records = new Map();
  const overlays = new Map();
  const watchers = new Set();

  function notify(keys) {
    if (!keys.length) return;
    for (const w of [...watchers]) {
      const hit = keys.filter((k) => w.patterns.some((p) => matches(p, k)));
      if (hit.length) {
        try { w.fn(hit); } catch (err) { console.error('state watcher failed', err); }
      }
    }
  }

  return {
    load(snapshot) {
      const before = [...records.keys()];
      records.clear();
      for (const [k, rec] of Object.entries(flatten(snapshot))) if (rec) records.set(k, rec);
      notify([...new Set([...before, ...records.keys()])]);
    },

    apply(patch) {
      const changed = [];
      for (const [k, rec] of Object.entries(flatten(patch))) {
        if (rec === null) records.delete(k);
        else records.set(k, rec);
        changed.push(k);
      }
      notify(changed);
    },

    get(key) {
      const rec = records.get(key);
      const over = overlays.get(key);
      if (!over) return rec;
      return { ...(rec || { src: 'live', at: Date.now() }), v: over.v, uiPending: true };
    },

    truth(key) {
      return records.get(key);
    },

    value(key, fallback = undefined) {
      const rec = this.get(key);
      return rec && rec.v !== undefined && rec.v !== null ? rec.v : fallback;
    },

    watch(patterns, fn, { immediate = true } = {}) {
      const w = { patterns: [].concat(patterns), fn };
      watchers.add(w);
      if (immediate) {
        const keys = w.patterns.flatMap((p) => (p.includes('*') ? [...records.keys()].filter((k) => matches(p, k)) : [p]));
        try { fn(keys.length ? keys : w.patterns); } catch (err) { console.error('state watcher failed', err); }
      }
      return () => watchers.delete(w);
    },

    // Optimistic value shown until cleared (ack, error or timeout).
    setOverlay(key, v) {
      overlays.set(key, { v });
      notify([key]);
    },

    clearOverlay(key) {
      if (overlays.delete(key)) notify([key]);
    },
  };
}
