// Applies an update that Lumen planned in <dataDir>/update/state.json ({ phase: 'applying', from, to, toVersion,
// fromVersion, pid, port }) and has just shut down for (server/features/updater.js). Started detached and hidden by
// the server:
//   1. waits for the old Lumen's process to exit and its port to close; one that hangs is stopped and started
//      again, with nothing changed;
//   2. checks the copy is still as Lumen planned it: master, no local changes, at `from` (else changes nothing
//      and starts the previous Lumen again);
//   3. if the dependencies changed, runs `npm ci` in a staging folder (.lumen-update) from the release's
//      package.json and lockfile; the working node_modules stays in place, so a PC switched off meanwhile still
//      starts the previous version;
//   4. fast-forwards branch master to the release tag (a move stopped part-way leaves nothing behind) and swaps
//      the new node_modules in;
//   5. starts Lumen (tools/start-hidden.js) and waits for /api/health to report the new version ready, then
//      checks it is still up a little later;
//   6. on any failure stops what it started, goes back to the previous commit (keeping local edits), puts the
//      previous node_modules back and starts the previous version again.
// The outcome goes to state.json (phase 'updated' or 'failed' with error); every step, and npm's output, to
// logs/update.log.
//   node tools/update-apply.js <dataDir> [--repo <dir>] [--port <n>] [--start "<cmd>"] [--npm "<cmd>"]
//     [--exit-wait-ms <n>] [--health-wait-ms <n>] [--stable-ms <n>] [--npm-timeout-ms <n>]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGit } from '../server/update/git.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXIT_WAIT_MS = 30_000;
const HEALTH_WAIT_MS = 60_000;
const STABLE_MS = 15_000; // a new version must still answer this long after it first said it was ready
const NPM_TIMEOUT_MS = 10 * 60 * 1000;
const RENAME_RETRY_MS = 20_000; // Windows: a virus scanner or indexer can hold a file for a moment
const POLL_MS = 500;

const args = process.argv.slice(2);
const dataDir = path.resolve(args[0] ?? path.join(REPO, 'data'));
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const repo = path.resolve(opt('repo', REPO));
const exitWaitMs = Number(opt('exit-wait-ms', EXIT_WAIT_MS));
const healthWaitMs = Number(opt('health-wait-ms', HEALTH_WAIT_MS));
const stableMs = Number(opt('stable-ms', STABLE_MS));
const npmTimeoutMs = Number(opt('npm-timeout-ms', NPM_TIMEOUT_MS));
const startCmd = opt('start', null);
const npmCmd = opt('npm', null);
const statePath = path.join(dataDir, 'update', 'state.json');
const logPath = path.join(dataDir, 'logs', 'update.log');
const modulesDir = path.join(repo, 'node_modules');
const keptModulesDir = path.join(repo, 'node_modules.lumen-prev'); // the previous install until the new one runs
const stagingDir = path.join(repo, '.lumen-update'); // the new install is made here first
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port = 8790; // set in main(): --port, else the plan's, else data/config.json's

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function log(message) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch { /* a log line is not worth failing an update for */ }
}
// fs.renameSync, retried while Windows reports the file busy (EPERM, EBUSY, EACCES).
function renameRetry(from, to) {
  const end = Date.now() + RENAME_RETRY_MS;
  for (let wait = 50; ; wait = Math.min(wait * 2, 1000)) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || Date.now() >= end) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}
function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch (err) { log(`could not remove ${path.basename(dir)}: ${err.message}`); }
}
function writeState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2));
  renameRetry(`${statePath}.tmp`, statePath);
}
// A command line split on spaces; a leading "node" is this Node.
function command(line, fallback) {
  if (!line) return fallback;
  const [file, ...rest] = line.split(' ').filter(Boolean);
  return { file: file === 'node' ? process.execPath : file, args: rest, shell: false };
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}
// A process and everything it started (npm's own children; the server's Edge).
function killTree(pid) {
  if (!alive(pid)) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** /api/health → its JSON, or null when nothing answers. */
function health() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
async function waitUntil(test, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await test();
    if (value) return value;
    await sleep(POLL_MS);
  }
  return test();
}
// Gone: the process has exited (its TV-facing port is freed last, after HTTP) and nothing answers on the port.
const stopped = (pid) => waitUntil(async () => !alive(pid) && (await health()) === null, exitWaitMs);
// Lumen answering (as `version` when given; `ready` once its start-up has finished) → its health, or null.
const healthy = (version, { ready = false } = {}) => waitUntil(async () => {
  const h = await health();
  return h?.ok === true && (!version || h.version === version) && (!ready || h.ready === true) ? h : null;
}, healthWaitMs);

