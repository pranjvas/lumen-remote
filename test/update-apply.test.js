// The update helper (tools/update-apply.js) end to end on a throwaway repo: it waits for the old Lumen's process to
// exit, checks the copy is still as Lumen planned, installs changed dependencies in a staging folder first (the
// working node_modules stays until the new one is complete), fast-forwards to the release, swaps node_modules in,
// starts Lumen and checks it comes up ready and stays up; on any failure it stops what it started, goes back to the
// previous commit keeping local edits, puts node_modules back and starts the previous version again. The "server"
// here is a tiny script answering /api/health with the version in its package.json; "npm" is a stand-in that
// records calls and can fail, delete node_modules, edit a file or hang.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const HELPER = path.resolve('tools/update-apply.js');
let root, origin, repo, dataDir, fakeNpm, npmLog;
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The fake server: listens on the port given (and a second, "TV-facing" port if given; either taken → it exits),
// answers /api/health with package.json's version and its pid, writes its pid.
const GOOD_SERVER = `const http = require('http'); const fs = require('fs');
const v = JSON.parse(fs.readFileSync(__dirname + '/package.json', 'utf8')).version;
fs.writeFileSync(__dirname + '/server.pid', String(process.pid));
const fail = () => process.exit(1);
http.createServer((q, s) => { s.end(JSON.stringify({ ok: true, app: 'lumen', version: v, pid: process.pid, ready: true })); }).on('error', fail).listen(Number(process.argv[2]), '127.0.0.1');
if (process.argv[3]) require('net').createServer().on('error', fail).listen(Number(process.argv[3]), '127.0.0.1');`;
const BAD_SERVER = `process.exit(1);`;
// Comes up ready, then dies (a release that crashes moments after start-up).
const CRASHING_SERVER = `const v = JSON.parse(require('fs').readFileSync(__dirname + '/package.json', 'utf8')).version;
require('http').createServer((q, s) => s.end(JSON.stringify({ ok: true, app: 'lumen', version: v, pid: process.pid, ready: true }))).listen(Number(process.argv[2]), '127.0.0.1');
setTimeout(() => process.exit(1), 1200);`;
// An old Lumen that hangs instead of exiting: answers, never stops. (node -e: arguments start at argv[1].)
const HUNG_SERVER = `require('http').createServer((q, s) => s.end(JSON.stringify({ ok: true, app: 'lumen', version: 'old', pid: process.pid }))).listen(Number(process.argv[1]), '127.0.0.1');`;
// Answers, but never as the version expected (a release that comes up wrong, or too slowly to count).
const WRONG_SERVER = `require('fs').writeFileSync(__dirname + '/wrong.pid', String(process.pid));
require('http').createServer((q, s) => s.end(JSON.stringify({ ok: true, app: 'lumen', version: '9.9.9', pid: process.pid }))).listen(Number(process.argv[2]), '127.0.0.1');`;
// The old Lumen part-way through stopping: its HTTP port already closed, its TV-facing port still held for a while.
// (Run with node -e: its arguments start at argv[1].)
const STOPPING_SERVER = `const lan = require('net').createServer().listen(Number(process.argv[1]), '127.0.0.1');
setTimeout(() => lan.close(() => process.exit(0)), Number(process.argv[2]));`;
const FAKE_NPM = `const fs = require('fs'); const path = require('path');
fs.appendFileSync(process.env.FAKE_NPM_LOG, process.argv.slice(2).join(' ') + '\\n');
console.log('fake npm output');
if (process.env.FAKE_NPM_RM_MODULES) fs.rmSync(path.join(process.cwd(), 'node_modules'), { recursive: true, force: true });
// The edit stands for the owner's, made once while the update runs (not again by a second npm run).
if (process.env.FAKE_NPM_EDIT && fs.readFileSync(process.env.FAKE_NPM_LOG, 'utf8').trim().split('\\n').length === 1) fs.writeFileSync(process.env.FAKE_NPM_EDIT_FILE, process.env.FAKE_NPM_EDIT);
if (process.env.FAKE_NPM_HANG) {
  const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.FAKE_NPM_HANG, String(c.pid));
  setInterval(() => {}, 1000);
} else if (process.env.FAKE_NPM_FAIL) process.exit(1);
else {
  fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'node_modules', 'installed.txt'), 'new install');
}`;

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
function release(version, { server = GOOD_SERVER, lock = null } = {}) {
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'lumen-remote', version }));
  fs.writeFileSync(path.join(repo, 'server.js'), server);
  if (lock) fs.writeFileSync(path.join(repo, 'package-lock.json'), lock);
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', `Release v${version}`);
  sh(repo, 'tag', '-a', `v${version}`, '-m', `v${version}`);
  return sh(repo, 'rev-parse', 'HEAD');
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
function killPidFile(file) {
  try { process.kill(Number(fs.readFileSync(path.join(repo, file), 'utf8')), 'SIGKILL'); } catch { /* not running */ }
  try { fs.rmSync(path.join(repo, file)); } catch { /* none */ }
}
function killServer() {
  killPidFile('server.pid');
  killPidFile('wrong.pid');
}
function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
const version = () => JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
function plan(from, to, toVersion, extra = {}) {
  fs.mkdirSync(path.join(dataDir, 'update'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'update', 'state.json'), JSON.stringify({ phase: 'applying', from, to, toVersion, fromVersion: version(), at: Date.now(), ...extra }));
}
const outcome = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'update', 'state.json'), 'utf8'));
const updateLog = () => fs.readFileSync(path.join(dataDir, 'logs', 'update.log'), 'utf8');
function runHelper(port, { npm = {}, exitWaitMs = 2000, healthWaitMs = 4000, stableMs = 300, lanPort = null, npmTimeoutMs = null, onStart = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HELPER, dataDir, '--repo', repo, '--port', String(port), '--start', `node server.js ${port}${lanPort ? ` ${lanPort}` : ''}`,
      '--npm', `node ${fakeNpm}`, '--exit-wait-ms', String(exitWaitMs), '--health-wait-ms', String(healthWaitMs), '--stable-ms', String(stableMs),
      ...(npmTimeoutMs ? ['--npm-timeout-ms', String(npmTimeoutMs)] : [])],
    { env: { ...process.env, FAKE_NPM_LOG: npmLog, FAKE_NPM_FAIL: npm.fail ? '1' : '', FAKE_NPM_RM_MODULES: npm.rmModules ? '1' : '', FAKE_NPM_EDIT: npm.edit ?? '',
      FAKE_NPM_EDIT_FILE: path.join(repo, 'notes.txt'), FAKE_NPM_HANG: npm.hang ?? '' }, stdio: 'ignore' });
    onStart?.(child);
    child.on('close', (code) => resolve(code));
  });
}
// Holds `file` open the way an editor or a virus scanner does (others may read it, not replace or delete it) for
// `ms`, resolving once the lock is in place.
async function lockFile(file, ms) {
  const marker = `${file}.locked`;
  fs.rmSync(marker, { force: true });
  const ps = spawn('powershell', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${file}', 'Open', 'Read', 'Read'); Set-Content -LiteralPath '${marker}' x; Start-Sleep -Milliseconds ${ms}; $f.Close(); Remove-Item -LiteralPath '${marker}'`], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await sleep(100);
  assert.ok(fs.existsSync(marker), 'the lock is in place');
  return ps;
}
// Each test starts from where the previous one left the copy (the release it moved to, or the one it went back
// to), clean.
function atNewest() {
  sh(repo, 'reset', '-q', '--hard', 'HEAD');
  return sh(repo, 'rev-parse', 'HEAD');
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-update-apply-'));
  dataDir = path.join(root, 'data');
  fakeNpm = path.join(root, 'fakenpm.js');
  npmLog = path.join(root, 'npm.log');
  fs.writeFileSync(fakeNpm, FAKE_NPM);
  origin = path.join(root, 'origin.git');
  repo = path.join(root, 'repo');
  sh(root, 'init', '-q', '--bare', '-b', 'master', origin);
  sh(root, 'clone', '-q', origin, repo);
  sh(repo, 'config', 'user.email', 't@example.invalid');
  sh(repo, 'config', 'user.name', 'T');
  sh(repo, 'checkout', '-q', '-B', 'master');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\nnode_modules.*/\n.lumen-update/\n*.pid\n*.locked\n');
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'original');
  release('0.1.0', { lock: '{"v":0}' });
});
after(async () => {
  killServer();
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(root, { recursive: true, force: true }); return; } catch { await sleep(300); }
  }
});

