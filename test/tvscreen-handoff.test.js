// Handing the page's video to the TV's own player: the engine the HLS probe picks, the DRM path
// (licence relays, the Widevine certificate, cookies kept to their own site), the automatic hand-off
// (only after a success is the page paused; a close stops it; one hand-off at a time; only a video
// someone starts; ads wait), dead links and their stand-ins, masters over variants and renditions,
// the copy stage for streams the TV shows wrongly, the frames held back while the player is in
// front, and the trackpad bringing Lumen's page back only over the YouTube app it opened. Then the
// conversion ladder beside the keys, the conversion jobs' lifetime and the player-state watchdogs.
// Mock TV, fake agent, a local media server, and a scripted stand-in for the browser page (no Edge).
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import nodePath from 'node:path';
import { PassThrough } from 'node:stream';
import { createTranscoder } from '../server/features/transcode.js';
import { createTestLog, startStack, waitFor } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AGENT_APP = 'lumenrmt01.LumenAgent';
const YOUTUBE_APP = { id: '111299001912', name: 'YouTube' };
const CERT = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

const media = (lines) => ['#EXTM3U', ...lines, '#EXT-X-ENDLIST', ''].join('\n');
const playlist = (res, text) => { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end(text); };

/** The local media server: playlists of every kind the hand-off meets. → { server, port, seen } */
async function mediaServer() {
  const seen = []; // requests the media server got: { url, method, cookie }
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const path = new URL(req.url, 'http://x').pathname;
      seen.push({ url: req.url, method: req.method, cookie: req.headers.cookie ?? null });
      const up = (p) => `http://${req.headers.host}${p}`;
      if (path === '/ts.m3u8' || path === '/alt.m3u8' || path === '/m/low.m3u8' || path === '/m/aac.m3u8') return playlist(res, media(['#EXTINF:4,', 'seg.ts']));
      if (path === '/fmp4.m3u8' || path === '/m/video.m3u8' || path === '/m/audio.m3u8') return playlist(res, media(['#EXT-X-MAP:URI="init.mp4"', '#EXTINF:4,', 'seg.m4s']));
      if (path === '/slow.m3u8') { setTimeout(() => playlist(res, media(['#EXTINF:4,', 'seg.ts'])), 2000); return undefined; }
      if (path === '/ts-master.m3u8') return playlist(res, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"\nts.m3u8\n');
      if (path === '/m/master.m3u8') return playlist(res, '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="a"\nvideo.m3u8\n');
      if (path === '/drm/master.m3u8') return playlist(res, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n');
      if (path === '/drm/media.m3u8') return playlist(res, media(['#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AA=="', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:6,', 'seg.m4s']));
      if (path === '/lic/la') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ licenseAcquisitionUrl: up('/lic/server'), token: 't1' })); return undefined; }
      if (path === '/lic/server') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(`licence for ${body}`); return undefined; }
      res.writeHead(path === '/forbidden.m3u8' || path === '/m/gone.m3u8' ? 403 : 404);
      res.end();
      return undefined;
    });
  });
  // Every address: the licence host is reached as "localhost", another site than 127.0.0.1.
  await new Promise((r) => server.listen(0, r));
  return { server, port: server.address().port, seen };
}

function fakePage() {
  return {
    playing: false, key: 'v', pauses: 0, resumes: 0, framePauses: 0, frameResumes: 0, lastInput: 0, ticks: 0,
    videos: [], // [{ src, area, playing, duration?, loop?, ad? }]
    frames: [],
    media: [], // the browser feature's media list: [{ url, kind, headers, role?, audioOnly?, variants?, renditions? }]
    drm: null, // what DRM_SCRIPT finds in window.playerConfig
  };
}

/**
 * The stack every suite here runs on: the real server with a scripted browser page, a scripted
 * converter and the real relay (its probe can be told more: probeExtra). → helpers
 */
async function handOffStack(config) {
  const web = await mediaServer();
  const stack = await startStack({ config });
  const b = stack.browser();
  await b.hello;
  const agent = stack.agent();
  await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
  const env = {
    stack, b, agent, web, page: fakePage(), sink: null, probeExtra: null,
    converts: [], stopped: [], holds: [],
    tc: { available: true, delay: 0, error: null, opts: [] },
  };
  const real = stack.server.features.browser;
  const fake = Object.create(real);
  Object.assign(fake, {
    async ensureRunning() {},
    // Lumen reopening a page itself (restore) is not someone using it.
    async open(url, options = {}) { env.setPage(url); if (options.userInput !== false) env.page.lastInput = Date.now(); return { value: { url } }; },
    async nav() { return {}; },
    async input() { return {}; },
    addSink(fn) { env.sink = fn; return () => { if (env.sink === fn) env.sink = null; }; },
    media: () => env.page.media,
    frameSize: () => ({ w: 1280, h: 720 }),
    // Called once per automatic hand-off tick, before anything else is checked: tests count ticks by it.
    lastInputAt: () => { env.page.ticks += 1; return env.page.lastInput; },
    async evaluate(expression) {
      const src = String(expression);
      const page = env.page;
      if (src.includes('v.pause()')) { page.pauses += 1; page.playing = false; return undefined; }
      if (src.includes('.play()')) { page.resumes += 1; page.playing = true; return 1; } // the hand-off's own videos play again
      if (src.includes('playerConfig')) return page.drm;
      if (src.includes('.html5-video-player')) return { found: false, t: null, ad: false, live: false };
      if (src.includes('iframe')) return { videos: page.videos, frames: page.frames };
      // The keys of the big videos playing (a video counts as started when its key is new).
      if (src.includes('innerWidth * innerHeight')) return page.playing ? [page.key ?? 'v'] : [];
      throw new Error(`unexpected page script: ${src.slice(0, 60)}`);
    },
    // The page's frames: the pause and resume scripts reach them too.
    async evaluateFrames(expression) {
      const src = String(expression);
      if (src.includes('v.pause()')) { env.page.framePauses += 1; return []; }
      if (src.includes('.play()')) { env.page.frameResumes += 1; return [0]; }
      return [];
    },
  });
  stack.server.features.browser = fake;
  const realTranscode = stack.server.features.transcode;
  const jobsByUrl = new Map();
  stack.server.features.transcode = {
    available: () => env.tc.available,
    existing: (url) => (jobsByUrl.has(url) && !env.stopped.includes(jobsByUrl.get(url).id) ? jobsByUrl.get(url) : null),
    async convert(url, options = {}) {
      env.converts.push(url);
      env.tc.opts.push(options);
      if (env.tc.delay) await sleep(env.tc.delay);
      if (env.tc.error) throw new Error(env.tc.error);
      const known = jobsByUrl.get(url);
      if (known && known.copy === !!options.copy && !env.stopped.includes(known.id)) return { id: known.id, reused: true };
      const id = `job${env.converts.length}`;
      jobsByUrl.set(url, { id, copy: !!options.copy });
      return { id };
    },
    stopJob: (id) => { env.stopped.push(id); },
    hold: (id, on) => { env.holds.push([id, on]); },
    file: () => null,
  };
  const realRelay = stack.server.features.relay;
  const relay = Object.create(realRelay);
  relay.probeHls = async (token) => {
    const result = await realRelay.probeHls(token);
    return env.probeExtra ? { ...result, ...env.probeExtra } : result;
  };
  stack.server.features.relay = relay;

  Object.assign(env, {
    setPage(url, title = 'Page') {
      stack.server.store.set('browser.url', url, { src: 'derived', via: 'browser' });
      stack.server.store.set('browser.title', title, { src: 'derived', via: 'browser' });
    },
    up: (path, host = '127.0.0.1') => `http://${host}:${web.port}${path}`,
    bigVideo: (src) => ({ src, area: 1280 * 600, playing: true }),
    playMsgs: () => agent.screen.filter((m) => m.t === 'screen-play'),
    toasts: (re) => agent.screen.filter((m) => m.t === 'screen-toast' && re.test(m.text)),
    agentLaunches: () => stack.mock.state.launches.filter((l) => l.appId === AGENT_APP).length,
    tvVideo: () => stack.server.store.get('tvscreen.video')?.v ?? null,
    fromAgent: (msg) => agent.ws.send(JSON.stringify(msg)),
    ok: (ack) => { assert.equal(ack.ok, true, JSON.stringify(ack.error)); return ack.value; },
    // The screen-play after the n-th: the agent's socket and the phone's are two sockets, so an ack
    // can arrive before the message the agent got.
    played: (n) => waitFor(() => env.playMsgs().length > n && env.playMsgs().at(-1), { timeout: 5000, message: 'a screen-play' }),
    ticks: async (k) => { const s = env.page.ticks; await waitFor(() => env.page.ticks >= s + k, { timeout: 15000, message: `${k} hand-off ticks` }); },
    async reopen() {
      env.ok(await b.send('tvscreen.close', {}, { timeout: 10000 }));
      env.ok(await b.send('tvscreen.open', {}, { timeout: 15000 }));
    },
    async stopPlayer() {
      env.fromAgent({ t: 'screen-video', state: 'stopped' });
      await waitFor(() => env.tvVideo() === 'stopped', { timeout: 3000, message: 'the player stopped' });
    },
    async stop() {
      stack.server.features.browser = real;
      stack.server.features.transcode = realTranscode;
      stack.server.features.relay = realRelay;
      await stack.stop();
      web.server.close();
    },
  });
  env.setPage(env.up('/start'));
  env.ok(await b.send('tvscreen.open', {}, { timeout: 15000 }));
  return env;
}

