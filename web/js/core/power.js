// Power state and actions: hold-to-turn-off when on, tap to wake when in standby/off,
// with a "waking" phase until REST reports on (or 30 s pass).

import { toast } from '../ui/toast.js';
import { haptic } from '../ui/haptics.js';

const WAKE_TIMEOUT_MS = 32000;

export function createPower(ctx) {
  const subs = new Set();
  let wakingSince = 0;
  let timer = null;

  const raw = () => ctx.state.value('conn.tv', ctx.state.value('power.state', 'unknown'));

  function current() {
    const tv = raw();
    if (wakingSince && tv !== 'on' && Date.now() - wakingSince < WAKE_TIMEOUT_MS) return 'waking';
    return tv;
  }

  const notify = () => { for (const fn of subs) fn(current()); };

  ctx.state.watch(['conn.tv', 'power.state'], () => {
    if (raw() === 'on' && wakingSince) {
      wakingSince = 0;
      clearInterval(timer);
    }
    notify();
  }, { immediate: false });

  async function wake() {
    wakingSince = Date.now();
    clearInterval(timer);
    timer = setInterval(() => {
      if (current() !== 'waking') { clearInterval(timer); wakingSince = 0; }
      notify();
    }, 500);
    notify();
    haptic('power');
    const ack = await ctx.cmd('power', { action: 'on' }, { timeoutMs: 40000 });
    if (!ack.ok) { wakingSince = 0; clearInterval(timer); }
    notify();
  }

  async function off() {
    haptic('power');
    const ack = await ctx.cmd('power', { action: 'off' });
    if (ack.ok) toast('Turning the TV off', { level: 'info' });
  }

  return {
    current,
    wake,
    off,
    wakingFor: () => (wakingSince ? Date.now() - wakingSince : 0),
    subscribe(fn) { subs.add(fn); fn(current()); return () => subs.delete(fn); },
  };
}
