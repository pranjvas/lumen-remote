// Lumen Eyes: the screen.capture command launches the eyes app through the TV agent (app-control
// "lumen" = the /eyes WebSocket URL), receives an NV12 frame, serves it as a 16:9 PNG at
// /api/screen.png, and the AI's look_at_screen tool returns it as image content.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startStack, request, waitFor } from './helpers.js';
import { nv12ToRgb, nv12ToPng } from '../server/util/image.js';
import { callTool } from '../server/ai/tools.js';

const W = 720;
const H = 540;

// A synthetic screen: left half white, right half black, neutral chroma.
function frame() {
  const buf = Buffer.alloc(W * H * 1.5, 128);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) buf[y * W + x] = x < W / 2 ? 235 : 16;
  return buf;
}

// A fake org.lumen.eyes: dials the URL Lumen passed, says hello, answers capture requests.
function connectEyes(url, { fail = false } = {}) {
  const ws = new WebSocket(url);
  const captures = [];
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', version: '0.2.0' })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.t !== 'capture') return;
    captures.push(msg);
    if (fail) {
      ws.send(JSON.stringify({ t: 'frame', id: msg.id, ok: false, error: 'capture failed (-1, 0x0, format 2)' }));
      return;
    }
    const header = Buffer.from(JSON.stringify({ t: 'frame', id: msg.id, ok: true, w: W, h: H, format: 'nv12', ms: 42 }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length, 0);
    ws.send(Buffer.concat([length, header, frame()]));
  });
  ws.on('error', () => {});
  return { ws, captures, close: () => ws.terminate() };
}

function pngSize(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe('image: NV12 → RGB → PNG', () => {
  test('limited-range white and black map to full range; the frame is stretched to 16:9', () => {
    const rgb = nv12ToRgb(frame(), W, H, 960, 540);
    assert.deepEqual([...rgb.subarray(0, 3)], [255, 255, 255]);
    const last = (540 * 960 - 1) * 3;
    assert.deepEqual([...rgb.subarray(last, last + 3)], [0, 0, 0]);
    const { png, width, height } = nv12ToPng(frame(), W, H);
    assert.deepEqual({ width, height }, { width: 960, height: 540 });
    assert.deepEqual(pngSize(png), { width: 960, height: 540 });
    assert.throws(() => nv12ToRgb(Buffer.alloc(10), W, H), RangeError);
  });
});

describe('eyes: screen capture through the TV agent', () => {
  let stack, b, agent;
  const eyes = [];

  before(async () => {
    stack = await startStack();
    b = stack.browser();
    await b.hello;
  });
  after(async () => {
    for (const e of eyes) e.close();
    await stack?.stop();
  });

  test('without the TV agent, screen.capture says the agent is needed', async () => {
    const ack = await b.send('screen.capture', {}, { timeout: 15000 });
    assert.equal(ack.ok, false);
    assert.equal(ack.error.code, 'UNAVAILABLE');
    assert.match(ack.error.message, /TV agent/);
  });

  test('a connection with the wrong key is refused', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${stack.lanPort}/eyes?key=${'0'.repeat(64)}`);
    const outcome = await new Promise((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('refused'));
      ws.once('unexpected-response', () => resolve('refused'));
    });
    assert.equal(outcome, 'refused');
  });

  test('screen.capture launches Lumen Eyes through the agent and serves the frame as a 16:9 PNG', async () => {
    agent = stack.agent();
    agent.onRequest((msg) => {
      if (msg.type === 'launch' && msg.appId === 'org.lumen.eyes') eyes.push(connectEyes(msg.data.lumen));
    });
    await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
    const ack = await b.send('screen.capture', {}, { timeout: 20000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(ack.value.width, 960);
    assert.equal(ack.value.height, 540);
    assert.match(ack.value.url, /^\/api\/screen\.png\?at=\d+$/);

    const launch = agent.requests.find((r) => r.type === 'launch' && r.appId === 'org.lumen.eyes');
    assert.match(launch.data.lumen, /^ws:\/\/127\.0\.0\.1:\d+\/eyes\?key=[0-9a-f]{64}$/);
    await b.waitForState('conn.eyes', (r) => r?.v === 'online', { timeout: 5000 });

    const res = await request({ port: stack.httpPort, path: '/api/screen.png' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  test('a second capture reuses the open connection (no new launch)', async () => {
    const launches = () => agent.requests.filter((r) => r.type === 'launch' && r.appId === 'org.lumen.eyes').length;
    const before = launches();
    const ack = await b.send('screen.capture', { mode: 1 }, { timeout: 20000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(launches(), before);
    assert.equal(eyes.at(-1).captures.at(-1).mode, 1);
    const bad = await b.send('screen.capture', { mode: 7 }, { timeout: 5000 });
    assert.equal(bad.error.code, 'INVALID');
  });

  test('look_at_screen returns the picture as image content, not inside the JSON text', async () => {
    const ctx = { hub: stack.server.hub, store: stack.server.store, eyes: stack.server.adapters.eyes };
    stack.server.store.set('app.foreground', { id: '3201907018807', name: 'Netflix' }, { src: 'live', via: 'test' });
    const out = await callTool('look_at_screen', {}, ctx);
    assert.equal(out.isError, false, out.text);
    assert.equal(out.images.length, 1);
    assert.equal(out.images[0].mimeType, 'image/png');
    assert.deepEqual(pngSize(Buffer.from(out.images[0].data, 'base64')), { width: 960, height: 540 });
    assert.ok(out.text.length < 500, 'no base64 in the text');
  });

  test('the Screen view drives a capture loop: on while watched, off when paused or left', async () => {
    const live = eyes.at(-1);
    const count = () => live.captures.length;
    await b.send('view', { name: 'screen', visible: true });
    await b.waitForState('screen.watching', (r) => r?.v === 1000, { timeout: 5000 });
    const start = count();
    await waitFor(() => count() >= start + 2, { timeout: 5000, what: 'two looped captures' });

    const paused = await b.send('screen.watch', { everyMs: 0 });
    assert.equal(paused.ok, true, JSON.stringify(paused.error));
    await b.waitForState('screen.watching', (r) => r?.v === 0, { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    const atPause = count();
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(count(), atPause, 'no captures while paused');

    assert.equal((await b.send('screen.watch', { everyMs: 100 })).error.code, 'INVALID');
    assert.equal((await b.send('screen.watch', { everyMs: 5000 })).ok, true);
    await b.waitForState('screen.watching', (r) => r?.v === 5000, { timeout: 5000 });
    await b.send('view', { name: 'remote', visible: true });
    await b.waitForState('screen.watching', (r) => r?.v === 0, { timeout: 5000 });
  });

  test('a capture the TV refuses is reported as FAILED', async () => {
    eyes.at(-1).close();
    await b.waitForState('conn.eyes', (r) => r?.v === 'offline', { timeout: 5000 });
    agent.onRequest((msg) => {
      if (msg.type === 'launch' && msg.appId === 'org.lumen.eyes') {
        eyes.pop()?.close();
        eyes.push(connectEyes(msg.data.lumen, { fail: true }));
      }
    });
    const ack = await b.send('screen.capture', {}, { timeout: 20000 });
    assert.equal(ack.ok, false);
    assert.equal(ack.error.code, 'FAILED');
    assert.match(ack.error.message, /could not capture/);
    await waitFor(() => eyes.at(-1).captures.length === 1, { timeout: 2000, what: 'the failing capture' });
  });
});
