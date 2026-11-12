// The embedded host (server/embedded-host.js): the server inside an app, rebuilt in place after a
// pause. Runs against the mock TV like every other suite; nothing here needs an iPad.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startMockTv } from './mock-tv.js';
import { connectBrowser, makeDataDir, request, testConfig, waitFor } from './helpers.js';
import { canConnect, createPauseWatch, startEmbeddedHost } from '../server/embedded-host.js';

// A port that is free now, to keep across restarts (the app's port is fixed too).
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

describe('pause watch', () => {
  test('tells no pause, a short one and a long one apart', () => {
    let t = 1000;
    const watch = createPauseWatch({ now: () => t, shortMs: 8000, longMs: 30000 });
    t += 2000;
    assert.equal(watch.tick(), 'none');
    t += 9000;
    assert.equal(watch.tick(), 'short');
    t += 2000;
    assert.equal(watch.tick(), 'none', 'the gap is measured from the previous tick');
    t += 45000;
    assert.equal(watch.tick(), 'long');
  });
});

describe('embedded host', () => {
  let mock;
  let data;
  let host;
  let httpPort;
  let lanPort;
  let clock = 0; // added to the real time: moving it forward looks like a pause to the host
  const clients = [];

  const status = () => JSON.parse(fs.readFileSync(host.statusFile, 'utf8'));
  const health = async () => JSON.parse((await request({ port: httpPort, path: '/api/health' })).body);
  const browser = () => {
    const client = connectBrowser(httpPort);
    clients.push(client);
    return client;
  };

  before(async () => {
    mock = await startMockTv({ power: 'on' });
    data = makeDataDir({ remoteToken: mock.tokens.remote, ipcToken: mock.tokens.ipc });
    httpPort = await freePort();
    lanPort = await freePort();
    host = await startEmbeddedHost({
      dataDir: data.dir,
      overrides: testConfig(mock, data.dir, { http: { port: httpPort }, lan: { port: lanPort } }),
      tickMs: 3600_000, // the tests call check() themselves
      retryMs: 0,
      now: () => Date.now() + clock,
    });
  });

  after(async () => {
    for (const client of clients) client.close();
    await host?.stop();
    await mock?.stop();
    data?.cleanup();
  });

  test('starts the server as an embedded host and says so in host-status.json', async () => {
    assert.ok(host.server, 'the server started');
    assert.equal(host.server.config.embedded, true);
    assert.equal(host.server.config.ai.backend, 'api', 'no Claude Code login inside an app');
    assert.equal(host.server.config.update.enabled, false);
    const s = status();
    assert.equal(s.state, 'ready');
    assert.equal(s.generation, 1);
    assert.equal(s.httpPort, httpPort);
    assert.equal(s.lanPort, lanPort);
    assert.equal((await health()).ready, true);

    const b = browser();
    await b.hello;
    assert.equal(b.value('host.embedded'), true);
    await b.waitForState('conn.tv', (r) => r?.v === 'on', { timeout: 10000 });
  });

  test('no pause and healthy listeners: nothing is restarted', async () => {
    clock += 2000;
    assert.equal(await host.check(), false);
    assert.equal(host.generation, 1);
  });

  test('a short pause with healthy listeners: nothing is restarted', async () => {
    clock += 10000;
    assert.equal(await host.check(), false);
    assert.equal(host.generation, 1);
  });

  test('a long pause: the server is rebuilt in place, on the same ports, and reaches the TV again', async () => {
    const before = host.server;
    clock += 60000;
    assert.equal(await host.check(), true);
    assert.equal(host.generation, 2);
    assert.notEqual(host.server, before, 'a new server object');

    const s = status();
    assert.equal(s.state, 'ready');
    assert.equal(s.generation, 2);
    assert.match(s.reason, /long pause/);
    assert.equal(s.httpPort, httpPort);
    assert.equal(s.lanPort, lanPort);
    assert.equal((await health()).ready, true);

    const b = browser();
    await b.hello;
    await b.waitForState('conn.tv', (r) => r?.v === 'on', { timeout: 10000 });
    const ack = await b.send('volume.set', { value: 31 }, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(mock.state.volume, 31);
  });

  test('the first check after a restart does not count the restart itself as a pause', async () => {
    clock += 2000;
    assert.equal(await host.check(), false);
    assert.equal(host.generation, 2);
  });

  test('the app asks through host-control.json: restarted once per new request', async () => {
    fs.writeFileSync(host.controlFile, JSON.stringify({ restart: 'request-1' }));
    assert.equal(await host.check(), true);
    assert.equal(host.generation, 3);
    assert.match(status().reason, /app asked/);

    assert.equal(await host.check(), false, 'the same request is not acted on twice');
    assert.equal(host.generation, 3);
    assert.equal((await health()).ready, true);
  });

  test('a short pause after which a listener is gone: restarted', async () => {
    // Close the page-facing listener behind the host's back, as a reclaimed socket would be.
    const live = host.server;
    await live.stop();
    assert.equal(await canConnect('127.0.0.1', httpPort, 500), false);

    clock += 10000;
    assert.equal(await host.check(), true);
    assert.equal(host.generation, 4);
    assert.match(status().reason, /listener stopped answering/);
    assert.equal((await health()).ready, true);
  });

  test('an accept error on a listening socket: restarted', async () => {
    host.noteError(Object.assign(new Error('accept EBADF'), { code: 'EBADF', syscall: 'accept' }));
    await waitFor(() => host.generation === 5 && status().state === 'ready', { timeout: 15000 });
    assert.match(status().reason, /listening socket failed/);
    assert.equal((await health()).ready, true);

    host.noteError(new Error('something unrelated'));
    assert.equal(host.generation, 5, 'other errors do not restart the server');
  });

  test('a restart that fails is tried again', async () => {
    // Something else holds the port while the server is down.
    const squatter = net.createServer();
    await host.server.stop();
    await new Promise((resolve) => squatter.listen(httpPort, '127.0.0.1', resolve));

    assert.equal(await host.restart('test'), false);
    assert.equal(status().state, 'failed');
    assert.equal(status().code, 'EADDRINUSE');
    assert.equal(host.server, null);

    await new Promise((resolve) => squatter.close(resolve));
    assert.equal(await host.check(), true);
    assert.equal(status().state, 'ready');
    assert.equal((await health()).ready, true);
  });

  test('stop() stops the server and says so', async () => {
    await host.stop();
    assert.equal(status().state, 'stopped');
    assert.equal(await canConnect('127.0.0.1', httpPort, 500), false);
    assert.equal(fs.existsSync(path.join(data.dir, 'host-status.json')), true);
  });
});
