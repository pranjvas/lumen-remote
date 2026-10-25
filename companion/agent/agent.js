// Lumen Agent (0.8.7): reads TV state in the page context and reports it to the Lumen server on the PC.
// Hands-off by design: it calls TV getters and listeners and never changes a setting. Its one action
// is opening a web page in the TV browser when the PC asks (request "open-url").
// Runs on Chromium M69, so the syntax stays within ES2017.
(function () {
  'use strict';

  const BACKOFF_MS = [2000, 5000, 10000, 30000];
  const SCREEN_RETRY_MS = 3000;
  const CONNECT_TIMEOUT_MS = 10000;
  const STATE_EVERY_MS = 5000;
  const WATCH_EVERY_MS = 1000;
  const IDLE_EXIT_MS = 30 * 60 * 1000;
  const HIDE_AFTER_MS = 400;
  const HIDE_RETRY_MS = 1500; // a hide the TV did not act on is tried again this often ...
  const HIDE_TRIES = 8; // ... this many times in all
  const PROPERTY_TIMEOUT_MS = 3000;
  const ICON_TIMEOUT_MS = 5000;
  const ICON_MAX_PX = 256;
  // Two launch attempts (generic view, then the browser by id) must answer inside the PC's 8 s request timeout.
  const LAUNCH_TIMEOUT_MS = 3500;
  const URL_MAX_LENGTH = 4096;
  const VIEW_OPERATION = 'http://tizen.org/appcontrol/operation/view';
  const BROWSER_APP_ID = 'org.tizen.browser';

  const statusEl = document.getElementById('status');
  const app = read(function () { return tizen.application.getCurrentApplication(); }, null);

  let config = null;
  let ws = null;
  let greeted = false;
  let attempt = 0;
  let retryTimer = null;
  let hideTimer = null;
  let lastLinkAt = Date.now();
  let slow = {};
  let lastFastSig = '';

  // Calls a TV API and returns the fallback when the API is missing or throws.
  function read(fn, fallback) {
    try {
      const value = fn();
      return value === undefined ? fallback : value;
    } catch (e) {
      return fallback;
    }
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? 'status error' : 'status';
  }

  // Steps aside so the TV's own picture comes back (not while the browser screen is up). One hide()
  // right after a launch can be lost: seen 25 Oct, the Lumen card stayed in front of the TV for minutes.
  // So it is tried again until the TV reports the page hidden.
  function hideSoon() {
    if (window.LumenScreen && window.LumenScreen.isActive()) return;
    clearTimeout(hideTimer);
    let tries = 0;
    function tryHide() {
      hideTimer = null;
      if (document.hidden || (window.LumenScreen && window.LumenScreen.isActive())) return;
      if (tries > 0 && window.LumenBox) window.LumenBox.note('hide-retry', tries);
      tries += 1;
      read(function () { app.hide(); });
      if (tries < HIDE_TRIES) hideTimer = setTimeout(tryHide, HIDE_RETRY_MS);
    }
    hideTimer = setTimeout(tryHide, HIDE_AFTER_MS);
  }

  function quit() {
    read(function () { if (ws) ws.close(1000, 'exit'); });
    read(function () { app.exit(); });
  }

  // ---- configuration ----

  function loadConfig() {
    return new Promise(function (resolve, reject) {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', 'agent-config.json');
      xhr.onload = function () {
        let c = null;
        try { c = JSON.parse(xhr.responseText); } catch (e) { c = null; }
        const port = c ? Number(c.pcPort) : 0;
        if (!c || typeof c.pcHost !== 'string' || !c.pcHost || !(port > 0) || typeof c.key !== 'string' || !c.key) {
          reject(new Error('agent-config.json is incomplete: rebuild with tools/agent/build.ps1'));
          return;
        }
        resolve({
          pcHost: c.pcHost,
          pcPort: port,
          key: c.key,
          version: String(c.version || read(function () { return app.appInfo.version; }, ''))
        });
      };
      xhr.onerror = function () { reject(new Error('agent-config.json is missing: rebuild with tools/agent/build.ps1')); };
      xhr.send();
    });
  }

  // ---- snapshot ----

  function sourceOf(s) {
    return s ? { type: s.type, number: s.number } : null;
  }

  function sourceList(list) {
    return Array.isArray(list) ? list.map(sourceOf) : null;
  }

  function readChannel() {
    const ch = read(function () { return tizen.tvchannel.getCurrentChannel(); }, null);
    const hy = read(function () { return webapis.hybridchannelinfo.getCurrentChannel(); }, null);
    if (!ch && !hy) return null;
    let number = null;
    if (ch && ch.major !== undefined && ch.major !== null) {
      number = Number(ch.minor) > 0 ? ch.major + '-' + ch.minor : String(ch.major);
    } else if (hy && hy.channelNumber) {
      number = String(hy.channelNumber);
    }
    return {
      name: (ch && (ch.channelName || ch.serviceName)) || (hy && hy.channelName) || null,
      number: number,
      type: (hy && hy.channelType) || null
    };
  }

  function readCaption() {
    const value = read(function () { return tizen.tvinfo.getCaptionValue('CAPTION_ONOFF_KEY'); }, null);
    if (value === null) return null;
    const s = String(value).toUpperCase();
    if (s === 'TRUE' || s === '1' || /(^|_)ON$/.test(s)) return 'on';
    if (s === 'FALSE' || s === '0' || /(^|_)OFF$/.test(s)) return 'off';
    return null;
  }

  // The cheap synchronous part, re-read every second to notice changes quickly.
  function readFast() {
    const source = sourceOf(read(function () { return tizen.tvwindow.getSource(); }, null));
    return {
      source: source,
      channel: source && source.type === 'TV' ? readChannel() : null,
      audio: {
        volume: read(function () { return tizen.tvaudiocontrol.getVolume(); }, null),
        mute: read(function () { return tizen.tvaudiocontrol.isMute(); }, null),
        outputCodec: read(function () { return tizen.tvaudiocontrol.getOutputMode(); }, null)
      },
      caption: readCaption()
    };
  }

  function property(name) {
    return new Promise(function (resolve) {
      const timer = setTimeout(function () { resolve(null); }, PROPERTY_TIMEOUT_MS);
      function done(value) { clearTimeout(timer); resolve(value || null); }
      try {
        tizen.systeminfo.getPropertyValue(name, done, function () { done(null); });
      } catch (e) {
        done(null);
      }
    });
  }

  // The asynchronous systeminfo part, refreshed with every periodic state.
  async function readSlow() {
    const values = await Promise.all(['BUILD', 'PANEL', 'CPU', 'STORAGE', 'VIDEOSOURCE', 'NETWORK', 'WIFI_NETWORK', 'ETHERNET_NETWORK'].map(property));
    const build = values[0], panel = values[1], cpu = values[2], storage = values[3], video = values[4];
    const net = values[5], wifi = values[6], eth = values[7];
    const bt = await readBluetooth();
    const units = storage && Array.isArray(storage.units)
      ? storage.units.filter(function (u) { return u.type === 'INTERNAL'; })
      : [];
    const sum = function (field) {
      return units.length ? units.reduce(function (n, u) { return n + (Number(u[field]) || 0); }, 0) : null;
    };
    return {
      connected: video ? sourceList(video.connected) : null,
      disconnected: video ? sourceList(video.disconnected) : null,
      build: (build && build.buildVersion) || null,
      panel: panel && panel.panelWidth ? { w: panel.panelWidth, h: panel.panelHeight } : null,
      system: {
        cpuLoad: cpu && typeof cpu.load === 'number' ? cpu.load : null,
        memAvailable: read(function () { return tizen.systeminfo.getAvailableMemory(); }, null),
        memTotal: read(function () { return tizen.systeminfo.getTotalMemory(); }, null),
        storageFree: sum('availableCapacity'),
        storageTotal: sum('capacity')
      },
      network: {
        type: (net && net.networkType) || null,
        wifi: wifi ? { status: wifi.status || null, ssid: wifi.ssid || null, ip: wifi.ipAddress || null, signal: typeof wifi.signalStrength === 'number' ? wifi.signalStrength : null,
          gateway: wifi.gateway || null, dns: wifi.dns || null, mac: wifi.macAddress || null } : null,
        ethernet: eth ? { status: eth.status || null, cable: eth.cable || null, ip: eth.ipAddress || null, gateway: eth.gateway || null, dns: eth.dns || null, mac: eth.macAddress || null } : null
      },
      bluetooth: bt
    };
  }

  // The TV's Bluetooth adapter and its paired devices (headphones, soundbars, remotes).
  function readBluetooth() {
    return new Promise(function (resolve) {
      const adapter = read(function () { return tizen.bluetooth.getDefaultAdapter(); }, null);
      if (!adapter) return resolve(null);
      const base = { name: read(function () { return adapter.name; }, null), powered: read(function () { return adapter.powered; }, null), devices: null };
      const timer = setTimeout(function () { resolve(base); }, PROPERTY_TIMEOUT_MS);
      try {
        adapter.getKnownDevices(function (devices) {
          clearTimeout(timer);
          base.devices = (devices || []).slice(0, 20).map(function (d) {
            return { name: String(d.name || '').slice(0, 60), bonded: d.isBonded === true, connected: d.isConnected === true,
              kind: read(function () { return d.deviceClass.major; }, null) };
          });
          resolve(base);
        }, function () { clearTimeout(timer); resolve(base); });
      } catch (e) {
        clearTimeout(timer);
        resolve(base);
      }
    });
  }

  function snapshotWith(fast) {
    lastFastSig = JSON.stringify(fast);
    return Object.assign({}, slow, fast);
  }

  // ---- connection ----

  function send(message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch (e) {
      return false;
    }
  }

  function connect() {
    retryTimer = null;
    setStatus('connecting to ' + config.pcHost);
    let sock;
    try {
      sock = new WebSocket('ws://' + config.pcHost + ':' + config.pcPort + '/agent?key=' + encodeURIComponent(config.key));
    } catch (e) {
      scheduleRetry();
      return;
    }
    ws = sock;
    let opened = false;
    const openTimer = setTimeout(function () {
      if (sock.readyState === WebSocket.CONNECTING) sock.close();
    }, CONNECT_TIMEOUT_MS);

    sock.onopen = function () {
      clearTimeout(openTimer);
      opened = true;
      attempt = 0;
      setStatus('connected to ' + config.pcHost);
      sendHello(sock);
    };
    sock.binaryType = 'arraybuffer';
    sock.onmessage = function (event) {
      if (typeof event.data !== 'string') { if (window.LumenScreen) window.LumenScreen.frame(event.data); return; }
      onMessage(event.data);
    };
    sock.onerror = function () {};
    sock.onclose = function (ev) {
      clearTimeout(openTimer);
      if (opened && window.LumenBox) window.LumenBox.note('ws-close', { code: ev && ev.code, clean: !!(ev && ev.wasClean), reason: String((ev && ev.reason) || '').slice(0, 80) });
      if (ws !== sock) return;
      if (opened) {
        lastLinkAt = Date.now();
        // The browser screen is up but the PC is gone: the live picture would freeze (and keep the
        // decoder), and every key would go nowhere. The TV's own player keeps playing.
        if (window.LumenScreen && window.LumenScreen.isActive()) {
          if (window.LumenLive) window.LumenLive.stop();
          if (window.LumenScreen.linkDown) window.LumenScreen.linkDown();
        }
      }
      ws = null;
      greeted = false;
      scheduleRetry();
    };
  }

  async function sendHello(sock) {
    slow = await readSlow();
    if (ws !== sock) return;
    // What happened before the last cut-off (black box), handed to the PC once.
    const box = window.LumenBox ? window.LumenBox.take() : [];
    // What the browser screen shows, so the PC carries on with it (or turns it off) after a reconnect.
    const screen = window.LumenScreen && window.LumenScreen.state ? window.LumenScreen.state() : undefined;
    greeted = send({ t: 'hello', agent: config.version, pcHost: config.pcHost, snapshot: snapshotWith(readFast()), box: box, screen: screen });
    if (greeted && window.LumenScreen && window.LumenScreen.linkUp) window.LumenScreen.linkUp();
    // From now on each note also goes to the PC at once: a page the TV kills cannot always save it.
    if (window.LumenBox && window.LumenBox.setSink) window.LumenBox.setSink(function (entry) { if (greeted) send({ t: 'box', e: entry }); });
  }

  function scheduleRetry() {
    let delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    // While the browser screen is up, the PC is tried again quickly (it relaunches nothing by itself).
    if (window.LumenScreen && window.LumenScreen.isActive()) delay = Math.min(delay, SCREEN_RETRY_MS);
    attempt += 1;
    setStatus('waiting for ' + config.pcHost);
    retryTimer = setTimeout(connect, delay);
  }

  function connectNow() {
    if (ws) return;
    clearTimeout(retryTimer);
    attempt = 0;
    connect();
  }

  // ---- reporting ----

  let watchTicks = 0;
  function watchTick() {
    if (!greeted) return;
    // These readings are synchronous calls into the TV's services (up to half a second each while
    // video decodes): with live video on, every third second is enough (volume has its own listener).
    watchTicks += 1;
    if (window.LumenLive && window.LumenLive.isShowing() && watchTicks % 3 !== 0) return;
    const fast = readFast();
    if (JSON.stringify(fast) !== lastFastSig) send({ t: 'state', snapshot: snapshotWith(fast) });
  }

  let slowTicks = 0;
  async function stateTick() {
    if (!greeted) return;
    // The video in front: where its clock is (every 5 s), so the PC's view of the player cannot drift.
    if (window.LumenScreen && window.LumenScreen.heartbeat) window.LumenScreen.heartbeat();
    // While live video plays, the heavier system readings (storage, network, Bluetooth) are refreshed
    // only once a minute: the heartbeat itself stays cheap.
    const liveOn = !!(window.LumenLive && window.LumenLive.isShowing());
    slowTicks += 1;
    if (!liveOn || slowTicks % 12 === 0) slow = await readSlow();
    if (greeted) send({ t: 'state', snapshot: snapshotWith(readFast()) });
  }

  function idleTick() {
    if (!greeted && Date.now() - lastLinkAt > IDLE_EXIT_MS) quit();
  }

  function watchVolume() {
    read(function () {
      tizen.tvaudiocontrol.setVolumeChangeListener(function (volume) {
        if (greeted) send({ t: 'event', kind: 'volume', value: volume });
      });
    });
  }

  // ---- requests from the PC ----

  function onMessage(raw) {
    let msg = null;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg && typeof msg.t === 'string' && msg.t.indexOf('screen-') === 0) { if (window.LumenScreen) window.LumenScreen.message(msg); return; }
    if (!msg || msg.t !== 'req' || typeof msg.rid !== 'string') return;
    handleRequest(msg).then(
      function (data) { send({ t: 'reply', rid: msg.rid, ok: true, data: data }); },
      function (err) { send({ t: 'reply', rid: msg.rid, ok: false, error: String((err && err.message) || err) }); }
    );
  }

  async function handleRequest(msg) {
    if (msg.type === 'apps') return listApps();
    if (msg.type === 'icon') return iconFor(msg.appId);
    if (msg.type === 'open-url') return openUrl(msg.url);
    if (msg.type === 'launch') return launchApp(msg.appId, msg.operation, msg.data);
    if (msg.type === 'meta') return appMeta(msg.appId);
    if (msg.type === 'caps') return mediaCaps();
    if (msg.type === 'screen') return screenMode(msg.on === true);
    if (msg.type === 'exit') {
      setTimeout(quit, 200);
      return null;
    }
    throw new Error('unknown request: ' + msg.type);
  }

  // ---- screen: Lumen's browser shown full screen on the TV (screen.js); the PC brings the agent to the
  // front with a launch, and while the screen is on the agent stays visible ----

  function screenMode(on) {
    if (!window.LumenScreen) throw new Error('this agent has no screen module');
    clearTimeout(hideTimer);
    if (on) window.LumenScreen.start();
    else {
      window.LumenScreen.stop();
      hideSoon();
    }
    return { on: on };
  }

  // ---- caps: what this TV's web engine can play (for Lumen's live video of its browser) ----

  var CAPS_TYPES = [
    'video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 'video/mp4; codecs="avc1.640028"', 'video/mp4; codecs="avc1.640029"',
    'video/mp4; codecs="avc1.64002A"', 'video/mp4; codecs="avc1.640033"', 'video/mp4; codecs="avc1.640034"',
    'video/mp4; codecs="hvc1.1.6.L120.B0"', 'video/mp4; codecs="hvc1.1.6.L150.B0"', 'video/mp4; codecs="hev1.1.6.L150.B0"',
    'video/mp4; codecs="hvc1.2.4.L153.B0"', 'video/mp4; codecs="hvc1.1.6.L153.B0"',
    'audio/mp4; codecs="mp4a.40.2"', 'audio/mp4; codecs="opus"', 'video/webm; codecs="vp9"', 'video/webm; codecs="vp8, opus"'
  ];

  function mediaCaps() {
    var mse = {};
    var plain = {};
    var probe = document.createElement('video');
    CAPS_TYPES.forEach(function (t) {
      mse[t] = read(function () { return window.MediaSource ? MediaSource.isTypeSupported(t) : null; }, null);
      plain[t] = read(function () { return probe.canPlayType(t); }, null);
    });
    return {
      userAgent: navigator.userAgent,
      mediaSource: typeof window.MediaSource,
      webkitMediaSource: typeof window.WebKitMediaSource,
      rtcPeerConnection: typeof window.RTCPeerConnection,
      webkitRtcPeerConnection: typeof window.webkitRTCPeerConnection,
      videoDecoder: typeof window.VideoDecoder,
      screen: { w: screen.width, h: screen.height, dpr: window.devicePixelRatio },
      mse: mse,
      canPlayType: plain
    };
  }

  // ---- meta: an app's declared metadata (partner apps put their deep-link template here,
  // e.g. http://samsung.com/tv/metadata/launch_social_v.link with a %% CONTENT_ID %% placeholder) ----

  function appMeta(appId) {
    if (!APP_ID_RE.test(String(appId || ''))) throw new Error('meta needs a Tizen app id');
    const meta = tizen.application.getAppMetaData(appId) || [];
    return meta.slice(0, 64).map(function (m) { return { key: String(m.key).slice(0, 200), value: String(m.value).slice(0, 2000) }; });
  }

  // ---- launch: open an app with app-control extra data (how Smart Hub tiles deep-link) ----

  const APP_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
  const DEFAULT_OPERATION = 'http://tizen.org/appcontrol/operation/default';

  // data: { key: string | string[] }, at most 16 keys and 4 KB of values in total.
  function launchApp(appId, operation, data) {
    if (!APP_ID_RE.test(String(appId || ''))) return Promise.reject(new Error('launch needs a Tizen app id'));
    const op = operation || DEFAULT_OPERATION;
    if (!/^https?:\/\/[A-Za-z0-9./_-]{1,200}$/.test(op)) return Promise.reject(new Error('bad app-control operation'));
    const entries = Object.keys(data || {});
    if (entries.length > 16) return Promise.reject(new Error('too many app-control keys'));
    let total = 0;
    const extra = [];
    for (let i = 0; i < entries.length; i++) {
      const key = entries[i];
      const raw = data[key];
      const values = (Array.isArray(raw) ? raw : [raw]).map(function (v) { return String(v); });
      values.forEach(function (v) { total += v.length + key.length; });
      extra.push(new tizen.ApplicationControlData(key, values));
    }
    if (total > 4096) return Promise.reject(new Error('app-control data too large'));
    return new Promise(function (resolve, reject) {
      let settled = false;
      const timer = setTimeout(function () { finish(new Error('launch timed out')); }, LAUNCH_TIMEOUT_MS);
      function finish(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve({ appId: appId, operation: op, keys: entries });
      }
      try {
        const control = new tizen.ApplicationControl(op, null, null, null, extra);
        tizen.application.launchAppControl(control, appId, function () { finish(null); },
          function (e) { finish(new Error((e && e.name ? e.name + ': ' : '') + ((e && e.message) || e))); });
      } catch (e) {
        finish(e);
      }
    });
  }

  // ---- open-url: show a web page in the TV browser ----

  function isWebUrl(url) {
    if (typeof url !== 'string' || !url || url.length > URL_MAX_LENGTH) return false;
    try {
      const protocol = new URL(url).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  // The generic "view" app control lets the TV pick its handler; if that is refused, ask the
  // Samsung browser by id. Resolves with the method that worked.
  async function openUrl(url) {
    if (!isWebUrl(url)) throw new Error('open-url needs an http(s) URL');
    let viewError;
    try {
      await launchView(url, null);
      return { method: 'view' };
    } catch (e) {
      viewError = e;
    }
    try {
      await launchView(url, BROWSER_APP_ID);
      return { method: 'browser' };
    } catch (e) {
      throw new Error('view: ' + viewError.message + '; ' + BROWSER_APP_ID + ': ' + e.message);
    }
  }

  function launchView(url, appId) {
    return new Promise(function (resolve, reject) {
      let settled = false;
      const timer = setTimeout(function () { done(new Error('launch timed out')); }, LAUNCH_TIMEOUT_MS);
      function done(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      }
      try {
        const control = new tizen.ApplicationControl(VIEW_OPERATION, url, null, null, []);
        tizen.application.launchAppControl(control, appId, function () { done(null); }, function (e) {
          done(new Error((e && (e.message || e.name)) || 'launchAppControl failed'));
        });
      } catch (e) {
        // A WebAPIException is not an Error instance; read its message or name.
        done(new Error((e && (e.message || e.name)) || String(e)));
      }
    });
  }

  function listApps() {
    const ownId = read(function () { return app.appInfo.id; }, 'lumenrmt01.LumenAgent');
    const ownPackage = read(function () { return app.appInfo.packageId; }, 'lumenrmt01');
    return new Promise(function (resolve, reject) {
      try {
        tizen.application.getAppsInfo(function (list) {
          resolve(list
            .filter(function (a) { return a.show && a.id !== ownId && a.packageId !== ownPackage; })
            .map(function (a) { return { id: a.id, name: a.name, show: true, iconPath: a.iconPath || null }; }));
        }, function (e) {
          reject(new Error((e && e.message) || 'getAppsInfo failed'));
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  async function iconFor(appId) {
    const info = read(function () { return tizen.application.getAppInfo(String(appId)); }, null);
    if (!info || !info.iconPath) throw new Error('no icon');
    const url = /^file:/.test(info.iconPath) ? info.iconPath : 'file://' + info.iconPath;
    try {
      return await rasterize(url);
    } catch (e) {
      // A file:// image can taint the canvas; a blob: copy of the same bytes does not.
      const blobUrl = await readAsBlobUrl(url);
      try {
        return await rasterize(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    }
  }

  function rasterize(src) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      const timer = setTimeout(function () { reject(new Error('icon load timed out')); }, ICON_TIMEOUT_MS);
      img.onload = function () {
        clearTimeout(timer);
        try {
          if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty icon');
          const scale = Math.min(1, ICON_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = function () {
        clearTimeout(timer);
        reject(new Error('icon load failed'));
      };
      img.src = src;
    });
  }

  function readAsBlobUrl(url) {
    return new Promise(function (resolve, reject) {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'blob';
      xhr.onload = function () {
        if (xhr.response && xhr.response.size) resolve(URL.createObjectURL(xhr.response));
        else reject(new Error('icon read failed'));
      };
      xhr.onerror = function () { reject(new Error('icon read failed')); };
      xhr.send();
    });
  }

  // ---- start ----

  document.addEventListener('visibilitychange', function () {
    // Another app in front (the TV pauses this page in the background): the live player stops cleanly
    // and the PC is told, instead of the PC taking the silence for a crash.
    // The TV's own player is suspended too (the TV has one decoder, and the app in front needs it).
    if (document.hidden) {
      if (window.LumenScreen && window.LumenScreen.hidden) window.LumenScreen.hidden();
      if (window.LumenLive && window.LumenLive.hidden) window.LumenLive.hidden();
      return;
    }
    if (window.LumenScreen && window.LumenScreen.visible) window.LumenScreen.visible();
    if (window.LumenLive && window.LumenLive.visible) window.LumenLive.visible();
    // Opened again from the Apps screen or relaunched by the PC: retry at once, then step aside
    // (unless the PC asked for the browser screen, which stays in front).
    if (config) connectNow();
    if (!(window.LumenScreen && window.LumenScreen.isActive())) hideSoon();
  });

  setStatus('starting');
  // The screen closed on the TV itself (Back with the PC gone): the agent steps aside.
  if (window.LumenScreen) window.LumenScreen.init(send, { onClosed: hideSoon });
  hideSoon();
  loadConfig().then(function (c) {
    config = c;
    watchVolume();
    setInterval(watchTick, WATCH_EVERY_MS);
    setInterval(stateTick, STATE_EVERY_MS);
    setInterval(idleTick, 30000);
    connect();
  }, function (err) {
    clearTimeout(hideTimer);
    setStatus(err.message, true);
    setTimeout(quit, 10000);
  });
})();
