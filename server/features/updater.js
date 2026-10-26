// Automatic updates (docs/superpowers/specs/2026-10-26-auto-updater-design.md). Lumen checks this copy's git
// origin for releases (tags vX.Y.Z made by `npm run release`), and moves to a newer one only by fast-forwarding
// branch master with no local changes. update.status = { current, latest, state, reason, checkedAt, auto }
// where state is idle | checking | up-to-date | available | waiting | applying | updated | failed | left-alone
// | unreachable.
import { REPO_ROOT, VERSION } from '../config.js';
import { createGit } from '../update/git.js';
import { compareVersions } from '../update/versions.js';

const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const SETTINGS_FILE = 'update/settings.json';

export function createUpdater({ config, data, log: rootLog, store, git = createGit({ cwd: REPO_ROOT }), version = VERSION, now = Date.now }) {
  const log = rootLog.child('update');
  const opts = config.update ?? {};
  const meta = { src: 'derived', via: 'update' };
  let status = { current: version, latest: null, state: 'idle', reason: null, checkedAt: null, auto: readAuto() };
  let checking = null;
  let timers = [];

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

  async function runCheck() {
    publish({ state: 'checking', reason: null });
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
    log.info('update available', { from: version, to: newest.version });
    return publish({ state: 'available', latest: newest.version, tag: newest.tag, reason: null, checkedAt: now() });
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
    return publish({ auto: on === true });
  }

  return {
    check,
    setAuto,
    status: () => status,
    start() {
      publish({ auto: readAuto() });
      if (opts.enabled === false) return;
      timers.push(setTimeout(() => check(), opts.firstCheckMs ?? FIRST_CHECK_MS));
      timers.push(setInterval(() => check(), opts.checkEveryMs ?? CHECK_EVERY_MS));
      for (const t of timers) t.unref?.();
    },
    async stop() {
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      timers = [];
      await checking?.catch(() => {});
    },
  };
}
