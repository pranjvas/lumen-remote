// The video on the TV from Lumen's browser, controlled from the phone: ⏪ 10 s, play/pause, 10 s ⏩ and a
// seek bar (hub tvscreen.control). While the TV's own player has the video, tvscreen.playback
// ({ state, position, duration, at }, ms) says where it is; with live video (the page itself on the
// TV) the buttons act on the page's own video, whose clock the phone does not see: no seek bar then.
// Shown in the Browser view and on the Send to TV page.

import { h, icon, fill } from '../ui/dom.js';
import { createSlider } from '../ui/slider.js';
import { duration } from '../ui/format.js';

export const SKIP_S = 10;
// The TV's player is busy with something other than a video the phone can drive (Lumen converting it).
const NOT_DRIVABLE = new Set(['fallback', 'error']);

/**
 * What the controls drive: 'player' (the TV's player has the video), 'page' (live video: the page's
 * own video, when the page has one) or null (nothing to show).
 */
export function controlsMode({ on, playback, video, media }) {
  if (on !== true) return null;
  if (playback && typeof playback === 'object') return 'player';
  if (NOT_DRIVABLE.has(video) || video === 'loading') return null;
  return Number(media) > 0 ? 'page' : null;
}

/**
 * The player's position in seconds now: the last report's, run on by the time since this phone got
 * it (the phone's clock and the PC's may differ, so the report's own `at` is not used), within the
 * video's length.
 */
export function playbackNow(playback, receivedAt, now) {
  if (!playback || !Number.isFinite(playback.position)) return null;
  const ran = playback.state === 'playing' && Number.isFinite(receivedAt) ? Math.max(0, now - receivedAt) : 0;
  const seconds = (playback.position + ran) / 1000;
  const length = Number.isFinite(playback.duration) && playback.duration > 0 ? playback.duration / 1000 : Infinity;
  return Math.min(seconds, length);
}

export function mountTvPlayback(host, ctx, { className = '' } = {}) {
  const card = h('section', { class: `tv-playback${className ? ` ${className}` : ''}`, 'aria-label': 'Video on the TV', hidden: true });
  host.append(card);
  let shape = '';
  let seek = null;
  let posText = null;
  let receivedAt = 0;
  let ticker = null;

  const playback = () => {
    const v = ctx.state.value('tvscreen.playback', null);
    return v && typeof v === 'object' ? v : null;
  };
  const mode = () => controlsMode({
    on: ctx.state.value('tvscreen.on', false),
    playback: playback(),
    video: ctx.state.value('tvscreen.video', null),
    media: ctx.state.value('browser.media', 0),
  });

  function control(args, el) {
    return ctx.cmd('tvscreen.control', args, { el, timeoutMs: 8000 });
  }

  function button(iconName, label, args, cls = 'key round') {
    const b = h('button', { class: cls, type: 'button', 'aria-label': label, title: label }, icon(iconName));
    b.addEventListener('click', () => control(args, b));
    return b;
  }

  function tick() {
    const pb = playback();
    if (!pb || !posText) return;
    const now = playbackNow(pb, receivedAt, performance.now());
    if (now == null) return;
    if (!seek?.busy) posText.textContent = duration(now);
    seek?.set(Math.round(now));
  }

  function setTicker(on) {
    if (on && !ticker) ticker = setInterval(tick, 500);
    if (!on && ticker) { clearInterval(ticker); ticker = null; }
  }

  function build(m, pb) {
    const length = pb && Number.isFinite(pb.duration) && pb.duration > 0 ? Math.round(pb.duration / 1000) : 0;
    const playing = pb?.state === 'playing';
    posText = null;
    seek = null;
    if (m === 'player' && length > 0) {
      posText = h('span', { class: 'mono' });
      seek = createSlider({
        min: 0, max: length, step: 1, value: Math.round(playbackNow(pb, receivedAt, performance.now()) ?? 0),
        label: 'Position on the TV', format: (v) => duration(v), ticks: false,
        onInput: (v) => { posText.textContent = duration(v); },
        onCommit: (v) => control({ action: 'seek', position: v }),
      });
    }
    const toggle = m === 'player'
      ? button(playing ? 'pause' : 'play', playing ? 'Pause on the TV' : 'Play on the TV', { action: playing ? 'pause' : 'play' }, 'key round hero')
      : button('playpause', 'Play or pause on the TV', { action: 'toggle' }, 'key round hero');
    fill(card,
      h('div', { class: 'tv-playback-head' },
        h('span', { class: 'silk', text: m === 'player' ? 'On the TV’s player' : 'Video on the page, on the TV' }),
        m === 'player' && pb?.state === 'loading' ? h('span', { class: 'muted', text: 'Starting…' }) : null),
      seek ? h('div', { class: 'scrubber' }, posText, seek.el, h('span', { class: 'mono muted', text: duration(length) })) : null,
      h('div', { class: 'transport' },
        button('rew', `Back ${SKIP_S} s`, { action: 'skip', by: -SKIP_S }),
        toggle,
        button('ff', `Forward ${SKIP_S} s`, { action: 'skip', by: SKIP_S })));
    tick();
  }

  function paint(keys = []) {
    if (keys.includes('tvscreen.playback')) receivedAt = performance.now();
    const m = mode();
    const pb = playback();
    card.hidden = !m;
    host.classList?.toggle('has-tv-playback', !!m);
    setTicker(m === 'player' && pb?.state === 'playing');
    if (!m) { shape = ''; return; }
    const length = pb && Number.isFinite(pb.duration) ? Math.round(pb.duration / 1000) : 0;
    const next = `${m}|${pb?.state ?? ''}|${length}`;
    if (next !== shape) { shape = next; build(m, pb); } else tick();
  }

  ctx.state.watch(['tvscreen.playback', 'tvscreen.on', 'tvscreen.video', 'browser.media'], (keys) => paint(keys));
  return { card };
}
