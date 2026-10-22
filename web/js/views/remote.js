// The instrument: now-playing strip, halo d-pad (live volume ring), nav row,
// volume / channel rockers with the centre cluster, and quick input chips.

import { h, icon, svg, reducedMotion, flash, fill } from '../ui/dom.js';
import { bindKey, bindPress } from '../ui/press.js';
import { badge } from '../ui/badge.js';
import { appTile } from '../ui/apptile.js';
import { clamp, prettySource } from '../ui/format.js';
import { openVolumeSheet } from './volume-sheet.js';
import { openTextSheet } from './text.js';

const ARC_START = 225;
const ARC_SWEEP = 270;
const R = 94;

function polar(deg, r) {
  const a = (deg * Math.PI) / 180;
  return [100 + r * Math.sin(a), 100 - r * Math.cos(a)];
}

export function mountRemote(root, ctx) {
  const body = h('div', { class: 'instrument-body' });
  body.append(nowStrip(ctx), haloPad(ctx), navRow(ctx), rockers(ctx), quickInputs(ctx));
  root.append(body);
}

/* ---------- Now strip ---------- */

export function describeNow(ctx) {
  const { state } = ctx;
  const tv = state.value('conn.tv', 'unknown');
  const fg = state.value('app.foreground', null);
  const source = state.value('input.source', null);
  const labels = state.value('input.labels', {}) || {};
  const channel = state.value('channel.current', null);
  const app = fg ? { ...(ctx.app(fg.id) || {}), ...fg, color: ctx.app(fg.id)?.color, icon: ctx.app(fg.id)?.icon, short: ctx.app(fg.id)?.short } : null;
  const inputLabel = source ? labels[source] || prettySource(source) : null;
  if (tv === 'standby' || tv === 'off') {
    return { app: null, iconName: 'power', title: tv === 'off' ? 'TV is off' : 'TV in standby', parts: ['Tap power to wake'], key: 'conn.tv' };
  }
  if (app) {
    const parts = [];
    if (channel && source === 'TV' && /tv ?plus|live/i.test(app.name || '')) parts.push(channel.name);
    if (inputLabel) parts.push(inputLabel);
    return { app, title: app.name || app.id, parts, key: 'app.foreground' };
  }
  if (source === 'TV' && channel) {
    return {
      app: { name: channel.name, short: String(channel.number ?? 'TV').slice(0, 4), color: null },
      title: channel.name || 'Live TV',
      parts: [channel.number ? `Ch ${channel.number}` : null, channel.type === 'TVPLUS' ? 'Samsung TV Plus' : 'Live TV'].filter(Boolean),
      key: 'channel.current',
    };
  }
  if (inputLabel) return { app: null, iconName: source === 'TV' ? 'tv' : 'hdmi', title: inputLabel, parts: [source !== inputLabel ? prettySource(source) : 'Input'], key: 'input.source' };
  return { app: null, iconName: tv === 'on' ? 'home' : 'wave', title: tv === 'on' ? 'Home screen' : 'Connecting…', parts: [], key: 'app.foreground' };
}

function nowStrip(ctx) {
  const tileHost = h('span');
  const title = h('div', { class: 'now-app' });
  const sub = h('div', { class: 'now-sub' });
  const badgeHost = h('span');
  const el = h('button', { class: 'now-strip', type: 'button', 'aria-label': 'Now playing — open Apps & Inputs', onClick: () => ctx.navigate('apps') },
    tileHost, h('div', { class: 'now-text' }, title, sub), badgeHost);
  let lastKey = null;
  let shown = '';
  ctx.state.watch(['app.*', 'channel.current', 'input.*', 'conn.tv'], () => {
    const now = describeNow(ctx);
    const signature = JSON.stringify(now);
    if (signature === shown) return;
    shown = signature;
    fill(tileHost, appTile(now.app, { size: 40, iconName: now.iconName }));
    title.textContent = now.title;
    fill(sub, ...now.parts.flatMap((p, i) => (i ? [h('span', { class: 'sep', text: '·' }), h('span', { text: p })] : [h('span', { text: p })])));
    if (lastKey !== now.key) {
      lastKey = now.key;
      fill(badgeHost, badge(now.key, { compact: true }));
    }
  });
  return el;
}

/* ---------- Halo + d-pad ---------- */

