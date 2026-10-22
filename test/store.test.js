// Provenance store contract (spec §5.1, §9.4): record shape, flat snapshot, 50 ms batched patches,
// prefix marks, the live-ranking rule and the state cache.
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skipUnless, sleep, waitFor } from './helpers.js';

const skip = skipUnless('server/store.js');

describe('store', { skip }, () => {
  let createStore;
  before(async () => { ({ createStore } = await import('../server/store.js')); });

  const tmpCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-store-')), 'state-cache.json');
  const collect = (store) => {
    const patches = [];
    store.on('patch', (p) => patches.push({ at: Date.now(), patch: p }));
    return patches;
  };
  /** Waits for the batch already pending, so a fresh collector sees only what happens next. */
  const settle = async (store) => {
    const seen = collect(store);
    await waitFor(() => seen.length > 0);
  };

  test('set returns whether the value changed; get returns the full record', async () => {
    const store = createStore({});
    assert.equal(store.set('audio.volume', 12, { src: 'live', via: 'gena', ttlMs: 60000 }), true);
    assert.equal(store.set('audio.volume', 12, { src: 'live', via: 'gena', ttlMs: 60000 }), false);
    assert.equal(store.set('audio.volume', 13, { src: 'live', via: 'gena', ttlMs: 60000 }), true);
    const rec = store.get('audio.volume');
    for (const field of ['v', 'src', 'via', 'at', 'ttlMs', 'stale', 'range', 'options', 'scope', 'pending', 'note']) {
      assert.ok(field in rec, `record has ${field}`);
    }
    assert.equal(rec.v, 13);
    assert.equal(rec.src, 'live');
    assert.equal(rec.via, 'gena');
    assert.equal(rec.ttlMs, 60000);
    assert.equal(rec.stale, false);
    assert.equal(rec.pending, null, 'pending is unused (§9.4)');
    assert.ok(Math.abs(rec.at - Date.now()) < 1000);
    assert.equal(store.get('audio.nothing'), undefined);
    await store.stop?.({ save: false });
  });

  test('range, options and scope are kept on the record', async () => {
    const store = createStore({});
    store.set('picture.backlight', 10, { src: 'live', via: 'ipc:backlightControl', range: [0, 50], scope: { input: 'TV', mode: 'Standard' } });
    const rec = store.get('picture.backlight');
    assert.deepEqual(rec.range, [0, 50]);
    assert.deepEqual(rec.scope, { input: 'TV', mode: 'Standard' });
    assert.equal(rec.via, 'ipc:backlightControl');
    await store.stop?.({ save: false });
  });

  test('snapshot is the same flat map of dotted keys as patches; object values allowed', async () => {
    const store = createStore({});
    const patches = collect(store);
    store.set('audio.volume', 12, { src: 'live', via: 'gena', ttlMs: 60000 });
    store.set('channel.current', { name: 'Ace TV', number: 1927, type: 'TVPLUS' }, { src: 'agent', via: 'agent:channel', ttlMs: 15000 });
    const snap = store.snapshot();
    assert.equal(snap.audio, undefined, 'not nested');
    assert.equal(snap['audio.volume'].v, 12);
    assert.deepEqual(snap['channel.current'].v, { name: 'Ace TV', number: 1927, type: 'TVPLUS' });
    await waitFor(() => patches.length === 1);
    assert.deepEqual(Object.keys(patches[0].patch).sort(), ['audio.volume', 'channel.current']);
    assert.deepEqual(patches[0].patch['audio.volume'], snap['audio.volume']);
    await store.stop?.({ save: false });
  });

  test('patches are batched about every 50 ms and never emitted synchronously', async () => {
    const store = createStore({});
    const patches = collect(store);
    const t0 = Date.now();
    store.set('audio.volume', 1, { src: 'live', via: 'test' });
    store.set('audio.mute', true, { src: 'live', via: 'test' });
    store.set('audio.volume', 2, { src: 'live', via: 'test' });
    assert.equal(patches.length, 0, 'not synchronous');
    await sleep(25);
    assert.equal(patches.length, 0, 'still batching at 25 ms');
    await waitFor(() => patches.length === 1, { message: 'one batch' });
    await sleep(80);
    assert.equal(patches.length, 1, 'exactly one batch');
    assert.ok(patches[0].at - t0 >= 40, `batched after ${patches[0].at - t0} ms`);
    assert.equal(patches[0].patch['audio.volume'].v, 2, 'latest value of the batch');
    assert.equal(patches[0].patch['audio.mute'].v, true);
    store.set('audio.volume', 3, { src: 'live', via: 'test' });
    await waitFor(() => patches.length === 2, { message: 'a later change makes a new batch' });
    await store.stop?.({ save: false });
  });

  test('mark("picture.*") flags only matching keys stale and publishes them', async () => {
    const store = createStore({});
    store.set('picture.backlight', 10, { src: 'live', via: 'ipc' });
    store.set('picture.contrast', 50, { src: 'live', via: 'ipc' });
    store.set('audio.volume', 12, { src: 'live', via: 'gena' });
    await settle(store);
    const patches = collect(store);
    store.mark('picture.*', { stale: true });
    assert.equal(store.get('picture.backlight').stale, true);
    assert.equal(store.get('picture.contrast').stale, true);
    assert.equal(store.get('audio.volume').stale, false);
    assert.equal(store.get('picture.backlight').v, 10, 'value kept');
    await waitFor(() => patches.length === 1);
    assert.deepEqual(Object.keys(patches[0].patch).sort(), ['picture.backlight', 'picture.contrast']);
    store.set('picture.backlight', 11, { src: 'live', via: 'ipc' });
    assert.equal(store.get('picture.backlight').stale, false, 'a fresh read clears stale');
    await store.stop?.({ save: false });
  });

  test('ranking: agent/derived/cache never replace a live record younger than its ttl', async () => {
    const store = createStore({});
    store.set('audio.volume', 12, { src: 'live', via: 'gena', ttlMs: 60000 });
    for (const src of ['agent', 'derived', 'cache']) {
      store.set('audio.volume', 40, { src, via: src });
      assert.equal(store.get('audio.volume').v, 12, `${src} must not replace fresh live`);
      assert.equal(store.get('audio.volume').src, 'live');
    }
    store.set('audio.volume', 13, { src: 'live', via: 'ipc', ttlMs: 30 });
    assert.equal(store.get('audio.volume').v, 13, 'live replaces live');
    await sleep(60);
    store.set('audio.volume', 14, { src: 'agent', via: 'agent:audio', ttlMs: 15000 });
    assert.equal(store.get('audio.volume').v, 14, 'agent replaces an expired live record');
    assert.equal(store.get('audio.volume').src, 'agent');
    store.set('audio.volume', 15, { src: 'live', via: 'gena', ttlMs: 60000 });
    assert.equal(store.get('audio.volume').v, 15, 'live always replaces agent');
    store.set('general.gameMode', 'Off', { src: 'tracked', via: 'user' });
    store.set('general.gameMode', 'On', { src: 'tracked', via: 'user' });
    assert.equal(store.get('general.gameMode').v, 'On', 'last writer wins otherwise');
    await store.stop?.({ save: false });
  });

  test('state cache: values come back after a restart as src "cache", stale', async () => {
    const cachePath = tmpCache();
    const first = createStore({ cachePath });
    first.set('audio.volume', 12, { src: 'live', via: 'gena', ttlMs: 60000, range: [0, 100] });
    first.set('picture.backlight', 10, { src: 'live', via: 'ipc:backlightControl', range: [0, 50] });
    assert.equal(typeof first.stop, 'function', 'the store persists on stop()');
    await first.stop();
    assert.ok(fs.existsSync(cachePath), 'state-cache.json written');

    const second = createStore({ cachePath });
    const vol = second.get('audio.volume');
    assert.equal(vol.v, 12);
    assert.equal(vol.src, 'cache');
    assert.equal(vol.stale, true);
    assert.equal(second.get('picture.backlight').v, 10);
    assert.equal(second.snapshot()['picture.backlight'].src, 'cache');
    second.set('audio.volume', 9, { src: 'live', via: 'gena', ttlMs: 60000 });
    assert.equal(second.get('audio.volume').src, 'live', 'a live read replaces the cached value');
    await second.stop({ save: false });
    fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
  });

  test('a deleted key is published as null', async (t) => {
    const store = createStore({});
    if (typeof store.delete !== 'function') return t.skip('store exposes no delete()');
    store.set('cast.session', { kind: 'dlna' }, { src: 'live', via: 'cast' });
    await settle(store);
    const patches = collect(store);
    store.delete('cast.session');
    await waitFor(() => patches.length === 1);
    assert.equal(patches[0].patch['cast.session'], null);
    assert.equal(store.snapshot()['cast.session'], undefined);
    await store.stop?.({ save: false });
  });
});
