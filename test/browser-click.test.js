// Browser clicks land on the element under the pointer: through the hub's browser.input (what the
// Browser view posts), with the frame size the client measured on (fw×fh, so a phone a few frames
// behind or showing the TV's scaled copy still hits), with a finger's touch adjustment, into a
// cross-origin iframe, and end to end from the real web UI in a phone-sized headless Edge with touch
// (a held tap still clicks and does not focus the hidden text field). Real headless Edge, mock TV,
// fake TV agent for the On TV case.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startStack, waitFor, sleep, AGENT_SNAPSHOT } from './helpers.js';

const EDGE = process.env.LUMEN_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const skip = !fs.existsSync(EDGE) && `headless Edge is not installed at ${EDGE}`;

// #b a button, #c a 14 px checkbox, #l a link, #f a cross-origin iframe holding a checkbox. Every
// click is logged in window.log; the iframe reports its own clicks with postMessage.
const MAIN = (framePort) => `<!doctype html><html><head><meta charset="utf-8"><title>Clicks</title><style>
html,body{margin:0;background:#fff;font:16px sans-serif}
#b{position:absolute;left:40px;top:40px;width:160px;height:48px}
#c{position:absolute;left:60px;top:150px;width:14px;height:14px;margin:0}
#l{position:absolute;left:40px;top:210px}
#f{position:absolute;left:300px;top:120px;width:300px;height:80px;border:0}
</style></head><body>
<button id="b">Press me</button><input id="c" type="checkbox"><a id="l" href="#linked">A link</a>
<iframe id="f" src="http://localhost:${framePort}/frame"></iframe><div style="height:3000px"></div>
<script>
window.log = [];
addEventListener('click', (e) => log.push({ t: 'click', id: e.target.id || e.target.tagName, trusted: e.isTrusted }), true);
addEventListener('contextmenu', (e) => { log.push({ t: 'context', id: e.target.id || e.target.tagName }); e.preventDefault(); }, true);
addEventListener('message', (e) => { if (e.data && e.data.frameClick) log.push({ t: 'frame', id: e.data.frameClick, checked: e.data.checked, trusted: e.data.trusted }); });
</script></body></html>`;
const FRAME = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#eef;font:16px sans-serif} #fc{position:absolute;left:20px;top:28px;width:24px;height:24px;margin:0}
</style></head><body><input id="fc" type="checkbox"><script>
document.getElementById('fc').addEventListener('click', (e) => parent.postMessage({ frameClick: 'fc', checked: e.target.checked, trusted: e.isTrusted }, '*'));
</script></body></html>`;

function serve(body) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(typeof body === 'function' ? body(req) : body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let next = 1;
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) { const id = next++; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => pending.set(id, { res, rej, method })); },
      close() { ws.close(); },
    }));
    ws.addEventListener('error', () => reject(new Error(`CDP connection to ${url} failed`)));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (!msg.id || !pending.has(msg.id)) return;
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`)); else p.res(msg.result);
    });
  });
}

