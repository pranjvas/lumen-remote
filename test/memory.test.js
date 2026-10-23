// Free memory: closes only apps running in the background (never the one on screen, Lumen's agent or
// the voice assistant), reports memory before and after through Eyes, and publishes tv.memory.
// app.installed has the real store shape here: { id, name, color, short, icon } with store ids for the
// apps the agent maps (no tizenId); the agent's tizenIdOf maps them back to the Tizen ids Eyes reports.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemory } from '../server/features/memory.js';
import { createTestLog } from './helpers.js';

function fakeStore(initial) {
  const map = new Map(Object.entries(initial).map(([k, v]) => [k, { v }]));
  return { get: (k) => map.get(k), set: (k, v) => map.set(k, { v }), map };
}

// The pairs agent.js knows (STORE_IDS), as its tizenIdOf answers them.
const TIZEN = {
  '3201907018807': 'org.tizen.netflix-app',
  '111299001912': '9Ur5IzDKqV.TizenYouTube',
  '3201910019365': 'org.tizen.primevideo',
  '3202004020626': 'AQKO41xyKP.AmazonAlexa',
};
const fakeAgent = { tizenIdOf: (id) => TIZEN[id] || id };
const entry = (id, name) => ({ id, name, color: null, short: null, icon: null });
const MB = 1024; // meminfo is in kB

