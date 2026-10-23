// Browser view (spec §11.3): server/features/browser.js drives the real headless Edge over CDP and
// streams its screen to the Lumen clients on the browser view. The pages come from a loopback web
// server inside this file; the Lumen stack runs against the mock TV. Both suites skip cleanly when
// the feature or msedge.exe is missing. Edge must be gone when a stack or feature stops.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { skipUnless, startStack, waitFor, sleep, createTestLog, createTestLan } from './helpers.js';

const EDGE = process.env.LUMEN_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FEATURE = 'server/features/browser.js';
const skip = skipUnless(FEATURE) || (!fs.existsSync(EDGE) && `headless Edge is not installed at ${EDGE}`);

const IDLE_MS = 1500; // config.browser.idleMs here; 20 min in production
const VIEW = { w: 640, h: 400 }; // the viewport the tests ask for (within the 320–1280 × 320–800 clamp)
const START_TIMEOUT = 20000; // Edge launch plus the first page
const BROWSER_CONFIG = { browser: { edgePath: EDGE, idleMs: IDLE_MS, allowLoopback: true } };

// ---------- the pages ----------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`;
// Home: a 240×80 link block at (40,40) and a 300×60 search field at (40,160), so clicks at the
// viewport points (160,80) and (190,190) hit them whatever the font rendering does.
const HOME = `<!doctype html><html><head><meta charset="utf-8"><title>Lumen test page</title><style>
html,body{margin:0;background:#fff;font:16px sans-serif}
#go{position:absolute;left:40px;top:40px;width:240px;height:80px;display:flex;align-items:center;justify-content:center;background:#1e66f5;color:#fff;text-decoration:none;font-size:24px}
#q{position:absolute;left:40px;top:160px;width:300px;height:60px;font-size:24px;box-sizing:border-box}
</style></head><body><a id="go" href="/second">Second page</a>
<form action="/search" method="get"><input id="q" name="q" autocomplete="off"></form></body></html>`;
// Busy: repaints every 40 ms so the screencast keeps producing frames.
const BUSY = page('Busy page', '<div id="n" style="font:bold 120px sans-serif;padding:40px">0</div>'
  + '<script>let n=0;setInterval(()=>{n++;document.getElementById("n").textContent=n;document.body.style.background="hsl("+(n*7%360)+" 60% 70%)"},40)</script>');
// Anim: repaints on every animation frame (60+ per second, more than the fan-out rate).
const ANIM = page('Anim page', '<div id="n" style="font:bold 120px sans-serif;padding:40px">0</div>'
  + '<script>let n=0;const f=()=>{n++;document.getElementById("n").textContent=n;document.body.style.background="hsl("+(n*7%360)+" 60% 70%)";requestAnimationFrame(f)};requestAnimationFrame(f)</script>');
// Burst: still until burst(ms) repaints it every 16 ms for ms; that resolves with the time of the last change.
const BURST = page('Burst page', '<div id="n" style="font:bold 120px sans-serif;padding:40px">0</div>'
  + '<script>let n=0;window.burst=(ms)=>new Promise((res)=>{const end=performance.now()+ms;const step=()=>{n++;document.getElementById("n").textContent=n;'
  + 'document.body.style.background="hsl("+(n*13%360)+" 60% 70%)";const at=Date.now();if(performance.now()<end)setTimeout(step,16);else res(at)};step()})</script>');
const LINK_AT = [160, 80];
const FIELD_AT = [190, 190];