describe('browser clicks land on the element under the pointer', { skip }, () => {
  let stack, viewer, agent, mainSrv, frameSrv, lumen, pageUrl, keepAlive;

  const okAck = (ack) => assert.equal(ack.ok, true, JSON.stringify(ack.error));
  // Centre of an element in viewport CSS px, plus the viewport size.
  const rect = (id) => lumen.evaluate(`(() => { const r = document.getElementById('${id}').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, right: r.right, top: r.top, vw: innerWidth, vh: innerHeight }; })()`);
  const reset = () => lumen.evaluate('window.log = []; document.getElementById("c").checked = false; true');
  const log = () => lumen.evaluate('window.log');
  // Viewport CSS px → the pixels of a frame of size fw×fh (what the Browser view measures on).
  const inFrame = (p, r, fw, fh) => ({ x: Math.round((p.x / r.vw) * fw), y: Math.round((p.y / r.vh) * fh), fw, fh });
  const sent = []; // what reached features.browser.input, for failure messages
  const clicked = async (id) => {
    try {
      await waitFor(async () => (await log()).some((e) => e.t === 'click' && e.id === id), { timeout: 8000, message: `a click on #${id}` });
    } catch (err) {
      err.message += `; sent ${JSON.stringify(sent.slice(-3))}; page saw ${JSON.stringify(await log().catch(() => null))}; target ${JSON.stringify(await rect(id))}`;
      throw err;
    }
  };

  before(async () => {
    frameSrv = await serve(FRAME);
    mainSrv = await serve(() => MAIN(frameSrv.address().port));
    pageUrl = `http://127.0.0.1:${mainSrv.address().port}/`;
    stack = await startStack({ config: { browser: { edgePath: EDGE, idleMs: 120000, allowLoopback: true } } });
    viewer = stack.browser();
    await viewer.hello;
    agent = stack.agent();
    // The agent adapter drops an agent silent for 15 s; this suite can take longer than that on a busy PC.
    keepAlive = setInterval(() => { try { agent.sendState(AGENT_SNAPSHOT); } catch { /* reconnecting */ } }, 5000);
    await viewer.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
    lumen = stack.server.features.browser;
    const input = lumen.input;
    lumen.input = (ev) => { sent.push(ev); return input(ev); };
    okAck(await viewer.send('browser.viewport', { w: 640, h: 400 }));
    okAck(await viewer.send('browser.open', { url: pageUrl }, { timeout: 40000 }));
    await waitFor(async () => (await lumen.evaluate('document.readyState')) === 'complete', { timeout: 15000, message: 'the page loaded' });
  });
  after(async () => {
    clearInterval(keepAlive);
    await stack?.stop();
    mainSrv?.close();
    frameSrv?.close();
  });

  test('a click at frame coordinates clicks the button, the checkbox and the link', async () => {
    for (const id of ['b', 'c', 'l']) {
      await reset();
      const r = await rect(id);
      const size = lumen.frameSize();
      okAck(await viewer.send('browser.input', { kind: 'click', ...inFrame(r, r, size.w, size.h), button: 'left' }));
      await clicked(id);
    }
    assert.equal(await lumen.evaluate('document.getElementById("c").checked'), false, 'reset after the last checkbox click');
  });

  test('a mouse click beside a small checkbox misses it; a finger tap there (touch radius) checks it', async () => {
    await reset();
    const r = await rect('c');
    const beside = { x: r.right + 6, y: r.y, vw: r.vw, vh: r.vh };
    const size = lumen.frameSize();
    okAck(await viewer.send('browser.input', { kind: 'click', ...inFrame(beside, r, size.w, size.h), button: 'left' }));
    await sleep(300);
    assert.equal(await lumen.evaluate('document.getElementById("c").checked'), false, 'the mouse is exact');
    okAck(await viewer.send('browser.input', { kind: 'click', ...inFrame(beside, r, size.w, size.h), button: 'left', touch: 12 }));
    await clicked('c');
    assert.equal(await lumen.evaluate('document.getElementById("c").checked'), true);
    // A tap far from anything clickable stays where it is (no snapping across the page).
    await reset();
    okAck(await viewer.send('browser.input', { kind: 'click', ...inFrame({ x: 250, y: 330, vw: r.vw, vh: r.vh }, r, size.w, size.h), button: 'left', touch: 12 }));
    await sleep(300);
    const got = (await log()).map((e) => e.id);
    assert.equal(got.length, 1, 'one click');
    assert.ok(!['b', 'c', 'l'].includes(got[0]), `the click went to the empty page, not ${got[0]}`);
  });

  test('a click reaches a checkbox inside a cross-origin iframe', async () => {
    await reset();
    const f = await rect('f');
    const target = { x: f.left + 20 + 12, y: f.top + 28 + 12, vw: f.vw, vh: f.vh };
    const size = lumen.frameSize();
    okAck(await viewer.send('browser.input', { kind: 'click', ...inFrame(target, f, size.w, size.h), button: 'left' }));
    const got = await waitFor(async () => (await log()).find((e) => e.t === 'frame'), { timeout: 3000, message: 'the iframe reported its click' });
    assert.deepEqual(got, { t: 'frame', id: 'fc', checked: true, trusted: true });
  });

  test('TV on (1280×720 viewport): clicks measured on a scaled copy of the frame still hit', async () => {
    okAck(await viewer.send('browser.openOnTv', {}, { timeout: 40000 }));
    await viewer.waitForState('tvscreen.on', (r) => r?.v === true, { timeout: 5000 });
    await waitFor(async () => (await lumen.evaluate('innerWidth + "x" + innerHeight')) === '1280x720', { timeout: 5000, message: 'the TV viewport' });
    try {
      for (const id of ['b', 'c', 'l']) {
        await reset();
        const r = await rect(id);
        // The phone shows (and measures on) a smaller copy than the frames the server last sent.
        okAck(await viewer.send('browser.input', { kind: 'click', ...inFrame(r, r, 640, 360), button: 'left' }));
        await clicked(id);
      }
      // The same with the newest frame's size taken from the server (no fw/fh: older clients).
      await reset();
      const r = await rect('b');
      const size = lumen.frameSize();
      okAck(await viewer.send('browser.input', { kind: 'click', x: Math.round((r.x / r.vw) * size.w), y: Math.round((r.y / r.vh) * size.h), button: 'left' }));
      await clicked('b');
    } finally {
      await viewer.send('tvscreen.close', {}); // the fake agent may already be gone on a slow run
    }
  });

  test('the real Browser view on a phone (touch): a held tap clicks, TV on and off, and does not focus the text field', async () => {
    const port = await freePort();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-click-ui-'));
    const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run',
      '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--mute-audio', 'about:blank'], { stdio: 'ignore', windowsHide: true });
    let browserWs = null;
    let cdp = null;
    try {
      browserWs = (await waitFor(() => fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok && r.json()), { timeout: 20000, interval: 150, message: 'the phone Edge' })).webSocketDebuggerUrl;
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      cdp = await connectCdp(target.webSocketDebuggerUrl);
      const ui = async (expression) => (await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
      await cdp.send('Page.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await cdp.send('Page.navigate', { url: stack.url('/#/browser') });
      await waitFor(() => ui(`document.documentElement.dataset.ready === '1'`), { timeout: 15000, interval: 100, message: 'the UI connected' });

      const tapOn = async (id, holdMs) => {
        await reset();
        const r = await rect(id);
        const box = await ui(`(() => { const r = document.querySelector('.browser-canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
        const x = box.x + (r.x / r.vw) * box.w;
        const y = box.y + (r.y / r.vh) * box.h;
        // Explicit timestamps: the hold the page sees is the finger's, not how long a busy machine took.
        const t0 = Date.now() / 1000;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }], timestamp: t0 });
        await sleep(holdMs);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: t0 + holdMs / 1000 });
        await clicked(id);
      };
      const framePainted = () => waitFor(() => ui(`document.querySelector('.browser-meta').textContent !== ''`), { timeout: 15000, interval: 100, message: 'a frame on the phone' });
      // The phone shows a frame of the page's current layout (same aspect as the viewport, the size
      // the server sent last) and has fitted the canvas to it.
      const settled = async () => {
        let seen = null;
        try {
          await waitFor(async () => {
            const [vw, vh] = (await lumen.evaluate('[innerWidth, innerHeight]'));
            const size = lumen.frameSize();
            const c = await ui(`(() => { const c = document.querySelector('.browser-canvas'); const r = c.getBoundingClientRect(); return { w: c.width, h: c.height, cw: r.width, ch: r.height }; })()`);
            seen = { vw, vh, size, c };
            return c.w === size.w && c.h === size.h && Math.abs(c.w / c.h - vw / vh) < 0.02 && Math.abs(c.cw / c.ch - c.w / c.h) < 0.02;
          }, { timeout: 15000, interval: 100, message: 'the phone showing the current layout' });
        } catch (err) {
          err.message += ` ${JSON.stringify(seen)}`;
          throw err;
        }
      };

      // TV off: the page is laid out at the phone's stage size.
      await framePainted();
      await waitFor(async () => (await lumen.evaluate('innerWidth')) < 640, { timeout: 10000, message: 'the phone viewport' });
      await settled();
      await tapOn('b', 80);
      await tapOn('c', 450); // a careful press: longer than a quick tap, shorter than the long press
      await tapOn('l', 80);
      // A long press (past 650 ms) is a right-click on the element, not a click.
      {
        await reset();
        const r = await rect('b');
        const c = await ui(`(() => { const r = document.querySelector('.browser-canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x + (r.x / r.vw) * c.w, y: c.y + (r.y / r.vh) * c.h }] });
        await sleep(900);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await waitFor(async () => (await log()).some((e) => e.t === 'context' && e.id === 'b'), { timeout: 3000, message: 'a right-click on #b' });
        assert.equal((await log()).filter((e) => e.t === 'click' && e.id === 'b').length, 0, 'a long press is not a left click');
      }
      // A swipe up scrolls the page (and is not a click).
      await reset();
      const box = await ui(`(() => { const r = document.querySelector('.browser-canvas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.75 }; })()`);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
      for (let i = 1; i <= 8; i++) {
        await sleep(16);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x, y: box.y - i * 20 }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await waitFor(async () => (await lumen.evaluate('scrollY')) > 60, { timeout: 5000, message: 'the swipe scrolled the page' });
      assert.deepEqual((await log()).filter((e) => e.t === 'click'), [], 'a swipe is not a click');
      await lumen.evaluate('scrollTo(0, 0); true');
      await sleep(300);
      assert.notEqual(await ui('document.activeElement && document.activeElement.className'), 'browser-typer', 'a tap does not focus the hidden text field (the iPhone keyboard)');
      assert.equal(await ui(`document.querySelector('.browser-stage').classList.contains('is-typing')`), false);

      // TV on: the phone shows the TV's 1280×720 page scaled down to its stage.
      okAck(await viewer.send('browser.openOnTv', {}, { timeout: 40000 }));
      await viewer.waitForState('tvscreen.on', (r) => r?.v === true, { timeout: 5000 });
      await waitFor(async () => (await lumen.evaluate('innerWidth')) === 1280, { timeout: 10000, message: 'the TV viewport' });
      await lumen.evaluate('document.body.style.background = "#fefefe"; true'); // a repaint, so a frame at the new size goes out
      await settled();
      await tapOn('b', 80);
      await tapOn('c', 120);
      await tapOn('l', 450);
      await viewer.send('tvscreen.close', {}); // the fake agent may already be gone on a slow run
    } finally {
      if (browserWs) {
        try { const b = await connectCdp(browserWs); await Promise.race([b.send('Browser.close'), sleep(2000)]); b.close(); } catch { /* gone */ }
      }
      cdp?.close();
      await sleep(300);
      if (edge.exitCode === null) await new Promise((r) => execFile('taskkill', ['/PID', String(edge.pid), '/T', '/F'], () => r()));
      // Edge's helper processes can hold the profile a moment longer; a leftover temp dir is harmless.
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* best effort */ }
    }
  });
});
