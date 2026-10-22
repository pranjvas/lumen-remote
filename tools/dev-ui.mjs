#!/usr/bin/env node
// Lumen web UI dev server: serves web/ on http://127.0.0.1:8799 (same CSP as server/http.js) with a
// fake /live WebSocket that sends a realistic hello (values from the 2026-10-21 live findings),
// acks every command with plausible TV behaviour, streams fake "Ask Lumen" runs and nudges the
// volume from "the physical remote" every 20 s. It never talks to a TV.
//
//   node tools/dev-ui.mjs [--port 8799] [--scenario live-tv|netflix|standby|unpaired|dynamic]
//   POST /dev/ime?open=1|0   opens/closes the TV keyboard (IME) for every connected tab.
//   POST /dev/browser?url=<page> | ?close=1 | ?error=<message>   drives the fake Lumen browser.
//   GET  /dev/commands       the last 300 commands received over /live (for UI protocol checks).
//
// The Browser view (spec §11.3) gets a fake session: wireframe pages rendered here as PNG frames
// (no Edge involved), with links, scrolling, a search box that takes typed text, and ack gating.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? 8799);
const SCENARIO = args.scenario ?? 'live-tv';
const HOST = '127.0.0.1';
const VOLUME_CAP = 60;
const CSRF = randomBytes(16).toString('hex');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(list[i]);
    if (!m) continue;
    out[m[1]] = m[2] ?? (list[i + 1] && !list[i + 1].startsWith('--') ? list[++i] : 'true');
  }
  return out;
}

/* ---------- catalogues: the real ones, so the UI renders exactly what the server will send ---------- */

const { KEYS } = await import('../server/catalog/keys.js');
const { SETTINGS } = await import('../server/catalog/settings.js');
const { APPS } = await import('../server/catalog/apps.js');
const SETTING = new Map(SETTINGS.map((s) => [s.key, s]));

/* ---------- fake TV state (flat provenance records, spec §5.1 / §9.4) ---------- */

const now = () => Date.now();
const records = new Map();

function rec(v, meta = {}) {
  return {
    v, src: meta.src ?? 'live', via: meta.via ?? null, at: meta.at ?? now(), ttlMs: meta.ttlMs ?? null, stale: meta.stale ?? false,
    range: meta.range ?? null, options: meta.options ?? null, scope: meta.scope ?? null, pending: null, note: meta.note ?? null,
  };
}

function put(key, v, meta) {
  const r = rec(v, meta);
  records.set(key, r);
  return r;
}

const EXTRA_APPS = [
  { id: '3201608010191', name: 'Samsung TV Plus', color: '#1428A0', short: 'TV+' },
  { id: 'org.tizen.emanual', name: 'e-Manual', color: '#4B5563', short: 'e' },
  { id: '3201707014448', name: 'Samsung Health', color: '#00B3E3', short: 'H' },
  { id: '3201811017267', name: 'Art Store', color: '#9B7B5B', short: 'Art' },
  { id: '3202008021439', name: 'Disney+ Hotstar Kids', color: '#0F1D6B', short: 'K' },
  { id: '3201909019271', name: 'Universal Guide', color: '#3A3F4B', short: 'UG' },
];
const ICON_APPS = new Set(['3201907018807', '111299001912', '3201606009684']);

