// Live video of Lumen's browser for the TV: instead of still JPEG frames, the page is captured inside
// Lumen's own headless Edge (a second tab, livecapture.html, captures the browsing tab with its sound
// through getDisplayMedia), encoded there by the PC's hardware encoder (WebCodecs: H.264, or HEVC for
// 4K; AAC audio), and the encoded chunks come to Lumen over a loopback-only WebSocket. Lumen packs
// them as fragmented MP4 (server/util/fmp4.js) and hands the fragments to the TV agent, whose MSE
// player (companion/agent/live.js) plays them at the live edge. A viewer that joins, falls behind or
// comes back gets a fresh key frame; the bitrate and resolution follow what the link and the TV keep
// up with (2160p30 → 1080p60 → 720p60). tvscreen.js keeps the JPEG frames as the fallback.
import http from 'node:http';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { LumenError } from '../errors.js';
import { CAPTURE_TITLE } from './browser.js';
import {
  initSegment, fragment, mimeType, avcCodecString, hevcCodecString, buildHvcC, splitAnnexB, lengthPrefixed,
  hevcNalType, HEVC_PARAMETER_SETS, VIDEO_TRACK, AUDIO_TRACK, VIDEO_TIMESCALE,
} from '../util/fmp4.js';

const CAPTURE_PAGE = new URL('./livecapture.html', import.meta.url);
const HELLO_TIMEOUT_MS = 10_000;
const AUDIO_WAIT_MS = 1500; // the init segment waits this long for the audio track's config
const AUDIO_FLUSH_MS = 60; // audio fragments ride with the next video fragment, or go alone after this
const KEY_REQUEST_GAP_MS = 300;
const RETRY_MS = [1000, 3000, 8000, 15000];

// ---------- the ladder ----------

/** Output steps, best first. `scale` is the device scale behind the 1280×720 CSS viewport. */
export const LADDER = Object.freeze([
  { name: '2160p30', width: 3840, height: 2160, fps: 30, scale: 3,
    codecs: [{ family: 'hevc', encoder: 'hvc1.1.6.L153.B0', tv: 'hvc1.1.6.L153.B0' }, { family: 'avc', encoder: 'avc1.640033', tv: 'avc1.640033' }],
    bitrate: { start: 16e6, min: 6e6, max: 22e6 } },
  { name: '1080p60', width: 1920, height: 1080, fps: 60, scale: 1.5,
    codecs: [{ family: 'avc', encoder: 'avc1.64002A', tv: 'avc1.64002A' }, { family: 'hevc', encoder: 'hvc1.1.6.L123.B0', tv: 'hvc1.1.6.L120.B0' }],
    bitrate: { start: 8e6, min: 3e6, max: 12e6 } },
  { name: '720p60', width: 1280, height: 720, fps: 60, scale: 1,
    codecs: [{ family: 'avc', encoder: 'avc1.640028', tv: 'avc1.640028' }],
    bitrate: { start: 4e6, min: 1.5e6, max: 6e6 } },
]);

/** TV-side MIME types to ask the TV about (MediaSource.isTypeSupported) for the ladder. */
export const TV_CODEC_PROBES = [...new Set(LADDER.flatMap((r) => r.codecs.map((c) => c.tv)))];

/**
 * The steps this pair can use: the TV's MSE takes the codec (caps[tvCodec] true) and the PC's
 * encoder makes it (encoders[`${name}:${family}`] true when known), at most maxHeight.
 * → [{ ...step, codec }] best first.
 */
export function usableLadder({ caps = {}, encoders = null, maxHeight = 2160, preferHevc = true } = {}) {
  const out = [];
  for (const step of LADDER) {
    if (step.height > maxHeight) continue;
    const order = preferHevc ? step.codecs : [...step.codecs].sort((a, b) => (a.family === 'avc' ? -1 : 0) - (b.family === 'avc' ? -1 : 0));
    const codec = order.find((c) => caps[c.tv] === true && (!encoders || encoders[`${step.name}:${c.family}`] !== false));
    if (codec) out.push({ ...step, codec });
  }
  return out;
}

