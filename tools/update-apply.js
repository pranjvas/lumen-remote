// Applies an update that Lumen planned in <dataDir>/update/state.json ({ phase: 'applying', from, to, toVersion,
// fromVersion, pid, port }) and has just shut down for (server/features/updater.js). Started detached and hidden by
// the server:
//   1. waits for the old Lumen's process to exit and its port to close (or gives up, changing nothing);
//   2. checks the copy is still as Lumen planned it: master, no local changes, at `from` (else changes nothing
//      and starts the previous Lumen again);
//   3. fast-forwards branch master to the release tag;
//   4. if the dependencies changed, sets node_modules aside and runs `npm ci`;
//   5. starts Lumen (tools/start-hidden.js) and waits for /api/health to report the new version;
//   6. on any failure stops what it started, goes back to the previous commit (keeping local edits), puts the
//      previous node_modules back and starts the previous version again.
// The outcome goes to state.json (phase 'updated' or 'failed' with error); every step, and npm's output, to
// logs/update.log.
//   node tools/update-apply.js <dataDir> [--repo <dir>] [--port <n>] [--start "<cmd>"] [--npm "<cmd>"]
//                                        [--exit-wait-ms <n>] [--health-wait-ms <n>] [--npm-timeout-ms <n>]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGit } from '../server/update/git.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXIT_WAIT_MS = 30_000;
const HEALTH_WAIT_MS = 60_000;
const NPM_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 500;

const args = process.argv.slice(2);
const dataDir = path.resolve(args[0] ?? path.join(REPO, 'data'));
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const repo = path.resolve(opt('repo', REPO));
const exitWaitMs = Number(opt('exit-wait-ms', EXIT_WAIT_MS));
const healthWaitMs = Number(opt('health-wait-ms', HEALTH_WAIT_MS));
const npmTimeoutMs = Number(opt('npm-timeout-ms', NPM_TIMEOUT_MS));
const startCmd = opt('start', null);
const npmCmd = opt('npm', null);
const statePath = path.join(dataDir, 'update', 'state.json');
const logPath = path.join(dataDir, 'logs', 'update.log');
const modulesDir = path.join(repo, 'node_modules');
const keptModulesDir = path.join(repo, 'node_modules.lumen-prev'); // the previous install while npm ci runs
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port = 8790; // set in main(): --port, else the plan's, else data/config.json's

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function log(message) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
}
function writeState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${statePath}.tmp`, statePath);
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
    if (await test()) return true;
    await sleep(POLL_MS);
  }
  return test();
}
// Gone: the process has exited (its TV-facing port is freed last, after HTTP) and nothing answers on the port.
const stopped = (pid) => waitUntil(async () => !alive(pid) && (await health()) === null, exitWaitMs);
const healthy = (version) => waitUntil(async () => { const h = await health(); return h?.ok === true && (!version || h.version === version); }, healthWaitMs);

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

function npmCi() {
  // --npm names the npm program (a test stand-in); the arguments are always ci --no-audit --no-fund.
  const npm = command(npmCmd, { file: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: process.platform === 'win32' });
  const { file, shell } = npm;
  const a = [...npm.args, 'ci', '--no-audit', '--no-fund'];
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const out = fs.openSync(logPath, 'a');
  return new Promise((resolve, reject) => {
    const child = spawn(file, a, { cwd: repo, windowsHide: true, stdio: ['ignore', out, out], shell });
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

// node_modules is moved aside before npm ci (which empties it first) and moved back on a rollback: going back
// then needs no network. A leftover from an earlier run is stale (the Lumen that planned this ran without it).
function setModulesAside() {
  if (fs.existsSync(keptModulesDir)) fs.rmSync(keptModulesDir, { recursive: true, force: true, maxRetries: 3 });
  if (!fs.existsSync(modulesDir)) return false;
  fs.renameSync(modulesDir, keptModulesDir);
  return true;
}
function restoreModules() {
  if (!fs.existsSync(keptModulesDir)) return;
  if (fs.existsSync(modulesDir)) {
    try {
      fs.rmSync(modulesDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      fs.renameSync(modulesDir, `${modulesDir}.lumen-failed-${Date.now()}`);
    }
  }
  fs.renameSync(keptModulesDir, modulesDir);
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

async function main() {
  const plan = readJson(statePath);
  if (!plan || plan.phase !== 'applying' || !plan.from || !plan.to) {
    log('nothing to apply');
    return 0;
  }
  port = Number(opt('port', plan.port ?? readJson(path.join(dataDir, 'config.json'))?.http?.port ?? 8790));
  const finish = (phase, error = null) => writeState({ ...plan, phase, at: Date.now(), ...(error && { error }) });
  log(`update ${plan.from.slice(0, 7)} -> ${plan.to}`);
  if (!(await stopped(plan.pid))) {
    log('Lumen did not stop; nothing changed');
    finish('failed', `Lumen did not stop within ${Math.round(exitWaitMs / 1000)} s; nothing was changed`);
    return 0;
  }
  const git = createGit({ cwd: repo });
  let moved = false;
  let modulesAside = false;
  let started = null;
  let error;
  try {
    const toCommit = await git.commitOf(plan.to);
    const why = await changedSincePlan(git, plan, toCommit);
    if (why) {
      log(`the copy changed (${why}); nothing changed`);
      started = start();
      const back = await healthy(plan.fromVersion ?? null);
      log(back ? 'the previous version is running' : 'the previous version did not start');
      finish('failed', `${why}; nothing was changed`);
      return back ? 0 : 1;
    }
    const deps = await git.depsChanged(plan.from, toCommit);
    if (deps) modulesAside = setModulesAside();
    try {
      await git.fastForward(plan.to);
    } catch (err) {
      // A move that failed part-way (a locked file) can leave files changed: set them aside, never delete them.
      if (await git.isDirty().catch(() => false)) await git.setAside(`Lumen update to ${plan.to}: left by a failed move`).catch(() => {});
      throw err;
    }
    moved = true;
    log(`moved to ${plan.to}`);
    if (deps) {
      log('dependencies changed: npm ci');
      await npmCi();
    }
    started = start();
    if (!(await healthy(plan.toVersion))) throw new Error(`Lumen ${plan.toVersion} did not answer within ${Math.round(healthWaitMs / 1000)} s`);
    log(`updated to ${plan.toVersion}`);
    finish('updated');
    if (modulesAside) {
      try { fs.rmSync(keptModulesDir, { recursive: true, force: true, maxRetries: 3 }); } catch (err) { log(`could not remove the previous node_modules: ${err.message}`); }
    }
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
    if (modulesAside) restoreModules();
  } catch (err) {
    log(`rollback could not put node_modules back: ${err.message}`);
  }
  start();
  const back = await healthy(plan.fromVersion ?? null);
  log(back ? 'the previous version is running' : 'the previous version did not start either');
  finish('failed', back ? error : `${error}; the previous version did not start either`);
  return back ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  try { log(`crashed: ${err.stack ?? err.message}`); } catch { /* nothing more to do */ }
  process.exit(1);
});
