// Lumen browser on the TV: "On TV" puts the agent in screen mode, streams the browser's frames to it
// as binary JPEG messages, moves a pointer with the remote's arrows, and Red closes it. Yellow with
// no video on the page says so. Real headless Edge, mock TV, fake agent.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { startStack, waitFor, createTestLog } from './helpers.js';
import { callTool } from '../server/ai/tools.js';
import { createTvScreen, youtubeStateScript } from '../server/features/tvscreen.js';

const EDGE = process.env.LUMEN_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const skip = !fs.existsSync(EDGE) && `headless Edge is not installed at ${EDGE}`;

describe('tvscreen: Lumen browser on the TV', { skip }, () => {
  let stack, b, agent, web;

  before(async () => {
    web = http.createServer((req, res) => {
      if (req.url.startsWith('/clip.m3u8')) {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end(['#EXTM3U', '#EXTINF:4,', 'seg.ts', '#EXT-X-ENDLIST', ''].join('\n'));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      // A page with a big video whose playing state the test controls (headless Edge plays no HLS).
      // An embedded player filling the page (as Dailymotion's does), its video inside the iframe.
      if (req.url.startsWith('/framed')) {
        res.end('<title>Framed</title><style>body{margin:0}</style><iframe id="pf" src="/video" style="width:100vw;height:90vh;border:0"></iframe>');
        return;
      }
      if (req.url.startsWith('/video')) {
        res.end('<title>Video</title><video id="v" src="/clip.m3u8" style="width:100vw;height:80vh"></video>'
          + '<script>let p = true; Object.defineProperty(v, "paused", { get: () => p }); v.pause = () => { p = true; }; window.startIt = () => { p = false; };</script>');
        return;
      }
      // YouTube's player as its page script sees it: an .html5-video-player element with the player API.
      if (req.url.startsWith('/ytplayer')) {
        res.end('<title>Clip - YouTube</title><div class="html5-video-player" id="movie_player"><video style="width:100vw;height:80vh"></video></div>'
          + '<script>const p = document.getElementById("movie_player"); p.getVideoData = () => ({ video_id: "dQw4w9WgXcQ", isLive: false }); p.getCurrentTime = () => 75.5;</script>');
        return;
      }
      // A page that logs where the mouse moves and clicks (CSS pixels), tall enough to scroll.
      if (req.url.startsWith('/pointer')) {
        res.end('<title>Pointer</title><div style="height:4000px"></div><script>window.log = [];'
          + 'addEventListener("mousemove", (e) => log.push(["move", e.clientX, e.clientY]));'
          + 'addEventListener("click", (e) => log.push(["click", e.clientX, e.clientY]));'
          + 'addEventListener("contextmenu", (e) => { e.preventDefault(); log.push(["right", e.clientX, e.clientY]); });</script>');
        return;
      }
      if (req.url.startsWith('/second')) res.end(`<title>Second</title><p>Search: ${new URL(req.url, 'http://x').searchParams.get('q') ?? ''}</p>`);
      else res.end('<title>Page</title><a href="/second">Go to second</a><form action="/second"><input name="q" placeholder="Search"></form><h1 style="height:3000px">Hello TV</h1>');
    });
    await new Promise((r) => web.listen(0, '127.0.0.1', r));
    stack = await startStack({ config: { browser: { edgePath: EDGE, idleMs: 120000, allowLoopback: true } } });
    b = stack.browser();
    await b.hello;
    agent = stack.agent();
    await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
  });
  after(async () => {
    await stack?.stop();
    web?.close();
  });

  test('On TV opens the screen: screen mode on, frames arrive as JPEG, the pointer shows', async () => {
    const ack = await b.send('browser.openOnTv', { url: `http://127.0.0.1:${web.address().port}/` }, { timeout: 40000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.ok(agent.requests.some((r) => r.type === 'screen' && r.on === true));
    await b.waitForState('tvscreen.on', (r) => r?.v === true, { timeout: 5000 });
    await waitFor(() => agent.frames.length > 0, { timeout: 15000, what: 'a frame on the TV' });
    const frame = agent.frames.at(-1);
    assert.deepEqual([frame[0], frame[1]], [0xff, 0xd8], 'a JPEG');
    assert.ok(agent.screen.some((m) => m.t === 'screen-cursor'));
  });

  test('the remote moves the pointer; Yellow without a video says so; Red closes', async () => {
    const before = agent.screen.filter((m) => m.t === 'screen-cursor').at(-1).x;
    agent.sendScreenInput({ key: 'right' });
    await waitFor(() => agent.screen.filter((m) => m.t === 'screen-cursor').at(-1).x > before, { timeout: 5000, what: 'the pointer to move right' });
    const play = await b.send('tvscreen.playVideo', {}, { timeout: 10000 });
    assert.equal(play.ok, false);
    assert.match(play.error.message, /No video/);
    agent.sendScreenInput({ key: 'red' });
    await b.waitForState('tvscreen.on', (r) => r?.v === false, { timeout: 5000 });
    assert.ok(agent.requests.some((r) => r.type === 'screen' && r.on === false));
  });

  test('the AI reads the page, clicks by text, and types into a field in Lumen browser', async () => {
    const ctx = { hub: stack.server.hub, store: stack.server.store, browser: () => stack.server.features.browser };
    const base = `http://127.0.0.1:${web.address().port}`;
    const opened = await callTool('browser_open', { url: `${base}/` }, ctx);
    assert.equal(opened.isError, false, opened.text);
    await waitFor(async () => (await callTool('browser_read', {}, ctx)).result.title === 'Page', { timeout: 15000, what: 'the page' });
    const read = await callTool('browser_read', {}, ctx);
    assert.ok(read.result.elements.some((e) => e.text === 'Go to second'));
    const search = read.result.elements.find((e) => e.tag === 'input');
    assert.equal((await callTool('browser_click', { index: search.i }, ctx)).isError, false);
    const typed = await callTool('browser_type', { text: 'lumen', submit: true }, ctx);
    assert.equal(typed.isError, false, typed.text);
    await waitFor(async () => (await callTool('browser_read', {}, ctx)).result.text.includes('Search: lumen'), { timeout: 15000, what: 'the search result page' });
    await callTool('browser_open', { url: `${base}/` }, ctx);
    await waitFor(async () => (await callTool('browser_read', {}, ctx)).result.title === 'Page', { timeout: 15000, what: 'the page again' });
    assert.equal((await callTool('browser_click', { text: 'go to second' }, ctx)).isError, false);
    await waitFor(async () => (await callTool('browser_read', {}, ctx)).result.title === 'Second', { timeout: 15000, what: 'the linked page' });
    const look = await callTool('browser_look', {}, ctx);
    assert.equal(look.images[0].mimeType, 'image/jpeg');
  });

  test('YouTube\'s player position is read through its API: the video\'s own time during an ad, nothing for another video', async () => {
    const page = stack.server.features.browser;
    await page.open(`http://127.0.0.1:${web.address().port}/ytplayer`);
    await waitFor(async () => (await page.evaluate('document.title').catch(() => '')) === 'Clip - YouTube', { timeout: 15000, what: 'the player page' });
    const state = (id) => page.evaluate(youtubeStateScript(id));
    assert.deepEqual(await state('dQw4w9WgXcQ'), { found: true, t: 75.5, ad: false, live: false });
    assert.deepEqual(await state('aaaaaaaaaaa'), { found: false, t: null, ad: false, live: false });
    await page.evaluate('p.classList.add("ad-showing")');
    assert.deepEqual(await state('dQw4w9WgXcQ'), { found: true, t: 75.5, ad: true, live: false });
    // Without the API's time, the <video>'s own time counts, but never an ad's.
    await page.evaluate('p.getCurrentTime = undefined');
    assert.equal((await state('dQw4w9WgXcQ')).t, null);
    await page.evaluate('p.classList.remove("ad-showing")');
    assert.equal((await state('dQw4w9WgXcQ')).t, 0);
  });

  test('a big video started on the page goes to the TV player by itself, and is paused on the page', async () => {
    const ack = await b.send('browser.openOnTv', { url: `http://127.0.0.1:${web.address().port}/video` }, { timeout: 40000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    const page = stack.server.features.browser;
    const plays = () => agent.screen.filter((m) => m.t === 'screen-play').length;
    const before = plays();
    await page.evaluate('startIt()');
    await waitFor(() => plays() > before, { timeout: 15000, what: 'the video handed to the TV player' });
    assert.match(agent.screen.filter((m) => m.t === 'screen-play').at(-1).url, /\/relay\//);
    await waitFor(async () => (await page.evaluate('v.paused')) === true, { timeout: 5000, what: 'the page video paused' });
    agent.sendScreenInput({ key: 'red' });
    await b.waitForState('tvscreen.on', (r) => r?.v === false, { timeout: 5000 });
  });

  test('a video playing inside an embedded player (an iframe) goes to the TV player too, and is paused there', async () => {
    const ack = await b.send('browser.openOnTv', { url: `http://127.0.0.1:${web.address().port}/framed` }, { timeout: 40000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    const page = stack.server.features.browser;
    const plays = () => agent.screen.filter((m) => m.t === 'screen-play').length;
    const before = plays();
    await waitFor(async () => (await page.evaluateFrames('typeof startIt === "function"')).includes(true), { timeout: 10000, what: 'the embedded player loaded' });
    await page.evaluateFrames('typeof startIt === "function" && startIt()');
    await waitFor(() => plays() > before, { timeout: 15000, what: 'the framed video handed to the TV player' });
    await waitFor(async () => (await page.evaluateFrames('typeof v === "object" ? v.paused : null')).includes(true), { timeout: 5000, what: 'the framed video paused' });
    agent.sendScreenInput({ key: 'red' });
    await b.waitForState('tvscreen.on', (r) => r?.v === false, { timeout: 5000 });
  });

  // The Browser view's trackpad: browser.pointer moves one shared pointer by deltas and clicks or
  // scrolls where it is.
  const ok = (ack) => { assert.equal(ack.ok, true, JSON.stringify(ack.error)); return ack.value; };
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const pageLog = (kind) => stack.server.features.browser.evaluate(`log.filter((e) => e[0] === '${kind}')`);

  test('the trackpad pointer moves, clicks, right-clicks and scrolls Lumen’s page', async () => {
    const page = stack.server.features.browser;
    ok(await b.send('browser.open', { url: `http://127.0.0.1:${web.address().port}/pointer` }, { timeout: 40000 }));
    await waitFor(async () => (await page.evaluate('document.title').catch(() => '')) === 'Pointer', { timeout: 15000, what: 'the pointer page' });
    const here = ok(await b.send('browser.pointer', {}));
    assert.equal(here.tv, false);
    const moved = ok(await b.send('browser.pointer', { dx: 0.1, dy: -0.05 }));
    assert.ok(near(moved.x, here.x + 0.1) && near(moved.y, here.y - 0.05), JSON.stringify({ here, moved }));
    const [w, h] = await page.evaluate('[innerWidth, innerHeight]');
    await waitFor(async () => (await pageLog('move')).length > 0, { timeout: 5000, what: 'a mousemove on the page' });
    const [, mx, my] = (await pageLog('move')).at(-1);
    assert.ok(Math.abs(mx - moved.x * w) <= 2 && Math.abs(my - moved.y * h) <= 2, `moved to ${mx},${my} in ${w}x${h}`);

    ok(await b.send('browser.pointer', { action: 'click' }));
    await waitFor(async () => (await pageLog('click')).length === 1, { timeout: 5000, what: 'a click on the page' });
    const [, cx, cy] = (await pageLog('click'))[0];
    assert.ok(Math.abs(cx - mx) <= 1 && Math.abs(cy - my) <= 1, 'the click lands where the pointer is');
    ok(await b.send('browser.pointer', { action: 'click', button: 'right' }));
    await waitFor(async () => (await pageLog('right')).length === 1, { timeout: 5000, what: 'a right-click on the page' });
    ok(await b.send('browser.pointer', { action: 'wheel', deltaY: 600 }));
    await waitFor(async () => (await page.evaluate('scrollY')) > 0, { timeout: 5000, what: 'the page to scroll' });

    // Moves stop at the edges; bad input is refused.
    const edge = ok(await b.send('browser.pointer', { dx: 1 }));
    assert.ok(edge.x < 1 && edge.x > 0.99);
    for (const bad of [{ action: 'drag' }, { dx: 3 }, { x: -0.5 }, { action: 'click', button: 'thumb' }, { action: 'wheel', deltaY: 'down' }]) {
      const ack = await b.send('browser.pointer', bad);
      assert.equal(ack.error?.code, 'INVALID', JSON.stringify(bad));
    }
    ok(await b.send('browser.pointer', { x: 0.5, y: 0.45 }));
  });

  test('with the page on the TV, the trackpad and the TV remote move the same pointer', async () => {
    ok(await b.send('browser.openOnTv', {}, { timeout: 40000 }));
    await b.waitForState('tvscreen.on', (r) => r?.v === true, { timeout: 5000 });
    const cursor = () => agent.screen.filter((m) => m.t === 'screen-cursor').at(-1);
    const moved = ok(await b.send('browser.pointer', { dx: -0.2, dy: 0.1 }));
    assert.equal(moved.tv, true);
    assert.ok(near(moved.x, 0.3) && near(moved.y, 0.55), JSON.stringify(moved));
    await waitFor(() => near(cursor().x, moved.x) && near(cursor().y, moved.y), { timeout: 5000, message: 'the TV cursor to follow the trackpad' });

    agent.sendScreenInput({ key: 'right' });
    await waitFor(() => cursor().x > moved.x, { timeout: 5000, what: 'the remote to move the pointer on' });
    const after = ok(await b.send('browser.pointer', {}));
    assert.equal(after.x, cursor().x, 'the trackpad sees where the remote left the pointer');

    const page = stack.server.features.browser;
    await page.evaluate('log.length = 0');
    ok(await b.send('browser.pointer', { action: 'click' }));
    await waitFor(async () => (await pageLog('click')).length === 1, { timeout: 5000, what: 'a click on the page' });
    const [w] = await page.evaluate('[innerWidth]');
    assert.ok(Math.abs((await pageLog('click'))[0][1] - after.x * w) <= 2, 'the click lands under the TV cursor');
    agent.sendScreenInput({ key: 'red' });
    await b.waitForState('tvscreen.on', (r) => r?.v === false, { timeout: 5000 });
  });

  test('while the phone pad drives the TV pointer, the phone position counts; the TV pointer is reported apart', async () => {
    ok(await b.send('browser.openOnTv', {}, { timeout: 40000 }));
    await b.waitForState('tvscreen.on', (r) => r?.v === true, { timeout: 5000 });
    const placed = ok(await b.send('browser.pointer', { x: 0.2, y: 0.3, native: true }));
    assert.ok(near(placed.x, 0.2) && near(placed.y, 0.3), JSON.stringify(placed));
    // The TV's own pointer is still on its way (or off): it is reported, but does not move the page pointer.
    agent.sendScreenInput({ pointer: { x: 0.7, y: 0.6 } });
    await waitFor(async () => ok(await b.send('browser.pointer', { native: true })).native?.x === 0.7, { timeout: 5000, what: 'the TV pointer reported' });
    const held = ok(await b.send('browser.pointer', { native: true }));
    assert.ok(near(held.x, 0.2) && near(held.y, 0.3), `the phone position holds: ${JSON.stringify(held)}`);
    assert.deepEqual(held.native, { x: 0.7, y: 0.6 });
    // A pad click lands at the phone position.
    const page = stack.server.features.browser;
    await page.evaluate('log.length = 0');
    ok(await b.send('browser.pointer', { x: 0.2, y: 0.3, action: 'click', native: true }));
    await waitFor(async () => (await pageLog('click')).length === 1, { timeout: 5000, what: 'a click on the page' });
    const [w] = await page.evaluate('[innerWidth]');
    assert.ok(Math.abs((await pageLog('click'))[0][1] - 0.2 * w) <= 2, 'the click lands at the phone position');
    agent.sendScreenInput({ key: 'red' });
    await b.waitForState('tvscreen.on', (r) => r?.v === false, { timeout: 5000 });
  });
});

// The trackpad's validation (hub browser.pointer) and the pointer's edges (tvscreen.pointer) need no
// Edge: a fake Lumen browser records the input events the pointer sends.
const POINTER_EDGE = 0.002; // tvscreen.js EDGE
function fakeBrowser(w = 1000, h = 500) {
  const inputs = [];
  return { inputs, frameSize: () => ({ w, h }), input: async (event) => { inputs.push(event); return {}; } };
}

describe('tvscreen: the trackpad pointer stops at every edge (no Edge needed)', () => {
  const store = { map: new Map(), get(k) { return this.map.get(k); }, set(k, v) { this.map.set(k, { v }); } };
  const screen = (page) => createTvScreen({ config: {}, log: createTestLog(), store, agent: () => null, rest: null, browser: () => page, relay: () => null });
  const pos = (r) => [r.value.x, r.value.y];

  test('dx/dy clamp to EDGE..1-EDGE on both axes; x/y clamp too; x/y win over dx/dy', async () => {
    const page = fakeBrowser();
    const tv = screen(page);
    assert.deepEqual(pos(await tv.pointer({})), [0.5, 0.45], 'starts where the TV cursor starts');
    assert.deepEqual(pos(await tv.pointer({ dx: 1 })), [1 - POINTER_EDGE, 0.45]);
    assert.deepEqual(pos(await tv.pointer({ dx: -1 })), [POINTER_EDGE, 0.45], 'stops at the left edge');
    assert.deepEqual(pos(await tv.pointer({ dx: -1 })), [POINTER_EDGE, 0.45], 'and stays there');
    assert.deepEqual(pos(await tv.pointer({ dy: 1 })), [POINTER_EDGE, 1 - POINTER_EDGE], 'stops at the bottom edge');
    assert.deepEqual(pos(await tv.pointer({ dy: -1 })), [POINTER_EDGE, POINTER_EDGE], 'stops at the top edge');
    assert.deepEqual(pos(await tv.pointer({ x: 1, y: 1 })), [1 - POINTER_EDGE, 1 - POINTER_EDGE]);
    assert.deepEqual(pos(await tv.pointer({ x: 0, y: 0 })), [POINTER_EDGE, POINTER_EDGE]);
    assert.deepEqual(pos(await tv.pointer({ x: 0.3, dx: 0.5, y: 0.6, dy: -0.4 })), [0.3, 0.6], 'x/y win over dx/dy');
    const [x, y] = pos(await tv.pointer({ x: 0.3, dy: 0.1 }));
    assert.ok(x === 0.3 && Math.abs(y - 0.7) < 1e-9, 'x with dy: y still moves by dy');
    // Every real move became one mousemove in frame pixels; calls that went nowhere sent nothing.
    assert.equal(page.inputs.length, 8);
    assert.ok(page.inputs.every((e) => e.kind === 'move'));
    assert.deepEqual(page.inputs.at(-1), { kind: 'move', x: 300, y: 350 });
  });

  test('a move that goes nowhere sends nothing; a click or scroll at the edge still lands there', async () => {
    const page = fakeBrowser();
    const tv = screen(page);
    await tv.pointer({ x: 0, y: 1 });
    const sent = page.inputs.length;
    assert.deepEqual(pos(await tv.pointer({ dx: -0.5, dy: 0.5 })), [POINTER_EDGE, 1 - POINTER_EDGE]);
    assert.equal(page.inputs.length, sent, 'pushing past the corner sends no mousemove');
    await tv.pointer({ dx: -0.1, action: 'click', button: 'right' });
    assert.deepEqual(page.inputs.at(-1), { kind: 'click', x: 2, y: 499, button: 'right' });
    await tv.pointer({ action: 'wheel', deltaY: 600 });
    assert.deepEqual(page.inputs.at(-1), { kind: 'wheel', x: 2, y: 499, deltaX: 0, deltaY: 600 });
    assert.equal((await tv.pointer({})).value.tv, false, 'not on the TV');
  });
});

describe('hub browser.pointer: validation before the pointer moves (no Edge needed)', () => {
  let stack, b, real;
  const page = fakeBrowser();

  before(async () => {
    stack = await startStack();
    b = stack.browser();
    await b.hello;
    real = stack.server.features.browser;
    stack.server.features.browser = page; // tvscreen reaches Lumen's browser through features.browser
  });
  after(async () => {
    if (stack) stack.server.features.browser = real;
    await stack?.stop();
  });

  test('every bad input is refused as INVALID and moves nothing', async () => {
    const bad = [
      { action: 'drag' }, { action: 1 }, { dx: 3 }, { dx: -1.5 }, { dy: 2 }, { dx: '0.1' }, { dx: Number.NaN },
      { x: -0.5 }, { x: 1.5 }, { y: -0.1 }, { y: 2 }, { x: 'left' },
      { action: 'click', button: 'thumb' }, { action: 'wheel', deltaY: 'down' }, { action: 'wheel', deltaX: 20000 },
    ];
    for (const cmd of bad) {
      const ack = await b.send('browser.pointer', cmd);
      assert.equal(ack.error?.code, 'INVALID', JSON.stringify(cmd));
    }
    assert.equal(page.inputs.length, 0);
  });

  test('dx:-1, x:0 and y:1 are accepted and stop at the edges; x wins over dx', async () => {
    const ok = (ack) => { assert.equal(ack.ok, true, JSON.stringify(ack.error)); return [ack.value.x, ack.value.y]; };
    assert.deepEqual(ok(await b.send('browser.pointer', { x: 0.5, y: 0.5 })), [0.5, 0.5]);
    assert.deepEqual(ok(await b.send('browser.pointer', { dx: -1 })), [POINTER_EDGE, 0.5]);
    assert.deepEqual(ok(await b.send('browser.pointer', { x: 0 })), [POINTER_EDGE, 0.5]);
    assert.deepEqual(ok(await b.send('browser.pointer', { y: 1 })), [POINTER_EDGE, 1 - POINTER_EDGE]);
    assert.deepEqual(ok(await b.send('browser.pointer', { dy: 1 })), [POINTER_EDGE, 1 - POINTER_EDGE]);
    assert.deepEqual(ok(await b.send('browser.pointer', { x: 0.25, dx: 0.5 })), [0.25, 1 - POINTER_EDGE]);
    ok(await b.send('browser.pointer', { action: 'click' }));
    assert.deepEqual(page.inputs.at(-1), { kind: 'click', x: 250, y: 499, button: 'left' });
  });
});
