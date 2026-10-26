// Cast: classify a link and send it to the right TV path (DIAL app, DLNA renderer, TV browser),
// accept local file uploads and serve them to the TV over the TV-facing listener.
// TV behaviour follows docs/research/re-dlna-cast.md and re-deep-links.md.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LumenError } from '../errors.js';
import { dlnaFeatures, isImage, TRANSIENT_UPNP_CODES } from '../adapters/avtransport.js';
import { DIAL_APPS, pickPayload } from '../adapters/dial.js';

const MAX_UPLOAD_BYTES = 4 * 1024 ** 3;
const FILE_TTL_MS = 6 * 3600_000;
const CLEANUP_EVERY_MS = 3600_000;
const POLL_MS = 1000;
const POLL_FAILURE_STOP_MS = 10_000;
const START_TIMEOUT_MS = 30_000; // no PLAYING by then = the cast never started (config.timing.castStartMs)
const PLAY_RETRY = { everyMs: 500, totalMs: 10_000 }; // 705/701 right after SetAVTransportURI
const SEEK_RETRY = { everyMs: 200, attempts: 8 }; // 701 while TRANSITIONING or just after a Seek
const PROBE_TIMEOUT_MS = 6000;
const BROWSER_TIMEOUT_MS = 10_000;
const MAX_URL_LENGTH = 2048;
const FILE_ID = /^[0-9a-f]{32}$/;
const BUSY_STATES = new Set(['PLAYING', 'PAUSED_PLAYBACK', 'TRANSITIONING']);
const IDLE_STATES = new Set(['STOPPED', 'NO_MEDIA_PRESENT']);
const BROWSER_APP = 'org.tizen.browser';

// Content-Type names exactly as the TV's DMR Sink lists them (other spellings risk 714). The Sink has
// no gif, webp or HLS entry, so those are not offered for uploads.
export const MIME_BY_EXT = Object.freeze({
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-mkv', webm: 'video/webm',
  ts: 'video/mpeg', mpg: 'video/mpeg', mpeg: 'video/mpeg', m2ts: 'video/vnd.dlna.mpeg-tts', mts: 'video/vnd.dlna.mpeg-tts',
  avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/vnd.dlna.adts', flac: 'audio/x-flac', wav: 'audio/x-wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wma: 'audio/x-ms-wma',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', bmp: 'image/bmp',
});

// HLS is only tried for internet links (the TV's player has an HLS demuxer, its DMR Sink lists no
// such type): experimental, and never for uploads.
export const HLS_MIME = 'application/vnd.apple.mpegurl';
const STREAM_BY_EXT = { m3u8: HLS_MIME };

// Common Content-Type spellings → the TV's names; null = a type the TV does not play.
const TV_MIME_ALIASES = {
  'video/x-matroska': 'video/x-mkv', 'video/mp2t': 'video/mpeg', 'video/x-m4v': 'video/mp4', 'video/avi': 'video/x-msvideo',
  'audio/flac': 'audio/x-flac', 'audio/wav': 'audio/x-wav', 'audio/wave': 'audio/x-wav', 'audio/x-pn-wav': 'audio/x-wav',
  'audio/vnd.wave': 'audio/x-wav', 'audio/aac': 'audio/vnd.dlna.adts', 'audio/aacp': 'audio/vnd.dlna.adts',
  'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4',
  'application/x-mpegurl': HLS_MIME, 'audio/mpegurl': HLS_MIME, 'audio/x-mpegurl': HLS_MIME,
  'image/gif': null, 'image/webp': null, 'image/svg+xml': null, 'image/heic': null, 'image/heif': null, 'image/avif': null,
};

const APP_TITLES = { youtube: 'YouTube', netflix: 'Netflix', prime: 'Prime Video' };
const UNSUPPORTED_MESSAGE = 'Lumen can cast the video, audio and image types the TV plays (mp4, mkv, webm, mov, mp3, flac, wav, jpg, png, …)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function mimeFromName(name) {
  const ext = /\.([a-z0-9]+)$/i.exec(name ?? '')?.[1]?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || null;
}

