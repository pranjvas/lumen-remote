// IP Control client (spec §2, §5.4, §9.3, §9.7) against the mock's TLS JSON-RPC server: the GET/SET
// rule, read-back, normalisation, error mapping, the single queue and pairing.
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockTv } from './mock-tv.js';
import { skipUnless, waitFor, sleep, createTestLog, FAST_TIMING } from './helpers.js';

const skip = skipUnless('server/adapters/ipcontrol.js', 'server/catalog/settings.js', 'server/store.js', 'server/config.js');

describe('IP Control client', { skip }, () => {
  let mock, modules;
  const made = [];

  before(async () => {
    const [{ createIpControl }, { createStore }, { loadConfig, createDataStore }] = await Promise.all([
      import('../server/adapters/ipcontrol.js'), import('../server/store.js'), import('../server/config.js'),
    ]);
    modules = { createIpControl, createStore, loadConfig, createDataStore };
    mock = await startMockTv({ allowDelayMs: 50 });
  });
  // One adapter at a time: the TV serves a single connection, so a leftover adapter's poll would collide.
  async function stopMade() {
    for (const m of made.splice(0)) {
      await m.ipc.stop();
      await m.store.stop?.({ save: false });
      fs.rmSync(m.dataDir, { recursive: true, force: true });
    }
    await sleep(250); // let an in-flight request finish
    resetMock();
  }
  beforeEach(stopMade);
  after(async () => {
    await stopMade();
    await mock.stop();
  });

  /** A fresh adapter with its own data dir, logger and store (conn.tv already 'on', as REST would publish). */
  function make({ token = mock.tokens.ipc, timing = {} } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ipc-'));
    if (token) fs.writeFileSync(path.join(dataDir, 'ipcontrol.json'), JSON.stringify({ token }));
    const config = modules.loadConfig({ dataDir, tv: mock.tv, timing: { ...FAST_TIMING, ...timing } });
    const data = modules.createDataStore(dataDir);
    const store = modules.createStore({});
    const log = createTestLog();
    store.set('conn.tv', 'on', { src: 'live', via: 'test' });
    const ipc = modules.createIpControl({ config, data, log, store });
    const m = { ipc, store, log, data, dataDir };
    made.push(m);
    return m;
  }
  const ipcRequests = (method) => mock.state.requests.ipc.filter((r) => r.method === method);
  const resetMock = () => {
    mock.setPictureMode('Standard');
    Object.assign(mock.options, { ipcFail: {}, ipcTransform: {}, ipcErrorStyle: 'nested', ipcDelayMs: 0 });
  };

  test('GET sends only the AccessToken and publishes normalised values', async () => {
    const { ipc, store } = make();
    await ipc.start();
    const before = ipcRequests('getTVStates').length;
    await ipc.get('getTVStates');
    const req = ipcRequests('getTVStates').slice(before);
    assert.equal(req.length, 1);
    assert.deepEqual([req[0].kind, req[0].params, req[0].tokenOk], ['get', {}, true]);
    assert.equal(store.get('audio.volume').v, mock.state.volume);
    assert.equal(store.get('audio.mute').v, false, 'mute is a boolean');
    assert.equal(store.get('audio.speaker').v, 'Internal', "getTVStates 'internal' → 'Internal'");
    assert.equal(store.get('input.source').v, 'TV');
    assert.equal(store.get('picture.mode').v, 'Standard');
    assert.equal(store.get('audio.volume').src, 'live');
    assert.equal(store.get('conn.ipc').v, 'paired');
  });

  test('setSetting: validate → SET → GET read-back → store, resolving { value }', async () => {
    const { ipc, store } = make();
    await ipc.start();
    await ipc.refresh('all');
    const before = ipcRequests('backlightControl').length;
    const result = await ipc.setSetting('picture.backlight', 14);
    assert.deepEqual(result, { value: 14 });
    const reqs = ipcRequests('backlightControl').slice(before);
    assert.deepEqual(reqs.map((r) => r.kind), ['set', 'get'], 'SET followed by a read-back GET');
    assert.deepEqual(reqs[0].params, { backlight: 14 });
    assert.equal(mock.state.picture.backlight, 14);
    const rec = store.get('picture.backlight');
    assert.equal(rec.v, 14);
    assert.equal(rec.src, 'live');
    assert.match(rec.via, /backlightControl/);
    assert.deepEqual(rec.range, [0, 50]);
    assert.deepEqual(rec.scope, { input: 'TV', mode: 'Standard' });
  });

  test('the read-back is what the TV reports, not what was asked for', async () => {
    mock.options.ipcTransform = { contrastControl: (v) => Math.min(v, 40) };
    const { ipc, store } = make();
    await ipc.start();
    const result = await ipc.setSetting('picture.contrast', 45);
    assert.deepEqual(result, { value: 40 });
    assert.equal(store.get('picture.contrast').v, 40);
  });

  test('out-of-range and unknown option values are rejected before anything is sent', async () => {
    const { ipc } = make();
    await ipc.start();
    const before = mock.state.requests.ipc.length;
    await assert.rejects(ipc.setSetting('picture.backlight', 99), { code: 'INVALID' });
    await assert.rejects(ipc.setSetting('picture.colorTone', 'Warm9'), { code: 'INVALID' });
    assert.equal(mock.state.requests.ipc.slice(before).filter((r) => r.kind === 'set').length, 0);
  });

  test('-32002 in Dynamic → LOCKED_IN_MODE (nested and flat error shapes)', async () => {
    const { ipc } = make();
    await ipc.start();
    mock.setPictureMode('Dynamic');
    await assert.rejects(ipc.setSetting('picture.backlight', 5), { code: 'LOCKED_IN_MODE' });
    mock.options.ipcErrorStyle = 'flat';
    await assert.rejects(ipc.setSetting('picture.backlight', 5), { code: 'LOCKED_IN_MODE' });
    assert.equal(mock.state.picture.backlight, 50, 'Dynamic value untouched');
  });

  test('-32601 → UNAVAILABLE, never latched: re-probed after a picture-mode change', async () => {
    const { ipc, store } = make();
    await ipc.start();
    mock.options.ipcFail = { colorToneControl: -32601 };
    await assert.rejects(ipc.get('colorToneControl'), { code: 'UNAVAILABLE' });
    await ipc.refresh('picture'); // the sweep meets -32601 for colour tone
    assert.equal(store.get('picture.colorTone')?.v ?? null, null, 'no value while unavailable');
    mock.options.ipcFail = {};
    const before = ipcRequests('colorToneControl').length;
    await ipc.setSetting('picture.mode', 'Movie');
    await waitFor(() => store.get('picture.colorTone')?.v === 'Warm2', { message: 'colour tone re-read in Movie' });
    assert.ok(ipcRequests('colorToneControl').length > before);
  });

  test('picture-mode change marks scoped picture values stale, then re-reads them in the new scope', async () => {
    const { ipc, store } = make();
    await ipc.start();
    await ipc.refresh('picture');
    const standard = store.get('picture.backlight').v;
    assert.equal(standard, mock.state.picture.backlight);
    const marks = [];
    store.on('patch', (p) => { if (p['picture.backlight']) marks.push(p['picture.backlight']); });
    await ipc.setSetting('picture.mode', 'Movie');
    await waitFor(() => store.get('picture.backlight')?.v === 8 && !store.get('picture.backlight').stale, { message: 'Movie backlight re-read' });
    assert.ok(marks.some((r) => r.stale === true && r.v === standard), 'the Standard value was published as stale first');
    assert.deepEqual(store.get('picture.backlight').scope, { input: 'TV', mode: 'Movie' });
  });

  test('a bad token → NOT_PAIRED and conn.ipc unpaired (both -32010 and -32700)', async () => {
    const bad = make({ token: 'not-the-token' });
    await bad.ipc.start();
    await assert.rejects(bad.ipc.get('getTVStates'), { code: 'NOT_PAIRED' });
    assert.equal(bad.store.get('conn.ipc').v, 'unpaired');

    const stale = make();
    await stale.ipc.start();
    mock.options.ipcFail = { getTVStates: -32700 };
    await assert.rejects(stale.ipc.get('getTVStates'), { code: 'NOT_PAIRED' });
    assert.equal(stale.store.get('conn.ipc').v, 'unpaired');
    resetMock();

    const none = make({ token: null });
    await none.ipc.start();
    await assert.rejects(none.ipc.get('getTVStates'), { code: 'NOT_PAIRED' });
  });

  test('other TV errors map to FAILED', async () => {
    const { ipc } = make();
    await ipc.start();
    mock.options.ipcFail = { backlightControl: -32003 };
    await assert.rejects(ipc.get('backlightControl'), { code: 'FAILED' });
  });

  test('one queue: concurrent calls never overlap and keep ≥ 150 ms between requests', async () => {
    const { ipc } = make();
    await ipc.start();
    const resetsBefore = mock.state.stats.ipcResets;
    const first = mock.state.requests.ipc.length;
    const results = await Promise.all(['backlightControl', 'contrastControl', 'sharpnessControl', 'colorControl', 'tintControl']
      .map((method) => ipc.get(method)));
    assert.equal(results.length, 5);
    assert.equal(mock.state.stats.ipcResets, resetsBefore, 'no overlapping connection was ever opened');
    assert.ok(!mock.state.violations.some((v) => v.kind === 'ipc-overlapping-connection'));
    const times = mock.state.requests.ipc.slice(first).map((r) => r.at);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 140, `gap ${times[i] - times[i - 1]} ms`);
  });

  test('user commands jump ahead of a running picture poll', async () => {
    const { ipc } = make({ timing: { ipcPictureMs: 200 } });
    await ipc.start();
    ipc.setDemand({ clients: 1, visible: true, views: new Set(['settings']) });
    const first = mock.state.requests.ipc.length;
    await waitFor(() => mock.state.requests.ipc.slice(first).filter((r) => r.kind === 'get').length >= 3, { message: 'picture poll running' });
    const t0 = Date.now();
    await ipc.setSetting('picture.sharpness', 9);
    const elapsed = Date.now() - t0;
    ipc.setDemand({ clients: 0, visible: false, views: new Set() });
    assert.ok(elapsed < 1200, `user write took ${elapsed} ms behind the poll`);
    assert.equal(mock.state.picture.sharpness, 9);
  });

  test('polling follows demand: getTVStates while visible, nothing with zero clients', async () => {
    const { ipc } = make({ timing: { ipcStatesMs: 150 } });
    await ipc.start();
    ipc.setDemand({ clients: 1, visible: true, views: new Set(['remote']) });
    const before = ipcRequests('getTVStates').length;
    await waitFor(() => ipcRequests('getTVStates').length >= before + 2, { message: 'getTVStates polled' });
    ipc.setDemand({ clients: 0, visible: false, views: new Set() });
    await sleep(400);
    const settled = ipcRequests('getTVStates').length;
    await sleep(500);
    assert.equal(ipcRequests('getTVStates').length, settled, 'no polls with zero clients');
  });

  test('power: only powerControl powerOff / powerOn, never param-less or reboot', async () => {
    const { ipc, store } = make();
    await ipc.start();
    await ipc.power('off');
    await waitFor(() => mock.state.power === 'standby');
    store.set('conn.tv', 'standby', { src: 'live', via: 'test' });
    await ipc.power('on');
    await waitFor(() => mock.state.power === 'on');
    store.set('conn.tv', 'on', { src: 'live', via: 'test' });
    const power = ipcRequests('powerControl');
    assert.deepEqual(power.map((r) => r.params), [{ power: 'powerOff' }, { power: 'powerOn' }]);
    assert.ok(!mock.state.violations.some((v) => v.kind.startsWith('ipc-')), JSON.stringify(mock.state.violations));
  });

  test('pair(): createAccessToken, the new token is persisted, and it is never logged', async () => {
    const { ipc, data, log, store } = make({ token: null });
    await ipc.start();
    const before = mock.state.pairRequests.ipc;
    await ipc.pair();
    assert.equal(mock.state.pairRequests.ipc, before + 1);
    const saved = data.readJson('ipcontrol.json', {});
    assert.ok(mock.state.tokens.ipc.has(saved.token), 'persisted token is the one the TV issued');
    assert.equal(store.get('conn.ipc').v, 'paired');
    await ipc.get('getTVStates');
    assert.equal(ipcRequests('getTVStates').at(-1).tokenOk, true, 'the new token is used');
    assert.ok(!log.text().includes(saved.token), 'token not in logs');
    assert.ok(!log.text().includes(mock.tokens.ipc), 'seed token not in logs');

    mock.options.ipcSlotsFull = true;
    await assert.rejects(ipc.pair(), { code: 'FAILED' });
    mock.options.ipcSlotsFull = false;
  });
});
