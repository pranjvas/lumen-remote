// Lumen browser on the TV: the page is rendered by Lumen's own browser on this PC (behind the VPN
// when it is on) and shown full screen by the TV agent (companion/agent/screen.js). The TV remote
// drives it — arrows move a pointer, OK clicks, Back goes back, CH ▲▼ scroll, Red closes, Green
// reloads, Yellow hands the page's video to the TV's own player through the relay (full quality,
// with sound). Phones keep controlling the same page in the Browser view.
import { LumenError } from '../errors.js';

const STEP = 0.014; // pointer step (fraction of the screen) for a single press
const STEP_MAX = 0.09;
const STREAK_MS = 260; // presses closer than this accelerate
const SCROLL_PX = 600;
const EDGE = 0.002;

export function createTvScreen({ config, log: rootLog, store, agent, rest, browser, relay, transcoder = () => null }) {
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

  const setState = (value) => store.set('tvscreen.on', value, { src: 'derived', via: 'tvscreen' });
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

  function sendCursor() {
    agent()?.sendScreen?.({ t: 'screen-cursor', x: cursor.x, y: cursor.y, visible: true });
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

  async function onPointer({ x, y }, click) {
    cursor = { x: Math.min(1, Math.max(0, Number(x) || 0)), y: Math.min(1, Math.max(0, Number(y) || 0)) };
    sendCursor();
    await b().input({ kind: click ? 'click' : 'move', ...at() });
  }

  function onMessage(msg) {
    if (!on) return;
    if (msg.t === 'screen-input') {
      if (typeof msg.key === 'string') enqueue(() => onKey(msg.key));
      else if (msg.pointer) enqueue(() => onPointer(msg.pointer, msg.click === true));
    } else if (msg.t === 'screen-video') {
      store.set('tvscreen.video', typeof msg.state === 'string' ? msg.state.slice(0, 20) : null, { src: 'derived', via: 'tvscreen' });
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
      removeSink = feature.addSink((bytes) => agent()?.sendFrame?.(bytes));
      unsubscribe = adapter.onScreen(onMessage);
      setState(true);
      log.info('browser shown on the TV', { url: store.get('browser.url')?.v ?? null });
    }
    sendCursor();
    return { value: { on: true, url: store.get('browser.url')?.v ?? null } };
  }

  async function close() {
    if (!on) return { value: { on: false } };
    on = false;
    removeSink?.();
    unsubscribe?.();
    removeSink = unsubscribe = null;
    setState(false);
    await agent()?.request?.('screen', { on: false }).catch(() => {});
    log.info('browser screen closed on the TV');
    return { value: { on: false } };
  }

  // The page's own video first: the biggest (or playing) <video> with a real URL, then streams the page
  // loaded from its own site, then any stream; ad players are what usually loads from other sites.
  async function pickMedia(explicit) {
    const feature = b();
    const media = feature.media();
    const pageUrl = store.get('browser.url')?.v ?? '';
    const site = (u) => { try { return new URL(u).hostname.split('.').slice(-2).join('.'); } catch { return ''; } };
    const headersFor = (url) => media.find((m) => m.url === url)?.headers ?? { referer: pageUrl };
    if (explicit) return { url: explicit, kind: /\.m3u8/i.test(explicit) ? 'hls' : 'file', headers: headersFor(explicit) };
    const videos = await feature.evaluate(`[...document.querySelectorAll('video')].map((v) => ({ src: v.currentSrc || v.src || '', area: v.clientWidth * v.clientHeight, playing: !v.paused }))`).catch(() => []);
    const direct = (videos ?? []).filter((v) => /^https?:/.test(v.src)).sort((x, y) => (y.playing - x.playing) || (y.area - x.area))[0];
    if (direct) return { url: direct.src, kind: /\.m3u8/i.test(direct.src) ? 'hls' : 'file', headers: headersFor(direct.src) };
    const own = media.filter((m) => site(m.url) === site(pageUrl));
    const rank = (list) => list.find((m) => m.kind === 'hls') ?? list.find((m) => m.kind === 'file') ?? list.find((m) => m.kind === 'dash');
    return rank(own) ?? rank(media) ?? null;
  }

  /** Plays the page's video (or `url`) on the TV's own player, through the relay; convert: true
   *  skips the direct attempt and converts on this PC straight away. */
  async function playVideo({ url: explicit, convert = false } = {}) {
    const adapter = a();
    const pick = await pickMedia(explicit);
    if (!pick) throw new LumenError('NOT_FOUND', 'No video found on this page yet: start the video, then try again');
    if (!relay()) throw new LumenError('UNAVAILABLE', 'The media relay is not available');
    const { url } = relay().register(pick.url, pick.headers);
    if (!on) await open();
    const tc = transcoder();
    const known = tc?.existing?.(pick.url);
    if (current?.job && current.job !== known?.id) tc?.stopJob(current.job);
    current = { pick, title: store.get('browser.title')?.v ?? '', stage: 'direct', job: null };
    // A video already converted (or known not to play directly) goes straight to the converted copy.
    if (known || convert) {
      current.stage = known && !known.copy ? 'copy' : 'direct';
      await fallback(known ? 'converted before' : 'conversion requested');
      return { value: { kind: pick.kind, title: current.title, converted: true } };
    }
    adapter.sendScreen({ t: 'screen-play', url, title: current.title });
    log.info('video handed to the TV player', { kind: pick.kind, host: new URL(pick.url).hostname });
    return { value: { kind: pick.kind, title: store.get('browser.title')?.v ?? null } };
  }

  // The TV's player refused the stream: re-package it (copy) on this PC, then fully convert it.
  async function fallback(error) {
    if (!current || !on) return;
    const next = current.stage === 'direct' ? 'copy' : current.stage === 'copy' ? 'encode' : null;
    const tc = transcoder();
    if (!next || !tc?.available()) {
      if (!next) toast('The TV cannot play this video');
      else toast('The TV cannot play this format, and ffmpeg is missing on the PC to convert it');
      return;
    }
    if (current.job) tc.stopJob(current.job);
    current.stage = next;
    toast(next === 'copy' ? 'Preparing the video for the TV…' : 'Converting the video for the TV…');
    try {
      const { id } = await tc.convert(current.pick.url, { headers: current.pick.headers, proxyUrl: relay()?.proxyUrl?.() ?? null, copy: next === 'copy' });
      current.job = id;
      agent()?.sendScreen?.({ t: 'screen-play', url: relay().convertedUrl(id), title: current.title, fromStart: true });
      log.info('playing the converted video on the TV', { stage: next, after: error.slice(0, 80) });
    } catch (err) {
      log.warn('conversion failed', { stage: next, message: err.message });
      if (next === 'copy') return fallback(error);
      toast(err.message);
    }
  }

  return {
    open,
    close,
    playVideo,
    start() { setState(false); },
    async stop() {
      if (current?.job) transcoder()?.stopJob(current.job);
      await close();
    },
    setDemand() {},
  };
}
