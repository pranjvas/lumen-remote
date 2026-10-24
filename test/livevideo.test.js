// Live video (features/livevideo.js, util/fmp4.js): fMP4 boxes and codec strings, the muxer (init
// segment once video and audio are configured, a timeline from the first key frame, contiguous AAC,
// the audio that comes before the first key frame, a new stream after a gap in the video), the TV
// message framing, the fan-out (key frame on join, skip to the next key frame when the link is backed
// up or the TV lags, each viewer's timeline rebased so a skip leaves no seam, pause/resume), the
// bitrate / step control driven as the feature drives it (a TV report every 2 s), and the feature
// itself against a fake browser (no Edge): starts that fail, an encoder that stops or keeps failing.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import {
  initSegment, fragment, fragmentBatch, listBoxes, findBox, avcCodecString, hevcCodecString, buildHvcC, splitAnnexB, parseHevcSps, mimeType,
  tfdtOffsets, VIDEO_TRACK, AUDIO_TRACK,
} from '../server/util/fmp4.js';
import {
  createMuxer, createFanout, createRateControl, createLiveVideo, usableLadder, startIndexOf, initMessage, mediaMessage, parseMessage, TV_CODEC_PROBES,
} from '../server/features/livevideo.js';

// Per track runs of a fragment: [{ track, time (tfdt), duration (sum), count }].
function trackRuns(buf) {
  const moof = findBox(buf, 'moof');
  return listBoxes(buf, moof.start + 8, moof.start + moof.size).filter((b) => b.type === 'traf').map((traf) => {
    const inner = listBoxes(buf, traf.start + 8, traf.start + traf.size);
    const tfhd = inner.find((b) => b.type === 'tfhd');
    const tfdt = inner.find((b) => b.type === 'tfdt');
    const trun = inner.find((b) => b.type === 'trun');
    const count = buf.readUInt32BE(trun.start + 12);
    let duration = 0;
    for (let i = 0; i < count; i++) duration += buf.readUInt32BE(trun.start + 20 + i * 12);
    return { track: buf.readUInt32BE(tfhd.start + 12), time: Number(buf.readBigUInt64BE(tfdt.start + 12)), duration, count };
  });
}
// Seams between consecutive fragments, per track (tools/scratch/live/mp4gaps.mjs): a fragment that
// does not start where the last one of its track ended is a gap (later) or an overlap (earlier).
function seams(bufs) {
  const ends = {};
  const out = {};
  for (const buf of bufs) {
    for (const r of trackRuns(buf)) {
      const s = (out[r.track] ??= { frags: 0, gaps: 0, overlaps: 0, worst: 0 });
      s.frags += 1;
      if (ends[r.track] !== undefined && r.time !== ends[r.track]) {
        const d = r.time - ends[r.track];
        if (d > 0) s.gaps += 1; else s.overlaps += 1;
        s.worst = Math.max(s.worst, Math.abs(d));
      }
      ends[r.track] = r.time + r.duration;
    }
  }
  return out;
}

// An avcC as Chrome's encoder gives it (High profile, level 4.2) with a dummy SPS/PPS.
const AVCC = Buffer.from('0164002affe1000a6764002aac2b40780227e501000468ee3cb0', 'hex');
const ASC = Buffer.from([0x11, 0x90]); // AAC-LC 48 kHz stereo
// VPS, SPS, PPS of a 320×240 4:4:4 x265 frame, and the hvcC ffmpeg writes for them (its SEI array
// left out): the record built here must match it byte for byte.
const HEVC_UNITS = [
  '40010c01ffff0408000003009e0800000300003c959809',
  '4201010408000003009e0800000300003c90014101e2cb2b349265780b7020200040000003004000000782',
  '4401c172860c4624',
].map((h) => Buffer.from(h, 'hex'));
const FFMPEG_HVCC_HEADER = '0104080000009e08000000003cf000fcfff8f800000f';
const annexB = (units) => Buffer.concat(units.flatMap((u) => [Buffer.from([0, 0, 0, 1]), u]));

describe('fmp4', () => {
  test('init segment: ftyp + moov with a video and an audio track and trex for both', () => {
    const init = initSegment({ video: { codec: 'avc1.64002A', width: 1920, height: 1080, config: AVCC }, audio: { sampleRate: 48000, channels: 2, config: ASC } });
    assert.deepEqual(listBoxes(init).map((b) => b.type), ['ftyp', 'moov']);
    const moov = findBox(init, 'moov');
    const inner = listBoxes(init, moov.start + 8, moov.start + moov.size).map((b) => b.type);
    assert.deepEqual(inner, ['mvhd', 'trak', 'trak', 'mvex']);
    assert.ok(findBox(init, 'moov/trak/mdia/minf/stbl/stsd'));
    const mvex = findBox(init, 'moov/mvex');
    assert.equal(listBoxes(init, mvex.start + 8, mvex.start + mvex.size).filter((b) => b.type === 'trex').length, 2);
    assert.ok(init.includes(AVCC), 'the avcC is carried as is');
    assert.ok(init.includes(Buffer.from('avcC')) && init.includes(Buffer.from('esds')));
  });

  test('fragment: moof + mdat, the data offset points at the sample, tfdt is the time', () => {
    const data = Buffer.from('sample-bytes');
    const frag = fragment({ seq: 7, track: VIDEO_TRACK, time: 123456, duration: 1500, data, key: false });
    const boxes = listBoxes(frag);
    assert.deepEqual(boxes.map((b) => b.type), ['moof', 'mdat']);
    const trun = findBox(frag, 'moof/traf/trun');
    const offset = frag.readUInt32BE(trun.start + 16);
    assert.equal(frag.subarray(offset, offset + data.length).toString(), 'sample-bytes');
    const tfdt = findBox(frag, 'moof/traf/tfdt');
    assert.equal(Number(frag.readBigUInt64BE(tfdt.start + 12)), 123456);
    assert.equal(frag.readUInt32BE(trun.start + 28), 0x01010000, 'a non-key sample is flagged non-sync');
    const key = fragment({ seq: 8, track: AUDIO_TRACK, time: 0, duration: 1024, data, key: true });
    assert.equal(key.readUInt32BE(findBox(key, 'moof/traf/trun').start + 28), 0x02000000);
  });

  test('codec strings from the configuration records', () => {
    assert.equal(avcCodecString(AVCC), 'avc1.64002A');
    const hvcC = buildHvcC(HEVC_UNITS);
    assert.equal(hvcC.subarray(0, 23).toString('hex'), FFMPEG_HVCC_HEADER.slice(0, 44) + '03', 'header as ffmpeg writes it (3 arrays here)');
    assert.equal(hevcCodecString(hvcC), 'hvc1.4.10.L60.9E.8');
    assert.equal(mimeType('avc1.64002A'), 'video/mp4; codecs="avc1.64002A,mp4a.40.2"');
  });

  test('HEVC SPS: size, chroma format and bit depth', () => {
    const sps = parseHevcSps(HEVC_UNITS[1]);
    assert.deepEqual([sps.width, sps.height, sps.chromaFormat, sps.bitDepthLuma], [320, 240, 3, 8]);
  });

  test('Annex B splitting keeps every unit (3- and 4-byte start codes)', () => {
    const buf = Buffer.concat([Buffer.from([0, 0, 1]), HEVC_UNITS[0], Buffer.from([0, 0, 0, 1]), HEVC_UNITS[2]]);
    assert.deepEqual(splitAnnexB(buf).map((u) => u.toString('hex')), [HEVC_UNITS[0], HEVC_UNITS[2]].map((u) => u.toString('hex')));
  });
});

