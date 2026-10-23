// App chrome: power button, connection chain, theme toggle, connection banners, navigation
// (bottom tab bar on phones, rail on desktop) and the phone "More" sheet.

import { h, icon, fill } from '../ui/dom.js';
import { openSheet } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';
import { hapticsEnabled, hapticsSupported, setHaptics } from '../ui/haptics.js';
import { reapplyTint, activeTheme } from '../ui/tint.js';
import { refreshBadges } from '../ui/badge.js';
import { pairButton, agentButton } from './settings.js';

export const VIEWS = [
  { id: 'remote', label: 'Remote', icon: 'remote', rank: 1 },
  { id: 'screen', label: 'Screen', icon: 'eye', rank: 1 },
  { id: 'apps', label: 'Apps', icon: 'apps', rank: 1 },
  { id: 'cast', label: 'Cast', icon: 'cast', rank: 1 },
  { id: 'browser', label: 'Browser', icon: 'globe', rank: 1 },
  { id: 'settings', label: 'Settings', icon: 'settings', rank: 1 },
  { id: 'keys', label: 'Keys', icon: 'numpad', rank: 2 },
  { id: 'mouse', label: 'Mouse', icon: 'mouse', rank: 1 },
  { id: 'touch', label: 'Touch', icon: 'touch', rank: 2, title: 'Touch & Text' },
  { id: 'scenes', label: 'Scenes', icon: 'scenes', rank: 2 },
  { id: 'ask', label: 'Ask', icon: 'spark', rank: 2, title: 'Ask Lumen' },
];

/* ---------- Power ---------- */

const HOLD_OFF_MS = 600;

export function powerButton(ctx, { label = false } = {}) {
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ring.setAttribute('class', 'ring');
  ring.setAttribute('viewBox', '0 0 50 50');
  ring.setAttribute('aria-hidden', 'true');
  ring.innerHTML = '<circle class="track" cx="25" cy="25" r="23"/><circle class="fill" cx="25" cy="25" r="23" pathLength="145"/>';
  const caption = label ? h('span', { class: 'power-label' }) : null;
  const btn = h('button', { class: 'power', type: 'button', 'aria-label': 'Power' }, ring, icon('power'), caption);
  let timer = null;
  let armed = false;

  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const state = ctx.power.current();
    if (state !== 'on') return;
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    btn.classList.add('is-arming');
    armed = true;
    timer = setTimeout(() => {
      armed = false;
      btn.classList.remove('is-arming');
      ctx.power.off();
    }, HOLD_OFF_MS);
  });
  const release = () => {
    if (!armed) return;
    armed = false;
    clearTimeout(timer);
    btn.classList.remove('is-arming');
    toast('Hold the power button to turn the TV off', { level: 'info', timeout: 2200 });
  };
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', () => { armed = false; clearTimeout(timer); btn.classList.remove('is-arming'); });
  let confirmUntil = 0;
  btn.addEventListener('click', (e) => {
    const state = ctx.power.current();
    if (state === 'standby' || state === 'off' || state === 'unknown') ctx.power.wake();
    else if (state === 'on' && e.detail === 0) {
      if (Date.now() < confirmUntil) ctx.power.off();
      else {
        confirmUntil = Date.now() + 2500;
        toast('Press again to turn the TV off', { level: 'info', timeout: 2400 });
      }
    }
  });

  ctx.power.subscribe((state) => {
    btn.dataset.state = state;
    const text = {
      on: 'On · hold to turn off',
      standby: 'Standby · tap to wake',
      off: 'Off · tap to wake',
      waking: `Waking… ${Math.round(ctx.power.wakingFor() / 1000)} s`,
      unknown: 'Power state unknown',
    }[state] || state;
    btn.setAttribute('aria-label', `Power — ${text}`);
    btn.title = text;
    if (caption) caption.textContent = { on: 'On', standby: 'Standby', off: 'Off', waking: 'Waking', unknown: '—' }[state] || '';
  });
  return btn;
}

/* ---------- Connection chain ---------- */

