// Lumen Agent: the "Lumen browser on TV" screen. The page is rendered on the PC (Lumen's own
// browser, behind the VPN when it is on) and arrives here as JPEG frames over the agent socket; the
// TV remote drives it (keys go back to the PC). Videos the page plays can be handed to the TV's own
// player (AVPlay) through Lumen's relay: full quality with sound. When AVPlay refuses a stream (clear
// fMP4 HLS is the usual case on this TV), hls.js on a <video> element takes over (up to 1080p,
// H.264/AAC), then a plain <video>: the order CineHD's media engine uses.
// Runs on Chromium M69, so the syntax stays within ES2017 (no ?. ?? or object spread).
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
  // AVPlay whose prepare never calls back (a black screen and no report): it counts as refused after
  // this long. A big MP4 through the VPN can take a while to open.
  const AVPLAY_START_MS = 40000;
  // Fatal hls.js media errors: recover at most this many times inside the window, then give up.
  const MEDIA_RECOVERIES = 2;
  const MEDIA_RECOVERY_WINDOW_MS = 30000;
  // A stream that broke after it played (a VPN blip, a relay 502) continues where it was, at most this
  // many times a minute, instead of starting over in another player.
  const RESUMES = 2;
  const RESUME_WINDOW_MS = 60000;
  const RESUME_MIN_MS = 5000;
  const LINK_DOWN_MS = 60000; // the PC not answering this long: the screen closes
  const LINK_HINT = 'Lumen on the PC is not answering · reconnecting · Back closes';

  let send = function () { return false; };
  let onClosed = function () {};
  let active = false;
  let registered = false;
  let pendingFrame = null;
  let decoding = false;
  let currentUrl = null;
  // { id, url, title, state, mode, engine, kind, drm, started, reported, played, position, resumes,
  //   netRetries, reloaded, hidden, suspended, closed, resumeAt, attempt }
  let video = null;
  const DECODER_HANDOVER_MS = 900; // live video's decoder released before AVPlay opens
  let hintTimer = null;
  let toastTimer = null;
  let startTimer = null;
  let pointerSent = 0;
  let linkDown = false;
  let linkTimer = null;
  let pendingPlay = null; // a screen-play that came while this page was in the background

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
  function pageHidden() { return !!(document && document.hidden); }

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

  // ms 0: the hint stays until something replaces it.
  function showHint(text, ms) {
    hint.textContent = text;
    hint.className = 'hint show';
    clearTimeout(hintTimer);
    hintTimer = null;
    if (ms === 0) return;
    hintTimer = setTimeout(function () { hint.className = 'hint'; }, ms || 6000);
  }

  function toast(text) {
    toastEl.textContent = text;
    toastEl.className = 'toast show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, 3500);
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
    // The PC is not answering: Back and Red still close the screen here.
    if (linkDown && (key === 'back' || key === 'red')) return closeScreen();
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

  function avplayTime() { return read(function () { return webapis.avplay.getCurrentTime(); }, null); }

  // AVPlay draws under the page: everything above it must be see-through, the page's root included
  // (html's own dark background hid every video, with the clock running: seen 24 Oct with Eyes).
  function videoLayer(on) {
    [document.documentElement, document.body].forEach(function (el) {
      if (el) el.classList[on ? 'add' : 'remove']('video');
    });
  }

  // A screen-video message about the current video (the PC matches `id` to the stream it sent).
  function sendVideo(fields) {
    const msg = { t: 'screen-video' };
    Object.keys(fields).forEach(function (k) { msg[k] = fields[k]; });
    if (video && typeof video.id === 'number' && msg.id === undefined) msg.id = video.id;
    return send(msg);
  }

  function playVideo(url, title, fromStart, engine, drm, kind, startAt, id) {
    stopVideo(false);
    // One decoder for the TV's player and the live video: a live player that was showing needs a
    // moment to let it go, or AVPlay starts with sound and a black picture.
    const hadLive = !!(live && live.isShowing && live.isShowing());
    if (live) live.stop();
    video = { id: typeof id === 'number' ? id : null, url: url, title: title || '', state: 'loading', mode: 'avplay', engine: engine || null, kind: kind || null,
      drm: drm || null, started: false, reported: false, played: false, position: 0, resumes: [], netRetries: [], reloaded: false,
      hidden: false, suspended: false, closed: false, resumeAt: 0, attempt: 0 };
    const mine = video;
    root.className = 'screen video';
    videoLayer(true);
    showHint((title ? title + ' · ' : '') + 'OK play/pause · ◀ ▶ 10 s · Yellow convert · Back returns to the page', 7000);
    // Lumen found a format the TV's player does not take (fragmented-MP4 HLS): skip it.
    if (engine === 'hls') return refused(drm ? 'DRM-protected HLS' : 'fragmented-MP4 HLS', mine);
    if (hadLive) setTimeout(function () { if (video === mine) openAvplay(mine, startAt > 0 ? startAt : 0, fromStart); }, DECODER_HANDOVER_MS);
    else openAvplay(mine, startAt > 0 ? startAt : 0, fromStart);
  }

  // AVPlay is one player shared by every video: a callback from a video that has since been replaced
  // (or moved to hls.js / <video>), or from an earlier open of the same video, must not act on it.
  function openAvplay(mine, startAtMs, fromStart) {
    mine.attempt += 1;
    mine.started = false;
    const attempt = mine.attempt;
    function current() { return video === mine && mine.mode === 'avplay' && mine.attempt === attempt; }
    let stage = 'webapis';
    try {
      if (typeof webapis === 'undefined' || !webapis.avplay) throw new Error('webapis.avplay is missing');
      stage = 'open';
      webapis.avplay.open(mine.url);
      stage = 'setDisplayRect';
      webapis.avplay.setDisplayRect(0, 0, 1920, 1080);
      stage = 'setListener';
      webapis.avplay.setListener({
        onbufferingcomplete: function () { if (current()) { mine.reported = true; report('playing'); } },
        onstreamcompleted: function () { if (!current()) return; report('ended'); stopVideo(true); },
        onerror: function (err) { if (current()) avplayError('onerror: ' + String(err), mine); },
        // The clock is the one sure sign the video plays (a converted copy may never call prepare back).
        oncurrentplaytime: function (ms) {
          if (!current() || !(ms > 0)) return;
          mine.played = true;
          mine.position = ms;
          if (!mine.reported) { mine.reported = true; report('playing'); }
        },
      });
      stage = 'prepareAsync';
      webapis.avplay.prepareAsync(function () {
        if (!current()) return;
        mine.started = true;
        clearTimeout(startTimer);
        startTimer = null;
        read(function () { webapis.avplay.play(); });
        mine.reported = true;
        report('playing');
        // A stream Lumen is still converting grows while it plays, so the player joins at its live
        // end: back to the start once playback is running (or on to where a broken stream was).
        const seekTo = startAtMs > 0 ? startAtMs : fromStart ? 0 : -1;
        if (seekTo >= 0) setTimeout(function () { if (current()) read(function () { webapis.avplay.seekTo(seekTo); }); }, 1200);
        // AVPlay sometimes "plays" a stream it cannot decode, with a black screen and a clock that never
        // moves; treat that as a refusal (not while in the background: the clock stops there).
        setTimeout(function () {
          if (!current() || pageHidden() || mine.hidden) return;
          const t = read(function () { return webapis.avplay.getCurrentTime(); }, 0);
          const state = read(function () { return webapis.avplay.getState(); }, '');
          if (state === 'PLAYING' && !(t > 0)) refused('AVPlay did not start (clock at ' + t + ')', mine);
        }, 10000);
      }, function (err) {
        if (current()) refused('prepare: ' + String(err && (err.name + ' ' + (err.message || '')) || err), mine);
      });
      clearTimeout(startTimer);
      startTimer = setTimeout(function () {
        startTimer = null;
        if (!current() || mine.started) return;
        refused('AVPlay did not start within ' + Math.round(AVPLAY_START_MS / 1000) + ' s', mine);
      }, AVPLAY_START_MS);
    } catch (e) {
      refused(stage + ': ' + String(e && (e.name + ' ' + (e.message || '')) || e), mine);
    }
  }

  function canResume(mine) {
    const now = Date.now();
    mine.resumes = mine.resumes.filter(function (t) { return now - t < RESUME_WINDOW_MS; });
    if (mine.resumes.length >= RESUMES) return false;
    mine.resumes.push(now);
    return true;
  }

  // AVPlay's error after the video played a while: the same player opens it again where it was
  // (never through stopVideo/playVideo: their 'stopped' would make the PC resume live video).
  function avplayError(reason, mine) {
    if (mine.played && mine.position > RESUME_MIN_MS && !pageHidden() && canResume(mine)) {
      const at = mine.position;
      read(function () { webapis.avplay.stop(); });
      read(function () { webapis.avplay.close(); });
      mine.state = 'loading';
      sendVideo({ state: 'loading', error: 'retrying at ' + at, mode: 'avplay', position: at, played: true });
      openAvplay(mine, at, false);
      return;
    }
    refused(reason, mine);
  }

  // ---- fallback: hls.js / <video> in this page (CineHD's order: AVPlay, hls.js MSE, plain video) ----

  // mine: the video the refusal belongs to; a refusal for a video that is no longer current is dropped.
  function refused(reason, mine) {
    if (!video || (mine && video !== mine)) return;
    if (video.mode !== 'avplay') return failed(reason);
    clearTimeout(startTimer);
    startTimer = null;
    read(function () { webapis.avplay.stop(); });
    read(function () { webapis.avplay.close(); });
    // In the background the decoder belongs to the app in front: no other player starts here.
    if (pageHidden()) return stopHidden();
    sendVideo({ state: 'fallback', error: reason });
    const url = video.url;
    const drm = video.drm;
    const at = video.played ? video.position : 0;
    // Lumen's engine:'hls' or kind:'hls' (it probed the playlist) and DRM (always HLS here) win over
    // the URL's name, which need not say .m3u8 (a playlist served as application/vnd.apple.mpegurl).
    const isHls = video.engine === 'hls' || video.kind === 'hls' || !!drm || /\.m3u8|\/relay\/x\//i.test(url) || /mpegurl/i.test(url);
    if (isHls && window.Hls && window.Hls.isSupported()) return playHls(url, reason, drm, at);
    // A plain <video> has no EME setup here, so a DRM stream cannot play through it.
    if (!drm && mse.canPlayType('video/mp4')) return playVideoElement(url, reason, at);
    failed(reason);
  }

  // The PC shows its own message at the end of its ladder (it may still convert the stream).
  function failed(reason) {
    if (!video) return;
    if (pageHidden()) return stopHidden();
    report('error', reason);
    stopVideo(true);
  }

  function stopHidden() {
    stopVideo(false, 'hidden');
  }

  // AVPlay has its start deadline and "clock never moved" check; the in-page players get a start
  // deadline too: a stream that never reaches 'playing' (keys that never arrive, endless non-fatal
  // stalls, a relay that sends nothing, a play() the TV rejected) is reported as failed so Lumen can
  // fall back.
  function armMseStart(mine, mode) {
    clearTimeout(startTimer);
    const ms = mine.drm ? MSE_START_DRM_MS : MSE_START_MS;
    startTimer = setTimeout(function () {
      startTimer = null;
      if (video !== mine || mine.mode !== mode || mine.started) return;
      failed(mode + ': did not start within ' + Math.round(ms / 1000) + ' s');
    }, ms);
  }

  function useMse(mode) {
    const mine = video;
    mine.mode = mode;
    root.className = 'screen video mse';
    mse.style.display = 'block';
    mse.onplaying = function () { mine.started = true; mine.reported = true; clearTimeout(startTimer); startTimer = null; report('playing'); };
    mse.onpause = function () { if (video) report('paused'); };
    mse.onended = function () { report('ended'); stopVideo(true); };
    mse.ontimeupdate = function () {
      const t = read(function () { return mse.currentTime; }, 0);
      if (video === mine && t > 0) { mine.played = true; mine.position = Math.round(t * 1000); }
    };
    mse.onerror = function () {
      const code = mse.error && mse.error.code;
      // A network error after the video played: load it again once, where it was.
      if (mode === 'video' && code === 2 && mine.played && !mine.reloaded && video === mine) {
        mine.reloaded = true;
        mse.src = String(mine.url).split('#')[0] + '#t=' + mine.position / 1000;
        mse.play().catch(function () {});
        return;
      }
      failed(mode + ': ' + String(code));
    };
    armMseStart(mine, mode);
  }

  // drm: { keySystem: licence URL } (Lumen relays the licence request to the site's licence server);
  // the TV's own DRM module (PlayReady / Widevine, through EME) decrypts. at: ms to start from.
  function playHls(url, reason, drm, at) {
    useMse('hls');
    const mineVideo = video;
    const config = { enableWorker: false, maxBufferLength: 20, maxMaxBufferLength: 30, maxBufferSize: 16 * 1024 * 1024, capLevelToPlayerSize: false };
    if (at > 0) config.startPosition = at / 1000;
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
    const NETWORK_RETRY = [Details.FRAG_LOAD_ERROR || 'fragLoadError', Details.FRAG_LOAD_TIMEOUT || 'fragLoadTimeOut',
      Details.LEVEL_LOAD_ERROR || 'levelLoadError', Details.LEVEL_LOAD_TIMEOUT || 'levelLoadTimeOut'];
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
      // A network error once the video played (a VPN blip): loading goes on where it was, a couple
      // of times a minute.
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && mineVideo && mineVideo.played && NETWORK_RETRY.indexOf(data.details) >= 0) {
        const now = Date.now();
        mineVideo.netRetries = mineVideo.netRetries.filter(function (t) { return now - t < RESUME_WINDOW_MS; });
        if (mineVideo.netRetries.length < RESUMES) {
          mineVideo.netRetries.push(now);
          read(function () { mine.startLoad(); });
          return;
        }
      }
      failed(describe(data));
    });
    hls.loadSource(url);
    hls.attachMedia(mse);
    sendVideo({ state: 'loading', error: 'AVPlay refused (' + reason.slice(0, 60) + '), using hls.js' });
  }

  function playVideoElement(url, reason, at) {
    useMse('video');
    mse.src = at > 0 ? String(url).split('#')[0] + '#t=' + at / 1000 : url;
    mse.play().catch(function () {});
    sendVideo({ state: 'loading', error: 'AVPlay refused (' + reason.slice(0, 60) + '), using <video>' });
  }

  function positionNow() {
    if (!video) return null;
    if (video.mode !== 'avplay') return Math.round(read(function () { return mse.currentTime; }, 0) * 1000);
    return avplayTime() || video.position || null;
  }

  function report(state, error) {
    if (!video) return;
    video.state = state;
    const inPage = video.mode !== 'avplay';
    sendVideo({ state: state, error: error || null, mode: video.mode, played: video.played === true,
      position: positionNow(),
      duration: inPage ? Math.round((mse.duration || 0) * 1000) : read(function () { return webapis.avplay.getDuration(); }, null) });
  }

  function stopVideo(backToPage, reason) {
    if (!video) return;
    clearTimeout(startTimer);
    startTimer = null;
    if (video.mode === 'avplay') {
      read(function () { webapis.avplay.stop(); });
      read(function () { webapis.avplay.close(); });
    } else {
      if (hls) { read(function () { hls.destroy(); }); hls = null; }
      mse.onplaying = mse.onpause = mse.onended = mse.onerror = mse.ontimeupdate = null;
      read(function () { mse.pause(); });
      mse.removeAttribute('src');
      read(function () { mse.load(); });
      mse.style.display = 'none';
    }
    sendVideo(reason ? { state: 'stopped', reason: reason } : { state: 'stopped' });
    video = null;
    videoLayer(false);
    root.className = active ? 'screen' : 'screen off';
    if (backToPage) showHint(linkDown ? LINK_HINT : 'Back to the page', linkDown ? 0 : 2500);
  }

  function videoKey(key) {
    video.reported = true;
    // Yellow on a video: Lumen converts it on the PC (a black picture, a refusal the TV did not report).
    if (key === 'yellow') { send({ t: 'screen-input', key: 'convert' }); return undefined; }
    if (key === 'back' || key === 'stop') return stopVideo(true);
    if (key === 'enter' || key === 'playpause') return playPause('toggle');
    if (key === 'play' || key === 'pause') return playPause(key);
    if (key === 'left' || key === 'rewind') return seekBy(-SEEK_MS);
    if (key === 'right' || key === 'ff') return seekBy(SEEK_MS);
    return undefined;
  }

  // action: toggle | play | pause (Pause on a paused video leaves it paused).
  function playPause(action) {
    if (!video) return undefined;
    if (video.mode !== 'avplay') {
      if (action === 'play' || (action === 'toggle' && mse.paused)) mse.play().catch(function () {});
      else mse.pause();
      return undefined;
    }
    const playing = read(function () { return webapis.avplay.getState(); }, '') === 'PLAYING';
    if (action === 'play' || (action === 'toggle' && !playing)) {
      read(function () { webapis.avplay.play(); });
      return report('playing');
    }
    read(function () { webapis.avplay.pause(); });
    return report('paused');
  }

  // ---- seeking: the remote's ◀ ▶ (⏪ ⏩) and the phone's controls ----

  // AVPlay answers a seek through callbacks and takes one at a time. Called without them (jumpForward
  // bare, as before 0.9.4) its refusals were lost: on 25 Oct this TV answered every seekTo and
  // jumpForward on a relayed MP4 with PLAYER_ERROR_INVALID_STATE while it played, and ◀ ▶ did
  // nothing. A refused seek now goes on in the page's own player from the target (it seeks over HTTP
  // ranges itself), and the PC is told. Presses while a seek runs add up to one more seek.
  const SEEK_ANSWER_MS = 15000; // a seek with no answer by then is let go
  let seeking = null; // { mine, target, next, timer }

  function clock(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const two = function (n) { return n < 10 ? '0' + n : String(n); };
    return h > 0 ? h + ':' + two(m) + ':' + two(sec) : m + ':' + two(sec);
  }

  function errorText(e) {
    return String(e && e.name ? e.name + ' ' + (e.message || '') : e).trim().slice(0, 120);
  }

  // The video's length in ms (0: unknown).
  function durationNow() {
    if (!video) return 0;
    if (video.mode !== 'avplay') {
      const d = read(function () { return mse.duration; }, 0);
      return isFinite(d) && d > 0 ? Math.round(d * 1000) : 0;
    }
    const d = read(function () { return webapis.avplay.getDuration(); }, 0);
    return d > 0 ? d : 0;
  }

  // Where the player is, for the PC (like a heartbeat: the phone's seek bar follows it, nothing is logged).
  function reportClock() {
    if (!video) return;
    sendVideo({ state: video.state, mode: video.mode, position: positionNow(), duration: durationNow() || null, heartbeat: true });
  }

  function seekBy(deltaMs) {
    if (!video) return undefined;
    const pending = seeking && seeking.mine === video ? (seeking.next !== null ? seeking.next : seeking.target) : null;
    return seekTo((pending !== null ? pending : positionNow() || 0) + deltaMs);
  }

  function seekTo(ms) {
    if (!video) return undefined;
    const mine = video;
    const duration = durationNow();
    const target = Math.max(0, duration > 0 ? Math.min(ms, duration - 1000) : ms);
    const from = seeking && seeking.mine === mine ? (seeking.next !== null ? seeking.next : seeking.target) : positionNow() || 0;
    showHint((target < from ? '◀◀ ' : '▶▶ ') + clock(target) + (duration > 0 ? ' / ' + clock(duration) : ''), 2500);
    if (mine.mode !== 'avplay') {
      read(function () { mse.currentTime = target / 1000; });
      mine.position = target;
      reportClock();
      return undefined;
    }
    if (seeking && seeking.mine === mine) { seeking.next = target; return undefined; }
    avplaySeek(mine, target);
    return undefined;
  }

  function avplaySeek(mine, target) {
    const op = { mine: mine, target: target, next: null, timer: null };
    seeking = op;
    function settle(ok, why) {
      if (seeking !== op) return;
      clearTimeout(op.timer);
      seeking = null;
      if (video !== mine || mine.mode !== 'avplay') return;
      if (ok === false) { seekRefused(mine, op.next !== null ? op.next : target, why); return; }
      if (ok) mine.position = target;
      if (op.next !== null && op.next !== target) { avplaySeek(mine, op.next); return; }
      reportClock();
    }
    op.timer = setTimeout(function () { settle(null); }, SEEK_ANSWER_MS);
    try {
      webapis.avplay.seekTo(target, function () { settle(true); }, function (e) { settle(false, errorText(e)); });
    } catch (e) {
      settle(false, errorText(e));
    }
  }

  // AVPlay will not seek this stream: the page's own player (hls.js or <video>) takes it from the target.
  function seekRefused(mine, target, why) {
    sendVideo({ state: mine.state, mode: 'avplay', error: 'seek refused: ' + why, position: positionNow() });
    mine.played = true;
    mine.position = target;
    showHint('▶▶ ' + clock(target) + ' · switching player', 3000);
    refused('seek refused: ' + why, mine);
  }

  // The phone's controls (Lumen's tvscreen.control): { action: toggle | play | pause | seek | skip,
  // position (ms) | by (ms), id }. A control meant for another stream is dropped.
  function control(msg) {
    if (!active || !video) return;
    if (typeof msg.id === 'number' && typeof video.id === 'number' && msg.id !== video.id) return;
    video.reported = true;
    if (msg.action === 'seek' && typeof msg.position === 'number' && isFinite(msg.position)) seekTo(msg.position);
    else if (msg.action === 'skip' && typeof msg.by === 'number' && isFinite(msg.by)) seekBy(msg.by);
    else if (msg.action === 'toggle' || msg.action === 'play' || msg.action === 'pause') playPause(msg.action);
  }

  // ---- this page in the background (another app in front): the TV's one decoder is let go ----

  function onHidden() {
    if (!video) return;
    const mine = video;
    mine.hidden = true;
    clearTimeout(startTimer);
    startTimer = null;
    if (mine.mode === 'avplay') {
      try {
        webapis.avplay.suspend();
        mine.suspended = true;
      } catch (e) {
        mine.resumeAt = avplayTime() || mine.position || 0;
        read(function () { webapis.avplay.stop(); });
        read(function () { webapis.avplay.close(); });
        mine.closed = true;
      }
    } else {
      if (hls) { const h = hls; read(function () { h.stopLoad(); }); }
      read(function () { mse.pause(); });
    }
    mine.state = 'paused';
    sendVideo({ state: 'paused', reason: 'hidden', mode: mine.mode, played: mine.played === true, position: mine.position || null });
  }

  function onVisible() {
    if (pendingPlay) {
      const p = pendingPlay;
      pendingPlay = null;
      if (active) startPlay(p);
      return;
    }
    if (!video || !video.hidden) return;
    const mine = video;
    mine.hidden = false;
    if (mine.mode === 'avplay') {
      if (mine.suspended) {
        mine.suspended = false;
        try {
          try { webapis.avplay.restore(); } catch (e) { webapis.avplay.restore(mine.url, mine.position || 0, true); }
          if (read(function () { return webapis.avplay.getState(); }, '') !== 'PLAYING') webapis.avplay.play();
          mine.reported = true;
          report('playing');
        } catch (e) {
          refused('restore: ' + String(e && (e.name || e.message) || e), mine);
        }
      } else if (mine.closed) {
        mine.closed = false;
        openAvplay(mine, mine.resumeAt || 0, false);
      }
      return;
    }
    if (hls) { const h = hls; read(function () { h.startLoad(-1); }); }
    mse.play().catch(function () {});
    if (!mine.started) armMseStart(mine, mine.mode);
  }

  function startPlay(msg) {
    const startAt = typeof msg.startAt === 'number' && isFinite(msg.startAt) && msg.startAt > 0 ? msg.startAt : 0;
    playVideo(msg.url, msg.title, msg.fromStart === true, msg.engine, msg.drm && typeof msg.drm === 'object' ? msg.drm : null,
      msg.kind === 'hls' ? 'hls' : null, startAt, typeof msg.id === 'number' ? msg.id : null);
  }

  // ---- the link to the PC ----

  function closeScreen() {
    window.LumenScreen.stop();
    read(function () { onClosed(); });
  }

  // ---- API for agent.js ----

  window.LumenScreen = {
    init: function (sendFn, options) {
      send = sendFn;
      if (options && typeof options.onClosed === 'function') onClosed = options.onClosed;
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
      pendingPlay = null;
      stopVideo(false);
      if (live) live.stop();
      active = false;
      linkDown = false;
      clearTimeout(linkTimer);
      linkTimer = null;
      unregisterKeys();
      root.className = 'screen off';
    },
    /** What the screen shows, for the hello (the PC carries on after a reconnect). */
    state: function () {
      return {
        active: active,
        hidden: pageHidden(),
        video: video ? { state: video.state, mode: video.mode, position: positionNow(), id: video.id } : null,
      };
    },
    /** Every few seconds while a video is in front: where its clock is (the PC's view of it drifts otherwise). */
    heartbeat: function () {
      if (!active || !video) return;
      sendVideo({ state: video.state, mode: video.mode, position: positionNow(),
        duration: video.mode !== 'avplay' ? Math.round((mse.duration || 0) * 1000) : read(function () { return webapis.avplay.getDuration(); }, null),
        heartbeat: true });
    },
    /** The PC link dropped while the screen is on: say so, let Back and Red close it, and close it
     *  after a minute. A video playing in the TV's own player keeps playing meanwhile. */
    linkDown: function () {
      if (!active) return;
      linkDown = true;
      if (!video) showHint(LINK_HINT, 0);
      clearTimeout(linkTimer);
      linkTimer = setTimeout(function () {
        linkTimer = null;
        if (linkDown && active) closeScreen();
      }, LINK_DOWN_MS);
    },
    linkUp: function () {
      if (!linkDown) return;
      linkDown = false;
      clearTimeout(linkTimer);
      linkTimer = null;
      if (hint.textContent === LINK_HINT) hint.className = 'hint';
    },
    hidden: onHidden,
    visible: onVisible,
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
        // A hidden page (not in screen mode) never opens the TV's player.
        if (!active) return;
        if (pageHidden()) { pendingPlay = msg; return; }
        startPlay(msg);
      } else if (msg.t.indexOf('screen-live') === 0) {
        if (live) live.message(msg);
        else send({ t: 'screen-live', state: 'unsupported', reason: 'no live player' });
      } else if (msg.t === 'screen-toast') {
        toast(String(msg.text || '').slice(0, 140));
      } else if (msg.t === 'screen-video-control') {
        control(msg);
      }
    },
  };
})();