test('happy path: waits for the old Lumen to stop, moves to the release, no reinstall when the lockfile is the same, starts it healthy', async () => {
  try {
    const port = await freePort();
    const from = release('0.2.0', { lock: '{"v":1}' });
    const to = release('0.3.0');
    sh(repo, 'reset', '-q', '--hard', from);
    fs.writeFileSync(npmLog, '');
    plan(from, 'v0.3.0', '0.3.0');
    assert.equal(await runHelper(port), 0);
    assert.equal(outcome().phase, 'updated');
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), to);
    assert.equal((await health(port))?.version, '0.3.0');
    assert.equal(fs.readFileSync(npmLog, 'utf8'), '', 'npm not run');
    assert.ok(fs.existsSync(path.join(dataDir, 'logs', 'update.log')));
  } finally {
    killServer();
  }
});

test('a changed package-lock.json reinstalls with npm ci in a staging folder (output in update.log), swapped in, the old install dropped once healthy', async () => {
  try {
    const port = await freePort();
    const from = atNewest();
    fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'marker.txt'), 'previous install');
    release('0.4.0', { lock: '{"v":2}' });
    sh(repo, 'reset', '-q', '--hard', from);
    fs.writeFileSync(npmLog, '');
    plan(from, 'v0.4.0', '0.4.0');
    assert.equal(await runHelper(port), 0);
    assert.equal(outcome().phase, 'updated');
    assert.match(fs.readFileSync(npmLog, 'utf8'), /^ci/m);
    assert.match(updateLog(), /fake npm output/, "npm's output is in update.log");
    assert.equal(fs.existsSync(path.join(repo, 'node_modules.lumen-prev')), false, 'the set-aside copy is gone after a good update');
    assert.equal(fs.readFileSync(path.join(repo, 'node_modules', 'installed.txt'), 'utf8'), 'new install', 'the new install is in place');
    assert.equal(fs.existsSync(path.join(repo, 'node_modules', 'marker.txt')), false, 'the old install is gone');
    assert.equal(fs.existsSync(path.join(repo, '.lumen-update')), false, 'the staging folder is cleaned up');
  } finally {
    killServer();
  }
});

