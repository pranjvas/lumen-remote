// Cast after the DLNA / DIAL reverse engineering (docs/research/re-dlna-cast.md, re-deep-links.md):
// the TV's MIME names, the media-server contract its DLNA reader needs, Stop → SetAVTransportURI →
// Play with the 705 retry, seek clamping and 701 retries, image and never-started sessions,
// redirect-following link classification, DIAL payloads and 401, and the browser REST launch.
// Everything is loopback: the mock TV plays the TV's part, a tiny web server plays the internet's.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { skipUnless, startStack, waitFor, sleep, request } from './helpers.js';
import { startMockTv } from './mock-tv.js';
import { MIME_BY_EXT, HLS_MIME, mimeFromName, tvMime, matchUrl, classify } from '../server/features/cast.js';
import { DLNA_FLAGS, DLNA_IMAGE_FLAGS, dlnaFeatures, buildDidl, formatTime, parseTime, upnpClass } from '../server/adapters/avtransport.js';
import { PAYLOADS, DIAL_APPS, pickPayload } from '../server/adapters/dial.js';

const skip = skipUnless('server/app.js');
const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const BROWSER_APP = '3201907018784';
const GTI = 'amzn1.dv.gti.9ab600aa-6625-b547-cfc0-190e3ad8a27d';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const ascii = (n) => Buffer.from(crypto.randomBytes(n).toString('base64').slice(0, n));

const closable = (server) => () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });

/** A loopback web server standing in for the internet: a redirect, a HEAD refusal, HLS, a page. */
async function webServer() {
  const server = http.createServer((req, res) => {
    const media = (type, size = 64) => {
      const ranged = req.headers.range === 'bytes=0-0';
      const headers = { 'Content-Type': type, 'Content-Length': ranged ? 1 : size, 'Accept-Ranges': 'bytes' };
      if (ranged) headers['Content-Range'] = `bytes 0-0/${size}`;
      res.writeHead(ranged ? 206 : 200, headers);
      res.end(req.method === 'HEAD' ? undefined : Buffer.alloc(ranged ? 1 : size));
    };
    switch (req.url) {
      case '/short.mp4': res.writeHead(302, { Location: '/cdn/final.mkv' }); return res.end();
      case '/cdn/final.mkv': return media('video/x-matroska');
      case '/nohead.flac':
        if (req.method === 'HEAD') { res.writeHead(405, { Allow: 'GET' }); return res.end(); }
        return media('audio/flac');
      case '/live.m3u8': return media('application/x-mpegURL');
      case '/page': res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<html>hi</html>');
      default: res.writeHead(404); return res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: (p) => `http://127.0.0.1:${server.address().port}${p}`, stop: closable(server) };
}

/** A media server that records what the renderer asks for (HEAD/GET, Range) and answers like Lumen does. */
async function mediaServer(size = 100) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, headers: req.headers });
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const start = m ? Number(m[1]) : 0;
    const headers = { 'Content-Type': 'video/mp4', 'Content-Length': size - start, 'Accept-Ranges': 'bytes' };
    if (m) headers['Content-Range'] = `bytes ${start}-${size - 1}/${size}`;
    res.writeHead(m ? 206 : 200, headers);
    res.end(req.method === 'HEAD' ? undefined : Buffer.alloc(size - start));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, url: (p) => `http://127.0.0.1:${server.address().port}${p}`, stop: closable(server) };
}

function soap(port, action, args) {
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
  const body = '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
    + `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${AVT}">${inner}</u:${action}></s:Body></s:Envelope>`;
  return request({
    port, path: '/upnp/control/AVTransport1', method: 'POST', body,
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${AVT}#${action}"` },
  });
}
const tag = (xml, name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]?.trim();

