// Converting for the TV (features/transcode.js): ffmpeg arguments (copy relabels H.264 only, the
// encode caps at 1080p30 and lets the encoder pick the level, HLS variants, start positions, the
// cookie kept on its site), the job life cycle (one job per key while it starts, HEVC retried as a
// plain copy, the reaper, folders from earlier runs), and — when ffmpeg is on this PC — real runs.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  cookieLines, createTranscoder, ffmpegArgs, findFfmpeg, findFfprobe, jobKey, planFromProbe,
} from '../server/features/transcode.js';
import { levelTooLow, readTsSps } from '../server/features/relay.js';
import { createTestLog } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const after_ = (args, flag) => args[args.indexOf(flag) + 1];

/** A spawn seam: each call runs `script({ args, child, outDir, n })`; the child exits when killed. */
function fakeFfmpeg(script) {
  const calls = [];
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    let gone = false;
    child.exit = (code, signal = null) => {
      if (gone) return;
      gone = true;
      child.stderr.end();
      child.emit('exit', code, signal);
    };
    child.kill = () => { setTimeout(() => child.exit(null, 'SIGKILL'), 5); return true; };
    const call = { args, child, outDir: path.dirname(args.at(-1)), n: calls.length };
    calls.push(call);
    script(call);
    return child;
  };
  return { spawn, calls };
}

function firstSegment(dir) {
  fs.writeFileSync(path.join(dir, 'seg_00000.ts'), 'x');
  fs.writeFileSync(path.join(dir, 'index.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg_00000.ts\n');
}

function tempData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tc-'));
}