test('a lockfile that differs only in its own version (every release bumps it) does not reinstall', async () => {
  try {
    const port = await freePort();
    const lock = (v) => JSON.stringify({ name: 'lumen-remote', version: v, lockfileVersion: 3, packages: { '': { name: 'lumen-remote', version: v }, 'node_modules/ws': { version: '8.0.0' } } }, null, 2);
    const from = release('0.4.1', { lock: lock('0.4.1') });
    release('0.4.2', { lock: lock('0.4.2') });
    sh(repo, 'reset', '-q', '--hard', from);
    fs.writeFileSync(npmLog, '');
    plan(from, 'v0.4.2', '0.4.2');
    assert.equal(await runHelper(port), 0);
    assert.equal(outcome().phase, 'updated');
    assert.equal(fs.readFileSync(npmLog, 'utf8'), '', 'npm not run for a version bump');
  } finally {
    killServer();
  }
});

test('a release that does not start is rolled back: the previous version runs again and the failure is recorded', async () => {
  try {
    const port = await freePort();
    const from = atNewest();
    const fromVersion = version();
    release('0.5.0', { server: BAD_SERVER });
    sh(repo, 'reset', '-q', '--hard', from);
    plan(from, 'v0.5.0', '0.5.0');
    assert.equal(await runHelper(port), 0, 'a successful rollback is not a crash');
    const o = outcome();
    assert.equal(o.phase, 'failed');
    assert.match(o.error, /did not answer|did not start/i);
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), from, 'back on the previous commit');
    assert.equal((await health(port))?.version, fromVersion, 'the previous version is running');
  } finally {
    killServer();
  }
});

