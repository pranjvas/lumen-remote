// Lumen's browser blocks ads, trackers and pop-under networks itself (browser.adBlock, catalog/
// adblock.js): their requests never leave Edge in the page, in its cross-site iframes and in its
// pop-ups; a page on an ad host (a click-jacking layer sending the page away, a pop-under window, an ad
// frame) is refused, the page stays as it was and an ad window is closed. Other hosts load as before,
// browser.adsBlocked counts what was refused for the page, and adBlock: false turns it all off.
// Every name the test pages use (ad hosts included) resolves to this PC (browser.hostResolverRules),
// so nothing reaches the internet; the one local server tells the names apart by their Host header.
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

const taskkill = (pid) => new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
function edgePids(marker) {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }`;
  return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true },
    (err, stdout) => resolve(err ? [] : stdout.split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean))));
}

// Hosts on the bundled list (each a subdomain or the bare domain of an entry), and the ones that are not.
const AD_HOSTS = ['ads.doubleclick.net', 'popads.net', 'syndication.exoclick.com', 'a.realsrv.com', 'tpc.googlesyndication.com',
  'cdn.trafficjunky.net', 'ads.juicyads.com', 'go.popcash.net', 'go.popads.net', 'frame.hilltopads.net'];
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0">${body}</body></html>`;
// A page whose big button (at 0,0, as browser-popup.test.js clicks it) runs `onclick`.
const opener = (title, onclick) => page(title, `<button id="b" style="position:absolute;left:0;top:0;width:320px;height:200px">go</button><script>b.onclick = () => { ${onclick} };</script>`);
// A request whose outcome the page keeps in window.results[name]: 'loaded' or 'blocked'.
const probe = (name, url) => `fetch(${JSON.stringify(url)}).then(() => { (window.results ??= {})[${JSON.stringify(name)}] = 'loaded'; }, () => { (window.results ??= {})[${JSON.stringify(name)}] = 'blocked'; });`;

function startSite() {
  const hits = []; // `${host}${path}` of every request that reached this PC
  let port;
  const at = (host, p) => `http://${host}:${port}${p}`;
  const server = http.createServer((req, res) => {
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    const p = new URL(req.url, 'http://x').pathname;
    hits.push(`${host}${p}`);
    if (/\.(gif|js|txt)$/.test(p)) {
      res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : 'text/plain', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      return res.end(p.endsWith('.js') ? 'window.adScript = true;' : 'x');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    if (host === 'site.example' && p === '/video') {
      // A video page with ads in it: a banner, a pop-under script, an ad frame and a beacon, a host that
      // is no ad (one that carries an ad address in its query too), and a cross-site player frame.
      return res.end(page('Video page', `<script>window.marker = 1;</script>
        <img src="${at('ads.doubleclick.net', '/banner.gif')}"><script src="${at('popads.net', '/pop.js')}"></script>
        <img src="${at('cdn.example', '/ok.gif')}?ref=http://ads.doubleclick.net/">
        <iframe src="${at('syndication.exoclick.com', '/ad-frame')}"></iframe>
        <iframe src="${at('player.example', '/player')}" style="width:400px;height:200px;border:0"></iframe>
        <script>${probe('adFetch', at('a.realsrv.com', '/beacon.txt'))}${probe('okFetch', at('cdn.example', '/ok.txt'))}</script>`));
    }
    if (host === 'player.example' && p === '/player') {
      return res.end(page('Player', `<img src="${at('tpc.googlesyndication.com', '/in-frame.gif')}"><img src="${at('cdn.example', '/frame-ok.gif')}">
        <script>${probe('adFetch', at('cdn.trafficjunky.net', '/frame-beacon.txt'))}${probe('okFetch', at('cdn.example', '/frame-ok.txt'))}</script>`));
    }
    if (host === 'site.example' && p === '/clean') return res.end(page('Clean', '<p>no ads</p>'));
    if (host === 'site.example' && p === '/clickjack') return res.end(page('Clickjack', '<script>window.marker = 1;</script><p>a page with a click-jacking layer</p>'));
    // Sized pop-ups (real windows, see PAGE_SCRIPT): one on the site whose page and cross-site frame ask
    // for ads once it has opened, and a pop-under straight to an ad host.
    if (host === 'site.example' && p === '/opener') return res.end(opener('Opener', `window.open(${JSON.stringify(at('site.example', '/popup'))}, 'w1', 'width=420,height=560')`));
    if (host === 'site.example' && p === '/popunder') return res.end(opener('Popunder', `window.open(${JSON.stringify(at('go.popcash.net', '/under'))}, 'w2', 'width=420,height=560')`));
    if (host === 'site.example' && p === '/popup') {
      return res.end(page('Pop-up', `<script>setTimeout(() => {
        new Image().src = ${JSON.stringify(at('ads.juicyads.com', '/popup-ad.gif'))}; new Image().src = ${JSON.stringify(at('cdn.example', '/popup-ok.gif'))};
        const f = document.createElement('iframe'); f.src = ${JSON.stringify(at('player.example', '/popup-frame'))}; document.body.append(f);
      }, 1000);</script>`));
    }
    // A link the middle button opens in a new tab: Edge opens it itself, with no opener, and Lumen does
    // not show it; its page asks for an ad once it has loaded.
    if (host === 'site.example' && p === '/middle') {
      return res.end(page('Middle', `<a href="${at('site.example', '/tab')}" style="position:absolute;left:0;top:0;width:320px;height:200px;display:block">link</a>`));
    }
    if (host === 'site.example' && p === '/tab') {
      return res.end(page('Tab', `<script>setTimeout(() => { new Image().src = ${JSON.stringify(at('ads.doubleclick.net', '/tab-ad.gif'))};
        new Image().src = ${JSON.stringify(at('cdn.example', '/tab-ok.gif'))}; }, 1000);</script>`));
    }
    if (host === 'player.example' && p === '/popup-frame') {
      return res.end(page('Pop-up frame', `<img src="${at('frame.hilltopads.net', '/popup-frame-ad.gif')}"><img src="${at('cdn.example', '/popup-frame-ok.gif')}">`));
    }
    return res.end(page(p.slice(1) || 'Home', `${host} page`));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    port = server.address().port;
    resolve({ server, hits, at, adHits: () => hits.filter((h) => AD_HOSTS.some((a) => h.startsWith(`${a}/`))) });
  }));
}