function seed() {
  const scopeNow = () => ({ input: records.get('input.source')?.v ?? 'TV', mode: records.get('picture.mode')?.v ?? 'Standard' });
  const ipc = (method, extra = {}) => ({ via: `ipc:${method}`, ttlMs: 10000, ...extra });
  const agent = (field) => ({ src: 'agent', via: `agent:${field}`, ttlMs: 15000 });

  put('conn.tv', SCENARIO === 'standby' ? 'standby' : 'on', { via: 'rest', ttlMs: 30000 });
  put('power.state', records.get('conn.tv').v, { via: 'rest', ttlMs: 30000 });
  put('conn.remote', SCENARIO === 'unpaired' ? 'unpaired' : 'paired', { via: 'remote' });
  put('conn.upnp', 'ok', { via: 'upnp' });
  put('conn.events', 'push', { via: 'gena' });
  put('conn.ipc', SCENARIO === 'unpaired' ? 'unpaired' : 'paired', { via: 'ipc' });
  put('conn.agent', 'online', { src: 'agent', via: 'agent' });
  put('conn.latency.rest', 38, { src: 'derived', via: 'rest' });
  put('conn.latency.upnp', 21, { src: 'derived', via: 'upnp' });
  put('conn.latency.ipc', 64, { src: 'derived', via: 'ipc' });

  put('device.name', '[TV] Samsung Q95TA 55', { via: 'rest:/api/v2/', ttlMs: 60000 });
  put('device.modelName', 'QA55Q95TAKXXL', { via: 'rest:/api/v2/', ttlMs: 60000 });
  put('device.model', '20_NIKEM_QTV', { via: 'rest:/api/v2/', ttlMs: 60000 });
  put('device.os', 'Tizen', { via: 'rest:/api/v2/', ttlMs: 60000 });
  put('device.platform', 'Tizen 5.5', { src: 'derived', via: 'rest:/api/v2/' });
  put('device.year', '2020', { src: 'derived', via: 'rest:/api/v2/' });
  put('device.firmware', 'TIZEN-TRUNK2020-NikeM-HOTFIX-RELEASE_20260703.2', agent('build'));
  put('device.resolution', '3840x2160', { via: 'rest:/api/v2/', ttlMs: 60000 });
  put('device.panel', { w: 3840, h: 2160 }, agent('panel'));
  put('device.networkType', 'wireless', { via: 'rest:/api/v2/', ttlMs: 60000 });
  put('device.language', 'en_IN', { via: 'rest:/api/v2/', ttlMs: 60000 });
  put('device.country', 'IN', { via: 'rest:/api/v2/', ttlMs: 60000 });
  put('device.developerMode', true, { via: 'rest:/api/v2/', ttlMs: 60000 });
  put('device.frameTV', false, { via: 'rest:/api/v2/', ttlMs: 60000 });

  put('audio.volume', 2, { via: 'gena', ttlMs: 1800000, range: [0, 100] });
  put('audio.mute', false, { via: 'gena', ttlMs: 1800000 });
  put('audio.soundMode', 'Amplify', ipc('soundModeControl', { options: SETTING.get('audio.soundMode')?.options }));
  put('audio.speaker', 'Internal', ipc('speakerSelectControl'));
  put('audio.outputCodec', 'PCM', agent('audio'));

  put('input.source', 'TV', ipc('getTVStates'));
  put('picture.mode', SCENARIO === 'dynamic' ? 'Dynamic' : 'Standard', ipc('pictureModeControl'));
  const pic = {
    'picture.size': '16:9', 'picture.backlight': 10, 'picture.contrast': 50, 'picture.shadowDetail': 2, 'picture.sharpness': 7,
    'picture.color': 25, 'picture.tint': 0, 'picture.colorTone': 'Standard', 'picture.localDimming': 'High',
    'picture.contrastEnhancer': 'High', 'picture.clarity': 'Off', 'picture.blurReduction': 0, 'picture.judderReduction': 0,
    'picture.ledClearMotion': 'Off', 'picture.noiseReduction': 'Off', 'picture.filmMode': 'Off', 'picture.gammaMode': 'BT.1886',
    'picture.gamma': 0, 'picture.colorSpace': 'Auto',
    'picture.whiteBalance': { 'R-Gain': 0, 'G-Gain': 0, 'B-Gain': 0, 'R-Offset': 0, 'G-Offset': 0, 'B-Offset': 0 },
  };
  for (const [key, v] of Object.entries(pic)) {
    const s = SETTING.get(key);
    put(key, v, ipc(s?.ipc?.method ?? 'getVideoStates', { range: s?.range ?? null, options: s?.options ?? null, scope: s?.scoped ? scopeNow() : null }));
  }

  put('input.connected', ['TV', 'HDMI1'], agent('connected'));
  put('input.available', ['TV', 'HDMI1', 'HDMI2', 'HDMI3', 'HDMI4', 'AV1'], agent('connected'));
  put('input.labels', { HDMI1: 'PlayStation 5' }, { src: 'tracked', via: 'user', at: now() - 3 * 3600e3 });
  put('channel.current', { name: 'Ace TV', number: 1927, type: 'TVPLUS' }, agent('channel'));
  put('app.foreground', SCENARIO === 'netflix' ? { id: '3201907018807', name: 'Netflix' } : null, { via: 'rest:applications', ttlMs: 20000 });
  put('app.installed', [...APPS, ...EXTRA_APPS].map((a) => ({ id: a.id, name: a.name, color: a.color, ...(ICON_APPS.has(a.id) ? { icon: `/api/icon/${a.id}` } : {}) })), agent('apps'));
  put('caption.state', 'off', agent('caption'));
  put('system.cpuLoad', 0.23, agent('system'));
  put('system.memAvailable', 84 * 1024 * 1024, agent('system'));
  put('system.memTotal', 1.97 * 1024 ** 3, agent('system'));
  put('system.storageFree', 1.21 * 1024 ** 3, agent('system'));
  put('system.storageTotal', 3.9 * 1024 ** 3, agent('system'));
  put('ime', { open: false, type: null, text: '', limit: -1 }, { via: 'remote' });
  put('touch.enabled', false, { via: 'remote' });
  put('sleep', null, { src: 'derived', via: 'sleep' });
  put('cast.session', null, { src: 'derived', via: 'cast' });
  for (const [key, v] of Object.entries({ 'browser.session': 'off', 'browser.error': null, 'browser.url': null, 'browser.title': null, 'browser.loading': false, 'browser.canGoBack': false, 'browser.canGoForward': false })) {
    put(key, v, { src: 'derived', via: 'browser' });
  }
  put('general.gameMode', 'Auto', { src: 'tracked', via: 'user', at: new Date('2026-10-21T19:40:00').getTime() });
  put('scenes', [
    { id: 'night', name: 'Night', steps: [{ cmd: 'setting.set', key: 'picture.backlight', value: 4 }, { cmd: 'volume.set', value: 8 }, { cmd: 'setting.set', key: 'audio.soundMode', value: 'Standard' }], createdAt: now() },
    { id: 'cinema', name: 'Cinema', steps: [{ cmd: 'setting.set', key: 'picture.mode', value: 'Movie' }, { cmd: 'setting.set', key: 'picture.backlight', value: 8 }, { cmd: 'setting.set', key: 'picture.localDimming', value: 'High' }], createdAt: now() },
  ], { src: 'derived', via: 'scenes' });
  put('macros', [
    { id: 'macro-menu-picture', name: 'Picture menu', steps: [{ key: 'KEY_MENU', gapMs: 0 }, { key: 'KEY_DOWN', gapMs: 800 }, { key: 'KEY_ENTER', gapMs: 300 }], createdAt: now() },
  ], { src: 'derived', via: 'macros' });
}
seed();

const snapshot = () => Object.fromEntries(records);

/* ---------- clients ---------- */

