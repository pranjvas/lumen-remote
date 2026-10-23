// Free memory on the TV: closes apps that are running in the background (not on screen), the same
// as quitting them on the TV; they start fresh next time. Only apps the TV's REST API can address
// (store ids and <package>.<name> ids from the agent's app list) are candidates; system apps and
// services cannot be closed from outside. Lumen's own agent and the voice assistant are kept.
// Memory is read before and after through Lumen Eyes (/proc/meminfo) when it is available, and kept in
// tv.memory while Settings is open. (The web API's figure the agent reports is close to MemFree and
// leaves out reclaimable cache, so it reads far lower than what the TV can actually use.)
import { LumenError } from '../errors.js';

const KEEP = ['AQKO41xyKP.AmazonAlexa']; // the voice assistant answers the remote's mic button
const SETTLE_MS = 2500;
const POLL_MS = 30000;

export function createMemory({ config, log: rootLog, store, rest, eyes, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const log = rootLog.child('memory');
  let busy = null;
  let pollTimer = null;

  function publish(r) {
    if (r?.via === 'eyes') store.set('tv.memory', r, { src: 'live', via: 'eyes:meminfo', ttlMs: 3 * POLL_MS });
    return r;
  }

  // → { reading, running: Set of running Tizen app ids | null }
  async function snapshot() {
    try {
      const { meminfo, apps } = await eyes().processes();
      const running = Array.isArray(apps) && apps.length && !apps[0]?.error ? new Set(apps.map((a) => a?.id).filter(Boolean)) : null;
      if (Number.isFinite(meminfo?.MemAvailable)) return { reading: toReading(meminfo), running };
      return { reading: await reading(), running };
    } catch (err) {
      log.debug('memory snapshot via Eyes failed', { message: err.message });
      return { reading: await reading(), running: null };
    }
  }

  function toReading(meminfo) {
    return { availableMb: Math.round(meminfo.MemAvailable / 1024), totalMb: Math.round(meminfo.MemTotal / 1024), swapFreeMb: Number.isFinite(meminfo.SwapFree) ? Math.round(meminfo.SwapFree / 1024) : null, via: 'eyes' };
  }

  async function reading() {
    try {
      const { meminfo } = await eyes().processes();
      if (Number.isFinite(meminfo?.MemAvailable)) {
        return { availableMb: Math.round(meminfo.MemAvailable / 1024), totalMb: Math.round(meminfo.MemTotal / 1024), swapFreeMb: Number.isFinite(meminfo.SwapFree) ? Math.round(meminfo.SwapFree / 1024) : null, via: 'eyes' };
      }
    } catch (err) {
      log.debug('memory reading via Eyes failed', { message: err.message });
    }
    const avail = store.get('system.memAvailable')?.v;
    const total = store.get('system.memTotal')?.v;
    return Number.isFinite(avail) ? { availableMb: Math.round(avail / 1048576), totalMb: Number.isFinite(total) ? Math.round(total / 1048576) : null, swapFreeMb: null, via: 'agent' } : null;
  }

  function candidates() {
    const keep = new Set([...KEEP, ...(config.memory?.keep ?? []), config.agent?.appId].filter(Boolean));
    const installed = store.get('app.installed')?.v;
    if (!Array.isArray(installed) || !installed.length) {
      throw new LumenError('UNAVAILABLE', 'Lumen does not know the TV’s apps yet (it needs the TV agent)');
    }
    return installed.filter((app) => typeof app?.id === 'string' && !keep.has(app.id) && !keep.has(app.tizenId));
  }

  async function freeOnce() {
    if (store.get('conn.tv')?.v !== 'on') throw new LumenError('TV_OFF', 'The TV is off');
    const all = candidates();
    const snap = await snapshot();
    const before = publish(snap.reading);
    // With Eyes, only the apps it sees running are checked (each REST check takes a moment).
    const list = snap.running ? all.filter((app) => snap.running.has(app.tizenId) || snap.running.has(app.id)) : all;
    const closed = [];
    const failed = [];
    for (const app of list) {
      let status;
      try {
        status = (await rest.getApp(app.id)).value;
      } catch {
        continue; // not installed under this id, or the TV did not answer for it
      }
      if (!status.running || status.visible) continue;
      try {
        await rest.close(app.id);
        closed.push({ id: app.id, name: status.name || app.name || app.id });
      } catch (err) {
        failed.push({ id: app.id, name: status.name || app.name || app.id, error: err.message });
      }
    }
    if (closed.length) await sleep(SETTLE_MS);
    const after = closed.length ? publish(await reading()) : before;
    // RAM and swap both count: closing a swapped-out app mostly frees swap. Noisy, so only a gain is reported.
    const total = (r) => (r ? r.availableMb + (r.swapFreeMb ?? 0) : null);
    const gain = before && after ? total(after) - total(before) : null;
    const freedMb = gain > 0 ? gain : null;
    log.info('freed TV memory', { closed: closed.map((c) => c.name), failed: failed.length, before: before?.availableMb ?? null, after: after?.availableMb ?? null });
    return { closed, failed, before, after, freedMb };
  }

  return {
    /** Closes background apps; → { closed: [{ id, name }], failed, before, after, freedMb }. */
    async free() {
      // One run at a time; a second request joins the one in progress.
      busy ??= freeOnce().finally(() => { busy = null; });
      return busy;
    },
    reading,
    // Settings shows the TV's memory: read it through Eyes while Settings is open.
    setDemand({ views } = {}) {
      const want = Boolean(views?.has?.('settings'));
      if (want === Boolean(pollTimer)) return;
      if (!want) { clearInterval(pollTimer); pollTimer = null; return; }
      const tick = () => { if (store.get('conn.tv')?.v === 'on') reading().then(publish).catch(() => {}); };
      pollTimer = setInterval(tick, POLL_MS);
      tick();
    },
    stop() { clearInterval(pollTimer); pollTimer = null; },
  };
}
