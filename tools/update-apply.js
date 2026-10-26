// Applies an update that Lumen planned in <dataDir>/update/state.json ({ phase: 'applying', from, to, toVersion })
// and has just shut down for (server/features/updater.js). Started detached and hidden by the server:
//   1. waits for the old Lumen to stop answering (or gives up, changing nothing);
//   2. fast-forwards branch master to the release tag;
//   3. runs `npm ci` if package-lock.json changed;
//   4. starts Lumen (tools/start-hidden.js) and waits for /api/health to report the new version;
//   5. on any failure goes back to the previous commit (reinstalling if needed) and starts that again.
// The outcome goes to state.json (phase 'updated' or 'failed' with error); every step to logs/update.log.
//   node tools/update-apply.js <dataDir> [--repo <dir>] [--port <n>] [--start "<cmd>"] [--npm "<cmd>"]
//                                        [--exit-wait-ms <n>] [--health-wait-ms <n>]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
const port = Number(opt('port', readJson(path.join(dataDir, 'config.json'))?.http?.port ?? 8790));
const startCmd = opt('start', null);
const npmCmd = opt('npm', null);
const statePath = path.join(dataDir, 'update', 'state.json');
const logPath = path.join(dataDir, 'logs', 'update.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const stopped = () => waitUntil(async () => (await health()) === null, exitWaitMs);
const healthy = (version) => waitUntil(async () => { const h = await health(); return h?.ok === true && (!version || h.version === version); }, healthWaitMs);

function start() {
  const { file, args: a } = command(startCmd, { file: process.execPath, args: [path.join(repo, 'tools', 'start-hidden.js')] });
  const child = spawn(file, a, { cwd: repo, detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
}
function npmCi() {
  // --npm names the npm program (a test stand-in); the arguments are always ci --no-audit --no-fund.
  const npm = command(npmCmd, { file: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: process.platform === 'win32' });
  const { file, shell } = npm;
  const a = [...npm.args, 'ci', '--no-audit', '--no-fund'];
  return new Promise((resolve, reject) => {
    const child = spawn(file, a, { cwd: repo, windowsHide: true, stdio: 'ignore', shell });
    const timer = setTimeout(() => child.kill(), NPM_TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`npm ci could not start: ${err.message}`)); });
    child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`npm ci failed (exit ${code})`)); });
  });
}

async function main() {
  const plan = readJson(statePath);
  if (!plan || plan.phase !== 'applying' || !plan.from || !plan.to) {
    log('nothing to apply');
    return 0;
  }
  const finish = (phase, error = null) => writeState({ ...plan, phase, at: Date.now(), ...(error && { error }) });
  log(`update ${plan.from.slice(0, 7)} -> ${plan.to}`);
  if (!(await stopped())) {
    log('Lumen did not stop; nothing changed');
    finish('failed', `Lumen did not stop within ${Math.round(exitWaitMs / 1000)} s; nothing was changed`);
    return 0;
  }
  const git = createGit({ cwd: repo });
  let moved = false;
  let lockChanged = false;
  let error;
  try {
    const toCommit = await git.commitOf(plan.to);
    lockChanged = await git.changed(plan.from, toCommit, 'package-lock.json');
    await git.fastForward(plan.to);
    moved = true;
    log(`moved to ${plan.to}`);
    if (lockChanged) {
      log('package-lock.json changed: npm ci');
      await npmCi();
    }
    start();
    if (!(await healthy(plan.toVersion))) throw new Error(`Lumen ${plan.toVersion} did not answer within ${Math.round(healthWaitMs / 1000)} s`);
    log(`updated to ${plan.toVersion}`);
    finish('updated');
    return 0;
  } catch (err) {
    error = err.message;
  }
  log(`failed: ${error}; rolling back`);
  if (!(await stopped())) log('the new Lumen is still answering; starting the previous one anyway');
  try {
    if (moved) await git.resetHard(plan.from);
    if (moved && lockChanged) await npmCi().catch((err) => log(`rollback ${err.message}`));
  } catch (err) {
    log(`rollback could not restore the previous commit: ${err.message}`);
  }
  start();
  const back = await healthy(null);
  log(back ? 'the previous version is running' : 'the previous version did not start either');
  finish('failed', back ? error : `${error}; the previous version did not start either`);
  return back ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  try { log(`crashed: ${err.stack ?? err.message}`); } catch { /* nothing more to do */ }
  process.exit(1);
});
