// Automatic updates (docs/superpowers/specs/2026-10-26-auto-updater-design.md). Lumen checks this copy's git
// origin for releases (tags vX.Y.Z made by `npm run release`), and moves to a newer one only by fast-forwarding
// branch master with no local changes. update.status = { current, latest, state, reason, checkedAt, auto }
// where state is idle | checking | up-to-date | available | waiting | applying | updated | failed | left-alone
// | unreachable.
// Applying: once Lumen has been idle for 2 minutes (nobody watching through it), the plan goes to
// data/update/state.json, a detached helper (tools/update-apply.js) is started and Lumen shuts down; the
// helper fast-forwards, reinstalls if needed, starts Lumen again and rolls back if it does not come up.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT, VERSION } from '../config.js';
import { createGit } from '../update/git.js';
import { compareVersions, tagFor } from '../update/versions.js';
import { canInstall, findTooling, installTvApp, repoVersions, tvAppUpdates } from '../update/tvapps.js';

const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const SETTINGS_FILE = 'update/settings.json';
const STATE_FILE = 'update/state.json';
const TV_APPS_FILE = 'update/tvapps.json'; // { attempted: { 'agent@0.9.5': true } }: one try per version
const IDLE_MS = 2 * 60 * 1000; // idle this long before an update is applied
const EVALUATE_EVERY_MS = 30_000;
const STALE_APPLYING_MS = 10 * 60 * 1000; // an 'applying' older than this was interrupted
const OUTCOME_POLL_MS = 5000;
const TOOLING_TTL_MS = 10 * 60 * 1000; // the Tizen tooling probe (files on disk) is redone this often // while the helper still says 'applying' after Lumen came back
const IDLE_KEYS = ['tvscreen.on', 'tvscreen.video', 'tvscreen.live', 'browser.incognito', 'cast.session'];
const PLAYER_ACTIVE = new Set(['loading', 'playing', 'paused', 'fallback']);
const DLNA_ACTIVE = new Set(['PLAYING', 'PAUSED_PLAYBACK', 'TRANSITIONING']); // a file Lumen serves to the TV

/** Starts tools/update-apply.js detached and hidden: it outlives this server. */
function spawnUpdateHelper(dataDir) {
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'tools', 'update-apply.js'), dataDir], {
    cwd: REPO_ROOT, detached: true, windowsHide: true, stdio: 'ignore',
  });
  child.unref();
}

