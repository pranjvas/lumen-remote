// Mouse: the TV's own on-screen pointer, driven from a phone trackpad or from this PC's mouse
// (Pointer Lock). Moves go out once per animation frame and the server coalesces them further.
// The TV's touch flag is only a hint: live on the Q95T the cursor moved over CineHD without it.

import { h, icon, fill, reducedMotion } from '../ui/dom.js';
import { haptic } from '../ui/haptics.js';
import { accelerate, bindTrackpad, readGain, saveGain } from '../ui/trackpad.js';
import { buildTextPanel } from './text.js';

const WHEEL_LINE_PX = 40;

export function mountMouse(root, ctx) {
  let gain = readGain();
  let pending = { dx: 0, dy: 0 };
  let frame = 0;
  let locked = false;

  const status = h('span', { class: 'chip mouse-status' });
  const hint = h('p', { class: 'touch-hint' });
  const cursor = h('div', { class: 'mouse-cursor', 'aria-hidden': 'true' }, icon('cursor'));
  const pad = h('div', {
    class: 'touchpad mousepad', role: 'application', 'aria-roledescription': 'trackpad', tabindex: '0',
    'aria-label': 'Trackpad. Drag to move the TV cursor, tap to click, two-finger tap or long press to right-click, two-finger drag to scroll.',
  }, cursor, hint);

  const lockBtn = h('button', { class: 'btn primary mouse-lock', type: 'button' }, icon('mouse', 'sm'), h('span', { text: 'Use this PC’s mouse' }));
  const button = (label, iconName, onClick, extra = '') => h('button', {
    class: `btn ghost ${extra}`, type: 'button', 'aria-label': label, onclick: () => { haptic('key'); onClick(); },
  }, icon(iconName, 'sm'), h('span', { text: label }));
  const gainInput = h('input', {
    type: 'range', min: '0.5', max: '5', step: '0.25', value: String(gain), 'aria-label': 'Pointer speed',
    oninput: (e) => { gain = Number(e.target.value); saveGain(gain); },
  });
  const text = buildTextPanel(ctx);
  const textCard = h('section', { class: 'section text-section', hidden: true },
    h('div', { class: 'section-head' }, h('h2', { text: 'Type on the TV' })), h('div', { class: 'card card-pad' }, text.el));

  root.append(
    h('header', { class: 'view-head' },
      h('div', null,
        h('h1', { class: 'view-title', text: 'Mouse' }),
        h('p', { class: 'view-sub', text: 'Move the TV’s cursor in the browser, CineHD and other apps' })),
      status),
    pad,
    h('div', { class: 'mouse-controls' },
      button('Left click', 'cursor', () => click('left')),
      button('Right click', 'more', () => click('right')),
      button('Scroll up', 'up', () => scroll(-120)),
      button('Scroll down', 'down', () => scroll(120)),
      button('Keyboard', 'keyboard', () => { textCard.hidden = !textCard.hidden; if (!textCard.hidden) text.input.focus(); }),
      button('Back', 'back', () => ctx.key('KEY_RETURN'))),
    h('div', { class: 'mouse-settings card card-pad' },
      h('label', { class: 'mouse-gain' }, h('span', { text: 'Pointer speed' }), gainInput),
      matchMedia('(pointer: fine)').matches ? lockBtn : null),
    textCard,
  );

  // ---- status ----
  function paintStatus() {
    const t = ctx.state.value('touch.enabled', null);
    const paired = ctx.state.value('conn.remote', null) === 'paired';
    fill(status, icon(t === false ? 'touch' : 'cursor', 'xs'),
      !paired ? 'Remote channel not paired' : t === true ? 'Pointer active in this app' : t === false ? 'This screen may not take a pointer' : 'Pointer ready');
    status.classList.toggle('is-off', !paired);
    hint.textContent = locked
      ? 'Your mouse now drives the TV · Esc to release'
      : 'Drag to move · Tap = click · Two-finger tap or long press = right-click · Two-finger drag = scroll';
  }
  ctx.state.watch('touch.enabled', paintStatus);
  ctx.state.watch('conn.remote', paintStatus);
  paintStatus();

  // ---- sending ----
  const flush = () => {
    frame = 0;
    const dx = Math.round(pending.dx);
    const dy = Math.round(pending.dy);
    pending = { dx: 0, dy: 0 };
    if (dx || dy) ctx.live.post('pointer.move', { dx: clampMove(dx), dy: clampMove(dy) });
  };
  const clampMove = (v) => Math.max(-400, Math.min(400, v));
  const queueMove = (dx, dy) => {
    pending.dx += accelerate(dx, gain);
    pending.dy += accelerate(dy, gain);
    if (!frame) frame = requestAnimationFrame(flush);
    nudgeCursor(dx, dy);
  };
  function click(buttonName) {
    if (frame) { cancelAnimationFrame(frame); flush(); }
    ctx.cmd('pointer.click', { button: buttonName }, { silent: false });
    pad.classList.remove('is-tap');
    void pad.offsetWidth;
    pad.classList.add('is-tap');
  }
  let wheelAcc = 0;
  let wheelTimer = 0;
  function scroll(dy) {
    wheelAcc += dy;
    if (wheelTimer) return;
    wheelTimer = setTimeout(() => {
      wheelTimer = 0;
      const amount = wheelAcc;
      wheelAcc = 0;
      if (amount) ctx.live.post('pointer.scroll', { dy: Math.max(-2400, Math.min(2400, amount)) });
    }, 80);
  }

  // A small on-pad echo of the movement, so the pad feels alive even though the cursor is on the TV.
  let cx = 0.5;
  let cy = 0.45;
  function nudgeCursor(dx, dy) {
    const r = pad.getBoundingClientRect();
    if (!r.width) return;
    cx = Math.min(0.97, Math.max(0.03, cx + (dx * gain) / r.width / 2));
    cy = Math.min(0.92, Math.max(0.05, cy + (dy * gain) / r.height / 2));
    cursor.style.left = `${cx * 100}%`;
    cursor.style.top = `${cy * 100}%`;
    if (!reducedMotion()) cursor.classList.add('is-live');
  }

  // ---- touch / pen / unlocked mouse gestures on the pad ----
  bindTrackpad(pad, { move: queueMove, click, scroll: (dx, dy) => scroll(dy * 6), paused: () => locked });

  // ---- this PC's mouse via Pointer Lock ----
  const lock = () => {
    const req = pad.requestPointerLock?.({ unadjustedMovement: true });
    // Older engines return undefined or reject unadjustedMovement; fall back to the plain request.
    if (req && typeof req.catch === 'function') req.catch(() => pad.requestPointerLock());
  };
  lockBtn.addEventListener('click', lock);
  ctx.on('mouse-lock', () => { if (matchMedia('(pointer: fine)').matches) lock(); });

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === pad;
    pad.classList.toggle('is-locked', locked);
    lockBtn.classList.toggle('is-active', locked);
    lockBtn.querySelector('span').textContent = locked ? 'Mouse captured · Esc to release' : 'Use this PC’s mouse';
    paintStatus();
  });
  document.addEventListener('mousemove', (e) => { if (locked) queueMove(e.movementX, e.movementY); });
  document.addEventListener('mousedown', (e) => {
    if (!locked) return;
    e.preventDefault();
    if (e.button === 0) click('left');
    else if (e.button === 2) click('right');
    else if (e.button === 1) ctx.key('KEY_RETURN');
  });
  document.addEventListener('wheel', (e) => {
    if (!locked) return;
    e.preventDefault();
    scroll(e.deltaMode === 1 ? e.deltaY * WHEEL_LINE_PX : e.deltaY);
  }, { passive: false });
  pad.addEventListener('wheel', (e) => {
    if (locked) return;
    e.preventDefault();
    scroll(e.deltaMode === 1 ? e.deltaY * WHEEL_LINE_PX : e.deltaY);
  }, { passive: false });

  // Arrow keys still work when the pad has keyboard focus.
  pad.addEventListener('keydown', (e) => {
    const map = { ArrowUp: 'KEY_UP', ArrowDown: 'KEY_DOWN', ArrowLeft: 'KEY_LEFT', ArrowRight: 'KEY_RIGHT', Enter: 'KEY_ENTER', Backspace: 'KEY_RETURN' };
    if (!map[e.key] || locked) return;
    e.preventDefault();
    e.stopPropagation();
    ctx.key(map[e.key]);
  });

  ctx.on('ime-open', () => { textCard.hidden = false; text.input.focus(); });
}
