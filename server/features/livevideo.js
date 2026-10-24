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
import { CAPTURE_TITLE, TV_VIEWPORT } from './browser.js';
import {
  initSegment, fragmentBatch, mimeType, avcCodecString, hevcCodecString, buildHvcC, splitAnnexB, lengthPrefixed,
  hevcNalType, tfdtOffsets, silentAacFrame, HEVC_PARAMETER_SETS, VIDEO_TRACK, AUDIO_TRACK, VIDEO_TIMESCALE,
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

/**
 * The size a capture is started at (getDisplayMedia): the step's, but never below the page's CSS
 * size. Edge lays a captured tab that goes full screen out at the size the capture started with
 * (limited to the screen, see browser.js screenArg); a smaller one showed only part of the page,
 * blown up. The step's own size follows at once (its config message applies it).
 */
export function captureRequest(step) {
  const small = step.width < TV_VIEWPORT.w || step.height < TV_VIEWPORT.h;
  return small ? { width: TV_VIEWPORT.w, height: TV_VIEWPORT.h, fps: step.fps } : { width: step.width, height: step.height, fps: step.fps };
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
 * fps, reset, audio }) and emit({ kind: 'media', key, buf, time, seq, tracks, video, audio,
 * audioRate }): one fragment per ~fragmentMs of media (video and audio together), each starting at a
 * key frame when there is one, so the TV appends a few large pieces a second instead of one per
 * frame. `tracks` is what fragmentBatch built it from; video { time, end } and audio { time, end,
 * samples } are in track ticks (90 kHz; the audio sample rate), so a viewer's copy can be rebased.
 * One muxer per capture session: its timeline starts at the session's first key frame. A gap of a
 * second or more in the video (the encoder died and came back) starts a new stream (a reset init)
 * at the next key frame instead of leaving a hole the TV's player would stall at.
 */
const EARLY_AUDIO_US = 1.5e6; // audio held while waiting for a key frame: at most this much

export function createMuxer({ emit, now = () => Date.now(), fragmentMs = FRAGMENT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let vcfg = null; // { codec, width, height, fps, format, config: avcC|hvcC|null }
  let acfg = null; // { sampleRate, channels, config }
  let sentInit = null; // signature of the init segment last emitted
  let family = null;
  let base = null; // µs of the first key frame
  let waitKey = true;
  let resetPending = false; // a gap in the video: a new stream from the next key frame
  let firstVideoAt = null;
  let seq = 1;
  let audioNext = null;
  let videoNext = null; // where the video sent so far ends (90 kHz)
  let lastVideoTime = -1;
  let batch = null; // { video: [{ time, data, key }], audio: [{ time, data }], since }
  let flushTimer = null;
  // Audio that came while waiting for a key frame (the capture's audio starts before the hardware
  // encoder's first key frame; a step change waits for one too): [{ ts, data }], the last ~1.5 s.
  let early = [];

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
    // The video runs on without seams: a fragment starts where the last one ended (the last frame of a
    // fragment only has a nominal duration, and a page captured at a low rate is further apart than
    // that). This TV's player stalls at even a short gap, and its recovery seeks can kill its page.
    let start = b.video.length ? b.video[0].time : 0;
    if (b.video.length && videoNext !== null && Math.abs(start - videoNext) < VIDEO_TIMESCALE) start = videoNext;
    const video = b.video.map((s, i) => ({ data: s.data, key: s.key,
      duration: i + 1 < b.video.length ? Math.max(1, b.video[i + 1].time - (i === 0 ? start : s.time)) : nominal }));
    if (video.length) videoNext = start + video.reduce((sum, v) => sum + v.duration, 0);
    const tracks = [];
    if (video.length) tracks.push({ track: VIDEO_TRACK, time: start, samples: video });
    if (b.audio.length) tracks.push({ track: AUDIO_TRACK, time: b.audio[0].time, samples: b.audio.map((s) => ({ data: s.data, key: true, duration: 1024 })) });
    const key = !!b.video[0]?.key;
    const audioRate = acfg?.sampleRate || 48000;
    const time = b.video.length ? start / VIDEO_TIMESCALE : b.audio[0].time / audioRate;
    const n = seq++;
    emit({ kind: 'media', key, time, seq: n, tracks, audioRate, audioChannels: acfg?.channels ?? 2, buf: fragmentBatch({ seq: n, tracks }),
      video: video.length ? { time: start, end: videoNext } : null,
      audio: b.audio.length ? { time: b.audio[0].time, end: b.audio[0].time + 1024 * b.audio.length, samples: b.audio.map((s) => s.data) } : null });
  }

  // AAC frames are 1024 samples: consecutive frames butt up against each other unless the clock
  // jumped (a gap in the capture), so the TV's player never sees overlaps or hairline gaps.
  function admitAudio(ts, data) {
    const rate = acfg.sampleRate;
    const fromTs = Math.round(((ts - base) * rate) / 1e6);
    if (fromTs < 0) return;
    const time = audioNext !== null && Math.abs(fromTs - audioNext) < 2048 ? audioNext : fromTs;
    if (audioNext !== null && time !== audioNext && batch?.audio.length) flush(); // a gap ends the run
    audioNext = time + 1024;
    add('audio', { time, data });
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
      if (base === null) base = ts;
      let time = Math.round(((ts - base) * VIDEO_TIMESCALE) / 1e6);
      if (time <= lastVideoTime) time = lastVideoTime + 1;
      if (time < 0) return;
      // A second or more without video (the encoder failed and came back): the seam would be a
      // hole in the TV's buffer, so a new stream (a fresh player on the TV) starts at the next key
      // frame. Shorter gaps are closed by the flush (videoNext).
      if (lastVideoTime >= 0 && time - lastVideoTime >= VIDEO_TIMESCALE) resetPending = true;
      if (resetPending) {
        if (!key) return;
        resetPending = false;
        flush();
        sentInit = null;
        maybeInit(true);
      }
      const held = waitKey;
      waitKey = false;
      // A key frame starts a fragment of its own, so a viewer can start (or restart) there.
      if (key && batch?.video.length) flush();
      if (held) {
        // The audio that came while waiting rides with this key frame (none before media time 0).
        const list = early;
        early = [];
        for (const a of list) admitAudio(a.ts, a.data);
      }
      lastVideoTime = time;
      add('video', { time, data: sample, key });
      if (span() >= fragmentMs - 500 / (vcfg.fps || 30)) flush();
    },
    audio(ts, data) {
      if (!acfg) return;
      if (base === null || sentInit === null || waitKey) {
        early.push({ ts, data });
        while (early.length && ts - early[0].ts > EARLY_AUDIO_US) early.shift();
        maybeInit();
        return;
      }
      admitAudio(ts, data);
    },
    /** Sends what is packed now (tests; the end of a stream). */
    flush,
    /** µs (capture-page clock) of media time 0, or null before the first key frame. */
    get base() { return base; },
    get initSent() { return sentInit !== null; },
    stop() { clearTimer(flushTimer); flushTimer = null; batch = null; early = []; },
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
 *
 * A skip must not leave a hole in the viewer's timeline (this TV's player stalls at a 33 ms gap, and
 * seeking over one gets its page killed), so each viewer has its own timeline: after a skip, its
 * fragments are moved back (tfdt) to butt up against what it already has, video exactly, audio to
 * the nearest whole AAC frame of the video's shift (a silent frame or two filled in, or a frame or two
 * left out), so lip sync stays within half a frame (±10.7 ms) and never drifts. A fresh player (a
 * reset init) starts on the stream's own timeline again. The same skip sheds lag: a TV that reports
 * itself well behind skips to the next key frame instead of seeking.
 */