describe('cast: TV names, DIDL and link matching', () => {
  test('MIME names are the ones in the TV Sink; gif, webp and HLS are not offered for files', () => {
    assert.deepEqual(['mkv', 'flac', 'wav', 'aac', 'ts', 'm2ts', 'mts', 'mov', '3gp', 'bmp'].map((ext) => MIME_BY_EXT[ext]), [
      'video/x-mkv', 'audio/x-flac', 'audio/x-wav', 'audio/vnd.dlna.adts', 'video/mpeg', 'video/vnd.dlna.mpeg-tts',
      'video/vnd.dlna.mpeg-tts', 'video/quicktime', 'video/3gpp', 'image/bmp',
    ]);
    for (const absent of ['video/x-matroska', 'audio/flac', 'audio/wav', 'audio/aac', 'video/mp2t', 'image/gif', 'image/webp', HLS_MIME]) {
      assert.ok(!Object.values(MIME_BY_EXT).includes(absent), `${absent} is not in the Sink`);
    }
    assert.equal(mimeFromName('Clip.MKV'), 'video/x-mkv');
    for (const name of ['a.gif', 'a.webp', 'a.m3u8', 'a.exe', 'noext']) assert.equal(mimeFromName(name), null, name);
    assert.equal(tvMime('video/x-matroska; charset=binary'), 'video/x-mkv');
    assert.equal(tvMime('audio/flac'), 'audio/x-flac');
    assert.equal(tvMime('application/x-mpegURL'), HLS_MIME);
    assert.equal(tvMime('image/gif'), null);
    assert.equal(tvMime('text/html'), null);
  });

  test('DIDL-Lite: item ids, classes, DLNA flags per type, escaping, H:MM:SS times', () => {
    assert.equal(dlnaFeatures('video/mp4'), DLNA_FLAGS);
    assert.equal(dlnaFeatures('image/png'), DLNA_IMAGE_FLAGS);
    assert.equal(DLNA_FLAGS, 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000');
    assert.equal(DLNA_IMAGE_FLAGS, 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=00F00000000000000000000000000000');
    assert.deepEqual(['video/x-mkv', 'audio/x-flac', 'image/jpeg'].map(upnpClass),
      ['object.item.videoItem.movie', 'object.item.audioItem.musicTrack', 'object.item.imageItem.photo']);
    const didl = buildDidl({ uri: 'http://127.0.0.1:1/m/a.jpg?x=1&y=2', title: 'Tom & Jerry <3', mime: 'image/jpeg' });
    assert.ok(didl.startsWith('<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"'));
    assert.ok(didl.includes('<item id="0" parentID="-1" restricted="1">'));
    assert.ok(didl.includes('<dc:title>Tom &amp; Jerry &lt;3</dc:title>'));
    assert.ok(didl.includes('<upnp:class>object.item.imageItem.photo</upnp:class>'));
    assert.ok(didl.includes(`<res protocolInfo="http-get:*:image/jpeg:${DLNA_IMAGE_FLAGS}">http://127.0.0.1:1/m/a.jpg?x=1&amp;y=2</res>`));
    assert.deepEqual([formatTime(5), formatTime(75), formatTime(3661), formatTime(-3)], ['0:00:05', '0:01:15', '1:01:01', '0:00:00']);
    assert.equal(parseTime('0:00:05.500'), 5.5);
  });

  test('matchUrl: YouTube with a start offset, Netflix ids, Prime GTIs, media by extension, HLS experimental', () => {
    const m = (u) => matchUrl(new URL(u));
    assert.deepEqual(m('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90'), { kind: 'youtube', id: 'dQw4w9WgXcQ', t: 90 });
    assert.deepEqual(m('https://youtu.be/dQw4w9WgXcQ?t=1m30s'), { kind: 'youtube', id: 'dQw4w9WgXcQ', t: 90 });
    assert.deepEqual(m('https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=0'), { kind: 'youtube', id: 'dQw4w9WgXcQ' });
    assert.deepEqual(m('https://www.netflix.com/in/title/70153404'), { kind: 'netflix', id: '70153404' });
    assert.deepEqual(m(`https://app.primevideo.com/detail?gti=${GTI}`), { kind: 'prime', gti: GTI });
    assert.deepEqual(m('https://www.amazon.com/gp/video/detail/B07Q5DQ8Y6'), { kind: 'prime', gti: null });
    assert.deepEqual(m('http://nas.local/films/Clip.MKV'), { kind: 'media', mime: 'video/x-mkv' });
    assert.deepEqual(m('https://cdn.example/live.m3u8'), { kind: 'media', mime: HLS_MIME, experimental: true });
    assert.equal(m('https://example.com/watch?v=abc'), null);
  });

  test('DIAL payloads: YouTube v= and t=, the ranked Netflix and Prime candidates, a config index with fallback', () => {
    assert.deepEqual(DIAL_APPS, { youtube: 'YouTube', netflix: 'Netflix', prime: 'AmazonInstantVideo' });
    assert.equal(pickPayload('youtube', { id: 'dQw4w9WgXcQ' }), 'v=dQw4w9WgXcQ');
    assert.equal(pickPayload('youtube', { id: 'dQw4w9WgXcQ', t: 90.7 }), 'v=dQw4w9WgXcQ&t=90');
    assert.deepEqual(PAYLOADS.netflix.map((build) => build({ id: '70153404' })), [
      'm=https://www.netflix.com/watch/70153404&source_type=4',
      'm=70153404&showMovieInfoOnly=true&source_type_payload=groupIndex%3D1%26tileIndex%3D0%26action%3Dmdp%26movieId%3D70153404',
      'm=70153404&source_type=4',
    ]);
    assert.equal(pickPayload('netflix', { id: '70153404' }, 2), 'm=70153404&source_type=4');
    const prime = { url: `https://app.primevideo.com/detail?gti=${GTI}`, gti: GTI };
    assert.deepEqual(PAYLOADS.prime.map((build) => build(prime)), [prime.url, GTI, `gti=${GTI}`]);
    const noGti = { url: 'https://www.amazon.com/gp/video/detail/B07Q5DQ8Y6', gti: null };
    assert.equal(pickPayload('prime', noGti, 2), noGti.url, 'falls back to the URL when the link has no GTI');
  });

  test('classify follows redirects itself, retries a refused HEAD with a ranged GET, and uses the TV name for the type', async () => {
    const web = await webServer();
    try {
      assert.deepEqual(await classify(web.url('/short.mp4')), { kind: 'media', url: web.url('/cdn/final.mkv'), mime: 'video/x-mkv' });
      assert.deepEqual(await classify(web.url('/nohead.flac')), { kind: 'media', url: web.url('/nohead.flac'), mime: 'audio/x-flac' });
      assert.deepEqual(await classify(web.url('/live.m3u8')), { kind: 'media', url: web.url('/live.m3u8'), mime: HLS_MIME, experimental: true });
      assert.deepEqual(await classify(web.url('/page')), { kind: 'page', url: web.url('/page') });
      assert.deepEqual(await classify('http://127.0.0.1:9/clip.mp4'), { kind: 'media', url: 'http://127.0.0.1:9/clip.mp4', mime: 'video/mp4' },
        'unreachable from the PC: the extension decides and the URL is kept');
    } finally {
      await web.stop();
    }
  });
});

describe('cast: the mock renderer and DIAL behave like the TV', () => {
  test('DMR: 705 on the first Play, then HEAD and a ranged GET with the reader headers; a failed HEAD ends in ERROR_OCCURRED', async () => {
    const mock = await startMockTv();
    const media = await mediaServer();
    try {
      const play = () => soap(mock.ports.dmr, 'Play', { InstanceID: 0, Speed: 1 });
      const seek = (target) => soap(mock.ports.dmr, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: target });
      assert.equal((await soap(mock.ports.dmr, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: media.url('/clip.mp4'), CurrentURIMetaData: '' })).status, 200);
      assert.equal(tag((await play()).body, 'errorCode'), '705');
      assert.equal((await play()).status, 200);
      await waitFor(() => mock.state.avtransport.state === 'PLAYING');
      assert.deepEqual(media.seen.map((r) => r.method), ['HEAD', 'GET']);
      for (const { headers } of media.seen) {
        assert.equal(headers['user-agent'], undefined, 'the reader sends no User-Agent');
        assert.equal(headers['getcontentfeatures.dlna.org'], '1');
        assert.equal(headers['transfermode.dlna.org'], 'Streaming');
        assert.equal(headers['getcaptioninfo.sec'], '1');
        assert.equal(headers.connection, 'close');
      }
      assert.equal(media.seen[1].headers.range, 'bytes=0-');
      assert.equal(tag((await seek('0:10:00')).body, 'errorCode'), '711', 'the exact end is an illegal target');
      assert.equal((await seek('0:00:10')).status, 200);
      assert.equal(tag((await seek('0:00:20')).body, 'errorCode'), '701', 'a seek right after a seek');

      await soap(mock.ports.dmr, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: 'http://127.0.0.1:9/gone.mp4', CurrentURIMetaData: '' });
      await play();
      await play();
      await waitFor(() => mock.state.avtransport.state === 'STOPPED');
      assert.equal(tag((await soap(mock.ports.dmr, 'GetTransportInfo', { InstanceID: 0 })).body, 'CurrentTransportStatus'), 'ERROR_OCCURRED');
      const reason = (await soap(mock.ports.dmr, 'X_GetStoppedReason', { InstanceID: 0 })).body;
      assert.equal(tag(reason, 'StoppedReason'), 'ERROR');
      assert.match(tag(reason, 'StoppedReasonData'), /^HEAD ECONNREFUSED/);
      assert.deepEqual(mock.state.errors, []);
    } finally {
      await media.stop();
      await mock.stop();
    }
  });

  test('DIAL: POST only on the singular path, 403 without the app Origin, 401 until allowed, 201 + LOCATION', async () => {
    const mock = await startMockTv({ dialAllowed: false });
    try {
      const post = (path, headers = {}) => request({
        port: mock.ports.dial, path, method: 'POST', body: 'v=dQw4w9WgXcQ', headers: { 'Content-Type': 'text/plain; charset="utf-8"', ...headers },
      });
      const origin = { Origin: 'https://www.youtube.com' };
      assert.equal((await post('/ws/apps/YouTube', origin)).status, 404);
      assert.equal((await post('/ws/app/YouTube', { Origin: 'http://evil.example' })).status, 403);
      assert.equal((await post('/ws/app/YouTube')).status, 403, 'no Origin is refused too (live-verified)');
      assert.equal((await post('/ws/app/YouTube', origin)).status, 401);
      assert.equal(mock.state.dial.denied, 1);
      mock.options.dialAllowed = true;
      const ok = await post('/ws/app/YouTube', origin);
      assert.equal(ok.status, 201);
      assert.equal(ok.headers.location, `http://127.0.0.1:${mock.ports.dial}/ws/apps/YouTube/run`);
      assert.equal((await post('/ws/app/YouTube', origin)).status, 201, 'launching again is 201 too');
      const big = await request({
        port: mock.ports.dial, path: '/ws/app/YouTube', method: 'POST', body: 'v=' + 'x'.repeat(5000),
        headers: { 'Content-Type': 'text/plain; charset="utf-8"', ...origin },
      });
      assert.equal(big.status, 413);
      assert.deepEqual(mock.state.violations.map((v) => v.kind), ['dial-plural-post', 'dial-origin-header', 'dial-origin-header']);
    } finally {
      await mock.stop();
    }
  });
});