/** Starts Lumen → { pid } of the server once known (start-hidden.js says it; a --start command is the server). */
function start() {
  const { file, args: a } = command(startCmd, { file: process.execPath, args: [path.join(repo, 'tools', 'start-hidden.js')] });
  const child = spawn(file, a, { cwd: repo, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const started = { pid: child.pid };
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
    const m = /\(pid (\d+)\)/.exec(out);
    if (m) started.pid = Number(m[1]);
  });
  child.stdout.on('error', () => {});
  child.unref();
  return started;
}
/** Stops a Lumen this helper started, and whatever still answers on the port, and waits for them to go. */
async function stopStarted(started) {
  const answering = (await health())?.pid;
  for (const pid of new Set([started?.pid, answering].filter(Boolean))) killTree(pid);
  return stopped(started?.pid ?? answering);
}
/** Starts the previous version again → whether it came up. */
async function startPrevious(plan) {
  start();
  const back = await healthy(plan.fromVersion ?? null);
  log(back ? 'the previous version is running' : 'the previous version did not start');
  return Boolean(back);
}

function npmCi(cwd) {
  // --npm names the npm program (a test stand-in); the arguments are always ci --no-audit --no-fund.
  const npm = command(npmCmd, { file: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: process.platform === 'win32' });
  const { file, shell } = npm;
  const a = [...npm.args, 'ci', '--no-audit', '--no-fund'];
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const out = fs.openSync(logPath, 'a');
  return new Promise((resolve, reject) => {
    const child = spawn(file, a, { cwd, windowsHide: true, stdio: ['ignore', out, out], shell });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, npmTimeoutMs);
    const done = (fn) => { clearTimeout(timer); try { fs.closeSync(out); } catch { /* closed */ } fn(); };
    child.on('error', (err) => done(() => reject(new Error(`npm ci could not start: ${err.message}`))));
    child.on('close', (code) => done(() => {
      if (timedOut) reject(new Error(`npm ci did not finish within ${Math.round(npmTimeoutMs / 1000)} s`));
      else if (code === 0) resolve();
      else reject(new Error(`npm ci failed (exit ${code})`));
    }));
  });
}