const LAG_SHED_SEC = 1.5; // a TV this far behind on two reports in a row skips ahead ...
const LAG_CALM_SEC = 1; // ... until it reports less than this
const SHED_GAP_MS = 1000; // at most one skip per key interval
const AAC_FRAME = 1024;

export function createFanout({ requestKey, now = () => Date.now(), limitBytes = () => 512 * 1024 }) {
  // viewer → { needKey, paused, sentInitGen, initAt, drops, sentBytes, and its timeline: vShift,
  // aShift (track ticks added to the stream's times), vEnd, aEnd (where what it has ends, on its
  // timeline), rebase (the next key fragment is moved back), audioRebase, lagHigh, shedding, ... }
  const viewers = new Map();
  let init = null; // { gen, info, buf }
  let gen = 0;
  let lastKeyRequest = 0;

  function askKey() {
    const t = now();
    if (t - lastKeyRequest < KEY_REQUEST_GAP_MS) return;
    lastKeyRequest = t;
    requestKey();
  }

  function freshTimeline(state) {
    state.vShift = 0;
    state.aShift = 0;
    state.vEnd = null;
    state.aEnd = null;
    state.rebase = false;
    state.audioRebase = null; // { ideal }: the audio's shift is settled at the next fragment with audio
    state.lastAudio = null;
    state.shedding = false;
  }

  function sendInit(viewer, state, reset = false) {
    if (!init) return;
    const isReset = reset || !!init.info.reset;
    const info = { ...init.info, reset: isReset };
    if (viewer.send(initMessage(init.gen, info, init.buf), { key: true, init: true, limit: Infinity })) {
      state.sentInitGen = init.gen;
      state.initAt = now();
    }
    state.needKey = true;
    if (isReset) freshTimeline(state); // a new player: the stream's own timeline
  }

  const readTime = (buf, at) => Number(buf.readBigUInt64BE(at));
  const writeTime = (buf, at, v) => buf.writeBigUInt64BE(BigInt(Math.max(0, Math.round(v))), at);

  /**
   * This viewer's copy of fragment `m` → { msg, commit } (commit: its timeline once it is sent).
   * offsetsOf() gives the tfdt offsets in m.buf (found once per fragment).
   */
  function viewerCopy(m, state, offsetsOf) {
    const v = m.video ?? null;
    const a = m.audio ?? null;
    let { vShift, aShift, audioRebase } = state;
    if (m.key && state.rebase && v && state.vEnd !== null) {
      // After a skip: this key fragment's video starts exactly where the viewer's video ends.
      vShift = state.vEnd - v.time;
      audioRebase = { ideal: Math.round((vShift * (m.audioRate || 48000)) / VIDEO_TIMESCALE) };
    }
    let audioRun = null; // a changed audio run: { time, samples }
    let aEnd = state.aEnd;
    let lastAudio = state.lastAudio;
    if (a) {
      let fill = 0;
      if (audioRebase) {
        // Audio follows on exactly too, shifted by the whole number of frames nearest the video's shift.
        if (state.aEnd !== null) {
          const contiguous = state.aEnd - a.time;
          const frames = Math.round((audioRebase.ideal - contiguous) / AAC_FRAME);
          aShift = contiguous + frames * AAC_FRAME;
          if (frames > 0) fill = frames;
        } else aShift = audioRebase.ideal;
        audioRebase = null;
      }
      let samples = a.samples;
      let start = a.time + aShift;
      let changed = false;
      if (fill) {
        const silent = silentAacFrame(m.audioChannels ?? 2) ?? state.lastAudio ?? samples[0];
        samples = [...Array(fill).fill(silent), ...samples];
        start -= fill * AAC_FRAME;
        changed = true;
      } else if (state.aEnd !== null && start < state.aEnd - AAC_FRAME / 2) {
        // Audio this viewer already has (the shift rounded down): those frames are left out.
        const drop = Math.min(samples.length, Math.round((state.aEnd - start) / AAC_FRAME));
        samples = samples.slice(drop);
        start += drop * AAC_FRAME;
        changed = drop > 0;
      }
      if (changed) audioRun = { time: start, samples };
      if (samples.length) {
        aEnd = start + samples.length * AAC_FRAME;
        lastAudio = samples[samples.length - 1];
      }
    }
    const commit = { vShift, aShift, audioRebase, aEnd, lastAudio, vEnd: v ? v.end + vShift : state.vEnd };
    let msg;
    if (audioRun && m.tracks) {
      const tracks = [];
      for (const t of m.tracks) {
        if (t.track === VIDEO_TRACK) tracks.push({ ...t, time: Math.max(0, t.time + vShift) });
        else if (t.track === AUDIO_TRACK && audioRun.samples.length) {
          tracks.push({ track: AUDIO_TRACK, time: Math.max(0, audioRun.time), samples: audioRun.samples.map((data) => ({ data, key: true, duration: AAC_FRAME })) });
        }
      }
      msg = mediaMessage(gen, m.key, [fragmentBatch({ seq: m.seq ?? 0, tracks })]);
    } else {
      msg = mediaMessage(gen, m.key, [m.buf]); // a copy: the shifts go into it
      if (vShift || aShift) {
        const offsets = offsetsOf();
        const head = msg.length - m.buf.length;
        if (offsets[VIDEO_TRACK] !== undefined && vShift) writeTime(msg, head + offsets[VIDEO_TRACK], readTime(m.buf, offsets[VIDEO_TRACK]) + vShift);
        if (offsets[AUDIO_TRACK] !== undefined && aShift) writeTime(msg, head + offsets[AUDIO_TRACK], readTime(m.buf, offsets[AUDIO_TRACK]) + aShift);
      }
    }
    return { msg, commit };
  }

  return {
    add(viewer) {
      const state = { needKey: true, paused: false, sentInitGen: -1, initAt: null, drops: 0, sentBytes: 0, lagHigh: 0, shedAt: 0, sheds: 0 };
      freshTimeline(state);
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
      let offsets = null;
      const offsetsOf = () => (offsets ??= tfdtOffsets(m.buf));
      for (const [viewer, state] of viewers) {
        if (state.paused) continue;
        if (state.sentInitGen !== gen) { if (init) sendInit(viewer, state); continue; }
        // Skipping to the next key frame: after a drop one is asked for; shedding lag waits for the
        // stream's own (the skip is what sheds the lag).
        if (state.needKey && !m.key) { if (!state.shedding) askKey(); continue; }
        const { msg, commit } = viewerCopy(m, state, offsetsOf);
        // A fragment that starts with a key frame may go over the limit once the link has drained a
        // little; anything else is skipped while the link is backed up, and the viewer restarts from
        // the next key frame, its timeline moved back to close the gap.
        if (viewer.send(msg, { key: m.key, limit: m.key ? limitBytes() * 2 : limitBytes() })) {
          Object.assign(state, commit);
          state.needKey = false;
          state.rebase = false;
          state.shedding = false;
          state.sentBytes += msg.length;
        } else {
          state.drops += 1;
          state.needKey = true;
          state.rebase = true;
          state.shedding = false;
          askKey();
        }
      }
    },
    /**
     * The TV's reported lag (s, every 2 s). Well behind on two reports in a row, the viewer skips to
     * the next key frame (rebased: no hole), once per report, until it is back under a second.
     * → true when a skip was started.
     */
    noteLag(viewer, lag) {
      const state = viewers.get(viewer);
      if (!state || state.paused || typeof lag !== 'number' || !Number.isFinite(lag)) return false;
      if (lag < LAG_CALM_SEC) { state.lagHigh = 0; return false; }
      if (lag <= LAG_SHED_SEC) return false;
      state.lagHigh += 1;
      if (state.lagHigh < 2 || state.needKey || state.vEnd === null || now() - state.shedAt < SHED_GAP_MS) return false;
      state.needKey = true;
      state.rebase = true;
      state.shedding = true;
      state.shedAt = now();
      state.sheds += 1;
      return true;
    },
    /** A viewer's timeline against the stream's: { video (90 kHz ticks), audio (samples), sheds }. */
    shifts(viewer) {
      const state = viewers.get(viewer);
      return state ? { video: state.vShift, audio: state.aShift, sheds: state.sheds } : null;
    },
    /** Per-viewer counters since the last call: { drops, sentBytes, needKey, initAt }. */
    takeStats(viewer) {
      const state = viewers.get(viewer);
      if (!state) return null;
      const out = { drops: state.drops, sentBytes: state.sentBytes, needKey: state.needKey, initAt: state.initAt };
      state.drops = 0;
      state.sentBytes = 0;
      return out;
    },
    /** The stream ended (the capture stopped): its init segment is not given to anyone any more. */
    clear() {
      init = null;
      for (const state of viewers.values()) state.initAt = null;
    },
    get size() { return viewers.size; },
    get gen() { return gen; },
  };
}

