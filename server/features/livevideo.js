// Live video of Lumen's browser for the TV: instead of still JPEG frames, the page is captured inside
// Lumen's own headless Edge (a second tab, livecapture.html, captures the browsing tab with its sound
// through getDisplayMedia), encoded there by the PC's hardware encoder (WebCodecs: H.264, or HEVC for
// 4K; AAC audio), and the encoded chunks come to Lumen over a loopback-only WebSocket. Lumen packs
// them as fragmented MP4 (server/util/fmp4.js), a few frames per fragment, and hands them to the TV
// agent, whose MSE player (companion/agent/live.js) plays them at the live edge. A viewer that joins,
// falls behind or comes back gets a fresh key frame; the bitrate and resolution follow what the link
// and the TV keep up with. The Q95T's web engine is slow (Chromium 69, a weak CPU, ~500 MB free), so
// the stream starts at 1080p30, goes down to 720p30 and 540p30, and tries 4K only after a long quiet
// spell when allowed. tvscreen.js keeps the JPEG frames as the fallback.
import http from 'node:http';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { LumenError } from '../errors.js';
import { CAPTURE_TITLE } from './browser.js';
import {
  initSegment, fragmentBatch, mimeType, avcCodecString, hevcCodecString, buildHvcC, splitAnnexB, lengthPrefixed,
  hevcNalType, HEVC_PARAMETER_SETS, VIDEO_TRACK, AUDIO_TRACK, VIDEO_TIMESCALE,
} from '../util/fmp4.js';

const CAPTURE_PAGE = new URL('./livecapture.html', import.meta.url);
const HELLO_TIMEOUT_MS = 10_000;
const AUDIO_WAIT_MS = 1500; // the init segment waits this long for the audio track's config
const KEY_REQUEST_GAP_MS = 300;
const RETRY_MS = [1000, 3000, 8000, 15000];
// getDisplayMedia waits for a picker that headless Edge never shows when no tab carries the title
// (the page changed its title in that moment): the attempt is abandoned and tried again.
const PICK_TIMEOUT_MS = 6000;
export const FRAGMENT_MS = 160; // media per fragment (one WebSocket message): ~6 messages a second
// The TV reports once every 2 s: nothing for this long counts against the step, and for the longer
// time the TV goes back to frames (its page is starved or frozen).
const STATS_LATE_MS = 5000;
const STATS_GONE_MS = 12000;
const STATS_GRACE_MS = 10000; // the start: before the TV's player is up
// Video on its way to the TV (sent, its pong not back) beyond this many seconds is congestion: one
// fragment plus the round trip is normal.
const QUEUE_LIMIT_SEC = 0.6;

// ---------- the ladder ----------

/**
 * Output steps, best first. `scale` is the device scale behind the 1280×720 CSS viewport; `probe`
 * steps are never started at, only tried after a quiet spell on the step below (1080p30, then
 * 1080p60, then 4K; maxHeight 1080 leaves 4K out, maxFps 30 leaves 60 out).
 */
export const LADDER = Object.freeze([
  { name: '2160p30', width: 3840, height: 2160, fps: 30, scale: 3, probe: true,
    codecs: [{ family: 'hevc', encoder: 'hvc1.1.6.L153.B0', tv: 'hvc1.1.6.L153.B0' }, { family: 'avc', encoder: 'avc1.640033', tv: 'avc1.640033' }],
    bitrate: { start: 14e6, min: 6e6, max: 20e6 } },
  // 60 frames a second at 1080p (level 4.2 / HEVC 4.1): tried after a quiet spell at 1080p30.
  { name: '1080p60', width: 1920, height: 1080, fps: 60, scale: 1.5, probe: true,
    codecs: [{ family: 'avc', encoder: 'avc1.64002A', tv: 'avc1.64002A' }, { family: 'hevc', encoder: 'hvc1.1.6.L123.B0', tv: 'hvc1.1.6.L123.B0' }],
    bitrate: { start: 8e6, min: 4e6, max: 12e6 } },
  { name: '1080p30', width: 1920, height: 1080, fps: 30, scale: 1.5,
    codecs: [{ family: 'avc', encoder: 'avc1.640028', tv: 'avc1.640028' }, { family: 'hevc', encoder: 'hvc1.1.6.L123.B0', tv: 'hvc1.1.6.L120.B0' }],
    bitrate: { start: 5e6, min: 2e6, max: 8e6 } },
  { name: '720p30', width: 1280, height: 720, fps: 30, scale: 1,
    codecs: [{ family: 'avc', encoder: 'avc1.64001F', tv: 'avc1.640028' }],
    bitrate: { start: 3e6, min: 1.2e6, max: 4.5e6 } },
  { name: '540p30', width: 960, height: 540, fps: 30, scale: 1,
    codecs: [{ family: 'avc', encoder: 'avc1.64001F', tv: 'avc1.640028' }],
    bitrate: { start: 1.8e6, min: 0.8e6, max: 2.5e6 } },
]);