// A server's Content-Type → the TV's name for it, or null when it is not a castable media type.
export function tvMime(contentType) {
  const mime = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (Object.hasOwn(TV_MIME_ALIASES, mime)) return TV_MIME_ALIASES[mime];
  if (mime === HLS_MIME) return HLS_MIME;
  return /^(video|audio|image)\/[\w.+-]+$/.test(mime) ? mime : null;
}

export function parseCastUrl(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text || text.length > MAX_URL_LENGTH) throw new LumenError('INVALID', 'Paste a link to cast');
  let url;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    throw new LumenError('INVALID', 'That is not a valid link');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new LumenError('INVALID', 'Only http and https links can be cast');
  return url;
}

// YouTube's t parameter: "90", "90s", "1m30s", "1h2m3s" → seconds (undefined when absent or zero).
function youtubeOffset(url) {
  const raw = url.searchParams.get('t') ?? new URLSearchParams(url.hash.slice(1)).get('t');
  if (!raw) return undefined;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(raw.trim());
  if (!m || !(m[1] || m[2] || m[3])) return undefined;
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return seconds > 0 ? seconds : undefined;
}

// Pattern-only classification; null means "probe it" (media by Content-Type, else a web page).
export function matchUrl(url) {
  const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  const { pathname } = url;

  let videoId = null;
  if (host === 'youtu.be') videoId = pathname.split('/')[1];
  else if (/(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(host)) {
    videoId = pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(pathname)?.[1];
  }
  if (videoId && /^[\w-]{11}$/.test(videoId)) {
    const t = youtubeOffset(url);
    return { kind: 'youtube', id: videoId, ...(t && { t }) };
  }

  if (/(^|\.)netflix\.com$/.test(host)) {
    const titleId = /\/(?:title|watch)\/(\d+)/.exec(pathname)?.[1];
    if (titleId) return { kind: 'netflix', id: titleId };
  }

  if (/(^|\.)primevideo\.com$/.test(host) || (/(^|\.)amazon\.[a-z.]+$/.test(host) && /\/gp\/video\//.test(pathname))) {
    const gti = url.searchParams.get('gti') ?? /(amzn1\.dv\.gti\.[0-9a-f-]+)/i.exec(pathname)?.[1] ?? null;
    return { kind: 'prime', gti };
  }

  const mime = mimeFromName(pathname);
  if (mime) return { kind: 'media', mime };
  const ext = /\.([a-z0-9]+)$/i.exec(pathname)?.[1]?.toLowerCase();
  return STREAM_BY_EXT[ext] ? { kind: 'media', mime: STREAM_BY_EXT[ext], experimental: true } : null;
}

// Follow redirects on the PC and learn the final URL and type: the TV's DLNA reader fails on any
// 3xx. HEAD first; when it is refused, a one-byte ranged GET. → { url, mime } or null.
async function probe(href) {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const attempt = async (init) => {
    const res = await fetch(href, { redirect: 'follow', signal, ...init });
    await res.body?.cancel().catch(() => {});
    return res;
  };
  let res = null;
  try {
    res = await attempt({ method: 'HEAD' });
  } catch { /* fall through to GET */ }
  if (!res?.ok) {
    try {
      res = await attempt({ method: 'GET', headers: { Range: 'bytes=0-0' } });
    } catch {
      return null;
    }
  }
  return res.ok ? { url: res.url || href, mime: tvMime(res.headers.get('content-type')) } : null;
}

// → { kind: 'youtube'|'netflix'|'prime'|'media'|'page', url, id?, t?, gti?, mime?, experimental? }
export async function classify(input) {
  const url = parseCastUrl(input);
  const matched = matchUrl(url);
  if (matched && matched.kind !== 'media') return { url: url.href, ...matched };
  const probed = await probe(url.href);
  if (matched) {
    // Media by extension: cast the final URL; the server's type wins over the extension when it has one.
    const mime = probed?.mime ?? matched.mime;
    return { kind: 'media', url: probed?.url ?? url.href, mime, ...(mime === HLS_MIME && { experimental: true }) };
  }
  if (probed?.mime) {
    return { kind: 'media', url: probed.url, mime: probed.mime, ...(probed.mime === HLS_MIME && { experimental: true }) };
  }
  return { kind: 'page', url: url.href };
}

// Single byte range → { start, end }; null = serve the whole file; 'unsatisfiable' = 416.
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    return suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : 'unsatisfiable';
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size) return 'unsatisfiable';
  return end >= start ? { start, end } : null;
}