const clients = new Set();
const received = [];
const send = (ws, msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
const broadcast = (msg) => { for (const ws of clients) send(ws, msg); };

// entries: [key, value, metaOverrides]; provenance of an existing record is kept unless overridden.
function patch(entries) {
  const out = {};
  for (const [key, v, meta] of entries) {
    const prev = records.get(key);
    out[key] = put(key, v, { ...(prev ? keepMeta(prev) : {}), ...meta, at: now(), stale: false });
  }
  broadcast({ t: 'patch', patch: out });
}

const keepMeta = (r) => ({ src: r.src, via: r.via, ttlMs: r.ttlMs, range: r.range, options: r.options, scope: r.scope });
const value = (key) => records.get(key)?.v;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (lo, hi) => lo + Math.round(Math.random() * (hi - lo));

class Fail extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ---------- fake Lumen browser (spec §11.3): wireframe PNG frames, no Edge needed ---------- */

const HEADER = 64;
const browser = {
  session: 'off', error: null, url: null, title: null, loading: false, history: [], index: -1,
  w: 1280, h: 800, scroll: 0, typed: '', focus: false, seq: 0, dirty: true, frameAt: 0, loadTimer: null,
};
const presence = new Map(); // ws → { name, visible, sent, acked }
const BROWSER_META = { src: 'derived', via: 'browser' };

function publishBrowser() {
  patch([
    ['browser.session', browser.session, BROWSER_META], ['browser.error', browser.error, BROWSER_META],
    ['browser.url', browser.url, BROWSER_META], ['browser.title', browser.title, BROWSER_META],
    ['browser.loading', browser.loading, BROWSER_META],
    ['browser.canGoBack', browser.index > 0, BROWSER_META],
    ['browser.canGoForward', browser.index < browser.history.length - 1, BROWSER_META],
  ]);
}

function browserUrl(url) {
  if (!url) throw new Fail('INVALID', 'No page to open');
  let u;
  try { u = new URL(String(url)); } catch { throw new Fail('INVALID', 'That is not a valid address'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Fail('INVALID', 'Only http and https pages can open');
  return u.href;
}

function fakeTitle(u) {
  const host = u.hostname.replace(/^www\./, '');
  const q = u.searchParams.get('q');
  if (q) return `${q} at ${host}`;
  if (host === 'example.com') return 'Example Domain';
  const name = host.split('.')[0].replace(/^./, (c) => c.toUpperCase());
  const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '').replace(/[-_]/g, ' ');
  return seg ? `${seg.replace(/^./, (c) => c.toUpperCase())} — ${name}` : `${name} — Home`;
}

function browserNavigate(url, { push = true } = {}) {
  if (push) {
    browser.history = [...browser.history.slice(0, browser.index + 1), url];
    browser.index = browser.history.length - 1;
  }
  Object.assign(browser, { url, title: null, loading: true, scroll: 0, typed: '', focus: false, dirty: true });
  publishBrowser();
  clearTimeout(browser.loadTimer);
  browser.loadTimer = setTimeout(() => {
    Object.assign(browser, { loading: false, title: fakeTitle(new URL(url)), dirty: true });
    publishBrowser();
  }, 700);
}

// Page geometry in frame pixels; content y values are page coordinates below the fixed header.
function pageLayout() {
  const { w } = browser;
  const pad = Math.round(w * 0.05);
  const colW = Math.floor((w - pad * 2 - 48) / 3);
  return {
    pad,
    nav: ['news', 'topics', 'about'].map((to, i) => ({ to, x: w - pad - (3 - i) * 100 + 12, y: 19, w: 88, h: 26 })),
    hero: { h: 300 },
    search: { x: pad, y: 330, w: w - pad * 2 - 110, h: 50 },
    searchBtn: { x: w - pad - 100, y: 330, w: 100, h: 50 },
    cards: [0, 1, 2].map((i) => ({ to: `story-${i + 1}`, x: pad + i * (colW + 24), y: 420, w: colW, h: 230 })),
    paras: { y: 690, lines: 26 },
    height: 690 + 26 * 26 + 180,
  };
}

const search = (q) => browserNavigate(`https://duckduckgo.com/?q=${encodeURIComponent(q)}`);

function browserInput(ev) {
  if (browser.session !== 'ready' || !browser.url) return;
  const L = pageLayout();
  const hit = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  const scrollBy = (dy) => {
    const max = Math.max(0, L.height - (browser.h - HEADER));
    browser.scroll = Math.max(0, Math.min(max, browser.scroll + dy));
  };
  browser.dirty = true;
  if (ev.kind === 'wheel') scrollBy(Number(ev.deltaY) || 0);
  else if (ev.kind === 'click' || ev.kind === 'down') {
    if (ev.button && ev.button !== 'left') return;
    const x = Number(ev.x);
    const y = Number(ev.y);
    const origin = new URL(browser.url).origin;
    if (y < HEADER) {
      const link = L.nav.find((r) => hit(r, x, y));
      if (link) browserNavigate(`${origin}/${link.to}`);
      return;
    }
    const py = y - HEADER + browser.scroll;
    const card = L.cards.find((r) => hit(r, x, py));
    if (card) { browserNavigate(`${origin}/${card.to}`); return; }
    if (hit(L.searchBtn, x, py) && browser.typed) { search(browser.typed); return; }
    browser.focus = hit(L.search, x, py);
  } else if (ev.kind === 'text') {
    browser.typed = (browser.typed + String(ev.text || '')).slice(0, 80);
    browser.focus = true;
  } else if (ev.kind === 'key') {
    if (ev.key === 'Backspace') browser.typed = browser.typed.slice(0, -1);
    else if (ev.key === 'Enter' && browser.typed) search(browser.typed);
    else if (ev.key === 'PageDown' || ev.key === 'PageUp') scrollBy(ev.key === 'PageDown' ? browser.h - HEADER - 40 : -(browser.h - HEADER - 40));
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') scrollBy(ev.key === 'ArrowDown' ? 60 : -60);
  }
}

const BROWSER_COMMANDS = {
  'browser.open': async ({ url }) => {
    const href = browserUrl(url);
    if (browser.session !== 'ready') {
      Object.assign(browser, { session: 'starting', error: null });
      publishBrowser();
      await sleep(900);
      browser.session = 'ready';
    }
    browserNavigate(href);
    return { value: { url: href } };
  },
  'browser.nav': ({ action }) => {
    if (browser.session !== 'ready') throw new Fail('UNAVAILABLE', 'The browser is not running');
    if (action === 'back' && browser.index > 0) { browser.index -= 1; browserNavigate(browser.history[browser.index], { push: false }); }
    else if (action === 'forward' && browser.index < browser.history.length - 1) { browser.index += 1; browserNavigate(browser.history[browser.index], { push: false }); }
    else if (action === 'reload' && browser.url) browserNavigate(browser.url, { push: false });
    else if (action === 'stop') {
      clearTimeout(browser.loadTimer);
      Object.assign(browser, { loading: false, title: browser.title || fakeTitle(new URL(browser.url)), dirty: true });
      publishBrowser();
    } else if (action === 'home') browserNavigate('https://duckduckgo.com/');
    return {};
  },
  'browser.input': (ev) => { browserInput(ev); return {}; },
  'browser.viewport': ({ w, h }) => {
    const nw = Math.max(320, Math.min(1280, Math.round(Number(w) || 0)));
    const nh = Math.max(320, Math.min(800, Math.round(Number(h) || 0)));
    if (nw !== browser.w || nh !== browser.h) Object.assign(browser, { w: nw, h: nh, dirty: true });
    return { value: { w: nw, h: nh } };
  },
  'browser.ack': ({ seq }, ws) => {
    const p = presence.get(ws);
    if (p) p.acked = Math.max(p.acked, Number(seq) || 0);
    return {};
  },
  'browser.close': () => {
    clearTimeout(browser.loadTimer);
    Object.assign(browser, { session: 'off', error: null, url: null, title: null, loading: false, history: [], index: -1, scroll: 0, typed: '', focus: false });
    publishBrowser();
    return {};
  },
  'browser.openOnTv': async ({ url }) => {
    requireOn();
    const href = browserUrl(url || browser.url);
    await sleep(500);
    return { value: { url: href, method: 'view' } };
  },
};

// 5×7 bitmap font, one base-32 digit per row (bit 16 = leftmost column); uppercase only.
const FONT = {
  A: 'ehhvhhh', B: 'uhhuhhu', C: 'fgggggf', D: 'uhhhhhu', E: 'vgguggv', F: 'vgguggg', G: 'fggnhhf', H: 'hhhvhhh', I: 'v44444v', J: '72222ic',
  K: 'hikokih', L: 'ggggggv', M: 'hrllhhh', N: 'hpljhhh', O: 'ehhhhhe', P: 'uhhuggg', Q: 'ehhhlid', R: 'uhhukih', S: 'fgge11u', T: 'v444444',
  U: 'hhhhhhe', V: 'hhhhha4', W: 'hhhllla', X: 'hha4ahh', Y: 'hha4444', Z: 'v1248gv',
  0: 'ehjlphe', 1: '4c4444e', 2: 'eh1248v', 3: 'v2421he', 4: '26aiv22', 5: 'vgu11he', 6: '68guhhe', 7: 'v124888', 8: 'ehhehhe', 9: 'ehhf12c',
  '.': '00000cc', '-': '000v000', '/': '122488g', ':': '0cc0cc0', '?': 'eh12404', '=': '00v0v00', '_': '000000v', ' ': '0000000',
};

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))));
}
const hostHue = (host) => [...host].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 0);

