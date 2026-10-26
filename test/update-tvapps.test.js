// TV apps after an update (server/update/tvapps.js and the updater): which apps the TV runs older than this
// copy carries, where the Tizen tooling is, and the updater installing them by itself only where the tooling
// is here (once per version, when Lumen is idle), else only saying an update is available.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findTooling, installArgs, installTvApp, repoVersions, tvAppUpdates } from '../server/update/tvapps.js';
import { createUpdater } from '../server/features/updater.js';
import { createStore } from '../server/store.js';
import { createDataStore, REPO_ROOT } from '../server/config.js';
import { createTestLog } from './helpers.js';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('which TV apps need an update: only a known, older version on the TV', () => {
  assert.deepEqual(tvAppUpdates({ repo: { agent: '0.9.5', eyes: '0.4.0' }, connected: { agent: '0.9.4', eyes: '0.4.0' } }), [{ app: 'agent', from: '0.9.4', to: '0.9.5' }]);
  assert.deepEqual(tvAppUpdates({ repo: { agent: '0.9.5', eyes: '0.4.0' }, connected: { agent: '0.9.5', eyes: '0.4.1' } }), [], 'equal or newer on the TV');
  assert.deepEqual(tvAppUpdates({ repo: { agent: '0.9.5', eyes: '0.4.0' }, connected: { agent: null, eyes: undefined } }), [], 'unknown: never installed blind');
});

test('the versions this copy carries come from the apps\' own manifests', () => {
  const v = repoVersions(REPO_ROOT);
  const xml = fs.readFileSync(path.join(REPO_ROOT, 'companion/agent/config.xml'), 'utf8');
  assert.equal(v.agent, /<widget\b[^>]*\bversion="([^"]+)"/.exec(xml)[1]);
  assert.match(v.eyes, /^\d+\.\d+\.\d+$/, 'the Eyes manifest version, not the XML declaration\'s');
});

test('the Tizen tooling: configured paths first, then the usual install folders, with the active signing profile and whether dotnet is here; none → null', () => {
  const home = 'C:\\Users\\someone';
  const studio = 'C:\\tizen-studio';
  const files = {
    [`${studio}\\sdk.info`]: 'TIZEN_SDK_INSTALLED_PATH=C:\\tizen-studio\nTIZEN_SDK_DATA_PATH=D:\\tizen-data\n',
    'D:\\tizen-data\\profile\\profiles.xml': '<?xml version="1.0"?>\n<profiles active="Mine" version="3.1">\n<profile name="Mine">\n</profile>\n</profiles>\n',
  };
  const readFile = (f) => { if (f in files) return files[f]; throw new Error('ENOENT'); };
  const usual = new Set([`${studio}\\tools\\ide\\bin\\tizen.bat`, `${studio}\\tools\\sdb.exe`]);
  const env = { USERPROFILE: home, PATH: 'C:\\Windows;C:\\Program Files\\dotnet' };
  assert.equal(findTooling({ config: {}, env, exists: () => false, readFile }), null);
  assert.deepEqual(findTooling({ config: {}, env, exists: (p) => usual.has(p) || p === 'C:\\Program Files\\dotnet\\dotnet.exe', readFile }),
    { tizenCli: `${studio}\\tools\\ide\\bin\\tizen.bat`, sdb: `${studio}\\tools\\sdb.exe`, profile: 'Mine', dotnet: true });
  assert.equal(findTooling({ config: {}, env, exists: (p) => usual.has(p), readFile: () => { throw new Error('ENOENT'); } }), null,
    'no certificate profile: it cannot sign, so it is not tooling');
  assert.equal(findTooling({ config: {}, env: { USERPROFILE: home, PATH: 'C:\\Windows' }, exists: (p) => usual.has(p), readFile }).dotnet, false);
  const mine = { tizenCli: 'D:\\t\\tizen.bat', sdb: 'D:\\t\\sdb.exe', profile: 'Q95T' };
  assert.deepEqual(findTooling({ config: { tvTooling: mine }, env, exists: () => true, readFile }), { ...mine, dotnet: true });
});

