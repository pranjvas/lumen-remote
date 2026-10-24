// Lumen's headless Edge going away or going wrong on its own: Edge dying (it starts again on the page
// it showed while someone watches, backs off, and gives up after repeated deaths), a launch asked for
// while Edge is still closing (it waits instead of being killed by the close's sweep), Lumen's own
// reopens (a VPN switch, Clear history) not counting as the user's input, and the page's renderer
// crashing (waiting calls are let go and the page loads again). Real headless Edge on loopback pages;
// each test kills only the Edge it started.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { waitFor, sleep, createTestLog } from './helpers.js';

const EDGE = process.env.LUMEN_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const skip = !fs.existsSync(EDGE) && `headless Edge is not installed at ${EDGE}`;
const START_TIMEOUT = 30000;

const PAGE = (title, body = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
// Repaints every 40 ms, so frames keep coming.
const BUSY = '<div id="n" style="font:bold 80px sans-serif">0</div><script>let n=0;setInterval(()=>{n++;document.getElementById("n").textContent=n},40)</script>';

async function pageServer() {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    if (p === '/a') return res.end(PAGE('A', `<a id="go" href="/b">to B</a>${BUSY}`));
    if (p === '/b') return res.end(PAGE('B', BUSY));
    return res.end(PAGE('Other', BUSY));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: (p) => `http://127.0.0.1:${server.address().port}${p}`, stop: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const taskkill = (pid) => new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
function edgePids(marker) {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }`;
  return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true },
    (err, stdout) => resolve(err ? [] : stdout.split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean))));
}

/** A browser feature of its own (own data dir, so its Edge is told apart from every other). */
async function makeBrowser(web, browserConfig = {}, { vpn = () => null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-recover-'));
  const marker = path.basename(dir);
  const { loadConfig } = await import('../server/config.js');
  const { createStore } = await import('../server/store.js');
  const { createBrowser } = await import('../server/features/browser.js');
  const config = loadConfig({ dataDir: dir, browser: { edgePath: EDGE, idleMs: 600000, allowLoopback: true, ...browserConfig }, log: { level: 'warn', console: false } });
  const log = createTestLog();
  const store = createStore({ cachePath: path.join(dir, 'state-cache.json'), log: log.child('store') });
  const hub = { sendToView() {}, broadcast() {} };
  const b = createBrowser({ config, log, store, hub, vpn });
  b.start();
  const state = (key) => store.get(`browser.${key}`)?.v;
  return {
    b, store, state, marker,
    /** The running Edge's browser process (what dies when Edge crashes). */
    async browserPid() {
      const { processInfo } = await b.devtools().ws.send('SystemInfo.getProcessInfo');
      return processInfo.find((p) => p.type === 'browser').id;
    },
    location: () => b.evaluate('location.pathname').catch(() => null),
    async open(p, title) {
      await b.open(web.url(p));
      await waitFor(() => state('title') === title && state('loading') === false, { timeout: START_TIMEOUT, message: `the page ${p} (now ${state('title')})` });
    },
    async stop() {
      try {
        await b.stop();
      } finally {
        await sleep(300);
        for (const pid of await edgePids(marker)) await taskkill(pid); // never leave this test's Edge behind
        await store.stop({ save: false }).catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    },
  };
}

describe('browser: Edge dying on its own', { skip }, () => {
  let web;
  before(async () => { web = await pageServer(); });
  after(async () => { await web?.stop(); });

  test('while the TV watches: Edge starts again on the page it showed (not about:blank), and frames reach the TV again', async () => {
    const t = await makeBrowser(web, { relaunchDelaysMs: [300, 300, 300] });
    const frames = [];
    const remove = t.b.addSink(() => frames.push(Date.now()));
    try {
      await t.open('/a', 'A');
      await t.b.evaluate('document.getElementById("go").click(), true');
      await waitFor(() => t.state('url') === web.url('/b') && t.state('title') === 'B', { timeout: 15000, message: 'the click to /b' });
      const sessions = [];
      const off = t.store.on('patch', (patch) => { if (patch['browser.session']) sessions.push(patch['browser.session'].v); });
      const killedAt = Date.now();
      await taskkill(await t.browserPid());
      await waitFor(() => sessions.includes('starting') && t.state('session') === 'ready', { timeout: 30000, message: `Edge back (sessions ${sessions.join(' → ')})` });
      off();
      assert.ok(!sessions.includes('off'), `the session never said off: ${sessions.join(' → ')}`);
      assert.equal(await t.location(), '/b', 'the page it showed');
      assert.equal(t.state('url'), web.url('/b'));
      await waitFor(() => frames.some((at) => at > killedAt + 500) && t.state('title') === 'B', { timeout: 15000, message: 'frames of the page again' });
      assert.ok(t.b.lastInputAt() < killedAt, 'the reopen is not the user\'s input');
    } finally {
      remove();
      await t.stop();
    }
  });

  test('with nobody watching: the session says so and names the page; the next start brings it back', async () => {
    const t = await makeBrowser(web, { relaunchDelaysMs: [300] });
    try {
      await t.open('/a', 'A');
      await t.b.evaluate('document.getElementById("go").click(), true');
      await waitFor(() => t.state('title') === 'B', { timeout: 15000, message: 'the click to /b' });
      await taskkill(await t.browserPid());
      await waitFor(() => t.state('session') === 'error', { timeout: 20000, message: `the session in error (now ${t.state('session')})` });
      assert.match(t.state('error'), /closed unexpectedly/);
      assert.equal(t.state('url'), web.url('/b'), 'the address stays for Retry');
      await sleep(1000);
      assert.equal(t.state('session'), 'error', 'not started again by itself');
      assert.deepEqual(await edgePids(t.marker), [], 'no Edge running');
      await t.b.ensureRunning(); // as live video's capture or tvscreen's open would
      await waitFor(async () => (await t.location()) === '/b', { timeout: START_TIMEOUT, message: 'the page reopened' });
      assert.equal(t.state('session'), 'ready');
    } finally {
      await t.stop();
    }
  });

  test('Clear history during the backoff: nothing comes back', async () => {
    const t = await makeBrowser(web, { relaunchDelaysMs: [6000] });
    const remove = t.b.addSink(() => {});
    try {
      await t.open('/b', 'B');
      await taskkill(await t.browserPid());
      await waitFor(() => t.state('session') === 'starting' && !t.b.devtools(), { timeout: 20000, message: 'waiting to start again' });
      const res = await t.b.clearHistory({ history: true, cache: false });
      assert.equal(res.restarted, false, 'Edge had died: nothing to restart');
      await sleep(7000); // past the relaunch it had scheduled
      assert.equal(t.state('url') ?? null, null, 'the page is forgotten');
      assert.notEqual(t.state('session'), 'ready');
      if (t.b.devtools()) assert.notEqual(await t.location(), '/b', 'the cleared page is not brought back');
    } finally {
      remove();
      await t.stop();
    }
  });

  test('four deaths within ten minutes: it stays closed with the reason', async () => {
    const t = await makeBrowser(web, { relaunchDelaysMs: [200, 200, 200] });
    const remove = t.b.addSink(() => {});
    try {
      await t.open('/b', 'B');
      for (let i = 1; i <= 3; i += 1) {
        await taskkill(await t.browserPid());
        await waitFor(() => t.state('session') !== 'ready', { timeout: 20000, message: `death ${i} noticed` });
        await waitFor(() => t.state('session') === 'ready' && t.b.devtools(), { timeout: 40000, message: `back after death ${i} (now ${t.state('session')})` });
        await waitFor(async () => (await t.location()) === '/b', { timeout: 15000, message: `the page after death ${i}` });
      }
      await taskkill(await t.browserPid());
      await waitFor(() => t.state('session') === 'error', { timeout: 20000, message: `given up (now ${t.state('session')})` });
      assert.match(t.state('error'), /keeps closing/);
      await sleep(1500);
      assert.equal(t.state('session'), 'error');
      assert.deepEqual(await edgePids(t.marker), [], 'not started again');
    } finally {
      remove();
      await t.stop();
    }
  });
});

describe('browser: a launch asked for while Edge is closing', { skip }, () => {
  let web, t;
  before(async () => {
    web = await pageServer();
    t = await makeBrowser(web);
  });
  after(async () => {
    await t?.stop();
    await web?.stop();
  });

  test('waits for the close instead of being killed by its sweep (three times, as live video retries during a VPN switch)', async () => {
    for (let i = 0; i < 3; i += 1) {
      await t.open('/a', 'A');
      const sessions = [];
      const off = t.store.on('patch', (patch) => { if (patch['browser.session']) sessions.push(patch['browser.session'].v); });
      const closed = t.b.close();
      await sleep(1000);
      const askedAt = Date.now();
      const running = t.b.ensureRunning();
      await closed;
      await running;
      const took = Date.now() - askedAt;
      off();
      // The rest of the close plus a launch. A launch killed by the close's sweep waited out the 45 s
      // start timeout and its retry (52-59 s); a loaded PC takes up to ~25 s for the good case.
      assert.ok(took < 40000, `the launch took ${took} ms`);
      await t.b.open(web.url('/b'));
      await waitFor(() => t.state('title') === 'B', { timeout: 15000, message: 'the next page' });
      await sleep(1500); // a sweep that killed it would have done so by now
      assert.equal(t.state('session'), 'ready', `round ${i + 1}: ${sessions.join(' → ')}`);
      assert.equal(await t.location(), '/b');
    }
  });
});

describe("browser: Lumen's own reopens are not the user's input", { skip }, () => {
  let web, t;
  let proxy = null; // the stand-in VPN's proxy: loopback pages bypass it, so any address will do
  before(async () => {
    web = await pageServer();
    t = await makeBrowser(web, {}, { vpn: () => ({ proxyUrl: () => proxy, status: () => ({ enabled: !!proxy }) }) });
  });
  after(async () => {
    await t?.stop();
    await web?.stop();
  });

  test('a VPN switch (applyProxy) and a Clear history that keeps history reopen the page without stamping the input time; opening a page does', async () => {
    await t.open('/a', 'A');
    const opened = t.b.lastInputAt();
    assert.ok(opened > 0);
    await sleep(50);
    proxy = 'http://127.0.0.1:9';
    await t.b.applyProxy();
    await waitFor(async () => (await t.location()) === '/a', { timeout: START_TIMEOUT, message: 'reopened behind the proxy' });
    assert.equal(t.b.lastInputAt(), opened, 'the VPN switch is not input');

    const res = await t.b.clearHistory({ history: false, cache: true });
    assert.equal(res.restarted, true);
    await waitFor(async () => (await t.location()) === '/a', { timeout: START_TIMEOUT, message: 'reopened after clearing the cache' });
    assert.equal(t.b.lastInputAt(), opened, 'Clear history is not input');

    proxy = null;
    await t.b.applyProxy();
    await waitFor(async () => (await t.location()) === '/a', { timeout: START_TIMEOUT, message: 'reopened without the proxy' });
    assert.equal(t.b.lastInputAt(), opened);

    await t.b.open(web.url('/b'));
    const input = t.b.lastInputAt();
    assert.ok(input > opened, 'a page someone opens is input');
    await sleep(20);
    await t.b.open(web.url('/a'), { userInput: false });
    assert.equal(t.b.lastInputAt(), input, 'open(url, { userInput: false }) leaves it');
  });
});

describe("browser: the page's renderer crashing", { skip }, () => {
  let web, t;
  const frames = [];
  let removeSink;
  before(async () => {
    web = await pageServer();
    t = await makeBrowser(web);
    removeSink = t.b.addSink(() => frames.push(Date.now()));
  });
  after(async () => {
    removeSink?.();
    await t?.stop();
    await web?.stop();
  });

  // Page.crash from a second DevTools client, as a renderer crash would happen.
  async function crashPage() {
    const { port, targetId } = t.b.devtools();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    ws.send(JSON.stringify({ id: 1, method: 'Page.crash', params: {} })); // never answered
    const at = Date.now();
    setTimeout(() => ws.close(), 8000); // Edge reports the crash seconds later; the client stays till then
    return at;
  }

  test('a crash lets a waiting evaluate go at once, and the page loads again with frames on the same session', async () => {
    await t.open('/b', 'B');
    const pending = t.b.evaluate('new Promise(() => {})', { timeoutMs: 60000 });
    let letGoAt = 0;
    const settled = pending.then(() => 'resolved', (err) => { letGoAt = Date.now(); return err; });
    await sleep(300);
    const crashedAt = await crashPage();
    const err = await settled;
    assert.ok(err instanceof Error && /crashed/.test(err.message), `the evaluate was let go because the page crashed (${err?.message ?? err})`);
    assert.ok(letGoAt - crashedAt < 15000, `let go ${letGoAt - crashedAt} ms after Page.crash`);
    await waitFor(() => t.state('crashed')?.count === 1, { timeout: 5000, message: 'browser.crashed published' });
    // Edge reports a Page.crash some seconds after it (3.4 s here); browser.crashed.at is when Lumen heard.
    const noticedAt = t.state('crashed').at;
    assert.ok(Math.abs(letGoAt - noticedAt) < 1000, `let go ${letGoAt - noticedAt} ms after the crash was noticed`);
    await waitFor(() => frames.some((at) => at > crashedAt + 300), { timeout: 15000, message: 'frames again after the crash' });
    assert.equal(t.state('session'), 'ready');
    assert.equal(await t.location(), '/b');
    assert.equal(await t.b.evaluate('1 + 1'), 2, 'the page answers again');
  });

  test('three crashes within a minute: the session says the page keeps crashing; opening a page works again', async () => {
    await waitFor(async () => (await t.location()) === '/b', { timeout: 15000, message: 'the page up' });
    await crashPage(); // the second within the minute: loaded again
    await waitFor(() => t.state('crashed')?.count === 2, { timeout: 20000, message: 'the second crash' });
    await waitFor(async () => (await t.location()) === '/b', { timeout: 15000, message: 'the page up again' });
    assert.equal(t.state('session'), 'ready');
    await crashPage(); // the third
    await waitFor(() => t.state('session') === 'error', { timeout: 20000, message: `given up (now ${t.state('session')})` });
    assert.match(t.state('error'), /keeps crashing/);
    await assert.rejects(t.b.evaluate('1', { timeoutMs: 3000 }), 'a crashed page does not answer, and says so');
    const openedAt = Date.now();
    await t.b.open(web.url('/a'));
    await waitFor(() => t.state('title') === 'A' && t.state('session') === 'ready', { timeout: 15000, message: 'a page opened on the crashed tab' });
    await waitFor(() => frames.some((at) => at > openedAt + 300), { timeout: 15000, message: 'frames of the new page' });
  });
});
