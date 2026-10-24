// Browser clicks land on the element under the pointer: through the hub's browser.input (what the
// Browser view posts), with the frame size the client measured on (fw×fh, so a phone a few frames
// behind or showing the TV's scaled copy still hits), with a finger's touch adjustment, into a
// cross-origin iframe, and end to end from the real web UI in a phone-sized headless Edge with touch
// (a held tap still clicks and does not focus the hidden text field; the Keyboard button turns typing
// off again; a word still being composed reaches the page before a tap; another device's page size is
// given back on the next tap; the TV's side shows as a status chip). The page area of short and
// landscape phones keeps its size and shape. Real headless Edge, mock TV, fake TV agent for On TV.
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

// #b a button, #c a 14 px checkbox, #l a link, #f a cross-origin iframe holding a checkbox, #q a text
// box. Every click is logged in window.log (a click on #b with what #q holds then); the iframe reports
// its own clicks with postMessage.
const MAIN = (framePort) => `<!doctype html><html><head><meta charset="utf-8"><title>Clicks</title><style>
html,body{margin:0;background:#fff;font:16px sans-serif}
#b{position:absolute;left:40px;top:40px;width:160px;height:48px}
#c{position:absolute;left:60px;top:150px;width:14px;height:14px;margin:0}
#l{position:absolute;left:40px;top:210px}
#f{position:absolute;left:300px;top:120px;width:300px;height:80px;border:0}
#q{position:absolute;left:40px;top:270px;width:200px;height:32px;margin:0;font:16px sans-serif}
</style></head><body>
<button id="b">Press me</button><input id="c" type="checkbox"><a id="l" href="#linked">A link</a><input id="q" type="text">
<iframe id="f" src="http://localhost:${framePort}/frame"></iframe><div style="height:3000px"></div>
<script>
window.log = [];
addEventListener('click', (e) => log.push({ t: 'click', id: e.target.id || e.target.tagName, trusted: e.isTrusted, ...(e.target.id === 'b' ? { q: document.getElementById('q').value } : {}) }), true);
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
  const reset = () => lumen.evaluate('window.log = []; document.getElementById("c").checked = false; document.getElementById("q").value = ""; true');
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
    mainSrv?.close();
    frameSrv?.close();
    try {
      await stack?.stop();
    } catch (err) {
      // On a PC at full load Lumen's Edge can hold its profile (in the data dir) for longer than the
      // helper's ~5 s of retries after it was told to exit: the server has stopped, only the temp dir is
      // left, so it is removed a little later instead of failing the suite.
      if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
      await sleep(5000);
      try { fs.rmSync(stack.dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* a leftover temp dir is harmless */ }
    }
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

  // Every command the web UI sends over /live (but frame acks), recorded in the page as window.__sent.
  const SENT_HOOK = `(() => {
    window.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const m = typeof data === 'string' ? JSON.parse(data) : null;
        if (m && m.t === 'cmd' && m.cmd !== 'browser.ack') window.__sent.push(Object.assign({}, m, { at: performance.now() }));
      } catch (e) { /* not JSON */ }
      return send.call(this, data);
    };
  })();`;

  // The real web UI in a headless Edge of its own, on the Browser view: a phone with touch when
  // metrics.mobile. Edge is closed (and killed) afterwards whatever happens.
  async function withPhone(metrics, fn) {
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
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SENT_HOOK });
      await cdp.send('Emulation.setDeviceMetricsOverride', metrics);
      if (metrics.mobile) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await cdp.send('Page.navigate', { url: stack.url('/#/browser') });
      await waitFor(() => ui(`document.documentElement.dataset.ready === '1'`), { timeout: 15000, interval: 100, message: 'the UI connected' });
      await fn({ cdp, ui });
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
  }

  // Taps and checks on the phone's UI.
  const KEYBOARD = '.browser-tools [aria-label="Keyboard"]';
  function phoneKit(cdp, ui) {
    const box = (selector) => ui(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    // A finger down at (x, y) for holdMs. Explicit timestamps: the hold the page sees is the finger's,
    // not how long a busy machine took.
    const touchAt = async (x, y, holdMs = 80) => {
      const t0 = Date.now() / 1000;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }], timestamp: t0 });
      await sleep(holdMs);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: t0 + holdMs / 1000 });
    };
    const tapUi = async (selector) => { const b = await box(selector); await touchAt(b.x + b.w / 2, b.y + b.h / 2); };
    // A tap on the page's element #id where the phone shows it; the page's log is cleared first unless keep.
    const tapOn = async (id, holdMs, { keep = false } = {}) => {
      if (!keep) await reset();
      const r = await rect(id);
      const c = await box('.browser-canvas');
      await touchAt(c.x + (r.x / r.vw) * c.w, c.y + (r.y / r.vh) * c.h, holdMs);
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
    // Where keys go: the Keyboard toggle, the hidden text field's focus and the stage's typing cue.
    const typing = () => ui(`({ pressed: document.querySelector(${JSON.stringify(KEYBOARD)}).getAttribute('aria-pressed'),
      focused: !!document.activeElement && document.activeElement.classList.contains('browser-typer'),
      cue: document.querySelector('.browser-stage').classList.contains('is-typing') })`);
    const sentCmds = (cmd) => ui(`window.__sent.filter((m) => m.cmd === ${JSON.stringify(cmd)})`);
    return { box, touchAt, tapUi, tapOn, framePainted, settled, typing, sentCmds };
  }

  test('the real Browser view on a phone (touch): a held tap clicks, TV on and off, and does not focus the text field', async () => {
    await withPhone({ width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, async ({ cdp, ui }) => {
      const { tapUi, tapOn, framePainted, settled, typing, sentCmds } = phoneKit(cdp, ui);
      const store = stack.server.store;
      const put = (key, v) => store.set(key, v, { src: 'derived', via: 'test' });
      const chip = () => ui(`(() => { const c = document.querySelector('.browser-chip'); if (c.hidden) return null; const a = c.querySelector('.browser-chip-action');
        return { text: c.querySelector('.browser-chip-long').textContent, action: a.hidden ? null : a.textContent }; })()`);
      const chipShows = async (want, message, timeout = 4000) => {
        let seen;
        try {
          await waitFor(async () => { seen = await chip(); return JSON.stringify(seen) === JSON.stringify(want); }, { timeout, interval: 100, message });
        } catch (err) {
          err.message += `; the chip showed ${JSON.stringify(seen)}`;
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

      // The address field asks for a keyboard with a space bar (the iPhone's URL keyboard has none).
      assert.equal(await ui(`document.querySelector('.browser-address').inputMode`), 'search');

      // Keyboard on, then off: the press does not blur the field first (Chromium focuses a pressed
      // button, and the click then turned the keyboard straight back on).
      await tapUi(KEYBOARD);
      await waitFor(async () => (await typing()).focused, { timeout: 3000, message: 'the keyboard on' });
      assert.deepEqual(await typing(), { pressed: 'true', focused: true, cue: true });
      await tapUi(KEYBOARD);
      await waitFor(async () => (await typing()).pressed === 'false', { timeout: 3000, message: 'the keyboard off' });
      await sleep(200);
      assert.deepEqual(await typing(), { pressed: 'false', focused: false, cue: false }, 'a second press turns typing off');
      await tapOn('b', 80);
      await sleep(200);
      assert.equal((await typing()).focused, false, 'a tap on the page does not turn typing back on');

      // A word still being composed (Android keyboards keep it in a composition) reaches the page
      // before a tap does: the search box holds it when the button is clicked.
      await tapOn('q', 80); // the page's text box takes focus
      await tapUi(KEYBOARD);
      await waitFor(async () => (await typing()).focused, { timeout: 3000, message: 'the keyboard on' });
      const from = sent.length;
      await cdp.send('Input.imeSetComposition', { text: 'weather', selectionStart: 7, selectionEnd: 7 });
      await sleep(200);
      assert.equal(await ui(`document.querySelector('.browser-typer').value`), 'weather', 'the word is being composed');
      assert.equal(sent.slice(from).filter((e) => e.kind === 'text').length, 0, 'nothing is sent while composing');
      await tapOn('b', 80, { keep: true });
      const click = (await log()).find((e) => e.t === 'click' && e.id === 'b');
      assert.equal(click.q, 'weather', `the word was in the box when the button was clicked; sent ${JSON.stringify(sent.slice(from))}`);
      const after = sent.slice(from);
      const textAt = after.findIndex((e) => e.kind === 'text' && e.text === 'weather');
      const clickAt = after.findIndex((e) => e.kind === 'click');
      assert.ok(textAt >= 0 && textAt < clickAt, `the word went before the click: ${JSON.stringify(after)}`);
      assert.equal(after.filter((e) => e.kind === 'text').length, 1, 'the word is sent once');
      assert.deepEqual(await typing(), { pressed: 'true', focused: true, cue: true }, 'the field keeps focus, so the keyboard stays');
      await tapUi(KEYBOARD); // typing off before the TV part
      await waitFor(async () => !(await typing()).focused, { timeout: 3000, message: 'the keyboard off' });

      // Another device asked for its own page size: once the phone is used again (a tap), it asks
      // for its own size again; until then a chip offers to fit.
      const mine = await lumen.evaluate('innerWidth + "x" + innerHeight');
      okAck(await viewer.send('browser.viewport', { w: 1000, h: 700 }));
      await waitFor(async () => (await lumen.evaluate('innerWidth')) === 1000, { timeout: 10000, message: 'the other device’s viewport' });
      await lumen.evaluate('document.body.style.background = "#fdfdfd"; true'); // a repaint, so a frame at the new size goes out
      await settled();
      await chipShows({ text: 'Sized for another device', action: 'Tap to fit' }, 'the size hint', 8000);
      const asked = (await sentCmds('browser.viewport')).length;
      await tapOn('b', 80); // lands on the other device's layout, then the phone asks for its own
      await waitFor(async () => (await sentCmds('browser.viewport')).length > asked, { timeout: 5000, message: 'the phone asked for its size again' });
      await waitFor(async () => (await lumen.evaluate('innerWidth + "x" + innerHeight')) === mine, { timeout: 10000, message: `the page back at the phone's ${mine}` });
      await lumen.evaluate('document.body.style.background = "#fff"; true');
      await settled();
      await chipShows(null, 'no hint once the page fits the phone again');

      // TV on: the phone shows the TV's 1280×720 page scaled down to its stage.
      okAck(await viewer.send('browser.openOnTv', {}, { timeout: 40000 }));
      await viewer.waitForState('tvscreen.on', (r) => r?.v === true, { timeout: 5000 });
      await waitFor(async () => (await lumen.evaluate('innerWidth')) === 1280, { timeout: 10000, message: 'the TV viewport' });
      await lumen.evaluate('document.body.style.background = "#fefefe"; true'); // a repaint, so a frame at the new size goes out
      await settled();
      await tapOn('b', 80);
      await tapOn('c', 120);
      await tapOn('l', 450);

      // The status chip says what the TV is really doing, with the one action that helps. The TV's
      // side is played here through the server's store (keys from features/tvscreen.js).
      const actionSends = async (cmd, args) => {
        const before = (await sentCmds(cmd)).length;
        await tapUi('.browser-chip-action');
        const got = await waitFor(async () => (await sentCmds(cmd)).slice(before)[0], { timeout: 3000, message: `${cmd} sent` });
        for (const [k, v] of Object.entries(args)) assert.equal(got[k], v, `${cmd} ${k}`);
      };
      try {
        await chipShows(null, 'no chip while all is well');
        put('tvscreen.liveBlocked', true);
        await chipShows({ text: 'Still frames (live video off after 2 drops)', action: 'Turn live on' }, 'live video off');
        await actionSends('tvscreen.live', { on: true });
        put('tvscreen.liveBlocked', false);
        // While ffmpeg runs the server says converting (and the video 'fallback').
        put('tvscreen.handoff', { stage: 'copy', converting: true });
        put('tvscreen.video', 'fallback');
        await chipShows({ text: 'Converting for the TV…', action: null }, 'a conversion');
        // Then the converted copy goes to the TV: the video stays 'loading' while the TV plays it (the
        // agent sends no 'playing' for that path), so the chip must not still say it is converting.
        put('tvscreen.handoff', { stage: 'copy', converting: false });
        put('tvscreen.video', 'loading');
        await chipShows(null, 'the converted copy sent to the TV');
        put('tvscreen.handoff', { stage: 'direct', converting: false });
        put('tvscreen.video', 'playing');
        await chipShows({ text: 'Black picture?', action: 'Convert for TV' }, 'the TV playing the page’s own stream');
        put('tvscreen.video', 'error');
        await chipShows({ text: 'The TV could not play the video', action: 'Convert for TV' }, 'the TV player failed');
        await actionSends('tvscreen.playVideo', { convert: true });
        put('tvscreen.video', null);
        put('tvscreen.handoff', null);
        await chipShows(null, 'the video gone');
        // A TV-side notice toasts once, on any screen.
        put('tvscreen.notice', { text: 'Test notice from the TV', level: 'warn', at: Date.now() });
        await waitFor(() => ui(`[...document.querySelectorAll('#toasts .toast')].some((t) => t.textContent.includes('Test notice from the TV'))`), { timeout: 3000, message: 'the notice toast' });
        // The TV killed the agent: On TV stays pressed, so the chip offers to reopen.
        put('conn.agent', 'offline');
        await chipShows({ text: 'TV agent closed', action: 'Reopen on TV' }, 'the agent closed');
        put('conn.agent', 'online');
        await chipShows(null, 'the agent back');
      } finally {
        for (const key of ['tvscreen.liveBlocked', 'tvscreen.handoff', 'tvscreen.video']) put(key, null);
        put('conn.agent', 'online');
        await viewer.send('tvscreen.close', {}); // the fake agent may already be gone on a slow run
      }
    });
  });

  test('short and landscape phones: the page area keeps its size and shape and asks for one viewport; the Keyboard button toggles with a mouse', async () => {
    await withPhone({ width: 844, height: 390, deviceScaleFactor: 3, mobile: true }, async ({ cdp, ui }) => {
      const { framePainted, typing } = phoneKit(cdp, ui);
      await framePainted();
      const measure = () => ui(`(() => { const s = document.querySelector('.browser-stage'); const c = document.querySelector('.browser-canvas').getBoundingClientRect();
        return { stage: Math.round(s.getBoundingClientRect().height * 10) / 10, sw: s.clientWidth, sh: s.clientHeight, w: c.width, h: c.height,
          viewports: window.__sent.filter((m) => m.cmd === 'browser.viewport').length }; })()`);
      const fits = (m) => m.w <= m.sw + 0.5 && m.h <= m.sh + 0.5;
      for (const [width, height, mobile, landscape] of [[844, 390, true, true], [375, 548, true, false], [390, 844, true, false], [1440, 900, false, false]]) {
        const size = `${width}×${height}`;
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
        await sleep(2000);
        // The frame of the new layout is on screen, inside the stage (in landscape it fills most of its width).
        let seen = null;
        try {
          await waitFor(async () => { seen = await measure(); return fits(seen) && (!landscape || seen.w >= 0.8 * seen.sw); }, { timeout: 15000, interval: 100, message: `${size}: the frame fitted` });
        } catch (err) {
          err.message += ` ${JSON.stringify(seen)}`;
          throw err;
        }
        const samples = [await measure()];
        for (let i = 0; i < 10; i++) { await sleep(200); samples.push(await measure()); }
        const [first, last] = [samples[0], samples.at(-1)];
        assert.ok(samples.every((m) => Math.abs(m.stage - first.stage) < 0.5), `${size}: the stage keeps its height ${JSON.stringify(samples.map((m) => m.stage))}`);
        assert.ok(last.viewports - first.viewports <= 1, `${size}: at most one browser.viewport in 2 s (${last.viewports - first.viewports})`);
        assert.ok(samples.every(fits), `${size}: the canvas fits inside the stage ${JSON.stringify(last)}`);
        if (landscape) assert.ok(samples.every((m) => m.w >= 0.8 * m.sw), `${size}: the frame fills at least 80% of the stage's width ${JSON.stringify(last)}`);
      }

      // With a mouse (an 800 px desktop window): the Keyboard button turns typing on, and off again.
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(500);
      const click = async (selector) => {
        const b = await ui(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
      };
      await click(KEYBOARD);
      await waitFor(async () => (await typing()).focused, { timeout: 3000, message: 'typing on with the mouse' });
      assert.deepEqual(await typing(), { pressed: 'true', focused: true, cue: true });
      // AltGr (Windows reports it as Ctrl+Alt): AltGr+Q on a German keyboard types '@' into the page,
      // not a Ctrl shortcut the server refuses.
      const from = sent.length;
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 3, key: '@', code: 'KeyQ', text: '@', unmodifiedText: 'q', windowsVirtualKeyCode: 81 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 3, key: '@', code: 'KeyQ', windowsVirtualKeyCode: 81 });
      await waitFor(() => sent.slice(from).some((e) => e.kind === 'text' && e.text === '@'), { timeout: 3000, message: `'@' typed; sent ${JSON.stringify(sent.slice(from))}` });
      assert.deepEqual(sent.slice(from).filter((e) => e.kind === 'key'), [], 'no Ctrl+Alt shortcut');
      await click(KEYBOARD);
      await waitFor(async () => (await typing()).pressed === 'false', { timeout: 3000, message: 'typing off with the mouse' });
      await sleep(200);
      assert.deepEqual(await typing(), { pressed: 'false', focused: false, cue: false }, 'keys no longer go to the page');
    });
  });
});
