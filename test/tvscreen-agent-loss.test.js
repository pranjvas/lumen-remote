// The TV agent going away while Lumen's browser is on the TV: the TV closes its page (memory), the PC
// link drops, the owner switches to another app, or this server restarts while the TV still shows
// the screen. Lumen opens the agent again once (at most twice in ten minutes) and puts the screen
// back (screen mode, live video offer, pointer, the latest frame); a page behind another app is not
// brought back; an agent that does not come back closes the screen, so Lumen's browser can idle; an
// agent that kept its screen through a link blip carries on; a TV left showing the screen by an
// earlier run of this server turns it off at its first key. Mock TV, fake agents, a scripted
// browser page and live video stand-in (no Edge).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor, AGENT_SNAPSHOT } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AGENT_APP = 'lumenrmt01.LumenAgent';

describe('tvscreen: the TV agent going away and coming back', () => {
  let stack, b, agent, sink, real;
  const page = { url: null, playing: false, pauses: 0, lastInput: 0, videos: [] };
  const live = []; // calls the live video stand-in got: ['attach', lower] | ['pause'] | ['resume'] | ['detach']

  const tvOn = () => stack.server.store.get('tvscreen.on')?.v === true;
  const tvVideo = () => stack.server.store.get('tvscreen.video')?.v ?? null;
  const agentLaunches = () => stack.mock.state.launches.filter((l) => l.appId === AGENT_APP).length;
  const ok = (ack) => { assert.equal(ack.ok, true, JSON.stringify(ack.error)); return ack.value; };
  const send = (a, msg) => a.ws.send(JSON.stringify(msg));
  const screenOf = (a, t) => a.screen.filter((m) => m.t === t);
  const requestsOf = (a, on) => a.requests.filter((r) => r.type === 'screen' && r.on === on);
  const isJpeg = (f) => f[0] === 0xff && f[1] === 0xd8;
  const attaches = () => live.filter((c) => c[0] === 'attach');

  // An agent as 0.8.7 says hello: with what its screen shows.
  async function connect(screen, version = '0.8.7') {
    const a = stack.agent({ version, autoHello: false });
    await a.opened;
    send(a, { t: 'hello', agent: version, version, pcHost: '127.0.0.1', snapshot: AGENT_SNAPSHOT, ...(screen !== undefined && { screen }) });
    return a;
  }
  async function kill(a = agent) {
    a.close();
    await b.waitForState('conn.agent', (r) => r?.v !== 'online', { timeout: 10000 });
  }
  async function online() {
    await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
  }
  async function openScreen() {
    ok(await b.send('tvscreen.open', {}, { timeout: 15000 }));
    await waitFor(() => tvOn(), { timeout: 3000, message: 'the screen on' });
  }
  function setPage(url) {
    page.url = url;
    stack.server.store.set('browser.url', url, { src: 'derived', via: 'browser' });
    stack.server.store.set('browser.title', 'Page', { src: 'derived', via: 'browser' });
  }

  before(async () => {
    stack = await startStack({ config: { liveVideo: { enabled: true }, tvscreen: { relaunchWaitMs: 3000, autoPlayOnTv: false } } });
    b = stack.browser();
    await b.hello;
    real = stack.server.features.browser;
    const fake = Object.create(real);
    Object.assign(fake, {
      async ensureRunning() {},
      async open(url) { setPage(url); return { value: { url } }; },
      async nav() { return {}; },
      async input() { return {}; },
      addSink(fn) { sink = fn; return () => { if (sink === fn) sink = null; }; },
      media: () => [],
      frameSize: () => ({ w: 1280, h: 720 }),
      lastInputAt: () => page.lastInput,
      async evaluate(expression) {
        const src = String(expression);
        if (src.includes('v.pause()')) { page.pauses += 1; page.playing = false; return undefined; }
        if (src.includes('.play()')) return 0;
        if (src.includes('playerConfig')) return null;
        if (src.includes('iframe')) return { videos: page.videos, frames: [] };
        if (src.includes('innerWidth * innerHeight')) return page.playing ? ['v'] : [];
        return null;
      },
      async evaluateFrames() { return []; },
    });
    stack.server.features.browser = fake;
    stack.server.features.livevideo = {
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
    setPage('https://example.com/start');
  });
  after(async () => {
    if (stack) stack.server.features.browser = real;
    await stack?.stop();
  });

  test('a TV left showing the screen (this server restarted) turns it off at its first key, and on its hello', async () => {
    agent = await connect({ active: true, video: null });
    await online();
    await waitFor(() => requestsOf(agent, false).length === 1, { timeout: 3000, message: 'screen off for a hello with the screen up' });
    assert.equal(tvOn(), false);
    agent.sendScreenInput({ key: 'back' });
    await waitFor(() => requestsOf(agent, false).length === 2, { timeout: 3000, message: 'screen off at the first key' });
    agent.sendScreenInput({ key: 'red' });
    await sleep(300);
    assert.equal(requestsOf(agent, false).length, 2, 'at most once every 3 s');
    // The agent's own 'stopped' after the screen went off is not a stray message.
    await sleep(3000);
    send(agent, { t: 'screen-video', state: 'stopped' });
    await sleep(300);
    assert.equal(requestsOf(agent, false).length, 2);
  });

  test('a link blip with the TV\'s player in front: the agent carries on, nothing is reopened, live video gets no strike', async () => {
    await openScreen();
    send(agent, { t: 'screen-live', state: 'ready', caps: { 'avc1.640028': true } });
    await waitFor(() => attaches().length === 1, { timeout: 3000, message: 'live video attached' });
    assert.equal(attaches()[0][1], 0);
    // Video → TV: live video pauses for the TV's player.
    page.videos = [{ src: 'https://example.com/v.mp4', area: 1280 * 600, playing: true }];
    const plays = screenOf(agent, 'screen-play').length;
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    const play = await waitFor(() => screenOf(agent, 'screen-play')[plays], { timeout: 3000, message: 'the screen-play' });
    assert.ok(live.some((c) => c[0] === 'pause'));
    send(agent, { t: 'screen-video', state: 'playing', id: play.id });
    await waitFor(() => tvVideo() === 'playing', { timeout: 3000, message: 'the player playing' });

    const launches = agentLaunches();
    const old = agent;
    await kill();
    agent = await connect({ active: true, video: { state: 'playing', mode: 'avplay', position: 64000, id: play.id } });
    await online();
    await sleep(2000); // past the relaunch delay: nothing to relaunch
    assert.equal(agentLaunches(), launches, 'the agent was not launched again');
    assert.equal(requestsOf(agent, true).length, 0, 'its screen was not turned on again');
    assert.equal(tvVideo(), 'playing', 'the player is still in front');
    assert.ok(tvOn());
    // Its reports go on counting, and when it stops live video is offered again: no strike.
    send(agent, { t: 'screen-video', state: 'stopped', id: play.id });
    await waitFor(() => tvVideo() === 'stopped', { timeout: 3000, message: 'the player stopped' });
    send(agent, { t: 'screen-live', state: 'ready', caps: { 'avc1.640028': true } });
    await waitFor(() => attaches().length === 2, { timeout: 3000, message: 'live video again' });
    assert.equal(attaches()[1][1], 0, 'no step lower: the drop was not live video\'s fault');
    assert.notEqual(old, agent);
  });

  test('a drop during live video counts against it; after two, live video is blocked (and tvscreen.liveBlocked says so) until turned on again', async () => {
    // First drop during live video: back within the relaunch delay (a fresh page: screen re-opened).
    await kill();
    agent = await connect({ active: false, video: null });
    await online();
    await waitFor(() => requestsOf(agent, true).length === 1, { timeout: 5000, message: 'screen on again' });
    await waitFor(() => screenOf(agent, 'screen-live-offer').length === 1, { timeout: 3000, message: 'live offered again' });
    send(agent, { t: 'screen-live', state: 'ready', caps: { 'avc1.640028': true } });
    await waitFor(() => attaches().length === 3, { timeout: 3000, message: 'live video again' });
    assert.equal(attaches()[2][1], 1, 'one step lower');
    // Second drop during live video.
    await kill();
    agent = await connect({ active: false, video: null });
    await online();
    await waitFor(() => requestsOf(agent, true).length === 1, { timeout: 5000, message: 'screen on again' });
    await sleep(500);
    assert.equal(screenOf(agent, 'screen-live-offer').length, 0, 'no live offer after two drops');
    const blocked = await b.waitForState('tvscreen.liveBlocked', (r) => r?.v?.strikes === 2, { timeout: 3000 });
    assert.ok(blocked.v.untilMs > Date.now());
    ok(await b.send('tvscreen.live', { on: true }));
    await b.waitForState('tvscreen.liveBlocked', (r) => r?.v == null, { timeout: 3000 });
    await waitFor(() => screenOf(agent, 'screen-live-offer').length === 1, { timeout: 3000, message: 'offered again' });
  });

  test('an agent before 0.8.7 (its hello says nothing about the screen) is put back in screen mode when it reconnects', async () => {
    await kill();
    agent = await connect(undefined, '0.8.6');
    await online();
    await waitFor(() => requestsOf(agent, true).length === 1, { timeout: 5000, message: 'screen on again' });
    await waitFor(() => screenOf(agent, 'screen-cursor').length > 0, { timeout: 3000, message: 'the pointer' });
    assert.ok(tvOn());
  });

  test('an agent that reconnects without saying hello yet is not taken for one showing the screen: Video → TV turns the screen on first', async () => {
    const replacement = stack.agent({ version: '0.8.7', autoHello: false });
    await replacement.opened;
    await waitFor(() => agent.ws.readyState === 3, { timeout: 3000, message: 'the old connection replaced' });
    agent = replacement;
    const order = [];
    agent.ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(String(data));
      if (msg.t === 'req' && msg.type === 'screen') order.push(`screen ${msg.on}`);
      if (msg.t === 'screen-play') order.push('play');
    });
    page.videos = [{ src: 'https://example.com/v2.mp4', area: 1280 * 600, playing: true }];
    ok(await b.send('tvscreen.playVideo', {}, { timeout: 15000 }));
    await waitFor(() => order.includes('play'), { timeout: 3000, message: 'the screen-play' });
    assert.deepEqual(order.slice(0, 2), ['screen true', 'play']);
    send(agent, { t: 'screen-video', state: 'stopped' });
    send(agent, { t: 'hello', agent: '0.8.7', version: '0.8.7', pcHost: '127.0.0.1', snapshot: AGENT_SNAPSHOT, screen: { active: true, video: null } });
    await sleep(300);
  });

  test('the TV closes the agent: Lumen opens it again, and the new page gets the screen, live video, the pointer and the latest frame', async () => {
    assert.ok(tvOn());
    assert.ok(sink, 'the frame sink is installed');
    sink(Buffer.from([0xff, 0xd8, 0x42]));
    const launches = agentLaunches();
    const t0 = Date.now();
    await kill();
    await waitFor(() => agentLaunches() > launches, { timeout: 4000, message: 'the agent launched again' });
    assert.ok(Date.now() - t0 < 3500, `relaunched after ${Date.now() - t0} ms`);
    // The relaunched page (a fresh one: no screen).
    agent = await connect({ active: false, video: null });
    await online();
    await waitFor(() => requestsOf(agent, true).length === 1, { timeout: 5000, message: 'screen on for the new page' });
    await waitFor(() => screenOf(agent, 'screen-live-offer').length === 1, { timeout: 3000, message: 'live video offered' });
    await waitFor(() => screenOf(agent, 'screen-cursor').length > 0, { timeout: 3000, message: 'the pointer' });
    await waitFor(() => agent.frames.some((f) => isJpeg(f) && f[2] === 0x42), { timeout: 3000, message: 'the latest frame' });
    assert.ok(screenOf(agent, 'screen-toast').some((m) => /back/.test(m.text)));
    assert.ok(tvOn());
  });

  test('the agent closes behind another app: the screen closes, and nothing is launched over that app', async () => {
    send(agent, { t: 'screen-live', state: 'hidden' });
    await sleep(200);
    const launches = agentLaunches();
    await kill();
    await waitFor(() => !tvOn(), { timeout: 3000, message: 'the screen closed' });
    await sleep(2500);
    assert.equal(agentLaunches(), launches, 'no launch over the app in front');
    agent = await connect({ active: false, video: null });
    await online();
    await sleep(500);
    assert.equal(requestsOf(agent, true).length, 0, 'the screen stays closed');
  });

  test('an agent that does not come back closes the screen after the wait; a third drop in ten minutes closes it at once', async () => {
    await openScreen();
    const launches = agentLaunches();
    await kill();
    await waitFor(() => agentLaunches() > launches, { timeout: 4000, message: 'the agent launched again' });
    // Nobody connects: after the wait (3 s here) the screen closes.
    await waitFor(() => !tvOn(), { timeout: 8000, message: 'the screen closed' });
    assert.equal(stack.server.store.get('tvscreen.video')?.v ?? null, null);

    agent = await connect({ active: false, video: null });
    await online();
    await openScreen();
    const before = agentLaunches();
    await kill();
    await waitFor(() => !tvOn(), { timeout: 3000, message: 'closed at once' });
    await sleep(2000);
    assert.equal(agentLaunches(), before, 'no third launch');
    agent = await connect({ active: false, video: null });
    await online();
  });
});
