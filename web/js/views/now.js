// Desktop "Now" console beside the instrument: a mini-TV now-playing card, the live readouts
// that matter (each with provenance), power, sleep and one-tap scenes.

import { h, icon, fill } from '../ui/dom.js';
import { appTile } from '../ui/apptile.js';
import { badge } from '../ui/badge.js';
import { toast } from '../ui/toast.js';
import { countdown, prettySource } from '../ui/format.js';
import { describeNow } from './remote.js';
import { powerButton } from './chrome.js';

const READOUTS = [
  { key: 'audio.volume', label: 'Volume', meter: [0, 100] },
  { key: 'picture.backlight', label: 'Brightness', meter: [0, 50] },
  { key: 'picture.contrast', label: 'Contrast', meter: [0, 50] },
  { key: 'picture.mode', label: 'Picture mode' },
  { key: 'audio.soundMode', label: 'Sound mode' },
  { key: 'input.source', label: 'Input', format: (v, ctx) => (ctx.state.value('input.labels', {}) || {})[v] || prettySource(v) },
];

export function mountNow(root, ctx) {
  const hero = h('div', { class: 'now-card card' });
  const tiles = h('div', { class: 'readouts' });
  const quick = h('div', { class: 'now-quick' });

  root.append(
    h('header', { class: 'view-head' }, h('div', null, h('h1', { class: 'view-title', text: 'Now' }), h('p', { class: 'view-sub now-clock' }))),
    hero,
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'At a glance' }), h('div', { class: 'aside' },
      h('button', { class: 'btn sm ghost', type: 'button', onClick: () => ctx.navigate('settings') }, 'All settings', icon('right', 'xs')))), tiles),
    quick,
  );

  const clockEl = root.querySelector('.now-clock');
  const tickClock = () => {
    clockEl.textContent = new Date().toLocaleString(undefined, { weekday: 'long', hour: '2-digit', minute: '2-digit' });
  };
  tickClock();
  setInterval(tickClock, 15000);

  // ---- hero ----
  const power = powerButton(ctx, { label: true });
  power.classList.add('power-lg');
  let shown = '';
  // Polls re-publish these keys every few seconds; rebuilding (and re-attaching the power button)
  // only on a visible change keeps a hold-to-turn-off from being interrupted.
  function renderHero() {
    const now = describeNow(ctx);
    const tv = ctx.state.value('conn.tv', 'unknown');
    const off = tv === 'standby' || tv === 'off';
    const signature = JSON.stringify([now, off]);
    if (signature === shown) return;
    shown = signature;
    hero.classList.toggle('is-off', off);
    fill(hero, 
      h('div', { class: 'tv-frame big', 'aria-hidden': 'true' },
        h('div', { class: 'tv-screen' }, off ? h('i', { class: 'tv-line' }) : appTile(now.app, { size: 76, iconName: now.iconName })),
        h('div', { class: 'tv-stand' })),
      h('div', { class: 'now-card-text' },
        h('span', { class: 'silk', text: off ? 'The TV is resting' : 'On screen now' }),
        h('div', { class: 'now-hero-title', text: now.title }),
        h('div', { class: 'now-sub' }, now.parts.join(' · ')),
        h('div', { class: 'now-hero-meta' }, badge(now.key, { compact: true }))),
      h('div', { class: 'now-card-power' }, power));
  }
  ctx.state.watch(['app.*', 'channel.current', 'input.*', 'conn.tv'], renderHero);

  // ---- readouts ----
  for (const r of READOUTS) {
    const value = h('span', { class: 'readout-value num', text: '—' });
    const fill = h('i');
    const tile = h('button', { class: 'readout', type: 'button', onClick: () => ctx.navigate('settings') },
      h('span', { class: 'silk', text: r.label }), value,
      r.meter ? h('span', { class: 'meter' }, fill) : h('span', { class: 'readout-spacer' }),
      badge(r.key, { compact: true }));
    tiles.append(tile);
    const paint = () => {
      const v = r.key === 'audio.volume' ? ctx.volume.shown() : ctx.state.value(r.key, null);
      value.textContent = v === null || v === undefined ? '—' : r.format ? r.format(v, ctx) : String(v);
      if (r.meter && Number.isFinite(v)) fill.style.setProperty('--pct', `${((v - r.meter[0]) / (r.meter[1] - r.meter[0])) * 100}%`);
      tile.classList.toggle('is-muted', r.key === 'audio.volume' && !!ctx.state.value('audio.mute', false));
    };
    if (r.key === 'audio.volume') ctx.volume.subscribe(paint);
    else ctx.state.watch([r.key, 'input.labels'], paint);
  }

  // ---- sleep + scenes ----
  const sleepChips = h('div', { class: 'chips' });
  const sleepNote = h('span', { class: 'muted' });
  const sceneChips = h('div', { class: 'chips' });
  quick.append(
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'Scenes' })), sceneChips),
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'Sleep' }), h('div', { class: 'aside' }, sleepNote)), sleepChips),
  );

  let sleepTimer = null;
  ctx.state.watch('sleep', () => {
    const sleep = ctx.state.value('sleep', null);
    const active = sleep?.endsAt > Date.now();
    clearInterval(sleepTimer);
    fill(sleepChips, ...[15, 30, 60, 90].map((m) => {
      const chip = h('button', { class: 'chip', type: 'button', 'aria-pressed': active && sleep.minutes === m ? 'true' : 'false' }, icon('sleep', 'xs'), `${m} min`);
      chip.addEventListener('click', async () => {
        const ack = await ctx.cmd('sleep.set', { minutes: active && sleep.minutes === m ? 0 : m }, { el: chip });
        if (ack.ok) toast(active && sleep.minutes === m ? 'Sleep timer cancelled' : `Off in ${m} minutes`, { level: 'ok', timeout: 2000 });
      });
      return chip;
    }));
    const tick = () => { sleepNote.textContent = active ? `Off in ${countdown(sleep.endsAt - Date.now())}` : ''; };
    tick();
    if (active) sleepTimer = setInterval(tick, 1000);
  });

  ctx.state.watch('scenes', () => {
    const scenes = ctx.state.value('scenes', []) || [];
    fill(sceneChips, ...(scenes.length ? scenes.map((s) => {
      const chip = h('button', { class: 'chip', type: 'button' }, icon('scenes', 'xs'), s.name);
      chip.addEventListener('click', async () => {
        chip.classList.add('is-pending');
        const ack = await ctx.cmd('scene.run', { target: s.id }, { el: chip, timeoutMs: 60000 });
        chip.classList.remove('is-pending');
        if (ack.ok) toast(`${s.name} applied`, { level: 'ok', timeout: 2000 });
      });
      return chip;
    }) : [h('span', { class: 'muted', text: 'No scenes yet' })]));
  });
}
