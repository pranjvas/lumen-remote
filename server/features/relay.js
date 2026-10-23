// Media relay for the TV: the TV fetches a video stream from Lumen (TV-facing listener,
// /relay/<token>/…), and Lumen fetches it upstream — through the VPN when it is on, with the page's
// Referer and the browser's User-Agent, following redirects. HLS playlists are rewritten so every
// variant playlist, key and segment also comes through the relay. Stream tokens are random and
// expire; only http(s) targets are relayed, and never to this PC itself (loopback, its own addresses)
// or, unless config.relay.allowPrivate is set, to the local network: the stream, playlist, redirect
// and licence URLs all come from web pages, and the relay must not let a page reach what the Lumen
// browser blocks (browser.js isLoopbackHost / Network.setBlockedURLs).
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { LumenError } from '../errors.js';

// Idle expiry of a token; a token also ends at an absolute age (licence tokens at TOKEN_TTL_MS,
// stream tokens at STREAM_MAX_MS) however often it is used.
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const STREAM_MAX_MS = 24 * 60 * 60 * 1000;
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
const bareHost = (host) => String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

// Hosting suffixes where every subdomain belongs to a different customer: each host is its own site.
const SHARED_SUFFIXES = [
  'cloudfront.net', 'amazonaws.com', 'akamaized.net', 'akamaihd.net', 'akamai.net', 'edgesuite.net', 'edgekey.net',
  'fastly.net', 'fastlylb.net', 'azureedge.net', 'azurewebsites.net', 'azurefd.net', 'windows.net', 'b-cdn.net',
  'r2.dev', 'workers.dev', 'pages.dev', 'github.io', 'gitlab.io', 'herokuapp.com', 'appspot.com', 'web.app',
  'firebaseapp.com', 'netlify.app', 'vercel.app', 'onrender.com', 'fly.dev', 'glitch.me', 'surge.sh',
  'blogspot.com', 'wordpress.com', 'googleusercontent.com', 'digitaloceanspaces.com', 'ngrok.io', 'ngrok-free.app',
  'llnwd.net', 'hwcdn.net', 'cachefly.net', 'kxcdn.com', 'cdn77.org', 'bunnycdn.com', 'backblazeb2.com',
];
// Second-level labels under a two-letter country TLD that are public suffixes (co.uk, com.au, ne.jp …).
const CC_SECOND_LEVEL = /^(ac|co|com|edu|gov|govt|net|org|mil|nic|ne|or|go|gob|gr|ed|lg|ltd|plc|sch|nom|gen|biz|info|in|res)$/;

/**
 * The site a host belongs to, for keeping the page's cookies on it: "cdn.media.example.com" →
 * "example.com", "www.bbc.co.uk" → "bbc.co.uk", "d111.cloudfront.net" → itself, an IP → itself.
 */
export function siteOf(host) {
  const h = bareHost(host);
  if (!h || net.isIP(h)) return h;
  if (SHARED_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`))) return h;
  const labels = h.split('.');
  const n = labels.length >= 3 && labels.at(-1).length === 2 && CC_SECOND_LEVEL.test(labels.at(-2)) ? 3 : 2;
  return labels.slice(-n).join('.');
}

/** IPv6 text → its eight 16-bit groups, or null. */
function ipv6Groups(text) {
  let s = String(text).replace(/%.*$/, '');
  if (!net.isIPv6(s)) return null;
  const quad = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (quad) {
    const [a, b, c, d] = quad.slice(2).map(Number);
    s = `${quad[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? null : tail ? tail.split(':') : [];
  const groups = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.length === 8 ? groups.map((g) => parseInt(g, 16)) : null;
}

/** An IP address in canonical form (IPv4-mapped / -compatible / NAT64 IPv6 → the IPv4 inside), or null. */
function canonicalIp(address) {
  const a = bareHost(address);
  if (net.isIPv4(a)) return a;
  const g = ipv6Groups(a);
  if (!g) return null;
  const embedded = (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || (g[5] === 0 && (g[6] || g[7] > 1))))
    || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
  if (embedded) return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  return g.map((x) => x.toString(16)).join(':');
}

/** 'loopback' (this PC), 'private' (LAN, link-local, CGNAT), 'reserved' (multicast, broadcast, 240/4) or null. */
function addressClass(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127 || a === 0) return 'loopback';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return 'private';
    if (a >= 224) return 'reserved';
    return null;
  }
  const g = ip.split(':').map((x) => parseInt(x, 16));
  if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return 'loopback'; // :: and ::1
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xfe00) === 0xfc00) return 'private'; // link-local, unique-local
  if ((g[0] & 0xff00) === 0xff00) return 'reserved'; // multicast
  return null;
}

function ownAddresses() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) { const ip = canonicalIp(i.address); if (ip) out.add(ip); }
  return out;
}

/**
 * Why the relay must not send a request to `host` (a URL hostname or a resolved address), or null.
 * Names other than localhost pass here; their resolved addresses are checked at connect time.
 */
