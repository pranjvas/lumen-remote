// Media relay for the TV: the TV fetches a video stream from Lumen (TV-facing listener,
// /relay/<token>/…), and Lumen fetches it upstream — through the VPN when it is on, with the page's
// Referer and the browser's User-Agent, following redirects. HLS playlists are rewritten so every
// variant playlist, key and segment also comes through the relay. Stream tokens are random and
// expire; only http(s) targets are relayed.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { LumenError } from '../errors.js';

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SESSIONS = 20;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';
const PASS_REQUEST = ['range', 'accept', 'accept-encoding', 'if-range'];
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

/** One upstream GET/HEAD, through an HTTP CONNECT proxy when proxyUrl is set. → IncomingMessage */
export function requestUpstream(target, { method = 'GET', headers = {}, proxyUrl = null, timeoutMs = TIMEOUT_MS } = {}) {
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
      req.end();
    };
    if (!proxyUrl) return send(null);
    const proxy = new URL(proxyUrl);
    if (!secure) {
      // Plain http through the proxy: absolute-URI request.
      const req = http.request({ host: proxy.hostname, port: proxy.port, method, path: url.href, headers: reqHeaders, agent: false, timeout: timeoutMs });
      req.on('response', resolve);
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', fail);
      req.end();
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

export function createRelay({ log: rootLog, lan, vpn = () => null }) {
  const log = rootLog.child('relay');
  const sessions = new Map(); // token → { referer, origin, userAgent, at }
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
  function register(target, { referer = null, origin = null, cookie = null, userAgent = null } = {}) {
    const url = webUrl(target);
    if (!url) throw new LumenError('INVALID', 'Only http(s) streams can be relayed');
    prune();
    const token = randomBytes(16).toString('hex');
    const ref = referer ? webUrl(referer) : null;
    sessions.set(token, {
      referer: ref?.href ?? null, origin: origin ?? ref?.origin ?? null, userAgent: userAgent || UA, at: Date.now(),
      cookie: typeof cookie === 'string' && cookie.length < 8192 ? cookie : null, cookieSite: siteOf(url.hostname),
    });
    return { token, url: relayUrl(token, url.href) };
  }

  async function onRequest(req, res) {
    const parts = new URL(req.url, 'http://relay.invalid').pathname.split('/').filter(Boolean); // relay, token, target, name
    const session = sessions.get(parts[1]);
    const target = parts[2] ? webUrl((() => { try { return unb64url(parts[2]); } catch { return ''; } })()) : null;
    if (!session || !target || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    session.at = Date.now();
    log.info('relay request', { host: target.hostname, method: req.method, range: req.headers.range ?? null });
    const headers = { 'user-agent': session.userAgent, ...(session.referer && { referer: session.referer }), ...(session.origin && { origin: session.origin }) };
    // The page's cookies go only to the site that set them, never to other hosts in the playlist.
    if (session.cookie && siteOf(target.hostname) === session.cookieSite) headers.cookie = session.cookie;
    for (const name of PASS_REQUEST) if (req.headers[name] && name !== 'accept-encoding') headers[name] = req.headers[name];
    headers['accept-encoding'] = 'identity';
    let upstream;
    try {
      upstream = await fetchFollow(target.href, { method: req.method, headers, proxyUrl: vpn()?.proxyUrl?.() ?? null });
    } catch (err) {
      log.warn('relay fetch failed', { host: target.hostname, message: err.message });
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('upstream failed');
      return;
    }
    const { res: up, url: finalUrl } = upstream;
    const type = up.headers['content-type'] ?? '';
    if (up.statusCode === 200 && isPlaylist(type, finalUrl) && req.method === 'GET') {
      try {
        const text = (await readBody(up, MAX_PLAYLIST_BYTES)).toString('utf8');
        const body = Buffer.from(rewritePlaylist(text, finalUrl, (abs) => relayUrl(parts[1], abs)), 'utf8');
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': body.length, 'cache-control': 'no-cache' });
        res.end(body);
      } catch (err) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(err.message);
      }
      return;
    }
    const out = {};
    for (const name of PASS_RESPONSE) if (up.headers[name]) out[name] = up.headers[name];
    res.writeHead(up.statusCode, out);
    if (req.method === 'HEAD') { up.resume(); res.end(); return; }
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
    },
    register,
    setDemand() {},
  };
}
