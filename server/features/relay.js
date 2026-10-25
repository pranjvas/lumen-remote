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

// The TV's player (AVPlay, and <video>, which plays through it) reads response header names
// case-sensitively. Sent lowercase as Node writes them when given so (content-length), it never
// learns the stream's size and refuses every seek with PLAYER_ERROR_INVALID_STATE (the Q95T, 26 Oct:
// the same file and server seek once the names are capitalised). Every reply here spells them as usual.
const HEADER_SPELLING = { etag: 'ETag' };
export function canonicalHeaderName(name) {
  const lower = String(name).toLowerCase();
  return HEADER_SPELLING[lower] ?? lower.replace(/(^|-)([a-z])/g, (_, dash, c) => dash + c.toUpperCase());
}
function writeHead(res, status, headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) out[canonicalHeaderName(name)] = value;
  res.writeHead(status, out);
}

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
/** A 206 whose Content-Range is the whole body (bytes 0-N/N+1), no larger than a playlist can be. */
const wholeBody = (h) => {
  const m = /^bytes 0-(\d+)\/(\d+)$/.exec(String(h['content-range'] ?? ''));
  return Boolean(m) && Number(m[1]) + 1 === Number(m[2]) && Number(m[2]) <= MAX_PLAYLIST_BYTES;
};
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

// ---------- what the TV's own player can show: HLS variants, H.264 levels ----------

// MaxFS (the largest frame, in 16×16 macroblocks) per H.264 level_idc (H.264 Table A-1; 9 is 1b).
// AVPlay sizes its decoder by the level: a 1080p stream labelled 3.0 plays with sound and a black
// picture while reporting 'playing'. Desktop decoders ignore the label.
const MAX_FS = { 9: 99, 10: 99, 11: 396, 12: 396, 13: 396, 20: 396, 21: 792, 22: 1620, 30: 1620, 31: 3600, 32: 5120, 40: 8192, 41: 8192, 42: 8704, 50: 22080, 51: 36864, 52: 36864 };
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);
const AUDIO_CODEC = /^(mp4a|ac-3|ec-3|ac-4|mp3|opus|flac|fLaC|alac|dtsc|dtse|dtsh|dtsl|dtsx|mhm1|mha1)(\.|$)/i;
const AUDIO_SEGMENT = /\.(aac|mp3|ac3|ec3|eac3|m4a|vtt)$/i;
const NO_COPY_CODECS = /(^|[\s,])(hvc1|hev1|av01|vp09)(\.|$|[\s,])/i;
const DRM_KEY = /#EXT-X-(SESSION-)?KEY:[^\r\n]*\bMETHOD=SAMPLE-AES/;
const ENCRYPTED_KEY = /#EXT-X-KEY:[^\r\n]*\bMETHOD=(?!NONE\b)/i;
const LEVEL_BUDGET_MS = 2500; // the level check's own budget inside probeHls / probeFile
const PROBE_SOFT_MS = 5000; // tvscreen gives the whole probe 6 s: the level check never makes it miss that
const SEGMENT_HEAD_BYTES = 64 * 1024;
const FILE_HEAD_BYTES = 256 * 1024;

const levelOf = (levelIdc, profile, constraints) => (levelIdc === 9 || (levelIdc === 11 && (constraints & 0x10) && profile < 100) ? 9 : levelIdc);

/** True when a w×h picture is larger than H.264 `level` (level_idc; 9 is 1b) allows. Frame size only. */
export function levelTooLow(level, w, h) {
  const max = MAX_FS[level];
  return Boolean(max && w > 0 && h > 0 && Math.ceil(w / 16) * Math.ceil(h / 16) > max);
}

/** An avc1/avc3 codec string's { profile, level } ("avc1.64001E", or the old "avc1.100.30"), or null. */
export function avcLevel(codec) {
  const m = /^avc[13]\.(?:([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})|(\d+)\.(\d+))$/i.exec(String(codec ?? '').trim());
  if (!m) return null;
  if (m[1]) {
    const profile = parseInt(m[1], 16);
    return { profile, level: levelOf(parseInt(m[3], 16), profile, parseInt(m[2], 16)) };
  }
  return { profile: Number(m[4]), level: Number(m[5]) };
}