function haloPad(ctx) {
  const gauge = svg('svg', { class: 'halo-gauge', viewBox: '0 0 200 200', 'aria-hidden': 'true' });
  const [sx, sy] = polar(ARC_START, R);
  const [ex, ey] = polar(ARC_START + ARC_SWEEP, R);
  const arc = `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${R} ${R} 0 1 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
  const ticks = [];
  for (let v = 0; v <= 100; v += 5) {
    const deg = ARC_START + (ARC_SWEEP * v) / 100;
    const major = v % 25 === 0;
    const [x1, y1] = polar(deg, major ? 84.5 : 86.5);
    const [x2, y2] = polar(deg, 89);
    const t = svg('line', { x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2), class: major ? 'tick major' : 'tick' });
    ticks.push([v, t]);
    gauge.append(t);
  }
  const track = svg('path', { d: arc, class: 'arc-track' });
  const level = svg('path', { d: arc, class: 'arc-level', pathLength: 100, 'stroke-dasharray': '100 200', 'stroke-dashoffset': 100 });
  const cap = svg('circle', { r: 3.4, cx: sx, cy: sy, class: 'arc-cap' });
  gauge.append(track, level, cap);

  const readNum = h('span', { class: 'num', text: '—' });
  const readLabel = h('span', { class: 'silk', text: 'Vol' });
  const readout = h('div', { class: 'halo-readout' }, readLabel, readNum);
  const whisperEl = h('div', { class: 'halo-whisper', 'aria-hidden': 'true', text: 'Changed on TV' });

  const seg = (dir, key, label) => {
    const b = h('button', { class: `dpad-seg ${dir}`, type: 'button', 'aria-label': label }, icon(dir));
    bindKey(b, ctx, key);
    return b;
  };
  const ok = h('button', { class: 'dpad-ok', type: 'button', 'aria-label': 'OK, select' }, h('span', { class: 'silk', text: 'OK' }));
  bindKey(ok, ctx, 'KEY_ENTER');
  const dpad = h('div', { class: 'dpad', role: 'group', 'aria-label': 'Navigation' },
    seg('up', 'KEY_UP', 'Up'), seg('right', 'KEY_RIGHT', 'Right'), seg('down', 'KEY_DOWN', 'Down'), seg('left', 'KEY_LEFT', 'Left'), ok);

  const el = h('div', { class: 'halo is-unknown' }, gauge, dpad, readout, whisperEl);

  if (matchMedia('(pointer: fine)').matches) {
    el.addEventListener('pointermove', (e) => {
      if (reducedMotion()) return;
      const r = dpad.getBoundingClientRect();
      dpad.style.setProperty('--mx', `${(((e.clientX - r.left) / r.width) * 100).toFixed(1)}%`);
      dpad.style.setProperty('--my', `${(((e.clientY - r.top) / r.height) * 100).toFixed(1)}%`);
    });
    el.addEventListener('pointerleave', () => { dpad.style.setProperty('--mx', '50%'); dpad.style.setProperty('--my', '28%'); });
  }

  // Critically damped-ish spring toward the TV's level.
  const anim = { pos: null, vel: 0, goal: null, raf: 0, last: 0 };
  function paint() {
    const p = clamp(anim.pos ?? 0, 0, 100);
    level.setAttribute('stroke-dashoffset', (100 - p).toFixed(2));
    const [cx, cy] = polar(ARC_START + (ARC_SWEEP * p) / 100, R);
    cap.setAttribute('cx', cx.toFixed(2));
    cap.setAttribute('cy', cy.toFixed(2));
    for (const [v, t] of ticks) t.classList.toggle('lit', v <= p + 0.01 && p > 0);
  }
  function frame(now) {
    const dt = Math.min(0.032, (now - anim.last) / 1000);
    anim.last = now;
    const force = -300 * (anim.pos - anim.goal) - 30 * anim.vel;
    anim.vel += force * dt;
    anim.pos += anim.vel * dt;
    if (Math.abs(anim.pos - anim.goal) < 0.02 && Math.abs(anim.vel) < 0.05) {
      anim.pos = anim.goal;
      anim.vel = 0;
      anim.raf = 0;
      paint();
      return;
    }
    paint();
    anim.raf = requestAnimationFrame(frame);
  }
  function springTo(v) {
    if (anim.pos === null || reducedMotion()) {
      anim.pos = v;
      anim.goal = v;
      paint();
      return;
    }
    if (anim.goal === v) return;
    anim.goal = v;
    flash(el, 'is-changing', 900);
    if (!anim.raf) {
      anim.last = performance.now();
      anim.raf = requestAnimationFrame(frame);
    }
  }

  ctx.volume.subscribe((s) => {
    const known = s.value !== null;
    el.classList.toggle('is-unknown', !known);
    el.classList.toggle('is-muted', s.muted);
    el.classList.toggle('is-pending', s.pending);
    if (known) springTo(s.value);
    readLabel.textContent = s.muted ? 'Muted' : 'Vol';
    readNum.textContent = known ? String(s.value) : '—';
  });

  let whisperTimer = null;
  ctx.on('changedOnTv', (msg) => {
    if (msg.key !== 'audio.volume' && msg.key !== 'audio.mute') return;
    whisperEl.classList.add('is-on');
    flash(el, 'is-changing', 1200);
    clearTimeout(whisperTimer);
    whisperTimer = setTimeout(() => whisperEl.classList.remove('is-on'), 1600);
  });

  return el;
}

/* ---------- Nav row ---------- */

function navRow(ctx) {
  const k = (key, iconName, label) => {
    const b = h('button', { class: 'key', type: 'button', 'aria-label': label }, icon(iconName), h('span', { class: 'silk', text: label }));
    bindKey(b, ctx, key);
    return b;
  };
  return h('div', { class: 'nav-row' }, k('KEY_RETURN', 'back', 'Back'), k('KEY_HOME', 'home', 'Home'), k('KEY_MENU', 'tvmenu', 'TV Menu'));
}

/* ---------- Rockers + cluster ---------- */

// Press-and-hold that repeats an async action, waiting for each read-back so it never overshoots.
function bindRepeat(el, action) {
  let held = false;
  let timer = null;
  bindPress(el, {
    down() {
      held = true;
      action();
      timer = setTimeout(async function loop() {
        while (held) {
          await action();
          await new Promise((r) => setTimeout(r, 140));
        }
      }, 450);
    },
    up() {
      held = false;
      clearTimeout(timer);
    },
  });
}

function rockers(ctx) {
  return h('div', { class: 'rockers' }, volumeRocker(ctx), cluster(ctx), channelRocker(ctx));
}

function volumeRocker(ctx) {
  const up = h('button', { class: 'rocker-btn', type: 'button', 'aria-label': 'Volume up' }, icon('plus'));
  const down = h('button', { class: 'rocker-btn', type: 'button', 'aria-label': 'Volume down' }, icon('minus'));
  const val = h('span', { class: 'rocker-val num', text: '—' });
  const leds = h('span', { class: 'leds', 'aria-hidden': 'true' }, Array.from({ length: 10 }, () => h('i')));
  const mid = h('button', { class: 'rocker-mid', type: 'button', role: 'slider', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Volume — open the precise control' },
    h('span', { class: 'silk', text: 'Vol' }), val, leds);
  const el = h('div', { class: 'rocker vol', role: 'group', 'aria-label': 'Volume' }, up, mid, down);

  bindRepeat(up, () => ctx.volume.step(1, { el }));
  bindRepeat(down, () => ctx.volume.step(-1, { el }));
  mid.addEventListener('click', () => openVolumeSheet(ctx));
  mid.addEventListener('keydown', (e) => {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    ctx.volume.step(d, { el });
  });

  ctx.volume.subscribe((s) => {
    const known = s.value !== null;
    val.textContent = known ? String(s.value) : '—';
    el.classList.toggle('is-pending', s.pending);
    el.classList.toggle('is-muted', s.muted);
    const lit = known ? Math.ceil(s.value / 10) : 0;
    [...leds.children].forEach((led, i) => led.classList.toggle('on', i < lit));
    mid.setAttribute('aria-valuenow', known ? s.value : 0);
    mid.setAttribute('aria-valuetext', known ? `Volume ${s.value}${s.muted ? ', muted' : ''}` : 'Volume unknown');
  });
  ctx.on('changedOnTv', (msg) => { if (msg.key === 'audio.volume') flash(el, 'is-echo', 500); });
  return el;
}

function channelRocker(ctx) {
  const up = h('button', { class: 'rocker-btn', type: 'button', 'aria-label': 'Channel up' }, icon('plus'));
  const down = h('button', { class: 'rocker-btn', type: 'button', 'aria-label': 'Channel down' }, icon('minus'));
  const val = h('span', { class: 'rocker-val num' });
  const sub = h('span', { class: 'rocker-sub' });
  const mid = h('button', { class: 'rocker-mid', type: 'button', 'aria-label': 'Channel list' }, h('span', { class: 'silk', text: 'Ch' }), val, sub);
  const el = h('div', { class: 'rocker ch', role: 'group', 'aria-label': 'Channel' }, up, mid, down);
  bindKey(up, ctx, 'KEY_CHUP');
  bindKey(down, ctx, 'KEY_CHDOWN');
  bindKey(mid, ctx, 'KEY_CH_LIST', { policy: 'none' });
  ctx.state.watch(['channel.current', 'input.source'], () => {
    const ch = ctx.state.value('channel.current', null);
    const onTuner = ctx.state.value('input.source', 'TV') === 'TV';
    const number = ch && onTuner && ch.number != null ? String(ch.number) : null;
    if (number) fill(val, number);
    else fill(val, icon('list'));
    val.style.fontSize = number && number.length > 4 ? '20px' : '';
    sub.textContent = number ? ch.name || '' : 'List';
  });
  return el;
}

function cluster(ctx) {
  const cell = (btn, label) => h('div', { class: 'cluster-cell' }, btn, h('span', { class: 'silk', 'aria-hidden': 'true', text: label }));
  const round = (iconName, label) => h('button', { class: 'key round', type: 'button', 'aria-label': label, title: label }, icon(iconName));

  const mute = round('mute', 'Mute');
  mute.addEventListener('click', () => ctx.volume.toggleMute({ el: mute }));
  ctx.volume.subscribe((s) => {
    mute.classList.toggle('is-on', s.muted);
    mute.setAttribute('aria-pressed', s.muted ? 'true' : 'false');
  });

  const source = round('source', 'Source');
  bindKey(source, ctx, 'KEY_SOURCE');

  const kb = round('keyboard', 'Keyboard');
  kb.addEventListener('click', () => openTextSheet(ctx));

  const play = round('playpause', 'Play / Pause');
  const playKey = () => (ctx.hasKey('KEY_PLAY_BACK') ? 'KEY_PLAY_BACK' : 'KEY_PLAY');
  bindPress(play, { down: () => ctx.key(playKey()), up() {} });

  const keys = round('numpad', 'Number pad and colour keys');
  keys.addEventListener('click', () => ctx.navigate('keys'));

  const touch = round('touch', 'Touchpad');
  touch.addEventListener('click', () => ctx.navigate('touch'));

  return h('div', { class: 'cluster' },
    cell(mute, 'Mute'), cell(source, 'Source'), cell(kb, 'Text'),
    cell(play, 'Play'), cell(keys, '123'), cell(touch, 'Touch'));
}

/* ---------- Quick inputs ---------- */

export function inputList(ctx) {
  const available = ctx.state.value('input.available', null);
  const connected = ctx.state.value('input.connected', null);
  const base = Array.isArray(available) && available.length ? available : Array.isArray(connected) && connected.length ? connected : ['TV', 'HDMI1', 'HDMI2', 'HDMI3', 'HDMI4'];
  const conn = new Set(Array.isArray(connected) ? connected : []);
  const norm = (s) => (s === 'TV1' ? 'TV' : s);
  const seen = new Set();
  return base.map(norm).filter((s) => !seen.has(s) && seen.add(s)).map((source) => ({
    source,
    connected: conn.size ? conn.has(source) || (source === 'TV' && conn.has('TV1')) : null,
  }));
}

function quickInputs(ctx) {
  const chips = h('div', { class: 'chips scroll', role: 'group', 'aria-label': 'Inputs' });
  const el = h('div', { class: 'quick-inputs' }, chips);
  let shown = '';
  ctx.state.watch(['input.*'], () => {
    const current = ctx.state.value('input.source', null);
    const labels = ctx.state.value('input.labels', {}) || {};
    const list = inputList(ctx).filter((i) => i.connected !== false || i.source === current);
    // input.source is re-polled every few seconds; rebuild the chips only when they would change.
    const signature = JSON.stringify([current, labels, list]);
    if (signature === shown) return;
    shown = signature;
    fill(chips, ...list.slice(0, 6).map(({ source, connected }) => {
      const chip = h('button', {
        class: 'chip',
        type: 'button',
        'aria-pressed': source === current ? 'true' : 'false',
        onClick: async () => {
          if (source === ctx.state.value('input.source')) return;
          ctx.state.setOverlay('input.source', source);
          chip.classList.add('is-pending');
          await ctx.cmd('input.set', { source }, { el: chip });
          ctx.state.clearOverlay('input.source');
        },
      }, h('i', { class: `dot${connected ? ' on' : ''}` }), labels[source] || prettySource(source));
      return chip;
    }));
  });
  return el;
}
