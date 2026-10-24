// Converts a video the TV cannot play into something it can: ffmpeg on this PC pulls the stream
// (through the VPN proxy when it is on, with the page's headers), and writes H.264 + AAC as an HLS
// playlist that the TV plays from Lumen while ffmpeg keeps going. Streams already in H.264/AAC are
// copied, not re-encoded, so a remux costs almost nothing.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { LumenError } from '../errors.js';
import { siteOf } from './relay.js';

const CANDIDATES = [
  'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
  path.join(os.homedir(), 'AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe'),
  path.join(os.homedir(), 'AppData/Local/Programs/Stremio/ffmpeg.exe'),
  'C:/Program Files/Jellyfin/Server/ffmpeg.exe',
];
const MAX_JOBS = 2;
const FIRST_SEGMENT_MS = 25000;
const JOB_IDLE_MS = 10 * 60 * 1000;
// A job nobody holds (hold(): the TV is playing it) goes after this long without use. Long enough
// for Back then Yellow to find it again through existing(). Not judged by file access alone: a
// paused AVPlay on a finished playlist fetches nothing.
const UNUSED_MS = 3 * 60 * 1000;
const REAP_EVERY_MS = 60 * 1000;
const EXIT_WAIT_MS = 1000;
const PROBE_MS = 8000;
const JOB_DIR = /^[0-9a-f]{16}$/;
const RM = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 };
// The copy relabels H.264 levels with h264_metadata, which refuses every other codec at once.
const HEVC_BSF_REFUSED = /Codec 'hevc' \(\d+\) is not supported by the bitstream filter 'h264_metadata'/;
const NETWORK_ERROR = /5XX|502|503|504|Connection|timed out|refused/i;
// The encode never sends the TV more than 1080p30 (4K encodes ran at about half real time, and a
// level picked for the source size). force_divisible_by needs FFmpeg 4.3; -fpsmax 4.4.
const SCALE = "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
const SCALE_LEGACY = "scale='if(gt(iw/ih,16/9),min(1920,iw),-2)':'if(gt(iw/ih,16/9),-2,min(1080,ih))'";
const COPY_AUDIO = /^(aac|ac3|eac3|mp3|mp2)$/;

