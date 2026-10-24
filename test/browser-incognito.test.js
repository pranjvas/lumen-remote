// Incognito (Browser view → hub browser.incognito): server/features/browser.js runs Edge on a fresh
// profile in the temp folder and deletes it when incognito ends; server/features/incognito.js keeps
// page addresses, sites and titles out of the log while it is on and drops the session's streams,
// conversions and Ask Lumen exchanges when it ends; tools/restart.ps1 -KeepTvPage never reopens an
// incognito page. The unit and hub suites need no Edge; the last suites drive the real headless Edge
// and skip without it.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startStack, makeDataDir, testConfig, waitFor, sleep, ROOT } from './helpers.js';
import { startMockTv } from './mock-tv.js';
import { createLogger } from '../server/log.js';
import { incognitoLine } from '../server/features/history.js';
import { incognitoPrefixFor } from '../server/features/browser.js';

const EDGE = process.env.LUMEN_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const noEdge = !fs.existsSync(EDGE) && `headless Edge is not installed at ${EDGE}`;
const START_TIMEOUT = 45000;
const TOKEN = `zq${Date.now().toString(36)}incog`; // in the incognito page's address and title only

const okAck = (ack) => assert.equal(ack.ok, true, JSON.stringify(ack.error));
const write = (file, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const readLog = (dataDir) => {
  const dir = path.join(dataDir, 'logs');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n') : '';
};

// ---------- the log while incognito ----------

const T = '2026-10-24T10:00:00.000Z';
const PRIVATE_LINES = [
  `${T} INFO  [tvscreen] browser shown on the TV {"host":"video.example.com"}`,
  `${T} INFO  [browser] ad redirect blocked; opening its destination {"host":"landing.example.com"}`,
  `${T} WARN  [relay] relay fetch failed {"host":"cdn.example.net","message":"getaddrinfo ENOTFOUND cdn.example.net"}`,
  `${T} INFO  [ai] ask {"backend":"agent-sdk","text":"summarise this page","tools":["browser_read"],"ok":true,"reply":"The page is about the secret plan","ms":900}`,
  `${T} INFO  [mcp] tool browser_read {"ok":true,"summary":"Read \\"Secret plan - Example\\" (12 things to click)"}`,
  `${T} DEBUG [vpn-proxy] CONNECT established {"host":"www.example.org","port":443}`,
  `${T} WARN  [hub] browser.open failed unexpectedly {"error":"navigation to https://www.example.org/… failed"}`,
  `10:00:08 INFO  [tvscreen] video handed to the TV player {"kind":"hls","engine":"avplay","host":"media.example.tv"}\r`,
];
const LEAKS = /example\.|summarise this page|secret plan|Secret plan/;
const UNCHANGED = [
  `${T} INFO  [browser] browser started {"port":51234,"pid":4321,"viewport":{"w":640,"h":400},"vpn":false,"incognito":true}`,
  `${T} INFO  [agent] agent online {"version":"0.8.6"}`,
  `${T} INFO  [http] listening on http://127.0.0.1:8790 and http://192.168.1.7:8790`,
];

describe('incognito: the log keeps no page', () => {
  test('incognitoLine clears every page, site, title, request and reply; other lines stay byte for byte', () => {
    for (const line of PRIVATE_LINES) {
      const out = incognitoLine(line);
      assert.ok(!LEAKS.test(out), `still names the page: ${out}`);
      assert.equal(out.endsWith('\r'), line.endsWith('\r'), 'line ending kept');
    }
    for (const line of UNCHANGED) assert.equal(incognitoLine(line), line);
    assert.equal(incognitoLine(PRIVATE_LINES[0]), `${T} INFO  [tvscreen] browser shown on the TV {"host":"[incognito]"}`);
    assert.match(incognitoLine(PRIVATE_LINES[3]), /"text":"\[incognito\]","tools":\["browser_read"\],"ok":true,"reply":"\[incognito\]","ms":900/);
  });

  test('the logger passes every line through its filter, in lumen.log and on the console (stdout.log)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-incog-log-'));
    const printed = [];
    const { log: realLog, error: realError } = console;
    console.log = (line) => printed.push(line);
    console.error = (line) => printed.push(line);
    try {
      const log = createLogger({ dir, level: 'info', console: true });
      let on = true;
      log.setFilter((line) => (on ? incognitoLine(line) : line));
      log.child('tvscreen').info('browser shown on the TV', { host: 'video.example.com' });
      log.child('relay').warn('relay fetch failed for https://cdn.example.net/hls/x.m3u8', { host: 'cdn.example.net' });
      on = false;
      log.child('tvscreen').info('browser shown on the TV', { host: 'after.example.com' });
      log.close();
      const lines = fs.readFileSync(path.join(dir, 'lumen.log'), 'utf8').trim().split('\n');
      assert.equal(lines.length, 3);
      for (const line of [...lines.slice(0, 2), ...printed.slice(0, 2)]) assert.ok(!/example\./.test(line), line);
      assert.match(lines[0], /\{"host":"\[incognito\]"\}$/);
      assert.match(lines[2], /after\.example\.com/, 'once incognito is off, lines are as before');
      assert.equal(printed.length, 3);
    } finally {
      console.log = realLog;
      console.error = realError;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- the hub, without Edge ----------

/** node processes running Lumen's real server (tools/restart.ps1 would stop them): must survive a -WhatIf. */
function lumenServers() {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*lumen-remote\\server\\index.js*' } | ForEach-Object { $_.ProcessId }";
  return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true },
    (err, stdout) => resolve(err ? [] : stdout.split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean).sort())));
}

