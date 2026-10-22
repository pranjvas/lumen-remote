// Cross-module contracts found while integrating the builders' work: subject ids travel as
// `target` (the frame id stays the frame id), presence 'now' reads the at-a-glance picture values,
// cast controls are not undone by a poll in flight, holds, labels, tracked values, the cached app
// list, and tools/dev-stack.mjs (mock TV + real server, loopback only).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { skipUnless, startStack, waitFor, sleep, request } from './helpers.js';

const skip = skipUnless('server/app.js', 'tools/dev-stack.mjs');

describe('integration: browser commands across modules', { skip }, () => {
  let stack, mock, b;
  before(async () => {
    stack = await startStack();
    ({ mock } = stack);
    b = stack.browser();
    await b.hello;
    await b.waitForState('conn.tv', (r) => r?.v === 'on', { timeout: 8000 });
    await b.waitForState('conn.remote', (r) => r?.v === 'paired', { timeout: 8000 });
  });
  after(() => stack?.stop());

  test('scene.run / scene.delete take the scene id as `target` and ack the frame id', async () => {
    const saved = await b.send('scene.save', { scene: { name: 'Integration', steps: [{ cmd: 'setting.set', key: 'picture.backlight', value: 13 }] } });
    assert.equal(saved.ok, true, JSON.stringify(saved.error));
    const run = await b.send('scene.run', { target: saved.value.id }, { timeout: 10000 });
    assert.equal(run.ok, true, JSON.stringify(run.error));
    assert.equal(mock.state.picture.backlight, 13);
    const removed = await b.send('scene.delete', { target: saved.value.id });
    assert.equal(removed.ok, true);
    await b.waitForState('scenes', (r) => r && !r.v.some((s) => s.id === saved.value.id));
  });

  test('macro.record → run → delete with `target`', async () => {
    assert.equal((await b.send('macro.record', { phase: 'start' })).ok, true);
    assert.equal((await b.send('key', { key: 'KEY_7' })).ok, true);
    const stopped = await b.send('macro.record', { phase: 'stop', name: 'Seven' });
    assert.equal(stopped.ok, true, JSON.stringify(stopped.error));
    const id = stopped.value.id;
    const mark = mock.keysSent().length;
    const run = await b.send('macro.run', { target: id });
    assert.equal(run.ok, true, JSON.stringify(run.error));
    // The ack and the key frame travel on different sockets: give the mock a moment to record the key.
    await waitFor(() => mock.keysSent().length > mark, { timeout: 3000, message: 'the replayed key reached the mock' });
    assert.deepEqual(mock.keysSent().slice(mark), ['KEY_7']);
    assert.equal((await b.send('macro.delete', { target: id })).ok, true);
  });

  test('hold: a repeat key clicks while beats arrive; a press key is Press … Release', async () => {
    const mark = mock.state.keys.length;
    assert.equal((await b.send('hold', { key: 'KEY_LEFT', phase: 'start' })).ok, true);
    for (let i = 0; i < 3; i++) {
      await sleep(250);
      b.fire('hold', { key: 'KEY_LEFT', phase: 'beat' });
    }
    assert.equal((await b.send('hold', { key: 'KEY_LEFT', phase: 'end' })).ok, true);
    const lefts = mock.state.keys.slice(mark).filter((k) => k.key === 'KEY_LEFT');
    assert.ok(lefts.length >= 4 && lefts.every((k) => k.cmd === 'Click'), `${lefts.length} clicks`);

    assert.equal((await b.send('hold', { key: 'KEY_RETURN', phase: 'start' })).ok, true);
    await sleep(300);
    assert.equal((await b.send('hold', { key: 'KEY_RETURN', phase: 'end' })).ok, true);
    await waitFor(() => mock.state.keys.some((k) => k.key === 'KEY_RETURN' && k.cmd === 'Release'));
    const back = mock.state.keys.filter((k) => k.key === 'KEY_RETURN').map((k) => k.cmd);
    assert.deepEqual(back, ['Press', 'Release']);
    assert.equal(mock.state.pressed.size, 0);
  });

  test('input.label and a tracked setting are stored as tracked and persisted', async () => {
    const label = await b.send('input.label', { source: 'HDMI1', label: 'PlayStation' });
    assert.equal(label.ok, true);
    await b.waitForState('input.labels', (r) => r?.v?.HDMI1 === 'PlayStation' && r.src === 'tracked');
    const tracked = await b.send('tracked.set', { key: 'sound.balance', value: 5 });
    assert.equal(tracked.ok, true, JSON.stringify(tracked.error));
    await b.waitForState('sound.balance', (r) => r?.v === 5 && r.src === 'tracked');
    const file = stack.data.read('tracked.json');
    assert.equal(file.labels.HDMI1, 'PlayStation');
    assert.equal(file.values['sound.balance'].v, 5);
  });

  test("presence 'now' (desktop dashboard) reads backlight and contrast without the Settings sweep", async () => {
    const fresh = stack.browser();
    await fresh.hello;
    await fresh.send('view', { name: 'now', visible: true });
    mock.setPicture('backlight', 21);
    const since = mock.state.requests.ipc.length;
    await fresh.waitForState('picture.backlight', (r) => r?.v === 21 && r.src === 'live', { timeout: 5000 });
    await sleep(800);
    const methods = new Set(mock.state.requests.ipc.slice(since).map((r) => r.method));
    assert.ok(methods.has('backlightControl') && methods.has('getVideoStates'), [...methods].join());
    assert.ok(!methods.has('localDimmingControl'), 'the full picture sweep stays off outside Settings');
    fresh.close();
  });

  test('a cast control is not undone by a transport poll already in flight', async () => {
    mock.options.dmrFetch = false; // a placeholder URL the renderer could never fetch: this test is about the poll race
    const cast = await b.send('cast.url', { url: 'http://127.0.0.1:9/clip.mp4' }, { timeout: 15000 });
    assert.equal(cast.ok, true, JSON.stringify(cast.error));
    // Issue the pause exactly while a poll's GetTransportInfo (which will still say PLAYING) is
    // at the TV: the user command jumps the queue, so the poll's answer lands after it.
    const ack = await new Promise((resolve) => {
      const onSoap = ({ action }) => {
        if (action !== 'GetTransportInfo') return;
        mock.events.off('soap', onSoap);
        b.send('cast.control', { action: 'pause' }).then(resolve);
      };
      mock.events.on('soap', onSoap);
    });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(ack.value.state, 'PAUSED_PLAYBACK');
    await sleep(600); // the poll that was in flight has published (or been dropped) by now
    assert.equal(b.value('cast.session').state, 'PAUSED_PLAYBACK', 'no late poll brought back PLAYING');
    assert.equal((await b.send('cast.control', { action: 'stop' })).ok, true);
    mock.options.dmrFetch = true;
  });
});