export function createUpdater({
  config, data, log: rootLog, store, features = {}, adapters = {}, requestExit = () => {}, git = createGit({ cwd: REPO_ROOT }),
  version = VERSION, now = Date.now, spawnHelper = () => spawnUpdateHelper(data.dir), tvApps: tvAppsSeam = null,
  httpPort = () => config.http?.port,
}) {
  const log = rootLog.child('update');
  const opts = config.update ?? {};
  const meta = { src: 'derived', via: 'update' };
  let status = { current: version, latest: null, state: 'idle', reason: null, checkedAt: null, auto: readAuto() };
  let checking = null;
  let timers = [];
  let idleSince = null;
  let applying = false;
  let failedVersion = null; // a release whose update failed here: not tried again by itself
  let removeListener = null;
  // TV apps (update.tvApps = { updates, tooling, installing, lastResult }): the agent and Eyes of a copy that sits
  // exactly at its release (clean, on master) against the TV's; installed when Lumen is idle and the TV is on,
  // where this PC has the Tizen tooling. An installed agent is not started here: it comes back through its own
  // auto-start, which never covers another app on the TV.
  const tvApps = {
    repoVersions: () => repoVersions(REPO_ROOT),
    connected: () => ({ agent: adapters.agent?.version?.() ?? null, eyes: adapters.eyes?.version?.() ?? null }),
    tooling: () => findTooling({ config }),
    install: (app, tooling) => installTvApp(app, tooling, { tvHost: config.tv?.host, log }),
    ...tvAppsSeam,
  };
  let tvState = { updates: [], tooling: false, installing: null, lastResult: null };
  let tvShape = '';
  let releaseCopy = false; // this copy is clean on master at its own release tag (set by each check)
  let tooling = { value: null, at: -Infinity };

  function readAuto() {
    const saved = data.readJson(SETTINGS_FILE, {});
    return saved?.auto !== false;
  }

  function publish(patch) {
    status = { ...status, ...patch };
    store.set('update.status', status, meta);
    return status;
  }

  // Why this copy cannot move to `tag`, or null when it can (fast-forward of master, nothing local).
  async function blocker(tag) {
    if (await git.isDirty()) return 'local changes';
    const branch = await git.branch();
    if (!branch) return 'not on a branch';
    if (branch !== 'master') return `on branch ${branch}`;
    if (!(await git.isAncestor(await git.head(), await git.commitOf(tag)))) return 'ahead of the release';
    return null;
  }

  // Whether this copy is exactly its release: what it carries for the TV is then what was released, not work in
  // progress.
  async function atRelease() {
    try {
      if (!(await git.isRepo()) || (await git.branch()) !== 'master' || (await git.isDirty())) return false;
      return (await git.head()) === (await git.commitOf(tagFor(version)));
    } catch {
      return false;
    }
  }

  async function runCheck() {
    publish({ state: 'checking', reason: null });
    releaseCopy = await atRelease();
    refreshTvApps();
    if (!(await git.isRepo())) return publish({ state: 'left-alone', reason: 'not a git copy', checkedAt: now() });
    try {
      await git.fetchTags();
    } catch (err) {
      log.info('could not check for updates', { message: err.message });
      return publish({ state: 'unreachable', reason: err.message, checkedAt: now() });
    }
    const [newest] = await git.releaseTags();
    if (!newest || compareVersions(newest.version, version) <= 0) {
      return publish({ state: 'up-to-date', latest: newest?.version ?? null, reason: null, checkedAt: now() });
    }
    const why = await blocker(newest.tag);
    if (why) return publish({ state: 'left-alone', latest: newest.version, reason: why, checkedAt: now() });
    if (newest.version === failedVersion) return publish({ state: 'failed', latest: newest.version, tag: newest.tag, checkedAt: now() });
    log.info('update available', { from: version, to: newest.version });
    return publish({ state: 'available', latest: newest.version, tag: newest.tag, reason: null, checkedAt: now() });
  }

  // Nobody is watching through Lumen: its browser is not on the TV, no video in the TV's player, no live
  // video, no file cast to the TV (Lumen serves it), no incognito browsing, no Ask Lumen run. A phone merely
  // having Lumen open does not count.
  function inUse() {
    const v = (key) => store.get(key)?.v;
    if (v('tvscreen.on') === true || PLAYER_ACTIVE.has(v('tvscreen.video')) || v('browser.incognito') === true) return true;
    const cast = v('cast.session');
    if (cast?.kind === 'dlna' && DLNA_ACTIVE.has(cast.state)) return true;
    const live = v('tvscreen.live');
    if (live && typeof live === 'object' && live.state && live.state !== 'off') return true;
    return features.ai?.busy?.() === true;
  }

  /** The idle gate: applies an available update once Lumen has been idle for 2 minutes, else installs a newer
   *  TV app where the tooling is here (→ the apply or install, if it starts one). */
  function evaluate() {
    const busy = inUse();
    if (busy) idleSince = null;
    else idleSince ??= now();
    const idleLong = !busy && now() - idleSince >= (opts.idleMs ?? IDLE_MS);
    refreshTvApps();
    if (applying || !status.auto) return undefined;
    if (['available', 'waiting'].includes(status.state)) {
      if (!idleLong) {
        const reason = busy ? 'Lumen is in use' : 'until Lumen is not in use';
        if (status.state !== 'waiting' || status.reason !== reason) publish({ state: 'waiting', reason });
        return undefined;
      }
      return apply().catch((err) => log.warn('could not start the update', { message: err.message }));
    }
    return idleLong ? installTvApps() : undefined;
  }

  function publishTv(patch = {}) {
    tvState = { ...tvState, ...patch };
    const shape = JSON.stringify(tvState);
    if (shape === tvShape) return;
    tvShape = shape;
    store.set('update.tvApps', tvState, meta);
  }

  function currentTooling() {
    if (now() - tooling.at >= TOOLING_TTL_MS) tooling = { value: tvApps.tooling() ?? null, at: now() };
    return tooling.value;
  }

  function refreshTvApps() {
    try {
      const updates = releaseCopy ? tvAppUpdates({ repo: tvApps.repoVersions(), connected: tvApps.connected() }) : [];
      const found = currentTooling();
      // tooling: every update shown installs by itself here (else Settings gives the manual steps).
      publishTv({ updates, tooling: updates.length ? updates.every((u) => canInstall(u.app, found)) : Boolean(found) });
    } catch (err) {
      log.debug('TV app versions unreadable', { message: err.message });
    }
  }

  // One newer TV app at a time, once per version (a failed try is shown, not repeated), only while the TV is on
  // (a TV asleep would waste the try).
  async function installTvApps() {
    if (tvState.installing || store.get('conn.tv')?.v !== 'on') return;
    const attempted = data.readJson(TV_APPS_FILE, {})?.attempted ?? {};
    const found = currentTooling();
    const next = tvState.updates.find((u) => !attempted[`${u.app}@${u.to}`] && canInstall(u.app, found));
    if (!next || !(await atRelease())) return;
    log.info('installing TV app update', next);
    publishTv({ installing: next.app });
    data.writeJson(TV_APPS_FILE, { attempted: { ...attempted, [`${next.app}@${next.to}`]: true } });
    let result;
    try {
      result = await tvApps.install(next.app, found);
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    publishTv({ installing: null, lastResult: { app: next.app, version: next.to, ok: result.ok === true, error: result.error ?? null, at: now() } });
    refreshTvApps();
  }

  // Applies the newest release, checking again first: local work begun while it waited, another branch or a
  // release withdrawn meanwhile stops it. `retry` ("Try again") also applies a release that failed here.
  async function apply({ retry = false } = {}) {
    if (applying) return status;
    applying = true;
    try {
      await check();
      const ready = status.state === 'available' || (retry && status.state === 'failed');
      if (!ready || !status.tag) {
        applying = false;
        return status;
      }
      // The helper waits for this process and port to go, and goes back to `fromVersion` on a failure.
      const plan = { from: await git.head(), to: status.tag, toVersion: status.latest, fromVersion: version, pid: process.pid, port: httpPort() };
      data.writeJson(STATE_FILE, { phase: 'applying', ...plan, at: now() });
      log.info('applying update', { from: version, to: plan.toVersion });
      publish({ state: 'applying', reason: null });
      spawnHelper(plan);
      requestExit();
      return status;
    } catch (err) {
      applying = false;
      throw err;
    }
  }

  /** "Update now" / "Try again": applies the newest release at once, checking first if needed. */
  async function applyNow() {
    if (!['available', 'waiting', 'failed'].includes(status.state) || !status.tag) await check();
    if (!['available', 'waiting', 'failed'].includes(status.state) || !status.tag) return status;
    return apply({ retry: true });
  }

  // What the helper left in data/update/state.json (read at start, and while it still says 'applying').
  function readOutcome() {
    const st = data.readJson(STATE_FILE, null);
    if (!st || typeof st !== 'object') return;
    if (st.phase === 'applying') {
      if (now() - (st.at ?? 0) > STALE_APPLYING_MS) {
        const failed = { ...st, phase: 'failed', error: 'the update was interrupted' };
        data.writeJson(STATE_FILE, failed);
        failedVersion = st.toVersion ?? null;
        publish({ state: 'failed', latest: st.toVersion ?? null, tag: st.to ?? null, reason: failed.error });
        return;
      }
      publish({ state: 'applying', latest: st.toVersion ?? null, reason: null });
      const t = setTimeout(readOutcome, OUTCOME_POLL_MS);
      t.unref?.();
      timers.push(t);
      return;
    }
    if (st.phase === 'updated') publish({ state: 'updated', latest: st.toVersion ?? null, reason: null, updatedAt: st.at ?? null });
    if (st.phase === 'failed') {
      failedVersion = st.toVersion ?? null;
      publish({ state: 'failed', latest: st.toVersion ?? null, tag: st.to ?? null, reason: st.error ?? 'the update failed' });
    }
  }

  /** Checks now (one check at a time) → the status. Never throws. */
  function check() {
    checking ??= runCheck()
      .catch((err) => publish({ state: 'unreachable', reason: err.message, checkedAt: now() }))
      .finally(() => { checking = null; });
    return checking;
  }

  function setAuto(on) {
    data.writeJson(SETTINGS_FILE, { auto: on === true });
    publish({ auto: on === true });
    if (on === true && status.state === 'available') evaluate();
    return status;
  }

  return {
    check,
    setAuto,
    evaluate,
    applyNow,
    status: () => status,
    start() {
      publish({ auto: readAuto() });
      readOutcome();
      refreshTvApps();
      if (opts.enabled === false) return;
      timers.push(setTimeout(() => check(), opts.firstCheckMs ?? FIRST_CHECK_MS));
      timers.push(setInterval(() => check(), opts.checkEveryMs ?? CHECK_EVERY_MS));
      timers.push(setInterval(() => evaluate(), EVALUATE_EVERY_MS));
      for (const t of timers) t.unref?.();
      removeListener = store.on('patch', (patch) => { if (IDLE_KEYS.some((k) => k in patch) || 'conn.agent' in patch || 'conn.eyes' in patch) evaluate(); });
    },
    async stop() {
      removeListener?.();
      removeListener = null;
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      timers = [];
      await checking?.catch(() => {});
    },
  };
}