export function cleanFileName(raw) {
  if (typeof raw !== 'string') return null;
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch { /* keep the raw header value */ }
  name = name.replace(/\\/g, '/').split('/').pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return name && name !== '.' && name !== '..' ? name : null;
}

function titleFromUrl(url) {
  const last = url.pathname.split('/').filter(Boolean).pop();
  if (last) {
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  }
  return url.hostname;
}

// Retries fn while the TV answers a transient UPnP fault (705 locked / 701 not available).
async function retryTransient(fn, { everyMs, totalMs = Infinity, attempts = Infinity }) {
  const deadline = Date.now() + totalMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!TRANSIENT_UPNP_CODES.includes(err.upnp?.code) || attempt >= attempts || Date.now() + everyMs > deadline) throw err;
      await sleep(everyMs);
    }
  }
}

// `browser` (optional) returns the Browser-view feature (spec §11.3); it is created after Cast, hence lazy.
// Candidate action_play_url strings for Netflix (provider-defined; ranked, config.cast.netflixSmartHub picks).
// The first plays the title on the Q95T (live 2026-10-23: Friends started playing from a cold start).
const SMART_HUB_NETFLIX = [
  (id) => `m=https://www.netflix.com/watch/${id}&source_type=4`,
  (id) => `m=${id}&source_type=4`,
  (id) => `m=${id}&showMovieInfoOnly=true&source_type_payload=groupIndex%3D1%26tileIndex%3D0%26action%3Dmdp%26movieId%3D${id}`,
];

