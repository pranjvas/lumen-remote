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