export function relayRefusal(host, { allowLoopback = false, allowPrivate = false, own = ownAddresses } = {}) {
  const h = bareHost(host);
  if (!h) return 'The stream has no host';
  const ip = canonicalIp(h);
  if (!ip) return !allowLoopback && (h === 'localhost' || h.endsWith('.localhost')) ? 'Lumen does not relay to this PC itself' : null;
  const cls = addressClass(ip);
  if (cls === 'reserved') return 'Lumen does not relay to that address';
  if (!allowLoopback && (cls === 'loopback' || own().has(ip))) return 'Lumen does not relay to this PC itself';
  if (!allowPrivate && cls === 'private') return 'Lumen does not relay to the local network';
  return null;
}

/** A dns.lookup-compatible function that refuses names resolving to an address `refusal` rejects (DNS rebinding). */
function guardedLookup(refusal, lookup = dns.lookup) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      const list = Array.isArray(address) ? address : [{ address, family }];
      const why = list.map((a) => refusal(a.address)).find(Boolean);
      if (why) return callback(new LumenError('INVALID', why));
      return callback(null, address, family);
    });
  };
}

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

/**
 * One upstream request (GET/HEAD, or POST with `body`), through an HTTP CONNECT proxy when proxyUrl is set. → IncomingMessage
 * `refusal(host)` (relayRefusal) is checked against the URL's host and, on direct connections, against
 * every address the name resolves to; through the VPN proxy names resolve inside the tunnel.
 */
