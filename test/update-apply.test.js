// The update helper (tools/update-apply.js) end to end on a throwaway repo: it waits for the old Lumen to stop,
// fast-forwards to the release, reinstalls only when package-lock.json changed, starts Lumen and checks its
// health; on any failure it goes back to the previous commit and starts that again. The "server" here is a tiny
// script answering /api/health with the version in its package.json; "npm" is a stand-in that records calls.
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

// The fake server: listens on the port given, answers /api/health with package.json's version, writes its pid.
const GOOD_SERVER = `const http = require('http'); const fs = require('fs');
const v = JSON.parse(fs.readFileSync(__dirname + '/package.json', 'utf8')).version;
fs.writeFileSync(__dirname + '/server.pid', String(process.pid));
http.createServer((q, s) => { s.end(JSON.stringify({ ok: true, app: 'lumen', version: v })); }).listen(Number(process.argv[2]), '127.0.0.1');`;
const BAD_SERVER = `process.exit(1);`;

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
function killServer() {
  try { process.kill(Number(fs.readFileSync(path.join(repo, 'server.pid'), 'utf8')), 'SIGKILL'); } catch { /* not running */ }
  try { fs.rmSync(path.join(repo, 'server.pid')); } catch { /* none */ }
}
function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function plan(from, to, toVersion) {
  fs.mkdirSync(path.join(dataDir, 'update'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'update', 'state.json'), JSON.stringify({ phase: 'applying', from, to, toVersion, at: Date.now() }));
}
const outcome = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'update', 'state.json'), 'utf8'));
function runHelper(port, { npmFails = false, exitWaitMs = 2000, healthWaitMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HELPER, dataDir, '--repo', repo, '--port', String(port), '--start', `node server.js ${port}`,
      '--npm', `node ${fakeNpm}`, '--exit-wait-ms', String(exitWaitMs), '--health-wait-ms', String(healthWaitMs)],
    { env: { ...process.env, FAKE_NPM_LOG: npmLog, FAKE_NPM_FAIL: npmFails ? '1' : '' }, stdio: 'ignore' });
    child.on('close', (code) => resolve(code));
  });
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-update-apply-'));
  dataDir = path.join(root, 'data');
  fakeNpm = path.join(root, 'fakenpm.js');
  npmLog = path.join(root, 'npm.log');
  fs.writeFileSync(fakeNpm, `require('fs').appendFileSync(process.env.FAKE_NPM_LOG, process.argv.slice(2).join(' ') + '\\n'); process.exit(process.env.FAKE_NPM_FAIL ? 1 : 0);`);
  origin = path.join(root, 'origin.git');
  repo = path.join(root, 'repo');
  sh(root, 'init', '-q', '--bare', '-b', 'master', origin);
  sh(root, 'clone', '-q', origin, repo);
  sh(repo, 'config', 'user.email', 't@example.invalid');
  sh(repo, 'config', 'user.name', 'T');
  sh(repo, 'checkout', '-q', '-B', 'master');
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

test('a changed package-lock.json reinstalls with npm ci', async () => {
  try {
    const port = await freePort();
    const from = sh(repo, 'rev-parse', 'HEAD');
    release('0.4.0', { lock: '{"v":2}' });
    sh(repo, 'reset', '-q', '--hard', from);
    fs.writeFileSync(npmLog, '');
    plan(from, 'v0.4.0', '0.4.0');
    assert.equal(await runHelper(port), 0);
    assert.equal(outcome().phase, 'updated');
    assert.match(fs.readFileSync(npmLog, 'utf8'), /^ci/m);
  } finally {
    killServer();
  }
});

test('a release that does not start is rolled back: the previous version runs again and the failure is recorded', async () => {
  try {
    const port = await freePort();
    const from = sh(repo, 'rev-parse', 'HEAD');
    release('0.5.0', { server: BAD_SERVER });
    sh(repo, 'reset', '-q', '--hard', from);
    plan(from, 'v0.5.0', '0.5.0');
    assert.equal(await runHelper(port), 0, 'a successful rollback is not a crash');
    const o = outcome();
    assert.equal(o.phase, 'failed');
    assert.match(o.error, /did not answer|did not start/i);
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), from, 'back on the previous commit');
    assert.equal((await health(port))?.version, '0.4.0', 'the previous version is running');
  } finally {
    killServer();
  }
});

test('npm ci failing rolls back too', async () => {
  try {
    const port = await freePort();
    const from = sh(repo, 'rev-parse', 'HEAD');
    release('0.6.0', { lock: '{"v":3}' });
    sh(repo, 'reset', '-q', '--hard', from);
    plan(from, 'v0.6.0', '0.6.0');
    assert.equal(await runHelper(port, { npmFails: true }), 0);
    assert.equal(outcome().phase, 'failed');
    assert.match(outcome().error, /npm/i);
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), from);
    assert.equal((await health(port))?.version, '0.4.0');
  } finally {
    killServer();
  }
});

test('an old Lumen that never stops: nothing is moved, no second Lumen is started, the update is recorded as failed', async () => {
  const port = await freePort();
  const from = sh(repo, 'rev-parse', 'HEAD');
  const stuck = http.createServer((q, s) => s.end(JSON.stringify({ ok: true, app: 'lumen', version: '0.4.0' }))).listen(port, '127.0.0.1');
  try {
    plan(from, 'v0.6.0', '0.6.0');
    assert.equal(await runHelper(port, { exitWaitMs: 1500 }), 0);
    assert.equal(outcome().phase, 'failed');
    assert.match(outcome().error, /did not stop/i);
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), from);
    assert.equal(fs.existsSync(path.join(repo, 'server.pid')), false, 'no second server started');
  } finally {
    stuck.close();
  }
});
