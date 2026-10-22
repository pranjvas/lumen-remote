// Provenance badges: LIVE · TV AGENT · TRACKED · DERIVED · STALE · UNAVAILABLE (+ LOCKED, UI-only).
// Every badge registered here follows its state key and re-ages itself.

import { h } from './dom.js';
import { ago, stamp } from './format.js';

const LABELS = {
  live: 'Live',
  agent: 'TV agent',
  tracked: 'Tracked',
  derived: 'Derived',
  stale: 'Stale',
  unavailable: 'Unavailable',
  reading: 'Reading',
  locked: 'Locked',
};

const VIA = [
  [/^gena/i, 'UPnP push'],
  [/^upnp/i, 'UPnP'],
  [/^ipc/i, 'IP Control'],
  [/^rest/i, 'TV REST'],
  [/^(remote|ws)/i, 'remote channel'],
  [/^agent/i, 'TV agent'],
  [/^user/i, 'you'],
  [/^(catalog|seed)/i, 'Lumen catalogue'],
  [/^cache/i, 'last session'],
  [/^(avtransport|dlna)/i, 'DLNA'],
  [/^dial/i, 'DIAL'],
];

function viaLabel(via, src) {
  if (!via) return src === 'tracked' ? 'you' : src === 'agent' ? 'TV agent' : 'the TV';
  for (const [re, label] of VIA) if (re.test(via)) return label;
  return via;
}

// Readings of what the TV is doing; while it sleeps they are only the last known values.
const TV_READING = /^(audio|picture|input\.source|app\.foreground|channel|caption|system|cast)/;
// Read only through IP Control: without a working IP Control link they are not "on the way".
const IPC_ONLY = /^(picture\.|audio\.(soundMode|speaker)$)/;

function provenance(rec, { locked = false, asleep = false, tvOn = false, ipcUp = true, tracked = false, key = '' } = {}) {
  if (locked) return { kind: 'locked', label: LABELS.locked, tip: 'Refused by the TV in this picture mode' };
  if (!rec && !tracked && IPC_ONLY.test(key) && !ipcUp) {
    return { kind: 'unavailable', label: LABELS.unavailable, tip: 'Needs IP Control — pair it in Settings › Connection' };
  }
  // Never read yet while the TV is on: the first poll is on its way, so it is not "unavailable".
  if (!rec && tvOn && !tracked && TV_READING.test(key)) return { kind: 'reading', label: LABELS.reading, tip: 'Reading from the TV' };
  if (!rec || rec.v === undefined || rec.v === null) {
    return { kind: 'unavailable', label: LABELS.unavailable, tip: rec?.note ? `The TV reports this as ${rec.note}` : rec ? 'Not exposed by the TV right now' : 'Not read from the TV yet' };
  }
  const via = viaLabel(rec.via, rec.src);
  const age = ago(rec.at);
  const expired = rec.ttlMs && rec.at && Date.now() - rec.at > rec.ttlMs;
  const sleeping = asleep && (rec.src === 'live' || rec.src === 'agent') && TV_READING.test(key);
  if (rec.src === 'cache' || rec.stale || expired || sleeping) {
    return { kind: 'stale', label: LABELS.stale, tip: `Last known · from ${via}, ${age}` };
  }
  if (rec.src === 'tracked') {
    return { kind: 'tracked', label: LABELS.tracked, tip: `Told to Lumen by ${via} · set ${stamp(rec.at)}` };
  }
  if (rec.src === 'agent') return { kind: 'agent', label: LABELS.agent, tip: `from ${via}, ${age}` };
  if (rec.src === 'derived') return { kind: 'derived', label: LABELS.derived, tip: `from ${via}, ${age}` };
  return { kind: 'live', label: LABELS.live, tip: `from ${via}, ${age}` };
}

const registry = new Set();
let ctx = null;

// isTracked(key): the key is a tracked-only setting (never read from the TV).
export function initBadges(state, isLocked, isTracked) {
  ctx = { state, isLocked, isTracked };
  state.watch('*', (keys) => {
    const set = new Set(keys);
    const all = set.has('conn.tv') || set.has('conn.ipc');
    for (const b of registry) if (all || set.has(b.key)) render(b, set.has(b.key));
  }, { immediate: false });
  setInterval(() => {
    for (const b of registry) {
      if (!b.el.isConnected) { registry.delete(b); continue; }
      render(b, false);
    }
  }, 5000);
}

export function badge(key, { compact = false } = {}) {
  const el = h('span', { class: compact ? 'badge compact' : 'badge', role: 'note' });
  const b = { key, el, last: null };
  registry.add(b);
  render(b, false);
  return el;
}

function render(b, fresh) {
  if (!ctx) return;
  const rec = ctx.state.get(b.key);
  const tv = ctx.state.value('conn.tv', null);
  const p = provenance(rec, {
    locked: ctx.isLocked?.(b.key),
    asleep: tv === 'standby' || tv === 'off',
    tvOn: tv === 'on',
    ipcUp: !['unpaired', 'down'].includes(ctx.state.value('conn.ipc', null)),
    tracked: Boolean(ctx.isTracked?.(b.key)),
    key: b.key,
  });
  const sig = `${p.kind}|${p.tip}`;
  if (sig === b.last) return;
  b.last = sig;
  b.el.dataset.kind = p.kind;
  b.el.dataset.tip = p.tip;
  b.el.textContent = p.label;
  b.el.setAttribute('aria-label', `${p.label}: ${p.tip}`);
  if (fresh && p.kind === 'live') {
    b.el.classList.remove('is-fresh');
    void b.el.offsetWidth;
    b.el.classList.add('is-fresh');
  }
}

export function refreshBadges() {
  for (const b of registry) { b.last = null; render(b, false); }
}
