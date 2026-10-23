// Live video (features/livevideo.js, util/fmp4.js): fMP4 boxes and codec strings, the muxer (init
// segment once video and audio are configured, a timeline from the first key frame, contiguous AAC),
// the TV message framing, the fan-out (key frame on join, skip to the next key frame when the link is
// backed up, audio riding with video, pause/resume) and the bitrate / step control.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  initSegment, fragment, listBoxes, findBox, avcCodecString, hevcCodecString, buildHvcC, splitAnnexB, parseHevcSps, mimeType,
  VIDEO_TRACK, AUDIO_TRACK,
} from '../server/util/fmp4.js';
import {
  createMuxer, createFanout, createRateControl, usableLadder, startIndexOf, initMessage, mediaMessage, parseMessage, TV_CODEC_PROBES,
} from '../server/features/livevideo.js';

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
    return { fan, viewer, init, media, keys: () => keys };
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

  test('a backed-up link skips to the next key frame and asks for one', () => {
    const { fan, viewer, init, media, keys } = setup();
    init();
    let open = true;
    const v = viewer(() => open);
    fan.add(v);
    media(true, 'K1');
    open = false;
    const before = keys();
    media(false, 'P1');
    assert.ok(keys() > before, 'a key frame is requested');
    open = true;
    media(false, 'P2');
    media(true, 'K2');
    assert.deepEqual(v.got.filter((m) => m.kind === 'media').map((m) => m.data.toString()), ['K1', 'K2']);
    assert.equal(fan.takeStats(v).drops, 1);
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
  const full = usableLadder({ caps: allCaps, maxHeight: 2160 });
  const tv = usableLadder({ caps: allCaps }); // the default: 1080p at most

  test('the ladder follows the TV, the encoder and maxHeight; it starts at 1080p30, never at 4K', () => {
    assert.deepEqual(tv.map((s) => s.name), ['1080p30', '720p30', '540p30']);
    assert.ok(tv.every((s) => s.fps === 30), '30 fps throughout for this TV');
    assert.deepEqual(full.map((s) => `${s.name}:${s.codec.family}`), ['2160p30:hevc', '1080p30:avc', '720p30:avc', '540p30:avc']);
    assert.equal(startIndexOf(full), 1, '4K is a probe step');
    assert.equal(startIndexOf(full, 1), 2, 'one step lower after the TV went away');
    const noHevc = usableLadder({ caps: { 'avc1.640033': true, 'avc1.640028': true }, encoders: { '2160p30:hevc': true }, maxHeight: 2160 });
    assert.deepEqual(noHevc.map((s) => `${s.name}:${s.codec.family}`), ['2160p30:avc', '1080p30:avc', '720p30:avc', '540p30:avc']);
    const noEncoder = usableLadder({ caps: allCaps, encoders: { '2160p30:hevc': false, '2160p30:avc': false }, maxHeight: 2160 });
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
    assert.equal(rc.tick({ dropRatio: 0.2 }).cause, 'probe-failed');
    assert.equal(rc.step.name, '1080p30');
    for (let i = 0; i < 60; i++) rc.tick({});
    assert.equal(rc.step.name, '1080p30', 'not tried again');
  });

  test('a step lowered for congestion is tried again after a quiet while', () => {
    const rc = createRateControl({ ladder: tv });
    for (let i = 0; i < 6; i++) rc.tick({ drops: 1 });
    assert.equal(rc.step.name, '720p30');
    for (let i = 0; i < 60 && rc.step.name !== '1080p30'; i++) rc.tick({});
    assert.equal(rc.step.name, '1080p30');
  });
});