/** A loopback web server standing in for the internet; records the GETs it answered. `/slow` waits for release(). */
async function pageServer() {
  const seen = [];
  const held = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://test');
    if (req.method === 'GET') seen.push(url.pathname);
    const html = (body) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
    switch (url.pathname) {
      case '/': return html(HOME);
      case '/second': return html(page('Second page', '<h1>Second</h1>'));
      case '/busy': return html(BUSY);
      case '/anim': return html(ANIM);
      case '/burst': return html(BURST);
      case '/slow': return held.push(() => html(page('Slow page', 'late')));
      case '/search': { const q = url.searchParams.get('q') ?? ''; return html(page(`Search: ${q}`, esc(q))); }
      default: res.writeHead(404); return res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: (p) => `http://127.0.0.1:${server.address().port}${p}`,
    count: (p) => seen.filter((s) => s === p).length,
    release: () => { for (const answer of held.splice(0)) answer(); },
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

// ---------- helpers ----------

/** Pixel size from a JPEG's SOF marker, so a frame's w × h can be checked against its bytes. */
function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

/**
 * msedge.exe processes whose command line names `marker` (the profile lives under the data dir), as
 * `{ pid, type }`: 'browser' for the browser (or launcher) process, else Chromium's --type (gpu-process, …).
 */
function edgeProcesses(marker) {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } `
    + '| ForEach-Object { $t = [regex]::Match($_.CommandLine, \'--type=([^ ]+)\'); $_.ProcessId.ToString() + \' \' + $(if ($t.Success) { $t.Groups[1].Value } else { \'browser\' }) }';
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((line) => {
        const [pid, type] = line.split(' ');
        return { pid: Number(pid), type };
      }));
    });
  });
}
const edgeRunning = async (marker) => (await edgeProcesses(marker)).length > 0;
const taskkill = (pid) => new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
const describeProcesses = (list) => list.map((p) => `${p.type} ${p.pid}`).join(', ');
/**
 * Edge must be gone once its owner closed it. Any stray is killed so a run never leaves Edge behind;
 * a surviving browser process fails the test, while an orphaned child process (Edge occasionally
 * lets a gpu/utility process outlive Browser.close) is only reported, as a diagnostic.
 */
async function edgeGone(marker, t = null, timeout = 10000) {
  let left = [];
  try {
    await waitFor(async () => !(left = await edgeProcesses(marker)).length, { timeout, interval: 250, message: `Edge processes for ${marker} to exit` });
  } catch (err) {
    await Promise.all(left.map((p) => taskkill(p.pid)));
    const report = `${err.message}; killed ${left.length} stray msedge.exe process(es): ${describeProcesses(left)}`;
    if (left.some((p) => p.type === 'browser')) throw new Error(report);
    if (t?.diagnostic) t.diagnostic(report);
    else console.log(`# ${report}`);
  }
}

const frames = (client) => client.of('browser.frame');
const aspect = (f) => f.w / f.h;
const near = (a, b, tolerance = 0.02) => Math.abs(a - b) <= b * tolerance;
/** Viewport coordinates → frame pixels (the frame may be scaled; the server maps them back). */
const at = (frame, [vx, vy]) => ({ x: Math.round((vx * frame.w) / VIEW.w), y: Math.round((vy * frame.h) / VIEW.h) });
const okAck = (ack) => assert.equal(ack.ok, true, JSON.stringify(ack.error));
const invalidAck = (ack, what) => { assert.equal(ack.ok, false, `${what} was accepted`); assert.equal(ack.error.code, 'INVALID', what); };
/** Acks every frame as it arrives, like the UI does. */
const autoAck = (client) => client.onMessage((m) => { if (m.t === 'browser.frame') client.fire('browser.ack', { seq: m.seq }); });
/** The hub's message for a plain (JSON) client: browser.js passes per-client encodings as a function. */
const asJson = (msg) => (typeof msg === 'function' ? msg({}) : msg);

function assertFrame(frame, expectedAspect) {
  assert.equal(frame.t, 'browser.frame');
  assert.equal(typeof frame.seq, 'number');
  const buf = frame.binary ? frame.bytes : Buffer.from(frame.data, 'base64');
  assert.deepEqual(jpegSize(buf), { w: frame.w, h: frame.h }, 'w × h match the JPEG');
  assert.ok(frame.w <= 1280 && frame.h <= 800, `${frame.w}×${frame.h} is within 1280×800`);
  assert.ok(near(aspect(frame), expectedAspect), `aspect ${aspect(frame).toFixed(3)} ≈ ${expectedAspect.toFixed(3)}`);
}

