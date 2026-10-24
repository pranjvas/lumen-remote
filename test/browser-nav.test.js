// Navigation details of Lumen's browser: Back leaves a full-screen player before it leaves the page;
// Back loads the previous page again (no back/forward cache), so the media list is that page's, and a
// single-page site's older streams are marked not current; HLS playlists are read to tell a master
// from its variants and renditions; and the shared viewport follows the clients still watching.
// Real headless Edge through the hub, mock TV.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startStack, waitFor, sleep } from './helpers.js';

const EDGE = process.env.LUMEN_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const skip = !fs.existsSync(EDGE) && `headless Edge is not installed at ${EDGE}`;
const START_TIMEOUT = 40000;

const taskkill = (pid) => new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
function edgePids(marker) {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }`;
  return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true },
    (err, stdout) => resolve(err ? [] : stdout.split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean))));
}

const html = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>html,body{margin:0}</style></head><body>${body}</body></html>`;
const read = (u) => `fetch(${JSON.stringify(u)}).then((r) => r.text())`;
const PLAYER = html('Player', '<div id="player" style="width:640px;height:360px;background:#000"><button id="fs" style="position:absolute;left:10px;top:10px;width:120px;height:60px">Full</button></div>'
  + '<script>fs.onclick = () => player.requestFullscreen().catch((e) => { window.fsError = String(e); });</script>');
