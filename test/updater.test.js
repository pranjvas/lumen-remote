// The updater feature (server/features/updater.js): checking for releases, the status it publishes
// (update.status), the automatic-updates switch and the hub commands. Git is a fake here: no test touches
// the real repository or the network (test/update-git.test.js covers the git layer itself).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpdater } from '../server/features/updater.js';
import { createStore } from '../server/store.js';
import { createDataStore } from '../server/config.js';
import { createTestLog, startStack } from './helpers.js';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

export function fakeGit(over = {}) {
  return {
    isRepo: async () => true,
    branch: async () => 'master',
    isDirty: async () => false,
    head: async () => 'aaa111',
    fetchTags: async () => {},
    releaseTags: async () => [{ tag: 'v0.3.0', version: '0.3.0' }, { tag: 'v0.2.0', version: '0.2.0' }],
    commitOf: async () => 'bbb222',
    isAncestor: async () => true,
    changed: async () => false,
    ...over,
  };
}

export function updaterHarness({ git = fakeGit(), version = '0.2.0', config = {}, ...rest } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-updater-'));
  dirs.push(dir);
  const store = createStore({ log: createTestLog() });
  const data = createDataStore(dir);
  const updater = createUpdater({
    config: { update: { enabled: false, ...config } }, data, log: createTestLog(), store, features: {},
    requestExit: () => {}, git, version, ...rest,
  });
  const status = () => store.get('update.status')?.v ?? null;
  return { updater, store, data, dir, status };
}

test('a newer release this copy can move to is available', async () => {
  const h = updaterHarness();
  await h.updater.check();
  const s = h.status();
  assert.equal(s.state, 'available');
  assert.equal(s.current, '0.2.0');
  assert.equal(s.latest, '0.3.0');
  assert.equal(typeof s.checkedAt, 'number');
  assert.equal(s.auto, true, 'automatic updates are on by default');
});

test('a copy with local work, on another branch, ahead of the release or not a git copy is left alone, and says why', async () => {
  for (const [over, reason] of [
    [{ isDirty: async () => true }, 'local changes'],
    [{ branch: async () => 'dev' }, 'on branch dev'],
    [{ branch: async () => null }, 'not on a branch'],
    [{ isAncestor: async () => false }, 'ahead of the release'],
    [{ isRepo: async () => false }, 'not a git copy'],
  ]) {
    const h = updaterHarness({ git: fakeGit(over) });
    await h.updater.check();
    assert.equal(h.status().state, 'left-alone', reason);
    assert.equal(h.status().reason, reason);
  }
});

test('a check that cannot reach GitHub says why and does not throw; the same version is up to date', async () => {
  const h = updaterHarness({ git: fakeGit({ fetchTags: async () => { throw new Error('Authentication failed for origin'); } }) });
  await h.updater.check();
  assert.equal(h.status().state, 'unreachable');
  assert.match(h.status().reason, /Authentication failed/);

  const same = updaterHarness({ version: '0.3.0' });
  await same.updater.check();
  assert.equal(same.status().state, 'up-to-date');
  const none = updaterHarness({ git: fakeGit({ releaseTags: async () => [] }) });
  await none.updater.check();
  assert.equal(none.status().state, 'up-to-date', 'no release yet');
});

test('the automatic-updates switch is kept in data/update/settings.json', async () => {
  const h = updaterHarness();
  h.updater.setAuto(false);
  assert.deepEqual(h.data.readJson('update/settings.json', null), { auto: false });
  assert.equal(h.status().auto, false);
  const again = createUpdater({ config: { update: { enabled: false } }, data: h.data, log: createTestLog(), store: h.store, features: {}, requestExit: () => {}, git: fakeGit(), version: '0.2.0' });
  again.start();
  assert.equal(h.status().auto, false, 'remembered after a restart');
  await again.stop();
});

test('hub: update.check returns the status; update.setAuto takes a boolean only', async () => {
  const stack = await startStack({ seams: { updateGit: fakeGit() } });
  try {
    const b = stack.browser();
    await b.hello;
    const ack = await b.send('update.check', {});
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.ok(['available', 'up-to-date'].includes(ack.value.state), ack.value.state);
    const bad = await b.send('update.setAuto', { on: 'yes' });
    assert.equal(bad.ok, false);
    const good = await b.send('update.setAuto', { on: false });
    assert.equal(good.ok, true);
    assert.equal(stack.server.store.get('update.status')?.v?.auto, false);
  } finally {
    await stack.stop();
  }
});