// ---------- muxer: encoded chunks → init segment + fragments ----------

const familyOf = (codec) => (/^(hvc1|hev1)/.test(codec) ? 'hevc' : 'avc');

/**
 * Turns the capture page's messages into fMP4. emit({ kind: 'init', buf, mime, codec, width, height,
 * fps, reset, audio }) and emit({ kind: 'media', track: 'video'|'audio', key, buf, time }).
 * One muxer per capture session: its timeline starts at the session's first key frame.
 */
export function createMuxer({ emit, now = () => Date.now() }) {
  let vcfg = null; // { codec, width, height, fps, format, config: avcC|hvcC|null }
  let acfg = null; // { sampleRate, channels, config }
  let sentInit = null; // signature of the init segment last emitted
  let family = null;
  let base = null; // µs of the first key frame
  let waitKey = true;
  let firstVideoAt = null;
  let seq = 1;
  let audioNext = null;
  let lastVideoTime = -1;

  function audioSpecificConfig(rate, channels) {
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const index = Math.max(0, rates.indexOf(rate));
    return Buffer.from([(2 << 3) | (index >> 1), ((index & 1) << 7) | (channels << 3)]);
  }

  function maybeInit(force = false) {
    if (!vcfg?.config) return false;
    const audioReady = !!acfg || force || (firstVideoAt !== null && now() - firstVideoAt >= AUDIO_WAIT_MS);
    if (!audioReady) return false;
    const codec = vcfg.format === 'annexb' ? hevcCodecString(vcfg.config) : avcCodecString(vcfg.config);
    const signature = `${codec}|${vcfg.width}x${vcfg.height}|${vcfg.config.toString('base64')}|${acfg ? acfg.config.toString('base64') : '-'}`;
    if (signature === sentInit) return true;
    const reset = sentInit === null || familyOf(codec) !== family;
    family = familyOf(codec);
    sentInit = signature;
    const buf = initSegment({ video: { codec, width: vcfg.width, height: vcfg.height, config: vcfg.config }, audio: acfg });
    waitKey = true;
    emit({ kind: 'init', buf, codec, mime: mimeType(codec, !!acfg), width: vcfg.width, height: vcfg.height, fps: vcfg.fps, reset, audio: !!acfg });
    return true;
  }

  return {
    videoConfig(msg) {
      const description = msg.description ? Buffer.from(msg.description, 'base64') : null;
      const next = { codec: msg.codec, width: msg.width, height: msg.height, fps: msg.fps || 60, format: msg.format === 'annexb' ? 'annexb' : 'avc' };
      // HEVC's record is built from the parameter sets of the next key frame.
      next.config = next.format === 'avc' ? description : (vcfg?.format === 'annexb' && vcfg.width === next.width && vcfg.height === next.height ? vcfg.config : null);
      vcfg = next;
      maybeInit();
    },
    audioConfig(msg) {
      const sampleRate = msg.sampleRate || 48000;
      const channels = msg.channels || 2;
      const config = msg.description ? Buffer.from(msg.description, 'base64') : audioSpecificConfig(sampleRate, channels);
      acfg = { sampleRate, channels, config, bitrate: 128000 };
      maybeInit();
    },
    video(ts, key, data) {
      if (!vcfg) return;
      if (firstVideoAt === null) firstVideoAt = now();
      let sample = data;
      if (vcfg.format === 'annexb') {
        const units = splitAnnexB(data);
        if (key) {
          const hvcC = buildHvcC(units);
          if (hvcC) vcfg.config = hvcC;
        }
        sample = lengthPrefixed(units.filter((u) => !HEVC_PARAMETER_SETS.has(hevcNalType(u))));
      }
      if (!maybeInit()) return;
      if (waitKey && !key) return;
      waitKey = false;
      if (base === null) base = ts;
      let time = Math.round(((ts - base) * VIDEO_TIMESCALE) / 1e6);
      if (time <= lastVideoTime) time = lastVideoTime + 1;
      if (time < 0) return;
      lastVideoTime = time;
      const duration = Math.round(VIDEO_TIMESCALE / (vcfg.fps || 60));
      emit({ kind: 'media', track: 'video', key, time: time / VIDEO_TIMESCALE, buf: fragment({ seq: seq++, track: VIDEO_TRACK, time, duration, data: sample, key }) });
    },
    audio(ts, data) {
      if (!acfg) return;
      if (base === null || sentInit === null || waitKey) { maybeInit(); return; }
      const rate = acfg.sampleRate;
      const fromTs = Math.round(((ts - base) * rate) / 1e6);
      if (fromTs < 0) return;
      // AAC frames are 1024 samples: consecutive frames butt up against each other unless the clock
      // jumped (a gap in the capture), so the TV's player never sees overlaps or hairline gaps.
      const time = audioNext !== null && Math.abs(fromTs - audioNext) < 2048 ? audioNext : fromTs;
      audioNext = time + 1024;
      emit({ kind: 'media', track: 'audio', key: true, time: time / rate, buf: fragment({ seq: seq++, track: AUDIO_TRACK, time, duration: 1024, data }) });
    },
    /** The capture page's encoders were (re)configured: the next frame starts with a key frame. */
    tick() { if (!sentInit) maybeInit(); },
    /** µs (capture-page clock) of media time 0, or null before the first key frame. */
    get base() { return base; },
    get initSent() { return sentInit !== null; },
  };
}

