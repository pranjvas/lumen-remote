// Media relay for the TV: the TV fetches a video stream from Lumen (TV-facing listener,
// /relay/<token>/…), and Lumen fetches it upstream — through the VPN when it is on, with the page's
// Referer and the browser's User-Agent, following redirects. HLS playlists are rewritten so every
// variant playlist, key and segment also comes through the relay. Stream tokens are random and
// expire; only http(s) targets are relayed.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { LumenError } from '../errors.js';

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SESSIONS = 20;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_LICENCE_BYTES = 256 * 1024;
const TIMEOUT_MS = 20000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';
const PASS_REQUEST = ['range', 'accept', 'accept-encoding', 'if-range'];
// The agent's in-page player (hls.js) fetches from a different origin than the app page.
const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-length, content-range, accept-ranges' };
const PASS_RESPONSE = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'cache-control'];

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');
// "cdn.media.example.com" → "example.com" (good enough to keep cookies on their own site).
const siteOf = (host) => String(host ?? '').toLowerCase().split('.').slice(-2).join('.');
const unb64url = (s) => Buffer.from(s, 'base64url').toString('utf8');
const isPlaylist = (type, url) => /mpegurl/i.test(type ?? '') || /\.m3u8?(\?|$)/i.test(url);

/** Absolute http(s) URL or null. */
function webUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** One upstream request (GET/HEAD, or POST with `body`), through an HTTP CONNECT proxy when proxyUrl is set. → IncomingMessage */
export function requestUpstream(target, { method = 'GET', headers = {}, proxyUrl = null, timeoutMs = TIMEOUT_MS, body = null } = {}) {
  const url = new URL(target);
  const secure = url.protocol === 'https:';
  const port = Number(url.port) || (secure ? 443 : 80);
  const path = `${url.pathname}${url.search}`;
  const reqHeaders = { host: url.host, ...headers };
  return new Promise((resolve, reject) => {
    const fail = (err) => reject(err instanceof LumenError ? err : new LumenError('FAILED', `The stream did not load: ${err.message}`));
    const send = (createConnection) => {
      const lib = secure ? https : http;
      const req = lib.request({ host: url.hostname, port, method, path, headers: reqHeaders, servername: url.hostname, ...(createConnection && { createConnection }), agent: false, timeout: timeoutMs });
      req.on('response', resolve);
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', fail);
      req.end(body ?? undefined);
    };
    if (!proxyUrl) return send(null);
    const proxy = new URL(proxyUrl);
    if (!secure) {
      // Plain http through the proxy: absolute-URI request.
      const req = http.request({ host: proxy.hostname, port: proxy.port, method, path: url.href, headers: reqHeaders, agent: false, timeout: timeoutMs });
      req.on('response', resolve);
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', fail);
      req.end(body ?? undefined);
      return;
    }
    const connect = http.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: `${url.hostname}:${port}`, headers: { host: `${url.hostname}:${port}` }, agent: false, timeout: timeoutMs });
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return fail(new LumenError('UNAVAILABLE', `The VPN could not reach ${url.hostname} (${res.statusCode})`));
      }
      send(() => tls.connect({ socket, servername: url.hostname, ALPNProtocols: ['http/1.1'] }));
    });
    connect.on('timeout', () => connect.destroy(new Error('VPN proxy timed out')));
    connect.on('error', fail);
    connect.end();
  });
}

/** Follows redirects; → { res, url } (final URL). */
async function fetchFollow(target, options) {
  let url = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await requestUpstream(url, options);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      const next = webUrl(res.headers.location, url);
      res.resume();
      if (!next) throw new LumenError('FAILED', 'The stream redirected somewhere unusable');
      url = next.href;
      continue;
    }
    return { res, url };
  }
  throw new LumenError('FAILED', 'The stream redirected too many times');
}

function readBody(res, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (size > max) { res.destroy(); reject(new LumenError('FAILED', 'The playlist is too large')); return; }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
    res.resume(); // a 'data' listener alone does not restart a stream readHead paused
  });
}

const PLAYLIST_SNIFF_BYTES = 64;
const looksLikePlaylist = (head) => /^﻿?\s*#EXTM3U/.test(head.toString('utf8'));

/** The first `bytes` bytes of a response (fewer when it ends sooner), leaving the rest unread and paused. */
function readHead(res, bytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const detach = () => {
      res.off('data', onData);
      res.off('end', onEnd);
      res.off('error', onError);
      res.off('close', onClose);
    };
    const finish = (ended) => {
      detach();
      res.pause();
      resolve({ head: Buffer.concat(chunks), ended });
    };
    const onData = (c) => { chunks.push(c); size += c.length; if (size >= bytes) finish(false); };
    const onEnd = () => finish(true);
    const onError = (err) => { detach(); reject(err); };
    const onClose = () => { detach(); reject(new Error('the stream closed early')); };
    res.on('data', onData);
    res.on('end', onEnd);
    res.on('error', onError);
    res.on('close', onClose);
  });
}

