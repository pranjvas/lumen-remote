// Single WebSocket to /live with auto-reconnect and ack correlation.

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];

let counter = 0;
export function makeId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  counter += 1;
  return `c${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// The frame's own fields come last so an argument can never replace them: a scene or macro id
// travels as `target` (spec §5.3 frames are { t, id, cmd, ...args }).
function frame(id, cmd, args) {
  return { ...args, t: 'cmd', id, cmd };
}

// Binary messages (asked for with /live?frames=bin): [type][header length][2 reserved][seq u32][w u16][h u16]
// then the payload. Type 1 is a browser frame, whose payload is the JPEG.
export function decodeBinary(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 12) return null;
  const view = new DataView(buffer);
  const headerLength = view.getUint8(1);
  if (view.getUint8(0) !== 1 || headerLength < 12 || headerLength > buffer.byteLength) return null;
  return { t: 'browser.frame', seq: view.getUint32(4), w: view.getUint16(8), h: view.getUint16(10), bytes: new Uint8Array(buffer, headerLength) };
}

export function createLive({ url = defaultUrl() } = {}) {
  const listeners = new Map();
  const pending = new Map();
  let ws = null;
  let status = 'connecting';
  let attempt = 0;
  let retryTimer = null;
  let retryAt = 0;
  let rtt = null;

  function emit(type, payload) {
    for (const fn of listeners.get(type) || []) {
      try { fn(payload); } catch (err) { console.error(`live listener "${type}" failed`, err); }
    }
  }

  function setStatus(next) {
    if (status === next) return;
    status = next;
    emit('status', status);
  }

  function connect() {
    clearTimeout(retryTimer);
    retryTimer = null;
    setStatus('connecting');
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error('WebSocket failed to open', err);
      scheduleRetry();
      return;
    }
    ws.addEventListener('open', () => {
      attempt = 0;
      setStatus('open');
    });
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') {
        const msg = decodeBinary(ev.data);
        if (msg) emit(msg.t, msg);
        return;
      }
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'ack' && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        rtt = Math.round(performance.now() - p.sentAt);
        p.resolve(msg);
      }
      emit(msg.t, msg);
    });
    ws.addEventListener('close', () => {
      ws = null;
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.resolve({ t: 'ack', id, ok: false, error: { code: 'OFFLINE', message: 'Connection to Lumen was lost' } });
      }
      pending.clear();
      setStatus('closed');
      scheduleRetry();
    });
  }

  function scheduleRetry() {
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt += 1;
    retryAt = Date.now() + delay;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, delay);
    emit('retry', { at: retryAt, attempt });
  }

  function send(cmd, args = {}, { timeoutMs = 15000, id = makeId() } = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ t: 'ack', id, ok: false, error: { code: 'OFFLINE', message: 'Not connected to Lumen' } });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ t: 'ack', id, ok: false, error: { code: 'TIMEOUT', message: 'The TV did not answer in time' } });
      }, timeoutMs);
      pending.set(id, { resolve, timer, sentAt: performance.now() });
      ws.send(JSON.stringify(frame(id, cmd, args)));
    });
  }

  // Fire-and-forget (hold beats): still a cmd with an id, but nothing waits on the ack.
  function post(cmd, args = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame(makeId(), cmd, args)));
    return true;
  }

  return {
    connect,
    send,
    post,
    retryNow: () => connect(),
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    get status() { return status; },
    get retryAt() { return retryAt; },
    get rtt() { return rtt; },
  };
}

function defaultUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/live?frames=bin`;
}
