// Live video of Lumen's browser on the TV, end to end with the real headless Edge: "On TV" offers the
// live stream to the agent; an agent that accepts gets an init segment and fragments starting at a
// key frame (H.264 + AAC from the page's own sound), the JPEG frames stop while the video plays, and
// they come back when the TV reports it cannot play it or live video is turned off. An agent that
// never answers the offer keeps the JPEG frames. Mock TV, fake agent.
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

describe('tvscreen: live video on the TV', { skip }, () => {
  let stack, b, agent, web;
  const caps = Object.fromEntries(TV_CODEC_PROBES.map((c) => [c, c.startsWith('avc1')]));

  before(async () => {
    web = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
    await new Promise((r) => web.listen(0, '127.0.0.1', r));
    stack = await startStack({ config: { browser: { edgePath: EDGE, idleMs: 120000, allowLoopback: true }, liveVideo: { enabled: true, maxHeight: 1080, idleStopMs: 1000 } } });
    b = stack.browser();
    await b.hello;
    agent = stack.agent({ version: '0.8.0' });
    await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
  });
  after(async () => {
    await stack?.stop();
    web?.close();
  });

  test('an agent that accepts the offer gets init + fragments from a key frame; frames stop while it plays', async () => {
    const ack = await b.send('browser.openOnTv', { url: `http://127.0.0.1:${web.address().port}/` }, { timeout: 40000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    const offer = await waitFor(() => agent.screen.find((m) => m.t === 'screen-live-offer'), { timeout: 5000, what: 'the live offer' });
    assert.deepEqual(offer.probes, TV_CODEC_PROBES);
    agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'ready', caps }));
    await waitFor(() => agent.frames.some((f) => tag(f) === 'LVM'), { timeout: 30000, what: 'live video fragments' });
    const live = agent.frames.filter((f) => !isJpeg(f)).map(parseMessage);
    assert.equal(live[0].kind, 'init');
    assert.equal(live[0].info.reset, true);
    assert.match(live[0].info.mime, /^video\/mp4; codecs="avc1\.64[0-9A-F]{4},mp4a\.40\.2"$/, 'H.264 with the page’s sound');
    assert.deepEqual([live[0].info.width, live[0].info.height], [1920, 1080], '1280×720 CSS px rendered at 1.5×');
    assert.ok(findBox(live[0].data, 'moov/trak/mdia/minf/stbl/stsd'), 'a real init segment');
    const firstMedia = live.find((m) => m.kind === 'media');
    assert.equal(firstMedia.key, true, 'the first fragment starts with a key frame');
    assert.equal(firstMedia.gen, live[0].gen);
    assert.ok(findBox(firstMedia.data, 'moof') && findBox(firstMedia.data, 'mdat'));

    agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'playing', w: 1920, h: 1080 }));
    await b.waitForState('tvscreen.live', (r) => r?.v?.state === 'streaming', { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    const jpegsBefore = agent.frames.filter(isJpeg).length;
    const mediaBefore = agent.frames.filter((f) => tag(f) === 'LVM').length;
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(agent.frames.filter(isJpeg).length, jpegsBefore, 'no JPEG frames while the video plays');
    assert.ok(agent.frames.filter((f) => tag(f) === 'LVM').length > mediaBefore + 30, 'fragments keep coming (~60 fps)');
    agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'stats', lag: 0.1, dropped: 0, decoded: 120, stalls: 0 }));
  });

  test('a TV that cannot play it falls back to frames; tvscreen.live off/on turns it off and offers it again', async () => {
    agent.screen.length = 0;
    agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'error', reason: 'MSE broke' }));
    await waitFor(() => agent.screen.some((m) => m.t === 'screen-live-stop'), { timeout: 5000, what: 'the live stop' });
    const jpegs = agent.frames.filter(isJpeg).length;
    await waitFor(() => agent.frames.filter(isJpeg).length > jpegs, { timeout: 10000, what: 'JPEG frames again' });
    await b.waitForState('tvscreen.live', (r) => r?.v?.state === 'off', { timeout: 5000 });

    const off = await b.send('tvscreen.live', { on: false });
    assert.equal(off.ok, true);
    const on = await b.send('tvscreen.live', { on: true });
    assert.equal(on.ok, true);
    await waitFor(() => agent.screen.filter((m) => m.t === 'screen-live-offer').length >= 1, { timeout: 5000, what: 'a new offer' });
    const bad = await b.send('tvscreen.live', { on: 'yes' });
    assert.equal(bad.ok, false);
  });

  test('closing the screen stops live video', async () => {
    agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'ready', caps }));
    await b.waitForState('tvscreen.live', (r) => r?.v?.state && r.v.state !== 'off', { timeout: 5000 });
    agent.sendScreenInput({ key: 'red' });
    await b.waitForState('tvscreen.on', (r) => r?.v === false, { timeout: 5000 });
    await b.waitForState('tvscreen.live', (r) => r?.v?.state === 'off', { timeout: 5000 });
  });
});
