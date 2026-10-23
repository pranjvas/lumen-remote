// YouTube in Lumen's browser goes to the TV's own YouTube app, not the relay: YouTube's web player
// streams separate audio and video over MSE (UMP POSTs to googlevideo.com), so the page has no single
// stream the TV could play. Video → TV, Yellow, the AI tool and the automatic hand-off of a started
// video all launch YouTube over DIAL with the video id and the page player's position, and pause the
// page. Mock TV (DIAL), fake agent, and a scripted stand-in for the browser page (no Edge needed).
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor } from './helpers.js';
import { youtubeVideo } from '../server/features/tvscreen.js';
import { callTool } from '../server/ai/tools.js';

const ID = 'dQw4w9WgXcQ';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('youtubeVideo: the YouTube link forms', () => {
  test('watch?v=, youtu.be/, /shorts/, /embed/, /live/, m., music., nocookie; t= and start=', () => {
    assert.deepEqual(youtubeVideo(`https://www.youtube.com/watch?v=${ID}`), { id: ID });
    assert.deepEqual(youtubeVideo(`https://www.youtube.com/watch?v=${ID}&t=75`), { id: ID, t: 75 });
    assert.deepEqual(youtubeVideo(`https://www.youtube.com/watch?v=${ID}&t=75s&list=PL1`), { id: ID, t: 75 });
    assert.deepEqual(youtubeVideo(`https://m.youtube.com/watch?v=${ID}&t=1h2m3s`), { id: ID, t: 3723 });
    assert.deepEqual(youtubeVideo(`https://music.youtube.com/watch?v=${ID}`), { id: ID });
    assert.deepEqual(youtubeVideo(`https://youtu.be/${ID}`), { id: ID });
    assert.deepEqual(youtubeVideo(`https://youtu.be/${ID}?t=1m30s`), { id: ID, t: 90 });
    assert.deepEqual(youtubeVideo(`https://www.youtube.com/shorts/${ID}`), { id: ID });
    assert.deepEqual(youtubeVideo(`https://youtube.com/shorts/${ID}?feature=share`), { id: ID });
    assert.deepEqual(youtubeVideo(`https://www.youtube.com/embed/${ID}`), { id: ID });
    assert.deepEqual(youtubeVideo(`https://www.youtube.com/embed/${ID}?start=42&autoplay=1`), { id: ID, t: 42 });
    assert.deepEqual(youtubeVideo(`https://www.youtube-nocookie.com/embed/${ID}?start=42`), { id: ID, t: 42 });
    assert.deepEqual(youtubeVideo(`https://www.youtube.com/live/${ID}`), { id: ID });
    assert.deepEqual(youtubeVideo(`https://www.youtube.com/watch?v=${ID}#t=30`), { id: ID, t: 30 });
  });

  test('not a video: the home page, search, channels, bad ids, other sites, junk', () => {
    for (const url of ['https://www.youtube.com/', 'https://www.youtube.com/results?search_query=test', 'https://www.youtube.com/@channel',
      'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/watch', 'https://example.com/watch?v=dQw4w9WgXcQ',
      'https://notyoutube.com/watch?v=dQw4w9WgXcQ', `ftp://youtu.be/${ID}`, 'not a url', '', null, undefined]) {
      assert.equal(youtubeVideo(url), null, String(url));
    }
  });
});

