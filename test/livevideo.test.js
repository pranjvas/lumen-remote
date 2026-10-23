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
  createMuxer, createFanout, createRateControl, usableLadder, initMessage, mediaMessage, parseMessage, LADDER, TV_CODEC_PROBES,
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
  function run(clock = { t: 0 }) {
    const out = [];
    const mux = createMuxer({ emit: (m) => out.push(m), now: () => clock.t });
    return { mux, out, clock };
  }
  const vconfig = (extra = {}) => ({ t: 'vconfig', codec: 'avc1.64002A', width: 1920, height: 1080, fps: 60, format: 'avc', description: AVCC.toString('base64'), ...extra });

  test('the init segment waits for audio, then media starts at a key frame at time 0', () => {
    const { mux, out } = run();
    mux.videoConfig(vconfig());
    mux.video(1_000_000, false, Buffer.from('p'));
    assert.equal(out.length, 0, 'nothing before the audio config (or its timeout)');
    mux.audioConfig({ sampleRate: 48000, channels: 2, description: ASC.toString('base64') });
    assert.equal(out[0].kind, 'init');
    assert.equal(out[0].mime, 'video/mp4; codecs="avc1.64002A,mp4a.40.2"');
    assert.equal(out[0].reset, true);
    mux.video(1_016_000, false, Buffer.from('p'));
    assert.equal(out.length, 1, 'a frame that is not a key frame is not the start');
    mux.video(1_033_000, true, Buffer.from('k'));
    mux.video(1_050_000, false, Buffer.from('p'));
    const media = out.filter((m) => m.kind === 'media');
    assert.deepEqual(media.map((m) => [m.track, m.key, +m.time.toFixed(3)]), [['video', true, 0], ['video', false, 0.017]]);
  });

  test('without audio the init segment goes after the wait, video only', () => {
    const { mux, out, clock } = run();
    mux.videoConfig(vconfig());
    mux.video(0, true, Buffer.from('k'));
    clock.t = 2000;
    mux.video(16_000, false, Buffer.from('p'));
    assert.equal(out[0].kind, 'init');
    assert.equal(out[0].audio, false);
    assert.equal(out[0].mime, 'video/mp4; codecs="avc1.64002A"');
  });

  test('AAC frames follow each other exactly; a real gap is kept', () => {
    const { mux, out } = run();
    mux.videoConfig(vconfig());
    mux.audioConfig({ sampleRate: 48000, channels: 2 });
    mux.video(100_000, true, Buffer.from('k'));
    mux.audio(100_000, Buffer.from('a'));
    mux.audio(121_400, Buffer.from('a')); // 21.4 ms later: jitter around 1024 samples
    mux.audio(500_000, Buffer.from('a')); // a gap in the capture
    const audio = out.filter((m) => m.track === 'audio').map((m) => Math.round(m.time * 48000));
    assert.deepEqual(audio, [0, 1024, 19200]);
  });

  test('a new size is a new init without reset; a new codec family resets', () => {
    const { mux, out } = run();
    mux.videoConfig(vconfig());
    mux.audioConfig({ sampleRate: 48000, channels: 2 });
    mux.video(0, true, Buffer.from('k'));
    mux.videoConfig(vconfig({ codec: 'avc1.640028', width: 1280, height: 720, description: Buffer.concat([AVCC.subarray(0, 3), Buffer.from([0x28]), AVCC.subarray(4)]).toString('base64') }));
    const inits = out.filter((m) => m.kind === 'init');
    assert.equal(inits.length, 2);
    assert.equal(inits[1].reset, false);
    assert.equal(inits[1].codec, 'avc1.640028');
    // HEVC (Annex B): the record comes from the next key frame's parameter sets.
    mux.videoConfig({ t: 'vconfig', codec: 'hvc1.1.6.L153.B0', width: 320, height: 240, fps: 30, format: 'annexb' });
    mux.video(50_000, true, annexB([...HEVC_UNITS, Buffer.from([0x26, 0x01, 0xaf])]));
    const last = out.filter((m) => m.kind === 'init').at(-1);
    assert.equal(last.codec, 'hvc1.4.10.L60.9E.8');
    assert.equal(last.reset, true);
    const media = out.at(-1);
    assert.equal(media.kind, 'media');
    assert.ok(!media.buf.includes(HEVC_UNITS[1]), 'parameter sets are not repeated in the samples');
    assert.ok(media.time > 0, 'the timeline continues');
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
    const timers = [];
    const fan = createFanout({
      requestKey: () => { keys += 1; },
      now: (() => { let t = 0; return () => (t += 1000); })(),
      setTimer: (fn) => { timers.push(fn); return timers.length; },
      clearTimer: () => {},
      limitBytes: () => 100,
    });
    const viewer = (accept = () => true) => {
      const got = [];
      return { got, send: (buf, opts) => { if (!accept(buf, opts)) return false; got.push(parseMessage(buf)); return true; } };
    };
    const init = (extra = {}) => fan.onInit({ mime: 'video/mp4', codec: 'avc1.64002A', width: 1920, height: 1080, fps: 60, audio: true, reset: true, buf: Buffer.from('I'), ...extra });
    const media = (track, key, tag = track[0]) => fan.onMedia({ track, key, buf: Buffer.from(tag), time: 0 });
    return { fan, viewer, init, media, timers, keys: () => keys };
  }

  test('a viewer that joins gets the init segment, asks for a key frame, and starts at one', () => {
    const { fan, viewer, init, media, keys } = setup();
    init();
    const v = viewer();
    fan.add(v);
    assert.equal(v.got[0].kind, 'init');
    assert.equal(v.got[0].info.reset, true);
    assert.ok(keys() >= 1);
    media('video', false);
    media('audio', true);
    assert.equal(v.got.length, 1, 'nothing until the key frame');
    media('video', true, 'K');
    media('audio', true, 'A');
    media('video', false, 'P');
    assert.deepEqual(v.got.slice(1).map((m) => [m.key, m.data.toString()]), [[true, 'K'], [false, 'AP']], 'audio rides with the next video fragment');
  });

  test('a backed-up link skips to the next key frame and asks for one', () => {
    const { fan, viewer, init, media, keys } = setup();
    init();
    let open = true;
    const v = viewer(() => open);
    fan.add(v);
    media('video', true, 'K1');
    open = false;
    const before = keys();
    media('video', false, 'P1');
    assert.ok(keys() > before, 'a key frame is requested');
    open = true;
    media('video', false, 'P2');
    media('video', true, 'K2');
    assert.deepEqual(v.got.filter((m) => m.kind === 'media').map((m) => m.data.toString()), ['K1', 'K2']);
    assert.equal(fan.takeStats(v).drops, 1);
  });

  test('pause holds everything; resume restarts from a fresh init and a key frame', () => {
    const { fan, viewer, init, media } = setup();
    init();
    const v = viewer();
    fan.add(v);
    media('video', true, 'K1');
    fan.pause(v);
    media('video', false, 'P');
    media('video', true, 'K2');
    fan.resume(v);
    media('video', false, 'P3');
    media('video', true, 'K3');
    const kinds = v.got.map((m) => (m.kind === 'init' ? `init${m.info.reset ? '!' : ''}` : m.data.toString()));
    assert.deepEqual(kinds, ['init!', 'K1', 'init!', 'K3']);
  });

  test('a new init goes to every viewer; media of an older stream is never mixed in', () => {
    const { fan, viewer, init, media } = setup();
    init();
    const v = viewer();
    fan.add(v);
    media('video', true, 'K1');
    init({ reset: false, width: 1280, height: 720 });
    media('video', true, 'K2');
    const msgs = v.got;
    assert.equal(msgs.at(-2).kind, 'init');
    assert.equal(msgs.at(-2).info.reset, false);
    assert.equal(msgs.at(-1).gen, msgs.at(-2).gen);
  });
});

