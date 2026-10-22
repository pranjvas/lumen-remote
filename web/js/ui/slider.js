// Accessible range slider. Ignores server updates while dragging and for 1 s after release,
// so the thumb never bounces between old and new values.

import { h } from './dom.js';
import { clamp } from './format.js';
import { haptic } from './haptics.js';

const HOLD_OFF_MS = 1000;

export function createSlider({
  min = 0, max = 100, step = 1, value = min, label, bipolar = false, big = false,
  format = (v) => String(v), onInput, onCommit, detents = false, ticks: showTicks = true,
}) {
  const fill = h('div', { class: 'slider-fill' });
  const thumb = h('div', { class: 'slider-thumb' });
  const ticks = h('div', { class: 'slider-ticks', 'aria-hidden': 'true' });
  const el = h('div', {
    class: `slider${bipolar ? ' bipolar' : ''}${big ? ' big' : ''}`,
    role: 'slider',
    tabindex: '0',
    'aria-label': label,
    'aria-valuemin': min,
    'aria-valuemax': max,
  }, h('div', { class: 'slider-track' }), fill, ticks, thumb);

  const span = max - min || 1;
  // About 20 ticks at most, on a 1-2-5 spacing.
  const raw = span / 20;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const tickEvery = Math.max(step, [1, 2, 5, 10].map((m) => m * pow).find((m) => m >= raw));
  for (let v = min; showTicks && v <= max + 1e-9; v += tickEvery) {
    const major = Math.abs(v) % (tickEvery * 2) < 1e-9 || v === min || v === max;
    ticks.append(h('i', { class: major ? 'major' : '', style: { left: `${((v - min) / span) * 100}%` } }));
  }

  let current = value;
  let dragging = false;
  let holdOffUntil = 0;
  let disabled = false;
  let keyTimer = null;

  const snap = (v) => clamp(Math.round((v - min) / step) * step + min, min, max);

  function paint(v) {
    el.style.setProperty('--pct', `${((v - min) / span) * 100}%`);
    el.setAttribute('aria-valuenow', v);
    el.setAttribute('aria-valuetext', format(v));
  }

  function setLocal(v, { emit = true } = {}) {
    const next = snap(v);
    if (next === current) return;
    current = next;
    paint(current);
    if (detents) haptic('detent');
    if (emit) onInput?.(current);
  }

  function fromPointer(e) {
    const r = el.getBoundingClientRect();
    return min + clamp((e.clientX - r.left) / r.width, 0, 1) * span;
  }

  el.addEventListener('pointerdown', (e) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    dragging = true;
    el.classList.add('is-dragging');
    el.focus({ preventScroll: true });
    setLocal(fromPointer(e));
  });
  el.addEventListener('pointermove', (e) => { if (dragging) setLocal(fromPointer(e)); });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    holdOffUntil = performance.now() + HOLD_OFF_MS;
    el.classList.remove('is-dragging');
    onCommit?.(current);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('lostpointercapture', end);

  el.addEventListener('keydown', (e) => {
    if (disabled) return;
    const jump = Math.max(step, Math.round(span / 10 / step) * step);
    const map = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: jump, PageDown: -jump };
    let next = null;
    if (e.key in map) next = current + map[e.key];
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    setLocal(next);
    holdOffUntil = performance.now() + HOLD_OFF_MS;
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => onCommit?.(current), 450);
  });

  paint(current);

  return {
    el,
    get value() { return current; },
    get busy() { return dragging || performance.now() < holdOffUntil; },
    set(v, { force = false } = {}) {
      if (v === null || v === undefined || Number.isNaN(Number(v))) return;
      if (!force && (dragging || performance.now() < holdOffUntil)) return;
      current = snap(Number(v));
      paint(current);
    },
    setPending(on) { el.classList.toggle('is-pending', !!on); },
    setDisabled(on) {
      disabled = !!on;
      el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      el.tabIndex = disabled ? -1 : 0;
    },
  };
}
