// VPN (follow-up 3): the in-process WireGuard tunnel (server/vpn/wireguard.js), its loopback HTTP
// proxy (server/vpn/proxy.js), the conf parser (server/vpn/conf.js) and the feature
// (server/features/vpn.js), exercised end to end against the Go user-space test peer on 127.0.0.1
// (test/fixtures/vpn/bin/testpeer.exe; never a real endpoint, never the TV). Every key is generated
// per run by the peer and no assertion message, status, log line or store record may carry one.
// Expectations follow docs/build-notes/followup-3-vpn-port-plan.md §9, §11 and §13.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  skipUnless, skipWithoutTestpeer, startTestPeer, syntheticConf, randomKeyString, waitFor, sleep, request,
  createTestLog, TUNNEL_PEER_IP,
} from './helpers.js';

const CONF = 'server/vpn/conf.js';
const TUNNEL = 'server/vpn/wireguard.js';
const PROXY = 'server/vpn/proxy.js';
const FEATURE = 'server/features/vpn.js';
const skipParse = skipUnless(CONF);
const skipE2e = skipUnless(CONF, TUNNEL, PROXY) || skipWithoutTestpeer();
const skipFeature = skipUnless(CONF, TUNNEL, PROXY, FEATURE) || skipWithoutTestpeer();

const HELLO = 'hello from wg peer\n';

async function loadModules({ feature = false } = {}) {
  const [conf, { createTunnel }, { createVpnProxy }, { LumenError }] = await Promise.all([
    import('../server/vpn/conf.js'), import('../server/vpn/wireguard.js'), import('../server/vpn/proxy.js'), import('../server/errors.js'),
  ]);
  const mods = { ...conf, createTunnel, createVpnProxy, LumenError };
  if (feature) mods.createVpn = (await import('../server/features/vpn.js')).createVpn;
  return mods;
}

/** createTunnel + start(); records the lifecycle events so tests can assert 'up' / 'exit' fired. */
async function bringUp(mods, confText, log, options = {}) {
  const tunnel = mods.createTunnel({ conf: mods.parseWireGuardConf(confText), log, ...options });
  const events = [];
  for (const name of ['up', 'down', 'error', 'exit']) tunnel.on(name, () => events.push(name));
  await tunnel.start();
  return { tunnel, events };
}

/** Waits for status().state === 'up'; the timeout message names the core's state (never a key). */
function untilUp(tunnel, timeout = 8000) {
  return waitFor(() => {
    const s = tunnel.status();
    if (s.state === 'up') return s;
    throw new Error(`state ${s.state}, handshake ${s.handshake}, retries ${s.retries}, lastError ${JSON.stringify(s.lastError ?? '')}`);
  }, { timeout, message: 'tunnel up' });
}

const closable = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });

/** `{ refused: true }` when nothing listens on 127.0.0.1:port, `{ refused: false }` when a connection opens. */
function probePort(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve({ refused: false }); });
    s.once('error', (err) => resolve({ refused: true, code: err.code }));
  });
}

/** A loopback HTTP server that must never be reached while the VPN is enabled (fail closed). */
async function directServer() {
  let connections = 0;
  const server = http.createServer((req, res) => res.end('direct'));
  server.on('connection', () => { connections += 1; });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, connections: () => connections, stop: () => closable(server) };
}

/** GET an absolute URL through the proxy the way a browser does: full URL in the request line + Host. */
function viaProxy(proxyPort, url, { timeout = 8000 } = {}) {
  return request({ port: proxyPort, path: url, headers: { Host: new URL(url).host }, timeout });
}

