#!/usr/bin/env node
// Live video end to end without the real TV: the real Lumen server (mock TV) streams its browser to
// the REAL agent page (companion/agent/index.html with agent.js, screen.js, live.js) running in a
// second headless Edge as a stand-in TV. Measures what the stand-in's MSE player shows: latency from
// the page's clock to the decoded picture (a 24-bit barcode of Date.now() drawn by the test page),
// presented frame rate, dropped frames, the stream's step and bitrate, plus the PC's CPU and GPU use.
//   node tools/live-video-standin.mjs [--secs 20] [--max-height 1080] [--codecs <tv codecs>] [--shot out.png]
// Everything binds 127.0.0.1; both Edges are closed at the end (taskkill /T).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startStack, waitFor } from '../test/helpers.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const SECS = Number(arg('secs', 20));
const MAX_HEIGHT = Number(arg('max-height', 1080));
const CODECS = arg('codecs', null);
const SHOT = arg('shot', null);
const THROTTLE = Number(arg('throttle', 1)); // CPU slow-down of the stand-in TV (DevTools CPU throttling), e.g. 6 for a weak TV SoC
const JPEG = process.argv.includes('--jpeg'); // baseline: live video off, the still frames only (CPU numbers)
const EDGE = process.env.LUMEN_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const AGENT_DIR = fileURLToPath(new URL('../companion/agent/', import.meta.url));
const med = (list) => { const s = [...list].sort((a, b) => a - b); return s.length ? Math.round(s[s.length >> 1]) : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The page shown in Lumen's browser: motion, text, a tone, and the clock as 24 black/white squares.
const TEST_PAGE = `<!DOCTYPE html><meta charset="utf-8"><title>Live test</title><body style="margin:0;background:#123;color:#eee;font:28px sans-serif">
<canvas id=bar width=960 height=40 style="position:absolute;left:0;top:0;width:960px;height:40px"></canvas>
<div id=b style="position:absolute;top:300px;width:160px;height:160px;background:#fc0"></div><p id=t style="margin:60px 20px 20px"></p>
<p style="margin:20px;font-size:16px">${'The quick brown fox jumps over the lazy dog. '.repeat(30)}</p>
<script>const x=bar.getContext('2d');let n=0;function f(){n++;const v=Date.now()%16777216;for(let i=0;i<24;i++){x.fillStyle=(v>>(23-i))&1?'#fff':'#000';x.fillRect(i*40,0,40,40);}
b.style.left=((n*8)%1280)+'px';t.textContent='frame '+n;requestAnimationFrame(f)}f();
const ac=new AudioContext();const o=ac.createOscillator();o.frequency.value=440;const g=ac.createGain();g.gain.value=0.2;o.connect(g).connect(ac.destination);o.start();</script>`;

// Runs in the stand-in TV page: samples the live <video> into a canvas and reads the barcode.
const PROBE = `(() => {
  const v = document.getElementById('live');
  if (!v || !v.videoWidth) return null;
  const c = window.__probeCanvas || (window.__probeCanvas = document.createElement('canvas'));
  c.width = v.videoWidth; c.height = v.videoHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, 0, 0);
  const s = v.videoWidth / 1280; // CSS px of the page → video px
  let val = 0;
  for (let i = 0; i < 24; i++) { const p = ctx.getImageData(Math.round((i * 40 + 20) * s), Math.round(20 * s), 1, 1).data; val = val * 2 + (p[0] > 127 ? 1 : 0); }
  const lat = ((Date.now() % 16777216) - val + 16777216) % 16777216;
  const q = v.getVideoPlaybackQuality();
  const end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
  const tl = window.__timeline;
  const present = tl ? Date.now() - (tl + v.currentTime * 1000) : null;
  const arrive = tl ? Date.now() - (tl + end * 1000) : null;
  return { lat, present, arrive, w: v.videoWidth, h: v.videoHeight, dropped: q.droppedVideoFrames, total: q.totalVideoFrames, lag: end - v.currentTime, muted: v.muted, audio: v.webkitAudioDecodedByteCount || 0, frames: window.__presented || 0, rate: v.playbackRate };
})()`;
const COUNT_FRAMES = `(() => { const v = document.getElementById('live'); window.__presented = 0;
  const tick = () => { window.__presented++; v.requestVideoFrameCallback(tick); }; v.requestVideoFrameCallback(tick); return true; })()`;

function cdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const pend = new Map();
    ws.onopen = () => resolve({ send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() });
    ws.onerror = reject;
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  });
}
const evaluate = async (c, expression) => (await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;

function cpuSeconds(pattern) {
  const ps = `(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" | Where-Object { $_.CommandLine -like '*${pattern}*' } | ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).TotalProcessorTime.TotalSeconds } | Measure-Object -Sum).Sum`;
  try { return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim()) || 0; } catch { return 0; }
}