/** Rewrites every URI in an HLS playlist (lines and URI="…" attributes) through `toRelay`. */
export function rewritePlaylist(text, base, toRelay) {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (m, uri) => {
        const abs = webUrl(uri, base);
        return abs ? `URI="${toRelay(abs.href)}"` : m;
      });
    }
    const abs = webUrl(trimmed, base);
    return abs ? toRelay(abs.href) : line;
  }).join('\n');
}

export function createRelay({ log: rootLog, lan, vpn = () => null, transcoder = () => null }) {
  const log = rootLog.child('relay');
  const sessions = new Map(); // token → { referer, origin, userAgent, at }
  const blobs = new Map(); // token → { body, type, at }: small public files Lumen hands the TV (a DRM service certificate)
  let unroute = null;

  function prune() {
    const now = Date.now();
    for (const [token, s] of sessions) if (now - s.at > TOKEN_TTL_MS) sessions.delete(token);
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  function base() {
    if (!lan?.address || !lan?.port) throw new LumenError('UNAVAILABLE', 'The TV-facing listener is not ready');
    return `http://${lan.address}:${lan.port}/relay`;
  }

  function relayUrl(token, target) {
    const name = (new URL(target).pathname.split('/').pop() || 'stream').replace(/[^\w.-]/g, '').slice(-60) || 'stream';
    return `${base()}/${token}/${b64url(target)}/${name}`;
  }

  /** A relay URL for `target` the TV can fetch; referer/userAgent are sent upstream. */
  // licence: true lets the TV POST to exactly this URL (a DRM licence server: the TV's own DRM module
  // makes the request, Lumen only adds the page's headers and carries it through the VPN).
  // licence: 'resolve' means the URL first answers a GET with the real licence-server URL (Vimeo:
  // JSON { licenseAcquisitionUrl, token } for ExpressPlay, or the URL as text), fetched per request.
  function register(target, { referer = null, origin = null, cookie = null, userAgent = null, licence = false } = {}) {
    const url = webUrl(target);
    if (!url) throw new LumenError('INVALID', 'Only http(s) streams can be relayed');
    prune();
    const token = randomBytes(16).toString('hex');
    const ref = referer ? webUrl(referer) : null;
    sessions.set(token, {
      target: url.href, referer: ref?.href ?? null, origin: origin ?? ref?.origin ?? null, userAgent: userAgent || UA, at: Date.now(),
      cookie: typeof cookie === 'string' && cookie.length < 8192 ? cookie : null, cookieSite: siteOf(url.hostname), licence: licence === true || licence === 'resolve' ? licence : false,
    });
    return { token, url: relayUrl(token, url.href) };
  }

  function upstreamHeaders(session, target) {
    const headers = { 'user-agent': session.userAgent, ...(session.referer && { referer: session.referer }), ...(session.origin && { origin: session.origin }) };
    // The page's cookies go only to the site that set them, never to other hosts in the playlist.
    if (session.cookie && siteOf(target.hostname) === session.cookieSite) headers.cookie = session.cookie;
    return headers;
  }

  async function fetchPlaylist(session, target) {
    const { res, url } = await fetchFollow(target, { headers: { ...upstreamHeaders(session, new URL(target)), 'accept-encoding': 'identity' }, proxyUrl: vpn()?.proxyUrl?.() ?? null, timeoutMs: 8000 });
    if (res.statusCode !== 200) { res.resume(); throw new LumenError('FAILED', `The playlist answered ${res.statusCode}`); }
    return { text: (await readBody(res, MAX_PLAYLIST_BYTES)).toString('utf8'), url };
  }

  /**
   * What kind of HLS a registered stream is: { fmp4 } is true when its media playlist uses
   * fragmented MP4 segments (EXT-X-MAP), which the TV's own player does not play.
   * { drm } is true for DRM-encrypted (SAMPLE-AES) streams.
   */
  async function probeHls(token) {
    const session = sessions.get(token);
    if (!session?.target) throw new LumenError('NOT_FOUND', 'Unknown stream');
    let { text, url } = await fetchPlaylist(session, session.target);
    const variant = /#EXT-X-STREAM-INF/.test(text) ? text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) : null;
    if (variant) ({ text, url } = await fetchPlaylist(session, new URL(variant, url).href));
    // SAMPLE-AES (FairPlay, Widevine, PlayReady): only a licensed DRM player can decrypt it.
    const drm = /#EXT-X-(SESSION-)?KEY:METHOD=SAMPLE-AES/.test(text);
    return { fmp4: /#EXT-X-MAP/.test(text), endlist: /#EXT-X-ENDLIST/.test(text), drm };
  }

  /** A relay URL serving `body` (a Buffer) as `type`. */
  function registerBlob(body, type = 'application/octet-stream') {
    const token = randomBytes(16).toString('hex');
    blobs.set(token, { body, type, at: Date.now() });
    while (blobs.size > MAX_SESSIONS) blobs.delete(blobs.keys().next().value);
    return { token, url: `${base()}/b/${token}` };
  }

  // /relay/x/<job>/<file>: HLS written by the transcoder (features/transcode.js).
  function serveConverted(req, res, job, name) {
    const file = transcoder()?.file(job, name);
    if (name.endsWith('.m3u8')) log.debug('converted playlist requested', { job, found: Boolean(file) });
    if (!file) { res.writeHead(404, { ...CORS, 'content-type': 'text/plain' }); res.end('not found'); return; }
    const playlist = name.endsWith('.m3u8');
    if (playlist) {
      // The playlist grows while ffmpeg works, so players treat it as live and join near the end;
      // EXT-X-START tells them to start at the beginning.
      const text = fs.readFileSync(file, 'utf8').replace(/^#EXTM3U\r?\n/, '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n');
      const body = Buffer.from(text, 'utf8');
      res.writeHead(200, { ...CORS, 'content-type': 'application/vnd.apple.mpegurl', 'content-length': body.length, 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    const size = fs.statSync(file).size;
    res.writeHead(200, { ...CORS, 'content-type': 'video/mp2t', 'content-length': size, 'cache-control': 'no-cache' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  }

  async function resolveLicenceServer(session, target, proxyUrl) {
    const { res, url } = await fetchFollow(target.href, { headers: { ...upstreamHeaders(session, target), 'accept-encoding': 'identity' }, proxyUrl, timeoutMs: 10000 });
    const text = (await readBody(res, 64 * 1024)).toString('utf8').trim();
    if (res.statusCode !== 200) throw new LumenError('FAILED', `The licence URL request answered ${res.statusCode}`);
    let next = null;
    try {
      const j = JSON.parse(text);
      if (j?.licenseAcquisitionUrl && j?.token) next = webUrl(`${j.licenseAcquisitionUrl}?ExpressPlayToken=${encodeURIComponent(j.token)}`);
    } catch { /* plain URL */ }
    next ??= webUrl(text, url);
    if (!next) throw new LumenError('FAILED', 'The licence URL request returned no URL');
    return next;
  }

  async function relayLicence(req, res, session, target) {
    session.at = Date.now();
    let body;
    try {
      body = await readBody(req, MAX_LICENCE_BYTES);
    } catch {
      res.writeHead(413, { ...CORS, 'content-type': 'text/plain' });
      res.end('too large');
      return;
    }
    const proxyUrl = vpn()?.proxyUrl?.() ?? null;
    try {
      let server = target;
      if (session.licence === 'resolve') server = await resolveLicenceServer(session, target, proxyUrl);
      const headers = { ...upstreamHeaders(session, server), 'content-length': String(body.length), 'accept-encoding': 'identity' };
      for (const name of ['content-type', 'soapaction', 'accept']) if (req.headers[name]) headers[name] = req.headers[name];
      const up = await requestUpstream(server.href, { method: 'POST', headers, body, proxyUrl });
      const reply = await readBody(up, MAX_LICENCE_BYTES);
      log.info('licence request', { host: server.hostname, status: up.statusCode, sent: body.length, received: reply.length });
      if (up.statusCode >= 400) {
        log.warn('licence server refused', { status: up.statusCode, type: up.headers['content-type'] ?? null, sentType: headers['content-type'] ?? null, reply: reply.toString('utf8').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 300) });
      }
      res.writeHead(up.statusCode, { ...CORS, 'content-type': up.headers['content-type'] ?? 'application/octet-stream', 'content-length': reply.length });
      res.end(reply);
    } catch (err) {
      log.warn('licence request failed', { host: target.hostname, message: err.message });
      res.writeHead(502, { ...CORS, 'content-type': 'text/plain' });
      res.end('licence server failed');
    }
  }

  async function onRequest(req, res) {
    if (req.method === 'OPTIONS') {
      const asked = String(req.headers['access-control-request-headers'] ?? '').slice(0, 300).replace(/[^\w, -]/g, '');
      res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'GET, HEAD, POST', 'access-control-allow-headers': asked || 'range, if-range', 'access-control-max-age': '600' });
      res.end();
      return;
    }
    const parts = new URL(req.url, 'http://relay.invalid').pathname.split('/').filter(Boolean); // relay, token, target, name
    if (parts[1] === 'x' && parts.length === 4) return serveConverted(req, res, parts[2], parts[3]);
    if (parts[1] === 'b' && parts.length === 3 && blobs.has(parts[2])) {
      const blob = blobs.get(parts[2]);
      res.writeHead(200, { ...CORS, 'content-type': blob.type, 'content-length': blob.body.length });
      res.end(req.method === 'HEAD' ? undefined : blob.body);
      return;
    }
    const session = sessions.get(parts[1]);
    const target = parts[2] ? webUrl((() => { try { return unb64url(parts[2]); } catch { return ''; } })()) : null;
    if (session && target && req.method === 'POST' && session.licence && target.href === session.target) return relayLicence(req, res, session, target);
    if (!session || !target || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { ...CORS, 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    session.at = Date.now();
    log.info('relay request', { host: target.hostname, method: req.method, range: req.headers.range ?? null });
    const headers = upstreamHeaders(session, target);
    for (const name of PASS_REQUEST) if (req.headers[name] && name !== 'accept-encoding') headers[name] = req.headers[name];
    headers['accept-encoding'] = 'identity';
    let upstream;
    try {
      upstream = await fetchFollow(target.href, { method: req.method, headers, proxyUrl: vpn()?.proxyUrl?.() ?? null });
    } catch (err) {
      log.warn('relay fetch failed', { host: target.hostname, message: err.message });
      res.writeHead(502, { ...CORS, 'content-type': 'text/plain' });
      res.end('upstream failed');
      return;
    }
    const { res: up, url: finalUrl } = upstream;
    const type = up.headers['content-type'] ?? '';
    // A playlist served with another type from a URL without .m3u8 is still a playlist to hls.js (it only
    // checks for #EXTM3U), so the body decides too: left unrewritten, its URIs would be fetched by the TV
    // itself, outside the VPN.
    let sniffed = null;
    if (up.statusCode === 200 && req.method === 'GET' && !isPlaylist(type, finalUrl)) {
      try {
        sniffed = await readHead(up, PLAYLIST_SNIFF_BYTES);
      } catch (err) {
        log.warn('relay fetch failed', { host: target.hostname, message: err.message });
        up.destroy();
        res.writeHead(502, { ...CORS, 'content-type': 'text/plain' });
        res.end('upstream failed');
        return;
      }
    }
    if (up.statusCode === 200 && req.method === 'GET' && (isPlaylist(type, finalUrl) || looksLikePlaylist(sniffed.head))) {
      try {
        const rest = sniffed?.ended ? Buffer.alloc(0) : await readBody(up, MAX_PLAYLIST_BYTES - (sniffed?.head.length ?? 0));
        const text = Buffer.concat([sniffed?.head ?? Buffer.alloc(0), rest]).toString('utf8');
        const body = Buffer.from(rewritePlaylist(text, finalUrl, (abs) => relayUrl(parts[1], abs)), 'utf8');
        res.writeHead(200, { ...CORS, 'content-type': 'application/vnd.apple.mpegurl', 'content-length': body.length, 'cache-control': 'no-cache' });
        res.end(body);
      } catch (err) {
        res.writeHead(502, { ...CORS, 'content-type': 'text/plain' });
        res.end(err.message);
      }
      return;
    }
    const out = {};
    for (const name of PASS_RESPONSE) if (up.headers[name]) out[name] = up.headers[name];
    res.writeHead(up.statusCode, { ...CORS, ...out });
    if (req.method === 'HEAD') { up.resume(); res.end(); return; }
    if (sniffed) {
      if (sniffed.ended) { res.end(sniffed.head); return; }
      res.write(sniffed.head);
    }
    up.pipe(res);
    up.on('error', () => res.destroy());
    res.on('close', () => up.destroy());
  }

  return {
    start() {
      if (lan) unroute = lan.route('/relay', { request: onRequest });
    },
    stop() {
      unroute?.();
      sessions.clear();
      blobs.clear();
    },
    register,
    registerBlob,
    probeHls,
    convertedUrl: (job) => `${base()}/x/${job}/index.m3u8`,
    proxyUrl: () => vpn()?.proxyUrl?.() ?? null,
    setDemand() {},
  };
}
