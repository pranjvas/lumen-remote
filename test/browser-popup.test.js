// Sign-in pop-ups: a page that opens a sized window (as "Sign in with Google" does) gets a real
// pop-up, which Lumen shows and sends input to while it is open; the pop-up can talk to its opener,
// and closing it (by itself, or with Back) returns to the page. Plain window.open still opens in the
// same tab. Real headless Edge, mock TV.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { startStack, waitFor } from './helpers.js';

const EDGE = process.env.LUMEN_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const skip = !fs.existsSync(EDGE) && `headless Edge is not installed at ${EDGE}`;

const MAIN = `<!doctype html><html><head><meta charset="utf-8"><title>Shop</title><style>
html,body{margin:0;font:16px sans-serif} #s{position:absolute;left:0;top:0;width:320px;height:200px}
</style></head><body><button id="s">Sign in</button><script>
document.getElementById('s').addEventListener('click', () => { window.open('/signin', 'signin', 'width=420,height=560'); });
addEventListener('message', (e) => { if (e.data === 'signed-in') document.title = 'Signed in'; });
</script></body></html>`;
const SIGNIN = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title><style>
html,body{margin:0;font:16px sans-serif} #ok{position:absolute;left:0;top:0;width:320px;height:200px}
</style></head><body><button id="ok">Continue</button><script>
document.getElementById('ok').addEventListener('click', () => { opener.postMessage('signed-in', '*'); window.close(); });
</script></body></html>`;

describe('browser: sign-in pop-ups', { skip }, () => {
  let stack, viewer, server, base;
  const okAck = (ack) => assert.equal(ack.ok, true, JSON.stringify(ack.error));
  const state = (key) => stack.server.store.get(`browser.${key}`)?.v;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(req.url.startsWith('/signin') ? SIGNIN : MAIN);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    stack = await startStack({ config: { browser: { edgePath: EDGE, idleMs: 120000, allowLoopback: true } } });
    viewer = stack.browser();
    await viewer.hello;
    okAck(await viewer.send('browser.viewport', { w: 640, h: 400 }));
  });
  // As browser.test.js: Edge's helper processes can hold the profile a moment after Edge closed, and a
  // failed data-dir cleanup must not leave the page server open (the test process would never exit).
  after(async () => {
    try {
      await stack?.server.stop();
      await new Promise((r) => setTimeout(r, 500));
      await stack?.stop().catch(() => {});
    } finally {
      server?.close();
    }
  });

  const openShop = async () => {
    okAck(await viewer.send('browser.open', { url: `${base}/` }, { timeout: 40000 }));
    await waitFor(() => state('title') === 'Shop', { timeout: 15000, message: 'the shop page' });
  };
  // Clicks at (100, 50) viewport px: inside both pages' big buttons, whatever the frame size.
  const clickButton = async () => okAck(await viewer.send('browser.input', { kind: 'click', x: 100, y: 50, fw: 640, fh: 400, button: 'left' }));

  test('the pop-up is shown, takes the click, talks to its opener and closes back to the page', async () => {
    await openShop();
    await clickButton();
    await waitFor(() => state('popup') === true, { timeout: 15000, message: 'the pop-up on show' });
    await waitFor(() => /\/signin$/.test(state('url') ?? ''), { timeout: 5000, message: `the pop-up's address (now ${state('url')})` });
    await clickButton(); // "Continue" in the pop-up
    await waitFor(() => state('popup') === false, { timeout: 15000, message: 'back to the page' });
    // The message event can reach the opener a moment after the pop-up is gone.
    await waitFor(async () => (await stack.server.features.browser.evaluate('document.title')) === 'Signed in', {
      timeout: 3000, message: 'the opener got the pop-up\'s message',
    });
  });

  test('Back while a pop-up is on show closes it', async () => {
    await openShop();
    await clickButton();
    await waitFor(() => state('popup') === true, { timeout: 15000, message: 'the pop-up on show' });
    okAck(await viewer.send('browser.nav', { action: 'back' }));
    await waitFor(() => state('popup') === false, { timeout: 10000, message: 'the pop-up closed' });
    assert.equal(await stack.server.features.browser.evaluate('document.title'), 'Shop');
  });

  test('a plain window.open (no size) still opens in the same tab', async () => {
    await openShop();
    await stack.server.features.browser.evaluate(`window.open('${base}/signin'); true`);
    await waitFor(() => state('title') === 'Sign in', { timeout: 15000, message: 'the same tab navigated' });
    assert.notEqual(state('popup'), true);
  });
});