function raster(w, h) {
  const px = Buffer.alloc(w * h * 3, 0xff);
  const rect = (x, y, rw, rh, [r, g, b]) => {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(w, Math.round(x + rw));
    const y1 = Math.min(h, Math.round(y + rh));
    for (let yy = y0; yy < y1; yy++) {
      let i = (yy * w + x0) * 3;
      for (let xx = x0; xx < x1; xx++) { px[i++] = r; px[i++] = g; px[i++] = b; }
    }
  };
  const gradient = (x, y, rw, rh, c0, c1) => {
    const y0 = Math.round(y);
    const y1 = Math.round(y + rh);
    for (let yy = Math.max(0, y0); yy < Math.min(h, y1); yy++) rect(x, yy, rw, 1, mix(c0, c1, (yy - y0) / Math.max(1, y1 - y0)));
  };
  const text = (str, x, y, size, color) => {
    let cx = x;
    for (const ch of String(str).toUpperCase()) {
      const glyph = FONT[ch] || FONT['?'];
      for (let row = 0; row < 7; row++) {
        const bits = parseInt(glyph[row], 32);
        for (let col = 0; col < 5; col++) if (bits & (16 >> col)) rect(cx + col * size, y + row * size, size, size, color);
      }
      cx += 6 * size;
    }
    return cx - x;
  };
  return { px, rect, gradient, text };
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgb, w, h) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 3 })), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderPage() {
  const { w, h, scroll } = browser;
  const u = new URL(browser.url);
  const host = u.hostname.replace(/^www\./, '');
  const hue = hostHue(host);
  const brand = hsl(hue, 0.55, 0.48);
  const deep = hsl(hue, 0.6, 0.28);
  const white = [255, 255, 255];
  const ink = [31, 36, 48];
  const grey = [205, 208, 215];
  const line = [228, 230, 235];
  const soft = [243, 244, 247];
  const R = raster(w, h);
  const L = pageLayout();
  const py = (y) => HEADER + y - scroll;

  R.gradient(0, py(0), w, L.hero.h, brand, deep);
  R.rect(L.pad, py(80), Math.round(w * 0.46), 30, white);
  R.rect(L.pad, py(124), Math.round(w * 0.34), 14, mix(brand, white, 0.7));
  R.rect(L.pad, py(146), Math.round(w * 0.28), 14, mix(brand, white, 0.7));
  R.rect(L.pad, py(200), 140, 44, white);
  R.text('EXPLORE', L.pad + 28, py(214), 2, deep);

  const sb = L.search;
  R.rect(sb.x - 1, py(sb.y) - 1, sb.w + 2, sb.h + 2, browser.focus ? brand : line);
  R.rect(sb.x, py(sb.y), sb.w, sb.h, white);
  const typedW = browser.typed ? R.text(browser.typed.slice(-Math.floor((sb.w - 40) / 12)), sb.x + 18, py(sb.y) + 18, 2, ink) : 0;
  if (!browser.typed) R.rect(sb.x + 18, py(sb.y) + 20, Math.min(180, sb.w - 40), 10, line);
  if (browser.focus && browser.seq % 2 === 0) R.rect(sb.x + 18 + typedW + 2, py(sb.y) + 15, 2, 20, brand);
  R.rect(L.searchBtn.x, py(L.searchBtn.y), L.searchBtn.w, L.searchBtn.h, brand);
  R.text('SEARCH', L.searchBtn.x + 15, py(L.searchBtn.y) + 18, 2, white);

  L.cards.forEach((c, i) => {
    const cardHue = (hue + 40 + i * 60) % 360;
    R.rect(c.x, py(c.y), c.w, c.h, soft);
    R.gradient(c.x, py(c.y), c.w, 120, hsl(cardHue, 0.5, 0.62), hsl(cardHue, 0.5, 0.42));
    R.rect(c.x + 16, py(c.y) + 138, c.w - 32, 14, ink);
    R.rect(c.x + 16, py(c.y) + 162, Math.max(20, c.w - 60), 10, grey);
    R.rect(c.x + 16, py(c.y) + 180, Math.max(20, c.w - 90), 10, grey);
    R.text(`STORY ${i + 1}`, c.x + 16, py(c.y) + 200, 2, brand);
  });

  for (let i = 0; i < L.paras.lines; i++) {
    const y = py(L.paras.y + i * 26);
    if (y < HEADER - 12 || y > h) continue;
    const width = i % 7 === 6 ? w * 0.4 : w * (0.72 + ((i * 37) % 23) / 100);
    R.rect(L.pad, y, Math.min(w - L.pad * 2, width), 10, i % 7 === 0 ? ink : grey);
  }
  R.rect(0, py(L.height - 140), w, 140, ink);
  R.text(host, L.pad, py(L.height - 90), 2, white);

  R.rect(0, 0, w, HEADER, [23, 26, 36]);
  R.rect(L.pad, 18, 28, 28, brand);
  R.text(host, L.pad + 40, 20, 2, white);
  R.text(`${u.pathname}${u.search}`.slice(0, 60), L.pad + 40, 42, 1, [150, 155, 170]);
  for (const n of L.nav) {
    R.rect(n.x, n.y, n.w, n.h, [40, 45, 58]);
    R.text(n.to, n.x + 10, n.y + 6, 2, [200, 204, 214]);
  }
  if (w >= 760) R.text(new Date().toTimeString().slice(0, 8), L.nav[0].x - 120, 25, 2, [150, 155, 170]);
  if (browser.loading) R.rect(0, HEADER - 3, Math.round(w * 0.6), 3, hsl(hue, 0.85, 0.62));
  return encodePng(R.px, w, h).toString('base64');
}

