// Media relay: HLS playlists are rewritten so every variant, key and segment URI goes through the
// relay, and only registered tokens with http(s) targets are served.
import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  avcLevel, chooseVariant, createRelay, levelTooLow, parseHlsMaster, parseSps, readMp4Sps, readTsSps, relayRefusal, rewritePlaylist, siteOf,
} from '../server/features/relay.js';
import { createTestLog } from './helpers.js';

// The SPS of a 1920x1080 High-profile stream labelled level 3.0 (MaxFS 1620, it needs 8160): the
// TV's player shows it black with sound.
const SPS_1080_L30 = '6764001eacd940780227e5c044';

/** A Baseline SPS NAL (hex) for widthMbs × heightMbs at level_idc `level`. */
function baselineSps(level, widthMbs, heightMbs) {
  const bits = [];
  const u = (n, v) => { for (let k = n - 1; k >= 0; k--) bits.push((v >> k) & 1); };
  const ue = (v) => { const x = v + 1; const n = Math.floor(Math.log2(x)); u(n, 0); u(n + 1, x); };
  u(8, 66); u(8, 0xc0); u(8, level);
  ue(0); ue(0); ue(2); ue(1); u(1, 0); // sps id, log2_max_frame_num-4, poc type 2, refs, gaps
  ue(widthMbs - 1); ue(heightMbs - 1); u(1, 1); u(1, 1); u(1, 0); u(1, 0); // frame_mbs_only, direct_8x8, no crop, no VUI
  u(1, 1);
  while (bits.length % 8) bits.push(0);
  const out = [0x67];
  let zeros = 0;
  for (let i = 0; i < bits.length; i += 8) {
    const b = parseInt(bits.slice(i, i + 8).join(''), 2);
    if (zeros >= 2 && b <= 3) { out.push(3); zeros = 0; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out).toString('hex');
}

/** One 188-byte TS packet (adaptation-field stuffing when the payload is short). */
function tsPacket(pid, payload, pusi = false) {
  const head = Buffer.from([0x47, (pusi ? 0x40 : 0) | (pid >> 8), pid & 0xff, 0x10]);
  if (payload.length >= 184) return Buffer.concat([head, payload.subarray(0, 184)]);
  head[3] = 0x30;
  const stuff = 184 - payload.length;
  const af = stuff === 1 ? Buffer.from([0]) : Buffer.concat([Buffer.from([stuff - 1, 0]), Buffer.alloc(stuff - 2, 0xff)]);
  return Buffer.concat([head, af, payload]);
}

/** A tiny MPEG-TS segment: PAT, PMT (H.264 on PID 0x100, or `streamType`) and one PES with the SPS. */
function tsSegment(spsHex, { streamType = 0x1b } = {}) {
  const pat = Buffer.from([0, 0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0]);
  const pmt = Buffer.from([0, 0x02, 0xb0, 18, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00, streamType, 0xe1, 0x00, 0xf0, 0x00, 0, 0, 0, 0]);
  const es = Buffer.concat([Buffer.from('0000000109f0', 'hex'), Buffer.from('00000001', 'hex'), Buffer.from(spsHex, 'hex'), Buffer.from('0000000168ce3c80', 'hex')]);
  const pes = Buffer.concat([Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1]), es]);
  return Buffer.concat([tsPacket(0, pat, true), tsPacket(0x1000, pmt, true), tsPacket(0x100, pes, true), tsPacket(0x100, Buffer.alloc(184, 0xaa))]);
}

/** An MP4 head: ftyp + moov (one avc1 track with this SPS); mdat first when moovLast. */
function mp4Head(spsHex, { moovLast = false } = {}) {
  const box = (type, ...parts) => { const body = Buffer.concat(parts); const h = Buffer.alloc(8); h.writeUInt32BE(body.length + 8); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); };
  const sps = Buffer.from(spsHex, 'hex');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(sps.length);
  const avcC = box('avcC', Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]), len, sps, Buffer.from([1, 0, 4, 0x68, 0xce, 0x3c, 0x80]));
  const avc1 = box('avc1', Buffer.alloc(78), avcC);
  const stsd = box('stsd', Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), avc1);
  const moov = box('moov', box('mvhd', Buffer.alloc(100)), box('trak', box('tkhd', Buffer.alloc(84)), box('mdia', box('mdhd', Buffer.alloc(24)), box('minf', box('stbl', stsd)))));
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isomavc1', 'latin1'));
  const mdat = box('mdat', Buffer.alloc(1000, 1));
  return moovLast ? Buffer.concat([ftyp, mdat, moov]) : Buffer.concat([ftyp, moov, mdat]);
}

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
      // No levelLow / audioOnly keys unless found: the probe's shape is otherwise unchanged.
      assert.deepEqual(await relay.probeHls(stream.token), {
        fmp4: true, endlist: true, drm: true, master: true,
        variants: [{ index: 0, bandwidth: 1, width: null, height: null, codecs: null, audio: null, uri: `${up}/v/media.m3u8` }],
      });
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

