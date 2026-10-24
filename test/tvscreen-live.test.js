// Live video of Lumen's browser on the TV, end to end with the real headless Edge: "On TV" offers the
// live stream to the agent; an agent that accepts gets an init segment and a few large fragments a
// second starting at a key frame (H.264 + AAC from the page's own sound), and no JPEG frame from then
// on. Frames come back when the TV reports it cannot play it, stops reporting, or live video is
// turned off. Opening the screen again offers live video again; a TV whose agent went away while
// playing, or that took the stream and never played it, starts a step lower, and after twice stays
// on frames. A capture that restarts mid-stream shows the page until the new stream plays. Mock TV,
// fake agent.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { startStack, waitFor } from './helpers.js';
import { parseMessage, TV_CODEC_PROBES } from '../server/features/livevideo.js';
import { findBox } from '../server/util/fmp4.js';

const EDGE = process.env.LUMEN_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const skip = !fs.existsSync(EDGE) && `headless Edge is not installed at ${EDGE}`;
const PAGE = '<title>Live</title><div id=b style="position:absolute;top:100px;width:100px;height:100px;background:#fc0"></div>'
  + '<script>let n=0;(function f(){n++;b.style.left=(n*4%1000)+"px";requestAnimationFrame(f)})();'
  + 'const ac=new AudioContext();const o=ac.createOscillator();o.connect(ac.destination);o.start();</script>';