export function createCast({ config, data, log, store, lan, avtransport, dial, rest, browser = () => null, agent = () => null }) {
  const logger = log.child('cast');
  const castDir = path.join(config.dataDir, 'cast');
  // rest.baseUrl is the adapter's "http://<tv>:8001/api/v2/" (not part of the shared contract, hence the fallback).
  const appsUrl = `${rest?.baseUrl ?? `http://${config.tv.host}:${config.tv.ports.rest}/api/v2/`}applications/`;
  const startTimeoutMs = config.timing?.castStartMs ?? START_TIMEOUT_MS;
  const uploads = new Map(); // fileId → { name, mime, size }

  let routePrefix = null;
  let session = null;
  let generation = 0; // bumps on every new cast and control so a late poll cannot overwrite them
  let polling = false; // DLNA session still worth polling
  let startedAt = 0; // when the current DLNA cast was sent
  let sawPlaying = false; // PLAYING (or paused) observed since the cast: STOPPED after that is the end
  let failedSince = null;
  let visible = false;
  let pollTimer = null;
  let pollInFlight = false;
  let cleanupTimer = null;
  let stopped = false;

  function publish(next) {
    session = next;
    const via = next?.kind === 'dlna' ? 'avtransport' : next?.kind === 'dial' ? 'dial' : next ? 'rest' : 'cast';
    store.set('cast.session', next ? { ...next } : null, { src: next?.kind === 'dlna' ? 'live' : 'derived', via });
    return { value: next ? { ...next } : null };
  }

  // --- DLNA session polling ------------------------------------------------

  function wantPoll() {
    return !stopped && polling && visible && session?.kind === 'dlna';
  }

  function schedulePoll() {
    if (!pollTimer && !pollInFlight && wantPoll()) pollTimer = setTimeout(pollOnce, POLL_MS);
  }

  function stopPollTimer() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function stoppedReason() {
    try {
      return (await avtransport.getStoppedReason('poll')).value;
    } catch {
      return null;
    }
  }

  async function pollOnce() {
    pollTimer = null;
    if (!wantPoll()) return;
    pollInFlight = true;
    const gen = generation;
    try {
      const [{ value: transport }, { value: pos }] = await Promise.all([
        avtransport.getTransportInfo('poll'),
        avtransport.getPositionInfo('poll'),
      ]);
      failedSince = null;
      if (gen !== generation) return;
      const state = transport.state ?? session.state;
      if (state === 'PLAYING' || state === 'PAUSED_PLAYBACK') sawPlaying = true;
      const next = { ...session, state, position: pos.position ?? session.position, duration: pos.duration ?? session.duration };
      // Images stay PLAYING at 0:00 for as long as they are shown, so only a STOPPED after PLAYING ends
      // a session; a cast that never reached PLAYING is given up after startTimeoutMs.
      if (!sawPlaying && Date.now() - startedAt >= startTimeoutMs) {
        polling = false;
        logger.warn('cast never started', { state, stoppedReason: await stoppedReason() });
        if (gen === generation) publish({ ...next, state: 'STOPPED', error: 'The TV did not start playing this' });
        return;
      }
      if (sawPlaying && IDLE_STATES.has(state)) polling = false;
      if (JSON.stringify(next) !== JSON.stringify(session)) publish(next);
    } catch (err) {
      logger.debug('poll failed', { code: err.code, error: err.message });
      failedSince ??= Date.now();
      if (Date.now() - failedSince >= POLL_FAILURE_STOP_MS) polling = false; // an unreachable TV ends polling too
    } finally {
      pollInFlight = false;
      schedulePoll();
    }
  }

  function startPolling() {
    polling = true;
    failedSince = null;
    schedulePoll();
  }

  // --- cast paths ----------------------------------------------------------

  // A new cast supersedes the old session: late polls of the old one are discarded.
  function supersede() {
    generation += 1;
    polling = false;
    stopPollTimer();
  }

  // The renderer takes a new URI more reliably from STOPPED; failures here are not the cast's problem.
  async function stopIfBusy() {
    try {
      const { value } = await avtransport.getTransportInfo();
      if (BUSY_STATES.has(value.state)) await avtransport.stopPlayback();
    } catch (err) {
      if (err.code === 'TV_OFF') throw err;
      logger.debug('pre-cast stop skipped', { code: err.code, error: err.message });
    }
  }

  async function playDlna({ uri, title, mime, shownUri, experimental = false }) {
    supersede();
    await stopIfBusy();
    await avtransport.setUri(uri, { title, mime });
    const { value: transport } = await retryTransient(() => avtransport.play(), PLAY_RETRY);
    startedAt = Date.now();
    sawPlaying = false;
    const result = publish({
      kind: 'dlna', title, uri: shownUri, state: transport.state ?? 'TRANSITIONING', position: 0, duration: null,
      ...(experimental && { experimental: true }),
    });
    startPolling();
    return result;
  }

  // Smart Hub's own tile launch (decompiled from CoBA's WebAppTileLauncher.LaunchNetflix): the Netflix
  // app is started with app-control extra data, which DIAL cannot send. Needs TV agent 0.4.0+. Smart Hub
  // also sends __K_SPLASH_SCREEN, __LEGACY_LAUNCH__ and __K_RELOCATE_BELOW; those are reserved for
  // platform apps and make launchAppControl fail with SecurityError for the agent, so they are left out.
  async function launchViaAgent(target) {
    const a = agent();
    if (target.kind !== 'netflix' || !target.id) return false;
    if (!a?.request || store.get('conn.agent')?.v !== 'online') {
      logger.info('TV agent offline; using DIAL', { agent: store.get('conn.agent')?.v ?? null });
      return false;
    }
    const forms = SMART_HUB_NETFLIX;
    const playUrl = forms[config.cast?.netflixSmartHub ?? 0](target.id);
    try {
      await a.request('launch', {
        appId: 'org.tizen.netflix-app',
        data: {
          '--root': 'app', '--app-js': 'netflix', callerid: 'com.samsung.tv.csfs', action_play_url: playUrl,
        },
      });
      return true;
    } catch (err) {
      logger.info('agent launch refused; using DIAL', { message: err?.message });
      return false;
    }
  }

  async function launchApp(target) {
    if (await launchViaAgent(target)) {
      supersede();
      return publish({ kind: 'dial', app: target.kind, title: APP_TITLES[target.kind], uri: target.url, state: 'PLAYING', position: null, duration: null, via: 'agent' });
    }
    const index = config.cast?.[`${target.kind}Payload`] ?? 0;
    const body = pickPayload(target.kind, target, index);
    await dial.launch(DIAL_APPS[target.kind], body);
    supersede();
    // DIAL 201 is the TV's confirmation; the app's own playback is not observable.
    return publish({ kind: 'dial', app: target.kind, title: APP_TITLES[target.kind], uri: target.url, state: 'PLAYING', position: null, duration: null });
  }

  // REST launch of the TV browser with the URL as the launch string (data.id). Both spellings of the
  // path are tried because msf-server's handling of the trailing slash is unverified on this firmware.
  async function openPage(url) {
    const tv = store.get('conn.tv')?.v;
    if (tv === 'standby' || tv === 'off') throw new LumenError('TV_OFF', 'The TV is off');
    const body = JSON.stringify({ id: url.href });
    let last = null;
    for (const target of [`${appsUrl}${BROWSER_APP}/`, `${appsUrl}${BROWSER_APP}`]) {
      let res, text;
      try {
        res = await fetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(BROWSER_TIMEOUT_MS),
        });
        text = await res.text();
      } catch (err) {
        last = { error: err };
        continue;
      }
      if (/-4009|App is running/i.test(text)) {
        throw new LumenError('FAILED', 'The Internet app is already open on the TV and ignores new links while it is in front: close it, then cast again');
      }
      if (res.ok) {
        supersede();
        return publish({ kind: 'browser', title: url.hostname, uri: url.href, state: 'PLAYING', position: null, duration: null });
      }
      last = { status: res.status };
      if (res.status !== 404) break;
    }
    if (last?.error) throw new LumenError('UNAVAILABLE', 'The TV did not answer the browser request');
    throw new LumenError('FAILED', `The TV browser refused the link (HTTP ${last.status})`);
  }

  // A web page opens in Lumen's own Browser view (spec §11.3); the TV browser stays behind Open on TV.
  // Without the browser feature (older wiring, tools) the page still goes to the TV.
  async function openInLumen(url) {
    const lumen = browser();
    if (typeof lumen?.open !== 'function') return openPage(url);
    await lumen.open(url.href);
    return { value: { kind: 'browser', url: url.href } };
  }

  // --- local files ---------------------------------------------------------

  // GET/HEAD /cast/<secret>/<fileId>/<name> from the TV's DLNA reader: HEAD must succeed with the full
  // headers, single ranges give 206/416, DLNA headers describe byte seek, transferMode is echoed.
  async function serveFile(req, res) {
    const reply = (status, headers) => res.writeHead(status, { ...headers, 'Content-Length': 0 }).end();
    if (stopped) return reply(503);
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, { Allow: 'GET, HEAD' });
    const pathname = new URL(req.url, 'http://lan').pathname;
    if (!routePrefix || !pathname.startsWith(routePrefix)) return reply(404);
    const [fileId, nameSegment = ''] = pathname.slice(routePrefix.length).split('/');
    if (!FILE_ID.test(fileId)) return reply(404);

    const filePath = path.join(castDir, fileId);
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return reply(404);
    }
    if (!stat.isFile()) return reply(404);

    const mime = uploads.get(fileId)?.mime ?? mimeFromName(cleanFileName(nameSegment)) ?? 'application/octet-stream';
    const size = stat.size;
    const requestedMode = String(req.headers['transfermode.dlna.org'] ?? '').trim();
    const headers = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'contentFeatures.dlna.org': dlnaFeatures(mime),
      'transferMode.dlna.org': /^(Streaming|Interactive|Background)$/i.test(requestedMode) ? requestedMode : isImage(mime) ? 'Interactive' : 'Streaming',
    };
    // Only byte seek is advertised (OP=01), so a time-seek request is not acceptable.
    if (req.headers['timeseekrange.dlna.org']) return reply(406, headers);
    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') return reply(416, { ...headers, 'Content-Range': `bytes */${size}` });
    const { start, end } = range ?? { start: 0, end: size - 1 };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD') return res.end();
    await pipeline(fs.createReadStream(filePath, { start, end }), res).catch((err) => {
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') logger.debug('file stream ended early', { error: err.message });
    });
  }

  async function cleanup({ startup = false } = {}) {
    let names;
    try {
      names = await fsp.readdir(castDir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const entry of names) {
      const fileId = entry.replace(/\.part$/, '');
      if (!FILE_ID.test(fileId)) continue;
      const filePath = path.join(castDir, entry);
      try {
        const { mtimeMs } = await fsp.stat(filePath);
        const leftoverPart = startup && entry.endsWith('.part');
        if (leftoverPart || now - mtimeMs > FILE_TTL_MS) {
          await fsp.rm(filePath, { force: true });
          if (!entry.endsWith('.part')) uploads.delete(fileId);
        }
      } catch (err) {
        logger.debug('cleanup skipped a file', { error: err.message });
      }
    }
  }

  function sendJson(res, status, body) {
    if (res.headersSent || res.destroyed) return;
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    if (status !== 201) headers.Connection = 'close';
    res.writeHead(status, headers).end(JSON.stringify(body));
  }

  const failure = (code, message) => ({ error: { code, message } });

  return {
    async start() {
      const secrets = (await data.readJson('secrets.json', {})) ?? {};
      let secret = secrets.castSecret;
      if (typeof secret !== 'string' || !/^[0-9a-f]{32,}$/i.test(secret)) {
        secret = randomBytes(32).toString('hex');
        logger.warn('castSecret missing from secrets.json; using a per-process secret');
      }
      routePrefix = `/cast/${secret}/`;
      lan.route(routePrefix, { request: serveFile });
      publish(null);
      await cleanup({ startup: true });
      cleanupTimer = setInterval(() => cleanup(), CLEANUP_EVERY_MS);
      cleanupTimer.unref();
    },

    async stop() {
      stopped = true;
      stopPollTimer();
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    },

    /** Whether a DLNA cast is still playing, asked of the TV: the session is polled only while a phone shows
     *  Lumen, so it can say PLAYING long after the video ended. One the TV no longer plays (or a TV that does not
     *  answer) is marked STOPPED. */
    async refreshDlna() {
      if (session?.kind !== 'dlna' || !BUSY_STATES.has(session.state)) return false;
      const gen = generation;
      let state = null;
      try {
        state = (await avtransport.getTransportInfo('poll')).value?.state ?? null;
      } catch (err) {
        logger.debug('cast check failed', { code: err.code, error: err.message });
      }
      if (BUSY_STATES.has(state)) return true;
      if (gen === generation && session?.kind === 'dlna') publish({ ...session, state: state ?? 'STOPPED' });
      return false;
    },

    setDemand({ visible: anyVisible } = {}) {
      visible = Boolean(anyVisible);
      if (visible) schedulePoll();
      else stopPollTimer();
    },

    classify,

    async castUrl(input) {
      const target = await classify(input);
      const url = new URL(target.url);
      logger.info('cast link', { kind: target.kind, host: url.hostname, ...(target.experimental && { experimental: true }) });
      // Everything but a page shown in Lumen's own browser plays on the TV, which must be on.
      const tv = store.get('conn.tv')?.v;
      const toLumen = target.kind === 'page' && typeof browser()?.open === 'function';
      if (!toLumen && (tv === 'standby' || tv === 'off')) throw new LumenError('TV_OFF', 'The TV is off');
      switch (target.kind) {
        case 'youtube':
        case 'netflix':
        case 'prime':
          return launchApp(target);
        case 'media':
          return playDlna({ uri: target.url, title: titleFromUrl(url), mime: target.mime, shownUri: target.url, experimental: target.experimental });
        default:
          return openInLumen(url);
      }
    },

    // Open on TV (spec §11.3): the TV browser launch for a page shown in Lumen's Browser view.
    openOnTv: (url) => openPage(parseCastUrl(url)),

    async castFile(fileId, name) {
      if (typeof fileId !== 'string' || !FILE_ID.test(fileId)) throw new LumenError('INVALID', 'Unknown file');
      try {
        await fsp.access(path.join(castDir, fileId));
      } catch {
        throw new LumenError('INVALID', 'That file is no longer on the server; upload it again');
      }
      const upload = uploads.get(fileId);
      const title = cleanFileName(name) ?? upload?.name ?? 'Lumen';
      const mime = upload?.mime ?? mimeFromName(title);
      if (!mime) throw new LumenError('INVALID', UNSUPPORTED_MESSAGE);
      const where = await lan.ready;
      if (!where || !routePrefix) {
        throw new LumenError('UNAVAILABLE', 'The TV-facing listener is not running, so the TV cannot fetch local files');
      }
      const host = where.address.includes(':') ? `[${where.address}]` : where.address;
      const uri = `http://${host}:${where.port}${routePrefix}${fileId}/${encodeURIComponent(title)}`;
      logger.info('cast file', { mime });
      return playDlna({ uri, title, mime, shownUri: null });
    },

    async control(action, position) {
      if (!session) throw new LumenError('INVALID', 'Nothing is casting');
      if (session.kind === 'dial' && action === 'stop') {
        // The TV advertises allowStop for its DIAL apps; DELETE on the run location closes the app.
        await dial.stopApp(DIAL_APPS[session.app]);
        return publish({ ...session, state: 'STOPPED' });
      }
      if (session.kind !== 'dlna') throw new LumenError('INVALID', `${session.title} is controlled with the TV remote`);
      // A poll already in flight read the renderer before this command, so its result is dropped.
      const gen = ++generation;
      let next;
      switch (action) {
        case 'play':
        case 'pause':
        case 'stop': {
          const call = { play: 'play', pause: 'pause', stop: 'stopPlayback' }[action];
          const { value: transport } = await avtransport[call]();
          next = { state: transport.state ?? session.state };
          break;
        }
        case 'seek': {
          const target = Number(position);
          if (!Number.isFinite(target) || target < 0) throw new LumenError('INVALID', 'Seek needs a position in seconds');
          // The TV answers 711 for a target at the exact end, so stay a second short of it.
          const clamped = session.duration ? Math.min(target, Math.max(0, session.duration - 1)) : target;
          const { value: pos } = await retryTransient(() => avtransport.seek(clamped), SEEK_RETRY);
          next = { position: pos.position ?? clamped, duration: pos.duration ?? session.duration };
          break;
        }
        default:
          throw new LumenError('INVALID', `Unknown cast action "${action}"`);
      }
      if (gen !== generation) return { value: { ...session } };
      const current = { ...session, ...next };
      delete current.error; // a control on a session that never started gives it another chance
      const result = publish(current);
      startPolling();
      return result;
    },

    async acceptUpload(req, res) {
      const name = cleanFileName(req.headers['x-file-name']);
      if (!name) return sendJson(res, 400, failure('INVALID', 'Missing file name (X-File-Name header)'));
      if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) {
        return sendJson(res, 413, failure('INVALID', 'Files up to 4 GB can be cast'));
      }
      const mime = mimeFromName(name) ?? tvMime(req.headers['content-type']);
      if (!mime || mime === HLS_MIME) return sendJson(res, 415, failure('INVALID', UNSUPPORTED_MESSAGE));

      const fileId = randomBytes(16).toString('hex');
      const finalPath = path.join(castDir, fileId);
      const partPath = `${finalPath}.part`;
      let size = 0;
      const counter = new Transform({
        transform(chunk, _encoding, done) {
          size += chunk.length;
          done(size > MAX_UPLOAD_BYTES ? new Error('upload over the size cap') : null, chunk);
        },
      });
      try {
        await fsp.mkdir(castDir, { recursive: true });
        await pipeline(req, counter, fs.createWriteStream(partPath, { flags: 'wx' }));
        if (size === 0) {
          await fsp.rm(partPath, { force: true });
          return sendJson(res, 400, failure('INVALID', 'The file is empty'));
        }
        await fsp.rename(partPath, finalPath);
      } catch (err) {
        await fsp.rm(partPath, { force: true }).catch(() => {});
        if (size > MAX_UPLOAD_BYTES) return sendJson(res, 413, failure('INVALID', 'Files up to 4 GB can be cast'));
        logger.warn('upload failed', { error: err.message, size });
        return sendJson(res, 500, failure('FAILED', 'The upload did not finish'));
      }
      uploads.set(fileId, { name, mime, size });
      logger.info('upload stored', { size, mime });
      return sendJson(res, 201, { fileId, name, size, mime });
    },
  };
}