// ---------- transport to the TV ----------

// Binary messages on the agent socket: 'L' 'V' 'I' 0, u32 gen, u16 JSON length, JSON, init segment;
// 'L' 'V' 'M' flags (1 = starts with a key frame), u32 gen, fragments. (JPEG frames start 0xFF 0xD8.)
export function initMessage(gen, info, buf) {
  const json = Buffer.from(JSON.stringify(info));
  const head = Buffer.alloc(10);
  head.write('LVI', 0, 'latin1');
  head.writeUInt32BE(gen, 4);
  head.writeUInt16BE(json.length, 8);
  return Buffer.concat([head, json, buf]);
}
export function mediaMessage(gen, key, bufs) {
  const head = Buffer.alloc(8);
  head.write('LVM', 0, 'latin1');
  head[3] = key ? 1 : 0;
  head.writeUInt32BE(gen, 4);
  return Buffer.concat([head, ...bufs]);
}
/** Parses a message made by initMessage/mediaMessage (tests, diagnostics). */
export function parseMessage(buf) {
  const tag = buf.toString('latin1', 0, 3);
  if (tag === 'LVI') {
    const len = buf.readUInt16BE(8);
    return { kind: 'init', gen: buf.readUInt32BE(4), info: JSON.parse(buf.toString('utf8', 10, 10 + len)), data: buf.subarray(10 + len) };
  }
  if (tag === 'LVM') return { kind: 'media', gen: buf.readUInt32BE(4), key: (buf[3] & 1) === 1, data: buf.subarray(8) };
  return null;
}

/**
 * Viewers of the stream. A viewer is { send(buf, { key, limit }) → boolean } (false: not sent, the
 * link is backed up). Each viewer gets the current init segment when it joins, then fragments from
 * the next key frame; one that cannot keep up skips to the next key frame. requestKey() asks the
 * encoder for one (joins and skips need it).
 */
