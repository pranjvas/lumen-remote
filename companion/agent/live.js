// Lumen Agent: live video of Lumen's browser. The PC captures its browser page with its sound,
// encodes it (H.264 or HEVC + AAC) and sends fragmented MP4 over the agent socket: an init message
// ('LVI') then media fragments ('LVM'), each tagged with a stream generation. This plays them through
// MSE on a <video> under the pointer, at normal speed always (the PC sheds lag: it skips media and
// keeps the timeline seamless), trims old buffer,
// and reports to the PC every 2 s so it can adapt the bitrate and resolution. A player that gets
// stuck, never starts or fails after it has played is never seeked: the PC starts it over (a new
// MediaSource), and when that happens again soon it steps down for a while (not for good: none of
// these say the TV cannot play the format). A stream MSE refuses before it ever plays is refused:
// the PC tries the next format down, then JPEG frames.
// Runs on Chromium M69 (Tizen 5.5): ES2017 syntax only (no ?. ?? or object spread).
(function () {
  'use strict';

  // Media arrives ~160 ms at a time, so the player stays a little behind the newest frame: closer,
  // it would run dry between fragments and stall. This TV's decoder lands every seek on the key frame
  // before the target (a key frame comes every second), and a seek flushes the hardware pipeline,
  // which can get this page killed within seconds: so the player seeks once, at its start, onto a key
  // frame it has seen arrive, and never again. Its speed is never changed either: at 1.1x this TV drops
  // frames, and the change back to 1x froze its picture for good (seen 24 Oct, DevTools: the clock
  // stopped at once with 7 s buffered ahead, until the player was started over).
  const KEEP_BEHIND = 4; // seconds of played video kept in the buffer
  const TRIM_EVERY = 10; // control ticks (500 ms) between buffer trims: remove() is not cheap here
  const MAX_QUEUE_BYTES = 8 * 1024 * 1024; // appends waiting beyond this: start over from a key frame
  const STALL_MS = 2500; // a clock that has not moved this long with frames ahead: a stall
  const STUCK_MS = 6000; // still stalled this long after: stuck, the PC starts the player over
  const SEEK_STUCK_MS = 3000; // a seek that has not finished in this long: stuck
  const START_MS = 8000; // a player that has not started this long after its creation: started over
  const RESYNC_GAP_MS = 30000; // at most one restart for lag or a hole asked by this page per this long
  const FAR_LAG = 6; // last resort: this far behind ...
  const FAR_MS = 10000; // ... for this long, or
  const OUT_MS = 3000; // the playhead outside every buffered range this long: a restart
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
  let jumps = 0; // seeks after the start: none any more (still reported for the PC's rate control)
  let createdAt = 0;
  let moved = false; // the clock has moved since this player started
  let stuckSince = 0; // a stall began (the clock stopped with frames ahead)
  let seekingSince = 0;
  let farSince = 0;
  let outSince = 0;
  let askedAt = 0; // a fresh start was asked of the PC: nothing is judged until its init comes
  let asks = 0; // fresh starts asked since the PC's last init
  let lastResyncAt = 0; // across players (not reset in create())

  function now() { return Date.now(); }
  function noop() {}
  function r2(v) { return Math.round(v * 100) / 100; }
  function note(kind, data) { if (window.LumenBox) window.LumenBox.note(kind, data); }

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
    askedAt = asks = 0;
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
    jumped = false;
    lastTime = -1;
    lastProgress = now();
    createdAt = now();
    moved = false;
    stuckSince = seekingSince = farSince = outSince = 0;
    if (el.playbackRate !== 1) el.playbackRate = 1;
    source.addEventListener('sourceopen', function () {
      if (ms !== source) return;
      try {
        sb = source.addSourceBuffer(type);
      } catch (e) {
        refuse('addSourceBuffer: ' + (e && e.name));
        return;
      }
      sb.addEventListener('updateend', pump);
      sb.addEventListener('error', function () { if (ms === source) fail('SourceBuffer error'); });
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
      fail('video error ' + (el.error ? el.error.code + ' ' + (el.error.message || '') : ''));
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

  // The player failed. One that never played: the TV cannot play this stream (refused). One that
  // has played: the format is fine, the player broke; the PC starts it over (and steps down for a
  // while when that keeps happening).
  function fail(reason) {
    if (failed) return;
    if (!started && !moved) { refuse(reason); return; }
    failed = true;
    teardown();
    lastResyncAt = now();
    report('resync', { reason: 'error', on: String(reason).slice(0, 160) });
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
        fail('appendBuffer: ' + (e && e.name));
      }
    }
  }

  // The PC answers with a fresh init segment (reset: a new MediaSource) and a key frame.
  function resync(why, detail) {
    queue = [];
    queued = 0;
    waitInit = true;
    askedAt = now();
    asks += 1;
    const extra = { reason: why };
    if (detail) extra.on = detail;
    report('resync', extra);
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
      if (keys[i] >= start - 0.03 && keys[i] < end - 0.1 && keys[i] > after) return keys[i];
    }
    return null;
  }

  // The player is stuck (its clock stopped with frames ahead, or a seek never finished). It is not
  // seeked: the PC starts it over from a key frame in a new MediaSource, every time (a stuck player
  // left alone is a frozen picture). The PC counts how often: again within two minutes, it steps
  // down for a while. Never a refusal: the TV can play the format.
  function stuck(why) {
    const t = now();
    stuckSince = seekingSince = 0;
    lastProgress = t;
    lastResyncAt = t;
    resync('stuck', why);
  }

  // Last resort for a player that is far behind or in a hole (the PC normally sheds lag itself).
  function restart(why) {
    farSince = outSince = 0;
    const t = now();
    if (t - lastResyncAt < RESYNC_GAP_MS) return;
    lastResyncAt = t;
    resync(why);
  }

  function control() {
    if (!el || !ms) return;
    const at = now();
    if (askedAt) {
      // A fresh start was asked: this player is not judged again (that would ask again every check).
      // The PC answers at once; no answer in a while, it is asked once more, and then this player
      // gives up (the PC goes back to frames) rather than show a frozen picture for good.
      if (at - askedAt >= START_MS) {
        if (asks >= 2) { teardown(); report('error', { reason: 'no fresh start from the PC' }); }
        else resync('no answer');
      }
      return;
    }
    // No start (no 'playing', a clock that never moved, or a MediaSource that never opened): the PC
    // starts it over. Not a refusal: a slow start (the TV's one decoder just released by its own
    // player) does not mean the TV cannot play the format.
    if (!started && !moved && at - createdAt >= START_MS) { lastResyncAt = at; resync('stuck', 'start'); return; }
    if (!sb || !el.buffered.length) return;
    const ranges = el.buffered;
    const end = ranges.end(ranges.length - 1);
    const t = el.currentTime;
    const lag = end - t;
    if (!started && !jumped) {
      // First data: start on the newest key frame (the stream itself starts on one). The only seek.
      jumped = true;
      const k = newestKey(ranges, -1);
      const from = k === null ? ranges.start(ranges.length - 1) : k;
      if (Math.abs(from - t) > 0.05) el.currentTime = from;
      const p = el.play();
      if (p && p.catch) p.catch(function () { el.muted = true; el.play().catch(noop); });
      return;
    }
    if (el.seeking) {
      // A seek that never finishes would hold this loop for good.
      seekingSince = seekingSince || at;
      if (at - seekingSince > SEEK_STUCK_MS) stuck('seeking');
      return;
    }
    seekingSince = 0;
    if (el.paused) el.play().catch(noop);
    if (t !== lastTime) {
      if (lastTime >= 0) {
        moved = true;
        if (t < lastTime - 0.05) note('live-back', { from: r2(lastTime), to: r2(t) });
      }
      lastTime = t;
      lastProgress = at;
      stuckSince = 0;
    } else if (lag > 0.3 && at - lastProgress >= STALL_MS) {
      // A clock that does not move while frames are buffered ahead: a stall (one per episode).
      lastProgress = at;
      if (!stuckSince) { stalls += 1; stuckSince = at; }
      el.play().catch(noop);
    }
    if (stuckSince && at - stuckSince >= STUCK_MS) { stuck('clock'); return; }
    let inRange = false;
    for (let i = 0; i < ranges.length; i++) if (t >= ranges.start(i) - 0.05 && t <= ranges.end(i)) inRange = true;
    outSince = inRange ? 0 : outSince || at;
    farSince = lag > FAR_LAG ? farSince || at : 0;
    if (outSince && at - outSince > OUT_MS) restart('hole');
    else if (farSince && at - farSince > FAR_MS) restart('behind');
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
    askedAt = asks = 0;
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
