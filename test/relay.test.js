// Media relay: HLS playlists are rewritten so every variant, key and segment URI goes through the
// relay, and only registered tokens with http(s) targets are served.
import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelay, relayRefusal, rewritePlaylist, siteOf } from '../server/features/relay.js';
import { createTestLog } from './helpers.js';

// The test upstreams listen on 127.0.0.1, which the relay refuses unless loopback is allowed.
const LOOPBACK_OK = { browser: { allowLoopback: true } };

/** An upstream (handler gets (req, res, body)) and a relay front; → { up, lan, relay, seen, close } */
async function relayStack(handler, relayOptions = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, headers: req.headers });
      handler(req, res, body);
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  let route;
  const front = http.createServer((req, res) => route(req, res));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const lan = { address: '127.0.0.1', port: front.address().port, route: (prefix, { request }) => { route = request; return () => {}; } };
  const relay = createRelay({ log: createTestLog(), lan, config: LOOPBACK_OK, ...relayOptions });
  relay.start();
  return {
    up: `http://127.0.0.1:${upstream.address().port}`, upPort: upstream.address().port, lan, relay, seen,
    close: () => { relay.stop(); front.close(); upstream.close(); },
  };
}

describe('relay destinations', () => {
  test('relayRefusal: this PC (every loopback form), the LAN and reserved ranges are refused; public hosts pass', () => {
    const none = { own: () => new Set() };
    for (const h of ['127.0.0.1', '127.9.9.9', '[::1]', '[::ffff:7f00:1]', '[::7f00:1]', '0.0.0.0', '[::]', 'localhost', 'localhost.', 'a.localhost', new URL('http://0x7f.1/').hostname, new URL('http://2130706433/').hostname]) {
      assert.match(relayRefusal(h, none), /this PC/, h);
      assert.equal(relayRefusal(h, { ...none, allowLoopback: true }), null, h);
    }
    for (const h of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.5', '169.254.169.254', '100.64.0.1', '[fe80::1]', '[fd00::1]', '[::ffff:c0a8:1]', '[64:ff9b::a00:1]']) {
      assert.match(relayRefusal(h, { ...none, allowLoopback: true }), /local network/, h);
      assert.equal(relayRefusal(h, { ...none, allowPrivate: true }), null, h);
    }
    for (const h of ['224.0.0.1', '255.255.255.255', '[ff02::1]']) assert.ok(relayRefusal(h, { ...none, allowLoopback: true, allowPrivate: true }), h);
    for (const h of ['8.8.8.8', '172.32.0.1', '[2606:4700::1111]', 'example.com', 'localhost.example.com']) assert.equal(relayRefusal(h, none), null, h);
    // This PC's own LAN address counts as this PC even when the LAN is allowed.
    assert.match(relayRefusal('192.168.7.7', { allowPrivate: true, own: () => new Set(['192.168.7.7']) }), /this PC/);
  });

  test('siteOf keeps cookies on one registrable site, not on shared suffixes', () => {
    assert.equal(siteOf('cdn.media.example.com'), siteOf('www.example.com'));
    assert.notEqual(siteOf('www.bbc.co.uk'), siteOf('evil.co.uk'));
    assert.notEqual(siteOf('d111.cloudfront.net'), siteOf('d999.cloudfront.net'));
    assert.notEqual(siteOf('me.github.io'), siteOf('attacker.github.io'));
    assert.notEqual(siteOf('a.akamaized.net'), siteOf('b.akamaized.net'));
    assert.notEqual(siteOf('1.2.3.4'), siteOf('9.2.3.4'));
    assert.notEqual(siteOf('cdn.example.com'), siteOf('other.com'));
  });

  test('register refuses this PC and the LAN by default; config opts in', () => {
    const lan = { address: '127.0.0.1', port: 1, route: () => () => {} };
    const strict = createRelay({ log: createTestLog(), lan });
    for (const u of ['http://127.0.0.1:8790/', 'http://localhost/x.m3u8', 'http://[::1]/', 'http://192.168.1.50/v.m3u8', 'http://169.254.169.254/latest']) assert.throws(() => strict.register(u), /relay/, u);
    assert.throws(() => strict.register('http://10.0.0.1/lic', { licence: 'resolve' }), /local network/);
    assert.ok(strict.register('https://cdn.example.com/v.m3u8').url);
    const lanOk = createRelay({ log: createTestLog(), lan, config: { relay: { allowPrivate: true } } });
    assert.ok(lanOk.register('http://192.168.1.50/v.m3u8').url);
    assert.throws(() => lanOk.register('http://127.0.0.1/'), /this PC/);
  });

  test('a name that resolves to this PC (DNS rebinding) is refused at connect time', async () => {
    const lookup = (host, opts, cb) => (opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
    const s = await relayStack((req, res) => { res.writeHead(200); res.end('secret'); }, { config: {}, lookup });
    try {
      const { url } = s.relay.register(`http://rebind.test:${s.upPort}/seg.ts`);
      const res = await fetch(url);
      assert.equal(res.status, 502);
      assert.equal(s.seen.length, 0);
    } finally {
      s.close();
    }
    // Control: the same name and lookup work when loopback is allowed, so the refusal above is the policy.
    const ok = await relayStack((req, res) => { res.writeHead(200); res.end('secret'); }, { config: LOOPBACK_OK, lookup });
    try {
      assert.equal(await (await fetch(ok.relay.register(`http://rebind.test:${ok.upPort}/seg.ts`).url)).text(), 'secret');
    } finally {
      ok.close();
    }
  });

  test('redirects to the LAN are refused; cookies are not carried to another site on a redirect', async () => {
    const s = await relayStack((req, res) => {
      if (req.url === '/to-lan') { res.writeHead(302, { location: 'http://10.0.0.1:9/x.ts' }); res.end(); return; }
      if (req.url === '/to-meta') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }); res.end(); return; }
      if (req.url === '/to-other') { res.writeHead(302, { location: `http://localhost:${s.upPort}/seg.ts` }); res.end(); return; }
      if (req.url === '/to-same') { res.writeHead(302, { location: '/seg.ts' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'video/mp2t' }); res.end('ok');
    });
    try {
      for (const p of ['/to-lan', '/to-meta']) assert.equal((await fetch(s.relay.register(`${s.up}${p}`).url)).status, 502, p);
      const cookie = { cookie: 'sid=1', referer: 'https://site.example/' };
      assert.equal(await (await fetch(s.relay.register(`${s.up}/to-other`, cookie).url)).text(), 'ok');
      const other = s.seen.filter((x) => x.url === '/seg.ts' && x.headers.host.startsWith('localhost'));
      assert.equal(other.length, 1);
      assert.equal(other[0].headers.cookie, undefined); // localhost is another site than 127.0.0.1
      assert.equal(other[0].headers.referer, 'https://site.example/');
      assert.equal(s.seen.find((x) => x.url === '/to-other').headers.cookie, 'sid=1');
      s.seen.length = 0;
      await (await fetch(s.relay.register(`${s.up}/to-same`, cookie).url)).text();
      assert.equal(s.seen.find((x) => x.url === '/seg.ts').headers.cookie, 'sid=1');
    } finally {
      s.close();
    }
  });
});

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
    const relay = createRelay({ log: createTestLog(), lan, config: LOOPBACK_OK });
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

  test('a playlist served without an HLS type or .m3u8 URL is still rewritten (the body starts with #EXTM3U); other bodies pass through intact', async () => {
    const big = Buffer.alloc(200 * 1024, 7);
    const upstream = http.createServer((req, res) => {
      const port = upstream.address().port;
      if (req.url === '/manifest?id=1') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/hls/720p?sig=a\n`); return; }
      if (req.url === '/hls/720p?sig=a') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        // Split across writes so the sniffed head and the rest come in separate chunks.
        res.write('﻿#EXT');
        setTimeout(() => res.end(`M3U\n#EXT-X-KEY:METHOD=AES-128,URI="http://127.0.0.1:${port}/k"\n#EXTINF:6,\nhttp://127.0.0.1:${port}/seg\n`), 20);
        return;
      }
      if (req.url === '/seg') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': big.length }); res.end(big); return; }
      if (req.url === '/tiny') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hi'); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    let handler;
    const front = http.createServer((req, res) => handler(req, res));
    await new Promise((r) => front.listen(0, '127.0.0.1', r));
    const lan = { address: '127.0.0.1', port: front.address().port, route: (prefix, { request }) => { handler = request; return () => {}; } };
    const relay = createRelay({ log: createTestLog(), lan, config: LOOPBACK_OK });
    relay.start();
    const relayed = (text) => text.split('\n').filter((l) => l && !l.startsWith('#'));
    try {
      const up = `http://127.0.0.1:${upstream.address().port}`;
      const master = await fetch(relay.register(`${up}/manifest?id=1`).url);
      assert.equal(master.headers.get('content-type'), 'application/vnd.apple.mpegurl');
      const [variant] = relayed(await master.text());
      assert.ok(variant.startsWith(`http://127.0.0.1:${lan.port}/relay/`), variant);
      const media = await (await fetch(variant)).text();
      assert.match(media, /URI="http:\/\/127\.0\.0\.1:\d+\/relay\//);
      assert.ok(!media.includes(`${up}/`), 'no upstream URI is left for the TV to fetch itself');
      const [seg] = relayed(media);
      assert.ok(seg.startsWith(`http://127.0.0.1:${lan.port}/relay/`), seg);
      const body = Buffer.from(await (await fetch(seg)).arrayBuffer());
      assert.equal(body.length, big.length);
      assert.ok(body.equals(big));
      assert.equal(await (await fetch(relay.register(`${up}/tiny`).url)).text(), 'hi');
    } finally {
      relay.stop();
      front.close();
      upstream.close();
    }
  });

  test('CORS for the in-page player, HLS probe (fMP4, DRM), licence POSTs only where allowed, resolved per request, and blobs', async () => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body });
        if (req.url === '/v/master.m3u8') { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n'); return; }
        if (req.url === '/v/media.m3u8') { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AA=="\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg.m4s\n#EXT-X-ENDLIST\n'); return; }
        if (req.url === '/lic/la') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ licenseAcquisitionUrl: `http://127.0.0.1:${upstream.address().port}/lic/server`, token: 't 1' })); return; }
        if (req.url.startsWith('/lic/server')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(`licence for ${body}`); return; }
        res.writeHead(404); res.end();
      });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    let handler;
    const front = http.createServer((req, res) => handler(req, res));
    await new Promise((r) => front.listen(0, '127.0.0.1', r));
    const lan = { address: '127.0.0.1', port: front.address().port, route: (prefix, { request }) => { handler = request; return () => {}; } };
    const relay = createRelay({ log: createTestLog(), lan, config: LOOPBACK_OK });
    relay.start();
    const up = `http://127.0.0.1:${upstream.address().port}`;
    try {
      const stream = relay.register(`${up}/v/master.m3u8`, { referer: 'https://site.example/' });
      const master = await fetch(stream.url);
      assert.equal(master.headers.get('access-control-allow-origin'), '*');
      const pre = await fetch(stream.url, { method: 'OPTIONS', headers: { 'access-control-request-headers': 'range' } });
      assert.equal(pre.status, 204);
      assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
      assert.deepEqual(await relay.probeHls(stream.token), { fmp4: true, endlist: true, drm: true });
      // A stream token never accepts POSTs.
      assert.equal((await fetch(stream.url, { method: 'POST', body: 'x' })).status, 404);
      // A licence token resolves the real licence server, then forwards the challenge there.
      const lic = relay.register(`${up}/lic/la`, { referer: 'https://site.example/', licence: 'resolve' });
      const reply = await fetch(lic.url, { method: 'POST', body: 'challenge' });
      assert.equal(reply.status, 200);
      assert.equal(await reply.text(), 'licence for challenge');
      assert.ok(seen.some((s) => s.method === 'GET' && s.url === '/lic/la'));
      assert.ok(seen.some((s) => s.method === 'POST' && s.url === '/lic/server?ExpressPlayToken=t%201'));
      const blob = relay.registerBlob(Buffer.from([1, 2, 3]));
      assert.deepEqual([...Buffer.from(await (await fetch(blob.url)).arrayBuffer())], [1, 2, 3]);
    } finally {
      relay.stop();
      front.close();
      upstream.close();
    }
  });
});

