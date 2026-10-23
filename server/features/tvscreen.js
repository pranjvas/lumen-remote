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
const pageVideoScript = (minArea) => `(() => {
  const area = innerWidth * innerHeight;
  return [...document.querySelectorAll('video')].some((v) => !v.paused && !v.ended && v.clientWidth * v.clientHeight >= area * ${minArea});
})()`;
// YouTube's player is paused through its own API too: a bare <video>.pause() while it is still
// buffering the start is undone by the player a moment later.
const PAUSE_PAGE_SCRIPT = `(() => {
  document.querySelectorAll('.html5-video-player').forEach((p) => { try { if (p.pauseVideo) p.pauseVideo(); } catch (e) {} });
  document.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch (e) {} });
})()`;
const YOUTUBE_REPEAT_MS = 15000; // the same video started again this soon after a hand-off is only paused
const YOUTUBE_MIN_EMBED_AREA = 40000; // CSS px²: a YouTube embed smaller than ~200×200 is not "the page's video"
const YOUTUBE_APP_IDS = new Set(['111299001912', '9Ur5IzDKqV.TizenYouTube']);
const AUTO_RETRY_MS = 60000; // a page whose video could not be handed over is not tried again by itself this soon
const MANUAL_GRACE_MS = 5000; // the automatic hand-off leaves the page alone this long around a manual one
const PROBE_MS = 6000; // the HLS probe's budget: a slow or failing playlist plays in AVPlay
// Two hosts are the same site when their last two labels match (the relay's own rule for cookies).
const siteOf = (raw) => { try { return new URL(raw).hostname.toLowerCase().split('.').slice(-2).join('.'); } catch { return ''; } };

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

