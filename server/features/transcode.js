// Converts a video the TV cannot play into something it can: ffmpeg on this PC pulls the stream
// (through the VPN proxy when it is on, with the page's headers), and writes H.264 + AAC as an HLS
// playlist that the TV plays from Lumen while ffmpeg keeps going. Streams already in H.264/AAC are
// copied, not re-encoded, so a remux costs almost nothing.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { LumenError } from '../errors.js';

const CANDIDATES = [
  'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
  path.join(os.homedir(), 'AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe'),
  path.join(os.homedir(), 'AppData/Local/Programs/Stremio/ffmpeg.exe'),
  'C:/Program Files/Jellyfin/Server/ffmpeg.exe',
];
const MAX_JOBS = 2;
const FIRST_SEGMENT_MS = 25000;
const JOB_IDLE_MS = 10 * 60 * 1000;

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

/** ffmpeg arguments for one job (exported for tests). */
export function ffmpegArgs({ input, headers = {}, proxyUrl = null, outDir, copyVideo = false, copyAudio = false, encoder = 'libx264' }) {
  const head = Object.entries({ 'User-Agent': headers.userAgent, Referer: headers.referer, Origin: headers.origin, Cookie: headers.cookie })
    .filter(([, v]) => typeof v === 'string' && v)
    .map(([k, v]) => `${k}: ${v.replace(/[\r\n]+/g, ' ')}\r\n`).join('');
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    ...(head ? ['-headers', head] : []),
    ...(proxyUrl ? ['-http_proxy', proxyUrl] : []),
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', input,
    '-map', '0:v:0?', '-map', '0:a:0?',
    ...(copyVideo ? ['-c:v', 'copy'] : ['-c:v', encoder, ...(encoder === 'libx264' ? ['-preset', 'veryfast', '-crf', '21'] : ['-b:v', '8M']),
      '-profile:v', 'high', '-level:v', '4.1', '-pix_fmt', 'yuv420p', '-g', '96', '-sc_threshold', '0']),
    ...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000']),
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
    path.join(outDir, 'index.m3u8'),
  ];
}

export function createTranscoder({ config, log: rootLog }) {
  const log = rootLog.child('transcode');
  const jobs = new Map(); // id → { dir, child, at, ready }
  const root = path.join(config.dataDir ?? os.tmpdir(), 'transcode');

  function cleanup(id) {
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    try { job.child?.kill('SIGKILL'); } catch { /* gone */ }
    fs.rm(job.dir, { recursive: true, force: true }, () => {});
  }

  function prune() {
    const now = Date.now();
    for (const [id, job] of jobs) if (now - job.at > JOB_IDLE_MS) cleanup(id);
    while (jobs.size >= MAX_JOBS) cleanup(jobs.keys().next().value);
  }

  /**
   * Starts converting `input` (a URL) for the TV; resolves once the first segment exists.
   * → { id, dir } — the relay serves <dir>/index.m3u8 and its segments.
   */
  // Not called start(): Lumen calls start() on every feature at boot.
  async function convert(input, { headers = {}, proxyUrl = null, copy = false } = {}) {
    const ffmpeg = findFfmpeg({ config });
    if (!ffmpeg) throw new LumenError('UNAVAILABLE', 'Converting needs ffmpeg on this PC (put ffmpeg.exe in Lumen\'s data/bin folder)');
    prune();
    const id = randomBytes(8).toString('hex');
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    const args = ffmpegArgs({ input, headers, proxyUrl, outDir: dir, copyVideo: copy, copyAudio: copy, encoder: config.ffmpeg?.encoder ?? 'libx264' });
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const job = { dir, child, at: Date.now(), stderr: '' };
    jobs.set(id, job);
    child.stderr.on('data', (d) => { job.stderr = (job.stderr + d.toString()).slice(-2000); });
    child.on('exit', (code) => {
      job.exited = code;
      if (code) log.warn('ffmpeg stopped', { code, tail: job.stderr.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300) });
    });
    log.info('converting for the TV', { id, copy, host: (() => { try { return new URL(input).hostname; } catch { return null; } })() });
    // Wait until the playlist lists a segment (the TV needs something to start on).
    const deadline = Date.now() + FIRST_SEGMENT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      const list = fs.existsSync(path.join(dir, 'index.m3u8')) ? fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8') : '';
      if (/\.ts\s*$/m.test(list)) return { id, dir };
      if (job.exited !== undefined) break;
    }
    const why = job.stderr.split('\n').filter(Boolean).slice(-1)[0] ?? 'no output';
    cleanup(id);
    throw new LumenError('FAILED', `The video could not be converted for the TV (${why.slice(0, 120)})`);
  }

  /** A file of job `id` (index.m3u8 or seg_NNNNN.ts) or null. */
  function file(id, name) {
    const job = jobs.get(id);
    if (!job || !/^(index\.m3u8|seg_\d{5}\.ts)$/.test(name)) return null;
    job.at = Date.now();
    const p = path.join(job.dir, name);
    return fs.existsSync(p) ? p : null;
  }

  return {
    convert,
    file,
    stopJob: (id) => cleanup(id),
    available: () => Boolean(findFfmpeg({ config })),
    async stop() { for (const id of [...jobs.keys()]) cleanup(id); },
    setDemand() {},
  };
}
