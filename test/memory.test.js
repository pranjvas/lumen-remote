// Free memory: closes only apps running in the background (never the one on screen, Lumen's agent or
// the voice assistant), reports memory before and after through Eyes, and publishes tv.memory.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemory } from '../server/features/memory.js';
import { createTestLog } from './helpers.js';

function fakeStore(initial) {
  const map = new Map(Object.entries(initial).map(([k, v]) => [k, { v }]));
  return { get: (k) => map.get(k), set: (k, v) => map.set(k, { v }), map };
}

describe('memory', () => {
  test('closes background apps only, measures before/after, publishes tv.memory', async () => {
    const apps = {
      'netflix-id': { name: 'Netflix', running: true, visible: false },
      'youtube-id': { name: 'YouTube', running: true, visible: true }, // on screen
      'prime-id': { name: 'Prime Video', running: false, visible: false },
      'lumenrmt01.LumenAgent': { name: 'Lumen Agent', running: true, visible: false },
      'AQKO41xyKP.AmazonAlexa': { name: 'Alexa', running: true, visible: false },
    };
    const closed = [];
    const rest = {
      getApp: async (id) => ({ value: { id, ...apps[id] } }),
      close: async (id) => { closed.push(id); apps[id].running = false; return { value: { id, closed: true } }; },
    };
    let avail = 400 * 1024;
    const eyes = { processes: async () => ({ meminfo: { MemTotal: 1837 * 1024, MemAvailable: avail, SwapFree: 10 * 1024 } }) };
    const store = fakeStore({
      'conn.tv': 'on',
      'app.installed': Object.keys(apps).map((id) => ({ id, name: apps[id].name })),
    });
    const memory = createMemory({
      config: { agent: { appId: 'lumenrmt01.LumenAgent' } }, log: createTestLog(), store, rest, eyes: () => eyes,
      sleep: async () => { avail += 150 * 1024; },
    });
    const r = await memory.free();
    assert.deepEqual(closed, ['netflix-id']);
    assert.deepEqual(r.closed.map((c) => c.name), ['Netflix']);
    assert.equal(r.before.availableMb, 400);
    assert.equal(r.after.availableMb, 550);
    assert.equal(r.freedMb, 150);
    assert.equal(store.get('tv.memory').v.availableMb, 550);
  });

  test('with Eyes, only the apps it sees running are checked', async () => {
    const checked = [];
    const rest = {
      getApp: async (id) => { checked.push(id); return { value: { id, name: id, running: true, visible: false } }; },
      close: async (id) => ({ value: { id, closed: true } }),
    };
    const eyes = { processes: async () => ({ meminfo: { MemTotal: 1024, MemAvailable: 512, SwapFree: 0 }, apps: [{ id: 'org.tizen.netflix-app' }, { id: 'org.tizen.menu' }] }) };
    const store = fakeStore({ 'conn.tv': 'on', 'app.installed': [{ id: '3201907018807', tizenId: 'org.tizen.netflix-app' }, { id: '3201910019365', tizenId: 'org.tizen.primevideo' }] });
    const memory = createMemory({ config: {}, log: createTestLog(), store, rest, eyes: () => eyes, sleep: async () => {} });
    const r = await memory.free();
    assert.deepEqual(checked, ['3201907018807']);
    assert.equal(r.freedMb, null, 'no gain is not reported as freed');
  });

  test('refuses while the TV is off, and needs the app list', async () => {
    const memory = createMemory({ config: {}, log: createTestLog(), store: fakeStore({ 'conn.tv': 'standby' }), rest: {}, eyes: () => ({}) });
    await assert.rejects(memory.free(), /off/);
    const memory2 = createMemory({ config: {}, log: createTestLog(), store: fakeStore({ 'conn.tv': 'on' }), rest: {}, eyes: () => ({}) });
    await assert.rejects(memory2.free(), /apps/);
  });
});