// 5 fps while something changed, a heartbeat frame every 1.5 s otherwise; a client two frames
// behind on acks is skipped until it catches up (the hub's rule).
setInterval(() => {
  if (browser.session !== 'ready' || !browser.url) return;
  const watching = [...presence].filter(([ws, p]) => p.name === 'browser' && p.visible && ws.readyState === ws.OPEN);
  if (!watching.length) return;
  if (!browser.dirty && now() - browser.frameAt < 1500) return;
  const data = renderPage();
  browser.seq += 1;
  browser.dirty = false;
  browser.frameAt = now();
  for (const [ws, p] of watching) {
    if (p.sent - p.acked >= 2) continue;
    p.sent = browser.seq;
    send(ws, { t: 'browser.frame', data, w: browser.w, h: browser.h, seq: browser.seq });
  }
}, 200);

/* ---------- commands ---------- */

const recorders = new Map();
let castTimer = null;

function requireOn() {
  if (value('conn.tv') !== 'on') throw new Fail('TV_OFF', 'The TV is off');
}

function setVolume(v, via = 'ipc:directVolumeControl') {
  const level = Math.max(0, Math.min(VOLUME_CAP, Math.round(v)));
  patch([['audio.volume', level, { src: 'live', via }], ['audio.mute', false, { src: 'live', via }]]);
  return level;
}

function markPicture() {
  const stale = {};
  for (const [key, r] of records) if (key.startsWith('picture.') && key !== 'picture.mode') stale[key] = put(key, r.v, { ...keepMeta(r), at: r.at, stale: true });
  broadcast({ t: 'patch', patch: stale });
  setTimeout(() => {
    const scope = { input: value('input.source'), mode: value('picture.mode') };
    patch([...records.keys()].filter((k) => k.startsWith('picture.') && k !== 'picture.mode').map((k) => [k, value(k), { scope: SETTING.get(k)?.scoped ? scope : null }]));
  }, 900);
}

