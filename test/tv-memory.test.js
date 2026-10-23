// The TV's memory end to end: rest.close() (REST DELETE /api/v2/applications/<id>/) and its errors,
// Lumen Eyes answering a { t: 'procs' } request (routed through the adapter's pending replies), and
// the hub's tv.processes / tv.freeMemory plus the AI's free_tv_memory tool against the mock TV.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { startStack, waitFor, createTestLog, FAST_TIMING } from './helpers.js';
import { createRest } from '../server/adapters/rest.js';
import { callTool } from '../server/ai/tools.js';

describe('rest.close: quitting an app over REST', () => {
  let server, rest;
  const seen = [];
  const replies = {
    'closes.it': [200, 'true'],
    'already.gone': [200, 'false'],
    'not.installed': [404, '{"code":404,"message":"Not found error.","status":404}'],
    'refuses.it': [500, '{"code":-1}'],
  };

  before(async () => {
    server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const id = decodeURIComponent(/^\/api\/v2\/applications\/([^/]+)\/$/.exec(req.url)?.[1] ?? '');
      const [status, body] = replies[id] ?? [404, ''];
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const store = { map: new Map(), get(k) { return this.map.get(k); }, set(k, v) { this.map.set(k, { v }); } };
    const config = { tv: { host: '127.0.0.1', ports: { rest: server.address().port } }, timing: FAST_TIMING };
    rest = createRest({ config, data: null, log: createTestLog(), store }); // never started: no polling
  });
  after(async () => {
    await rest?.stop();
    server?.close();
  });

  test('200 closes it (the body says whether it was running); 404 is UNAVAILABLE; any other status is FAILED', async () => {
    assert.deepEqual(await rest.close('closes.it'), { value: { id: 'closes.it', closed: true } });
    assert.deepEqual(await rest.close('already.gone'), { value: { id: 'already.gone', closed: false } });
    await assert.rejects(rest.close('not.installed'), (err) => err.code === 'UNAVAILABLE' && /not installed/.test(err.message));
    await assert.rejects(rest.close('refuses.it'), (err) => err.code === 'FAILED' && /HTTP 500/.test(err.message));
    assert.deepEqual(seen, ['closes.it', 'already.gone', 'not.installed', 'refuses.it'].map((id) => `DELETE /api/v2/applications/${id}/`));
  });

  test('a bad app id is refused before anything is sent', async () => {
    const before = seen.length;
    await assert.rejects(rest.close('../api'), (err) => err.code === 'INVALID');
    await assert.rejects(rest.close(42), (err) => err.code === 'INVALID');
    assert.equal(seen.length, before);
  });
});

// A fake org.lumen.eyes that answers memory requests. A stray reply for another id comes first: it
// must not resolve the request.
function connectEyes(url, meminfo) {
  const ws = new WebSocket(url);
  const asked = [];
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', version: '0.3.2' })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.t !== 'procs') return;
    asked.push(msg);
    ws.send(JSON.stringify({ t: 'procs', id: 'not-this-one', meminfo: { MemTotal: 1, MemAvailable: 1 } }));
    ws.send(JSON.stringify({
      t: 'procs', id: msg.id, meminfo: meminfo(),
      procs: [{ pid: 812, name: 'WebProcess', rssKb: 204800, cmd: '/usr/bin/WebProcess' }],
    }));
  });
  ws.on('error', () => {});
  return { asked, close: () => ws.terminate() };
}

describe('tv.processes and tv.freeMemory through Lumen Eyes and the mock TV', () => {
  let stack, b, agent, eyes;
  let availKb = 400 * 1024;

  before(async () => {
    stack = await startStack();
    b = stack.browser();
    await b.hello;
    agent = stack.agent();
    agent.onRequest((msg) => {
      if (msg.type === 'launch' && msg.appId === 'org.lumen.eyes') {
        eyes?.close();
        eyes = connectEyes(msg.data.lumen, () => ({ MemTotal: 1837 * 1024, MemAvailable: availKb, SwapFree: 10 * 1024 }));
      }
    });
    await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
    await b.waitForState('conn.tv', (r) => r?.v === 'on', { timeout: 10000 });
    await b.waitForState('app.installed', (r) => r?.src === 'agent', { timeout: 10000 });
  });
  after(async () => {
    eyes?.close();
    await stack?.stop();
  });

  test('tv.processes resolves with Eyes\' reply for this request, without its t and id, and without command lines', async () => {
    const ack = await b.send('tv.processes', {}, { timeout: 20000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.deepEqual(ack.value, {
      meminfo: { MemTotal: 1837 * 1024, MemAvailable: 400 * 1024, SwapFree: 10 * 1024 },
      procs: [{ pid: 812, name: 'WebProcess', rssKb: 204800 }],
    });
    assert.equal(eyes.asked.length, 1);
  });

  test('tv.freeMemory closes the background apps over REST DELETE, never the one on screen', async () => {
    // Netflix comes on screen; YouTube and CineHD (on screen until now) keep running behind it. The
    // agent's other app (Sideloaded) is not on the mock TV: its status check 404s and it is skipped.
    stack.mock.setForeground('3201907018807');
    const deletes = () => stack.mock.state.requests.rest.filter((r) => r.method === 'DELETE').map((r) => r.path);
    const askedBefore = eyes.asked.length;
    const freeing = b.send('tv.freeMemory', {}, { timeout: 30000 });
    await waitFor(() => deletes().length === 2, { timeout: 15000, what: 'the DELETEs' });
    availKb += 150 * 1024; // what Eyes reads once the apps have gone
    const ack = await freeing;
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.deepEqual(deletes().sort(), ['/api/v2/applications/111299001912/', '/api/v2/applications/pvcinehd01.CineHDTV/']);
    assert.deepEqual(ack.value.closed.map((c) => c.name).sort(), ['CineHD TV', 'YouTube']);
    assert.equal(ack.value.before.availableMb, 400);
    assert.equal(ack.value.after.availableMb, 550);
    assert.equal(ack.value.freedMb, 150);
    assert.ok(eyes.asked.length >= askedBefore + 2, 'memory read before and after through Eyes');
    assert.equal((await stack.server.adapters.rest.getApp('111299001912')).value.running, false, 'the mock TV quit it');
    assert.equal((await stack.server.adapters.rest.getApp('3201907018807')).value.visible, true, 'Netflix stays on screen');
  });

  test('the AI\'s free_tv_memory tool names what it closed, or says nothing was running', async () => {
    const ctx = { hub: stack.server.hub, store: stack.server.store };
    stack.mock.setForeground('111299001912'); // YouTube runs again, then goes behind Netflix
    stack.mock.setForeground('3201907018807');
    const closed = await callTool('free_tv_memory', {}, ctx);
    assert.equal(closed.isError, false, closed.text);
    assert.deepEqual(closed.result.closed, ['YouTube']);
    assert.equal(closed.result.summary, 'Closed YouTube');
    const none = await callTool('free_tv_memory', {}, ctx);
    assert.equal(none.isError, false, none.text);
    assert.deepEqual(none.result.closed, []);
    assert.equal(none.result.summary, 'No apps were running in the background');
  });
});
