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
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      if (p === '/replace') return res.end(page('Replace', `<script>location.replace(${JSON.stringify(here('/replace-hit'))})</script>`));
      if (p === '/v6') return res.end(page('V6', `<script>location.replace('http://[::ffff:127.0.0.1]:${localPort}/v6-hit')</script>`));
      if (p === '/frame') return res.end(page('Frame', `<iframe src="${here('/iframe-hit')}"></iframe><iframe src="${lanBase}/control-frame"></iframe>`));
      if (p === '/fetch') return res.end(page('Fetch', `<script>fetch(${JSON.stringify(here('/fetch-hit'))}).catch(() => {})</script>`));
      if (p === '/link') return res.end(page('Link', `<a id="go" href="${here('/link-hit')}">here</a>`));
      return res.end(page(p.slice(1) || 'Home', 'LAN page'));
    });
    await new Promise((r) => lan.listen(0, lanIp, r));
    lanBase = `http://${lanIp}:${lan.address().port}`;
    stack = await startStack({ config: { browser: { edgePath: EDGE, idleMs: 120000, allowLoopback: false } } });
    marker = path.basename(stack.dataDir);
    client = stack.browser();
    await client.hello;
    await client.send('view', { name: 'browser', visible: true });
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
});
