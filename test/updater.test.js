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

// ---- applying: the idle gate, the hand-off to the helper, and the outcome after the restart ----

function applyHarness({ version = '0.2.0', git = fakeGit(), auto = true, features = {} } = {}) {
  let clock = 1_000_000;
  const spawned = [];
  let exits = 0;
  const h = updaterHarness({
    version, git, features, now: () => clock,
    spawnHelper: (plan) => { spawned.push(plan); },
    requestExit: () => { exits += 1; },
    httpPort: () => 4321,
  });
  if (!auto) h.updater.setAuto(false);
  return { ...h, spawned, exits: () => exits, advance: (ms) => { clock += ms; }, clock: () => clock };
}
const setKey = (h, key, v) => h.store.set(key, v, { src: 'derived', via: 'test' });

test('an update is applied once Lumen has been idle for 2 minutes: the plan is written, the helper started, Lumen exits', async () => {
  const h = applyHarness();
  await h.updater.check();
  await h.updater.evaluate();
  assert.equal(h.spawned.length, 0, 'not before 2 minutes of idle');
  assert.equal(h.status().state, 'waiting');
  h.advance(2 * 60 * 1000);
  await h.updater.evaluate();
  assert.equal(h.spawned.length, 1);
  assert.deepEqual(h.spawned[0], { from: 'aaa111', to: 'v0.3.0', toVersion: '0.3.0', fromVersion: '0.2.0', pid: process.pid, port: 4321 },
    'the helper waits for this process and this port, and knows which version to go back to');
  const plan = h.data.readJson('update/state.json', null);
  assert.equal(plan.phase, 'applying');
  assert.equal(plan.to, 'v0.3.0');
  assert.equal(h.exits(), 1, 'Lumen shuts down for the helper');
  assert.equal(h.status().state, 'applying');
  await h.updater.evaluate();
  assert.equal(h.spawned.length, 1, 'only once');
});

test('in use (Lumen on the TV, a TV video, live video, incognito, a file cast to the TV from Lumen, an Ask Lumen run): it waits, and counts 2 minutes from when that ends', async () => {
  for (const [key, value, idle] of [['tvscreen.on', true, false], ['tvscreen.video', 'playing', null], ['tvscreen.live', { state: 'playing' }, { state: 'off' }], ['browser.incognito', true, false],
    ['cast.session', { kind: 'dlna', state: 'PAUSED_PLAYBACK' }, { kind: 'dlna', state: 'STOPPED' }]]) {
    const h = applyHarness();
    setKey(h, key, value);
    await h.updater.check();
    await h.updater.evaluate(); // an idle Lumen would start counting here
    h.advance(10 * 60 * 1000);
    await h.updater.evaluate();
    assert.equal(h.spawned.length, 0, `${key} blocks`);
    assert.equal(h.status().state, 'waiting');
    setKey(h, key, idle);
    await h.updater.evaluate();
    h.advance(60 * 1000);
    await h.updater.evaluate();
    assert.equal(h.spawned.length, 0, `${key}: only one idle minute so far`);
    h.advance(61 * 1000);
    await h.updater.evaluate();
    assert.equal(h.spawned.length, 1, `${key}: applied after 2 idle minutes`);
  }
  const busy = applyHarness({ features: { ai: { busy: () => true } } });
  await busy.updater.check();
  busy.advance(10 * 60 * 1000);
  await busy.updater.evaluate();
  assert.equal(busy.spawned.length, 0, 'an Ask Lumen run blocks');
});

test('automatic updates off: it waits for "Update now", which applies at once even while in use', async () => {
  const h = applyHarness({ auto: false });
  await h.updater.check();
  h.advance(10 * 60 * 1000);
  await h.updater.evaluate();
  assert.equal(h.spawned.length, 0);
  assert.equal(h.status().state, 'available');
  setKey(h, 'tvscreen.on', true);
  await h.updater.applyNow();
  assert.equal(h.spawned.length, 1);
});