async function startBrowser(extra = {}) {
  const stack = await startStack({ config: {
    browser: { edgePath: EDGE, idleMs: 120000, allowLoopback: false, hostResolverRules: 'MAP * 127.0.0.1', ...extra },
    log: { level: 'debug', console: false },
  } });
  const client = stack.browser();
  await client.hello;
  await client.send('view', { name: 'browser', visible: true });
  await client.send('browser.viewport', { w: 640, h: 400 });
  return { stack, client, marker: path.basename(stack.dataDir) };
}
async function stopBrowser(s) {
  if (!s) return;
  try {
    await s.stack.server.stop();
    await sleep(500);
    for (const pid of await edgePids(s.marker)) await taskkill(pid);
  } finally {
    await s.stack.stop().catch(() => {});
  }
}

describe('browser: ads, trackers and pop-unders are blocked', { skip }, () => {
  let site, s;
  before(async () => {
    site = await startSite();
    s = await startBrowser();
  });
  after(async () => {
    try { await stopBrowser(s); } finally { site?.server.close(); }
  });

  const state = (key) => s.stack.server.store.get(`browser.${key}`)?.v;
  const b = () => s.stack.server.features.browser;
  async function visit(url, title) {
    const ack = await s.client.send('browser.open', { url }, { timeout: 40000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    await waitFor(() => state('title') === title && state('loading') === false, { timeout: 20000, message: `${title} loaded` });
  }

  test('in the page and its cross-site player frame: ad requests never leave Edge, other hosts load, and they are counted', async () => {
    await visit(site.at('site.example', '/video'), 'Video page');
    await waitFor(() => site.hits.includes('player.example/player'), { timeout: 10000, message: 'the player frame loaded' });
    await waitFor(async () => {
      const frames = await b().evaluateFrames('window.results && Object.keys(window.results).length === 2 ? window.results : null');
      return frames.filter(Boolean).length === 2;
    }, { timeout: 10000, message: 'every probe in the page and the frame answered' });
    const frames = (await b().evaluateFrames('window.results || null')).filter(Boolean);
    for (const r of frames) assert.deepEqual(r, { adFetch: 'blocked', okFetch: 'loaded' });
    for (const ok of ['cdn.example/ok.gif', 'cdn.example/ok.txt', 'cdn.example/frame-ok.gif', 'cdn.example/frame-ok.txt']) {
      await waitFor(() => site.hits.includes(ok), { timeout: 5000, message: `${ok} loaded (not an ad host)` });
    }
    assert.equal(await b().evaluate('window.adScript === true'), false, 'the pop-under script never ran');
    await sleep(500);
    assert.deepEqual(site.adHits(), [], 'no ad host was asked for anything');
    // The banner, the script, the ad frame and the beacon in the page; the image and the beacon in the frame.
    await waitFor(() => state('adsBlocked') >= 6, { timeout: 5000, message: `adsBlocked counted them (now ${state('adsBlocked')})` });
  });

  test("a click-jacking layer sending the page to an ad host: refused, the page stays as it was; the count starts again with each page", async () => {
    await visit(site.at('site.example', '/clickjack'), 'Clickjack');
    await waitFor(() => state('adsBlocked') === 0, { timeout: 5000, message: 'a new page counts from 0' });
    await b().evaluate(`location.href = ${JSON.stringify(site.at('go.popads.net', '/landing'))}; true`);
    await waitFor(() => state('adsBlocked') === 1, { timeout: 5000, message: `the refused page counted (now ${state('adsBlocked')})` });
    await sleep(1000);
    assert.equal(await b().evaluate('window.marker'), 1, 'the same document, not reloaded');
    assert.equal(state('title'), 'Clickjack');
    assert.match(state('url'), /\/clickjack$/);
    assert.equal(state('loading'), false);
    assert.deepEqual(site.adHits(), []);
  });

  // The tabs and windows the page has open besides itself (Edge's own first blank tab aside).
  async function openedTabs() {
    const { targetInfos } = await b().devtools().ws.send('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'page' && t.targetId !== b().devtools().targetId && t.url !== 'about:blank');
  }
  const click = async (button = 'left') => {
    const ack = await s.client.send('browser.input', { kind: 'click', x: 100, y: 50, fw: 640, fh: 400, button });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
  };

  test('a pop-up on the site: its own ad requests and those of its cross-site frame are refused, the rest loads', async () => {
    await visit(site.at('site.example', '/opener'), 'Opener');
    await click();
    await waitFor(() => state('popup') === true, { timeout: 15000, message: 'the pop-up on show' });
    for (const ok of ['cdn.example/popup-ok.gif', 'player.example/popup-frame', 'cdn.example/popup-frame-ok.gif']) {
      await waitFor(() => site.hits.includes(ok), { timeout: 10000, message: `${ok} loaded` });
    }
    await waitFor(() => state('adsBlocked') >= 2, { timeout: 5000, message: `the pop-up's and its frame's ads counted (now ${state('adsBlocked')})` });
    await sleep(500);
    assert.deepEqual(site.adHits(), []);
    const ack = await s.client.send('browser.nav', { action: 'back' });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    await waitFor(() => state('popup') === false, { timeout: 10000, message: 'Back closed the pop-up' });
  });

  test('a pop-under window opened straight to an ad host is closed before it loads; the page stays', async () => {
    await visit(site.at('site.example', '/popunder'), 'Popunder');
    await click();
    await waitFor(() => state('adsBlocked') === 1, { timeout: 10000, message: `the pop-under refused (now ${state('adsBlocked')})` });
    await waitFor(async () => (await openedTabs()).length === 0 && !b().popupShown(), { timeout: 10000, message: 'the pop-under window closed' });
    await sleep(1000);
    assert.notEqual(state('popup'), true, 'no pop-up on show');
    assert.equal(state('title'), 'Popunder', 'the page itself stays');
    assert.deepEqual(site.adHits(), []);
  });

  test('a new tab Lumen does not show (a middle-clicked link) gets the block list too', async () => {
    await visit(site.at('site.example', '/middle'), 'Middle');
    await click('middle');
    await waitFor(() => site.hits.includes('cdn.example/tab-ok.gif'), { timeout: 15000, message: 'the new tab loaded its page' });
    await sleep(500);
    assert.deepEqual(site.adHits(), []);
    assert.notEqual(state('popup'), true, 'not shown as a pop-up');
    assert.equal(state('title'), 'Middle', 'the page itself stays');
    for (const t of await openedTabs()) await b().devtools().ws.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
  });

  test('a page someone opens on an ad host is theirs to see', async () => {
    await visit(site.at('www.taboola.com', '/about'), 'about');
    assert.ok(site.hits.includes('www.taboola.com/about'));
  });

  test('the log names no ad host and no page', async () => {
    const dir = path.join(s.stack.dataDir, 'logs');
    const text = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    assert.match(text, /refused an ad page|pop-up or new tab with an ad/, 'the debug log was read');
    assert.equal(text.includes('blocked by wildcard'), false, "Edge took the list's URL patterns");
    for (const host of [...AD_HOSTS, 'site.example', 'player.example', 'cdn.example']) assert.equal(text.includes(host), false, `the log names ${host}`);
  });
});

describe('browser: adBlock false blocks nothing', { skip }, () => {
  let site, s;
  before(async () => {
    site = await startSite();
    s = await startBrowser({ adBlock: false });
  });
  after(async () => {
    try { await stopBrowser(s); } finally { site?.server.close(); }
  });

  test('the same ads reach their hosts and nothing is counted', async () => {
    const ack = await s.client.send('browser.open', { url: site.at('site.example', '/video') }, { timeout: 40000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    for (const hit of ['ads.doubleclick.net/banner.gif', 'popads.net/pop.js', 'syndication.exoclick.com/ad-frame', 'a.realsrv.com/beacon.txt',
      'tpc.googlesyndication.com/in-frame.gif', 'cdn.trafficjunky.net/frame-beacon.txt']) {
      await waitFor(() => site.hits.includes(hit), { timeout: 20000, message: `${hit} reached its host` });
    }
    assert.equal(s.stack.server.store.get('browser.adsBlocked')?.v ?? 0, 0);
  });
});
