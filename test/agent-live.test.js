// The TV agent's live video player (companion/agent/live.js), run in a vm with a fake MediaSource and
// <video>: the offer answer with the TV's codec support, init → SourceBuffer, fragments of the
// current stream only, refusal of a format the TV does not take, the quota and backlog resync, the
// start on a key frame (the only seek: seeks get this TV's page killed), a stuck, unstarted or broken
// player started over by the PC (never refused: the PC steps down for a while when it keeps
// happening), and the stop. Also: the agent's scripts stay within the TV's ES2017 engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { initMessage, mediaMessage } from '../server/features/livevideo.js';

const SOURCE = readFileSync(new URL('../companion/agent/live.js', import.meta.url), 'utf8');
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

function setup({ supported = (t) => /avc1/.test(t) } = {}) {
  const clock = { now: 1_000_000 };
  const FakeDate = { now: () => clock.now };
  const sent = [];
  const timers = [];
  const appended = [];
  let quota = false;
  class FakeSourceBuffer {
    constructor(type) { this.type = type; this.updating = false; this.mode = 'segments'; this.listeners = {}; this.removed = []; }
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
    appendBuffer(data) {
      if (quota) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; }
      appended.push(Buffer.from(data));
      this.updating = true;
      Promise.resolve().then(() => { this.updating = false; (this.listeners.updateend || []).forEach((fn) => fn()); });
    }
    remove(a, b) { this.removed.push([a, b]); }
  }
  class FakeMediaSource {
    constructor() { this.readyState = 'closed'; this.listeners = {}; this.buffers = []; FakeMediaSource.last = this; }
    static isTypeSupported(t) { return supported(t); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    addSourceBuffer(type) { const sb = new FakeSourceBuffer(type); this.buffers.push(sb); return sb; }
    endOfStream() { this.readyState = 'ended'; }
    open() { this.readyState = 'open'; this.listeners.sourceopen(); }
  }
  const ranges = [];
  let currentTime = 0;
  const writes = []; // currentTime set by the player (seeks)
  const video = {
    style: {}, muted: true, paused: true, playbackRate: 1, videoWidth: 1920, videoHeight: 1080, error: null,
    buffered: { get length() { return ranges.length; }, start: (i) => ranges[i][0], end: (i) => ranges[i][1] },
    play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
    removeAttribute() {}, load() {},
    getVideoPlaybackQuality() { return { droppedVideoFrames: 2, totalVideoFrames: 100 }; },
  };
  Object.defineProperty(video, 'currentTime', { get: () => currentTime, set: (v) => { writes.push(v); currentTime = v; }, enumerable: true });
  const notes = [];
  const classes = new Set();
  const root = { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
  const context = {
    window: {}, console, Uint8Array, DataView, ArrayBuffer, JSON, Math, Date: FakeDate, Object, Array, String, Promise, TextDecoder,
    MediaSource: FakeMediaSource,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval: (id) => { if (id) timers[id - 1] = null; },
    setTimeout, clearTimeout,
  };
  context.window = context;
  context.LumenBox = { note: (kind, data) => notes.push({ kind, data }) };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  const live = context.LumenLive;
  live.init((m) => { sent.push(JSON.parse(JSON.stringify(m))); return true; }, video, root);
  const tick = (ms) => timers.filter((t) => t && t.ms === ms).forEach((t) => t.fn());
  // The playhead moves on its own (playback, not a seek by the player).
  const setTime = (v) => { currentTime = v; };
  return { live, sent, appended, video, ranges, classes, tick, clock, writes, notes, setTime, ms: () => FakeMediaSource.last, setQuota: (v) => { quota = v; } };
}

const init = (gen, info) => ab(initMessage(gen, { mime: 'video/mp4; codecs="avc1.64002A,mp4a.40.2"', reset: true, ...info }, Buffer.from('INIT')));
const media = (gen, key, text) => ab(mediaMessage(gen, key, [Buffer.from(text)]));
const flush = () => new Promise((r) => setImmediate(r));
// A key fragment whose video starts at `sec` (a tfdt box, version 1, 90 kHz), as the PC sends it.
const keyAt = (gen, sec) => {
  const time = Buffer.alloc(8);
  time.writeBigUInt64BE(BigInt(Math.round(sec * 90000)));
  return ab(mediaMessage(gen, true, [Buffer.concat([Buffer.from('\x00\x00\x00 moof\x00\x00\x00\x14tfdt\x01\x00\x00\x00', 'latin1'), time, Buffer.alloc(16)])]));
};

test('the offer is answered with what the TV takes', () => {
  const { live, sent } = setup();
  live.message({ t: 'screen-live-offer', probes: ['avc1.64002A', 'hvc1.1.6.L153.B0'] });
  assert.deepEqual(sent.at(-1), { t: 'screen-live', state: 'ready', caps: { 'avc1.64002A': true, 'hvc1.1.6.L153.B0': false } });
});

test('init opens a SourceBuffer; fragments of the current stream are appended, others ignored', async () => {
  const { live, appended, ms } = setup();
  assert.equal(live.data(init(4)), true);
  ms().open();
  assert.equal(ms().buffers[0].type, 'video/mp4; codecs="avc1.64002A,mp4a.40.2"');
  live.data(media(4, true, 'K'));
  live.data(media(3, false, 'old'));
  await flush();
  live.data(media(4, false, 'P'));
  await flush();
  assert.deepEqual(appended.map((b) => b.toString()), ['INIT', 'K', 'P']);
  assert.equal(live.data(new Uint8Array([0xff, 0xd8, 0, 0, 0, 0, 0, 0]).buffer), false, 'a JPEG is not live video');
});

test('a format the TV does not take is refused; the TV string of the step is tried first', () => {
  const { live, sent, ms } = setup({ supported: (t) => /hvc1\.1\.6\.L153/.test(t) });
  live.data(init(1, { mime: 'video/mp4; codecs="hvc1.1.6.H150.90,mp4a.40.2"', tvMime: 'video/mp4; codecs="hvc1.1.6.L153.B0,mp4a.40.2"' }));
  ms().open();
  assert.equal(ms().buffers[0].type, 'video/mp4; codecs="hvc1.1.6.L153.B0,mp4a.40.2"');
  live.data(init(2, { mime: 'video/mp4; codecs="avc1.640033,mp4a.40.2"', tvMime: null }));
  assert.equal(sent.at(-1).state, 'refused');
  assert.match(sent.at(-1).reason, /not supported/);
});

test('a full buffer drops the backlog and asks for a fresh start', async () => {
  const { live, sent, ms, setQuota, ranges, video } = setup();
  live.data(init(1));
  ms().open();
  await flush();
  ranges.push([0, 10]);
  video.currentTime = 9;
  setQuota(true);
  live.data(media(1, true, 'K'));
  assert.equal(sent.at(-1).state, 'resync');
  setQuota(false);
  live.data(media(1, false, 'P'));
  await flush();
  assert.ok(!sent.some((m) => m.state === 'refused'));
});

test('playback starts on a key frame, catches up gently, and never seeks to catch up', async () => {
  const { live, sent, ms, ranges, video, tick, classes, clock, writes, notes, setTime } = setup();
  live.data(init(1));
  ms().open();
  await flush();
  live.data(keyAt(1, 5.2));
  await flush();
  ranges.push([5, 6]);
  tick(500);
  assert.equal(video.currentTime, 5.2, 'starts on the newest key frame');
  assert.equal(writes.length, 1, 'the start is the one seek');
  assert.equal(video.paused, false);
  video.onplaying();
  assert.ok(classes.has('live'));
  assert.equal(sent.find((m) => m.state === 'playing').w, 1920);
  clock.now += 500;
  setTime(5.5);
  ranges[0][1] = 6.6; // 1.1 s behind: a little faster, no seek
  tick(500);
  assert.equal(video.currentTime, 5.5);
  assert.ok(video.playbackRate > 1);
  assert.deepEqual({ ...notes.filter((n) => n.kind === 'live-rate').at(-1).data }, { to: 1.1, t: 5.5, lag: 1.1 }, 'rate changes go to the black box');
  live.data(keyAt(1, 9.1));
  await flush();
  clock.now += 500;
  setTime(5.55);
  ranges[0][1] = 9.7; // far behind half a second later: the rate stays (one change per dwell)
  tick(500);
  assert.ok(video.playbackRate > 1, 'no second rate change within the dwell');
  clock.now += 4000;
  setTime(5.6);
  ranges[0][1] = 9.7; // 4.1 s behind: no seek (the PC sheds the lag), and back to normal speed
  tick(500);
  assert.equal(video.currentTime, 5.6);
  assert.equal(video.playbackRate, 1);
  for (let i = 0; i < 18; i++) { clock.now += 500; setTime(video.currentTime + 0.5); ranges[0][1] += 0.5; tick(500); }
  assert.equal(writes.length, 1, 'no seek after the start, however long it lags');
  assert.ok(!sent.some((m) => m.state === 'resync' || m.state === 'refused'));
  setTime(video.currentTime - 1); // the playhead went back on its own: noted
  clock.now += 500;
  tick(500);
  assert.ok(notes.some((n) => n.kind === 'live-back'));
  tick(2000);
  const stats = sent.filter((m) => m.state === 'stats').at(-1);
  assert.deepEqual([stats.dropped, stats.decoded, stats.jumps, stats.rate], [2, 100, 0, 1]);
  live.message({ t: 'screen-live-stop' });
  assert.equal(classes.has('live'), false);
  assert.equal(live.isShowing(), false);
});

// Starts a player on a key frame at `at` s and reports 'playing' unless told not to.
async function started(env, { gen = 1, at = 5.2, playing = true } = {}) {
  env.live.data(init(gen));
  env.ms().open();
  await flush();
  env.live.data(keyAt(gen, at));
  await flush();
  env.ranges.length = 0;
  env.ranges.push([at - 0.2, at + 0.8]);
  env.tick(500);
  if (playing) env.video.onplaying();
  return env.clock.now;
}
// Half-second control ticks, frames arriving all the while, until `until()` or `secs` pass.
function run(env, secs, until = () => false, { moving = false } = {}) {
  for (let i = 0; i < secs * 2 && !until(); i++) {
    env.clock.now += 500;
    env.ranges[0][1] += 0.5;
    if (moving) env.setTime(env.video.currentTime + 0.5);
    env.tick(500);
  }
}

test('a clock that never moves is never seeked: the PC starts it over after ~9 s, every time, never refused', async () => {
  const env = setup();
  const { sent, writes } = env;
  const t0 = await started(env);
  const seeks = writes.length;
  run(env, 20, () => sent.some((m) => m.state === 'resync' || m.state === 'refused'));
  assert.equal(writes.length, seeks, 'no seek while stuck');
  const resyncs = sent.filter((m) => m.state === 'resync');
  assert.equal(resyncs.length, 1);
  assert.deepEqual([resyncs[0].reason, resyncs[0].on], ['stuck', 'clock']);
  const secs = (env.clock.now - t0) / 1000;
  assert.ok(secs >= 6 && secs <= 9.5, `restart asked after ${secs} s`);
  run(env, 5); // waiting for the PC's fresh start: not asked again on every check
  assert.equal(sent.filter((m) => m.state === 'resync').length, 1);
  // The PC starts it over (a reset init: a new MediaSource); that one is stuck too: started over
  // again (the PC counts the restarts and steps down for a while). The TV can play the format.
  const t1 = await started(env, { gen: 2, at: 30 });
  const seeks2 = writes.length;
  run(env, 20, () => sent.filter((m) => m.state === 'resync').length === 2);
  assert.equal(sent.filter((m) => m.state === 'resync').length, 2, 'a second restart');
  assert.ok((env.clock.now - t1) / 1000 <= 9.5);
  assert.ok(!sent.some((m) => m.state === 'refused'), 'never refused');
  assert.equal(writes.length, seeks2, 'no seek on the second player either');
});

test('a player that never starts is started over after ~8 s, not refused (no playing, or no sourceopen)', async () => {
  const env = setup();
  const t0 = await started(env, { playing: false });
  run(env, 20, () => env.sent.some((m) => m.state === 'resync' || m.state === 'refused'));
  const ask = env.sent.find((m) => m.state === 'resync');
  assert.ok(ask, 'a fresh start asked');
  assert.deepEqual([ask.reason, ask.on], ['stuck', 'start']);
  const secs = (env.clock.now - t0) / 1000;
  assert.ok(secs >= 7.5 && secs <= 8.5, `asked after ${secs} s`);
  assert.ok(!env.sent.some((m) => m.state === 'refused'), 'a slow start is not a format the TV cannot play');

  const quiet = setup();
  quiet.live.data(init(1)); // the MediaSource never opens
  const t1 = quiet.clock.now;
  for (let i = 0; i < 40 && !quiet.sent.some((m) => m.state === 'resync'); i++) { quiet.clock.now += 500; quiet.tick(500); }
  assert.equal(quiet.sent.at(-1).state, 'resync');
  assert.ok((quiet.clock.now - t1) / 1000 <= 8.5);
  // The PC does not answer: asked once more, then this player gives up (the PC goes back to frames).
  for (let i = 0; i < 80 && !quiet.sent.some((m) => m.state === 'error'); i++) { quiet.clock.now += 500; quiet.tick(500); }
  assert.deepEqual(quiet.sent.map((m) => [m.state, m.reason]), [['resync', 'stuck'], ['resync', 'no answer'], ['error', 'no fresh start from the PC']]);
  assert.ok((quiet.clock.now - t1) / 1000 <= 24.5);
  for (let i = 0; i < 40; i++) { quiet.clock.now += 500; quiet.tick(500); }
  assert.equal(quiet.sent.length, 3, 'nothing more');
});

test('a player error before it ever played is a refusal; after it played, the PC starts it over', async () => {
  const env = setup();
  env.live.data(init(1));
  env.ms().open();
  await flush();
  env.video.error = { code: 4, message: 'format' };
  env.video.onerror();
  assert.equal(env.sent.at(-1).state, 'refused');
  assert.match(env.sent.at(-1).reason, /^video error 4/);

  const later = setup();
  await started(later);
  run(later, 2, undefined, { moving: true });
  const source = later.ms();
  later.video.error = { code: 3, message: 'decode' };
  later.video.onerror();
  const msg = later.sent.at(-1);
  assert.deepEqual([msg.state, msg.reason], ['resync', 'error']);
  assert.match(msg.on, /^video error 3/);
  assert.equal(later.live.isShowing(), false, 'the broken player is gone');
  source.buffers[0].listeners.error.forEach((fn) => fn()); // the old player's SourceBuffer fails too
  assert.equal(later.sent.filter((m) => m.state === 'resync').length, 1, 'reported once');
  await started(later, { gen: 2, at: 30 }); // the PC's fresh start
  assert.equal(later.live.isShowing(), true);
  assert.ok(!later.sent.some((m) => m.state === 'refused'), 'never refused');
});

test('a seek that never finishes counts as stuck', async () => {
  const env = setup();
  const { sent, video } = env;
  await started(env);
  run(env, 2, undefined, { moving: true });
  video.seeking = true;
  const t0 = env.clock.now;
  run(env, 10, () => sent.some((m) => m.state === 'resync'));
  const restart = sent.find((m) => m.state === 'resync');
  assert.deepEqual([restart.reason, restart.on], ['stuck', 'seeking']);
  assert.ok((env.clock.now - t0) / 1000 > 3 && (env.clock.now - t0) / 1000 <= 4);
  // The PC starts it over; stuck again soon after: started over again, never refused.
  await started(env, { gen: 2, at: 30 });
  run(env, 10, () => sent.filter((m) => m.state === 'resync').length === 2);
  assert.deepEqual(sent.filter((m) => m.state === 'resync').map((m) => m.on), ['seeking', 'seeking']);
  assert.ok(!sent.some((m) => m.state === 'refused'));
});

test('last resort only: far behind for 10 s asks the PC for a restart, at most once per 30 s', async () => {
  const env = setup();
  const { sent, writes } = env;
  await started(env);
  run(env, 1, undefined, { moving: true });
  env.ranges[0][1] = env.video.currentTime + 7; // 7 s behind, playing on
  const t0 = env.clock.now;
  run(env, 12, () => sent.some((m) => m.state === 'resync'), { moving: true });
  const secs = (env.clock.now - t0) / 1000;
  assert.equal(sent.find((m) => m.state === 'resync').reason, 'behind');
  assert.ok(secs >= 10 && secs <= 11, `after ${secs} s`);
  // The PC starts it over; the new player is far behind again at once: no more for now.
  await started(env, { gen: 2, at: 30 });
  run(env, 1, undefined, { moving: true });
  env.ranges[0][1] = env.video.currentTime + 7;
  run(env, 15, undefined, { moving: true });
  assert.equal(sent.filter((m) => m.state === 'resync').length, 1);
  assert.equal(writes.length, 2, 'never a seek, only the start of each player');
});

test('played video is removed every few seconds, not on every check', async () => {
  const { live, ms, ranges, video, tick } = setup();
  live.data(init(1));
  ms().open();
  await flush();
  live.data(keyAt(1, 18));
  await flush();
  ranges.push([0, 20]);
  tick(500); // the start: onto the newest key frame
  video.onplaying();
  const sb = ms().buffers[0];
  for (let i = 0; i < 8; i++) tick(500);
  assert.equal(sb.removed.length, 0, 'no remove() on the frequent checks');
  tick(500);
  tick(500);
  assert.equal(sb.removed.length, 1, 'one remove() every 10 checks (5 s)');
  assert.ok(sb.removed[0][1] <= video.currentTime - 3.9, 'a few seconds behind the playhead are kept');
});

test('agent scripts use no syntax newer than the TV engine (Chromium 69: no ?. ?? or object spread)', () => {
  const dir = new URL('../companion/agent/', import.meta.url);
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js') && !n.endsWith('.min.js'))) {
    const code = readFileSync(new URL(name, dir), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '') // comments
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""'); // strings
    assert.doesNotMatch(code, /\?\.(?!\d)/, `${name}: optional chaining`);
    assert.doesNotMatch(code, /\?\?/, `${name}: nullish coalescing`);
    assert.doesNotMatch(code, /\{\s*\.\.\./, `${name}: object spread`);
  }
});