describe('muxer', () => {
  // A fake clock and timers: fragments close on media time, or after 2× the fragment time on the clock.
  function run() {
    const out = [];
    const clock = { t: 0 };
    const timers = [];
    const mux = createMuxer({ emit: (m) => out.push(m), now: () => clock.t, fragmentMs: 160,
      setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: (id) => { if (id) timers[id - 1] = null; } });
    const fire = () => { const list = timers.splice(0); list.forEach((fn) => fn && fn()); };
    return { mux, out, clock, fire };
  }
  const vconfig = (extra = {}) => ({ t: 'vconfig', codec: 'avc1.640028', width: 1920, height: 1080, fps: 30, format: 'avc', description: AVCC.toString('base64'), ...extra });
  const media = (out) => out.filter((m) => m.kind === 'media');
  // Samples per track in a fragment: [[track, count, firstTime]].
  const runs = (buf) => {
    const moof = findBox(buf, 'moof');
    return listBoxes(buf, moof.start + 8, moof.start + moof.size).filter((b) => b.type === 'traf').map((traf) => {
      const inner = listBoxes(buf, traf.start + 8, traf.start + traf.size);
      const tfhd = inner.find((b) => b.type === 'tfhd');
      const tfdt = inner.find((b) => b.type === 'tfdt');
      const trun = inner.find((b) => b.type === 'trun');
      return [buf.readUInt32BE(tfhd.start + 12), buf.readUInt32BE(trun.start + 12), Number(buf.readBigUInt64BE(tfdt.start + 12))];
    });
  };

  test('the init segment waits for audio; media starts at a key frame; ~160 ms of media per fragment', () => {
    const { mux, out } = run();
    mux.videoConfig(vconfig());
    mux.video(1_000_000, false, Buffer.from('p'));
    assert.equal(out.length, 0, 'nothing before the audio config (or its timeout)');
    mux.audioConfig({ sampleRate: 48000, channels: 2, description: ASC.toString('base64') });
    assert.equal(out[0].kind, 'init');
    assert.equal(out[0].mime, 'video/mp4; codecs="avc1.64002A,mp4a.40.2"', 'the codec string comes from the encoder avcC');
    assert.equal(out[0].reset, true);
    mux.video(1_016_000, false, Buffer.from('p'));
    assert.equal(out.length, 1, 'a frame that is not a key frame is not the start');
    let audioAt = 1_033_000;
    for (let i = 0; i < 12; i++) {
      const t = 1_033_000 + i * 33_333;
      mux.video(t, i === 0, Buffer.from(`f${i}`));
      for (; audioAt <= t; audioAt += 21_333) mux.audio(audioAt, Buffer.from('a')); // AAC: 1024 samples at 48 kHz
    }
    const m = media(out);
    assert.equal(m.length, 2, '12 frames at 30 fps → two fragments');
    assert.equal(m[0].key, true);
    assert.equal(m[1].key, false);
    assert.equal(m[0].time, 0);
    const [video, audio] = runs(m[0].buf);
    assert.deepEqual([video[0], video[1], video[2]], [1, 6, 0], 'six video frames from time 0');
    assert.equal(audio[0], 2);
    assert.ok(audio[1] >= 3, 'the audio of that time rides in the same fragment');
    const trun = findBox(m[0].buf, 'moof/traf/trun');
    const offset = m[0].buf.readUInt32BE(trun.start + 16);
    assert.equal(m[0].buf.subarray(offset, offset + 2).toString(), 'f0', 'the data offset points at the first frame');
  });

  test('a key frame always starts a fragment of its own', () => {
    const { mux, out } = run();
    mux.videoConfig(vconfig());
    mux.audioConfig({ sampleRate: 48000, channels: 2 });
    mux.video(0, true, Buffer.from('k'));
    mux.video(33_333, false, Buffer.from('p'));
    mux.video(66_666, true, Buffer.from('K'));
    const m = media(out);
    assert.equal(m.length, 1, 'the run before the new key frame went out');
    assert.equal(runs(m[0].buf)[0][1], 2);
  });

  test('without audio the init segment goes after the wait, video only', () => {
    const { mux, out, clock } = run();
    mux.videoConfig(vconfig());
    mux.video(0, true, Buffer.from('k'));
    clock.t = 2000;
    mux.video(33_000, false, Buffer.from('p'));
    assert.equal(out[0].kind, 'init');
    assert.equal(out[0].audio, false);
    assert.equal(out[0].mime, 'video/mp4; codecs="avc1.64002A"');
  });

  test('AAC frames follow each other exactly; a real gap is kept; audio alone goes out after a while', () => {
    const { mux, out, fire } = run();
    mux.videoConfig(vconfig());
    mux.audioConfig({ sampleRate: 48000, channels: 2 });
    mux.video(100_000, true, Buffer.from('k'));
    mux.audio(100_000, Buffer.from('a'));
    mux.audio(121_400, Buffer.from('a')); // 21.4 ms later: jitter around 1024 samples
    mux.audio(500_000, Buffer.from('a')); // a gap in the capture: a new run
    fire(); // no video for a while (a still page): what is packed goes out
    const m = media(out);
    const first = runs(m[0].buf).find((r) => r[0] === 2);
    assert.deepEqual([first[1], first[2]], [2, 0], 'two contiguous AAC frames from 0');
    const second = runs(m[1].buf).find((r) => r[0] === 2);
    assert.deepEqual([second[1], second[2]], [1, 19200]);
  });

  test('a new size is a new init without reset; a new codec family resets', () => {
    const { mux, out } = run();
    mux.videoConfig(vconfig());
    mux.audioConfig({ sampleRate: 48000, channels: 2 });
    mux.video(0, true, Buffer.from('k'));
    mux.videoConfig(vconfig({ codec: 'avc1.64001F', width: 1280, height: 720, description: Buffer.concat([AVCC.subarray(0, 3), Buffer.from([0x1f]), AVCC.subarray(4)]).toString('base64') }));
    const kinds = out.map((m) => m.kind);
    assert.deepEqual(kinds, ['init', 'media', 'init'], 'the packed frames of the old size go before the new init');
    assert.equal(out[2].reset, false);
    assert.equal(out[2].codec, 'avc1.64001F');
    // HEVC (Annex B): the record comes from the next key frame's parameter sets.
    mux.videoConfig({ t: 'vconfig', codec: 'hvc1.1.6.L153.B0', width: 320, height: 240, fps: 30, format: 'annexb' });
    mux.video(50_000, true, annexB([...HEVC_UNITS, Buffer.from([0x26, 0x01, 0xaf])]));
    mux.flush();
    const last = out.filter((m) => m.kind === 'init').at(-1);
    assert.equal(last.codec, 'hvc1.4.10.L60.9E.8');
    assert.equal(last.reset, true);
    const tail = out.at(-1);
    assert.equal(tail.kind, 'media');
    assert.ok(!tail.buf.includes(HEVC_UNITS[1]), 'parameter sets are not repeated in the samples');
    assert.ok(tail.time > 0, 'the timeline continues');
  });

  test('audio that arrives before the late first key frame rides with it: the stream opens with sound', () => {
    const { mux, out } = run();
    mux.videoConfig(vconfig());
    mux.audioConfig({ sampleRate: 48000, channels: 2 });
    // The hardware encoder's first key frame (1 s) comes after the audio up to 1.4 s has arrived.
    for (let ts = 600_000; ts < 1_400_000; ts += 21_333) mux.audio(ts, Buffer.from('a'));
    mux.video(1_000_000, true, Buffer.from('k'));
    for (let i = 1; i < 6; i++) mux.video(1_000_000 + i * 33_333, false, Buffer.from('p'));
    mux.flush();
    const audio = runs(media(out)[0].buf).find((r) => r[0] === AUDIO_TRACK);
    assert.ok(audio, 'the first fragment has sound');
    assert.ok(audio[2] < 1024, `the audio starts with the video (at ${audio?.[2]} samples)`);
    assert.ok(audio[1] >= 18, 'the held audio from the key frame on, none from before');
  });

  test('a second or more without video starts a new stream at the next key frame; a shorter gap is closed', () => {
    for (const [gapUs, reset] of [[1_500_000, true], [900_000, false]]) {
      const { mux, out, fire } = run();
      mux.videoConfig(vconfig());
      mux.audioConfig({ sampleRate: 48000, channels: 2 });
      let a = 0;
      const audioUntil = (ts) => { for (; a <= ts; a += 21_333) mux.audio(a, Buffer.from('a')); };
      let t = 0;
      for (let i = 0; i < 30; i++, t += 33_333) { audioUntil(t); mux.video(t, i % 15 === 0, Buffer.from('v')); }
      // The encoder failed: no video for a while, the sound goes on.
      const back = t + gapUs;
      for (; a < back;) { audioUntil(Math.min(back - 1, a + 100_000)); fire(); }
      audioUntil(back);
      mux.video(back, false, Buffer.from('p')); // back: a frame that is not a key frame first
      for (let i = 1; i < 20; i++) { audioUntil(back + i * 33_333); mux.video(back + i * 33_333, i === 1, Buffer.from('v')); }
      mux.flush();
      const inits = out.filter((m) => m.kind === 'init');
      assert.equal(inits.length, reset ? 2 : 1, `${gapUs / 1e6} s gap`);
      // Per stream (from one init to the next): the video has no seam.
      const streams = [];
      for (const m of out) if (m.kind === 'init') streams.push([]); else streams.at(-1).push(m);
      for (const list of streams) assert.equal(seams(list.map((m) => m.buf))[VIDEO_TRACK]?.gaps ?? 0, 0, 'no hole in the video of a stream');
      if (reset) {
        assert.equal(inits[1].reset, true, 'a fresh player on the TV');
        assert.equal(streams[1][0].key, true, 'the new stream starts with its key frame');
      }
    }
  });
});

