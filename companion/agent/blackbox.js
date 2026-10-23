// Lumen Agent black box: a small ring of notable events kept in localStorage, so when the page is
// cut off (the TV closes it, a crash, a freeze) the PC can read what happened just before, once the
// agent is back and says hello. Script errors, stretches where this page's script did not run (the
// TV starving or freezing it), memory, visibility changes, socket closes and the live player's
// events go in. Loaded before every other agent script. ES2017 only (Chromium 69).
(function () {
  'use strict';

  const KEY = 'lumen.box';
  const MAX = 80;
  const TICK_MS = 1000;
  const STALL_MS = 2500;
  const MEM_EVERY_MS = 10000;

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; }
  }

  let ring = load();
  let sink = null; // agent.js: sends each note to the PC as it happens (localStorage can be lost in a kill)

  function note(kind, data) {
    const entry = { t: Date.now(), k: String(kind).slice(0, 24), d: data === undefined ? null : data };
    ring.push(entry);
    if (sink) { try { sink(entry); } catch (e) { /* the PC is gone: the ring keeps it */ } }
    if (ring.length > MAX) ring = ring.slice(ring.length - MAX);
    try { localStorage.setItem(KEY, JSON.stringify(ring)); } catch (e) { /* storage full: keep in memory */ }
  }

  // Everything noted since the last hand-over; the ring then starts again.
  function take() {
    const out = ring;
    ring = [];
    try { localStorage.setItem(KEY, '[]'); } catch (e) { /* ignore */ }
    return out;
  }

  window.addEventListener('error', function (e) {
    note('error', { msg: String(e.message || e.error || 'error').slice(0, 200), at: (e.filename || '').split('/').pop() + ':' + (e.lineno || 0) });
  });
  window.addEventListener('unhandledrejection', function (e) {
    const r = e && e.reason;
    note('rejection', String((r && (r.name + ': ' + r.message)) || r).slice(0, 200));
  });
  document.addEventListener('visibilitychange', function () { note('visibility', document.hidden ? 'hidden' : 'visible'); });

  // A timer that fires late means this page's script was not running: the TV starved or froze it.
  let last = Date.now();
  setInterval(function () {
    const now = Date.now();
    const gap = now - last;
    last = now;
    if (gap > STALL_MS) note('script-stall', { ms: gap });
  }, TICK_MS);

  // JS heap now and then (Chromium's performance.memory), only when it moved by 16 MB or more.
  let lastHeap = 0;
  setInterval(function () {
    const m = window.performance && performance.memory;
    if (!m) return;
    const used = Math.round(m.usedJSHeapSize / 1048576);
    if (Math.abs(used - lastHeap) >= 16) {
      lastHeap = used;
      note('heap', { usedMb: used, limitMb: Math.round(m.jsHeapSizeLimit / 1048576) });
    }
  }, MEM_EVERY_MS);

  note('start', { at: new Date().toISOString() });
  window.LumenBox = { note: note, take: take, setSink: function (fn) { sink = typeof fn === 'function' ? fn : null; } };
})();