/** tools/restart.ps1 -KeepTvPage -WhatIf against `port`: what it would reopen, changing nothing. */
function restartPlan(port) {
  return new Promise((resolve, reject) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'tools', 'restart.ps1'), '-KeepTvPage', '-Port', String(port), '-WhatIf'],
  { windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout))));
}

describe('incognito: browser.incognito through the hub (Edge not running)', () => {
  let stack, client;
  before(async () => {
    // No Edge at this path: this suite never starts one, and a start fails at once.
    stack = await startStack({ config: { browser: { edgePath: path.join(os.tmpdir(), 'lumen-no-edge-here', 'msedge.exe') }, log: { level: 'debug', console: false } } });
    client = stack.browser();
    await client.hello;
  });
  after(async () => { await stack?.stop(); });

  const set = async (on) => {
    const ack = await client.send('browser.incognito', { on }, { timeout: 30000 });
    okAck(ack);
    assert.deepEqual(ack.value, { on });
    await client.waitForState('browser.incognito', (r) => r?.v === on, { timeout: 5000 });
  };

  test('starts off; anything but a boolean is refused', async () => {
    assert.equal(client.value('browser.incognito'), false);
    for (const args of [{}, { on: 'yes' }, { on: 1 }, { on: null }]) {
      const ack = await client.send('browser.incognito', args);
      assert.equal(ack.ok, false, JSON.stringify(args));
      assert.equal(ack.error.code, 'INVALID', JSON.stringify(args));
    }
  });

  test('on with no page open starts nothing; off again leaves the browser off', async () => {
    await set(true);
    assert.equal(client.value('browser.session') ?? 'off', 'off', 'Edge is not started just for the switch');
    assert.equal(stack.server.features.browser.incognitoProfile(), null, 'no profile folder before Edge starts');
    await set(false);
    assert.equal(client.value('browser.session') ?? 'off', 'off');
  });

  test('a browser that fails to start does not end incognito (Retry stays incognito)', async () => {
    await set(true);
    const ack = await client.send('browser.open', { url: `http://127.0.0.1:9/${TOKEN}` }, { timeout: 30000 });
    assert.equal(ack.ok, false);
    await client.waitForState('browser.session', (r) => r?.v === 'error', { timeout: 5000 });
    assert.equal(client.value('browser.incognito'), true);
    await set(false);
  });

  test('while on, log lines name no page, site, title or Ask Lumen request; after, they are as before', async () => {
    const log = stack.server.log;
    await set(true);
    log.child('tvscreen').info('browser shown on the TV', { host: 'video.example.com' });
    log.child('relay').warn('relay fetch failed', { host: 'cdn.example.net', message: 'getaddrinfo ENOTFOUND cdn.example.net' });
    log.child('ai').info('ask', { text: 'summarise this page', reply: 'The page at https://news.example.com/story/1 is about the secret plan', ok: true });
    log.child('mcp').info('tool browser_read', { ok: true, summary: 'Read "Secret plan - Example"' });
    log.child('hub').warn('browser.open failed unexpectedly', new Error('navigation to https://www.example.org/watch?v=1 failed'));
    const during = readLog(stack.dataDir);
    assert.ok(!LEAKS.test(during), 'nothing names the page while incognito');
    assert.match(during, /\[tvscreen\] browser shown on the TV \{"host":"\[incognito\]"\}/);
    await set(false);
    log.child('tvscreen').info('browser shown on the TV', { host: 'normal.example.com' });
    assert.match(readLog(stack.dataDir), /"host":"normal\.example\.com"/, 'the normal log names the site, as before');
  });

  test('Ask Lumen: exchanges made while incognito are never saved, and are forgotten when it ends', async () => {
    const { ai } = stack.server.features;
    const threads = path.join(stack.dataDir, 'ai-threads.json');
    const ask = (text) => ai.ask(text, { id: `r${Math.random().toString(36).slice(2, 8)}`, emit: () => {}, thread: 'incognitothread' });
    await ask('a normal question');
    await set(true);
    await ask(`what does ${TOKEN} say`);
    await ask(`and ${TOKEN} again`);
    const saved = fs.readFileSync(threads, 'utf8');
    assert.match(saved, /a normal question/, 'the earlier exchange is kept');
    assert.ok(!saved.includes(TOKEN), 'incognito exchanges are not written');
    await set(false);
    await waitFor(() => /incognito session forgotten .*"exchanges":2/.test(readLog(stack.dataDir)), { timeout: 5000, message: 'the two exchanges forgotten' });
    assert.equal(ai.forgetPrivate(), 0, 'nothing private is left in memory');
    await ask('one more normal question');
    const after = fs.readFileSync(threads, 'utf8');
    assert.match(after, /one more normal question/);
    assert.ok(!after.includes(TOKEN));
  });

  test('when it ends, the TV screen memory, the relay streams and the conversions of the session go', async () => {
    const { tvscreen, relay } = stack.server.features;
    let forgot = 0;
    const original = tvscreen.forgetHistory;
    tvscreen.forgetHistory = () => { forgot += 1; return original(); };
    try {
      await set(true);
      relay.register('https://cdn.example.net/hls/master.m3u8', { referer: 'https://video.example.com/watch' });
      write(path.join(stack.dataDir, 'transcode', 'fedcba9876543210', 'index.m3u8'), '#EXTM3U\n');
      await set(false);
      await waitFor(() => forgot === 1, { timeout: 5000, message: 'the TV screen forgot the session' });
      assert.equal(relay.forget(), 0, 'no stream of the session is still registered');
      assert.equal(fs.existsSync(path.join(stack.dataDir, 'transcode', 'fedcba9876543210')), false, 'its conversion is gone');
    } finally {
      tvscreen.forgetHistory = original;
    }
  });

  test('tools/restart.ps1 -KeepTvPage never reopens an incognito page (checked with -WhatIf, nothing restarts)', { skip: process.platform !== 'win32' && 'Windows PowerShell' }, async () => {
    const servers = await lumenServers();
    const { store } = stack.server;
    const page = (url) => store.set('browser.url', url, { src: 'derived', via: 'browser' });
    try {
      page(`http://127.0.0.1:9/${TOKEN}`);
      const normal = await restartPlan(stack.httpPort);
      assert.match(normal, /What if: .*Restart/);
      assert.match(normal, /Would reopen the page after the restart/);

      await set(true);
      page(`http://127.0.0.1:9/${TOKEN}`);
      const incognito = await restartPlan(stack.httpPort);
      assert.match(incognito, /The browser is incognito: its page is not reopened/);
      assert.match(incognito, /No page would be reopened/);
      assert.ok(!incognito.includes(TOKEN), 'the page address is not printed');
    } finally {
      page(null);
      await set(false);
    }
    assert.deepEqual(await lumenServers(), servers, 'the running Lumen server was not touched');
  });
});