export function createFanout({ requestKey, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, limitBytes = () => 512 * 1024 }) {
  const viewers = new Map(); // viewer → { needKey, audio: [], paused, sentInitGen, drops, sentBytes, timer }
  let init = null; // { gen, info, buf }
  let gen = 0;
  let lastKeyRequest = 0;

  function askKey() {
    const t = now();
    if (t - lastKeyRequest < KEY_REQUEST_GAP_MS) return;
    lastKeyRequest = t;
    requestKey();
  }

  function sendInit(viewer, state, reset = false) {
    if (!init) return;
    const info = { ...init.info, reset: reset || init.info.reset };
    if (viewer.send(initMessage(init.gen, info, init.buf), { key: true, init: true, limit: Infinity })) state.sentInitGen = init.gen;
    state.needKey = true;
    state.audio = [];
  }

  function flushAudio(viewer, state) {
    clearTimer(state.timer);
    state.timer = null;
    if (!state.audio.length || state.needKey || state.paused) { state.audio = []; return; }
    const msg = mediaMessage(gen, false, state.audio);
    state.audio = [];
    if (viewer.send(msg, { key: false, limit: limitBytes() })) state.sentBytes += msg.length;
    else { state.drops += 1; state.needKey = true; askKey(); }
  }

  return {
    add(viewer) {
      const state = { needKey: true, audio: [], paused: false, sentInitGen: -1, drops: 0, sentBytes: 0, timer: null };
      viewers.set(viewer, state);
      sendInit(viewer, state, true);
      askKey();
      return state;
    },
    remove(viewer) {
      const state = viewers.get(viewer);
      if (state) clearTimer(state.timer);
      viewers.delete(viewer);
    },
    pause(viewer) {
      const state = viewers.get(viewer);
      if (!state) return;
      state.paused = true;
      state.audio = [];
    },
    /** Back after a pause (the TV's own player was in front): a fresh player from a key frame. */
    resume(viewer) {
      const state = viewers.get(viewer);
      if (!state || !state.paused) return;
      state.paused = false;
      sendInit(viewer, state, true);
      askKey();
    },
    /** Asks for a key frame and starts the viewer over from it (the TV's player lost its place). */
    resync(viewer) {
      const state = viewers.get(viewer);
      if (!state) return;
      sendInit(viewer, state, true);
      askKey();
    },
    onInit(next) {
      gen += 1;
      init = { gen, info: { mime: next.mime, codec: next.codec, width: next.width, height: next.height, fps: next.fps, audio: next.audio, reset: next.reset }, buf: next.buf };
      for (const [viewer, state] of viewers) if (!state.paused) sendInit(viewer, state);
    },
    onMedia(m) {
      for (const [viewer, state] of viewers) {
        if (state.paused || state.sentInitGen !== gen) {
          if (!state.paused && init && state.sentInitGen !== gen) sendInit(viewer, state);
          continue;
        }
        if (m.track === 'audio') {
          if (state.needKey) continue;
          state.audio.push(m.buf);
          if (!state.timer) state.timer = setTimer(() => { state.timer = null; flushAudio(viewer, state); }, AUDIO_FLUSH_MS);
          continue;
        }
        if (state.needKey && !m.key) { askKey(); continue; }
        const parts = [...state.audio, m.buf];
        state.audio = [];
        clearTimer(state.timer);
        state.timer = null;
        const msg = mediaMessage(gen, m.key, parts);
        // A key frame may go over the limit once the link has drained a little; anything else is
        // skipped while the link is backed up, and the viewer restarts from the next key frame.
        if (viewer.send(msg, { key: m.key, limit: m.key ? limitBytes() * 2 : limitBytes() })) {
          state.needKey = false;
          state.sentBytes += msg.length;
        } else {
          state.drops += 1;
          state.needKey = true;
          askKey();
        }
      }
    },
    /** Per-viewer counters since the last call: { drops, sentBytes }. */
    takeStats(viewer) {
      const state = viewers.get(viewer);
      if (!state) return null;
      const out = { drops: state.drops, sentBytes: state.sentBytes, needKey: state.needKey };
      state.drops = 0;
      state.sentBytes = 0;
      return out;
    },
    get size() { return viewers.size; },
    get gen() { return gen; },
  };
}

// ---------- rate control ----------

/**
 * Picks the bitrate and the ladder step from what the link and the TV report each second.
 * tick({ drops, queueSec, stalls, dropRatio, refused }) → { bitrate?, step? } (changes only).
 */
