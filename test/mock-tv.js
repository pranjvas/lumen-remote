// Mock Samsung QA55Q95T (2020, Tizen 5.5) for Lumen's tests.
//
// Every channel binds 127.0.0.1 on an ephemeral port and shares one TV state:
//   REST 8001 · remote WSS 8002 · DMR 9197 (RenderingControl, AVTransport, ConnectionManager, GENA)
//   IP Control 1516 (TLS JSON-RPC) · DIAL 8080 · Wake-on-LAN (UDP)
// Payload shapes come from the live captures in test/fixtures/ (see docs/research/2026-10-21-live-findings.md).
// Things a correct client must never do are recorded in `state.violations` instead of being acted on.
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const fixture = (rel) => fs.readFileSync(path.join(FIXTURES, rel), 'utf8');
export const fixtureJson = (rel) => JSON.parse(fixture(rel));

/** The test-only self-signed certificate shared by the WSS and IP Control mocks (generated once with openssl). */
export function testCert() {
  const dir = path.join(FIXTURES, 'tls');
  const keyFile = path.join(dir, 'mock-tv-key.pem');
  const certFile = path.join(dir, 'mock-tv-cert.pem');
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
      '-days', '3650', '-subj', '/CN=Lumen Mock TV (test only)', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'],
    { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

const HOST = '127.0.0.1';
const REMOTE_PATH = '/api/v2/channels/samsung.remote.control';
const DANGER_KEY = /^KEY_(FACTORY|AUTO_ARC_\w+|PANNEL_\w+|EXT\d+|ID_INPUT|ID_SETUP|DTV_SIGNAL|CONVERGENCE|3SPEED|11|12)$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const UPNP_SERVER = 'UPnP/1.0, Samsung AllShare Server/1.0';
const GENA_SERVER = 'UPnP/1.1 Samsung AllShare Server/1.0';

const DEFAULTS = {
  power: 'on',                  // 'on' | 'standby' | 'off'
  remoteToken: '13572468',      // pre-paired WSS token (data/tv.json in tests)
  ipcToken: 'MOCKIPCTOKEN0001', // pre-paired IP Control token (data/ipcontrol.json in tests)
  wifiMac: '02:4c:55:4d:45:4e', // locally administered, never a real device
  allow: true,                  // what the viewer presses on the on-screen Allow prompt
  allowDelayMs: 150,
  rotateToken: false,           // hand out a fresh token on every authorised reconnect
  earlyEvents: true,            // send the touch state before ms.channel.connect, as the TV does
  pingMs: 5000,                 // the TV pings about every 6 s
  initialNotifyDelayMs: 50,
  emptyNotifies: true,          // follow each change NOTIFY with an empty <LastChange/>, as the Q95T does
  dropNotify: false,            // simulate a firewall that swallows inbound NOTIFY
  ipcErrorStyle: 'nested',      // 'nested' {error:{code,message}} | 'flat' {code,message}
  ipcSlotsFull: false,          // createAccessToken → -32011
  ipcFail: {},                  // { [method]: code } forces a JSON-RPC error for that method
  ipcTransform: {},             // { [method]: (requested) => stored } e.g. a firmware clamp, to prove read-back
  standbyIpcPowerOn: true,      // inside the standby window IP Control still accepts powerControl powerOn
  fmmContent: false,            // Filmmaker Mode is only selectable with FMM content
  restDelayMs: 0,
  ipcDelayMs: 0,
  wakeDelayMs: 50,
  mediaDurationS: 600,
  playLockedOnce: true,         // the first Play after SetAVTransportURI answers 705 "Transport is locked"
  dmrFetch: true,               // Play opens the URI like the TV's DLNA reader (HEAD, then a ranged GET)
  dmrFetchDelayMs: 0,           // how long the renderer stays TRANSITIONING before it fetches
  seekLockMs: 200,              // a Seek within this time of the previous one answers 701
  dialAllowed: true,            // this PC is on the TV's allowed-device list (DIAL POST 401 otherwise)
  // Developer mode (server/ai/skills/developer-mode.md), modelled on Samsung's published screens:
  appsPanel: null,              // the REST app id that opens Apps (e.g. 'org.volt.apps'); null → 404, like other system ids
  developerMode: undefined,     // '1' | '0'; undefined → the device fixture ('1')
  developerIP: undefined,       // undefined → the device fixture
  devIpAutoAdvance: true,       // a Host PC IP box jumps to the next one after three digits
  devDigitsOpenIme: false,      // digits on Apps land in a text field (the TV keyboard opens) instead of the code
  model: undefined,             // REST device.model override, e.g. '24_PONTUSM_UHD' for a 2024 TV
  language: undefined,          // REST device.Language override; 'ar_*' / 'he_*' lay the IP boxes out right to left
};

// Picture values are per input × picture mode. TV|Standard starts at the live readings.
const LIVE = fixtureJson('ipc/live-getters.json');
const BASE_PICTURE = {
  backlight: LIVE.backlightControl.backlight,
  contrast: LIVE.getVideoStates.contrast,
  brightness: LIVE.getVideoStates.brightness,
  sharpness: LIVE.getVideoStates.sharpness,
  color: LIVE.getVideoStates.color,
  tint: LIVE.getVideoStates.tint,
  colorTone: LIVE.colorToneControl.colorTone,
  localDimming: LIVE.localDimmingControl.localDimming,
  contrastEnhancer: LIVE.contrastEnhancerControl.contrastEnhancer,
  autoMotionPlus: LIVE.autoMotionPlusControl.autoMotionPlus,
  'AMP.blurReduction': 5,
  'AMP.judderReduction': 5,
  'AMP.LEDClearMotion': 'Off',
  digitalCleanView: LIVE.digitalCleanViewControl.digitalCleanView,
  filmMode: LIVE.filmModeControl.filmMode,
  gammaMode: LIVE.gammaModeControl.gammaMode,
  'gamma.BT1886': 0,
  colorSpace: 'Auto',
  'R-Gain': 0, 'G-Gain': 0, 'B-Gain': 0, 'R-Offset': 0, 'G-Offset': 0, 'B-Offset': 0,
};
const MODE_PICTURE = {
  Dynamic: { backlight: 50, brightness: 0, sharpness: 10, color: 30, colorTone: 'Cool', autoMotionPlus: 'Auto' },
  Standard: {},
  Natural: { backlight: 12, contrast: 45, brightness: 0, sharpness: 5, contrastEnhancer: 'Low' },
  Movie: { backlight: 8, contrast: 45, brightness: 0, sharpness: 0, colorTone: 'Warm2', contrastEnhancer: 'Off' },
  'Filmmaker Mode': { backlight: 8, contrast: 45, brightness: 0, sharpness: 0, colorTone: 'Warm2', contrastEnhancer: 'Off', digitalCleanView: 'Off' },
};
const PICTURE_MODES = Object.keys(MODE_PICTURE);
const INPUTS = ['TV', 'HDMI1', 'HDMI2', 'HDMI3', 'HDMI4', 'AV1'];

const int = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
const oneOf = (...values) => (v) => values.includes(v);

// IP Control picture methods: scoped to input × mode and refused (-32002) in Dynamic.
const PICTURE_METHODS = {
  backlightControl: ['backlight', int(0, 50)],
  contrastControl: ['contrast', int(0, 50)],
  brightnessControl: ['brightness', int(-5, 5)],
  sharpnessControl: ['sharpness', int(0, 20)],
  colorControl: ['color', int(0, 50)],
  tintControl: ['tint', int(-50, 50)],
  colorToneControl: ['colorTone', oneOf('Cool', 'Standard', 'Warm1', 'Warm2')],
  localDimmingControl: ['localDimming', oneOf('Low', 'Standard', 'High')],
  contrastEnhancerControl: ['contrastEnhancer', oneOf('Off', 'Low', 'High')],
  autoMotionPlusControl: ['autoMotionPlus', oneOf('Off', 'Auto', 'Custom')],
  'AMP.blurReductionControl': ['AMP.blurReduction', int(0, 10), { customOnly: true }],
  'AMP.judderReductionControl': ['AMP.judderReduction', int(0, 10), { customOnly: true }],
  'AMP.LEDClearMotionControl': ['AMP.LEDClearMotion', oneOf('Off', 'On')],
  digitalCleanViewControl: ['digitalCleanView', oneOf('Off', 'Auto')],
  filmModeControl: ['filmMode', oneOf('Off', 'Auto')],
  gammaModeControl: ['gammaMode', oneOf('BT.1886', 'ST.2084', 'HLG', '2.20')],
  'gamma.BT1886Control': ['gamma.BT1886', int(-3, 3)],
  colorSpaceControl: ['colorSpace', oneOf('Auto', 'Native', 'Custom')],
};
const WB_FIELDS = ['R-Gain', 'G-Gain', 'B-Gain', 'R-Offset', 'G-Offset', 'B-Offset'];
const IPC_2025_ONLY = new Set(['gameModeControl', 'brightnessOptimizationControl', 'energySavingSolutionControl',
  'motionLightingControl', 'autoPowerSavingControl', 'autoPowerOffControl', 'HDRToneMappingControl',
  'peakBrightnessControl', 'colorBoosterControl', 'applyPictureSettingsControl', 'getDeviceInformation']);
const IPC_MESSAGES = {
  [-32700]: 'Parse error', [-32601]: 'Method not found', [-32602]: 'Invalid params', [-32002]: 'Failed',
  [-32003]: 'Invalid operation', [-32010]: 'Unauthorized', [-32011]: 'All AccessToken occupied',
};

const DIAL_APPS = {
  Netflix: { appId: '3201907018807', version: '80.25.23140' },
  YouTube: { appId: '111299001912', version: '2.1.498' },
  AmazonInstantVideo: { appId: '3201910019365', version: '5.3.21' },
};
const EXTRA_APPS = [ // installed on the Q95T but timed out in the capture; versions from the research report
  { id: '111299001912', name: 'YouTube', running: true, version: '2.1.498', visible: false },
  { id: '3201910019365', name: 'Prime Video', running: true, version: '5.3.21', visible: false },
  { id: 'lumenrmt01.LumenAgent', name: 'Lumen Agent', running: false, version: '0.1.0', visible: false },
];

const BROWSER_APP = '3201907018784'; // Internet; remote-server also accepts its package id for launches
const BROWSER_PACKAGE = 'org.tizen.browser';
const DIAL_MAX_BODY = 4096;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlDecode = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const fromB64 = (s) => Buffer.from(String(s ?? ''), 'base64').toString('utf8');

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function parseTime(text) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?$/.exec(String(text).trim());
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}

export function parseMagicPacket(buf) {
  if (buf.length < 102 || !buf.subarray(0, 6).every((b) => b === 0xff)) return null;
  const mac = buf.subarray(6, 12);
  for (let i = 1; i < 16; i++) if (!buf.subarray(6 + i * 6, 12 + i * 6).equals(mac)) return null;
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join(':');
}

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const lastChange = (inner) => '<?xml version="1.0" encoding="utf-8"?>\r\n<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property>'
  + (inner == null ? '<LastChange/>' : `<LastChange>${xmlEscape(inner)}</LastChange>`) + '</e:property>\r\n</e:propertyset>\r\n';

class UpnpFault extends Error {
  constructor(code, description) { super(description); this.upnpCode = code; }
}
class RpcError extends Error {
  constructor(code) { super(IPC_MESSAGES[code] ?? 'Error'); this.rpcCode = code; }
}

export async function startMockTv(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  opts.ipcFail = { ...opts.ipcFail };
  opts.ipcTransform = { ...opts.ipcTransform };
  const events = new EventEmitter();
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };

  const apps = new Map([...fixtureJson('rest/apps.json'), ...EXTRA_APPS].map((a) => [a.id, { ...a }]));
  if (opts.appsPanel) apps.set(opts.appsPanel, { id: opts.appsPanel, name: 'Apps', running: false, version: '1.0.0', visible: false });
  const deviceFixture = fixtureJson('rest/device.json').device;
  const state = {
    power: opts.power,
    volume: LIVE.getTVStates.volume,
    mute: LIVE.getTVStates.mute === 'muteOn',
    input: LIVE.getTVStates.inputSource,
    pictureMode: LIVE.getTVStates.pictureMode,
    pictureSize: LIVE.getTVStates.pictureSize,
    soundMode: LIVE.getTVStates.soundMode,
    speaker: LIVE.speakerSelectControl.speakerSelect,
    // Bluetooth speakers the TV has connected (externalSpeakerControl); bt: the one the sound goes to.
    btSpeakers: [],
    bt: null,
    picture: { ...BASE_PICTURE },
    pictureScopes: new Map(),
    apps,
    keys: [],          // { key, cmd, at } for every SendRemoteKey
    pressed: new Set(),
    texts: [],         // decoded SendInputString payloads
    inputEnds: 0,
    pointer: [],       // { cmd, x?, y?, accepted }
    ime: { open: false, type: null, text: '', limit: 0 },
    touch: false,
    // Developer mode: the saved setting (what REST reports), the box while it is open
    // ({ on, ip: [4 strings], row 0 On/Off · 1 IP boxes · 2 OK/Cancel, col, fresh }), the notice after OK.
    dev: {
      mode: opts.developerMode ?? deviceFixture.developerMode,
      ip: opts.developerIP ?? deviceFixture.developerIP,
      dialog: null, notice: false, code: '', opened: 0, saved: 0, cancelled: 0,
    },
    avtransport: {
      uri: '', metadata: '', state: 'NO_MEDIA_PRESENT', status: 'OK', positionS: 0, durationS: 0, playingSince: null,
      image: false, playLocked: false, lastSeekAt: 0, generation: 0, stoppedReason: '', stoppedReasonData: '',
      actions: [],     // every AVTransport action, with the parsed DIDL for SetAVTransportURI
      fetches: [],     // what the renderer's DLNA reader fetched: { method, url, status, ok, request, response }
    },
    dial: { apps: Object.fromEntries(Object.entries(DIAL_APPS).map(([name, a]) => [name, { ...a, state: 'stopped' }])), launches: [], denied: 0 },
    launches: [],      // REST POST /api/v2/applications/<id>/ → { id (as requested), appId, body, payload }
    webapps: [],       // REST POST /api/v2/webapplication/
    wol: [],           // { mac, matches, from, size, at }
    tokens: { remote: new Set([opts.remoteToken]), ipc: new Set([opts.ipcToken]) },
    pairRequests: { remote: 0, ipc: 0 },
    subscriptions: new Map(),
    notifies: [],      // { sid, service, seq, body, status }
    requests: { rest: [], remote: [], soap: [], gena: [], ipc: [], dial: [] },
    stats: { ipcConnections: 0, ipcResets: 0 },
    violations: [],
    errors: [],
  };
  const violation = (kind, detail = {}) => { const v = { kind, ...detail, at: Date.now() }; state.violations.push(v); events.emit('violation', v); };
  const changed = (key, value) => events.emit('change', { key, value });

  // ---------- shared mutations (each one notifies GENA subscribers) ----------
  function changeAudio({ volume = state.volume, mute = state.mute }) {
    const vars = [];
    if (mute !== state.mute) { state.mute = mute; vars.push(`<Mute channel="Master" val="${mute ? 1 : 0}"/>`); changed('mute', mute); }
    if (volume !== state.volume) { state.volume = volume; vars.push(`<Volume channel="Master" val="${volume}"/>`); changed('volume', volume); }
    for (const v of vars) notifyService('RenderingControl', rcEvent(v));
  }
  const scopeKey = () => `${state.input}|${state.pictureMode}`;
  function switchScope({ input = state.input, mode = state.pictureMode }) {
    if (input === state.input && mode === state.pictureMode) return;
    state.pictureScopes.set(scopeKey(), state.picture);
    state.input = input;
    state.pictureMode = mode;
    state.picture = state.pictureScopes.get(scopeKey()) ?? { ...BASE_PICTURE, ...MODE_PICTURE[mode] };
    changed('scope', { input, mode });
  }
  function setForeground(id) {
    for (const app of apps.values()) app.visible = app.id === id;
    if (id && apps.has(id)) apps.get(id).running = true;
    if (id !== opts.appsPanel) Object.assign(state.dev, { dialog: null, notice: false, code: '' });
    changed('foreground', id);
  }

  // ---------- Developer mode box (Apps → 1 2 3 4 5) ----------
  // Layout from Samsung's figures (2016–2024): [On] [Off] · four Host PC IP boxes · [OK] [Cancel];
  // focus opens on On; Down from On lands on the third box (the nearest below it).
  const ipParts = (ip) => { const p = String(ip ?? '').split('.'); return p.length === 4 ? p : ['0', '0', '0', '0']; };
  function devKey(key) {
    const dev = state.dev;
    const digit = /^KEY_(\d)$/.exec(key)?.[1];
    if (!opts.appsPanel) return;
    if (state.ime.open) {
      if (key === 'KEY_RETURN') mock.ime.end(); // Back closes the TV keyboard first
      return;
    }
    if (dev.notice) {
      if (key === 'KEY_RETURN' || key === 'KEY_ENTER') dev.notice = false;
      return;
    }
    const d = dev.dialog;
    if (!d) {
      if (!apps.get(opts.appsPanel)?.visible) return;
      if (key === 'KEY_RETURN') { setForeground(null); return; }
      if (digit === undefined) { dev.code = ''; return; }
      if (opts.devDigitsOpenIme) { mock.ime.start('text'); return; }
      dev.code = (dev.code + digit).slice(-5);
      if (dev.code === '12345') {
        dev.code = '';
        dev.opened++;
        dev.dialog = { on: dev.mode === '1', ip: ipParts(dev.ip), row: 0, col: 0, fresh: true };
        events.emit('devDialog', 'open');
      }
      return;
    }
    if (key === 'KEY_RETURN') { dev.dialog = null; dev.cancelled++; events.emit('devDialog', 'cancel'); return; }
    if (d.row === 0) {
      if (key === 'KEY_LEFT') d.col = 0;
      else if (key === 'KEY_RIGHT') d.col = 1;
      else if (key === 'KEY_ENTER') d.on = d.col === 0;
      else if (key === 'KEY_DOWN') Object.assign(d, d.on ? { row: 1, col: d.col === 0 ? 2 : 3, fresh: true } : { row: 2 });
    } else if (d.row === 1) {
      if (key === 'KEY_LEFT' && d.col > 0) Object.assign(d, { col: d.col - 1, fresh: true });
      else if (key === 'KEY_RIGHT' && d.col < 3) Object.assign(d, { col: d.col + 1, fresh: true });
      else if (key === 'KEY_UP') Object.assign(d, { row: 0, col: d.col >= 2 ? 1 : 0 });
      else if (key === 'KEY_DOWN') Object.assign(d, { row: 2, col: d.col <= 1 ? 0 : 1 });
      else if (digit !== undefined) {
        // The first digit after the focus arrives replaces the box; a box holds three digits.
        d.ip[d.col] = d.fresh ? digit : d.ip[d.col].length < 3 ? d.ip[d.col] + digit : d.ip[d.col];
        d.fresh = false;
        if (d.ip[d.col].length === 3 && opts.devIpAutoAdvance && d.col < 3) Object.assign(d, { col: d.col + 1, fresh: true });
      }
    } else {
      if (key === 'KEY_LEFT') d.col = 0;
      else if (key === 'KEY_RIGHT') d.col = 1;
      else if (key === 'KEY_UP') Object.assign(d, d.on ? { row: 1, col: d.col === 0 ? 0 : 3, fresh: true } : { row: 0 });
      else if (key === 'KEY_ENTER') {
        dev.dialog = null;
        if (d.col === 1) { dev.cancelled++; events.emit('devDialog', 'cancel'); return; }
        dev.mode = d.on ? '1' : '0';
        // Right-to-left menus show the boxes in reverse, so the first box typed is the last part.
        const parts = /^(ar|he|iw)([_-]|$)/i.test(opts.language ?? '') ? [...d.ip].reverse() : d.ip;
        if (d.on) dev.ip = parts.map((p) => String(Number(p || 0))).join('.');
        dev.saved++;
        dev.notice = true;
        events.emit('devDialog', 'saved');
      }
    }
  }

  // ---------- REST (8001) ----------
  const device = fixtureJson('rest/device.json');
  const notFound = fixture('rest/not-found.json');
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };

  async function restRequest(req, res) {
    const url = new URL(req.url, 'http://mock');
    const body = await readBody(req);
    state.requests.rest.push({ method: req.method, path: url.pathname, body, at: Date.now() });
    if (opts.restDelayMs) await sleep(opts.restDelayMs);
    if (url.pathname === '/api/v2/' && req.method === 'GET') {
      const info = structuredClone(device);
      info.device.PowerState = state.power;
      info.device.wifiMac = opts.wifiMac;
      info.device.developerMode = state.dev.mode;
      info.device.developerIP = state.dev.ip;
      if (opts.model) info.device.model = opts.model;
      if (opts.language) info.device.Language = opts.language;
      info.uri = `http://${HOST}:${ports.rest}/api/v2/`;
      return json(res, 200, info);
    }
    if (url.pathname === '/api/v2') { violation('rest-missing-trailing-slash', { path: url.pathname }); return req.socket.destroy(); }
    if (url.pathname === '/api/v2/webapplication/' && req.method === 'POST') {
      if (state.power !== 'on') return req.socket.destroy();
      let target = null;
      try { target = JSON.parse(body).url ?? null; } catch { /* recorded as null */ }
      state.webapps.push({ url: target, at: Date.now() });
      events.emit('webapp', { url: target });
      setForeground('3201907018784');
      return json(res, 200, true);
    }
    const m = /^\/api\/v2\/applications\/([^/]+)(\/?)$/.exec(url.pathname);
    if (!m) { res.writeHead(404); return res.end(); }
    const [, requested, slash] = m;
    // Launches accept the browser's package id (GET still answers 404 for org.tizen.* ids, as the TV does).
    const id = requested === BROWSER_PACKAGE && req.method === 'POST' ? BROWSER_APP : requested;
    const app = apps.get(id);
    if (req.method === 'GET') {
      // The real TV never answers app status without the trailing slash.
      if (!slash) { violation('rest-missing-trailing-slash', { path: url.pathname }); return req.socket.destroy(); }
      if (!app) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(notFound); }
      return json(res, 200, { id: app.id, name: app.name, running: app.running, version: app.version, visible: state.power === 'on' && app.visible });
    }
    if (req.method === 'POST' || req.method === 'DELETE') {
      if (state.power !== 'on') return req.socket.destroy();
      if (!app) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(notFound); }
      if (req.method === 'DELETE') {
        app.running = false;
        app.visible = false;
        return json(res, 200, true);
      }
      let payload = null;
      try { payload = JSON.parse(body || '{}').id ?? null; } catch { /* no launch string */ }
      // DoLaunchApplication drops a launch string for an app that is already in front (-4009 "App is running.").
      // The HTTP status of that reply has not been observed; 500 is the mock's choice.
      if (payload != null && app.visible) return json(res, 500, { code: -4009, message: 'App is running.', status: 500 });
      state.launches.push({ id: requested, appId: id, body, payload, at: Date.now() });
      setForeground(id);
      events.emit('launch', { id: requested, appId: id, body, payload });
      return json(res, 200, true);
    }
    res.writeHead(405);
    res.end();
  }

  // ---------- remote channel WSS (8002) ----------
  const tls = testCert();
  const remoteClients = new Set();
  const broadcast = (msg) => { for (const ws of remoteClients) ws.send(JSON.stringify(msg)); };
  const newRemoteToken = () => String(crypto.randomInt(10_000_000, 100_000_000));

  function onRemoteConnection(ws, req) {
    const url = new URL(req.url, 'https://mock');
    const name = fromB64(url.searchParams.get('name'));
    const token = url.searchParams.get('token');
    const clientId = crypto.randomUUID();
    state.requests.remote.push({ name, withToken: Boolean(token), at: Date.now() });
    ws.on('error', () => {});
    if (opts.earlyEvents) ws.send(JSON.stringify({ event: state.touch ? 'ms.remote.touchEnable' : 'ms.remote.touchDisable' }));

    const accept = (issued) => {
      const clientToken = issued ?? token;
      remoteClients.add(ws);
      ws.on('close', () => remoteClients.delete(ws));
      ws.on('message', (data) => onRemoteMessage(String(data)));
      ws.send(JSON.stringify({
        event: 'ms.channel.connect',
        data: {
          id: clientId,
          ...(issued ? { token: issued } : {}),
          clients: [{ attributes: { name: b64(name), token: clientToken }, connectTime: Date.now(), deviceName: b64(name), id: clientId, isHost: false }],
        },
      }));
      ws.send(JSON.stringify({ event: 'ms.channel.ready', data: {} }));
      events.emit('remoteConnect', { name, token: clientToken });
    };
    const reject = () => { ws.send(JSON.stringify({ event: 'ms.channel.unauthorized' })); ws.close(); };

    if (token) {
      if (!state.tokens.remote.has(token)) return reject();
      if (!opts.rotateToken) return accept();
      const fresh = newRemoteToken();
      state.tokens.remote.add(fresh);
      return accept(fresh);
    }
    state.pairRequests.remote++;
    events.emit('pairRequest', { channel: 'remote', name });
    later(() => {
      if (ws.readyState !== ws.OPEN) return;
      if (!opts.allow) return reject();
      const fresh = newRemoteToken();
      state.tokens.remote.add(fresh);
      accept(fresh);
    }, opts.allowDelayMs);
  }

  function onRemoteMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return violation('remote-bad-json', { text }); }
    if (msg.method !== 'ms.remote.control') return; // ed.* emits get no reply on this firmware
    const p = msg.params ?? {};
    switch (p.TypeOfRemote) {
      case 'SendRemoteKey': return onKey(p.DataOfCmd, p.Cmd);
      case 'SendInputString': {
        const text = p.DataOfCmd === 'base64' ? fromB64(p.Cmd) : String(p.Cmd ?? '');
        state.texts.push(text);
        state.ime.text = text;
        events.emit('text', { text });
        broadcast({ data: 'disable', event: 'ms.remote.imeDone' });
        broadcast({ data: 'enable', event: 'ms.remote.imeDone' });
        return;
      }
      case 'SendInputEnd':
        state.inputEnds++;
        events.emit('inputEnd', {});
        if (state.ime.open) mock.ime.end();
        return;
      case 'ProcessMouseDevice': {
        // The real Q95T moves its cursor whether or not it sent touchEnable (live 2026-10-21), so the
        // touch flag is recorded as a hint only.
        const move = { cmd: p.Cmd, ...(p.Position ? { x: p.Position.x, y: p.Position.y } : {}), touch: state.touch };
        state.pointer.push(move);
        events.emit('pointer', move);
        return;
      }
      default:
        violation('remote-unknown-type', { type: p.TypeOfRemote });
    }
  }

  function onKey(key, cmd) {
    const entry = { key, cmd, at: Date.now() };
    state.keys.push(entry);
    events.emit('key', entry);
    if (DANGER_KEY.test(key)) return violation('danger-key', { key });
    if (key === 'KEY_POWER' && cmd === 'Press') return violation('power-hold', { key });
    if (cmd === 'Release') { state.pressed.delete(key); return; }
    if (cmd === 'Press') state.pressed.add(key);
    else if (cmd !== 'Click') return violation('remote-unknown-cmd', { key, cmd });
    if (key === 'KEY_VOLUP') changeAudio({ volume: Math.min(100, state.volume + 1), mute: false });
    else if (key === 'KEY_VOLDOWN') changeAudio({ volume: Math.max(0, state.volume - 1), mute: false });
    else if (key === 'KEY_MUTE') changeAudio({ mute: !state.mute });
    else if (key === 'KEY_POWER') later(() => setPower('standby'), 20);
    if (cmd === 'Click') devKey(key);
  }

  // ---------- DMR (9197): SOAP + GENA ----------
  const urn = (service) => `urn:schemas-upnp-org:service:${service}:1`;
  const soapEnvelope = (inner) => '<?xml version="1.0" encoding="utf-8"?><s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" '
    + `xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner}</s:Body></s:Envelope>`;
  const soapResponse = (service, action, out) => soapEnvelope(`<u:${action}Response xmlns:u="${urn(service)}">`
    + Object.entries(out).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>\r\n`).join('') + `</u:${action}Response>`);
  const soapFault = (code, description) => soapEnvelope('<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>'
    + `<UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${description}</errorDescription></UPnPError>`
    + '</detail></s:Fault>');
  const soapArgs = (body) => Object.fromEntries([...body.matchAll(/<([A-Za-z_][\w.-]*)>([\s\S]*?)<\/\1>/g)].map((m) => [m[1], xmlDecode(m[2])]));
  const requireArgs = (args, ...names) => { for (const n of names) if (!(n in args)) throw new UpnpFault(402, 'Invalid Args'); };
  const masterChannel = (args) => { requireArgs(args, 'Channel'); if (args.Channel !== 'Master') throw new UpnpFault(402, 'Invalid Args'); };

  const rcEvent = (vars) => `<Event xmlns="urn:schemas-upnp-org:metadata-1-0/RCS/"><InstanceID val="0">${vars}</InstanceID></Event>`;
  const rcInitialEvent = () => rcEvent(`<Mute channel="Master" val="${state.mute ? 1 : 0}"/><PresetNameList val="FactoryDefaults"/>`
    + `<Volume channel="Master" val="${state.volume}"/><X_360View latitudeCenter="0.0000" longitudeCenter="0.0000" scaleFactor="2.4000" val=""/>`
    + '<X_AspectRatio val="Default"/><X_Captions val=""/><X_EnabledCaptions val=""/><X_ServiceCapabilities val="GetVolume,SetVolume,GetMute,SetMute"/>');

  const av = state.avtransport;
  // Images report PLAYING at 0:00:00 for as long as they are shown.
  const avPosition = () => (av.playingSince && !av.image ? Math.min(av.durationS, av.positionS + (Date.now() - av.playingSince) / 1000) : av.positionS);
  const avActions = () => ({ PLAYING: 'Pause,Stop,Seek', PAUSED_PLAYBACK: 'Play,Stop,Seek', STOPPED: 'Play,Seek' }[av.state] ?? '');
  const avEvent = (vars) => `<Event xmlns="urn:schemas-upnp-org:metadata-1-0/AVT/"><InstanceID val="0">${vars}</InstanceID></Event>`;
  const avVar = (name, value) => `<${name} val="${xmlEscape(value)}"/>`;
  const avInitialEvent = () => avEvent([
    ['AVTransportURI', av.uri], ['AVTransportURIMetaData', av.metadata], ['CurrentMediaDuration', fmtTime(av.durationS)],
    ['CurrentPlayMode', 'NORMAL'], ['CurrentRecordQualityMode', 'NOT_IMPLEMENTED'], ['CurrentTrack', av.uri ? 1 : 0],
    ['CurrentTrackDuration', fmtTime(av.durationS)], ['CurrentTrackMetaData', av.metadata], ['CurrentTrackURI', av.uri],
    ['CurrentTransportActions', avActions()], ['NextAVTransportURI', ''], ['NextAVTransportURIMetaData', ''],
    ['NumberOfTracks', av.uri ? 1 : 0], ['PlaybackStorageMedium', av.uri ? 'NETWORK' : 'NETWORK,NONE'],
    ['PossiblePlaybackStorageMedia', 'NETWORK,NONE'], ['PossibleRecordQualityModes', 'NOT_IMPLEMENTED'],
    ['PossibleRecordStorageMedia', 'NOT_IMPLEMENTED'], ['RecordMediumWriteStatus', 'NOT_IMPLEMENTED'],
    ['RecordStorageMedium', 'NOT_IMPLEMENTED'], ['TransportPlaySpeed', 1], ['TransportState', av.state], ['TransportStatus', 'OK'],
  ].map(([n, v]) => avVar(n, v)).join(''));
  function setTransport(next) {
    av.positionS = avPosition();
    av.playingSince = next === 'PLAYING' ? Date.now() : null;
    if (next === 'STOPPED' || next === 'NO_MEDIA_PRESENT') av.positionS = 0;
    av.state = next;
    changed('transport', next);
    notifyService('AVTransport', avEvent(avVar('TransportState', next) + avVar('CurrentTransportActions', avActions())));
  }
  function parseDidl(didl) {
    const res = /<res\b([^>]*)>([\s\S]*?)<\/res>/.exec(didl);
    return {
      title: xmlDecode(/<dc:title>([\s\S]*?)<\/dc:title>/.exec(didl)?.[1] ?? ''),
      upnpClass: xmlDecode(/<upnp:class>([\s\S]*?)<\/upnp:class>/.exec(didl)?.[1] ?? ''),
      protocolInfo: xmlDecode(/protocolInfo="([^"]*)"/.exec(res?.[1] ?? '')?.[1] ?? ''),
      duration: parseTime(xmlDecode(/duration="([^"]*)"/.exec(res?.[1] ?? '')?.[1] ?? '')),
      url: res ? xmlDecode(res[2]) : '',
    };
  }

  // The renderer's DLNA reader (libDlnaReaderCore, decompiled): HEAD first and abort if it fails, then a
  // ranged GET; DLNA request headers, no User-Agent, Connection: close; only 100, 200-202 and 206-299
  // count as success, so any redirect fails the cast. Each fetch is recorded in av.fetches.
  const readerAccepts = (status) => status === 100 || (status >= 200 && status <= 202) || (status >= 206 && status <= 299);
  const READER_RESPONSE_HEADERS = ['content-type', 'content-length', 'accept-ranges', 'content-range', 'contentfeatures.dlna.org', 'transfermode.dlna.org'];
  function readerRequest(method, target, headers) {
    return new Promise((resolve) => {
      const record = { method, url: target, status: null, ok: false, error: null, request: { ...headers }, response: {} };
      let url;
      try { url = new URL(target); } catch { return resolve({ ...record, error: 'invalid url' }); }
      if (url.protocol !== 'http:') return resolve({ ...record, error: 'not http' });
      let settled = false;
      const finish = (extra) => { if (!settled) { settled = true; resolve({ ...record, ...extra }); } };
      const req = http.request({
        host: url.hostname, port: url.port, path: url.pathname + url.search, method, agent: false, timeout: 3000,
        headers: { ...headers, Connection: 'close' },
      }, (res) => {
        const response = Object.fromEntries(READER_RESPONSE_HEADERS.filter((h) => h in res.headers).map((h) => [h, res.headers[h]]));
        const done = () => { finish({ status: res.statusCode, ok: readerAccepts(res.statusCode), response }); req.destroy(); };
        if (method === 'HEAD') res.resume();
        else res.once('data', done); // the reader only needs the head of the stream here
        res.on('end', done);
        res.on('error', done);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => finish({ error: err.code ?? err.message }));
      req.end();
    });
  }
  function readerFailed(phase, record) {
    av.status = 'ERROR_OCCURRED';
    av.stoppedReason = 'ERROR'; // the TV's own StoppedReason values are not known yet; these are the mock's
    av.stoppedReasonData = `${phase} ${record.status ?? record.error}`;
    setTransport('STOPPED');
  }
  async function readerFetch(gen) {
    const headers = {
      'getcontentFeatures.dlna.org': '1', 'transferMode.dlna.org': av.image ? 'Interactive' : 'Streaming',
      'getCaptionInfo.sec': '1', 'getMediaInfo.sec': '1',
    };
    if (opts.dmrFetchDelayMs) await sleep(opts.dmrFetchDelayMs);
    if (gen !== av.generation) return; // superseded by a new URI or a Stop meanwhile
    const head = await readerRequest('HEAD', av.uri, headers);
    av.fetches.push(head);
    if (gen !== av.generation) return;
    if (!head.ok) return readerFailed('HEAD', head);
    const get = await readerRequest('GET', av.uri, { ...headers, Range: 'bytes=0-' });
    av.fetches.push(get);
    if (gen !== av.generation) return;
    if (!get.ok) return readerFailed('GET', get);
    setTransport('PLAYING');
  }

  const SOAP = {
    RenderingControl: {
      GetVolume: (a) => { masterChannel(a); return { CurrentVolume: state.volume }; },
      GetMute: (a) => { masterChannel(a); return { CurrentMute: state.mute ? 1 : 0 }; },
      SetVolume: (a) => {
        masterChannel(a);
        requireArgs(a, 'DesiredVolume');
        const v = Number(a.DesiredVolume);
        if (!/^\d+$/.test(a.DesiredVolume.trim())) throw new UpnpFault(402, 'Invalid Args');
        if (v > 100) throw new UpnpFault(601, 'Argument Value Out of Range');
        changeAudio({ volume: v, mute: false }); // SetVolume unmutes the Q95T
        return {};
      },
      SetMute: (a) => {
        masterChannel(a);
        requireArgs(a, 'DesiredMute');
        const m = { 1: true, true: true, 0: false, false: false }[a.DesiredMute.trim().toLowerCase()];
        if (m === undefined) throw new UpnpFault(402, 'Invalid Args');
        changeAudio({ mute: m });
        return {};
      },
      X_GetServiceCapabilities: () => ({ ServiceCapabilities: 'GetVolume,SetVolume,GetMute,SetMute' }),
    },
    AVTransport: {
      SetAVTransportURI: (a) => {
        requireArgs(a, 'CurrentURI');
        if (!a.CurrentURI) throw new UpnpFault(402, 'Invalid Args');
        const didl = parseDidl(a.CurrentURIMetaData ?? '');
        if (a.CurrentURIMetaData && !/^\s*<DIDL-Lite[\s>]/.test(a.CurrentURIMetaData)) violation('didl-malformed');
        av.actions.push({ action: 'SetAVTransportURI', uri: a.CurrentURI, metadata: a.CurrentURIMetaData ?? '', didl, at: Date.now() });
        av.generation++;
        av.uri = a.CurrentURI;
        av.metadata = a.CurrentURIMetaData ?? '';
        av.image = /^object\.item\.imageItem/.test(didl.upnpClass);
        av.durationS = av.image ? 0 : didl.duration ?? opts.mediaDurationS;
        Object.assign(av, { status: 'OK', stoppedReason: '', stoppedReasonData: '', playLocked: opts.playLockedOnce, lastSeekAt: 0 });
        notifyService('AVTransport', avEvent(avVar('AVTransportURI', av.uri) + avVar('CurrentTrackURI', av.uri)));
        setTransport('STOPPED');
        return {};
      },
      Play: (a) => {
        av.actions.push({ action: 'Play', speed: a.Speed, at: Date.now() });
        if (!av.uri) throw new UpnpFault(701, 'Transition not available');
        if (av.playLocked) { av.playLocked = false; throw new UpnpFault(705, 'Transport is locked'); }
        if (av.state === 'PLAYING' || av.state === 'TRANSITIONING') return {};
        if (av.state === 'PAUSED_PLAYBACK' || !opts.dmrFetch) { setTransport('PLAYING'); return {}; }
        // From STOPPED the reader opens the stream first; playback starts once it has.
        av.status = 'OK';
        setTransport('TRANSITIONING');
        readerFetch(av.generation).catch((err) => { state.errors.push(err); events.emit('failure', err); });
        return {};
      },
      Pause: () => {
        av.actions.push({ action: 'Pause', at: Date.now() });
        if (av.state !== 'PLAYING') throw new UpnpFault(701, 'Transition not available');
        setTransport('PAUSED_PLAYBACK');
        return {};
      },
      Stop: () => {
        av.actions.push({ action: 'Stop', at: Date.now() });
        if (!av.uri) throw new UpnpFault(701, 'Transition not available');
        av.generation++;
        setTransport('STOPPED');
        return {};
      },
      Seek: (a) => {
        av.actions.push({ action: 'Seek', unit: a.Unit, target: a.Target, at: Date.now() });
        if (a.Unit !== 'REL_TIME') throw new UpnpFault(710, 'Seek mode not supported');
        const target = parseTime(a.Target ?? '');
        // 711 at the exact end (the TV does), 701 while still opening the stream or right after a seek.
        if (target == null || target >= av.durationS || !av.uri) throw new UpnpFault(711, 'Illegal seek target');
        if (av.state === 'TRANSITIONING' || Date.now() - av.lastSeekAt < opts.seekLockMs) throw new UpnpFault(701, 'Transition not available');
        av.lastSeekAt = Date.now();
        av.positionS = target;
        if (av.playingSince) av.playingSince = Date.now();
        return {};
      },
      GetTransportInfo: () => ({ CurrentTransportState: av.state, CurrentTransportStatus: av.status, CurrentSpeed: 1 }),
      GetPositionInfo: () => ({
        Track: av.uri ? 1 : 0, TrackDuration: fmtTime(av.durationS), TrackMetaData: av.metadata, TrackURI: av.uri,
        RelTime: fmtTime(avPosition()), AbsTime: fmtTime(avPosition()), RelCount: 2147483647, AbsCount: 2147483647,
      }),
      GetMediaInfo: () => ({
        NrTracks: av.uri ? 1 : 0, MediaDuration: fmtTime(av.durationS), CurrentURI: av.uri, CurrentURIMetaData: av.metadata,
        NextURI: '', NextURIMetaData: '', PlayMedium: av.uri ? 'NETWORK' : 'NETWORK,NONE', RecordMedium: 'NOT_IMPLEMENTED', WriteStatus: 'NOT_IMPLEMENTED',
      }),
      GetCurrentTransportActions: () => ({ Actions: avActions() }),
      X_GetStoppedReason: () => ({ StoppedReason: av.stoppedReason, StoppedReasonData: av.stoppedReasonData }),
    },
    ConnectionManager: {
      GetProtocolInfo: () => fixture('upnp/soap-GetProtocolInfo.xml'),
      GetCurrentConnectionIDs: () => fixture('upnp/soap-GetCurrentConnectionIDs.xml'),
      GetCurrentConnectionInfo: () => fixture('upnp/soap-GetCurrentConnectionInfo.xml'),
    },
  };

  async function soapRequest(req, res, service) {
    const body = await readBody(req);
    const [actionUrn, action] = String(req.headers.soapaction ?? '').replace(/"/g, '').split('#');
    const args = soapArgs(body);
    state.requests.soap.push({ service, action, args, at: Date.now() });
    events.emit('soap', { service, action, args });
    const headers = { 'Content-Type': 'text/xml; charset="utf-8"', EXT: '', Server: UPNP_SERVER };
    try {
      if (actionUrn !== urn(service) || !Object.hasOwn(SOAP[service], action)) throw new UpnpFault(401, 'Invalid Action');
      if ('InstanceID' in args && args.InstanceID !== '0') throw new UpnpFault(402, 'Invalid Args');
      const out = SOAP[service][action](args);
      res.writeHead(200, headers);
      res.end(typeof out === 'string' ? out : soapResponse(service, action, out));
    } catch (err) {
      if (!(err instanceof UpnpFault)) throw err;
      res.writeHead(500, headers);
      res.end(soapFault(err.upnpCode, err.message));
    }
  }

  // GENA: the Q95T grants the requested timeout (even infinite) and keeps it on renewal.
  function genaRequest(req, res, service) {
    const { sid, callback, nt, timeout } = req.headers;
    const reply = (status, headers = {}) => { res.writeHead(status, { Server: GENA_SERVER, 'Content-Length': 0, ...headers }); res.end(); };
    state.requests.gena.push({ method: req.method, service, sid: sid ?? null, callback: callback ?? null, timeout: timeout ?? null, at: Date.now() });
    if (req.method === 'UNSUBSCRIBE') {
      const sub = state.subscriptions.get(sid);
      if (!sub || sub.service !== service) return reply(412);
      state.subscriptions.delete(sid);
      events.emit('unsubscribe', { sid, service });
      return reply(200);
    }
    if (sid && (callback || nt)) return reply(400);
    const timeoutS = /infinite/i.test(timeout ?? '') ? Infinity : Number(/Second-(\d+)/i.exec(timeout ?? '')?.[1] ?? 1800);
    if (timeoutS === Infinity) violation('gena-infinite-timeout');
    if (sid) {
      const sub = state.subscriptions.get(sid);
      if (!sub || sub.service !== service || sub.expiresAt < Date.now()) { state.subscriptions.delete(sid); return reply(412); }
      sub.expiresAt = Date.now() + sub.timeoutS * 1000;
      sub.renewals++;
      events.emit('renew', { sid, service });
      return reply(200, { SID: sid, TIMEOUT: `Second-${sub.timeoutS}` });
    }
    const target = /<([^>]+)>/.exec(callback ?? '')?.[1];
    if (nt !== 'upnp:event' || !target) return reply(412);
    let url;
    try { url = new URL(target); } catch { return reply(412); }
    if (!LOOPBACK.has(url.hostname)) { violation('gena-callback-not-loopback', { host: url.hostname }); return reply(412); }
    const newSid = `uuid:${crypto.randomUUID()}`;
    const sub = { sid: newSid, service, callback: url.href, timeoutS, expiresAt: Date.now() + timeoutS * 1000, seq: 0, renewals: 0, chain: Promise.resolve() };
    state.subscriptions.set(newSid, sub);
    reply(200, { SID: newSid, TIMEOUT: Number.isFinite(timeoutS) ? `Second-${timeoutS}` : 'Second-infinite' });
    events.emit('subscribe', { sid: newSid, service, callback: url.href });
    later(() => deliver(sub, lastChange(service === 'RenderingControl' ? rcInitialEvent() : avInitialEvent())), opts.initialNotifyDelayMs);
  }

  function deliver(sub, body) {
    if (!state.subscriptions.has(sub.sid)) return;
    if (sub.expiresAt < Date.now()) { state.subscriptions.delete(sub.sid); return; }
    const record = { sid: sub.sid, service: sub.service, seq: sub.seq++, body, status: null };
    state.notifies.push(record);
    if (opts.dropNotify) { record.status = 'dropped'; return; }
    sub.chain = sub.chain.then(() => new Promise((resolve) => {
      const url = new URL(sub.callback);
      const done = () => { events.emit('notify', record); resolve(); };
      const req = http.request({
        host: url.hostname, port: url.port, path: url.pathname + url.search, method: 'NOTIFY', agent: false, timeout: 3000,
        headers: {
          HOST: url.host, 'CONTENT-TYPE': 'text/xml; charset="utf-8"', 'CONTENT-LENGTH': Buffer.byteLength(body),
          NT: 'upnp:event', NTS: 'upnp:propchange', SID: sub.sid, SEQ: String(record.seq), CONNECTION: 'close',
        },
      }, (res) => { record.status = res.statusCode; res.resume(); res.on('end', done); });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => { record.status = 'error'; record.error = err.code ?? err.message; done(); });
      req.end(body);
    }));
  }

  function notifyService(service, inner) {
    for (const sub of state.subscriptions.values()) {
      if (sub.service !== service) continue;
      deliver(sub, lastChange(inner));
      if (opts.emptyNotifies && service === 'RenderingControl') deliver(sub, lastChange(null));
    }
  }

  async function dmrRequest(req, res) {
    const { pathname } = new URL(req.url, 'http://mock');
    const control = /^\/upnp\/control\/(RenderingControl|AVTransport|ConnectionManager)1$/.exec(pathname);
    const event = /^\/upnp\/event\/(RenderingControl|AVTransport)1$/.exec(pathname);
    if (control && req.method === 'POST') return soapRequest(req, res, control[1]);
    if (event && ['SUBSCRIBE', 'UNSUBSCRIBE'].includes(req.method)) return genaRequest(req, res, event[1]);
    if (pathname === '/dmr' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"' });
      return res.end(fixture('upnp/dmr-description.xml'));
    }
    res.writeHead(404);
    res.end();
  }

  // ---------- IP Control (1516) ----------
  const tvStates = () => ({
    inputSource: state.input, mute: state.mute ? 'muteOn' : 'muteOff', pictureMode: state.pictureMode, pictureSize: state.pictureSize,
    soundMode: state.soundMode, speakerSelect: state.speaker === 'Internal' ? 'internal' : 'external', volume: state.volume,
  });
  const videoStates = () => {
    const { brightness, color, contrast, sharpness, tint } = state.picture;
    return { brightness, color, contrast, sharpness, tint };
  };
  const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

  function ipcCall(method, set) {
    if (opts.ipcFail[method]) throw new RpcError(opts.ipcFail[method]);
    if (IPC_2025_ONLY.has(method)) throw new RpcError(-32601);
    const stored = (value) => (opts.ipcTransform[method] ? opts.ipcTransform[method](value) : value);
    const getOnly = (value) => { if (set) throw new RpcError(-32602); return value; };
    const setEnum = (field, valid, apply) => {
      if (!set) return null;
      if (!valid(set[field])) throw new RpcError(-32002);
      apply(set[field]);
      return null;
    };
    switch (method) {
      case 'getTVStates': return getOnly(tvStates());
      case 'getVideoStates': return getOnly(videoStates());
      case 'pictureModeControl':
        setEnum('pictureMode', (m) => PICTURE_MODES.includes(m) && (m !== 'Filmmaker Mode' || opts.fmmContent), (mode) => switchScope({ mode }));
        return { pictureMode: state.pictureMode };
      case 'inputSourceControl':
        setEnum('inputSource', oneOf(...INPUTS), (input) => switchScope({ input }));
        return { inputSource: state.input };
      case 'pictureSizeControl':
        setEnum('pictureSize', oneOf('16:9', '4:3'), (v) => { state.pictureSize = v; changed('pictureSize', v); });
        return { pictureSize: state.pictureSize };
      case 'soundModeControl':
        setEnum('soundMode', oneOf('Standard', 'Optimized', 'Amplify'), (v) => { state.soundMode = v; changed('soundMode', v); });
        return { soundMode: state.soundMode };
      // As the Q95T answers (24 Oct): reads 'Internal' or 'External' (optical and Bluetooth alike);
      // only Internal and AudioOut/Optical can be set here ('Bluetooth' is a -32002).
      case 'speakerSelectControl':
        setEnum('speakerSelect', oneOf('Internal', 'AudioOut/Optical'), (v) => { state.speaker = v; state.bt = null; changed('speaker', v); });
        return { speakerSelect: state.speaker === 'Internal' ? 'Internal' : 'External' };
      // The Bluetooth speakers the TV has connected ({} when none); { deviceId } sends the sound to one.
      case 'externalSpeakerControl':
        if (set) {
          if (!state.btSpeakers.some((d) => d.deviceId === set.deviceId)) throw new RpcError(-32002);
          state.speaker = 'External';
          state.bt = set.deviceId;
          changed('speaker', 'External');
          return { deviceId: set.deviceId };
        }
        return state.btSpeakers.length ? state.btSpeakers.map((d) => ({ ...d })) : {};
      case 'directVolumeControl':
        if (state.speaker !== 'Internal') throw new RpcError(-32002); // the TV volume is meaningless on an external output
        setEnum('volume', int(0, 100), (volume) => changeAudio({ volume: stored(volume) }));
        return { volume: state.volume };
      case 'volumeUpDnControl':
        if (!set) throw new RpcError(-32602);
        setEnum('control', oneOf('volumeUp', 'volumeDn'), (c) => changeAudio({ volume: Math.max(0, Math.min(100, state.volume + (c === 'volumeUp' ? 1 : -1))) }));
        return { volume: state.volume };
      case 'muteControl':
        setEnum('mute', oneOf('muteOn', 'muteOff'), (m) => changeAudio({ mute: m === 'muteOn' }));
        return { mute: state.mute ? 'muteOn' : 'muteOff' };
      case 'powerControl':
        if (!set || !('power' in set)) { violation('ipc-powerControl-without-param'); throw new RpcError(-32602); }
        if (set.power === 'reboot') { violation('ipc-reboot'); throw new RpcError(-32002); }
        if (set.power === 'powerOff') { later(() => setPower('standby'), 20); return { power: 'powerOff' }; }
        if (set.power === 'powerOn') return { power: 'powerOn' };
        throw new RpcError(-32002);
      case 'WB2PointControl':
        if (set) {
          if (state.pictureMode === 'Dynamic') throw new RpcError(-32002);
          if (!WB_FIELDS.every((f) => int(-50, 50)(set[f]))) throw new RpcError(-32002);
          Object.assign(state.picture, pick(set, WB_FIELDS));
          changed('picture', pick(set, WB_FIELDS));
        }
        return pick(state.picture, WB_FIELDS);
      default: {
        const entry = PICTURE_METHODS[method];
        if (!entry) throw new RpcError(-32601);
        const [field, valid, flags = {}] = entry;
        if (set) {
          if (state.pictureMode === 'Dynamic') throw new RpcError(-32002);
          if (flags.customOnly && state.picture.autoMotionPlus !== 'Custom') throw new RpcError(-32002);
          if (!(field in set) || !valid(set[field])) throw new RpcError(-32002);
          state.picture[field] = stored(set[field]);
          changed(`picture.${field}`, state.picture[field]);
        }
        return { [field]: state.picture[field] };
      }
    }
  }

  let ipcActive = null; // the TV serves one connection at a time and resets overlapping ones
  function onIpcConnection(socket) {
    if (state.power === 'off' || (state.power === 'standby' && !opts.standbyIpcPowerOn)) return socket.destroy();
    if (ipcActive && !ipcActive.destroyed) {
      state.stats.ipcResets++;
      violation('ipc-overlapping-connection');
      return socket.resetAndDestroy ? socket.resetAndDestroy() : socket.destroy();
    }
    state.stats.ipcConnections++;
    ipcActive = socket;
    socket.once('close', () => { if (ipcActive === socket) ipcActive = null; });
  }

  async function ipcRequest(req, res) {
    // Overlapping sockets are destroyed on accept, so this request owns the active slot until it is answered.
    res.on('finish', () => { ipcActive = null; });
    const raw = await readBody(req);
    if (opts.ipcDelayMs) await sleep(opts.ipcDelayMs);
    const send = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json', Server: 'Samsung IP Control Server/1.0', Connection: 'close' });
      res.end(JSON.stringify(body));
    };
    const fail = (id, code) => send(opts.ipcErrorStyle === 'flat'
      ? { code, message: IPC_MESSAGES[code] }
      : { jsonrpc: '2.0', id, error: { code, message: IPC_MESSAGES[code] } });

    let msg;
    try { msg = JSON.parse(raw); } catch { msg = null; }
    if (!msg || typeof msg !== 'object') return fail(null, -32700);
    const { id = null, method, params } = msg;
    const hasToken = params && typeof params === 'object' && 'AccessToken' in params;
    const args = hasToken ? Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'AccessToken')) : {};
    const isSet = Object.keys(args).length > 0;
    const record = { method, kind: isSet ? 'set' : 'get', params: args, tokenOk: hasToken && state.tokens.ipc.has(params.AccessToken), at: Date.now() };
    state.requests.ipc.push(record);
    events.emit('ipc', record);

    if (state.power !== 'on') {
      if (method === 'powerControl' && args.power === 'powerOn' && record.tokenOk) {
        later(() => setPower('on'), opts.wakeDelayMs);
        return send({ jsonrpc: '2.0', id, result: { power: 'powerOn' } });
      }
      return req.socket.destroy();
    }
    if (method === 'createAccessToken') {
      state.pairRequests.ipc++;
      events.emit('pairRequest', { channel: 'ipc' });
      await sleep(opts.allowDelayMs);
      if (opts.ipcSlotsFull) return fail(id, -32011);
      if (!opts.allow) return fail(id, -32010);
      const token = `MOCKIPC${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
      state.tokens.ipc.add(token);
      return send({ jsonrpc: '2.0', id, result: { AccessToken: token } });
    }
    if (!hasToken) return fail(id, -32700);
    if (!record.tokenOk) return fail(id, -32010);
    try {
      return send({ jsonrpc: '2.0', id, result: ipcCall(method, isSet ? args : null) });
    } catch (err) {
      if (!(err instanceof RpcError)) throw err;
      return fail(id, err.rpcCode);
    }
  }

  // ---------- DIAL (8080) ----------
  const dialXml = (name, app) => '<service xmlns="urn:dial-multiscreen-org:schemas:dial" dialVer="2.2">'
    + `<name>${name}</name><options allowStop="true"/><state>${app.state}</state><version>${app.version}</version><link rel="run" href="run"/></service>`;

  // remote-server's DIALAPIService (decompiled + live): GET answers /ws/app/ and /ws/apps/, POST only the singular
  // path; a missing or foreign Origin is 403, over 4096 bytes 413, a PC not on the allowed list 401, success 201.
  const DIAL_ORIGINS = { YouTube: 'youtube.com', Netflix: 'netflix.com', AmazonInstantVideo: 'primevideo.com' };
  async function dialRequest(req, res) {
    const { pathname, searchParams } = new URL(req.url, 'http://mock');
    const body = await readBody(req);
    const empty = (status) => { res.writeHead(status, { 'Content-Length': 0 }); res.end(); };
    state.requests.dial.push({ method: req.method, path: pathname, body, origin: req.headers.origin ?? null, at: Date.now() });
    const m = /^\/ws\/(app|apps)\/([^/]+)(\/run)?\/?$/.exec(pathname);
    const name = m && decodeURIComponent(m[2]);
    const app = name && state.dial.apps[name];
    if (!app) return empty(404);
    if (req.method === 'GET' && !m[3]) {
      res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"', 'Access-Control-Allow-Origin': '*' });
      return res.end(dialXml(name, app));
    }
    if (req.method === 'POST' && !m[3]) {
      if (m[1] === 'apps') { violation('dial-plural-post', { path: pathname }); return empty(404); }
      // The real TV (2026 firmware) refuses a launch unless the Origin ends with the app's own domain.
      const allowedOrigin = DIAL_ORIGINS[name];
      if (allowedOrigin && !(req.headers.origin ?? '').endsWith(allowedOrigin)) {
        violation('dial-origin-header', { origin: req.headers.origin ?? null });
        return empty(403);
      }
      if (Buffer.byteLength(body) > DIAL_MAX_BODY) return empty(413);
      if (!opts.dialAllowed) { state.dial.denied++; return empty(401); }
      app.state = 'running';
      const launch = { name, body, contentType: req.headers['content-type'] ?? null, friendlyName: searchParams.get('friendlyName'), at: Date.now() };
      state.dial.launches.push(launch);
      setForeground(app.appId);
      events.emit('dialLaunch', launch);
      res.writeHead(201, { LOCATION: `http://${HOST}:${ports.dial}/ws/apps/${name}/run`, 'Content-Length': 0 });
      return res.end();
    }
    if (req.method === 'DELETE' && m[3]) {
      app.state = 'stopped';
      if (apps.has(app.appId)) Object.assign(apps.get(app.appId), { running: false, visible: false });
      res.writeHead(200);
      return res.end();
    }
    res.writeHead(405);
    res.end();
  }

  // ---------- power ----------
  function setPower(next) {
    if (!['on', 'standby', 'off'].includes(next)) throw new Error(`unknown power state ${next}`);
    if (next === state.power) return;
    const wasOn = state.power === 'on';
    state.power = next;
    if (wasOn) {
      for (const ws of remoteClients) ws.terminate();
      remoteClients.clear();
      state.subscriptions.clear(); // the DMR forgets its subscribers in standby
      state.pressed.clear();
      for (const app of apps.values()) app.visible = false;
      av.generation++;
      Object.assign(av, { uri: '', metadata: '', state: 'NO_MEDIA_PRESENT', status: 'OK', positionS: 0, durationS: 0, playingSince: null, image: false, playLocked: false });
      if (state.ime.open) state.ime = { open: false, type: null, text: '', limit: 0 };
      state.touch = false;
      Object.assign(state.dev, { dialog: null, notice: false, code: '' });
    }
    events.emit('power', next);
  }

  // ---------- servers ----------
  const sockets = new Set();
  const track = (server, gate) => server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (gate) gate(socket);
  });
  // A bug in the mock itself: answer 500 and keep it in state.errors so a suite can assert there were none.
  const handle = (fn) => (req, res) => fn(req, res).catch((err) => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
    state.errors.push(err);
    events.emit('failure', err);
  });
  const onlyWhenOn = (socket) => { if (state.power !== 'on') socket.destroy(); };

  // REST keeps answering in standby; a TV that is fully off accepts nothing, so requests just time out.
  const restHandler = handle(restRequest);
  const restServer = http.createServer((req, res) => { if (state.power !== 'off') restHandler(req, res); });
  track(restServer);

  const wssServer = https.createServer(tls);
  track(wssServer, onlyWhenOn);
  const wss = new WebSocketServer({ server: wssServer, path: REMOTE_PATH, perMessageDeflate: false });
  wss.on('connection', onRemoteConnection);
  const pinger = setInterval(() => { for (const ws of remoteClients) ws.ping(Buffer.from([0])); }, opts.pingMs);

  const dmrServer = http.createServer(handle(dmrRequest));
  track(dmrServer, onlyWhenOn);

  const ipcServer = https.createServer(tls, handle(ipcRequest));
  track(ipcServer, onIpcConnection);

  const dialServer = http.createServer(handle(dialRequest));
  track(dialServer, onlyWhenOn);

  const wolSocket = dgram.createSocket('udp4');
  wolSocket.on('message', (msg, rinfo) => {
    const mac = parseMagicPacket(msg);
    const packet = { mac, matches: mac === opts.wifiMac.toLowerCase(), from: rinfo.address, size: msg.length, at: Date.now() };
    state.wol.push(packet);
    events.emit('wol', packet);
    if (packet.matches && state.power !== 'on') later(() => setPower('on'), opts.wakeDelayMs);
  });

  const listen = (server) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => resolve(server.address().port));
  });
  const ports = {
    rest: await listen(restServer),
    wss: await listen(wssServer),
    dmr: await listen(dmrServer),
    ipc: await listen(ipcServer),
    dial: await listen(dialServer),
    wolUdp: await new Promise((resolve) => wolSocket.bind(0, HOST, () => resolve(wolSocket.address().port))),
  };

  let stopped = false;
  const mock = {
    ports,
    state,
    events,
    options: opts,
    tokens: { remote: opts.remoteToken, ipc: opts.ipcToken },
    /** Overrides for `startServer({ tv })`. */
    tv: { host: HOST, ports: { rest: ports.rest, wss: ports.wss, dmr: ports.dmr, ipc: ports.ipc, dial: ports.dial } },
    setPower,
    /** External changes, as if made with the physical remote. */
    setVolume: (volume) => changeAudio({ volume }),
    setMute: (mute) => changeAudio({ mute }),
    setPictureMode: (mode) => switchScope({ mode }),
    setInput: (input) => switchScope({ input }),
    setPicture: (field, value) => { state.picture[field] = value; changed(`picture.${field}`, value); },
    setForeground,
    setTouch(enabled) {
      state.touch = enabled;
      broadcast({ event: enabled ? 'ms.remote.touchEnable' : 'ms.remote.touchDisable' });
    },
    ime: {
      start(type = 'text', limit = 2048) {
        state.ime = { open: true, type, text: '', limit };
        broadcast({ data: type, entrylimit: limit, event: 'ms.remote.imeStart' });
      },
      update(text) {
        state.ime.text = text;
        broadcast({ data: b64(text), entrylimit: state.ime.limit, event: 'ms.remote.imeUpdate' });
      },
      done(enabled = true) { broadcast({ data: enabled ? 'enable' : 'disable', event: 'ms.remote.imeDone' }); },
      end() {
        state.ime = { open: false, type: null, text: state.ime.text, limit: 0 };
        broadcast({ event: 'ms.remote.imeEnd' });
      },
    },
    /** Deliver a raw NOTIFY body (e.g. a fixture) to every subscriber of a DMR service. */
    notifyRaw(body, service = 'RenderingControl') {
      for (const sub of state.subscriptions.values()) if (sub.service === service) deliver(sub, body);
    },
    /** Resolves once every queued NOTIFY has been delivered. */
    async flushNotifies() {
      await Promise.all([...state.subscriptions.values()].map((s) => s.chain));
    },
    keysSent: () => state.keys.map((k) => k.key),
    remoteClients: () => remoteClients.size,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(pinger);
      for (const t of timers) clearTimeout(t);
      for (const ws of remoteClients) ws.terminate();
      for (const s of sockets) s.destroy();
      wss.close();
      await Promise.all([restServer, wssServer, dmrServer, ipcServer, dialServer].map((s) => new Promise((resolve) => {
        s.close(() => resolve());
        s.closeAllConnections?.();
      })));
      await new Promise((resolve) => wolSocket.close(resolve));
    },
  };
  return mock;
}
