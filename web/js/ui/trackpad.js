// Trackpad gestures, shared by the Mouse view (the TV's own pointer) and the Browser view's pad
// (Lumen's page, and the TV's cursor while the page is on the TV): one finger moves, a tap clicks,
// a two-finger tap or a long press right-clicks, two fingers scroll.

import { haptic } from './haptics.js';

const TAP_MS = 250;
const TAP_SLOP = 8;
const LONG_PRESS_MS = 550;
const GAIN_KEY = 'lumen.mouse.gain';

/** Pointer speed, set on the Mouse view and used by every pad. */
export const readGain = () => {
  const v = Number(localStorage.getItem(GAIN_KEY));
  return Number.isFinite(v) && v >= 0.5 && v <= 5 ? v : 2;
};
export const saveGain = (v) => localStorage.setItem(GAIN_KEY, String(v));

// Pointer acceleration: slow strokes stay precise, quick flicks cross the screen.
export const accelerate = (d, gain) => {
  const speed = Math.abs(d);
  return Math.sign(d) * speed * gain * (1 + Math.min(speed, 40) / 25);
};

/**
 * Wires the gestures onto `pad`: move(dx, dy) gets raw finger deltas in CSS pixels, click('left' |
 * 'right') a tap or long press, scroll(dx, dy) the first finger's deltas while two are down.
 * While `paused()` is true touches are ignored (the Mouse view with this PC's mouse captured).
 */
export function bindTrackpad(pad, { move, click, scroll, paused = () => false }) {
  const touches = new Map();
  let gesture = null;
  let longTimer = 0;

  // iOS can still hand a finger on the pad to the page's own scrolling (the view scrolls on short
  // phones) and cancel the pointer stream halfway through a drag. Taking the touches themselves keeps
  // the whole gesture on the pad; the pointer events below still do the work.
  if ('ontouchstart' in window) {
    const keep = (e) => { if (!paused() && e.cancelable) e.preventDefault(); };
    pad.addEventListener('touchstart', keep, { passive: false });
    pad.addEventListener('touchmove', keep, { passive: false });
  }

  pad.addEventListener('pointerdown', (e) => {
    if (paused()) return;
    pad.setPointerCapture(e.pointerId);
    touches.set(e.pointerId, { lastX: e.clientX, lastY: e.clientY });
    if (touches.size === 1) {
      gesture = { start: performance.now(), x: e.clientX, y: e.clientY, moved: 0, two: false, scrolled: false, long: false };
      clearTimeout(longTimer);
      longTimer = setTimeout(() => {
        if (gesture && !gesture.two && gesture.moved < TAP_SLOP) { gesture.long = true; haptic('key'); click('right'); }
      }, LONG_PRESS_MS);
    } else if (touches.size === 2 && gesture) {
      gesture.two = true;
      clearTimeout(longTimer);
    }
  });

  pad.addEventListener('pointermove', (e) => {
    if (paused()) return;
    const t = touches.get(e.pointerId);
    if (!t || !gesture) return;
    const dx = e.clientX - t.lastX;
    const dy = e.clientY - t.lastY;
    t.lastX = e.clientX;
    t.lastY = e.clientY;
    gesture.moved = Math.max(gesture.moved, Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y));
    if (gesture.moved >= TAP_SLOP) clearTimeout(longTimer);
    if (gesture.two) {
      // Two fingers scroll; only the first finger's motion counts so the speed is not doubled.
      if (e.pointerId === [...touches.keys()][0]) { gesture.scrolled = true; scroll(dx, dy); }
      return;
    }
    move(dx, dy);
  });

  const end = (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.delete(e.pointerId);
    if (touches.size || !gesture) return;
    clearTimeout(longTimer);
    const quick = performance.now() - gesture.start < TAP_MS;
    if (quick && gesture.moved < TAP_SLOP && !gesture.long && !gesture.scrolled) {
      haptic('key');
      click(gesture.two ? 'right' : 'left');
    }
    gesture = null;
  };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', (e) => { touches.delete(e.pointerId); if (!touches.size) { gesture = null; clearTimeout(longTimer); } });
  pad.addEventListener('contextmenu', (e) => e.preventDefault());
}
