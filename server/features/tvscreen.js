// Lumen browser on the TV: the page is rendered by Lumen's own browser on this PC (behind the VPN
// when it is on) and shown full screen by the TV agent (companion/agent/screen.js). The TV remote
// drives it — arrows move a pointer, OK clicks, Back goes back, CH ▲▼ scroll, Red closes, Green
// reloads, Yellow hands the page's video to the TV's own player through the relay (full quality,
// with sound). Phones keep controlling the same page in the Browser view, and its trackpad moves this
// same pointer (browser.pointer), so the TV's cursor follows the phone. YouTube is the exception:
// its web player streams separate audio and video over MSE (UMP POSTs to googlevideo.com), so there
// is no single stream to relay; its videos open in the TV's own YouTube app at the same position.
import { LumenError } from '../errors.js';
import { matchUrl } from './cast.js';
import * as relayLib from './relay.js';

const STEP = 0.014; // pointer step (fraction of the screen) for a single press
const STEP_MAX = 0.09;
const STREAK_MS = 260; // presses closer than this accelerate
const SCROLL_PX = 600;
const EDGE = 0.002;
// While the page is on the TV, a video the user starts on the page is handed to the TV's own player
// (full quality, sound, DRM through the TV's CDM): Lumen's mirrored page has no sound and few frames,
// and its headless browser cannot play DRM video at all.
const AUTO_POLL_MS = 1500;
const USER_START_MS = 10000; // a page video is handed to the TV only if someone acted this recently
const FRONT_EVERY_MS = 5000; // at most this often, the trackpad brings Lumen's page back in front of another app
const AUTO_MIN_AREA = 0.18; // fraction of the page: a watch page's player (Dailymotion's is ~23% beside its sidebar) counts; previews and thumbnails stay
const AUTO_MIN_AREA_YOUTUBE = 0.15; // a YouTube video page: Shorts' portrait player is about a third of a 16:9 page
const TV_VIDEO_ACTIVE = new Set(['loading', 'playing', 'paused', 'fallback']);
// The big videos playing on the page, each by a key that stays the same while it plays (its stream,
// or its place in the page): a video counts as started when its key was not playing at the last
// check, so a click on a player that already plays (full screen, volume, a seek) starts nothing.
// Never keyed by size or position: going full screen changes both.
const pageVideoScript = (minArea) => `(() => {
  const area = innerWidth * innerHeight;
  return [...document.querySelectorAll('video')].map((v, i) => [v, i]).filter(([v]) => !v.paused && !v.ended && v.clientWidth * v.clientHeight >= area * ${minArea}).map(([v, i]) => v.currentSrc || v.src || ('#' + i));
})()`;
// The same inside each frame (an embedded player such as Dailymotion's fills the page from an iframe).
const frameVideoScript = (minPx) => `[...document.querySelectorAll('video')].map((v, i) => [v, i]).filter(([v]) => !v.paused && !v.ended && v.clientWidth * v.clientHeight >= ${minPx}).map(([v, i]) => v.currentSrc || v.src || (location.pathname + '#' + i))`;
// YouTube's player is paused through its own API too: a bare <video>.pause() while it is still
// buffering the start is undone by the player a moment later. The videos that were playing are
// tagged with the hand-off's token first, so only they play again if the TV cannot play the video
// (the script runs in the page and in every frame; it only ever adds tags).
const pausePageScript = (token) => `(() => {
  const tag = ${JSON.stringify(token ? String(token) : '')};
  const all = [...document.querySelectorAll('video')];
  if (tag) all.forEach((v) => { try { if (!v.paused && !v.ended) v.setAttribute('data-lumen-handed', tag); } catch (e) {} });
  document.querySelectorAll('.html5-video-player').forEach((p) => { try { if (p.pauseVideo) p.pauseVideo(); } catch (e) {} });
  all.forEach((v) => { try { v.pause(); } catch (e) {} });
})()`;
// The hand-off's own videos play again (the TV could not play them), in the page and in its frames.
const resumePageScript = (token) => `(() => {
  const tag = ${JSON.stringify(String(token))};
  let n = 0;
  document.querySelectorAll('video[data-lumen-handed]').forEach((el) => {
    if (el.getAttribute('data-lumen-handed') !== tag || !el.paused) return;
    n += 1;
    try { const p = el.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  });
  return n;
})()`;
const YOUTUBE_REPEAT_MS = 15000; // the same video started again this soon after a hand-off is only paused
const YOUTUBE_MIN_EMBED_AREA = 40000; // CSS px²: a YouTube embed smaller than ~200×200 is not "the page's video"
const YOUTUBE_APP_IDS = new Set(['111299001912', '9Ur5IzDKqV.TizenYouTube']);
const AUTO_RETRY_MS = 60000; // a page whose video could not be handed over is not tried again by itself this soon
const MANUAL_GRACE_MS = 5000; // the automatic hand-off leaves the page alone this long around a manual one
const PROBE_MS = 6000; // the HLS probe's budget: a slow or failing playlist plays in AVPlay
const AD_HOLD_MS = 120000; // after an ad was seen on a page, its content may start without a new click this long
const ENDED_REPEAT_MS = 10 * 60 * 1000; // the stream that just ended on the TV is not handed over again by itself
const AD_SHORT_S = 60; // a plain-URL clip shorter than this in front of the page's player is an ad (automatic hand-off)
// A link the site refuses for good (a one-time link the page's player already used): the TV would
// only get the same answer.
const GONE_STATUSES = new Set([401, 403, 404, 410]);
// The TV agent going away while the browser is on the TV: it is opened again once per drop, at most
// twice in ten minutes (the TV closes pages for memory; the owner may also have switched it off).
const RELAUNCH_DELAY_MS = 1500;
const RELAUNCH_MAX = 2;
const RELAUNCH_WINDOW_MS = 10 * 60 * 1000;
const STRAY_OFF_EVERY_MS = 3000;
// Ad servers and ad SDKs whose clips are never "the page's video". googlevideo.com (YouTube's own
// media) is never blocked by host: its ads and its videos come from the same hosts.
const AD_MEDIA_HOSTS = /(^|\.)(2mdn\.net|doubleclick\.net|googlesyndication\.com|imasdk\.googleapis\.com|adnxs\.com|springserve\.com|spotxchange\.com|spotx\.tv|innovid\.com|serving-sys\.com|flashtalking\.com|teads\.tv)$/i;
// Two hosts are the same site when their last two labels match (the relay's own rule for cookies).
const hostOf = (raw) => { try { return new URL(raw).hostname; } catch { return null; } };
const siteOf = (raw) => { try { return new URL(raw).hostname.toLowerCase().split('.').slice(-2).join('.'); } catch { return ''; } };
export function isAdUrl(raw) {
  const host = hostOf(raw);
  return Boolean((host && AD_MEDIA_HOSTS.test(host)) || /dclk_video_ads/i.test(String(raw ?? '')));
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// Messages that reach a phone or the TV never carry a stream address (ffmpeg errors can).
const noUrls = (text) => String(text ?? '').replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, 'the stream');
const keyOfUrl = (raw) => { try { const u = new URL(raw); return u.origin + u.pathname; } catch { return String(raw ?? ''); } };
const linkOf = (entry, base) => {
  const raw = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? (entry.url ?? entry.uri ?? null) : null;
  if (typeof raw !== 'string' || !raw) return null;
  try { return new URL(raw, base).href; } catch { return null; }
};

/** The YouTube video a link points at → { id, t? } (t in whole seconds), or null. Covers watch?v=,
 *  youtu.be/, /shorts/, /embed/ (start=), /live/, m. and music. hosts, youtube-nocookie.com. */