// ---------- with the real headless Edge ----------

/** A loopback site: '/' (home), '/normal' (sets a cookie) and '/<TOKEN>' (the incognito page, sets another). */
async function siteServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://test');
    const page = (title, extra = {}) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'max-age=3600', ...extra });
      res.end(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><script>try { localStorage.setItem('seen', ${JSON.stringify(title)}); } catch (e) {}</script></body></html>`);
    };
    if (url.pathname === '/') return page('Incognito home');
    if (url.pathname === '/normal') return page('Normal page', { 'Set-Cookie': 'normal=1; Path=/; Max-Age=3600' });
    if (url.pathname === `/${TOKEN}`) return page(`Private ${TOKEN}`, { 'Set-Cookie': 'private=1; Path=/; Max-Age=3600' });
    res.writeHead(404);
    return res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: (p) => `http://127.0.0.1:${server.address().port}${p}`,
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function edgePids(marker) {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }`;
  return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true },
    (err, stdout) => resolve(err ? [] : stdout.split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean))));
}
const taskkill = (pid) => new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
/** No Edge with `marker` in its command line may be left; strays are killed so a run never leaves Edge behind. */
async function edgeGone(marker) {
  let left = [];
  try {
    await waitFor(async () => !(left = await edgePids(marker)).length, { timeout: 15000, interval: 250, message: `Edge (${marker}) to exit` });
  } catch (err) {
    await Promise.all(left.map(taskkill));
    throw err;
  }
}

// Every file of a profile with its size and modification time.
function profileFiles(dir) {
  const out = {};
  const walk = (d) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      const file = path.join(d, name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.isDirectory()) walk(file);
      else out[path.relative(dir, file)] = `${st.size}:${st.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}
const bytesOf = (dir) => Object.keys(profileFiles(dir)).map((name) => {
  try { return fs.readFileSync(path.join(dir, name)).toString('latin1'); } catch { return ''; }
}).join('');

describe('incognito: with headless Edge', { skip: noEdge }, () => {
  let stack, web, viewer, normalMarker, profile;
  const markers = new Set();
  before(async () => {
    web = await siteServer();
    stack = await startStack({ config: { browser: { edgePath: EDGE, idleMs: 120000, allowLoopback: true, homeUrl: web.url('/') }, log: { level: 'debug', console: false } } });
    profile = path.join(stack.dataDir, 'browser-profile');
    normalMarker = path.join(path.basename(stack.dataDir), 'browser-profile');
    markers.add(normalMarker);
    viewer = stack.browser();
    await viewer.hello;
    viewer.onMessage((m) => { if (m.t === 'browser.frame') viewer.fire('browser.ack', { seq: m.seq }); });
    await viewer.send('view', { name: 'browser', visible: true });
    await viewer.send('browser.viewport', { w: 640, h: 400 });
  });
  after(async () => {
    try {
      await stack?.server.stop();
      for (const marker of markers) await edgeGone(marker).catch(async () => { for (const pid of await edgePids(marker)) await taskkill(pid); });
    } finally {
      await sleep(300);
      await stack?.stop().catch(() => {});
      await web?.stop();
    }
  });

  const openPage = async (p, title) => {
    okAck(await viewer.send('browser.open', { url: web.url(p) }, { timeout: START_TIMEOUT }));
    await viewer.waitForState('browser.title', (r) => r?.v === title, { timeout: START_TIMEOUT });
    await viewer.waitForState('browser.loading', (r) => r?.v === false, { timeout: 10000 });
  };
  const evaluate = (expr) => stack.server.features.browser.evaluate(expr);
  const set = async (on) => {
    const ack = await viewer.send('browser.incognito', { on }, { timeout: 90000 });
    okAck(ack);
    await viewer.waitForState('browser.incognito', (r) => r?.v === on, { timeout: 5000 });
  };
  const tempProfile = () => {
    const dir = stack.server.features.browser.incognitoProfile();
    if (dir) markers.add(path.basename(dir));
    return dir;
  };
  let normalFiles = null; // the normal profile's files while incognito began

  test('on: Edge restarts on a fresh profile in the temp folder, with every page and cookie of the normal one left behind', async () => {
    await openPage('/normal', 'Normal page');
    assert.equal(await evaluate('document.cookie'), 'normal=1');
    await set(true);
    await viewer.waitForState('browser.session', (r) => r?.v === 'ready', { timeout: START_TIMEOUT });
    await viewer.waitForState('browser.title', (r) => r?.v === 'Incognito home', { timeout: START_TIMEOUT });
    normalFiles = profileFiles(profile);
    const dir = tempProfile();
    assert.ok(dir, 'Edge runs on an incognito profile');
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()), 'in the temp folder');
    assert.ok(path.basename(dir).startsWith(incognitoPrefixFor(profile)), path.basename(dir));
    assert.ok(fs.existsSync(path.join(dir, 'Default')), 'Edge made its profile there');
    assert.ok((await edgePids(path.basename(dir))).length > 0, 'Edge runs with the temp profile');
    assert.deepEqual(await edgePids(normalMarker), [], 'no Edge runs on the normal profile');
    assert.equal(await evaluate('document.cookie'), '', 'no cookie of the normal profile');
    assert.equal(viewer.value('browser.canGoBack'), false, 'no back history from the normal session');
  });

  test('while on: the page lives in memory only; neither the state cache, the log nor the normal profile get it', async () => {
    await openPage(`/${TOKEN}`, `Private ${TOKEN}`);
    assert.equal(await evaluate('document.cookie'), 'private=1');
    assert.equal(viewer.value('browser.url'), web.url(`/${TOKEN}`), 'the phone still sees the page (in memory)');
    stack.server.store.set('lumen.test', Date.now(), { src: 'live' }); // so the cache is written now
    stack.server.store.persist();
    const cache = fs.readFileSync(path.join(stack.dataDir, 'state-cache.json'), 'utf8');
    assert.ok(!cache.includes(TOKEN), 'the page is not in the state cache');
    assert.deepEqual(Object.keys(JSON.parse(cache).records).filter((key) => key.startsWith('browser.') || key.startsWith('tvscreen.')), []);
    await sleep(500);
    const log = readLog(stack.dataDir);
    assert.match(log, /browser started .*"incognito":true/);
    assert.ok(!log.includes(TOKEN), 'the page is not in the log');
    assert.deepEqual(profileFiles(profile), normalFiles, 'the normal profile is untouched while incognito');
  });

  test('off: the temp profile is deleted, Edge goes back to the normal profile and the page from before', async () => {
    const dir = tempProfile();
    await set(false);
    assert.equal(fs.existsSync(dir), false, 'the incognito profile is gone');
    await edgeGone(path.basename(dir));
    await viewer.waitForState('browser.title', (r) => r?.v === 'Normal page', { timeout: START_TIMEOUT });
    assert.equal(viewer.value('browser.url'), web.url('/normal'));
    assert.equal(await evaluate('document.cookie'), 'normal=1', 'the normal profile’s cookie is back');
    assert.ok((await edgePids(normalMarker)).length > 0, 'Edge runs on the normal profile again');
    assert.equal(stack.server.features.browser.incognitoProfile(), null);
    okAck(await viewer.send('browser.close', {}, { timeout: 45000 })); // Edge can take a while to close on a busy PC
    await edgeGone(normalMarker);
    assert.ok(!bytesOf(profile).includes(TOKEN), 'the incognito page is nowhere in the normal profile');
    assert.ok(!readLog(stack.dataDir).includes(TOKEN), 'nor in the log');
  });

  test('a close still under way does not end an incognito session started meanwhile', async () => {
    await openPage('/normal', 'Normal page');
    const closed = viewer.send('browser.close', {}, { timeout: 45000 }); // incognito is turned on while Edge is closing
    await set(true);
    okAck(await closed);
    await sleep(300);
    assert.equal(viewer.value('browser.incognito'), true, 'still incognito once the old Edge has closed');
    await edgeGone(normalMarker);
    await set(false);
  });

  test('Edge crashing while incognito ends it: the temp profile is deleted and the page forgotten', async () => {
    await set(true);
    await openPage(`/${TOKEN}`, `Private ${TOKEN}`);
    const dir = tempProfile();
    assert.ok(dir && fs.existsSync(dir));
    for (const pid of await edgePids(path.basename(dir))) await taskkill(pid);
    await viewer.waitForState('browser.incognito', (r) => r?.v === false, { timeout: 20000 });
    await viewer.waitForState('browser.session', (r) => r?.v === 'error', { timeout: 10000 });
    assert.equal(fs.existsSync(dir), false, 'the incognito profile is gone');
    assert.equal(viewer.value('browser.url') ?? null, null, 'the page is forgotten');
    assert.deepEqual(stack.server.features.browser.media(), []);
  });

  test('on the TV: off closes the TV screen, and the session’s streams are forgotten', async () => {
    const agent = stack.agent();
    await viewer.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
    await set(true);
    okAck(await viewer.send('browser.openOnTv', { url: web.url(`/${TOKEN}`) }, { timeout: START_TIMEOUT }));
    await viewer.waitForState('tvscreen.on', (r) => r?.v === true, { timeout: 10000 });
    await waitFor(() => agent.frames.length > 0, { timeout: 15000, message: 'the TV gets the page' });
    const dir = tempProfile();
    stack.server.features.relay.register('https://cdn.example.net/hls/master.m3u8', {});
    const screenOff = agent.requests.filter((r) => r.type === 'screen' && r.on === false).length;
    await set(false);
    await viewer.waitForState('tvscreen.on', (r) => r?.v === false, { timeout: 10000 });
    assert.ok(agent.requests.filter((r) => r.type === 'screen' && r.on === false).length > screenOff, 'the TV was told to close the screen');
    assert.equal(fs.existsSync(dir), false);
    assert.equal(stack.server.features.relay.forget(), 0, 'the session’s streams are gone');
    assert.equal(viewer.value('browser.session'), 'off', 'nothing to go back to: the browser stays off');
    agent.close();
  });

  test('Lumen stopping while incognito deletes the temp profile', async () => {
    await set(true);
    await openPage(`/${TOKEN}`, `Private ${TOKEN}`);
    const dir = tempProfile();
    assert.ok(dir && fs.existsSync(dir));
    await stack.server.stop();
    // stop() waits at most 5 s per part, and closing Edge can take longer on a busy PC: the profile
    // goes when the browser's close finishes (or, if Lumen's process exits first, in its exit hook).
    await waitFor(() => !fs.existsSync(dir), { timeout: 20000, interval: 200, message: 'the incognito profile is gone' });
    await edgeGone(path.basename(dir));
  });
});