describe('browser: Lumen clients ↔ hub ↔ headless Edge', { skip }, () => {
  let stack, mock, web, viewer, other, marker;
  before(async () => {
    web = await pageServer();
    stack = await startStack({ config: BROWSER_CONFIG });
    mock = stack.mock;
    marker = path.basename(stack.dataDir);
    viewer = stack.browser();
    await viewer.hello;
    autoAck(viewer);
    await viewer.send('view', { name: 'browser', visible: true });
    await viewer.waitForState('conn.tv', (r) => r?.v === 'on', { timeout: 8000 });
    other = stack.browser();
    await other.hello;
    await other.send('view', { name: 'remote', visible: true });
  });
  after(async () => {
    try {
      await stack?.server.stop();
      if (marker) await edgeGone(marker); // the profile under the data dir must be free before cleanup
    } finally {
      await sleep(300);
      await stack?.stop().catch(() => {});
      await web?.stop();
    }
  });

  test('browser.open refuses anything but http(s) and starts nothing', async () => {
    for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'ftp://example.com/x', 'not a link', '']) {
      invalidAck(await viewer.send('browser.open', { url }), url || '(empty)');
    }
    assert.equal(viewer.value('browser.session') ?? 'off', 'off');
    assert.equal(await edgeRunning(marker), false);
  });

  test('browser.viewport before any session, then browser.open: Edge starts lazily with its profile under the data dir, and the derived state follows the page', async () => {
    okAck(await viewer.send('browser.viewport', VIEW));
    okAck(await viewer.send('browser.open', { url: web.url('/') }, { timeout: START_TIMEOUT }));
    const session = await viewer.waitForState('browser.session', (r) => r?.v === 'ready', { timeout: START_TIMEOUT });
    assert.equal(session.src, 'derived');
    const url = await viewer.waitForState('browser.url', (r) => r?.v === web.url('/'), { timeout: 10000 });
    assert.equal(url.src, 'derived');
    await viewer.waitForState('browser.title', (r) => r?.v === 'Lumen test page', { timeout: 10000 });
    await viewer.waitForState('browser.loading', (r) => r?.v === false, { timeout: 10000 });
    assert.equal(viewer.value('browser.error') ?? null, null);
    assert.equal(typeof viewer.value('browser.canGoBack'), 'boolean');
    assert.equal(typeof viewer.value('browser.canGoForward'), 'boolean');
    assert.ok(fs.existsSync(path.join(stack.dataDir, 'browser-profile')), 'the Edge profile is <dataDir>/browser-profile');
    assert.equal(await edgeRunning(marker), true);
  });

  test('frames reach the client on the browser view as JPEGs matching w × h with increasing seq; the remote view gets none', async () => {
    const frame = await waitFor(() => frames(viewer).at(-1), { timeout: 10000, message: 'a browser.frame for the viewer' });
    assertFrame(frame, VIEW.w / VIEW.h);
    const seqs = frames(viewer).map((f) => f.seq);
    assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), `seq increases: ${seqs.join()}`);
    assert.equal(frames(other).length, 0);
  });

  test('a click on the link navigates; back, forward and reload work and the history flags follow', async () => {
    const frame = frames(viewer).at(-1);
    okAck(await viewer.send('browser.input', { kind: 'click', ...at(frame, LINK_AT), button: 'left' }));
    await viewer.waitForState('browser.url', (r) => r?.v === web.url('/second'), { timeout: 10000 });
    await viewer.waitForState('browser.title', (r) => r?.v === 'Second page', { timeout: 10000 });
    await viewer.waitForState('browser.canGoBack', (r) => r?.v === true, { timeout: 5000 });
    assert.ok(web.count('/second') >= 1);

    okAck(await viewer.send('browser.nav', { action: 'back' }));
    await viewer.waitForState('browser.url', (r) => r?.v === web.url('/'), { timeout: 10000 });
    await viewer.waitForState('browser.canGoForward', (r) => r?.v === true, { timeout: 5000 });
    okAck(await viewer.send('browser.nav', { action: 'forward' }));
    await viewer.waitForState('browser.url', (r) => r?.v === web.url('/second'), { timeout: 10000 });
    await viewer.waitForState('browser.canGoForward', (r) => r?.v === false, { timeout: 5000 });

    const fetched = web.count('/second');
    okAck(await viewer.send('browser.nav', { action: 'reload' }));
    await waitFor(() => web.count('/second') > fetched, { timeout: 5000, message: 'reload fetched /second again' });
    await viewer.waitForState('browser.loading', (r) => r?.v === false, { timeout: 10000 });
    invalidAck(await viewer.send('browser.nav', { action: 'sideways' }), 'an unknown nav action');
  });

  test('browser.nav stop cancels a navigation the server has not answered yet; the previous page stays', async () => {
    const pending = viewer.fire('browser.open', { url: web.url('/slow') });
    await viewer.waitForState('browser.loading', (r) => r?.v === true, { timeout: 5000 });
    await waitFor(() => web.count('/slow') === 1, { timeout: 5000, message: 'the slow request reached the server' });
    okAck(await viewer.send('browser.nav', { action: 'stop' }));
    await viewer.waitForState('browser.loading', (r) => r?.v === false, { timeout: 5000 });
    await viewer.waitForMessage((m) => m.t === 'ack' && m.id === pending, { timeout: 5000, message: 'the cancelled open is acked' });
    web.release();
    assert.equal(viewer.value('browser.title'), 'Second page');
  });

  test('typing: a click focuses the field, text lands in it (read back with evaluate), Backspace and Enter work (the form submits)', async () => {
    okAck(await viewer.send('browser.open', { url: web.url('/') }, { timeout: START_TIMEOUT }));
    await viewer.waitForState('browser.title', (r) => r?.v === 'Lumen test page', { timeout: 10000 });
    await viewer.waitForState('browser.loading', (r) => r?.v === false, { timeout: 10000 });
    const frame = frames(viewer).at(-1);
    okAck(await viewer.send('browser.input', { kind: 'click', ...at(frame, FIELD_AT), button: 'left' }));
    okAck(await viewer.send('browser.input', { kind: 'text', text: 'hello lumenx' }));
    okAck(await viewer.send('browser.input', { kind: 'key', key: 'Backspace', code: 'Backspace' }));
    // The read-back the spec asks for: a second Runtime.evaluate through the same CDP session.
    assert.equal(await stack.server.features.browser.evaluate('document.querySelector("#q").value'), 'hello lumen');
    okAck(await viewer.send('browser.input', { kind: 'key', key: 'Enter', code: 'Enter' }));
    await viewer.waitForState('browser.url', (r) => r?.v === web.url('/search?q=hello+lumen'), { timeout: 10000 });
    await viewer.waitForState('browser.title', (r) => r?.v === 'Search: hello lumen', { timeout: 10000 });
    invalidAck(await viewer.send('browser.input', { kind: 'teleport', x: 1, y: 1 }), 'an unknown input kind');
  });

  test('browser.viewport clamps to 320–1280 × 320–800 and the frames take the new shape', async () => {
    okAck(await viewer.send('browser.open', { url: web.url('/busy') }, { timeout: START_TIMEOUT }));
    await viewer.waitForState('browser.title', (r) => r?.v === 'Busy page', { timeout: 10000 });
    for (const [wanted, expected] of [[{ w: 100, h: 5000 }, 320 / 800], [{ w: 5000, h: 100 }, 1280 / 320], [VIEW, VIEW.w / VIEW.h]]) {
      const mark = frames(viewer).length;
      okAck(await viewer.send('browser.viewport', wanted));
      const frame = await waitFor(() => frames(viewer).slice(mark).find((f) => near(aspect(f), expected)), {
        timeout: 8000, message: `a frame with aspect ${expected.toFixed(2)} after viewport ${JSON.stringify(wanted)}`,
      });
      assertFrame(frame, expected);
    }
    invalidAck(await viewer.send('browser.viewport', { w: 'wide', h: 400 }), 'a non-numeric viewport');
  });

  test('frames are gated per client: acked clients keep receiving at ≤ maxFps, a silent client is skipped after 4 frames until it acks (or its acks expire), a hidden tab gets nothing more', async () => {
    const lazy = stack.browser();
    const hidden = stack.browser();
    try {
      await lazy.hello;
      await lazy.send('view', { name: 'browser', visible: true });
      await hidden.hello;
      await hidden.send('view', { name: 'browser', visible: true });
      await waitFor(() => frames(hidden).length >= 1, { timeout: 5000, message: 'a newcomer is shown the current page' });
      await hidden.send('view', { name: 'browser', visible: false });
      const hiddenHad = frames(hidden).length;

      const mark = frames(viewer).length;
      await sleep(1000);
      const got = frames(viewer).length - mark;
      assert.ok(got >= 5, `the acking viewer keeps receiving (${got} frames in 1 s)`);
      assert.ok(got <= 24 + 3, `at most 24 frames/s per client (${got} in 1 s)`);
      assert.ok(frames(lazy).length >= 1 && frames(lazy).length <= 4, `the silent client got ${frames(lazy).length} frame(s)`);
      assert.equal(frames(hidden).length, hiddenHad, 'a hidden browser tab gets no more frames');
      assert.equal(frames(other).length, 0, 'the remote view gets no frames');

      const had = frames(lazy).length;
      okAck(await lazy.send('browser.ack', { seq: frames(lazy).at(-1).seq }));
      await waitFor(() => frames(lazy).length > had, { timeout: 3000, message: 'frames resume after the ack' });
      // Acks lost on the way do not freeze it: unacked frames stop counting after 1.5 s.
      const silent = frames(lazy).length;
      await sleep(400);
      const stuck = frames(lazy).length;
      assert.ok(stuck - silent <= 4, `no more than the window while silent (${stuck - silent})`);
      await waitFor(() => frames(lazy).length > stuck, { timeout: 4000, message: 'frames again once the unacked ones expired' });
    } finally {
      lazy.close();
      hidden.close();
    }
  });

  test('a client that asks for binary frames (/live?frames=bin, as the web UI does) gets the JPEG bytes behind a 12-byte header; acks keep it flowing', async () => {
    const bin = stack.browser({ binaryFrames: true });
    try {
      await bin.hello;
      autoAck(bin);
      await bin.send('view', { name: 'browser', visible: true });
      await waitFor(() => frames(bin).length >= 5, { timeout: 5000, message: 'binary frames' });
      const frame = frames(bin).at(-1);
      assert.equal(frame.binary, true);
      assertFrame(frame, VIEW.w / VIEW.h);
      assert.ok(frames(viewer).at(-1).data, 'the JSON client still gets base64 frames');
      const seqs = frames(bin).map((f) => f.seq);
      assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), `seq increases: ${seqs.join()}`);
      // The header's seq is what the ack names: the newest one gets acked like any other.
      okAck(await bin.send('browser.ack', { seq: frame.seq }));
    } finally {
      bin.close();
    }
  });

  test("cast.url with a page opens it in Lumen's browser, not on the TV", async () => {
    const launches = mock.state.launches.length;
    const ack = await viewer.send('cast.url', { url: web.url('/second') }, { timeout: 15000 });
    okAck(ack);
    assert.deepEqual([ack.value.kind, ack.value.url], ['browser', web.url('/second')]);
    await viewer.waitForState('browser.url', (r) => r?.v === web.url('/second'), { timeout: 10000 });
    assert.equal(mock.state.launches.length, launches, 'no TV browser launch');
  });

  test('with the TV in standby a page link still opens in Lumen, while a TV-bound link is refused TV_OFF', async () => {
    mock.setPower('standby');
    await viewer.waitForState('conn.tv', (r) => r?.v === 'standby', { timeout: 10000 });
    try {
      const fetched = web.count('/second');
      const ack = await viewer.send('cast.url', { url: web.url('/second') }, { timeout: 15000 });
      okAck(ack);
      assert.equal(ack.value.kind, 'browser');
      await waitFor(() => web.count('/second') > fetched, { timeout: 10000, message: 'the page was fetched again' });
      await viewer.waitForState('browser.url', (r) => r?.v === web.url('/second'), { timeout: 10000 });
      const refused = await viewer.send('cast.url', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, { timeout: 15000 });
      assert.equal(refused.ok, false, 'a YouTube link needs the TV');
      assert.equal(refused.error.code, 'TV_OFF');
    } finally {
      mock.setPower('on');
      await viewer.waitForState('conn.tv', (r) => r?.v === 'on', { timeout: 10000 });
    }
  });

  test('Open on TV asks the agent when it is online and falls back to the REST browser launch when it is not', async () => {
    const agent = stack.agent({ version: '0.3.0' });
    await agent.opened;
    await viewer.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 8000 });
    const launches = mock.state.launches.length;
    okAck(await viewer.send('browser.openInTvBrowser', { url: web.url('/second') }, { timeout: 15000 }));
    const req = await agent.waitForRequest('open-url');
    assert.equal(req.url, web.url('/second'));
    assert.equal(mock.state.launches.length, launches, 'the agent opened it, so no REST launch');

    agent.close();
    await viewer.waitForState('conn.agent', (r) => r?.v !== 'online', { timeout: 8000 });
    okAck(await viewer.send('browser.openInTvBrowser', {}, { timeout: 15000 })); // no url → the current page
    const launch = mock.state.launches.at(-1);
    assert.deepEqual([mock.state.launches.length, launch.id, launch.payload], [launches + 1, 'org.tizen.browser', web.url('/second')]);
    invalidAck(await viewer.send('browser.openInTvBrowser', { url: 'javascript:alert(1)' }), 'a non-web URL for the TV');
  });

  test('browser.close ends the session and Edge; opening again starts a fresh one', async (t) => {
    okAck(await viewer.send('browser.close'));
    await viewer.waitForState('browser.session', (r) => r?.v === 'off', { timeout: 10000 });
    await edgeGone(marker, t);
    okAck(await viewer.send('browser.open', { url: web.url('/') }, { timeout: START_TIMEOUT }));
    await viewer.waitForState('browser.session', (r) => r?.v === 'ready', { timeout: START_TIMEOUT });
    await viewer.waitForState('browser.title', (r) => r?.v === 'Lumen test page', { timeout: 10000 });
    assert.equal(await edgeRunning(marker), true);
  });

  test('without a viewer the session shuts down after browser.idleMs and Edge exits', async (t) => {
    await viewer.send('view', { name: 'remote', visible: true }); // the last browser-view client leaves
    const left = Date.now();
    await viewer.waitForState('browser.session', (r) => r?.v === 'off', { timeout: IDLE_MS + 8000 });
    assert.ok(Date.now() - left >= IDLE_MS - 200, `not before idleMs (${Date.now() - left} ms)`);
    await edgeGone(marker, t);
    await viewer.send('view', { name: 'browser', visible: true });
  });

  test('stopping the server closes Edge even with a live session', async (t) => {
    okAck(await viewer.send('browser.open', { url: web.url('/') }, { timeout: START_TIMEOUT }));
    await viewer.waitForState('browser.session', (r) => r?.v === 'ready', { timeout: START_TIMEOUT });
    assert.equal(await edgeRunning(marker), true);
    await stack.server.stop();
    await edgeGone(marker, t);
  });
});

