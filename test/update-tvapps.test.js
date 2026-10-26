// TV apps after an update (server/update/tvapps.js and the updater): which apps the TV runs older than this
// copy carries, where the Tizen tooling is, and the updater installing them by itself only where the tooling
// is here (once per version, when Lumen is idle), else only saying an update is available.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findTooling, repoVersions, tvAppUpdates } from '../server/update/tvapps.js';
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

test('the Tizen tooling: configured paths first, then the usual install folders; none → null', () => {
  const env = { USERPROFILE: 'C:\\Users\\someone' };
  assert.equal(findTooling({ config: {}, env, exists: () => false }), null);
  const usual = new Set(['C:\\tizen-studio\\tools\\ide\\bin\\tizen.bat', 'C:\\tizen-studio\\tools\\sdb.exe']);
  assert.deepEqual(findTooling({ config: {}, env, exists: (p) => usual.has(p) }), { tizenCli: 'C:\\tizen-studio\\tools\\ide\\bin\\tizen.bat', sdb: 'C:\\tizen-studio\\tools\\sdb.exe' });
  const mine = { tizenCli: 'D:\\t\\tizen.bat', sdb: 'D:\\t\\sdb.exe' };
  assert.deepEqual(findTooling({ config: { tvTooling: mine }, env, exists: () => true }), mine);
});

function harness({ tooling }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tvapps-'));
  dirs.push(dir);
  let clock = 5_000_000;
  const installs = [];
  const after = [];
  const store = createStore({ log: createTestLog() });
  const updater = createUpdater({
    config: { update: { enabled: false } }, data: createDataStore(dir), log: createTestLog(), store, features: {},
    git: { isRepo: async () => false }, version: '0.2.0', now: () => clock,
    tvApps: {
      repoVersions: () => ({ agent: '0.9.5', eyes: '0.4.0' }),
      connected: () => ({ agent: '0.9.4', eyes: '0.4.0' }),
      tooling: () => tooling,
      install: async (app) => { installs.push(app); return { ok: true }; },
      afterInstall: async (app) => { after.push(app); },
    },
  });
  return { updater, store, installs, after, advance: (ms) => { clock += ms; }, tv: () => store.get('update.tvApps')?.v ?? null };
}

test('without the tooling: the update is shown, nothing is installed', async () => {
  const h = harness({ tooling: null });
  h.advance(10 * 60 * 1000);
  await h.updater.evaluate();
  h.advance(3 * 60 * 1000);
  await h.updater.evaluate();
  assert.deepEqual(h.tv().updates, [{ app: 'agent', from: '0.9.4', to: '0.9.5' }]);
  assert.equal(h.tv().tooling, false);
  assert.deepEqual(h.installs, []);
});

test('with the tooling: installed once Lumen has been idle 2 minutes, once per version, then the agent is started', async () => {
  const h = harness({ tooling: { tizenCli: 'x', sdb: 'y' } });
  await h.updater.evaluate();
  assert.deepEqual(h.installs, [], 'not before 2 idle minutes');
  h.advance(2 * 60 * 1000 + 1);
  await h.updater.evaluate();
  assert.deepEqual(h.installs, ['agent']);
  assert.deepEqual(h.after, ['agent']);
  assert.equal(h.tv().lastResult.ok, true);
  h.advance(10 * 60 * 1000);
  await h.updater.evaluate();
  assert.deepEqual(h.installs, ['agent'], 'not again for the same version');
});