describe('incognito: a killed Lumen’s leftovers', { skip: noEdge }, () => {
  test('the next start kills the incognito Edge it left running and deletes its profile, before Edge starts again', async () => {
    const mock = await startMockTv();
    const data = makeDataDir({ remoteToken: mock.tokens.remote, ipcToken: mock.tokens.ipc });
    const leftover = path.join(os.tmpdir(), `${incognitoPrefixFor(path.join(data.dir, 'browser-profile'))}left${Date.now().toString(36)}`);
    const other = path.join(os.tmpdir(), `${incognitoPrefixFor(path.join(data.dir, 'another-profile'))}other${Date.now().toString(36)}`);
    write(path.join(leftover, 'Default', 'History'), TOKEN);
    write(path.join(other, 'keep'), 'another Lumen’s session');
    const orphan = spawn(EDGE, ['--headless=new', `--user-data-dir=${leftover}`, '--remote-debugging-port=0', '--no-first-run', 'about:blank'], { stdio: 'ignore', windowsHide: true });
    let server;
    try {
      await waitFor(async () => (await edgePids(path.basename(leftover))).length > 0, { timeout: 20000, interval: 250, message: 'the orphaned Edge runs' });
      const { startServer } = await import('../server/app.js');
      server = await startServer(testConfig(mock, data.dir, { browser: { edgePath: EDGE, allowLoopback: true } }));
      await waitFor(() => !fs.existsSync(leftover), { timeout: 20000, interval: 200, message: 'the leftover profile is deleted' });
      await edgeGone(path.basename(leftover));
      assert.equal(fs.existsSync(other), true, 'another Lumen’s incognito profile is not touched');
      assert.equal(server.store.get('browser.incognito')?.v, false);
    } finally {
      for (const pid of await edgePids(path.basename(leftover))) await taskkill(pid);
      if (orphan.pid) await taskkill(orphan.pid);
      await server?.stop().catch(() => {});
      await mock.stop();
      fs.rmSync(leftover, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      fs.rmSync(other, { recursive: true, force: true });
      data.cleanup();
    }
  });
});
