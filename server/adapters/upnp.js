// UPnP RenderingControl on the TV's media renderer (port 9197): volume and mute over SOAP,
// pushed changes over GENA (NOTIFY to the TV-facing listener), and polling whenever push is not live.
import http from 'node:http';
import crypto from 'node:crypto';
import { createQueue } from '../util/queue.js';
import { LumenError } from '../errors.js';

const RCS = 'urn:schemas-upnp-org:service:RenderingControl:1';
const CONTROL_PATH = '/upnp/control/RenderingControl1';
const EVENT_PATH = '/upnp/event/RenderingControl1';
const REQUEST_TIMEOUT_MS = 4000;
const UNSUBSCRIBE_TIMEOUT_MS = 2000;
const SAFETY_POLL_MS = 30000;
const RETRY_SUBSCRIBE_MS = 30000;
const MAX_BODY = 64 * 1024;

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

// Single pass, so "&amp;lt;" becomes "&lt;" rather than "<".
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (whole, ent) => {
    if (ent[0] !== '#') return ENTITIES[ent.toLowerCase()];
    const code = ent[1].toLowerCase() === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

// GENA propertyset → { volume?, mute? } for the Master channel only; null for an empty <LastChange/> or no audio change.
export function parseLastChange(body) {
  const match = /<LastChange>([\s\S]*?)<\/LastChange>/.exec(String(body ?? ''));
  if (!match) return null;
  const raw = match[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(raw);
  const xml = cdata ? cdata[1] : decodeEntities(raw);
  const change = {};
  for (const [, name, attrText] of xml.matchAll(/<(Volume|Mute)\b([^>]*)>/g)) {
    const attrs = Object.fromEntries([...attrText.matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
    if (attrs.channel && attrs.channel !== 'Master') continue;
    if (name === 'Volume' && /^\d+$/.test(attrs.val ?? '')) change.volume = Number(attrs.val);
    if (name === 'Mute' && /^(0|1|true|false)$/i.test(attrs.val ?? '')) change.mute = attrs.val === '1' || attrs.val.toLowerCase() === 'true';
  }
  return Object.keys(change).length ? change : null;
}

function envelope(action, args) {
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<s:Body><u:${action} xmlns:u="${RCS}">${inner}</u:${action}></s:Body></s:Envelope>`;
}

const field = (body, name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1]?.trim();

export function createUpnp({ config, data, log: rootLog, store, lan }) {
  const log = rootLog.child('upnp');
  const { host } = config.tv;
  const port = config.tv.ports.dmr;
  const t = config.timing;
  const queue = createQueue({ concurrency: 1, minGapMs: 200 });
  const saved = config.secrets?.genaSecret ?? data.readJson('secrets.json', {})?.genaSecret;
  const secret = typeof saved === 'string' && /^[A-Za-z0-9_-]{16,}$/.test(saved) ? saved : crypto.randomBytes(32).toString('hex');
  const routePath = `/gena/${secret}`;
  const active = new Set();

  let started = false;
  let stopped = false;
  let visible = false;
  let mode = 'off';              // conn.events: 'push' | 'polling' | 'off'
  let reachable = null;          // conn.upnp: 'ok' | 'down'
  let sid = null;
  let staleSid = null;           // a subscription from before the TV left 'on'; dropped before subscribing again
  let tvOn = false;
  let grantedS = t.genaTimeoutS;
  let subscribing = false;
  let notifiedSinceSubscribe = false;
  const timers = {};

  const tvState = () => store.get('conn.tv')?.v;
  const pollInterval = () => (mode === 'push' ? SAFETY_POLL_MS : visible ? t.volumePollVisibleMs : t.volumePollIdleMs);
  const valueTtl = () => Math.max(5000, 3 * pollInterval());
  const pollLoop = createLoop(async () => {
    if (tvState() !== 'on') return;
    await read('GetVolume', 'poll');
    await read('GetMute', 'poll');
  }, pollInterval, log);

  function send({ method, path, headers, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host, port, method, path, agent: false,
        headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      });
      let done = false;
      const settle = (fn, value) => { if (done) return; done = true; clearTimeout(timer); active.delete(req); fn(value); };
      const timer = setTimeout(() => req.destroy(Object.assign(new Error(`no answer within ${timeoutMs} ms`), { code: 'ETIMEDOUT' })), timeoutMs);
      req.on('response', (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => { size += chunk.length; if (size <= MAX_BODY) chunks.push(chunk); });
        res.on('end', () => settle(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (err) => settle(reject, err));
      });
      req.on('error', (err) => settle(reject, err));
      active.add(req);
      req.end(body);
    });
  }

  function setConn(state) {
    if (state === reachable) return;
    reachable = state;
    store.set('conn.upnp', state, { src: 'live', via: 'upnp', ttlMs: null });
  }

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    store.set('conn.events', next, { src: 'live', via: 'gena', ttlMs: null });
    if (next === 'polling') pollLoop.kick(); else pollLoop.reschedule();
  }

  function publish(key, value, via) {
    const meta = key === 'audio.volume' ? { range: [0, 100] } : {};
    store.set(key, value, { src: 'live', via, ttlMs: valueTtl(), ...meta });
  }

  function soap(action, args, priority) {
    return queue.push(async () => {
      if (stopped) throw new LumenError('UNAVAILABLE', 'Lumen is shutting down');
      const t0 = Date.now();
      let res;
      try {
        res = await send({
          method: 'POST', path: CONTROL_PATH, body: envelope(action, { InstanceID: 0, Channel: 'Master', ...args }),
          headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${RCS}#${action}"` },
        });
      } catch (err) {
        setConn('down');
        if (tvState() === 'standby' || tvState() === 'off') throw new LumenError('TV_OFF', 'The TV is off');
        throw new LumenError('FAILED', `The TV's media renderer did not answer (${err.code ?? err.message})`);
      }
      setConn('ok');
      store.set('conn.latency.upnp', Date.now() - t0, { src: 'derived', via: 'upnp', ttlMs: valueTtl() });
      if (res.status !== 200) {
        const code = field(res.body, 'errorCode');
        const detail = code ? `UPnP ${code} ${field(res.body, 'errorDescription') ?? ''}`.trim() : `HTTP ${res.status}`;
        throw new LumenError('FAILED', `The TV refused ${action} (${detail})`);
      }
      return res.body;
    }, { priority });
  }

  async function read(action, priority) {
    const body = await soap(action, {}, priority);
    if (action === 'GetVolume') {
      const value = Number(field(body, 'CurrentVolume'));
      if (!Number.isInteger(value)) throw new LumenError('FAILED', 'The TV sent an unreadable volume');
      publish('audio.volume', value, 'upnp:GetVolume');
      return value;
    }
    const raw = field(body, 'CurrentMute');
    if (!/^(0|1|true|false)$/i.test(raw ?? '')) throw new LumenError('FAILED', 'The TV sent an unreadable mute state');
    const value = raw === '1' || raw.toLowerCase() === 'true';
    publish('audio.mute', value, 'upnp:GetMute');
    return value;
  }

  async function getVolume() {
    return { value: await read('GetVolume', 'user') };
  }

  async function getMute() {
    return { value: await read('GetMute', 'user') };
  }

  async function setVolume(v) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw new LumenError('INVALID', 'Volume must be 0–100');
    await soap('SetVolume', { DesiredVolume: Math.round(v) }, 'user');
    const value = await read('GetVolume', 'user');
    await read('GetMute', 'user').catch((err) => log.debug(`mute read-back failed: ${err.message}`));   // SetVolume unmutes the TV
    return { value };
  }

  async function setMute(muted) {
    if (typeof muted !== 'boolean') throw new LumenError('INVALID', 'Mute must be true or false');
    await soap('SetMute', { DesiredMute: muted ? 1 : 0 }, 'user');
    return { value: await read('GetMute', 'user') };
  }

  // --- GENA ---

  function clearTimer(name) {
    clearTimeout(timers[name]);
    delete timers[name];
  }

  function retryLater() {
    clearTimer('retry');
    timers.retry = setTimeout(() => { delete timers.retry; ensureSubscription(); }, RETRY_SUBSCRIBE_MS);
  }

  function scheduleRenew() {
    clearTimer('renew');
    timers.renew = setTimeout(() => { delete timers.renew; renew(); }, Math.max(1000, grantedS * 800));
  }

  function grantedSeconds(header) {
    const seconds = Number(/^Second-(\d+)$/i.exec(String(header ?? '').trim())?.[1]);
    return seconds > 0 ? seconds : t.genaTimeoutS;
  }

  function gena(headers) {
    return queue.push(() => send({ method: 'SUBSCRIBE', path: EVENT_PATH, headers }), { priority: 'poll' });
  }

  async function ensureSubscription() {
    if (stopped || !started || subscribing || tvState() !== 'on') return;
    if (sid) return renew();
    subscribing = true;
    try {
      const listener = await Promise.resolve(lan?.ready).catch(() => null);
      if (!listener) {
        setMode('polling');
        return;
      }
      if (stopped || tvState() !== 'on') return;
      if (staleSid) {
        const old = staleSid;
        staleSid = null;
        await queue.push(() => unsubscribe(old), { priority: 'poll' });
      }
      notifiedSinceSubscribe = false;
      const res = await gena({ CALLBACK: `<http://${listener.address}:${listener.port}${routePath}>`, NT: 'upnp:event', TIMEOUT: `Second-${t.genaTimeoutS}` });
      if (res.status !== 200 || !res.headers.sid) throw new Error(`HTTP ${res.status}`);
      sid = res.headers.sid;
      grantedS = grantedSeconds(res.headers.timeout);
      scheduleRenew();
      clearTimer('fallback');
      timers.fallback = setTimeout(() => {
        delete timers.fallback;
        if (notifiedSinceSubscribe) return;
        log.warn(`no GENA NOTIFY within ${t.genaFallbackMs} ms of SUBSCRIBE; polling volume`);
        setMode('polling');
      }, t.genaFallbackMs);
      log.info(`GENA subscribed for ${grantedS} s`);
    } catch (err) {
      log.warn(`GENA SUBSCRIBE failed (${err.code ?? err.message}); polling volume`);
      setMode('polling');
      retryLater();
    } finally {
      subscribing = false;
    }
  }

  async function renew() {
    if (stopped || !sid || tvState() !== 'on') return;
    try {
      const res = await gena({ SID: sid, TIMEOUT: `Second-${t.genaTimeoutS}` });
      if (res.status === 412) {
        log.info('GENA subscription expired on the TV; subscribing again');
        sid = null;
        return ensureSubscription();
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      grantedS = grantedSeconds(res.headers.timeout);
      scheduleRenew();
    } catch (err) {
      log.warn(`GENA renewal failed (${err.code ?? err.message}); polling volume`);
      setMode('polling');
      retryLater();
    }
  }

  function onNotify(req, res) {
    if (req.url.split('?')[0] !== routePath) {
      res.writeHead(404, { 'Content-Length': 0 });
      return res.end();
    }
    if (req.method !== 'NOTIFY') {
      res.writeHead(405, { Allow: 'NOTIFY', 'Content-Length': 0 });
      return res.end();
    }
    // Unknown SIDs get 412 so the TV drops subscriptions we abandoned. During SUBSCRIBE the SID is not known yet.
    if (!req.headers.sid || (req.headers.sid !== sid && !subscribing)) {
      res.writeHead(412, { 'Content-Length': 0 });
      return res.end();
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { res.writeHead(413, { 'Content-Length': 0, Connection: 'close' }); res.end(); req.destroy(); } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      res.writeHead(200, { 'Content-Length': 0 });
      res.end();
      onEvent(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {});
  }

  function onEvent(body) {
    if (stopped) return;
    notifiedSinceSubscribe = true;
    if (mode !== 'push') {
      log.info('GENA push is live');
      setMode('push');
    }
    const change = parseLastChange(body);
    if (change?.volume !== undefined) publish('audio.volume', change.volume, 'gena');
    if (change?.mute !== undefined) publish('audio.mute', change.mute, 'gena');
  }

  // conn.tv is re-published on every REST poll; only transitions matter here.
  function onPatch(patch) {
    if (!patch || !('conn.tv' in patch)) return;
    const on = patch['conn.tv']?.v === 'on';
    if (on === tvOn) return;
    tvOn = on;
    if (on) {
      setMode('polling');        // until a NOTIFY proves that push works
      ensureSubscription();
    } else {
      for (const name of ['renew', 'retry', 'fallback']) clearTimer(name);
      if (sid) { staleSid = sid; sid = null; }
      setMode('off');
      setConn('down');
    }
  }

  async function unsubscribe(id) {
    try {
      await send({ method: 'UNSUBSCRIBE', path: EVENT_PATH, headers: { SID: id }, timeoutMs: UNSUBSCRIBE_TIMEOUT_MS });
    } catch (err) {
      log.debug(`UNSUBSCRIBE failed: ${err.code ?? err.message}`);
    }
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      lan?.route('/gena/' + secret, { request: onNotify });
      store.on('patch', onPatch);
      store.set('conn.events', mode, { src: 'live', via: 'gena', ttlMs: null });
      pollLoop.reschedule(true);
      if (tvState() === 'on') onPatch({ 'conn.tv': { v: 'on' } });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      store.off?.('patch', onPatch);
      pollLoop.stop();
      for (const name of Object.keys(timers)) clearTimer(name);
      queue.clear(new LumenError('UNAVAILABLE', 'Lumen is shutting down'));
      if (sid) await unsubscribe(sid);
      sid = null;
      for (const req of active) req.destroy();
    },
    setDemand({ visible: v } = {}) {
      const next = Boolean(v);
      if (next === visible) return;
      visible = next;
      if (visible && mode === 'polling') pollLoop.kick(); else pollLoop.reschedule();
    },
    getVolume,
    setVolume,
    getMute,
    setMute,
  };
}

// setTimeout chain that never overlaps itself and never lets an error escape a timer.
function createLoop(task, interval, log) {
  let timer = null;
  let running = false;
  let stopped = false;
  async function tick() {
    timer = null;
    if (stopped) return;
    running = true;
    try { await task(); } catch (err) { log.debug(`poll failed: ${err.message}`); }
    running = false;
    if (!stopped) timer = setTimeout(tick, interval());
  }
  return {
    kick() { if (running || stopped) return; clearTimeout(timer); tick(); },
    reschedule(force = false) {
      if (running || stopped || (!timer && !force)) return;
      clearTimeout(timer);
      timer = setTimeout(tick, interval());
    },
    stop() { stopped = true; clearTimeout(timer); timer = null; },
  };
}
