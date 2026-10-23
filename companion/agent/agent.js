// Lumen Agent 0.3: reads TV state in the page context and reports it to the Lumen server on the PC.
// Hands-off by design: it calls TV getters and listeners and never changes a setting. Its one action
// is opening a web page in the TV browser when the PC asks (request "open-url").
// Runs on Chromium M69, so the syntax stays within ES2017.
(function () {
  'use strict';

  const BACKOFF_MS = [2000, 5000, 10000, 30000];
  const CONNECT_TIMEOUT_MS = 10000;
  const STATE_EVERY_MS = 5000;
  const WATCH_EVERY_MS = 1000;
  const IDLE_EXIT_MS = 30 * 60 * 1000;
  const HIDE_AFTER_MS = 400;
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

  function hideSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { read(function () { app.hide(); }); }, HIDE_AFTER_MS);
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
    const values = await Promise.all(['BUILD', 'PANEL', 'CPU', 'STORAGE', 'VIDEOSOURCE'].map(property));
    const build = values[0], panel = values[1], cpu = values[2], storage = values[3], video = values[4];
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
      }
    };
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
    sock.onmessage = function (event) { onMessage(event.data); };
    sock.onerror = function () {};
    sock.onclose = function () {
      clearTimeout(openTimer);
      if (ws !== sock) return;
      if (opened) lastLinkAt = Date.now();
      ws = null;
      greeted = false;
      scheduleRetry();
    };
  }

  async function sendHello(sock) {
    slow = await readSlow();
    if (ws !== sock) return;
    greeted = send({ t: 'hello', agent: config.version, pcHost: config.pcHost, snapshot: snapshotWith(readFast()) });
  }

  function scheduleRetry() {
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
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

  function watchTick() {
    if (!greeted) return;
    const fast = readFast();
    if (JSON.stringify(fast) !== lastFastSig) send({ t: 'state', snapshot: snapshotWith(fast) });
  }

  async function stateTick() {
    if (!greeted) return;
    slow = await readSlow();
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
    if (msg.type === 'exit') {
      setTimeout(quit, 200);
      return null;
    }
    throw new Error('unknown request: ' + msg.type);
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
    if (document.hidden) return;
    // Opened again from the Apps screen or relaunched by the PC: retry at once, then step aside.
    if (config) connectNow();
    hideSoon();
  });

  setStatus('starting');
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