const MASTER = ['#EXTM3U', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",DEFAULT=YES,URI="audio.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="a"', 'v720.m3u8', ''].join('\n');
const MEDIA = (ext) => ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXTINF:4,', `s1.${ext}`, '#EXTINF:4,', `s2.${ext}`, '#EXT-X-ENDLIST', ''].join('\n');

describe('browser: navigation, the media list and the shared viewport', { skip }, () => {
  let stack, web, base, a, marker;
  const feature = () => stack.server.features.browser;
  const okAck = (ack) => { assert.equal(ack.ok, true, JSON.stringify(ack.error)); return ack.value; };
  const state = (key) => stack.server.store.get(`browser.${key}`)?.v;
  const listed = (p) => feature().media().find((m) => m.url === `${base}${p}`);
  async function openPage(p, title) {
    okAck(await a.send('browser.open', { url: `${base}${p}` }, { timeout: START_TIMEOUT }));
    await waitFor(() => state('title') === title && state('loading') === false, { timeout: START_TIMEOUT, message: `the page ${p} (now ${state('title')})` });
  }

  before(async () => {
    web = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      if (p.endsWith('.m3u8')) {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
        if (p === '/hls/master.m3u8') return res.end(MASTER);
        if (p === '/hls/audio.m3u8') return res.end(MEDIA('aac'));
        return res.end(MEDIA('ts'));
      }
      // max-age=0, not no-store: a back/forward cache would keep these pages.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=0' });
      if (p === '/first') return res.end(html('First', '<h1>First</h1>'));
      if (p === '/player') return res.end(PLAYER);
      if (p === '/a') return res.end(html('A', `<a id="go" href="/b">to B</a><script>${read('/a.m3u8')}</script>`));
      if (p === '/b') return res.end(html('B', `<h1>B</h1><script>${read('/b.m3u8')}</script>`));
      if (p === '/hls') return res.end(html('HLS', `<script>${read('/hls/master.m3u8')}.then(() => ${read('/hls/v720.m3u8')}).then(() => ${read('/hls/audio.m3u8')})</script>`));
      return res.end(html('Other', ''));
    });
    await new Promise((r) => web.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${web.address().port}`;
    stack = await startStack({ config: { browser: { edgePath: EDGE, idleMs: 120000, allowLoopback: true } } });
    marker = path.basename(stack.dataDir);
    a = stack.browser();
    await a.hello;
    await a.send('view', { name: 'browser', visible: true });
    okAck(await a.send('browser.viewport', { w: 640, h: 400 }));
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

  test('Back with a player in full screen leaves full screen and stays on the video page; the next Back leaves it', async () => {
    await openPage('/first', 'First');
    await openPage('/player', 'Player');
    okAck(await a.send('browser.input', { kind: 'click', x: 70, y: 40, fw: 640, fh: 400, button: 'left' }));
    await waitFor(() => feature().evaluate('document.fullscreenElement ? document.fullscreenElement.id : null').then((id) => id === 'player'), { timeout: 5000, message: 'the player in full screen' });
    assert.deepEqual(okAck(await a.send('browser.nav', { action: 'back' })), { exitedFullscreen: true });
    await waitFor(() => feature().evaluate('document.fullscreenElement === null'), { timeout: 5000, message: 'full screen left' });
    await sleep(500);
    assert.equal(state('url'), `${base}/player`, 'still on the video page');
    okAck(await a.send('browser.nav', { action: 'back' }));
    await waitFor(() => state('url') === `${base}/first`, { timeout: 10000, message: 'back on the first page' });
  });

  test("Back loads the previous page again, so the media list is that page's streams, not the next page's", async () => {
    await openPage('/a', 'A');
    await waitFor(() => listed('/a.m3u8'), { timeout: 10000, message: "A's stream" });
    await feature().evaluate('document.getElementById("go").click(), true');
    await waitFor(() => state('title') === 'B' && listed('/b.m3u8'), { timeout: 10000, message: "B and its stream" });
    assert.equal(listed('/a.m3u8'), undefined, "A's stream went with A");
    okAck(await a.send('browser.nav', { action: 'back' }));
    await waitFor(() => state('title') === 'A', { timeout: 10000, message: 'back on A' });
    await waitFor(() => listed('/a.m3u8'), { timeout: 10000, message: `A's stream again (listed: ${feature().media().map((m) => m.url).join(', ')})` });
    assert.equal(listed('/b.m3u8'), undefined, "B's stream is not A's");
    assert.equal(listed('/a.m3u8').current, true);

    // A single-page site moving on: what it loaded before is no longer current.
    await feature().evaluate(`history.pushState({}, '', '/a/next'); ${read('/c.m3u8')}.then(() => true)`);
    await waitFor(() => listed('/c.m3u8'), { timeout: 10000, message: 'the next stream' });
    assert.equal(listed('/c.m3u8').current, true);
    assert.equal(listed('/a.m3u8').current, false);
  });

  test('playlists are read: the master, its variant and its audio rendition are told apart in media()', async () => {
    await openPage('/hls', 'HLS');
    // Roles come once each body is read (after the response): the audio rendition is marked by its
    // master at once, its own role a moment later.
    await waitFor(() => listed('/hls/master.m3u8')?.role && listed('/hls/v720.m3u8')?.role && listed('/hls/audio.m3u8')?.audio && listed('/hls/audio.m3u8')?.role, {
      timeout: 10000, message: `roles (${JSON.stringify(feature().media().map((m) => [m.url.slice(base.length), m.role, m.audio ?? false]))})`,
    });
    const master = listed('/hls/master.m3u8');
    assert.equal(master.role, 'master');
    assert.deepEqual(master.variants, [{ url: `${base}/hls/v720.m3u8`, bandwidth: 3000000, height: 720, codecs: 'avc1.64001f,mp4a.40.2' }]);
    assert.deepEqual(master.renditions, [{ url: `${base}/hls/audio.m3u8`, type: 'audio' }]);
    assert.deepEqual([listed('/hls/v720.m3u8').role, listed('/hls/v720.m3u8').audioOnly], ['media', false]);
    const audio = listed('/hls/audio.m3u8');
    assert.equal(audio.audio, true, "the master's audio rendition");
    assert.equal(audio.audioOnly, true, 'packed AAC segments');
  });

  test('the shared viewport: when the client whose size the page had leaves, the page takes the size of the one still watching; a TV that leaves restores it too', async () => {
    const size = () => feature().evaluate('innerWidth + "x" + innerHeight');
    await waitFor(async () => (await size()) === '640x400', { timeout: 8000, message: "A's size" });
    const other = stack.browser();
    try {
      await other.hello;
      await other.send('view', { name: 'browser', visible: true });
      okAck(await other.send('browser.viewport', { w: 900, h: 500 }));
      await waitFor(async () => (await size()) === '900x500', { timeout: 8000, message: "B's size" });
      await other.send('view', { name: 'home', visible: true });
      await waitFor(async () => (await size()) === '640x400', { timeout: 8000, message: `A's size again (now ${await size()})` });

      // B asks again, a TV sink takes the page, B leaves meanwhile: the TV's leaving gives A's size back.
      await other.send('view', { name: 'browser', visible: true });
      okAck(await other.send('browser.viewport', { w: 900, h: 500 }));
      await waitFor(async () => (await size()) === '900x500', { timeout: 8000, message: "B's size (2)" });
      const remove = feature().addSink(() => {});
      await waitFor(async () => (await size()) === '1280x720', { timeout: 8000, message: "the TV's size" });
      await other.send('view', { name: 'home', visible: true });
      await sleep(300);
      remove();
      await waitFor(async () => (await size()) === '640x400', { timeout: 8000, message: `A's size after the TV (now ${await size()})` });
    } finally {
      other.close();
    }
  });
});