describe('memory', () => {
  test('closes background apps only, measures before/after, publishes tv.memory', async () => {
    const apps = {
      '3201907018807': { name: 'Netflix', running: true, visible: false },
      '111299001912': { name: 'YouTube', running: true, visible: true }, // on screen
      '3201910019365': { name: 'Prime Video', running: false, visible: false },
      'lumenrmt01.LumenAgent': { name: 'Lumen Agent', running: true, visible: false },
      '3202004020626': { name: 'Alexa', running: true, visible: false },
    };
    const closed = [];
    const rest = {
      getApp: async (id) => ({ value: { id, ...apps[id] } }),
      close: async (id) => { closed.push(id); apps[id].running = false; return { value: { id, closed: true } }; },
    };
    let avail = 400 * MB;
    const eyes = { processes: async () => ({ meminfo: { MemTotal: 1837 * MB, MemAvailable: avail, SwapFree: 10 * MB } }) };
    const store = fakeStore({
      'conn.tv': 'on',
      'app.installed': Object.keys(apps).map((id) => entry(id, apps[id].name)),
    });
    const memory = createMemory({
      config: { agent: { appId: 'lumenrmt01.LumenAgent' } }, log: createTestLog(), store, rest, eyes: () => eyes, agent: () => fakeAgent,
      sleep: async () => { avail += 150 * MB; },
    });
    const r = await memory.free();
    assert.deepEqual(closed, ['3201907018807']);
    assert.deepEqual(r.closed.map((c) => c.name), ['Netflix']);
    assert.equal(r.before.availableMb, 400);
    assert.equal(r.after.availableMb, 550);
    assert.equal(r.freedMb, 150);
    assert.equal(store.get('tv.memory').v.availableMb, 550);
  });

  test('with Eyes, the running apps it reports by Tizen id are matched to their store ids', async () => {
    const checked = [];
    const closed = [];
    const rest = {
      getApp: async (id) => { checked.push(id); return { value: { id, name: id, running: true, visible: false } }; },
      close: async (id) => { closed.push(id); return { value: { id, closed: true } }; },
    };
    const eyes = {
      processes: async () => ({
        meminfo: { MemTotal: 1024, MemAvailable: 512, SwapFree: 0 },
        apps: [{ id: 'org.tizen.netflix-app' }, { id: '9Ur5IzDKqV.TizenYouTube' }, { id: 'AQKO41xyKP.AmazonAlexa' }, { id: 'org.tizen.menu' }, { id: 'abcdefghij.Other' }],
      }),
    };
    const store = fakeStore({
      'conn.tv': 'on',
      'app.installed': [entry('3201907018807', 'Netflix'), entry('111299001912', 'YouTube'), entry('3201910019365', 'Prime Video'), entry('3202004020626', 'Alexa'), entry('abcdefghij.Other', 'Other')],
    });
    const memory = createMemory({ config: {}, log: createTestLog(), store, rest, eyes: () => eyes, agent: () => fakeAgent, sleep: async () => {} });
    const r = await memory.free();
    assert.deepEqual(checked, ['3201907018807', '111299001912', 'abcdefghij.Other'], 'Prime is not running; Alexa is kept');
    assert.deepEqual(closed, checked);
    assert.equal(r.freedMb, null, 'no gain is not reported as freed');
  });

  test('without Eyes, the voice assistant is still kept by its store id', async () => {
    const checked = [];
    const rest = {
      getApp: async (id) => { checked.push(id); return { value: { id, name: id, running: true, visible: false } }; },
      close: async (id) => ({ value: { id, closed: true } }),
    };
    const eyes = { processes: async () => { throw new Error('Lumen Eyes did not connect'); } };
    const store = fakeStore({ 'conn.tv': 'on', 'app.installed': [entry('3202004020626', 'Alexa'), entry('3201907018807', 'Netflix')] });
    // No agent seam at all: the store id alone in KEEP is enough.
    const memory = createMemory({ config: {}, log: createTestLog(), store, rest, eyes: () => eyes, sleep: async () => {} });
    await memory.free();
    assert.deepEqual(checked, ['3201907018807']);
  });

  test('Eyes failing: asked once, every app is checked, the agent figure is used and never compared with Eyes', async () => {
    let calls = 0;
    const eyes = { processes: async () => { calls++; throw new Error('Lumen Eyes did not connect'); } };
    const checked = [];
    const rest = {
      getApp: async (id) => { checked.push(id); return { value: { id, name: id, running: true, visible: false } }; },
      close: async (id) => ({ value: { id, closed: true } }),
    };
    const store = fakeStore({
      'conn.tv': 'on',
      'system.memAvailable': 150 * 1048576,
      'system.memTotal': 1837 * 1048576,
      'app.installed': [entry('3201907018807', 'Netflix'), entry('111299001912', 'YouTube')],
    });
    const memory = createMemory({ config: {}, log: createTestLog(), store, rest, eyes: () => eyes, agent: () => fakeAgent, sleep: async () => {} });
    const r = await memory.free();
    assert.ok(calls <= 2, `Eyes asked ${calls} times`);
    assert.equal(calls, 1);
    assert.deepEqual(checked, ['3201907018807', '111299001912']);
    assert.deepEqual(r.before, { availableMb: 150, totalMb: 1837, swapFreeMb: null, via: 'agent' });
    assert.equal(r.after.via, 'agent');
    assert.equal(r.freedMb, null);
    assert.equal(store.get('tv.memory'), undefined, 'the agent figure is not published as tv.memory');
  });

  test('Eyes connecting late does not turn the source change into a false "freed" figure', async () => {
    let calls = 0;
    const eyes = {
      processes: async () => {
        calls++;
        if (calls <= 2) throw new Error('Lumen Eyes did not connect');
        return { meminfo: { MemTotal: 1837 * MB, MemAvailable: 900 * MB, SwapFree: 400 * MB } };
      },
    };
    const rest = {
      getApp: async (id) => ({ value: { id, name: id, running: true, visible: false } }),
      close: async (id) => ({ value: { id, closed: true } }),
    };
    const store = fakeStore({ 'conn.tv': 'on', 'system.memAvailable': 150 * 1048576, 'app.installed': [entry('3201907018807', 'Netflix')] });
    const memory = createMemory({ config: {}, log: createTestLog(), store, rest, eyes: () => eyes, agent: () => fakeAgent, sleep: async () => {} });
    const r = await memory.free();
    assert.equal(r.closed.length, 1);
    assert.equal(r.before.via, 'agent');
    assert.equal(r.after.via, 'agent', 'after is read from the same source as before');
    assert.equal(r.freedMb, null);
  });

  test('Eyes dropping out after the first reading: the mixed before/after is not reported as freed', async () => {
    let calls = 0;
    const eyes = {
      processes: async () => {
        calls++;
        if (calls > 1) throw new Error('Lumen Eyes disconnected');
        return { meminfo: { MemTotal: 1837 * MB, MemAvailable: 300 * MB, SwapFree: 100 * MB }, apps: [{ id: 'org.tizen.netflix-app' }] };
      },
    };
    const rest = {
      getApp: async (id) => ({ value: { id, name: id, running: true, visible: false } }),
      close: async (id) => ({ value: { id, closed: true } }),
    };
    const store = fakeStore({ 'conn.tv': 'on', 'system.memAvailable': 2000 * 1048576, 'app.installed': [entry('3201907018807', 'Netflix')] });
    const memory = createMemory({ config: {}, log: createTestLog(), store, rest, eyes: () => eyes, agent: () => fakeAgent, sleep: async () => {} });
    const r = await memory.free();
    assert.equal(r.before.via, 'eyes');
    assert.equal(r.after.via, 'agent');
    assert.equal(r.freedMb, null);
  });

  test('swap counts only when both readings have it', async () => {
    let n = 0;
    const eyes = {
      processes: async () => (n++ === 0
        ? { meminfo: { MemTotal: 1837 * MB, MemAvailable: 300 * MB }, apps: [{ id: 'org.tizen.netflix-app' }] }
        : { meminfo: { MemTotal: 1837 * MB, MemAvailable: 320 * MB, SwapFree: 500 * MB } }),
    };
    const rest = {
      getApp: async (id) => ({ value: { id, name: id, running: true, visible: false } }),
      close: async (id) => ({ value: { id, closed: true } }),
    };
    const store = fakeStore({ 'conn.tv': 'on', 'app.installed': [entry('3201907018807', 'Netflix')] });
    const memory = createMemory({ config: {}, log: createTestLog(), store, rest, eyes: () => eyes, agent: () => fakeAgent, sleep: async () => {} });
    const r = await memory.free();
    assert.equal(r.freedMb, 20);
  });

  test('the Settings poll reads through Eyes only while it is connected, and never starts it', async () => {
    let online = false;
    let calls = 0;
    const eyes = {
      status: () => ({ online }),
      processes: async () => { calls++; return { meminfo: { MemTotal: 1837 * MB, MemAvailable: 700 * MB, SwapFree: 0 } }; },
    };
    const store = fakeStore({ 'conn.tv': 'on', 'system.memAvailable': 150 * 1048576 });
    const memory = createMemory({ config: {}, log: createTestLog(), store, rest: {}, eyes: () => eyes, agent: () => fakeAgent });
    try {
      memory.setDemand({ views: new Set(['settings']) });
      await new Promise((r) => setImmediate(r));
      assert.equal(calls, 0, 'Eyes is not asked (or launched) while it is offline');
      assert.equal(store.get('tv.memory'), undefined);
      memory.setDemand({ views: new Set() });
      online = true;
      memory.setDemand({ views: new Set(['settings']) });
      await new Promise((r) => setImmediate(r));
      assert.equal(calls, 1);
      assert.equal(store.get('tv.memory').v.availableMb, 700);
    } finally {
      memory.stop();
    }
    // A direct reading may still start Eyes; without it, the agent figure is read from the store.
    online = false;
    const offline = createMemory({ config: {}, log: createTestLog(), store, rest: {}, eyes: () => ({ processes: async () => { throw new Error('no Eyes'); } }) });
    assert.deepEqual(await offline.reading(), { availableMb: 150, totalMb: null, swapFreeMb: null, via: 'agent' });
  });

  test('refuses while the TV is off, and needs the app list', async () => {
    const memory = createMemory({ config: {}, log: createTestLog(), store: fakeStore({ 'conn.tv': 'standby' }), rest: {}, eyes: () => ({}) });
    await assert.rejects(memory.free(), /off/);
    const memory2 = createMemory({ config: {}, log: createTestLog(), store: fakeStore({ 'conn.tv': 'on' }), rest: {}, eyes: () => ({}) });
    await assert.rejects(memory2.free(), /apps/);
  });
});