export function connectionChain(ctx) {
  const dot = (label) => h('span', { class: 'chain-dot', role: 'img', 'aria-label': label });
  const browser = dot('This browser');
  const pc = dot('Lumen on this PC');
  const tv = dot('TV');
  const seg1 = h('span', { class: 'chain-seg' });
  const seg2 = h('span', { class: 'chain-seg' });
  const latency = h('span', { class: 'chain-latency' });
  const el = h('span', { class: 'chain', title: 'Browser → PC → TV' }, browser, seg1, pc, seg2, tv, latency);

  function paint() {
    const link = ctx.live.status;
    const tvState = ctx.state.value('conn.tv', 'unknown');
    const remote = ctx.state.value('conn.remote', null);
    const linkOk = link === 'open';
    browser.className = 'chain-dot ok';
    seg1.className = `chain-seg ${linkOk ? 'ok' : link === 'connecting' ? 'warn' : 'bad'}`;
    pc.className = `chain-dot ${linkOk ? 'ok' : 'bad'}`;
    const tvGood = linkOk && tvState === 'on';
    const tvWarn = linkOk && (tvState === 'standby' || tvState === 'unknown' || remote === 'connecting' || remote === 'unpaired');
    seg2.className = `chain-seg ${tvGood && !tvWarn ? 'ok' : tvWarn || tvGood ? 'warn' : 'bad'}`;
    tv.className = `chain-dot ${tvGood && !tvWarn ? 'ok' : tvWarn || tvGood ? 'warn' : 'bad'}`;
    const ms = ctx.state.value('conn.latency.rest', ctx.state.value('conn.latency', null)?.rest ?? null);
    latency.textContent = linkOk && Number.isFinite(ms) ? `${ms} ms` : '';
    el.setAttribute('aria-label', `Connection: Lumen ${linkOk ? 'connected' : 'disconnected'}, TV ${tvState}`);
  }
  ctx.live.on('status', paint);
  ctx.state.watch(['conn.*'], paint);
  return el;
}

/* ---------- Theme ---------- */

export function applyTheme(choice) {
  if (choice) document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = activeTheme() === 'gallery' ? '#f3f0e9' : '#0e1013';
  reapplyTint();
}

export function themeToggle() {
  const btn = h('button', { class: 'icon-btn', type: 'button' });
  const paint = () => {
    const theme = activeTheme();
    fill(btn, icon(theme === 'gallery' ? 'moon' : 'sun', 'sm'));
    btn.setAttribute('aria-label', theme === 'gallery' ? 'Switch to Nocturne (dark)' : 'Switch to Gallery (light)');
    btn.title = btn.getAttribute('aria-label');
  };
  btn.addEventListener('click', () => {
    const next = activeTheme() === 'gallery' ? 'nocturne' : 'gallery';
    localStorage.setItem('lumen.theme', next);
    applyTheme(next);
    paint();
    refreshBadges();
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (!localStorage.getItem('lumen.theme')) { applyTheme(null); paint(); } });
  paint();
  return btn;
}

/* ---------- Banners ---------- */

const dismissed = new Set();
const AGENT_VIEWS = new Set(['apps', 'settings']);