describe('HLS variants and H.264 levels', () => {
  test('parseHlsMaster: one entry per STREAM-INF (I-frame playlists are not variants), indexes as ffmpeg numbers programmes', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",DEFAULT=YES,URI="audio/en.m3u8"',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,RESOLUTION=640x360,URI="iframe360.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="aud"',
      '360/index.m3u8',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=190000,RESOLUTION=1280x720,URI="iframe720.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"',
      'https://cdn.example/720/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"',
      '1080/index.m3u8?sig=1',
    ].join('\r\n');
    const variants = parseHlsMaster(text, 'https://site.example/v/master.m3u8');
    assert.deepEqual(variants.map((v) => [v.index, v.height, v.bandwidth]), [[0, 360, 800000], [1, 720, 2500000], [2, 1080, 6000000]]);
    assert.deepEqual(variants[0], { index: 0, bandwidth: 800000, width: 640, height: 360, codecs: 'avc1.42c01e,mp4a.40.2', audio: 'aud', uri: 'https://site.example/v/360/index.m3u8' });
    assert.equal(variants[1].uri, 'https://cdn.example/720/index.m3u8');
    assert.equal(variants[2].uri, 'https://site.example/v/1080/index.m3u8?sig=1');
    assert.deepEqual(parseHlsMaster('#EXTM3U\n#EXTINF:4,\nseg.ts\n'), []);
  });

  test('chooseVariant: the best up to 1080p to encode, up to 2160p to copy (H.264 before HEVC); the smallest above when none fits', () => {
    const v = (index, height, bandwidth, codecs = 'avc1.640028,mp4a.40.2') => ({ index, width: Math.round((height * 16) / 9), height, bandwidth, codecs, audio: null, uri: `${height}.m3u8` });
    const ladder = [v(0, 360, 800e3), v(1, 720, 2.5e6), v(2, 1080, 6e6), v(3, 2160, 16e6)];
    assert.equal(chooseVariant(ladder, { copy: false }).height, 1080);
    assert.equal(chooseVariant(ladder, { copy: true }).height, 2160);
    const hevcTop = [v(0, 360, 800e3), v(1, 1080, 6e6), v(2, 2160, 20e6, 'hvc1.2.4.L153.B0,mp4a.40.2')];
    assert.equal(chooseVariant(hevcTop, { copy: true }).index, 1, 'HEVC is passed over for a copy');
    assert.equal(chooseVariant(hevcTop, { copy: false }).index, 1);
    assert.equal(chooseVariant([v(0, 1440, 9e6), v(1, 2160, 16e6)], { copy: false }).height, 1440, 'nothing up to 1080p: the smallest above');
    assert.equal(chooseVariant([v(0, 1080, 6e6), { ...v(1, null, 9e9, 'mp4a.40.2'), width: null }], { copy: false }).index, 0, 'audio-only variants never count');
    assert.equal(chooseVariant([], { copy: true }), null);
    assert.equal(chooseVariant(undefined), null);
  });

  test('avcLevel / levelTooLow / parseSps: the label against the picture size', () => {
    assert.deepEqual(avcLevel('avc1.64001E'), { profile: 100, level: 30 });
    assert.deepEqual(avcLevel('avc3.4d401f'), { profile: 77, level: 31 });
    assert.deepEqual(avcLevel('avc1.42F00B'), { profile: 66, level: 9 }, 'level_idc 11 with constraint_set3 on Baseline is 1b');
    assert.deepEqual(avcLevel('avc1.66.30'), { profile: 66, level: 30 });
    assert.equal(avcLevel('hvc1.1.6.L93.B0'), null);
    assert.equal(levelTooLow(30, 1920, 1080), true);
    assert.equal(levelTooLow(31, 1280, 720), false);
    assert.equal(levelTooLow(40, 1920, 1088), false);
    assert.equal(levelTooLow(99, 1920, 1080), false, 'an unknown level is not judged');
    const sps = parseSps(Buffer.from(SPS_1080_L30, 'hex'));
    assert.deepEqual({ level: sps.level, w: sps.w, h: sps.h, profile: sps.profile }, { level: 30, w: 1920, h: 1088, profile: 100 });
    const s720 = parseSps(Buffer.from(baselineSps(31, 80, 45), 'hex'));
    assert.deepEqual({ level: s720.level, w: s720.w, h: s720.h }, { level: 31, w: 1280, h: 720 });
    const ts = readTsSps(tsSegment(SPS_1080_L30));
    assert.deepEqual({ level: ts.level, w: ts.w, h: ts.h }, { level: 30, w: 1920, h: 1088 });
    assert.equal(readTsSps(tsSegment(SPS_1080_L30, { streamType: 0x24 })), null, 'HEVC is not read as H.264');
    assert.equal(readTsSps(Buffer.from('not a transport stream')), null);
    assert.throws(() => parseSps(Buffer.from('6764', 'hex')), /SPS/);
    const mp4 = readMp4Sps(mp4Head(SPS_1080_L30));
    assert.deepEqual({ level: mp4.level, w: mp4.w, h: mp4.h }, { level: 30, w: 1920, h: 1088 });
    assert.equal(readMp4Sps(mp4Head(SPS_1080_L30, { moovLast: true })), null, 'moov at the end is not in the head');
  });
});

