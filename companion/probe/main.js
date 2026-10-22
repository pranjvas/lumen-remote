/* Lumen Agent probe: enumerates what this TV web runtime exposes. Read-only: only getters (get/is) are called. */
(function () {
  'use strict';
  var statusEl = document.getElementById('status');
  function setStatus(t) { statusEl.textContent = t; }
  function errText(e) { return String(e && e.name ? e.name + ': ' + e.message : e); }
  function plain(v) {
    if (v === undefined) return '[undefined]';
    try { return JSON.parse(JSON.stringify(v, function (k, x) { return typeof x === 'function' ? '[fn]' : x; })); } catch (e) { return String(v); }
  }
  function flat(o) {
    if (!o || typeof o !== 'object') return plain(o);
    var out = {};
    keysOf(o).forEach(function (k) { try { var v = o[k]; if (typeof v !== 'function') out[k] = plain(v); } catch (e) { out[k] = '[throws ' + errText(e) + ']'; } });
    return out;
  }
  function safe(fn) { try { return { ok: true, value: plain(fn()) }; } catch (e) { return { ok: false, error: errText(e) }; } }
  function cbPromise(starter, ms) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(x) { if (!done) { done = true; resolve(x); } }
      setTimeout(function () { finish({ ok: false, error: 'timeout ' + (ms || 4000) + ' ms' }); }, ms || 4000);
      try { starter(function (v) { finish({ ok: true, value: v }); }, function (e) { finish({ ok: false, error: errText(e) }); }); }
      catch (e) { finish({ ok: false, error: errText(e) }); }
    });
  }
  function keysOf(o) {
    if (!o) return null;
    var out = [];
    try { for (var k in o) out.push(k); } catch (e) {}
    try { Object.getOwnPropertyNames(o).forEach(function (k) { if (out.indexOf(k) < 0) out.push(k); }); } catch (e) {}
    try {
      var proto = Object.getPrototypeOf(o);
      if (proto && proto !== Object.prototype) Object.getOwnPropertyNames(proto).forEach(function (k) { if (out.indexOf(k) < 0 && k !== 'constructor') out.push(k); });
    } catch (e) {}
    return out.sort();
  }
  var SKIP_MODULES = /network|adinfo|sso|account|billing|payment|voice|sheild|shield|drm/i;
  function sweep(mod) {
    if (!mod) return null;
    var out = {};
    keysOf(mod).forEach(function (k) {
      var f;
      try { f = mod[k]; } catch (e) { out[k] = '[throws]'; return; }
      if (typeof f !== 'function') { out[k] = (f && typeof f === 'object') ? plain(f) : f; return; }
      if (!/^(get|is)/.test(k)) { out[k] = '[fn/' + f.length + ']'; return; }
      out[k] = safe(function () { return f.call(mod); });
    });
    return out;
  }

  async function probe() {
    var r = { at: new Date().toISOString(), ua: navigator.userAgent, screen: [screen.width, screen.height, window.devicePixelRatio] };
    r.windowSamsungKeys = Object.getOwnPropertyNames(window).filter(function (k) { return /tizen|webapis|b2b|samsung|sef|plugin|deviceapis|^sf$|xsf|msf|caph/i.test(k); });
    r.tizenKeys = keysOf(window.tizen);
    r.webapisKeys = keysOf(window.webapis);
    r.tizenModules = {};
    if (window.tizen) keysOf(tizen).forEach(function (k) { try { var m = tizen[k]; if (m && typeof m === 'object') r.tizenModules[k] = keysOf(m); } catch (e) { r.tizenModules[k] = '[throws ' + errText(e) + ']'; } });
    r.webapisModules = {};
    if (window.webapis) keysOf(webapis).forEach(function (k) { try { var m = webapis[k]; if (m && typeof m === 'object') r.webapisModules[k] = keysOf(m); } catch (e) { r.webapisModules[k] = '[throws ' + errText(e) + ']'; } });

    r.audio = {
      volume: safe(function () { return tizen.tvaudiocontrol.getVolume(); }),
      mute: safe(function () { return tizen.tvaudiocontrol.isMute(); }),
      outputMode: safe(function () { return tizen.tvaudiocontrol.getOutputMode(); })
    };
    r.tvwindow = {
      source: safe(function () { return tizen.tvwindow.getSource(); }),
      sourceMain: safe(function () { return tizen.tvwindow.getSource('MAIN'); }),
      windows: await cbPromise(function (ok, fail) { tizen.tvwindow.getAvailableWindows(ok, fail); })
    };
    r.tvchannel = {
      current: safe(function () { return tizen.tvchannel.getCurrentChannel(); }),
      program: safe(function () { return tizen.tvchannel.getCurrentProgram(); })
    };
    r.systeminfo = {};
    var props = ['BUILD', 'DISPLAY', 'VIDEOSOURCE', 'CPU', 'MEMORY', 'STORAGE', 'LOCALE', 'PERIPHERAL', 'PANEL'];
    for (var i = 0; i < props.length; i++) {
      var p = props[i];
      var res = await cbPromise(function (ok, fail) { tizen.systeminfo.getPropertyValue(p, ok, fail); });
      if (res.ok) res.value = flat(res.value);
      if (p === 'VIDEOSOURCE' && res.ok && res.value) {
        try { res.connected = (res.value.connected || []).map(flat); res.disconnected = (res.value.disconnected || []).map(flat); } catch (e) {}
      }
      r.systeminfo[p] = res;
    }
    r.systeminfo.totalMemory = safe(function () { return tizen.systeminfo.getTotalMemory(); });
    r.systeminfo.availableMemory = safe(function () { return tizen.systeminfo.getAvailableMemory(); });
    r.capabilities = {};
    ['http://tizen.org/feature/platform.version', 'http://tizen.org/feature/screen.width', 'http://tizen.org/feature/screen.height',
      'http://tizen.org/system/model_name', 'http://tizen.org/system/build.string', 'http://tizen.org/system/build.date',
      'http://tizen.org/feature/web.service', 'http://tizen.org/feature/tv.inputdevice', 'http://tizen.org/feature/platform.version.name']
      .forEach(function (k) { r.capabilities[k] = safe(function () { return tizen.systeminfo.getCapability(k); }); });

    r.sweeps = {};
    if (window.webapis) keysOf(webapis).forEach(function (k) {
      var m; try { m = webapis[k]; } catch (e) { return; }
      if (!m || typeof m !== 'object' || SKIP_MODULES.test(k)) return;
      r.sweeps['webapis.' + k] = sweep(m);
    });
    ['tvaudiocontrol', 'tvdisplaycontrol', 'tvwindow', 'tvinfo', 'tvchannel'].forEach(function (k) {
      if (window.tizen && tizen[k]) r.sweeps['tizen.' + k] = sweep(tizen[k]);
    });
    try {
      var ti = webapis.tvinfo, keys = ti && ti.TvInfoMenuKey;
      if (keys) { r.tvinfoMenu = {}; Object.keys(keys).forEach(function (k) { r.tvinfoMenu[k] = safe(function () { return ti.getMenuValue ? ti.getMenuValue(keys[k]) : ti.getCaptionValue(keys[k]); }); }); }
    } catch (e) { r.tvinfoMenuError = errText(e); }
    try {
      var pi = webapis.productinfo, ck = pi && pi.ProductInfoConfigKey;
      if (ck) { r.productConfig = {}; Object.keys(ck).forEach(function (k) { r.productConfig[k] = safe(function () { return pi.getSystemConfig(ck[k]); }); }); }
    } catch (e) { r.productConfigError = errText(e); }
    r.inputKeys = safe(function () { return tizen.tvinputdevice.getSupportedKeys().map(function (k) { return k.name + ':' + k.code; }); });

    var apps = await cbPromise(function (ok, fail) { tizen.application.getAppsInfo(ok, fail); }, 8000);
    r.apps = apps.ok ? { count: apps.value.length, list: apps.value.map(function (a) { return { id: a.id, packageId: a.packageId, name: a.name, show: a.show, version: a.version, icon: a.iconPath, categories: a.categories }; }) } : apps;
    var ctx = await cbPromise(function (ok, fail) { tizen.application.getAppsContext(ok, fail); }, 8000);
    r.running = ctx.ok ? ctx.value.map(function (c) { return { id: c.appId, contextId: c.id }; }) : ctx;
    return r;
  }

  function launchService(operation) {
    return cbPromise(function (ok, fail) {
      var ac = new tizen.ApplicationControl(operation || 'http://lumen.local/op/probe', null, null, null, []);
      tizen.application.launchAppControl(ac, 'lumenrmt01.LumenService', function () {}, fail, {
        onsuccess: function (data) { ok((data || []).map(function (d) { return { key: d.key, value: d.value }; })); },
        onfailure: function () { fail(new Error('service replied failure')); }
      });
    }, 10000);
  }

  window.lumenProbe = probe;
  window.lumenLaunchService = launchService;
  window.lumenVolumeEvents = [];
  try { tizen.tvaudiocontrol.setVolumeChangeListener(function (v) { window.lumenVolumeEvents.push({ t: Date.now(), volume: v }); }); window.lumenVolumeListener = 'set'; }
  catch (e) { window.lumenVolumeListener = errText(e); }

  document.addEventListener('keydown', function (e) {
    if (e.keyCode === 10009) { try { tizen.application.getCurrentApplication().exit(); } catch (x) {} }
  });
  setStatus('ready: window.lumenProbe(), window.lumenLaunchService()');
})();
