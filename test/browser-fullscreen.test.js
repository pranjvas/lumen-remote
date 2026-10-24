// A page's player going full screen while the TV shows the page as live video. Edge then lays the
// captured tab out at the capture's size, limited to its screen: with headless Edge's own 800×600
// screen (89×66 at a device scale of 3) the view shrank under the 1280×720 viewport and the phone and
// the TV got its top-left corner blown up. The frames must stay the whole page. Real headless Edge,
// mock TV, fake agent; the full-screen button is clicked through Lumen's input path (a user gesture).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { startStack, waitFor, sleep } from './helpers.js';
import { TV_CODEC_PROBES, LADDER, captureRequest } from '../server/features/livevideo.js';
import { screenArg, TV_VIEWPORT } from '../server/features/browser.js';

const EDGE = process.env.LUMEN_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const skip = !fs.existsSync(EDGE) && `headless Edge is not installed at ${EDGE}`;

// The player: a video (a canvas stream) with a red bar along its right edge, a blue one along its
// bottom and a green centre; its Full button sits top left. In full screen it fills the viewport.
// Its video starts by itself (go()), long after the page was opened.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Player</title><style>
html,body{margin:0;background:#fff}
#player{position:relative;width:640px;height:360px;background:#000}
#player:fullscreen{width:100%;height:100%}
#player video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
#r{position:absolute;right:0;top:0;width:12%;height:100%;background:#f00}
#bt{position:absolute;left:0;bottom:0;width:100%;height:12%;background:#00f}
#c{position:absolute;left:44%;top:44%;width:12%;height:12%;background:#0f0}
#fs{position:absolute;left:10px;top:10px;width:120px;height:60px}
</style></head><body><div id="player"><video id="v" muted playsinline></video><div id="r"></div><div id="bt"></div><div id="c"></div><button id="fs">Full</button></div>
<script>
const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180; const g = cv.getContext('2d'); let n = 0;
(function draw() { n++; g.fillStyle = '#333'; g.fillRect(0, 0, 320, 180); g.fillStyle = '#ccc'; g.fillRect((n * 3) % 300, 80, 20, 20); requestAnimationFrame(draw); })();
v.srcObject = cv.captureStream(30); window.go = () => v.play();
fetch('/v.m3u8').catch(() => {}); // a stream the page loaded: a hand-off would have something to hand over
fs.onclick = () => player.requestFullscreen().catch((e) => { window.fsError = String(e); });
</script></body></html>`;

// Colours at fractions of a JPEG frame, decoded in Lumen's own Edge (the page there is a fine place:
// it is only read from).
async function colours(browser, jpeg, points) {
  const expr = `(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(jpeg.toString('base64'))}), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    return ${JSON.stringify(points)}.map(([fx, fy]) => [...g.getImageData(Math.floor(fx * bmp.width), Math.floor(fy * bmp.height), 1, 1).data.slice(0, 3)]);
  })()`;
  return browser.evaluate(expr);
}
const is = (rgb, [r, g, b]) => rgb.every((v, i) => Math.abs(v - [r, g, b][i]) < 70);

describe('browser: Edge screen and capture size (no Edge needed)', () => {
  test('the screen is the largest viewport at the device scale; captures start at the page size or more', () => {
    assert.equal(screenArg(1), '--screen-info={1280x800 devicePixelRatio=1}');
    assert.equal(screenArg(3), '--screen-info={3840x2400 devicePixelRatio=3}');
    for (const step of LADDER) {
      const req = captureRequest(step);
      assert.ok(req.width >= TV_VIEWPORT.w && req.height >= TV_VIEWPORT.h, `${step.name} starts at ${req.width}×${req.height}`);
      assert.equal(req.width * 9, req.height * 16, `${step.name}: 16:9 like the viewport`);
      assert.equal(req.fps, step.fps);
    }
    assert.deepEqual(captureRequest(LADDER.find((s) => s.name === '1080p30')), { width: 1920, height: 1080, fps: 30 });
  });
});

for (const maxHeight of [1080, 2160]) {
  describe(`browser: a player going full screen during live video (liveVideo.maxHeight ${maxHeight})`, { skip }, () => {
    let stack, b, phone, agent, web, reporting;

    before(async () => {
      web = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
      await new Promise((r) => web.listen(0, '127.0.0.1', r));
      stack = await startStack({ config: { browser: { edgePath: EDGE, idleMs: 120000, allowLoopback: true }, liveVideo: { enabled: true, maxHeight } } });
      b = stack.browser();
      await b.hello;
      agent = stack.agent({ version: '0.8.1' });
      await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
    });
    after(async () => {
      clearInterval(reporting);
      await stack?.stop();
      web?.close();
    });

    test('the phone keeps getting the whole page, at the size it had, while the player is full screen', async () => {
      const opened = Date.now();
      const ack = await b.send('browser.openOnTv', { url: `http://127.0.0.1:${web.address().port}/` }, { timeout: 40000 });
      assert.equal(ack.ok, true, JSON.stringify(ack.error));
      await waitFor(() => agent.screen.find((m) => m.t === 'screen-live-offer'), { timeout: 5000, message: 'the live offer' });
      const caps = Object.fromEntries(TV_CODEC_PROBES.map((c) => [c, c.startsWith('avc1')]));
      agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'ready', caps }));
      reporting = setInterval(() => agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'stats', lag: 0.1, dropped: 0, decoded: 120, stalls: 0 })), 500);
      await waitFor(() => agent.frames.some((f) => f.toString('latin1', 0, 3) === 'LVM'), { timeout: 30000, message: 'live video fragments' });
      agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'playing', w: 1920, h: 1080 }));
      await b.waitForState('tvscreen.live', (r) => r?.v?.state === 'streaming', { timeout: 10000 });

      phone = stack.browser({ binaryFrames: true });
      await phone.hello;
      phone.onMessage((m) => { if (m.t === 'browser.frame') phone.fire('browser.ack', { seq: m.seq }); });
      await phone.send('view', { name: 'browser', visible: true });
      // The first frame can be the one from before the TV locked the viewport: a 16:9 one is the page now.
      const before = await waitFor(() => phone.of('browser.frame').filter((f) => f.w * TV_VIEWPORT.h === f.h * TV_VIEWPORT.w).at(-1),
        { timeout: 10000, message: 'a frame of the TV viewport on the phone' });
      const feature = stack.server.features.browser;
      // The page's video starts by itself, well after the page was opened (nobody clicked it): it stays
      // on the page, and a click on its Full button later is no reason to hand it to the TV. The
      // input window counts from the browser's own last input (opening the page, stamped once Edge
      // has started), not from when the test asked.
      await sleep(Math.max(0, Math.max(opened, feature.lastInputAt?.() ?? 0) + 10500 - Date.now()));
      await feature.evaluate('go().then(() => true)');
      await sleep(3200); // the automatic hand-off sees it playing
      const plays = () => agent.screen.filter((m) => m.t === 'screen-play').length;
      assert.equal(plays(), 0);

      // Full, clicked where the phone shows it (frame pixels).
      const click = { kind: 'click', x: Math.round((70 * before.w) / TV_VIEWPORT.w), y: Math.round((40 * before.h) / TV_VIEWPORT.h), fw: before.w, fh: before.h, button: 'left' };
      assert.equal((await phone.send('browser.input', click)).ok, true);
      await waitFor(() => feature.evaluate('document.fullscreenElement?.id === "player"'), { timeout: 5000, message: 'the player in full screen' });
      assert.deepEqual(await feature.evaluate('[innerWidth, innerHeight]'), [TV_VIEWPORT.w, TV_VIEWPORT.h], 'the page keeps its viewport');

      await sleep(1500); // Edge's relayout for full screen, then a few frames
      const mark = phone.of('browser.frame').length;
      await waitFor(() => phone.of('browser.frame').length >= mark + 3, { timeout: 10000, message: 'frames in full screen' });
      const during = phone.of('browser.frame').slice(mark);
      for (const f of during) assert.deepEqual([f.w, f.h], [before.w, before.h], `a full-screen frame is ${f.w}×${f.h}, not the ${before.w}×${before.h} it was`);
      // The whole player, not a corner of it: its right edge red, its bottom blue, its centre green.
      const [right, bottom, centre] = await colours(feature, during.at(-1).bytes, [[0.97, 0.5], [0.5, 0.97], [0.5, 0.5]]);
      assert.ok(is(right, [255, 0, 0]), `the right edge is red: ${right}`);
      assert.ok(is(bottom, [0, 0, 255]), `the bottom edge is blue: ${bottom}`);
      assert.ok(is(centre, [0, 255, 0]), `the centre is green: ${centre}`);

      assert.equal(plays(), 0, 'the Full click handed nothing to the TV');
      await feature.evaluate('document.exitFullscreen().then(() => true)');
    });
  });
}
