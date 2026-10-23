// Browser view (spec §11.3): one shared headless Microsoft Edge driven over the Chrome DevTools
// Protocol. Its screen streams to the Lumen clients on the Browser view as JPEG frames
// (Page.startScreencast) and their pointer and keyboard input goes back (Input.*). Edge starts on
// first use, keeps its profile under data/browser-profile, listens on 127.0.0.1 only and closes
// after idleMs without a viewer. The process-handling follows tools/screenshot.mjs.
import { spawn, execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { LumenError } from '../errors.js';

const PROFILE_DIR = 'browser-profile';
const HOME_URL = 'https://duckduckgo.com/';
const VIEWPORT = Object.freeze({ minW: 320, maxW: 1280, minH: 320, maxH: 800 });
const START_TIMEOUT_MS = 20_000;
const POLL_MS = 150;
const BROWSER_CLOSE_MS = 1500; // Browser.close is given this long before the port check
const EXIT_WAIT_MS = 3000; // then the DevTools port must be gone within this
const IDLE_FPS = 5; // fan-out rate while frames repeat byte-for-byte
const UNACKED_LIMIT = 2; // a client this many frames behind is skipped until it acks
const MAX_VIEWPORT_INPUT = 8192;

const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, shift: 8 };
const BUTTON_BITS = { left: 1, right: 2, middle: 4 };
// Non-printing keys the UI sends as `key` events: DOM key → [code, Windows virtual key, text?].
const SPECIAL_KEYS = {
  Enter: ['Enter', 13, '\r'], Backspace: ['Backspace', 8], Tab: ['Tab', 9, '\t'], Escape: ['Escape', 27],
  Delete: ['Delete', 46], Insert: ['Insert', 45], Home: ['Home', 36], End: ['End', 35],
  PageUp: ['PageUp', 33], PageDown: ['PageDown', 34],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  ' ': ['Space', 32, ' '],
};

// Runs in every new top-level document. Popups cannot be shown (there is one screencast), so new
// windows open in the same page; title changes are reported through a binding (Edge's own
// Target.targetInfoChanged can lag seconds behind a script-set title).
const TITLE_BINDING = '__lumenTitle';
const PAGE_SCRIPT = `(() => {
  if (window !== top) return;
  window.open = (url) => { if (url) location.assign(url); return null; };
  addEventListener('click', (event) => {
    const link = event.target && event.target.closest ? event.target.closest('a[target]') : null;
    if (link && link.target && link.target !== '_self') link.target = '_self';
  }, true);
  let last;
  let titleObserver = null;
  const report = () => { if (document.title !== last) { last = document.title; ${TITLE_BINDING}(last); } };
  const watchTitle = () => {
    if (titleObserver) titleObserver.disconnect();
    titleObserver = null;
    const el = document.querySelector('title');
    if (el) { titleObserver = new MutationObserver(report); titleObserver.observe(el, { childList: true, characterData: true, subtree: true }); }
    report();
  };
  const watchHead = () => {
    if (!document.head) return false;
    new MutationObserver(watchTitle).observe(document.head, { childList: true });
    watchTitle();
    return true;
  };
  if (!watchHead()) {
    const early = new MutationObserver(() => { if (watchHead()) early.disconnect(); });
    early.observe(document, { childList: true, subtree: true });
  }
  addEventListener('load', report);
})();`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const isBlank = (entry) => !entry || entry.url === 'about:blank';

export function validateUrl(input, { allowLoopback = false } = {}) {
  const raw = typeof input === 'string' ? input.trim() : '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new LumenError('INVALID', 'That is not a link');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new LumenError('INVALID', 'Only http and https links can be opened');
  if (!allowLoopback && isLoopbackHost(url.hostname)) throw new LumenError('INVALID', 'Pages on this PC itself cannot be opened in the Lumen browser');
  return url.href;
}

// This PC's own services (Lumen, the browser's DevTools port, anything bound to localhost) are off-limits:
// the Lumen browser is reachable from every Lumen client, including phones on the LAN.
export function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::' || host === '0.0.0.0'
    || /^127\./.test(host) || /^::ffff:127\./.test(host) || /^0x7f/.test(host) || /^2130706433$/.test(host);
}
const LOOPBACK_PATTERNS = ['*://localhost*', '*://*.localhost*', '*://127.*', '*://[::1]*', '*://0.0.0.0*', '*://[::]*'];

