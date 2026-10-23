// Lumen Agent: the "Lumen browser on TV" screen. The page is rendered on the PC (Lumen's own
// browser, behind the VPN when it is on) and arrives here as JPEG frames over the agent socket; the
// TV remote drives it (keys go back to the PC). Videos the page plays can be handed to the TV's own
// player (AVPlay) through Lumen's relay: full quality with sound. When AVPlay refuses a stream (clear
// fMP4 HLS is the usual case on this TV), hls.js on a <video> element takes over (up to 1080p,
// H.264/AAC), then a plain <video>: the order CineHD's media engine uses.
// Runs on Chromium M69, so the syntax stays within ES2017.
(function () {
  'use strict';

  const KEYS = {
    37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'enter', 10009: 'back',
    427: 'chup', 428: 'chdown', 403: 'red', 404: 'green', 405: 'yellow', 406: 'blue',
    10252: 'playpause', 415: 'play', 19: 'pause', 413: 'stop', 412: 'rewind', 417: 'ff',
    48: '0', 49: '1', 50: '2', 51: '3', 52: '4', 53: '5', 54: '6', 55: '7', 56: '8', 57: '9',
  };
  const REGISTER = ['ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
    'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const SEEK_MS = 10000;
  // hls.js / <video> in this page: how long a stream may sit in 'loading' before it counts as failed
  // (DRM waits for a licence round trip through Lumen's relay, so it gets longer).
  const MSE_START_MS = 30000;
  const MSE_START_DRM_MS = 45000;
  // Fatal hls.js media errors: recover at most this many times inside the window, then give up.
  const MEDIA_RECOVERIES = 2;
  const MEDIA_RECOVERY_WINDOW_MS = 30000;

  let send = function () { return false; };
  let active = false;
  let registered = false;
  let pendingFrame = null;
  let decoding = false;
  let currentUrl = null;
  let video = null; // { url, title, state, mode, engine, drm, started }
  let hintTimer = null;
  let startTimer = null;
  let pointerSent = 0;

  const root = document.getElementById('screen');
  const frame = document.getElementById('frame');
  const cursor = document.getElementById('cursor');
  const hint = document.getElementById('hint');
  const toastEl = document.getElementById('toast');
  const player = document.getElementById('av');
  const mse = document.getElementById('mse');
  const live = window.LumenLive || null; // live.js: the page as a video stream with sound
  let hls = null;

  function read(fn, fallback) {
    try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; }
  }

  function registerKeys() {
    if (registered) return;
    registered = true;
    REGISTER.forEach(function (name) { read(function () { tizen.tvinputdevice.registerKey(name); }); });
  }

  function unregisterKeys() {
    if (!registered) return;
    registered = false;
    REGISTER.forEach(function (name) { read(function () { tizen.tvinputdevice.unregisterKey(name); }); });
  }

  function showHint(text, ms) {
    hint.textContent = text;
    hint.className = 'hint show';
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { hint.className = 'hint'; }, ms || 6000);
  }

  function toast(text) {
    toastEl.textContent = text;
    toastEl.className = 'toast show';
    setTimeout(function () { toastEl.className = 'toast'; }, 3500);
  }

  // ---- frames ----

  function showFrame(buffer) {
    pendingFrame = buffer;
    if (decoding) return;
    const next = pendingFrame;
    pendingFrame = null;
    decoding = true;
    const url = URL.createObjectURL(new Blob([next], { type: 'image/jpeg' }));
    frame.onload = frame.onerror = function () {
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentUrl = url;
      decoding = false;
      if (pendingFrame) showFrame(pendingFrame);
    };
    frame.src = url;
  }

  // ---- input ----

  function onKey(e) {
    if (!active) return;
    const key = KEYS[e.keyCode];
    if (!key) return;
    e.preventDefault();
    e.stopPropagation();
    if (live) live.unmute();
    if (video) return videoKey(key);
    send({ t: 'screen-input', key: key, repeat: e.repeat === true });
  }

  function onPointer(e) {
    if (!active || video) return;
    const now = Date.now();
    if (e.type === 'mousemove' && now - pointerSent < 33) return;
    pointerSent = now;
    send({ t: 'screen-input', pointer: { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }, click: e.type === 'click' });
  }

  // A live video message from the PC ('LV' + 'I' or 'M', live.js), not a JPEG frame.
  function isLiveData(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) return false;
    const b = new Uint8Array(buffer, 0, 2);
    return b[0] === 0x4c && b[1] === 0x56;
  }

  // ---- the TV's own video player ----

  function playVideo(url, title, fromStart, engine, drm) {
    stopVideo(false);
    if (live) live.stop(); // one decoder for the TV's player
    video = { url: url, title: title || '', state: 'loading', mode: 'avplay', engine: engine || null, drm: drm || null, started: false };
    const mine = video;
    // AVPlay is one player shared by every video: a callback from a video that has since been
    // replaced (or moved to hls.js / <video>) must not act on the current one.
    function current() { return video === mine && mine.mode === 'avplay'; }
    root.className = 'screen video';
    document.body.classList.add('video');
    showHint((title ? title + ' · ' : '') + 'OK play/pause · ◀ ▶ 10 s · Back returns to the page', 7000);
    // Lumen found a format the TV's player does not take (fragmented-MP4 HLS): skip it.
    if (engine === 'hls') return refused(drm ? 'DRM-protected HLS' : 'fragmented-MP4 HLS', mine);
    let stage = 'webapis';
    try {
      if (typeof webapis === 'undefined' || !webapis.avplay) throw new Error('webapis.avplay is missing');
      stage = 'open';
      webapis.avplay.open(url);
      stage = 'setDisplayRect';
      webapis.avplay.setDisplayRect(0, 0, 1920, 1080);
      stage = 'setListener';
      webapis.avplay.setListener({
        onbufferingcomplete: function () { if (current()) report('playing'); },
        onstreamcompleted: function () { if (!current()) return; report('ended'); stopVideo(true); },
        onerror: function (err) { if (current()) refused('onerror: ' + String(err), mine); },
        oncurrentplaytime: function () {},
      });
      stage = 'prepareAsync';
      webapis.avplay.prepareAsync(function () {
        if (!current()) return;
        read(function () { webapis.avplay.play(); });
        report('playing');
        // A stream Lumen is still converting grows while it plays, so the player joins at its live
        // end; go back to the start once playback is running.
        if (fromStart) setTimeout(function () { if (current()) read(function () { webapis.avplay.seekTo(0); }); }, 1200);
        // AVPlay sometimes "plays" a stream it cannot decode, with a black screen and a clock that never
        // moves; treat that as a refusal.
        setTimeout(function () {
          if (!current()) return;
          const t = read(function () { return webapis.avplay.getCurrentTime(); }, 0);
          const state = read(function () { return webapis.avplay.getState(); }, '');
          if (state === 'PLAYING' && !(t > 0)) refused('AVPlay did not start (clock at ' + t + ')', mine);
        }, 10000);
      }, function (err) {
        if (current()) refused('prepare: ' + String(err && (err.name + ' ' + (err.message || '')) || err), mine);
      });
    } catch (e) {
      refused(stage + ': ' + String(e && (e.name + ' ' + (e.message || '')) || e), mine);
    }
  }

  // ---- fallback: hls.js / <video> in this page (CineHD's order: AVPlay, hls.js MSE, plain video) ----

  // mine: the video the refusal belongs to; a refusal for a video that is no longer current is dropped.
  function refused(reason, mine) {
    if (!video || (mine && video !== mine)) return;
    if (video.mode !== 'avplay') return failed(reason);
    read(function () { webapis.avplay.stop(); });
    read(function () { webapis.avplay.close(); });
    send({ t: 'screen-video', state: 'fallback', error: reason });
    const url = video.url;
    const drm = video.drm;
    // Lumen's engine:'hls' (it probed the playlist) and DRM (always HLS here) win over the URL's name,
    // which need not say .m3u8 (a playlist served as application/vnd.apple.mpegurl from any path).
    const isHls = video.engine === 'hls' || !!drm || /\.m3u8|\/relay\/x\//i.test(url) || /mpegurl/i.test(url);
    if (isHls && window.Hls && window.Hls.isSupported()) return playHls(url, reason, drm);
    // A plain <video> has no EME setup here, so a DRM stream cannot play through it.
    if (!drm && mse.canPlayType('video/mp4')) return playVideoElement(url, reason);
    failed(reason);
  }

  function failed(reason) {
    report('error', reason);
    toast('The TV could not play this video');
    stopVideo(true);
  }

  function useMse(mode) {
    const mine = video;
    mine.mode = mode;
    root.className = 'screen video mse';
    mse.style.display = 'block';
    mse.onplaying = function () { mine.started = true; clearTimeout(startTimer); startTimer = null; report('playing'); };
    mse.onpause = function () { if (video) report('paused'); };
    mse.onended = function () { report('ended'); stopVideo(true); };
    mse.onerror = function () { failed(mode + ': ' + String(mse.error && mse.error.code)); };
    // AVPlay has its "clock never moved" check; the in-page players get a start deadline: a stream
    // that never reaches 'playing' (keys that never arrive, endless non-fatal stalls, a relay that
    // sends nothing, a play() the TV rejected) is reported as failed so Lumen can fall back.
    clearTimeout(startTimer);
    startTimer = setTimeout(function () {
      startTimer = null;
      if (video !== mine || mine.mode !== mode || mine.started) return;
      failed(mode + ': did not start within ' + Math.round((mine.drm ? MSE_START_DRM_MS : MSE_START_MS) / 1000) + ' s');
    }, mine.drm ? MSE_START_DRM_MS : MSE_START_MS);
  }

  // drm: { keySystem: licence URL } (Lumen relays the licence request to the site's licence server);
  // the TV's own DRM module (PlayReady / Widevine, through EME) decrypts.
  function playHls(url, reason, drm) {
    useMse('hls');
    const config = { enableWorker: false, maxBufferLength: 20, maxMaxBufferLength: 30, maxBufferSize: 16 * 1024 * 1024, capLevelToPlayerSize: false };
    if (drm) {
      config.emeEnabled = true;
      config.drmSystems = {};
      Object.keys(drm).forEach(function (k) {
        const d = drm[k] || {};
        config.drmSystems[k] = { licenseUrl: String(d.licenseUrl || '') };
        if (d.serverCertificateUrl) config.drmSystems[k].serverCertificateUrl = String(d.serverCertificateUrl);
      });
    }
    hls = new window.Hls(config);
    const mine = hls;
    const Details = window.Hls.ErrorDetails || {};
    const NO_RECOVERY = [Details.MANIFEST_INCOMPATIBLE_CODECS_ERROR || 'manifestIncompatibleCodecsError',
      Details.BUFFER_INCOMPATIBLE_CODECS_ERROR || 'bufferIncompatibleCodecsError'];
    let recoveries = 0;
    let lastRecovery = 0;
    function describe(data) {
      return 'hls: ' + data.type + ' ' + data.details + (data.error && data.error.message ? ' (' + String(data.error.message).slice(0, 120) + ')' : '') + (data.response && data.response.code ? ' http ' + data.response.code : '');
    }
    hls.on(window.Hls.Events.MANIFEST_PARSED, function (ev, data) {
      // This TV's MSE path plays up to 1080p.
      let cap = -1;
      (data.levels || []).forEach(function (l, i) { if (!l.height || l.height <= 1080) cap = i; });
      if (cap >= 0) hls.autoLevelCapping = cap;
      mse.play().catch(function () {});
    });
    hls.on(window.Hls.Events.ERROR, function (ev, data) {
      if (!data || !data.fatal || hls !== mine) return;
      // A fatal media error has already been through hls.js's own recovery (and stopLoad). Re-attach
      // a limited number of times (the second time with the audio codec swapped, as hls.js
      // recommends), then report it, so Lumen can move on to its own fallback instead of a black
      // screen. Codecs the TV does not decode cannot be fixed by re-attaching.
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && NO_RECOVERY.indexOf(data.details) < 0) {
        const now = Date.now();
        if (now - lastRecovery > MEDIA_RECOVERY_WINDOW_MS) recoveries = 0;
        if (recoveries < MEDIA_RECOVERIES) {
          recoveries += 1;
          lastRecovery = now;
          const position = read(function () { return mse.currentTime; }, 0);
          if (recoveries > 1) read(function () { mine.swapAudioCodec(); });
          read(function () { mine.recoverMediaError(); });
          // recoverMediaError() only restarts loading from a non-zero position; a stream that failed
          // before its first frame would otherwise load nothing and stay black.
          if (!(position > 0)) read(function () { mine.startLoad(-1); });
          return;
        }
      }
      failed(describe(data));
    });
    hls.loadSource(url);
    hls.attachMedia(mse);
    send({ t: 'screen-video', state: 'loading', error: 'AVPlay refused (' + reason.slice(0, 60) + '), using hls.js' });
  }

  function playVideoElement(url, reason) {
    useMse('video');
    mse.src = url;
    mse.play().catch(function () {});
    send({ t: 'screen-video', state: 'loading', error: 'AVPlay refused (' + reason.slice(0, 60) + '), using <video>' });
  }

  function report(state, error) {
    if (!video) return;
    video.state = state;
    const inPage = video.mode !== 'avplay';
    send({ t: 'screen-video', state: state, error: error || null, mode: video.mode,
      position: inPage ? Math.round(mse.currentTime * 1000) : read(function () { return webapis.avplay.getCurrentTime(); }, null),
      duration: inPage ? Math.round((mse.duration || 0) * 1000) : read(function () { return webapis.avplay.getDuration(); }, null) });
  }

  function stopVideo(backToPage) {
    if (!video) return;
    clearTimeout(startTimer);
    startTimer = null;
    if (video.mode === 'avplay') {
      read(function () { webapis.avplay.stop(); });
      read(function () { webapis.avplay.close(); });
    } else {
      if (hls) { read(function () { hls.destroy(); }); hls = null; }
      mse.onplaying = mse.onpause = mse.onended = mse.onerror = null;
      read(function () { mse.pause(); });
      mse.removeAttribute('src');
      read(function () { mse.load(); });
      mse.style.display = 'none';
    }
    send({ t: 'screen-video', state: 'stopped' });
    video = null;
    document.body.classList.remove('video');
    root.className = active ? 'screen' : 'screen off';
    if (backToPage) showHint('Back to the page', 2500);
  }

  function videoKey(key) {
    if (video.mode !== 'avplay') {
      if (key === 'back' || key === 'stop') return stopVideo(true);
      if (key === 'enter' || key === 'playpause' || key === 'play' || key === 'pause') {
        if (!mse.paused && key !== 'play') mse.pause(); else mse.play().catch(function () {});
        return undefined;
      }
      if (key === 'left' || key === 'rewind') { mse.currentTime = Math.max(0, mse.currentTime - SEEK_MS / 1000); return undefined; }
      if (key === 'right' || key === 'ff') { mse.currentTime = mse.currentTime + SEEK_MS / 1000; return undefined; }
      return undefined;
    }
    const state = read(function () { return webapis.avplay.getState(); }, '');
    if (key === 'back' || key === 'stop') return stopVideo(true);
    if (key === 'enter' || key === 'playpause' || key === 'play' || key === 'pause') {
      if (state === 'PLAYING' && key !== 'play') read(function () { webapis.avplay.pause(); });
      else read(function () { webapis.avplay.play(); });
      return report(state === 'PLAYING' ? 'paused' : 'playing');
    }
    if (key === 'left' || key === 'rewind') return read(function () { webapis.avplay.jumpBackward(SEEK_MS); });
    if (key === 'right' || key === 'ff') return read(function () { webapis.avplay.jumpForward(SEEK_MS); });
  }

  // ---- API for agent.js ----

  window.LumenScreen = {
    init: function (sendFn) {
      send = sendFn;
      if (live) live.init(sendFn, document.getElementById('live'), root);
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('mousemove', onPointer, true);
      document.addEventListener('click', onPointer, true);
    },
    isActive: function () { return active; },
    start: function () {
      active = true;
      registerKeys();
      root.className = video ? 'screen video' : 'screen';
      showHint('◀ ▲ ▼ ▶ move · OK click · Back go back · CH ▲▼ scroll · Red close · Yellow play video on TV');
    },
    stop: function () {
      stopVideo(false);
      if (live) live.stop();
      active = false;
      unregisterKeys();
      root.className = 'screen off';
    },
    // Binary messages: live video ('LV…', live.js) or a JPEG frame.
    frame: function (buffer) {
      // While the TV's own player is in front, live video waits: the TV has one decoder for both,
      // and a live player started next to it leaves the video black and can crash this page.
      if (video && isLiveData(buffer)) return;
      if (live && live.data(buffer)) return;
      showFrame(buffer);
    },
    message: function (msg) {
      if (msg.t === 'screen-cursor') {
        cursor.style.transform = 'translate(' + Math.round(msg.x * 1920) + 'px,' + Math.round(msg.y * 1080) + 'px)';
        cursor.style.display = msg.visible === false ? 'none' : 'block';
      } else if (msg.t === 'screen-play') {
        playVideo(msg.url, msg.title, msg.fromStart === true, msg.engine, msg.drm && typeof msg.drm === 'object' ? msg.drm : null);
      } else if (msg.t.indexOf('screen-live') === 0) {
        if (live) live.message(msg);
        else send({ t: 'screen-live', state: 'unsupported', reason: 'no live player' });
      } else if (msg.t === 'screen-toast') {
        toast(String(msg.text || '').slice(0, 140));
      }
    },
  };
})();