/** TV-side MIME types to ask the TV about (MediaSource.isTypeSupported) for the ladder. */
export const TV_CODEC_PROBES = [...new Set(LADDER.flatMap((r) => r.codecs.map((c) => c.tv)))];

/**
 * The steps this pair can use: the TV's MSE takes the codec (caps[tvCodec] true) and the PC's
 * encoder makes it (encoders[`${name}:${family}`] true when known), at most maxHeight.
 * → [{ ...step, codec }] best first.
 */
export function usableLadder({ caps = {}, encoders = null, maxHeight = 1080, maxFps = 60, preferHevc = true } = {}) {
  const out = [];
  for (const step of LADDER) {
    if (step.height > maxHeight || step.fps > maxFps) continue;
    const order = preferHevc ? step.codecs : [...step.codecs].sort((a, b) => (a.family === 'avc' ? -1 : 0) - (b.family === 'avc' ? -1 : 0));
    const codec = order.find((c) => caps[c.tv] === true && (!encoders || encoders[`${step.name}:${c.family}`] !== false));
    if (codec) out.push({ ...step, codec });
  }
  return out;
}

/** Where a ladder starts: the first step that is not a probe, `lower` steps further down. */
export function startIndexOf(ladder, lower = 0) {
  const first = ladder.findIndex((s) => !s.probe);
  return Math.min(ladder.length - 1, Math.max(0, first) + Math.max(0, lower));
}

// ---------- muxer: encoded chunks → init segment + fragments ----------

const familyOf = (codec) => (/^(hvc1|hev1)/.test(codec) ? 'hevc' : 'avc');

/**
 * Turns the capture page's messages into fMP4. emit({ kind: 'init', buf, mime, codec, width, height,
 * fps, reset, audio }) and emit({ kind: 'media', key, buf, time }): one fragment per ~fragmentMs of
 * media (video and audio together), each starting at a key frame when there is one, so the TV appends
 * a few large pieces a second instead of one per frame. One muxer per capture session: its timeline
 * starts at the session's first key frame.
 */
