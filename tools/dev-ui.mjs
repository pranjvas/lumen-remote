#!/usr/bin/env node
// Lumen web UI dev server: serves web/ on http://127.0.0.1:8799 (same CSP as server/http.js) with a
// fake /live WebSocket that sends a realistic hello (values from the 2026-10-21 live findings),
// acks every command with plausible TV behaviour, streams fake "Ask Lumen" runs and nudges the
// volume from "the physical remote" every 20 s. It never talks to a TV.
//
//   node tools/dev-ui.mjs [--port 8799] [--scenario live-tv|netflix|standby|unpaired|dynamic]
//   POST /dev/ime?open=1|0   opens/closes the TV keyboard (IME) for every connected tab.
//   GET  /dev/commands       the last 300 commands received over /live (for UI protocol checks).

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
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
  view: () => ({}),
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
  'cast.url': ({ url }) => {
    requireOn();
    const u = new URL(url);
    if (/youtu/.test(u.hostname)) return startCast({ kind: 'dial', title: 'YouTube video', uri: url });
    if (/netflix/.test(u.hostname)) return startCast({ kind: 'dial', title: 'Netflix title', uri: url });
    if (/\.(mp4|mkv|webm|mp3|m4a|flac|jpg|png|m3u8)$/i.test(u.pathname)) {
      return startCast({ kind: 'dlna', title: decodeURIComponent(u.pathname.split('/').pop()), uri: url, duration: 5520 });
    }
    return startCast({ kind: 'browser', title: u.hostname, uri: url });
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
      await sleep(jitter(60, 220));
      try {
        const run = COMMANDS[msg.cmd];
        if (!run) throw new Fail('INVALID', `Unknown command ${msg.cmd}`);
        const res = (await run(msg, ws)) ?? {};
        send(ws, { t: 'ack', id: msg.id, ok: true, ms: now() - started, ...(res.value !== undefined ? { value: res.value } : {}) });
      } catch (err) {
        send(ws, { t: 'ack', id: msg.id, ok: false, ms: now() - started, error: { code: err.code || 'FAILED', message: err.message } });
      }
    });
    ws.on('close', () => { clients.delete(ws); recorders.delete(ws); });
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
