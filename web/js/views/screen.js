// Screen: what the TV is showing, as Lumen Eyes captures it (video and on-screen menus together).
// The server captures only while a visible client has this view open, at the fastest cadence any
// viewer chose; each new still bumps `screen.at` and this view swaps it in without a flash.

import { h, icon, fill } from '../ui/dom.js';
import { createSegmented } from '../ui/segmented.js';
import { haptic } from '../ui/haptics.js';
import { ago, clock } from '../ui/format.js';

const EVERY_KEY = 'lumen.screen.every';
const EVERY = [1000, 5000, 0];
const EVERY_LABEL = { 1000: 'Live', 5000: 'Every 5 s', 0: 'Paused' };
const STALE_MS = 8000;

const readEvery = () => {
  const saved = localStorage.getItem(EVERY_KEY);
  const v = saved === null ? NaN : Number(saved);
  return EVERY.includes(v) ? v : 1000;
};

export function mountScreen(root, ctx) {
  let every = readEvery();
  let shownAt = 0;
  let loadingAt = 0;
  let front = 0;

  const status = h('span', { class: 'chip screen-status' });
  const layers = [0, 1].map(() => h('img', { class: 'screen-layer', alt: '', decoding: 'async', draggable: 'false' }));
  const empty = h('div', { class: 'screen-empty' }, h('i', { class: 'tv-line' }), h('span', { class: 'screen-empty-text' }));
  const appPill = h('span', { class: 'screen-pill screen-app', hidden: true });
  const metaPill = h('span', { class: 'screen-pill screen-meta num', hidden: true });
  const frame = h('div', {
    class: 'screen-frame', role: 'img', 'aria-label': 'The TV screen',
    ondblclick: () => fullscreen(),
  }, ...layers, empty, h('div', { class: 'screen-overlay' }, appPill, metaPill));
  const stage = h('figure', { class: 'screen-stage' }, frame, h('div', { class: 'screen-stand', 'aria-hidden': 'true' }));

  const rate = createSegmented({
    options: EVERY, value: every, label: 'How often to look', format: (v) => EVERY_LABEL[v],
    onSelect: (v) => {
      every = v;
      localStorage.setItem(EVERY_KEY, String(v));
      rate.set(v);
      watch();
      paintStatus();
    },
  });
  const save = h('a', { class: 'btn ghost screen-save', href: '/api/screen.png', download: 'tv-screen.png', 'aria-label': 'Save this still' },
    icon('photo', 'sm'), h('span', { text: 'Save still' }));
  const full = h('button', { class: 'btn ghost screen-full', type: 'button', 'aria-label': 'Full screen', onclick: () => fullscreen() }, icon('aspect', 'sm'), h('span', { text: 'Full screen' }));
  const connect = h('button', { class: 'btn primary sm', type: 'button', hidden: true, onclick: async () => {
    connect.classList.add('is-pending');
    await ctx.cmd('agent.connect', {}, { el: connect, timeoutMs: 30000 });
    connect.classList.remove('is-pending');
  } }, icon('agent', 'sm'), h('span', { text: 'Connect TV agent' }));

  const steer = (label, iconName, key, extra = '') => h('button', {
    class: `key steer-key ${extra}`, type: 'button', 'aria-label': label,
    onclick: () => { haptic('key'); ctx.key(key); },
  }, icon(iconName, 'sm'));
  const pad = h('div', { class: 'screen-steer', role: 'group', 'aria-label': 'Steer the TV' },
    steer('Back', 'back', 'KEY_RETURN', 'steer-back'),
    steer('Up', 'up', 'KEY_UP', 'steer-up'),
    steer('Home', 'home', 'KEY_HOME', 'steer-home'),
    steer('Left', 'left', 'KEY_LEFT', 'steer-left'),
    h('button', { class: 'key steer-key steer-ok', type: 'button', 'aria-label': 'OK', onclick: () => { haptic('key'); ctx.key('KEY_ENTER'); } }, 'OK'),
    steer('Right', 'right', 'KEY_RIGHT', 'steer-right'),
    steer('Down', 'down', 'KEY_DOWN', 'steer-down'));

  const readout = (label) => {
    const value = h('span', { class: 'readout-value num', text: '—' });
    return { el: h('div', { class: 'readout screen-readout' }, h('span', { class: 'silk', text: label }), value), value };
  };
  const seen = readout('Seen');
  const trip = readout('Latency');
  const onTv = readout('On the TV');
  const eyes = readout('Eyes');

  root.append(
    h('header', { class: 'view-head' },
      h('div', null,
        h('h1', { class: 'view-title', text: 'Screen' }),
        h('p', { class: 'view-sub', text: 'What the TV is showing, as Lumen sees it' })),
      status),
    stage,
    h('div', { class: 'screen-controls' }, rate.el, h('div', { class: 'screen-actions' }, connect, save, full)),
    h('div', { class: 'screen-lower' },
      h('section', { class: 'section screen-steer-card' },
        h('div', { class: 'section-head' }, h('h2', { text: 'Steer' })),
        pad,
        matchMedia('(pointer: fine)').matches ? h('p', { class: 'screen-hint muted', text: 'Arrow keys, Enter and Backspace steer the TV too.' }) : null),
      h('section', { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', { text: 'Eyes' })),
        h('div', { class: 'readouts screen-readouts' }, seen.el, trip.el, onTv.el, eyes.el))),
  );

  const visible = () => ctx.viewName === 'screen' && !document.hidden;

  // ---- cadence ----
  function watch() {
    if (ctx.viewName !== 'screen') return;
    ctx.cmd('screen.watch', { everyMs: every }, { silent: true });
  }
  ctx.on('view', (name) => { if (name === 'screen') { watch(); paintAll(); } });
  ctx.on('hello', () => watch());

  // ---- frames ----
  function load(at) {
    if (!at || at <= shownAt || at === loadingAt || !visible()) return;
    loadingAt = at;
    const next = layers[1 - front];
    const img = new Image();
    img.decoding = 'async';
    img.src = `/api/screen.png?at=${at}`;
    img.decode().then(() => {
      if (at <= shownAt) return;
      next.src = img.src;
      next.classList.add('is-front');
      layers[front].classList.remove('is-front');
      front = 1 - front;
      shownAt = at;
      save.href = img.src;
      save.download = `tv-screen-${clock(at).replace(':', '')}.png`;
      paintAll();
    }).catch(() => {}).finally(() => { if (loadingAt === at) loadingAt = 0; });
  }
  ctx.state.watch('screen.at', () => load(ctx.state.value('screen.at', 0)));
  document.addEventListener('visibilitychange', () => { if (visible()) load(ctx.state.value('screen.at', 0)); });

  // ---- status ----
  function paintStatus() {
    const tv = ctx.state.value('conn.tv', 'unknown');
    const off = tv === 'standby' || tv === 'off';
    const error = ctx.state.value('screen.error', null);
    const link = ctx.state.value('conn.eyes', 'offline');
    const fresh = shownAt && Date.now() - shownAt < STALE_MS;
    let text;
    let tone = 'off';
    if (off) text = 'The TV is resting';
    else if (error) { text = error.code === 'UNAVAILABLE' ? 'Can’t see the TV' : 'Capture failed'; tone = 'bad'; }
    else if (every === 0) text = shownAt ? `Paused · ${ago(shownAt)}` : 'Paused';
    else if (link === 'connecting' || (!shownAt && link !== 'online')) { text = 'Opening Lumen Eyes…'; tone = 'wait'; }
    else if (fresh) { text = every === 1000 ? 'Live' : `Every 5 s · ${ago(shownAt)}`; tone = 'on'; }
    else text = shownAt ? `Last seen ${ago(shownAt)}` : 'Waiting for the first look';
    fill(status, h('span', { class: `dot ${tone === 'on' ? 'on' : ''}` }), text);
    status.dataset.tone = tone;
    status.title = error?.message ?? '';

    const needsAgent = !!error && /TV agent/i.test(error.message ?? '');
    connect.hidden = !needsAgent;
    frame.classList.toggle('is-off', off);
    frame.classList.toggle('has-frame', !!shownAt);
    save.classList.toggle('is-disabled', !shownAt);
    save.setAttribute('aria-disabled', shownAt ? 'false' : 'true');
    frame.classList.toggle('is-stale', !!shownAt && !fresh && every !== 0);
    empty.hidden = !!shownAt && !off;
    empty.querySelector('.screen-empty-text').textContent = off ? 'The TV is resting'
      : error ? error.message
        : every === 0 ? 'Paused. Choose Live to look at the TV.'
          : 'Opening Lumen Eyes on the TV…';
  }

  function paintMeta() {
    const fg = ctx.state.value('app.foreground', null);
    const app = fg ? ctx.app(fg.id) : null;
    const name = app?.name || fg?.name || null;
    appPill.hidden = !name || !shownAt;
    appPill.textContent = name || '';
    const meta = ctx.state.value('screen.meta', null);
    metaPill.hidden = !meta || !shownAt;
    if (meta) metaPill.textContent = `${meta.width}×${meta.height}`;
    seen.value.textContent = shownAt ? ago(shownAt) : '—';
    trip.value.textContent = Number.isFinite(meta?.ms) ? `${meta.ms} ms` : '—';
    onTv.value.textContent = Number.isFinite(meta?.captureMs) ? `${meta.captureMs} ms` : '—';
    const link = ctx.state.value('conn.eyes', 'offline');
    eyes.value.textContent = { online: 'Connected', connecting: 'Starting…', offline: 'Asleep' }[link] ?? '—';
  }

  function paintAll() {
    paintStatus();
    paintMeta();
  }
  ctx.state.watch(['screen.error', 'screen.meta', 'conn.eyes', 'conn.tv', 'app.foreground'], paintAll);
  setInterval(() => { if (visible()) paintAll(); }, 1000);

  // ---- full screen ----
  // iPhone Safari has no element full screen, so there the frame fills the window instead (tap it or
  // press Escape to leave).
  function fullscreen() {
    if (frame.classList.contains('is-immersive')) { immersive(false); return; }
    if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
    if (document.fullscreenEnabled && frame.requestFullscreen) frame.requestFullscreen().catch(() => immersive(true));
    else immersive(true);
  }
  function immersive(on) {
    frame.classList.toggle('is-immersive', on);
  }
  frame.addEventListener('click', () => { if (frame.classList.contains('is-immersive')) immersive(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && frame.classList.contains('is-immersive')) immersive(false); });
  ctx.on('view', (name) => { if (name !== 'screen') immersive(false); });

  paintAll();
}
