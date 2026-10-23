// Media relay: HLS playlists are rewritten so every variant, key and segment URI goes through the
// relay, and only registered tokens with http(s) targets are served.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelay, rewritePlaylist } from '../server/features/relay.js';
import { createTestLog } from './helpers.js';

describe('relay', () => {
  test('rewritePlaylist: lines and URI="…" attributes become relay URLs; comments stay', () => {
    const text = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/index.m3u8\nhttps://cdn.example/seg1.ts\n';
    const out = rewritePlaylist(text, 'https://cdn.example/v/master.m3u8', (u) => `R(${u})`);
    assert.match(out, /URI="R\(https:\/\/cdn\.example\/v\/key\.bin\)"/);
    assert.match(out, /^R\(https:\/\/cdn\.example\/v\/low\/index\.m3u8\)$/m);
    assert.match(out, /^R\(https:\/\/cdn\.example\/seg1\.ts\)$/m);
    assert.match(out, /^#EXT-X-STREAM-INF:BANDWIDTH=1$/m);
  });

  test('serves a registered stream (playlist rewritten, segment passed through); unknown tokens 404', async () => {
    const upstream = http.createServer((req, res) => {
      if (req.url === '/v/master.m3u8') { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end('#EXTM3U\nseg.ts\n'); return; }
      if (req.url === '/v/seg.ts') { res.writeHead(200, { 'content-type': 'video/mp2t' }); res.end(Buffer.from([0x47, 1, 2])); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    let handler;
    const front = http.createServer((req, res) => handler(req, res));
    await new Promise((r) => front.listen(0, '127.0.0.1', r));
    const lan = { address: '127.0.0.1', port: front.address().port, route: (prefix, { request }) => { handler = request; return () => {}; } };
    const relay = createRelay({ log: createTestLog(), lan });
    relay.start();
    try {
      const { url } = relay.register(`http://127.0.0.1:${upstream.address().port}/v/master.m3u8`, { referer: 'https://site.example/' });
      const master = await (await fetch(url)).text();
      const seg = master.split('\n').find((l) => l.startsWith('http'));
      assert.ok(seg.startsWith(`http://127.0.0.1:${lan.port}/relay/`));
      const body = Buffer.from(await (await fetch(seg)).arrayBuffer());
      assert.deepEqual([...body], [0x47, 1, 2]);
      assert.equal((await fetch(`http://127.0.0.1:${lan.port}/relay/nope/x/y`)).status, 404);
      assert.throws(() => relay.register('file:///etc/passwd'), /http/);
    } finally {
      relay.stop();
      front.close();
      upstream.close();
    }
  });
});

describe('transcode', () => {
  test('ffmpeg arguments: page headers, VPN proxy, copy vs H.264/AAC encode, HLS event playlist', async () => {
    const { ffmpegArgs } = await import('../server/features/transcode.js');
    const enc = ffmpegArgs({ input: 'https://v.example/a.mp4', headers: { referer: 'https://v.example/', cookie: 'a=1' }, proxyUrl: 'http://127.0.0.1:5000', outDir: 'D' });
    assert.equal(enc[enc.indexOf('-http_proxy') + 1], 'http://127.0.0.1:5000');
    assert.match(enc[enc.indexOf('-headers') + 1], /Referer: https:\/\/v\.example\/\r\nCookie: a=1\r\n/);
    assert.equal(enc[enc.indexOf('-c:v') + 1], 'libx264');
    assert.equal(enc[enc.indexOf('-c:a') + 1], 'aac');
    assert.equal(enc[enc.indexOf('-hls_playlist_type') + 1], 'event');
    const copy = ffmpegArgs({ input: 'x', outDir: 'D', copyVideo: true, copyAudio: true });
    assert.equal(copy[copy.indexOf('-c:v') + 1], 'copy');
    assert.equal(copy.includes('-http_proxy'), false);
  });

  test('the relay serves converted files only for known jobs and file names', async () => {
    let handler;
    const front = http.createServer((req, res) => handler(req, res));
    await new Promise((r) => front.listen(0, '127.0.0.1', r));
    const lan = { address: '127.0.0.1', port: front.address().port, route: (prefix, { request }) => { handler = request; return () => {}; } };
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-x-'));
    fs.writeFileSync(path.join(dir, 'index.m3u8'), '#EXTM3U\nseg_00000.ts\n');
    const transcoder = { file: (job, name) => (job === 'abc' && /^(index\.m3u8|seg_\d{5}\.ts)$/.test(name) && fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : null) };
    const relay = createRelay({ log: createTestLog(), lan, transcoder: () => transcoder });
    relay.start();
    try {
      const ok = await fetch(relay.convertedUrl('abc'));
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get('content-type'), 'application/vnd.apple.mpegurl');
      assert.equal((await fetch(`http://127.0.0.1:${lan.port}/relay/x/abc/..%2Fsecrets.json`)).status, 404);
      assert.equal((await fetch(`http://127.0.0.1:${lan.port}/relay/x/nope/index.m3u8`)).status, 404);
    } finally {
      relay.stop();
      front.close();
    }
  });
});