describe('browser: createBrowser on its own (evaluate, idle timer, stop)', { skip }, () => {
  let dir, marker, web, store, lan, browser, sent;
  const viewers = new Set([{ id: 'viewer' }]);
  before(async () => {
    web = await pageServer();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-browser-'));
    marker = path.basename(dir);
    const { loadConfig, createDataStore } = await import('../server/config.js');
    const { createStore } = await import('../server/store.js');
    const { createBrowser } = await import(`../${FEATURE}`);
    const config = loadConfig({ dataDir: dir, ...BROWSER_CONFIG, log: { level: 'warn', console: false } });
    const log = createTestLog();
    store = createStore({ cachePath: path.join(dir, 'state-cache.json'), log: log.child('store') });
    lan = await createTestLan();
    sent = [];
    const hub = { sendToView: (view, msg) => sent.push({ view, msg: asJson(msg) }), broadcast() {} };
    browser = createBrowser({ config, data: createDataStore(dir), log, store, lan, hub });
    await browser.start?.();
  });
  after(async () => {
    try {
      await browser?.stop();
      if (marker) await edgeGone(marker);
    } finally {
      await store?.stop({ save: false });
      await lan?.stop();
      await web?.stop();
      await sleep(300);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  const session = () => store.get('browser.session')?.v ?? 'off';
  const lastFrame = () => sent.filter((s) => s.view === 'browser' && s.msg.t === 'browser.frame').at(-1)?.msg;

  test('open() refuses non-web URLs with INVALID before touching Edge', async () => {
    for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'about:blank', 'nope']) {
      await assert.rejects(browser.open(url), (err) => err.code === 'INVALID', url);
    }
    assert.equal(session(), 'off');
    assert.equal(await edgeRunning(marker), false);
  });

  test('open() starts Edge lazily, publishes the derived state, fans frames out through hub.sendToView, and evaluate() reads the page back', async () => {
    browser.viewers(viewers);
    await browser.setViewport(VIEW.w, VIEW.h);
    await browser.open(web.url('/'));
    await waitFor(() => session() === 'ready', { timeout: START_TIMEOUT, message: `browser.session ready (now ${session()})` });
    await waitFor(() => store.get('browser.title')?.v === 'Lumen test page', { timeout: 10000, message: 'browser.title' });
    assert.deepEqual([store.get('browser.url').v, store.get('browser.url').src], [web.url('/'), 'derived']);
    assert.equal(await browser.evaluate('document.title'), 'Lumen test page');
    const frame = await waitFor(lastFrame, { timeout: 10000, message: 'a frame through hub.sendToView' });
    assertFrame(frame, VIEW.w / VIEW.h);
  });

  test('input(): a click focuses the field and text lands in it (read back with evaluate); setViewport clamps', async () => {
    const frame = lastFrame();
    await browser.input({ kind: 'click', ...at(frame, FIELD_AT), button: 'left' });
    await browser.input({ kind: 'text', text: 'typed through cdp' });
    await waitFor(async () => (await browser.evaluate('document.querySelector("#q").value')) === 'typed through cdp', {
      timeout: 5000, message: 'the field value',
    });
    const mark = sent.length;
    assert.deepEqual(await browser.setViewport(100, 5000), { value: { w: 320, h: 800 } });
    const tall = await waitFor(() => sent.slice(mark).map((s) => s.msg).find((m) => m.t === 'browser.frame' && near(aspect(m), 320 / 800)), {
      timeout: 8000, message: 'a 320×800-shaped frame',
    });
    assertFrame(tall, 320 / 800);
  });

  test('source pacing: on a page that paints every animation frame, Edge captures about one frame per frame sent', async () => {
    await browser.open(web.url('/anim'));
    await waitFor(() => store.get('browser.title')?.v === 'Anim page', { timeout: 10000, message: 'the anim page' });
    await sleep(1000);
    const mark = sent.length;
    await sleep(2000);
    const seqs = sent.slice(mark).map((s) => s.msg).filter((m) => m.t === 'browser.frame').map((m) => m.seq);
    assert.ok(seqs.length >= 20, `frames keep flowing (${seqs.length} in 2 s)`);
    assert.ok(seqs.length <= 2 * 24 + 4, `at most maxFps (${seqs.length} in 2 s)`);
    // seq counts Edge's frames; unpaced, Edge sends every painted frame (60+ per second).
    const perSent = (seqs.at(-1) - seqs[0]) / (seqs.length - 1);
    assert.ok(perSent < 1.6, `Edge frames per frame sent: ${perSent.toFixed(2)}`);
  });

  test('pacing never leaves a still page on a stale frame: after each burst of paints its last state is sent', async () => {
    await browser.open(web.url('/burst'));
    await waitFor(() => store.get('browser.title')?.v === 'Burst page', { timeout: 10000, message: 'the burst page' });
    const captured = []; // when Edge captured each frame sent (ms, wall clock)
    const remove = browser.addSink((bytes, frame) => captured.push(frame.ts));
    try {
      await sleep(800);
      for (let i = 0; i < 4; i += 1) {
        const last = await browser.evaluate('burst(300)');
        await waitFor(() => captured.some((ts) => ts >= last - 1), { timeout: 2000, message: `a frame of the final state after burst ${i + 1}` });
        await sleep(300);
      }
    } finally {
      remove();
    }
  });

  test('viewers(empty) starts the idle timer: the session closes after idleMs and Edge exits; a later open relaunches', async (t) => {
    browser.viewers(new Set());
    const left = Date.now();
    await waitFor(() => session() === 'off', { timeout: IDLE_MS + 8000, message: `idle shutdown (now ${session()})` });
    assert.ok(Date.now() - left >= IDLE_MS - 200, `not before idleMs (${Date.now() - left} ms)`);
    await edgeGone(marker, t);

    browser.viewers(viewers);
    await browser.open(web.url('/second'));
    await waitFor(() => session() === 'ready' && store.get('browser.title')?.v === 'Second page', { timeout: START_TIMEOUT, message: 'relaunch' });
    assert.equal(await edgeRunning(marker), true);
  });

  test('stop() closes Edge', async (t) => {
    await browser.stop();
    await edgeGone(marker, t);
  });
});

describe('browser: binary frame messages', () => {
  test("encodeFrame (server) and decodeBinary (web/js/core/live.js) agree on the 12-byte header; anything else is not a frame", async () => {
    const { encodeFrame } = await import('../server/features/browser.js');
    const { decodeBinary } = await import('../web/js/core/live.js');
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]);
    const out = encodeFrame({ seq: 70000, w: 1280, h: 720 }, jpeg);
    assert.equal(out.length, 12 + jpeg.length);
    const buffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
    const msg = decodeBinary(buffer);
    assert.deepEqual({ ...msg, bytes: [...msg.bytes] }, { t: 'browser.frame', seq: 70000, w: 1280, h: 720, bytes: [...jpeg] });
    assert.equal(decodeBinary(new ArrayBuffer(5)), null, 'too short');
    const other = new Uint8Array(buffer.slice(0));
    other[0] = 2;
    assert.equal(decodeBinary(other.buffer), null, 'an unknown type');
    assert.equal(decodeBinary('{"t":"browser.frame"}'), null, 'text');
  });
});

describe('browser: links to this PC are refused by default', () => {
  test('isLoopbackHost and validateUrl block localhost forms unless allowLoopback is set', async () => {
    const { isLoopbackHost, validateUrl } = await import('../server/features/browser.js');
    for (const h of ['localhost', 'app.localhost', '127.0.0.1', '127.9.9.9', '[::1]', '::1', '0.0.0.0', '0x7f000001', '2130706433']) {
      assert.equal(isLoopbackHost(h), true, h);
    }
    for (const h of ['example.com', '192.168.1.2', '10.0.0.1', 'localhost.example.com']) assert.equal(isLoopbackHost(h), false, h);
    assert.throws(() => validateUrl('http://127.0.0.1:8790/'), /this PC/);
    assert.throws(() => validateUrl('http://localhost:9222/json'), /this PC/);
    assert.equal(validateUrl('http://127.0.0.1:8790/', { allowLoopback: true }), 'http://127.0.0.1:8790/');
    assert.equal(validateUrl('https://example.com/a'), 'https://example.com/a');
  });
});