export function youtubeVideo(raw) {
  let url;
  try { url = new URL(String(raw ?? '')); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const match = matchUrl(url);
  if (match?.kind !== 'youtube') return null;
  const start = Number.parseInt(url.searchParams.get('start') ?? '', 10);
  const t = match.t ?? (start > 0 ? start : undefined);
  return { id: match.id, ...(t && { t: Math.floor(t) }) };
}

/** Page script: where YouTube's own player is in video `id` → { found, t, ad, live }. During an ad the
 *  <video> element plays the ad, so the player API's getCurrentTime() (the video's own position) wins. */
export function youtubeStateScript(id) {
  return `(() => {
  const want = ${JSON.stringify(String(id))};
  const data = (p) => { try { return (p.getVideoData && p.getVideoData()) || null; } catch (e) { return null; } };
  const p = [...document.querySelectorAll('.html5-video-player')].find((x) => (data(x) || {}).video_id === want);
  if (!p) return { found: false, t: null, ad: false, live: false };
  const ad = p.classList.contains('ad-showing');
  let t = null;
  try { if (p.getCurrentTime) t = p.getCurrentTime(); } catch (e) {}
  if (!(typeof t === 'number' && isFinite(t)) && !ad) { const v = p.querySelector('video'); t = v ? v.currentTime : null; }
  return { found: true, t: typeof t === 'number' && isFinite(t) ? t : null, ad, live: !!(data(p) || {}).isLive };
})()`;
}

/** What the streams a page loaded are to each other (browser.media() entries: role 'master' |
 *  'media' | 'subtitles', audioOnly, a master's variants[] and renditions[]): the renditions (audio,
 *  subtitles) never stand for the video, a variant has its master, and a variant's bandwidth. */
function mediaIndex(media) {
  const renditions = new Set();
  const masters = new Map(); // variant url / origin+path → its master entry
  const bandwidth = new Map();
  for (const m of media) {
    if (m?.kind !== 'hls' || m.role !== 'master') continue;
    for (const r of Array.isArray(m.renditions) ? m.renditions : []) {
      const u = linkOf(r, m.url);
      if (u) { renditions.add(u); renditions.add(keyOfUrl(u)); }
    }
    for (const v of Array.isArray(m.variants) ? m.variants : []) {
      const u = linkOf(v, m.url);
      if (!u) continue;
      const bw = Number(v?.bandwidth);
      for (const k of [u, keyOfUrl(u)]) {
        if (!masters.has(k)) masters.set(k, m);
        if (bw > 0 && !bandwidth.has(k)) bandwidth.set(k, bw);
      }
    }
  }
  const has = (map, m) => map.has(m.url) || map.has(keyOfUrl(m.url));
  return {
    excluded: (m) => m.role === 'subtitles' || m.audioOnly === true || has(renditions, m),
    masterOf: (m) => masters.get(m.url) ?? masters.get(keyOfUrl(m.url)) ?? null,
    bandwidthOf: (m) => bandwidth.get(m.url) ?? bandwidth.get(keyOfUrl(m.url)) ?? 0,
  };
}
// Entries the page's player is using now (after an SPA move or a bfcache return) come first.
const preferCurrent = (list) => [...list.filter((m) => m.current === true), ...list.filter((m) => m.current !== true)];

export function createTvScreen({ config, log: rootLog, store, agent, rest, browser, relay, transcoder = () => null, cast = () => null, liveVideo = () => null }) {
  const log = rootLog.child('tvscreen');
  const appId = config.agent?.appId;
  const opts = config.tvscreen ?? {};
  const AGENT_GONE_CLOSE_MS = opts.agentGoneCloseMs ?? 90000; // longer than ensureAgent's 20 s wait
  const RELAUNCH_WAIT_MS = opts.relaunchWaitMs ?? 25000;
  const JOB_GRACE_MS = opts.jobGraceMs ?? 60000;
  const LOADING_WATCH_MS = opts.loadingWatchMs ?? 60000; // a player that never reports again is gone
  const STUCK_MS = opts.stuckMs ?? 45000; // heartbeats with a clock at 0 this long: the player failed
  const LIVE_START_MS = config.liveVideo?.startMs ?? 10000;
  let on = false;
  let removeSink = null;
  let unsubscribeScreen = null;
  let subscribedTo = null;
  let cursor = { x: 0.5, y: 0.45 };
  let streak = 0;
  let lastKeyAt = 0;
  let queue = Promise.resolve();
  // { pick, title, stage: 'direct' | 'copy' | 'encode' | 'drm', job, page, explicit, token, variants,
  //   converting, retried }
  let current = null;
  let handCount = 0;
  let playSeq = 0; // every screen-play; agents 0.8.7+ echo it in their reports
  let autoTimer = null;
  let bringingFront = 0;
  let lastRemoteInput = 0; // OK / clicks from the TV remote or the trackpad
  let lastYoutube = null; // { id, at } of the last video opened in the TV's YouTube app
  let generation = 0; // bumped by close(): an automatic hand-off started before it never reopens the screen
  // Every hand-off (automatic, Yellow, Video → TV, the AI tool) runs one at a time, so a video is
  // never handed over twice at once (two relay sessions, two screen-plays, two YouTube launches).
  let handOffChain = Promise.resolve();
  let handOffBusy = 0;
  let autoRun = null; // the automatic hand-off in flight → its result, or null
  let lastManualAt = 0;
  let autoFailed = null; // { url, at }: the page whose video could not be handed over
  let prevKeys = null; // the big videos playing at the last automatic check (null: none checked yet)
  let adHold = null; // { url, until }: an ad was playing on this page; its content may follow without a click
  let endedOnTv = null; // { page, url, at }: the stream that last played to its end on the TV
  let heldFrame = null; // the page's latest frame, held back while the TV's player is in front
  let removeStoreListener = null;
  // Live video (features/livevideo.js): the TV agent (0.8+) plays the page as a video stream with its
  // sound; the JPEG frames go to the TV until it takes the stream (from its 'ready'), while it is
  // paused, or when it fails.
  let live = null; // { handle, playing, paused, startTimer }
  let liveWanted = config.liveVideo?.enabled === true;
  let lastJpeg = null;
  // The TV agent's side: whether it was told to show the screen on this connection, whether it is
  // in the background, and the drop being handled (relaunch or close).
  let screenSent = false;
  let agentHidden = false;
  let agentWasOnline = false;
  let opening = 0;
  let synced = false; // the reconnect was settled by the agent's hello (screen-sync)
  let lostAt = 0;
  let relaunchPending = false;
  let relaunchFired = false;
  let relaunchTimes = [];
  let lossTimer = null;
  let deadlineTimer = null;
  let lastStrayOffAt = 0;
  let jobGraceTimer = null;
  let videoWatchTimer = null;
  let lastVideoReportAt = 0;
  let lastBeat = null; // { position } of the last heartbeat
  let stuckSince = null;
  let lastSession = null;

  const meta = { src: 'derived', via: 'tvscreen' };
  const setState = (value) => store.set('tvscreen.on', value, meta);
  const setVideo = (value) => store.set('tvscreen.video', value, meta);
  const setHandoff = (stage, converting = false) => store.set('tvscreen.handoff', stage ? { stage, converting } : null, meta);
  const setLiveBlocked = (value) => { if (value || store.get('tvscreen.liveBlocked')?.v) store.set('tvscreen.liveBlocked', value, meta); };
  const videoActive = () => TV_VIDEO_ACTIVE.has(store.get('tvscreen.video')?.v);
  const agentOnline = () => store.get('conn.agent')?.v === 'online';
  const pageUrlNow = () => store.get('browser.url')?.v ?? '';
  const cancelled = () => Object.assign(new LumenError('FAILED', 'The browser screen was closed'), { cancelled: true });
  const adWait = () => Object.assign(new LumenError('FAILED', 'An ad is playing on the page: its video goes to the TV once it starts'), { adWait: true });
  // An automatic hand-off stops quietly once the screen was closed (or closed and opened again).
  const checkLive = (ctx) => { if (ctx?.auto && (ctx.gen !== generation || !on)) throw cancelled(); };
  // The page's own video is paused once the TV plays it: it would download the same stream a second
  // time (through the VPN) and keep sending frames the TV does not show. Its embedded players too.
  const pausePage = async (token) => {
    const feature = browser();
    const script = pausePageScript(token);
    await feature?.evaluate?.(script).catch(() => {});
    await feature?.evaluateFrames?.(script).catch(() => {});
  };
  // Only the videos this hand-off paused play again; with no hand-off, nothing does.
  const resumePage = async (token) => {
    if (!token) return;
    const feature = browser();
    const script = resumePageScript(token);
    await feature?.evaluate?.(script).catch(() => {});
    await feature?.evaluateFrames?.(script).catch(() => {});
  };

  function serialHandOff(fn) {
    handOffBusy += 1;
    const run = handOffChain.then(fn).finally(() => { handOffBusy -= 1; });
    handOffChain = run.catch(() => {});
    return run;
  }
  const b = () => {
    const feature = browser();
    if (!feature) throw new LumenError('UNAVAILABLE', 'Lumen’s browser is not available');
    return feature;
  };
  const a = () => {
    const adapter = agent();
    if (!adapter?.sendFrame || !agentOnline()) {
      throw new LumenError('UNAVAILABLE', 'The TV agent is not connected (Settings → TV agent)');
    }
    return adapter;
  };

  // Pointer position in frame pixels, which is what browser.input() takes.
  function at() {
    const size = b().frameSize();
    return { x: Math.round(cursor.x * size.w), y: Math.round(cursor.y * size.h) };
  }

  // Lumen's own pointer on the TV; hidden while the TV's pointer (Mouse view, Browser pad) is in use.
  let drawn = false;
  function sendCursor() {
    drawn = true;
    agent()?.sendScreen?.({ t: 'screen-cursor', x: cursor.x, y: cursor.y, visible: true });
  }
  function hideCursor() {
    if (!drawn) return;
    drawn = false;
    agent()?.sendScreen?.({ t: 'screen-cursor', x: cursor.x, y: cursor.y, visible: false });
  }

  /** A message on the TV, and for the phones (tvscreen.notice): the TV may be gone or behind another
   *  app when a failure comes. 'warn' for failures, 'info' for progress. */
  function toast(text, level = 'info') {
    const clean = noUrls(text).slice(0, 200);
    agent()?.sendScreen?.({ t: 'screen-toast', text: clean });
    store.set('tvscreen.notice', { text: clean, level: level === 'warn' ? 'warn' : 'info', at: Date.now() }, meta);
  }

  // Remote keys and pointer events are handled one at a time, in order.
  function enqueue(fn) {
    queue = queue.then(fn).catch((err) => log.debug('screen input failed', { message: err.message }));
    return queue;
  }

  async function move(dx, dy) {
    const nx = Math.min(1 - EDGE, Math.max(EDGE, cursor.x + dx));
    const ny = Math.min(1 - EDGE, Math.max(EDGE, cursor.y + dy));
    // Pushing past the top or bottom edge scrolls the page instead.
    if (dy && ny === cursor.y) await b().input({ kind: 'wheel', ...at(), deltaY: dy > 0 ? SCROLL_PX / 2 : -SCROLL_PX / 2 });
    cursor = { x: nx, y: ny };
    sendCursor();
    await b().input({ kind: 'move', ...at() });
  }

  // The browser is starting again (it stopped, or a crash): keys that need the page say so instead
  // of failing quietly.
  const browserReopening = () => {
    const state = store.get('browser.session')?.v;
    return state === 'starting' || state === 'error';
  };

  async function onKey(key) {
    if (!on) return undefined;
    const now = Date.now();
    if (key === 'enter' || key === 'yellow') lastRemoteInput = now;
    streak = now - lastKeyAt < STREAK_MS ? streak + 1 : 0;
    lastKeyAt = now;
    const step = Math.min(STEP * (1 + streak * 0.45), STEP_MAX);
    if ((key === 'enter' || key === 'green' || key === 'back') && browserReopening()) {
      toast('The browser is reopening');
      return undefined;
    }
    switch (key) {
      case 'left': return move(-step, 0);
      case 'right': return move(step, 0);
      case 'up': return move(0, -step * 16 / 9);
      case 'down': return move(0, step * 16 / 9);
      case 'enter': return b().input({ kind: 'click', ...at() });
      case 'back': return b().nav('back');
      case 'chup': return b().input({ kind: 'wheel', ...at(), deltaY: -SCROLL_PX });
      case 'chdown': return b().input({ kind: 'wheel', ...at(), deltaY: SCROLL_PX });
      case 'green': return b().nav('reload');
      case 'red': return close();
      // A hand-off can take a while (a probe, a conversion): the keys after it do not wait for it.
      case 'yellow': playVideo().catch((err) => toast(err.message, 'warn')); return undefined;
      case 'convert': playVideo({ convert: true }).catch((err) => toast(err.message, 'warn')); return undefined;
      case 'blue': return toast('Type with Lumen on your phone: Browser → Keyboard');
      default: return undefined;
    }
  }

  /** The pointer a phone's trackpad drives (hub browser.pointer): moves by dx/dy (fractions of the
   *  page) or to x/y, then clicks or scrolls where it is. It is the same pointer the TV remote moves,
   *  so the TV's cursor follows while the page is on the TV. → where it is now. */
  // Where the TV's own pointer is (the agent reports it), kept apart from the page pointer while the
  // phone's pad is in charge: then the phone's position counts and the TV pointer is only steered
  // towards it (the Browser view checks nativeAt and nudges it again if it is off).
  let nativeAt = null;
  let padUntil = 0;
  const PAD_AUTHORITY_MS = 2500;

  async function pointer({ dx = 0, dy = 0, x, y, action = 'move', button = 'left', deltaX = 0, deltaY = 0, native = false } = {}) {
    if (native) padUntil = Date.now() + PAD_AUTHORITY_MS;
    const next = {
      x: Math.min(1 - EDGE, Math.max(EDGE, x ?? cursor.x + dx)),
      y: Math.min(1 - EDGE, Math.max(EDGE, y ?? cursor.y + dy)),
    };
    const moved = next.x !== cursor.x || next.y !== cursor.y;
    if (action === 'click') lastRemoteInput = Date.now();
    // A sync with nothing to do (the Browser view asks where the pointer is) changes nothing on the TV.
    if (moved || action !== 'move') {
      if (on) bringToFront();
      const feature = b();
      cursor = next;
      if (on && moved && !native) sendCursor();
      if (action === 'click') await feature.input({ kind: 'click', ...at(), button });
      else if (action === 'wheel') await feature.input({ kind: 'wheel', ...at(), deltaX, deltaY });
      else await feature.input({ kind: 'move', ...at() });
    }
    return { value: { x: cursor.x, y: cursor.y, tv: on, native: nativeAt } };
  }

  // The TV's YouTube app Lumen handed a video to is in front of Lumen's page: using the trackpad
  // brings the page, and its pointer, back. Any other app the user opened stays in front.
  function bringToFront() {
    const fg = store.get('app.foreground')?.v;
    if (!fg?.id || fg.id === appId || !appId || !rest || !lastYoutube || Date.now() - bringingFront < FRONT_EVERY_MS) return;
    if (!YOUTUBE_APP_IDS.has(fg.id) && !/^youtube$/i.test(String(fg.name ?? ''))) return;
    bringingFront = Date.now();
    log.info('bringing Lumen’s page back in front', { from: fg.name ?? fg.id });
    rest.launch(appId).then(() => sendCursor()).catch((err) => log.debug('agent bring-to-front failed', { message: err.message }));
  }

  async function onPointer({ x, y }, click) {
    if (!on) return;
    nativeAt = { x: Math.min(1, Math.max(0, Number(x) || 0)), y: Math.min(1, Math.max(0, Number(y) || 0)) };
    // The phone's pad is in charge: its position counts, the TV pointer is only being steered there.
    if (Date.now() < padUntil) { hideCursor(); return; }
    if (click) lastRemoteInput = Date.now();
    cursor = { ...nativeAt };
    hideCursor(); // the TV draws its own pointer here
    await b().input({ kind: click ? 'click' : 'move', ...at() });
  }

  // Every screen message from the agent, whether the screen is on or not (after a restart of this
  // server the TV can still be showing the screen: its keys then turn it off).
  function onMessage(msg) {
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'screen-link') { screenSent = false; return; } // a new agent connection: not told yet
    if (msg.t === 'screen-sync') { onScreenSync(msg); return; }
    if (!on) {
      if (msg.t === 'screen-live' && (msg.state === 'hidden' || msg.state === 'visible')) agentHidden = msg.state === 'hidden';
      if (opening) return;
      const stray = msg.t === 'screen-input' || (msg.t === 'screen-video' && msg.state !== 'stopped' && msg.reason !== 'hidden');
      if (stray && Date.now() - lastStrayOffAt > STRAY_OFF_EVERY_MS) {
        lastStrayOffAt = Date.now();
        log.info('the TV still shows Lumen’s browser; turning it off there', { from: msg.t });
        agent()?.request?.('screen', { on: false }).catch(() => {});
      }
      return;
    }
    if (msg.t === 'screen-input') {
      // Red closes at once, even while earlier keys are still being handled.
      if (msg.key === 'red') { close().catch(() => {}); return; }
      if (typeof msg.key === 'string') enqueue(() => onKey(msg.key));
      else if (msg.pointer) enqueue(() => onPointer(msg.pointer, msg.click === true));
    } else if (msg.t === 'screen-live') {
      onLive(msg);
    } else if (msg.t === 'screen-video') {
      onVideo(msg);
    }
  }

  function onVideo(msg) {
    const state = typeof msg.state === 'string' ? msg.state.slice(0, 20) : null;
    // A report about a stream that has since been replaced (agents 0.8.7+ say which one).
    if (typeof msg.id === 'number' && msg.id !== playSeq) { log.debug('TV player report for an older stream', { state }); return; }
    // While Lumen converts the stream, the agent's trailing 'stopped' (or a repeated error) changes nothing.
    if (current?.converting && (state === 'stopped' || state === 'error')) return;
    lastVideoReportAt = Date.now();
    if (msg.reason === 'hidden') agentHidden = true;
    if (msg.heartbeat === true) { onHeartbeat(msg, state); return; }
    if (state === 'error') {
      log.warn('TV player error', { error: noUrls(msg.error ?? '').slice(0, 200), stage: current?.stage ?? null, played: msg.played === true });
      onVideoError(msg);
      // The conversion took over ('fallback'): the page and live video stay paused.
      if (current?.converting) return;
    }
    setVideo(state);
    syncLivePause();
    if (TV_VIDEO_ACTIVE.has(state)) {
      cancelJobGrace();
      if (state === 'loading') armVideoWatch();
    }
    // Back on the page: it shows the frame held back while the player was in front (a still page
    // sends no new one).
    if (!videoActive() && heldFrame) {
      const frame = heldFrame;
      heldFrame = null;
      agent()?.sendFrame?.(frame);
    }
    if (state !== 'paused' && state !== 'error') log.info('TV player', { state, mode: typeof msg.mode === 'string' ? msg.mode.slice(0, 10) : null, note: noUrls(msg.error ?? '').slice(0, 120) || null });
    if (state === 'ended' && current?.pick?.url) endedOnTv = { page: current.page, url: current.pick.url, at: Date.now() };
    if (state === 'stopped' || state === 'ended') releaseJob(false);
  }

  // Every 5 s while a video is in front (agents 0.8.7+): a clock that moves is a video that plays,
  // even when its 'playing' report was lost; a clock stuck at 0 for long is one that failed.
  function onHeartbeat(msg, state) {
    const position = num(msg.position);
    const now = store.get('tvscreen.video')?.v ?? null;
    const moved = position !== null && lastBeat?.position != null && position !== lastBeat.position;
    lastBeat = { position };
    if (now === 'loading') {
      if (state === 'playing' || moved) {
        log.info('TV player playing (its clock moves)');
        stuckSince = null;
        setVideo('playing');
        syncLivePause();
        cancelJobGrace();
        return;
      }
      if (!(position > 0)) {
        stuckSince ??= Date.now();
        if (Date.now() - stuckSince >= STUCK_MS) {
          stuckSince = null;
          log.warn('the TV player shows nothing: its clock has not moved', { ms: STUCK_MS });
          onVideo({ t: 'screen-video', state: 'error', error: `the TV player did not start within ${Math.round(STUCK_MS / 1000)} s`, mode: msg.mode });
        }
      } else stuckSince = null;
      armVideoWatch();
    } else if (!TV_VIDEO_ACTIVE.has(now) && TV_VIDEO_ACTIVE.has(state)) {
      // The agent is still playing a video Lumen took for gone: live video and the frames step aside again.
      setVideo(state);
      syncLivePause();
      cancelJobGrace();
    }
  }

  // A player that was told to play and has not said anything for a minute: nobody knows what the TV
  // shows, so the page's frames, live video and the automatic hand-off come back (no conversion is
  // started on an unknown clock).
  function armVideoWatch() {
    clearTimeout(videoWatchTimer);
    videoWatchTimer = setTimeout(() => {
      videoWatchTimer = null;
      if (!on || store.get('tvscreen.video')?.v !== 'loading') return;
      const quiet = Date.now() - lastVideoReportAt;
      if (quiet < LOADING_WATCH_MS) { armVideoWatch(); return; }
      log.warn('the TV player has not reported since it was asked to play; taking it for gone', { quietMs: quiet });
      setVideo(null);
      syncLivePause();
      if (heldFrame) { const frame = heldFrame; heldFrame = null; agent()?.sendFrame?.(frame); }
    }, LOADING_WATCH_MS);
    videoWatchTimer.unref?.();
  }

  // The TV's player could not play the stream: the next stage of the ladder (copy, then encode) runs
  // on its own, outside the key queue and the hand-off chain, so the remote keeps working and a newer
  // video simply replaces it. Nothing left to try: the hand-off's own page video plays again.
  function onVideoError(msg) {
    // A video Lumen knows nothing more about (it carried on after a reconnect): only said so (the
    // agent leaves the message to the PC, which may still have a conversion to try).
    if (!current) { toast('The TV could not play this video', 'warn'); return; }
    if (current.converting) return;
    const mine = current;
    const position = num(msg.position);
    fallback(String(msg.error ?? ''), mine, { played: msg.played === true, position }).then(async (played) => {
      if (played || current !== mine || !on) return;
      // Set before the page plays again: the automatic hand-off must not hand the same video over again.
      if (!mine.explicit) autoFailed = { url: mine.page ?? pageUrlNow(), at: Date.now() };
      await resumePage(mine.token);
      log.info('the TV could not play the video; it plays on the page again');
    }).catch((err) => log.debug('TV player fallback failed', { message: err.message }));
  }

  // Starts the TV agent when it is not running (installs, restarts) and waits for it to connect.
  async function ensureAgent() {
    if (agentOnline()) return;
    const adapter = agent();
    if (!adapter?.launch) throw new LumenError('UNAVAILABLE', 'The TV agent is not available');
    await adapter.launch().catch(() => {});
    const deadline = Date.now() + 20000;
    while (!agentOnline() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  }

  function ensureSubscribed() {
    const adapter = agent();
    if (!adapter?.onScreen || subscribedTo === adapter) return;
    unsubscribeScreen?.();
    unsubscribeScreen = adapter.onScreen(onMessage);
    subscribedTo = adapter;
  }

  /** Shows Lumen's browser on the TV, optionally opening `url` first. restore: Lumen reopens the page
   *  itself (a restart), which is not someone using the page. Safe to call again while on: it puts
   *  the agent back in screen mode and in front (after it reconnected or went to the background). */
  async function open({ url, restore = false } = {}) {
    opening += 1;
    try {
      ensureSubscribed();
      await ensureAgent();
      const adapter = a();
      const feature = b();
      if (url) await feature.open(url, { userInput: !restore });
      else {
        await feature.ensureRunning();
        if (!store.get('browser.url')?.v) await feature.nav('home', { userInput: !restore });
      }
      await adapter.request('screen', { on: true });
      screenSent = true;
      agentHidden = false;
      if (appId && rest) await rest.launch(appId).catch((err) => log.debug('agent bring-to-front failed', { message: err.message }));
      clearLoss();
      if (!on) {
        on = true;
        setVideo(null);
        heldFrame = null;
        prevKeys = null;
        // While the TV's player is in front the page's frames are not shown: the TV would only decode
        // them on the thread its player needs. The latest one is kept for the return to the page.
        removeSink = feature.addSink((bytes) => {
          lastJpeg = bytes;
          if (videoActive()) { heldFrame = bytes; return; }
          heldFrame = null;
          if (liveShowing()) return;
          agent()?.sendFrame?.(bytes);
        });
        setState(true);
        if (config.tvscreen?.autoPlayOnTv !== false) autoTimer = setInterval(() => { autoHandOff().catch(() => {}); }, AUTO_POLL_MS);
        // The site only: page addresses are browsing history (Clear history scrubs even this from the log).
        log.info('browser shown on the TV', { host: hostOf(store.get('browser.url')?.v) });
      }
      // Every open offers live video again: after the agent restarted or reconnected, its player is gone.
      offerLive();
      sendCursor();
      return { value: { on: true, url: store.get('browser.url')?.v ?? null } };
    } finally {
      opening -= 1;
    }
  }


  async function close() {
    clearLoss();
    if (!on) return { value: { on: false } };
    on = false;
    generation += 1;
    releaseJob(true);
    clearInterval(autoTimer);
    autoTimer = null;
    clearTimeout(videoWatchTimer);
    videoWatchTimer = null;
    removeSink?.();
    removeSink = null;
    heldFrame = null;
    prevKeys = null;
    adHold = null;
    stuckSince = null;
    stopLive(null);
    // The agent's own 'stopped' arrives after the screen is off (and is ignored then).
    setVideo(null);
    setState(false);
    setHandoff(null);
    screenSent = false;
    await agent()?.request?.('screen', { on: false }).catch(() => {});
    log.info('browser screen closed on the TV');
    return { value: { on: false } };
  }

  // ---------- the TV agent going away and coming back ----------

  function clearLoss() {
    clearTimeout(lossTimer);
    clearTimeout(deadlineTimer);
    lossTimer = deadlineTimer = null;
    lostAt = 0;
    relaunchPending = false;
    relaunchFired = false;
  }

  // Closing because the agent is gone: the page's video stops too (nobody watches it), and Edge can
  // idle once nothing takes its frames.
  async function closeLost(why) {
    if (!on) return;
    clearLoss();
    log.info('closing Lumen’s browser on the TV', { why });
    await pausePage();
    await close();
  }

  function onAgentLost() {
    synced = false;
    screenSent = false;
    if (live) {
      // A drop while live video played counts against it (its page starved or was killed); one while
      // the TV's own player was in front (live paused) or behind another app does not.
      if (!live.paused && !liveHidden) {
        strike();
        log.warn('the TV agent went away during live video', { strikes: liveStrikes });
      }
      stopLive(null);
    }
    releaseJob(false);
    if (!on) return;
    clearLoss();
    lostAt = Date.now();
    const relaunchOn = opts.relaunchAgent !== false && typeof agent()?.launch === 'function';
    relaunchTimes = relaunchTimes.filter((t) => lostAt - t < RELAUNCH_WINDOW_MS);
    const tvOn = store.get('conn.tv')?.v === 'on';
    if (agentHidden || !tvOn || (relaunchOn && relaunchTimes.length >= RELAUNCH_MAX)) {
      const why = agentHidden ? 'the agent closed behind another app' : !tvOn ? 'the TV is off' : 'the TV keeps closing the agent';
      log.info('the TV agent went away', { why });
      // Never re-entered from inside the store's patch listener.
      lossTimer = setTimeout(() => { lossTimer = null; closeLost(why).catch(() => {}); }, 0);
      return;
    }
    if (relaunchOn) {
      // The one exception to "companion launches are user actions only" (spec §9): the owner was
      // watching Lumen's browser on the TV when the TV closed it.
      relaunchPending = true;
      lossTimer = setTimeout(() => {
        lossTimer = null;
        if (!on || agentOnline()) return;
        relaunchTimes.push(Date.now());
        relaunchFired = true;
        log.info('the TV closed Lumen’s page; opening it again');
        agent().launch().catch((err) => {
          log.info('the TV agent could not be opened again', { message: err.message });
          closeLost('the agent could not be opened again').catch(() => {});
        });
        deadlineTimer = setTimeout(() => {
          deadlineTimer = null;
          if (on && !agentOnline()) closeLost('the agent did not come back').catch(() => {});
        }, RELAUNCH_WAIT_MS);
        deadlineTimer.unref?.();
      }, RELAUNCH_DELAY_MS);
      return;
    }
    log.info('the TV agent went away; waiting for it', { ms: AGENT_GONE_CLOSE_MS });
    lossTimer = setTimeout(() => { lossTimer = null; if (on && !agentOnline()) closeLost('the agent did not come back').catch(() => {}); }, AGENT_GONE_CLOSE_MS);
    lossTimer.unref?.();
  }

  // The agent is back and not showing the screen (a fresh page, or an agent before 0.8.7 that does
  // not say): screen mode, the front, live video, the pointer and the latest frame again.
  function reopenAfterReconnect(why) {
    screenSent = false;
    enqueue(async () => {
      if (!on) return;
      try {
        await open();
        if (!liveShowing() && !videoActive() && lastJpeg) agent()?.sendFrame?.(lastJpeg);
        toast(why === 'relaunched' ? 'Lumen is back after the TV closed it' : 'Lumen’s browser is back on the TV');
        log.info('browser shown on the TV again', { why });
      } catch (err) {
        log.info('Lumen’s browser could not be shown on the TV again', { message: err.message });
        await close();
      }
    });
  }

  function onAgentBack() {
    ensureSubscribed();
    const relaunched = relaunchFired;
    clearLoss();
    if (!on) return;
    // The agent's hello said what it shows, and that was handled already.
    if (synced) { synced = false; return; }
    reopenAfterReconnect(relaunched ? 'relaunched' : 'reconnected');
  }

  // The agent's hello (adapters/agent.js): what its screen shows (agents 0.8.7+; `known` false before).
  function onScreenSync(msg) {
    const known = msg.known === true;
    const active = msg.active === true;
    const video = msg.video && typeof msg.video === 'object' ? msg.video : null;
    if (!on) {
      // This server restarted (or closed the screen) while the TV kept showing it.
      if (known && active && !opening) {
        log.info('the TV still shows Lumen’s browser from before; turning it off there');
        agent()?.request?.('screen', { on: false }).catch(() => {});
      }
      return;
    }
    if (!known) {
      // A quick reconnect leaves no trace in conn.agent (the store's 50 ms batch): handled here, or
      // as an agent coming back when the drop was seen.
      if (agentWasOnline) reopenAfterReconnect('reconnected');
      return;
    }
    synced = true;
    const pending = relaunchPending || relaunchFired;
    const relaunched = relaunchFired;
    clearLoss();
    if (typeof msg.hidden === 'boolean') agentHidden = msg.hidden;
    if (active) {
      // A link blip: the agent kept the screen (and its player) up.
      screenSent = true;
      if (video) {
        const state = typeof video.state === 'string' ? video.state.slice(0, 20) : null;
        log.info('the TV agent reconnected; its player is still in front', { state });
        // Its reports name the stream it plays: they count from now on.
        if (typeof video.id === 'number' && Number.isInteger(video.id)) playSeq = video.id;
        lastVideoReportAt = Date.now();
        setVideo(TV_VIDEO_ACTIVE.has(state) ? state : null);
        syncLivePause();
        if (videoActive()) cancelJobGrace();
      } else {
        log.info('the TV agent reconnected with Lumen’s browser on screen');
        if (live) stopLive(null);
        else agent()?.sendScreen?.({ t: 'screen-live-stop' }); // a live player the PC no longer feeds
        offerLive();
        sendCursor();
        if (lastJpeg && !videoActive()) agent()?.sendFrame?.(lastJpeg);
      }
      return;
    }
    if (pending) { reopenAfterReconnect(relaunched ? 'relaunched' : 'reconnected'); return; }
    // Back without the screen and not relaunched by Lumen: the owner closed it on the TV.
    log.info('the TV agent came back without Lumen’s browser; closing it');
    close().catch(() => {});
  }

  // ---------- the automatic hand-off ----------

  // The keys of the big videos playing on the page or in its frames (sizes count against the page).
  async function playingKeys(feature, minArea) {
    const keys = new Set();
    const top = await feature.evaluate(pageVideoScript(minArea)).catch(() => null);
    if (Array.isArray(top)) for (const k of top.slice(0, 32)) keys.add(`p:${String(k).slice(0, 600)}`);
    if (!feature.evaluateFrames) return keys;
    const vp = await feature.evaluate('[innerWidth, innerHeight]').catch(() => null);
    if (!Array.isArray(vp) || !(vp[0] > 0) || !(vp[1] > 0)) return keys;
    const minPx = Math.round(minArea * vp[0] * vp[1]);
    const found = await feature.evaluateFrames(frameVideoScript(minPx)).catch(() => []);
    for (const list of Array.isArray(found) ? found : []) {
      if (Array.isArray(list)) for (const k of list.slice(0, 32)) keys.add(`f:${String(k).slice(0, 600)}`);
    }
    return keys;
  }

  // The user started a big video on the page: play it on the TV's player instead, and pause it on the
  // page (so it does not keep loading, and does not start again when the TV returns to the page).
  // "Started" means a big video that was not playing at the last check plays now, and someone acted
  // within the last few seconds: a click on a player that already plays (full screen, volume), a
  // video that starts by itself, and Lumen reopening the page itself start nothing.
  // A hand-off that failed leaves the page's video playing (the user can still watch it there), and
  // the same page is not tried again by itself for a while.
  async function autoHandOff() {
    // Busy: a slow page check or a hand-off in flight must not let the next tick start a second one.
    if (!on || handOffBusy || videoActive() || Date.now() - lastManualAt < MANUAL_GRACE_MS) return null;
    // Nothing goes to an agent that is gone, in the background, or not showing the screen yet.
    if (!agentOnline() || agentHidden || !screenSent) return null;
    const feature = browser();
    if (!feature) return null;
    const inputAt = Math.max(feature.lastInputAt?.() ?? 0, lastRemoteInput);
    const pageUrl = pageUrlNow();
    const ctx = { auto: true, gen: generation };
    const run = serialHandOff(async () => {
      if (ctx.gen !== generation || !on) return null;
      const yt = youtubeVideo(pageUrl);
      const keys = await playingKeys(feature, yt ? AUTO_MIN_AREA_YOUTUBE : AUTO_MIN_AREA);
      if (ctx.gen !== generation || !on) return null;
      const fresh = [...keys].filter((k) => !prevKeys || !prevKeys.has(k));
      prevKeys = keys;
      // The same YouTube video starting again on the page right after it went to the app: just pause it.
      if (yt && keys.size && lastYoutube?.id === yt.id && Date.now() - lastYoutube.at < YOUTUBE_REPEAT_MS) { await pausePage(); return null; }
      if (!fresh.length) return null;
      const held = adHold && adHold.url === pageUrl && Date.now() < adHold.until;
      // Only a video someone started (a click, a key, opening a link) goes to the TV: videos that start
      // by themselves (previews, autoplay) stay on the page instead of taking the TV over. After an
      // ad, the page's own video follows by itself.
      if (!held && Date.now() - inputAt > USER_START_MS) return null;
      // Checked again here: the page check can land after a failed hand-off resumed the page.
      if (autoFailed?.url === pageUrl && Date.now() - autoFailed.at < AUTO_RETRY_MS) return null;
      ctx.announce = yt ? 'Opening in YouTube on the TV…' : 'Playing on the TV’s player…';
      try {
        const result = await handOff({}, ctx);
        adHold = null;
        log.info('page video handed to the TV automatically');
        return result;
      } catch (err) {
        if (err.cancelled) return null;
        if (err.adWait) {
          // The ad plays on the page (live video shows it); its video follows once it starts.
          if (!(adHold && adHold.url === pageUrl)) toast('An ad is playing: the video goes to the TV once it starts');
          adHold = { url: pageUrl, until: Date.now() + AD_HOLD_MS };
          log.info('an ad is playing on the page; waiting for its video');
          return null;
        }
        autoFailed = { url: pageUrl, at: Date.now() };
        toast(err.message, 'warn');
        log.info('automatic hand-off failed', { message: err.message });
        return null;
      }
    });
    autoRun = run;
    try { return await run; } finally { if (autoRun === run) autoRun = null; }
  }

  // The page's own video first: a playing <video> with a real URL, then a YouTube embed (the biggest),
  // then the biggest <video>, then streams the page loaded from its own site, then any stream; ad
  // players are what usually loads from other sites. Ads (an IMA/VAST pre-roll in the player, an ad
  // server's clip) are never the page's video: while one plays in front, the video waits for it.
  const PAGE_MEDIA_SCRIPT = `({
    videos: [...document.querySelectorAll('video')].map((v) => {
      const r = v.getBoundingClientRect();
      return {
        src: v.currentSrc || v.src || '', area: v.clientWidth * v.clientHeight, playing: !v.paused,
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        duration: isFinite(v.duration) && v.duration > 0 ? v.duration : null, loop: !!v.loop,
        ad: v.title === 'Advertisement' || !!v.closest('.ima-ad-container,.vjs-ad-playing,.vjs-ad-loading,.jw-flag-ads,.ad-showing') || !!(v.parentElement && v.parentElement.querySelector('iframe[src*="imasdk.googleapis.com"]')),
      };
    }),
    frames: [...document.querySelectorAll('iframe')].map((f) => ({ src: f.src || '', area: f.clientWidth * f.clientHeight })),
    view: innerWidth * innerHeight, vw: innerWidth, vh: innerHeight,
  })`;
  const kindOfUrl = (url) => (/\.m3u8/i.test(url) ? 'hls' : /\.mpd/i.test(url) ? 'dash' : 'file');
  async function pickMedia(explicit, { auto = false } = {}) {
    const feature = b();
    const media = feature.media?.() ?? [];
    const pageUrl = pageUrlNow();
    const headersFor = (url) => media.find((m) => m.url === url)?.headers ?? { referer: pageUrl };
    if (explicit) return { url: explicit, kind: kindOfUrl(explicit), headers: headersFor(explicit) };
    const found = await feature.evaluate(PAGE_MEDIA_SCRIPT).catch(() => null);
    const all = found?.videos ?? [];
    // An MSE player (a blob: video) bigger than a plain-URL video is the page's video: the smaller
    // one is an ad or a preview, and the player's stream is among those the page loaded.
    // A plain-URL video smaller than a watch page's player (an ad box, a preview) is never the page's
    // video either, even while the real player is still loading.
    const mse = Math.max(0, ...all.filter((v) => /^blob:/.test(v.src)).map((v) => v.area));
    const minArea = Math.max(mse, AUTO_MIN_AREA * (found?.view || 0));
    const plain = (v) => /^https?:/.test(v.src);
    const box = (v) => (v.rect && v.rect.w > 0 && v.rect.h > 0 ? v.rect : null);
    // The share of v's box that o's box covers (0 when either is unknown).
    const covers = (o, v) => {
      const p = box(v), q = box(o);
      if (!p || !q) return 0;
      const w = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
      const h = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
      return w > 0 && h > 0 ? (w * h) / (p.w * p.h) : 0;
    };
    const vw = found?.vw, vh = found?.vh;
    const onScreen = (o) => { const q = box(o); return !q || !(vw > 0 && vh > 0) || (q.x < vw && q.y < vh && q.x + q.w > 0 && q.y + q.h > 0); };
    // The player a short clip plays in front of (a pre-roll its player does not mark): a video at
    // least about its size that is the page's MSE player (blob:, on screen) or lies under the clip.
    // Clips side by side in a feed or a news page are none of these.
    const playerBehind = (v, o) => o !== v && o.area > 0 && o.area >= 0.9 * v.area
      && ((/^blob:/.test(o.src) && onScreen(o)) || covers(o, v) >= 0.5);
    // Ad-like: marked as an ad by its player, from an ad server, a looping preview that is not
    // playing, or (for the automatic hand-off only: an explicit request is not second-guessed by
    // sizes) a short plain clip in front of the page's player.
    const adLike = (v) => v.ad === true || isAdUrl(v.src)
      || (auto && plain(v) && typeof v.duration === 'number' && v.duration < AD_SHORT_S && all.some((o) => playerBehind(v, o)))
      || (v.loop === true && !v.playing);
    if (all.some((v) => v.playing && adLike(v) && v.area > 0 && v.area >= minArea)) return { kind: 'ad' };
    const videos = all.filter((v) => plain(v) && !adLike(v) && v.area >= minArea).sort((x, y) => (y.playing - x.playing) || (y.area - x.area));
    const asFile = (v) => ({ url: v.src, kind: kindOfUrl(v.src), headers: headersFor(v.src) });
    if (videos[0]?.playing) return asFile(videos[0]);
    // A YouTube embed is the page's video only while none of the page's own players plays (an MSE
    // player's blob: video included): the site's video is not swapped for an unrelated embed.
    const embed = all.some((v) => v.playing) ? null : (found?.frames ?? []).filter((f) => f.area >= YOUTUBE_MIN_EMBED_AREA)
      .map((f) => ({ area: f.area, video: youtubeVideo(f.src) })).filter((f) => f.video).sort((x, y) => y.area - x.area)[0];
    if (embed) return { kind: 'youtube', video: embed.video };
    if (videos[0]) return asFile(videos[0]);
    return rankMedia(media, pageUrl);
  }

  // The streams the page loaded, best first: an HLS master (the TV picks the quality) over one fixed
  // variant, never an audio or subtitle rendition (sound over black) unless nothing else exists.
  function rankMedia(media, pageUrl) {
    const usable = media.filter((m) => m?.url && !isAdUrl(m.url));
    const idx = mediaIndex(usable);
    const first = (list, kind) => preferCurrent(list.filter((m) => m.kind === kind))[0] ?? null;
    const hlsStep = (list) => {
      const hls = preferCurrent(list.filter((m) => m.kind === 'hls'));
      if (!hls.length) return null;
      const masters = hls.filter((m) => m.role === 'master');
      const others = hls.filter((m) => m.role !== 'master');
      if (masters.length) {
        // The master whose variants list the newest video playlist is the one the player uses.
        const newest = others.find((m) => !idx.excluded(m));
        return (newest && masters.find((m) => idx.masterOf(newest) === m)) ?? masters[0];
      }
      // A variant of a master the page loaded (from any site): the master plays instead.
      const master = others[0] ? idx.masterOf(others[0]) : null;
      return master ?? others[0] ?? null;
    };
    const rankOwn = (list) => hlsStep(list) ?? first(list, 'file') ?? first(list, 'dash');
    const rankOther = (list) => hlsStep(list) ?? first(list, 'dash') ?? first(list, 'file');
    const own = (list) => list.filter((m) => siteOf(m.url) === siteOf(pageUrl));
    const video = usable.filter((m) => !idx.excluded(m));
    return rankOwn(own(video)) ?? rankOther(video) ?? rankOwn(own(usable)) ?? rankOther(usable) ?? null;
  }

  // Other streams that can stand in for a playlist the site refused: only from the pick's or the
  // page's own site (never an ad's or a preview's), masters first, then video variants, best first.
  function alternatives(pick, pageUrl) {
    const media = (browser()?.media?.() ?? []).filter((m) => m?.url && !isAdUrl(m.url));
    const idx = mediaIndex(media);
    const sites = new Set([siteOf(pick.url), siteOf(pageUrl)]);
    const list = media.filter((m) => m.kind === 'hls' && m.url !== pick.url && sites.has(siteOf(m.url)) && !idx.excluded(m));
    const masters = list.filter((m) => m.role === 'master');
    const rest = list.filter((m) => m.role !== 'master').map((m, i) => [m, i])
      .sort(([x, i], [y, j]) => (idx.bandwidthOf(y) - idx.bandwidthOf(x)) || (i - j)).map(([m]) => m);
    return [...masters, ...rest].slice(0, 4);
  }

  // A YouTube video plays in the TV's own YouTube app (DIAL, as Cast does), at the position the page's
  // player is at; the page's video is paused so it does not keep playing behind the app.
  async function playOnYoutube(video, { fromPage = false, onPage = false } = {}, ctx = {}) {
    const launcher = cast();
    if (!launcher?.castUrl) throw new LumenError('UNAVAILABLE', 'Lumen cannot start YouTube on the TV right now');
    const feature = browser();
    let t = video.t;
    if (fromPage && feature?.evaluate) {
      const player = await feature.evaluate(youtubeStateScript(video.id)).catch(() => null);
      if (player?.found) t = player.live ? undefined : player.t >= 1 ? Math.floor(player.t) : video.t;
    }
    const watch = `https://www.youtube.com/watch?v=${video.id}${t >= 1 ? `&t=${t}` : ''}`;
    checkLive(ctx);
    await launcher.castUrl(watch);
    lastYoutube = { id: video.id, at: Date.now() };
    setHandoff('youtube');
    await pausePage();
    // The page's title names the video only when the page is that video's own page.
    const title = onPage ? String(store.get('browser.title')?.v ?? '').replace(/ - YouTube$/, '') || null : null;
    log.info('YouTube video opened in the TV’s YouTube app', { at: t >= 1 ? t : 0 });
    return { value: { kind: 'youtube', app: 'youtube', videoId: video.id, t: t >= 1 ? t : 0, title } };
  }

  /** Plays the page's video (or `url`) on the TV's own player, through the relay; convert: true
   *  skips the direct attempt and converts on this PC straight away (the video already on the TV,
   *  when one is). A YouTube page (or link, or a YouTube embed on the page) opens in the TV's
   *  YouTube app instead. */
  async function playVideo({ url: explicit, convert = false } = {}) {
    lastManualAt = Date.now();
    const joined = autoRun;
    const pageUrl = pageUrlNow();
    try {
      return await serialHandOff(async () => {
        // "Convert" for a video being converted, or one whose full conversion is on the TV: nothing
        // further to try, and the ffmpeg job feeding the TV (or starting) is left alone.
        if (convert && explicit === undefined && on && current?.pick && current.stage !== 'drm'
          && (current.converting || (current.stage === 'encode' && videoActive()))) {
          throw new LumenError('FAILED', current.converting ? 'The video is being prepared for the TV already' : 'This video is already converted for the TV');
        }
        // "Convert" for the video on the TV (a black picture, a refusal): that video, not a new pick
        // from the page (which may have an ad or a dead link by now).
        if (convert && explicit === undefined && on && current?.pick && !current.converting
          && current.stage !== 'drm' && (videoActive() || current.stage === 'direct')) {
          const mine = current;
          const before = store.get('tvscreen.video')?.v ?? null;
          // direct → copy; a copy that shows wrongly → the full conversion.
          if (mine.stage !== 'copy' && mine.stage !== 'encode') mine.stage = 'direct';
          if (!(await fallback('conversion requested', mine))) {
            // The TV's player still has the video it had: live video and the frames stay aside.
            if (current === mine && on && TV_VIDEO_ACTIVE.has(before)) { setVideo(before); syncLivePause(); }
            throw new LumenError('FAILED', 'The video could not be prepared for the TV');
          }
          return { value: { kind: mine.pick.kind, title: mine.title, converted: true } };
        }
        // Yellow (or Video → TV) while the automatic hand-off was handing the page's video over: that one counts.
        if (joined && explicit === undefined && !convert) {
          const done = await joined;
          if (done) return done;
        }
        try {
          return await handOff({ url: explicit, convert });
        } catch (err) {
          if (err.adWait) adHold = { url: pageUrl, until: Date.now() + AD_HOLD_MS };
          else if (explicit === undefined) autoFailed = { url: pageUrl, at: Date.now() };
          throw err;
        }
      });
    } finally {
      lastManualAt = Date.now();
    }
  }

  // The player is in front on the TV as soon as it gets the stream (the agent reports 'playing' later).
  function sendPlay(adapter, msg) {
    // Live video stops before the TV's player starts (the TV has one decoder for both); waiting for
    // the player's first report let a new stream header through, and the two players then fought.
    playSeq += 1;
    lastVideoReportAt = Date.now();
    lastBeat = null;
    stuckSince = null;
    setVideo('loading');
    syncLivePause();
    adapter.sendScreen({ ...msg, id: playSeq });
    armVideoWatch();
  }

  // A new hand-off: the video it plays and what is needed to stop it or play the page's video again.
  function newCurrent(pick, { stage, explicit = false, variants = null } = {}) {
    return {
      pick, title: store.get('browser.title')?.v ?? '', stage, job: null, page: pageUrlNow(),
      explicit, token: String(++handCount), variants, converting: false, retried: false,
    };
  }

  async function handOff({ url: explicit, convert = false } = {}, ctx = {}) {
    const pageUrl = pageUrlNow();
    const yt = youtubeVideo(explicit ?? pageUrl);
    if (yt) {
      const onPage = youtubeVideo(pageUrl)?.id === yt.id;
      if (ctx.announce) toast(ctx.announce);
      // An explicit link's own t= wins over where the page's player is.
      return playOnYoutube(yt, { fromPage: onPage && !(explicit && yt.t), onPage }, ctx);
    }
    const pick = await pickMedia(explicit, { auto: !!ctx.auto });
    if (pick?.kind === 'ad') throw adWait();
    // The stream that just played to its end on the TV, picked again by itself: the page is back on
    // an ad or its own end screen, not a new video.
    if (ctx.auto && pick?.url && endedOnTv && endedOnTv.page === pageUrl && endedOnTv.url === pick.url && Date.now() - endedOnTv.at < ENDED_REPEAT_MS) throw adWait();
    if (ctx.announce && pick) toast(ctx.announce);
    if (pick?.kind === 'youtube') return playOnYoutube(pick.video, {}, ctx);
    a();
    if (!pick) throw new LumenError('NOT_FOUND', 'No video found on this page yet: start the video, then try again');
    if (!relay()) throw new LumenError('UNAVAILABLE', 'The media relay is not available');
    // HLS with fragmented-MP4 segments never plays in the TV's own player (CineHD found the same), so
    // the agent goes straight to its in-page hls.js player for it. A playlist the server refuses (a
    // one-time link the page's player already used: Dailymotion's cdndirector answers 403 the second
    // time), or one with only the sound, is passed over for another stream of the same site.
    const probeOnce = async (token) => {
      let probeTimer = null;
      return Promise.race([
        relay().probeHls(token).catch((err) => {
          const status = Number(/answered (\d{3})/.exec(err.message)?.[1]) || null;
          return { refused: !!status && status >= 400 && status < 500 && status !== 408 && status !== 429, status, error: err.message };
        }),
        new Promise((r) => { probeTimer = setTimeout(r, PROBE_MS, null); }),
      ]).finally(() => clearTimeout(probeTimer));
    };
    let { url, token } = relay().register(pick.url, pick.headers);
    let probe = pick.kind === 'hls' && relay().probeHls ? await probeOnce(token) : null;
    let tried = 0;
    if ((probe?.refused || probe?.audioOnly) && !explicit) {
      for (const other of alternatives(pick, pageUrl)) {
        tried += 1;
        const next = relay().register(other.url, other.headers);
        const result = await probeOnce(next.token);
        if (result?.refused || result?.audioOnly) continue;
        log.info(probe.refused ? 'playlist refused; using another stream the page loaded' : 'only the sound in that playlist; using another stream the page loaded',
          { from: hostOf(pick.url), to: hostOf(other.url) });
        Object.assign(pick, other);
        ({ url, token } = next);
        probe = result;
        break;
      }
    }
    if (probe?.refused && GONE_STATUSES.has(probe.status) && !explicit) {
      log.info('the site refused the video’s link', { status: probe.status, host: hostOf(pick.url) });
      throw new LumenError('NOT_FOUND', 'The site refused this video’s link (a one-time link): it keeps playing on the page');
    }
    if (probe?.audioOnly && !explicit && tried) throw new LumenError('NOT_FOUND', 'Only the sound track was found: start the video on the page, then try again');
    const recognised = !!probe && !probe.refused && !probe.error; // the probe read an HLS playlist
    if (probe?.refused || probe?.error) probe = null;
    if (probe?.drm) return playProtected(pick, ctx, { explicit: !!explicit });
    const engine = probe?.fmp4 ? 'hls' : 'avplay';
    checkLive(ctx);
    // Not shown yet, the agent reconnected since, or another app is in front: screen mode and the
    // front first (the TV agent would play into a hidden page).
    if (!on || !screenSent || agentHidden) await open();
    const tc = transcoder();
    const known = tc?.existing?.(pick.url);
    if (current?.job && current.job !== known?.id) releaseJob(true);
    current = newCurrent(pick, { stage: 'direct', explicit: !!explicit, variants: probe?.variants ?? null });
    const mine = current;
    setHandoff('direct');
    // A video already converted (or known not to play directly) goes straight to the converted copy.
    if (known || convert) {
      mine.stage = known && !known.copy ? 'copy' : 'direct';
      if (!(await fallback(known ? 'converted before' : 'conversion requested', mine))) throw new LumenError('FAILED', 'The video could not be prepared for the TV');
      if (current === mine && on) await pausePage(mine.token);
      return { value: { kind: pick.kind, title: mine.title, converted: true } };
    }
    // Streams the TV's player shows wrongly or not at all go to the copy stage up front: an H.264
    // stream labelled with a level too low for its picture (AVPlay plays the sound over black and
    // never says so) and DASH (the relay does not rewrite manifests).
    const levelLow = probe?.levelLow && !probe.fmp4;
    if (probe?.levelLow && probe.fmp4) log.info('H.264 level too low for the picture (fMP4: hls.js plays it)', { level: probe.level ?? null });
    if ((levelLow || pick.kind === 'dash') && tc?.available?.()) {
      if (levelLow) log.info('H.264 level too low for the picture; relabelling on this PC', { level: probe.level ?? null, size: probe.size ?? null });
      const reason = levelLow ? 'level' : 'dash';
      if (await fallback(levelLow ? 'H.264 level too low' : 'DASH stream', mine)) {
        if (current === mine && on) await pausePage(mine.token);
        return { value: { kind: pick.kind, title: mine.title, converted: true, reason } };
      }
      if (current !== mine || !on) throw cancelled();
      if (pick.kind === 'dash') throw new LumenError('FAILED', 'The video could not be prepared for the TV');
      // The copy failed: the TV's player gets the stream itself, which is no worse than before.
    }
    sendPlay(a(), { t: 'screen-play', url, title: mine.title, engine, ...(recognised && { kind: 'hls' }) });
    await pausePage(mine.token);
    log.info('video handed to the TV player', { kind: pick.kind, engine, host: hostOf(pick.url) });
    return { value: { kind: pick.kind, engine, title: store.get('browser.title')?.v ?? null } };
  }

  // DRM-protected video plays through the TV's own certified DRM (PlayReady / Widevine via EME in the
  // agent's hls.js): the site's licence server decides, and the keys stay inside the TV. Lumen relays
  // the CENC stream and the licence requests with the page's headers. The licence servers come from
  // the page's player config (Vimeo's playerConfig today).
  const DRM_SCRIPT = `(() => {
    const r = window.playerConfig && window.playerConfig.request;
    if (!r || !r.drm || !r.drm.cdms || !r.files || !r.files.hls_cenc) return null;
    const f = r.files.hls_cenc, cdns = f.cdns || {};
    const cdn = cdns[f.default_cdn] || Object.values(cdns)[0];
    const lic = (k) => (r.drm.cdms[k] && r.drm.cdms[k].license_url) || null;
    const wv = r.drm.cdms.widevine;
    return { stream: cdn && cdn.url || null, playready: lic('playready'), widevine: lic('widevine'), widevineCert: wv && typeof wv.certificate === 'string' ? wv.certificate : null };
  })()`;

  async function playProtected(pick, ctx = {}, { explicit = false } = {}) {
    const info = await b().evaluate(DRM_SCRIPT).catch(() => null);
    if (!info?.stream || !(info.playready || info.widevine)) {
      throw new LumenError('UNAVAILABLE', 'This video is DRM-protected and Lumen could not find its licence server on this page');
    }
    // The page's cookie was captured for pick.url: it goes only to that same site, never to a stream
    // or licence host the page's script names.
    const noCookie = { ...pick.headers };
    delete noCookie.cookie;
    const headersFor = (target, extra = {}) => ({ ...(siteOf(target) === siteOf(pick.url) ? pick.headers : noCookie), ...extra });
    const { url } = relay().register(info.stream, headersFor(info.stream));
    const drm = {};
    if (info.playready) drm['com.microsoft.playready'] = { licenseUrl: relay().register(info.playready, headersFor(info.playready, { licence: 'resolve' })).url };
    if (info.widevine) {
      // Widevine first asks for the licence server's (public) service certificate; the page carries it.
      const cert = /^[A-Za-z0-9+/=]{16,8192}$/.test(info.widevineCert ?? '') ? Buffer.from(info.widevineCert, 'base64') : null;
      drm['com.widevine.alpha'] = {
        licenseUrl: relay().register(info.widevine, headersFor(info.widevine, { licence: 'resolve' })).url,
        ...(cert && relay().registerBlob && { serverCertificateUrl: relay().registerBlob(cert).url }),
      };
    }
    checkLive(ctx);
    if (!on || !screenSent || agentHidden) await open();
    // A converted video playing before keeps no ffmpeg running behind the protected one.
    if (current?.job) releaseJob(true);
    current = newCurrent(pick, { stage: 'drm', explicit });
    setHandoff('drm');
    sendPlay(a(), { t: 'screen-play', url, title: current.title, engine: 'hls', kind: 'hls', drm });
    await pausePage(current.token);
    log.info('protected video handed to the TV player', { host: hostOf(info.stream), systems: Object.keys(drm) });
    return { value: { kind: 'hls', drm: Object.keys(drm), title: current.title } };
  }

  // The variant ffmpeg should take from a master playlist (relay.js decides; older relays: ffmpeg's own).
  const chooseProgram = (variants, copy) => {
    if (!Array.isArray(variants) || !variants.length || typeof relayLib.chooseVariant !== 'function') return null;
    try { const index = relayLib.chooseVariant(variants, { copy })?.index; return Number.isInteger(index) ? index : null; } catch { return null; }
  };

  // The TV's player refused the stream: re-package it (copy) on this PC, then fully convert it. Runs
  // for `mine` only: a newer hand-off or a close while ffmpeg starts wins, and the copy is dropped.
  // → true when a converted copy went to the TV (or nothing more is to be done: it was replaced).
  async function fallback(error, mine = current, { played = false, position = null } = {}) {
    if (!mine || mine !== current || !on || mine.converting || agentHidden) return false;
    if (mine.stage === 'drm') { toast('The TV could not get a licence for this protected video', 'warn'); return false; }
    // A copy that had played and then failed (a network blip mid-film) is made again, once, from
    // where it was, before the slower full conversion.
    let next = mine.stage === 'direct' ? 'copy' : mine.stage === 'copy' ? 'encode' : null;
    if (mine.stage === 'copy' && played && !mine.retried) { next = 'copy'; mine.retried = true; }
    const tc = transcoder();
    if (!next || !tc?.available?.()) {
      if (!next) { toast('The TV cannot play this video', 'warn'); releaseJob(true); }
      else toast('The TV cannot play this format, and ffmpeg is missing on the PC to convert it', 'warn');
      return false;
    }
    const gen = generation;
    releaseJob(true);
    mine.stage = next;
    mine.converting = true;
    // An active state: live video stays paused, frames stay held, the automatic hand-off waits.
    setVideo('fallback');
    syncLivePause();
    setHandoff(next, true);
    toast(next === 'copy' ? 'Preparing the video for the TV…' : 'Converting the video for the TV…');
    if (lastJpeg) agent()?.sendFrame?.(lastJpeg);
    const startSec = played && position > 30000 ? Math.floor(position / 1000) : null;
    const options = {
      headers: mine.pick.headers, proxyUrl: relay()?.proxyUrl?.() ?? null, copy: next === 'copy',
      ...(startSec && { startSec }),
    };
    const program = chooseProgram(mine.variants, next === 'copy');
    if (program !== null) options.program = program;
    const stale = () => current !== mine || gen !== generation || !on;
    try {
      let result;
      try {
        result = await tc.convert(mine.pick.url, options);
      } catch (err) {
        if (options.program === undefined || !/does not contain any stream/i.test(err.message) || stale()) throw err;
        delete options.program;
        result = await tc.convert(mine.pick.url, options);
      }
      mine.converting = false;
      if (stale()) {
        // Replaced or closed while ffmpeg started: its copy is not wanted (unless the newer video is the same).
        if (current === mine || current?.pick?.url !== mine.pick.url) tc.stopJob?.(result.id);
        log.info('conversion finished after the video was replaced; dropped', { stage: next });
        return true;
      }
      mine.job = result.id;
      tc.hold?.(result.id, true);
      setHandoff(next, false);
      if (!agentOnline()) {
        // The agent went away meanwhile: the copy waits (a short while) for the next Video → TV.
        releaseJob(false);
        setVideo(null);
        return true;
      }
      sendPlay(agent(), { t: 'screen-play', url: relay().convertedUrl(result.id), title: mine.title, fromStart: true });
      log.info('playing the converted video on the TV', { stage: next, after: noUrls(error).slice(0, 80), ...(startSec && { from: startSec }) });
      return true;
    } catch (err) {
      mine.converting = false;
      if (stale()) return true;
      log.warn('conversion failed', { stage: next, message: noUrls(err.message) });
      // A link the server refuses (403, 404) fails the same way whatever ffmpeg does with it.
      if (next === 'copy' && !/Server returned 4(\d\d|XX)\b/.test(err.message)) return fallback(error, mine);
      toast(err.message, 'warn');
      setVideo('error');
      syncLivePause();
      setHandoff(null);
      return false;
    }
  }

  // ---------- conversion jobs ----------

  function cancelJobGrace() {
    if (!jobGraceTimer) return;
    clearTimeout(jobGraceTimer);
    jobGraceTimer = null;
    if (current?.job) transcoder()?.hold?.(current.job, true);
  }

  // The conversion behind the video on the TV is let go: at once (stop), or after a grace in which
  // the same video can come back (Back then Yellow) without starting ffmpeg again.
  function releaseJob(stop) {
    clearTimeout(jobGraceTimer);
    jobGraceTimer = null;
    const id = current?.job;
    if (!id) return;
    const tc = transcoder();
    tc?.hold?.(id, false);
    if (stop) {
      tc?.stopJob?.(id);
      current.job = null;
      return;
    }
    jobGraceTimer = setTimeout(() => {
      jobGraceTimer = null;
      if (current?.job !== id || (on && videoActive())) return;
      log.info('conversion no longer watched; stopping it');
      transcoder()?.stopJob?.(id);
      current.job = null;
    }, JOB_GRACE_MS);
    jobGraceTimer.unref?.();
  }

  // ---------- live video ----------

  // From the moment the TV takes the live stream (its 'ready'), no JPEG frame goes to it (it would
  // decode them on the thread its player and its socket need), except one when the stream is paused,
  // restarts or stops.
  const liveShowing = () => !!(live && !live.paused);
  // Times the TV's agent went away while it was playing live video (its page starved or was killed
  // for memory), or did not start it: the next offer starts a step lower, and after two the TV stays
  // on frames until live video is turned on again (tvscreen.live).
  let liveStrikes = 0;
  let lastStrikeAt = 0;
  let liveHidden = false; // the TV's agent is in the background (the owner switched to another app)
  const MAX_LIVE_STRIKES = 2;
  const STRIKES_FORGOTTEN_MS = 10 * 60 * 1000; // a drop this long ago no longer counts against live video
  const strike = () => { liveStrikes += 1; lastStrikeAt = Date.now(); };

  // Asks the TV agent whether it has the live player (older agents do not answer).
  function offerLive() {
    const feature = liveVideo();
    if (!liveWanted || !feature?.enabled?.() || live) return;
    if (liveStrikes && Date.now() - lastStrikeAt > STRIKES_FORGOTTEN_MS) { liveStrikes = 0; setLiveBlocked(null); }
    if (liveStrikes >= MAX_LIVE_STRIKES) {
      log.info('live video not offered: the TV agent went away twice while playing it', { strikes: liveStrikes });
      setLiveBlocked({ strikes: liveStrikes, untilMs: lastStrikeAt + STRIKES_FORGOTTEN_MS });
      return;
    }
    agent()?.sendScreen?.({ t: 'screen-live-offer', probes: feature.codecProbes() });
  }

  const isInit = (buf) => buf?.length > 3 && buf[0] === 0x4c && buf[1] === 0x56 && buf[2] === 0x49; // 'LVI'

  // A TV that took the stream but never plays it (a MediaSource that never opens) keeps reporting, so
  // the stats watchdog never fires: from the first init it gets LIVE_START_MS to play.
  function armStart(mine) {
    mine.startTimer = setTimeout(() => {
      mine.startTimer = null;
      if (live !== mine || mine.playing || mine.paused) return;
      log.warn('the TV did not start the live video', { ms: LIVE_START_MS });
      strike();
      stopLive('the TV did not start the live video');
    }, LIVE_START_MS);
  }
  const disarmStart = (mine) => { if (mine?.startTimer) { clearTimeout(mine.startTimer); mine.startTimer = null; } };

  // The capture restarted (features/livevideo.js): the TV's player would sit on its last picture, so
  // it is torn down (the page's frame shows) until the new stream plays.
  function onLiveRestart(mine) {
    if (live !== mine || mine.paused) return;
    mine.playing = false;
    disarmStart(mine);
    agent()?.sendScreen?.({ t: 'screen-live-stop' });
    browser()?.setSparseFrames?.(false);
    if (lastJpeg && !videoActive()) agent()?.sendFrame?.(lastJpeg);
    toast('Live video restarting…');
  }

  function onLive(msg) {
    const state = typeof msg.state === 'string' ? msg.state : '';
    if (state === 'hidden') {
      // Another app in front on the TV: not a failure. Live video stops and comes back with the page.
      agentHidden = true;
      liveHidden = true;
      if (live) {
        log.info('the TV switched away from Lumen; live video paused');
        stopLive(null);
      }
      return;
    }
    if (state === 'visible') {
      liveHidden = false;
      agentHidden = false;
      if (on && !live) offerLive();
      return;
    }
    if (state === 'ready') {
      const feature = liveVideo();
      if (!liveWanted || !feature?.enabled?.() || live) return;
      const caps = {};
      if (msg.caps && typeof msg.caps === 'object') for (const [k, v] of Object.entries(msg.caps).slice(0, 32)) caps[String(k).slice(0, 60)] = v === true;
      const mine = { handle: null, playing: false, paused: false, startTimer: null };
      const viewer = {
        send: (buf, sendOpts) => {
          if (live === mine && !mine.playing && !mine.paused && !mine.startTimer && isInit(buf)) armStart(mine);
          return agent()?.sendVideo?.(buf, sendOpts) ?? false;
        },
        buffered: () => agent()?.bufferedAmount?.() ?? 0,
        onFallback: (reason) => {
          if (live !== mine) return;
          if (/stopped reporting/.test(String(reason))) strike(); // its page was starved
          stopLive(reason);
        },
        onRestart: () => onLiveRestart(mine),
      };
      // Set first: a capture that is still running sends its init to the new viewer at once.
      live = mine;
      try {
        mine.handle = feature.attach(viewer, caps, { lower: liveStrikes });
      } catch (err) {
        live = null;
        disarmStart(mine);
        log.info('live video not available', { message: err.message });
        return;
      }
      try {
        log.info('live video offered to the TV', { caps: Object.keys(caps).filter((k) => caps[k]), strikes: liveStrikes });
        browser()?.setSparseFrames?.(true);
        syncLivePause();
      } catch (err) {
        log.info('live video not available', { message: err.message });
      }
      return;
    }
    if (!live) return;
    if (state === 'playing') {
      if (!live.playing) {
        log.info('live video playing on the TV', { size: msg.w && msg.h ? `${msg.w}x${msg.h}` : null, muted: msg.muted === true });
        browser()?.setSparseFrames?.(true);
      }
      live.playing = true;
      disarmStart(live);
    } else if (state === 'stats') {
      live.handle.report({ lag: num(msg.lag), dropped: num(msg.dropped) ?? 0, decoded: num(msg.decoded) ?? 0, stalls: num(msg.stalls) ?? 0, buffered: num(msg.buffered) });
    } else if (state === 'resync') {
      live.handle.resync();
    } else if (state === 'refused') {
      // The TV's player refused this format or could not decode it: the next step down is tried (its
      // init starts the start clock again).
      log.info('the TV refused the live stream', { reason: String(msg.reason ?? '').slice(0, 120) });
      live.playing = false;
      disarmStart(live);
      live.handle.refused();
      if (lastJpeg && !videoActive()) agent()?.sendFrame?.(lastJpeg);
    } else if (state === 'unsupported' || state === 'error') {
      stopLive(`TV: ${String(msg.reason ?? state).slice(0, 120)}`);
    }
  }

  // The live player steps aside while the TV's own player is in front or a sign-in pop-up is shown
  // (the capture shows the page, not the pop-up): the JPEG frames show those.
  function syncLivePause() {
    if (!live) return;
    const pause = videoActive() || !!browser()?.popupShown?.();
    if (pause === live.paused) return;
    live.paused = pause;
    if (pause) {
      disarmStart(live);
      live.handle.pause();
      live.playing = false;
      browser()?.setSparseFrames?.(false);
      agent()?.sendScreen?.({ t: 'screen-live-stop' });
      if (lastJpeg && !videoActive()) agent()?.sendFrame?.(lastJpeg);
    } else {
      browser()?.setSparseFrames?.(true);
      live.handle.resume();
    }
  }

  // Back to the JPEG frames (the TV cannot play the stream, live video was turned off, or closed).
  function stopLive(reason) {
    if (!live) return;
    const { handle } = live;
    disarmStart(live);
    live = null;
    handle.detach();
    browser()?.setSparseFrames?.(false);
    agent()?.sendScreen?.({ t: 'screen-live-stop' });
    if (reason) {
      log.info('live video stopped; showing frames', { reason: String(reason).slice(0, 160) });
      if (on && lastJpeg && !videoActive()) agent()?.sendFrame?.(lastJpeg);
    }
  }

  /** Turns live video on or off for the browser on the TV (the JPEG frames are the fallback). */
  function setLive({ on: want }) {
    liveWanted = want === true;
    if (liveWanted) { liveStrikes = 0; setLiveBlocked(null); }
    if (!liveWanted) stopLive('turned off');
    else if (on) offerLive();
    return { value: { live: liveWanted } };
  }

  /** Clear history: forgets the pages and videos the TV screen remembers (the page whose video failed,
   *  the last YouTube hand-off, the page's last frame). A video the TV is playing now keeps going;
   *  → { videoOnTv, job }: whether one is, and its conversion job, which must stay. */
  function forgetHistory() {
    const playing = videoActive();
    autoFailed = null;
    lastYoutube = null;
    lastJpeg = null;
    heldFrame = null;
    endedOnTv = null;
    adHold = null;
    prevKeys = null;
    setHandoff(null);
    if (store.get('tvscreen.notice')?.v) store.set('tvscreen.notice', null, meta);
    if (!playing) {
      releaseJob(true);
      current = null;
    }
    return { videoOnTv: playing, job: playing ? current?.job ?? null : null };
  }

  // The browser itself stopping or crashing while it is on the TV: the TV says so.
  function onSession(state) {
    const before = lastSession;
    lastSession = state;
    if (!on || state === before) return;
    if (state === 'starting' && before === 'ready') toast('The browser stopped; starting it again', 'warn');
    else if (state === 'error') toast('The browser stopped. Open the page again from your phone', 'warn');
    else if (state === 'ready' && before) sendCursor();
  }

  function onAgentConn(value) {
    const online = value === 'online';
    // The agent gone (closed, the TV off): its player is gone too, whatever it last reported.
    if (!online && store.get('tvscreen.video')?.v != null) {
      heldFrame = null;
      setVideo(null);
    }
    if (online === agentWasOnline) return;
    agentWasOnline = online;
    if (online) onAgentBack();
    else onAgentLost();
  }

  return {
    open,
    close,
    playVideo,
    pointer,
    setLive,
    forgetHistory,
    start() {
      setState(false);
      agentWasOnline = agentOnline();
      lastSession = store.get('browser.session')?.v ?? null;
      // Screen messages are heard from the start: a TV left in screen mode by an earlier run of this
      // server is turned off by its first key press.
      ensureSubscribed();
      removeStoreListener ??= store.on('patch', (patch) => {
        if ('conn.agent' in patch) onAgentConn(patch['conn.agent']?.v ?? null);
        if ('browser.popup' in patch) syncLivePause();
        if ('browser.session' in patch) onSession(patch['browser.session']?.v ?? null);
        if ('browser.crashed' in patch && on && patch['browser.crashed']?.v) toast('The page crashed; reloading', 'warn');
      });
    },
    async stop() {
      removeStoreListener?.();
      removeStoreListener = null;
      clearLoss();
      clearTimeout(videoWatchTimer);
      videoWatchTimer = null;
      releaseJob(true);
      await close();
      unsubscribeScreen?.();
      unsubscribeScreen = null;
      subscribedTo = null;
    },
    setDemand() {},
  };
}
