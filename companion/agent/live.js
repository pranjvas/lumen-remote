// Lumen Agent: live video of Lumen's browser. The PC captures its browser page with its sound,
// encodes it (H.264 or HEVC + AAC) and sends fragmented MP4 over the agent socket: an init message
// ('LVI') then media fragments ('LVM'), each tagged with a stream generation. This plays them through
// MSE on a <video> under the pointer, kept at the live edge (small drift: a slightly faster rate;
// large: a jump), trims old buffer, recovers from stalls, and reports to the PC once a second so it
// can adapt the bitrate and resolution. When MSE refuses the stream the PC falls back to JPEG frames.
// Runs on Chromium M69 (Tizen 5.5): ES2017 syntax only (no ?. ?? or object spread).
(function () {
  'use strict';

  // Media arrives ~160 ms at a time, so the player stays a little behind the newest frame: closer,
  // it would run dry between fragments and stall. This TV's decoder lands every seek on the key frame
  // before the target (a key frame comes every second), and a seek flushes the hardware pipeline,
  // which can freeze this page's script for good: so the player seeks as little as it can, only onto
  // key frames it has seen arrive, and catches up on small drift by playing slightly faster.
  const SOFT_LAG = 0.9; // above this the rate goes up a little
  const CALM_LAG = 0.45; // back to normal speed below this
  const CATCH_UP_RATE = 1.1;
  const HARD_LAG = 3; // above this the player jumps to the newest key frame
  const JUMP_GAP_MS = 8000; // at least this long between two jumps
  const KEEP_BEHIND = 4; // seconds of played video kept in the buffer
  const TRIM_EVERY = 10; // control ticks (500 ms) between buffer trims: remove() is not cheap here
  const MAX_QUEUE_BYTES = 8 * 1024 * 1024; // appends waiting beyond this: start over from a key frame
  const STALL_MS = 2500;
  const VIDEO_TIMESCALE = 90000; // the PC's fMP4 video track (server/util/fmp4.js)
  // This TV's web engine is slow: the PC sends a few large fragments a second, this page appends them
  // one at a time (all that waited, in one append), checks the live edge twice a second, trims the
  // buffer every few seconds and reports every 2 s (the PC treats silence as overload).

  let send = function () { return false; };
  let el = null; // <video id="live">
  let root = null;
  let ms = null;
  let sb = null;
  let mime = null;
  let gen = -1;
  let queue = [];
  let queued = 0;
  let waitInit = true; // after a reset or a dropped queue, media waits for the next init
  let started = false; // 'playing' reported for this player
  let jumped = false;
  let stalls = 0;
  let lastTime = -1;
  let lastProgress = 0;
  let controlTimer = null;
  let statsTimer = null;
  let objectUrl = null;
  let failed = false;
  let ticks = 0;
  let keys = []; // media times (s) of the latest key frames that arrived, oldest first
  let lastJump = 0;
  let jumps = 0;

  function now() { return Date.now(); }

  function probe(list) {
    const out = {};
    const MS = window.MediaSource;
    (Array.isArray(list) ? list : []).slice(0, 16).forEach(function (codec) {
      const c = String(codec).replace(/[^A-Za-z0-9.]/g, '');
      try { out[c] = !!(MS && MS.isTypeSupported('video/mp4; codecs="' + c + ',mp4a.40.2"')); } catch (e) { out[c] = false; }
    });
    return out;
  }

  function report(state, extra) {
    const msg = { t: 'screen-live', state: state };
    if (state !== 'stats' && window.LumenBox) window.LumenBox.note('live-' + state, extra || null);
    if (extra) Object.keys(extra).forEach(function (k) { msg[k] = extra[k]; });
    send(msg);
  }

  // ---- player lifecycle ----

  function teardown() {
    clearInterval(controlTimer);
    clearInterval(statsTimer);
    controlTimer = statsTimer = null;
    queue = [];
    queued = 0;
    sb = null;
    if (ms) {
      try { if (ms.readyState === 'open') ms.endOfStream(); } catch (e) { /* closing anyway */ }
    }
    ms = null;
    mime = null;
    gen = -1;
    waitInit = true;
    started = false;
    if (el) {
      el.onplaying = el.onerror = el.onwaiting = null;
      try { el.pause(); } catch (e) { /* not playing */ }
      el.removeAttribute('src');
      try { el.load(); } catch (e) { /* nothing loaded */ }
      el.style.display = 'none';
    }
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    if (root) root.classList.remove('live');
  }

  function create(type) {
    teardown();
    failed = false;
    mime = type;
    const source = new MediaSource();
    ms = source;
    stalls = 0;
    jumps = 0;
    keys = [];
    lastJump = 0;
    jumped = false;
    lastTime = -1;
    lastProgress = now();
    source.addEventListener('sourceopen', function () {
      if (ms !== source) return;
      try {
        sb = source.addSourceBuffer(type);
      } catch (e) {
        refuse('addSourceBuffer: ' + (e && e.name));
        return;
      }
      sb.addEventListener('updateend', pump);
      sb.addEventListener('error', function () { if (ms === source) refuse('SourceBuffer error'); });
      pump();
    });
    el.style.display = 'block';
    el.muted = false;
    el.onplaying = function () {
      if (ms !== source) return;
      if (root) root.classList.add('live');
      if (!started) {
        started = true;
        report('playing', { w: el.videoWidth, h: el.videoHeight, muted: el.muted });
      }
    };
    el.onerror = function () {
      if (ms !== source) return;
      refuse('video error ' + (el.error ? el.error.code + ' ' + (el.error.message || '') : ''));
    };
    el.onwaiting = function () { if (ms === source) lastProgress = Math.min(lastProgress, now()); };
    objectUrl = URL.createObjectURL(source);
    el.src = objectUrl;
    controlTimer = setInterval(control, 500);
    statsTimer = setInterval(stats, 2000);
  }

  // The TV cannot play this stream: the PC tries the next format down (or JPEG frames).
  function refuse(reason) {
    if (failed) return;
    failed = true;
    teardown();
    report('refused', { reason: String(reason).slice(0, 160) });
  }

  // ---- appending ----

  function concat(parts) {
    if (parts.length === 1) return parts[0];
    let total = 0;
    parts.forEach(function (p) { total += p.byteLength; });
    const out = new Uint8Array(total);
    let at = 0;
    parts.forEach(function (p) { out.set(p, at); at += p.byteLength; });
    return out;
  }

  function pump() {
    if (!sb || sb.updating || !queue.length || !ms || ms.readyState !== 'open') return;
    const data = concat(queue);
    queue = [];
    queued = 0;
    try {
      sb.appendBuffer(data);
    } catch (e) {
      if (e && e.name === 'QuotaExceededError') {
        // Full: drop what has been played and start over from the next key frame.
        trim(true);
        resync('quota');
      } else {
        refuse('appendBuffer: ' + (e && e.name));
      }
    }
  }

  function resync(why) {
    queue = [];
    queued = 0;
    waitInit = true;
    report('resync', { reason: why });
  }

  function trim(hard) {
    if (!sb || sb.updating || !el.buffered.length) return;
    const start = el.buffered.start(0);
    const until = el.currentTime - (hard ? 1 : KEEP_BEHIND);
    if (until - start > (hard ? 0.5 : 4)) {
      try { sb.remove(start, until); } catch (e) { /* busy */ }
    }
  }

  // ---- keeping to the live edge ----

  // The start of a fragment's video: the first tfdt box (version 1: a 64-bit time) in its moof.
  function fragmentTime(data) {
    const n = Math.min(data.byteLength - 16, 512);
    for (let i = 4; i < n; i++) {
      if (data[i] === 0x74 && data[i + 1] === 0x66 && data[i + 2] === 0x64 && data[i + 3] === 0x74) {
        const v = new DataView(data.buffer, data.byteOffset + i + 4, 12);
        const t = v.getUint8(0) === 1 ? v.getUint32(4) * 4294967296 + v.getUint32(8) : v.getUint32(4);
        return t / VIDEO_TIMESCALE;
      }
    }
    return null;
  }

  function noteKey(data) {
    const t = fragmentTime(data);
    if (t === null) return;
    keys.push(t);
    if (keys.length > 8) keys.shift();
  }

  // The newest key frame that is in the buffer and at least `after` seconds in, or null.
  function newestKey(ranges, after) {
    const start = ranges.start(ranges.length - 1);
    const end = ranges.end(ranges.length - 1);
    for (let i = keys.length - 1; i >= 0; i--) {
      if (keys[i] >= start - 0.01 && keys[i] < end - 0.1 && keys[i] > after) return keys[i];
    }
    return null;
  }

  function jumpTo(t, why) {
    lastJump = now();
    jumps += 1;
    if (window.LumenBox) window.LumenBox.note('live-jump', { why: why, from: Math.round(el.currentTime * 100) / 100, to: Math.round(t * 100) / 100 });
    if (el.playbackRate !== 1) el.playbackRate = 1;
    el.currentTime = t;
  }

  function control() {
    if (!sb || !el || !el.buffered.length) return;
    const ranges = el.buffered;
    const end = ranges.end(ranges.length - 1);
    const t = el.currentTime;
    const lag = end - t;
    if (!started && !jumped) {
      // First data: start on the newest key frame (the stream itself starts on one).
      jumped = true;
      const k = newestKey(ranges, -1);
      const from = k === null ? ranges.start(ranges.length - 1) : k;
      if (Math.abs(from - t) > 0.05) el.currentTime = from;
      lastJump = now();
      const p = el.play();
      if (p && p.catch) p.catch(function () { el.muted = true; el.play().catch(function () {}); });
      return;
    }
    if (el.seeking) return;
    let inRange = false;
    for (let i = 0; i < ranges.length; i++) if (t >= ranges.start(i) - 0.05 && t <= ranges.end(i)) inRange = true;
    const canJump = now() - lastJump > JUMP_GAP_MS;
    if (!inRange || lag > HARD_LAG) {
      // In a hole (a skipped stretch) or far behind: on to the newest key frame, now and then.
      const k = canJump || !inRange ? newestKey(ranges, t + 0.5) : null;
      if (k !== null && (canJump || now() - lastJump > 1500)) { jumpTo(k, inRange ? 'behind' : 'hole'); return; }
    }
    if (lag > SOFT_LAG && el.playbackRate === 1) el.playbackRate = CATCH_UP_RATE;
    else if (lag < CALM_LAG && el.playbackRate !== 1) el.playbackRate = 1;
    if (el.paused) el.play().catch(function () {});
    // A clock that does not move while frames are buffered ahead is a stall: on past it.
    if (t !== lastTime) { lastTime = t; lastProgress = now(); } else if (lag > 0.3 && now() - lastProgress > STALL_MS) {
      stalls += 1;
      lastProgress = now();
      const k = newestKey(ranges, t + 0.2);
      if (k !== null && now() - lastJump > 1500) jumpTo(k, 'stall');
    }
    ticks += 1;
    if (ticks % TRIM_EVERY === 0) trim(false);
  }

  function stats() {
    if (!el || !ms) return;
    const q = el.getVideoPlaybackQuality ? el.getVideoPlaybackQuality() : null;
    const ranges = el.buffered;
    const end = ranges.length ? ranges.end(ranges.length - 1) : 0;
    report('stats', {
      lag: ranges.length ? Math.round((end - el.currentTime) * 1000) / 1000 : null,
      buffered: ranges.length ? Math.round((end - ranges.start(0)) * 10) / 10 : 0,
      dropped: q ? q.droppedVideoFrames : 0, decoded: q ? q.totalVideoFrames : 0,
      stalls: stalls, jumps: jumps, rate: el.playbackRate, w: el.videoWidth, h: el.videoHeight, muted: el.muted,
    });
  }

  // ---- messages ----

  function family(type) { return /hvc1|hev1/.test(String(type)) ? 'hevc' : 'avc'; }

  function supported(type) {
    if (!type || !window.MediaSource) return false;
    try { return MediaSource.isTypeSupported(String(type)); } catch (e) { return false; }
  }

  function onInit(g, info, data) {
    // The stream's exact codec string first, then the one this TV said it takes for the step.
    const exact = String(info.mime || '');
    const type = supported(exact) ? exact : supported(info.tvMime) ? String(info.tvMime) : null;
    if (!type) { gen = g; refuse('not supported: ' + exact.slice(0, 80)); return; }
    // Same codec family: a new resolution goes into the same buffer (MSE takes a new init segment).
    if (!ms || info.reset || family(type) !== family(mime)) create(type);
    gen = g;
    waitInit = false;
    queue.push(data);
    queued += data.byteLength;
    pump();
  }

  function onMedia(g, data, key) {
    if (g !== gen || waitInit || !ms) return;
    if (key) noteKey(data);
    queue.push(data);
    queued += data.byteLength;
    if (queued > MAX_QUEUE_BYTES) { resync('backlog'); return; }
    pump();
  }

  window.LumenLive = {
    init: function (sendFn, videoEl, rootEl) {
      send = sendFn;
      el = videoEl;
      root = rootEl;
    },
    /** A binary message from the PC: true when it was a live video message. */
    data: function (buffer) {
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) return false;
      const b = new Uint8Array(buffer, 0, 4);
      if (b[0] !== 0x4c || b[1] !== 0x56) return false; // 'LV'
      const view = new DataView(buffer);
      const g = view.getUint32(4);
      if (b[2] === 0x49 && buffer.byteLength >= 10) { // 'I'
        const len = view.getUint16(8);
        let info = null;
        try { info = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 10, len))); } catch (e) { info = null; }
        if (info) onInit(g, info, new Uint8Array(buffer, 10 + len));
      } else if (b[2] === 0x4d) { // 'M'
        onMedia(g, new Uint8Array(buffer, 8), (new Uint8Array(buffer, 3, 1)[0] & 1) === 1);
      }
      return true;
    },
    // This page went into the background (another app in front) or came back.
    hidden: function () {
      teardown();
      if (send) report('hidden');
    },
    visible: function () {
      if (send) report('visible');
    },
    message: function (msg) {
      if (msg.t === 'screen-live-offer') {
        if (!window.MediaSource || !el) report('unsupported', { reason: 'no MediaSource' });
        else report('ready', { caps: probe(msg.probes) });
      } else if (msg.t === 'screen-live-stop') {
        teardown();
      }
    },
    stop: teardown,
    isShowing: function () { return !!(ms && started); },
    /** A remote key was pressed: the sound comes on if autoplay had to start the video muted. */
    unmute: function () { if (el && el.muted && ms) el.muted = false; },
  };
})();