const COMMANDS = {
  ...BROWSER_COMMANDS,
  view: ({ name, visible }, ws) => {
    // A view change starts with nothing outstanding: the ack window counts from here.
    presence.set(ws, { name, visible: visible !== false, sent: browser.seq, acked: browser.seq });
    browser.dirty = true;
    return {};
  },
  key: async ({ key }, ws) => {
    requireOn();
    recorders.get(ws)?.push({ key, at: now() });
    if (key === 'KEY_VOLUP') setVolume(value('audio.volume') + 1, 'gena');
    if (key === 'KEY_VOLDOWN') setVolume(value('audio.volume') - 1, 'gena');
    if (key === 'KEY_MUTE') patch([['audio.mute', !value('audio.mute'), { via: 'gena' }]]);
    if (key === 'KEY_POWER') setTimeout(() => patch([['conn.tv', 'standby', {}], ['power.state', 'standby', {}]]), 1500);
    return {};
  },
  hold: () => ({}),
  'volume.set': ({ value: v }) => { requireOn(); return { value: setVolume(v) }; },
  'volume.step': ({ delta }) => { requireOn(); return { value: setVolume(value('audio.volume') + delta) }; },
  'mute.set': ({ value: v }) => { requireOn(); patch([['audio.mute', !!v, { via: 'ipc:muteControl' }]]); return { value: !!v }; },
  power: async ({ action }) => {
    if (action === 'off') {
      requireOn();
      setTimeout(() => patch([['conn.tv', 'standby', {}], ['power.state', 'standby', {}]]), 1200);
      return {};
    }
    await sleep(2600);
    patch([['conn.tv', 'on', {}], ['power.state', 'on', {}]]);
    return { value: 'on' };
  },
  'app.launch': async ({ appId }) => {
    requireOn();
    const app = value('app.installed').find((a) => a.id === appId);
    if (!app) throw new Fail('UNAVAILABLE', 'That app is not installed');
    await sleep(700);
    patch([['app.foreground', { id: app.id, name: app.name }, {}]]);
    return { value: { id: app.id, visible: true } };
  },
  'input.set': ({ source }) => {
    requireOn();
    patch([['input.source', source, { via: 'ipc:inputSourceControl' }], ['app.foreground', null, {}]]);
    markPicture();
    return { value: source };
  },
  'setting.set': ({ key, value: v }) => {
    const s = SETTING.get(key);
    if (!s) throw new Fail('INVALID', `Unknown setting ${key}`);
    if (s.type === 'tracked') {
      patch([[key, v, { src: 'tracked', via: 'user' }]]);
      return { value: v };
    }
    requireOn();
    if (s.writable === false) throw new Fail('INVALID', `${s.label} is read-only`);
    if (key.startsWith('picture.') && key !== 'picture.mode' && value('picture.mode') === 'Dynamic') throw new Fail('LOCKED_IN_MODE', `${s.label} cannot be changed in Dynamic mode`);
    if (s.type === 'range') {
      const [lo, hi] = s.range;
      if (typeof v !== 'number' || v < lo || v > hi) throw new Fail('INVALID', `${s.label} must be ${lo}–${hi}`);
    } else if (s.options && !s.options.includes(v)) {
      throw new Fail('INVALID', `${s.label} must be one of ${s.options.join(', ')}`);
    }
    patch([[key, v, { via: `ipc:${s.ipc?.method}` }]]);
    if (key === 'picture.mode') markPicture();
    return { value: v };
  },
  'tracked.set': (cmd) => COMMANDS['setting.set'](cmd),
  'settings.refresh': async () => {
    requireOn();
    await sleep(600);
    patch([...records.keys()].filter((k) => k.startsWith('picture.') || k.startsWith('audio.')).map((k) => [k, value(k), {}]));
    return {};
  },
  'input.label': ({ source, label }) => {
    const labels = { ...(value('input.labels') || {}) };
    if (label) labels[source] = label;
    else delete labels[source];
    patch([['input.labels', labels, { src: 'tracked', via: 'user' }]]);
    return { value: labels };
  },
  'text.send': ({ text: t, submit }) => {
    requireOn();
    const ime = value('ime');
    if (ime?.open) patch([['ime', submit ? { ...ime, open: false, text: t } : { ...ime, text: t }, {}]]);
    return {};
  },
  'pointer.move': () => { if (!value('touch.enabled')) throw new Fail('UNAVAILABLE', 'The TV is not showing a pointer on this screen'); return {}; },
  'pointer.click': () => ({}),
  'sleep.set': ({ minutes }) => {
    patch([['sleep', minutes ? { endsAt: now() + minutes * 60000, minutes } : null, {}]]);
    return {};
  },
  'scene.run': async ({ target: id }, ws) => {
    const scene = value('scenes').find((s) => s.id === id);
    if (!scene) throw new Fail('INVALID', 'No such scene');
    for (const { waitMs, ...step } of scene.steps) {
      await sleep(waitMs ?? 250);
      await COMMANDS[step.cmd]?.(step, ws);
    }
    return {};
  },
  'scene.save': ({ scene }) => {
    const saved = { id: scene.id || `scene-${randomBytes(4).toString('hex')}`, name: scene.name, steps: scene.steps, createdAt: now() };
    patch([['scenes', [...value('scenes').filter((s) => s.id !== saved.id), saved], {}]]);
    return { value: saved };
  },
  'scene.delete': ({ target: id }) => { patch([['scenes', value('scenes').filter((s) => s.id !== id), {}]]); return {}; },
  'macro.record': ({ phase, name }, ws) => {
    if (phase === 'start') { recorders.set(ws, []); return {}; }
    const keys = recorders.get(ws) || [];
    recorders.delete(ws);
    if (!keys.length) throw new Fail('INVALID', 'No keys were recorded');
    const steps = keys.map((k, i) => ({ key: k.key, gapMs: i ? Math.max(150, k.at - keys[i - 1].at) : 0 }));
    const macro = { id: `macro-${randomBytes(4).toString('hex')}`, name: name || 'Macro', steps, createdAt: now() };
    patch([['macros', [...value('macros'), macro], {}]]);
    return { value: macro };
  },
  'macro.run': async () => { requireOn(); await sleep(900); return {}; },
  'macro.delete': ({ target: id }) => { patch([['macros', value('macros').filter((m) => m.id !== id), {}]]); return {}; },
  'agent.connect': async () => {
    requireOn();
    patch([['conn.agent', 'launching', {}]]);
    setTimeout(() => patch([['conn.agent', 'online', {}]]), 2000);
    return {};
  },
  'pair.remote': async () => { requireOn(); await sleep(3000); patch([['conn.remote', 'paired', {}]]); return {}; },
  'pair.ipcontrol': async () => { requireOn(); await sleep(3000); patch([['conn.ipc', 'paired', {}]]); return {}; },
  'cast.url': async ({ url }) => {
    requireOn();
    const u = new URL(url);
    if (/youtu/.test(u.hostname)) return startCast({ kind: 'dial', title: 'YouTube video', uri: url });
    if (/netflix/.test(u.hostname)) return startCast({ kind: 'dial', title: 'Netflix title', uri: url });
    if (/\.(mp4|mkv|webm|mp3|m4a|flac|jpg|png|m3u8)$/i.test(u.pathname)) {
      return startCast({ kind: 'dlna', title: decodeURIComponent(u.pathname.split('/').pop()), uri: url, duration: 5520 });
    }
    // Any other page opens in the Lumen browser (spec §11.3); Open on TV lives in that view.
    await BROWSER_COMMANDS['browser.open']({ url });
    return { value: { kind: 'browser', url } };
  },
  'cast.file': ({ name }) => { requireOn(); return startCast({ kind: 'dlna', title: name, uri: null, duration: 1325 }); },
  'cast.control': ({ action, position }) => {
    const s = value('cast.session');
    if (!s || s.kind !== 'dlna') throw new Fail('INVALID', 'That cast is controlled with the TV remote');
    const next = { ...s };
    if (action === 'play') next.state = 'PLAYING';
    if (action === 'pause') next.state = 'PAUSED_PLAYBACK';
    if (action === 'stop') { next.state = 'STOPPED'; next.position = 0; }
    if (action === 'seek') next.position = position;
    patch([['cast.session', next, { src: 'live', via: 'avtransport' }]]);
    return { value: next };
  },
  'ai.ask': ({ id, text }, ws) => { fakeAsk(ws, id, text); return { value: { id } }; },
  'ai.cancel': ({ target }, ws) => { aiRuns.get(target)?.abort(); send(ws, { t: 'ai', id: target, kind: 'error', code: 'CANCELLED', message: 'Cancelled' }); send(ws, { t: 'ai', id: target, kind: 'done', ok: false }); return {}; },
};

