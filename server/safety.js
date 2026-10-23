// Guard rails applied to every command: key allowlist, power cooldown, volume cap and a
// per-client rate limit.
import { LumenError } from './errors.js';
import { isAllowedKey } from './catalog/keys.js';

const RATE = { burst: 30, perSecond: 30 };
// Touchpad movement streams far faster than button presses, so it has its own bucket.
const POINTER_RATE = { burst: 120, perSecond: 120 };
// Browser frame acks: one per frame a client receives (the server sends at most browser.maxFps).
const FRAME_ACK_RATE = { burst: 120, perSecond: 120 };

function createBucket({ burst, perSecond }) {
  let tokens = burst;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSecond);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

export function createSafety({ config }) {
  const { volumeCap = 60, powerCooldownMs = 15000 } = config.safety ?? {};
  const buckets = new WeakMap();
  const anonymous = {};
  let lastPowerAt = 0;

  return {
    volumeCap,

    // action: 'click' | 'press' | 'hold'. Returns the key or throws INVALID.
    checkKey(key, action = 'click') {
      if (typeof key !== 'string' || !isAllowedKey(key, action)) {
        throw new LumenError('INVALID', action === 'click' ? `Key ${key} is not allowed` : `Key ${key} cannot be held`);
      }
      return key;
    },

    // Throws RATE_LIMIT while a previous power action is still settling (KEY_POWER toggles).
    checkPower() {
      const wait = lastPowerAt + powerCooldownMs - Date.now();
      if (wait > 0) throw new LumenError('RATE_LIMIT', `Power was just used; try again in ${Math.ceil(wait / 1000)} s`);
    },
    notePower() {
      lastPowerAt = Date.now();
    },

    // The level Lumen may set when asked for `target`. Lowering is always allowed; raising stops
    // at the cap, or at the current level if that is already above the cap. `current` is the
    // trusted current level, or null when unknown.
    limitVolume(target, current = null) {
      const wanted = Math.max(0, Math.min(100, Math.round(target)));
      if (wanted <= volumeCap) return wanted;
      if (current !== null && wanted <= current) return wanted;
      return Math.max(volumeCap, current ?? 0);
    },

    // Throws RATE_LIMIT when a client sends commands faster than allowed.
    checkRate(client, cmd) {
      const owner = client && typeof client === 'object' ? client : anonymous;
      let entry = buckets.get(owner);
      if (!entry) {
        entry = { main: createBucket(RATE), pointer: createBucket(POINTER_RATE), frameAck: createBucket(FRAME_ACK_RATE) };
        buckets.set(owner, entry);
      }
      const take = cmd === 'pointer.move' ? entry.pointer : cmd === 'browser.ack' ? entry.frameAck : entry.main;
      if (!take()) throw new LumenError('RATE_LIMIT', 'Too many commands; slow down');
    },
  };
}