const isJpeg = (f) => f[0] === 0xff && f[1] === 0xd8;
const tag = (f) => f.toString('latin1', 0, 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('tvscreen: live video on the TV', { skip }, () => {
  let stack, b, agent, web, viewer;
  const lowers = []; // the step offset every attach got (one per strike)
  const caps = Object.fromEntries(TV_CODEC_PROBES.map((c) => [c, c.startsWith('avc1')]));
  const ready = (a = agent) => a.ws.send(JSON.stringify({ t: 'screen-live', state: 'ready', caps }));
  const stats = (a = agent) => a.ws.send(JSON.stringify({ t: 'screen-live', state: 'stats', lag: 0.1, dropped: 0, decoded: 120, stalls: 0 }));

  before(async () => {
    web = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
    await new Promise((r) => web.listen(0, '127.0.0.1', r));
    stack = await startStack({ config: {
      browser: { edgePath: EDGE, idleMs: 120000, allowLoopback: true },
      // A short watchdog so the silent-TV case fits in a test.
      liveVideo: { enabled: true, maxHeight: 1080, idleStopMs: 1000, statsGraceMs: 2000, statsLateMs: 1500, statsGoneMs: 3000, startMs: 3000 },
    } });
    // The real live video, with the TV screen's viewer and its start offset in view.
    const realLive = stack.server.features.livevideo;
    stack.server.features.livevideo = Object.create(realLive, {
      attach: { value: (v, caps, options) => { viewer = v; lowers.push(options?.lower ?? 0); return realLive.attach(v, caps, options); } },
    });
    b = stack.browser();
    await b.hello;
    agent = stack.agent({ version: '0.8.1' });
    await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
  });
  after(async () => {
    await stack?.stop();
    web?.close();
  });

  test('an agent that accepts gets init + batched fragments from a key frame, and no JPEG frame from then on', async () => {
    const ack = await b.send('browser.openOnTv', { url: `http://127.0.0.1:${web.address().port}/` }, { timeout: 40000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    const offer = await waitFor(() => agent.screen.find((m) => m.t === 'screen-live-offer'), { timeout: 5000, what: 'the live offer' });
    assert.deepEqual(offer.probes, TV_CODEC_PROBES);
    await waitFor(() => agent.frames.some(isJpeg), { timeout: 15000, what: 'frames before live video' });
    ready();
    const jpegsAtAttach = agent.frames.filter(isJpeg).length;
    // Every 2 s, as live.js reports (the PC ticks every second: half its ticks have no report).
    const statsTimer = setInterval(() => stats(), 2000);
    try {
      await waitFor(() => agent.frames.some((f) => tag(f) === 'LVM'), { timeout: 30000, what: 'live video fragments' });
      const live = agent.frames.filter((f) => !isJpeg(f)).map(parseMessage);
      assert.equal(live[0].kind, 'init');
      assert.equal(live[0].info.reset, true);
      assert.match(live[0].info.mime, /^video\/mp4; codecs="avc1\.64[0-9A-F]{4},mp4a\.40\.2"$/, 'H.264 with the page’s sound');
      assert.deepEqual([live[0].info.width, live[0].info.height, live[0].info.fps], [1920, 1080, 30], '1080p30: 1280×720 CSS px at 1.5×');
      assert.ok(findBox(live[0].data, 'moov/trak/mdia/minf/stbl/stsd'), 'a real init segment');
      const firstMedia = live.find((m) => m.kind === 'media');
      assert.equal(firstMedia.key, true, 'the first fragment starts with a key frame');
      assert.ok(findBox(firstMedia.data, 'moof') && findBox(firstMedia.data, 'mdat'));

      agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'playing', w: 1920, h: 1080 }));
      await b.waitForState('tvscreen.live', (r) => r?.v?.state === 'streaming', { timeout: 5000 });
      const mediaBefore = agent.frames.filter((f) => tag(f) === 'LVM').length;
      await sleep(2000);
      const perSecond = (agent.frames.filter((f) => tag(f) === 'LVM').length - mediaBefore) / 2;
      assert.ok(perSecond >= 3 && perSecond <= 10, `a few large fragments a second, not one per frame (${perSecond}/s)`);
      assert.ok(agent.frames.filter(isJpeg).length <= jpegsAtAttach + 1, 'no JPEG frames once the TV took the stream');
    } finally {
      clearInterval(statsTimer);
    }
  });

  test('a TV that cannot play it falls back to frames; tvscreen.live off/on turns it off and offers it again', async () => {
    agent.screen.length = 0;
    agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'error', reason: 'MSE broke' }));
    await waitFor(() => agent.screen.some((m) => m.t === 'screen-live-stop'), { timeout: 5000, what: 'the live stop' });
    const jpegs = agent.frames.filter(isJpeg).length;
    await waitFor(() => agent.frames.filter(isJpeg).length > jpegs + 2, { timeout: 10000, what: 'JPEG frames again' });
    await b.waitForState('tvscreen.live', (r) => r?.v?.state === 'off', { timeout: 5000 });

    assert.equal((await b.send('tvscreen.live', { on: false })).ok, true);
    assert.equal((await b.send('tvscreen.live', { on: true })).ok, true);
    await waitFor(() => agent.screen.some((m) => m.t === 'screen-live-offer'), { timeout: 5000, what: 'a new offer' });
    assert.equal((await b.send('tvscreen.live', { on: 'yes' })).ok, false);
  });

  test('a TV that stops reporting goes back to frames', async () => {
    agent.screen.length = 0;
    ready();
    await waitFor(() => agent.frames.some((f) => tag(f) === 'LVM'), { timeout: 30000, what: 'the stream' });
    // No stats from the TV: after the grace and the watchdog, the stream stops.
    await waitFor(() => agent.screen.some((m) => m.t === 'screen-live-stop'), { timeout: 15000, what: 'the fallback to frames' });
    await b.waitForState('tvscreen.live', (r) => r?.v?.state === 'off', { timeout: 5000 });
  });

  test('a TV that takes the stream but never plays it goes back to frames after the start deadline, and starts a step lower next time', async () => {
    assert.equal((await b.send('tvscreen.live', { on: true })).ok, true); // forgets the strikes so far
    await waitFor(() => agent.screen.some((m) => m.t === 'screen-live-offer'), { timeout: 5000, what: 'the offer' });
    agent.screen.length = 0;
    agent.frames.length = 0;
    ready();
    // It reports, but decodes nothing and never says 'playing'.
    const reporting = setInterval(() => agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'stats', lag: 0, dropped: 0, decoded: 0, stalls: 0 })), 500);
    try {
      await waitFor(() => agent.frames.some((f) => tag(f) === 'LVI'), { timeout: 30000, what: 'the stream' });
      const t0 = Date.now();
      await waitFor(() => agent.screen.some((m) => m.t === 'screen-live-stop'), { timeout: 8000, what: 'the fallback to frames' });
      assert.ok(Date.now() - t0 < 6000, `fell back after ${Date.now() - t0} ms`);
    } finally {
      clearInterval(reporting);
    }
    await b.waitForState('tvscreen.live', (r) => r?.v?.state === 'off', { timeout: 5000 });
    const jpegs = agent.frames.filter(isJpeg).length;
    await waitFor(() => agent.frames.filter(isJpeg).length > jpegs, { timeout: 10000, what: 'JPEG frames again' });
    // Opened again: offered one step lower (one strike).
    assert.equal((await b.send('tvscreen.close', {}, { timeout: 10000 })).ok, true);
    agent.frames.length = 0;
    agent.screen.length = 0;
    assert.equal((await b.send('tvscreen.open', {}, { timeout: 40000 })).ok, true);
    await waitFor(() => agent.screen.some((m) => m.t === 'screen-live-offer'), { timeout: 5000, what: 'the offer on reopen' });
    ready();
    const statsTimer = setInterval(() => stats(), 500);
    try {
      await waitFor(() => agent.frames.some((f) => tag(f) === 'LVI'), { timeout: 30000, what: 'the stream after reopening' });
      agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'playing', w: 1280, h: 720 }));
      const init = parseMessage(agent.frames.find((f) => tag(f) === 'LVI'));
      assert.deepEqual([init.info.width, init.info.height], [1280, 720], 'one step lower: 720p30');
      assert.equal(lowers.at(-1), 1);
    } finally {
      clearInterval(statsTimer);
    }
    assert.equal((await b.send('tvscreen.live', { on: false })).ok, true);
  });

  test('a capture restart mid-stream: the TV drops its frozen player and shows the page, then gets the new stream, with no strike', async () => {
    assert.equal((await b.send('tvscreen.live', { on: false })).ok, true);
    agent.screen.length = 0;
    assert.equal((await b.send('tvscreen.live', { on: true })).ok, true);
    await waitFor(() => agent.screen.some((m) => m.t === 'screen-live-offer'), { timeout: 5000, what: 'the offer' });
    agent.frames.length = 0;
    ready();
    const statsTimer = setInterval(() => stats(), 500);
    try {
      await waitFor(() => agent.frames.some((f) => tag(f) === 'LVM'), { timeout: 30000, what: 'the stream' });
      agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'playing', w: 1920, h: 1080 }));
      await b.waitForState('tvscreen.live', (r) => r?.v?.state === 'streaming', { timeout: 5000 });
      agent.screen.length = 0;
      const jpegs = agent.frames.filter(isJpeg).length;
      const inits = agent.frames.filter((f) => tag(f) === 'LVI').length;
      // The capture page goes away (as when Edge drops it); livevideo restarts it and tells the viewer.
      const dt = stack.server.features.browser.devtools();
      const targets = await (await fetch(`http://127.0.0.1:${dt.port}/json/list`)).json();
      const capture = targets.find((t) => /\/capture\?t=/.test(t.url));
      assert.ok(capture, 'the capture page');
      await fetch(`http://127.0.0.1:${dt.port}/json/close/${capture.id}`);
      viewer.onRestart?.();
      await waitFor(() => agent.screen.some((m) => m.t === 'screen-live-stop'), { timeout: 5000, what: 'the frozen player dropped' });
      await waitFor(() => agent.frames.filter(isJpeg).length > jpegs, { timeout: 5000, what: 'the page frame' });
      assert.ok(agent.screen.some((m) => m.t === 'screen-toast' && /restarting/i.test(m.text)));
      await waitFor(() => agent.frames.filter((f) => tag(f) === 'LVI').length > inits, { timeout: 20000, what: 'the new stream' });
      agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'playing', w: 1920, h: 1080 }));
      await b.waitForState('tvscreen.live', (r) => r?.v?.state === 'streaming', { timeout: 10000 });
    } finally {
      clearInterval(statsTimer);
    }
    // No strike: opened again, it starts where it did.
    assert.equal((await b.send('tvscreen.close', {}, { timeout: 10000 })).ok, true);
    agent.screen.length = 0;
    const attached = lowers.length;
    assert.equal((await b.send('tvscreen.open', {}, { timeout: 40000 })).ok, true);
    await waitFor(() => agent.screen.some((m) => m.t === 'screen-live-offer'), { timeout: 5000, what: 'the offer on reopen' });
    ready();
    await waitFor(() => lowers.length > attached, { timeout: 5000, what: 'attached again' });
    assert.equal(lowers.at(-1), 0, 'no step lower after a capture restart');
    assert.equal((await b.send('tvscreen.live', { on: false })).ok, true);
  });

  test('reopening offers live video again; an agent lost during live video means one step lower, then frames only', async () => {
    // Live again (tvscreen.live on clears the record), then the agent goes away mid-stream.
    assert.equal((await b.send('tvscreen.live', { on: true })).ok, true);
    ready();
    const first = agent;
    const reporting = setInterval(() => { if (first.ws.readyState === 1) stats(first); }, 500);
    await b.waitForState('tvscreen.live', (r) => r?.v?.state === 'streaming', { timeout: 30000 }).finally(() => clearInterval(reporting));
    agent.close();
    await b.waitForState('conn.agent', (r) => r?.v !== 'online', { timeout: 20000 });
    await b.waitForState('tvscreen.live', (r) => r?.v?.state === 'off', { timeout: 5000 });

    agent = stack.agent({ version: '0.8.1' });
    await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
    assert.equal((await b.send('tvscreen.open', {}, { timeout: 40000 })).ok, true);
    await waitFor(() => agent.screen.some((m) => m.t === 'screen-live-offer'), { timeout: 5000, what: 'the offer on reopen' });
    ready();
    const statsTimer = setInterval(() => stats(), 500);
    try {
      await waitFor(() => agent.frames.some((f) => tag(f) === 'LVI'), { timeout: 30000, what: 'the stream after reopening' });
      const init = parseMessage(agent.frames.find((f) => tag(f) === 'LVI'));
      assert.deepEqual([init.info.width, init.info.height], [1280, 720], 'one step lower: 720p30');
    } finally {
      clearInterval(statsTimer);
    }

    agent.close(); // the second time
    await b.waitForState('conn.agent', (r) => r?.v !== 'online', { timeout: 20000 });
    agent = stack.agent({ version: '0.8.1' });
    await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
    assert.equal((await b.send('tvscreen.open', {}, { timeout: 40000 })).ok, true);
    await sleep(1000);
    assert.ok(!agent.screen.some((m) => m.t === 'screen-live-offer'), 'no offer after the agent went away twice');
  });

  test('switching the TV to another app pauses live video without counting it as a failure; coming back offers it again', async () => {
    assert.equal((await b.send('tvscreen.live', { on: true })).ok, true);
    await waitFor(() => agent.screen.some((m) => m.t === 'screen-live-offer'), { timeout: 5000, what: 'the offer' });
    ready();
    await b.waitForState('tvscreen.live', (r) => r?.v?.state && r.v.state !== 'off', { timeout: 5000 });
    agent.screen.length = 0;
    agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'hidden' }));
    await waitFor(() => agent.screen.some((m) => m.t === 'screen-live-stop'), { timeout: 5000, what: 'live stopped while hidden' });
    await b.waitForState('tvscreen.live', (r) => r?.v?.state === 'off', { timeout: 5000 });
    agent.screen.length = 0;
    agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'visible' }));
    const offer = await waitFor(() => agent.screen.find((m) => m.t === 'screen-live-offer'), { timeout: 5000, what: 'the offer on return' });
    assert.ok(offer, 're-offered after coming back');
  });

  test('closing the screen stops live video', async () => {
    assert.equal((await b.send('tvscreen.live', { on: true })).ok, true);
    await waitFor(() => agent.screen.some((m) => m.t === 'screen-live-offer'), { timeout: 5000, what: 'the offer' });
    ready();
    await b.waitForState('tvscreen.live', (r) => r?.v?.state && r.v.state !== 'off', { timeout: 5000 });
    agent.sendScreenInput({ key: 'red' });
    await b.waitForState('tvscreen.on', (r) => r?.v === false, { timeout: 5000 });
    await b.waitForState('tvscreen.live', (r) => r?.v?.state === 'off', { timeout: 5000 });
  });
});
