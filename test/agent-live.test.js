// The TV agent's live video player (companion/agent/live.js), run in a vm with a fake MediaSource and
// <video>: the offer answer with the TV's codec support, init → SourceBuffer, fragments of the
// current stream only, refusal of a format the TV does not take, the quota and backlog resync, the
// live-edge jump and the stop. Also: the agent's scripts stay within the TV's ES2017 engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { initMessage, mediaMessage } from '../server/features/livevideo.js';

const SOURCE = readFileSync(new URL('../companion/agent/live.js', import.meta.url), 'utf8');
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

function setup({ supported = (t) => /avc1/.test(t) } = {}) {
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
  const video = {
    style: {}, muted: true, paused: true, currentTime: 0, playbackRate: 1, videoWidth: 1920, videoHeight: 1080, error: null,
    buffered: { get length() { return ranges.length; }, start: (i) => ranges[i][0], end: (i) => ranges[i][1] },
    play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
    removeAttribute() {}, load() {},
    getVideoPlaybackQuality() { return { droppedVideoFrames: 2, totalVideoFrames: 100 }; },
  };
  const classes = new Set();
  const root = { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
  const context = {
    window: {}, console, Uint8Array, DataView, ArrayBuffer, JSON, Math, Date, Object, Array, String, Promise, TextDecoder,
    MediaSource: FakeMediaSource,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval() {},
    setTimeout, clearTimeout,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  const live = context.LumenLive;
  live.init((m) => { sent.push(JSON.parse(JSON.stringify(m))); return true; }, video, root);
  const tick = (ms) => timers.filter((t) => t.ms === ms).forEach((t) => t.fn());
  return { live, sent, appended, video, ranges, classes, tick, ms: () => FakeMediaSource.last, setQuota: (v) => { quota = v; } };
}

const init = (gen, info) => ab(initMessage(gen, { mime: 'video/mp4; codecs="avc1.64002A,mp4a.40.2"', reset: true, ...info }, Buffer.from('INIT')));
const media = (gen, key, text) => ab(mediaMessage(gen, key, [Buffer.from(text)]));
const flush = () => new Promise((r) => setImmediate(r));

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

test('playback starts near the live edge, jumps back when far behind, reports stats, and stops', async () => {
  const { live, sent, ms, ranges, video, tick, classes } = setup();
  live.data(init(1));
  ms().open();
  await flush();
  ranges.push([5, 6]);
  tick(250);
  assert.ok(video.currentTime > 5.8 && video.currentTime < 6, `starts just behind the newest frame (${video.currentTime})`);
  assert.equal(video.paused, false);
  video.onplaying();
  assert.ok(classes.has('live'));
  assert.equal(sent.find((m) => m.state === 'playing').w, 1920);
  ranges[0][1] = 9; // far behind (3 s)
  tick(250);
  assert.ok(video.currentTime > 8.8, 'jumped to the live edge');
  ranges[0][1] = 9.5; // 0.6 s behind: a little faster
  tick(250);
  assert.ok(video.playbackRate > 1);
  tick(1000);
  const stats = sent.filter((m) => m.state === 'stats').at(-1);
  assert.deepEqual([stats.dropped, stats.decoded], [2, 100]);
  live.message({ t: 'screen-live-stop' });
  assert.equal(classes.has('live'), false);
  assert.equal(live.isShowing(), false);
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