export function mountBanners(host, ctx) {
  let countdownTimer = null;
  let shown = '';

  function banner(id, { level = 'warn', iconName = 'alert', title, text, actions = [], dismissible = false }) {
    const close = dismissible ? h('button', { class: 'icon-btn close', type: 'button', 'aria-label': 'Dismiss' }, icon('close', 'sm')) : null;
    close?.addEventListener('click', () => { dismissed.add(id); paint(); });
    return h('div', { class: `banner ${level}`, role: level === 'bad' ? 'alert' : 'status', dataset: { id } },
      icon(iconName), h('div', { class: 'banner-text' }, h('strong', { text: title }), text ? h('span', { text }) : null), ...actions, close);
  }

  // Repaints only when what the banners say changes: conn.* keys are re-published on every poll,
  // and rebuilding a button between pointer-down and click would swallow the click.
  function paint() {
    const link = ctx.live.status;
    const signature = [link, ...['conn.tv', 'conn.remote', 'conn.ipc', 'conn.agent'].map((k) => ctx.state.value(k, null)),
      AGENT_VIEWS.has(ctx.viewName), [...dismissed].join()].join('|');
    if (signature === shown) return;
    shown = signature;
    clearInterval(countdownTimer);
    const list = [];
    if (link !== 'open') {
      const retry = h('button', { class: 'btn sm', type: 'button', text: 'Retry now', onClick: () => ctx.live.retryNow() });
      const textEl = h('span');
      const tick = () => {
        const s = Math.max(0, Math.ceil((ctx.live.retryAt - Date.now()) / 1000));
        textEl.textContent = link === 'connecting' ? 'Connecting…' : `Retrying in ${s} s · is Lumen running on this PC?`;
      };
      const b = banner('host', { level: 'bad', iconName: 'unlink', title: 'Can’t reach Lumen on this PC', actions: [retry] });
      b.querySelector('.banner-text').append(textEl);
      tick();
      countdownTimer = setInterval(tick, 500);
      list.push(b);
    } else {
      const tv = ctx.state.value('conn.tv', 'unknown');
      const remote = ctx.state.value('conn.remote', null);
      const ipc = ctx.state.value('conn.ipc', null);
      const agent = ctx.state.value('conn.agent', null);
      if (tv === 'standby' || tv === 'off') {
        const wake = h('button', { class: 'btn sm primary', type: 'button' }, icon('power'), 'Wake TV');
        wake.addEventListener('click', () => ctx.power.wake());
        list.push(banner('tv', { iconName: 'power', title: tv === 'off' ? 'The TV is off or off the network' : 'The TV is in standby', text: 'Values below are the last known ones', actions: [wake] }));
      } else if (tv === 'on') {
        if (remote === 'unpaired') list.push(banner('remote', { title: 'Remote channel not paired', text: 'Keys need a one-time Allow on the TV', actions: [pairButton(ctx, 'pair.remote')] }));
        if (ipc === 'unpaired') list.push(banner('ipc', { title: 'IP Control not paired', text: 'Needed for exact picture and sound values', actions: [pairButton(ctx, 'pair.ipcontrol')] }));
        // The agent only adds detail (channel, inputs, icons), so its banner stays off the remote itself.
        if ((agent === 'offline' || agent === 'unknown') && !dismissed.has('agent') && AGENT_VIEWS.has(ctx.viewName)) {
          list.push(banner('agent', { level: 'info', iconName: 'agent', title: 'TV agent offline', text: 'Channel, inputs and app icons come from it', actions: [agentButton(ctx)], dismissible: true }));
        }
      }
    }
    fill(host, ...list.slice(0, 2));
    document.querySelector('.app')?.classList.toggle('is-offline', link !== 'open');
  }

  ctx.live.on('status', paint);
  ctx.on('view', paint);
  ctx.state.watch(['conn.tv', 'conn.remote', 'conn.ipc', 'conn.agent'], paint);
}

/* ---------- Navigation ---------- */

export function mountNav(host, ctx) {
  host.append(h('div', { class: 'nav-logo', 'aria-hidden': 'true' }, icon('halo', 'lg')));
  for (const v of VIEWS) {
    host.append(h('a', { class: 'nav-item', href: `#/${v.id}`, dataset: { view: v.id, rank: String(v.rank) }, 'aria-label': v.title || v.label }, icon(v.icon), h('span', { text: v.label })));
  }
  const more = h('button', { class: 'nav-item', type: 'button', dataset: { rank: 'more' }, 'aria-label': 'More views' }, icon('more'), h('span', { text: 'More' }));
  more.addEventListener('click', () => openMore(ctx));
  host.append(more);
  return {
    setCurrent(view) {
      for (const a of host.querySelectorAll('.nav-item[data-view]')) {
        if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      const secondary = VIEWS.find((v) => v.id === view)?.rank === 2;
      if (secondary) more.setAttribute('aria-current', 'page');
      else more.removeAttribute('aria-current');
    },
  };
}

function openMore(ctx) {
  openSheet({
    title: 'More',
    build(body, sheet) {
      const grid = h('div', { class: 'more-grid' }, VIEWS.filter((v) => v.rank === 2).map((v) =>
        h('a', { class: 'more-item', href: `#/${v.id}`, onClick: () => sheet.close() }, icon(v.icon, 'lg'), h('span', { text: v.title || v.label }))));
      const theme = themeToggle();
      theme.classList.add('more-theme');
      const rows = [h('div', { class: 'more-row' }, h('span', { text: 'Theme' }), theme)];
      if (hapticsSupported()) {
        const sw = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': hapticsEnabled() ? 'true' : 'false', 'aria-label': 'Vibration' });
        sw.addEventListener('click', () => { setHaptics(!hapticsEnabled()); sw.setAttribute('aria-checked', hapticsEnabled() ? 'true' : 'false'); });
        rows.push(h('div', { class: 'more-row' }, h('span', { text: 'Vibration on key press' }), sw));
      }
      body.append(grid, ...rows);
    },
  });
}