test('npm ci failing rolls back too', async () => {
  try {
    const port = await freePort();
    const from = atNewest();
    const fromVersion = version();
    release('0.6.0', { lock: '{"v":3}' });
    sh(repo, 'reset', '-q', '--hard', from);
    plan(from, 'v0.6.0', '0.6.0');
    assert.equal(await runHelper(port, { npm: { fail: true } }), 0);
    assert.equal(outcome().phase, 'failed');
    assert.match(outcome().error, /npm/i);
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), from);
    assert.equal((await health(port))?.version, fromVersion);
  } finally {
    killServer();
  }
});

test('npm ci that empties node_modules and fails (offline): the previous node_modules is put back, not reinstalled', async () => {
  try {
    const port = await freePort();
    const from = atNewest();
    const fromVersion = version();
    fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'marker.txt'), 'previous install');
    release('0.6.1', { lock: '{"v":4}' });
    sh(repo, 'reset', '-q', '--hard', from);
    fs.writeFileSync(npmLog, '');
    plan(from, 'v0.6.1', '0.6.1');
    assert.equal(await runHelper(port, { npm: { fail: true, rmModules: true } }), 0);
    assert.equal(outcome().phase, 'failed');
    assert.equal(fs.readFileSync(path.join(repo, 'node_modules', 'marker.txt'), 'utf8'), 'previous install', 'the previous install is back');
    assert.equal(fs.existsSync(path.join(repo, 'node_modules.lumen-prev')), false);
    assert.equal(fs.readFileSync(npmLog, 'utf8').trim().split('\n').length, 1, 'npm ci is not run again for the rollback');
    assert.equal((await health(port))?.version, fromVersion);
  } finally {
    killServer();
  }
});

test('npm ci that hangs is stopped with everything it started, and rolled back', async () => {
  const grandchild = path.join(root, 'grandchild.pid');
  try {
    const port = await freePort();
    const from = atNewest();
    release('0.6.2', { lock: '{"v":5}' });
    sh(repo, 'reset', '-q', '--hard', from);
    plan(from, 'v0.6.2', '0.6.2');
    assert.equal(await runHelper(port, { npm: { hang: grandchild }, npmTimeoutMs: 1500 }), 0);
    assert.equal(outcome().phase, 'failed');
    assert.match(outcome().error, /npm/i);
    const pid = Number(fs.readFileSync(grandchild, 'utf8'));
    await sleep(500);
    assert.equal(alive(pid), false, "npm's own child processes are stopped too");
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), from);
  } finally {
    try { process.kill(Number(fs.readFileSync(grandchild, 'utf8')), 'SIGKILL'); } catch { /* gone */ }
    killServer();
  }
});

test('going back keeps a local edit made while the update ran, and the previous node_modules', async () => {
  try {
    const port = await freePort();
    const from = atNewest();
    fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'marker.txt'), 'previous install');
    release('0.6.3', { lock: '{"v":6}', server: BAD_SERVER });
    sh(repo, 'reset', '-q', '--hard', from);
    fs.writeFileSync(npmLog, '');
    plan(from, 'v0.6.3', '0.6.3');
    assert.equal(await runHelper(port, { npm: { edit: 'edited during the update' } }), 0);
    assert.equal(outcome().phase, 'failed');
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), from);
    assert.equal(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8'), 'edited during the update', 'the edit survives the rollback');
    assert.equal(fs.readFileSync(path.join(repo, 'node_modules', 'marker.txt'), 'utf8'), 'previous install', 'the previous install is back');
  } finally {
    sh(repo, 'checkout', '-q', '--', 'notes.txt');
    killServer();
  }
});