// Ctrl/Meta shortcuts the page may receive; the rest (Ctrl+W, Ctrl+T, Ctrl+N, ...) are browser-level
// accelerators that would close or replace the shared tab.
const EDIT_SHORTCUTS = new Set(['a', 'c', 'v', 'x', 'z', 'y', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

// Ad click-through links (sponsored search results) go through ad-redirect hosts that the VPN's
// DNS blocks, so the click ends on an error page. The destination is carried in the link itself.
const AD_HOSTS = /(^|\.)(doubleclick\.net|googleadservices\.com|googlesyndication\.com|dartsearch\.net)$/i;
const DEST_PARAMS = ['adurl', 'ds_dest_url', 'dest_url', 'url', 'u'];

/** The page an ad-redirect URL leads to, or null when `raw` is not an ad redirect. */
export function adDestination(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!AD_HOSTS.test(u.hostname)) return null;
  const candidates = DEST_PARAMS.map((k) => u.searchParams.get(k)).filter(Boolean);
  // DoubleClick ddm links append the destination after a bare '?': …;dc_…?https://site/…
  const embedded = raw.slice(u.origin.length).match(/https?(?::|%3A)(?:\/|%2F){2}.+$/i);
  if (embedded) candidates.push(embedded[0]);
  for (let c of candidates) {
    if (/^https?%3A/i.test(c)) { try { c = decodeURIComponent(c); } catch { continue; } }
    try {
      const dest = new URL(c);
      if ((dest.protocol === 'http:' || dest.protocol === 'https:') && !AD_HOSTS.test(dest.hostname) && !isLoopbackHost(dest.hostname)) return dest.href;
    } catch { /* not a URL */ }
  }
  return null;
}

export function clampViewport(w, h) {
  return {
    w: clamp(Math.round(Number(w) || VIEWPORT.maxW), VIEWPORT.minW, VIEWPORT.maxW),
    h: clamp(Math.round(Number(h) || VIEWPORT.maxH), VIEWPORT.minH, VIEWPORT.maxH),
  };
}

// 'hls' | 'dash' | 'file' for a video stream a page can be handed off with; segments and audio are not.
export function mediaKind(mime, url) {
  const type = String(mime ?? '').toLowerCase();
  const path = String(url ?? '').split('?')[0].toLowerCase();
  if (/mpegurl/.test(type) || path.endsWith('.m3u8')) return 'hls';
  if (/dash\+xml/.test(type) || path.endsWith('.mpd')) return 'dash';
  if (/^video\/(mp4|webm|quicktime)/.test(type) && !/\.(m4s|ts)$/.test(path)) return 'file';
  return null;
}

// Width and height from a JPEG's start-of-frame marker, or null when it cannot be found.
export function jpegSize(buffer) {
  let i = 2;
  while (i + 9 < buffer.length) {
    if (buffer[i] !== 0xff) return null;
    const marker = buffer[i + 1];
    if (marker === 0xff) { i += 1; continue; } // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; } // standalone markers
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buffer.readUInt16BE(i + 5), w: buffer.readUInt16BE(i + 7) };
    }
    i += 2 + buffer.readUInt16BE(i + 2);
  }
  return null;
}

function modifierBits(value) {
  if (Number.isInteger(value)) return value & 15;
  if (!Array.isArray(value)) return 0;
  return value.reduce((bits, name) => bits | (MODIFIER_BITS[String(name).toLowerCase()] ?? 0), 0);
}