export function createTvScreen({ config, log: rootLog, store, agent, rest, browser, relay, transcoder = () => null, cast = () => null }) {
  const log = rootLog.child('tvscreen');
  const appId = config.agent?.appId;
  let on = false;
  let removeSink = null;
  let unsubscribe = null;
  let cursor = { x: 0.5, y: 0.45 };
  let streak = 0;
  let lastKeyAt = 0;
  let queue = Promise.resolve();
  let current = null; // { pick, title, stage: 'direct' | 'copy' | 'encode', job }
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
  let heldFrame = null; // the page's latest frame, held back while the TV's player is in front
  let removeStoreListener = null;

  const setState = (value) => store.set('tvscreen.on', value, { src: 'derived', via: 'tvscreen' });
  const setVideo = (value) => store.set('tvscreen.video', value, { src: 'derived', via: 'tvscreen' });
  const videoActive = () => TV_VIDEO_ACTIVE.has(store.get('tvscreen.video')?.v);
  const cancelled = () => Object.assign(new LumenError('FAILED', 'The browser screen was closed'), { cancelled: true });
  // An automatic hand-off stops quietly once the screen was closed (or closed and opened again).
  const checkLive = (ctx) => { if (ctx?.auto && (ctx.gen !== generation || !on)) throw cancelled(); };
  // The page's own video is paused once the TV plays it: it would download the same stream a second
  // time (through the VPN) and keep sending frames the TV does not show.
  // The page's videos, and those of its embedded players, stop once the TV plays the video.
  const pausePage = async () => {
    const feature = browser();
    await feature?.evaluate?.(PAUSE_PAGE_SCRIPT).catch(() => {});
    await feature?.evaluateFrames?.(PAUSE_PAGE_SCRIPT).catch(() => {});
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
    if (!adapter?.sendFrame || store.get('conn.agent')?.v !== 'online') {
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

  function toast(text) {
    agent()?.sendScreen?.({ t: 'screen-toast', text });
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

  async function onKey(key) {
    const now = Date.now();
    if (key === 'enter' || key === 'yellow') lastRemoteInput = now;
    streak = now - lastKeyAt < STREAK_MS ? streak + 1 : 0;
    lastKeyAt = now;
    const step = Math.min(STEP * (1 + streak * 0.45), STEP_MAX);
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
      case 'yellow': return playVideo().catch((err) => toast(err.message));
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
    nativeAt = { x: Math.min(1, Math.max(0, Number(x) || 0)), y: Math.min(1, Math.max(0, Number(y) || 0)) };
    // The phone's pad is in charge: its position counts, the TV pointer is only being steered there.
    if (Date.now() < padUntil) { hideCursor(); return; }
    if (click) lastRemoteInput = Date.now();
    cursor = { ...nativeAt };
    hideCursor(); // the TV draws its own pointer here
    await b().input({ kind: click ? 'click' : 'move', ...at() });
  }

  function onMessage(msg) {
    if (!on) return;
    if (msg.t === 'screen-input') {
      if (typeof msg.key === 'string') enqueue(() => onKey(msg.key));
      else if (msg.pointer) enqueue(() => onPointer(msg.pointer, msg.click === true));
    } else if (msg.t === 'screen-video') {
      setVideo(typeof msg.state === 'string' ? msg.state.slice(0, 20) : null);
      // Back on the page: it shows the frame held back while the player was in front (a still page
      // sends no new one).
      if (!videoActive() && heldFrame) {
        const frame = heldFrame;
        heldFrame = null;
        agent()?.sendFrame?.(frame);
      }
      if (msg.state !== 'paused') log.info('TV player', { state: String(msg.state).slice(0, 20), mode: typeof msg.mode === 'string' ? msg.mode.slice(0, 10) : null, note: msg.state === 'error' ? null : String(msg.error ?? '').slice(0, 120) || null });
      if (msg.state === 'error') {
        log.warn('TV player error', { error: String(msg.error ?? '').slice(0, 200), stage: current?.stage ?? null });
        enqueue(() => fallback(String(msg.error ?? '')));
      }
    }
  }

  // Starts the TV agent when it is not running (installs, restarts) and waits for it to connect.
  async function ensureAgent() {
    if (store.get('conn.agent')?.v === 'online') return;
    const adapter = agent();
    if (!adapter?.launch) throw new LumenError('UNAVAILABLE', 'The TV agent is not available');
    await adapter.launch().catch(() => {});
    const deadline = Date.now() + 20000;
    while (store.get('conn.agent')?.v !== 'online' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  }

  /** Shows Lumen's browser on the TV, optionally opening `url` first. */
  async function open({ url } = {}) {
    await ensureAgent();
    const adapter = a();
    const feature = b();
    if (url) await feature.open(url);
    else {
      await feature.ensureRunning();
      if (!store.get('browser.url')?.v) await feature.nav('home');
    }
    await adapter.request('screen', { on: true });
    if (appId && rest) await rest.launch(appId).catch((err) => log.debug('agent bring-to-front failed', { message: err.message }));
    if (!on) {
      on = true;
      setVideo(null);
      heldFrame = null;
      // While the TV's player is in front the page's frames are not shown: the TV would only decode
      // them on the thread its player needs. The latest one is kept for the return to the page.
      removeSink = feature.addSink((bytes) => {
        if (videoActive()) { heldFrame = bytes; return; }
        heldFrame = null;
        agent()?.sendFrame?.(bytes);
      });
      unsubscribe = adapter.onScreen(onMessage);
      setState(true);
      if (config.tvscreen?.autoPlayOnTv !== false) autoTimer = setInterval(() => { autoHandOff().catch(() => {}); }, AUTO_POLL_MS);
      log.info('browser shown on the TV', { url: store.get('browser.url')?.v ?? null });
    }
    sendCursor();
    return { value: { on: true, url: store.get('browser.url')?.v ?? null } };
  }

  async function close() {
    if (!on) return { value: { on: false } };
    on = false;
    generation += 1;
    clearInterval(autoTimer);
    autoTimer = null;
    removeSink?.();
    unsubscribe?.();
    removeSink = unsubscribe = null;
    heldFrame = null;
    // The agent's own 'stopped' arrives after the subscription is gone.
    setVideo(null);
    setState(false);
    await agent()?.request?.('screen', { on: false }).catch(() => {});
    log.info('browser screen closed on the TV');
    return { value: { on: false } };
  }

  // The user started a big video on the page: play it on the TV's player instead, and pause it on the
  // page (so it does not keep loading, and does not start again when the TV returns to the page).
  // A hand-off that failed leaves the page's video playing (the user can still watch it there), and
  // the same page is not tried again by itself for a while.
  // A big video playing on the page itself, or inside one of its frames (an embedded player such as
  // Dailymotion's fills the page from an iframe). Sizes count against the whole page.
  async function pageVideoPlaying(feature, minArea) {
    if (await feature.evaluate(pageVideoScript(minArea)).catch(() => false) === true) return true;
    if (!feature.evaluateFrames) return false;
    const vp = await feature.evaluate('[innerWidth, innerHeight]').catch(() => null);
    if (!Array.isArray(vp) || !(vp[0] > 0) || !(vp[1] > 0)) return false;
    const minPx = Math.round(minArea * vp[0] * vp[1]);
    const found = await feature.evaluateFrames(`[...document.querySelectorAll('video')].some((v) => !v.paused && !v.ended && v.clientWidth * v.clientHeight >= ${minPx})`).catch(() => []);
    return found.some((v) => v === true);
  }

  async function autoHandOff() {
    // Busy: a slow page check or a hand-off in flight must not let the next tick start a second one.
    if (!on || handOffBusy || videoActive() || Date.now() - lastManualAt < MANUAL_GRACE_MS) return null;
    const feature = browser();
    if (!feature) return null;
    // Only a video someone started (a click, a key, opening a link) goes to the TV: videos that start
    // by themselves (previews, autoplay) stay on the page instead of taking the TV over.
    if (Date.now() - Math.max(feature.lastInputAt?.() ?? 0, lastRemoteInput) > USER_START_MS) return null;
    const pageUrl = store.get('browser.url')?.v ?? '';
    if (autoFailed?.url === pageUrl && Date.now() - autoFailed.at < AUTO_RETRY_MS) return null;
    const ctx = { auto: true, gen: generation };
    const run = serialHandOff(async () => {
      if (ctx.gen !== generation || !on) return null;
      const yt = youtubeVideo(pageUrl);
      const playing = await pageVideoPlaying(feature, yt ? AUTO_MIN_AREA_YOUTUBE : AUTO_MIN_AREA);
      if (!playing || ctx.gen !== generation || !on) return null;
      // The same YouTube video starting again on the page right after it went to the app: just pause it.
      if (yt && lastYoutube?.id === yt.id && Date.now() - lastYoutube.at < YOUTUBE_REPEAT_MS) { await pausePage(); return null; }
      toast(yt ? 'Opening in YouTube on the TV…' : 'Playing on the TV’s player…');
      try {
        const result = await handOff({}, ctx);
        log.info('page video handed to the TV automatically');
        return result;
      } catch (err) {
        if (err.cancelled) return null;
        autoFailed = { url: pageUrl, at: Date.now() };
        toast(err.message);
        log.info('automatic hand-off failed', { message: err.message });
        return null;
      }
    });
    autoRun = run;
    try { return await run; } finally { if (autoRun === run) autoRun = null; }
  }

  // The page's own video first: a playing <video> with a real URL, then a YouTube embed (the biggest),
  // then the biggest <video>, then streams the page loaded from its own site, then any stream; ad
  // players are what usually loads from other sites.
  const PAGE_MEDIA_SCRIPT = `({
    videos: [...document.querySelectorAll('video')].map((v) => ({ src: v.currentSrc || v.src || '', area: v.clientWidth * v.clientHeight, playing: !v.paused })),
    frames: [...document.querySelectorAll('iframe')].map((f) => ({ src: f.src || '', area: f.clientWidth * f.clientHeight })),
  })`;
  async function pickMedia(explicit) {
    const feature = b();
    const media = feature.media();
    const pageUrl = store.get('browser.url')?.v ?? '';
    const headersFor = (url) => media.find((m) => m.url === url)?.headers ?? { referer: pageUrl };
    if (explicit) return { url: explicit, kind: /\.m3u8/i.test(explicit) ? 'hls' : 'file', headers: headersFor(explicit) };
    const found = await feature.evaluate(PAGE_MEDIA_SCRIPT).catch(() => null);
    const all = found?.videos ?? [];
    const videos = all.filter((v) => /^https?:/.test(v.src)).sort((x, y) => (y.playing - x.playing) || (y.area - x.area));
    const asFile = (v) => ({ url: v.src, kind: /\.m3u8/i.test(v.src) ? 'hls' : 'file', headers: headersFor(v.src) });
    if (videos[0]?.playing) return asFile(videos[0]);
    // A YouTube embed is the page's video only while none of the page's own players plays (an MSE
    // player's blob: video included): the site's video is not swapped for an unrelated embed.
    const embed = all.some((v) => v.playing) ? null : (found?.frames ?? []).filter((f) => f.area >= YOUTUBE_MIN_EMBED_AREA)
      .map((f) => ({ area: f.area, video: youtubeVideo(f.src) })).filter((f) => f.video).sort((x, y) => y.area - x.area)[0];
    if (embed) return { kind: 'youtube', video: embed.video };
    if (videos[0]) return asFile(videos[0]);
    const own = media.filter((m) => siteOf(m.url) === siteOf(pageUrl));
    const rank = (list) => list.find((m) => m.kind === 'hls') ?? list.find((m) => m.kind === 'file') ?? list.find((m) => m.kind === 'dash');
    return rank(own) ?? rank(media) ?? null;
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
    await pausePage();
    // The page's title names the video only when the page is that video's own page.
    const title = onPage ? String(store.get('browser.title')?.v ?? '').replace(/ - YouTube$/, '') || null : null;
    log.info('YouTube video opened in the TV’s YouTube app', { at: t >= 1 ? t : 0 });
    return { value: { kind: 'youtube', app: 'youtube', videoId: video.id, t: t >= 1 ? t : 0, title } };
  }

  /** Plays the page's video (or `url`) on the TV's own player, through the relay; convert: true
   *  skips the direct attempt and converts on this PC straight away. A YouTube page (or link, or a
   *  YouTube embed on the page) opens in the TV's YouTube app instead. */
  async function playVideo({ url: explicit, convert = false } = {}) {
    lastManualAt = Date.now();
    const joined = autoRun;
    const pageUrl = store.get('browser.url')?.v ?? '';
    try {
      return await serialHandOff(async () => {
        // Yellow (or Video → TV) while the automatic hand-off was handing the page's video over: that one counts.
        if (joined && explicit === undefined && !convert) {
          const done = await joined;
          if (done) return done;
        }
        try {
          return await handOff({ url: explicit, convert });
        } catch (err) {
          if (explicit === undefined) autoFailed = { url: pageUrl, at: Date.now() };
          throw err;
        }
      });
    } finally {
      lastManualAt = Date.now();
    }
  }

  // The player is in front on the TV as soon as it gets the stream (the agent reports 'playing' later).
  function sendPlay(adapter, msg) {
    adapter.sendScreen(msg);
    setVideo('loading');
  }

  async function handOff({ url: explicit, convert = false } = {}, ctx = {}) {
    const pageUrl = store.get('browser.url')?.v ?? '';
    const yt = youtubeVideo(explicit ?? pageUrl);
    if (yt) {
      const onPage = youtubeVideo(pageUrl)?.id === yt.id;
      // An explicit link's own t= wins over where the page's player is.
      return playOnYoutube(yt, { fromPage: onPage && !(explicit && yt.t), onPage }, ctx);
    }
    const pick = await pickMedia(explicit);
    if (pick?.kind === 'youtube') return playOnYoutube(pick.video, {}, ctx);
    const adapter = a();
    if (!pick) throw new LumenError('NOT_FOUND', 'No video found on this page yet: start the video, then try again');
    if (!relay()) throw new LumenError('UNAVAILABLE', 'The media relay is not available');
    const { url, token } = relay().register(pick.url, pick.headers);
    // HLS with fragmented-MP4 segments never plays in the TV's own player (CineHD found the same), so
    // the agent goes straight to its in-page hls.js player for it.
    let probeTimer = null;
    const probe = pick.kind === 'hls' && relay().probeHls
      ? await Promise.race([
        relay().probeHls(token).catch(() => null),
        new Promise((r) => { probeTimer = setTimeout(r, PROBE_MS, null); }),
      ]).finally(() => clearTimeout(probeTimer))
      : null;
    if (probe?.drm) return playProtected(pick, ctx);
    const engine = probe?.fmp4 ? 'hls' : 'avplay';
    checkLive(ctx);
    if (!on) await open();
    const tc = transcoder();
    const known = tc?.existing?.(pick.url);
    if (current?.job && current.job !== known?.id) tc?.stopJob(current.job);
    current = { pick, title: store.get('browser.title')?.v ?? '', stage: 'direct', job: null };
    // A video already converted (or known not to play directly) goes straight to the converted copy.
    if (known || convert) {
      current.stage = known && !known.copy ? 'copy' : 'direct';
      if (await fallback(known ? 'converted before' : 'conversion requested')) await pausePage();
      return { value: { kind: pick.kind, title: current.title, converted: true } };
    }
    sendPlay(adapter, { t: 'screen-play', url, title: current.title, engine });
    await pausePage();
    log.info('video handed to the TV player', { kind: pick.kind, engine, host: new URL(pick.url).hostname });
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

  async function playProtected(pick, ctx = {}) {
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
    if (!on) await open();
    // A converted video playing before keeps no ffmpeg running behind the protected one.
    if (current?.job) transcoder()?.stopJob(current.job);
    current = { pick, title: store.get('browser.title')?.v ?? '', stage: 'drm', job: null };
    sendPlay(a(), { t: 'screen-play', url, title: current.title, engine: 'hls', drm });
    await pausePage();
    log.info('protected video handed to the TV player', { host: new URL(info.stream).hostname, systems: Object.keys(drm) });
    return { value: { kind: 'hls', drm: Object.keys(drm), title: current.title } };
  }

  // The TV's player refused the stream: re-package it (copy) on this PC, then fully convert it.
  // → true when a converted copy went to the TV.
  async function fallback(error) {
    if (!current || !on) return false;
    if (current.stage === 'drm') { toast('The TV could not get a licence for this protected video'); return false; }
    const next = current.stage === 'direct' ? 'copy' : current.stage === 'copy' ? 'encode' : null;
    const tc = transcoder();
    if (!next || !tc?.available()) {
      if (!next) toast('The TV cannot play this video');
      else toast('The TV cannot play this format, and ffmpeg is missing on the PC to convert it');
      return false;
    }
    if (current.job) tc.stopJob(current.job);
    current.stage = next;
    toast(next === 'copy' ? 'Preparing the video for the TV…' : 'Converting the video for the TV…');
    try {
      const { id } = await tc.convert(current.pick.url, { headers: current.pick.headers, proxyUrl: relay()?.proxyUrl?.() ?? null, copy: next === 'copy' });
      current.job = id;
      const adapter = agent();
      if (adapter?.sendScreen) sendPlay(adapter, { t: 'screen-play', url: relay().convertedUrl(id), title: current.title, fromStart: true });
      log.info('playing the converted video on the TV', { stage: next, after: error.slice(0, 80) });
      return true;
    } catch (err) {
      log.warn('conversion failed', { stage: next, message: err.message });
      if (next === 'copy') return fallback(error);
      toast(err.message);
      return false;
    }
  }

  return {
    open,
    close,
    playVideo,
    pointer,
    start() {
      setState(false);
      // The agent gone (closed, the TV off): its player is gone too, whatever it last reported.
      removeStoreListener ??= store.on('patch', (patch) => {
        if ('conn.agent' in patch && patch['conn.agent']?.v !== 'online' && store.get('tvscreen.video')?.v != null) {
          heldFrame = null;
          setVideo(null);
        }
      });
    },
    async stop() {
      removeStoreListener?.();
      removeStoreListener = null;
      if (current?.job) transcoder()?.stopJob(current.job);
      await close();
    },
    setDemand() {},
  };
}