describe('relay licence requests', () => {
  test('POSTs go only to the registered URL; failed, plain-text, direct, oversized and LAN-pointing licences', async () => {
    const s = await relayStack((req, res, body) => {
      if (req.url === '/lic/bad') { res.writeHead(500); res.end('no'); return; }
      if (req.url === '/lic/junk') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"nothing":1}'); return; }
      if (req.url === '/lic/text') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('/lic/server?k=1\n'); return; }
      if (req.url === '/lic/lan') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ licenseAcquisitionUrl: 'http://192.168.1.9/x', token: 'a' })); return; }
      if (req.url === '/lic/other') { res.writeHead(200); res.end('other'); return; }
      if (req.url.startsWith('/lic/server') || req.url === '/lic/direct') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(`licence ${req.url} for ${body}`); return; }
      res.writeHead(404); res.end();
    });
    const post = (url, body = 'challenge', headers = {}) => fetch(url, { method: 'POST', body, headers });
    try {
      // A licence token's POST goes to exactly its registered URL: another target under it is a 404.
      const lic = s.relay.register(`${s.up}/lic/direct`, { licence: true });
      const elsewhere = lic.url.replace(/\/[^/]+\/[^/]+$/, `/${Buffer.from(`${s.up}/lic/other`).toString('base64url')}/other`);
      assert.equal((await post(elsewhere)).status, 404);
      assert.equal(s.seen.some((x) => x.url === '/lic/other'), false);
      // licence: true posts straight to the registered URL, with the TV's content type.
      const direct = await post(lic.url, 'c1', { 'content-type': 'text/xml', soapaction: 'x' });
      assert.equal(await direct.text(), 'licence /lic/direct for c1');
      const sent = s.seen.find((x) => x.url === '/lic/direct');
      assert.equal(sent.headers['content-type'], 'text/xml');
      assert.equal(sent.headers.soapaction, 'x');
      // A resolve URL answering as plain text (relative to itself).
      const text = await post(s.relay.register(`${s.up}/lic/text`, { licence: 'resolve' }).url, 'c2');
      assert.equal(await text.text(), 'licence /lic/server?k=1 for c2');
      // A resolve URL that fails or answers no URL → 502, still readable by the in-page player.
      for (const p of ['/lic/bad', '/lic/junk']) {
        const r = await post(s.relay.register(`${s.up}${p}`, { licence: 'resolve' }).url);
        assert.equal(r.status, 502, p);
        assert.equal(r.headers.get('access-control-allow-origin'), '*', p);
      }
      // A resolved licence server on the LAN is refused before anything is sent there.
      const lan = await post(s.relay.register(`${s.up}/lic/lan`, { licence: 'resolve' }).url);
      assert.equal(lan.status, 502);
      // Over 256 KB → 413 (the request is drained, so the answer still arrives).
      const big = await post(lic.url, Buffer.alloc(300 * 1024, 1));
      assert.equal(big.status, 413);
      assert.equal(big.headers.get('access-control-allow-origin'), '*');
      assert.equal(s.seen.filter((x) => x.url === '/lic/direct').length, 1);
    } finally {
      s.close();
    }
  });

  test('tokens and blobs expire: idle after 6 h, licence tokens 6 h after registration however often used', async () => {
    const s = await relayStack((req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end('ok'); });
    const HOUR = 60 * 60 * 1000;
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      const stream = s.relay.register(`${s.up}/seg.ts`);
      const lic = s.relay.register(`${s.up}/lic`, { licence: true });
      const blob = s.relay.registerBlob(Buffer.from([1]));
      mock.timers.tick(5 * HOUR);
      assert.equal((await fetch(stream.url)).status, 200);
      assert.equal((await fetch(lic.url, { method: 'POST', body: 'x' })).status, 200);
      mock.timers.tick(1.5 * HOUR);
      assert.equal((await fetch(stream.url)).status, 200); // used 1.5 h ago: still live
      assert.equal((await fetch(lic.url, { method: 'POST', body: 'x' })).status, 404); // 6.5 h since registration
      assert.equal((await fetch(blob.url)).status, 404);
      mock.timers.tick(6 * HOUR + 1);
      assert.equal((await fetch(stream.url)).status, 404); // idle for over 6 h
      await assert.rejects(s.relay.probeHls(stream.token), /Unknown/);
    } finally {
      mock.timers.reset();
      s.close();
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
