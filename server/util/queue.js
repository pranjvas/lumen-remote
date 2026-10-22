// A small async work queue: bounded concurrency, a minimum idle gap between tasks,
// and two priorities ('user' tasks always run before waiting 'poll' tasks).
import { LumenError } from '../errors.js';

export function createQueue({ concurrency = 1, minGapMs = 0 } = {}) {
  const waiting = { user: [], poll: [] };
  let active = 0;
  let lastActivity = 0; // when a task last started or finished
  let timer = null;

  function next() {
    return waiting.user.shift() ?? waiting.poll.shift();
  }

  function pump() {
    if (timer) return;
    while (active < concurrency && (waiting.user.length || waiting.poll.length)) {
      const wait = lastActivity + minGapMs - Date.now();
      if (minGapMs > 0 && wait > 0) {
        timer = setTimeout(() => {
          timer = null;
          pump();
        }, wait);
        return;
      }
      run(next());
    }
  }

  async function run(job) {
    active += 1;
    lastActivity = Date.now();
    try {
      job.resolve(await job.fn());
    } catch (err) {
      job.reject(err);
    } finally {
      active -= 1;
      lastActivity = Date.now();
      pump();
    }
  }

  return {
    push(fn, { priority = 'user' } = {}) {
      return new Promise((resolve, reject) => {
        waiting[priority === 'poll' ? 'poll' : 'user'].push({ fn, resolve, reject });
        pump();
      });
    },
    // Rejects every task that has not started yet (running tasks finish on their own).
    clear(err = new LumenError('UNAVAILABLE', 'Stopped')) {
      clearTimeout(timer);
      timer = null;
      for (const job of [...waiting.user.splice(0), ...waiting.poll.splice(0)]) job.reject(err);
    },
    get size() {
      return waiting.user.length + waiting.poll.length;
    },
    get active() {
      return active;
    },
  };
}