export function createMuxer({ emit, now = () => Date.now(), fragmentMs = FRAGMENT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
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
  let batch = null; // { video: [{ time, data, key }], audio: [{ time, data }], since }
  let flushTimer = null;

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
    flush(); // what was packed for the old init goes first
    const reset = sentInit === null || familyOf(codec) !== family;
    family = familyOf(codec);
    sentInit = signature;
    const buf = initSegment({ video: { codec, width: vcfg.width, height: vcfg.height, config: vcfg.config }, audio: acfg });
    waitKey = true;
    emit({ kind: 'init', buf, codec, mime: mimeType(codec, !!acfg), width: vcfg.width, height: vcfg.height, fps: vcfg.fps, reset, audio: !!acfg });
    return true;
  }

  function flush() {
    clearTimer(flushTimer);
    flushTimer = null;
    const b = batch;
    batch = null;
    if (!b || (!b.video.length && !b.audio.length)) return;
    const nominal = Math.round(VIDEO_TIMESCALE / (vcfg?.fps || 30));
    const video = b.video.map((s, i) => ({ data: s.data, key: s.key, duration: i + 1 < b.video.length ? Math.max(1, b.video[i + 1].time - s.time) : nominal }));
    const tracks = [];
    if (video.length) tracks.push({ track: VIDEO_TRACK, time: b.video[0].time, samples: video });
    if (b.audio.length) tracks.push({ track: AUDIO_TRACK, time: b.audio[0].time, samples: b.audio.map((s) => ({ data: s.data, key: true, duration: 1024 })) });
    const key = !!b.video[0]?.key;
    const time = b.video.length ? b.video[0].time / VIDEO_TIMESCALE : b.audio[0].time / (acfg?.sampleRate || 48000);
    emit({ kind: 'media', key, time, buf: fragmentBatch({ seq: seq++, tracks }) });
  }

  function add(kind, sample) {
    batch ??= { video: [], audio: [], since: now() };
    batch[kind].push(sample);
    // A still page or a lost video frame: the audio does not wait for long.
    flushTimer ??= setTimer(() => { flushTimer = null; flush(); }, fragmentMs * 2);
  }

  const span = () => (batch?.video.length ? ((lastVideoTime - batch.video[0].time) * 1000) / VIDEO_TIMESCALE : 0);

  return {
    videoConfig(msg) {
      const description = msg.description ? Buffer.from(msg.description, 'base64') : null;
      const next = { codec: msg.codec, width: msg.width, height: msg.height, fps: msg.fps || 30, format: msg.format === 'annexb' ? 'annexb' : 'avc' };
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
      // A key frame starts a fragment of its own, so a viewer can start (or restart) there.
      if (key && batch?.video.length) flush();
      lastVideoTime = time;
      add('video', { time, data: sample, key });
      if (span() >= fragmentMs - 500 / (vcfg.fps || 30)) flush();
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
      if (audioNext !== null && time !== audioNext && batch?.audio.length) flush(); // a gap ends the run
      audioNext = time + 1024;
      add('audio', { time, data });
    },
    /** Sends what is packed now (tests; the end of a stream). */
    flush,
    /** µs (capture-page clock) of media time 0, or null before the first key frame. */
    get base() { return base; },
    get initSent() { return sentInit !== null; },
    stop() { clearTimer(flushTimer); flushTimer = null; batch = null; },
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
export function createFanout({ requestKey, now = () => Date.now(), limitBytes = () => 512 * 1024 }) {
  const viewers = new Map(); // viewer → { needKey, paused, sentInitGen, drops, sentBytes }
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
  }

  return {
    add(viewer) {
      const state = { needKey: true, paused: false, sentInitGen: -1, drops: 0, sentBytes: 0 };
      viewers.set(viewer, state);
      sendInit(viewer, state, true);
      askKey();
      return state;
    },
    remove(viewer) { viewers.delete(viewer); },
    pause(viewer) {
      const state = viewers.get(viewer);
      if (state) state.paused = true;
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
      init = { gen, info: { mime: next.mime, tvMime: next.tvMime ?? null, codec: next.codec, width: next.width, height: next.height, fps: next.fps, audio: next.audio, reset: next.reset }, buf: next.buf };
      for (const [viewer, state] of viewers) if (!state.paused) sendInit(viewer, state);
    },
    onMedia(m) {
      for (const [viewer, state] of viewers) {
        if (state.paused) continue;
        if (state.sentInitGen !== gen) { if (init) sendInit(viewer, state); continue; }
        if (state.needKey && !m.key) { askKey(); continue; }
        const msg = mediaMessage(gen, m.key, [m.buf]);
        // A fragment that starts with a key frame may go over the limit once the link has drained a
        // little; anything else is skipped while the link is backed up, and the viewer restarts from
        // the next key frame.
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
    /** The stream ended (the capture stopped): its init segment is not given to anyone any more. */
    clear() { init = null; },
    get size() { return viewers.size; },
    get gen() { return gen; },
  };
}

// ---------- rate control ----------

/**
 * Picks the bitrate and the ladder step from what the link and the TV report each second.
 * tick({ drops, queueSec, stalls, dropRatio, refused, statsLate }) → { bitrate?, step? } (changes
 * only), or { exhausted: true } when no step is left. Starts at startIndex (never at a probe step);
 * a probe step above is tried once after probeAfter quiet seconds and dropped at its first trouble.
 */
const PROBE_GRACE_TICKS = 4;

export function createRateControl({ ladder, startIndex = startIndexOf(ladder), probeAfter = 90 }) {
  let index = Math.min(startIndex, ladder.length - 1);
  let bitrate = ladder[index].bitrate.start;
  let good = 0;
  let bad = 0;
  let decodeBad = 0;
  let lowered = null; // { from, at: tick count, cause }
  let probing = null; // { from, at }
  let ticks = 0;
  let upWait = 45;
  const blocked = new Set(); // steps the TV refused or could not keep up with

  function moveTo(next, cause) {
    if (next === index || next < 0 || next >= ladder.length) return null;
    if (next > index && cause !== 'probe-failed') lowered = { from: index, at: ticks, cause };
    index = next;
    bitrate = Math.min(ladder[index].bitrate.start, ladder[index].bitrate.max);
    good = bad = decodeBad = 0;
    return { step: index, bitrate, cause };
  }
  const below = () => ladder.findIndex((_, i) => i > index && !blocked.has(i));

  return {
    get index() { return index; },
    get step() { return ladder[index]; },
    get bitrate() { return bitrate; },
    tick({ drops = 0, queueSec = 0, stalls = 0, dropRatio = 0, refused = false, statsLate = false } = {}) {
      ticks += 1;
      const trouble = refused || drops > 0 || queueSec > QUEUE_LIMIT_SEC || stalls > 0 || dropRatio > 0.1 || statsLate;
      // A probe step goes at its first trouble, for good: after a few seconds of grace, since the
      // switch itself (a new size from a key frame, maybe a new player on the TV) comes in a burst.
      if (probing && trouble && !refused && ticks - probing.at <= PROBE_GRACE_TICKS) return null;
      if (probing && trouble) {
        blocked.add(index);
        const back = probing.from;
        probing = null;
        return moveTo(back, 'probe-failed');
      }
      if (probing && ticks - probing.at > 30) probing = null; // it held: it is the step now
      if (refused) {
        blocked.add(index);
        const next = below();
        return next < 0 ? { exhausted: true } : moveTo(next, 'refused');
      }
      if (dropRatio > 0.1) decodeBad += 1; else decodeBad = 0;
      if (decodeBad >= 3) {
        blocked.add(index);
        const next = below();
        if (next >= 0) return moveTo(next, 'decode');
        decodeBad = 0;
      }
      const congested = drops > 0 || queueSec > QUEUE_LIMIT_SEC || stalls > 0 || statsLate;
      const { min, max } = ladder[index].bitrate;
      if (congested) {
        good = 0;
        if (bitrate > min) {
          bitrate = Math.max(min, Math.round(bitrate * 0.7));
          return { bitrate };
        }
        bad += 1; // congested at the floor of this step
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
      // A probe step above (60 fps, 4K) once the stream has been quiet for a long while.
      let up = index - 1; // the nearest probe step above that has not failed
      while (up >= 0 && ladder[up].probe && blocked.has(up)) up -= 1;
      if (!lowered && up >= 0 && ladder[up].probe && good >= probeAfter) {
        const from = index;
        const change = moveTo(up, 'probe');
        probing = { from, at: ticks };
        return change;
      }
      if (good % 8 === 0 && bitrate < max) {
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
  const settings = { enabled: false, maxHeight: 1080, maxFps: 60, probeAfterSec: 30, preferHevc: true, idleStopMs: 15_000, gopSeconds: 1, fragmentMs: FRAGMENT_MS,
    statsLateMs: STATS_LATE_MS, statsGoneMs: STATS_GONE_MS, statsGraceMs: STATS_GRACE_MS, ...config.liveVideo };
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
  let startLower = 0;
  let stopped = false;
  const viewers = new Map(); // viewer → { tvStats, refused }

  const publish = (value) => store.set('tvscreen.live', value, { src: 'derived', via: 'livevideo' });
  const fanout = createFanout({
    requestKey: () => sendPage({ t: 'key' }),
    // Bytes on their way to the TV (sent, not yet confirmed by the TV's pong): about 0.6 s of video.
    limitBytes: () => Math.max(384 * 1024, Math.round(((rate?.bitrate ?? 5e6) / 8) * 0.6)),
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
    muxer?.stop();
    muxer = createMuxer({ emit: onMuxed, fragmentMs: settings.fragmentMs });
    if (!captureTarget) {
      const target = await (await fetch(`http://127.0.0.1:${dt.port}/json/new?http://127.0.0.1:${port}/capture?t=${token}`, { method: 'PUT' })).json();
      captureTarget = { id: target.id, cdp: await connectCdp(target.webSocketDebuggerUrl), devPort: dt.port };
    }
    await waitForPage();
    const cdp = captureTarget.cdp;
    if (!encoders) encoders = await evaluate(cdp, `lumenEncoders(${JSON.stringify(encoderProbes())})`).catch(() => null);
    ladder = usableLadder({ caps, encoders, maxHeight: settings.maxHeight, maxFps: settings.maxFps, preferHevc: settings.preferHevc });
    if (!ladder.length) throw new LumenError('UNAVAILABLE', 'The TV’s player takes none of the stream formats this PC can encode');
    if (!rate || rate.index >= ladder.length) rate = createRateControl({ ladder, startIndex: startIndexOf(ladder, startLower), probeAfter: settings.probeAfterSec });
    const step = rate.step;
    await feature.setTvScale(step.scale);
    // Edge picks the tab to capture by its title: the page carries the capture title for a moment.
    const main = await connectCdp(`ws://127.0.0.1:${dt.port}/devtools/page/${dt.targetId}`);
    let started;
    try {
      const saved = await evaluate(main, 'document.title');
      await evaluate(main, `document.title = ${JSON.stringify(CAPTURE_TITLE)}`);
      let pickTimer = null;
      try {
        started = await Promise.race([
          evaluate(cdp, `lumenStart(${JSON.stringify({ width: step.width, height: step.height, fps: step.fps })})`, { gesture: true }),
          new Promise((_, reject) => { pickTimer = setTimeout(() => reject(new Error('the tab capture did not start')), PICK_TIMEOUT_MS); }),
        ]);
      } finally {
        clearTimeout(pickTimer);
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
    muxer?.stop();
    muxer = null;
    fanout.clear();
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
    retryTimer = setTimeout(() => { ensureCapture().catch(startFailed); }, delay);
  }

  // A start that failed is tried again a few times (spaced out); then the TV goes back to frames.
  // Nothing the TV can play is not retried.
  function startFailed(err) {
    if (stopped || !viewers.size) return;
    const hopeless = err instanceof LumenError && /none of the stream formats|turned off/.test(err.message);
    if (!hopeless && retry < RETRY_MS.length) {
      const delay = RETRY_MS[retry];
      retry += 1;
      publishState('restarting');
      retryTimer = setTimeout(() => { ensureCapture().catch(startFailed); }, delay);
      return;
    }
    retry = 0;
    for (const v of [...viewers.values()]) v.onFallback?.(`live video could not start: ${err.message}`);
  }

  // ---- muxer output ----

  function onMuxed(m) {
    if (m.kind === 'init') {
      log.info('live video stream', { codec: m.codec, size: `${m.width}x${m.height}`, fps: m.fps, audio: m.audio, reset: m.reset });
      // The encoder's exact codec string (HEVC can come out as High tier) and the one the TV said it
      // takes for this step: the TV's player uses the first it accepts.
      const tv = rate?.step?.codec?.tv;
      fanout.onInit({ ...m, tvMime: tv && familyOf(tv) === familyOf(m.codec) ? mimeType(tv, m.audio) : null });
      publishState('streaming');
    } else fanout.onMedia(m);
  }

  // ---- rate control: once a second ----

  function controlTick() {
    if (!rate) { publishState(); return; }
    for (const [viewer, v] of viewers) {
      if (v.paused) continue;
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
      // The TV reports every 2 s once it plays (10 s allowed for the start). A TV that stops
      // reporting is starved or frozen: the stream gets lighter, and then it goes back to frames.
      const quietMs = Date.now() - (v.lastStatsAt ?? v.since + settings.statsGraceMs);
      if (quietMs > settings.statsGoneMs) { log.warn('the TV stopped reporting on the live video', { quietMs }); v.onFallback?.('the TV stopped reporting'); continue; }
      signals.statsLate = quietMs > settings.statsLateMs;
      v.refused = false;
      v.last = { ...signals, kbps: sent ? Math.round((sent.sentBytes * 8) / 1000) : 0, lagMs: tv?.lag != null ? Math.round(tv.lag * 1000) : (v.last?.lagMs ?? null),
        // Frames the TV decoded per second (it reports every 2 s).
        tvFps: tv && decodedDelta > 0 ? Math.round(decodedDelta / 2) : (v.last?.tvFps ?? null) };
      const change = rate.tick(signals);
      if (change?.exhausted) { v.onFallback?.('The TV could not play the live video'); continue; }
      if (change?.step !== undefined) {
        const step = rate.step;
        log.info('live video step', { step: step.name, codec: step.codec.family, bitrate: rate.bitrate, why: signals });
        browser()?.setTvScale?.(step.scale);
        sendPage(stepConfig(step, rate.bitrate));
      } else if (change?.bitrate) {
        log.debug('live video bitrate', { bitrate: rate.bitrate, why: signals });
        sendPage({ t: 'bitrate', bitrate: rate.bitrate });
      }
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
      kbps: first?.kbps ?? null, lagMs: first?.lagMs ?? null, tvFps: first?.tvFps ?? null, fps: lastStats ? Math.round((lastStats.frames + lastStats.repeats) / 2) : null,
      // Loudest captured sample over the last 2 s (0..1); 0 for a silent page; null without sound.
      audioPeak: typeof lastStats?.audioPeak === 'number' ? Math.round(lastStats.audioPeak * 1000) / 1000 : null,
    });
  }

  // ---- API ----

  /**
   * A TV viewer: { send(buf, { key, limit }) → boolean, buffered() → bytes, onFallback(reason) }.
   * tvCaps: { [tv codec string]: boolean } from the TV's MediaSource.isTypeSupported.
   * options.lower: start this many steps below the usual start (the TV's page died on live video before).
   * → { pause(), resume(), resync(), report(stats), refused(), detach() }.
   */
  function attach(viewer, tvCaps = {}, options = {}) {
    if (!settings.enabled) throw new LumenError('UNAVAILABLE', 'Live video is turned off');
    clearTimeout(stopTimer);
    stopTimer = null;
    const changedCaps = JSON.stringify(tvCaps) !== JSON.stringify(caps);
    caps = { ...tvCaps };
    const lower = Math.max(0, Number(options.lower) || 0);
    const rechoose = changedCaps || lower !== startLower;
    if (rechoose) rate = null;
    startLower = lower;
    // New caps (another TV, an agent update) or a lower start choose the ladder again.
    if (rechoose && page) stopCapture();
    viewers.set(viewer, { tvStats: null, refused: false, onFallback: viewer.onFallback, since: Date.now(), lastStatsAt: null });
    fanout.add(viewer);
    statsTimer ??= setInterval(controlTick, 1000);
    ensureCapture().catch(startFailed);
    // A capture still running (the TV came straight back) is already streaming.
    publishState(page && muxer?.initSent ? 'streaming' : 'starting');
    return {
      pause: () => { const v = viewers.get(viewer); if (v) v.paused = true; fanout.pause(viewer); },
      resume: () => { const v = viewers.get(viewer); if (v) { v.paused = false; v.since = Date.now(); v.lastStatsAt = null; } fanout.resume(viewer); },
      resync: () => fanout.resync(viewer),
      report: (stats) => { const v = viewers.get(viewer); if (v) { v.tvStats = stats; v.lastStatsAt = Date.now(); } },
      refused: () => { const v = viewers.get(viewer); if (v) { v.refused = true; v.since = Date.now(); v.lastStatsAt = null; } },
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