describe('cast: through the server and the mock TV', { skip }, () => {
  let stack, mock, b, port;
  before(async () => {
    stack = await startStack({ config: { timing: { castStartMs: 2000 } } });
    ({ mock, httpPort: port } = stack);
    b = stack.browser();
    await b.hello;
    await b.send('view', { name: 'cast', visible: true });
    await b.waitForState('conn.tv', (r) => r?.v === 'on', { timeout: 8000 });
  });
  after(() => stack?.stop());

  const actions = () => mock.state.avtransport.actions;
  const fetches = () => mock.state.avtransport.fetches;
  const kinds = (from) => actions().slice(from).map((a) => a.action);

  async function upload(name, bytes, type = 'application/octet-stream') {
    const hello = await b.hello;
    const res = await request({
      port, path: '/api/cast/upload', method: 'POST', body: bytes,
      headers: {
        Origin: `http://127.0.0.1:${port}`, 'X-Lumen-CSRF': hello.csrf, 'X-File-Name': encodeURIComponent(name),
        'Content-Type': type, 'Content-Length': bytes.length,
      },
    });
    return { status: res.status, body: JSON.parse(res.body) };
  }
  async function castFile(name, bytes, type) {
    const up = await upload(name, bytes, type);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const ack = await b.send('cast.file', { fileId: up.body.fileId, name: up.body.name }, { timeout: 20000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    return { up, ack };
  }

  test('cast.file: the file route satisfies the DLNA reader and the flow retries the locked Play', async () => {
    const content = ascii(4096);
    const mark = actions().length;
    const { up, ack } = await castFile('Clip ü.mkv', content);
    assert.equal(up.body.mime, 'video/x-mkv');
    assert.deepEqual([ack.value.kind, ack.value.uri, ack.value.title], ['dlna', null, 'Clip ü.mkv']);
    await waitFor(() => mock.state.avtransport.state === 'PLAYING');
    assert.deepEqual(kinds(mark), ['SetAVTransportURI', 'Play', 'Play'], '705 on the first Play, retried');
    const set = actions()[mark];
    assert.equal(set.didl.upnpClass, 'object.item.videoItem.movie');
    assert.equal(set.didl.protocolInfo, `http-get:*:video/x-mkv:${DLNA_FLAGS}`);
    assert.equal(set.didl.title, 'Clip ü.mkv');
    assert.equal(set.didl.url, set.uri);
    assert.ok(!mock.state.violations.some((v) => v.kind === 'didl-malformed'));

    const [head, get] = fetches().slice(-2);
    assert.deepEqual([head.method, head.status, head.ok], ['HEAD', 200, true]);
    assert.deepEqual(head.response, {
      'content-type': 'video/x-mkv', 'content-length': '4096', 'accept-ranges': 'bytes',
      'contentfeatures.dlna.org': DLNA_FLAGS, 'transfermode.dlna.org': 'Streaming',
    });
    assert.deepEqual([get.method, get.status, get.request.Range, get.response['content-range']], ['GET', 206, 'bytes=0-', 'bytes 0-4095/4096']);
    await b.waitForState('cast.session', (r) => r?.v?.state === 'PLAYING' && r.v.duration === 600, { timeout: 5000 });
    assert.ok(!JSON.stringify(b.messages).includes(stack.secrets.castSecret), 'the cast secret never reaches the browser');

    // The rest of the contract, asked directly: transferMode echo, time seek refused, 416, a middle range.
    const tv = new URL(mock.state.avtransport.uri);
    const ask = (method, headers) => request({ port: tv.port, path: tv.pathname, method, headers });
    const bg = await ask('HEAD', { 'transferMode.dlna.org': 'Background' });
    assert.deepEqual([bg.status, bg.headers['transfermode.dlna.org'], bg.headers['content-length'], bg.body], [200, 'Background', '4096', '']);
    assert.equal((await ask('GET', { 'TimeSeekRange.dlna.org': 'npt=1-' })).status, 406);
    const past = await ask('GET', { Range: 'bytes=5000-' });
    assert.deepEqual([past.status, past.headers['content-range']], [416, 'bytes */4096']);
    const middle = await ask('GET', { Range: 'bytes=100-199' });
    assert.deepEqual([middle.status, middle.headers['content-range'], middle.body], [206, 'bytes 100-199/4096', content.subarray(100, 200).toString()]);
  });

  test('a new cast stops the playing one first; audio gets the musicTrack class and the TV wav name', async () => {
    assert.equal(mock.state.avtransport.state, 'PLAYING');
    const mark = actions().length;
    await castFile('tone.wav', ascii(2048));
    assert.deepEqual(kinds(mark).slice(0, 3), ['Stop', 'SetAVTransportURI', 'Play']);
    const set = actions()[mark + 1];
    assert.equal(set.didl.upnpClass, 'object.item.audioItem.musicTrack');
    assert.equal(set.didl.protocolInfo, `http-get:*:audio/x-wav:${DLNA_FLAGS}`);
    await waitFor(() => mock.state.avtransport.state === 'PLAYING');
  });

  test('seek retries 701 while the renderer is still TRANSITIONING and clamps to duration − 1 s', async () => {
    mock.options.dmrFetchDelayMs = 700;
    try {
      const mark = actions().length;
      await castFile('film.mp4', ascii(1024));
      assert.equal(mock.state.avtransport.state, 'TRANSITIONING', 'the renderer has not opened the stream yet');
      const seek = await b.send('cast.control', { action: 'seek', position: 30 }, { timeout: 10000 });
      assert.equal(seek.ok, true, JSON.stringify(seek.error));
      assert.equal(mock.state.avtransport.positionS, 30);
      assert.ok(kinds(mark).filter((a) => a === 'Seek').length >= 2, `retried: ${kinds(mark).join()}`);
    } finally {
      mock.options.dmrFetchDelayMs = 0;
    }
    await b.waitForState('cast.session', (r) => r?.v?.duration === 600, { timeout: 5000 });
    const end = await b.send('cast.control', { action: 'seek', position: 86400 }, { timeout: 10000 });
    assert.equal(end.ok, true, JSON.stringify(end.error));
    assert.equal(actions().at(-1).target, '0:09:59');
    assert.equal(end.value.position, 599);
  });

  test('images: Interactive transfer, the image flags, and a session that stays PLAYING at 0:00 past the start timeout', async () => {
    const mark = actions().length;
    const first = fetches().length;
    const { up } = await castFile('photo.png', PNG, 'image/png');
    assert.equal(up.body.mime, 'image/png');
    await waitFor(() => mock.state.avtransport.state === 'PLAYING');
    const set = actions().slice(mark).find((a) => a.action === 'SetAVTransportURI');
    assert.equal(set.didl.upnpClass, 'object.item.imageItem.photo');
    assert.equal(set.didl.protocolInfo, `http-get:*:image/png:${DLNA_IMAGE_FLAGS}`);
    const head = fetches()[first];
    assert.equal(head.request['transferMode.dlna.org'], 'Interactive');
    assert.equal(head.response['transfermode.dlna.org'], 'Interactive');
    assert.equal(head.response['contentfeatures.dlna.org'], DLNA_IMAGE_FLAGS);
    await sleep(2600); // beyond castStartMs, with polls running: PLAYING at 0:00 is not a stall
    const session = b.value('cast.session');
    assert.deepEqual([session.state, session.position, session.error], ['PLAYING', 0, undefined]);
  });

  test('a cast the TV cannot fetch is accepted by the renderer, then reported as never started', async () => {
    const ack = await b.send('cast.url', { url: 'http://127.0.0.1:9/clip.mp4' }, { timeout: 20000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    await waitFor(() => mock.state.avtransport.status === 'ERROR_OCCURRED');
    const rec = await b.waitForState('cast.session', (r) => r?.v?.error, { timeout: 8000 });
    assert.equal(rec.v.state, 'STOPPED');
    assert.match(rec.v.error, /did not start/);
  });

  test('DIAL: singular path, text/plain with a quoted charset, app Origin, YouTube t=, Netflix and Prime bodies, 401 → Allow on your TV', async () => {
    const n = mock.state.dial.launches.length;
    let ack = await b.send('cast.url', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90' }, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.deepEqual([ack.value.kind, ack.value.title], ['dial', 'YouTube']);
    const yt = mock.state.dial.launches[n];
    assert.deepEqual([yt.name, yt.body, yt.contentType], ['YouTube', 'v=dQw4w9WgXcQ&t=90', 'text/plain; charset="utf-8"']);
    const posted = mock.state.requests.dial.filter((r) => r.method === 'POST').at(-1);
    assert.deepEqual([posted.path, posted.origin], ['/ws/app/YouTube', 'https://www.youtube.com']);

    ack = await b.send('cast.url', { url: 'https://www.netflix.com/title/70153404' }, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.deepEqual([mock.state.dial.launches[n + 1].name, mock.state.dial.launches[n + 1].body],
      ['Netflix', 'm=https://www.netflix.com/watch/70153404&source_type=4']);

    const prime = `https://app.primevideo.com/detail?gti=${GTI}`;
    ack = await b.send('cast.url', { url: prime }, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.deepEqual([mock.state.dial.launches[n + 2].name, mock.state.dial.launches[n + 2].body], ['AmazonInstantVideo', prime]);
    assert.ok(!mock.state.violations.some((v) => v.kind.startsWith('dial-')));

    mock.options.dialAllowed = false;
    try {
      ack = await b.send('cast.url', { url: 'https://youtu.be/dQw4w9WgXcQ' }, { timeout: 15000 });
      assert.equal(ack.ok, false);
      assert.equal(ack.error.code, 'FAILED');
      assert.match(ack.error.message, /^Allow on your TV/);
      assert.equal(mock.state.dial.denied, 1);
    } finally {
      mock.options.dialAllowed = true;
    }
  });

  test('config.cast.netflixPayload picks another candidate', async () => {
    const other = await startStack({ config: { cast: { netflixPayload: 1 } } });
    try {
      const ob = other.browser();
      await ob.hello;
      await ob.waitForState('conn.tv', (r) => r?.v === 'on', { timeout: 8000 });
      const ack = await ob.send('cast.url', { url: 'https://www.netflix.com/title/70153404' }, { timeout: 15000 });
      assert.equal(ack.ok, true, JSON.stringify(ack.error));
      assert.equal(other.mock.state.dial.launches.at(-1).body, PAYLOADS.netflix[1]({ id: '70153404' }));
    } finally {
      await other.stop();
    }
  });

  // Spec §11.3: a page link now opens in Lumen's own browser (test/browser.test.js); the TV browser
  // launch sits behind Open on TV, which uses REST while the agent is offline (none is connected here).
  describe('Open on TV', { skip: skipUnless('server/features/browser.js') }, () => {
    test('REST POST /api/v2/applications/org.tizen.browser with { id: url }, never /webapplication/; -4009 when already in front', async () => {
      const web = await webServer();
      try {
        const n = mock.state.launches.length;
        let ack = await b.send('browser.openOnTv', { url: web.url('/page') }, { timeout: 15000 });
        assert.equal(ack.ok, true, JSON.stringify(ack.error));
        const launch = mock.state.launches[n];
        assert.deepEqual([launch.id, launch.appId, launch.payload], ['org.tizen.browser', BROWSER_APP, web.url('/page')]);
        const posted = mock.state.requests.rest.filter((r) => r.method === 'POST' && r.path.includes('org.tizen.browser'));
        assert.equal(posted[0].path, '/api/v2/applications/org.tizen.browser/');
        assert.equal(JSON.parse(posted[0].body).id, web.url('/page'));
        assert.equal(mock.state.webapps.length, 0, 'the App Launcher container is never used');
        assert.equal(mock.state.apps.get(BROWSER_APP).visible, true);

        ack = await b.send('browser.openOnTv', { url: web.url('/page') }, { timeout: 15000 });
        assert.equal(ack.ok, false);
        assert.match(ack.error.message, /already open/);
        assert.equal(mock.state.launches.length, n + 1, 'the refused launch string was dropped');
      } finally {
        await web.stop();
      }
    });
  });

  test('cast.control stop on a DIAL session sends DELETE on the run location; the adapter lifecycle never does', async () => {
    let ack = await b.send('cast.url', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    const before = mock.state.requests.dial.length;
    ack = await b.send('cast.control', { action: 'stop' }, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(ack.value.state, 'STOPPED');
    // The run location is the app resource plus its <link rel="run" href="run"/> (DIAL §6.4), on the
    // singular /ws/app/ path the TV accepts writes on, with the app's Origin like the launch.
    const deleted = mock.state.requests.dial.slice(before).filter((r) => r.method === 'DELETE');
    assert.deepEqual(deleted.map((r) => [r.path, r.origin]), [['/ws/app/YouTube/run', 'https://www.youtube.com']]);
    assert.match((await request({ port: mock.ports.dial, path: '/ws/app/YouTube' })).body, /<state>stopped<\/state>/);

    // Stopping the server itself must not turn into a DIAL request for an app called "undefined".
    const other = await startStack();
    try {
      await other.server.stop();
      assert.deepEqual(other.mock.state.requests.dial.filter((r) => r.method === 'DELETE'), []);
    } finally {
      await other.mock.stop();
      other.data.cleanup();
    }
  });

  test('agent.launch passes an app id and app-control data to the TV agent, and refuses bad input', async () => {
    const agent = stack.agent();
    await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
    const ack = await b.send('agent.launch', { appId: '3201907018807', data: { PAYLOAD: '{"values":"x"}' } }, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    const launch = agent.requests.findLast((r) => r.type === 'launch');
    assert.equal(launch.appId, '3201907018807');
    assert.deepEqual(launch.data, { PAYLOAD: '{"values":"x"}' });
    for (const bad of [{ appId: 'a b' }, { appId: 'x', operation: 'javascript:alert(1)' }, { appId: 'x', data: [1] }]) {
      const res = await b.send('agent.launch', bad, { timeout: 15000 });
      assert.equal(res.ok, false, JSON.stringify(bad));
      assert.equal(res.error.code, 'INVALID');
    }
    agent.ws.close();
    await b.waitForState('conn.agent', (r) => r?.v !== 'online', { timeout: 30000 });
  });

  test('Netflix links go to the TV agent as a Smart Hub app-control launch when it is online, DIAL otherwise', async () => {
    const agent = stack.agent();
    await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
    const dialBefore = mock.state.dial.launches.length;
    const ack = await b.send('cast.url', { url: 'https://www.netflix.com/title/70153404' }, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    const launch = agent.requests.find((r) => r.type === 'launch');
    assert.ok(launch, 'the agent got a launch request');
    assert.equal(launch.appId, 'org.tizen.netflix-app');
    assert.equal(launch.data.action_play_url, 'm=https://www.netflix.com/watch/70153404&source_type=4');
    assert.equal(launch.data['--app-js'], 'netflix');
    assert.equal(launch.data.callerid, 'com.samsung.tv.csfs');
    assert.deepEqual(Object.keys(launch.data).filter((k) => k.startsWith('__')), [], 'no platform-reserved keys (SecurityError on the TV)');
    assert.equal(mock.state.dial.launches.length, dialBefore, 'no DIAL launch when the agent handled it');
    agent.ws.close();
    await b.waitForState('conn.agent', (r) => r?.v !== 'online', { timeout: 30000 });
    const viaDial = await b.send('cast.url', { url: 'https://www.netflix.com/title/70153404' }, { timeout: 15000 });
    assert.equal(viaDial.ok, true, JSON.stringify(viaDial.error));
    assert.equal(mock.state.dial.launches.length, dialBefore + 1);
  });

  test('the mock saw nothing a correct client must never do', () => {
    assert.deepEqual(mock.state.violations, []);
    assert.deepEqual(mock.state.errors, []);
  });
});
