'use strict';
// Lumen Agent probe service (Node 4.4.3 on Tizen 5.5): what the service context can read,
// and whether it outlives the UI app. Loopback only: the PC reaches it through an sdb forward.
var http = require('http');
var PORT = 18890, LIFETIME_MS = 30 * 60 * 1000;
var server = null, serverState = 'none', startedAt = Date.now(), requests = 0, volumeEvents = [];

function errText(e) { return String(e && e.name ? e.name + ': ' + e.message : e); }
function plain(v) {
  if (v === undefined) return '[undefined]';
  try { return JSON.parse(JSON.stringify(v, function (k, x) { return typeof x === 'function' ? '[fn]' : x; })); } catch (e) { return String(v); }
}
function safe(fn) { try { return { ok: true, value: plain(fn()) }; } catch (e) { return { ok: false, error: errText(e) }; } }
function keysOf(o) {
  if (!o) return null;
  var out = [];
  try { for (var k in o) out.push(k); } catch (e) {}
  try { Object.getOwnPropertyNames(o).forEach(function (k) { if (out.indexOf(k) < 0) out.push(k); }); } catch (e) {}
  return out.sort();
}

function probe() {
  var hasTizen = typeof tizen !== 'undefined', hasWebapis = typeof webapis !== 'undefined';
  var r = { at: new Date().toISOString(), node: process.version, uptimeMs: Date.now() - startedAt, requests: requests, serverState: serverState,
    typeofTizen: typeof tizen, typeofWebapis: typeof webapis, globals: Object.keys(global).sort() };
  if (hasTizen) {
    r.tizenKeys = keysOf(tizen);
    r.audio = {
      volume: safe(function () { return tizen.tvaudiocontrol.getVolume(); }),
      mute: safe(function () { return tizen.tvaudiocontrol.isMute(); }),
      outputMode: safe(function () { return tizen.tvaudiocontrol.getOutputMode(); })
    };
    r.tvwindowSource = safe(function () { return tizen.tvwindow.getSource(); });
    r.currentApp = safe(function () { return tizen.application.getCurrentApplication().appInfo.id; });
  }
  if (hasWebapis) {
    r.webapisKeys = keysOf(webapis);
    r.firmware = safe(function () { return webapis.productinfo.getFirmware(); });
  }
  r.volumeEvents = volumeEvents.slice(-20);
  return r;
}

function ensureServer() {
  if (server) return;
  server = http.createServer(function (req, res) {
    requests++;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(probe()));
  });
  server.on('error', function (e) { serverState = 'error ' + errText(e); server = null; });
  server.on('listening', function () { serverState = 'listening 127.0.0.1:' + PORT; });
  serverState = 'starting';
  server.listen(PORT, '127.0.0.1');
  try { tizen.tvaudiocontrol.setVolumeChangeListener(function (v) { volumeEvents.push({ t: Date.now(), volume: v }); if (volumeEvents.length > 50) volumeEvents.shift(); }); }
  catch (e) { volumeEvents.push({ listenerError: errText(e) }); }
  setTimeout(function () {
    try { if (server) server.close(); } catch (e) {}
    try { tizen.application.getCurrentApplication().exit(); } catch (e) {}
  }, LIFETIME_MS);
}

module.exports.onStart = function () { ensureServer(); };
module.exports.onRequest = function () {
  var request = null;
  try { request = tizen.application.getCurrentApplication().getRequestedAppControl(); } catch (e) {}
  ensureServer();
  function reply() {
    try { if (request) request.replyResult([new tizen.ApplicationControlData('probe', [JSON.stringify(probe())])]); } catch (e) {}
  }
  if (serverState === 'starting' && server) { server.once('listening', reply); server.once('error', reply); } else reply();
};
module.exports.onStop = function () { try { if (server) server.close(); } catch (e) {} };
module.exports.onExit = function () { try { if (server) server.close(); } catch (e) {} };
