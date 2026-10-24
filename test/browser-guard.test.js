// Pages on this PC stay off-limits to Lumen's browser however a page asks for them: Network.
// setBlockedURLs stops subresources only, so a redirect, a location.replace, an iframe or an
// IPv4-in-IPv6 address used to reach a service bound to 127.0.0.1. With allowLoopback off, every
// document request is checked (Fetch domain) and refused. The test pages are served on this PC's LAN
// address (the browser may open those); the service that must see no request listens on 127.0.0.1.
// Real headless Edge through the hub, mock TV. Skips without a LAN IPv4 address.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startStack, waitFor, sleep } from './helpers.js';

const EDGE = process.env.LUMEN_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const lanIp = Object.values(os.networkInterfaces()).flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal && /^(192\.168|10|172\.(1[6-9]|2\d|3[01]))\./.test(i.address))
  .map((i) => i.address)[0] ?? null;
const skip = (!fs.existsSync(EDGE) && `headless Edge is not installed at ${EDGE}`) || (!lanIp && 'no LAN IPv4 address to serve the test pages on');

const taskkill = (pid) => new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
function edgePids(marker) {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }`;
  return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true },
    (err, stdout) => resolve(err ? [] : stdout.split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean))));
}

describe("browser: no page on this PC, whatever way it is asked for", { skip }, () => {
  let stack, client, marker, local, lan, localPort, lanBase;
  const localHits = [];
  const lanHits = [];
  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  // A page whose big button (at 0,0, as browser-popup.test.js clicks it) runs `onclick`.
  const opener = (title, onclick, extra = '') => page(title, `<style>html,body{margin:0}</style><button id="b" style="position:absolute;left:0;top:0;width:320px;height:200px">go</button>${extra}<script>b.onclick = () => { ${onclick} };</script>`);

  before(async () => {
    // The service on this PC that must never be reached.
    local = http.createServer((req, res) => { localHits.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('Local', 'this PC')); });
    await new Promise((r) => local.listen(0, '127.0.0.1', r));
    localPort = local.address().port;
    const here = (p) => `http://127.0.0.1:${localPort}${p}`;
    lan = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      lanHits.push(p);
      if (p === '/redirect') { res.writeHead(302, { location: here('/redirect-hit') }); return res.end(); }
      if (p === '/redirect-ok') { res.writeHead(302, { location: `${lanBase}/landed` }); return res.end(); }
      if (p === '/popup-redirect-hop') { res.writeHead(302, { location: here('/popup-redirect-hit') }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      if (p === '/replace') return res.end(page('Replace', `<script>location.replace(${JSON.stringify(here('/replace-hit'))})</script>`));
      if (p === '/v6') return res.end(page('V6', `<script>location.replace('http://[::ffff:127.0.0.1]:${localPort}/v6-hit')</script>`));
      if (p === '/frame') return res.end(page('Frame', `<iframe src="${here('/iframe-hit')}"></iframe><iframe src="${lanBase}/control-frame"></iframe>`));
      if (p === '/fetch') return res.end(page('Fetch', `<script>fetch(${JSON.stringify(here('/fetch-hit'))}).catch(() => {})</script>`));
      if (p === '/link') return res.end(page('Link', `<a id="go" href="${here('/link-hit')}">here</a>`));
      // Sized pop-ups (real windows, see PAGE_SCRIPT): straight to this PC, through a LAN redirect to
      // it, and a LAN one (control) whose page asks this PC for an image and a fetch.
      const sized = (to, name) => `window.open(${JSON.stringify(to)}, ${JSON.stringify(name)}, 'width=420,height=560')`;
      if (p === '/popup-direct') return res.end(opener('Opener', sized(here('/popup-direct-hit'), 'w1')));
      if (p === '/popup-redirect') return res.end(opener('Opener', sized(`${lanBase}/popup-redirect-hop`, 'w2')));
      if (p === '/popup-lan') return res.end(opener('Opener', sized(`${lanBase}/popup-page`, 'w3')));
      if (p === '/popup-page') {
        return res.end(page('Popup page', `<img src="${here('/popup-img-hit')}"><script>fetch(${JSON.stringify(here('/popup-fetch-hit'))}).catch(() => {})</script>`));
      }
      // A link the middle button opens in a new tab (Edge itself opens it: no opener, and it starts loading at once).
      if (p === '/middle-tab') {
        return res.end(page('Opener', `<style>html,body{margin:0}</style><a href="${here('/middle-tab-hit')}" style="position:absolute;left:0;top:0;width:320px;height:200px;display:block">link</a>`));
      }
      // A form sent to a new tab: that tab has no opener (target=_blank implies noopener).
      if (p === '/form-tab') {
        return res.end(opener('Opener', 'f.submit();', `<form id="f" method="post" target="_blank" action="${here('/form-tab-hit')}"><input name="x" value="1"></form>`));
      }
      return res.end(page(p.slice(1) || 'Home', 'LAN page'));
    });
    await new Promise((r) => lan.listen(0, lanIp, r));
    lanBase = `http://${lanIp}:${lan.address().port}`;
    stack = await startStack({ config: { browser: { edgePath: EDGE, idleMs: 120000, allowLoopback: false } } });
    marker = path.basename(stack.dataDir);
    client = stack.browser();
    await client.hello;
    await client.send('view', { name: 'browser', visible: true });
    await client.send('browser.viewport', { w: 640, h: 400 });
  });
  after(async () => {
    try {
      await stack?.server.stop();
      await sleep(500);
      for (const pid of await edgePids(marker)) await taskkill(pid);
    } finally {
      await stack?.stop().catch(() => {});
      local?.close();
      lan?.close();
    }
  });

  const state = (key) => stack.server.store.get(`browser.${key}`)?.v;
  async function visit(p) {
    const ack = await client.send('browser.open', { url: `${lanBase}${p}` }, { timeout: 40000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    await waitFor(() => lanHits.includes(p), { timeout: 15000, message: `${p} served` });
    await waitFor(() => state('loading') === false, { timeout: 15000, message: `${p} loaded` });
    await sleep(1500); // a script's navigation, a frame
  }

  test('a redirect, location.replace, an iframe, a link, a fetch and an IPv4-in-IPv6 address all stay off this PC', async () => {
    await visit('/redirect-ok'); // control: redirects on the LAN work
    await waitFor(() => lanHits.includes('/landed'), { timeout: 10000, message: 'the LAN redirect landed' });
    for (const p of ['/redirect', '/replace', '/v6', '/frame', '/fetch']) await visit(p);
    assert.ok(lanHits.includes('/control-frame'), 'the LAN iframe loaded (frames work)');
    await visit('/link');
    await stack.server.features.browser.evaluate('document.getElementById("go").click(), true');
    await sleep(1500);
    assert.deepEqual(localHits, [], 'nothing reached the service on 127.0.0.1');
  });

  // The tabs and windows the page has open besides itself (Edge's own first blank tab aside).
  const b = () => stack.server.features.browser;
  async function openedTabs() {
    const { targetInfos } = await b().devtools().ws.send('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'page' && t.targetId !== b().devtools().targetId && t.url !== 'about:blank');
  }
  // Every tab or window Edge made (Lumen's browser connection, which discovers targets).
  const created = [];
  let watching = null;
  // Opens the opener page `p` and clicks its button (a real click: pop-ups need the user's gesture);
  // waits for the tab or window that makes.
  async function clickOpener(p, button = 'left') {
    await visit(p);
    if (watching !== b().devtools().ws) {
      watching = b().devtools().ws;
      watching.on('Target.targetCreated', ({ targetInfo }) => { if (targetInfo.type === 'page') created.push(targetInfo.targetId); });
    }
    await waitFor(() => state('title') === 'Opener', { timeout: 15000, message: `${p}: the opener` });
    const n = created.length;
    const ack = await client.send('browser.input', { kind: 'click', x: 100, y: 50, fw: 640, fh: 400, button });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    await waitFor(() => created.length > n, { timeout: 10000, message: `${p}: a new tab or window` });
  }

  test('a sized pop-up opened on this PC, or redirected to it, is closed before it reaches it', async () => {
    for (const p of ['/popup-direct', '/popup-redirect']) {
      const before = localHits.length;
      await clickOpener(p);
      if (p === '/popup-redirect') await waitFor(() => lanHits.includes('/popup-redirect-hop'), { timeout: 10000, message: 'the pop-up asked the LAN first' });
      await waitFor(async () => (await openedTabs()).length === 0 && !b().popupShown(), { timeout: 10000, message: `${p}: the pop-up closed` });
      await sleep(1000);
      assert.deepEqual(localHits.slice(before), [], `${p}: nothing reached the service on 127.0.0.1`);
      assert.notEqual(state('popup'), true, `${p}: no pop-up on show`);
      assert.equal(state('title'), 'Opener', `${p}: the page itself stays`);
    }
  });

  test('a sized pop-up on the LAN still shows, and what it asks of this PC is refused', async () => {
    const before = localHits.length;
    await clickOpener('/popup-lan');
    await waitFor(() => state('popup') === true, { timeout: 15000, message: 'the pop-up on show' });
    await waitFor(() => lanHits.includes('/popup-page'), { timeout: 10000, message: 'the pop-up page served' });
    await sleep(2000);
    assert.deepEqual(localHits.slice(before), [], 'the pop-up\'s image and fetch did not reach 127.0.0.1');
    const ack = await client.send('browser.nav', { action: 'back' });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    await waitFor(() => state('popup') === false, { timeout: 10000, message: 'Back closed the pop-up' });
  });

  test('new tabs without an opener (a form sent to _blank, a middle-clicked link) do not reach this PC either, and are closed', async () => {
    for (const [p, button] of [['/form-tab', 'left'], ['/middle-tab', 'middle']]) {
      const before = localHits.length;
      await clickOpener(p, button);
      await waitFor(async () => (await openedTabs()).length === 0, { timeout: 10000, message: `${p}: the new tab closed` });
      await sleep(2000);
      assert.deepEqual(localHits.slice(before), [], `${p}: nothing reached 127.0.0.1`);
      assert.equal(state('title'), 'Opener', `${p}: the page itself stays`);
    }
  });

  test("Lumen's own tab on this PC (live video's capture page) still opens", async () => {
    const before = localHits.length;
    const target = await b().openOwnTab(`http://127.0.0.1:${localPort}/own-tab?t=secret`);
    try {
      await waitFor(() => localHits.slice(before).includes('/own-tab?t=secret'), { timeout: 15000, message: 'the own tab loaded' });
      assert.notEqual(state('popup'), true, 'not taken for a pop-up');
    } finally {
      await fetch(`http://127.0.0.1:${b().devtools().port}/json/close/${target.id}`).catch(() => {});
    }
  });
});