export function createRateControl({ ladder, startIndex = 0 }) {
  let index = Math.min(startIndex, ladder.length - 1);
  let bitrate = ladder[index].bitrate.start;
  let good = 0;
  let bad = 0;
  let decodeBad = 0;
  let lowered = null; // { from, at: tick count, cause }
  let ticks = 0;
  let upWait = 45;
  const blocked = new Set(); // steps the TV refused or could not decode

  function moveTo(next, cause) {
    if (next === index || next < 0 || next >= ladder.length) return null;
    if (next > index) lowered = { from: index, at: ticks, cause };
    index = next;
    bitrate = Math.min(ladder[index].bitrate.start, ladder[index].bitrate.max);
    good = bad = decodeBad = 0;
    return { step: index, bitrate };
  }

  return {
    get index() { return index; },
    get step() { return ladder[index]; },
    get bitrate() { return bitrate; },
    tick({ drops = 0, queueSec = 0, stalls = 0, dropRatio = 0, refused = false } = {}) {
      ticks += 1;
      if (refused) {
        blocked.add(index);
        const next = ladder.findIndex((_, i) => i > index && !blocked.has(i));
        return next < 0 ? { exhausted: true } : moveTo(next, 'refused');
      }
      if (dropRatio > 0.1) decodeBad += 1; else decodeBad = 0;
      if (decodeBad >= 3) {
        blocked.add(index);
        const next = ladder.findIndex((_, i) => i > index && !blocked.has(i));
        if (next >= 0) return moveTo(next, 'decode');
        decodeBad = 0;
      }
      const congested = drops > 0 || queueSec > 0.35 || stalls > 0;
      const { min, max } = ladder[index].bitrate;
      if (congested) {
        good = 0;
        bad += 1;
        if (bitrate > min) {
          bitrate = Math.max(min, Math.round(bitrate * 0.7));
          return { bitrate };
        }
        if (bad >= 3 && index < ladder.length - 1) return moveTo(index + 1, 'congestion');
        return null;
      }
      bad = 0;
      good += 1;
      // A step lowered for congestion is tried again after a quiet while (longer each time).
      if (lowered && lowered.cause === 'congestion' && ticks - lowered.at >= upWait && good >= 10 && !blocked.has(lowered.from)) {
        upWait = Math.min(upWait * 2, 600);
        const back = lowered.from;
        lowered = null;
        return moveTo(back, 'up');
      }
      if (good >= 8 && bitrate < max) {
        good = 0;
        bitrate = Math.min(max, Math.round(bitrate * 1.15));
        return { bitrate };
      }
      return null;
    },
  };
}