// ---------- rate control ----------

/**
 * Picks the bitrate and the ladder step from what the link says every second and the TV reports
 * every 2 s. tick({ drops, queueSec, statsLate (the PC's side, every tick), tvFresh, stalls, jumps,
 * resyncs, lag, dropRatio (the TV's report, when one came: tvFresh), refused, refusedIndex,
 * runtimeError }) → { bitrate?, step?, cause? } (changes only), { resync: true } (start the viewer's
 * player over), or { exhausted: true } when no step is left. Starts at startIndex (never at a probe
 * step); a probe step above is tried once after probeAfter quiet seconds and dropped at its first
 * trouble (a TV that lags on its reports included). The TV's signals are judged over its last
 * reports, not per tick: a tick without a report neither clears them nor counts as quiet. A format
 * the TV refused, a failed probe and a failing encoder block their step for good; a step left for
 * dropped frames, repeated player errors or a TV player that asks to start over again within two
 * minutes (stuck, never started, failed while playing) is held for ten minutes and then tried again.
 */
const PROBE_GRACE_TICKS = 4;
const HOLD_MS = 10 * 60 * 1000;
const ERROR_WINDOW_MS = 10 * 60 * 1000;
const RESTART_AGAIN_MS = 2 * 60 * 1000;
const TV_LAG_TROUBLE_SEC = 1.5;
const UP_CAUSES = new Set(['congestion', 'decode', 'error']);

