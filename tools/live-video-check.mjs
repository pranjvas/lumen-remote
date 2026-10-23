#!/usr/bin/env node
// Live video check without the real TV: the real Lumen server (mock TV) shows a local test page on a
// fake TV agent that accepts the live stream, and writes what arrives to an fMP4 file for inspection.
//   node tools/live-video-check.mjs [--secs 10] [--max-height 1080] [--out live.mp4] [--codecs avc1.64002A,...]
// Everything binds 127.0.0.1; Lumen's headless Edge is closed at the end.
import fs from 'node:fs';
import http from 'node:http';
import { startStack, waitFor } from '../test/helpers.js';
import { parseMessage, TV_CODEC_PROBES } from '../server/features/livevideo.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const SECS = Number(arg('secs', 10));
const MAX_HEIGHT = Number(arg('max-height', 1080));
const OUT = arg('out', 'live-check.mp4');
const CODECS = arg('codecs', TV_CODEC_PROBES.join(',')).split(',');

// A moving box, a clock and a 440 Hz tone: motion, readable text and sound.
export const TEST_PAGE = `<!DOCTYPE html><title>Live test</title><body style="margin:0;background:#123;color:#eee;font:28px sans-serif">
<div id=b style="position:absolute;top:300px;width:160px;height:160px;background:#fc0"></div><p id=t style="margin:20px"></p>
<p style="margin:20px;font-size:16px">${'The quick brown fox jumps over the lazy dog. '.repeat(40)}</p>
<script>let n=0;function f(){n++;b.style.left=((n*8)%1280)+'px';t.textContent='frame '+n+' · '+Date.now();requestAnimationFrame(f)}f();
const ac=new AudioContext();const o=ac.createOscillator();o.frequency.value=440;const g=ac.createGain();g.gain.value=0.2;o.connect(g).connect(ac.destination);o.start();</script>`;

async function main() {
  const web = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(TEST_PAGE); });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const stack = await startStack({ config: { browser: { allowLoopback: true, idleMs: 120000 }, liveVideo: { enabled: true, maxHeight: MAX_HEIGHT }, log: { level: 'info', console: true } } });
  const b = stack.browser();
  await b.hello;
  const agent = stack.agent({ version: '0.8.0' });
  await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
  const caps = Object.fromEntries(TV_CODEC_PROBES.map((c) => [c, CODECS.includes(c)]));
  // The fake agent answers the offer as live.js does, and reports 'playing' on the first fragment.
  let playing = false;
  const replies = setInterval(() => {
    const offer = agent.screen.find((m) => m.t === 'screen-live-offer' && !m.answered);
    if (offer) { offer.answered = true; agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'ready', caps })); }
  }, 50);
  try {
    const t0 = Date.now();
    const ack = await b.send('browser.openOnTv', { url: `http://127.0.0.1:${web.address().port}/` }, { timeout: 60000 });
    if (!ack.ok) throw new Error(JSON.stringify(ack.error));
    await waitFor(() => agent.frames.some((f) => f.toString('latin1', 0, 3) === 'LVI'), { timeout: 30000, what: 'the init segment' });
    console.log('first init after', Date.now() - t0, 'ms');
    const startAt = Date.now();
    const seen = agent.frames.length;
    let lastStats = 0;
    let decoded = 0;
    while (Date.now() - startAt < SECS * 1000) {
      await new Promise((r) => setTimeout(r, 500));
      if (!playing && agent.frames.slice(seen).some((f) => f.toString('latin1', 0, 3) === 'LVM')) { playing = true; agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'playing', w: 0, h: 0 })); }
      // A healthy TV's report every 2 s, as live.js sends it; without it the PC falls back to frames.
      if (playing && Date.now() - lastStats >= 2000) {
        lastStats = Date.now();
        decoded += 60;
        agent.ws.send(JSON.stringify({ t: 'screen-live', state: 'stats', lag: 0.4, buffered: 1, dropped: 0, decoded, stalls: 0, rate: 1 }));
      }
    }
    const msgs = agent.frames.map((f) => parseMessage(f) ?? { kind: 'jpeg', data: f });
    const inits = msgs.filter((m) => m.kind === 'init');
    const media = msgs.filter((m) => m.kind === 'media');
    const lastInit = inits.at(-1);
    const fromLast = media.filter((m) => m.gen === lastInit.gen);
    const firstKey = fromLast.findIndex((m) => m.key);
    fs.writeFileSync(OUT, Buffer.concat([lastInit.data, ...fromLast.slice(firstKey).map((m) => m.data)]));
    const bytes = fromLast.reduce((s, m) => s + m.data.length, 0);
    console.log(JSON.stringify({
      inits: inits.map((i) => i.info), mediaMessages: fromLast.length, keyMessages: fromLast.filter((m) => m.key).length,
      jpegs: msgs.filter((m) => m.kind === 'jpeg').length, kbps: Math.round((bytes * 8) / SECS / 1000), out: OUT,
      live: stack.server.store.get('tvscreen.live')?.v,
    }, null, 1));
  } finally {
    clearInterval(replies);
    await stack.stop();
    web.close();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