const codecList = (codecs) => String(codecs ?? '').split(',').map((c) => c.trim()).filter(Boolean);
const audioOnlyCodecs = (codecs) => { const list = codecList(codecs); return list.length > 0 && list.every((c) => AUDIO_CODEC.test(c)); };

/** An HLS attribute list (`BANDWIDTH=1,CODECS="a,b"`) → { BANDWIDTH: '1', CODECS: 'a,b' }. */
function hlsAttributes(text) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let m;
  while ((m = re.exec(text))) out[m[1].toUpperCase()] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}

/**
 * The variants of an HLS master playlist, one per #EXT-X-STREAM-INF (I-frame playlists are not
 * variants): { index, bandwidth, width, height, codecs, audio, uri }. `index` counts STREAM-INF
 * entries only, which is ffmpeg's program id for that variant (-map 0:p:<index>:v:0).
 */
export function parseHlsMaster(text, baseUrl = undefined) {
  const out = [];
  let attrs = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXT-X-STREAM-INF:/i.test(line)) { attrs = hlsAttributes(line.slice(line.indexOf(':') + 1)); continue; }
    if (line.startsWith('#') || !attrs) continue;
    const res = /^(\d+)x(\d+)$/i.exec(attrs.RESOLUTION ?? '');
    const abs = baseUrl ? webUrl(line, baseUrl) : null;
    out.push({
      index: out.length, bandwidth: Number(attrs.BANDWIDTH) || 0, width: res ? Number(res[1]) : null, height: res ? Number(res[2]) : null,
      codecs: attrs.CODECS ?? null, audio: attrs.AUDIO ?? null, uri: abs ? abs.href : line,
    });
    attrs = null;
  }
  return out;
}

/**
 * The variant worth converting: the highest bandwidth up to 1080p for an encode, up to 2160p for a
 * copy (which also passes over HEVC, AV1 and VP9 variants while an H.264 one exists); when none fits,
 * the smallest above that. Audio-only variants never count. → a variant, or null without any.
 */
export function chooseVariant(variants, { copy = false } = {}) {
  const list = (Array.isArray(variants) ? variants : []).filter((v) => v && !audioOnlyCodecs(v.codecs));
  if (!list.length) return null;
  const cap = copy ? 2160 : 1080;
  const usable = copy ? list.filter((v) => !NO_COPY_CODECS.test(v.codecs ?? '')) : list;
  const pool = usable.length ? usable : list;
  const fit = pool.filter((v) => !(v.height > cap));
  if (fit.length) return fit.reduce((best, v) => (v.bandwidth > best.bandwidth || (v.bandwidth === best.bandwidth && (v.height ?? 0) > (best.height ?? 0)) ? v : best));
  return pool.reduce((best, v) => (v.height < best.height ? v : best));
}

/** A bit reader over an RBSP; reading past the end throws. */
function bitReader(bytes) {
  let pos = 0;
  const end = bytes.length * 8;
  const bit = () => {
    if (pos >= end) throw new Error('short SPS');
    const b = (bytes[pos >> 3] >> (7 - (pos & 7))) & 1;
    pos += 1;
    return b;
  };
  const u = (n) => { let v = 0; for (let k = 0; k < n; k++) v = v * 2 + bit(); return v; };
  const ue = () => {
    let zeros = 0;
    while (!bit()) if (++zeros > 31) throw new Error('bad SPS');
    return 2 ** zeros - 1 + u(zeros);
  };
  const se = () => { const k = ue(); return k & 1 ? (k + 1) / 2 : -k / 2; };
  return { u, ue, se };
}

/**
 * An H.264 sequence parameter set (a NAL unit, header byte first) →
 * { profile, constraints, level, chroma, bitDepth, refs, w, h, mbs }: w and h are the coded size
 * (macroblocks × 16, before cropping), mbs the frame size the level limits. Throws on a bad SPS.
 */