describe('transcode arguments', () => {
  test('the copy relabels H.264 levels unless told not to (HEVC); the encode caps at 1080p30 and picks no level itself', () => {
    const copy = ffmpegArgs({ input: 'http://v.example/a.mp4', outDir: 'D', copyVideo: true, copyAudio: true });
    assert.equal(after_(copy, '-bsf:v'), 'h264_metadata=level=auto');
    assert.equal(copy.includes('-vf'), false);
    assert.equal(copy.includes('-fpsmax'), false);
    const plain = ffmpegArgs({ input: 'http://v.example/a.mp4', outDir: 'D', copyVideo: true, videoBsf: 'none' });
    assert.equal(plain.includes('-bsf:v'), false);
    assert.equal(after_(plain, '-c:v'), 'copy');
    assert.equal(after_(ffmpegArgs({ input: 'x', outDir: 'D', copyVideo: true, videoBsf: 'h264' }), '-bsf:v'), 'h264_metadata=level=auto');

    for (const encoder of ['libx264', 'h264_nvenc']) {
      const enc = ffmpegArgs({ input: 'http://v.example/a.mp4', outDir: 'D', encoder });
      const vf = after_(enc, '-vf');
      assert.match(vf, /min\(1920,iw\)/, encoder);
      assert.match(vf, /min\(1080,ih\)/, encoder);
      assert.match(vf, /force_original_aspect_ratio=decrease/, encoder);
      assert.equal(after_(enc, '-fpsmax'), '30', encoder);
      assert.ok(enc.indexOf('-vf') < enc.indexOf('-c:v'), encoder);
      assert.equal(enc.includes('4.1'), false, `${encoder}: no fixed level`);
      assert.equal(enc.includes('-level:v'), false, encoder);
      assert.equal(enc.includes('-bsf:v'), false, encoder);
    }
    // Builds before 4.3/4.4: an equivalent scale and no fps cap.
    const old = ffmpegArgs({ input: 'x', outDir: 'D', support: { scaleDivisible: false, fpsmax: false } });
    assert.match(after_(old, '-vf'), /^scale='if\(gt\(iw\/ih,16\/9\),min\(1920,iw\),-2\)':'if\(gt\(iw\/ih,16\/9\),-2,min\(1080,ih\)\)'$/);
    assert.equal(old.includes('-fpsmax'), false);
  });

  test('HLS variants by programme, start positions by input seeking, and live inputs on a sliding playlist', () => {
    const p1 = ffmpegArgs({ input: 'http://v.example/master.m3u8', outDir: 'D', program: 1 });
    assert.ok(p1.includes('0:p:1:v:0?'));
    assert.ok(p1.includes('0:p:1:a:0?'));
    const p0 = ffmpegArgs({ input: 'x', outDir: 'D', program: 0 });
    assert.ok(p0.includes('0:p:0:v:0?'));
    const none = ffmpegArgs({ input: 'x', outDir: 'D' });
    assert.ok(none.includes('0:v:0?') && none.includes('0:a:0?'));
    assert.ok(ffmpegArgs({ input: 'x', outDir: 'D', program: '1' }).includes('0:v:0?'), 'only a number names a programme');

    const at = ffmpegArgs({ input: 'http://v.example/a.mp4', outDir: 'D', startSec: 95.5 });
    assert.equal(after_(at, '-ss'), '95.5');
    assert.ok(at.indexOf('-ss') < at.indexOf('-i'), '-ss before -i (input seeking)');
    for (const startSec of [0, -3, undefined, Number.NaN]) assert.equal(ffmpegArgs({ input: 'x', outDir: 'D', startSec }).includes('-ss'), false, String(startSec));

    const vod = ffmpegArgs({ input: 'x', outDir: 'D' });
    assert.equal(after_(vod, '-hls_list_size'), '0');
    assert.equal(after_(vod, '-hls_playlist_type'), 'event');
    const live = ffmpegArgs({ input: 'x', outDir: 'D', live: true });
    assert.equal(after_(live, '-hls_list_size'), '900');
    assert.equal(after_(live, '-hls_flags'), 'delete_segments+independent_segments+temp_file');
    assert.equal(live.includes('-hls_playlist_type'), false);
  });

  test('the page\'s cookie goes to ffmpeg as -cookies scoped to the input\'s site (with its port), never as a header', () => {
    const args = ffmpegArgs({ input: 'http://127.0.0.1:8123/v/master.m3u8', headers: { cookie: 'sid=1; theme=dark', referer: 'https://site.example/' }, outDir: 'D' });
    assert.doesNotMatch(after_(args, '-headers'), /cookie/i);
    assert.equal(after_(args, '-cookies'), 'sid=1; path=/; domain=127.0.0.1:8123\ntheme=dark; path=/; domain=127.0.0.1:8123');
    assert.ok(args.indexOf('-cookies') < args.indexOf('-i'));
    assert.equal(cookieLines('a=1', 'https://cdn.media.example.com/x.m3u8'), 'a=1; path=/; domain=example.com');
    assert.equal(cookieLines('a=1', 'https://www.bbc.co.uk/x'), 'a=1; path=/; domain=bbc.co.uk');
    assert.equal(cookieLines('a=1', 'https://d111.cloudfront.net/x'), 'a=1; path=/; domain=d111.cloudfront.net');
    assert.equal(cookieLines('a=1', 'https://example.com:443/x'), 'a=1; path=/; domain=example.com:443', 'a port written out counts');
    assert.equal(cookieLines('a=1', 'http://[::1]:9/x'), 'a=1; path=/; domain=[::1]:9');
    assert.equal(cookieLines('a=1\r\nX: y; b=2', 'https://e.com/'), 'a=1X: y; path=/; domain=e.com\nb=2; path=/; domain=e.com', 'no line breaks reach ffmpeg');
    // Through the VPN proxy plain http requests carry an absolute URI, which ffmpeg matches paths against.
    assert.equal(cookieLines('a=1', 'http://e.com/x', { proxied: true }), 'a=1; path=/; domain=e.com\na=1; path=http://; domain=e.com');
    assert.match(after_(ffmpegArgs({ input: 'http://e.com/x', headers: { cookie: 'a=1' }, proxyUrl: 'http://127.0.0.1:1', outDir: 'D' }), '-cookies'), /path=http:\/\//);
    assert.equal(cookieLines('', 'https://e.com/'), '');
    assert.equal(cookieLines('a=1', 'not a url'), '');
    assert.equal(ffmpegArgs({ input: 'https://e.com/a.mp4', outDir: 'D' }).includes('-cookies'), false);
  });

  test('job keys: mode, start and programme each make another job; existing() still matches by input', () => {
    const input = 'https://v.example/a.m3u8';
    assert.notEqual(jobKey(input, { copy: true, startSec: 0 }), jobKey(input, { copy: true, startSec: 600 }));
    assert.notEqual(jobKey(input, { copy: true, program: 1 }), jobKey(input, { copy: true }));
    assert.notEqual(jobKey(input, { copy: true }), jobKey(input, { copy: false }));
    assert.equal(jobKey(input, {}), jobKey(input, { startSec: 0, program: null }));
    for (const key of [jobKey(input, { copy: true, startSec: 12.5, program: 2 }), jobKey(input)]) assert.ok(key.endsWith(`|${input}`), key);
    assert.ok(jobKey(input, { copy: true }).startsWith('copy|'));
  });

  test('planFromProbe: 8-bit H.264 copied and relabelled, HEVC copied as it is, everything else encoded; audio by codec', () => {
    const s = (codec_type, codec_name, extra = {}) => ({ codec_type, codec_name, ...extra });
    assert.deepEqual(planFromProbe({ streams: [s('video', 'h264', { profile: 'High', pix_fmt: 'yuv420p' }), s('audio', 'aac')] }), { copyVideo: true, videoBsf: 'h264', copyAudio: true });
    assert.deepEqual(planFromProbe({ streams: [s('video', 'hevc', { profile: 'Main 10', pix_fmt: 'yuv420p10le' }), s('audio', 'eac3')] }), { copyVideo: true, videoBsf: 'none', copyAudio: true });
    assert.deepEqual(planFromProbe({ streams: [s('video', 'h264', { profile: 'High 10', pix_fmt: 'yuv420p10le' }), s('audio', 'flac')] }), { copyVideo: false, videoBsf: 'none', copyAudio: false });
    assert.equal(planFromProbe({ streams: [s('video', 'h264', { profile: 'High 4:4:4 Predictive', pix_fmt: 'yuv444p' })] }).copyVideo, false);
    for (const codec of ['vp9', 'av1', 'mpeg2video', 'mpeg4']) assert.equal(planFromProbe({ streams: [s('video', codec)] }).copyVideo, false, codec);
    for (const codec of ['aac', 'ac3', 'eac3', 'mp3', 'mp2']) assert.equal(planFromProbe({ streams: [s('audio', codec)] }).copyAudio, true, codec);
    for (const codec of ['opus', 'flac', 'dts', 'truehd', 'vorbis']) assert.equal(planFromProbe({ streams: [s('audio', codec)] }).copyAudio, false, codec);
    // Cover art is not the video; a programme's own streams decide for an HLS variant.
    assert.equal(planFromProbe({ streams: [s('video', 'mjpeg'), s('video', 'h264', { pix_fmt: 'yuv420p' })] }).videoBsf, 'h264');
    const hls = { programs: [{ program_id: 0, streams: [s('video', 'h264', { pix_fmt: 'yuv420p' })] }, { program_id: 1, streams: [s('video', 'hevc')] }], streams: [] };
    assert.equal(planFromProbe(hls, { program: 1 }).videoBsf, 'none');
    assert.equal(planFromProbe(hls, { program: 0 }).videoBsf, 'h264');
    assert.equal(planFromProbe({ streams: [] }), null);
    assert.equal(planFromProbe(null), null);
  });
});

describe('transcode jobs', () => {
  let data;
  const log = createTestLog();
  const make = (spawn, seams = {}, dataDir = data) => createTranscoder({ config: { dataDir }, log, seams: { ffmpeg: 'fake-ffmpeg', spawn, ...seams } });
  before(() => { data = tempData(); });
  after(() => { fs.rmSync(data, { recursive: true, force: true }); });

  test('a second request for a job still starting waits for its first segment instead of getting a 404', async () => {
    const fake = fakeFfmpeg(({ outDir }) => { setTimeout(() => firstSegment(outDir), 700); });
    const tc = make(fake.spawn);
    try {
      const order = [];
      const a = tc.convert('https://v.example/a.m3u8', { copy: true }).then((r) => { order.push('a'); return r; });
      await sleep(100);
      const b = tc.convert('https://v.example/a.m3u8', { copy: true }).then((r) => { order.push('b'); return r; });
      const [ra, rb] = await Promise.all([a, b]);
      assert.deepEqual(order, ['a', 'b']);
      assert.equal(ra.id, rb.id);
      assert.equal(rb.reused, true);
      assert.notEqual(tc.file(rb.id, 'index.m3u8'), null);
      assert.equal(fake.calls.length, 1, 'one ffmpeg');
      // A finished start is reused at once; another start position is another job.
      assert.equal((await tc.convert('https://v.example/a.m3u8', { copy: true })).id, ra.id);
      const later = await tc.convert('https://v.example/a.m3u8', { copy: true, startSec: 600 });
      assert.notEqual(later.id, ra.id);
      assert.ok(fake.calls[1].args.includes('-ss'));
    } finally {
      await tc.stop();
    }
  });

  test('a waiting request shares the starting conversion\'s failure', async () => {
    const fake = fakeFfmpeg(({ child }) => { setTimeout(() => { child.stderr.write('Server returned 403 Forbidden\n'); child.exit(1); }, 300); });
    const tc = make(fake.spawn);
    try {
      const a = tc.convert('https://v.example/b.mp4', { copy: false });
      await sleep(50);
      const b = tc.convert('https://v.example/b.mp4', { copy: false });
      await assert.rejects(a, /403/);
      await assert.rejects(b, /403/);
      assert.equal(fake.calls.length, 1);
      assert.equal(tc.existing('https://v.example/b.mp4'), null);
    } finally {
      await tc.stop();
    }
  });

  test('HEVC refused by the H.264 relabel is copied again as it is; VP9 is not retried', async () => {
    const refuse = (codec, id) => `[h264_metadata @ 0000] Codec '${codec}' (${id}) is not supported by the bitstream filter 'h264_metadata'. Supported codecs are: h264 (27)\nError initializing bitstream filter: h264_metadata\n`;
    const hevc = fakeFfmpeg(({ args, child, outDir }) => {
      if (args.includes('-bsf:v')) setTimeout(() => { child.stderr.write(refuse('hevc', 173)); child.exit(1); }, 50);
      else setTimeout(() => firstSegment(outDir), 100);
    });
    const tc = make(hevc.spawn);
    try {
      const a = tc.convert('https://v.example/hevc.mp4', { copy: true });
      await sleep(200); // past the first attempt: the retry is still the same start
      const b = tc.convert('https://v.example/hevc.mp4', { copy: true });
      const [ra, rb] = await Promise.all([a, b]);
      assert.equal(ra.id, rb.id);
      assert.equal(hevc.calls.length, 2);
      assert.ok(hevc.calls[0].args.includes('-bsf:v'));
      assert.equal(hevc.calls[1].args.includes('-bsf:v'), false);
      assert.equal(after_(hevc.calls[1].args, '-c:v'), 'copy');
      assert.equal(tc.existing('https://v.example/hevc.mp4').copy, true);
    } finally {
      await tc.stop();
    }

    const vp9 = fakeFfmpeg(({ child }) => { setTimeout(() => { child.stderr.write(refuse('vp9', 167)); child.exit(1); }, 50); });
    const tc2 = make(vp9.spawn);
    try {
      await assert.rejects(tc2.convert('https://v.example/vp9.webm', { copy: true }), /could not be converted/);
      assert.equal(vp9.calls.length, 1, 'a TS copy of VP9 never plays: no retry');
    } finally {
      await tc2.stop();
    }
    // An encode never retries as a copy.
    const enc = fakeFfmpeg(({ child }) => { setTimeout(() => { child.stderr.write(refuse('hevc', 173)); child.exit(1); }, 50); });
    const tc3 = make(enc.spawn);
    try {
      await assert.rejects(tc3.convert('https://v.example/x.mp4', { copy: false }));
      assert.equal(enc.calls.length, 1);
    } finally {
      await tc3.stop();
    }
  });

  test('the reaper stops idle jobs nobody holds, never held ones or ones still starting; a released job gets the whole idle time', async () => {
    const fake = fakeFfmpeg(({ outDir, n }) => { setTimeout(() => firstSegment(outDir), n === 2 ? 600 : 20); });
    const tc = make(fake.spawn, { unusedMs: 150 });
    try {
      const idle = await tc.convert('https://v.example/idle.m3u8', { copy: true });
      const playing = await tc.convert('https://v.example/playing.m3u8', { copy: true });
      assert.equal(tc.hold(playing.id, true), true);
      assert.equal(tc.hold('0000000000000000', true), false);
      await sleep(250);
      tc.reap();
      assert.equal(tc.file(idle.id, 'index.m3u8'), null, 'the idle job is gone');
      for (let i = 0; i < 60 && fs.existsSync(idle.dir); i++) await sleep(50);
      assert.equal(fs.existsSync(idle.dir), false, 'its folder too, once its ffmpeg has exited');
      assert.notEqual(tc.file(playing.id, 'index.m3u8'), null, 'the held job stays');
      // A job still waiting for its first segment is never the reaper's.
      const slow = tc.convert('https://v.example/slow.m3u8', { copy: true });
      for (let i = 0; i < 4; i++) { await sleep(170); tc.reap(); }
      assert.ok((await slow).id);
      // Released: the full idle time again, then reaped.
      tc.hold(playing.id, false);
      tc.reap();
      assert.notEqual(tc.file(playing.id, 'index.m3u8'), null);
      await sleep(250);
      tc.reap();
      assert.equal(tc.existing('https://v.example/playing.m3u8'), null);
    } finally {
      await tc.stop();
    }
  });

  test('start() removes job folders earlier runs left (16 hex digits only); stop() waits for ffmpeg and removes this run\'s', async () => {
    const root = path.join(data, 'transcode');
    // Upper case is another name (NTFS folds case, so it must not alias a lower-case one here).
    for (const name of ['0123456789abcdef', 'fedcba9876543210', 'keep-me', '0123', 'ABCDEF0123456789']) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, 'seg_00000.ts'), 'x');
    }
    const fake = fakeFfmpeg(({ outDir }) => { setTimeout(() => firstSegment(outDir), 20); });
    const tc = make(fake.spawn);
    tc.start();
    try {
      assert.equal(fs.existsSync(path.join(root, '0123456789abcdef')), false);
      assert.equal(fs.existsSync(path.join(root, 'fedcba9876543210')), false);
      for (const name of ['keep-me', '0123', 'ABCDEF0123456789']) assert.equal(fs.existsSync(path.join(root, name)), true, name);
      const job = await tc.convert('https://v.example/c.m3u8', { copy: true });
      tc.start(); // a second start keeps this run's own job
      assert.equal(fs.existsSync(job.dir), true);
      let exitedBeforeRemoval = false;
      fake.calls[0].child.once('exit', () => { exitedBeforeRemoval = fs.existsSync(job.dir); });
      await tc.stop();
      assert.equal(exitedBeforeRemoval, true, 'ffmpeg had exited before its folder went');
      assert.equal(fs.existsSync(job.dir), false, 'removed by the time stop() resolves');
      assert.equal(tc.existing('https://v.example/c.m3u8'), null);
    } finally {
      await tc.stop();
    }
  });

  test('clearSaved keeps the job the TV plays and counts this run\'s jobs and old folders', async () => {
    const own = tempData();
    const root = path.join(own, 'transcode');
    fs.mkdirSync(path.join(root, 'aaaaaaaaaaaaaaaa'), { recursive: true });
    const fake = fakeFfmpeg(({ outDir }) => { setTimeout(() => firstSegment(outDir), 20); });
    const tc = make(fake.spawn, {}, own);
    try {
      const keep = await tc.convert('https://v.example/k.m3u8', { copy: true });
      const drop = await tc.convert('https://v.example/d.m3u8', { copy: true });
      assert.equal(tc.clearSaved({ keep: [keep.id] }), 2);
      assert.notEqual(tc.file(keep.id, 'index.m3u8'), null);
      assert.equal(tc.file(drop.id, 'index.m3u8'), null);
      assert.equal(fs.existsSync(path.join(root, 'aaaaaaaaaaaaaaaa')), false);
    } finally {
      await tc.stop();
      fs.rmSync(own, { recursive: true, force: true });
    }
  });
});