async function main() {
  const stack = await startStack({ config: { browser: { allowLoopback: true, idleMs: 120000 }, liveVideo: { enabled: !JPEG, maxHeight: MAX_HEIGHT }, log: { level: 'info', console: true } } });
  const agentConfig = JSON.stringify({ pcHost: '127.0.0.1', pcPort: stack.lanPort, key: stack.server.agentKey, version: '0.8.1' });
  const web = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/test') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(TEST_PAGE); return; }
    if (url.pathname === '/agent/agent-config.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(agentConfig); return; }
    const file = path.join(AGENT_DIR, path.basename(url.pathname));
    if (url.pathname.startsWith('/agent/') && fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
      res.end(fs.readFileSync(file));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const port = 9600 + Math.floor(Math.random() * 300);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-standin-'));
  const tv = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--window-size=1920,1080', '--no-first-run',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    `http://127.0.0.1:${web.address().port}/agent/index.html`], { stdio: 'ignore' });
  let page = null;
  try {
    const b = stack.browser();
    await b.hello;
    await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 30000 });
    let target;
    await waitFor(async () => { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.url.includes('/agent/index.html')); return !!target; } catch { return false; } }, { timeout: 20000, what: 'the stand-in TV page' });
    page = await cdp(target.webSocketDebuggerUrl);
    if (THROTTLE > 1) await page.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    if (CODECS) await evaluate(page, `(() => { const real = MediaSource.isTypeSupported.bind(MediaSource); const allow = ${JSON.stringify(CODECS.split(','))};
      MediaSource.isTypeSupported = (t) => allow.some((c) => t.includes(c)) && real(t); return true; })()`);
    const t0 = Date.now();
    const ack = await b.send('browser.openOnTv', { url: `http://127.0.0.1:${web.address().port}/test` }, { timeout: 60000 });
    if (!ack.ok) throw new Error(JSON.stringify(ack.error));
    if (!JPEG) await waitFor(async () => (await evaluate(page, `document.getElementById('screen').classList.contains('live')`)) === true, { timeout: 40000, what: 'live video playing on the stand-in' });
    const startup = Date.now() - t0;
    if (!JPEG) await evaluate(page, COUNT_FRAMES);
    await sleep(2000);
    const lumenProfile = path.join(stack.dataDir, 'browser-profile');
    const cpu0 = cpuSeconds(lumenProfile), cpuTv0 = cpuSeconds(prof), node0 = process.cpuUsage();
    const smi = spawn('nvidia-smi', ['--query-gpu=utilization.gpu,utilization.encoder,utilization.decoder', '--format=csv,noheader,nounits', '-lms', '500'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let smiOut = ''; smi.stdout.on('data', (d) => { smiOut += d; });
    const first = JPEG ? null : await evaluate(page, PROBE);
    const samples = [];
    const states = [];
    const tStart = Date.now();
    while (Date.now() - tStart < SECS * 1000) {
      await sleep(THROTTLE > 1 ? 1000 : 250);
      const tl = stack.server.features.livevideo.timeline().baseWallMs;
      if (tl) await evaluate(page, `window.__timeline = ${tl}`);
      const s = JPEG ? null : await evaluate(page, PROBE);
      if (s) samples.push(s);
      states.push(stack.server.store.get('tvscreen.live')?.v);
    }
    const wall = (Date.now() - tStart) / 1000;
    const last = samples.at(-1);
    smi.kill();
    const cpu1 = cpuSeconds(lumenProfile), cpuTv1 = cpuSeconds(prof), node1 = process.cpuUsage(node0);
    if (SHOT) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    }
    if (JPEG) {
      console.log(JSON.stringify({ mode: 'jpeg frames only', cpu: { lumenEdgePctOfOneCore: Math.round(((cpu1 - cpu0) / wall) * 100), standinTvEdgePct: Math.round(((cpuTv1 - cpuTv0) / wall) * 100), lumenNodePct: Math.round(((node1.user + node1.system) / 1e6 / wall) * 100) } }));
      return;
    }
    const lats = samples.map((s) => s.lat).filter((l) => l < 10000).sort((a, b) => a - b);
    const rows = smiOut.trim().split(/\r?\n/).map((l) => l.split(',').map(Number)).filter((x) => x.length === 3 && !x.some(Number.isNaN));
    const avg = (i) => Math.round(rows.reduce((s, x) => s + x[i], 0) / Math.max(1, rows.length));
    console.log(JSON.stringify({
      throttle: THROTTLE, startupMs: startup, size: `${last.w}x${last.h}`, presentedFps: +((last.frames - first.frames) / wall).toFixed(1),
      droppedFrames: last.dropped - first.dropped, decodedFrames: last.total - first.total,
      latencyMs: { median: lats[lats.length >> 1], p95: lats[Math.floor(lats.length * 0.95)], min: lats[0], max: lats.at(-1) },
      captureToPresentMs: med(samples.map((s) => s.present).filter((x) => x !== null)),
      captureToArrivalMs: med(samples.map((s) => s.arrive).filter((x) => x !== null)),
      bufferLagMs: Math.round((samples.reduce((s, x) => s + x.lag, 0) / samples.length) * 1000),
      audioDecodedBytes: last.audio - first.audio, muted: last.muted,
      live: states.at(-1), steps: [...new Set(states.map((s) => s?.step))],
      cpu: { lumenEdgePctOfOneCore: Math.round(((cpu1 - cpu0) / wall) * 100), standinTvEdgePct: Math.round(((cpuTv1 - cpuTv0) / wall) * 100),
        lumenNodePct: Math.round(((node1.user + node1.system) / 1e6 / wall) * 100), cores: os.cpus().length },
      gpu: { util: avg(0), encoder: avg(1), decoder: avg(2) },
    }, null, 1));
  } finally {
    page?.close();
    try { execFileSync('taskkill', ['/PID', String(tv.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" | Where-Object { $_.CommandLine -like '*${prof}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' }); } catch { /* gone */ }
    await stack.stop();
    web.close();
    fs.rmSync(prof, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