describe('HLS probe', () => {
  const playlist = (res, text) => { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end(text); };
  const media = (lines) => `#EXTM3U\n#EXT-X-TARGETDURATION:4\n${lines.join('\n')}\n#EXT-X-ENDLIST\n`;

  test('levelLow from the SPS of the first segment (Range 0-65535, the page\'s headers), from CODECS, and none when the level fits', async () => {
    const s = await relayStack((req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      if (p === '/low/media.m3u8') return playlist(res, media(['#EXTINF:4,', 'seg0.ts', '#EXTINF:4,', 'seg1.ts']));
      if (p === '/low/seg0.ts') {
        const body = tsSegment(SPS_1080_L30);
        res.writeHead(206, { 'content-type': 'video/mp2t', 'content-range': `bytes 0-${body.length - 1}/${body.length * 50}` });
        return res.end(body);
      }
      if (p === '/codecs/master.m3u8') return playlist(res, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.64001E,mp4a.40.2"\nmedia.m3u8\n');
      if (p === '/codecs/media.m3u8') return playlist(res, media(['#EXTINF:4,', 'missing.ts']));
      if (p === '/ok720/master.m3u8') return playlist(res, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"\nmedia.m3u8\n');
      if (p === '/ok720/media.m3u8') return playlist(res, media(['#EXTINF:4,', 'seg.ts']));
      if (p === '/ok720/seg.ts') { res.writeHead(200, { 'content-type': 'video/mp2t' }); return res.end(tsSegment(baselineSps(31, 80, 45))); }
      // CODECS says 3.0, the segment's own SPS says 4.0: the SPS wins for the variant it came from.
      if (p === '/relabelled/master.m3u8') return playlist(res, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.64001E"\nmedia.m3u8\n');
      if (p === '/relabelled/media.m3u8') return playlist(res, media(['#EXTINF:4,', 'seg.ts']));
      if (p === '/relabelled/seg.ts') { res.writeHead(200, { 'content-type': 'video/mp2t' }); return res.end(tsSegment(baselineSps(40, 120, 68))); }
      // Another variant's CODECS still counts (AVPlay switches up to it).
      if (p === '/ladder/master.m3u8') return playlist(res, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.42c01e"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.64001e"\nhigh.m3u8\n');
      if (p === '/ladder/low.m3u8') return playlist(res, media(['#EXTINF:4,', 'seg.ts']));
      if (p === '/ladder/seg.ts') { res.writeHead(200, { 'content-type': 'video/mp2t' }); return res.end(tsSegment(baselineSps(30, 40, 23))); }
      // EXT-X-BYTERANGE: the first segment is a sub-range of one file.
      if (p === '/br/media.m3u8') return playlist(res, media(['#EXTINF:4,', '#EXT-X-BYTERANGE:900@376', 'all.ts']));
      if (p === '/br/all.ts') {
        const body = Buffer.concat([Buffer.alloc(376, 0xff), tsSegment(SPS_1080_L30)]);
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec(req.headers.range);
        const part = body.subarray(Number(a), Number(b) + 1);
        res.writeHead(206, { 'content-type': 'video/mp2t', 'content-range': `bytes ${a}-${Number(a) + part.length - 1}/${body.length}` });
        return res.end(part);
      }
      res.writeHead(404);
      return res.end();
    });
    try {
      const reg = (p) => s.relay.register(`${s.up}${p}`, { referer: 'https://site.example/', cookie: 'sid=1' }).token;
      const low = await s.relay.probeHls(reg('/low/media.m3u8'));
      assert.deepEqual(low, { fmp4: false, endlist: true, drm: false, levelLow: { level: 30, w: 1920, h: 1088, from: 'sps' } });
      const segReq = s.seen.find((x) => x.url === '/low/seg0.ts');
      assert.equal(segReq.headers.range, 'bytes=0-65535');
      assert.equal(segReq.headers.referer, 'https://site.example/');
      assert.equal(segReq.headers.cookie, 'sid=1');
      assert.equal(s.seen.some((x) => x.url === '/low/seg1.ts'), false, 'only the first segment is read');

      const codecs = await s.relay.probeHls(reg('/codecs/master.m3u8'));
      assert.deepEqual(codecs.levelLow, { level: 30, w: 1920, h: 1080, from: 'codecs' });
      assert.equal(codecs.master, true);
      assert.equal(codecs.variants.length, 1);

      const ok720 = await s.relay.probeHls(reg('/ok720/master.m3u8'));
      assert.equal('levelLow' in ok720, false, JSON.stringify(ok720));
      assert.equal('audioOnly' in ok720, false);
      assert.equal('levelLow' in await s.relay.probeHls(reg('/relabelled/master.m3u8')), false, 'the SPS overrides CODECS for its variant');
      assert.deepEqual((await s.relay.probeHls(reg('/ladder/master.m3u8'))).levelLow, { level: 30, w: 1920, h: 1080, from: 'codecs' });

      const br = await s.relay.probeHls(reg('/br/media.m3u8'));
      assert.equal(s.seen.find((x) => x.url === '/br/all.ts').headers.range, 'bytes=376-1275');
      assert.deepEqual(br.levelLow, { level: 30, w: 1920, h: 1088, from: 'sps' });
    } finally {
      s.close();
    }
  });

  test('a hanging first segment still gives the probe within its budget, without a level verdict', async () => {
    const hung = [];
    const s = await relayStack((req, res) => {
      if (req.url === '/hang/media.m3u8') return playlist(res, media(['#EXTINF:4,', 'seg.ts']));
      if (req.url === '/hang/seg.ts') { hung.push(res); return undefined; } // never answers
      if (req.url === '/drip/media.m3u8') return playlist(res, media(['#EXTINF:4,', 'seg.ts']));
      if (req.url === '/drip/seg.ts') { res.writeHead(200, { 'content-type': 'video/mp2t' }); res.write(Buffer.from([0x47])); hung.push(res); return undefined; } // starts, then stalls
      res.writeHead(404);
      return res.end();
    });
    try {
      for (const p of ['/hang/media.m3u8', '/drip/media.m3u8']) {
        const t0 = Date.now();
        const probe = await s.relay.probeHls(s.relay.register(`${s.up}${p}`).token);
        const took = Date.now() - t0;
        assert.deepEqual(probe, { fmp4: false, endlist: true, drm: false }, p);
        assert.ok(took < 4000, `${p}: ${took} ms`);
      }
    } finally {
      for (const r of hung) r.destroy();
      s.close();
    }
  });

  test('DRM keys in any attribute order, in the master\'s session keys too; audio-only playlists; AES-128 skips the segment read', async () => {
    const s = await relayStack((req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      if (p === '/order/media.m3u8') return playlist(res, media(['#EXT-X-KEY:KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AA=="', '#EXTINF:4,', 'seg.ts']));
      if (p === '/session/master.m3u8') return playlist(res, '#EXTM3U\n#EXT-X-SESSION-KEY:KEYFORMAT="com.apple.streamingkeydelivery",METHOD=SAMPLE-AES,URI="skd://x"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n');
      if (p === '/session/media.m3u8') return playlist(res, media(['#EXTINF:4,', 'seg.ts']));
      if (p === '/aac/media.m3u8') return playlist(res, media(['#EXTINF:4,', 'audio_000.aac?x=1']));
      if (p === '/mp4a/master.m3u8') return playlist(res, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\naudio.m3u8\n');
      if (p === '/mp4a/audio.m3u8') return playlist(res, media(['#EXTINF:4,', 'a0.ts']));
      // An audio-only fallback listed first, video after it: a video stream.
      if (p === '/mixed/master.m3u8') return playlist(res, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.5"\naudio.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"\nvideo.m3u8\n');
      if (p === '/mixed/audio.m3u8') return playlist(res, media(['#EXTINF:4,', 'a0.aac']));
      if (p === '/aes/media.m3u8') return playlist(res, media(['#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '#EXTINF:4,', 'seg.ts']));
      res.writeHead(404);
      return res.end();
    });
    try {
      const probe = (p) => s.relay.probeHls(s.relay.register(`${s.up}${p}`).token);
      assert.equal((await probe('/order/media.m3u8')).drm, true, 'KEYFORMAT before METHOD');
      assert.equal((await probe('/session/master.m3u8')).drm, true, 'EXT-X-SESSION-KEY in the master');
      assert.equal(s.seen.some((x) => x.url.endsWith('/seg.ts')), false, 'no segment read for DRM streams');
      const aac = await probe('/aac/media.m3u8');
      assert.equal(aac.audioOnly, true);
      assert.equal(s.seen.some((x) => x.url.startsWith('/aac/audio_000')), false, 'no SPS read for audio');
      assert.equal((await probe('/mp4a/master.m3u8')).audioOnly, true);
      assert.equal('audioOnly' in await probe('/mixed/master.m3u8'), false, 'a master with video variants is not audio only');
      const aes = await probe('/aes/media.m3u8');
      assert.deepEqual(aes, { fmp4: false, endlist: true, drm: false });
      assert.equal(s.seen.some((x) => x.url === '/aes/seg.ts'), false, 'encrypted segments are not read');
    } finally {
      s.close();
    }
  });

  test('probeFile reads an MP4\'s avcC from its first 256 KB (moov first only)', async () => {
    const s = await relayStack((req, res) => {
      const body = req.url === '/front.mp4' ? mp4Head(SPS_1080_L30) : req.url === '/ok.mp4' ? mp4Head(baselineSps(40, 120, 68)) : req.url === '/end.mp4' ? mp4Head(SPS_1080_L30, { moovLast: true }) : null;
      if (!body) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': body.length });
      res.end(body);
    });
    try {
      const probe = (p) => s.relay.probeFile(s.relay.register(`${s.up}${p}`).token);
      assert.deepEqual(await probe('/front.mp4'), { levelLow: { level: 30, w: 1920, h: 1088, from: 'sps' } });
      assert.equal(s.seen.find((x) => x.url === '/front.mp4').headers.range, 'bytes=0-262143');
      assert.deepEqual(await probe('/ok.mp4'), {});
      assert.deepEqual(await probe('/end.mp4'), {});
      assert.deepEqual(await probe('/missing.mp4'), {});
    } finally {
      s.close();
    }
  });
});

describe('relay ranges', () => {
  /** An upstream that honours Range (206 with Content-Range) for every path in `files`. */
  const ranged = (files) => (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const f = files[p];
    if (!f) { res.writeHead(404); res.end(); return; }
    const body = Buffer.isBuffer(f.body) ? f.body : Buffer.from(f.body);
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (!m) { res.writeHead(200, { 'content-type': f.type, 'content-length': body.length }); res.end(body); return; }
    const a = Number(m[1]);
    const b = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    res.writeHead(206, { 'content-type': f.type, 'content-range': `bytes ${a}-${b}/${body.length}`, 'content-length': b - a + 1 });
    res.end(body.subarray(a, b + 1));
  };

  test('playlists are fetched whole and rewritten even when the TV asks for a range; other ranges pass through as 206', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 0x30);
    const s = await relayStack(ranged({
      '/v/master.m3u8': { type: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n' },
      '/api/manifest': { type: 'text/plain', body: '#EXTM3U\n#EXTINF:4,\n/v/seg.ts\n' },
      '/v/seg.ts': { type: 'video/mp2t', body: Buffer.alloc(4096, 0x47) },
      '/big': { type: 'text/plain', body: big },
    }));
    const lanBase = `http://127.0.0.1:${s.lan.port}/relay/`;
    const relayed = (text) => text.split('\n').filter((l) => l && !l.startsWith('#'));
    try {
      const master = await fetch(s.relay.register(`${s.up}/v/master.m3u8`).url, { headers: { range: 'bytes=0-' } });
      assert.equal(master.status, 200);
      const [variant] = relayed(await master.text());
      assert.ok(variant.startsWith(lanBase), variant);
      assert.equal(s.seen.find((x) => x.url === '/v/master.m3u8').headers.range, undefined, 'no Range upstream for a playlist URL');

      // No .m3u8 in the URL: the Range goes upstream, and the whole-body 206 is still rewritten.
      const manifest = await fetch(s.relay.register(`${s.up}/api/manifest`).url, { headers: { range: 'bytes=0-' } });
      assert.equal(manifest.status, 200);
      assert.equal(manifest.headers.get('content-range'), null);
      const [seg] = relayed(await manifest.text());
      assert.ok(seg.startsWith(lanBase), seg);
      assert.equal(s.seen.find((x) => x.url === '/api/manifest').headers.range, 'bytes=0-');

      // A segment range and a large whole-body 206 pass through untouched.
      const part = await fetch(seg, { headers: { range: 'bytes=0-717' } });
      assert.equal(part.status, 206);
      assert.equal(part.headers.get('content-range'), 'bytes 0-717/4096');
      assert.equal((await part.arrayBuffer()).byteLength, 718);
      const whole = await fetch(s.relay.register(`${s.up}/big`).url, { headers: { range: 'bytes=0-' } });
      assert.equal(whole.status, 206);
      assert.equal(whole.headers.get('content-range'), `bytes 0-${big.length - 1}/${big.length}`);
      assert.equal((await whole.arrayBuffer()).byteLength, big.length);
    } finally {
      s.close();
    }
  });

  test('a video file is seekable through the relay: Accept-Ranges is announced, and a range from mid-file has its own length', async () => {
    const film = Buffer.alloc(3 * 1024 * 1024, 0x21);
    // An upstream like archive.org's: its 206 replies carry no Accept-Ranges.
    const s = await relayStack(ranged({ '/film.mp4': { type: 'video/mp4', body: film } }));
    try {
      const url = s.relay.register(`${s.up}/film.mp4`).url;
      // AVPlay's first request: the whole file as a range.
      const first = await fetch(url, { headers: { range: 'bytes=0-' } });
      assert.equal(first.status, 206);
      assert.equal(first.headers.get('accept-ranges'), 'bytes', 'the player is told it can seek');
      assert.equal(first.headers.get('content-length'), String(film.length));
      await first.arrayBuffer();
      // A seek: from the middle to the end.
      const from = 1_000_000;
      const mid = await fetch(url, { headers: { range: `bytes=${from}-` } });
      assert.equal(mid.status, 206);
      assert.equal(mid.headers.get('content-range'), `bytes ${from}-${film.length - 1}/${film.length}`);
      assert.equal(mid.headers.get('content-length'), String(film.length - from));
      assert.equal(mid.headers.get('accept-ranges'), 'bytes');
      assert.equal((await mid.arrayBuffer()).byteLength, film.length - from);
      // Without a range: the whole file with the server's own headers (it said nothing about ranges).
      const plain = await fetch(url);
      assert.equal(plain.status, 200);
      assert.equal(plain.headers.get('accept-ranges'), null);
      assert.equal((await plain.arrayBuffer()).byteLength, film.length);
    } finally {
      s.close();
    }
  });
});

describe('transcode', () => {
  test('ffmpeg arguments: page headers, VPN proxy, copy vs H.264/AAC encode, HLS event playlist', async () => {
    const { ffmpegArgs } = await import('../server/features/transcode.js');
    const enc = ffmpegArgs({ input: 'https://v.example/a.mp4', headers: { referer: 'https://v.example/', cookie: 'a=1' }, proxyUrl: 'http://127.0.0.1:5000', outDir: 'D' });
    assert.equal(enc[enc.indexOf('-http_proxy') + 1], 'http://127.0.0.1:5000');
    assert.match(enc[enc.indexOf('-headers') + 1], /Referer: https:\/\/v\.example\/\r\n/);
    // The cookie is scoped to the input's site (-cookies), never a header sent to every host.
    assert.doesNotMatch(enc[enc.indexOf('-headers') + 1], /Cookie/i);
    // (A second line for plain http through the proxy, whose absolute URI ffmpeg matches paths against.)
    assert.equal(enc[enc.indexOf('-cookies') + 1], 'a=1; path=/; domain=v.example\na=1; path=http://; domain=v.example');
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
