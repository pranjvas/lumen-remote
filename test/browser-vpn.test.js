// The VPN switch end to end: "Use a config file" (POST /api/vpn/config) → vpn.set on → Lumen's
// headless Edge restarts behind the tunnel proxy → a page that exists only inside the tunnel
// (http://10.66.0.1/hello on the Go test peer) loads. Throwaway keys, loopback peer only.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startStack, request, waitFor, startTestPeer, skipWithoutTestpeer } from './helpers.js';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const skip = skipWithoutTestpeer() || (fs.existsSync(EDGE) ? false : 'Microsoft Edge not found');

describe('browser + VPN: the switch routes Lumen\'s browser through the tunnel', { skip }, () => {
  let peer, stack, b, hello;

  const upload = (text) => request({
    port: stack.httpPort, path: '/api/vpn/config', method: 'POST', body: text,
    headers: { Origin: `http://127.0.0.1:${stack.httpPort}`, 'X-Lumen-CSRF': hello.csrf, 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(text) },
  });
  const pageText = () => stack.server.features.browser.evaluate('document.body ? document.body.innerText : ""').catch(() => '');

  before(async () => {
    peer = await startTestPeer();
    stack = await startStack({ config: { browser: { edgePath: EDGE, idleMs: 120000, allowLoopback: true } } });
    b = stack.browser();
    hello = await b.hello;
    await b.send('view', { name: 'browser', visible: true });
  });
  // The peer is closed whatever happens to the stack's cleanup: left running, it keeps the test process alive.
  after(async () => {
    try {
      await stack?.stop();
    } finally {
      await peer?.close();
    }
  });

  test('a config upload is validated, saved, and reported without keys', async () => {
    const bad = await upload('this is not a WireGuard config');
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).error.code, 'INVALID');

    const forged = await request({
      port: stack.httpPort, path: '/api/vpn/config', method: 'POST', body: peer.conf,
      headers: { Origin: 'http://evil.example', 'X-Lumen-CSRF': hello.csrf, 'Content-Type': 'text/plain' },
    });
    assert.equal(forged.status, 403);

    const ok = await upload(peer.conf);
    assert.equal(ok.status, 200, ok.body);
    const body = JSON.parse(ok.body);
    assert.match(body.value.config.endpoint, /^127\.0\.0\.1:\d+$/);
    assert.equal(peer.containsKey(ok.body), false, 'no key material in the reply');
    await b.waitForState('vpn.state', (r) => r?.v === 'off', { timeout: 8000 });
    assert.equal(fs.readFileSync(`${stack.dataDir}/vpn/wg.conf`, 'utf8'), peer.conf);
  });

  test('vpn.set on → the tunnel comes up and a tunnel-only page loads in Lumen\'s browser', async () => {
    const on = await b.send('vpn.set', { on: true }, { timeout: 30000 });
    assert.equal(on.ok, true, JSON.stringify(on.error));
    await b.waitForState('vpn.state', (r) => r?.v === 'up', { timeout: 20000 });
    const opened = await b.send('browser.open', { url: 'http://10.66.0.1/hello' }, { timeout: 40000 });
    assert.equal(opened.ok, true, JSON.stringify(opened.error));
    await waitFor(async () => (await pageText()).includes('hello from wg peer'), { timeout: 20000, what: 'the tunnel-only page' });
    assert.ok(b.state['vpn.bytesIn']?.v > 0);
  });

  test('a second config keeps the first as a backup; Undo restores it', async () => {
    const other = peer.conf.replace(/PersistentKeepalive = \d+/, 'PersistentKeepalive = 15');
    assert.equal((await upload(other)).status, 200);
    await b.waitForState('vpn.hasBackup', (r) => r?.v === true, { timeout: 8000 });
    const undo = await b.send('vpn.restoreBackup', {}, { timeout: 30000 });
    assert.equal(undo.ok, true, JSON.stringify(undo.error));
    assert.equal(fs.readFileSync(`${stack.dataDir}/vpn/wg.conf`, 'utf8'), peer.conf);
  });

  test('vpn.set off → the switch is off and the browser runs without the proxy', async () => {
    const off = await b.send('vpn.set', { on: false }, { timeout: 30000 });
    assert.equal(off.ok, true, JSON.stringify(off.error));
    await b.waitForState('vpn.enabled', (r) => r?.v === false, { timeout: 8000 });
    assert.equal(b.state['vpn.proxyPort']?.v ?? null, null);
  });
});