export function createRateControl({ ladder, startIndex = startIndexOf(ladder), probeAfter = 90, now = Date.now }) {
  let index = Math.min(startIndex, ladder.length - 1);
  let bitrate = ladder[index].bitrate.start;
  let good = 0;
  let bad = 0;
  const lowered = []; // steps left for a lower one, latest last: { from, at: tick count, cause }
  let probing = null; // { from, at }
  let ticks = 0;
  let upWait = 45;
  const blocked = new Set(); // for good: formats the TV refused, failed probes, failing encoders
  const held = new Map(); // step → until (ms): left for dropped frames or player errors
  let errors = []; // when the TV's player failed at run time (not its format)
  let restarts = []; // when the TV's player asked to start over at this step
  let tvHist = []; // the TV's last 3 reports: { stall, decode }
  let troubleHist = []; // the TV's last 4 reports: trouble of any kind
  let lastTvTrouble = false; // the latest report showed trouble (carried over ticks without one)

  const isHeld = (i) => (held.get(i) ?? 0) > now();
  function moveTo(next, cause) {
    if (next === index || next < 0 || next >= ladder.length) return null;
    if (next > index && cause !== 'probe-failed') lowered.push({ from: index, at: ticks, cause });
    // Only a probe starts a probe: any other move ends one (a step left while still on trial must
    // not leave the trial running on the step it went to).
    if (cause !== 'probe') probing = null;
    index = next;
    bitrate = Math.min(ladder[index].bitrate.start, ladder[index].bitrate.max);
    good = bad = 0;
    restarts = [];
    tvHist = [];
    troubleHist = [];
    lastTvTrouble = false;
    return { step: index, bitrate, cause };
  }
  const below = () => ladder.findIndex((_, i) => i > index && !blocked.has(i) && !isHeld(i));

  return {
    get index() { return index; },
    get step() { return ladder[index]; },
    get bitrate() { return bitrate; },
    tick({ drops = 0, queueSec = 0, stalls = 0, dropRatio = 0, refused = false, refusedIndex = null, statsLate = false,
      runtimeError = false, tvFresh = true, lag = null, jumps = 0, resyncs = 0 } = {}) {
      ticks += 1;
      let entry = null;
      if (tvFresh) {
        const lagging = typeof lag === 'number' && lag > TV_LAG_TROUBLE_SEC;
        entry = { stall: stalls > 0 || jumps > 0 || resyncs > 0 || lagging, decode: dropRatio > 0.1 };
        tvHist = [...tvHist, entry].slice(-3);
        troubleHist = [...troubleHist, entry.stall || entry.decode].slice(-4);
        lastTvTrouble = entry.stall || entry.decode;
      }
      const tvStalled = tvFresh && (stalls > 0 || jumps > 0 || resyncs > 0);
      // The TV's player stalls, restarts or lags on 2 of its last 3 reports.
      const tvCongested = !!entry && tvHist.filter((e) => e.stall).length >= 2;
      const trouble = refused || runtimeError || drops > 0 || queueSec > QUEUE_LIMIT_SEC || tvStalled || tvCongested || dropRatio > 0.1 || statsLate;
      // A probe step goes at its first trouble, for good: after a few seconds of grace, since the
      // switch itself (a new size from a key frame, maybe a new player on the TV) comes in a burst.
      if (probing && trouble && !refused && !runtimeError && ticks - probing.at <= PROBE_GRACE_TICKS) return null;
      if (probing && trouble) {
        blocked.add(index);
        const back = probing.from;
        probing = null;
        return moveTo(back, 'probe-failed');
      }
      if (probing && ticks - probing.at > 30) probing = null; // it held: it is the step now
      if (refused) {
        // The step the refusal came in on (the stream may have changed step since).
        const at = Number.isInteger(refusedIndex) ? refusedIndex : index;
        blocked.add(at);
        if (at !== index) return { resync: true };
        const next = below();
        return next < 0 ? { exhausted: true } : moveTo(next, 'refused');
      }
      if (runtimeError) {
        // The TV's player failed while playing (it was started over already): a second time within
        // ten minutes, the step is held for ten minutes and the next one down is used.
        const t = now();
        errors = [...errors.filter((x) => t - x < ERROR_WINDOW_MS), t];
        if (errors.length >= 2) {
          errors = [];
          held.set(index, t + HOLD_MS);
          const next = below();
          return next < 0 ? { exhausted: true } : moveTo(next, 'error');
        }
      }
      // The TV's player asked to start over (it got stuck, never started, or failed while playing; the
      // PC started it over already): again within two minutes at this step, the step is held for ten
      // minutes and the next one down is used. Never for good: a slow start (the TV's one decoder just
      // released by its own player) or two bad minutes must not cost a step until the server restarts.
      if (resyncs > 0) {
        const t = now();
        restarts = [...restarts.filter((x) => t - x < RESTART_AGAIN_MS), ...new Array(resyncs).fill(t)];
        const next = below();
        if (restarts.length >= 2 && next >= 0) {
          held.set(index, t + HOLD_MS);
          return moveTo(next, 'error');
        }
      }
      // Dropped frames on 2 of the TV's last 3 reports: it cannot decode this step.
      if (entry && tvHist.filter((e) => e.decode).length >= 2) {
        const next = below();
        if (next >= 0) {
          held.set(index, now() + HOLD_MS);
          return moveTo(next, 'decode');
        }
      }
      // Nothing left below and still in trouble on 3 of the TV's last 4 reports.
      if (entry && below() < 0 && troubleHist.filter(Boolean).length >= 3) return { exhausted: true };
      // Congestion: the link (dropped or queued fragments, a late report) or the TV's player (stalls,
      // restarts or lag on 2 of its last 3 reports). The bitrate goes down to the step's floor, then
      // the step: at once for the TV, after 3 seconds at the floor for the link.
      const pcCongested = drops > 0 || queueSec > QUEUE_LIMIT_SEC || statsLate;
      const { min, max } = ladder[index].bitrate;
      if (pcCongested || tvCongested) {
        good = 0;
        if (bitrate > min) {
          bitrate = Math.max(min, Math.round(bitrate * 0.7));
          return { bitrate };
        }
        if (tvCongested) return moveTo(below(), 'congestion');
        bad += 1; // congested at the floor of this step
        if (bad >= 3) return moveTo(below(), 'congestion');
        return null;
      }
      // The TV's latest report showed trouble: no credit, no climb, no probe until a clean one.
      if (lastTvTrouble) return null;
      bad = 0;
      good += 1;
      // A step left for congestion is tried again after a quiet while (longer each time); one left for
      // dropped frames or player errors once its hold is over. Steps blocked for good are passed over.
      while (lowered.length && blocked.has(lowered[lowered.length - 1].from)) lowered.pop();
      const last = lowered[lowered.length - 1];
      if (last && UP_CAUSES.has(last.cause) && good >= 10 && !isHeld(last.from) && (last.cause !== 'congestion' || ticks - last.at >= upWait)) {
        if (last.cause === 'congestion') upWait = Math.min(upWait * 2, 600);
        lowered.pop();
        return moveTo(last.from, 'up');
      }
      // A probe step above (60 fps, 4K) once the stream has been quiet for a long while.
      let up = index - 1; // the nearest probe step above that has not failed
      while (up >= 0 && ladder[up].probe && blocked.has(up)) up -= 1;
      if (!lowered.length && up >= 0 && ladder[up].probe && good >= probeAfter) {
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
    /** The PC's encoder keeps failing at this step: it is blocked for good and the next one down used. */
    encoderFailed() {
      probing = null;
      blocked.add(index);
      const next = below();
      return next < 0 ? { exhausted: true } : moveTo(next, 'encoder');
    },
  };
}

// ---------- the feature ----------

// A browser that hangs (Edge closing or crashed under a DevTools call) must not hang the start: every
// DevTools step has a time limit, and an attempt that runs out ends in the usual retries.
const BROWSER_TIMEOUT_MS = 8000;

function connectCdp(url, timeoutMs = BROWSER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let next = 1;
    const timer = setTimeout(() => { reject(new Error('the browser did not answer')); try { ws.close(); } catch { /* gone */ } }, timeoutMs);
    ws.addEventListener('open', () => clearTimeout(timer));
    ws.addEventListener('error', () => clearTimeout(timer));
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

async function evaluate(cdp, expression, { gesture = false, timeoutMs = BROWSER_TIMEOUT_MS } = {}) {
  let timer = null;
  const answer = cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: gesture });
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the browser did not answer')), timeoutMs); });
  const { result, exceptionDetails } = await Promise.race([answer, late]).finally(() => clearTimeout(timer));
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split('\n')[0] ?? exceptionDetails.text);
  return result?.value;
}

