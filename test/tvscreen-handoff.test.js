// Handing the page's video to the TV's own player: the engine the HLS probe picks, the DRM path
// (licence relays, the Widevine certificate, cookies kept to their own site), the automatic hand-off
// (only after a success is the page paused; a close stops it; one hand-off at a time), the frames
// held back while the player is in front, and the trackpad bringing Lumen's page back only over the
// YouTube app it opened. Mock TV, fake agent, a local media server, and a scripted stand-in for the
// browser page (no Edge needed).
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startStack, waitFor } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AGENT_APP = 'lumenrmt01.LumenAgent';
const YOUTUBE_APP = { id: '111299001912', name: 'YouTube' };
const CERT = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

describe('tvscreen: handing the page\'s video to the TV', () => {
  let stack, b, agent, real, realTranscode, page, web, port, sink;
  const seen = []; // requests the media server got: { url, method, cookie }
  const converts = [];
  const stopped = [];

  const media = (lines) => ['#EXTM3U', ...lines, '#EXT-X-ENDLIST', ''].join('\n');
  const playlist = (res, text) => { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end(text); };

  function fakePage() {
    return {
      playing: false, pauses: 0, lastInput: 0,
      videos: [], // [{ src, area, playing }]
      frames: [],
      media: [], // the browser feature's media list: [{ url, kind, headers }]
      drm: null, // what DRM_SCRIPT finds in window.playerConfig
    };
  }

  function setPage(url, title = 'Page') {
    stack.server.store.set('browser.url', url, { src: 'derived', via: 'browser' });
    stack.server.store.set('browser.title', title, { src: 'derived', via: 'browser' });
  }
  const up = (path, host = '127.0.0.1') => `http://${host}:${port}${path}`;
  const bigVideo = (src) => ({ src, area: 1280 * 600, playing: true });
  const playMsgs = () => agent.screen.filter((m) => m.t === 'screen-play');
  const toasts = (re) => agent.screen.filter((m) => m.t === 'screen-toast' && re.test(m.text));
  const agentLaunches = () => stack.mock.state.launches.filter((l) => l.appId === AGENT_APP).length;
  const youtubeLaunches = () => stack.mock.state.dial.launches.filter((l) => l.name === 'YouTube').length;
  const tvVideo = () => stack.server.store.get('tvscreen.video')?.v ?? null;
  const fromAgent = (msg) => agent.ws.send(JSON.stringify(msg));
  const ok = (ack) => { assert.equal(ack.ok, true, JSON.stringify(ack.error)); return ack.value; };
  // The app in front, on the mock TV (which the REST poller reads) and in the store at once.
  const setForeground = (value) => {
    stack.mock.setForeground(value.id);
    stack.server.store.set('app.foreground', value, { src: 'live', via: 'test', ttlMs: 60000 });
  };
  async function reopen() {
    ok(await b.send('tvscreen.close', {}, { timeout: 10000 }));
    ok(await b.send('tvscreen.open', {}, { timeout: 15000 }));
  }

  before(async () => {
    web = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const path = new URL(req.url, 'http://x').pathname;
        seen.push({ url: req.url, method: req.method, cookie: req.headers.cookie ?? null });
        if (path === '/ts.m3u8') return playlist(res, media(['#EXTINF:4,', 'seg.ts']));
        if (path === '/fmp4.m3u8') return playlist(res, media(['#EXT-X-MAP:URI="init.mp4"', '#EXTINF:4,', 'seg.m4s']));
        if (path === '/slow.m3u8') { setTimeout(() => playlist(res, media(['#EXTINF:4,', 'seg.ts'])), 2000); return undefined; }
        if (path === '/drm/master.m3u8') return playlist(res, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n');
        if (path === '/drm/media.m3u8') return playlist(res, media(['#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AA=="', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:6,', 'seg.m4s']));
        if (path === '/lic/la') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ licenseAcquisitionUrl: up('/lic/server'), token: 't1' })); return undefined; }
        if (path === '/lic/server') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(`licence for ${body}`); return undefined; }
        res.writeHead(path === '/forbidden.m3u8' ? 403 : 404);
        res.end();
        return undefined;
      });
    });
    // Every address: the licence host is reached as "localhost", another site than 127.0.0.1.
    await new Promise((r) => web.listen(0, r));
    port = web.address().port;

    stack = await startStack();
    b = stack.browser();
    await b.hello;
    agent = stack.agent();
    await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
    real = stack.server.features.browser;
    const fake = Object.create(real);
    Object.assign(fake, {
      async ensureRunning() {},
      async open(url) { setPage(url); return { value: { url } }; },
      async nav() { return {}; },
      async input() { return {}; },
      addSink(fn) { sink = fn; return () => { if (sink === fn) sink = null; }; },
      media: () => page.media,
      frameSize: () => ({ w: 1280, h: 720 }),
      lastInputAt: () => page.lastInput,
      async evaluate(expression) {
        const src = String(expression);
        if (src.includes('v.pause()')) { page.pauses += 1; page.playing = false; return undefined; }
        if (src.includes('playerConfig')) return page.drm;
        if (src.includes('.html5-video-player')) return { found: false, t: null, ad: false, live: false };
        if (src.includes('iframe')) return { videos: page.videos, frames: page.frames };
        if (src.includes('innerWidth * innerHeight')) return page.playing;
        throw new Error(`unexpected page script: ${src.slice(0, 60)}`);
      },
    });
    stack.server.features.browser = fake;
    realTranscode = stack.server.features.transcode;
    stack.server.features.transcode = {
      available: () => true,
      existing: () => null,
      async convert(url) { converts.push(url); return { id: `job${converts.length}` }; },
      stopJob: (id) => { stopped.push(id); },
      file: () => null,
    };
    page = fakePage();
    setPage(up('/start'));
    ok(await b.send('tvscreen.open', {}, { timeout: 15000 }));
  });
  after(async () => {
    if (stack) {
      stack.server.features.browser = real;
      stack.server.features.transcode = realTranscode;
    }
    await stack?.stop();
    web?.close();
  });
  beforeEach(() => { page = fakePage(); });

  test('the engine follows the probe: TS → AVPlay, fMP4 → hls.js, a refused playlist → AVPlay; the page is paused', async () => {
    for (const [path, engine] of [['/ts.m3u8', 'avplay'], ['/fmp4.m3u8', 'hls'], ['/forbidden.m3u8', 'avplay']]) {
      page = fakePage();
      setPage(up(`/watch${path}`), 'A video');
      page.videos = [bigVideo(up(path))];
      page.playing = true;
      const n = playMsgs().length;
      const value = ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
      assert.equal(value.engine, engine, path);
      assert.equal(playMsgs().length, n + 1, path);
      assert.equal(playMsgs().at(-1).engine, engine, path);
      assert.match(playMsgs().at(-1).url, /\/relay\//);
      assert.equal(page.pauses, 1, `${path}: the page's own video is paused`);
      assert.equal(tvVideo(), 'loading');
      fromAgent({ t: 'screen-video', state: 'stopped' });
      await waitFor(() => tvVideo() === 'stopped', { timeout: 3000, what: 'the player stopped' });
    }
  });

  test('while the TV\'s player is in front, page frames are held back; the latest is shown on the way back', async () => {
    setPage(up('/watch/frames'));
    page.videos = [bigVideo(up('/ts.m3u8'))];
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    fromAgent({ t: 'screen-video', state: 'playing' });
    await waitFor(() => tvVideo() === 'playing', { timeout: 3000, what: 'the player playing' });
    assert.ok(sink, 'the frame sink is installed');
    const n = agent.frames.length;
    sink(Buffer.from([0xff, 0xd8, 1]));
    sink(Buffer.from([0xff, 0xd8, 2]));
    await sleep(300);
    assert.equal(agent.frames.length, n, 'no frames while the player is in front');
    fromAgent({ t: 'screen-video', state: 'stopped' });
    await waitFor(() => agent.frames.length === n + 1, { timeout: 3000, what: 'the held frame' });
    assert.deepEqual([...agent.frames.at(-1)], [0xff, 0xd8, 2]);
    sink(Buffer.from([0xff, 0xd8, 3]));
    await waitFor(() => agent.frames.length === n + 2, { timeout: 3000, what: 'frames flowing again' });
  });

  test('DRM: licence relays and the certificate go to the TV, the cookie stays on its own site, a converted job is stopped', async () => {
    // A converted video plays first: the direct stream fails, a copy job starts.
    setPage(up('/watch/converted'));
    page.videos = [bigVideo(up('/ts.m3u8'))];
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    fromAgent({ t: 'screen-video', state: 'error', error: 'AVPlay refused' });
    await waitFor(() => converts.length === 1, { timeout: 5000, what: 'a conversion' });
    await waitFor(() => playMsgs().at(-1).fromStart === true, { timeout: 3000, what: 'the converted copy on the TV' });
    const job = `job${converts.length}`;

    page = fakePage();
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
    const value = ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    assert.deepEqual(value.drm.sort(), ['com.microsoft.playready', 'com.widevine.alpha']);
    assert.ok(stopped.includes(job), 'the converted video\'s ffmpeg job is stopped');
    assert.equal(page.pauses, 1);
    const play = playMsgs().at(-1);
    assert.equal(play.engine, 'hls');
    assert.match(play.url, /\/relay\//);
    assert.match(play.drm['com.microsoft.playready'].licenseUrl, /\/relay\//);
    const wv = play.drm['com.widevine.alpha'];
    assert.match(wv.licenseUrl, /\/relay\//);
    assert.deepEqual(Buffer.from(await (await fetch(wv.serverCertificateUrl)).arrayBuffer()), CERT);
    // The stream's own site got its cookie (the probe); the licence host never does.
    assert.ok(seen.some((s) => s.url === '/drm/master.m3u8' && s.cookie === 'sid=secret'));
    const reply = await fetch(wv.licenseUrl, { method: 'POST', body: 'challenge' });
    assert.equal(await reply.text(), 'licence for challenge');
    const licence = seen.filter((s) => s.url.startsWith('/lic/'));
    assert.ok(licence.some((s) => s.url === '/lic/la?wv'));
    assert.deepEqual(licence.map((s) => s.cookie), licence.map(() => null), 'no cookie to the licence hosts');

    // The TV gets no licence: it says so, and nothing is converted (the segments are encrypted).
    const n = toasts(/licence/).length;
    fromAgent({ t: 'screen-video', state: 'error', error: 'EME refused' });
    await waitFor(() => toasts(/licence/).length > n, { timeout: 3000, what: 'the licence toast' });
    await sleep(200);
    assert.equal(converts.length, 1, 'no conversion of a protected video');
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
    const n = youtubeLaunches();
    const ack = await b.send('tvscreen.playVideo', {}, { timeout: 15000 });
    assert.equal(ack.ok, false);
    assert.match(ack.error.message, /No video/);
    assert.equal(youtubeLaunches(), n);
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
    await reopen();
    await sleep(5200); // past the manual hand-offs above
    setPage(up('/mse-only'));
    page.videos = [bigVideo('blob:http://127.0.0.1/mse')];
    page.playing = true;
    page.lastInput = Date.now();
    const n = toasts(/No video/).length;
    await waitFor(() => toasts(/No video/).length > n, { timeout: 8000, what: 'the failure toast' });
    assert.equal(page.pauses, 0, 'the page video keeps playing');
    page.lastInput = Date.now(); // the user taps play again on the page
    await sleep(3500);
    assert.equal(toasts(/No video/).length, n + 1, 'tried once');
    assert.equal(page.pauses, 0);
  });

  test('closing the screen during an automatic hand-off: the screen stays closed, nothing plays', async () => {
    await reopen();
    await sleep(5200);
    setPage(up('/slow-auto'));
    page.videos = [bigVideo(up('/slow.m3u8?auto'))];
    page.playing = true;
    page.lastInput = Date.now();
    await waitFor(() => seen.some((s) => s.url === '/slow.m3u8?auto'), { timeout: 8000, what: 'the hand-off probing the stream' });
    const plays = playMsgs().length;
    const launches = agentLaunches();
    ok(await b.send('tvscreen.close', {}, { timeout: 10000 }));
    const requests = agent.requests.length;
    await sleep(2800);
    assert.equal(stack.server.store.get('tvscreen.on')?.v, false);
    assert.equal(playMsgs().length, plays, 'no screen-play');
    assert.equal(agentLaunches(), launches, 'Lumen\'s page is not launched again');
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
    await waitFor(() => playMsgs().length > plays, { timeout: 8000, what: 'the hand-off' });
    await sleep(2500);
    assert.equal(playMsgs().length, plays + 1);
    assert.equal(seen.filter((s) => s.url === '/slow.m3u8?yellow').length, 1, 'one probe');
    fromAgent({ t: 'screen-video', state: 'stopped' });
    await waitFor(() => tvVideo() === 'stopped', { timeout: 3000, what: 'the player stopped' });

    // The automatic one first, then Yellow while it is still probing: Yellow joins it.
    await sleep(5200);
    page = fakePage();
    setPage(up('/slow-auto2'));
    page.videos = [bigVideo(up('/slow.m3u8?auto2'))];
    page.playing = true;
    page.lastInput = Date.now();
    await waitFor(() => seen.some((s) => s.url === '/slow.m3u8?auto2'), { timeout: 8000, what: 'the automatic hand-off probing' });
    plays = playMsgs().length;
    agent.sendScreenInput({ key: 'yellow' });
    await waitFor(() => playMsgs().length > plays, { timeout: 8000, what: 'the hand-off' });
    await sleep(2500);
    assert.equal(playMsgs().length, plays + 1);
    assert.equal(seen.filter((s) => s.url === '/slow.m3u8?auto2').length, 1, 'one probe');
    fromAgent({ t: 'screen-video', state: 'stopped' });
    await waitFor(() => tvVideo() === 'stopped', { timeout: 3000, what: 'the player stopped' });
  });

  test('the trackpad brings Lumen\'s page back over the YouTube app it opened, not over other apps, and not on a sync', async () => {
    setPage('https://www.youtube.com/watch?v=jNQXAC9IVRw', 'Me at the zoo - YouTube');
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    const n = agentLaunches();
    setForeground({ id: '3201907018807', name: 'Netflix' });
    ok(await b.send('browser.pointer', { dx: 0.01 }));
    await sleep(300);
    assert.equal(agentLaunches(), n, 'another app the user opened stays in front');
    setForeground(YOUTUBE_APP);
    ok(await b.send('browser.pointer', {}));
    await sleep(300);
    assert.equal(agentLaunches(), n, 'a pointer sync changes nothing on the TV');
    ok(await b.send('browser.pointer', { dx: 0.01 }));
    await waitFor(() => agentLaunches() === n + 1, { timeout: 5000, what: 'Lumen\'s page launched in front' });
    setForeground(YOUTUBE_APP);
    ok(await b.send('browser.pointer', { dx: 0.01 }));
    await sleep(300);
    assert.equal(agentLaunches(), n + 1, 'at most once every 5 s');
  });

  test('the TV player\'s state is cleared on close and when the agent goes away: the next video goes over by itself', async () => {
    fromAgent({ t: 'screen-video', state: 'playing' });
    await waitFor(() => tvVideo() === 'playing', { timeout: 3000, what: 'the player playing' });
    ok(await b.send('tvscreen.close', {}, { timeout: 10000 }));
    assert.equal(tvVideo(), null);
    ok(await b.send('tvscreen.open', {}, { timeout: 15000 }));
    await sleep(5200);
    setPage(up('/after-close'));
    page.videos = [bigVideo(up('/ts.m3u8?after'))];
    page.playing = true;
    page.lastInput = Date.now();
    const plays = playMsgs().length;
    await waitFor(() => playMsgs().length > plays, { timeout: 8000, what: 'the automatic hand-off after reopening' });
    assert.equal(page.pauses, 1, 'paused once it went over');

    fromAgent({ t: 'screen-video', state: 'playing' });
    await waitFor(() => tvVideo() === 'playing', { timeout: 3000, what: 'the player playing' });
    agent.close();
    await b.waitForState('conn.agent', (r) => r?.v !== 'online', { timeout: 10000 });
    await waitFor(() => tvVideo() === null, { timeout: 3000, what: 'the player state cleared' });
  });
});
