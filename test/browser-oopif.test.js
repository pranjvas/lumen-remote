// Cross-site (out-of-process) iframes: an embedded player from another site is a target of its own
// under site isolation. Lumen attaches to it, so the streams it loads are in media() (even a manifest
// fetched while the frame's document is parsed), the page's block list applies inside it, its videos
// are seen and paused (evaluateFrames), and the automatic hand-off sends its stream to the TV. The
// page is on 127.0.0.1 and frames http://localhost:<port>: another site. Real headless Edge, mock
// TV, fake agent.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startStack, waitFor, sleep } from './helpers.js';

const EDGE = process.env.LUMEN_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const skip = !fs.existsSync(EDGE) && `headless Edge is not installed at ${EDGE}`;

const taskkill = (pid) => new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
function edgePids(marker) {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }`;
  return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true },
    (err, stdout) => resolve(err ? [] : stdout.split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean))));
}

describe('browser: cross-site iframes', { skip }, () => {
  let stack, b, agent, web, port, marker;
  const hits = [];
  const playlist = (res) => { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' }); res.end('#EXTM3U\n#EXTINF:4,\nseg.ts\n#EXT-X-ENDLIST\n'); };

  before(async () => {
    web = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      hits.push({ host: req.headers.host, path: p });
      if (p === '/early.m3u8' || p === '/clip.m3u8') return playlist(res);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      if (p === '/outer') {
        return res.end(`<title>Outer</title><style>body{margin:0}</style><iframe id="pf" src="http://localhost:${port}/video" style="width:100vw;height:90vh;border:0"></iframe>`);
      }
      if (p === '/video') {
        // A manifest fetched while the document is parsed, a fetch the block list refuses, then a player
        // whose playing state the test controls (headless Edge plays no HLS).
        return res.end('<title>Video</title><script>fetch("/early.m3u8");'
          + 'fetch("/blocked-by-lumen.txt").then(() => { window.blockResult = "ok"; }, () => { window.blockResult = "failed"; });</script>'
          + '<video id="v" src="/clip.m3u8" style="width:100vw;height:80vh"></video>'
          + '<script>let p = true; Object.defineProperty(v, "paused", { get: () => p }); v.pause = () => { p = true; }; window.startIt = () => { p = false; };</script>');
      }
      return res.end('<title>Other</title>');
    });
    await new Promise((r) => web.listen(0, '127.0.0.1', r));
    port = web.address().port;
    stack = await startStack({ config: { browser: { edgePath: EDGE, idleMs: 120000, allowLoopback: true, blockedUrls: ['*blocked-by-lumen*'] } } });
    marker = path.basename(stack.dataDir);
    b = stack.browser();
    await b.hello;
    agent = stack.agent();
    await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
  });
  after(async () => {
    try {
      await stack?.server.stop();
      await sleep(500);
      for (const pid of await edgePids(marker)) await taskkill(pid);
    } finally {
      await stack?.stop().catch(() => {});
      web?.close();
    }
  });

  test("the frame's streams are listed (one fetched while it was parsed too), the block list applies in it, and its player is seen", async () => {
    const ack = await b.send('browser.openOnTv', { url: `http://127.0.0.1:${port}/outer` }, { timeout: 40000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    const page = stack.server.features.browser;
    await waitFor(async () => (await page.evaluateFrames('typeof startIt === "function"')).includes(true), { timeout: 15000, message: 'the embedded player reached' });
    const media = () => page.media();
    await waitFor(() => media().some((m) => m.url === `http://localhost:${port}/early.m3u8`), { timeout: 10000, message: `the parse-time manifest (${media().map((m) => m.url).join(', ')})` });
    await waitFor(() => media().some((m) => m.url === `http://localhost:${port}/clip.m3u8`), { timeout: 10000, message: "the player's manifest" });
    const early = media().find((m) => m.url.endsWith('/early.m3u8'));
    assert.equal(early.kind, 'hls');
    assert.ok(early.frameId, "the entry names the iframe's frame");
    const frames = await page.evaluateFrames('location.host', { withFrames: true });
    const inner = frames.find((f) => f.value === `localhost:${port}`);
    assert.ok(inner, `evaluateFrames reaches the cross-site frame (${JSON.stringify(frames)})`);
    assert.equal(inner.frameId, early.frameId, 'the same frame id as the media entry');

    await waitFor(async () => (await page.evaluateFrames('window.blockResult || null')).includes('failed'), { timeout: 10000, message: 'the blocked fetch failed' });
    assert.equal(hits.filter((h) => h.path === '/blocked-by-lumen.txt').length, 0, 'the blocked address was never fetched');
  });

  test("a video started in the frame goes to the TV's player by itself with the frame's stream, and is paused in the frame", async () => {
    const page = stack.server.features.browser;
    const plays = () => agent.screen.filter((m) => m.t === 'screen-play');
    const before = plays().length;
    // Someone clicks play: the hand-off takes only videos people start.
    assert.equal((await b.send('browser.input', { kind: 'click', x: 2, y: 2, fw: 1280, fh: 720, button: 'left' })).ok, true);
    await page.evaluateFrames('typeof startIt === "function" && startIt()');
    await waitFor(() => plays().length > before, { timeout: 20000, message: 'the framed video handed to the TV player' });
    const url = plays().at(-1).url;
    assert.match(url, /\/relay\//);
    const target = Buffer.from(url.split('/').at(-2), 'base64url').toString('utf8');
    assert.match(target, new RegExp(`^http://localhost:${port}/(early|clip)\\.m3u8$`), `the frame's stream: ${target}`);
    await waitFor(async () => (await page.evaluateFrames('typeof v === "object" ? v.paused : null')).includes(true), { timeout: 5000, message: 'the framed video paused' });
    agent.sendScreenInput({ key: 'red' });
    await b.waitForState('tvscreen.on', (r) => r?.v === false, { timeout: 5000 });
  });
});