// ---------- real ffmpeg (skipped when this PC has none) ----------

const FFMPEG = findFfmpeg({ config: {} });
const FFPROBE = findFfprobe(FFMPEG);

function ffmpegSync(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || '').slice(-300)}`);
}

/** A file server over `dir` (Range-aware) on `host`; `delayMs` holds every answer; `seen` lists requests. */
async function fileServer(dir, { host = '127.0.0.1', delayMs = 0, rewrite = (name, body) => body } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    seen.push({ name, headers: req.headers });
    setTimeout(() => {
      const file = path.join(dir, name);
      if (!name || name.includes('..') || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      const body = rewrite(name, fs.readFileSync(file));
      const type = name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      if (m) {
        const a = Number(m[1]);
        const b = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
        res.writeHead(206, { 'content-type': type, 'content-length': b - a + 1, 'content-range': `bytes ${a}-${b}/${body.length}`, 'accept-ranges': 'bytes' });
        res.end(body.subarray(a, b + 1));
        return;
      }
      res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'accept-ranges': 'bytes' });
      res.end(body);
    }, delayMs);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  return { url: (name) => `http://${host}:${server.address().port}/${name}`, port: server.address().port, seen, close: () => { server.closeAllConnections?.(); server.close(); } };
}

/** The PMT stream types of a TS file's first programme. */
function tsStreamTypes(buf) {
  let pmt = -1;
  for (let i = 0; i + 188 <= buf.length; i += 188) {
    const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
    const afc = (buf[i + 3] >> 4) & 3;
    let p = i + 4;
    if (afc & 2) p += 1 + buf[p];
    const pay = buf.subarray(p, i + 188);
    const s = 1 + pay[0];
    if (pid === 0 && pmt < 0) pmt = ((pay[s + 10] & 0x1f) << 8) | pay[s + 11];
    else if (pid === pmt) {
      const end = s + 3 + (((pay[s + 1] & 0x0f) << 8) | pay[s + 2]) - 4;
      const out = [];
      for (let q = s + 12 + (((pay[s + 10] & 0x0f) << 8) | pay[s + 11]); q + 5 <= end; q += 5 + (((pay[q + 3] & 0x0f) << 8) | pay[q + 4])) out.push(pay[q]);
      return out;
    }
  }
  return [];
}

