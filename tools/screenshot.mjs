#!/usr/bin/env node
// Screenshots every Lumen view with headless Microsoft Edge over the Chrome DevTools Protocol
// (Node's built-in WebSocket), at phone and desktop sizes, and reports console errors per view.
//
//   node tools/screenshot.mjs [--base http://127.0.0.1:8799] [--out docs/screenshots]
//        [--views remote,apps,...] [--sizes 390x844,1440x900] [--theme nocturne|gallery|both]
//        [--pages 3] [--extras] [--motion] [--edge <path to msedge.exe>]
//
// Targets: tools/dev-ui.mjs (fake /live, default port 8799) or tools/dev-stack.mjs (the real server on
// the mock TV, port 8798: --base http://127.0.0.1:8798).
// --extras adds interaction shots against tools/dev-ui.mjs (volume sheet, an Ask run, a cast, the TV keyboard).
// Exit code 1 when any console error, exception or failed request was seen.

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const BASE = (args.base ?? 'http://127.0.0.1:8799').replace(/\/$/, '');
const OUT = path.resolve(ROOT, args.out ?? 'docs/screenshots');
const VIEWS = (args.views ?? 'remote,apps,settings,keys,touch,cast,scenes,ask').split(',').map((v) => v.trim()).filter(Boolean);
const SIZES = (args.sizes ?? '390x844,1440x900').split(',').map((s) => s.split('x').map(Number));
const THEMES = args.theme === 'both' ? ['nocturne', 'gallery'] : [args.theme ?? 'nocturne'];
const PAGES = Number(args.pages ?? 3);
const EDGE = args.edge ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(list[i]);
    if (!m) continue;
    out[m[1]] = m[2] ?? (list[i + 1] && !list[i + 1].startsWith('--') ? list[++i] : 'true');
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, { timeout = 15000, every = 150, what = 'condition' } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* not yet */ }
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(every);
  }
}

/* ---------- minimal CDP client ---------- */

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const handlers = new Map();
    let next = 1;
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const id = next++;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => pending.set(id, { res, rej, method }));
      },
      on(method, fn) { handlers.set(method, [...(handlers.get(method) || []), fn]); },
      close() { ws.close(); },
    }));
    ws.addEventListener('error', () => reject(new Error(`CDP connection to ${url} failed`)));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`));
        else p.res(msg.result);
      } else if (msg.method) {
        for (const fn of handlers.get(msg.method) || []) fn(msg.params);
      }
    });
  });
}

/* ---------- main ---------- */

const port = await freePort();
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-shot-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
  '--disable-background-networking', '--disable-component-update', '--hide-scrollbars', '--mute-audio',
  '--force-color-profile=srgb',
  // A locked or sleeping desktop must not make the page "hidden" (Windows occlusion tracking).
  '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  'about:blank',
], { stdio: 'ignore', windowsHide: true });
edge.on('error', (err) => { console.error(`Could not start Edge at ${EDGE}: ${err.message}`); process.exit(2); });

const problems = [];
let label = 'startup';
let cdp;
let browserWs = null;

// On Windows msedge.exe hands off to another process, so killing the spawned PID is not enough:
// close the browser over CDP, wait for the DevTools port to go away, and only then fall back to taskkill.
async function closeEdge() {
  if (browserWs) {
    try {
      const browser = await connectCdp(browserWs);
      await Promise.race([browser.send('Browser.close'), sleep(2000)]);
    } catch { /* already gone */ }
  }
  const gone = await waitFor(() => fetch(`http://127.0.0.1:${port}/json/version`).then(() => false, () => true), { timeout: 5000, what: 'Edge to exit' }).catch(() => false);
  if (!gone || edge.exitCode === null) {
    await new Promise((resolve) => {
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(edge.pid), '/T', '/F'], () => resolve());
      else { edge.kill('SIGKILL'); resolve(); }
    });
  }
}