// ---------- the feature ----------

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let next = 1;
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('DevTools connection closed'));
        const id = next++;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => pending.set(id, { res, rej, method }));
      },
      close() { try { ws.close(); } catch { /* gone */ } },
    }));
    ws.addEventListener('error', () => reject(new Error('DevTools connection failed')));
    ws.addEventListener('close', () => { for (const p of pending.values()) p.rej(new Error(`${p.method}: closed`)); pending.clear(); });
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      const p = msg.id && pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`));
      else p.res(msg.result);
    });
  });
}

async function evaluate(cdp, expression, { gesture = false } = {}) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: gesture });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split('\n')[0] ?? exceptionDetails.text);
  return result?.value;
}

export function createLiveVideo({ config, log: rootLog, store, browser }) {
  const log = rootLog.child('livevideo');
  const settings = { enabled: false, maxHeight: 2160, preferHevc: true, idleStopMs: 15_000, gopSeconds: 2, ...config.liveVideo };
  const token = randomBytes(24).toString('hex');
  let server = null; // loopback HTTP + WebSocket server for the capture page
  let wss = null;
  let port = null;
  let page = null; // the capture page's WebSocket
  let pageWaiters = [];
  let captureTarget = null; // { id, cdp }
  let capturing = null; // in-flight start → resolves when chunks flow
  let muxer = null;
  let ladder = [];
  let rate = null;
  let encoders = null; // PC encoder support per step (probed once per browser session)
  let caps = {};
  let stopTimer = null;
  let retry = 0;
  let retryTimer = null;
  let statsTimer = null;
  let lastStats = null;
  let pageClock = null; // wall-clock ms of the capture page's timestamp 0
  let stopped = false;
  const viewers = new Map(); // viewer → { tvStats, refused }

  const publish = (value) => store.set('tvscreen.live', value, { src: 'derived', via: 'livevideo' });
  const fanout = createFanout({
    requestKey: () => sendPage({ t: 'key' }),
    limitBytes: () => Math.max(256 * 1024, Math.round(((rate?.bitrate ?? 8e6) / 8) * 0.3)),
  });

  function sendPage(msg) {
    if (page && page.readyState === 1) page.send(JSON.stringify(msg));
  }

  // ---- loopback server ----

  async function ensureServer() {
    if (server) return;
    const html = fs.readFileSync(CAPTURE_PAGE);
    wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/capture' || url.searchParams.get('t') !== token) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
    });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/ws' || url.searchParams.get('t') !== token) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, onPage);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    port = server.address().port;
  }

  function onPage(ws) {
    if (page) page.close();
    page = ws;
    ws.on('message', (raw, isBinary) => {
      if (ws !== page) return;
      if (isBinary) { onChunk(raw); return; }
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      onPageMessage(msg);
    });
    ws.on('close', () => {
      if (ws !== page) return;
      page = null;
      onCaptureLost('the capture page closed');
    });
  }

  function onPageMessage(msg) {
    if (msg.t === 'hello') { pageClock = typeof msg.clock === 'number' ? msg.clock : null; const w = pageWaiters; pageWaiters = []; w.forEach((fn) => fn()); }
    else if (msg.t === 'vconfig') muxer?.videoConfig(msg);
    else if (msg.t === 'aconfig') muxer?.audioConfig(msg);
    else if (msg.t === 'stats') lastStats = msg;
    else if (msg.t === 'ended') onCaptureLost('the capture ended');
    else if (msg.t === 'error') log.warn('capture page error', { where: String(msg.where).slice(0, 40), message: String(msg.message).slice(0, 200) });
  }

  function onChunk(buf) {
    if (!muxer || buf.length < 12) return;
    const kind = buf[0];
    const ts = buf.readDoubleLE(4);
    const data = buf.subarray(12);
    if (kind === 2) muxer.video(ts, (buf[1] & 1) === 1, data);
    else if (kind === 4) muxer.audio(ts, data);
  }

  // ---- capture lifecycle ----

  function waitForPage() {
    if (page) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the capture page did not connect')), HELLO_TIMEOUT_MS);
      pageWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  function encoderProbes() {
    return LADDER.flatMap((s) => s.codecs.map((c) => ({ key: `${s.name}:${c.family}`, codec: c.encoder, width: s.width, height: s.height, fps: s.fps, bitrate: s.bitrate.start })));
  }

  function stepConfig(step, bitrate) {
    return { t: 'config', codec: step.codec.encoder, width: step.width, height: step.height, fps: step.fps, bitrate, gop: Math.round(step.fps * settings.gopSeconds) };
  }

  async function startCapture() {
    const feature = browser();
    if (!feature?.devtools) throw new LumenError('UNAVAILABLE', 'Lumen’s browser is not available');
    await feature.ensureRunning();
    const dt = feature.devtools();
    if (!dt) throw new LumenError('UNAVAILABLE', 'The browser is not open');
    await ensureServer();
    muxer = createMuxer({ emit: onMuxed });
    if (!captureTarget) {
      const target = await (await fetch(`http://127.0.0.1:${dt.port}/json/new?http://127.0.0.1:${port}/capture?t=${token}`, { method: 'PUT' })).json();
      captureTarget = { id: target.id, cdp: await connectCdp(target.webSocketDebuggerUrl), devPort: dt.port };
    }
    await waitForPage();
    const cdp = captureTarget.cdp;
    if (!encoders) encoders = await evaluate(cdp, `lumenEncoders(${JSON.stringify(encoderProbes())})`).catch(() => null);
    ladder = usableLadder({ caps, encoders, maxHeight: settings.maxHeight, preferHevc: settings.preferHevc });
    if (!ladder.length) throw new LumenError('UNAVAILABLE', 'The TV’s player takes none of the stream formats this PC can encode');
    if (!rate || rate.index >= ladder.length) rate = createRateControl({ ladder });
    const step = rate.step;
    await feature.setTvScale(step.scale);
    // Edge picks the tab to capture by its title: the page carries the capture title for a moment.
    const main = await connectCdp(`ws://127.0.0.1:${dt.port}/devtools/page/${dt.targetId}`);
    let started;
    try {
      const saved = await evaluate(main, 'document.title');
      await evaluate(main, `document.title = ${JSON.stringify(CAPTURE_TITLE)}`);
      try {
        started = await evaluate(cdp, `lumenStart(${JSON.stringify({ width: step.width, height: step.height, fps: step.fps })})`, { gesture: true });
      } finally {
        await evaluate(main, `document.title = ${JSON.stringify(saved ?? '')}`).catch(() => {});
      }
    } finally {
      main.close();
    }
    await feature.fitContents().catch((err) => log.debug('could not size the page for capture', { message: err.message }));
    sendPage(stepConfig(step, rate.bitrate));
    retry = 0;
    log.info('live video started', { step: step.name, codec: step.codec.family, bitrate: rate.bitrate, audio: started?.audio ?? false });
    publishState('starting');
  }

  function ensureCapture() {
    if (page && muxer && !capturing) return Promise.resolve();
    capturing ??= startCapture()
      .catch((err) => { log.warn('live video could not start', { message: err.message }); stopCapture(); throw err; })
      .finally(() => { capturing = null; });
    return capturing;
  }

  function stopCapture() {
    clearTimeout(retryTimer);
    retryTimer = null;
    sendPage({ t: 'stop' });
    const target = captureTarget;
    captureTarget = null;
    if (target) {
      fetch(`http://127.0.0.1:${target.devPort}/json/close/${target.id}`).catch(() => {});
      target.cdp.close();
    }
    page?.close();
    page = null;
    muxer = null;
    browser()?.fitContents?.({ restore: true }).catch(() => {});
  }

  function onCaptureLost(reason) {
    const wasRunning = !!muxer;
    stopCapture();
    if (!wasRunning || stopped || !viewers.size) return;
    const delay = RETRY_MS[Math.min(retry, RETRY_MS.length - 1)];
    retry += 1;
    log.info('live video lost; restarting', { reason, inMs: delay });
    publishState('restarting');
    retryTimer = setTimeout(() => { ensureCapture().catch(() => {}); }, delay);
  }

  // ---- muxer output ----

  function onMuxed(m) {
    if (m.kind === 'init') {
      log.info('live video stream', { codec: m.codec, size: `${m.width}x${m.height}`, fps: m.fps, audio: m.audio, reset: m.reset });
      fanout.onInit(m);
      publishState('streaming');
    } else fanout.onMedia(m);
  }

  // ---- rate control: once a second ----

  function controlTick() {
    if (!rate) { publishState(); return; }
    for (const [viewer, v] of viewers) {
      const sent = fanout.takeStats(viewer);
      const tv = v.tvStats;
      v.tvStats = null;
      const decodedDelta = tv && v.prevTv ? tv.decoded - v.prevTv.decoded : 0;
      const droppedDelta = tv && v.prevTv ? tv.dropped - v.prevTv.dropped : 0;
      if (tv) v.prevTv = tv;
      const signals = {
        drops: sent?.drops ?? 0,
        queueSec: viewer.buffered ? viewer.buffered() / Math.max(1, rate.bitrate / 8) : 0,
        stalls: tv && v.prevStalls !== undefined ? Math.max(0, tv.stalls - v.prevStalls) : 0,
        dropRatio: decodedDelta > 20 ? droppedDelta / (decodedDelta + droppedDelta) : 0,
        refused: v.refused,
      };
      if (tv) v.prevStalls = tv.stalls;
      v.refused = false;
      v.last = { ...signals, kbps: sent ? Math.round((sent.sentBytes * 8) / 1000) : 0, lagMs: tv?.lag != null ? Math.round(tv.lag * 1000) : null };
      const change = rate.tick(signals);
      if (change?.exhausted) { v.onFallback?.('The TV could not play the live video'); continue; }
      if (change?.step !== undefined) {
        const step = rate.step;
        log.info('live video step', { step: step.name, codec: step.codec.family, bitrate: rate.bitrate, why: signals });
        browser()?.setTvScale?.(step.scale);
        sendPage(stepConfig(step, rate.bitrate));
      } else if (change?.bitrate) sendPage({ t: 'bitrate', bitrate: rate.bitrate });
    }
    publishState();
  }

  let state = 'off';
  function publishState(next = state) {
    state = next;
    if (!viewers.size && state !== 'off') state = 'off';
    const first = [...viewers.values()][0]?.last ?? null;
    const step = rate?.step;
    publish(state === 'off' ? { state: 'off' } : {
      state, step: step?.name ?? null, codec: step?.codec.family ?? null, bitrate: rate?.bitrate ?? null,
      kbps: first?.kbps ?? null, lagMs: first?.lagMs ?? null, fps: lastStats ? Math.round((lastStats.frames + lastStats.repeats) / 2) : null,
    });
  }

  // ---- API ----

  /**
   * A TV viewer: { send(buf, { key, limit }) → boolean, buffered() → bytes, onFallback(reason) }.
   * tvCaps: { [tv codec string]: boolean } from the TV's MediaSource.isTypeSupported.
   * → { pause(), resume(), resync(), report(stats), refused(), detach() }.
   */
  function attach(viewer, tvCaps = {}) {
    if (!settings.enabled) throw new LumenError('UNAVAILABLE', 'Live video is turned off');
    clearTimeout(stopTimer);
    stopTimer = null;
    const changedCaps = JSON.stringify(tvCaps) !== JSON.stringify(caps);
    caps = { ...tvCaps };
    if (changedCaps) rate = null;
    viewers.set(viewer, { tvStats: null, refused: false, onFallback: viewer.onFallback });
    fanout.add(viewer);
    statsTimer ??= setInterval(controlTick, 1000);
    // New caps (another TV, an agent update) choose the ladder again.
    if (changedCaps && page) { stopCapture(); }
    ensureCapture().catch((err) => viewer.onFallback?.(err.message));
    publishState('starting');
    return {
      pause: () => fanout.pause(viewer),
      resume: () => fanout.resume(viewer),
      resync: () => fanout.resync(viewer),
      report: (stats) => { const v = viewers.get(viewer); if (v) v.tvStats = stats; },
      refused: () => { const v = viewers.get(viewer); if (v) v.refused = true; },
      detach: () => detach(viewer),
    };
  }

  function detach(viewer) {
    if (!viewers.delete(viewer)) return;
    fanout.remove(viewer);
    if (viewers.size) return;
    clearInterval(statsTimer);
    statsTimer = null;
    publishState('off');
    // A viewer that comes straight back (the TV's player closed, the agent reconnected) finds the
    // capture still running.
    stopTimer = setTimeout(() => { if (!viewers.size) stopCapture(); }, settings.idleStopMs);
    stopTimer.unref?.();
  }

  return {
    attach,
    enabled: () => settings.enabled === true,
    codecProbes: () => TV_CODEC_PROBES.slice(),
    /** Wall-clock ms of media time 0 of the current stream (diagnostics: latency measurements). */
    timeline: () => ({ baseWallMs: pageClock !== null && muxer?.base != null ? pageClock + muxer.base / 1000 : null }),
    start() { publish({ state: 'off' }); },
    async stop() {
      stopped = true;
      clearTimeout(stopTimer);
      clearInterval(statsTimer);
      stopCapture();
      if (server) {
        for (const client of wss?.clients ?? []) client.terminate();
        const closing = new Promise((resolve) => server.close(() => resolve()));
        server.closeAllConnections?.();
        await closing;
      }
      server = null;
    },
    setDemand() {},
  };
}