function startCast(session) {
  const s = { state: 'PLAYING', position: session.kind === 'dlna' ? 0 : null, duration: session.duration ?? null, ...session };
  patch([['cast.session', s, { src: s.kind === 'dlna' ? 'live' : 'derived', via: s.kind === 'dlna' ? 'avtransport' : 'dial' }]]);
  clearInterval(castTimer);
  if (s.kind === 'dlna') {
    castTimer = setInterval(() => {
      const cur = value('cast.session');
      if (!cur || cur.state !== 'PLAYING') return;
      patch([['cast.session', { ...cur, position: Math.min(cur.duration, (cur.position ?? 0) + 1) }, {}]]);
    }, 1000);
  }
  return { value: s };
}

/* ---------- fake Ask Lumen ---------- */

const aiRuns = new Map();

async function fakeAsk(ws, id, text) {
  const ctrl = new AbortController();
  aiRuns.set(id, ctrl);
  const emit = async (ms, event) => {
    await sleep(ms);
    if (ctrl.signal.aborted) throw new Error('cancelled');
    send(ws, { t: 'ai', id, ...event });
  };
  const started = now();
  try {
    const q = text.toLowerCase();
    await emit(250, { kind: 'status', text: 'Thinking…' });
    await emit(500, { kind: 'status', text: 'Running get_tv_state…' });
    await emit(450, { kind: 'tool', name: 'get_tv_state', input: '', ok: true, result: `On · ${value('input.source')} · volume ${value('audio.volume')} · ${value('picture.mode')}` });
    let answer;
    if (/bright/.test(q)) {
      const from = value('picture.backlight');
      const to = Math.min(50, from + 5);
      await emit(400, { kind: 'status', text: 'Running change_setting…' });
      await COMMANDS['setting.set']({ key: 'picture.backlight', value: to });
      await emit(300, { kind: 'tool', name: 'change_setting', input: 'key=picture.backlight, delta=5', ok: true, result: `Brightness ${from} → ${to}` });
      answer = `Brightness ${from} → ${to}.`;
    } else if (/netflix|friends/.test(q)) {
      await emit(500, { kind: 'status', text: 'Searching the web…' });
      await emit(900, { kind: 'tool', name: 'web_search', input: 'query=Friends netflix.com title', ok: true, result: '3 results' });
      await emit(300, { kind: 'text', text: 'Friends is Netflix title 70153404.' });
      await emit(500, { kind: 'tool', name: 'open_netflix', input: 'titleId=70153404', ok: true, result: 'Netflix opened on title 70153404' });
      answer = 'Opened Friends on Netflix.';
    } else if (/sleep/.test(q)) {
      const minutes = Number(/(\d+)/.exec(q)?.[1] ?? 30);
      COMMANDS['sleep.set']({ minutes });
      await emit(400, { kind: 'tool', name: 'sleep_timer', input: `minutes=${minutes}`, ok: true, result: `Sleep timer ${minutes} min` });
      answer = `The TV will turn off in ${minutes} minutes.`;
    } else if (/cinema/.test(q)) {
      await COMMANDS['scene.run']({ target: 'cinema' }, ws);
      await emit(300, { kind: 'tool', name: 'run_scene', input: 'name=Cinema', ok: true, result: 'Cinema: 3 steps applied' });
      answer = 'Cinema scene applied: Movie mode, brightness 8, local dimming High.';
    } else if (/hdmi/.test(q)) {
      await emit(300, { kind: 'tool', name: 'set_input', input: 'source=HDMI1', ok: true, result: 'Input TV → HDMI1' });
      COMMANDS['input.set']({ source: 'HDMI1' });
      answer = 'Switched to HDMI 1 (PlayStation 5).';
    } else {
      answer = `The TV is on ${value('input.source') === 'TV' ? `Ace TV (Samsung TV Plus, ch 1927)` : value('input.source')}, volume ${value('audio.volume')}, picture mode ${value('picture.mode')}.`;
    }
    await emit(350, { kind: 'result', text: answer });
    await emit(50, { kind: 'done', ok: true, ms: now() - started });
  } catch {
    /* cancelled: ai.cancel already answered */
  } finally {
    aiRuns.delete(id);
  }
}

/* ---------- HTTP ---------- */