/** Collects a socket until it ends/closes → Buffer (prefixed with `initial`). */
function readAll(socket, initial = Buffer.alloc(0), { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [initial];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no end of stream within ${timeout} ms`)); }, timeout);
    const done = () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); };
    socket.on('data', (c) => chunks.push(c));
    socket.once('end', done);
    socket.once('close', done);
    socket.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Raw `CONNECT authority` through the proxy → { status, header, socket, head }. After a 200 the
 * socket carries the tunnelled bytes; otherwise `head` holds whatever body followed the header.
 */
function connectVia(proxyPort, authority, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: proxyPort });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`CONNECT ${authority}: no response within ${timeout} ms`)); }, timeout);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      clearTimeout(timer);
      socket.off('data', onData);
      const header = buf.subarray(0, end).toString('latin1');
      resolve({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(header)?.[1]), header, socket, head: buf.subarray(end + 4) });
    };
    socket.on('data', onData);
    socket.once('error', (err) => { clearTimeout(timer); reject(err); });
    socket.once('close', () => { clearTimeout(timer); reject(new Error(`CONNECT ${authority}: closed without a response`)); });
    socket.once('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
  });
}

/** Live worker threads of this process (the tunnel worker and, nested in it, the shim's I/O worker). */
function workerThreads() {
  const count = (report) => (report.workers ?? []).reduce((n, w) => n + 1 + count(w), 0);
  return count(process.report.getReport());
}

/** The 'error' (or 'connect', reported as an Error) of a tunnel Duplex. */
function duplexOutcome(stream) {
  return new Promise((resolve) => {
    stream.once('error', resolve);
    stream.once('connect', () => resolve(Object.assign(new Error('connected'), { code: 'connected' })));
  });
}

// ---------------------------------------------------------------------------------------------

describe('vpn: conf.js parses and serializes WireGuard confs without leaking keys', { skip: skipParse }, () => {
  let parseWireGuardConf, serializeWireGuardConf, summarizeWireGuardConf, LumenError;
  before(async () => {
    ({ parseWireGuardConf, serializeWireGuardConf, summarizeWireGuardConf } = await import('../server/vpn/conf.js'));
    ({ LumenError } = await import('../server/errors.js'));
  });

  test('a Proton-shaped conf (CRLF, comments, trailing comment, IPv6 AllowedIPs) parses to the §9.2 shape', () => {
    const presharedKey = randomKeyString();
    const { text, privateKey, publicKey } = syntheticConf({ presharedKey });
    const conf = parseWireGuardConf(text);
    assert.equal(conf.privateKey, privateKey);
    assert.equal(conf.address.length, 1);
    assert.match(conf.address[0], /^10\.2\.0\.2(\/32)?$/);
    assert.deepEqual(conf.dns, ['10.2.0.1']);
    assert.equal(conf.peer.publicKey, publicKey);
    assert.equal(conf.peer.presharedKey, presharedKey);
    assert.equal(conf.peer.endpoint, '185.107.56.1:51820', 'trailing comment stripped from Endpoint');
    assert.deepEqual(conf.peer.allowedIPs, ['0.0.0.0/0', '::/0']);
    assert.equal(conf.peer.keepalive, 25);

    const plain = parseWireGuardConf(syntheticConf({ keepalive: null, eol: '\n' }).text);
    assert.equal(plain.peer.presharedKey ?? undefined, undefined);
    assert.equal(plain.peer.keepalive ?? undefined, undefined);
  });

  test('summarizeWireGuardConf carries endpoint, addresses and an 8-char public-key prefix, never a key', () => {
    const { text, privateKey, publicKey } = syntheticConf();
    const summary = summarizeWireGuardConf(parseWireGuardConf(text));
    const json = JSON.stringify(summary);
    assert.equal(summary.endpoint, '185.107.56.1:51820');
    assert.equal(summary.publicKeyPrefix, publicKey.slice(0, 8));
    assert.equal(summary.keepalive, 25);
    assert.ok(json.includes('10.2.0.2') && json.includes('10.2.0.1'), 'address and dns are summarized');
    assert.equal(json.includes(privateKey), false, 'summary leaks the private key');
    assert.equal(json.includes(publicKey), false, 'summary carries the full public key');
  });

  test('serializeWireGuardConf: canonical LF text, no comments, keepalive default 25, PresharedKey only when present', () => {
    const noKeepalive = syntheticConf({ keepalive: null });
    const mask = (s, c) => s.replaceAll(c.privateKey, '<priv>').replaceAll(c.publicKey, '<pub>').replaceAll(c.presharedKey ?? '\u0000', '<psk>');
    const out = serializeWireGuardConf(parseWireGuardConf(noKeepalive.text));
    assert.equal(out.includes('\r'), false, 'CRLF survived');
    assert.equal(out.includes('#'), false, 'a comment survived');
    assert.deepEqual(mask(out, noKeepalive).split('\n').filter(Boolean), [
      '[Interface]', 'PrivateKey = <priv>', 'Address = 10.2.0.2/32', 'DNS = 10.2.0.1',
      '[Peer]', 'PublicKey = <pub>', 'AllowedIPs = 0.0.0.0/0', 'Endpoint = 185.107.56.1:51820', 'PersistentKeepalive = 25',
    ]);
    assert.match(serializeWireGuardConf(parseWireGuardConf(noKeepalive.text), { keepalive: 7 }), /^PersistentKeepalive = 7$/m);

    const withPsk = syntheticConf({ presharedKey: randomKeyString(), keepalive: 10 });
    const lines = mask(serializeWireGuardConf(parseWireGuardConf(withPsk.text)), withPsk).split('\n');
    assert.ok(lines.includes('PresharedKey = <psk>'), 'PresharedKey line present when configured');
    assert.ok(lines.indexOf('PresharedKey = <psk>') > lines.indexOf('PublicKey = <pub>'), 'PresharedKey belongs to [Peer]');
    assert.ok(lines.includes('PersistentKeepalive = 10'), 'the conf keepalive wins over the default');
  });

  test('parse errors are LumenError INVALID with the §9.2 messages and never echo a value', () => {
    const cases = [
      ['missing PrivateKey', syntheticConf({ omit: ['PrivateKey'] }), /PrivateKey is missing/],
      ['PrivateKey not base64', syntheticConf({ privateKey: 'not*base64' }), /PrivateKey is not a 32-byte base64 key/],
      ['missing PublicKey', syntheticConf({ omit: ['PublicKey'] }), /PublicKey is missing/],
      ['PublicKey not base64', syntheticConf({ publicKey: 'not*base64' }), /PublicKey is not a 32-byte base64 key/],
      ['PublicKey of 31 bytes', syntheticConf({ publicKey: crypto.randomBytes(31).toString('base64') }), /PublicKey is not a 32-byte base64 key/],
      ['PresharedKey too short', syntheticConf({ presharedKey: 'c2hvcnQ=' }), /PresharedKey is not a 32-byte base64 key/],
      ['missing Address', syntheticConf({ omit: ['Address'] }), /Address needs an IPv4 entry/],
      ['IPv6-only Address', syntheticConf({ address: 'fd00:1::2/128' }), /Address needs an IPv4 entry/],
      ['missing DNS', syntheticConf({ omit: ['DNS'] }), /DNS needs an IPv4 server/],
      ['Endpoint without port', syntheticConf({ endpoint: '185.107.56.1' }), /Endpoint needs host:port/],
      ['Endpoint IPv6 literal', syntheticConf({ endpoint: '[2001:db8::1]:51820' }), /Endpoint host may only contain letters, digits, dots and dashes/],
      ['file over 16 KB', syntheticConf({ extraLines: Array.from({ length: 400 }, (_, i) => `# padding ${i} ${'x'.repeat(40)}`) }), /larger than 16 KB/],
      ['line over 599 bytes', syntheticConf({ extraLines: [`# ${'y'.repeat(700)}`] }), /line \d+ is longer than 599 bytes/],
      ['second [Peer]', syntheticConf({ extraLines: ['[Peer]', `PublicKey = ${randomKeyString()}`, 'Endpoint = 192.0.2.1:51820'] }), /peer/i],
    ];
    for (const [label, { text, privateKey, publicKey }, re] of cases) {
      let err = null;
      try { parseWireGuardConf(text); } catch (e) { err = e; }
      assert.ok(err, `${label}: parse should throw`);
      assert.ok(err instanceof LumenError, `${label}: expected LumenError, got ${err.name}`);
      assert.equal(err.code, 'INVALID', label);
      assert.match(err.message, re, label);
      const echoed = err.message.includes(privateKey) || err.message.includes(publicKey) || err.message.includes('not*base64');
      assert.equal(echoed, false, `${label}: the error message echoes a conf value`);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('vpn: tunnel + proxy end to end through the Go test peer on 127.0.0.1', { skip: skipE2e }, () => {
  let mods, log, peer, tunnel, events, proxy;
  const startedAt = Date.now();

  before(async () => {
    mods = await loadModules();
    log = createTestLog();
    peer = await startTestPeer();
    ({ tunnel, events } = await bringUp(mods, peer.conf, log));
    await untilUp(tunnel);
    proxy = mods.createVpnProxy({ tunnel, log });
    await proxy.start();
  });
  after(async () => {
    await proxy?.stop().catch(() => {});
    await tunnel?.stop().catch(() => {});
    await peer?.close();
  });

  test('handshake: status() reports up/ok, the peer endpoint, counters and the hub port — never a key', async (t) => {
    const st = tunnel.status();
    t.diagnostic(`peer spawn + wasm start + handshake: ${Date.now() - startedAt} ms before the first test`);
    assert.equal(st.state, 'up');
    assert.equal(st.handshake, 'ok');
    assert.equal(st.linked, true);
    assert.equal(st.endpoint, `127.0.0.1:${peer.port}`);
    assert.ok(st.rx > 0 && st.tx > 0, `rx ${st.rx} tx ${st.tx}`);
    assert.ok(typeof st.handshakeAgeMs === 'number' && st.handshakeAgeMs >= 0, `handshakeAgeMs ${st.handshakeAgeMs}`);
    assert.equal(typeof st.uptimeMs, 'number');
    assert.equal(st.streams, 0);
    assert.equal(typeof proxy.port, 'number');
    assert.equal(typeof tunnel.port, 'number');
    assert.ok(events.includes('up'), `events so far: ${events.join(',') || 'none'}`);
    await peer.waitForLog(/handshake ok/, 3000);
    assert.equal(peer.containsKey(JSON.stringify(st)), false, 'status() leaks a key');
    assert.equal(peer.containsKey(log.text()), false, 'the tunnel/proxy log leaks a key');
  });

  test('DNS: names resolve inside the tunnel via the conf DNS server; IPv4 literals resolve to themselves', async (t) => {
    // `.test` never resolves on the public internet: 10.66.0.1 can only come from the peer's responder.
    const t0 = Date.now();
    assert.equal(await tunnel.resolve('anything.test'), TUNNEL_PEER_IP);
    t.diagnostic(`resolve anything.test through the tunnel: ${Date.now() - t0} ms`);
    assert.equal(await tunnel.resolve('lumen-vpn-check.example'), TUNNEL_PEER_IP);
    assert.equal(await tunnel.resolve(TUNNEL_PEER_IP), TUNNEL_PEER_IP);
  });

  test('proxy, absolute-URI: GET http://10.66.0.1/hello and GET http://anything.test/hello return the peer body', async (t) => {
    const t0 = Date.now();
    const byIp = await viaProxy(proxy.port, `http://${TUNNEL_PEER_IP}/hello`);
    t.diagnostic(`GET /hello via proxy: ${Date.now() - t0} ms`);
    assert.equal(byIp.status, 200);
    assert.equal(byIp.body, HELLO);
    // The hostname travels to the tunnel core untouched: neither Edge nor Lumen resolves it locally.
    const byName = await viaProxy(proxy.port, 'http://anything.test/hello');
    assert.equal(byName.status, 200);
    assert.equal(byName.body, HELLO);
  });

  test('proxy, CONNECT: 200 then raw HTTP to the peer, by IP and by a name the core resolves in-tunnel', async () => {
    for (const host of [TUNNEL_PEER_IP, 'anything.test']) {
      const { status, header, socket, head } = await connectVia(proxy.port, `${host}:80`);
      assert.equal(status, 200, `CONNECT ${host}:80 → ${header.split('\r\n')[0]}`);
      socket.write(`GET /hello HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      const reply = (await readAll(socket, head)).toString('latin1');
      assert.match(reply, /^HTTP\/1\.[01] 200 OK\r\n/, `reply to GET over CONNECT ${host}`);
      assert.ok(reply.endsWith(HELLO), `body tail: ${JSON.stringify(reply.slice(-40))}`);
    }
    await waitFor(() => tunnel.status().streams === 0, { timeout: 5000, message: 'streams released after the peer closed them' });
  });

  test('DNS burst: 60 concurrent CONNECTs to 30 distinct new names all open (lwIP holds only DNS_TABLE_SIZE lookups at once)', { timeout: 30000 }, async (t) => {
    // Before the hub resolved names itself, everything past lwIP's 8 pending lookups got an instant
    // 502 "vpn: dns-failed" (heavy pages showed ERR_TUNNEL_CONNECTION_FAILED).
    const names = Array.from({ length: 30 }, (_, i) => `burst-${i}-${crypto.randomBytes(3).toString('hex')}.test`);
    const t0 = Date.now();
    const opened = await Promise.all([...names, ...names].map((name) => connectVia(proxy.port, `${name}:80`, { timeout: 20000 })));
    t.diagnostic(`60 CONNECTs, 30 new names: ${Date.now() - t0} ms`);
    try {
      const bad = opened.filter((c) => c.status !== 200).map((c) => `${c.status} ${c.head.toString('latin1').trim()}`);
      assert.deepEqual(bad, [], 'every CONNECT got 200');
      const c = opened[0];
      c.socket.write(`GET /hello HTTP/1.1\r\nHost: ${names[0]}\r\nConnection: close\r\n\r\n`);
      assert.ok((await readAll(c.socket, c.head)).toString('latin1').endsWith(HELLO), 'a stream opened by name carries traffic');
    } finally {
      for (const c of opened) c.socket.destroy();
    }
    // Answers are shared: the same names again come from the hub's short cache.
    const t1 = Date.now();
    assert.deepEqual(await Promise.all(names.map((n) => tunnel.resolve(n))), names.map(() => TUNNEL_PEER_IP));
    t.diagnostic(`30 cached names again: ${Date.now() - t1} ms`);
    await waitFor(() => tunnel.status().streams === 0, { timeout: 8000, message: 'burst streams released' });
  });

  test('proxy rejects what no browser sends a proxy: relative paths, https:// URLs, bad CONNECT authorities (400)', async () => {
    assert.equal((await request({ port: proxy.port, path: '/hello' })).status, 400, 'relative path');
    assert.equal((await viaProxy(proxy.port, `https://${TUNNEL_PEER_IP}/hello`)).status, 400, 'https absolute-URI');
    for (const authority of [TUNNEL_PEER_IP, `${TUNNEL_PEER_IP}:0`, `${TUNNEL_PEER_IP}:70000`, '[::1]:80']) {
      const { status, socket } = await connectVia(proxy.port, authority);
      socket.destroy();
      assert.equal(status, 400, `CONNECT ${authority}`);
    }
  });

  test('throughput smoke: a 5 MiB blob arrives intact through the proxy in under 15 s', { timeout: 30000 }, async (t) => {
    const bytes = 5 * 1024 * 1024;
    const t0 = Date.now();
    const got = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: proxy.port, path: `http://${TUNNEL_PEER_IP}/blob?bytes=${bytes}`, headers: { Host: TUNNEL_PEER_IP }, agent: false,
      }, (res) => {
        let total = 0;
        let bad = 0;
        res.on('data', (c) => { total += c.length; for (let i = 0; i < c.length; i += 1) if (c[i] !== 0x5a) bad += 1; });
        res.on('end', () => resolve({ status: res.statusCode, total, bad, length: Number(res.headers['content-length']) }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(25000, () => req.destroy(new Error('blob timed out')));
      req.end();
    });
    const seconds = (Date.now() - t0) / 1000;
    assert.equal(got.status, 200);
    assert.equal(got.length, bytes, 'Content-Length copied from upstream');
    assert.equal(got.total, bytes, 'body length');
    assert.equal(got.bad, 0, 'every byte is 0x5a');
    assert.ok(seconds < 15, `took ${seconds.toFixed(1)} s`);
    t.diagnostic(`5 MiB via proxy: ${((bytes * 8) / seconds / 1e6).toFixed(1)} Mbit/s in ${seconds.toFixed(2)} s`);
  });

  test('stream capacity: 200 concurrent CONNECTs are carried at once (the rebuilt core allows 260; the original 32)', { timeout: 40000 }, async () => {
    const held = [];
    try {
      const opened = await Promise.all(Array.from({ length: 200 }, () => connectVia(proxy.port, `${TUNNEL_PEER_IP}:80`, { timeout: 20000 })));
      for (const [i, c] of opened.entries()) {
        held.push(c.socket);
        assert.equal(c.status, 200, `CONNECT #${i + 1}`);
      }
      await waitFor(() => tunnel.status().streams === 200, { timeout: 15000, message: `200 open streams (now ${tunnel.status().streams})` });
    } finally {
      for (const s of held) s.destroy();
    }
    await waitFor(() => tunnel.status().streams === 0, { timeout: 8000, message: 'held streams released' });
  });

  test('a full proxy closes the longest-idle tunnel for a newcomer instead of failing it', { timeout: 40000 }, async () => {
    const small = mods.createVpnProxy({ tunnel, log, maxStreams: 3, idleEvictMs: 300 });
    await small.start();
    const held = [];
    try {
      for (let i = 0; i < 3; i += 1) {
        const c = await connectVia(small.port, `${TUNNEL_PEER_IP}:80`);
        assert.equal(c.status, 200, `CONNECT #${i + 1}`);
        held.push(c);
        await sleep(50);
      }
      const closed = held.map((c) => new Promise((resolve) => c.socket.once('close', () => resolve(true))));
      const t0 = Date.now();
      const late = await connectVia(small.port, `${TUNNEL_PEER_IP}:80`, { timeout: 8000 });
      assert.equal(late.status, 200, 'the fourth CONNECT gets a slot');
      assert.ok(Date.now() - t0 < 3000, `it got one quickly (${Date.now() - t0} ms), not after the 10 s queue`);
      assert.equal(await Promise.race([closed[0], sleep(2000).then(() => false)]), true, 'the oldest idle tunnel was closed for it');
      held.push(late);
    } finally {
      for (const c of held) c.socket.destroy();
      await small.stop();
    }
    await waitFor(() => tunnel.status().streams === 0, { timeout: 8000, message: 'held streams released' });
  });

  test('stop(): state stopped, hub and proxy ports closed, worker threads gone, idempotent; connect() then fails closed', { timeout: 15000 }, async (t) => {
    const hubPort = tunnel.port;
    const proxyPort = proxy.port;
    const workersBefore = workerThreads();
    assert.ok(workersBefore >= 1, `the tunnel runs in a worker thread (report lists ${workersBefore})`);
    await proxy.stop();
    await tunnel.stop();
    assert.equal(tunnel.status().state, 'stopped');
    // A requested stop is not a failure: 'exit' / 'error' are the worker-death signals the feature restarts on (§11.4).
    assert.deepEqual(events.filter((e) => e === 'exit' || e === 'error'), [], `events: ${events.join(',')}`);
    await waitFor(() => workerThreads() === 0, { timeout: 3000, message: `worker threads after stop (${workerThreads()} left)` });
    t.diagnostic(`worker threads: ${workersBefore} while up, 0 after stop()`);
    assert.equal((await probePort(hubPort)).refused, true, 'the hub listener is still open');
    assert.equal((await probePort(proxyPort)).refused, true, 'the proxy is still listening');
    await tunnel.stop();
    await proxy.stop();
    assert.equal((await duplexOutcome(tunnel.connect(TUNNEL_PEER_IP, 80))).code, 'vpn-tunnel-down');
    await peer.close();
    assert.equal(peer.containsKey(log.text()), false, 'the log leaks a key');
  });
});

// ---------------------------------------------------------------------------------------------

describe('vpn: fail closed (never a direct connection while the switch is on)', { skip: skipE2e }, () => {
  test('tunnel never up (wrong peer key): 502 for CONNECT and absolute-URI, direct server untouched, API errors vpn-tunnel-down', { timeout: 30000 }, async (t) => {
    const mods = await loadModules();
    const log = createTestLog();
    const peer = await startTestPeer();
    const direct = await directServer();
    let tunnel, proxy;
    try {
      ({ tunnel } = await bringUp(mods, peer.wrongPeerConf, log));
      proxy = mods.createVpnProxy({ tunnel, log });
      await proxy.start();
      assert.notEqual(tunnel.status().state, 'up');

      const t0 = Date.now();
      const c = await connectVia(proxy.port, `127.0.0.1:${direct.port}`);
      const body = (await readAll(c.socket, c.head)).toString();
      assert.equal(c.status, 502, `CONNECT → ${c.header.split('\r\n')[0]}`);
      assert.match(body, /vpn/, 'the 502 body names the vpn');
      assert.equal((await viaProxy(proxy.port, `http://127.0.0.1:${direct.port}/`)).status, 502, 'absolute-URI GET');
      t.diagnostic(`two 502s while handshaking: ${Date.now() - t0} ms`);

      assert.equal((await duplexOutcome(tunnel.connect('127.0.0.1', direct.port))).code, 'vpn-tunnel-down');
      await assert.rejects(tunnel.resolve('anything.test'), { code: 'vpn-tunnel-down' });
      assert.equal(direct.connections(), 0, 'the direct server was reached');

      // The core keeps retrying the handshake (REKEY_TIMEOUT 5 s) instead of giving up or falling back.
      const st = await waitFor(() => { const s = tunnel.status(); return s.retries >= 1 ? s : null; }, { timeout: 9000, message: 'a handshake retry' });
      assert.equal(st.handshake, 'pending');
      assert.equal(st.state, 'handshaking');
      assert.equal(direct.connections(), 0);
    } finally {
      await proxy?.stop().catch(() => {});
      await tunnel?.stop().catch(() => {});
      await peer.close();
      await direct.stop();
    }
  });

  test('peer gone: after the peer exits, CONNECT and GET through the proxy get 502 and the direct server stays untouched', { timeout: 40000 }, async (t) => {
    const mods = await loadModules();
    const log = createTestLog();
    const peer = await startTestPeer();
    const direct = await directServer();
    let tunnel, proxy;
    try {
      ({ tunnel } = await bringUp(mods, peer.conf, log, { openTimeoutMs: 2000 }));
      await untilUp(tunnel);
      proxy = mods.createVpnProxy({ tunnel, log });
      await proxy.start();
      assert.equal((await viaProxy(proxy.port, `http://${TUNNEL_PEER_IP}/hello`)).body, HELLO, 'sanity: traffic flows before the peer dies');

      await peer.close();
      const t0 = Date.now();
      const [c, g, h] = await Promise.all([
        connectVia(proxy.port, `127.0.0.1:${direct.port}`, { timeout: 15000 }),
        viaProxy(proxy.port, `http://127.0.0.1:${direct.port}/`, { timeout: 15000 }),
        viaProxy(proxy.port, `http://${TUNNEL_PEER_IP}/hello`, { timeout: 15000 }),
      ]);
      c.socket.destroy();
      t.diagnostic(`three 502s with the peer gone: ${Date.now() - t0} ms (tunnel state now ${tunnel.status().state})`);
      assert.equal(c.status, 502, 'CONNECT to a loopback server');
      assert.equal(g.status, 502, 'absolute-URI GET to a loopback server');
      assert.equal(h.status, 502, 'absolute-URI GET to the dead peer');
      assert.equal(direct.connections(), 0, 'the direct server was reached');
    } finally {
      await proxy?.stop().catch(() => {});
      await tunnel?.stop().catch(() => {});
      await peer.close();
      await direct.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('vpn: keepalive and re-handshake', { skip: skipE2e }, () => {
  test('PersistentKeepalive = 1 keeps sending with no streams open (tx grows by ≥ 64 wire bytes in 4.5 s)', { timeout: 30000 }, async (t) => {
    const mods = await loadModules();
    const log = createTestLog();
    const peer = await startTestPeer({ keepalive: 1 });
    let tunnel;
    try {
      ({ tunnel } = await bringUp(mods, peer.conf, log));
      await untilUp(tunnel);
      await sleep(300);
      // Status posts are ≤ 1 Hz, so both readings can be up to 1 s stale: 4.5 s guarantees ≥ 3 keepalives in view.
      const tx0 = tunnel.status().tx;
      await sleep(4500);
      const grew = tunnel.status().tx - tx0;
      t.diagnostic(`tx grew by ${grew} bytes over 4.5 s (keepalive = 32 bytes each)`);
      assert.ok(grew >= 64, `tx grew by ${grew} bytes, expected at least 64`);
      assert.equal(tunnel.status().streams, 0);
    } finally {
      await tunnel?.stop().catch(() => {});
      await peer.close();
    }
  });

  test('re-handshake after the keys expire', {
    skip: 'needs 180 s of wall time (REKEY_AFTER_TIME 120 s, REJECT_AFTER_TIME 180 s) and the Go peer never initiates',
  }, () => {});
});

// ---------------------------------------------------------------------------------------------

describe('vpn: features/vpn.js state keys, persistence and fail-closed proxyUrl()', { skip: skipFeature }, () => {
  let mods, peer, dir, config, data, store, log, vpn;
  const key = (k) => store.get(k)?.v;
  const confPath = () => path.join(dir, 'vpn', 'wg.conf');
  const ctx = () => ({ config, data, log, store, lan: null });
  const FEATURE_STATUS_KEYS = ['state', 'enabled', 'endpoint', 'handshakeAgeS', 'bytesIn', 'bytesOut', 'error', 'proxyPort'];
  /** Records every value written to vpn.state (the store batches patches, so a flash could hide in a patch). */
  function recordStates() {
    const seen = [];
    const original = store.set;
    store.set = (k, v, meta) => { if (k === 'vpn.state') seen.push(v); return original(k, v, meta); };
    return { seen, restore: () => { store.set = original; } };
  }

  before(async () => {
    mods = await loadModules({ feature: true });
    const { loadConfig, createDataStore } = await import('../server/config.js');
    const { createStore } = await import('../server/store.js');
    peer = await startTestPeer();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-vpn-'));
    config = loadConfig({ dataDir: dir, log: { level: 'warn', console: false } });
    data = createDataStore(dir);
    store = createStore({});
    log = createTestLog();
  });
  after(async () => {
    await vpn?.stop().catch(() => {});
    await peer?.close();
    await store?.stop({ save: false });
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  test('no conf → unconfigured with a one-line error; enable() is refused and nothing is persisted as enabled', async () => {
    vpn = mods.createVpn(ctx());
    await vpn.start();
    assert.equal(key('vpn.state'), 'unconfigured');
    assert.equal(typeof key('vpn.error'), 'string');
    assert.ok(key('vpn.error').length > 0 && !key('vpn.error').includes('\n'), 'vpn.error is one line');
    assert.equal(key('vpn.enabled'), false);
    assert.ok(key('vpn.endpoint') == null, 'no endpoint while unconfigured');
    assert.equal(vpn.proxyUrl(), null);
    assert.equal(store.get('vpn.state').src, 'derived');
    assert.equal(store.get('vpn.state').via, 'vpn');
    await assert.rejects(vpn.enable(), (err) => err instanceof mods.LumenError && err.code === 'INVALID');
    assert.equal(key('vpn.enabled'), false);
    assert.equal(data.readJson('vpn/state.json', { enabled: false }).enabled, false);
    assert.equal(vpn.proxyUrl(), null);
    await vpn.stop();
    vpn = null;
  });

  test('valid conf, disabled → off with the endpoint and no proxy; reload() follows the file', async () => {
    fs.mkdirSync(path.dirname(confPath()), { recursive: true });
    fs.writeFileSync(confPath(), peer.conf);
    vpn = mods.createVpn(ctx());
    await vpn.start();
    assert.equal(key('vpn.state'), 'off');
    assert.equal(key('vpn.endpoint'), `127.0.0.1:${peer.port}`);
    assert.ok(key('vpn.error') == null, `vpn.error should be empty, got ${JSON.stringify(key('vpn.error'))}`);
    assert.equal(key('vpn.enabled'), false);
    assert.equal(vpn.proxyUrl(), null);
    assert.ok(key('vpn.proxyPort') == null);

    fs.rmSync(confPath());
    await vpn.reload();
    assert.equal(key('vpn.state'), 'unconfigured');
    fs.writeFileSync(confPath(), peer.conf);
    await vpn.reload();
    assert.equal(key('vpn.state'), 'off');
    assert.equal(peer.containsKey(JSON.stringify(store.snapshot())), false, 'the store leaks a key');
  });

  test('enable() → connecting/up with proxyPort and counters, traffic flows; disable() → off and the old port refuses', { timeout: 30000 }, async (t) => {
    const states = recordStates();
    const res = await vpn.enable();
    assert.equal(key('vpn.enabled'), true);
    assert.equal(data.readJson('vpn/state.json').enabled, true, 'enabled persisted');
    const port = key('vpn.proxyPort');
    assert.equal(typeof port, 'number');
    assert.equal(vpn.proxyUrl(), `http://127.0.0.1:${port}`);
    assert.ok(['connecting', 'up'].includes(key('vpn.state')), `state right after enable(): ${key('vpn.state')}`);
    assert.ok(res && typeof res === 'object' && res.value && res.value.enabled === true, 'enable() resolves { value: status() }');
    await waitFor(() => key('vpn.state') === 'up', { timeout: 8000, message: `vpn.state up (now ${key('vpn.state')}, error ${JSON.stringify(key('vpn.error'))})` });
    states.restore();
    // A healthy switch-on publishes connecting → up and nothing else: no flash of 'error' before the tunnel starts.
    assert.deepEqual(states.seen, ['connecting', 'up'], `vpn.state sequence during enable(): ${states.seen.join(' → ')}`);

    const hello = await viaProxy(port, `http://${TUNNEL_PEER_IP}/hello`);
    assert.equal(hello.status, 200);
    assert.equal(hello.body, HELLO);
    await waitFor(() => key('vpn.bytesIn') > 0 && key('vpn.bytesOut') > 0, { timeout: 5000, message: 'byte counters' });
    assert.equal(typeof key('vpn.handshakeAgeS'), 'number');
    assert.ok(key('vpn.error') == null, `vpn.error while up: ${JSON.stringify(key('vpn.error'))}`);
    const st = vpn.status();
    for (const k of FEATURE_STATUS_KEYS) assert.ok(k in st, `status() has ${k}`);
    assert.equal(st.state, 'up');
    assert.equal(st.enabled, true);
    assert.equal(st.proxyPort, port);
    assert.equal(st.endpoint, `127.0.0.1:${peer.port}`);
    t.diagnostic(`feature up: bytesIn ${key('vpn.bytesIn')} bytesOut ${key('vpn.bytesOut')} handshakeAgeS ${key('vpn.handshakeAgeS')}`);

    await vpn.disable();
    assert.equal(key('vpn.state'), 'off');
    assert.equal(key('vpn.enabled'), false);
    assert.ok(key('vpn.proxyPort') == null, 'proxyPort cleared');
    assert.equal(vpn.proxyUrl(), null);
    assert.equal(data.readJson('vpn/state.json').enabled, false, 'disabled persisted');
    assert.equal((await probePort(port)).refused, true, 'the old proxy port still accepts connections');
    assert.equal(peer.containsKey(log.text()), false, 'the log leaks a key');
    assert.equal(peer.containsKey(JSON.stringify(store.snapshot())), false, 'the store leaks a key');
    await vpn.stop();
    vpn = null;
  });

  test('persisted enabled:true comes up at start(); stop() closes the proxy and keeps the switch persisted', { timeout: 30000 }, async () => {
    data.writeJson('vpn/state.json', { enabled: true });
    vpn = mods.createVpn(ctx());
    const states = recordStates();
    await vpn.start();
    assert.equal(key('vpn.enabled'), true);
    await waitFor(() => key('vpn.state') === 'up', { timeout: 10000, message: `vpn.state up (now ${key('vpn.state')})` });
    states.restore();
    assert.deepEqual(states.seen, ['connecting', 'up'], `vpn.state sequence at start(): ${states.seen.join(' → ')}`);
    const port = key('vpn.proxyPort');
    assert.equal(typeof port, 'number');
    assert.equal(vpn.proxyUrl(), `http://127.0.0.1:${port}`);
    assert.equal((await viaProxy(port, `http://${TUNNEL_PEER_IP}/hello`)).body, HELLO);
    await vpn.stop();
    vpn = null;
    assert.equal((await probePort(port)).refused, true, 'the proxy port is still open after stop()');
    assert.equal(data.readJson('vpn/state.json').enabled, true, 'stop() must not flip the persisted switch');
  });
});
