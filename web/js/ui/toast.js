// Toasts, "changed on TV" whispers and a throttled polite live region.

import { h, icon } from './dom.js';

const ICONS = { info: 'info', warn: 'alert', error: 'alert', ok: 'check', whisper: 'wave' };
let host = null;
let live = null;
let lastAnnounce = 0;
let queued = null;

export function initToasts(toastHost, liveRegion) {
  host = toastHost;
  live = liveRegion;
}

export function toast(text, { level = 'info', timeout = 3600 } = {}) {
  if (!host || !text) return;
  const el = h('div', { class: `toast ${level}`, role: level === 'error' ? 'alert' : 'status' }, icon(ICONS[level] || 'info'), h('span', { text }));
  host.append(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 240);
  }, timeout);
}

export function whisper(text) {
  toast(text, { level: 'whisper', timeout: 2200 });
  announce(text);
}

export function announce(text) {
  if (!live) return;
  const now = Date.now();
  if (now - lastAnnounce < 2000) {
    queued = text;
    setTimeout(() => { if (queued) { const t = queued; queued = null; announce(t); } }, 2000 - (now - lastAnnounce));
    return;
  }
  lastAnnounce = now;
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = text; });
}