/** The ffmpeg to use: config.ffmpeg.path, <dataDir>/bin/ffmpeg.exe, PATH, then known installs. */
export function findFfmpeg({ config } = {}) {
  const list = [
    config?.ffmpeg?.path,
    config?.dataDir && path.join(config.dataDir, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
  ].filter(Boolean);
  for (const p of list) if (fs.existsSync(p)) return p;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
  const onPath = which.status === 0 ? which.stdout.split(/\r?\n/).find(Boolean) : null;
  if (onPath) return onPath.trim();
  return CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

/** The ffprobe beside an ffmpeg, or null. */
export function findFfprobe(ffmpeg) {
  if (!ffmpeg) return null;
  const p = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  return fs.existsSync(p) ? p : null;
}

const versions = new Map(); // ffmpeg path → { scaleDivisible, fpsmax }
/** What an ffmpeg build supports for the encode's size and rate caps (unknown builds count as new). */
export function ffmpegSupport(ffmpeg) {
  if (versions.has(ffmpeg)) return versions.get(ffmpeg);
  let support = { scaleDivisible: true, fpsmax: true };
  try {
    const out = spawnSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).stdout ?? '';
    const m = /ffmpeg version n?(\d+)\.(\d+)/i.exec(out);
    if (m) {
      const v = Number(m[1]) * 100 + Number(m[2]);
      support = { scaleDivisible: v >= 403, fpsmax: v >= 404 };
    }
  } catch { /* keep the defaults */ }
  versions.set(ffmpeg, support);
  return support;
}

/**
 * The page's cookie as ffmpeg -cookies lines (`name=value; path=/; domain=<site>[:port]`), scoped to
 * the input's site by the relay's rules: ffmpeg then sends it only to hosts on that site, never to a
 * segment host or redirect target elsewhere (a Cookie header in -headers goes everywhere). ffmpeg's
 * domain match is a plain suffix test and includes the port the URL names.
 * proxied: plain http through the VPN proxy sends an absolute URI, which ffmpeg also matches the
 * cookie's path against (a prefix test), so each cookie gets a second line with path=http://.
 */
export function cookieLines(cookie, input, { proxied = false } = {}) {
  if (typeof cookie !== 'string' || !cookie) return '';
  let url;
  try { url = new URL(input); } catch { return ''; }
  const site = siteOf(url.hostname);
  if (!site) return '';
  // ffmpeg compares against host[:port] as the URL spells it, so a default port written out counts.
  const port = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(?:\[[^\]]*\]|[^:/?#]*):(\d+)/i.exec(input)?.[1];
  const domain = `${net.isIPv6(site) ? `[${site}]` : site}${port ? `:${port}` : ''}`;
  const paths = proxied ? ['/', 'http://'] : ['/'];
  return cookie.split(';').map((p) => p.replace(/[\r\n]+/g, '').trim()).filter((p) => /^[^=\s;]+=/.test(p))
    .flatMap((p) => paths.map((at) => `${p}; path=${at}; domain=${domain}`)).join('\n');
}

/** Input options shared by ffmpeg and ffprobe: page headers (never the cookie), cookies, VPN proxy. */
function inputOptions({ input, headers = {}, proxyUrl = null }) {
  const head = Object.entries({ 'User-Agent': headers.userAgent, Referer: headers.referer, Origin: headers.origin })
    .filter(([, v]) => typeof v === 'string' && v)
    .map(([k, v]) => `${k}: ${v.replace(/[\r\n]+/g, ' ')}\r\n`).join('');
  const cookies = cookieLines(headers.cookie, input, { proxied: Boolean(proxyUrl) });
  return [
    ...(head ? ['-headers', head] : []),
    ...(cookies ? ['-cookies', cookies] : []),
    ...(proxyUrl ? ['-http_proxy', proxyUrl] : []),
  ];
}

/**
 * ffmpeg arguments for one job (exported for tests).
 * - copyVideo / copyAudio: copy that stream instead of encoding it; videoBsf 'auto' or 'h264'
 *   relabels a copied H.264 stream's level, 'none' copies it untouched (HEVC);
 * - program: an HLS variant's index (relay parseHlsMaster) to take the streams from;
 * - startSec: start this far in (input seeking: by range or segment, a copy starts on the key frame before);
 * - live: a live input keeps a sliding 1-hour playlist instead of growing for ever;
 * - support: ffmpegSupport() of the build (older builds get an equivalent scale and no fps cap).
 */
export function ffmpegArgs({
  input, headers = {}, proxyUrl = null, outDir, copyVideo = false, copyAudio = false, encoder = 'libx264',
  videoBsf = 'auto', program = null, startSec = 0, live = false, support = { scaleDivisible: true, fpsmax: true },
}) {
  const from = Number.isInteger(program) && program >= 0 ? `0:p:${program}:` : '0:';
  const start = Number(startSec) > 0 ? ['-ss', String(Number(startSec))] : [];
  // A copied H.264 stream gets a level that fits its size: sites label 1080p as level 3.0, which
  // desktop decoders ignore but the TV's sizes itself by (sound, black picture).
  const video = copyVideo
    ? ['-c:v', 'copy', ...(videoBsf === 'none' ? [] : ['-bsf:v', 'h264_metadata=level=auto'])]
    : ['-vf', support.scaleDivisible ? SCALE : SCALE_LEGACY, ...(support.fpsmax ? ['-fpsmax', '30'] : []),
      '-c:v', encoder, ...(encoder === 'libx264' ? ['-preset', 'veryfast', '-crf', '21'] : ['-b:v', '8M']),
      // No -level: the encoder picks the one that fits the (capped) size and rate.
      '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '96', '-sc_threshold', '0'];
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    ...inputOptions({ input, headers, proxyUrl }),
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    ...start,
    '-i', input,
    '-map', `${from}v:0?`, '-map', `${from}a:0?`,
    ...video,
    ...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000']),
    '-f', 'hls', '-hls_time', '4',
    // VOD keeps every segment (seeking back); a live input keeps the last 900 (an hour).
    ...(live
      ? ['-hls_list_size', '900', '-hls_flags', 'delete_segments+independent_segments+temp_file']
      : ['-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file']),
    '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
    path.join(outDir, 'index.m3u8'),
  ];
}

/** ffprobe arguments: the codecs of every stream, and of every programme's streams (HLS variants). */
export function ffprobeArgs({ input, headers = {}, proxyUrl = null }) {
  const fields = 'index,codec_type,codec_name,profile,pix_fmt,bits_per_raw_sample';
  return [
    '-hide_banner', '-v', 'error', ...inputOptions({ input, headers, proxyUrl }),
    '-print_format', 'json', '-show_entries', `stream=${fields}:program=program_id:program_stream=${fields}`, '-i', input,
  ];
}

const eightBit = (s) => !/10|4:2:2|4:4:4|422|444/.test(String(s.profile ?? ''))
  && (!s.pix_fmt || /^yuvj?420p$/.test(s.pix_fmt)) && (!s.bits_per_raw_sample || String(s.bits_per_raw_sample) === '8');

/**
 * What a copy job copies, from ffprobe's JSON: 8-bit H.264 is copied and relabelled, HEVC copied as
 * it is, anything else (High 10, VP9, AV1, MPEG-2 …) encoded; AAC/AC-3/E-AC-3/MP3/MP2 audio copied,
 * anything else encoded to AAC. → { copyVideo, copyAudio, videoBsf }, or null without streams.
 */
export function planFromProbe(info, { program = null } = {}) {
  const prog = Number.isInteger(program) ? info?.programs?.find((p) => p.program_id === program) : null;
  const streams = (prog?.streams?.length ? prog.streams : info?.streams) ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !/^(mjpeg|png|bmp|gif)$/.test(s.codec_name ?? ''));
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v && !a) return null;
  let video = { copyVideo: true, videoBsf: 'none' };
  if (v?.codec_name === 'h264') video = eightBit(v) ? { copyVideo: true, videoBsf: 'h264' } : { copyVideo: false, videoBsf: 'none' };
  else if (v && v.codec_name !== 'hevc') video = { copyVideo: false, videoBsf: 'none' };
  return { ...video, copyAudio: !a || COPY_AUDIO.test(a.codec_name ?? '') };
}