test('the copy changed after Lumen planned the update (local edits, or another commit checked out): nothing is moved and the previous Lumen is started again', async () => {
  try {
    const port = await freePort();
    const from = atNewest();
    const fromVersion = version();
    release('0.7.0');
    sh(repo, 'reset', '-q', '--hard', from);
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'work in progress');
    plan(from, 'v0.7.0', '0.7.0');
    assert.equal(await runHelper(port), 0);
    assert.equal(outcome().phase, 'failed');
    assert.match(outcome().error, /local changes/);
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), from, 'not moved');
    assert.equal(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8'), 'work in progress', 'the edit untouched');
    assert.equal((await health(port))?.version, fromVersion, 'the previous Lumen is running again');
    killServer();
    sh(repo, 'checkout', '-q', '--', 'notes.txt');

    plan(sh(repo, 'rev-parse', 'HEAD~1'), 'v0.7.0', '0.7.0');
    assert.equal(await runHelper(port), 0);
    assert.equal(outcome().phase, 'failed');
    assert.match(outcome().error, /not at the commit/);
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), from, 'not moved');
  } finally {
    killServer();
  }
});

test('the old Lumen is still exiting after its HTTP port closed: the new one is started only once its process is gone', async () => {
  let old;
  try {
    const port = await freePort();
    const lanPort = await freePort();
    const from = atNewest();
    release('0.8.0');
    sh(repo, 'reset', '-q', '--hard', from);
    old = spawn(process.execPath, ['-e', STOPPING_SERVER, String(lanPort), '6000'], { stdio: 'ignore' });
    await sleep(300);
    plan(from, 'v0.8.0', '0.8.0', { pid: old.pid });
    assert.equal(await runHelper(port, { lanPort, exitWaitMs: 12000 }), 0);
    assert.equal(outcome().phase, 'updated', outcome().error);
    assert.equal((await health(port))?.version, '0.8.0');
  } finally {
    old?.kill();
    killServer();
  }
});

test('a new version that answers but never as itself is stopped before going back; only the previous version counts as recovered', async () => {
  try {
    const port = await freePort();
    const from = atNewest();
    const fromVersion = version();
    release('0.9.0', { server: WRONG_SERVER });
    sh(repo, 'reset', '-q', '--hard', from);
    plan(from, 'v0.9.0', '0.9.0');
    assert.equal(await runHelper(port, { healthWaitMs: 2500 }), 0);
    assert.equal(outcome().phase, 'failed');
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), from);
    const h = await health(port);
    assert.equal(h?.version, fromVersion, `the previous version runs, not the new one (${JSON.stringify(h)})`);
  } finally {
    killServer();
  }
});

test('an old Lumen that never stops: nothing is moved, no second Lumen is started, the update is recorded as failed', async () => {
  const port = await freePort();
  const from = atNewest();
  killServer();
  const stuck = http.createServer((q, s) => s.end(JSON.stringify({ ok: true, app: 'lumen', version: '0.4.0' }))).listen(port, '127.0.0.1');
  try {
    plan(from, 'v0.9.0', '0.9.0');
    assert.equal(await runHelper(port, { exitWaitMs: 1500 }), 0);
    assert.equal(outcome().phase, 'failed');
    assert.match(outcome().error, /did not stop/i);
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), from);
    assert.equal(fs.existsSync(path.join(repo, 'server.pid')), false, 'no second server started');
  } finally {
    stuck.close();
  }
});

test('the PC switched off while npm ci runs: the working node_modules is still in place and the copy has not moved', async () => {
  const grandchild = path.join(root, 'grandchild2.pid');
  try {
    const from = atNewest();
    fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'marker.txt'), 'previous install');
    release('0.10.0', { lock: '{"v":10}' });
    sh(repo, 'reset', '-q', '--hard', from);
    plan(from, 'v0.10.0', '0.10.0');
    const port = await freePort();
    await runHelper(port, {
      npm: { hang: grandchild },
      onStart: (child) => {
        // The helper is killed (shut-down, sign-out) once npm ci is under way.
        const t = setInterval(() => {
          if (!fs.existsSync(grandchild)) return;
          clearInterval(t);
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        }, 100);
      },
    });
    assert.equal(fs.readFileSync(path.join(repo, 'node_modules', 'marker.txt'), 'utf8'), 'previous install', 'Lumen can still start from this copy');
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), from, 'not moved before the new install was complete');
  } finally {
    try { process.kill(Number(fs.readFileSync(grandchild, 'utf8')), 'SIGKILL'); } catch { /* gone */ }
    killServer();
  }
});