test('the install passes the signing profile to the app\'s build', () => {
  const a = installArgs('agent', { tizenCli: 'C:\\t\\tizen.bat', sdb: 'C:\\t\\sdb.exe', profile: 'Mine' }, { tvHost: '10.0.0.9', repo: 'C:\\lumen' });
  assert.deepEqual(a.slice(a.indexOf('-App')), ['-App', 'agent', '-TizenCli', 'C:\\t\\tizen.bat', '-Sdb', 'C:\\t\\sdb.exe', '-TvHost', '10.0.0.9', '-SigningProfile', 'Mine']);
});

// A copy on master, clean, exactly at its own release (v0.2.0).
const releaseGit = (over = {}) => ({
  isRepo: async () => true, branch: async () => 'master', isDirty: async () => false, head: async () => 'rel020',
  fetchTags: async () => {}, releaseTags: async () => [{ tag: 'v0.2.0', version: '0.2.0' }], commitOf: async () => 'rel020',
  isAncestor: async () => true, ...over,
});

function harness({ tooling, git = releaseGit(), tv = 'on', connected = { agent: '0.9.4', eyes: '0.4.0' }, install = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tvapps-'));
  dirs.push(dir);
  let clock = 5_000_000;
  const installs = [];
  const launches = [];
  const spawned = [];
  const store = createStore({ log: createTestLog() });
  const data = createDataStore(dir);
  const updater = createUpdater({
    config: { update: { enabled: false } }, data, log: createTestLog(), store, features: {},
    adapters: { agent: { launch: async () => { launches.push(Date.now()); return { value: 'online' }; } } },
    git, version: '0.2.0', now: () => clock, spawnHelper: (plan) => { spawned.push(plan); }, requestExit: () => {},
    tvApps: {
      repoVersions: () => ({ agent: '0.9.5', eyes: '0.4.0' }),
      connected: () => connected,
      tooling: () => tooling,
      install: async (app) => { installs.push(app); return install ? install(app) : { ok: true }; },
    },
  });
  const setTv = (v) => store.set('conn.tv', v, { src: 'live', via: 'test' });
  setTv(tv);
  return { updater, store, data, installs, launches, spawned, setTv, advance: (ms) => { clock += ms; }, tv: () => store.get('update.tvApps')?.v ?? null };
}
const TOOLING = { tizenCli: 'x', sdb: 'y', profile: 'Mine', dotnet: true };

test('without the tooling: the update is shown, nothing is installed', async () => {
  const h = harness({ tooling: null });
  await h.updater.check();
  await h.updater.evaluate();
  h.advance(3 * 60 * 1000);
  await h.updater.evaluate();
  assert.deepEqual(h.tv().updates, [{ app: 'agent', from: '0.9.4', to: '0.9.5' }]);
  assert.equal(h.tv().tooling, false);
  assert.deepEqual(h.installs, []);
});

test('with the tooling: installed once Lumen has been idle 2 minutes, once per version; the agent is left to start itself', async () => {
  const h = harness({ tooling: TOOLING });
  await h.updater.check();
  await h.updater.evaluate();
  assert.deepEqual(h.installs, [], 'not before 2 idle minutes');
  h.advance(2 * 60 * 1000 + 1);
  await h.updater.evaluate();
  assert.deepEqual(h.installs, ['agent']);
  assert.equal(h.tv().lastResult.ok, true);
  assert.deepEqual(h.launches, [], 'not launched over whatever the TV shows (its own auto-start never covers another app)');
  h.advance(10 * 60 * 1000);
  await h.updater.evaluate();
  assert.deepEqual(h.installs, ['agent'], 'not again for the same version');
});

test('only a clean copy at a release installs TV apps: local edits, another branch, or commits past the release do not', async () => {
  for (const [over, why] of [[{ isDirty: async () => true }, 'local changes'], [{ branch: async () => 'dev' }, 'another branch'], [{ head: async () => 'later1' }, 'past the release'], [{ isRepo: async () => false }, 'not a git copy']]) {
    const h = harness({ tooling: TOOLING, git: releaseGit(over) });
    await h.updater.check();
    await h.updater.evaluate();
    h.advance(3 * 60 * 1000);
    await h.updater.evaluate();
    assert.deepEqual(h.installs, [], why);
    assert.deepEqual(h.tv().updates, [], `${why}: no TV app update offered`);
  }
});

test('the TV asleep: no install is tried, and the one try for the version is kept for when it is on', async () => {
  const h = harness({ tooling: TOOLING, tv: 'standby' });
  await h.updater.check();
  await h.updater.evaluate();
  h.advance(3 * 60 * 1000);
  await h.updater.evaluate();
  assert.deepEqual(h.installs, []);
  assert.equal(h.data.readJson('update/tvapps.json', null), null, 'nothing recorded as tried');
  h.setTv('on');
  await h.updater.evaluate();
  assert.deepEqual(h.installs, ['agent']);
});

test('an Eyes update needs dotnet to build: without it, it is shown with the manual steps, not tried', async () => {
  const h = harness({ tooling: { ...TOOLING, dotnet: false }, connected: { agent: '0.9.5', eyes: '0.3.0' } });
  await h.updater.check();
  await h.updater.evaluate();
  h.advance(3 * 60 * 1000);
  await h.updater.evaluate();
  assert.deepEqual(h.tv().updates, [{ app: 'eyes', from: '0.3.0', to: '0.4.0' }]);
  assert.equal(h.tv().tooling, false, 'Settings shows how to install it');
  assert.deepEqual(h.installs, []);
});

// An install that finishes only when told to.
function pendingInstall() {
  let finish;
  const done = new Promise((r) => { finish = () => r({ ok: true }); });
  return { install: () => done, finish };
}

test('two idle-gate passes at once start one install, not two', async () => {
  const p = pendingInstall();
  const h = harness({ tooling: TOOLING, install: p.install });
  await h.updater.check();
  await h.updater.evaluate();
  h.advance(3 * 60 * 1000);
  const a = h.updater.evaluate();
  const b = h.updater.evaluate();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(h.installs, ['agent']);
  p.finish();
  await Promise.all([a, b]);
  assert.deepEqual(h.installs, ['agent']);
});

test('an update found while a TV app installs waits for the install (Lumen does not exit under it)', async () => {
  const p = pendingInstall();
  let tags = [{ tag: 'v0.2.0', version: '0.2.0' }];
  const h = harness({ tooling: TOOLING, install: p.install, git: releaseGit({ releaseTags: async () => tags }) });
  await h.updater.check();
  await h.updater.evaluate();
  h.advance(3 * 60 * 1000);
  const installing = h.updater.evaluate();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(h.installs, ['agent'], 'the install is under way');
  tags = [{ tag: 'v0.3.0', version: '0.3.0' }, ...tags];
  await h.updater.check();
  await h.updater.evaluate();
  await h.updater.applyNow();
  assert.equal(h.spawned.length, 0, 'neither the idle gate nor "Update now" exits during the install');
  p.finish();
  await installing;
  h.advance(3 * 60 * 1000);
  await h.updater.evaluate();
  assert.equal(h.spawned.length, 1, 'applied once the install is done');
});

test('an install that hangs (a stuck sdb) is stopped with everything it started, and reported', { skip: process.platform !== 'win32' }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tvapp-hang-'));
  dirs.push(repo);
  fs.mkdirSync(path.join(repo, 'tools'));
  const pidFile = path.join(repo, 'child.pid');
  // A stand-in install script whose child (like a hung sdb) keeps the output pipes open.
  fs.writeFileSync(path.join(repo, 'tools', 'tvapp-install.ps1'), `param($App, $TizenCli, $Sdb, $TvHost, $SigningProfile)
$p = Start-Process -FilePath '${process.execPath}' -ArgumentList '-e', '"setInterval(() => {}, 1000)"' -NoNewWindow -PassThru
Set-Content -LiteralPath '${pidFile}' $p.Id
& '${process.execPath}' -e "setInterval(() => {}, 1000)"
`);
  const started = Date.now();
  const r = await installTvApp('agent', { tizenCli: 'x', sdb: 'y', profile: 'P' }, { tvHost: '10.0.0.9', repo, timeoutMs: 3000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not finish/);
  assert.ok(Date.now() - started < 20000, 'it gave up instead of waiting for the hung child');
  await new Promise((res) => setTimeout(res, 500));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the hung child was stopped too');
});