/** The key two conversions share a job by: mode, start, programme and input. */
export function jobKey(input, { copy = false, startSec = 0, program = null } = {}) {
  const start = Number(startSec) > 0 ? Number(startSec) : 0;
  const prog = Number.isInteger(program) && program >= 0 ? program : '-';
  return `${copy ? 'copy' : 'encode'}|${start}|p${prog}|${input}`;
}

const isPlaylistUrl = (input) => /\.m3u8?(\?|$)/i.test(String(input));

// seams (tests): ffmpeg (a path, skipping the search), spawn(file, args) → a ChildProcess-like,
// unusedMs (the reaper's idle limit).
export function createTranscoder({ config, log: rootLog, seams = {} }) {
  const log = rootLog.child('transcode');
  const jobs = new Map(); // id → { dir, child, at, stderr, key, ready, exited, done }
  const held = new Set(); // ids the TV is playing: never reaped
  const starting = new Map(); // key → the conversion still waiting for its first segment (with its retry)
  const root = path.join(config.dataDir ?? os.tmpdir(), 'transcode');
  const unusedMs = seams.unusedMs ?? UNUSED_MS;
  const ffmpegPath = () => seams.ffmpeg ?? findFfmpeg({ config });
  const spawnFfmpeg = seams.spawn ?? ((file, args) => spawn(file, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }));
  let reaper = null;

  /** Resolves when the job's ffmpeg has exited, or after `ms`. */
  function exited(job, ms) {
    if (job.done || !job.child) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      job.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  function removeDir(dir, retry = true) {
    fs.rm(dir, RM, (err) => {
      if (!err) return;
      // Windows keeps a file busy for a moment after the process that had it open is gone.
      if (retry) { setTimeout(() => removeDir(dir, false), 500).unref?.(); return; }
      log.warn('a converted video could not be removed', { code: err.code });
    });
  }

  // Stops the job and removes its folder once its ffmpeg has let go of the files.
  function cleanup(id) {
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    held.delete(id);
    try { job.child?.kill('SIGKILL'); } catch { /* gone */ }
    exited(job, EXIT_WAIT_MS).then(() => removeDir(job.dir));
  }

  function prune() {
    const now = Date.now();
    for (const [id, job] of jobs) if (!held.has(id) && now - job.at > JOB_IDLE_MS) cleanup(id);
    while (jobs.size >= MAX_JOBS) cleanup([...jobs.keys()].find((id) => !held.has(id)) ?? jobs.keys().next().value);
  }

  /** The reaper: jobs nobody holds and nothing used for unusedMs (jobs still starting have their own deadline). */
  function reap() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (held.has(id) || !job.ready || now - job.at <= unusedMs) continue;
      log.info('stopping an unused conversion', { id });
      cleanup(id);
    }
  }

  /** Removes the job folders under <dataDir>/transcode that no job of this run owns. → the names removed. */
  function sweepOrphans(skip = new Set()) {
    const removed = [];
    let names = [];
    try { names = fs.readdirSync(root); } catch { return removed; /* nothing converted yet */ }
    for (const name of names) {
      if (jobs.has(name) || skip.has(name) || !JOB_DIR.test(name)) continue;
      try {
        fs.rmSync(path.join(root, name), RM);
        removed.push(name);
      } catch (err) {
        log.warn('a converted video could not be removed', { code: err.code });
      }
    }
    return removed;
  }

  /**
   * Starts converting `input` (a URL) for the TV; resolves once the first segment exists.
   * → { id, dir } — the relay serves <dir>/index.m3u8 and its segments.
   * options: { headers, proxyUrl, copy, program, startSec, live } (ffmpegArgs).
   */
  // Not called start(): Lumen calls start() on every feature at boot. Reuses a live job for the same
  // key, waits for one still starting, retries a refused HEVC relabel as a plain copy, and retries
  // once when the first connection fails (a VPN hiccup is common).
  async function convert(input, options = {}) {
    const key = jobKey(input, options);
    const pending = starting.get(key);
    if (pending) {
      const r = await pending;
      const job = jobs.get(r.id);
      if (!job || (job.exited !== undefined && job.exited !== 0)) throw new LumenError('FAILED', 'The video could not be converted for the TV (the conversion stopped)');
      job.at = Date.now();
      return { ...r, reused: true };
    }
    for (const [id, job] of jobs) {
      if (job.key === key && job.ready && (job.exited === undefined || job.exited === 0)) {
        job.at = Date.now();
        return { id, dir: job.dir, reused: true };
      }
    }
    const run = (async () => {
      try {
        return await convertOnce(input, options, key);
      } catch (err) {
        if (err.retryPlainCopy && options.copy) {
          log.info('copying the HEVC video as it is');
          return convertOnce(input, { ...options, videoBsf: 'none' }, key);
        }
        if (!NETWORK_ERROR.test(err.message)) throw err;
        log.info('retrying the conversion', { message: err.message.slice(0, 120) });
        await new Promise((r) => setTimeout(r, 1500));
        return convertOnce(input, options, key);
      }
    })();
    starting.set(key, run);
    try {
      return await run;
    } finally {
      if (starting.get(key) === run) starting.delete(key);
    }
  }

  /** What to copy, from ffprobe (when it sits beside ffmpeg); null when it is missing or fails. */
  async function probePlan(ffmpeg, input, { headers, proxyUrl, program }) {
    const ffprobe = findFfprobe(ffmpeg);
    if (!ffprobe || seams.spawn) return null;
    return new Promise((resolve) => {
      let out = '';
      let child;
      try {
        child = spawn(ffprobe, ffprobeArgs({ input, headers, proxyUrl }), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, PROBE_MS);
      child.stdout.on('data', (d) => { if (out.length < 256 * 1024) out += d; });
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) { resolve(null); return; }
        try { resolve(planFromProbe(JSON.parse(out), { program })); } catch { resolve(null); }
      });
    });
  }

  async function convertOnce(input, options, key) {
    const { headers = {}, proxyUrl = null, copy = false, videoBsf = 'auto', program = null, startSec = 0, live = false } = options;
    const ffmpeg = ffmpegPath();
    if (!ffmpeg) throw new LumenError('UNAVAILABLE', 'Converting needs ffmpeg on this PC (put ffmpeg.exe in Lumen\'s data/bin folder)');
    let plan = { copyVideo: copy, copyAudio: copy, videoBsf };
    // A copy of a file (not HLS, which is H.264/AAC or goes to hls.js) checks the codecs first: an
    // MKV with FLAC or High 10 video would otherwise fail on the TV before being encoded.
    if (copy && options.videoBsf === undefined && !isPlaylistUrl(input)) {
      const probed = await probePlan(ffmpeg, input, { headers, proxyUrl, program });
      if (probed) plan = probed;
    }
    prune();
    const id = randomBytes(8).toString('hex');
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    const args = ffmpegArgs({
      input, headers, proxyUrl, outDir: dir, ...plan, program, startSec, live,
      encoder: config.ffmpeg?.encoder ?? 'libx264', support: seams.spawn ? undefined : ffmpegSupport(ffmpeg),
    });
    const child = spawnFfmpeg(ffmpeg, args);
    const job = { dir, child, at: Date.now(), stderr: '', key, ready: false, exited: undefined, done: false };
    jobs.set(id, job);
    child.stderr?.on('data', (d) => { job.stderr = (job.stderr + d.toString()).slice(-2000); });
    child.on('error', (err) => {
      job.stderr = `${job.stderr}\n${err.message}`.slice(-2000);
      // Never started (no pid): no 'exit' follows, so the wait for the first segment ends now.
      if (child.pid === undefined && !job.done) { job.exited = -1; job.done = true; }
    });
    child.on('exit', (code) => {
      job.exited = code;
      job.done = true;
      if (code) log.warn('ffmpeg stopped', { code, tail: job.stderr.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300) });
    });
    log.info('converting for the TV', {
      id, copy, video: plan.copyVideo ? plan.videoBsf === 'none' ? 'copy' : 'copy+level' : 'encode', audio: plan.copyAudio ? 'copy' : 'aac',
      ...(Number.isInteger(program) && { program }), ...(Number(startSec) > 0 && { startSec: Number(startSec) }), ...(live && { live }),
      host: (() => { try { return new URL(input).hostname; } catch { return null; } })(),
    });
    // Wait until the playlist lists a segment (the TV needs something to start on).
    const deadline = Date.now() + FIRST_SEGMENT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      const list = fs.existsSync(path.join(dir, 'index.m3u8')) ? fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8') : '';
      if (/\.ts\s*$/m.test(list) && jobs.get(id) === job) {
        job.ready = true;
        job.at = Date.now();
        return { id, dir };
      }
      if (job.done || jobs.get(id) !== job) break;
    }
    const why = job.stderr.split('\n').filter(Boolean).slice(-1)[0] ?? 'no output';
    const plainCopy = plan.copyVideo && plan.videoBsf !== 'none' && HEVC_BSF_REFUSED.test(job.stderr);
    cleanup(id);
    const err = new LumenError('FAILED', `The video could not be converted for the TV (${why.slice(0, 120)})`);
    if (plainCopy) err.retryPlainCopy = true;
    throw err;
  }

  /** The job for this input that is still usable (for skipping a direct attempt known to fail). */
  function existing(input) {
    for (const [id, job] of jobs) {
      if (job.key?.endsWith(`|${input}`) && (job.exited === undefined || job.exited === 0)) return { id, copy: job.key.startsWith('copy|') };
    }
    return null;
  }

  /** A file of job `id` (index.m3u8 or seg_NNNNN.ts) or null. */
  function file(id, name) {
    const job = jobs.get(id);
    if (!job || !/^(index\.m3u8|seg_\d{5}\.ts)$/.test(name)) return null;
    job.at = Date.now();
    const p = path.join(job.dir, name);
    return fs.existsSync(p) ? p : null;
  }

  /** The TV is playing job `id` (on) or no longer (off): a held job is never reaped. tvscreen holds
   *  the converted video its player has in front (loading, playing, paused). → false for an unknown job. */
  function hold(id, on = true) {
    const job = jobs.get(id);
    if (!job) return false;
    if (on) held.add(id);
    else held.delete(id);
    job.at = Date.now(); // a released job gets the whole unused time before the reaper takes it
    return true;
  }

  /** Clear history: removes converted videos (this run's jobs and the folders earlier runs left in
   *  <dataDir>/transcode) except the jobs in `keep` (the one the TV is playing). → how many went. */
  function clearSaved({ keep = [] } = {}) {
    const removed = new Set();
    for (const id of [...jobs.keys()]) {
      if (keep.includes(id)) continue;
      const { dir } = jobs.get(id);
      cleanup(id);
      try { fs.rmSync(dir, RM); } catch { /* cleanup's rm finishes it once ffmpeg has gone */ }
      removed.add(id);
    }
    for (const name of sweepOrphans(removed)) removed.add(name);
    return removed.size;
  }

  return {
    convert,
    existing,
    file,
    hold,
    clearSaved,
    reap,
    stopJob: (id) => cleanup(id),
    available: () => Boolean(ffmpegPath()),
    // At boot (after the HTTP port is bound, so a second instance never touches the live one's
    // folders): folders earlier runs left behind go, and the reaper starts.
    start() {
      const gone = sweepOrphans();
      if (gone.length) log.info('removed converted videos left by an earlier run', { count: gone.length });
      clearInterval(reaper);
      reaper = setInterval(reap, REAP_EVERY_MS);
      reaper.unref?.();
    },
    // Waits for each ffmpeg to exit (index.js exits the process right after), then removes the folders.
    async stop() {
      clearInterval(reaper);
      reaper = null;
      const all = [...jobs.values()];
      jobs.clear();
      held.clear();
      for (const job of all) { try { job.child?.kill('SIGKILL'); } catch { /* gone */ } }
      await Promise.all(all.map((job) => exited(job, EXIT_WAIT_MS)));
      for (const job of all) {
        try { fs.rmSync(job.dir, RM); } catch (err) { log.warn('a converted video could not be removed', { code: err.code }); }
      }
    },
    setDemand() {},
  };
}