const csp = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ws://${HOST}:${PORT} ws://localhost:${PORT}`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function iconSvg(app) {
  const glyph = app.id === '111299001912'
    ? '<path d="M128 104v96l84-48z" fill="#fff"/>'
    : app.id === '3201606009684'
      ? '<g fill="none" stroke="#000" stroke-width="16" stroke-linecap="round"><path d="M78 118c40-14 96-12 140 10"/><path d="M88 154c34-10 78-8 112 8"/><path d="M98 188c26-7 58-6 84 6"/></g>'
      : '<text x="152" y="200" font-family="Georgia, serif" font-weight="700" font-size="150" text-anchor="middle" fill="#fff">N</text>';
  const bg = app.id === '3201606009684' ? '#1DB954' : app.id === '111299001912' ? '#FF0000' : '#000';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 304 304"><rect width="304" height="304" fill="${bg}"/>${app.id === '3201907018807' ? '<rect width="304" height="304" fill="#141414"/>' : ''}${glyph}</svg>`;
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(WEB, rel);
  if (!file.startsWith(WEB + path.sep) || rel.split('/').some((p) => p.startsWith('.'))) return reply(res, 404, 'Not found');
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Security-Policy': csp, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    if (!path.extname(rel)) return serveStatic(req, res, '/');
    reply(res, 404, 'Not found');
  }
}

function reply(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  if (p === '/api/health') return reply(res, 200, { ok: true, dev: true, scenario: SCENARIO });
  if (p.startsWith('/api/icon/')) {
    const id = decodeURIComponent(p.slice('/api/icon/'.length));
    const app = APPS.find((a) => a.id === id);
    if (!app || !ICON_APPS.has(id)) return reply(res, 404, 'No icon');
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=86400' });
    return res.end(iconSvg(app));
  }
  if (p === '/api/cast/upload') {
    if (req.method !== 'POST') return reply(res, 405, 'Method not allowed');
    if (req.headers['x-lumen-csrf'] !== CSRF) return reply(res, 403, { error: { code: 'INVALID', message: 'Bad CSRF token' } });
    const name = decodeURIComponent(req.headers['x-file-name'] || '');
    if (!name) return reply(res, 400, { error: { code: 'INVALID', message: 'X-File-Name is required' } });
    let size = 0;
    for await (const chunk of req) size += chunk.length;
    if (!size) return reply(res, 400, { error: { code: 'INVALID', message: 'Empty file' } });
    return reply(res, 201, { fileId: randomBytes(16).toString('hex'), name, size, mime: req.headers['content-type'] || 'application/octet-stream' });
  }
  if (p === '/dev/commands') return reply(res, 200, received);
  if (p === '/dev/ime' && req.method === 'POST') {
    const open = url.searchParams.get('open') !== '0';
    patch([['ime', { open, type: 'text', text: open ? 'friends' : '', limit: -1 }, {}]]);
    return reply(res, 200, { ok: true, open });
  }
  if (p === '/dev/browser' && req.method === 'POST') {
    const q = url.searchParams;
    try {
      if (q.get('close')) BROWSER_COMMANDS['browser.close']();
      else if (q.get('error')) {
        clearTimeout(browser.loadTimer);
        Object.assign(browser, { session: 'error', error: q.get('error'), loading: false });
        publishBrowser();
      } else if (q.get('url')) await BROWSER_COMMANDS['browser.open']({ url: q.get('url') });
    } catch (err) {
      return reply(res, 400, { error: { code: err.code || 'FAILED', message: err.message } });
    }
    return reply(res, 200, { ok: true, session: browser.session, url: browser.url, seq: browser.seq, viewport: { w: browser.w, h: browser.h } });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'Method not allowed');
  return serveStatic(req, res, p);
});

const wss = new WebSocketServer({ noServer: true });
const ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${HOST}:${PORT}`);
  if (pathname !== '/live' || !ORIGINS.has(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    send(ws, {
      t: 'hello',
      version: '0.1.0-dev',
      state: snapshot(),
      catalog: { keys: KEYS, settings: SETTINGS, apps: APPS },
      csrf: CSRF,
      ai: SCENARIO === 'unpaired' ? { backend: 'off', ready: false, reason: 'Set ANTHROPIC_API_KEY or run `ant auth login`, or install the Claude Code CLI' } : { backend: 'claude-code', ready: true, reason: null },
    });
    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg?.t !== 'cmd') return;
      received.push({ at: now(), ...msg });
      if (received.length > 300) received.shift();
      const started = now();
      // Presence and the Lumen browser are handled on the PC in the real server: no TV latency,
      // and their order matters (typed text, acks).
      if (msg.cmd !== 'view' && !String(msg.cmd).startsWith('browser.')) await sleep(jitter(60, 220));
      try {
        const run = COMMANDS[msg.cmd];
        if (!run) throw new Fail('INVALID', `Unknown command ${msg.cmd}`);
        const res = (await run(msg, ws)) ?? {};
        send(ws, { t: 'ack', id: msg.id, ok: true, ms: now() - started, ...(res.value !== undefined ? { value: res.value } : {}) });
      } catch (err) {
        send(ws, { t: 'ack', id: msg.id, ok: false, ms: now() - started, error: { code: err.code || 'FAILED', message: err.message } });
      }
    });
    ws.on('close', () => { clients.delete(ws); recorders.delete(ws); presence.delete(ws); });
  });
});

// Pollers: the real adapters keep live and agent records fresh (IP Control 2.5 s, agent 5 s, REST 3 s).
setInterval(() => {
  if (value('conn.tv') !== 'on' || !clients.size) return;
  const fresh = [...records].filter(([, r]) => (r.src === 'live' || r.src === 'agent') && r.ttlMs && Date.now() - r.at > r.ttlMs / 2);
  if (fresh.length) patch(fresh.map(([k, r]) => [k, r.v, {}]));
}, 2500);

// "Physical remote" nudges: a small external volume change every 20 s.
setInterval(() => {
  if (value('conn.tv') !== 'on' || !clients.size) return;
  const from = value('audio.volume');
  const delta = from <= 1 ? 1 : from >= 14 ? -1 : Math.random() < 0.5 ? -1 : 1;
  const to = from + delta * jitter(1, 2);
  patch([['audio.volume', to, { src: 'live', via: 'gena' }]]);
  setTimeout(() => broadcast({ t: 'changedOnTv', key: 'audio.volume', from, to }), 1000);
}, 20000);

server.listen(PORT, HOST, () => {
  console.log(`Lumen UI dev server · http://${HOST}:${PORT} · scenario "${SCENARIO}" (fake TV, nothing leaves this PC)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
