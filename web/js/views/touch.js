// Touch & Text: a touchpad (swipe = arrows, tap = OK, two-finger tap = Back; pointer mode and
// two-finger drag move the TV pointer when touch.enabled) and the text field for the TV keyboard.

import { h, icon, reducedMotion, fill } from '../ui/dom.js';
import { createSegmented } from '../ui/segmented.js';
import { haptic } from '../ui/haptics.js';
import { buildTextPanel } from './text.js';

const SWIPE_PX = 16;
const TAP_MS = 250;
const TAP_SLOP = 10;
const POINTER_GAIN = 2.2;

export function mountTouch(root, ctx) {
  let mode = 'swipe';
  const hint = h('p', { class: 'touch-hint' });
  const arrow = h('div', { class: 'touch-arrow', 'aria-hidden': 'true' });
  const pad = h('div', { class: 'touchpad', role: 'application', 'aria-roledescription': 'touchpad', 'aria-label': 'Touchpad. Swipe for arrows, tap for OK.', tabindex: '0' }, arrow, hint);
  const modeHost = h('div', { class: 'touch-mode' });
  const text = buildTextPanel(ctx);

  root.append(
    h('header', { class: 'view-head' },
      h('div', null, h('h1', { class: 'view-title', text: 'Touch & Text' }), h('p', { class: 'view-sub', text: 'Swipe like the SmartThings remote, or type straight into the TV' })),
      modeHost),
    pad,
    h('section', { class: 'section text-section' }, h('div', { class: 'section-head' }, h('h2', { text: 'Text' })), h('div', { class: 'card card-pad' }, text.el)),
  );

  function paintHint() {
    hint.textContent = mode === 'pointer'
      ? 'Drag to move the pointer · Tap to click'
      : `Swipe to move · Tap = OK · Two-finger tap = Back${ctx.state.value('touch.enabled', false) ? ' · Two-finger drag = pointer' : ''}`;
  }

  ctx.state.watch('touch.enabled', () => {
    const enabled = !!ctx.state.value('touch.enabled', false);
    if (!enabled && mode === 'pointer') mode = 'swipe';
    if (enabled) {
      const seg = createSegmented({
        options: ['swipe', 'pointer'],
        value: mode,
        label: 'Touchpad mode',
        format: (o) => (o === 'swipe' ? 'Swipe' : 'Pointer'),
        onSelect: (o) => { mode = o; seg.set(o); paintHint(); },
      });
      fill(modeHost, seg.el);
    } else {
      fill(modeHost, h('span', { class: 'chip', title: 'The TV enables the pointer only in apps that support it (like the browser)' }, icon('touch', 'xs'), 'Pointer off on this screen'));
    }
    paintHint();
  });

  ctx.on('ime-open', () => text.input.focus());

  // ---- gesture recognition ----
  const pointers = new Map();
  let gesture = null;
  let moveAcc = { dx: 0, dy: 0 };
  let moveTimer = null;
  let lastTrail = 0;

  const showArrow = (dir) => {
    fill(arrow, icon(dir));
    arrow.classList.remove('is-on');
    void arrow.offsetWidth;
    arrow.classList.add('is-on');
  };

  const trail = (x, y) => {
    if (reducedMotion()) return;
    const now = performance.now();
    if (now - lastTrail < 24) return;
    lastTrail = now;
    const r = pad.getBoundingClientRect();
    const dot = h('i', { class: 'trail', style: { left: `${x - r.left}px`, top: `${y - r.top}px` } });
    pad.append(dot);
    setTimeout(() => dot.remove(), 420);
  };

  const flushMove = () => {
    moveTimer = null;
    const dx = Math.round(moveAcc.dx * POINTER_GAIN);
    const dy = Math.round(moveAcc.dy * POINTER_GAIN);
    moveAcc = { dx: 0, dy: 0 };
    if (dx || dy) ctx.live.post('pointer.move', { dx, dy });
  };
  const queueMove = (dx, dy) => {
    moveAcc.dx += dx;
    moveAcc.dy += dy;
    if (!moveTimer) moveTimer = setTimeout(flushMove, 33);
  };

  const arrowFor = (dx, dy) => (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? ['KEY_RIGHT', 'right'] : ['KEY_LEFT', 'left']) : dy > 0 ? ['KEY_DOWN', 'down'] : ['KEY_UP', 'up']);
  const step = () => (matchMedia('(pointer: coarse)').matches ? 56 : 40);

  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY });
    if (pointers.size === 1) {
      gesture = { start: performance.now(), x: e.clientX, y: e.clientY, ax: e.clientX, ay: e.clientY, moved: 0, swiped: false, two: false };
    } else if (pointers.size === 2 && gesture) {
      gesture.two = true;
    }
    trail(e.clientX, e.clientY);
  });

  pad.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p || !gesture) return;
    const dx = e.clientX - p.lastX;
    const dy = e.clientY - p.lastY;
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    gesture.moved = Math.max(gesture.moved, Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y));
    trail(e.clientX, e.clientY);
    const pointerOn = !!ctx.state.value('touch.enabled', false);
    if (gesture.two) {
      if (pointerOn && e.pointerId === [...pointers.keys()][0]) queueMove(dx, dy);
      return;
    }
    if (mode === 'pointer' && pointerOn) { queueMove(dx, dy); return; }
    const tx = e.clientX - gesture.ax;
    const ty = e.clientY - gesture.ay;
    const threshold = gesture.swiped ? step() : SWIPE_PX;
    if (Math.max(Math.abs(tx), Math.abs(ty)) >= threshold && Math.abs(Math.abs(tx) - Math.abs(ty)) > (gesture.swiped ? 0 : SWIPE_PX / 2)) {
      const [key, dir] = arrowFor(tx, ty);
      ctx.key(key);
      haptic('key');
      showArrow(dir);
      gesture.swiped = true;
      gesture.ax = e.clientX;
      gesture.ay = e.clientY;
    }
  });

  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size || !gesture) return;
    const quick = performance.now() - gesture.start < TAP_MS;
    const still = gesture.moved < TAP_SLOP;
    if (quick && still) {
      haptic('key');
      if (gesture.two) {
        if (ctx.state.value('touch.enabled', false)) ctx.cmd('pointer.click', { button: 'left' });
        else { ctx.key('KEY_RETURN'); showArrow('back'); }
      } else if (mode === 'pointer' && ctx.state.value('touch.enabled', false)) {
        ctx.cmd('pointer.click', { button: 'left' });
      } else {
        ctx.key('KEY_ENTER');
        pad.classList.remove('is-tap');
        void pad.offsetWidth;
        pad.classList.add('is-tap');
      }
    }
    if (moveTimer) { clearTimeout(moveTimer); flushMove(); }
    gesture = null;
  };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); if (!pointers.size) gesture = null; });

  pad.addEventListener('keydown', (e) => {
    const map = { ArrowUp: 'KEY_UP', ArrowDown: 'KEY_DOWN', ArrowLeft: 'KEY_LEFT', ArrowRight: 'KEY_RIGHT', Enter: 'KEY_ENTER', ' ': 'KEY_ENTER', Backspace: 'KEY_RETURN' };
    if (!map[e.key]) return;
    e.preventDefault();
    e.stopPropagation();
    ctx.key(map[e.key]);
  });
}