test('after the restart: updated, failed (not retried by itself, but by "Update now"), and an interrupted update', async () => {
  const done = applyHarness({ version: '0.3.0' });
  done.data.writeJson('update/state.json', { phase: 'updated', from: 'aaa111', to: 'v0.3.0', toVersion: '0.3.0', at: done.clock() });
  done.updater.start();
  assert.equal(done.status().state, 'updated');
  assert.equal(done.status().latest, '0.3.0');

  const bad = applyHarness();
  bad.data.writeJson('update/state.json', { phase: 'failed', from: 'aaa111', to: 'v0.3.0', toVersion: '0.3.0', at: bad.clock(), error: 'Lumen did not answer within 60 s' });
  bad.updater.start();
  assert.equal(bad.status().state, 'failed');
  assert.match(bad.status().reason, /did not answer/);
  await bad.updater.check();
  bad.advance(10 * 60 * 1000);
  await bad.updater.evaluate();
  assert.equal(bad.spawned.length, 0, 'the failed release is not tried again by itself');
  assert.equal(bad.status().state, 'failed');
  await bad.updater.applyNow();
  assert.equal(bad.spawned.length, 1, '"Update now" (Try again) does');

  const stale = applyHarness();
  stale.data.writeJson('update/state.json', { phase: 'applying', from: 'aaa111', to: 'v0.3.0', toVersion: '0.3.0', at: stale.clock() - 11 * 60 * 1000 });
  stale.updater.start();
  assert.equal(stale.status().state, 'failed');
  assert.match(stale.status().reason, /interrupted/);
  assert.equal(stale.data.readJson('update/state.json', null).phase, 'failed');
  for (const x of [done, bad, stale]) await x.updater.stop();
});

test('it checks again just before applying: local work begun while it waited, or a release withdrawn meanwhile, stops it', async () => {
  let dirty = false;
  const h = applyHarness({ git: fakeGit({ isDirty: async () => dirty }) });
  await h.updater.check();
  await h.updater.evaluate();
  assert.equal(h.status().state, 'waiting');
  dirty = true; // the owner starts editing while Lumen waits to be idle
  h.advance(2 * 60 * 1000);
  await h.updater.evaluate();
  assert.equal(h.spawned.length, 0, 'not applied over local changes');
  assert.equal(h.status().state, 'left-alone');
  assert.equal(h.status().reason, 'local changes');

  let tags = [{ tag: 'v0.3.0', version: '0.3.0' }];
  const bad = applyHarness({ git: fakeGit({ releaseTags: async () => tags }) });
  bad.data.writeJson('update/state.json', { phase: 'failed', from: 'aaa111', to: 'v0.3.0', toVersion: '0.3.0', at: bad.clock(), error: 'x' });
  bad.updater.start();
  await bad.updater.check();
  assert.equal(bad.status().state, 'failed');
  tags = []; // withdrawn
  await bad.updater.applyNow();
  assert.equal(bad.spawned.length, 0, '"Try again" does not install a withdrawn release');
  assert.equal(bad.status().state, 'up-to-date');
  await bad.updater.stop();
});

test('hub: update.apply runs "Update now"', async () => {
  const stack = await startStack({ seams: { updateGit: fakeGit({ releaseTags: async () => [] }) } });
  try {
    const b = stack.browser();
    await b.hello;
    const ack = await b.send('update.apply', {});
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(ack.value.state, 'up-to-date', 'nothing to apply: it checked and says so');
  } finally {
    await stack.stop();
  }
});

test('/api/health says ready once start-up has finished (the update helper waits for it before counting a new version)', async () => {
  const stack = await startStack({ seams: { updateGit: fakeGit({ releaseTags: async () => [] }) } });
  try {
    const h = await (await fetch(stack.url('/api/health'))).json();
    assert.equal(h.ok, true);
    assert.equal(h.ready, true);
    assert.equal(h.pid, process.pid);
  } finally {
    await stack.stop();
  }
});