describe('tvscreen: YouTube plays in the TV\'s YouTube app', () => {
  let stack, b, agent, real, page;

  // The page Lumen's browser shows: its URL, title, <video> state, YouTube player and iframes.
  function fakePage() {
    return {
      playing: false, pauses: 0, evaluated: [],
      player: null, // { id, t, ad, live } as YouTube's player API reports it, or null
      frames: [], // [{ src, area }]
      videos: [], // [{ src, area, playing }]
    };
  }

  function setPage(url, title = 'Some video - YouTube') {
    const store = stack.server.store;
    store.set('browser.url', url, { src: 'derived', via: 'browser' });
    store.set('browser.title', title, { src: 'derived', via: 'browser' });
  }

  const launches = () => stack.mock.state.dial.launches.filter((l) => l.name === 'YouTube');
  const plays = () => agent.screen.filter((m) => m.t === 'screen-play').length;

  before(async () => {
    stack = await startStack();
    b = stack.browser();
    await b.hello;
    agent = stack.agent();
    await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
    real = stack.server.features.browser;
    // Everything but the page itself is the real browser feature (which never starts Edge here).
    const fake = Object.create(real);
    Object.assign(fake, {
      async ensureRunning() {},
      async open(url) { setPage(url, 'Page'); return { value: { url } }; },
      async nav() { return {}; },
      async input() { return {}; },
      addSink: () => () => {},
      media: () => [],
      frameSize: () => ({ w: 1280, h: 720 }),
      lastInputAt: () => page.lastInput ?? 0,
      async evaluate(expression) {
        const src = String(expression);
        page.evaluated.push(src);
        if (src.includes('v.pause()')) { page.pauses += 1; page.playing = false; return undefined; }
        if (src.includes('.html5-video-player')) {
          const want = /const want = "([\w-]+)"/.exec(src)?.[1];
          const p = page.player;
          return p && p.id === want ? { found: true, t: p.t, ad: !!p.ad, live: !!p.live } : { found: false, t: null, ad: false, live: false };
        }
        if (src.includes('iframe')) return { videos: page.videos, frames: page.frames };
        if (src.includes('innerWidth * innerHeight')) return page.playing;
        throw new Error(`unexpected page script: ${src.slice(0, 60)}`);
      },
    });
    stack.server.features.browser = fake;
  });
  after(async () => {
    if (stack) stack.server.features.browser = real;
    await stack?.stop();
  });
  beforeEach(() => { page = fakePage(); });

  test('Video → TV on a watch page: YouTube app with the id and the player\'s position, page paused, no relay', async () => {
    setPage(`https://www.youtube.com/watch?v=${ID}&t=10s`, 'Never Gonna Give You Up - YouTube');
    page.player = { id: ID, t: 75.6 };
    page.playing = true;
    const n = launches().length;
    const before = plays();
    const ack = await b.send('tvscreen.playVideo', {}, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.deepEqual([ack.value.kind, ack.value.videoId, ack.value.t, ack.value.title], ['youtube', ID, 75, 'Never Gonna Give You Up']);
    assert.equal(launches().length, n + 1);
    assert.equal(launches().at(-1).body, `v=${ID}&t=75`);
    assert.equal(page.pauses, 1, 'the page video is paused');
    assert.equal(plays(), before, 'nothing goes to the agent\'s player');
    const session = await b.waitForState('cast.session', (r) => r?.v?.app === 'youtube', { timeout: 5000 });
    assert.equal(session.v.title, 'YouTube');
  });

  test('youtu.be with t= and no player on the page: the link\'s own position', async () => {
    setPage(`https://youtu.be/${ID}?t=1m30s`);
    const ack = await b.send('tvscreen.playVideo', {}, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(launches().at(-1).body, `v=${ID}&t=90`);
  });

  test('a Short at the start: just the id', async () => {
    setPage(`https://www.youtube.com/shorts/${ID}`);
    page.player = { id: ID, t: 0.4 };
    const ack = await b.send('tvscreen.playVideo', {}, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(launches().at(-1).body, `v=${ID}`);
    assert.equal(ack.value.t, 0);
  });

  test('an embed page with start=, and an ad playing: the video\'s own position, not the ad\'s', async () => {
    setPage(`https://www.youtube.com/embed/${ID}?start=42`);
    let ack = await b.send('tvscreen.playVideo', {}, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(launches().at(-1).body, `v=${ID}&t=42`);
    setPage(`https://www.youtube.com/watch?v=${ID}&t=30`);
    page.player = { id: ID, t: 30, ad: true };
    ack = await b.send('tvscreen.playVideo', {}, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(launches().at(-1).body, `v=${ID}&t=30`);
  });

  test('a live stream goes without a position; another video in the player is not used', async () => {
    setPage(`https://www.youtube.com/live/${ID}`);
    page.player = { id: ID, t: 5000, live: true };
    let ack = await b.send('tvscreen.playVideo', {}, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(launches().at(-1).body, `v=${ID}`);
    setPage(`https://www.youtube.com/watch?v=${ID}`);
    page.player = { id: 'aaaaaaaaaaa', t: 300 };
    ack = await b.send('tvscreen.playVideo', {}, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(launches().at(-1).body, `v=${ID}`);
  });

  test('an explicit YouTube link plays in the app; its own t= wins over the page', async () => {
    setPage(`https://www.youtube.com/watch?v=${ID}`);
    page.player = { id: ID, t: 200 };
    const ack = await b.send('tvscreen.playVideo', { url: `https://youtu.be/${ID}?t=12` }, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(launches().at(-1).body, `v=${ID}&t=12`);
  });

  test('a YouTube embed on another site: the biggest one goes to the app; a tiny one is not the page\'s video', async () => {
    setPage('https://news.example.com/story', 'A story');
    page.frames = [
      { src: 'https://www.youtube.com/embed/aaaaaaaaaaa?enablejsapi=1', area: 100 },
      { src: `https://www.youtube-nocookie.com/embed/${ID}?start=7`, area: 640 * 360 },
      { src: 'https://ads.example.net/frame', area: 300 * 250 },
    ];
    const ack = await b.send('tvscreen.playVideo', {}, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(launches().at(-1).body, `v=${ID}&t=7`);
    assert.equal(ack.value.title, null, 'the story\'s title is not the video\'s');
    page = fakePage();
    page.frames = [{ src: `https://www.youtube.com/embed/${ID}`, area: 100 }];
    const none = await b.send('tvscreen.playVideo', {}, { timeout: 15000 });
    assert.equal(none.ok, false);
    assert.match(none.error.message, /No video/);
  });

  test('the AI tool browser_play_video_on_tv opens the YouTube app', async () => {
    setPage(`https://www.youtube.com/watch?v=${ID}`, 'Rick Astley - YouTube');
    page.player = { id: ID, t: 61.2 };
    const ctx = { hub: stack.server.hub, store: stack.server.store, browser: () => stack.server.features.browser };
    const res = await callTool('browser_play_video_on_tv', {}, ctx);
    assert.equal(res.isError, false, res.text);
    assert.equal(launches().at(-1).body, `v=${ID}&t=61`);
    assert.match(res.text, /YouTube app/);
    assert.equal(page.pauses, 1);
  });

  test('On TV: a YouTube video someone starts on the page goes to the app by itself, once; autoplay stays', async () => {
    const other = 'jNQXAC9IVRw'; // not handed off by the tests above (those would count as a repeat)
    setPage(`https://www.youtube.com/watch?v=${other}`);
    const opened = await b.send('tvscreen.open', {}, { timeout: 15000 });
    assert.equal(opened.ok, true, JSON.stringify(opened.error));
    const n = launches().length;
    const before = plays();
    page.player = { id: other, t: 3.2 };
    await sleep(1800); // a paused page is left alone
    assert.equal(launches().length, n);
    page.playing = true; // started by itself (autoplay, a preview): stays on the page
    await sleep(1800);
    assert.equal(launches().length, n);
    page.playing = false;
    page.lastInput = Date.now(); // someone tapped play
    page.playing = true;
    await waitFor(() => launches().length > n, { timeout: 8000, what: 'YouTube launched on the TV' });
    assert.equal(launches().at(-1).body, `v=${other}&t=3`);
    await waitFor(() => page.playing === false, { timeout: 3000, what: 'the page video paused' });
    assert.ok(agent.screen.some((m) => m.t === 'screen-toast' && /YouTube/.test(m.text)));
    // YouTube starting the same video again on the page right away is paused, not launched again.
    const pauses = page.pauses;
    page.playing = true;
    await waitFor(() => page.pauses > pauses, { timeout: 5000, what: 'the repeat paused' });
    await sleep(300);
    assert.equal(launches().length, n + 1);
    assert.equal(plays(), before, 'nothing goes to the agent\'s player');
    const closed = await b.send('tvscreen.close', {}, { timeout: 10000 });
    assert.equal(closed.ok, true);
  });

  test('without the TV agent, Video → TV still opens YouTube (DIAL needs no agent)', async () => {
    agent.close();
    await b.waitForState('conn.agent', (r) => r?.v !== 'online', { timeout: 10000 });
    setPage(`https://www.youtube.com/watch?v=${ID}`);
    const ack = await b.send('tvscreen.playVideo', {}, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(launches().at(-1).body, `v=${ID}`);
  });
});
