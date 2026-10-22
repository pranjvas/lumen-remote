// Sleep timer owned by Lumen: a persisted countdown that ends with IP Control powerOff,
// falling back to one KEY_POWER click when the TV is known to be on. State key `sleep`.
import { LumenError } from '../errors.js';

const FILE = 'sleep.json';
const MAX_MINUTES = 720;
const RECHECK_MS = 30000; // re-read the wall clock so PC sleep/resume cannot stretch the timer
const LATE_GRACE_MS = 2 * 60 * 1000; // a timer that ended while Lumen restarted still fires

export function createSleep({ data, log: rootLog, store, ipc, remote }) {
  const log = rootLog.child('sleep');
  let state = null; // { endsAt, minutes }
  let timer = null;
  let stopped = false;

  function publish() {
    store.set('sleep', state, { src: 'tracked', via: 'lumen' });
  }

  function commit(next) {
    state = next;
    try {
      data.writeJson(FILE, state);
    } catch (err) {
      log.warn('sleep timer not saved', err);
    }
    publish();
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!state || stopped) return;
    const left = state.endsAt - Date.now();
    if (left <= 0) {
      fire();
      return;
    }
    timer = setTimeout(schedule, Math.min(left, RECHECK_MS));
  }

  async function fire() {
    commit(null);
    const tv = store.get('conn.tv')?.v;
    if (tv === 'standby' || tv === 'off') {
      log.info('sleep timer ended; the TV is already off');
      return;
    }
    log.info('sleep timer ended; turning the TV off');
    try {
      await ipc.set('powerControl', { power: 'powerOff' });
      return;
    } catch (err) {
      log.warn('IP Control power off failed', { code: err.code, message: err.message });
    }
    if (store.get('conn.tv')?.v !== 'on') return;
    try {
      await remote.click('KEY_POWER');
    } catch (err) {
      log.error('KEY_POWER fallback failed', { code: err.code, message: err.message });
    }
  }

  return {
    start() {
      stopped = false;
      const saved = data.readJson(FILE, null);
      const valid = saved && Number.isFinite(saved.endsAt) && Number.isInteger(saved.minutes);
      if (!valid) {
        state = null;
        publish();
        return;
      }
      if (Date.now() - saved.endsAt > LATE_GRACE_MS) {
        log.info('discarding a sleep timer that ended while Lumen was not running');
        commit(null);
        return;
      }
      state = { endsAt: saved.endsAt, minutes: saved.minutes };
      publish();
      schedule();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    },
    setDemand() {},

    // minutes 0 cancels.
    set(minutes) {
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_MINUTES) {
        throw new LumenError('INVALID', `Sleep timer must be 0–${MAX_MINUTES} minutes`);
      }
      commit(minutes === 0 ? null : { endsAt: Date.now() + minutes * 60000, minutes });
      log.info(minutes ? `sleep in ${minutes} min` : 'sleep timer cancelled');
      return { value: state };
    },
  };
}
