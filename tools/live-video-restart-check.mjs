#!/usr/bin/env node
// Live video robustness without the TV: while a fake agent receives the stream, the page navigates
// and then Lumen's Edge restarts (as the VPN switch does); the stream must come back by itself with
// a fresh init segment and a key frame each time.
//   node tools/live-video-restart-check.mjs
import http from 'node:http';
import { startStack, waitFor } from '../test/helpers.js';
import { parseMessage, TV_CODEC_PROBES } from '../server/features/livevideo.js';

const PAGE = (n) => `<title>Page ${n}</title><div id=b style="position:absolute;top:100px;width:100px;height:100px;background:#fc0"></div>`
  + '<script>let n=0;(function f(){n++;b.style.left=(n*4%1000)+"px";requestAnimationFrame(f)})();</script>';

async function main() {
  const web = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE(req.url)); });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${web.address().port}`;
  const stack = await startStack({ config: { browser: { allowLoopback: true, idleMs: 120000 }, liveVideo: { enabled: true, maxHeight: 1080 }, log: { level: 'info', console: true } } });
  const b = stack.browser();
  await b.hello;
  const agent = stack.agent({ version: '0.8.0' });
  await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
  const caps = Object.fromEntries(TV_CODEC_PROBES.map((c) => [c, c.startsWith('avc1')]));
  const answer = setInterval(() => {
    for (const m of agent.screen) if (m.t === 'screen-live-offer' && !m.answered) { m.answered = true; agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'ready', caps })); }
  }, 50);
  const live = () => agent.frames.filter((f) => f[0] === 0x4c).map(parseMessage);
  const mediaAfter = async (count, what) => waitFor(() => live().filter((m) => m.kind === 'media').length >= count, { timeout: 30000, what });
  try {
    const ack = await b.send('browser.openOnTv', { url: `${base}/one` }, { timeout: 60000 });
    if (!ack.ok) throw new Error(JSON.stringify(ack.error));
    await mediaAfter(60, 'the stream');
    const t0 = Date.now();
    const before = live().filter((m) => m.kind === 'media').length;
    await b.send('browser.open', { url: `${base}/two` }, { timeout: 30000 });
    await mediaAfter(before + 60, 'the stream after a navigation');
    console.log('navigation: stream continued', { inits: live().filter((m) => m.kind === 'init').length, ms: Date.now() - t0 });
    const inits = live().filter((m) => m.kind === 'init').length;
    const t1 = Date.now();
    const feature = stack.server.features.browser;
    await feature.close();
    await feature.open(`${base}/three`);
    await waitFor(() => live().filter((m) => m.kind === 'init').length > inits, { timeout: 40000, what: 'a new init after the restart' });
    const all = live();
    const lastInit = all.map((m) => m.kind).lastIndexOf('init');
    await waitFor(() => live().slice(lastInit).some((m) => m.kind === 'media'), { timeout: 20000, what: 'media after the restart' });
    const firstMedia = live().slice(lastInit).find((m) => m.kind === 'media');
    console.log('restart: stream back', { ms: Date.now() - t1, reset: all[lastInit].info.reset, startsWithKey: firstMedia.key, live: stack.server.store.get('tvscreen.live')?.v });
  } finally {
    clearInterval(answer);
    await stack.stop();
    web.close();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
