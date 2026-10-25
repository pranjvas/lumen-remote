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

function setup({ hlsSupported = true, suspend = true } = {}) {
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
    play() { this.calls.push(['play']); this.state = 'PLAYING'; },
    stop() { this.calls.push(['stop']); },
    close() { this.calls.push(['close']); },
    seek: null, // { ms, ok, fail }: the last seekTo, answered by the test
    seekTo(ms, ok, fail) { this.calls.push(['seekTo', ms]); this.seek = { ms, ok, fail }; },
    pause() { this.calls.push(['pause']); this.state = 'PAUSED'; },
    restore() { this.calls.push(['restore']); },
    state: 'PLAYING',
    time: 5000,
    getState() { return this.state; },
    getCurrentTime() { return this.time; },
    getDuration() { return 60000; },
  };
  if (suspend) avplay.suspend = function () { this.calls.push(['suspend']); };
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
    stopLoad() { this.calls.push(['stopLoad']); }
    destroy() { this.calls.push(['destroy']); }
  }
  FakeHls.Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' };
  FakeHls.ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' };
  FakeHls.ErrorDetails = {
    MANIFEST_INCOMPATIBLE_CODECS_ERROR: 'manifestIncompatibleCodecsError',
    BUFFER_INCOMPATIBLE_CODECS_ERROR: 'bufferIncompatibleCodecsError',
    FRAG_LOAD_ERROR: 'fragLoadError',
  };
  const listeners = {};
  const els = { screen: element(), frame: element(), cursor: element(), hint: element(), toast: element(), av: element(), mse };
  const ctx = {
    document: {
      getElementById: (id) => els[id],
      addEventListener(type, fn) { listeners[type] = fn; },
      documentElement: element(),
      body: element(),
      hidden: false,
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
  let closed = 0;
  screen.init((msg) => { sent.push(msg); return true; }, { onClosed: () => { closed += 1; } });
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
  // A remote key as the TV delivers it (keydown on the document).
  const key = (keyCode) => listeners.keydown({ keyCode, preventDefault() {}, stopPropagation() {} });
  const setHidden = (hidden) => { ctx.document.hidden = hidden; };
  return { sent, states, avplay, mse, hlsInstances, play, advance, screen, els, doc: ctx.document, key, setHidden, closed: () => closed };
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

test('AVPlay: while a video plays, the page above it is see-through down to html; back on the page, it is not', () => {
  // Seen 24 Oct with Eyes: html kept its dark background and hid every video, its clock running.
  const s = setup();
  s.play('http://pc/relay/tok/a.mp4');
  assert.ok(s.doc.documentElement.classList.contains('video'), 'html');
  assert.ok(s.doc.body.classList.contains('video'), 'body');
  s.key(10009); // Back: to the page
  assert.equal(s.states().at(-1), 'stopped');
  assert.equal(s.doc.documentElement.classList.contains('video'), false);
  assert.equal(s.doc.body.classList.contains('video'), false);
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

// ---- agent 0.8.7: start deadline, 'playing' from the clock, resume after a break, the PC link,
// the page in the background, what the hello and heartbeat say ----

const avErrors = (s) => s.sent.filter((m) => m.t === 'screen-video' && m.state === 'fallback').map((m) => m.error);

test('AVPlay: a prepare that never calls back counts as refused after 40 s, and <video> takes over', () => {
  const s = setup();
  s.play('http://pc/relay/tok/a.mp4');
  s.advance(39000);
  assert.deepEqual(avErrors(s), [], 'not yet');
  s.advance(2000);
  assert.match(avErrors(s)[0], /did not start within 40 s/);
  const loading = s.sent.find((m) => m.state === 'loading');
  assert.match(loading.error, /using <video>/);
  assert.equal(s.mse.src, 'http://pc/relay/tok/a.mp4');
});

test('AVPlay: a prepare that calls back in time and a moving clock are never refused; a replaced video\'s deadline does nothing', () => {
  const s = setup();
  s.play('http://pc/relay/tok/a.mp4');
  s.advance(5000);
  s.avplay.prepare.ok();
  s.advance(120000);
  assert.deepEqual(avErrors(s), []);
  assert.equal(s.hlsInstances.length, 0);

  const t = setup();
  t.play('http://pc/relay/tok/a.mp4');
  t.advance(30000);
  t.play('http://pc/relay/tok/b.mp4');
  t.avplay.prepare.ok();
  t.advance(30000);
  assert.deepEqual(avErrors(t), [], 'A\'s deadline was dropped with A');
});

test('AVPlay: the clock reports \'playing\' once when prepare never calls back; never again after a pause', () => {
  const s = setup();
  s.play('http://pc/relay/tok/x/index.m3u8');
  s.avplay.listener.oncurrentplaytime(0);
  assert.deepEqual(s.states(), [], 'a clock at 0 is not playing');
  s.avplay.listener.oncurrentplaytime(1200);
  s.avplay.listener.oncurrentplaytime(2400);
  assert.deepEqual(s.states(), ['playing']);

  const t = setup();
  t.play('http://pc/relay/tok/a.mp4');
  t.avplay.prepare.ok();
  t.key(13); // OK: pause
  assert.deepEqual(t.states(), ['playing', 'paused']);
  t.avplay.listener.oncurrentplaytime(6000);
  assert.deepEqual(t.states(), ['playing', 'paused'], 'AVPlay\'s clock after pause() is no \'playing\'');
});

test('AVPlay: an error after the video played opens it again where it was; the start deadline still applies; then hls.js starts there', () => {
  const s = setup();
  s.play('http://pc/relay/tok/film.m3u8');
  s.avplay.prepare.ok();
  s.avplay.listener.oncurrentplaytime(2400000);
  s.avplay.listener.onerror('PLAYER_ERROR_CONNECTION_FAILED');
  assert.equal(s.avplay.calls.filter((c) => c[0] === 'open').length, 2, 'opened again');
  assert.ok(!s.states().includes('stopped'), 'no stop in between (the PC would resume live video)');
  assert.match(s.sent.at(-1).error, /retrying at 2400000/);
  s.avplay.prepare.ok();
  s.advance(1300);
  assert.deepEqual(s.avplay.calls.at(-1), ['seekTo', 2400000]);
  // The deadline still applies to the next open.
  s.avplay.listener.onerror('PLAYER_ERROR_CONNECTION_FAILED');
  assert.equal(s.avplay.calls.filter((c) => c[0] === 'open').length, 3);
  s.advance(41000);
  assert.match(avErrors(s)[0], /did not start within 40 s/);
  assert.equal(s.hlsInstances.length, 1);
  assert.equal(s.hlsInstances[0].config.startPosition, 2400);
});

test('AVPlay: a third error within a minute moves on to hls.js at the position; an mp4 to <video> placed there once loaded', () => {
  const s = setup();
  s.play('http://pc/relay/tok/film.m3u8');
  s.avplay.prepare.ok();
  s.avplay.listener.oncurrentplaytime(2400000);
  for (let i = 0; i < 2; i++) { s.avplay.listener.onerror('PLAYER_ERROR'); s.avplay.prepare.ok(); }
  s.avplay.listener.onerror('PLAYER_ERROR');
  assert.equal(s.hlsInstances.length, 1);
  assert.equal(s.hlsInstances[0].config.startPosition, 2400);

  const m = setup();
  m.play('http://pc/relay/tok/film.mp4');
  m.avplay.prepare.ok();
  m.avplay.listener.oncurrentplaytime(2400000);
  for (let i = 0; i < 2; i++) { m.avplay.listener.onerror('PLAYER_ERROR'); m.avplay.prepare.ok(); }
  m.avplay.listener.onerror('PLAYER_ERROR');
  assert.equal(m.mse.src, 'http://pc/relay/tok/film.mp4');
  m.mse.onloadedmetadata();
  assert.equal(m.mse.currentTime, 2400);
  m.mse.onseeked();
  assert.equal(m.mse.paused, false);
});

test('hls.js: a network error after the video played loads on from where it was, twice a minute; the third is reported with the position', () => {
  const s = setup();
  s.play('http://pc/relay/tok/a.m3u8', { engine: 'hls' });
  const h = s.hlsInstances[0];
  s.mse.onplaying();
  s.mse.currentTime = 42;
  s.mse.ontimeupdate();
  const net = { fatal: true, type: 'networkError', details: 'fragLoadError' };
  h.emit('hlsError', net);
  h.emit('hlsError', net);
  assert.equal(h.calls.filter((c) => c[0] === 'startLoad').length, 2);
  assert.ok(!s.states().includes('error'));
  h.emit('hlsError', net);
  const err = s.sent.find((m) => m.state === 'error');
  assert.ok(err);
  assert.equal(err.played, true);
  assert.equal(err.position, 42000);
});

test('the PC link lost: a persistent hint, Back closes the screen here, and it closes by itself after a minute', () => {
  const s = setup();
  s.screen.linkDown();
  assert.match(s.els.hint.textContent, /not answering/);
  s.key(10009); // Back
  assert.equal(s.closed(), 1);
  assert.equal(s.els.screen.className, 'screen off');
  assert.equal(s.screen.isActive(), false);

  const t = setup();
  t.screen.linkDown();
  t.advance(59000);
  assert.equal(t.screen.isActive(), true);
  t.screen.linkUp();
  t.advance(5000);
  assert.equal(t.screen.isActive(), true, 'back in time: nothing closes');
  t.screen.linkDown();
  t.advance(61000);
  assert.equal(t.screen.isActive(), false);
  assert.equal(t.closed(), 1);
});

test('in the background, AVPlay is suspended and restored; without suspend it is closed and opened again where it was', () => {
  const s = setup();
  s.play('http://pc/relay/tok/a.mp4');
  s.avplay.prepare.ok();
  s.avplay.listener.oncurrentplaytime(90000);
  s.setHidden(true);
  s.screen.hidden();
  assert.ok(s.avplay.calls.some((c) => c[0] === 'suspend'));
  assert.deepEqual([s.sent.at(-1).state, s.sent.at(-1).reason], ['paused', 'hidden']);
  // The clock check does not take the stopped clock for a failure.
  s.avplay.time = 0;
  s.advance(20000);
  assert.deepEqual(avErrors(s), []);
  s.avplay.time = 90000;
  s.setHidden(false);
  s.screen.visible();
  assert.ok(s.avplay.calls.some((c) => c[0] === 'restore'));
  assert.equal(s.sent.at(-1).state, 'playing');

  const t = setup({ suspend: false });
  t.play('http://pc/relay/tok/a.mp4');
  t.avplay.prepare.ok();
  t.avplay.time = 90000;
  t.setHidden(true);
  t.screen.hidden();
  assert.deepEqual(t.avplay.calls.slice(-2), [['stop'], ['close']]);
  t.setHidden(false);
  t.screen.visible();
  assert.equal(t.avplay.calls.filter((c) => c[0] === 'open').length, 2);
  t.avplay.prepare.ok();
  t.advance(1300);
  assert.deepEqual(t.avplay.calls.at(-1), ['seekTo', 90000]);
});

test('in the background, hls.js stops loading and the video pauses; an error there starts no other player', () => {
  const s = setup();
  s.play('http://pc/relay/tok/a.m3u8', { engine: 'hls' });
  const h = s.hlsInstances[0];
  s.setHidden(true);
  s.screen.hidden();
  assert.ok(h.calls.some((c) => c[0] === 'stopLoad'));
  assert.equal(s.mse.paused, true);
  s.setHidden(false);
  s.screen.visible();
  assert.deepEqual(h.calls.at(-1), ['startLoad', -1]);
  assert.equal(s.mse.paused, false);

  const t = setup();
  t.play('http://pc/relay/tok/a.mp4');
  t.setHidden(true);
  t.screen.hidden();
  t.avplay.listener.onerror('PLAYER_ERROR');
  t.avplay.prepare.fail({ name: 'PLAYER_ERROR', message: '' });
  assert.equal(t.hlsInstances.length, 0);
  assert.equal(t.mse.src, '');
  const stop = t.sent.at(-1);
  assert.deepEqual([stop.state, stop.reason], ['stopped', 'hidden']);
});

test('screen-play: kept while in the background, ignored while the screen is off; kind:hls picks hls.js; Yellow on a video asks to convert', () => {
  const s = setup();
  s.setHidden(true);
  s.play('http://pc/relay/tok/a.mp4');
  assert.equal(s.avplay.calls.length, 0, 'not started in the background');
  s.setHidden(false);
  s.screen.visible();
  assert.equal(s.avplay.calls[0][0], 'open');

  const off = setup();
  off.screen.stop();
  off.play('http://pc/relay/tok/a.mp4');
  assert.equal(off.avplay.calls.length, 0);

  const k = setup();
  k.play('http://pc/relay/tok/playlist', { kind: 'hls' });
  k.avplay.prepare.fail({ name: 'PLAYER_ERROR', message: '' });
  assert.equal(k.hlsInstances.length, 1);
  k.key(405); // Yellow
  assert.deepEqual(JSON.parse(JSON.stringify(k.sent.at(-1))), { t: 'screen-input', key: 'convert' }); // from the vm's realm
});

test('the hello and the heartbeat say what the screen shows; reports carry the stream\'s id; the agent shows no failure toast of its own', () => {
  const s = setup();
  assert.deepEqual(JSON.parse(JSON.stringify(s.screen.state())), { active: true, hidden: false, video: null });
  s.play('http://pc/relay/tok/a.mp4', { id: 7 });
  s.avplay.prepare.ok();
  const st = s.screen.state();
  assert.deepEqual([st.active, st.video.state, st.video.mode, st.video.position, st.video.id], [true, 'playing', 'avplay', 5000, 7]);
  s.screen.heartbeat();
  const beat = s.sent.at(-1);
  assert.deepEqual([beat.t, beat.state, beat.position, beat.heartbeat, beat.id], ['screen-video', 'playing', 5000, true, 7]);
  assert.equal(s.sent.find((m) => m.state === 'playing').id, 7);
  // Failed in every player: reported, no toast here (the PC may still convert it).
  const t = setup({ hlsSupported: false });
  t.screen.message({ t: 'screen-toast', text: 'first' });
  t.play('http://pc/relay/tok/a.m3u8', { engine: 'hls', drm: { 'com.widevine.alpha': { licenseUrl: 'x' } } });
  assert.ok(t.states().includes('error'));
  assert.equal(t.els.toast.textContent, 'first');
});

// ---- seeking: the remote's ◀ ▶ and the phone's controls ----

const seeks = (s) => s.avplay.calls.filter((c) => c[0] === 'seekTo').map((c) => c[1]);
const lastReport = (s) => s.sent.filter((m) => m.t === 'screen-video').at(-1);

test('◀ ▶ seek AVPlay with seekTo and its callbacks; the TV shows where it went; the PC hears the new position', () => {
  const s = setup();
  s.play('http://pc/relay/tok/film.mp4', { id: 7 });
  s.avplay.prepare.ok();
  s.avplay.time = 5000;
  s.key(39); // ▶
  assert.deepEqual(seeks(s), [15000]);
  // This TV refuses a seek while AVPlay plays (PLAYER_ERROR_INVALID_STATE): pause, seek, then play
  // again once the seek is done (CineHD's order, which seeks MP4 here).
  assert.deepEqual(s.avplay.calls.slice(-2), [['pause'], ['seekTo', 15000]]);
  assert.equal(typeof s.avplay.seek.ok, 'function', 'a success callback');
  assert.equal(typeof s.avplay.seek.fail, 'function', 'an error callback: AVPlay\'s refusals were lost without one');
  assert.match(s.els.hint.textContent, /0:15 \/ 1:00/);
  s.avplay.time = 15000;
  s.avplay.seek.ok();
  assert.deepEqual(s.avplay.calls.at(-1), ['play'], 'playing again after the seek');
  const r = lastReport(s);
  assert.equal(r.position, 15000);
  assert.equal(r.duration, 60000);
  assert.equal(r.id, 7);
  assert.equal(r.heartbeat, true, 'reported like a heartbeat (no log line per press)');
  s.key(37); // ◀
  assert.deepEqual(seeks(s), [15000, 5000]);
  s.avplay.seek.ok();
  s.avplay.time = 2000;
  s.key(412); // rewind: never before the start
  assert.deepEqual(seeks(s).at(-1), 0);
});

test('a seek on a paused video leaves it paused', () => {
  const s = setup();
  s.play('http://pc/relay/tok/film.mp4');
  s.avplay.prepare.ok();
  s.avplay.time = 5000;
  s.key(13); // OK: pause
  const before = s.avplay.calls.length;
  s.key(39);
  s.avplay.seek.ok();
  assert.deepEqual(s.avplay.calls.slice(before), [['seekTo', 15000]], 'no pause, no play');
  assert.equal(s.avplay.state, 'PAUSED');
});

test('presses while a seek runs add up to one more seek; never past the end', () => {
  const s = setup();
  s.play('http://pc/relay/tok/film.mp4');
  s.avplay.prepare.ok();
  s.avplay.time = 5000;
  const plays = () => s.avplay.calls.filter((c) => c[0] === 'play').length;
  s.key(39);
  s.key(39);
  s.key(417); // ff
  const playsBefore = plays();
  assert.deepEqual(seeks(s), [15000], 'one seek at a time');
  assert.match(s.els.hint.textContent, /0:35/);
  s.avplay.seek.ok();
  assert.deepEqual(seeks(s), [15000, 35000]);
  assert.equal(plays(), playsBefore, 'no play between the two seeks');
  s.avplay.seek.ok();
  assert.deepEqual(s.avplay.calls.at(-1), ['play']);
  s.avplay.time = 35000;
  for (let i = 0; i < 5; i++) s.key(39);
  s.avplay.seek.ok();
  assert.equal(seeks(s).at(-1), 59000, 'a second before the end');
});

test('AVPlay refusing a seek: the PC is told, and the video goes on in the page\'s own player from there', () => {
  const s = setup();
  s.play('http://pc/relay/tok/film.mp4');
  s.avplay.prepare.ok();
  s.avplay.listener.oncurrentplaytime(5000);
  s.avplay.time = 5000;
  s.key(39);
  s.avplay.seek.fail({ name: 'InvalidStateError', message: 'PLAYER_ERROR_INVALID_STATE' });
  const note = s.sent.find((m) => m.t === 'screen-video' && /seek refused/.test(m.error || ''));
  assert.ok(note, 'the refusal reaches the PC');
  assert.match(note.error, /PLAYER_ERROR_INVALID_STATE/);
  assert.ok(s.avplay.calls.some((c) => c[0] === 'close'), 'AVPlay let go');
  // The TV ignores a #t= start: the <video> is placed at the target once its metadata is in, then plays.
  assert.match(s.mse.src, /film\.mp4$/);
  assert.equal(s.mse.paused, true, 'not playing from 0 meanwhile');
  s.mse.onloadedmetadata();
  assert.equal(s.mse.currentTime, 15, 'the in-page <video> starts at the seek target');
  s.mse.onseeked();
  assert.equal(s.mse.paused, false, 'and plays from there');
  // There, ◀ ▶ seek the <video> itself: paused for the seek, playing again once it is done.
  s.key(39);
  assert.equal(s.mse.currentTime, 25);
  assert.equal(s.mse.paused, true);
  s.mse.onseeked();
  assert.equal(s.mse.paused, false);
  assert.equal(lastReport(s).position, 25000);

  // An HLS stream goes to hls.js at the target.
  const h = setup();
  h.play('http://pc/relay/tok/a.m3u8', { engine: 'avplay', kind: 'hls' });
  h.avplay.prepare.ok();
  h.avplay.listener.oncurrentplaytime(5000);
  h.avplay.time = 5000;
  h.key(37);
  h.avplay.seek.fail({ name: 'InvalidStateError', message: 'x' });
  assert.equal(h.hlsInstances.at(-1).config.startPosition, undefined, 'from the start (0 s)');
  // A seek with no answer at all is let go after a while (later presses are not stuck behind it).
  const n = setup();
  n.play('http://pc/relay/tok/film.mp4');
  n.avplay.prepare.ok();
  n.avplay.time = 5000;
  n.key(39);
  n.advance(16000);
  n.avplay.time = 15000;
  n.key(39);
  assert.deepEqual(seeks(n), [15000, 25000]);
});

test('the phone\'s controls: play/pause, skip and seek reach the player; a control for another stream is dropped', () => {
  const s = setup();
  s.play('http://pc/relay/tok/film.mp4', { id: 3 });
  s.avplay.prepare.ok();
  s.avplay.time = 20000;
  s.screen.message({ t: 'screen-video-control', action: 'seek', position: 30000, id: 3 });
  assert.deepEqual(seeks(s), [30000]);
  s.avplay.seek.ok();
  s.avplay.time = 30000;
  s.screen.message({ t: 'screen-video-control', action: 'skip', by: -10000, id: 3 });
  assert.deepEqual(seeks(s), [30000, 20000]);
  s.avplay.seek.ok();
  s.screen.message({ t: 'screen-video-control', action: 'toggle', id: 3 });
  assert.equal(s.avplay.state, 'PAUSED');
  assert.equal(lastReport(s).state, 'paused');
  s.screen.message({ t: 'screen-video-control', action: 'play', id: 3 });
  assert.equal(s.avplay.calls.at(-1)[0], 'play');
  s.screen.message({ t: 'screen-video-control', action: 'seek', position: 1000, id: 2 });
  assert.deepEqual(seeks(s), [30000, 20000], 'another stream\'s control changes nothing');

  // The in-page player takes them too.
  const m = setup();
  m.play('http://pc/relay/tok/a.m3u8', { engine: 'hls', id: 4 });
  m.mse.currentTime = 50;
  m.screen.message({ t: 'screen-video-control', action: 'seek', position: 12000, id: 4 });
  assert.equal(m.mse.currentTime, 12);
  m.mse.paused = false;
  m.screen.message({ t: 'screen-video-control', action: 'toggle', id: 4 });
  assert.equal(m.mse.paused, true);
});