try {
  browserWs = (await waitFor(() => fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok && r.json()), { what: 'Edge DevTools endpoint' })).webSocketDebuggerUrl;
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => problems.push({ view: label, kind: 'exception', text: d.exception?.description || d.text }));
  cdp.on('Runtime.consoleAPICalled', ({ type, args: a }) => {
    if (type === 'error' || type === 'warning' || type === 'assert') problems.push({ view: label, kind: `console.${type}`, text: a.map((x) => x.value ?? x.description ?? '').join(' ') });
  });
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error' || entry.level === 'warning') problems.push({ view: label, kind: `log.${entry.source}`, text: `${entry.text}${entry.url ? ` (${entry.url})` : ''}` });
  });
  cdp.on('Network.loadingFailed', ({ errorText, canceled, type }) => {
    if (!canceled && type !== 'WebSocket') problems.push({ view: label, kind: 'network', text: errorText });
  });

  await fs.mkdir(OUT, { recursive: true });
  const written = [];
  const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    await fs.writeFile(file, Buffer.from(data, 'base64'));
    written.push(path.relative(ROOT, file).split(path.sep).join('/'));
  };
  const settle = (ms = 450) => sleep(ms);

  for (const theme of THEMES) {
    for (const [width, height] of SIZES) {
      const mobile = width < 760;
      const suffix = `${width}x${height}${theme === 'gallery' ? '-gallery' : ''}`;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await cdp.send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [
          { name: 'prefers-color-scheme', value: theme === 'gallery' ? 'light' : 'dark' },
          { name: 'prefers-reduced-motion', value: args.motion ? 'no-preference' : 'reduce' },
        ],
      });

      label = `${VIEWS[0]} ${suffix} (load)`;
      await cdp.send('Page.navigate', { url: `${BASE}/#/${VIEWS[0]}` });
      await waitFor(() => evaluate(`document.documentElement.dataset.ready === '1'`), { what: `the UI hello at ${BASE}` });
      await evaluate(`document.fonts.ready.then(() => true)`);

      for (const view of VIEWS) {
        label = `${view} ${suffix}`;
        await evaluate(`location.hash = '#/${view}'; true`);
        await settle(view === VIEWS[0] ? 700 : 450);
        await evaluate(`(document.querySelector('.view:not([hidden])') || {}).scrollTop = 0; true`);
        await shot(`${view}-${suffix}`);
        for (let page = 2; page <= PAGES; page++) {
          const moved = await evaluate(`(() => {
            const el = document.querySelector('.app:not([data-view="remote"]) .view:not([hidden])') || (innerWidth >= 980 ? document.querySelector('.view:not([hidden])') : null);
            if (!el || el.scrollTop + el.clientHeight >= el.scrollHeight - 8) return false;
            el.scrollTop += el.clientHeight * 0.85;
            return true;
          })()`);
          if (!moved) break;
          await settle(250);
          await shot(`${view}-${suffix}-p${page}`);
        }
      }

      if (args.extras) {
        label = `extras ${suffix}`;
        await evaluate(`location.hash = '#/remote'; true`);
        await settle();
        await evaluate(`document.querySelector('.rocker.vol .rocker-mid').click(); true`);
        await settle(600);
        await shot(`extra-volume-sheet-${suffix}`);
        await evaluate(`document.querySelector('.sheet .sheet-head .icon-btn').click(); true`);
        await settle(400);

        await evaluate(`location.hash = '#/ask'; true`);
        await settle();
        await evaluate(`[...document.querySelectorAll('.ask-examples .chip')].find((c) => /brightness/i.test(c.textContent))?.click(); true`);
        await sleep(3200);
        await shot(`extra-ask-run-${suffix}`);

        await evaluate(`location.hash = '#/cast'; true`);
        await settle();
        await evaluate(`(() => { const f = document.querySelector('.cast-field'); f.value = 'http://192.0.2.10/films/Blade%20Runner%202049.mkv'; f.dispatchEvent(new Event('input')); document.querySelector('.cast-link .btn.primary').click(); return true; })()`);
        await sleep(2200);
        await shot(`extra-cast-${suffix}`);

        await evaluate(`location.hash = '#/remote'; document.activeElement?.blur(); document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })); true`);
        await settle(600);
        await shot(`extra-shortcuts-${suffix}`);
        await evaluate(`document.querySelector('.sheet .sheet-head .icon-btn')?.click(); true`);
        await settle(400);
        if (mobile) {
          await evaluate(`document.querySelector('.nav-item[data-rank="more"]').click(); true`);
          await settle(600);
          await shot(`extra-more-${suffix}`);
          await evaluate(`document.querySelector('.sheet .sheet-head .icon-btn')?.click(); true`);
          await settle(400);
        }

        await fetch(`${BASE}/dev/ime?open=1`, { method: 'POST' });
        await settle(900);
        await shot(`extra-ime-${suffix}`);
        await fetch(`${BASE}/dev/ime?open=0`, { method: 'POST' });
        await settle(400);
      }
    }
  }

  console.log(`Wrote ${written.length} screenshots to ${path.relative(ROOT, OUT) || '.'}:`);
  for (const f of written) console.log(`  ${f}`);
} catch (err) {
  problems.push({ view: label, kind: 'tool', text: err.message });
} finally {
  try { cdp?.close(); } catch { /* already closed */ }
  await closeEdge();
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

if (problems.length) {
  console.log(`\n${problems.length} console problem(s):`);
  for (const p of problems) console.log(`  [${p.view}] ${p.kind}: ${p.text}`);
  process.exitCode = 1;
} else {
  console.log('\nNo console errors, warnings, exceptions or failed requests.');
}
