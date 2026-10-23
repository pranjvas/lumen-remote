// Lumen browser on the TV: "On TV" puts the agent in screen mode, streams the browser's frames to it
// as binary JPEG messages, moves a pointer with the remote's arrows, and Red closes it. Yellow with
// no video on the page says so. Real headless Edge, mock TV, fake agent.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { startStack, waitFor } from './helpers.js';
import { callTool } from '../server/ai/tools.js';

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
      if (req.url.startsWith('/video')) {
        res.end('<title>Video</title><video id="v" src="/clip.m3u8" style="width:100vw;height:80vh"></video>'
          + '<script>let p = true; Object.defineProperty(v, "paused", { get: () => p }); v.pause = () => { p = true; }; window.startIt = () => { p = false; };</script>');
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
});
