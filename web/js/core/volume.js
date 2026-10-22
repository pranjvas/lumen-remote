// Volume controller: optimistic steps and sets reconciled against the TV's read-back,
// shared by the halo, the rocker, the precise sheet and keyboard shortcuts.

import { clamp } from '../ui/format.js';
import { haptic } from '../ui/haptics.js';

const CONFIRM_MS = 1500;

export function createVolume(ctx) {
  const { state } = ctx;
  const subs = new Set();
  let inflight = 0;
  let target = null;
  let confirmed = null;
  let setBusy = false;
  let queuedSet = null;
  let muteTarget = null;

  const truth = () => {
    const v = state.truth('audio.volume')?.v;
    return Number.isFinite(v) ? v : null;
  };

  function shown() {
    if (target !== null) return target;
    if (confirmed && performance.now() < confirmed.until && truth() !== confirmed.v) return confirmed.v;
    return truth();
  }

  const notify = () => { for (const fn of subs) fn(api.snapshot()); };

  state.watch(['audio.volume', 'audio.mute'], () => {
    if (confirmed && truth() === confirmed.v) confirmed = null;
    notify();
  }, { immediate: false });

  function settle(ack) {
    if (ack.ok && Number.isFinite(ack.value)) confirmed = { v: ack.value, until: performance.now() + CONFIRM_MS };
  }

  async function step(delta, { el } = {}) {
    const base = shown();
    if (base !== null) target = clamp(base + delta, 0, 100);
    inflight += 1;
    haptic('detent');
    notify();
    const ack = await ctx.cmd('volume.step', { delta }, { el });
    inflight -= 1;
    if (inflight === 0) {
      target = null;
      settle(ack);
    }
    notify();
    return ack;
  }

  // Absolute set; while one is in flight, only the newest requested level is queued.
  async function set(value) {
    const v = clamp(Math.round(value), 0, 100);
    target = v;
    notify();
    if (setBusy) { queuedSet = v; return; }
    setBusy = true;
    let next = v;
    while (next !== null) {
      queuedSet = null;
      const ack = await ctx.cmd('volume.set', { value: next });
      next = queuedSet;
      if (next === null) {
        target = null;
        settle(ack);
      }
    }
    setBusy = false;
    notify();
  }

  async function toggleMute({ el } = {}) {
    const now = muteTarget ?? state.truth('audio.mute')?.v;
    const next = !now;
    muteTarget = next;
    state.setOverlay('audio.mute', next);
    haptic('key');
    const ack = await ctx.cmd('mute.set', { value: next }, { el });
    muteTarget = null;
    state.clearOverlay('audio.mute');
    notify();
    return ack;
  }

  const api = {
    step,
    set,
    toggleMute,
    shown,
    truth,
    snapshot: () => ({
      value: shown(),
      truth: truth(),
      pending: target !== null || inflight > 0,
      muted: !!state.value('audio.mute', false),
      record: state.truth('audio.volume'),
    }),
    subscribe(fn) {
      subs.add(fn);
      fn(api.snapshot());
      return () => subs.delete(fn);
    },
  };
  return api;
}