export function parseSps(nal) {
  const rbsp = [];
  let zeros = 0;
  for (let i = 1; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 3) { zeros = 0; continue; } // emulation prevention (00 00 03)
    rbsp.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  const r = bitReader(rbsp);
  const profile = r.u(8);
  const constraints = r.u(8);
  const levelIdc = r.u(8);
  r.ue(); // seq_parameter_set_id
  let chroma = 1;
  let bitDepth = 8;
  if (HIGH_PROFILES.has(profile)) {
    chroma = r.ue();
    if (chroma === 3) r.u(1);
    bitDepth = r.ue() + 8;
    r.ue();
    r.u(1);
    if (r.u(1)) {
      for (let k = 0; k < (chroma !== 3 ? 8 : 12); k++) {
        if (!r.u(1)) continue;
        let last = 8;
        let next = 8;
        for (let j = 0; j < (k < 6 ? 16 : 64); j++) {
          if (next !== 0) next = (last + r.se() + 256) % 256;
          last = next === 0 ? last : next;
        }
      }
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const poc = r.ue();
  if (poc === 0) r.ue();
  else if (poc === 1) {
    r.u(1);
    r.se();
    r.se();
    const cycle = r.ue();
    if (cycle > 255) throw new Error('bad SPS');
    for (let k = 0; k < cycle; k++) r.se();
  }
  const refs = r.ue();
  r.u(1);
  const wMbs = r.ue() + 1;
  const mapUnits = r.ue() + 1;
  const frameMbsOnly = r.u(1);
  const hMbs = mapUnits * (2 - frameMbsOnly);
  if (wMbs > 1024 || hMbs > 1024) throw new Error('bad SPS');
  return { profile, constraints, level: levelOf(levelIdc, profile, constraints), chroma, bitDepth, refs, w: wMbs * 16, h: hMbs * 16, mbs: wMbs * hMbs };
}

/** The first SPS in an H.264 Annex B elementary stream, parsed, or null. */
function firstSps(es) {
  for (let i = 0; i + 3 < es.length; i++) {
    if (es[i] !== 0 || es[i + 1] !== 0 || es[i + 2] !== 1 || (es[i + 3] & 0x1f) !== 7) continue;
    let end = es.length;
    for (let j = i + 4; j + 2 < es.length; j++) if (es[j] === 0 && es[j + 1] === 0 && es[j + 2] <= 1) { end = j; break; }
    try { return parseSps(es.subarray(i + 3, end)); } catch { return null; }
  }
  return null;
}

const TS_PACKET = 188;

/** A PSI section in a TS payload (pointer field first) → { s: its start, end: before the CRC }, or null. */
function psiSection(pay) {
  const s = 1 + pay[0];
  if (s + 3 > pay.length) return null;
  const length = ((pay[s + 1] & 0x0f) << 8) | pay[s + 2];
  return { s, end: Math.min(pay.length, s + 3 + length - 4) };
}

/** The H.264 elementary stream in the first bytes of an MPEG-TS file (PAT → PMT → PES), or null. */
function tsH264Es(buf) {
  let start = -1;
  for (let i = 0; i < TS_PACKET && i < buf.length; i++) {
    if (buf[i] === 0x47 && (i + TS_PACKET >= buf.length || buf[i + TS_PACKET] === 0x47)) { start = i; break; }
  }
  if (start < 0) return null;
  let pmtPid = -1;
  let videoPid = -1;
  const es = [];
  for (let i = start; i + TS_PACKET <= buf.length; i += TS_PACKET) {
    if (buf[i] !== 0x47) break;
    const pusi = (buf[i + 1] & 0x40) !== 0;
    const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
    const afc = (buf[i + 3] >> 4) & 3;
    let p = i + 4;
    if (afc & 2) p += 1 + buf[p];
    if (!(afc & 1) || p >= i + TS_PACKET) continue;
    const pay = buf.subarray(p, i + TS_PACKET);
    if (pid === 0 && pusi && pmtPid < 0) {
      const sec = psiSection(pay);
      if (!sec || pay[sec.s] !== 0x00) continue;
      for (let q = sec.s + 8; q + 4 <= sec.end; q += 4) {
        if (((pay[q] << 8) | pay[q + 1]) !== 0) { pmtPid = ((pay[q + 2] & 0x1f) << 8) | pay[q + 3]; break; }
      }
    } else if (pid === pmtPid && pusi && videoPid < 0) {
      const sec = psiSection(pay);
      if (!sec || pay[sec.s] !== 0x02 || sec.s + 12 > pay.length) continue;
      const infoLength = ((pay[sec.s + 10] & 0x0f) << 8) | pay[sec.s + 11];
      for (let q = sec.s + 12 + infoLength; q + 5 <= sec.end; q += 5 + (((pay[q + 3] & 0x0f) << 8) | pay[q + 4])) {
        if (pay[q] === 0x1b) { videoPid = ((pay[q + 1] & 0x1f) << 8) | pay[q + 2]; break; }
      }
      if (videoPid < 0) return null; // no H.264 in the programme (HEVC, audio only)
    } else if (pid === videoPid) {
      if (pusi) {
        if (pay.length < 9 || pay[0] !== 0 || pay[1] !== 0 || pay[2] !== 1) continue;
        const at = 9 + pay[8];
        if (at < pay.length) es.push(pay.subarray(at));
      } else if (es.length) {
        es.push(pay);
      }
    }
  }
  return es.length ? Buffer.concat(es) : null;
}

/** The first H.264 SPS in the first bytes of an MPEG-TS segment (see parseSps), or null. */
export function readTsSps(buf) {
  const es = tsH264Es(buf);
  return es ? firstSps(es) : null;
}

/** MP4 boxes between start and end (headers that do not fit end the walk). */
function* mp4Boxes(buf, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let head = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = Number(buf.readBigUInt64BE(p + 8));
      head = 16;
    } else if (size === 0) {
      size = Number.MAX_SAFE_INTEGER - p; // to the end of the file
    }
    if (size < head) return;
    yield { type, body: p + head, end: p + size };
    p += size;
  }
}