describe('TV message framing', () => {
  test('init and media messages round-trip and never look like a JPEG', () => {
    const init = initMessage(3, { mime: 'm', reset: true }, Buffer.from('INIT'));
    assert.notEqual(init[0], 0xff);
    assert.deepEqual(parseMessage(init), { kind: 'init', gen: 3, info: { mime: 'm', reset: true }, data: Buffer.from('INIT') });
    const media = mediaMessage(3, true, [Buffer.from('a'), Buffer.from('b')]);
    const parsed = parseMessage(media);
    assert.deepEqual([parsed.kind, parsed.gen, parsed.key, parsed.data.toString()], ['media', 3, true, 'ab']);
    assert.equal(parseMessage(Buffer.from([0xff, 0xd8, 0, 0, 0, 0, 0, 0])), null);
  });
});

describe('fan-out', () => {
  function setup() {
    let keys = 0;
    const fan = createFanout({ requestKey: () => { keys += 1; }, now: (() => { let t = 0; return () => (t += 1000); })(), limitBytes: () => 100 });
    const viewer = (accept = () => true) => {
      const got = [];
      return { got, send: (buf, opts) => { if (!accept(buf, opts)) return false; got.push(parseMessage(buf)); return true; } };
    };
    const init = (extra = {}) => fan.onInit({ mime: 'video/mp4', codec: 'avc1.640028', width: 1920, height: 1080, fps: 30, audio: true, reset: true, buf: Buffer.from('I'), ...extra });
    const media = (key, tag) => fan.onMedia({ key, buf: Buffer.from(tag), time: 0 });
    // Fragment i of a steady stream, as the muxer emits it: 5 frames (15360 ticks at 90 kHz) and 8
    // AAC frames (8192 samples at 48 kHz) = 170.7 ms each; its first video sample reads `F<i>`.
    const frag = (i, key) => {
      const tracks = [
        { track: VIDEO_TRACK, time: i * 15360, samples: Array.from({ length: 5 }, (_, j) => ({ data: Buffer.from(`F${i}.${j}`), key: key && j === 0, duration: 3072 })) },
        { track: AUDIO_TRACK, time: i * 8192, samples: Array.from({ length: 8 }, () => ({ data: Buffer.from('aac'), key: true, duration: 1024 })) },
      ];
      fan.onMedia({ key, tracks, seq: i, audioRate: 48000, audioChannels: 2, time: i * 15360 / 90000, buf: fragmentBatch({ seq: i, tracks }),
        video: { time: i * 15360, end: (i + 1) * 15360 }, audio: { time: i * 8192, end: (i + 1) * 8192, samples: tracks[1].samples.map((s) => s.data) } });
    };
    const fragments = (v) => v.got.filter((m) => m.kind === 'media').map((m) => m.data);
    const tagOf = (buf) => /F\d+/.exec(buf.toString('latin1'))[0];
    return { fan, viewer, init, media, frag, fragments, tagOf, keys: () => keys };
  }

  test('a viewer that joins gets the init segment, asks for a key frame, and starts at one', () => {
    const { fan, viewer, init, media, keys } = setup();
    init();
    const v = viewer();
    fan.add(v);
    assert.equal(v.got[0].kind, 'init');
    assert.equal(v.got[0].info.reset, true);
    assert.ok(keys() >= 1);
    media(false, 'P0');
    assert.equal(v.got.length, 1, 'nothing until a fragment that starts with a key frame');
    media(true, 'K');
    media(false, 'P');
    assert.deepEqual(v.got.slice(1).map((m) => [m.key, m.data.toString()]), [[true, 'K'], [false, 'P']]);
  });

  test('a backed-up link skips to the next key frame and asks for one; the skip leaves no seam', () => {
    const { fan, viewer, init, frag, fragments, tagOf, keys } = setup();
    init();
    let open = true;
    const v = viewer(() => open);
    fan.add(v);
    frag(0, true);
    open = false;
    const before = keys();
    frag(1, false);
    assert.ok(keys() > before, 'a key frame is requested');
    open = true;
    frag(2, false);
    frag(3, true);
    frag(4, false);
    const got = fragments(v);
    assert.deepEqual(got.map(tagOf), ['F0', 'F3', 'F4']);
    assert.equal(fan.takeStats(v).drops, 1);
    // F3 and what follows are moved back by the skipped 341 ms (F1, F2): no hole on either track.
    assert.deepEqual(trackRuns(got[1]).map((r) => [r.track, r.time]), [[VIDEO_TRACK, 15360], [AUDIO_TRACK, 8192]]);
    assert.deepEqual(seams(got)[VIDEO_TRACK], { frags: 3, gaps: 0, overlaps: 0, worst: 0 });
    assert.deepEqual(seams(got)[AUDIO_TRACK], { frags: 3, gaps: 0, overlaps: 0, worst: 0 });
    assert.deepEqual(fan.shifts(v), { video: -2 * 15360, audio: -2 * 8192, sheds: 0 });
    // A fresh player (a reset init) is on the stream's own timeline again.
    fan.resync(v);
    frag(5, true);
    assert.equal(trackRuns(fragments(v).at(-1))[0].time, 5 * 15360);
  });

  test('a skip leaves no seam with the real muxer: a viewer that refuses a fragment now and then', () => {
    const clock = { t: 0 };
    let wantKey = true;
    const fan = createFanout({ requestKey: () => { wantKey = true; }, now: () => clock.t, limitBytes: () => 1e9 });
    const mux = createMuxer({ emit: (m) => (m.kind === 'init' ? fan.onInit(m) : fan.onMedia(m)), now: () => clock.t, fragmentMs: 160, setTimer: () => 0, clearTimer: () => {} });
    const got = [];
    let attempts = 0;
    let refused = 0;
    const refuseAt = [6, 19, 31, 44, 58]; // media sends refused (the next one that is not a key fragment)
    const viewer = { send(buf) {
      const m = parseMessage(buf);
      if (m.kind === 'media') {
        attempts += 1;
        if (!m.key && refused < refuseAt.length && attempts >= refuseAt[refused]) { refused += 1; return false; }
      }
      got.push(m);
      return true;
    } };
    fan.add(viewer);
    mux.videoConfig({ t: 'vconfig', codec: 'avc1.640028', width: 1920, height: 1080, fps: 30, format: 'avc', description: AVCC.toString('base64') });
    mux.audioConfig({ sampleRate: 48000, channels: 2 });
    // 12 s of capture: video at 30 fps (a key frame a second, or when asked) arriving 45 ms after its
    // time, AAC every 1024 samples arriving 8 ms after.
    const events = [];
    for (let i = 0; i < 360; i++) events.push({ at: Math.round((i * 1e6) / 30) + 45_000, video: Math.round((i * 1e6) / 30), i });
    for (let j = 0; j < 562; j++) events.push({ at: Math.round((j * 1024 * 1e6) / 48000) + 8000, audio: Math.round((j * 1024 * 1e6) / 48000) });
    events.sort((a, b) => a.at - b.at);
    let sinceKey = 0;
    for (const e of events) {
      clock.t = e.at / 1000;
      if (e.audio !== undefined) { mux.audio(e.audio, Buffer.from('aac')); continue; }
      const key = wantKey || sinceKey >= 29;
      wantKey = false;
      sinceKey = key ? 0 : sinceKey + 1;
      mux.video(e.video, key, Buffer.from(`v${e.i}`));
    }
    mux.flush();
    assert.equal(refused, refuseAt.length, 'the viewer refused some fragments');
    const media = got.filter((m) => m.kind === 'media').map((m) => m.data);
    const s = seams(media);
    assert.deepEqual([s[VIDEO_TRACK].gaps, s[VIDEO_TRACK].overlaps], [0, 0], `video seams ${JSON.stringify(s[VIDEO_TRACK])}`);
    assert.deepEqual([s[AUDIO_TRACK].gaps, s[AUDIO_TRACK].overlaps], [0, 0], `audio seams ${JSON.stringify(s[AUDIO_TRACK])}`);
    // The viewer's timeline is behind the stream by what it skipped; its sound by the same time,
    // to within half an AAC frame (lip sync), however many skips.
    const { video, audio } = fan.shifts(viewer);
    assert.ok(video < -refuseAt.length * 9000, `the skips moved the video back (${video} ticks)`);
    assert.ok(Math.abs(audio - (video * 48000) / 90000) <= 512, `audio ${audio} vs video ${(video * 48000) / 90000} samples`);
  });

  test('a TV that lags skips ahead to the stream’s next key frame, without a seam, until it is close again', () => {
    const { fan, viewer, init, frag, fragments, tagOf, keys } = setup();
    init();
    const v = viewer();
    fan.add(v);
    frag(0, true);
    frag(1, false);
    assert.equal(fan.noteLag(v, 2), false, 'one report is not enough');
    assert.equal(fan.noteLag(v, 2.2), true, 'two in a row: a skip');
    const asked = keys();
    frag(2, false);
    frag(3, false);
    assert.equal(keys(), asked, 'no key frame asked for: the stream’s own is waited for');
    frag(4, true);
    frag(5, false);
    const got = fragments(v);
    assert.deepEqual(got.map(tagOf), ['F0', 'F1', 'F4', 'F5']);
    assert.deepEqual([seams(got)[VIDEO_TRACK].gaps, seams(got)[AUDIO_TRACK].gaps], [0, 0]);
    assert.equal(fan.shifts(v).video, -2 * 15360, 'the lag shed: 341 ms');
    assert.equal(fan.takeStats(v).drops, 0, 'not counted as a drop');
    assert.equal(fan.noteLag(v, 0.8), false);
    assert.equal(fan.noteLag(v, 1.6), false, 'close again: two reports needed once more');
  });

  test('pause holds everything; resume restarts from a fresh init and a key frame', () => {
    const { fan, viewer, init, media } = setup();
    init();
    const v = viewer();
    fan.add(v);
    media(true, 'K1');
    fan.pause(v);
    media(false, 'P');
    media(true, 'K2');
    fan.resume(v);
    media(false, 'P3');
    media(true, 'K3');
    const kinds = v.got.map((m) => (m.kind === 'init' ? `init${m.info.reset ? '!' : ''}` : m.data.toString()));
    assert.deepEqual(kinds, ['init!', 'K1', 'init!', 'K3']);
  });

  test('a new init goes to every viewer; media of an older stream is never mixed in', () => {
    const { fan, viewer, init, media } = setup();
    init();
    const v = viewer();
    fan.add(v);
    media(true, 'K1');
    init({ reset: false, width: 1280, height: 720 });
    media(true, 'K2');
    const msgs = v.got;
    assert.equal(msgs.at(-2).kind, 'init');
    assert.equal(msgs.at(-2).info.reset, false);
    assert.equal(msgs.at(-1).gen, msgs.at(-2).gen);
  });
});

