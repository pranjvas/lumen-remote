// Pointer/keyboard press handling and the hold protocol: `hold` start → beat every 400 ms → end.
// Repeat keys click on press, then hand repetition to the server after HOLD_MS.
// Press keys (long-press meaningful) click on release, or Press/Release when held.

import { haptic } from './haptics.js';

const HOLD_MS = 500;
const BEAT_MS = 400;
const active = new Set();

function endAll() {
  for (const p of [...active]) p.cancel();
}

window.addEventListener('blur', endAll);
document.addEventListener('visibilitychange', () => { if (document.hidden) endAll(); });

export function keyPress(ctx, key, policy = ctx.holdPolicy(key), onFire) {
  let timer = null;
  let beat = null;
  let holding = false;

  const fire = () => {
    ctx.key(key);
    onFire?.(key);
  };

  const startHold = () => {
    timer = null;
    holding = true;
    haptic('armed');
    ctx.live.post('hold', { key, phase: 'start' });
    beat = setInterval(() => ctx.live.post('hold', { key, phase: 'beat' }), BEAT_MS);
  };

  const stop = () => {
    clearTimeout(timer);
    timer = null;
    clearInterval(beat);
    beat = null;
    if (holding) {
      holding = false;
      ctx.live.post('hold', { key, phase: 'end' });
    }
    active.delete(api);
  };

  const api = {
    down() {
      haptic('key');
      if (policy !== 'press') fire();
      if (policy === 'repeat' || policy === 'press') {
        active.add(api);
        timer = setTimeout(startHold, HOLD_MS);
      }
    },
    up() {
      if (policy === 'press' && !holding && timer) fire();
      stop();
    },
    cancel: stop,
  };
  return api;
}

// Wire pointer events (with capture) plus keyboard activation to down/up/cancel handlers.
export function bindPress(el, { down, up, cancel = up }) {
  let pressed = false;
  const finish = (cancelled) => {
    if (!pressed) return;
    pressed = false;
    el.classList.remove('is-pressed');
    (cancelled ? cancel : up)();
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || el.disabled) return;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch { /* element gone */ }
    pressed = true;
    el.classList.add('is-pressed');
    down(e);
  });
  el.addEventListener('pointerup', () => finish(false));
  el.addEventListener('pointercancel', () => finish(true));
  el.addEventListener('lostpointercapture', () => finish(false));
  el.addEventListener('click', (e) => {
    if (e.detail !== 0 || el.disabled) return;
    el.classList.add('is-pressed');
    down(e);
    up();
    setTimeout(() => el.classList.remove('is-pressed'), 120);
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

export function bindKey(el, ctx, key, opts = {}) {
  const press = keyPress(ctx, key, opts.policy ?? ctx.holdPolicy(key), opts.onFire);
  bindPress(el, { down: press.down, up: press.up, cancel: press.cancel });
  return press;
}