function mp4Child(buf, box, type, skip = 0) {
  for (const b of mp4Boxes(buf, box.body + skip, Math.min(box.end, buf.length))) if (b.type === type) return b;
  return null;
}

/**
 * The SPS of the first H.264 track in the first bytes of an MP4 (moov → … → avcC), parsed, or null:
 * also null when the media comes before the moov (moov at the end of the file).
 */
export function readMp4Sps(buf) {
  let moov = null;
  for (const b of mp4Boxes(buf, 0, buf.length)) {
    if (b.type === 'moov') { moov = b; break; }
    if (b.type === 'mdat' || b.type === 'moof') return null;
  }
  if (!moov) return null;
  for (const trak of mp4Boxes(buf, moov.body, Math.min(moov.end, buf.length))) {
    if (trak.type !== 'trak') continue;
    let box = trak;
    for (const type of ['mdia', 'minf', 'stbl', 'stsd']) { box = box && mp4Child(buf, box, type); }
    if (!box) continue;
    for (const entry of mp4Boxes(buf, box.body + 8, Math.min(box.end, buf.length))) { // stsd: version, flags, count
      if (entry.type !== 'avc1' && entry.type !== 'avc3') continue;
      const avcC = mp4Child(buf, entry, 'avcC', 78); // after the visual sample entry's fixed fields
      if (!avcC || avcC.body + 8 > buf.length || !(buf[avcC.body + 5] & 0x1f)) return null;
      const length = buf.readUInt16BE(avcC.body + 6);
      const at = avcC.body + 8;
      if (at + length > buf.length) return null;
      try { return parseSps(buf.subarray(at, at + length)); } catch { return null; }
    }
  }
  return null;
}

/** Up to `max` bytes from the start of a response; then the response is destroyed (never read past). */
function readPrefix(res, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).subarray(0, max)); } };
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    res.on('data', (c) => {
      if (settled) return;
      chunks.push(c);
      size += c.length;
      if (size >= max) { done(); res.destroy(); }
    });
    res.on('end', done);
    res.on('error', (err) => (size ? done() : fail(err)));
    res.on('close', () => (size ? done() : fail(new Error('the stream closed early'))));
    res.resume();
  });
}

/** Rejects when `promise` takes longer than `ms`. */
function withinBudget(promise, ms) {
  let timer = null;
  return Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('over budget')), ms); })])
    .finally(() => clearTimeout(timer));
}

/** The first segment of a media playlist: { url, range: { length, offset } | null }, or null. */
function firstSegment(text, base) {
  let range = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const br = /^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?/i.exec(line);
    if (br) { range = { length: Number(br[1]), offset: Number(br[2] ?? 0) }; continue; }
    if (line.startsWith('#')) continue;
    const abs = webUrl(line, base);
    return abs ? { url: abs.href, range } : null;
  }
  return null;
}

