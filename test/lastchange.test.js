// LastChange parsing with real Q95T NOTIFY bodies (entity-encoded RenderingControl events, partial
// events and empty <LastChange/>), both as a unit and through the UPnP adapter's GENA route.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockTv, fixture, fixtureJson } from './mock-tv.js';
import { skipUnless, waitFor, sleep, createTestLan, createTestLog, FAST_TIMING, merge } from './helpers.js';

const SEQUENCE = fixtureJson('upnp/gena-sequence.json');

describe('LastChange parser (unit)', { skip: skipUnless('server/adapters/upnp.js') }, () => {
  let parseLastChange;
  before(async () => { ({ parseLastChange } = await import('../server/adapters/upnp.js')); });

  test('the initial event carries Master volume and mute among other variables', (t) => {
    if (typeof parseLastChange !== 'function') return t.skip('upnp.js does not export parseLastChange');
    assert.deepEqual(parseLastChange(fixture('upnp/notify-rc-initial.xml')), { volume: 4, mute: true });
  });

  test('partial events carry only what changed', (t) => {
    if (typeof parseLastChange !== 'function') return t.skip('upnp.js does not export parseLastChange');
    assert.deepEqual(parseLastChange(fixture('upnp/notify-rc-mute-0.xml')), { mute: false });
    assert.deepEqual(parseLastChange(fixture('upnp/notify-rc-volume-5.xml')), { volume: 5 });
    assert.deepEqual(parseLastChange(fixture('upnp/notify-rc-volume-10.xml')), { volume: 10 });
  });

  test('an empty <LastChange/> and an AVTransport event carry no audio change', (t) => {
    if (typeof parseLastChange !== 'function') return t.skip('upnp.js does not export parseLastChange');
    for (const name of ['notify-rc-empty.xml', 'notify-avt-initial.xml']) {
      const r = parseLastChange(fixture(`upnp/${name}`));
      assert.ok(r == null || (r.volume === undefined && r.mute === undefined), `${name} → ${JSON.stringify(r)}`);
    }
  });

  test('only the Master channel counts', (t) => {
    if (typeof parseLastChange !== 'function') return t.skip('upnp.js does not export parseLastChange');
    const body = fixture('upnp/notify-rc-volume-5.xml').replace('channel=&quot;Master&quot;', 'channel=&quot;LF&quot;');
    const r = parseLastChange(body);
    assert.ok(r == null || r.volume === undefined, JSON.stringify(r));
  });
});

describe('LastChange through the UPnP adapter (GENA route)', { skip: skipUnless('server/adapters/upnp.js', 'server/store.js', 'server/config.js') }, () => {
  let mock, lan, upnp, store, writes, dataDir, log;

  before(async () => {
    const { createUpnp } = await import('../server/adapters/upnp.js');
    const { createStore } = await import('../server/store.js');
    const { loadConfig, createDataStore } = await import('../server/config.js');
    mock = await startMockTv();
    mock.setVolume(4);   // the state the TV was in when the sequence was captured
    mock.setMute(true);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-lastchange-'));
    // No polling during the replay: only NOTIFY may move the values.
    const config = loadConfig({ dataDir, tv: mock.tv, timing: merge(FAST_TIMING, { volumePollVisibleMs: 60000, volumePollIdleMs: 60000, genaFallbackMs: 5000 }) });
    store = createStore({});
    writes = [];
    const set = store.set;
    store.set = (key, v, meta) => { writes.push({ key, v, via: meta?.via }); return set(key, v, meta); };
    store.set('conn.tv', 'on', { src: 'live', via: 'test' });
    lan = await createTestLan();
    log = createTestLog();
    upnp = createUpnp({ config, data: createDataStore(dataDir), log, store, lan });
    upnp.start();
  });
  after(async () => {
    await upnp?.stop();
    await lan?.stop();
    await mock?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const genaWrites = (key) => writes.filter((w) => w.key === key && /gena/i.test(String(w.via))).map((w) => w.v);

  test('subscribes with a loopback CALLBACK and goes to push on the initial NOTIFY', async () => {
    await waitFor(() => mock.state.subscriptions.size === 1, { message: 'SUBSCRIBE reached the mock' });
    const [sub] = mock.state.subscriptions.values();
    assert.match(sub.callback, /^http:\/\/127\.0\.0\.1:\d+\/gena\/\w+/);
    assert.equal(sub.timeoutS, 1800);
    await waitFor(() => store.get('conn.events')?.v === 'push', { message: 'conn.events push' });
    await waitFor(() => store.get('audio.volume')?.v === 4 && store.get('audio.mute')?.v === true);
    await mock.flushNotifies();
    assert.equal(mock.state.notifies[0].status, 200, 'the adapter answers NOTIFY with 200');
  });

  test('the real 14-NOTIFY sequence (with empty LastChange events) lands as exactly its values', async () => {
    await sleep(500); // let the adapter's start-up reads land before the replay
    // The TV's own state after the captured sequence, so a stray safety poll agrees with the replay.
    Object.assign(mock.state, { volume: 9, mute: false });
    const before = { volume: genaWrites('audio.volume').length, mute: genaWrites('audio.mute').length };
    for (const n of SEQUENCE.notifies) mock.notifyRaw(n.body);
    await mock.flushNotifies();
    const expectedVolumes = SEQUENCE.notifies.filter((n) => n.volume !== undefined).map((n) => n.volume);
    const expectedMutes = SEQUENCE.notifies.filter((n) => n.mute !== undefined).map((n) => n.mute);
    await waitFor(() => genaWrites('audio.volume').length - before.volume >= expectedVolumes.length);
    assert.deepEqual(genaWrites('audio.volume').slice(before.volume), expectedVolumes);
    assert.deepEqual(genaWrites('audio.mute').slice(before.mute), expectedMutes);
    assert.equal(store.get('audio.volume').v, 9);
    assert.equal(store.get('audio.mute').v, false);
    assert.equal(store.get('audio.volume').src, 'live');
    assert.ok(mock.state.notifies.every((n) => n.status === 200), 'every NOTIFY answered 200');
  });

  test('an empty LastChange alone changes nothing', async () => {
    const count = writes.length;
    mock.notifyRaw(fixture('upnp/notify-rc-empty.xml'));
    await mock.flushNotifies();
    assert.deepEqual(writes.slice(count).filter((w) => w.key.startsWith('audio.')), []);
    assert.equal(store.get('audio.volume').v, 9);
  });

  test('a live change on the TV arrives through GENA', async () => {
    mock.setVolume(17);
    await waitFor(() => store.get('audio.volume')?.v === 17);
    assert.equal(store.get('audio.volume').via, 'gena');
  });
});