// The release's dependencies, installed in the staging folder while the working node_modules stays in place.
async function stageInstall(git, toCommit) {
  removeDir(stagingDir);
  fs.mkdirSync(stagingDir, { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) {
    const text = await git.fileAt(toCommit, file);
    if (text !== null) fs.writeFileSync(path.join(stagingDir, file), text);
  }
  log('dependencies changed: npm ci (staging)');
  await npmCi(stagingDir);
}
// The staged node_modules in, the previous one kept aside (→ true once swapped).
function swapModules() {
  const fresh = path.join(stagingDir, 'node_modules');
  if (!fs.existsSync(fresh)) fs.mkdirSync(fresh, { recursive: true });
  if (fs.existsSync(keptModulesDir)) removeDir(keptModulesDir); // a stale leftover: the Lumen that planned this ran without it
  const hadModules = fs.existsSync(modulesDir);
  if (hadModules) renameRetry(modulesDir, keptModulesDir);
  try {
    renameRetry(fresh, modulesDir);
  } catch (err) {
    if (hadModules) renameRetry(keptModulesDir, modulesDir);
    throw err;
  }
  return true;
}
function restoreModules() {
  if (!fs.existsSync(keptModulesDir)) return;
  if (fs.existsSync(modulesDir)) {
    try {
      fs.rmSync(modulesDir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      renameRetry(modulesDir, `${modulesDir}.lumen-failed-${Date.now()}`);
    }
  }
  renameRetry(keptModulesDir, modulesDir);
}

// Why the copy is no longer as Lumen planned it (so nothing may move), or null.
async function changedSincePlan(git, plan, toCommit) {
  const branch = await git.branch();
  if (branch !== 'master') return branch ? `on branch ${branch}` : 'not on a branch';
  if (await git.isDirty()) return 'local changes';
  if ((await git.head()) !== plan.from) return 'not at the commit Lumen planned from';
  if (!(await git.isAncestor(plan.from, toCommit))) return 'the release is not ahead of this copy';
  return null;
}

// Fast-forward; a move stopped part-way (a file locked by another program) leaves files changed and the release's
// new files behind: the changed ones are set aside (git stash, recoverable), the new ones removed, so the next try
// starts clean.
async function moveTo(git, plan, toCommit) {
  const added = await git.addedFiles(plan.from, toCommit);
  const there = new Set(added.filter((f) => fs.existsSync(path.join(repo, f))));
  try {
    await git.fastForward(plan.to);
  } catch (err) {
    for (const f of added) {
      if (!there.has(f)) try { fs.rmSync(path.join(repo, f), { force: true }); } catch { /* still locked */ }
    }
    if (await git.isDirty().catch(() => false)) await git.setAside(`Lumen update to ${plan.to}: left by a failed move`).catch((e) => log(`could not set aside: ${e.message}`));
    throw err;
  }
}

async function main() {
  const plan = readJson(statePath);
  if (!plan || plan.phase !== 'applying' || !plan.from || !plan.to) {
    log('nothing to apply');
    return 0;
  }
  port = Number(opt('port', plan.port ?? readJson(path.join(dataDir, 'config.json'))?.http?.port ?? 8790));
  const finish = (phase, error = null) => {
    try {
      writeState({ ...plan, phase, at: Date.now(), ...(error && { error }) });
    } catch (err) {
      log(`could not record the outcome (${phase}): ${err.message}`);
    }
  };
  log(`update ${plan.from.slice(0, 7)} -> ${plan.to}`);
  if (!(await stopped(plan.pid))) {
    const waited = `Lumen did not stop within ${Math.round(exitWaitMs / 1000)} s`;
    if (alive(plan.pid)) {
      log(`${waited}; stopping it`);
      killTree(plan.pid);
      if (await stopped(plan.pid)) {
        const back = await startPrevious(plan);
        finish('failed', `${waited}; it was stopped and started again; nothing was changed`);
        return back ? 0 : 1;
      }
    }
    log(`${waited}; nothing changed`);
    finish('failed', `${waited}; nothing was changed`);
    return 0;
  }
  const git = createGit({ cwd: repo });
  let moved = false;
  let swapped = false;
  let started = null;
  let error;
  try {
    const toCommit = await git.commitOf(plan.to);
    const why = await changedSincePlan(git, plan, toCommit);
    if (why) {
      log(`the copy changed (${why}); nothing changed`);
      const back = await startPrevious(plan);
      finish('failed', `${why}; nothing was changed`);
      return back ? 0 : 1;
    }
    const deps = await git.depsChanged(plan.from, toCommit);
    if (deps) await stageInstall(git, toCommit);
    await moveTo(git, plan, toCommit);
    moved = true;
    log(`moved to ${plan.to}`);
    if (deps) swapped = swapModules();
    started = start();
    const first = await healthy(plan.toVersion, { ready: true });
    if (!first) throw new Error(`Lumen ${plan.toVersion} did not answer within ${Math.round(healthWaitMs / 1000)} s`);
    await sleep(stableMs);
    const later = await health();
    if (!(later?.ok === true && later.version === plan.toVersion && later.pid === first.pid)) {
      throw new Error(`Lumen ${plan.toVersion} started but did not stay up`);
    }
    log(`updated to ${plan.toVersion}`);
    finish('updated');
    if (swapped) removeDir(keptModulesDir);
    removeDir(stagingDir);
    return 0;
  } catch (err) {
    error = err.message;
  }
  log(`failed: ${error}; rolling back`);
  if (started && !(await stopStarted(started))) log('the new Lumen is still running after being stopped');
  try {
    if (moved) await git.resetKeep(plan.from);
  } catch (err) {
    log(`rollback could not restore the previous commit: ${err.message}`);
  }
  try {
    if (swapped) restoreModules();
  } catch (err) {
    log(`rollback could not put node_modules back: ${err.message}`);
  }
  removeDir(stagingDir);
  const back = await startPrevious(plan);
  finish('failed', back ? error : `${error}; the previous version did not start either`);
  return back ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  try { log(`crashed: ${err.stack ?? err.message}`); } catch { /* nothing more to do */ }
  process.exit(1);
});