test('a state file briefly locked by another program (a virus scanner) does not undo a good update', { skip: process.platform !== 'win32' }, async () => {
  let ps;
  try {
    const port = await freePort();
    const from = atNewest();
    release('0.11.0');
    sh(repo, 'reset', '-q', '--hard', from);
    plan(from, 'v0.11.0', '0.11.0');
    ps = await lockFile(path.join(dataDir, 'update', 'state.json'), 7000);
    assert.equal(await runHelper(port), 0);
    assert.equal(outcome().phase, 'updated', outcome().error);
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), sh(repo, 'rev-parse', 'v0.11.0^{commit}'));
    assert.equal((await health(port))?.version, '0.11.0');
  } finally {
    ps?.kill();
    killServer();
  }
});

test('a release that comes up and then crashes is rolled back: it must stay up before it counts', async () => {
  try {
    const port = await freePort();
    const from = atNewest();
    const fromVersion = version();
    release('0.12.0', { server: CRASHING_SERVER });
    sh(repo, 'reset', '-q', '--hard', from);
    plan(from, 'v0.12.0', '0.12.0');
    assert.equal(await runHelper(port, { stableMs: 3000 }), 0);
    assert.equal(outcome().phase, 'failed');
    assert.match(outcome().error, /did not stay up|stopped/i);
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), from);
    assert.equal((await health(port))?.version, fromVersion);
  } finally {
    killServer();
  }
});

test('an old Lumen that hangs instead of exiting is stopped and started again, with nothing changed', async () => {
  let old;
  try {
    const port = await freePort();
    const from = atNewest();
    const fromVersion = version();
    release('0.13.0');
    sh(repo, 'reset', '-q', '--hard', from);
    old = spawn(process.execPath, ['-e', HUNG_SERVER, String(port)], { stdio: 'ignore' });
    for (let i = 0; i < 50 && !(await health(port)); i++) await sleep(100);
    plan(from, 'v0.13.0', '0.13.0', { pid: old.pid });
    assert.equal(await runHelper(port, { exitWaitMs: 1500 }), 0);
    assert.equal(outcome().phase, 'failed');
    assert.match(outcome().error, /did not stop/i);
    assert.equal(alive(old.pid), false, 'the hung Lumen was stopped');
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), from, 'nothing moved');
    assert.equal((await health(port))?.version, fromVersion, 'Lumen is running again');
  } finally {
    old?.kill();
    killServer();
  }
});

test('a move stopped part-way by a locked file leaves nothing behind, so the next try can succeed', { skip: process.platform !== 'win32' }, async () => {
  let ps;
  try {
    const port = await freePort();
    const from = atNewest();
    fs.writeFileSync(path.join(repo, 'zz-last.txt'), 'old');
    sh(repo, 'add', 'zz-last.txt');
    sh(repo, 'commit', '-q', '-m', 'a file the next release changes');
    const base = sh(repo, 'rev-parse', 'HEAD');
    const v = version();
    fs.writeFileSync(path.join(repo, 'aa-added.txt'), 'added by the release');
    fs.writeFileSync(path.join(repo, 'zz-last.txt'), 'new');
    release('0.14.0');
    sh(repo, 'reset', '-q', '--hard', base);
    assert.equal(from !== base, true);
    plan(base, 'v0.14.0', '0.14.0', { fromVersion: v });
    ps = await lockFile(path.join(repo, 'zz-last.txt'), 5000);
    assert.equal(await runHelper(port), 0);
    assert.equal(outcome().phase, 'failed');
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), base, 'not moved');
    assert.equal(fs.existsSync(path.join(repo, 'aa-added.txt')), false, "the release's new file is not left behind");
    killServer();
    await new Promise((r) => { if (ps.exitCode !== null) r(); else ps.on('exit', r); });
    assert.equal(sh(repo, 'status', '--porcelain'), '', 'nothing left in the working tree');
    plan(base, 'v0.14.0', '0.14.0', { fromVersion: v });
    assert.equal(await runHelper(port), 0);
    assert.equal(outcome().phase, 'updated', 'the next try succeeds');
  } finally {
    ps?.kill();
    killServer();
  }
});