describe('transcode with ffmpeg', { skip: FFMPEG ? false : 'no ffmpeg on this PC' }, () => {
  let clips;
  let data;
  const log = createTestLog();
  const transcoder = () => createTranscoder({ config: { dataDir: data }, log });
  before(() => {
    clips = tempData();
    data = tempData();
    const src = (size, rate, seconds) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(seconds)];
    ffmpegSync([...src('3840x2160', 60, 1), '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', path.join(clips, 'uhd60.ts')]);
    ffmpegSync([...src('640x360', 25, 2), '-c:v', 'libx264', '-preset', 'ultrafast', '-level:v', '3.0', '-c:a', 'aac', path.join(clips, 'small.ts')]);
    ffmpegSync([...src('320x180', 25, 2), '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', path.join(clips, 'v0.ts')]);
    ffmpegSync([...src('640x360', 25, 2), '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', path.join(clips, 'v1.ts')]);
    const media = (seg) => `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.0,\n${seg}\n#EXT-X-ENDLIST\n`;
    fs.writeFileSync(path.join(clips, 'v0.m3u8'), media('v0.ts'));
    fs.writeFileSync(path.join(clips, 'v1.m3u8'), media('v1.ts'));
    fs.writeFileSync(path.join(clips, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180,CODECS="avc1.42c00d,mp4a.40.2"\nv0.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"\nv1.m3u8\n');
    try {
      ffmpegSync([...src('640x360', 25, 2), '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-c:a', 'aac', path.join(clips, 'hevc.ts')]);
    } catch { /* a build without libx265: that test skips */ }
  });
  after(() => {
    fs.rmSync(clips, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  test('a 4K60 encode comes out at most 1080p with a level that fits it', { timeout: 90000 }, async () => {
    const server = await fileServer(clips);
    const tc = transcoder();
    try {
      const { id, dir } = await tc.convert(server.url('uhd60.ts'), { copy: false });
      assert.ok(tc.file(id, 'index.m3u8'));
      const sps = readTsSps(fs.readFileSync(path.join(dir, 'seg_00000.ts')).subarray(0, 65536));
      assert.ok(sps, 'an H.264 SPS in the first segment');
      assert.ok(sps.w <= 1920 && sps.h <= 1088, `${sps.w}x${sps.h}`);
      assert.equal(levelTooLow(sps.level, sps.w, sps.h), false, `level ${sps.level} for ${sps.w}x${sps.h}`);
      if (FFPROBE) {
        const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,width,height', '-of', 'json', path.join(dir, 'seg_00000.ts')], { encoding: 'utf8', windowsHide: true });
        const [st] = JSON.parse(r.stdout).streams;
        const [num, den] = st.r_frame_rate.split('/').map(Number);
        assert.ok(num / den <= 30.01, `frame rate ${st.r_frame_rate}`);
        assert.deepEqual([st.width, st.height], [1920, 1080]);
      }
    } finally {
      await tc.stop();
      server.close();
    }
  });

  test('two requests for one conversion against a slow source: the second waits, and the playlist exists for it', { timeout: 60000 }, async () => {
    const server = await fileServer(clips, { delayMs: 1200 });
    const tc = transcoder();
    try {
      const order = [];
      const a = tc.convert(server.url('small.ts'), { copy: true }).then((r) => { order.push('a'); return r; });
      await sleep(200);
      const b = tc.convert(server.url('small.ts'), { copy: true }).then((r) => { order.push('b'); return r; });
      const [ra, rb] = await Promise.all([a, b]);
      assert.deepEqual(order, ['a', 'b']);
      assert.equal(ra.id, rb.id);
      assert.notEqual(tc.file(rb.id, 'index.m3u8'), null);
      // The copy relabelled the 640x360 level 3.0 stream (it fits, so it stays a valid level).
      const sps = readTsSps(fs.readFileSync(path.join(ra.dir, 'seg_00000.ts')).subarray(0, 65536));
      assert.equal(levelTooLow(sps.level, sps.w, sps.h), false);
    } finally {
      await tc.stop();
      server.close();
    }
  });

  test('a master playlist converts the programme asked for (not the first-listed variant)', { timeout: 60000 }, async () => {
    const server = await fileServer(clips);
    const tc = transcoder();
    try {
      const first = await tc.convert(server.url('master.m3u8'), { copy: true });
      const chosen = await tc.convert(server.url('master.m3u8'), { copy: true, program: 1 });
      assert.notEqual(first.id, chosen.id);
      const width = (dir) => readTsSps(fs.readFileSync(path.join(dir, 'seg_00000.ts')).subarray(0, 65536))?.w;
      assert.equal(width(first.dir), 320);
      assert.equal(width(chosen.dir), 640);
      assert.equal(tsStreamTypes(fs.readFileSync(path.join(chosen.dir, 'seg_00000.ts'))).includes(0x0f), true, 'the variant\'s audio came too');
    } finally {
      await tc.stop();
      server.close();
    }
  });

  test('HEVC is copied into the TS as it is (not relabelled, not re-encoded)', { timeout: 60000 }, async (t) => {
    if (!fs.existsSync(path.join(clips, 'hevc.ts'))) { t.skip('no libx265 in this ffmpeg'); return; }
    fs.writeFileSync(path.join(clips, 'hevc.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nhevc.ts\n#EXT-X-ENDLIST\n');
    const server = await fileServer(clips);
    const tc = transcoder();
    try {
      // A file: ffprobe (when beside ffmpeg) plans a plain copy; HLS is not probed, so ffmpeg refuses
      // the relabel first and the copy is retried without it.
      for (const name of ['hevc.ts', 'hevc.m3u8']) {
        const { dir } = await tc.convert(server.url(name), { copy: true });
        assert.ok(tsStreamTypes(fs.readFileSync(path.join(dir, 'seg_00000.ts'))).includes(0x24), `${name}: an HEVC stream`);
      }
      assert.match(log.text(), /copying the HEVC video as it is/);
    } finally {
      await tc.stop();
      server.close();
    }
  });

  test('the page\'s cookie reaches the playlist\'s host only, not a segment host elsewhere', { timeout: 60000 }, async (t) => {
    let other;
    try {
      other = await fileServer(clips, { host: '127.0.0.2' });
    } catch {
      t.skip('127.0.0.2 is not usable here');
      return;
    }
    const main = await fileServer(clips, {
      rewrite: (name, body) => (name === 'cross.m3u8' ? Buffer.from(body.toString('utf8').replace('SEGMENT', other.url('v1.ts'))) : body),
    });
    fs.writeFileSync(path.join(clips, 'cross.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nSEGMENT\n#EXT-X-ENDLIST\n');
    // A plain-http forward proxy like the VPN's: the same rule must hold through it.
    const proxied = [];
    const proxy = http.createServer((req, res) => {
      proxied.push({ url: req.url, cookie: req.headers.cookie });
      const u = new URL(req.url);
      http.request({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }).end();
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const tc = transcoder();
    try {
      await tc.convert(main.url('cross.m3u8'), { copy: true, headers: { cookie: 'sid=secret', referer: 'https://site.example/' } });
      const list = main.seen.find((x) => x.name === 'cross.m3u8');
      assert.equal(list.headers.cookie, 'sid=secret');
      const seg = other.seen.find((x) => x.name === 'v1.ts');
      assert.ok(seg, 'the segment was fetched from the other host');
      assert.equal(seg.headers.cookie, undefined);
      assert.equal(seg.headers.referer, 'https://site.example/');

      await tc.convert(main.url('cross.m3u8'), { copy: false, headers: { cookie: 'sid=secret' }, proxyUrl: `http://127.0.0.1:${proxy.address().port}` });
      assert.equal(proxied.find((x) => x.url.endsWith('/cross.m3u8'))?.cookie, 'sid=secret', 'through the proxy, once');
      assert.equal(proxied.find((x) => x.url.endsWith('/v1.ts'))?.cookie, undefined);
    } finally {
      await tc.stop();
      main.close();
      other.close();
      proxy.closeAllConnections?.();
      proxy.close();
    }
  });
});