const ENCODER_ERRORS_MAX = 3; // video encoder failures within ENCODER_ERROR_WINDOW_MS: the step is dropped
const ENCODER_ERROR_WINDOW_MS = 60_000;
const BACKSTOP_LAG_SEC = 6; // the TV this far behind on 3 reports in a row: back to frames
const SLOW_DECODE_SHARE = 0.4; // the TV decoding under this share of the frames sent is slow
const SLOW_DECODE_REPORTS = 3; // slow on this many reports in a row (2 s each): a fresh player
const SLOW_DECODE_GAP_MS = 30000; // at most one such restart this often

export function createLiveVideo({ config, log: rootLog, store, browser }) {
  const log = rootLog.child('livevideo');
  const settings = { enabled: false, maxHeight: 1080, maxFps: 60, probeAfterSec: 30, preferHevc: true, idleStopMs: 15_000, gopSeconds: 1, fragmentMs: FRAGMENT_MS,
    statsLateMs: STATS_LATE_MS, statsGoneMs: STATS_GONE_MS, statsGraceMs: STATS_GRACE_MS,
    // Internal timings (tests shorten them).
    // noStreamMs: a capture that is up and has sent no stream for this long is started again (default
    // statsGraceMs + statsGoneMs, the time a TV that went quiet gets).
    pickTimeoutMs: PICK_TIMEOUT_MS, retryMs: RETRY_MS, browserTimeoutMs: BROWSER_TIMEOUT_MS, controlMs: 1000, noStreamMs: null, ...config.liveVideo };
  const ev = (cdp, expression, opts = {}) => evaluate(cdp, expression, { timeoutMs: settings.browserTimeoutMs, ...opts });
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
  let rechooseNext = false; // resetRate(): the next viewer starts on a new rate controller
  let stopped = false;
  let emptyStats = 0; // capture reports in a row with frames but no encoded bytes
  let encoderErrors = []; // times of video encoder failures the capture page did not recover from
  let captureUpAt = null; // when the running capture started (lumenStart answered); null while none runs
  let noStreamRestarted = false; // a capture that sent no stream was started again once already
  // viewer → { tvStats, prevTv, refused, refusedIndex, runtimeError, resyncs, since, lastStatsAt,
  // onFallback, onRestart, lagRun, stallHist, last, fellBack }
  const viewers = new Map();

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
    else if (msg.t === 'stats') onCaptureStats(msg);
    else if (msg.t === 'ended') onCaptureLost('the capture ended');
    else if (msg.t === 'error') onCaptureError(msg);
  }

  // The capture page encodes frames but nothing comes out (its encoder is gone or stuck): the step's
  // config makes it build a new one. The TV would otherwise show a frozen picture with sound.
  function onCaptureStats(msg) {
    lastStats = msg;
    if (msg.bytes === 0 && (Number(msg.frames) || 0) + (Number(msg.repeats) || 0) > 0) emptyStats += 1;
    else emptyStats = 0;
    if (emptyStats >= 2 && rate) {
      emptyStats = 0;
      log.warn('the capture encodes nothing; configuring its encoder again', { step: rate.step.name });
      sendPage(stepConfig(rate.step, rate.bitrate));
    }
  }

  // A video encoder that keeps failing at this step (a probe step whose encoder passed the support
  // check but fails at its real start): the step is dropped for good.
  function onCaptureError(msg) {
    const where = String(msg.where).slice(0, 40);
    log.warn('capture page error', { where, message: String(msg.message).slice(0, 200), recovered: msg.recovered === true });
    if (where !== 'video encoder' || msg.recovered === true || !rate) return;
    const t = Date.now();
    encoderErrors = [...encoderErrors.filter((x) => t - x < ENCODER_ERROR_WINDOW_MS), t];
    if (encoderErrors.length < ENCODER_ERRORS_MAX) return;
    encoderErrors = [];
    log.warn('the video encoder keeps failing; dropping the step', { step: rate.step.name });
    applyChange(rate.encoderFailed(), { encoder: true }, null, 'The PC could not encode the live video');
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
    emptyStats = 0;
    encoderErrors = [];
    if (!captureTarget) {
      const signal = AbortSignal.timeout(settings.browserTimeoutMs);
      const target = await (await fetch(`http://127.0.0.1:${dt.port}/json/new?http://127.0.0.1:${port}/capture?t=${token}`, { method: 'PUT', signal })).json();
      captureTarget = { id: target.id, cdp: await connectCdp(target.webSocketDebuggerUrl, settings.browserTimeoutMs), devPort: dt.port };
    }
    await waitForPage();
    const cdp = captureTarget.cdp;
    if (!encoders) encoders = await ev(cdp, `lumenEncoders(${JSON.stringify(encoderProbes())})`).catch(() => null);
    ladder = usableLadder({ caps, encoders, maxHeight: settings.maxHeight, maxFps: settings.maxFps, preferHevc: settings.preferHevc });
    if (!ladder.length) throw new LumenError('UNAVAILABLE', 'The TV’s player takes none of the stream formats this PC can encode');
    if (!rate || rate.index >= ladder.length) rate = createRateControl({ ladder, startIndex: startIndexOf(ladder, startLower), probeAfter: settings.probeAfterSec });
    const step = rate.step;
    await feature.setTvScale(step.scale);
    // Edge picks the tab to capture by its title: the page carries the capture title for a moment.
    const main = await connectCdp(`ws://127.0.0.1:${dt.port}/devtools/page/${dt.targetId}`, settings.browserTimeoutMs);
    let started;
    try {
      const saved = await ev(main, 'document.title');
      await ev(main, `document.title = ${JSON.stringify(CAPTURE_TITLE)}`);
      let pickTimer = null;
      try {
        started = await Promise.race([
          ev(cdp, `lumenStart(${JSON.stringify(captureRequest(step))})`, { gesture: true }),
          new Promise((_, reject) => { pickTimer = setTimeout(() => reject(new Error('the tab capture did not start')), settings.pickTimeoutMs); }),
        ]);
      } finally {
        clearTimeout(pickTimer);
        await ev(main, `document.title = ${JSON.stringify(saved ?? '')}`).catch(() => {});
      }
    } finally {
      main.close();
    }
    await feature.fitContents().catch((err) => log.debug('could not size the page for capture', { message: err.message }));
    sendPage(stepConfig(step, rate.bitrate));
    retry = 0;
    captureUpAt = Date.now();
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
    captureUpAt = null;
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
    const delay = settings.retryMs[Math.min(retry, settings.retryMs.length - 1)];
    retry += 1;
    log.info('live video lost; restarting', { reason, inMs: delay });
    publishState('restarting');
    // The TV hears nothing until the new stream's init: its silence does not count until then.
    for (const v of viewers.values()) {
      restartWatch(v);
      try { v.onRestart?.(reason); } catch (err) { log.debug('viewer restart hook failed', { message: err.message }); }
    }
    retryTimer = setTimeout(() => { ensureCapture().catch(startFailed); }, delay);
  }

  // A start that failed is tried again a few times (spaced out); then the TV goes back to frames.
  // Nothing the TV can play is not retried.
  function startFailed(err) {
    if (stopped || !viewers.size) return;
    const hopeless = err instanceof LumenError && /none of the stream formats|turned off/.test(err.message);
    if (!hopeless && retry < settings.retryMs.length) {
      const delay = settings.retryMs[retry];
      retry += 1;
      publishState('restarting');
      retryTimer = setTimeout(() => { ensureCapture().catch(startFailed); }, delay);
      return;
    }
    retry = 0;
    for (const v of [...viewers.values()]) fallBack(v, `live video could not start: ${err.message}`);
  }

  // A viewer goes back to frames once (tvscreen detaches it); nothing more is judged for it.
  function fallBack(v, reason) {
    if (v.fellBack) return;
    v.fellBack = true;
    v.onFallback?.(reason);
  }

  // ---- muxer output ----

  function onMuxed(m) {
    if (m.kind === 'init') {
      log.info('live video stream', { codec: m.codec, size: `${m.width}x${m.height}`, fps: m.fps, audio: m.audio, reset: m.reset });
      noStreamRestarted = false;
      // The encoder's exact codec string (HEVC can come out as High tier) and the one the TV said it
      // takes for this step: the TV's player uses the first it accepts.
      const tv = rate?.step?.codec?.tv;
      fanout.onInit({ ...m, tvMime: tv && familyOf(tv) === familyOf(m.codec) ? mimeType(tv, m.audio) : null });
      publishState('streaming');
    } else fanout.onMedia(m);
  }

  // ---- rate control: once a second ----

  // A rate change: a new step (the page's scale and the encoder's config), a new bitrate, a fresh
  // player for `viewer`, or back to frames when nothing is left (that viewer, or all of them).
  // → true when the viewers went back to frames.
  function applyChange(change, why, viewer = null, exhaustedReason = 'The TV could not play the live video') {
    if (!change) return false;
    if (change.exhausted) {
      const list = viewer ? [viewers.get(viewer)].filter(Boolean) : [...viewers.values()];
      for (const v of list) fallBack(v, exhaustedReason);
      return true;
    }
    if (change.resync && viewer) fanout.resync(viewer);
    if (change.step !== undefined) {
      const step = rate.step;
      log.info('live video step', { step: step.name, codec: step.codec.family, bitrate: rate.bitrate, cause: change.cause ?? null, why });
      browser()?.setTvScale?.(step.scale);
      sendPage(stepConfig(step, rate.bitrate));
    } else if (change.bitrate) {
      log.debug('live video bitrate', { bitrate: rate.bitrate, why });
      sendPage({ t: 'bitrate', bitrate: rate.bitrate });
    }
    return false;
  }

  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const rise = (cur, prev, key) => (cur && prev && num(cur[key]) !== null && num(prev[key]) !== null ? Math.max(0, cur[key] - prev[key]) : 0);

  // The TV's player starts over (attach, resume, a refusal or error, a capture restart): its silence
  // counts from the next init, and its counters start again.
  function restartWatch(v) {
    v.since = Date.now();
    v.lastStatsAt = null;
    v.prevTv = null;
    v.lagRun = 0;
    v.stallHist = [];
  }

  function controlTick() {
    if (!rate) { publishState(); return; }
    for (const [viewer, v] of viewers) {
      if (v.paused || v.fellBack) continue;
      const sent = fanout.takeStats(viewer);
      // A refusal or a player error is acted on at once: the stream that follows comes from it.
      if (v.refused || v.runtimeError) {
        const signals = { refused: v.refused, refusedIndex: v.refusedIndex, runtimeError: v.runtimeError, tvFresh: false };
        v.refused = v.runtimeError = false;
        v.refusedIndex = null;
        applyChange(rate.tick(signals), signals, viewer);
        continue;
      }
      const tv = v.tvStats;
      v.tvStats = null;
      // Nothing counts before the TV has had an init since it (re)started: a start can take a while
      // (a capture retried), and the TV reports only once it has a stream. But a capture that is up
      // and sends no stream (its encoder never gives anything, or every frame is the wrong size)
      // would leave the TV on its last picture for good: it is started again once, then the TV goes
      // back to frames (not a strike: the TV did nothing wrong).
      if (!sent?.initAt || sent.initAt < v.since) {
        if (tv) v.prevTv = tv;
        const waitedMs = captureUpAt !== null && muxer && !capturing ? Date.now() - Math.max(v.since, captureUpAt) : 0;
        if (waitedMs > (settings.noStreamMs ?? settings.statsGraceMs + settings.statsGoneMs)) {
          if (!noStreamRestarted) {
            noStreamRestarted = true;
            log.warn('the capture sends no video; starting it again', { waitedMs, step: rate.step.name });
            onCaptureLost('the capture sent no video');
          } else {
            log.warn('the capture sends no video; back to frames', { waitedMs, step: rate.step.name });
            fallBack(v, 'live video could not start: the capture sent no video');
          }
        }
        continue;
      }
      const prev = v.prevTv;
      if (tv) v.prevTv = tv;
      const decodedDelta = rise(tv, prev, 'decoded');
      const droppedDelta = rise(tv, prev, 'dropped');
      const stalls = rise(tv, prev, 'stalls');
      const lag = num(tv?.lag);
      const resyncs = tv ? v.resyncs : 0;
      if (tv) v.resyncs = 0;
      if (tv) {
        // Backstop for TV agents that still seek on stalls (their page gets killed soon after): far
        // behind on 3 reports in a row, or stalls on 3 of the last 4, the TV goes back to frames.
        v.lagRun = lag !== null && lag > BACKSTOP_LAG_SEC ? v.lagRun + 1 : 0;
        v.stallHist = [...v.stallHist, stalls > 0].slice(-4);
        if (v.lagRun >= 3 || v.stallHist.filter(Boolean).length >= 3) {
          log.warn('the TV player is stuck on the live video', { lag, stalls: v.stallHist.filter(Boolean).length });
          fallBack(v, 'the TV player is stuck');
          continue;
        }
      }
      // The TV reports every 2 s once it plays (statsGraceMs allowed after the init). A TV that stops
      // reporting is starved or frozen: the stream gets lighter, and then it goes back to frames.
      const quietMs = Date.now() - (v.lastStatsAt ?? sent.initAt + settings.statsGraceMs);
      if (quietMs > settings.statsGoneMs) { log.warn('the TV stopped reporting on the live video', { quietMs }); fallBack(v, 'the TV stopped reporting'); continue; }
      const signals = {
        drops: sent.drops,
        queueSec: viewer.buffered ? viewer.buffered() / Math.max(1, rate.bitrate / 8) : 0,
        statsLate: quietMs > settings.statsLateMs,
        tvFresh: !!tv,
        stalls,
        jumps: rise(tv, prev, 'jumps'),
        resyncs,
        lag,
        dropRatio: decodedDelta > 20 ? droppedDelta / (decodedDelta + droppedDelta) : 0,
      };
      // A TV decoding far fewer frames than the PC sends (seen 24 Oct after H.264 → HEVC 4K → H.264:
      // 6 of 30 fps, the picture looked paused) is started over in a fresh player, once in a while.
      if (tv && prev) {
        const sentFps = lastStats ? (lastStats.frames + lastStats.repeats) / 2 : null;
        const slow = sentFps !== null && sentFps >= 15 && decodedDelta / 2 < sentFps * SLOW_DECODE_SHARE;
        v.slowRun = slow ? (v.slowRun ?? 0) + 1 : 0;
        if (v.slowRun >= SLOW_DECODE_REPORTS && Date.now() - (v.slowResyncAt ?? 0) > SLOW_DECODE_GAP_MS) {
          v.slowRun = 0;
          v.slowResyncAt = Date.now();
          log.warn('the TV decodes the live video slowly; starting its player over', { tvFps: Math.round(decodedDelta / 2), sentFps: Math.round(sentFps) });
          fanout.resync(viewer);
        }
      }
      v.last = { ...signals, kbps: Math.round((sent.sentBytes * 8) / 1000), lagMs: lag !== null ? Math.round(lag * 1000) : (v.last?.lagMs ?? null),
        // Frames the TV decoded per second (it reports every 2 s).
        tvFps: tv && decodedDelta > 0 ? Math.round(decodedDelta / 2) : (v.last?.tvFps ?? null) };
      applyChange(rate.tick(signals), signals, viewer);
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
   * A TV viewer: { send(buf, { key, limit }) → boolean, buffered() → bytes, onFallback(reason),
   * onRestart(reason) (optional: the capture is being restarted, the TV will get a new stream) }.
   * tvCaps: { [tv codec string]: boolean } from the TV's MediaSource.isTypeSupported.
   * options.lower: start this many steps below the usual start (the TV's page died on live video before).
   * → { pause(), resume(), resync(reason) (the TV's player asked to start over: started over; again
   *     within 2 minutes, the step is held for 10 minutes), report(stats), refused(reason) (the TV
   *     cannot play this format: its step is blocked; a reason starting 'stuck' is a stuck player,
   *     handled as resync), error() (its player failed while playing: started over; twice in 10
   *     minutes, the step is held), detach() }. The agent's reason is optional.
   */
  function attach(viewer, tvCaps = {}, options = {}) {
    if (!settings.enabled) throw new LumenError('UNAVAILABLE', 'Live video is turned off');
    clearTimeout(stopTimer);
    stopTimer = null;
    const changedCaps = JSON.stringify(tvCaps) !== JSON.stringify(caps);
    caps = { ...tvCaps };
    const lower = Math.max(0, Number(options.lower) || 0);
    const rechoose = changedCaps || lower !== startLower || rechooseNext;
    rechooseNext = false;
    if (rechoose) rate = null;
    startLower = lower;
    // New caps (another TV, an agent update), a lower start or live video turned on again choose the
    // ladder again.
    if (rechoose && page) stopCapture();
    viewers.set(viewer, { tvStats: null, prevTv: null, refused: false, refusedIndex: null, runtimeError: false, resyncs: 0, lagRun: 0, stallHist: [],
      onFallback: viewer.onFallback, onRestart: viewer.onRestart, since: Date.now(), lastStatsAt: null });
    fanout.add(viewer);
    statsTimer ??= setInterval(controlTick, settings.controlMs);
    ensureCapture().catch(startFailed);
    // A capture still running (the TV came straight back) is already streaming.
    publishState(page && muxer?.initSent ? 'streaming' : 'starting');
    // The TV's player asked to start over (stuck, never started, failed while playing, behind, a full
    // buffer): a fresh player now; counted as trouble, and again within 2 minutes the step is held.
    const restartAsked = () => { const v = viewers.get(viewer); if (v) v.resyncs += 1; fanout.resync(viewer); };
    return {
      pause: () => { const v = viewers.get(viewer); if (v) v.paused = true; fanout.pause(viewer); },
      resume: () => { const v = viewers.get(viewer); if (v) { v.paused = false; restartWatch(v); } fanout.resume(viewer); },
      resync: () => restartAsked(),
      report: (stats) => {
        const v = viewers.get(viewer);
        if (!v) return;
        v.tvStats = stats;
        v.lastStatsAt = Date.now();
        // Well behind: this viewer skips ahead to a key frame (no seek on the TV).
        if (fanout.noteLag(viewer, stats?.lag)) log.debug('the TV is behind on the live video; skipping ahead', { lag: stats.lag });
      },
      // The step the refusal came in on is the one blamed (not whatever the step is at the next tick).
      // A stuck player is not a format the TV cannot play: it is started over, never blocked.
      refused: (reason) => {
        if (/^stuck/.test(String(reason ?? ''))) { restartAsked(); return; }
        const v = viewers.get(viewer);
        if (v) { v.refused = true; v.refusedIndex = rate?.index ?? null; restartWatch(v); }
      },
      error: () => {
        const v = viewers.get(viewer);
        if (!v) return;
        v.runtimeError = true;
        restartWatch(v);
        fanout.resync(viewer);
      },
      detach: () => detach(viewer),
    };
  }

  function detach(viewer) {
    if (!viewers.delete(viewer)) return;
    fanout.remove(viewer);
    if (viewers.size) return;
    clearInterval(statsTimer);
    statsTimer = null;
    // A capture retry still pending is for nobody now (it would start the browser again).
    clearTimeout(retryTimer);
    retryTimer = null;
    retry = 0;
    noStreamRestarted = false;
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
    /**
     * Diagnostics (latency measurements): baseWallMs, the wall-clock ms of media time 0 on the first
     * viewer's timeline (skips move it back: shiftSec, cumulative, ≤ 0); streamBaseWallMs, that of
     * the stream itself.
     */
    timeline: () => {
      const streamBaseWallMs = pageClock !== null && muxer?.base != null ? pageClock + muxer.base / 1000 : null;
      const first = viewers.keys().next().value;
      const shift = first ? fanout.shifts(first) : null;
      const shiftSec = shift ? shift.video / VIDEO_TIMESCALE : 0;
      return { baseWallMs: streamBaseWallMs !== null ? streamBaseWallMs - shiftSec * 1000 : null, streamBaseWallMs, shiftSec, lagSkips: shift?.sheds ?? 0 };
    },
    /** The next viewer starts on a new rate controller (live video turned on again: blocks forgotten). */
    resetRate() { rechooseNext = true; },
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