// The CDP key event fields for a DOM `key` (one printable character or a SPECIAL_KEYS name).
function describeKey(key, code) {
  const special = SPECIAL_KEYS[key];
  if (special) return { key, code: code ?? special[0], keyCode: special[1], text: special[2] };
  if ([...key].length === 1) {
    const upper = key.toUpperCase();
    const keyCode = /^[A-Z0-9]$/.test(upper) ? upper.charCodeAt(0) : 0;
    const guessed = /^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(upper) ? `Digit${upper}` : '';
    return { key, code: code ?? guessed, keyCode, text: key };
  }
  throw new LumenError('INVALID', `Lumen cannot send the key ${key.slice(0, 20)}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Minimal DevTools client over Node's WebSocket: send(method, params) → result, on(method, fn), onClose(fn).
function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const handlers = new Map();
    const closers = new Set();
    let next = 1;
    const fail = (message) => {
      for (const { rej, method } of pending.values()) rej(new LumenError('UNAVAILABLE', `${method}: ${message}`));
      pending.clear();
    };
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new LumenError('UNAVAILABLE', 'The browser is not open'));
        const id = next++;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => pending.set(id, { res, rej, method }));
      },
      on(method, fn) { handlers.set(method, [...(handlers.get(method) ?? []), fn]); },
      onClose(fn) { closers.add(fn); },
      close() { ws.close(); },
    }));
    ws.addEventListener('error', () => reject(new Error(`DevTools connection to ${url} failed`)));
    ws.addEventListener('close', () => {
      fail('the browser connection closed');
      for (const fn of closers) fn();
    });
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej, method } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`${method}: ${msg.error.message}`));
        else res(msg.result);
      } else if (msg.method) {
        for (const fn of handlers.get(msg.method) ?? []) fn(msg.params);
      }
    });
  });
}

const devtoolsUp = (port) => fetch(`http://127.0.0.1:${port}/json/version`).then((res) => res.ok && res.json(), () => false);

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function createBrowser({ config, log: rootLog, store, hub, vpn = () => null }) {
  const log = rootLog.child('browser');
  const settings = { idleMs: 1_200_000, maxFps: 15, quality: 60, maxWidth: 1280, maxHeight: 800, ...config.browser };
  // Lumen browser on TV (features/tvscreen.js): extra receivers of every frame as JPEG bytes. While one
  // is attached the viewport is the TV's 16:9 and phones see a scaled copy.
  const sinks = new Set();
  const TV_VIEWPORT = Object.freeze({ w: 1280, h: 720 });
  let requestedViewport = null;
  // Video streams the page loaded (HLS/DASH manifests, whole files), newest first, with the request
  // headers that fetched them (cookies, referer) so the TV can be handed the same stream.
  let mediaSeen = [];
  const mediaRequests = new Map(); // requestId → { url, type, headers }
  const MEDIA_KEEP = 20;
  const { edgePath } = settings;
  const profileDir = path.join(config.dataDir, PROFILE_DIR);

  let viewport = { w: VIEWPORT.maxW, h: VIEWPORT.maxH };
  // On Windows the spawned msedge.exe hands the profile to a new browser process and exits within a
  // second, so the browser-level CDP connection and the PID it reports are what the shutdown uses.
  let child = null; // the spawned msedge.exe
  let launchedProxy = null; // the --proxy-server Edge was started with (the VPN switch)
  let devPort = null;
  let browser = null; // CDP connection to the browser target
  let browserPid = null;
  let page = null; // CDP connection to the one tab
  let mainFrameId = null;
  let titleFromPage = null; // the current document's title as reported by PAGE_SCRIPT
  let ready = false;
  let starting = null; // the in-flight launch, so concurrent opens share it
  let stopped = false;
  const pressed = new Set(); // mouse buttons currently held

  // Frames: `latest` waits for the next fan-out slot, `lastFrame` is what viewers currently show.
  let seq = 0;
  let latest = null;
  let lastFrame = null;
  let lastSentAt = 0;
  let flushTimer = null;
  const watchers = new Map(); // client on the Browser view → { outstanding: seq[], lastSeq }
  let idleTimer = null;

  // ---------- state ----------

  // Values are primitives; an unchanged value is not re-published (the store would still emit a patch).
  function publish(key, value) {
    const current = store.get(`browser.${key}`);
    if (current && current.v === value && current.src === 'derived') return;
    store.set(`browser.${key}`, value, { src: 'derived', via: 'browser' });
  }

  function setSession(state, error = null) {
    publish('session', state);
    publish('error', error);
  }

  function clearPage() {
    publish('url', null);
    publish('title', null);
    publish('loading', false);
    publish('canGoBack', false);
    publish('canGoForward', false);
  }

  async function refreshHistory(cdp = page) {
    if (!cdp) return;
    try {
      const { currentIndex, entries } = await cdp.send('Page.getNavigationHistory');
      if (cdp !== page) return;
      const current = entries[currentIndex];
      const url = isBlank(current) ? null : current.url;
      publish('url', url);
      // The page script's title wins once it has reported; the history title can lag behind it.
      if (titleFromPage === null) publish('title', url ? (current.title || new URL(url).hostname) : null);
      publish('canGoBack', entries.slice(0, currentIndex).some((entry) => !isBlank(entry)));
      publish('canGoForward', currentIndex < entries.length - 1);
    } catch (err) {
      log.debug('navigation history unavailable', { message: err.message });
    }
  }

  function requireReady() {
    if (!ready || !page) throw new LumenError('UNAVAILABLE', 'The browser is not open');
    return page;
  }

  // ---------- frames ----------

  function canReceive(client, frameSeq) {
    const watcher = watchers.get(client);
    if (!watcher || watcher.outstanding.length >= UNACKED_LIMIT) return false;
    watcher.outstanding.push(frameSeq);
    watcher.lastSeq = frameSeq;
    return true;
  }

  function sendFrame(frame, only = null) {
    hub.sendToView('browser', { t: 'browser.frame', data: frame.data, w: frame.w, h: frame.h, seq: frame.seq },
      (client) => (only === null || client === only) && canReceive(client, frame.seq));
  }

  function flushFrame() {
    flushTimer = null;
    const frame = latest;
    latest = null;
    if (!frame || !ready) return;
    const size = jpegSize(Buffer.from(frame.data, 'base64')) ?? { w: frame.w, h: frame.h };
    lastFrame = { ...frame, ...size };
    lastSentAt = Date.now();
    sendFrame(lastFrame);
    if (sinks.size) {
      const bytes = Buffer.from(lastFrame.data, 'base64');
      for (const sink of sinks) {
        try { sink(bytes, lastFrame); } catch (err) { log.debug('frame sink failed', { message: err.message }); }
      }
    }
  }

  // Frames are acked to Edge at once and fanned out at most maxFps per second (IDLE_FPS while the
  // bytes repeat); a frame that arrives before its slot replaces the one waiting.
  function onScreencastFrame({ data, metadata, sessionId }, cdp) {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (cdp !== page || !ready) return;
    seq += 1;
    latest = { data, w: metadata.deviceWidth, h: metadata.deviceHeight, seq };
    if (flushTimer) return;
    const gap = 1000 / (lastFrame && lastFrame.data === data ? IDLE_FPS : settings.maxFps);
    flushTimer = setTimeout(flushFrame, Math.max(0, lastSentAt + gap - Date.now()));
  }

  function ack(client, acked) {
    const watcher = watchers.get(client);
    if (!watcher) return;
    watcher.outstanding = watcher.outstanding.filter((s) => s > acked);
    // Caught up after being skipped: show it the frame it missed, or it would stay on a stale page.
    if (!watcher.outstanding.length && lastFrame && lastFrame.seq !== watcher.lastSeq) sendFrame(lastFrame, client);
  }

  // ---------- idle shutdown ----------

  function clearIdle() {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  function armIdle() {
    clearIdle();
    if (!child || watchers.size || sinks.size) return;
    idleTimer = setTimeout(() => {
      log.info('closing the browser: no viewer for a while', { idleMs: settings.idleMs });
      close().catch((err) => log.warn('idle close failed', err));
    }, settings.idleMs);
    idleTimer.unref();
  }

  function viewers(set) {
    const next = new Set(set);
    for (const client of watchers.keys()) if (!next.has(client)) watchers.delete(client);
    for (const client of next) {
      if (watchers.has(client)) continue;
      watchers.set(client, { outstanding: [], lastSeq: 0 });
      if (lastFrame && ready) sendFrame(lastFrame, client);
    }
    if (watchers.size) clearIdle();
    else armIdle();
  }

  // ---------- Edge process ----------

  const pidToKill = () => browserPid ?? child?.pid ?? null;

  // Synchronous, for Lumen's own exit: Edge must not outlive it.
  function killOnExit() {
    const pid = pidToKill();
    if (!pid) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }

  function taskkill(pid) {
    return new Promise((resolve) => {
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      else {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        resolve();
      }
    });
  }

  async function until(condition, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await condition()) return true;
      if (Date.now() >= deadline) return false;
      await sleep(POLL_MS);
    }
  }

  // Browser.close over CDP, wait for the DevTools port and the browser process to go, then taskkill
  // as the fallback (as tools/screenshot.mjs does).
  // msedge.exe processes started with Lumen's profile directory (strays from an earlier run, or
  // helpers that outlived Browser.close). Windows only; elsewhere this is a no-op.
  function killStrays() {
    if (process.platform !== 'win32') return Promise.resolve();
    const pattern = `*${profileDir}*`.replace(/'/g, "''");
    const script = `Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" | Where-Object { $_.CommandLine -like '${pattern}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15000 }, () => resolve()));
  }

  async function closeEdge({ proc, conn, port, pid }) {
    if (conn) {
      await Promise.race([conn.send('Browser.close').catch(() => {}), sleep(BROWSER_CLOSE_MS)]);
      conn.close();
    }
    await until(() => devtoolsUp(port).then((up) => up === false), EXIT_WAIT_MS);
    const exited = await until(() => !isAlive(pid) && !isAlive(proc.pid), EXIT_WAIT_MS);
    if (!exited) {
      log.warn('Edge did not close on request; killing it', { pid });
      for (const target of new Set([pid, proc.pid].filter(Boolean))) if (isAlive(target)) await taskkill(target);
    }
    await killStrays(); // crashpad/utility helpers can outlive the browser process
  }

  // Edge is never left running after this: killOnExit covers a crash of Lumen itself.
  async function teardown() {
    launchedProxy = null;
    clearIdle();
    clearTimeout(flushTimer);
    flushTimer = null;
    latest = null;
    lastFrame = null;
    pressed.clear();
    ready = false;
    const session = { proc: child, conn: browser, port: devPort, pid: browserPid };
    const cdp = page;
    child = null;
    browser = null;
    browserPid = null;
    page = null;
    devPort = null;
    mainFrameId = null;
    titleFromPage = null;
    for (const watcher of watchers.values()) Object.assign(watcher, { outstanding: [], lastSeq: 0 });
    cdp?.close();
    if (session.proc) {
      await closeEdge(session);
      process.off('exit', killOnExit);
    }
    clearPage();
  }

  // Either CDP connection dropping while in use means Edge died or was closed from outside.
  function onConnectionLost(cdp) {
    if (cdp !== page && cdp !== browser) return;
    log.warn('the browser closed unexpectedly');
    teardown()
      .then(() => setSession(stopped ? 'off' : 'error', stopped ? null : 'The browser closed unexpectedly'))
      .catch((err) => log.warn('cleanup after browser exit failed', err));
  }

  const metrics = () => ({ width: viewport.w, height: viewport.h, deviceScaleFactor: 1, mobile: false });

  async function waitForDevtools(port, spawnFailed) {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const version = await Promise.race([devtoolsUp(port), spawnFailed.then((err) => ({ failed: err }))]);
      if (version?.failed) throw new Error(`Microsoft Edge could not be started: ${version.failed.message}`);
      if (version) return version;
      await sleep(POLL_MS);
    }
    throw new Error('Microsoft Edge did not start in time');
  }

  async function launch() {
    if (stopped) throw new LumenError('UNAVAILABLE', 'Lumen is stopping');
    if (!edgePath || !fs.existsSync(edgePath)) {
      throw new LumenError('UNAVAILABLE', `Microsoft Edge was not found at ${edgePath ?? '(no browser.edgePath)'}`);
    }
    const vpnFeature = vpn();
    const proxyUrl = vpnFeature?.proxyUrl?.() ?? null;
    if (vpnFeature?.status?.().enabled && !proxyUrl) {
      // The switch is on but nothing can carry the traffic: never start Edge without the tunnel.
      throw new LumenError('UNAVAILABLE', `The VPN is on but not ready: ${vpnFeature.status().error ?? 'starting'}`);
    }
    setSession('starting');
    await killStrays(); // an Edge left behind by an earlier Lumen would keep the profile locked
    const port = await freePort();
    fs.mkdirSync(profileDir, { recursive: true });
    const proc = spawn(edgePath, [
      '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
      `--window-size=${viewport.w},${viewport.h}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
      '--disable-background-networking', '--disable-component-update', '--mute-audio', '--force-color-profile=srgb',
      // A locked or sleeping desktop must not make the page "hidden" (Windows occlusion tracking).
      '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
      ...(proxyUrl ? [
        `--proxy-server=${proxyUrl}`,
        // Fail closed: every name is resolved by the proxy inside the tunnel, never locally; no QUIC
        // (UDP cannot use an HTTP proxy) and no WebRTC UDP outside the proxy.
        '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ] : []),
      'about:blank',
    ], { stdio: 'ignore', windowsHide: true });
    launchedProxy = proxyUrl;
    const spawnFailed = new Promise((resolve) => proc.once('error', resolve));
    child = proc;
    devPort = port;
    process.once('exit', killOnExit);

    const version = await waitForDevtools(port, spawnFailed);
    const conn = await connectCdp(version.webSocketDebuggerUrl);
    browser = conn;
    // No downloads: any Lumen client could otherwise write files onto this PC.
    await conn.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch((err) => log.warn('could not disable downloads', { message: err.message }));
    conn.onClose(() => onConnectionLost(conn));
    try {
      const { processInfo } = await conn.send('SystemInfo.getProcessInfo');
      browserPid = processInfo.find((info) => info.type === 'browser')?.id ?? null;
    } catch (err) {
      log.debug('browser process id unknown', { message: err.message });
    }
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = await connectCdp(target.webSocketDebuggerUrl);
    cdp.onClose(() => onConnectionLost(cdp));
    cdp.on('Page.screencastFrame', (params) => onScreencastFrame(params, cdp));
    cdp.on('Page.frameStartedLoading', ({ frameId }) => { if (frameId === mainFrameId) publish('loading', true); });
    cdp.on('Page.frameStoppedLoading', ({ frameId }) => {
      if (frameId !== mainFrameId) return;
      publish('loading', false);
      refreshHistory(cdp);
    });
    cdp.on('Page.frameNavigated', ({ frame }) => {
      if (frame.parentId) return;
      titleFromPage = null; // a new document; its script reports the title once it is parsed
      refreshHistory(cdp);
    });
    cdp.on('Runtime.bindingCalled', ({ name, payload }) => {
      if (name !== TITLE_BINDING || cdp !== page) return;
      titleFromPage = payload || null;
      if (payload) publish('title', payload);
      else refreshHistory(cdp); // no <title>: the history supplies the hostname
    });
    cdp.on('Page.navigatedWithinDocument', ({ frameId }) => { if (frameId === mainFrameId) refreshHistory(cdp); });
    cdp.on('Page.loadEventFired', () => refreshHistory(cdp));
    // Dialogs would block the page: alerts and beforeunload are accepted, confirms and prompts cancelled.
    cdp.on('Page.javascriptDialogOpening', ({ type }) => {
      cdp.send('Page.handleJavaScriptDialog', { accept: type === 'alert' || type === 'beforeunload' }).catch(() => {});
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable'); // bindingCalled needs the domain on
    await cdp.send('Network.enable');
    mediaSeen = [];
    mediaRequests.clear();
    cdp.on('Network.requestWillBeSent', (p) => {
      if (p.type === 'Document' && p.frameId === mainFrameId) mediaSeen = [];
      if (mediaRequests.size > 500) mediaRequests.clear();
      mediaRequests.set(p.requestId, { url: p.request.url, type: p.type, frameId: p.frameId, headers: { ...p.request.headers } });
    });
    cdp.on('Network.requestWillBeSentExtraInfo', (p) => {
      const r = mediaRequests.get(p.requestId);
      if (r) r.headers = { ...r.headers, ...p.headers };
    });
    cdp.on('Network.responseReceived', (p) => {
      const r = mediaRequests.get(p.requestId);
      const kind = mediaKind(p.response.mimeType, p.response.url);
      if (!kind || !r || p.response.status >= 400) return;
      const lower = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
      const entry = { url: p.response.url, kind, mime: p.response.mimeType, at: Date.now(),
        headers: { cookie: lower.cookie ?? null, referer: lower.referer ?? null, origin: lower.origin ?? null, userAgent: lower['user-agent'] ?? null } };
      mediaSeen = [entry, ...mediaSeen.filter((m) => m.url !== entry.url)].slice(0, MEDIA_KEEP);
      publish('media', mediaSeen.length);
    });
    cdp.on('Network.loadingFinished', (p) => mediaRequests.delete(p.requestId));
    cdp.on('Network.loadingFailed', (p) => {
      const r = mediaRequests.get(p.requestId);
      mediaRequests.delete(p.requestId);
      // A blocked ad redirect in the main frame: go to the page the ad points at instead.
      const dest = r?.type === 'Document' && r.frameId === mainFrameId && !p.canceled ? adDestination(r.url) : null;
      if (dest && cdp === page) {
        log.info('ad redirect blocked; opening its destination', { host: new URL(dest).hostname });
        publish('url', dest);
        cdp.send('Page.navigate', { url: dest }).catch(() => {});
      }
    });
    if (!config.browser?.allowLoopback) await cdp.send('Network.setBlockedURLs', { urls: LOOPBACK_PATTERNS });
    mainFrameId = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
    await cdp.send('Runtime.addBinding', { name: TITLE_BINDING });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SCRIPT });
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Sites treat the "Headless" token as a bot; the rest of the UA is the real one.
    const { userAgent } = await cdp.send('Browser.getVersion');
    if (/Headless/.test(userAgent)) await cdp.send('Emulation.setUserAgentOverride', { userAgent: userAgent.replace(/Headless/g, '') });
    await cdp.send('Emulation.setDeviceMetricsOverride', metrics());
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: settings.quality, maxWidth: settings.maxWidth, maxHeight: settings.maxHeight, everyNthFrame: 1,
    });
    page = cdp;
    ready = true;
    setSession('ready');
    log.info('browser started', { port, pid: browserPid, viewport, vpn: !!proxyUrl });
    if (!watchers.size) armIdle();
  }

  function ensureRunning() {
    if (ready && page) return Promise.resolve();
    starting ??= launch()
      .catch(async (err) => {
        const message = err instanceof LumenError ? err.message : `The browser could not start: ${err.message}`;
        log.warn('browser start failed', { message: err.message });
        await teardown();
        setSession('error', message);
        throw err instanceof LumenError ? err : new LumenError('FAILED', message);
      })
      .finally(() => { starting = null; });
    return starting;
  }

  async function close() {
    if (!child && !page && !starting) {
      if (store.get('browser.session')?.v !== 'off') setSession('off');
      return {};
    }
    if (starting) await starting.catch(() => {});
    await teardown();
    setSession('off');
    log.info('browser closed');
    return {};
  }

  // ---------- commands ----------

  async function open(input) {
    const url = validateUrl(input, { allowLoopback: !!config.browser?.allowLoopback });
    await ensureRunning();
    const cdp = requireReady();
    publish('loading', true);
    publish('url', url);
    const { errorText } = await cdp.send('Page.navigate', { url });
    if (errorText) log.debug('navigation failed', { errorText });
    return { value: { url } };
  }

  async function nav(action) {
    if (action === 'home') return open(HOME_URL);
    const cdp = requireReady();
    switch (action) {
      case 'reload':
        await cdp.send('Page.reload');
        break;
      case 'stop':
        // During a document swap Edge can answer "Not attached to an active page": nothing to stop.
        await cdp.send('Page.stopLoading').catch((err) => log.debug('nothing to stop', { message: err.message }));
        break;
      case 'back':
      case 'forward': {
        const { currentIndex, entries } = await cdp.send('Page.getNavigationHistory');
        const index = currentIndex + (action === 'back' ? -1 : 1);
        const entry = entries[index];
        if (!entry || (action === 'back' && isBlank(entry) && index === 0)) break; // the initial blank tab is not a page
        await cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id });
        break;
      }
      default:
        throw new LumenError('INVALID', `Unknown browser action ${String(action).slice(0, 20)}`);
    }
    return {};
  }

  // Frame pixels → viewport pixels (the frame may be a scaled copy of the viewport).
  function toViewport({ x = 0, y = 0 }) {
    const frame = lastFrame ?? viewport;
    const sx = viewport.w / (frame.w || viewport.w);
    const sy = viewport.h / (frame.h || viewport.h);
    return {
      x: clamp(Math.round(clamp(Number(x) || 0, 0, MAX_VIEWPORT_INPUT) * sx), 0, viewport.w),
      y: clamp(Math.round(clamp(Number(y) || 0, 0, MAX_VIEWPORT_INPUT) * sy), 0, viewport.h),
    };
  }

  function mouse(cdp, type, event, extra = {}) {
    const buttons = [...pressed].reduce((bits, name) => bits | BUTTON_BITS[name], 0);
    return cdp.send('Input.dispatchMouseEvent', { type, ...toViewport(event), modifiers: modifierBits(event.modifiers), buttons, ...extra });
  }

  async function pressKey(cdp, { key, code, modifiers }) {
    const described = describeKey(String(key), code);
    const bits = modifierBits(modifiers);
    if ((bits & (MODIFIER_BITS.ctrl | MODIFIER_BITS.meta)) && !EDIT_SHORTCUTS.has(described.key.length === 1 ? described.key.toLowerCase() : described.key)) {
      throw new LumenError('INVALID', 'That shortcut is not passed to the page');
    }
    const typed = described.text !== undefined && !(bits & (MODIFIER_BITS.ctrl | MODIFIER_BITS.meta));
    const shifted = Boolean(bits & MODIFIER_BITS.shift) && !SPECIAL_KEYS[described.key];
    const base = {
      key: shifted ? described.key.toUpperCase() : described.key, code: described.code,
      windowsVirtualKeyCode: described.keyCode, nativeVirtualKeyCode: described.keyCode, modifiers: bits,
    };
    await cdp.send('Input.dispatchKeyEvent', typed
      ? { ...base, type: 'keyDown', text: shifted ? described.text.toUpperCase() : described.text, unmodifiedText: described.text }
      : { ...base, type: 'rawKeyDown' });
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  async function input(event) {
    const cdp = requireReady();
    const button = BUTTON_BITS[event.button] ? event.button : 'left';
    switch (event.kind) {
      case 'move':
        await mouse(cdp, 'mouseMoved', event, { button: pressed.size ? [...pressed][0] : 'none' });
        break;
      case 'down':
        pressed.add(button);
        await mouse(cdp, 'mousePressed', event, { button, clickCount: 1 });
        break;
      case 'up':
        pressed.delete(button);
        await mouse(cdp, 'mouseReleased', event, { button, clickCount: 1 });
        break;
      case 'click':
        pressed.add(button);
        await mouse(cdp, 'mousePressed', event, { button, clickCount: 1 });
        pressed.delete(button);
        await mouse(cdp, 'mouseReleased', event, { button, clickCount: 1 });
        break;
      case 'wheel':
        await mouse(cdp, 'mouseWheel', event, { deltaX: Number(event.deltaX) || 0, deltaY: Number(event.deltaY) || 0 });
        break;
      case 'key':
        await pressKey(cdp, event);
        break;
      case 'text':
        await cdp.send('Input.insertText', { text: String(event.text ?? '') });
        break;
      default:
        throw new LumenError('INVALID', `Unknown input kind ${String(event.kind).slice(0, 20)}`);
    }
    return {};
  }

  async function setViewport(w, h) {
    requestedViewport = clampViewport(w, h);
    if (sinks.size) return { value: { ...viewport } }; // the TV's viewport holds while it watches
    const next = clampViewport(w, h);
    const changed = next.w !== viewport.w || next.h !== viewport.h;
    viewport = next;
    if (changed && ready && page) await page.send('Emulation.setDeviceMetricsOverride', metrics());
    return { value: { ...viewport } };
  }

  // For tests: runs an expression in the page and returns its value.
  async function evaluate(expression) {
    const cdp = requireReady();
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression: String(expression), awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new LumenError('FAILED', exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'The page threw');
    return result?.value;
  }

  // Restarts Edge when the VPN switch changed what --proxy-server must be, and reopens the page.
  async function applyProxy() {
    const want = vpn()?.proxyUrl?.() ?? null;
    const wantOn = !!vpn()?.status?.().enabled;
    const running = !!(child || page || starting);
    if (!running || (want === launchedProxy && (want || !wantOn))) return {};
    const url = store.get('browser.url')?.v;
    await close();
    if (url) await open(url).catch(() => {}); // a fail-closed refusal shows as browser.session 'error'
    return {};
  }

  /** Adds a frame receiver (bytes, frame) and locks the TV viewport; → a function that removes it. */
  function addSink(fn) {
    sinks.add(fn);
    clearIdle();
    const wasLocked = sinks.size > 1;
    if (!wasLocked) {
      requestedViewport ??= { ...viewport };
      viewport = { ...TV_VIEWPORT };
      if (ready && page) page.send('Emulation.setDeviceMetricsOverride', metrics()).catch(() => {});
    }
    if (lastFrame && ready) fn(Buffer.from(lastFrame.data, 'base64'), lastFrame);
    return () => {
      if (!sinks.delete(fn) || sinks.size) return;
      viewport = requestedViewport ?? viewport;
      if (ready && page) page.send('Emulation.setDeviceMetricsOverride', metrics()).catch(() => {});
      if (!watchers.size) armIdle();
    };
  }

  // ---------- for the AI: read, look, click ----------

  // Visible text plus the interactive elements on screen, numbered; positions are CSS pixels.
  const SNAPSHOT_SCRIPT = `(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05; };
    const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || el.name || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const els = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [onclick], video')]
      .filter(vis).slice(0, 120).map((el) => { const r = el.getBoundingClientRect();
        return { tag: el.tagName.toLowerCase(), type: el.type || el.getAttribute('role') || '', text: label(el), href: el.href ? String(el.href).slice(0, 160) : undefined,
          x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })
      .filter((e) => e.text || e.tag === 'input' || e.tag === 'textarea' || e.tag === 'video');
    return { url: location.href, title: document.title, scrollY: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight, viewport: { w: innerWidth, h: innerHeight },
      text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000), elements: els };
  })()`;
  let lastSnapshot = null;

  /** Page text and numbered interactive elements (the numbering is what click() takes). */
  async function snapshot() {
    await ensureRunning();
    const value = await evaluate(SNAPSHOT_SCRIPT);
    value.elements = value.elements.map((e, i) => ({ i: i + 1, ...e }));
    lastSnapshot = value;
    return value;
  }

  /** A JPEG screenshot of the page as the browser shows it. */
  async function screenshot() {
    const cdp = requireReady();
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
    return Buffer.from(data, 'base64');
  }

  /** Clicks element number `index` from the last snapshot, or the first element whose text matches. */
  async function clickElement({ index, text }) {
    if (!lastSnapshot || (text && !index)) await snapshot();
    const list = lastSnapshot.elements;
    const wanted = text ? String(text).toLowerCase() : null;
    const el = index ? list.find((e) => e.i === index)
      : list.find((e) => e.text.toLowerCase() === wanted) ?? list.find((e) => e.text.toLowerCase().includes(wanted));
    if (!el) throw new LumenError('NOT_FOUND', text ? `Nothing on screen says "${String(text).slice(0, 40)}"` : `There is no element ${index}`);
    const size = frameSize();
    const sx = size.w / (lastSnapshot.viewport.w || size.w);
    const sy = size.h / (lastSnapshot.viewport.h || size.h);
    await input({ kind: 'click', x: el.x * sx, y: el.y * sy });
    lastSnapshot = null;
    return { value: { clicked: el.text || el.tag, tag: el.tag } };
  }

  /** Video streams the current page loaded, newest first. */
  const media = () => mediaSeen.map((m) => ({ ...m, headers: { ...m.headers } }));

  /** The size frames arrive in (input coordinates are in frame pixels). */
  const frameSize = () => ({ w: lastFrame?.w ?? viewport.w, h: lastFrame?.h ?? viewport.h });

  return {
    applyProxy,
    addSink,
    media,
    frameSize,
    snapshot,
    screenshot,
    clickElement,
    ensureRunning,
    open,
    nav,
    input,
    setViewport,
    viewers,
    ack,
    close,
    evaluate,

    start() {
      setSession('off');
      clearPage();
    },

    async stop() {
      stopped = true;
      await close();
    },

    // Presence reaches this feature through viewers(); nothing here depends on the overall demand.
    setDemand() {},
  };
}