describe('integration: restart keeps the agent app list from the cache', { skip }, () => {
  test('app.installed from the agent survives a restart (stale) instead of the curated seed', async () => {
    const first = await startStack();
    const agent = first.agent();
    const b = first.browser();
    await b.hello;
    await b.waitForState('app.installed', (r) => r?.src === 'agent', { timeout: 8000 });
    agent.close();
    const { startServer } = await import('../server/app.js');
    const config = first.server.config;
    await first.server.stop();
    b.close();
    const again = await startServer({ dataDir: first.dataDir, tv: first.mock.tv, http: { port: 0 }, lan: { enabled: false }, ai: { backend: 'off' }, log: { level: 'warn', console: false }, wol: config.wol });
    try {
      const rec = again.store.get('app.installed');
      assert.equal(rec.src, 'cache');
      assert.ok(rec.v.some((a) => a.id === 'LumenTest0.Sideloaded'), 'the agent-only app is still listed');
    } finally {
      await again.stop();
      await first.mock.stop();
      first.data.cleanup();
    }
  });
});

describe('integration: tools/dev-stack.mjs', { skip }, () => {
  test('starts the mock TV + real server on loopback with the fake agent, and cleans up', async () => {
    const { startDevStack } = await import('../tools/dev-stack.mjs');
    const stack = await startDevStack({ port: 0, ai: 'fake' });
    try {
      assert.match(stack.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      const health = await request({ port: stack.server.httpPort, path: '/api/health', headers: { Host: `127.0.0.1:${stack.server.httpPort}` } });
      assert.equal(JSON.parse(health.body).app, 'lumen');
      assert.equal(stack.server.config.tv.host, '127.0.0.1', 'never the real TV');
      assert.deepEqual(stack.server.config.wol.targets, ['127.0.0.1'], 'WoL only to the mock');
      await waitFor(() => stack.server.store.get('conn.agent')?.v === 'online', { timeout: 8000 });
      await waitFor(() => stack.server.store.get('conn.tv')?.v === 'on', { timeout: 8000 });
      const ai = await stack.server.hub.handle({ cmd: 'ai.ask', text: 'switch to HDMI 1', id: 'dev-ai' });
      assert.equal(ai.ok, true);
      await waitFor(() => stack.mock.state.input === 'HDMI1', { timeout: 8000, message: 'scripted AI ran set_input through the hub' });
    } finally {
      await stack.stop();
    }
    assert.equal(fs.existsSync(stack.dataDir), false, 'temp data dir removed');
  });
});

describe('integration: web live link frames', () => {
  test('an argument named id or cmd can never replace the frame id or command', async () => {
    const sent = [];
    class FakeSocket extends EventTarget {
      static OPEN = 1;
      readyState = 1;
      send(text) { sent.push(JSON.parse(text)); }
    }
    const saved = globalThis.WebSocket;
    globalThis.WebSocket = FakeSocket;
    try {
      const { createLive } = await import('../web/js/core/live.js');
      const live = createLive({ url: 'ws://127.0.0.1:1/live' });
      live.connect();
      const pending = live.send('scene.run', { id: 'night', cmd: 'power', t: 'x' }, { id: 'frame-1', timeoutMs: 50 });
      live.post('macro.run', { id: 'macro-1' });
      assert.deepEqual(sent[0], { t: 'cmd', id: 'frame-1', cmd: 'scene.run' });
      assert.equal(sent[1].cmd, 'macro.run');
      assert.notEqual(sent[1].id, 'macro-1');
      assert.equal((await pending).error.code, 'TIMEOUT');
    } finally {
      globalThis.WebSocket = saved;
    }
  });
});

describe('integration: Ask status in hello', { skip }, () => {
  test('a browser that connects while the Claude Code login check runs gets the settled status', async () => {
    let availability = null;
    let probe = null;
    const agentSdk = {
      availability: () => availability,
      isAvailable() {
        probe ??= new Promise((resolve) => setTimeout(() => { availability = { available: true, reason: null }; resolve(true); }, 400));
        return probe;
      },
      run: async () => ({ ok: true, text: 'unused', tools: [] }),
    };
    const api = { isConfigured: () => false, run: async () => ({ ok: false, tools: [] }) };
    const { startServer } = await import('../server/app.js');
    const data = (await import('./helpers.js')).makeDataDir();
    const server = await startServer({
      dataDir: data.dir, tv: { host: '127.0.0.1', ports: { rest: 9, wss: 9, dmr: 9, ipc: 9, dial: 9 } },
      http: { port: 0 }, lan: { enabled: false }, ai: { backend: 'auto' }, log: { level: 'warn', console: false },
      wol: { targets: ['127.0.0.1'], ports: [9] },
    }, { aiBackends: { api, agentSdk } });
    const { connectBrowser } = await import('./helpers.js');
    const b = connectBrowser(server.httpPort);
    try {
      const hello = await b.hello;
      assert.deepEqual([hello.ai.backend, hello.ai.ready], ['agent-sdk', true]);
    } finally {
      b.close();
      await server.stop();
      data.cleanup();
    }
  });
});
