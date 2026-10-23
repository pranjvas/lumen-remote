// Lumen web UI entry: live link, state, routing, presence, chrome and views.

import { $, h } from './ui/dom.js';
import { createLive } from './core/live.js';
import { createState } from './core/state.js';
import { createContext } from './core/ctx.js';
import { createVolume } from './core/volume.js';
import { createPower } from './core/power.js';
import { initBadges } from './ui/badge.js';
import { initToasts, toast, whisper, announce } from './ui/toast.js';
import { setTint } from './ui/tint.js';
import { VIEWS, mountBanners, mountNav, powerButton, connectionChain, themeToggle, applyTheme } from './views/chrome.js';
import { mountRemote } from './views/remote.js';
import { mountNow } from './views/now.js';
import { mountApps } from './views/apps.js';
import { mountSettings } from './views/settings.js';
import { mountKeys } from './views/keys.js';
import { mountTouch } from './views/touch.js';
import { mountMouse } from './views/mouse.js';
import { mountCast } from './views/cast.js';
import { mountBrowser } from './views/browser.js';
import { mountScenes } from './views/scenes.js';
import { mountScreen } from './views/screen.js';
import { createAsk } from './views/ask.js';
import { watchIme } from './views/text.js';
import { mountShortcuts, openHelp } from './views/shortcuts.js';

const DESKTOP = matchMedia('(min-width: 980px)');

const state = createState();
const live = createLive();
const ctx = createContext({ live, state });
ctx.volume = createVolume(ctx);
ctx.power = createPower(ctx);
ctx.viewName = 'remote';

applyTheme(localStorage.getItem('lumen.theme'));
initToasts($('#toasts'), $('#live-region'));
initBadges(state, (key) => ctx.isLocked(key), (key) => ctx.setting(key)?.type === 'tracked');

/* ---------- chrome ---------- */

const app = $('.app');
$('#power-slot').replaceWith(powerButton(ctx));
$('#chain-slot').replaceWith(connectionChain(ctx));
$('#theme-slot').replaceWith(themeToggle());
$('#help-btn').addEventListener('click', openHelp);
mountBanners($('#banners'), ctx);
const nav = mountNav($('#nav'), ctx);

const ask = createAsk(ctx);
const bar = ask.composer();
bar.form.id = 'askbar';
$('#askbar-slot').replaceWith(bar.form);

state.watch('device.name', () => {
  const name = state.value('device.name', null) || state.value('device.modelName', null);
  $('#tv-name').textContent = name ? String(name).replace(/^\[TV\]\s*/, '') : 'Samsung Q95T';
});

/* ---------- views ---------- */

mountRemote($('#instrument'), ctx);
const panels = {
  now: mountInto('now', mountNow),
  screen: mountInto('screen', mountScreen),
  apps: mountInto('apps', mountApps),
  settings: mountInto('settings', mountSettings),
  keys: mountInto('keys', mountKeys),
  touch: mountInto('touch', mountTouch),
  mouse: mountInto('mouse', mountMouse),
  cast: mountInto('cast', mountCast),
  browser: mountInto('browser', mountBrowser),
  scenes: mountInto('scenes', mountScenes),
  ask: mountInto('ask', (root) => ask.mountView(root)),
};

function mountInto(id, mount) {
  const el = h('section', { class: 'view', id: `view-${id}`, hidden: true, 'aria-label': VIEWS.find((v) => v.id === id)?.title || VIEWS.find((v) => v.id === id)?.label || 'Now' });
  $('#panel').append(el);
  mount(el, ctx);
  return el;
}

/* ---------- routing + presence ---------- */

let reported = null;

// The hub keeps one view per client; visible:false means the tab is hidden. The desktop Remote
// also shows the "Now" dashboard, reported as 'now' so the server reads its picture values.
function presence() {
  const name = ctx.viewName === 'remote' && DESKTOP.matches ? 'now' : ctx.viewName;
  const next = { name, visible: !document.hidden };
  if (reported && reported.name === next.name && reported.visible === next.visible) return;
  if (live.post('view', next)) reported = next;
}

function show(view) {
  const known = VIEWS.some((v) => v.id === view);
  const name = known ? view : 'remote';
  const panel = name === 'remote' ? (DESKTOP.matches ? 'now' : null) : name;
  ctx.viewName = name;
  app.dataset.view = name;
  for (const [id, el] of Object.entries(panels)) el.hidden = id !== panel;
  nav.setCurrent(name);
  const meta = VIEWS.find((v) => v.id === name);
  document.title = name === 'remote' ? 'Lumen' : `${meta?.title || meta?.label} · Lumen`;
  presence();
  ctx.emit('view', name);
}

function route() {
  show(location.hash.replace(/^#\/?/, '') || 'remote');
}

ctx.on('navigate', (view) => {
  if (location.hash === `#/${view}`) route();
  else location.hash = `#/${view}`;
});
window.addEventListener('hashchange', route);
DESKTOP.addEventListener('change', route);
document.addEventListener('visibilitychange', presence);

/* ---------- live link ---------- */

live.on('hello', (msg) => {
  ctx.setHello(msg);
  state.load(msg.state);
  ctx.emit('hello', msg);
  ctx.emit('ai-status');
  reported = null;
  presence();
  document.documentElement.dataset.ready = '1';
});
live.on('patch', (msg) => state.apply(msg.patch));
live.on('toast', (msg) => toast(msg.text, { level: msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'info' }));
live.on('changedOnTv', (msg) => {
  ctx.emit('changedOnTv', msg);
  whisper(changeText(msg));
});
live.on('status', (s) => {
  if (s !== 'open') reported = null;
  if (s === 'closed') announce('Connection to Lumen lost');
});

function changeText({ key, from, to }) {
  if (key === 'audio.mute') return to ? 'Muted on the TV' : 'Unmuted on the TV';
  const label = key === 'audio.volume' ? 'Volume' : key === 'input.source' ? 'Input' : ctx.setting(key)?.label || key;
  const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'object' ? '…' : String(v));
  return `${label} ${fmt(from)} → ${fmt(to)} · changed on the TV`;
}

/* ---------- ambient tint follows the foreground app ---------- */

state.watch(['app.foreground', 'app.installed'], () => {
  const fg = state.value('app.foreground', null);
  setTint(fg ? ctx.app(fg.id)?.color || null : null);
});

/* ---------- keyboard, IME, service worker ---------- */

mountShortcuts(ctx, { focusAsk: () => { bar.input.focus(); bar.input.select(); } });
watchIme(ctx);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then((reg) => {
      const paths = performance.getEntriesByType('resource')
        .map((e) => new URL(e.name))
        .filter((u) => u.origin === location.origin)
        .map((u) => u.pathname);
      reg.active?.postMessage({ t: 'shell', paths });
    })
    .catch((err) => console.warn('Service worker not registered', err));
}

route();
live.connect();