describe('rate control and the ladder', () => {
  const ladder = usableLadder({ caps: Object.fromEntries(TV_CODEC_PROBES.map((c) => [c, true])) });

  test('the ladder follows the TV and the encoder; HEVC first at 4K', () => {
    assert.deepEqual(ladder.map((s) => `${s.name}:${s.codec.family}`), ['2160p30:hevc', '1080p60:avc', '720p60:avc']);
    const noHevc = usableLadder({ caps: { 'avc1.640033': true, 'avc1.64002A': true, 'avc1.640028': true }, encoders: { '2160p30:hevc': true } });
    assert.deepEqual(noHevc.map((s) => `${s.name}:${s.codec.family}`), ['2160p30:avc', '1080p60:avc', '720p60:avc']);
    const capped = usableLadder({ caps: Object.fromEntries(TV_CODEC_PROBES.map((c) => [c, true])), maxHeight: 1080 });
    assert.equal(capped[0].name, '1080p60');
    const noEncoder = usableLadder({ caps: Object.fromEntries(TV_CODEC_PROBES.map((c) => [c, true])), encoders: { '2160p30:hevc': false, '2160p30:avc': false } });
    assert.equal(noEncoder[0].name, '1080p60');
  });

  test('congestion lowers the bitrate to the floor, then steps down; quiet raises it again', () => {
    const rc = createRateControl({ ladder });
    assert.equal(rc.bitrate, LADDER[0].bitrate.start);
    let change;
    for (let i = 0; i < 10 && rc.bitrate > ladder[0].bitrate.min; i++) change = rc.tick({ drops: 1 });
    assert.equal(rc.bitrate, ladder[0].bitrate.min);
    const steps = [];
    for (let i = 0; i < 3; i++) steps.push(rc.tick({ queueSec: 1 }));
    assert.deepEqual(steps.slice(0, 2), [null, null], 'two congested seconds at the floor are borne');
    assert.equal(steps[2].step, 1);
    assert.equal(rc.step.name, '1080p60');
    for (let i = 0; i < 8; i++) change = rc.tick({});
    assert.ok(rc.bitrate > ladder[1].bitrate.start, 'the bitrate creeps back up');
  });

  test('a TV that drops frames or refuses the format gets the next step; the end is reported', () => {
    const rc = createRateControl({ ladder });
    for (let i = 0; i < 3; i++) rc.tick({ dropRatio: 0.3 });
    assert.equal(rc.step.name, '1080p60');
    assert.equal(rc.tick({ refused: true }).step, 2);
    assert.deepEqual(rc.tick({ refused: true }), { exhausted: true });
  });

  test('a step lowered for congestion is tried again after a quiet while', () => {
    const rc = createRateControl({ ladder });
    for (let i = 0; i < 6; i++) rc.tick({ drops: 1 });
    assert.equal(rc.step.name, '1080p60');
    let up = null;
    for (let i = 0; i < 60 && !up?.step && up?.step !== 0; i++) up = rc.tick({});
    assert.equal(rc.step.name, '2160p30');
  });
});
