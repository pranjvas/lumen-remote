// Clear history (Browser view → hub browser.clearHistory): server/features/history.js scrubs page
// addresses and site names from Lumen's logs, server/features/browser.js removes the chosen kinds of
// data from the Edge profile, and the log stops writing page paths at all (server/log.js). The unit
// and hub suites need no Edge; the last suite drives the real headless Edge and skips without it.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startStack, waitFor, sleep } from './helpers.js';
import { redactString, createLogger } from '../server/log.js';
import { scrubLine, scrubLogs, maskUrls } from '../server/features/history.js';
import { removeProfileData } from '../server/features/browser.js';

const EDGE = process.env.LUMEN_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const noEdge = !fs.existsSync(EDGE) && `headless Edge is not installed at ${EDGE}`;
const START_TIMEOUT = 30000;

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (file, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const okAck = (ack) => assert.equal(ack.ok, true, JSON.stringify(ack.error));

// Log lines as Lumen wrote them before page paths were shortened at the source: the lumen.log form
// (ISO time) and the stdout.log console form (clock time). Every site here is made up.
const T = '2026-10-23T10:00:00.000Z';
const HISTORY_LINES = [
  `${T} INFO  [tvscreen] browser shown on the TV {"url":"https://video.example.com/watch?v=abc123&t=42"}`,
  `${T} INFO  [relay] relay request {"host":"cdn.example.net","method":"GET","range":"bytes=0-"}`,
  `${T} WARN  [transcode] ffmpeg stopped {"code":1,"tail":"[https @ 0x1] HTTP error 403 | https://cdn.example.net/hls/seg.m3u8?sig=1: Server returned 403"}`,
  `${T} INFO  [tvscreen] playlist refused; using another stream the page loaded {"from":"a.example.com","to":"b.example.org"}`,
  `${T} WARN  [relay] relay fetch failed {"host":"cdn.example.net","message":"getaddrinfo ENOTFOUND cdn.example.net"}`,
  `${T} INFO  [transcode] converting for the TV {"id":"0123456789abcdef","copy":true,"host":"media.example.tv"}`,
  `${T} INFO  [vpn-proxy] CONNECT established {"host":"www.example.com","port":443}`,
  `${T} INFO  [cast] cast link {"kind":"page","host":"shop.example.co"}`,
  `${T} INFO  [tvscreen] protected video handed to the TV player {"host":"drm.example.com","systems":["widevine"]}`,
  `${T} INFO  [browser] ad redirect blocked; opening its destination {"host":"landing.example.com"}`,
  `${T} WARN  [tvscreen] conversion failed {"stage":"encode","message":"The video could not be converted (https://cdn.example.net/v.m3u8: 403 Forbidden)"}`,
  `${T} INFO  [ai] ask {"text":"open the news","reply":"Opened https://news.example.com/story/1 in the browser","ok":true}`,
  `${T} INFO  [browser] cut short {"url":"https://cut.example.com/a/b`,
  `10:00:08 WARN  [tvscreen] TV player error {"error":"MEDIA_ERR_NETWORK http://192.168.1.7:8791/relay/abcd/aHR0cHM6Ly9jZG4uZXhhbXBsZS5uZXQ/x.m3u8","stage":"direct"}\r`,
];
const KEPT_LINES = [
  `${T} INFO  [http] listening on http://127.0.0.1:8790 and http://192.168.1.7:8790`,
  `${T} INFO  [agent] agent online {"version":"0.8.4","build":"T-MSLDEUC-1.0"}`,
  `${T} INFO  [browser] browser started {"port":51234,"pid":4321,"viewport":{"w":640,"h":400},"vpn":false}`,
  `${T} WARN  [ipc] getBacklight timed out {"ms":3000}`,
  '  Phone http://192.168.1.7:8790/  (same Wi-Fi)',
  '',
];
// What must be gone from the scrubbed text: the sites, the page paths and the encoded relay target.
const LEAKS = /example\.|watch\?v|abc123|\/hls\/|story\/1|aHR0cHM6|\/relay\/abcd/;

describe('history: page addresses never reach the log in full', () => {
  test('redactString keeps scheme://host of a web address and drops its path, query and user:password', () => {
    assert.equal(redactString('open https://www.example.com/watch?v=abc&t=1 now'), 'open https://www.example.com/… now');
    assert.equal(redactString('ws://user:pw@tv.local:8002/api/v2/channels'), 'ws://tv.local:8002/…');
    assert.equal(redactString('listening on http://127.0.0.1:8790 and http://192.168.1.7:8790/'), 'listening on http://127.0.0.1:8790 and http://192.168.1.7:8790/');
    assert.equal(redactString('(see http://192.168.1.7:8791/relay/abc/aHR0cA/x.m3u8)'), '(see http://192.168.1.7:8791/…)');
  });

  test('the logger writes shortened addresses to lumen.log, in messages and in fields', () => {
    const dir = tmpDir('lumen-log-');
    try {
      const log = createLogger({ dir, level: 'info', console: false });
      log.child('tvscreen').info('browser shown on https://video.example.com/watch?v=abc', { url: 'https://video.example.com/watch?v=abc', nested: { referer: 'https://a.example.org/p?q=1' } });
      log.close();
      const text = fs.readFileSync(path.join(dir, 'lumen.log'), 'utf8');
      assert.ok(!/watch\?v|p\?q=1/.test(text), text);
      assert.match(text, /browser shown on https:\/\/video\.example\.com\/… \{"url":"https:\/\/video\.example\.com\/…","nested":\{"referer":"https:\/\/a\.example\.org\/…"\}\}/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('history: scrubbing the existing logs', () => {
  test('scrubLine clears page, site and title fields in browsing lines and masks addresses everywhere else; other lines stay byte for byte', () => {
    for (const line of HISTORY_LINES) {
      const out = scrubLine(line);
      assert.notEqual(out, line, `unchanged: ${line.slice(25, 70)}`);
      assert.ok(!LEAKS.test(out), `still leaks: ${out}`);
      assert.equal(out.endsWith('\r'), line.endsWith('\r'), 'line ending kept');
    }
    for (const line of KEPT_LINES) assert.equal(scrubLine(line), line);
    // The shape of a scrubbed line: same time, level, tag and message; place fields read [cleared].
    assert.equal(scrubLine(HISTORY_LINES[1]), `${T} INFO  [relay] relay request {"host":"[cleared]","method":"GET","range":"bytes=0-"}`);
    assert.equal(scrubLine(HISTORY_LINES[4]), `${T} WARN  [relay] relay fetch failed {"host":"[cleared]","message":"getaddrinfo ENOTFOUND [host]"}`);
    assert.match(scrubLine(HISTORY_LINES[11]), /"text":"open the news","reply":"Opened \[url\] in the browser","ok":true/);
    assert.match(scrubLine(HISTORY_LINES[13]), /http:\/\/192\.168\.1\.7:8791\/…/);
    assert.equal(maskUrls('http://127.0.0.1:8790/'), 'http://127.0.0.1:8790/');
  });

  test('scrubLogs rewrites lumen.log, stdout.log and rotated copies in place: an open append handle keeps writing after the scrubbed text', () => {
    const dir = tmpDir('lumen-logs-');
    try {
      const body = [...HISTORY_LINES, ...KEPT_LINES].join('\n');
      write(path.join(dir, 'lumen.log'), body);
      write(path.join(dir, 'lumen.log.2'), `${HISTORY_LINES[0]}\n`);
      write(path.join(dir, 'stdout.log'), `${KEPT_LINES[4]}\n${HISTORY_LINES[4]}\n`);
      write(path.join(dir, 'notes.txt'), HISTORY_LINES[0]);
      // stdout.log is held open for appending, as the start-hidden launcher's redirect holds it.
      const held = fs.openSync(path.join(dir, 'stdout.log'), 'a');
      let result;
      try {
        result = scrubLogs(dir);
        fs.writeSync(held, `${KEPT_LINES[3]}\n`);
      } finally {
        fs.closeSync(held);
      }
      assert.deepEqual(result, { files: 3, lines: HISTORY_LINES.length + 2 });
      for (const name of ['lumen.log', 'lumen.log.2', 'stdout.log']) assert.ok(!LEAKS.test(fs.readFileSync(path.join(dir, name), 'utf8')), name);
      assert.equal(fs.readFileSync(path.join(dir, 'stdout.log'), 'utf8'), `${KEPT_LINES[4]}\n${scrubLine(HISTORY_LINES[4])}\n${KEPT_LINES[3]}\n`);
      assert.ok(fs.readFileSync(path.join(dir, 'lumen.log'), 'utf8').endsWith(KEPT_LINES.join('\n')), 'kept lines unchanged');
      assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), HISTORY_LINES[0], 'only log files are touched');
      assert.deepEqual(scrubLogs(dir), { files: 0, lines: 0 }, 'a second pass has nothing left');
      assert.deepEqual(scrubLogs(path.join(dir, 'missing')), { files: 0, lines: 0 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A stand-in Edge profile: one file or folder for each kind of data, and Preferences with per-site lists.
function fakeProfile() {
  const dir = tmpDir('lumen-profile-');
  const files = {
    history: ['Default/History', 'Default/History-journal', 'Default/Visited Links', 'Default/Top Sites', 'Default/Shortcuts-journal',
      'Default/Favicons', 'Default/Network Action Predictor', 'Default/Sessions/Tabs_1', 'Default/Session Storage/000003.log',
      'Default/EdgeSessions/SessionRestoreLog', 'Default/DIPS-wal', 'Default/Network/Network Persistent State', 'Default/Network/TransportSecurity'],
    cache: ['Default/Cache/Cache_Data/f_000001', 'Default/Code Cache/js/index', 'Default/GPUCache/data_0'],
    cookies: ['Default/Network/Cookies', 'Default/Network/Cookies-journal', 'Default/Local Storage/leveldb/000003.log', 'Default/IndexedDB/x/1',
      'Default/Service Worker/Database/1'],
    kept: ['Local State', 'Default/Bookmarks', 'Default/Login Data', 'Default/Web Data', 'Default/Vpn Tokens', 'Default/Secure Preferences'],
  };
  for (const name of Object.values(files).flat()) write(path.join(dir, name));
  write(path.join(dir, 'Default/Preferences'), JSON.stringify({
    profile: { content_settings: { exceptions: { site_engagement: { 'https://a.example.com:443,*': {} }, media_engagement: { 'https://a.example.com:443,*': {} }, client_hints: { 'https://a.example.com:443,*': {} }, notifications: { 'https://b.example.com:443,*': { setting: 1 } } } } },
    login_detection: { oauth_signed_in_origins: { 'https://a.example.com': 1 } },
    browser: { has_seen_welcome_page: true },
  }));
  const exists = (name) => fs.existsSync(path.join(dir, name));
  const prefs = () => JSON.parse(fs.readFileSync(path.join(dir, 'Default/Preferences'), 'utf8'));
  return { dir, files, exists, prefs };
}

describe('history: removing browsing data from the Edge profile', () => {
  test('the default choice (history and cache) removes those and keeps cookies, sign-ins, bookmarks, passwords and settings', () => {
    const p = fakeProfile();
    try {
      const { removed, left } = removeProfileData(p.dir);
      assert.deepEqual(left, []);
      assert.ok(removed >= p.files.history.length, `removed ${removed}`);
      for (const name of [...p.files.history, ...p.files.cache]) assert.equal(p.exists(name), false, `${name} is gone`);
      for (const name of [...p.files.cookies, ...p.files.kept]) assert.equal(p.exists(name), true, `${name} is kept`);
      const exceptions = p.prefs().profile.content_settings.exceptions;
      assert.deepEqual(Object.keys(exceptions).sort(), ['client_hints', 'notifications'], 'per-site visit lists go; permissions and site data stay');
      assert.ok(p.prefs().login_detection.oauth_signed_in_origins, 'sign-in record kept');
      assert.equal(p.prefs().browser.has_seen_welcome_page, true, 'other settings untouched');
    } finally {
      fs.rmSync(p.dir, { recursive: true, force: true });
    }
  });

  test('cookies alone removes cookies and site storage and nothing else', () => {
    const p = fakeProfile();
    try {
      assert.deepEqual(removeProfileData(p.dir, { history: false, cache: false, cookies: true }).left, []);
      for (const name of p.files.cookies) assert.equal(p.exists(name), false, `${name} is gone`);
      for (const name of [...p.files.history, ...p.files.cache, ...p.files.kept]) assert.equal(p.exists(name), true, `${name} is kept`);
      const prefs = p.prefs();
      assert.deepEqual(Object.keys(prefs.profile.content_settings.exceptions).sort(), ['media_engagement', 'notifications', 'site_engagement']);
      assert.equal(prefs.login_detection.oauth_signed_in_origins, undefined);
    } finally {
      fs.rmSync(p.dir, { recursive: true, force: true });
    }
  });
});

describe('history: browser.clearHistory through the hub (Edge not running)', () => {
  let stack, client, other;
  before(async () => {
    stack = await startStack();
    client = stack.browser();
    other = stack.browser();
    await Promise.all([client.hello, other.hello]);
    await client.send('view', { name: 'browser', visible: true });
  });
  after(async () => { await stack?.stop(); });

  test('invalid choices are refused before anything is touched', async () => {
    for (const args of [{ history: 'yes' }, { cache: 1 }, { cookies: null }, { history: false, cache: false, cookies: false }]) {
      const ack = await client.send('browser.clearHistory', args);
      assert.equal(ack.ok, false, JSON.stringify(args));
      assert.equal(ack.error.code, 'INVALID', JSON.stringify(args));
    }
    assert.equal(client.of('browser.cleared').length, 0);
  });

  test('clears the profile history and cache, old conversions and the page addresses in every log file; every client hears browser.cleared; the logger keeps writing', async () => {
    const data = stack.dataDir;
    const profile = path.join(data, 'browser-profile');
    for (const name of ['Default/History', 'Default/Visited Links', 'Default/Sessions/Tabs_1', 'Default/Cache/Cache_Data/f_1']) write(path.join(profile, name));
    write(path.join(profile, 'Default/Network/Cookies'));
    write(path.join(profile, 'Default/Bookmarks'));
    write(path.join(data, 'transcode/0123456789abcdef/index.m3u8'), '#EXTM3U\n');
    const logs = path.join(data, 'logs');
    fs.mkdirSync(logs, { recursive: true }); // the logger makes it on its first line
    fs.appendFileSync(path.join(logs, 'lumen.log'), `${HISTORY_LINES.slice(0, 4).join('\n')}\n`);
    write(path.join(logs, 'stdout.log'), `${HISTORY_LINES[4]}\n${KEPT_LINES[4]}\n`);
    write(path.join(logs, 'lumen.log.1'), `${HISTORY_LINES[0]}\n`);

    const ack = await client.send('browser.clearHistory', {}, { timeout: 60000 });
    okAck(ack);
    assert.equal(ack.value.history, true);
    assert.equal(ack.value.cache, true);
    assert.equal(ack.value.cookies, false);
    assert.deepEqual(ack.value.left, []);
    assert.equal(ack.value.restarted, false, 'Edge was not running, so it is not started');
    assert.equal(ack.value.conversions, 1);
    assert.ok(ack.value.logLines >= 6, `logLines ${ack.value.logLines}`);
    for (const c of [client, other]) {
      await c.waitForMessage((m) => m.t === 'browser.cleared', { timeout: 5000, message: 'browser.cleared' });
      assert.deepEqual(c.of('browser.cleared').at(-1), { t: 'browser.cleared', history: true, cache: true, cookies: false });
    }

    for (const name of ['Default/History', 'Default/Visited Links', 'Default/Sessions', 'Default/Cache']) assert.equal(fs.existsSync(path.join(profile, name)), false, `${name} is gone`);
    for (const name of ['Default/Network/Cookies', 'Default/Bookmarks']) assert.equal(fs.existsSync(path.join(profile, name)), true, `${name} is kept`);
    assert.equal(fs.existsSync(path.join(data, 'transcode/0123456789abcdef')), false, 'the old conversion is gone');
    for (const name of ['lumen.log', 'lumen.log.1', 'stdout.log']) assert.ok(!LEAKS.test(fs.readFileSync(path.join(logs, name), 'utf8')), `${name} still names a page`);
    assert.ok(fs.readFileSync(path.join(logs, 'stdout.log'), 'utf8').includes(KEPT_LINES[4]), 'other lines stay');

    stack.server.log.warn('a line after clearing');
    const after = fs.readFileSync(path.join(logs, 'lumen.log'), 'utf8');
    assert.match(after, /a line after clearing\n$/, 'the logger appends after the rewritten text');
    assert.ok(!after.includes('\0'), 'no gap where the old text was');
    assert.equal(client.value('browser.url') ?? null, null);
    assert.equal(client.value('browser.session') ?? 'off', 'off');
  });

  test('cookies only: the cookie jar goes, the logs are left alone', async () => {
    const profile = path.join(stack.dataDir, 'browser-profile');
    write(path.join(profile, 'Default/Network/Cookies'));
    write(path.join(profile, 'Default/History'));
    fs.appendFileSync(path.join(stack.dataDir, 'logs', 'stdout.log'), `${HISTORY_LINES[1]}\n`);
    const ack = await client.send('browser.clearHistory', { history: false, cache: false, cookies: true }, { timeout: 60000 });
    okAck(ack);
    assert.equal(fs.existsSync(path.join(profile, 'Default/Network/Cookies')), false);
    assert.equal(fs.existsSync(path.join(profile, 'Default/History')), true, 'history kept when not chosen');
    assert.ok(fs.readFileSync(path.join(stack.dataDir, 'logs', 'stdout.log'), 'utf8').includes(HISTORY_LINES[1]), 'logs are history: untouched');
    assert.deepEqual(client.of('browser.cleared').at(-1), { t: 'browser.cleared', history: false, cache: false, cookies: true });
  });
});

// ---------- with the real headless Edge ----------

/** A loopback site: '/' and '/second' (which sets a cookie). */
async function siteServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://test');
    const page = (title, extra = {}) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'max-age=3600', ...extra });
      res.end(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`);
    };
    if (url.pathname === '/') return page('History home');
    if (url.pathname === '/second') return page('History second', { 'Set-Cookie': 'lumen_test=kept; Path=/; Max-Age=3600' });
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
/** Edge for this data dir must be gone; strays are killed so a run never leaves Edge behind. */
async function edgeGone(marker) {
  let left = [];
  try {
    await waitFor(async () => !(left = await edgePids(marker)).length, { timeout: 10000, interval: 250, message: 'Edge to exit' });
  } catch (err) {
    await Promise.all(left.map(taskkill));
    throw err;
  }
}

describe('history: with headless Edge', { skip: noEdge }, () => {
  let stack, web, viewer, marker, profile;
  before(async () => {
    web = await siteServer();
    stack = await startStack({ config: { browser: { edgePath: EDGE, idleMs: 120000, allowLoopback: true, homeUrl: web.url('/') } } });
    marker = path.basename(stack.dataDir);
    profile = path.join(stack.dataDir, 'browser-profile');
    viewer = stack.browser();
    await viewer.hello;
    viewer.onMessage((m) => { if (m.t === 'browser.frame') viewer.fire('browser.ack', { seq: m.seq }); });
    await viewer.send('view', { name: 'browser', visible: true });
    await viewer.send('browser.viewport', { w: 640, h: 400 });
  });
  after(async () => {
    try {
      await stack?.server.stop();
      if (marker) await edgeGone(marker).catch(async () => { for (const pid of await edgePids(marker)) await taskkill(pid); });
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
  const historyBytes = () => ['History', 'History-journal', 'History-wal']
    .map((name) => path.join(profile, 'Default', name)).filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f).toString('latin1')).join('');

  test('history and cache: Edge closes, its History database and tabs go, the page is forgotten; cookies stay and the next start has no back history', async () => {
    await openPage('/second', 'History second');
    await openPage('/', 'History home');
    await viewer.waitForState('browser.canGoBack', (r) => r?.v === true, { timeout: 5000 });
    assert.equal(await evaluate('document.cookie'), 'lumen_test=kept');

    const ack = await viewer.send('browser.clearHistory', {}, { timeout: 90000 });
    okAck(ack);
    assert.deepEqual(ack.value.left, [], 'nothing was in use');
    assert.equal(ack.value.restarted, false, 'not on the TV: the browser stays off until it is used');
    await viewer.waitForState('browser.session', (r) => r?.v === 'off', { timeout: 10000 });
    assert.equal(viewer.value('browser.url') ?? null, null);
    assert.equal(viewer.value('browser.title') ?? null, null);
    await edgeGone(marker);
    for (const name of ['History', 'Visited Links', 'Sessions', 'Cache']) assert.equal(fs.existsSync(path.join(profile, 'Default', name)), false, `${name} is gone`);

    await openPage('/', 'History home');
    assert.equal(viewer.value('browser.canGoBack'), false, 'no back history');
    assert.equal(await evaluate('document.cookie'), 'lumen_test=kept', 'cookies were not chosen');
    okAck(await viewer.send('browser.close'));
    await edgeGone(marker);
    assert.ok(!historyBytes().includes(web.url('/second')), 'the cleared page is not in the new History database');
  });

  test('cookies only, with the page open: the same page comes back and its cookie is gone', async () => {
    await openPage('/', 'History home');
    assert.equal(await evaluate('document.cookie'), 'lumen_test=kept');
    const ack = await viewer.send('browser.clearHistory', { history: false, cache: false, cookies: true }, { timeout: 90000 });
    okAck(ack);
    assert.equal(ack.value.restarted, true, 'history was kept, so the page reopens');
    await viewer.waitForState('browser.session', (r) => r?.v === 'ready', { timeout: START_TIMEOUT });
    await viewer.waitForState('browser.title', (r) => r?.v === 'History home', { timeout: START_TIMEOUT });
    assert.equal(viewer.value('browser.url'), web.url('/'));
    assert.equal(await evaluate('document.cookie'), '');
    okAck(await viewer.send('browser.close'));
    await edgeGone(marker);
  });

  test('while the TV shows the browser: Edge starts again on the home page with no back history, so the TV never keeps the cleared page', async () => {
    await openPage('/second', 'History second');
    // Frames the TV gets (tvscreen attaches a sink like this one), and when Edge started again after
    // the clear: a frame after that is the new Edge's (the old one was closed before it).
    const frames = [];
    const removeSink = stack.server.features.browser.addSink(() => frames.push(Date.now()));
    let restartAt = Infinity;
    const unsubscribe = stack.server.store.on('patch', (patch) => { if (patch['browser.session']?.v === 'starting') restartAt = Math.min(restartAt, Date.now()); });
    try {
      const ack = await viewer.send('browser.clearHistory', {}, { timeout: 90000 });
      okAck(ack);
      assert.equal(ack.value.restarted, true);
      await viewer.waitForState('browser.session', (r) => r?.v === 'ready', { timeout: START_TIMEOUT });
      await viewer.waitForState('browser.title', (r) => r?.v === 'History home', { timeout: START_TIMEOUT });
      assert.equal(viewer.value('browser.url'), web.url('/'));
      assert.equal(viewer.value('browser.canGoBack'), false);
      assert.ok(restartAt < Infinity, 'Edge started again');
      await waitFor(() => frames.some((at) => at > restartAt), { timeout: 10000, message: `the TV gets frames of the new page (${frames.length} frames)` });
    } finally {
      unsubscribe();
      removeSink();
    }
    okAck(await viewer.send('browser.close'));
    await edgeGone(marker);
  });
});
