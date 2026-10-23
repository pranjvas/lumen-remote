// Lumen Agent: live video of Lumen's browser. The PC captures its browser page with its sound,
// encodes it (H.264 or HEVC + AAC) and sends fragmented MP4 over the agent socket: an init message
// ('LVI') then media fragments ('LVM'), each tagged with a stream generation. This plays them through
// MSE on a <video> under the pointer, kept at the live edge (small drift: a slightly faster rate;
// large: a jump), trims old buffer, recovers from stalls, and reports to the PC once a second so it
// can adapt the bitrate and resolution. When MSE refuses the stream the PC falls back to JPEG frames.
// Runs on Chromium M69 (Tizen 5.5): ES2017 syntax only (no ?. ?? or object spread).
(function () {
  'use strict';

  const TARGET_LAG = 0.08; // seconds behind the newest frame the player aims for
  const SOFT_LAG = 0.16; // above this the rate goes up, in proportion to the drift
  const HARD_LAG = 0.9; // above this the player jumps to the live edge
  const KEEP_BEHIND = 6; // seconds of played video kept in the buffer
  const MAX_QUEUE_BYTES = 12 * 1024 * 1024; // appends waiting beyond this: start over from a key frame
  const STALL_MS = 1500;

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
    controlTimer = setInterval(control, 250);
    statsTimer = setInterval(stats, 1000);
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
    parts.forEach(function (p) { out.set(new Uint8Array(p), at); at += p.byteLength; });
    return out.buffer;
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

  function control() {
    if (!sb || !el || !el.buffered.length) return;
    const ranges = el.buffered;
    const end = ranges.end(ranges.length - 1);
    const t = el.currentTime;
    const lag = end - t;
    if (!started && !jumped) {
      // First data: start just behind the newest frame.
      jumped = true;
      el.currentTime = Math.max(ranges.start(ranges.length - 1), end - TARGET_LAG);
      const p = el.play();
      if (p && p.catch) p.catch(function () { el.muted = true; el.play().catch(function () {}); });
      return;
    }
    // In a hole between ranges (a skipped stretch): on to the next range.
    let inRange = false;
    for (let i = 0; i < ranges.length; i++) if (t >= ranges.start(i) - 0.05 && t <= ranges.end(i)) inRange = true;
    if (!inRange || lag > HARD_LAG) {
      el.currentTime = Math.max(ranges.start(ranges.length - 1), end - TARGET_LAG);
      el.playbackRate = 1;
    } else if (lag > SOFT_LAG) {
      el.playbackRate = Math.min(1.25, 1 + (lag - TARGET_LAG) * 0.5);
    } else if (lag < TARGET_LAG + 0.03) {
      el.playbackRate = 1;
    }
    if (el.paused) el.play().catch(function () {});
    // A clock that does not move while frames are buffered ahead is a stall: jump past it.
    if (t !== lastTime) { lastTime = t; lastProgress = now(); } else if (lag > 0.25 && now() - lastProgress > STALL_MS) {
      stalls += 1;
      lastProgress = now();
      el.currentTime = Math.max(ranges.start(ranges.length - 1), end - TARGET_LAG);
    }
    trim(false);
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
      stalls: stalls, rate: el.playbackRate, w: el.videoWidth, h: el.videoHeight, muted: el.muted,
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

  function onMedia(g, data) {
    if (g !== gen || waitInit || !ms) return;
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
        if (info) onInit(g, info, buffer.slice(10 + len));
      } else if (b[2] === 0x4d) { // 'M'
        onMedia(g, buffer.slice(8));
      }
      return true;
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