describe('tvscreen: handing the page\'s video to the TV', () => {
  let env, stack, b, agent, page, up, setPage, bigVideo, playMsgs, toasts, tvVideo, fromAgent, ok;
  const seen = () => env.web.seen;

  before(async () => {
    env = await handOffStack();
    ({ stack, b, agent, up, setPage, bigVideo, playMsgs, toasts, tvVideo, fromAgent, ok } = env);
  });
  after(async () => { await env?.stop(); });
  beforeEach(() => { page = env.page = fakePage(); });

  test('the engine follows the probe: TS → AVPlay, fMP4 → hls.js; the page is paused; a refused one-time link stays on the page', async () => {
    for (const [path, engine] of [['/ts.m3u8', 'avplay'], ['/fmp4.m3u8', 'hls']]) {
      page = env.page = fakePage();
      setPage(up(`/watch${path}`), 'A video');
      page.videos = [bigVideo(up(path))];
      page.playing = true;
      const n = playMsgs().length;
      const value = ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
      assert.equal(value.engine, engine, path);
      await env.played(n);
      assert.equal(playMsgs().length, n + 1, path);
      assert.equal(playMsgs().at(-1).engine, engine, path);
      assert.equal(playMsgs().at(-1).kind, 'hls', 'the probe read an HLS playlist');
      assert.match(playMsgs().at(-1).url, /\/relay\//);
      assert.equal(page.pauses, 1, `${path}: the page's own video is paused`);
      assert.equal(page.framePauses, 1, `${path}: its frames too`);
      assert.equal(tvVideo(), 'loading');
      await env.stopPlayer();
    }
    // A link the site refuses (403): nothing goes to the TV, the page keeps playing it.
    page = env.page = fakePage();
    setPage(up('/watch/forbidden'), 'Gone');
    page.videos = [bigVideo(up('/forbidden.m3u8'))];
    page.playing = true;
    const n = playMsgs().length;
    const ack = await b.send('tvscreen.playVideo', {}, { timeout: 15000 });
    assert.equal(ack.ok, false);
    assert.match(ack.error.message, /refused this video’s link/);
    assert.equal(playMsgs().length, n, 'no screen-play');
    assert.equal(page.pauses, 0, 'the page is not paused');
  });

  test('a refused link is replaced by another stream of the same site, never by another site\'s', async () => {
    setPage(up('/watch/alt'), 'Alt');
    page.videos = [bigVideo(up('/forbidden.m3u8?a'))];
    page.media = [
      { url: up('/fmp4.m3u8?elsewhere', 'localhost'), kind: 'hls', headers: {} },
      { url: up('/alt.m3u8'), kind: 'hls', headers: {} },
    ];
    const prior = playMsgs().length;
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    await env.played(prior);
    assert.match(playMsgs().at(-1).url, /\/alt\.m3u8$/);
    assert.ok(!seen().some((s) => s.url === '/fmp4.m3u8?elsewhere'), 'the other site\'s stream was not even tried');
    await env.stopPlayer();

    page = env.page = fakePage();
    setPage(up('/watch/alt2'), 'Alt 2');
    page.videos = [bigVideo(up('/forbidden.m3u8?b'))];
    page.media = [{ url: up('/fmp4.m3u8?only-elsewhere', 'localhost'), kind: 'hls', headers: {} }];
    const n = playMsgs().length;
    const ack = await b.send('tvscreen.playVideo', {}, { timeout: 15000 });
    assert.equal(ack.ok, false);
    assert.match(ack.error.message, /refused/);
    assert.equal(playMsgs().length, n);
  });

  test('the master playlist is handed over, never a rendition (sound over black) or one fixed variant', async () => {
    const master = up('/m/master.m3u8');
    const video = up('/m/video.m3u8');
    const audio = up('/m/audio.m3u8');
    setPage(up('/watch/master'), 'Master');
    page.videos = [bigVideo('blob:http://127.0.0.1/m')];
    page.media = [
      { url: audio, kind: 'hls', role: 'media', headers: {} },
      { url: video, kind: 'hls', role: 'media', headers: {} },
      { url: master, kind: 'hls', role: 'master', variants: [{ url: video, bandwidth: 2000000 }], renditions: [{ url: audio, type: 'AUDIO' }], headers: {} },
    ];
    const prior = playMsgs().length;
    const value = ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    assert.equal(value.engine, 'hls');
    await env.played(prior);
    assert.match(playMsgs().at(-1).url, /\/master\.m3u8$/);
    await env.stopPlayer();

    // No master: the video playlist, not the sound.
    page.media = [
      { url: up('/m/aac.m3u8'), kind: 'hls', role: 'media', audioOnly: true, headers: {} },
      { url: up('/m/low.m3u8'), kind: 'hls', role: 'media', headers: {} },
    ];
    const prior2 = playMsgs().length;
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    await env.played(prior2);
    assert.match(playMsgs().at(-1).url, /\/low\.m3u8$/);
    await env.stopPlayer();

    // A refused master: its audio rendition never stands in for it.
    page.media = [
      { url: audio, kind: 'hls', role: 'media', headers: {} },
      { url: up('/m/gone.m3u8'), kind: 'hls', role: 'master', variants: [], renditions: [{ url: audio }], headers: {} },
    ];
    const n = playMsgs().length;
    const ack = await b.send('tvscreen.playVideo', {}, { timeout: 15000 });
    assert.equal(ack.ok, false);
    assert.equal(playMsgs().length, n, 'no screen-play');
    assert.ok(!playMsgs().some((m) => /\/audio\.m3u8$/.test(m.url)), 'the rendition was never handed over');
  });

  test('ads: a pre-roll in the player is never handed over, its video follows without a new click; a short clip over the player is an ad, a standalone one is not', async () => {
    await env.reopen();
    await sleep(5200); // past the manual hand-offs above
    setPage(up('/watch/preroll'), 'Preroll');
    page.media = [{ url: up('/fmp4.m3u8?content'), kind: 'hls', headers: {} }];
    page.videos = [
      { src: up('/ad-preroll.mp4'), area: 1280 * 600, playing: true, ad: true, duration: 20 },
      { src: 'blob:http://127.0.0.1/content', area: 1280 * 600, playing: false },
    ];
    page.key = 'ad';
    page.playing = true;
    page.lastInput = Date.now();
    const plays = playMsgs().length;
    const n = toasts(/An ad is playing/).length;
    await waitFor(() => toasts(/An ad is playing/).length > n, { timeout: 8000, message: 'the ad notice' });
    assert.equal(playMsgs().length, plays, 'the ad is not handed over');
    assert.equal(page.pauses, 0, 'the ad plays on');
    // The ad ends and the page's own player starts, long after the click.
    page.lastInput = Date.now() - 11000;
    page.videos = [{ src: 'blob:http://127.0.0.1/content', area: 1280 * 600, playing: true }];
    page.key = 'content';
    await waitFor(() => playMsgs().length > plays, { timeout: 8000, message: 'the video after the ad' });
    assert.match(playMsgs().at(-1).url, /\/fmp4\.m3u8$/);
    assert.equal(playMsgs().at(-1).engine, 'hls');
    await env.stopPlayer();

    // The automatic hand-off: a short plain clip someone started, on a page of its own.
    const started = (path, key, videos) => {
      page = env.page = fakePage();
      setPage(up(path), key);
      page.videos = videos;
      page.key = key;
      page.playing = true;
      page.lastInput = Date.now();
    };
    const full = { x: 0, y: 0, w: 1280, h: 600 };
    // A 20 s plain clip in front of the page's paused MSE player (a pre-roll its player does not
    // mark), or over a plain-URL video it covers: an ad, its video waits.
    const before = playMsgs().length;
    for (const [path, videos] of [
      ['/watch/short-ad', [
        { src: up('/ad-preroll.mp4'), area: 1280 * 600, rect: full, playing: true, duration: 20 },
        { src: 'blob:http://127.0.0.1/player', area: 1280 * 600, rect: full, playing: false },
      ]],
      ['/watch/over', [
        { src: up('/ad-over.mp4'), area: 1280 * 600, rect: full, playing: true, duration: 15 },
        { src: up('/film.mp4'), area: 1280 * 600, rect: full, playing: false, duration: 5400 },
      ]],
    ]) {
      const notices = toasts(/An ad is playing/).length;
      started(path, path.slice(7), videos);
      await waitFor(() => toasts(/An ad is playing/).length > notices, { timeout: 8000, message: `the short clip on ${path} taken for an ad` });
      assert.equal(playMsgs().length, before, `${path}: the ad is not handed over`);
      assert.equal(page.pauses, 0, `${path}: the ad plays on`);
    }
    // Two same-size clips of a news feed, one under the other: no ads; the one started goes over.
    started('/news/feed', 'feed', [
      { src: up('/clip45.mp4'), area: 1280 * 600, rect: { x: 0, y: 40, w: 1280, h: 600 }, playing: true, duration: 45 },
      { src: up('/clip30.mp4?next'), area: 1280 * 600, rect: { x: 0, y: 680, w: 1280, h: 600 }, playing: false, duration: 30 },
    ]);
    await waitFor(() => playMsgs().length > before, { timeout: 8000, message: 'the feed\'s clip handed over' });
    assert.match(playMsgs().at(-1).url, /\/clip45\.mp4$/);
    await env.stopPlayer();

    // Video → TV is never second-guessed by sizes: a short clip in front of an MSE player, two
    // same-size clips of a page (positions unknown), and a standalone 30 s clip all go over.
    for (const [path, videos, expected] of [
      ['/watch/short-clip', [
        { src: up('/short20.mp4'), area: 1280 * 600, playing: true, duration: 20 },
        { src: 'blob:http://127.0.0.1/player', area: 1280 * 600, playing: false },
      ], /\/short20\.mp4$/],
      ['/news/today', [
        { src: up('/news45.mp4'), area: 1280 * 600, playing: true, duration: 45 },
        { src: up('/news30.mp4'), area: 1280 * 600, playing: false, duration: 30 },
      ], /\/news45\.mp4$/],
      ['/watch/clip', [{ src: up('/clip30.mp4'), area: 1280 * 600, playing: true, duration: 30 }], /\/clip30\.mp4$/],
    ]) {
      page = env.page = fakePage();
      setPage(up(path), 'Clip');
      page.videos = videos;
      const prior = playMsgs().length;
      ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
      await env.played(prior);
      assert.match(playMsgs().at(-1).url, expected, path);
      await env.stopPlayer();
    }
  });

  test('DASH, and an ad server\'s clip beside it: the page\'s .mpd goes to the copy stage (the relay does not rewrite manifests)', async () => {
    setPage(up('/watch/dash'), 'Dash');
    page.videos = [bigVideo('blob:http://127.0.0.1/dash')];
    page.media = [
      { url: 'https://imasdk.googleapis.com/ads/preroll.mp4', kind: 'file', headers: {} },
      { url: up('/v.mpd', 'localhost'), kind: 'dash', headers: {} },
    ];
    const c = env.converts.length;
    const prior = playMsgs().length;
    const value = ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    await env.played(prior);
    assert.equal(value.converted, true);
    assert.equal(value.reason, 'dash');
    assert.equal(env.converts.length, c + 1);
    assert.match(env.converts.at(-1), /\/v\.mpd$/);
    assert.equal(env.tc.opts.at(-1).copy, true);
    assert.match(playMsgs().at(-1).url, /\/relay\/x\//);
    assert.ok(!playMsgs().some((m) => /\.mpd$/.test(m.url)), 'the relayed .mpd never went to the TV');
    await env.stopPlayer();
  });

  test('an H.264 stream labelled with a level too low for its picture goes to the copy stage first; without ffmpeg AVPlay gets it; a normal one plays directly', async () => {
    setPage(up('/watch/level'), 'Level');
    page.videos = [bigVideo(up('/ts-master.m3u8?level'))];
    page.playing = true;
    env.probeExtra = { levelLow: true, level: 30, size: '1920x1080' };
    try {
      let c = env.converts.length;
      const prior = playMsgs().length;
      const value = ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
      await env.played(prior);
      assert.equal(value.converted, true);
      assert.equal(value.reason, 'level');
      assert.equal(env.converts.length, c + 1);
      assert.equal(env.tc.opts.at(-1).copy, true);
      assert.match(playMsgs().at(-1).url, /\/relay\/x\//);
      assert.ok(playMsgs().at(-1).fromStart);
      assert.equal(page.pauses, 1);
      await env.stopPlayer();

      env.tc.available = false;
      page = env.page = fakePage();
      setPage(up('/watch/level2'), 'Level 2');
      page.videos = [bigVideo(up('/ts-master.m3u8?level2'))];
      c = env.converts.length;
      const direct = ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
      assert.equal(direct.engine, 'avplay');
      assert.equal(env.converts.length, c);
      await env.stopPlayer();

      // Video → TV with convert: true and no ffmpeg: said so.
      const refused = await b.send('tvscreen.playVideo', { convert: true }, { timeout: 15000 });
      assert.equal(refused.ok, false);
      assert.match(refused.error.message, /could not be prepared/);
    } finally {
      env.tc.available = true;
      env.probeExtra = null;
    }
    page = env.page = fakePage();
    setPage(up('/watch/normal'), 'Normal');
    page.videos = [bigVideo(up('/ts-master.m3u8?normal'))];
    const c = env.converts.length;
    const value = ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    assert.equal(value.engine, 'avplay');
    assert.equal(env.converts.length, c, 'no conversion');
    await env.stopPlayer();
  });

  test('Convert on the TV (Yellow on the video) converts the video that is on the TV, even after the page moved on', async () => {
    setPage(up('/watch/conv'), 'Conv');
    page.videos = [bigVideo(up('/ts.m3u8?conv'))];
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    fromAgent({ t: 'screen-video', state: 'playing' });
    await waitFor(() => tvVideo() === 'playing', { timeout: 3000, message: 'the player playing' });
    page.videos = [bigVideo(up('/fmp4.m3u8?another'))];
    const c = env.converts.length;
    agent.sendScreenInput({ key: 'convert' });
    await waitFor(() => env.converts.length === c + 1, { timeout: 5000, message: 'a conversion' });
    assert.equal(env.converts.at(-1), up('/ts.m3u8?conv'));
    assert.equal(env.tc.opts.at(-1).copy, true);
    await waitFor(() => playMsgs().at(-1).fromStart === true, { timeout: 3000, message: 'the converted copy on the TV' });
    await env.stopPlayer();
  });

  test('while the TV\'s player is in front, page frames are held back; the latest is shown on the way back', async () => {
    setPage(up('/watch/frames'));
    page.videos = [bigVideo(up('/ts.m3u8'))];
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    fromAgent({ t: 'screen-video', state: 'playing' });
    await waitFor(() => tvVideo() === 'playing', { timeout: 3000, message: 'the player playing' });
    assert.ok(env.sink, 'the frame sink is installed');
    const n = agent.frames.length;
    env.sink(Buffer.from([0xff, 0xd8, 1]));
    env.sink(Buffer.from([0xff, 0xd8, 2]));
    await sleep(300);
    assert.equal(agent.frames.length, n, 'no frames while the player is in front');
    fromAgent({ t: 'screen-video', state: 'stopped' });
    await waitFor(() => agent.frames.length === n + 1, { timeout: 3000, message: 'the held frame' });
    assert.deepEqual([...agent.frames.at(-1)], [0xff, 0xd8, 2]);
    env.sink(Buffer.from([0xff, 0xd8, 3]));
    await waitFor(() => agent.frames.length === n + 2, { timeout: 3000, message: 'frames flowing again' });
  });

  test('DRM: licence relays and the certificate go to the TV, the cookie stays on its own site, a converted job is stopped', async () => {
    // A converted video plays first: the direct stream fails, a copy job starts.
    setPage(up('/watch/converted'));
    page.videos = [bigVideo(up('/ts.m3u8'))];
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    fromAgent({ t: 'screen-video', state: 'error', error: 'AVPlay refused' });
    const c = env.converts.length;
    await waitFor(() => env.converts.length === c + 1, { timeout: 5000, message: 'a conversion' });
    await waitFor(() => playMsgs().at(-1).fromStart === true, { timeout: 3000, message: 'the converted copy on the TV' });
    const job = `job${env.converts.length}`;

    page = env.page = fakePage();
    const stream = up('/drm/master.m3u8');
    setPage(up('/watch/protected'), 'Protected');
    page.videos = [bigVideo(stream)];
    page.media = [{ url: stream, kind: 'hls', headers: { referer: up('/watch/protected'), cookie: 'sid=secret' } }];
    page.drm = {
      stream,
      playready: up('/lic/la?pr', 'localhost'),
      widevine: up('/lic/la?wv', 'localhost'),
      widevineCert: CERT.toString('base64'),
    };
    const prior = playMsgs().length;
    const value = ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    await env.played(prior);
    assert.deepEqual(value.drm.sort(), ['com.microsoft.playready', 'com.widevine.alpha']);
    assert.ok(env.stopped.includes(job), 'the converted video\'s ffmpeg job is stopped');
    assert.equal(page.pauses, 1);
    const play = playMsgs().at(-1);
    assert.equal(play.engine, 'hls');
    assert.match(play.url, /\/relay\//);
    assert.match(play.drm['com.microsoft.playready'].licenseUrl, /\/relay\//);
    const wv = play.drm['com.widevine.alpha'];
    assert.match(wv.licenseUrl, /\/relay\//);
    assert.deepEqual(Buffer.from(await (await fetch(wv.serverCertificateUrl)).arrayBuffer()), CERT);
    // The stream's own site got its cookie (the probe); the licence host never does.
    assert.ok(seen().some((s) => s.url === '/drm/master.m3u8' && s.cookie === 'sid=secret'));
    const reply = await fetch(wv.licenseUrl, { method: 'POST', body: 'challenge' });
    assert.equal(await reply.text(), 'licence for challenge');
    const licence = seen().filter((s) => s.url.startsWith('/lic/'));
    assert.ok(licence.some((s) => s.url === '/lic/la?wv'));
    assert.deepEqual(licence.map((s) => s.cookie), licence.map(() => null), 'no cookie to the licence hosts');

    // The TV gets no licence: it says so, and nothing is converted (the segments are encrypted).
    const n = toasts(/licence/).length;
    const converts = env.converts.length;
    fromAgent({ t: 'screen-video', state: 'error', error: 'EME refused' });
    await waitFor(() => toasts(/licence/).length > n, { timeout: 3000, message: 'the licence toast' });
    await sleep(200);
    assert.equal(env.converts.length, converts, 'no conversion of a protected video');
    fromAgent({ t: 'screen-video', state: 'stopped' });

    page.drm = null;
    const none = await b.send('tvscreen.playVideo', {}, { timeout: 15000 });
    assert.equal(none.ok, false);
    assert.match(none.error.message, /licence server/);
  });

  test('a YouTube embed is not used while the page\'s own (MSE) video plays', async () => {
    setPage(up('/news'), 'News');
    page.videos = [bigVideo('blob:http://127.0.0.1/abc')];
    page.frames = [{ src: 'https://www.youtube.com/embed/dQw4w9WgXcQ', area: 640 * 360 }];
    const n = stack.mock.state.dial.launches.filter((l) => l.name === 'YouTube').length;
    const ack = await b.send('tvscreen.playVideo', {}, { timeout: 15000 });
    assert.equal(ack.ok, false);
    assert.match(ack.error.message, /No video/);
    assert.equal(stack.mock.state.dial.launches.filter((l) => l.name === 'YouTube').length, n);
  });

  test('a small plain-URL video (an ad) is not taken for the page\'s bigger MSE player', async () => {
    setPage(up('/watch-mse'), 'Watch');
    page.videos = [bigVideo('blob:http://127.0.0.1/main'), { src: up('/ad.mp4'), area: 300 * 250, playing: true }];
    page.frames = [];
    const plays = playMsgs().length;
    const ack = await b.send('tvscreen.playVideo', {}, { timeout: 15000 });
    assert.equal(ack.ok, false, 'no stream of the page was sniffed in this test');
    assert.ok(!playMsgs().slice(plays).some((m) => /ad\.mp4/.test(m.url ?? '')), 'the ad was not sent to the TV');
  });

  test('an automatic hand-off that fails leaves the page playing, and is not retried every tick', async () => {
    await env.reopen();
    await sleep(5200); // past the manual hand-offs above
    setPage(up('/mse-only'));
    page.videos = [bigVideo('blob:http://127.0.0.1/mse')];
    page.playing = true;
    page.lastInput = Date.now();
    const n = toasts(/No video/).length;
    await waitFor(() => toasts(/No video/).length > n, { timeout: 8000, message: 'the failure toast' });
    assert.equal(page.pauses, 0, 'the page video keeps playing');
    page.lastInput = Date.now(); // the user taps play again on the page
    await sleep(3500);
    assert.equal(toasts(/No video/).length, n + 1, 'tried once');
    assert.equal(page.pauses, 0);
  });

  test('a click on a video that already plays (full screen, volume) hands nothing over; pressing play does', async () => {
    await env.reopen();
    await sleep(5200);
    setPage(up('/watch/already'), 'Already');
    page.videos = [bigVideo(up('/ts.m3u8?already'))];
    page.playing = true;
    page.lastInput = Date.now() - 11000; // it plays, nobody acted
    await env.ticks(2);
    const plays = playMsgs().length;
    page.lastInput = Date.now(); // the full-screen button
    await env.ticks(3);
    assert.equal(playMsgs().length, plays, 'a click on a playing video hands nothing over');
    assert.equal(page.pauses, 0);
    // Paused, then play pressed: that is someone starting it.
    page.playing = false;
    await env.ticks(2);
    page.playing = true;
    page.lastInput = Date.now();
    await waitFor(() => playMsgs().length > plays, { timeout: 8000, message: 'the hand-off after play' });
    assert.equal(page.pauses, 1);
    await env.stopPlayer();
  });

  test('a TV error the agent reports on an automatic hand-off: a dead link is converted once (copy only), the page plays again, and it is not handed over again', async () => {
    await env.reopen();
    await sleep(5200);
    setPage(up('/watch/dead-copy'), 'Dead');
    page.videos = [bigVideo(up('/ts.m3u8?dead'))];
    page.playing = true;
    page.lastInput = Date.now();
    const plays = playMsgs().length;
    await waitFor(() => playMsgs().length > plays, { timeout: 8000, message: 'the automatic hand-off' });
    assert.equal(page.pauses, 1);
    env.tc.error = `The video could not be converted for the TV (${up('/seg/1.ts')}: Server returned 404 Not Found)`;
    try {
      const c = env.converts.length;
      fromAgent({ t: 'screen-video', state: 'error', error: 'PLAYER_ERROR_CONNECTION_FAILED' });
      await waitFor(() => env.converts.length === c + 1, { timeout: 5000, message: 'the copy attempt' });
      await waitFor(() => page.resumes === 1, { timeout: 5000, message: 'the page video playing again' });
      assert.equal(page.frameResumes, 1, 'its frames too');
      fromAgent({ t: 'screen-video', state: 'stopped' });
      page.lastInput = Date.now(); // someone keeps using the page
      await sleep(6000);
      assert.equal(env.converts.length, c + 1, 'one conversion: the copy, no full encode of a dead link');
      assert.equal(env.tc.opts.at(-1).copy, true);
      assert.equal(playMsgs().length, plays + 1, 'not handed over again');
      // The phones hear about it too, without the stream's address.
      const notice = await b.waitForState('tvscreen.notice', (r) => r?.v?.level === 'warn', { timeout: 3000 });
      assert.match(notice.v.text, /could not be converted/);
      assert.doesNotMatch(notice.v.text, /http:/);
    } finally {
      env.tc.error = null;
    }
  });

  test('Lumen reopening a page itself (restore) hands its autoplaying video nothing; a link someone opens does', async () => {
    const tv = stack.server.features.tvscreen;
    ok(await b.send('tvscreen.close', {}, { timeout: 10000 }));
    await sleep(5200);
    page.videos = [bigVideo(up('/ts.m3u8?restore'))];
    page.playing = true; // autoplay
    const plays = playMsgs().length;
    await tv.open({ url: up('/watch/restore'), restore: true });
    await env.ticks(3);
    assert.equal(playMsgs().length, plays, 'nothing handed over after a restore');
    ok(await b.send('tvscreen.close', {}, { timeout: 10000 }));
    await tv.open({ url: up('/watch/opened') });
    await waitFor(() => playMsgs().length > plays, { timeout: 8000, message: 'the hand-off after opening a link' });
    await env.stopPlayer();
  });

  test('with Lumen behind another app, nothing goes over by itself, and Video → TV brings it to the front before the player starts', async () => {
    await env.reopen();
    await sleep(5200);
    fromAgent({ t: 'screen-live', state: 'hidden' });
    await sleep(100);
    setPage(up('/watch/hidden'), 'Hidden');
    page.videos = [bigVideo(up('/ts.m3u8?hidden'))];
    page.playing = true;
    page.lastInput = Date.now();
    const plays = playMsgs().length;
    await sleep(3500);
    assert.equal(playMsgs().length, plays, 'no automatic hand-off into a page behind another app');
    const launches = env.agentLaunches();
    let launchesAtPlay = null;
    const watch = (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(String(data));
      if (msg.t === 'screen-play' && launchesAtPlay === null) launchesAtPlay = env.agentLaunches();
    };
    agent.ws.on('message', watch);
    try {
      ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
      await waitFor(() => launchesAtPlay !== null, { timeout: 3000, message: 'the screen-play' });
      assert.ok(launchesAtPlay > launches, 'Lumen was launched in front before the player started');
    } finally {
      agent.ws.off('message', watch);
    }
    await env.stopPlayer();
  });

  test('closing the screen during an automatic hand-off: the screen stays closed, nothing plays', async () => {
    await env.reopen();
    await sleep(5200);
    setPage(up('/slow-auto'));
    page.videos = [bigVideo(up('/slow.m3u8?auto'))];
    page.playing = true;
    page.lastInput = Date.now();
    await waitFor(() => seen().some((s) => s.url === '/slow.m3u8?auto'), { timeout: 8000, message: 'the hand-off probing the stream' });
    const plays = playMsgs().length;
    const launches = env.agentLaunches();
    ok(await b.send('tvscreen.close', {}, { timeout: 10000 }));
    const requests = agent.requests.length;
    await sleep(2800);
    assert.equal(stack.server.store.get('tvscreen.on')?.v, false);
    assert.equal(playMsgs().length, plays, 'no screen-play');
    assert.equal(env.agentLaunches(), launches, 'Lumen\'s page is not launched again');
    assert.ok(!agent.requests.slice(requests).some((r) => r.type === 'screen' && r.on === true), 'the screen is not turned on again');
    ok(await b.send('tvscreen.open', {}, { timeout: 15000 }));
  });

  test('Yellow and the automatic hand-off never hand the same video over twice', async () => {
    await sleep(5200);
    // Yellow first; the poller sees the playing video and the fresh key press meanwhile.
    setPage(up('/slow-yellow'));
    page.videos = [bigVideo(up('/slow.m3u8?yellow'))];
    page.playing = true;
    let plays = playMsgs().length;
    agent.sendScreenInput({ key: 'yellow' });
    await waitFor(() => playMsgs().length > plays, { timeout: 8000, message: 'the hand-off' });
    await sleep(2500);
    assert.equal(playMsgs().length, plays + 1);
    assert.equal(seen().filter((s) => s.url === '/slow.m3u8?yellow').length, 1, 'one probe');
    await env.stopPlayer();

    // The automatic one first, then Yellow while it is still probing: Yellow joins it.
    await sleep(5200);
    page = env.page = fakePage();
    setPage(up('/slow-auto2'));
    page.videos = [bigVideo(up('/slow.m3u8?auto2'))];
    page.playing = true;
    page.lastInput = Date.now();
    await waitFor(() => seen().some((s) => s.url === '/slow.m3u8?auto2'), { timeout: 8000, message: 'the automatic hand-off probing' });
    plays = playMsgs().length;
    agent.sendScreenInput({ key: 'yellow' });
    await waitFor(() => playMsgs().length > plays, { timeout: 8000, message: 'the hand-off' });
    await sleep(2500);
    assert.equal(playMsgs().length, plays + 1);
    assert.equal(seen().filter((s) => s.url === '/slow.m3u8?auto2').length, 1, 'one probe');
    await env.stopPlayer();
  });

  test('the trackpad brings Lumen\'s page back over the YouTube app it opened, not over other apps, and not on a sync', async () => {
    // The app in front as Lumen knows it: the REST adapter's (its poll overwrites a value set by hand
    // in the store). The mock TV switches apps, and a REST read of the app publishes it at once.
    const setForeground = async (app) => {
      stack.mock.setForeground(app.id);
      await stack.server.adapters.rest.getApp(app.id);
      await waitFor(() => stack.server.store.get('app.foreground')?.v?.id === app.id, { timeout: 5000, message: `${app.name} in front` });
    };
    setPage('https://www.youtube.com/watch?v=jNQXAC9IVRw', 'Me at the zoo - YouTube');
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    const n = env.agentLaunches();
    await setForeground({ id: '3201907018807', name: 'Netflix' });
    ok(await b.send('browser.pointer', { dx: 0.01 }));
    await sleep(300);
    assert.equal(env.agentLaunches(), n, 'another app the user opened stays in front');
    await setForeground(YOUTUBE_APP);
    ok(await b.send('browser.pointer', {}));
    await sleep(300);
    assert.equal(env.agentLaunches(), n, 'a pointer sync changes nothing on the TV');
    assert.equal(stack.server.store.get('app.foreground')?.v?.id, YOUTUBE_APP.id, 'YouTube still in front for the next move');
    ok(await b.send('browser.pointer', { dx: 0.01 }));
    await waitFor(() => env.agentLaunches() === n + 1, { timeout: 5000, message: 'Lumen\'s page launched in front' });
    await setForeground(YOUTUBE_APP);
    ok(await b.send('browser.pointer', { dx: 0.01 }));
    await sleep(300);
    assert.equal(env.agentLaunches(), n + 1, 'at most once every 5 s');
  });

  test('a converted video paused on the TV outlives the reaper; once the player stops it is released for the idle time; a close stops it at once', async () => {
    // The real transcoder with a stand-in ffmpeg: a finished copy (ENDLIST), as a short film's copy is
    // long before the film ends. A paused AVPlay fetches nothing, so only the hold keeps it.
    const dataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'lumen-hold-'));
    const spawn = (file, args) => {
      const child = new EventEmitter();
      child.stderr = new PassThrough();
      let gone = false;
      child.kill = () => {
        if (!gone) { gone = true; setTimeout(() => { child.stderr.end(); child.emit('exit', null, 'SIGKILL'); }, 5); }
        return true;
      };
      const outDir = nodePath.dirname(args.at(-1));
      setTimeout(() => {
        fs.writeFileSync(nodePath.join(outDir, 'seg_00000.ts'), 'x');
        fs.writeFileSync(nodePath.join(outDir, 'index.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg_00000.ts\n#EXT-X-ENDLIST\n');
      }, 20);
      return child;
    };
    const tc = createTranscoder({ config: { dataDir }, log: createTestLog(), seams: { ffmpeg: 'fake-ffmpeg', spawn, unusedMs: 150 } });
    const fakeTc = stack.server.features.transcode;
    stack.server.features.transcode = tc;
    const source = up('/ts.m3u8?converted-held');
    const jobOf = (url) => /\/relay\/x\/([0-9a-f]{16})\/index\.m3u8$/.exec(url)?.[1] ?? null;
    try {
      setPage(up('/watch/held'), 'A film');
      page.videos = [bigVideo(source)];
      ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
      fromAgent({ t: 'screen-video', state: 'error', error: 'AVPlay refused' });
      await waitFor(() => jobOf(playMsgs().at(-1).url), { timeout: 8000, what: 'the converted copy on the TV' });
      const play = playMsgs().at(-1);
      const id = jobOf(play.url);
      assert.equal(play.fromStart, true);

      // Paused on the TV for longer than the idle time: still there, and the TV gets its files back.
      fromAgent({ t: 'screen-video', state: 'paused' });
      await waitFor(() => tvVideo() === 'paused', { timeout: 3000, what: 'the player paused' });
      await sleep(300);
      tc.reap();
      assert.equal(tc.existing(source)?.id, id, 'the paused video\'s job is held');
      assert.equal((await fetch(play.url)).status, 200, 'resuming finds the playlist');

      // Back on the TV: released, with the whole idle time to find it again (Yellow).
      fromAgent({ t: 'screen-video', state: 'stopped' });
      await waitFor(() => tvVideo() === 'stopped', { timeout: 3000, what: 'the player stopped' });
      tc.reap();
      assert.equal(tc.existing(source)?.id, id, 'a released job gets the idle time first');
      const n = playMsgs().length;
      ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
      await waitFor(() => playMsgs().length > n, { timeout: 8000, what: 'the converted copy again' });
      assert.equal(jobOf(playMsgs().at(-1).url), id, 'Yellow plays the same converted copy');
      fromAgent({ t: 'screen-video', state: 'playing' });
      await waitFor(() => tvVideo() === 'playing', { timeout: 3000, what: 'the player playing' });
      await sleep(300);
      tc.reap();
      assert.equal(tc.existing(source)?.id, id, 'held again while it plays');

      // The screen closed: nobody can come back to it, so its ffmpeg job is stopped at once (the TV
      // screen's own rule, which the conversion-jobs suite checks with the stand-in converter too).
      ok(await b.send('tvscreen.close', {}, { timeout: 10000 }));
      assert.equal(tc.existing(source), null, 'stopped on close');
      assert.equal((await fetch(play.url)).status, 404);
    } finally {
      stack.server.features.transcode = fakeTc;
      await tc.stop();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      ok(await b.send('tvscreen.open', {}, { timeout: 15000 }));
    }
  });

  test('the TV player\'s state is cleared on close and when the agent goes away: the next video goes over by itself', async () => {
    fromAgent({ t: 'screen-video', state: 'playing' });
    await waitFor(() => tvVideo() === 'playing', { timeout: 3000, message: 'the player playing' });
    ok(await b.send('tvscreen.close', {}, { timeout: 10000 }));
    assert.equal(tvVideo(), null);
    ok(await b.send('tvscreen.open', {}, { timeout: 15000 }));
    await sleep(5200);
    setPage(up('/after-close'));
    page.videos = [bigVideo(up('/ts.m3u8?after'))];
    page.playing = true;
    page.lastInput = Date.now();
    const plays = playMsgs().length;
    await waitFor(() => playMsgs().length > plays, { timeout: 8000, message: 'the automatic hand-off after reopening' });
    assert.equal(page.pauses, 1, 'paused once it went over');

    fromAgent({ t: 'screen-video', state: 'playing' });
    await waitFor(() => tvVideo() === 'playing', { timeout: 3000, message: 'the player playing' });
    agent.close();
    await b.waitForState('conn.agent', (r) => r?.v !== 'online', { timeout: 10000 });
    await waitFor(() => tvVideo() === null, { timeout: 3000, message: 'the player state cleared' });
  });
});

describe('tvscreen: the conversion beside the keys, conversion jobs and the player watchdogs', () => {
  let env, b, agent, page, up, setPage, bigVideo, playMsgs, tvVideo, fromAgent, ok;
  const live = []; // calls the live video stand-in got
  const screenOf = (t) => agent.screen.filter((m) => m.t === t);

  before(async () => {
    env = await handOffStack({ liveVideo: { enabled: true }, tvscreen: { autoPlayOnTv: false, jobGraceMs: 400, loadingWatchMs: 2500, stuckMs: 2000 } });
    ({ b, agent, up, setPage, bigVideo, playMsgs, tvVideo, fromAgent, ok } = env);
    // Live video stood in for: what the TV screen asks of it.
    env.stack.server.features.livevideo = {
      enabled: () => true,
      codecProbes: () => ['avc1.640028'],
      attach(viewer, caps, options) {
        live.push(['attach', options.lower]);
        return {
          pause: () => live.push(['pause']), resume: () => live.push(['resume']), resync() {}, report() {},
          refused: () => live.push(['refused']), detach: () => live.push(['detach']),
        };
      },
    };
  });
  after(async () => { await env?.stop(); });
  beforeEach(() => { page = env.page = fakePage(); });

  async function playThenFail(path, title) {
    setPage(up(`/watch/${title}`), title);
    page.videos = [bigVideo(up(path))];
    const prior = playMsgs().length;
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    await env.played(prior);
    const c = env.converts.length;
    fromAgent({ t: 'screen-video', state: 'error', error: 'AVPlay refused' });
    await waitFor(() => env.converts.length === c + 1, { timeout: 5000, message: 'the conversion starting' });
    return `job${env.converts.length}`;
  }

  test('during a conversion the remote keeps working: Red closes at once, and the copy never plays', async () => {
    env.tc.delay = 3000;
    try {
      const job = await playThenFail('/ts.m3u8?red', 'Red');
      assert.equal(tvVideo(), 'fallback');
      fromAgent({ t: 'screen-video', state: 'stopped' }); // the agent's trailing 'stopped'
      await sleep(300);
      assert.equal(tvVideo(), 'fallback', 'the trailing stop changes nothing during the conversion');
      const plays = playMsgs().length;
      const t0 = Date.now();
      agent.sendScreenInput({ key: 'red' });
      await b.waitForState('tvscreen.on', (r) => r?.v === false, { timeout: 2000 });
      assert.ok(Date.now() - t0 < 1500, `Red took ${Date.now() - t0} ms`);
      await sleep(3500);
      assert.equal(playMsgs().length, plays, 'no screen-play after the close');
      assert.ok(env.stopped.includes(job), 'the conversion job is stopped');
    } finally {
      env.tc.delay = 0;
    }
    ok(await b.send('tvscreen.open', {}, { timeout: 15000 }));
  });

  test('a second video during a conversion replaces it: the copy never plays under its title, its job stops; a close does the same', async () => {
    env.tc.delay = 3000;
    try {
      const job = await playThenFail('/ts.m3u8?first', 'First');
      page = env.page = fakePage();
      setPage(up('/watch/second'), 'Second');
      page.videos = [bigVideo(up('/fmp4.m3u8?second'))];
      const plays = playMsgs().length;
      ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
      await env.played(plays);
      assert.equal(playMsgs().length, plays + 1);
      assert.equal(playMsgs().at(-1).title, 'Second');
      await sleep(3500);
      assert.ok(!playMsgs().slice(plays).some((m) => m.fromStart), 'no converted copy of the first video');
      assert.ok(env.stopped.includes(job), 'the first video\'s job is stopped');
      await env.stopPlayer();

      const job2 = await playThenFail('/ts.m3u8?closing', 'Closing');
      const plays2 = playMsgs().length;
      ok(await b.send('tvscreen.close', {}, { timeout: 10000 }));
      await sleep(3500);
      assert.equal(playMsgs().length, plays2, 'no screen-play after tvscreen.close');
      assert.ok(env.stopped.includes(job2));
    } finally {
      env.tc.delay = 0;
    }
    ok(await b.send('tvscreen.open', {}, { timeout: 15000 }));
  });

  test('live video stays paused from the TV error to the converted copy; with nothing left to try it resumes once and the page plays again', async () => {
    fromAgent({ t: 'screen-live', state: 'ready', caps: { 'avc1.640028': true } });
    await waitFor(() => live.some((c) => c[0] === 'attach'), { timeout: 3000, message: 'live video attached' });
    env.tc.delay = 500;
    try {
      setPage(up('/watch/live'), 'Live');
      page.videos = [bigVideo(up('/ts.m3u8?live'))];
      page.playing = true;
      const stops = screenOf('screen-live-stop').length;
      ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
      assert.equal(screenOf('screen-live-stop').length, stops + 1, 'live video stops for the TV\'s player');
      const mark = live.length;
      const plays = playMsgs().length;
      fromAgent({ t: 'screen-video', state: 'error', error: 'AVPlay refused' });
      await waitFor(() => playMsgs().length > plays, { timeout: 5000, message: 'the converted copy' });
      assert.deepEqual(live.slice(mark).filter((c) => c[0] === 'resume'), [], 'no live resume in between');
      assert.equal(screenOf('screen-live-stop').length, stops + 1, 'no second live stop');
      await env.stopPlayer();
      await waitFor(() => live.slice(mark).some((c) => c[0] === 'resume'), { timeout: 3000, message: 'live back with the page' });

      // No ffmpeg: one live resume, and the hand-off's own video plays on the page again.
      env.tc.available = false;
      page = env.page = fakePage();
      setPage(up('/watch/live2'), 'Live 2');
      page.videos = [bigVideo(up('/ts.m3u8?live2'))];
      page.playing = true;
      ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
      const mark2 = live.length;
      fromAgent({ t: 'screen-video', state: 'error', error: 'AVPlay refused' });
      await waitFor(() => page.resumes === 1, { timeout: 3000, message: 'the page video playing again' });
      assert.deepEqual(live.slice(mark2).filter((c) => c[0] === 'resume'), [['resume']]);
    } finally {
      env.tc.delay = 0;
      env.tc.available = true;
    }
    fromAgent({ t: 'screen-video', state: 'stopped' });
  });

  test('a conversion job stops once its video stopped (after a short grace), on close, and after the last stage failed; a video back in the grace keeps it', async () => {
    const convertPage = async (title) => {
      page = env.page = fakePage();
      setPage(up(`/watch/${title}`), title);
      page.videos = [bigVideo(up(`/ts.m3u8?${title}`))];
      ok(await b.send('tvscreen.playVideo', { convert: true }, { timeout: 15000 }));
      return `job${env.converts.length}`;
    };
    // Stopped, then the grace: stopped.
    const a = await convertPage('grace');
    assert.ok(env.holds.some(([id, on]) => id === a && on === true), 'held while it plays');
    fromAgent({ t: 'screen-video', state: 'stopped' });
    await waitFor(() => env.stopped.includes(a), { timeout: 3000, message: 'the job stopped after the grace' });

    // Stopped, then playing again within the grace: kept; close stops it.
    const c = await convertPage('kept');
    fromAgent({ t: 'screen-video', state: 'stopped' });
    await sleep(100);
    fromAgent({ t: 'screen-video', state: 'playing' });
    await sleep(800);
    assert.ok(!env.stopped.includes(c), 'kept while it plays again');
    ok(await b.send('tvscreen.close', {}, { timeout: 10000 }));
    assert.ok(env.stopped.includes(c), 'close stops it');
    ok(await b.send('tvscreen.open', {}, { timeout: 15000 }));

    // Yellow on the same video within the grace: the same job plays again.
    const d = await convertPage('again');
    fromAgent({ t: 'screen-video', state: 'stopped' });
    await sleep(100);
    agent.sendScreenInput({ key: 'yellow' });
    await waitFor(() => playMsgs().at(-1).url.includes(`/x/${d}/`) && tvVideo() === 'loading', { timeout: 5000, message: 'the same copy again' });
    await sleep(800);
    assert.ok(!env.stopped.includes(d), 'the job is kept');
    await env.stopPlayer();
    await waitFor(() => env.stopped.includes(d), { timeout: 3000, message: 'stopped after the grace' });

    // The full conversion fails on the TV too: nothing is left, its job stops.
    page = env.page = fakePage();
    setPage(up('/watch/last'), 'Last');
    page.videos = [bigVideo(up('/ts.m3u8?last'))];
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    let n = env.converts.length;
    fromAgent({ t: 'screen-video', state: 'error', error: 'AVPlay refused' });
    await waitFor(() => env.converts.length === n + 1 && playMsgs().at(-1).fromStart, { timeout: 5000, message: 'the copy' });
    n = env.converts.length;
    fromAgent({ t: 'screen-video', state: 'error', error: 'the copy failed too' });
    await waitFor(() => env.converts.length === n + 1 && env.tc.opts.at(-1).copy === false, { timeout: 5000, message: 'the full conversion' });
    await waitFor(() => tvVideo() === 'loading', { timeout: 3000, message: 'the full conversion on the TV' });
    const encode = `job${env.converts.length}`;
    fromAgent({ t: 'screen-video', state: 'error', error: 'that failed as well' });
    await waitFor(() => env.stopped.includes(encode), { timeout: 3000, message: 'the last stage\'s job stopped' });
    fromAgent({ t: 'screen-video', state: 'stopped' });
  });

  test('Convert (Yellow, the AI\'s convert: true) on a fully converted video, or one being converted, changes nothing: its job keeps feeding the TV', async () => {
    const notices = (re) => env.toasts(re).length;
    // A video the TV refuses, then shows wrongly as a copy: the full conversion plays.
    setPage(up('/watch/encoded'), 'Encoded');
    page.videos = [bigVideo(up('/ts.m3u8?encoded'))];
    const prior = playMsgs().length;
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    await env.played(prior);
    let n = env.converts.length;
    fromAgent({ t: 'screen-video', state: 'error', error: 'AVPlay refused' });
    await waitFor(() => env.converts.length === n + 1 && playMsgs().at(-1).fromStart, { timeout: 5000, message: 'the copy' });
    n = env.converts.length;
    agent.sendScreenInput({ key: 'convert' }); // the copy shows black: Yellow
    await waitFor(() => env.converts.length === n + 1 && env.tc.opts.at(-1).copy === false, { timeout: 5000, message: 'the full conversion' });
    const encode = `job${env.converts.length}`;
    await waitFor(() => playMsgs().at(-1).url.includes(`/x/${encode}/`) && tvVideo() === 'loading', { timeout: 3000, message: 'the full conversion on the TV' });
    fromAgent({ t: 'screen-video', state: 'playing' });
    await waitFor(() => tvVideo() === 'playing', { timeout: 3000, message: 'the conversion playing' });

    const plays = playMsgs().length;
    const converts = env.converts.length;
    const holds = env.holds.length;
    const already = notices(/already converted/);
    agent.sendScreenInput({ key: 'convert' }); // Yellow again (the agent's hint shows it on every video)
    await waitFor(() => notices(/already converted/) > already, { timeout: 3000, message: 'the notice on the TV' });
    const ack = await b.send('tvscreen.playVideo', { convert: true }, { timeout: 15000 });
    assert.equal(ack.ok, false);
    assert.match(ack.error.message, /already converted/);
    await sleep(600); // past the job grace
    assert.ok(!env.stopped.includes(encode), 'the job feeding the TV is not stopped');
    assert.ok(!env.holds.slice(holds).some(([id, on]) => id === encode && on === false), 'and still held');
    assert.equal(env.converts.length, converts, 'nothing converted again');
    assert.equal(playMsgs().length, plays, 'nothing new sent to the TV');
    assert.equal(tvVideo(), 'playing');
    await env.stopPlayer();
    await waitFor(() => env.stopped.includes(encode), { timeout: 3000, message: 'stopped after the grace' });

    // Yellow while the copy is being made: the copy plays when ready, nothing starts again.
    env.tc.delay = 1500;
    try {
      page = env.page = fakePage();
      const job = await playThenFail('/ts.m3u8?busy', 'Busy');
      const c = env.converts.length;
      const busy = notices(/being prepared/);
      agent.sendScreenInput({ key: 'convert' });
      await waitFor(() => notices(/being prepared/) > busy, { timeout: 3000, message: 'the notice on the TV' });
      await waitFor(() => playMsgs().at(-1).url.includes(`/x/${job}/`), { timeout: 5000, message: 'the copy on the TV' });
      assert.equal(env.converts.length, c, 'one conversion');
      assert.ok(!env.stopped.includes(job), 'its job kept');
    } finally {
      env.tc.delay = 0;
    }
    await env.stopPlayer();
  });

  test('a stream that broke mid-film is converted from where it was; a copy that had played is made again once before the full conversion', async () => {
    setPage(up('/watch/film'), 'Film');
    page.videos = [bigVideo(up('/ts.m3u8?film'))];
    const prior = playMsgs().length;
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    await env.played(prior);
    const n = env.converts.length;
    fromAgent({ t: 'screen-video', state: 'error', error: 'PLAYER_ERROR_CONNECTION_FAILED', played: true, position: 2400000 });
    await waitFor(() => env.converts.length === n + 1, { timeout: 5000, message: 'the copy' });
    assert.deepEqual([env.tc.opts.at(-1).copy, env.tc.opts.at(-1).startSec], [true, 2400]);
    await waitFor(() => playMsgs().at(-1).fromStart === true && tvVideo() === 'loading', { timeout: 3000, message: 'the copy on the TV' });
    // The copy plays a while, then breaks: made again from there, still a copy.
    fromAgent({ t: 'screen-video', state: 'error', error: 'relay 502', played: true, position: 600000 });
    await waitFor(() => env.converts.length === n + 2, { timeout: 5000, message: 'the copy again' });
    assert.deepEqual([env.tc.opts.at(-1).copy, env.tc.opts.at(-1).startSec], [true, 600]);
    await waitFor(() => tvVideo() === 'loading', { timeout: 3000, message: 'the second copy on the TV' });
    // Once more: now the full conversion.
    fromAgent({ t: 'screen-video', state: 'error', error: 'relay 502', played: true, position: 700000 });
    await waitFor(() => env.converts.length === n + 3, { timeout: 5000, message: 'the full conversion' });
    assert.deepEqual([env.tc.opts.at(-1).copy, env.tc.opts.at(-1).startSec], [false, 700]);
    await waitFor(() => tvVideo() === 'loading', { timeout: 3000, message: 'the conversion on the TV' });
    await env.stopPlayer();
  });

  test('the player\'s state cannot drift: a moving clock means playing, a silent player is let go, a clock stuck at 0 is a failure', async () => {
    setPage(up('/watch/beat'), 'Beat');
    page.videos = [bigVideo(up('/ts.m3u8?beat'))];
    const prior = playMsgs().length;
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    const { id } = await env.played(prior);
    assert.equal(tvVideo(), 'loading');
    fromAgent({ t: 'screen-video', state: 'loading', mode: 'avplay', position: 0, heartbeat: true, id });
    await sleep(150);
    assert.equal(tvVideo(), 'loading');
    fromAgent({ t: 'screen-video', state: 'loading', mode: 'avplay', position: 1200, heartbeat: true, id });
    await waitFor(() => tvVideo() === 'playing', { timeout: 3000, message: 'playing from the moving clock' });
    // A report about an older stream changes nothing.
    fromAgent({ t: 'screen-video', state: 'stopped', id: id - 1 });
    await sleep(200);
    assert.equal(tvVideo(), 'playing');
    await env.stopPlayer();

    // Asked to play, then nothing: after the watchdog the page comes back.
    page = env.page = fakePage();
    setPage(up('/watch/silent'), 'Silent');
    page.videos = [bigVideo(up('/ts.m3u8?silent'))];
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    assert.equal(tvVideo(), 'loading');
    await waitFor(() => tvVideo() === null, { timeout: 6000, message: 'the silent player let go' });

    // Heartbeats with the clock at 0: a failure, and the ladder goes on.
    page = env.page = fakePage();
    setPage(up('/watch/stuck'), 'Stuck');
    page.videos = [bigVideo(up('/ts.m3u8?stuck'))];
    const prior2 = playMsgs().length;
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    const stuck = (await env.played(prior2)).id;
    const n = env.converts.length;
    const beat = setInterval(() => fromAgent({ t: 'screen-video', state: 'loading', mode: 'avplay', position: 0, heartbeat: true, id: stuck }), 400);
    try {
      await waitFor(() => env.converts.length === n + 1, { timeout: 6000, message: 'the copy after the stuck clock' });
    } finally {
      clearInterval(beat);
    }
    await waitFor(() => playMsgs().at(-1).fromStart === true, { timeout: 3000, message: 'the converted copy on the TV' });
    await env.stopPlayer();
  });
});