describe('rate control and the ladder', () => {
  const allCaps = Object.fromEntries(TV_CODEC_PROBES.map((c) => [c, true]));
  const full = usableLadder({ caps: allCaps, maxHeight: 2160, maxFps: 30 });
  const tv = usableLadder({ caps: allCaps, maxFps: 30 }); // 1080p30 at most
  const all = usableLadder({ caps: allCaps, maxHeight: 2160 }); // 60 fps and 4K too

  test('the ladder follows the TV, the encoder and maxHeight; it starts at 1080p30, never at 4K', () => {
    assert.deepEqual(tv.map((s) => s.name), ['1080p30', '720p30', '540p30']);
    assert.ok(tv.every((s) => s.fps === 30), '30 fps throughout for this TV');
    assert.deepEqual(full.map((s) => `${s.name}:${s.codec.family}`), ['2160p30:hevc', '1080p30:avc', '720p30:avc', '540p30:avc']);
    assert.equal(startIndexOf(full), 1, '4K is a probe step');
    assert.equal(startIndexOf(full, 1), 2, 'one step lower after the TV went away');
    const noHevc = usableLadder({ caps: { 'avc1.640033': true, 'avc1.640028': true }, encoders: { '2160p30:hevc': true }, maxHeight: 2160, maxFps: 30 });
    assert.deepEqual(noHevc.map((s) => `${s.name}:${s.codec.family}`), ['2160p30:avc', '1080p30:avc', '720p30:avc', '540p30:avc']);
    const noEncoder = usableLadder({ caps: allCaps, encoders: { '2160p30:hevc': false, '2160p30:avc': false }, maxHeight: 2160, maxFps: 30 });
    assert.equal(noEncoder[0].name, '1080p30');
  });

  test('congestion lowers the bitrate to the floor, then steps down; quiet raises it again', () => {
    const rc = createRateControl({ ladder: tv });
    assert.equal(rc.step.name, '1080p30');
    for (let i = 0; i < 10 && rc.bitrate > tv[0].bitrate.min; i++) rc.tick({ drops: 1 });
    assert.equal(rc.bitrate, tv[0].bitrate.min);
    const steps = [];
    for (let i = 0; i < 3; i++) steps.push(rc.tick({ queueSec: 1 }));
    assert.deepEqual(steps.slice(0, 2), [null, null], 'two congested seconds at the floor are borne');
    assert.equal(steps[2].step, 1);
    assert.equal(rc.step.name, '720p30');
    for (let i = 0; i < 8; i++) rc.tick({});
    assert.ok(rc.bitrate > tv[1].bitrate.start, 'the bitrate creeps back up');
  });

  test('a TV that stops reporting counts as congestion', () => {
    const rc = createRateControl({ ladder: tv });
    const change = rc.tick({ statsLate: true });
    assert.ok(change.bitrate < tv[0].bitrate.start);
  });

  test('a TV that drops frames or refuses the format gets the next step; the end is reported', () => {
    const rc = createRateControl({ ladder: tv });
    for (let i = 0; i < 3; i++) rc.tick({ dropRatio: 0.3 });
    assert.equal(rc.step.name, '720p30');
    assert.equal(rc.tick({ refused: true }).step, 2);
    assert.deepEqual(rc.tick({ refused: true }), { exhausted: true });
  });

  test('4K is tried only after a long quiet spell, and dropped for good at its first trouble', () => {
    const rc = createRateControl({ ladder: full, probeAfter: 20 });
    assert.equal(rc.step.name, '1080p30');
    let change = null;
    for (let i = 0; i < 25 && rc.step.name !== '2160p30'; i++) change = rc.tick({});
    assert.equal(rc.step.name, '2160p30');
    assert.equal(change.cause, 'probe');
    for (let i = 0; i < 4; i++) assert.equal(rc.tick({ drops: 1 }), null, 'the switch itself is borne');
    assert.equal(rc.tick({ dropRatio: 0.2 }).cause, 'probe-failed');
    assert.equal(rc.step.name, '1080p30');
    for (let i = 0; i < 60; i++) rc.tick({});
    assert.equal(rc.step.name, '1080p30', 'not tried again');
  });

  test('with 60 fps allowed: 1080p30 first, then 1080p60, then 4K; a failed 60 fps step is skipped', () => {
    assert.deepEqual(all.map((s) => `${s.name}:${s.codec.family}`), ['2160p30:hevc', '1080p60:avc', '1080p30:avc', '720p30:avc', '540p30:avc']);
    assert.deepEqual(usableLadder({ caps: allCaps }).map((s) => s.name), ['1080p60', '1080p30', '720p30', '540p30'], 'maxHeight 1080 by default');
    assert.equal(usableLadder({ caps: { ...allCaps, 'avc1.64002A': false, 'hvc1.1.6.L123.B0': false } })[0].name, '1080p30', 'a TV without level 4.2 stays at 30');
    const rc = createRateControl({ ladder: all, probeAfter: 20 });
    assert.equal(rc.step.name, '1080p30');
    for (let i = 0; i < 25 && rc.step.name === '1080p30'; i++) rc.tick({});
    assert.equal(rc.step.name, '1080p60');
    for (let i = 0; i < 31; i++) rc.tick({}); // it held: 1080p60 is the step now
    for (let i = 0; i < 25 && rc.step.name === '1080p60'; i++) rc.tick({});
    assert.equal(rc.step.name, '2160p30');
    const again = createRateControl({ ladder: all, probeAfter: 20 });
    for (let i = 0; i < 25 && again.step.name === '1080p30'; i++) again.tick({});
    for (let i = 0; i < 4; i++) again.tick({});
    assert.equal(again.tick({ drops: 1 }).cause, 'probe-failed');
    assert.equal(again.step.name, '1080p30');
    for (let i = 0; i < 25 && again.step.name === '1080p30'; i++) again.tick({});
    assert.equal(again.step.name, '2160p30', 'on to 4K past the failed 60 fps step');
  });

  test('a step lowered for congestion is tried again after a quiet while', () => {
    const rc = createRateControl({ ladder: tv });
    for (let i = 0; i < 6; i++) rc.tick({ drops: 1 });
    assert.equal(rc.step.name, '720p30');
    for (let i = 0; i < 60 && rc.step.name !== '1080p30'; i++) rc.tick({});
    assert.equal(rc.step.name, '1080p30');
  });

  // As the feature drives it: a tick a second, the TV's report on every 2nd (tvFresh), nothing from
  // the TV on the others. → the changes, with the second they came at.
  function drive(rc, seconds, report, start = 1) {
    const changes = [];
    for (let s = start; s < start + seconds; s++) {
      const change = rc.tick(s % 2 === 0 ? { tvFresh: true, ...report(s) } : { tvFresh: false });
      if (change) changes.push({ s, ...change });
    }
    return changes;
  }

  test('a TV that stalls every 2.5 s (reports every 2 s): the bitrate goes down within 3 reports, then the step', () => {
    const rc = createRateControl({ ladder: tv });
    let last = 0;
    const changes = drive(rc, 20, (s) => { const n = Math.floor(s / 2.5) - Math.floor(last / 2.5); last = s; return { stalls: n, lag: 0.5 }; });
    assert.ok(changes.length && changes[0].s <= 6 && changes[0].bitrate < tv[0].bitrate.start, `first change ${JSON.stringify(changes[0])}`);
    const down = changes.find((c) => c.step !== undefined);
    assert.ok(down && down.s <= 14, 'a step down');
    assert.equal(tv[down.step].name, '720p30');
    assert.ok(changes.every((c, i) => i === 0 || c.step !== undefined || c.bitrate < changes[i - 1].bitrate || changes[i - 1].step !== undefined), 'no climb in between');
  });

  test('a TV that drops 40% of its frames steps down for decoding, with no probe and no climb while it does', () => {
    const rc = createRateControl({ ladder: all, probeAfter: 20 });
    const changes = drive(rc, 40, () => ({ dropRatio: 0.4 }));
    assert.deepEqual(changes.slice(0, 2).map((c) => [c.s, all[c.step].name, c.cause]), [[4, '720p30', 'decode'], [8, '540p30', 'decode']]);
    assert.ok(!changes.some((c) => c.cause === 'probe' || c.cause === 'up' || (c.step === undefined && c.bitrate)), JSON.stringify(changes));
    assert.deepEqual(changes.find((c) => c.exhausted), { s: 14, exhausted: true }, 'nothing left below and still dropping: back to frames');
  });

  test('a TV player error: once, no step change; twice, a step down held for 10 minutes, then back', () => {
    let t = 0;
    const rc = createRateControl({ ladder: tv, now: () => t });
    assert.equal(rc.tick({ runtimeError: true, tvFresh: false }), null);
    assert.equal(rc.step.name, '1080p30');
    t += 60_000;
    assert.equal(rc.tick({ runtimeError: true, tvFresh: false }).cause, 'error');
    assert.equal(rc.step.name, '720p30');
    drive(rc, 30, () => ({ lag: 0.4 }));
    assert.equal(rc.step.name, '720p30', 'held');
    t += 10 * 60_000;
    let ticks = 0;
    while (rc.step.name === '720p30' && ticks < 30) { rc.tick({}); ticks += 1; }
    assert.equal(rc.step.name, '1080p30', 'tried again once the hold is over');
    const again = createRateControl({ ladder: tv, now: () => t });
    again.tick({ runtimeError: true });
    t += 11 * 60_000;
    assert.equal(again.tick({ runtimeError: true }), null, 'errors 10 minutes apart do not add up');
  });

  test('a step dropped for decoding comes back after the hold and 10 quiet ticks', () => {
    let t = 0;
    const rc = createRateControl({ ladder: tv, now: () => t });
    drive(rc, 4, () => ({ dropRatio: 0.3 }));
    assert.equal(rc.step.name, '720p30');
    t += 10 * 60_000 + 1000;
    for (let i = 0; i < 9; i++) rc.tick({});
    assert.equal(rc.step.name, '720p30');
    assert.equal(rc.tick({}).cause, 'up');
    assert.equal(rc.step.name, '1080p30');
  });

  test('a refusal blames the step it came in on; an encoder that keeps failing blocks its step', () => {
    const rc = createRateControl({ ladder: tv });
    for (let i = 0; i < 6; i++) rc.tick({ drops: 1 });
    assert.equal(rc.step.name, '720p30');
    assert.deepEqual(rc.tick({ refused: true, refusedIndex: 0 }), { resync: true }, 'the old step is blocked, the player started over');
    for (let i = 0; i < 120; i++) rc.tick({});
    assert.equal(rc.step.name, '720p30', 'never back to the refused step');
    const enc = createRateControl({ ladder: tv });
    assert.deepEqual([enc.encoderFailed().cause, enc.step.name], ['encoder', '720p30']);
    for (let i = 0; i < 120; i++) enc.tick({});
    assert.equal(enc.step.name, '720p30', 'blocked for good');
    enc.encoderFailed();
    assert.deepEqual(enc.encoderFailed(), { exhausted: true });
  });
});

