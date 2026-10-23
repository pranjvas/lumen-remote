// Lumen Agent: the "Lumen browser on TV" screen. The page is rendered on the PC (Lumen's own
// browser, behind the VPN when it is on) and arrives here as JPEG frames over the agent socket; the
// TV remote drives it (keys go back to the PC). Videos the page plays can be handed to the TV's own
// player (AVPlay) through Lumen's relay: full quality with sound.
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

  let send = function () { return false; };
  let active = false;
  let registered = false;
  let pendingFrame = null;
  let decoding = false;
  let currentUrl = null;
  let video = null; // { url, title, state }
  let hintTimer = null;
  let pointerSent = 0;

  const root = document.getElementById('screen');
  const frame = document.getElementById('frame');
  const cursor = document.getElementById('cursor');
  const hint = document.getElementById('hint');
  const toastEl = document.getElementById('toast');
  const player = document.getElementById('av');

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

  // ---- the TV's own video player ----

  function playVideo(url, title, fromStart) {
    stopVideo(false);
    video = { url: url, title: title || '', state: 'loading' };
    root.className = 'screen video';
    document.body.classList.add('video');
    showHint((title ? title + ' · ' : '') + 'OK play/pause · ◀ ▶ 10 s · Back returns to the page', 7000);
    let stage = 'webapis';
    try {
      if (typeof webapis === 'undefined' || !webapis.avplay) throw new Error('webapis.avplay is missing');
      stage = 'open';
      webapis.avplay.open(url);
      stage = 'setDisplayRect';
      webapis.avplay.setDisplayRect(0, 0, 1920, 1080);
      stage = 'setListener';
      webapis.avplay.setListener({
        onbufferingcomplete: function () { report('playing'); },
        onstreamcompleted: function () { report('ended'); stopVideo(true); },
        onerror: function (err) { report('error', 'onerror: ' + String(err)); toast('The TV could not play this video'); stopVideo(true); },
        oncurrentplaytime: function () {},
      });
      stage = 'prepareAsync';
      webapis.avplay.prepareAsync(function () {
        read(function () { webapis.avplay.play(); });
        report('playing');
        // A stream Lumen is still converting grows while it plays, so the player joins at its live
        // end; go back to the start once playback is running.
        if (fromStart) setTimeout(function () { read(function () { webapis.avplay.seekTo(0); }); }, 1200);
      }, function (err) {
        report('error', 'prepare: ' + String(err && (err.name + ' ' + (err.message || '')) || err));
        toast('The TV could not play this video');
        stopVideo(true);
      });
    } catch (e) {
      report('error', stage + ': ' + String(e && (e.name + ' ' + (e.message || '')) || e));
      toast('The TV player is not available');
      stopVideo(true);
    }
  }

  function report(state, error) {
    if (!video) return;
    video.state = state;
    send({ t: 'screen-video', state: state, error: error || null,
      position: read(function () { return webapis.avplay.getCurrentTime(); }, null),
      duration: read(function () { return webapis.avplay.getDuration(); }, null) });
  }

  function stopVideo(backToPage) {
    if (!video) return;
    read(function () { webapis.avplay.stop(); });
    read(function () { webapis.avplay.close(); });
    send({ t: 'screen-video', state: 'stopped' });
    video = null;
    document.body.classList.remove('video');
    root.className = active ? 'screen' : 'screen off';
    if (backToPage) showHint('Back to the page', 2500);
  }

  function videoKey(key) {
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
      active = false;
      unregisterKeys();
      root.className = 'screen off';
    },
    frame: showFrame,
    message: function (msg) {
      if (msg.t === 'screen-cursor') {
        cursor.style.transform = 'translate(' + Math.round(msg.x * 1920) + 'px,' + Math.round(msg.y * 1080) + 'px)';
        cursor.style.display = msg.visible === false ? 'none' : 'block';
      } else if (msg.t === 'screen-play') {
        playVideo(msg.url, msg.title, msg.fromStart === true);
      } else if (msg.t === 'screen-toast') {
        toast(String(msg.text || '').slice(0, 140));
      }
    },
  };
})();