export function requestUpstream(target, { method = 'GET', headers = {}, proxyUrl = null, timeoutMs = TIMEOUT_MS, body = null, refusal = null, lookup = undefined } = {}) {
  const url = new URL(target);
  const secure = url.protocol === 'https:';
  const port = Number(url.port) || (secure ? 443 : 80);
  const path = `${url.pathname}${url.search}`;
  const reqHeaders = { host: url.host, ...headers };
  const refused = refusal?.(url.hostname);
  if (refused) return Promise.reject(new LumenError('INVALID', refused));
  return new Promise((resolve, reject) => {
    const fail = (err) => reject(err instanceof LumenError ? err : new LumenError('FAILED', `The stream did not load: ${err.message}`));
    const send = (createConnection) => {
      const lib = secure ? https : http;
      const resolver = !createConnection && refusal ? guardedLookup(refusal, lookup) : lookup;
      const req = lib.request({ host: url.hostname, port, method, path, headers: reqHeaders, servername: url.hostname, ...(createConnection && { createConnection }), ...(resolver && { lookup: resolver }), agent: false, timeout: timeoutMs });
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

/**
 * Follows redirects; → { res, url } (final URL). `headersFor(url)` builds the headers for each hop, so
 * cookies meant for one site are not carried to the site a redirect points at.
 */
async function fetchFollow(target, { headersFor, ...options }) {
  let url = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await requestUpstream(url, { ...options, headers: headersFor(new URL(url)) });
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

// drain: true (a request from the TV) reads and drops the rest instead of destroying the stream, so the
// caller can still answer it (413).
function readBody(res, max, { drain = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    res.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        if (!drain) res.destroy();
        reject(new LumenError('FAILED', 'The playlist is too large'));
        return;
      }
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

// config.browser.allowLoopback (tests that serve their own pages on 127.0.0.1) also lets the relay reach
// this PC; config.relay.allowPrivate lets it reach the local network. `lookup` is a dns.lookup seam (tests).
export function createRelay({ log: rootLog, lan, config = {}, vpn = () => null, transcoder = () => null, lookup = undefined }) {
  const log = rootLog.child('relay');
  const sessions = new Map(); // token → { target, referer, origin, userAgent, cookie, cookieSite, licence, at, expires }
  const blobs = new Map(); // token → { body, type, at }: small public files Lumen hands the TV (a DRM service certificate)
  const policy = { allowLoopback: Boolean(config?.browser?.allowLoopback), allowPrivate: Boolean(config?.relay?.allowPrivate) };
  const refusal = (host) => relayRefusal(host, policy);
  let unroute = null;

  function prune() {
    const now = Date.now();
    for (const [token, s] of sessions) if (now - s.at > TOKEN_TTL_MS || now > s.expires) sessions.delete(token);
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    for (const [token, b] of blobs) if (now - b.at > TOKEN_TTL_MS) blobs.delete(token);
    while (blobs.size > MAX_SESSIONS) blobs.delete(blobs.keys().next().value);
  }

  /** The live session for `token`, or null (expired ones are dropped first). */
  function live(token) {
    prune();
    return sessions.get(token) ?? null;
  }

  // Every upstream request: VPN proxy when on, the destination policy, the DNS seam.
  const upstreamOptions = (extra = {}) => ({ proxyUrl: vpn()?.proxyUrl?.() ?? null, refusal, lookup, ...extra });

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
    const refused = refusal(url.hostname);
    if (refused) throw new LumenError('INVALID', refused);
    prune();
    const token = randomBytes(16).toString('hex');
    const ref = referer ? webUrl(referer) : null;
    const kind = licence === true || licence === 'resolve' ? licence : false;
    const now = Date.now();
    sessions.set(token, {
      target: url.href, referer: ref?.href ?? null, origin: origin ?? ref?.origin ?? null, userAgent: userAgent || UA, at: now,
      expires: now + (kind ? TOKEN_TTL_MS : STREAM_MAX_MS),
      cookie: typeof cookie === 'string' && cookie.length < 8192 ? cookie : null, cookieSite: siteOf(url.hostname), licence: kind,
    });
    return { token, url: relayUrl(token, url.href) };
  }

  function upstreamHeaders(session, target, extra = {}) {
    const headers = { 'user-agent': session.userAgent, ...(session.referer && { referer: session.referer }), ...(session.origin && { origin: session.origin }), ...extra };
    // The page's cookies go only to the site that set them, never to other hosts in the playlist.
    if (session.cookie && siteOf(target.hostname) === session.cookieSite) headers.cookie = session.cookie;
    return headers;
  }

  async function fetchPlaylist(session, target) {
    const { res, url } = await fetchFollow(target, upstreamOptions({ headersFor: (u) => upstreamHeaders(session, u, { 'accept-encoding': 'identity' }), timeoutMs: 8000 }));
    if (res.statusCode !== 200) { res.resume(); throw new LumenError('FAILED', `The playlist answered ${res.statusCode}`); }
    return { text: (await readBody(res, MAX_PLAYLIST_BYTES)).toString('utf8'), url };
  }

  /**
   * What kind of HLS a registered stream is: { fmp4 } is true when its media playlist uses
   * fragmented MP4 segments (EXT-X-MAP), which the TV's own player does not play.
   * { drm } is true for DRM-encrypted (SAMPLE-AES) streams.
   */
  async function probeHls(token) {
    const session = live(token);
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
    prune();
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

  async function resolveLicenceServer(session, target) {
    const { res, url } = await fetchFollow(target.href, upstreamOptions({ headersFor: (u) => upstreamHeaders(session, u, { 'accept-encoding': 'identity' }), timeoutMs: 10000 }));
    const text = (await readBody(res, 64 * 1024)).toString('utf8').trim();
    if (res.statusCode !== 200) throw new LumenError('FAILED', `The licence URL request answered ${res.statusCode}`);
    let next = null;
    let json;
    try { json = JSON.parse(text); } catch { /* plain URL */ }
    if (json !== undefined) {
      // JSON answers only count through their URL field; anything else is "no URL", not a relative path.
      if (typeof json?.licenseAcquisitionUrl === 'string' && json?.token) next = webUrl(`${json.licenseAcquisitionUrl}?ExpressPlayToken=${encodeURIComponent(json.token)}`);
    } else if (/^[^\s{}<>"]{1,4096}$/.test(text)) {
      next = webUrl(text, url);
    }
    if (!next) throw new LumenError('FAILED', 'The licence URL request returned no URL');
    // The site picks the licence server, so it must pass the same destination policy (the POST checks
    // it again); a server on another site is normal (Vimeo → ExpressPlay) but worth a log line.
    const refused = refusal(next.hostname);
    if (refused) throw new LumenError('INVALID', `The licence server is not allowed: ${refused}`);
    if (siteOf(next.hostname) !== siteOf(target.hostname)) log.info('licence server on another site', { registered: target.hostname, resolved: next.hostname });
    return next;
  }

  async function relayLicence(req, res, session, target) {
    session.at = Date.now();
    let body;
    try {
      body = await readBody(req, MAX_LICENCE_BYTES, { drain: true });
    } catch {
      res.writeHead(413, { ...CORS, 'content-type': 'text/plain', connection: 'close' });
      res.end('too large');
      return;
    }
    try {
      let server = target;
      if (session.licence === 'resolve') server = await resolveLicenceServer(session, target);
      const headers = upstreamHeaders(session, server, { 'content-length': String(body.length), 'accept-encoding': 'identity' });
      for (const name of ['content-type', 'soapaction', 'accept']) if (req.headers[name]) headers[name] = req.headers[name];
      const up = await requestUpstream(server.href, upstreamOptions({ method: 'POST', headers, body }));
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
    const session = live(parts[1]); // also drops expired blobs
    if (parts[1] === 'b' && parts.length === 3 && blobs.has(parts[2])) {
      const blob = blobs.get(parts[2]);
      res.writeHead(200, { ...CORS, 'content-type': blob.type, 'content-length': blob.body.length });
      res.end(req.method === 'HEAD' ? undefined : blob.body);
      return;
    }
    const target = parts[2] ? webUrl((() => { try { return unb64url(parts[2]); } catch { return ''; } })()) : null;
    if (session && target && req.method === 'POST' && session.licence && target.href === session.target) return relayLicence(req, res, session, target);
    if (!session || !target || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { ...CORS, 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    session.at = Date.now();
    log.info('relay request', { host: target.hostname, method: req.method, range: req.headers.range ?? null });
    const passed = {};
    for (const name of PASS_REQUEST) if (req.headers[name] && name !== 'accept-encoding') passed[name] = req.headers[name];
    passed['accept-encoding'] = 'identity';
    let upstream;
    try {
      upstream = await fetchFollow(target.href, upstreamOptions({ method: req.method, headersFor: (u) => upstreamHeaders(session, u, passed) }));
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