// ---------- the feature, against a fake browser (no Edge) ----------

// A stand-in for Lumen's headless Edge: DevTools' /json/new opens the capture page, which here is a
// WebSocket client the test drives; Runtime.evaluate answers lumenEncoders, document.title and
// lumenStart (lumenStart(n) → a value, or a promise that never settles for a call never answered).
async function fakeBrowser({ lumenStart = async () => ({ audio: true }), title = async () => 'Page' } = {}) {
  const calls = { ensureRunning: 0, starts: 0 };
  const pages = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/json/new') {
      const target = new URL(url.search.slice(1));
      const ws = new WsClient(`ws://${target.host}/ws?t=${target.searchParams.get('t')}`);
      const page = { ws, got: [] };
      pages.push(page);
      ws.on('message', (raw, binary) => { if (!binary) page.got.push(JSON.parse(String(raw))); });
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', clock: Date.now() })));
      ws.on('error', () => {});
      res.end(JSON.stringify({ id: `cap${pages.length}`, webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/cap` }));
    } else res.end('{}');
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => ws.on('message', async (raw) => {
    const msg = JSON.parse(String(raw));
    const expr = msg.params?.expression ?? '';
    let value;
    if (expr.startsWith('lumenEncoders(')) value = {};
    else if (expr === 'document.title') value = await title();
    else if (expr.startsWith('document.title =')) value = 'x';
    else if (expr.startsWith('lumenStart(')) { calls.starts += 1; value = await lumenStart(calls.starts); }
    if (value !== undefined && ws.readyState === 1) ws.send(JSON.stringify({ id: msg.id, result: { result: { value } } }));
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const feature = {
    devtools: () => ({ port: server.address().port, targetId: 'main' }),
    ensureRunning: async () => { calls.ensureRunning += 1; },
    setTvScale: async () => {},
    fitContents: async () => {},
  };
  return {
    feature, calls, pages,
    page: () => pages.at(-1),
    close() {
      for (const p of pages) p.ws.terminate();
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.closeAllConnections?.();
      server.close();
    },
  };
}

function liveFeature(edge, liveVideo = {}) {
  const logs = [];
  const logger = { child: () => logger };
  for (const level of ['debug', 'info', 'warn', 'error']) logger[level] = (msg, data) => logs.push({ level, msg, data });
  const live = createLiveVideo({
    config: { liveVideo: { enabled: true, maxHeight: 1080, maxFps: 30, controlMs: 100, ...liveVideo } },
    log: logger, store: { set() {} }, browser: () => edge.feature,
  });
  return { live, logs };
}

// A TV agent as live.js behaves: it reports only once it has had an init segment (then every everyMs).
function fakeTv({ everyMs = 200 } = {}) {
  const tv = { got: [], fallbacks: [], handle: null, timer: null };
  tv.stop = () => { clearInterval(tv.timer); tv.timer = null; };
  tv.viewer = {
    send(buf) {
      const m = parseMessage(buf);
      tv.got.push(m);
      if (m.kind === 'init' && !tv.timer && !tv.silent) {
        let decoded = 0;
        tv.timer = setInterval(() => { decoded += 6; tv.handle?.report({ lag: 0.4, dropped: 0, decoded, stalls: 0, jumps: 0 }); }, everyMs);
      }
      return true;
    },
    buffered: () => 0,
    onFallback: (reason) => { tv.fallbacks.push(reason); tv.stop(); },
  };
  return tv;
}

const caps30 = Object.fromEntries(TV_CODEC_PROBES.map((c) => [c, c.startsWith('avc1')]));
async function until(fn, ms = 5000, what = 'the condition') {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// What the capture page sends: its configs, then encoded chunks ([kind, flags, 0, 0, f64 ts LE] + data).
function chunk(kind, key, ts, data) {
  const head = Buffer.alloc(12);
  head[0] = kind;
  head[1] = key ? 1 : 0;
  head.writeDoubleLE(ts, 4);
  return Buffer.concat([head, data]);
}
function streamFrom(page, { seconds = 1, from = 0 } = {}) {
  page.ws.send(JSON.stringify({ t: 'vconfig', codec: 'avc1.640028', width: 1920, height: 1080, fps: 30, format: 'avc', description: AVCC.toString('base64') }));
  page.ws.send(JSON.stringify({ t: 'aconfig', sampleRate: 48000, channels: 2, description: ASC.toString('base64') }));
  for (let i = 0; i < seconds * 30; i++) page.ws.send(chunk(2, i % 30 === 0, from + i * 33_333, Buffer.from('v')));
}
const configsOf = (page) => page.got.filter((m) => m.t === 'config');

describe('the feature (a fake browser, no Edge)', () => {
  test('a start that fails twice ends in "could not start", not "stopped reporting", and the next start is not lowered', async () => {
    let answer = false;
    const edge = await fakeBrowser({ lumenStart: async () => (answer ? { audio: true } : new Promise(() => {})) });
    // Timings where a watchdog counted from attach would fire long before the start gives up.
    const { live, logs } = liveFeature(edge, { pickTimeoutMs: 400, retryMs: [50], statsGraceMs: 200, statsLateMs: 150, statsGoneMs: 300 });
    const tv = fakeTv();
    const tv2 = fakeTv();
    try {
      tv.handle = live.attach(tv.viewer, caps30);
      await until(() => tv.fallbacks.length, 5000, 'the fallback');
      assert.equal(edge.calls.starts, 2, 'tried twice');
      assert.match(tv.fallbacks[0], /^live video could not start: the tab capture did not start/);
      assert.ok(!logs.some((l) => /stopped reporting|live video step/.test(l.msg)), 'no watchdog and no step change before any init');
      tv.handle.detach();
      answer = true;
      tv2.handle = live.attach(tv2.viewer, caps30);
      await until(() => edge.page() && configsOf(edge.page()).length, 5000, 'the capture config');
      const config = configsOf(edge.page())[0];
      assert.deepEqual([config.width, config.height], [1920, 1080], 'starts at 1080p30, not lower');
      tv2.handle.detach();
    } finally {
      tv.stop();
      tv2.stop();
      await live.stop();
      edge.close();
    }
  });

  test('the TV’s silence counts from its first init: a slow first frame is not "stopped reporting"', async () => {
    const edge = await fakeBrowser();
    const { live } = liveFeature(edge, { statsGraceMs: 200, statsLateMs: 150, statsGoneMs: 300 });
    const tv = fakeTv();
    try {
      tv.handle = live.attach(tv.viewer, caps30);
      await until(() => edge.page() && configsOf(edge.page()).length, 5000, 'the capture config');
      await sleep(900); // the encoder's first frame is slow: no init yet, so the TV says nothing
      assert.deepEqual(tv.fallbacks, []);
      streamFrom(edge.page());
      await until(() => tv.got.some((m) => m.kind === 'media'), 5000, 'the stream');
      await sleep(800); // the TV reports every 200 ms from its init on
      assert.deepEqual(tv.fallbacks, []);
      tv.stop(); // and then it falls silent
      await until(() => tv.fallbacks.length, 3000, 'the fallback');
      assert.deepEqual(tv.fallbacks, ['the TV stopped reporting']);
    } finally {
      tv.stop();
      await live.stop();
      edge.close();
    }
  });

  test('a viewer gone while a capture retry is pending: the browser is not started again', async () => {
    const edge = await fakeBrowser({ lumenStart: () => new Promise(() => {}) });
    const { live, logs } = liveFeature(edge, { pickTimeoutMs: 200, retryMs: [300, 300] });
    const tv = fakeTv();
    try {
      tv.handle = live.attach(tv.viewer, caps30);
      await until(() => logs.some((l) => l.msg === 'live video could not start'), 3000, 'the first failure');
      const before = edge.calls.ensureRunning;
      tv.handle.detach();
      await sleep(700);
      assert.equal(edge.calls.ensureRunning, before, 'no ensureRunning for nobody');
    } finally {
      tv.stop();
      await live.stop();
      edge.close();
    }
  });

  test('a browser that does not answer ends the attempt instead of hanging it', async () => {
    const edge = await fakeBrowser({ title: () => new Promise(() => {}) });
    const { live } = liveFeature(edge, { browserTimeoutMs: 300, retryMs: [50] });
    const tv = fakeTv();
    try {
      tv.handle = live.attach(tv.viewer, caps30);
      await until(() => tv.fallbacks.length, 5000, 'the fallback');
      assert.match(tv.fallbacks[0], /could not start: the browser did not answer/);
    } finally {
      tv.stop();
      await live.stop();
      edge.close();
    }
  });

  test('a capture that encodes nothing is configured again; an encoder that keeps failing drops the step', async () => {
    const edge = await fakeBrowser();
    const { live } = liveFeature(edge);
    const tv = fakeTv();
    try {
      tv.handle = live.attach(tv.viewer, caps30);
      await until(() => edge.page() && configsOf(edge.page()).length, 5000, 'the capture config');
      const page = edge.page();
      page.ws.send(JSON.stringify({ t: 'stats', frames: 30, repeats: 0, bytes: 0 }));
      page.ws.send(JSON.stringify({ t: 'stats', frames: 30, repeats: 0, bytes: 0 }));
      await until(() => configsOf(page).length === 2, 3000, 'a second config');
      assert.equal(configsOf(page)[1].width, 1920, 'the same step');
      // Failures the page recovered from do not count; three it did not, within a minute, do.
      page.ws.send(JSON.stringify({ t: 'error', where: 'video encoder', message: 'recreated', recovered: true }));
      for (let i = 0; i < 3; i++) page.ws.send(JSON.stringify({ t: 'error', where: 'video encoder', message: 'EncodingError' }));
      await until(() => configsOf(page).length === 3, 3000, 'the step down');
      assert.deepEqual([configsOf(page)[2].width, configsOf(page)[2].height], [1280, 720]);
    } finally {
      tv.stop();
      await live.stop();
      edge.close();
    }
  });
});

// ---------- the capture page (livecapture.html), its script run in a vm with fake WebCodecs ----------

describe('the capture page', () => {
  const html = fs.readFileSync(new URL('../server/features/livecapture.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  function page() {
    const sent = [];
    const timers = [];
    const encoders = [];
    let failConfigure = 0;
    class FakeWebSocket {
      constructor() { this.readyState = 1; this.bufferedAmount = 0; FakeWebSocket.last = this; }
      send(data) { if (typeof data === 'string') sent.push(JSON.parse(data)); }
    }
    class FakeVideoEncoder {
      constructor(init) { this.init = init; this.state = 'unconfigured'; this.encodeQueueSize = 0; encoders.push(this); }
      configure(config) {
        if (failConfigure > 0) { failConfigure -= 1; throw new Error('NotSupportedError'); }
        this.config = config;
        this.state = 'configured';
      }
      close() { this.state = 'closed'; }
      fail(message) { this.state = 'closed'; this.init.error(new Error(message)); } // as WebCodecs does
    }
    const context = {
      URLSearchParams, URL, JSON, Math, String, Promise, Uint8Array, DataView, ArrayBuffer, Float32Array, btoa, console,
      location: { search: '?t=x', host: '127.0.0.1:1' },
      performance: { now: () => 0, timeOrigin: 0 },
      WebSocket: FakeWebSocket, VideoEncoder: FakeVideoEncoder,
      navigator: {},
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: (id) => { if (id) timers[id - 1] = null; },
      setInterval: () => 0, clearInterval: () => {},
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(script, context);
    const ws = FakeWebSocket.last;
    const runTimers = () => { const list = timers.splice(0); list.forEach((t) => t && t.fn()); };
    return { sent, encoders, ws, runTimers, failNext: (n = 1) => { failConfigure = n; }, message: (msg) => ws.onmessage({ data: JSON.stringify(msg) }) };
  }
  const config = { t: 'config', codec: 'avc1.640028', width: 1920, height: 1080, fps: 30, bitrate: 5e6, gop: 30 };

  test('a video encoder that fails is replaced a second later with the same config, and that is reported', async () => {
    const p = page();
    await p.message(config);
    assert.equal(p.encoders.length, 1);
    assert.equal(p.encoders[0].state, 'configured');
    p.encoders[0].fail('EncodingError');
    assert.deepEqual(p.sent.map((m) => [m.t, m.where]), [['error', 'video encoder']]);
    assert.equal(p.encoders.length, 1, 'not at once');
    p.runTimers();
    assert.equal(p.encoders.length, 2);
    assert.equal(p.encoders[1].state, 'configured');
    assert.equal(p.encoders[1].config.width, 1920);
    assert.deepEqual(p.sent.at(-1), { t: 'error', where: 'video encoder', message: 'recreated', recovered: true });
    p.encoders[0].init.error(new Error('late')); // a late error of the old encoder changes nothing
    p.runTimers();
    assert.equal(p.encoders.length, 2);
    assert.equal(p.sent.filter((m) => m.t === 'error').length, 2);
  });

  test('a replacement that cannot be configured is tried again, a second at a time', async () => {
    const p = page();
    await p.message(config);
    p.encoders[0].fail('EncodingError');
    p.failNext(1);
    p.runTimers();
    assert.equal(p.sent.filter((m) => m.t === 'error' && !m.recovered).length, 2, 'the failed try is reported (Lumen counts these)');
    p.runTimers();
    assert.equal(p.encoders.at(-1).state, 'configured');
    assert.equal(p.sent.at(-1).recovered, true);
    p.message({ t: 'stop' });
    p.encoders.at(-1).fail('EncodingError');
    p.runTimers();
    assert.equal(p.encoders.at(-1).state, 'closed', 'not after a stop');
  });
});
