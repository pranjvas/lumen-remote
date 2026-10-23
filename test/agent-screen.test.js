// The TV agent's "Lumen browser on TV" screen (companion/agent/screen.js), run in a vm with a fake
// DOM, a fake AVPlay and a fake hls.js: the player fallbacks and their failure reporting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../companion/agent/screen.js', import.meta.url), 'utf8');

function element() {
  const classes = new Set();
  return {
    style: {}, className: '', textContent: '', src: '', attrs: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    removeAttribute(name) { delete this.attrs[name]; if (name === 'src') this.src = ''; },
  };
}

function setup({ hlsSupported = true } = {}) {
  const sent = [];
  const timers = new Map();
  let nextTimer = 1;
  let now = 0;
  const avplay = {
    calls: [],
    listener: null,
    prepare: null,
    open(url) { this.calls.push(['open', url]); },
    setDisplayRect() {},
    setListener(l) { this.listener = l; },
    prepareAsync(ok, fail) { this.calls.push(['prepareAsync']); this.prepare = { ok, fail }; },
    play() { this.calls.push(['play']); },
    stop() { this.calls.push(['stop']); },
    close() { this.calls.push(['close']); },
    seekTo(ms) { this.calls.push(['seekTo', ms]); },
    getState() { return 'PLAYING'; },
    getCurrentTime() { return 5000; },
    getDuration() { return 60000; },
  };
  const mse = Object.assign(element(), {
    currentTime: 0, duration: 0, paused: true, error: null,
    onplaying: null, onpause: null, onended: null, onerror: null,
    canPlayType() { return 'maybe'; },
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    load() {},
  });
  const hlsInstances = [];
  class FakeHls {
    static isSupported() { return hlsSupported; }
    constructor(config) { this.config = config; this.handlers = {}; this.calls = []; hlsInstances.push(this); }
    on(evt, fn) { this.handlers[evt] = fn; }
    emit(evt, data) { this.handlers[evt](evt, data); }
    loadSource(url) { this.calls.push(['loadSource', url]); }
    attachMedia() { this.calls.push(['attachMedia']); }
    recoverMediaError() { this.calls.push(['recoverMediaError']); }
    swapAudioCodec() { this.calls.push(['swapAudioCodec']); }
    startLoad(p) { this.calls.push(['startLoad', p]); }
    destroy() { this.calls.push(['destroy']); }
  }
  FakeHls.Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' };
  FakeHls.ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' };
  FakeHls.ErrorDetails = {
    MANIFEST_INCOMPATIBLE_CODECS_ERROR: 'manifestIncompatibleCodecsError',
    BUFFER_INCOMPATIBLE_CODECS_ERROR: 'bufferIncompatibleCodecsError',
  };
  const els = { screen: element(), frame: element(), cursor: element(), hint: element(), toast: element(), av: element(), mse };
  const ctx = {
    document: {
      getElementById: (id) => els[id],
      addEventListener() {},
      body: element(),
    },
    webapis: { avplay },
    tizen: { tvinputdevice: { registerKey() {}, unregisterKey() {} } },
    Hls: FakeHls,
    innerWidth: 1920, innerHeight: 1080,
    setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    Date: { now: () => now },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Blob: function Blob() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx, { filename: 'screen.js' });
  const screen = ctx.LumenScreen;
  screen.init((msg) => { sent.push(msg); return true; });
  screen.start();
  function advance(ms) {
    const until = now + ms;
    for (;;) {
      let due = null;
      for (const [id, t] of timers) if (t.at <= until && (!due || t.at < due[1].at)) due = [id, t];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  }
  const play = (url, extra = {}) => screen.message({ t: 'screen-play', url, title: 'T', ...extra });
  const states = () => sent.filter((m) => m.t === 'screen-video').map((m) => m.state);
  return { sent, states, avplay, mse, hlsInstances, play, advance, screen };
}

const fatalMedia = (details) => ({ fatal: true, type: 'mediaError', details });

test('hls.js: a fatal media error is recovered a limited number of times, then reported', () => {
  const s = setup();
  s.play('http://pc/relay/tok/a.m3u8', { engine: 'hls' });
  const h = s.hlsInstances[0];
  assert.ok(h, 'hls.js took over');
  h.emit('hlsError', fatalMedia('bufferAppendError'));
  h.emit('hlsError', fatalMedia('bufferAppendError'));
  assert.equal(s.states().includes('error'), false, 'two recoveries are allowed');
  const recov = h.calls.filter((c) => c[0] === 'recoverMediaError').length;
  assert.equal(recov, 2);
  assert.ok(h.calls.some((c) => c[0] === 'swapAudioCodec'), 'second attempt swaps the audio codec');
  // Never started (position 0): recoverMediaError skips startLoad, so the agent restarts loading.
  assert.equal(h.calls.filter((c) => c[0] === 'startLoad').length, 2);
  h.emit('hlsError', fatalMedia('bufferAppendError'));
  const err = s.sent.find((m) => m.state === 'error');
  assert.ok(err, 'third fatal media error is reported to Lumen');
  assert.match(err.error, /bufferAppendError/);
  assert.equal(s.states().at(-1), 'stopped');
});

test('hls.js: a stream that already played does not get an extra startLoad', () => {
  const s = setup();
  s.play('http://pc/relay/tok/a.m3u8', { engine: 'hls' });
  const h = s.hlsInstances[0];
  s.mse.currentTime = 42;
  h.emit('hlsError', fatalMedia('bufferStalledError'));
  assert.deepEqual(h.calls.filter((c) => c[0] === 'recoverMediaError' || c[0] === 'startLoad'), [['recoverMediaError']]);
});

test('hls.js: media recoveries spaced far apart do not add up', () => {
  const s = setup();
  s.play('http://pc/relay/tok/a.m3u8', { engine: 'hls' });
  const h = s.hlsInstances[0];
  s.mse.onplaying();
  for (let i = 0; i < 4; i++) { h.emit('hlsError', fatalMedia('bufferAppendError')); s.advance(60000); }
  assert.equal(s.states().includes('error'), false);
  assert.equal(h.calls.filter((c) => c[0] === 'recoverMediaError').length, 4);
});

test('hls.js: incompatible codecs fail at once without re-attaching', () => {
  for (const details of ['bufferIncompatibleCodecsError', 'manifestIncompatibleCodecsError']) {
    const s = setup();
    s.play('http://pc/relay/tok/a.m3u8', { engine: 'hls' });
    const h = s.hlsInstances[0];
    h.emit('hlsError', fatalMedia(details));
    assert.equal(h.calls.some((c) => c[0] === 'recoverMediaError'), false, details);
    assert.match(s.sent.find((m) => m.state === 'error').error, new RegExp(details));
  }
});

test('AVPlay: a late prepare error from a replaced video does not touch the current one', () => {
  const s = setup();
  s.play('http://pc/relay/tok/a.mp4');
  const prepA = s.avplay.prepare;
  s.play('http://pc/relay/tok/b.mp4');
  const prepB = s.avplay.prepare;
  prepB.ok();
  const before = s.sent.length;
  const calls = s.avplay.calls.length;
  prepA.fail({ name: 'PLAYER_ERROR_INVALID_STATE', message: 'closed' });
  prepA.ok();
  assert.equal(s.sent.length, before, 'nothing reported for A');
  assert.equal(s.avplay.calls.length, calls, 'B\'s player left alone');
  assert.equal(s.hlsInstances.length, 0, 'B not moved to hls.js');
});

test('AVPlay: a late prepare error does not tear down a replacement playing in hls.js', () => {
  const s = setup();
  s.play('http://pc/relay/tok/a.mp4');
  const prepA = s.avplay.prepare;
  s.play('http://pc/relay/tok/b.m3u8', { engine: 'hls' });
  const h = s.hlsInstances[0];
  s.mse.onplaying();
  prepA.fail({ name: 'PLAYER_ERROR', message: '' });
  assert.equal(s.states().includes('error'), false);
  assert.equal(h.calls.some((c) => c[0] === 'destroy'), false);
});

test('AVPlay: listener and timer callbacks of a replaced video are ignored', () => {
  const s = setup();
  s.play('http://pc/relay/tok/a.mp4', { fromStart: true });
  const listenerA = s.avplay.listener;
  s.avplay.prepare.ok();
  s.play('http://pc/relay/tok/b.m3u8', { engine: 'hls' });
  s.mse.onplaying();
  const before = s.sent.length;
  listenerA.onerror('PLAYER_ERROR_CONNECTION_FAILED');
  listenerA.onstreamcompleted();
  listenerA.onbufferingcomplete();
  s.advance(1500);
  assert.equal(s.sent.length, before);
  assert.equal(s.avplay.calls.some((c) => c[0] === 'seekTo'), false, 'A\'s fromStart seek does not hit B');
  assert.equal(s.hlsInstances[0].calls.some((c) => c[0] === 'destroy'), false);
});

test('AVPlay: the current video\'s own errors still fall back', () => {
  const s = setup();
  s.play('http://pc/relay/tok/a.m3u8');
  s.avplay.prepare.fail({ name: 'PLAYER_ERROR_NOT_SUPPORTED_FORMAT', message: '' });
  assert.ok(s.states().includes('fallback'));
  assert.equal(s.hlsInstances.length, 1);
});

test('in-page players: a stream that never reaches playing is reported after the start deadline', () => {
  const s = setup();
  s.play('http://pc/relay/tok/a.m3u8', { engine: 'hls' });
  s.advance(29000);
  assert.equal(s.states().includes('error'), false);
  s.advance(2000);
  const err = s.sent.find((m) => m.state === 'error');
  assert.ok(err);
  assert.match(err.error, /hls: did not start/);
  assert.equal(s.hlsInstances[0].calls.some((c) => c[0] === 'destroy'), true);
});

test('in-page players: DRM gets a longer start deadline; <video> has one too', () => {
  const s = setup();
  s.play('http://pc/relay/tok/a.m3u8', { engine: 'hls', drm: { 'com.widevine.alpha': { licenseUrl: 'http://pc/lic' } } });
  s.advance(40000);
  assert.equal(s.states().includes('error'), false);
  s.advance(6000);
  assert.ok(s.states().includes('error'));

  const v = setup();
  v.play('http://pc/relay/tok/a.mp4');
  v.avplay.prepare.fail({ name: 'PLAYER_ERROR', message: '' });
  assert.equal(v.hlsInstances.length, 0, 'mp4 goes to <video>');
  v.advance(31000);
  assert.match(v.sent.find((m) => m.state === 'error').error, /video: did not start/);
});

test('in-page players: once playing, the start deadline does nothing, and stopping clears it', () => {
  const s = setup();
  s.play('http://pc/relay/tok/a.m3u8', { engine: 'hls' });
  s.mse.onplaying();
  s.advance(120000);
  assert.equal(s.states().includes('error'), false);

  const t = setup();
  t.play('http://pc/relay/tok/a.m3u8', { engine: 'hls' });
  t.screen.message({ t: 'screen-play', url: 'http://pc/relay/tok/b.mp4', title: 'B' });
  t.advance(31000);
  assert.equal(t.states().includes('error'), false, 'old deadline cleared when the video changed');
});

test('fallback: Lumen\'s engine:hls picks hls.js even when the URL does not say m3u8', () => {
  const s = setup();
  s.play('http://pc/relay/tok/manifestformatm3u8-aapl', { engine: 'hls' });
  assert.equal(s.hlsInstances.length, 1);
  assert.deepEqual(s.hlsInstances[0].calls[0], ['loadSource', 'http://pc/relay/tok/manifestformatm3u8-aapl']);
  assert.equal(s.mse.src, '');
});

test('fallback: DRM never drops to a plain <video>', () => {
  const s = setup({ hlsSupported: false });
  s.play('http://pc/relay/tok/playlist', { engine: 'hls', drm: { 'com.microsoft.playready': { licenseUrl: 'http://pc/lic' } } });
  assert.equal(s.mse.src, '');
  assert.ok(s.states().includes('error'));
});

test('fallback: a non-HLS URL without engine:hls still goes to <video>', () => {
  const s = setup();
  s.play('http://pc/relay/tok/movie.mp4');
  s.avplay.prepare.fail({ name: 'PLAYER_ERROR', message: '' });
  assert.equal(s.hlsInstances.length, 0);
  assert.equal(s.mse.src, 'http://pc/relay/tok/movie.mp4');
});
