// Remote-control channel (wss://TV:8002 samsung.remote.control): keys, text, pointer, and the TV's IME/touch events.
// One socket, opened only while conn.tv is 'on' (opening it can wake some TVs), with the saved token.
// Connecting without a token happens only inside pair(), because it shows an Allow prompt on the TV.
import WebSocket from 'ws';
import { createQueue } from '../util/queue.js';
import { LumenError } from '../errors.js';
import { isAllowedKey } from '../catalog/keys.js';

const HANDSHAKE_TIMEOUT_MS = 10000;
const CONNECT_WAIT_MS = 35000;
const PAIR_WAIT_MS = 45000;
const DEAD_AFTER_MS = 12000;
const PING_IDLE_MS = 5000;
const READY_WAIT_MS = 4000;
const CLOSE_WAIT_MS = 1000;
const POINTER_FLUSH_MS = 33;
const MAX_MOVE = 1920;
const MAX_TEXT = 2048;
const IME_CLOSED = Object.freeze({ open: false, type: null, text: '', limit: null });

const control = (params) => ({ method: 'ms.remote.control', params });
const keyMessage = (cmd, key) => control({ Cmd: cmd, DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' });

export function createRemote({ config, data, log: rootLog, store, rest }) {
  const log = rootLog.child('remote');
  const { host, clientName } = config.tv;
  const port = config.tv.ports.wss;
  const backoff = config.timing.reconnectBackoffMs;
  const releaseAfterMs = config.timing.holdMaxMs + 1000;
  const queue = createQueue({ concurrency: 1, minGapMs: config.safety.keyGapMs });

  let token = readToken();
  let current = null;            // { socket, mode: 'token' | 'pair', ready, reason, timers }
  let unauthorized = false;
  let attempt = 0;
  let reconnectTimer = null;
  let started = false;
  let stopped = false;
  let pairing = null;            // { promise, resolve, reject }
  let ime = IME_CLOSED;
  let touch = null;
  let move = null;               // pending pointer move { dx, dy, timer, waiters }
  let tvOn = false;
  const waiters = new Set();     // commands waiting for the channel to become ready
  const pressed = new Map();     // key → safety release timer

  const tvState = () => store.get('conn.tv')?.v;

  function readToken() {
    const saved = data.readJson('tv.json', {}) ?? {};
    return typeof saved.token === 'string' || typeof saved.token === 'number' ? String(saved.token) : null;
  }

  function saveToken(next, paired) {
    if (!next || next === token) return;
    token = next;
    Promise.resolve()
      .then(() => data.writeJson('tv.json', { ...(data.readJson('tv.json', {}) ?? {}), token: next, ...(paired ? { pairedAt: new Date().toISOString() } : {}) }))
      .then(() => log.info('remote token saved'), (err) => log.error(`could not save the remote token: ${err.message}`));
  }

  function publish(state, note = null) {
    store.set('conn.remote', state, { src: 'live', via: 'ws:remote', ttlMs: null, note });
  }

  function publishIdle() {
    if (!token) publish('unpaired', 'Pair the remote to send keys');
    else if (unauthorized) publish('unpaired', 'The TV no longer accepts this remote; pair again');
    else publish('down');
  }

  function setIme(next) {
    ime = next;
    store.set('ime', next, { src: 'live', via: 'ws:ime', ttlMs: null });
  }

  function url(withToken) {
    const name = encodeURIComponent(Buffer.from(clientName).toString('base64'));
    const auth = withToken && token ? `&token=${encodeURIComponent(token)}` : '';
    return `wss://${host}:${port}/api/v2/channels/samsung.remote.control?name=${name}${auth}`;
  }

  function openSocket(mode) {
    const socket = new WebSocket(url(mode === 'token'), { rejectUnauthorized: false, perMessageDeflate: false, handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
    const session = { socket, mode, ready: false, reason: 'closed', timers: {}, lastFrame: Date.now() };
    current = session;
    // Until ms.channel.connect only the wait timer applies (the TV may sit on its Allow prompt); after it, 12 s of silence = dead.
    session.alive = () => {
      session.lastFrame = Date.now();
      if (!session.ready) return;
      clearTimeout(session.timers.dead);
      session.timers.dead = setTimeout(() => { session.reason = 'dead'; socket.terminate(); }, DEAD_AFTER_MS);
    };
    const alive = () => session.alive();
    session.timers.wait = setTimeout(() => { session.reason = 'wait'; socket.terminate(); }, mode === 'pair' ? PAIR_WAIT_MS : CONNECT_WAIT_MS);
    socket.on('open', () => {
      alive();
      session.timers.ping = setInterval(() => {
        if (Date.now() - session.lastFrame >= PING_IDLE_MS && socket.readyState === WebSocket.OPEN) socket.ping();
      }, PING_IDLE_MS);
    });
    socket.on('ping', alive);
    socket.on('pong', alive);
    socket.on('message', (raw) => {
      alive();
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg && typeof msg.event === 'string') onMessage(session, msg);
    });
    socket.on('error', (err) => { session.reason = err.code ?? err.message; });
    socket.on('close', () => onClosed(session));
    return session;
  }

  function onMessage(session, msg) {
    switch (msg.event) {
      case 'ms.channel.connect': return onConnected(session, msg.data ?? {});
      case 'ms.channel.unauthorized': return onUnauthorized(session);
      case 'ms.channel.timeOut': session.reason = 'timeOut'; return session.socket.close();
      case 'ms.remote.touchEnable': return setTouch(true);
      case 'ms.remote.touchDisable': return setTouch(false);
      case 'ms.remote.imeStart': return setIme({ open: true, type: String(msg.data ?? 'text'), text: '', limit: imeLimit(msg) });
      case 'ms.remote.imeUpdate': return setIme({ ...ime, open: true, text: /pass/i.test(ime.type ?? '') ? '' : decodeText(msg.data) });
      case 'ms.remote.imeEnd': return setIme(IME_CLOSED);
      case 'ed.edenTV.update': return rest?.foregroundCheck?.();
      case 'ms.error': return log.warn(`TV reported an error: ${String(msg.data?.message ?? 'unknown')}`);
      default: return undefined;   // imeDone (not a close), client joins/leaves, voice UI, early handshake noise
    }
  }

  function onConnected(session, info) {
    if (session !== current || session.ready) return;
    const issued = info.token ?? info.clients?.find((c) => c.id === info.id)?.attributes?.token;
    if (session.mode === 'pair') {
      if (!issued) {
        session.reason = 'no-token';
        session.socket.close();
        return;
      }
      saveToken(String(issued), true);
      unauthorized = false;
      pairing?.resolve({ value: 'paired' });
      pairing = null;
      log.info('paired with the TV');
    } else if (issued) {
      saveToken(String(issued), false);
    }
    clearTimeout(session.timers.wait);
    session.ready = true;
    session.alive();
    attempt = 0;
    publish('paired');
    releaseAll(session);
    for (const w of waiters) { clearTimeout(w.timer); w.resolve(); }
    waiters.clear();
  }

  function onUnauthorized(session) {
    session.reason = 'unauthorized';
    if (session.mode === 'token') {
      unauthorized = true;
      log.warn('the TV rejected the saved token (ms.channel.unauthorized); not retrying until paired again');
    }
    session.socket.close();
  }

  function onClosed(session) {
    for (const timer of Object.values(session.timers)) { clearTimeout(timer); clearInterval(timer); }
    if (session !== current) return;
    current = null;
    if (session.ready) log.info(`remote channel closed (${session.reason})`);
    if (ime.open) setIme(IME_CLOSED);
    if (session.mode === 'pair' && !session.ready) {
      const declined = session.reason === 'unauthorized';
      const message = declined ? 'Pairing was declined on the TV'
        : session.reason === 'wait' ? 'No answer within 45 s; accept the prompt on the TV and try again'
          : session.reason === 'no-token' ? 'The TV did not issue a token'
            : 'The TV did not answer; is it on and on the same network?';
      failPairing(new LumenError(declined ? 'NOT_PAIRED' : 'FAILED', message));
      if (declined && !token) return publish('unpaired', message);
    }
    publishIdle();
    scheduleReconnect();
  }

  function failPairing(err) {
    if (!pairing) return;
    pairing.reject(err);
    pairing = null;
  }

  function connectNow() {
    if (stopped || !started || pairing || current || unauthorized || !token || tvState() !== 'on') return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    publish('connecting');
    openSocket('token');
  }

  function scheduleReconnect() {
    if (stopped || pairing || current || unauthorized || !token || reconnectTimer || tvState() !== 'on') return;
    const delay = backoff[Math.min(attempt, backoff.length - 1)];
    attempt += 1;
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try { await rest?.getDevice?.(); } catch { /* the power read below decides */ }   // never reopen on a TV that just went to standby
      connectNow();
    }, delay);
  }

  // conn.tv is re-published on every REST poll; only transitions matter here.
  function onPatch(patch) {
    if (!patch || !('conn.tv' in patch)) return;
    const on = patch['conn.tv']?.v === 'on';
    if (on === tvOn) return;
    tvOn = on;
    if (on) {
      attempt = 0;
      connectNow();
    } else {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function blockedError() {
    if (stopped) return new LumenError('UNAVAILABLE', 'Lumen is shutting down');
    if (!token || unauthorized) return new LumenError('NOT_PAIRED', 'Pair Lumen with the TV first');
    if (!current && tvState() !== 'on') return new LumenError('TV_OFF', 'The TV is off');
    return null;
  }

  function whenReady() {
    if (current?.ready) return Promise.resolve();
    const blocked = blockedError();
    if (blocked) return Promise.reject(blocked);
    connectNow();
    return new Promise((resolve, reject) => {
      const w = {
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(w);
          reject(blockedError() ?? new LumenError('FAILED', 'The remote channel is not connected'));
        }, READY_WAIT_MS),
      };
      waiters.add(w);
    });
  }

  function send(payload) {
    const socket = current?.ready ? current.socket : null;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw blockedError() ?? new LumenError('FAILED', 'The remote channel is not connected');
    socket.send(JSON.stringify(payload));
  }

  function enqueue(payload) {
    return queue.push(async () => {
      await whenReady();
      send(payload);
      return {};
    }, { priority: 'user' });
  }

  function releaseAll(session) {
    for (const [key, timer] of pressed) {
      clearTimeout(timer);
      if (session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(keyMessage('Release', key)));
    }
    if (pressed.size) log.info(`released ${pressed.size} held key(s)`);
    pressed.clear();
  }

  function setTouch(enabled) {
    touch = enabled;
    store.set('touch.enabled', enabled, { src: 'live', via: 'ws:touch', ttlMs: null });
  }

  function checkKey(key, action) {
    if (!isAllowedKey(key, action)) throw new LumenError('INVALID', `${typeof key === 'string' ? key : 'That key'} cannot be ${action === 'press' ? 'held' : 'sent'}`);
  }

  async function click(key) {
    checkKey(key, 'click');
    return enqueue(keyMessage('Click', key));
  }

  async function press(key) {
    checkKey(key, 'press');
    const result = await enqueue(keyMessage('Press', key));
    clearTimeout(pressed.get(key));
    pressed.set(key, setTimeout(() => {
      log.warn(`${key} held too long; releasing`);
      release(key).catch(() => {});
    }, releaseAfterMs));
    return result;
  }

  async function release(key) {
    checkKey(key, 'release');
    clearTimeout(pressed.get(key));
    const result = await enqueue(keyMessage('Release', key));
    pressed.delete(key);
    return result;
  }

  async function text(str, submit = false) {
    if (typeof str !== 'string' || str.length > MAX_TEXT) throw new LumenError('INVALID', `Text must be a string of at most ${MAX_TEXT} characters`);
    const result = await enqueue(control({ Cmd: Buffer.from(str, 'utf8').toString('base64'), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' }));
    if (submit) await enqueue(control({ TypeOfRemote: 'SendInputEnd' }));
    return result;
  }

  // Moves are relative (about 1920x1080 units) and coalesced to ~30 messages a second. The TV's
  // touchEnable/touchDisable events are only a hint: live on the Q95T the cursor moved over CineHD
  // with no touch event at all, so the pointer is never gated on them.
  function pointerMove(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return Promise.reject(new LumenError('INVALID', 'dx and dy must be numbers'));
    move ??= { dx: 0, dy: 0, waiters: [], timer: setTimeout(() => flushMove(), POINTER_FLUSH_MS) };
    move.dx += dx;
    move.dy += dy;
    return new Promise((resolve, reject) => move.waiters.push({ resolve, reject }));
  }

  async function flushMove() {
    if (!move) return;
    const { dx, dy, waiters: pending, timer } = move;
    clearTimeout(timer);
    move = null;
    const clamp = (v) => Math.max(-MAX_MOVE, Math.min(MAX_MOVE, Math.round(v)));
    try {
      await whenReady();
      send(control({ Cmd: 'Move', Position: { x: clamp(dx), y: clamp(dy), Time: String(Date.now()) }, TypeOfRemote: 'ProcessMouseDevice' }));
      for (const w of pending) w.resolve({});
    } catch (err) {
      for (const w of pending) w.reject(err);
    }
  }

  async function pointerClick(button = 'left') {
    await flushMove();
    return enqueue(control({ Cmd: button === 'right' ? 'RightClick' : 'LeftClick', TypeOfRemote: 'ProcessMouseDevice' }));
  }

  // There is no wheel message, so scrolling becomes key clicks: one per 120 wheel units (a notch).
  // Channel keys page the TV browser; arrow keys scroll most other apps. config.pointer.scrollKeys picks.
  let scrollAcc = 0;
  async function pointerScroll(dy) {
    if (!Number.isFinite(dy)) throw new LumenError('INVALID', 'dy must be a number');
    scrollAcc = Math.max(-1200, Math.min(1200, scrollAcc + dy));
    const steps = Math.trunc(scrollAcc / 120);
    if (!steps) return {};
    scrollAcc -= steps * 120;
    const arrows = config.pointer?.scrollKeys === 'arrows';
    const key = steps > 0 ? (arrows ? 'KEY_DOWN' : 'KEY_CHDOWN') : (arrows ? 'KEY_UP' : 'KEY_CHUP');
    for (let i = 0; i < Math.min(Math.abs(steps), 5); i++) await enqueue(keyMessage('Click', key));
    return { value: { key, steps } };
  }

  function pair() {
    if (pairing) return pairing.promise;
    const blocked = stopped ? new LumenError('UNAVAILABLE', 'Lumen is shutting down')
      : tvState() !== 'on' ? new LumenError('TV_OFF', 'Turn the TV on to pair') : null;
    if (blocked) return Promise.reject(blocked);
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const previous = current;
    current = null;
    if (previous) {
      if (previous.ready) releaseAll(previous);
      previous.socket.close();
    }
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    pairing = { promise, resolve, reject };
    log.info('pairing: waiting for Allow on the TV');
    publish('connecting', 'Accept on your TV');
    openSocket('pair');
    return promise;
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      store.on('patch', onPatch);
      tvOn = tvState() === 'on';
      setIme(IME_CLOSED);
      publishIdle();
      connectNow();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      store.off?.('patch', onPatch);
      clearTimeout(reconnectTimer);
      const shutdown = new LumenError('UNAVAILABLE', 'Lumen is shutting down');
      queue.clear(shutdown);
      for (const w of waiters) { clearTimeout(w.timer); w.reject(shutdown); }
      waiters.clear();
      if (move) { clearTimeout(move.timer); for (const w of move.waiters) w.reject(shutdown); move = null; }
      failPairing(shutdown);
      const session = current;
      current = null;
      if (session) {
        if (session.ready) releaseAll(session);
        await new Promise((resolve) => {
          const timer = setTimeout(() => { session.socket.terminate(); resolve(); }, CLOSE_WAIT_MS);
          session.socket.once('close', () => { clearTimeout(timer); resolve(); });
          session.socket.close(1000);
        });
      }
      for (const timer of pressed.values()) clearTimeout(timer);
      pressed.clear();
    },
    setDemand() {},
    click,
    press,
    release,
    text,
    pointerMove,
    pointerClick,
    pointerScroll,
    pair,
  };
}

function imeLimit(msg) {
  const n = Number(msg.entrylimit ?? msg.data?.entrylimit);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function decodeText(data) {
  return typeof data === 'string' ? Buffer.from(data, 'base64').toString('utf8') : '';
}