/** levelLow from the variants' CODECS and RESOLUTION, one per variant (null when it fits). */
function codecLevels(variants) {
  return variants.map((v) => {
    if (!v.width || !v.height) return null;
    for (const codec of codecList(v.codecs)) {
      const avc = avcLevel(codec);
      if (avc && levelTooLow(avc.level, v.width, v.height)) return { level: avc.level, w: v.width, h: v.height, from: 'codecs' };
    }
    return null;
  });
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
   * The first `max` bytes of `target` (Range from `offset`), with the session's headers and the
   * destination policy; 200 and 206 both count. Gives up (destroying the response) after budgetMs.
   */
  async function fetchHead(session, target, { offset = 0, max, budgetMs }) {
    let res = null;
    let over = false;
    const timer = setTimeout(() => { over = true; res?.destroy(); }, budgetMs);
    try {
      const range = `bytes=${offset}-${offset + max - 1}`;
      ({ res } = await fetchFollow(target, upstreamOptions({ headersFor: (u) => upstreamHeaders(session, u, { range, 'accept-encoding': 'identity' }), timeoutMs: budgetMs })));
      if (over) { res.destroy(); throw new Error('over budget'); }
      if (res.statusCode !== 200 && res.statusCode !== 206) { res.destroy(); throw new LumenError('FAILED', `The stream answered ${res.statusCode}`); }
      return await readPrefix(res, max);
    } finally {
      clearTimeout(timer);
    }
  }

  // levelLow for an HLS stream: CODECS + RESOLUTION of every variant (AVPlay switches between them),
  // and the SPS in the first variant's first segment, which replaces what CODECS says about that variant.
  async function hlsLevel(session, { variants, media, mediaUrl, budgetMs }) {
    const fromCodecs = codecLevels(variants);
    const seg = firstSegment(media, mediaUrl);
    let sps = null;
    if (seg && budgetMs >= 200 && !/#EXT-X-MAP/.test(media) && !ENCRYPTED_KEY.test(media)) {
      const max = seg.range ? Math.min(seg.range.length, SEGMENT_HEAD_BYTES) : SEGMENT_HEAD_BYTES;
      if (max > 0) {
        const head = await withinBudget(fetchHead(session, seg.url, { offset: seg.range?.offset ?? 0, max, budgetMs }), budgetMs).catch(() => null);
        sps = head ? readTsSps(head) : null;
      }
    }
    if (sps) {
      if (levelTooLow(sps.level, sps.w, sps.h)) return { level: sps.level, w: sps.w, h: sps.h, from: 'sps' };
      fromCodecs[0] = null;
    }
    return fromCodecs.find(Boolean) ?? null;
  }

  /**
   * What kind of HLS a registered stream is:
   * - fmp4: its media playlist uses fragmented MP4 segments (EXT-X-MAP), which the TV's own player
   *   does not play; endlist: it is a finished (VOD) playlist;
   * - drm: DRM-encrypted (SAMPLE-AES, in the master's session keys or the media playlist);
   * - master: true for a master playlist, with its `variants` (parseHlsMaster);
   * - audioOnly: true when the stream carries no video (every variant's CODECS is audio, or a
   *   single stream's segments are audio or subtitles);
   * - levelLow: { level, w, h, from: 'sps' | 'codecs' } when an H.264 level is too low for its
   *   picture (the TV's player shows black). It and audioOnly are only there when found, and the
   *   level check never fails or holds up the probe (its own budget, within tvscreen's 6 s).
   */
  async function probeHls(token) {
    const startedAt = Date.now();
    const session = live(token);
    if (!session?.target) throw new LumenError('NOT_FOUND', 'Unknown stream');
    const first = await fetchPlaylist(session, session.target);
    let { text, url } = first;
    const master = /#EXT-X-STREAM-INF/.test(first.text);
    const variants = master ? parseHlsMaster(first.text, first.url) : [];
    if (master) {
      const next = variants[0]?.uri ?? first.text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      if (next) ({ text, url } = await fetchPlaylist(session, new URL(next, first.url).href));
    }
    // SAMPLE-AES (FairPlay, Widevine, PlayReady): only a licensed DRM player can decrypt it.
    const drm = DRM_KEY.test(first.text) || DRM_KEY.test(text);
    const out = { fmp4: /#EXT-X-MAP/.test(text), endlist: /#EXT-X-ENDLIST/.test(text), drm };
    if (master) out.master = true;
    if (variants.length) out.variants = variants;
    // Audio only: every variant's CODECS is audio, or a single stream's segments are audio or
    // subtitles. A master that lists an audio-only fallback before its video variants is video.
    const seg = firstSegment(text, url);
    const audioOnly = (variants.length > 0 && variants.every((v) => audioOnlyCodecs(v.codecs)))
      || Boolean(seg && variants.length <= 1 && AUDIO_SEGMENT.test(new URL(seg.url).pathname));
    if (audioOnly) out.audioOnly = true;
    if (!drm && !audioOnly) {
      try {
        const budgetMs = Math.min(LEVEL_BUDGET_MS, PROBE_SOFT_MS - (Date.now() - startedAt));
        const low = await withinBudget(hlsLevel(session, { variants, media: text, mediaUrl: url, budgetMs }), Math.max(budgetMs, 0) + 50);
        if (low) out.levelLow = low;
      } catch { /* no level verdict: never a failed probe */ }
    }
    return out;
  }

  /**
   * levelLow for a plain video file (an MP4 with its moov in the first 256 KB): { levelLow } when
   * the H.264 level is too low for the picture, else {}. Never throws for an unreadable file.
   */
  async function probeFile(token) {
    const session = live(token);
    if (!session?.target) throw new LumenError('NOT_FOUND', 'Unknown stream');
    const head = await withinBudget(fetchHead(session, session.target, { max: FILE_HEAD_BYTES, budgetMs: LEVEL_BUDGET_MS }), LEVEL_BUDGET_MS + 50).catch(() => null);
    const sps = head ? readMp4Sps(head) : null;
    return sps && levelTooLow(sps.level, sps.w, sps.h) ? { levelLow: { level: sps.level, w: sps.w, h: sps.h, from: 'sps' } } : {};
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
    if (!file) { writeHead(res, 404, { ...CORS, 'content-type': 'text/plain' }); res.end('not found'); return; }
    const playlist = name.endsWith('.m3u8');
    if (playlist) {
      // The playlist grows while ffmpeg works, so players treat it as live and join near the end;
      // EXT-X-START tells them to start at the beginning.
      const text = fs.readFileSync(file, 'utf8').replace(/^#EXTM3U\r?\n/, '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n');
      const body = Buffer.from(text, 'utf8');
      writeHead(res, 200, { ...CORS, 'content-type': 'application/vnd.apple.mpegurl', 'content-length': body.length, 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    const size = fs.statSync(file).size;
    writeHead(res, 200, { ...CORS, 'content-type': 'video/mp2t', 'content-length': size, 'cache-control': 'no-cache' });
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
      writeHead(res, 413, { ...CORS, 'content-type': 'text/plain', connection: 'close' });
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
      writeHead(res, up.statusCode, { ...CORS, 'content-type': up.headers['content-type'] ?? 'application/octet-stream', 'content-length': reply.length });
      res.end(reply);
    } catch (err) {
      log.warn('licence request failed', { host: target.hostname, message: err.message });
      writeHead(res, 502, { ...CORS, 'content-type': 'text/plain' });
      res.end('licence server failed');
    }
  }

  async function onRequest(req, res) {
    if (req.method === 'OPTIONS') {
      const asked = String(req.headers['access-control-request-headers'] ?? '').slice(0, 300).replace(/[^\w, -]/g, '');
      writeHead(res, 204, { ...CORS, 'access-control-allow-methods': 'GET, HEAD, POST', 'access-control-allow-headers': asked || 'range, if-range', 'access-control-max-age': '600' });
      res.end();
      return;
    }
    const parts = new URL(req.url, 'http://relay.invalid').pathname.split('/').filter(Boolean); // relay, token, target, name
    if (parts[1] === 'x' && parts.length === 4) return serveConverted(req, res, parts[2], parts[3]);
    const session = live(parts[1]); // also drops expired blobs
    if (parts[1] === 'b' && parts.length === 3 && blobs.has(parts[2])) {
      const blob = blobs.get(parts[2]);
      writeHead(res, 200, { ...CORS, 'content-type': blob.type, 'content-length': blob.body.length });
      res.end(req.method === 'HEAD' ? undefined : blob.body);
      return;
    }
    const target = parts[2] ? webUrl((() => { try { return unb64url(parts[2]); } catch { return ''; } })()) : null;
    if (session && target && req.method === 'POST' && session.licence && target.href === session.target) return relayLicence(req, res, session, target);
    if (!session || !target || (req.method !== 'GET' && req.method !== 'HEAD')) {
      writeHead(res, 404, { ...CORS, 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    session.at = Date.now();
    log.info('relay request', { host: target.hostname, method: req.method, range: req.headers.range ?? null });
    const passed = {};
    for (const name of PASS_REQUEST) if (req.headers[name] && name !== 'accept-encoding') passed[name] = req.headers[name];
    passed['accept-encoding'] = 'identity';
    // AVPlay asks for every URL with Range: bytes=0-. A playlist is fetched whole: a 206 of it would
    // otherwise pass through unrewritten, and the TV would fetch its URIs itself (outside the VPN).
    if (isPlaylist(null, target.href)) { delete passed.range; delete passed['if-range']; }
    let upstream;
    try {
      upstream = await fetchFollow(target.href, upstreamOptions({ method: req.method, headersFor: (u) => upstreamHeaders(session, u, passed) }));
    } catch (err) {
      log.warn('relay fetch failed', { host: target.hostname, message: err.message });
      writeHead(res, 502, { ...CORS, 'content-type': 'text/plain' });
      res.end('upstream failed');
      return;
    }
    const { res: up, url: finalUrl } = upstream;
    const type = up.headers['content-type'] ?? '';
    // A playlist served with another type from a URL without .m3u8 is still a playlist to hls.js (it only
    // checks for #EXTM3U), so the body decides too: left unrewritten, its URIs would be fetched by the TV
    // itself, outside the VPN.
    // A 206 holding the whole body (bytes 0-N/N+1, small enough for a playlist) counts as a full reply.
    const complete = up.statusCode === 200 || (up.statusCode === 206 && wholeBody(up.headers));
    let sniffed = null;
    if (complete && req.method === 'GET' && !isPlaylist(type, finalUrl)) {
      try {
        sniffed = await readHead(up, PLAYLIST_SNIFF_BYTES);
      } catch (err) {
        log.warn('relay fetch failed', { host: target.hostname, message: err.message });
        up.destroy();
        writeHead(res, 502, { ...CORS, 'content-type': 'text/plain' });
        res.end('upstream failed');
        return;
      }
    }
    if (complete && req.method === 'GET' && (isPlaylist(type, finalUrl) || looksLikePlaylist(sniffed.head))) {
      try {
        const rest = sniffed?.ended ? Buffer.alloc(0) : await readBody(up, MAX_PLAYLIST_BYTES - (sniffed?.head.length ?? 0));
        const text = Buffer.concat([sniffed?.head ?? Buffer.alloc(0), rest]).toString('utf8');
        const body = Buffer.from(rewritePlaylist(text, finalUrl, (abs) => relayUrl(parts[1], abs)), 'utf8');
        writeHead(res, 200, { ...CORS, 'content-type': 'application/vnd.apple.mpegurl', 'content-length': body.length, 'cache-control': 'no-cache' });
        res.end(body);
      } catch (err) {
        writeHead(res, 502, { ...CORS, 'content-type': 'text/plain' });
        res.end(err.message);
      }
      return;
    }
    const out = {};
    for (const name of PASS_RESPONSE) if (up.headers[name]) out[name] = up.headers[name];
    // A range answered with 206 is a file that can be seeked: say so even where the server leaves
    // Accept-Ranges out of its 206s (archive.org does). The TV's AVPlay judges a stream's seeking by it.
    if (up.statusCode === 206 && !out['accept-ranges']) out['accept-ranges'] = 'bytes';
    writeHead(res, up.statusCode, { ...CORS, ...out });
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
    /** Clear history: drops every registered stream and file (their addresses, the page's cookies). → how many. */
    forget() {
      const count = sessions.size + blobs.size;
      sessions.clear();
      blobs.clear();
      return count;
    },
    probeHls,
    probeFile,
    convertedUrl: (job) => `${base()}/x/${job}/index.m3u8`,
    proxyUrl: () => vpn()?.proxyUrl?.() ?? null,
    setDemand() {},
  };
}
