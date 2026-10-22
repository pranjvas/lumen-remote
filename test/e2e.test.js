// End to end: browser WebSocket client ↔ real server (startServer) ↔ mock TV, plus the fake agent,
// the HTTP surface, Cast, the MCP endpoint and Ask with the AI backend off (spec §5.3, §8–§11).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skipUnless, startStack, waitFor, sleep, request, tryUpgrade } from './helpers.js';

const skip = skipUnless('server/app.js');
const ready = async (b, { remote = true } = {}) => {
  await b.hello;
  await b.waitForState('conn.tv', (r) => r?.v === 'on', { timeout: 8000 });
  if (remote) await b.waitForState('conn.remote', (r) => r?.v === 'paired', { timeout: 8000 });
};

describe('e2e: browser ↔ server ↔ mock TV', { skip }, () => {
  let stack, mock, b, port;
  before(async () => {
    stack = await startStack({ config: { log: { level: 'debug', console: false } } });
    ({ mock, httpPort: port } = stack);
    b = stack.browser();
    await b.hello;
    await b.send('view', { name: 'remote', visible: true });
    await ready(b);
  });
  after(() => stack?.stop());

  test('hello carries a flat state snapshot, the catalogues, csrf and AI status — and no identifiers', async () => {
    const hello = await b.hello;
    assert.equal(hello.t, 'hello');
    assert.equal(typeof hello.version, 'string');
    for (const [key, rec] of Object.entries(hello.state)) {
      assert.ok(rec && 'v' in rec && 'src' in rec, `${key} is a record`);
    }
    assert.equal(hello.state.audio, undefined, 'flat dotted keys, not nested');

    const { keys, settings, apps } = hello.catalog;
    const up = keys.find((k) => k.key === 'KEY_UP');
    assert.deepEqual([up.label, up.group, up.hold], ['Up', 'nav', 'repeat']);
    assert.equal(keys.find((k) => k.key === 'KEY_POWER').hold, 'none');
    const backlight = settings.find((s) => s.key === 'picture.backlight');
    assert.deepEqual([backlight.label, backlight.group, backlight.type, backlight.range, backlight.ipc.method, backlight.writable],
      ['Brightness', 'picture', 'range', [0, 50], 'backlightControl', true]);
    const gameMode = settings.find((s) => s.key === 'general.gameMode');
    assert.equal(gameMode.type, 'tracked');
    assert.ok(gameMode.options.includes('On'));
    assert.equal(typeof gameMode.menuPath, 'string');
    const netflix = apps.find((a) => a.id === '3201907018807');
    assert.equal(netflix.name, 'Netflix');
    assert.match(netflix.color, /^#[0-9a-f]{6}$/i);
    assert.ok(!apps.some((a) => a.id === 'lumenrmt01.LumenAgent'), 'the agent is not an app tile');

    assert.equal(typeof hello.csrf, 'string');
    assert.ok(hello.csrf.length >= 16);
    assert.equal(hello.ai?.backend, 'off');
    assert.equal(hello.ai?.ready, false);

    const text = JSON.stringify(hello).toLowerCase();
    for (const secret of [mock.options.wifiMac, mock.tokens.remote, mock.tokens.ipc, ...Object.values(stack.secrets)]) {
      assert.ok(!text.includes(String(secret).toLowerCase()), 'hello leaks no MAC, token or secret');
    }
  });

  test('WebSocket upgrades need the right Origin and Host', async () => {
    assert.equal((await tryUpgrade(port, { origin: `http://127.0.0.1:${port}` })).status, 101);
    assert.equal((await tryUpgrade(port, { origin: `http://localhost:${port}`, host: `localhost:${port}` })).status, 101);
    assert.equal((await tryUpgrade(port, { origin: 'http://evil.example' })).status, 403);
    assert.notEqual((await tryUpgrade(port, {})).status, 101, 'no Origin');
    assert.notEqual((await tryUpgrade(port, { origin: `http://127.0.0.1:${port}`, host: `attacker.example:${port}` })).status, 101, 'foreign Host');
    assert.notEqual((await tryUpgrade(port, { origin: `http://127.0.0.1:${port + 1}` })).status, 101, 'allowlist follows the bound port');
    const rejected = stack.browser({ origin: 'http://evil.example' });
    await assert.rejects(rejected.opened, { statusCode: 403 });
  });

  test('/api/health answers JSON without CORS; no path traversal', async () => {
    const health = await request({ port, path: '/api/health' });
    assert.equal(health.status, 200);
    assert.match(health.headers['content-type'], /json/);
    JSON.parse(health.body);
    assert.equal(health.headers['access-control-allow-origin'], undefined);
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/../data/secrets.json']) {
      const r = await request({ port, path: p });
      assert.ok(!r.body.includes('"dependencies"') && !r.body.includes('mcpToken'), `${p} → ${r.status}`);
    }
  });

  test('the page is served with the CSP', { skip: skipUnless('web/index.html') }, async () => {
    const page = await request({ port, path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /html/);
    assert.match(page.headers['content-security-policy'] ?? '', /default-src 'self'/);
    assert.equal(page.headers['access-control-allow-origin'], undefined);
  });

  test('a key click reaches the TV', async () => {
    const ack = await b.send('key', { key: 'KEY_UP' });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(typeof ack.ms, 'number');
    await waitFor(() => mock.state.keys.some((k) => k.key === 'KEY_UP' && k.cmd === 'Click'));
    const conn = mock.state.requests.remote.at(-1);
    assert.deepEqual([conn.name, conn.withToken], ['Lumen Remote', true]);
  });

  test('text.send types into the TV field and submits', async () => {
    const ack = await b.send('text.send', { text: 'lumen ✓', submit: true });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    await waitFor(() => mock.state.texts.includes('lumen ✓') && mock.state.inputEnds === 1);
  });

  test('volume.set acks with the read-back and the browser sees it', async () => {
    const ack = await b.send('volume.set', { value: 23 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(ack.value, 23);
    assert.equal(mock.state.volume, 23);
    await b.waitForState('audio.volume', (r) => r?.v === 23);
  });

  test('setting.set picture.backlight acks with what the TV reports', async () => {
    const ack = await b.send('setting.set', { key: 'picture.backlight', value: 17 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(ack.value, 17);
    assert.equal(mock.state.picture.backlight, 17);
    const rec = await b.waitForState('picture.backlight', (r) => r?.v === 17);
    assert.equal(rec.src, 'live');

    mock.options.ipcTransform = { backlightControl: (v) => Math.min(v, 40) }; // a firmware clamp
    const clamped = await b.send('setting.set', { key: 'picture.backlight', value: 45 });
    mock.options.ipcTransform = {};
    assert.equal(clamped.ok, true, JSON.stringify(clamped.error));
    assert.equal(clamped.value, 40, 'the read-back, not the request');
    await b.waitForState('picture.backlight', (r) => r?.v === 40);
  });

  test('picture writes in Dynamic → LOCKED_IN_MODE', async () => {
    mock.setPictureMode('Dynamic');
    try {
      const ack = await b.send('setting.set', { key: 'picture.backlight', value: 5 });
      assert.equal(ack.ok, false);
      assert.equal(ack.error.code, 'LOCKED_IN_MODE');
      assert.equal(mock.state.picture.backlight, 50, 'the Dynamic value is untouched');
    } finally {
      mock.setPictureMode('Standard');
    }
  });

  test('tracked settings and input labels are stored by Lumen, never sent to the TV', async () => {
    const ack = await b.send('setting.set', { key: 'general.gameMode', value: 'On' });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    const rec = await b.waitForState('general.gameMode', (r) => r?.v === 'On');
    assert.equal(rec.src, 'tracked');
    assert.ok(!mock.state.requests.ipc.some((r) => r.method === 'gameModeControl'));
    assert.ok(JSON.stringify(stack.data.read('tracked.json')).includes('general.gameMode'), 'persisted in tracked.json');
    const bad = await b.send('setting.set', { key: 'general.gameMode', value: 'Sideways' });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'INVALID');
    const label = await b.send('input.label', { source: 'HDMI1', label: 'PlayStation' });
    assert.equal(label.ok, true, JSON.stringify(label.error));
    const labels = await b.waitForState('input.labels', (r) => r?.v?.HDMI1 === 'PlayStation');
    assert.equal(labels.src, 'tracked');
  });

  test('app.launch goes through REST and the app becomes visible', async () => {
    const ack = await b.send('app.launch', { appId: '3201907018807' }, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.ok(mock.state.launches.some((l) => l.id === '3201907018807'));
    assert.equal(mock.state.apps.get('3201907018807').visible, true);
  });

  test('agent hello → input.connected, channel.current, app.installed (and icons)', async () => {
    const agent = stack.agent();
    await agent.opened;
    await b.waitForState('conn.agent', (r) => r?.v === 'online');
    const connected = await b.waitForState('input.connected', (r) => Array.isArray(r?.v) && r.v.length === 2);
    assert.deepEqual(connected.v, ['TV', 'HDMI1']);
    assert.equal(connected.src, 'agent');
    const channel = await b.waitForState('channel.current', (r) => r?.v?.name === 'Ace TV');
    assert.equal(String(channel.v.number), '1927');
    assert.equal(channel.src, 'agent');
    await agent.waitForRequest('apps');
    const installed = await b.waitForState('app.installed', (r) => r?.src === 'agent' && r.v.some((a) => a.id === 'LumenTest0.Sideloaded'));
    assert.match(installed.v.find((a) => a.id === '3201907018807').color, /^#/, 'brand colour merged from the catalogue');
    await b.waitForState('caption.state', (r) => r?.v === 'off');
    await b.waitForState('device.firmware', (r) => r?.v === 'TIZEN-TRUNK2020-NikeM-HOTFIX-RELEASE_20260703.2');

    const icon = await request({ port, path: '/api/icon/3201907018807', timeout: 10000 });
    assert.equal(icon.status, 200);
    assert.match(icon.headers['content-type'], /image\/png/);
    const missing = await request({ port, path: '/api/icon/LumenTest0.Sideloaded', timeout: 10000 });
    assert.equal(missing.status, 404);

    const intruder = stack.agent({ key: 'wrong-key' });
    await assert.rejects(intruder.opened);
  });

  test('cast.url with a direct media link → SetAVTransportURI then Play', async () => {
    const url = `http://127.0.0.1:${mock.ports.rest}/media/lumen-test.mp4`;
    const ack = await b.send('cast.url', { url }, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    const actions = mock.state.avtransport.actions;
    const set = actions.findIndex((a) => a.action === 'SetAVTransportURI' && a.uri === url);
    assert.ok(set >= 0, JSON.stringify(actions.map((a) => a.action)));
    assert.ok(actions.slice(set + 1).some((a) => a.action === 'Play'), 'Play after SetAVTransportURI');
    assert.equal(actions[set].didl.upnpClass, 'object.item.videoItem.movie');
    assert.match(actions[set].didl.protocolInfo, /^http-get:\*:video\/mp4:/);
    assert.equal(actions[set].didl.url, url);
    assert.ok(!mock.state.violations.some((v) => v.kind === 'didl-malformed'));
    await b.waitForState('cast.session', (r) => r?.v?.kind === 'dlna');
  });

  test('cast.url with a YouTube link → DIAL launch of YouTube with the video id', async () => {
    const ack = await b.send('cast.url', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    const launch = mock.state.dial.launches.find((l) => l.name === 'YouTube');
    assert.ok(launch, 'DIAL POST /ws/app/YouTube');
    assert.match(launch.body, /dQw4w9WgXcQ/);
  });

  test('MCP endpoint: tools/list and tools/call get_tv_state with the bearer token; 401 without', async () => {
    let session;
    const mcp = (body, auth = `Bearer ${stack.secrets.mcpToken}`) => request({
      port, path: '/mcp', method: 'POST', body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(auth ? { Authorization: auth } : {}), ...(session ? { 'Mcp-Session-Id': session } : {}),
      },
    });
    const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lumen-test', version: '0' } } });
    assert.equal(init.status, 200);
    session = init.headers['mcp-session-id'];
    const info = JSON.parse(init.body).result;
    assert.equal(info.serverInfo.name, 'lumen');
    assert.ok(info.capabilities.tools);
    assert.equal((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

    const list = JSON.parse((await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).body).result.tools;
    const names = list.map((t) => t.name);
    for (const name of ['get_tv_state', 'set_setting', 'set_volume', 'press_keys', 'launch_app', 'cast_media']) assert.ok(names.includes(name), name);
    assert.ok(list.every((t) => t.inputSchema?.type === 'object'));

    const call = JSON.parse((await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_tv_state', arguments: {} } })).body).result;
    assert.notEqual(call.isError, true);
    assert.equal(call.content[0].type, 'text');
    assert.match(call.content[0].text, /volume/i);

    assert.equal((await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, null)).status, 401);
    assert.equal((await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, 'Bearer not-the-token')).status, 401);
  });

  test('ai.ask with the backend off → a clean error event and nothing sent to the TV', async () => {
    const keysBefore = mock.state.keys.length;
    const setsBefore = mock.state.requests.ipc.filter((r) => r.kind === 'set').length;
    const id = b.fire('ai.ask', { text: 'make it brighter' });
    const event = await b.waitForMessage((m) => m.t === 'ai' && m.id === id && m.kind === 'error', { timeout: 5000 });
    assert.ok(Object.entries(event).some(([k, v]) => !['t', 'id', 'kind'].includes(k) && typeof v === 'string' && v.length > 3), JSON.stringify(event));
    await sleep(200);
    assert.equal(mock.state.keys.length, keysBefore);
    assert.equal(mock.state.requests.ipc.filter((r) => r.kind === 'set').length, setsBefore);
  });

  test('the TV never saw anything a correct client must not send, and nothing paired by itself', () => {
    assert.deepEqual(mock.state.violations, []);
    assert.deepEqual(mock.state.pairRequests, { remote: 0, ipc: 0 });
    assert.deepEqual(mock.state.errors, []);
  });

  test('the debug log carries no token, MAC or secret', () => {
    const file = path.join(stack.dataDir, 'logs', 'lumen.log');
    const text = fs.readFileSync(file, 'utf8').toLowerCase();
    assert.ok(text.length > 0, 'something was logged');
    const leaks = { wifiMac: mock.options.wifiMac, remoteToken: mock.tokens.remote, ipcToken: mock.tokens.ipc, ...stack.secrets };
    for (const [name, value] of Object.entries(leaks)) {
      assert.ok(!text.includes(String(value).toLowerCase()), `${name} appears in lumen.log`);
    }
  });
});

describe('e2e: a change made on the TV itself', { skip }, () => {
  let stack, mock, b;
  before(async () => {
    // Slow polls, so the change can only arrive through GENA.
    stack = await startStack({ config: { timing: { ipcStatesMs: 60000, ipcPictureMs: 60000, volumePollVisibleMs: 60000, volumePollIdleMs: 60000 } } });
    mock = stack.mock;
    b = stack.browser();
    await ready(b, { remote: false });
    await b.waitForState('conn.events', (r) => r?.v === 'push', { timeout: 8000 });
    await b.waitForState('audio.volume', (r) => r?.v === mock.state.volume, { timeout: 8000 });
  });
  after(() => stack?.stop());

  test('an external volume change arrives as a GENA patch and as changedOnTv', async () => {
    const from = b.value('audio.volume');
    const since = b.messages.length;
    mock.setVolume(from + 9);
    const rec = await b.waitForState('audio.volume', (r) => r?.v === from + 9);
    assert.match(String(rec.via), /gena/);
    assert.equal(rec.src, 'live');
    const change = await b.waitForMessage((m) => m.t === 'changedOnTv' && m.key === 'audio.volume', { since, timeout: 4000 });
    assert.deepEqual([change.from, change.to], [from, from + 9]);
  });

  test('an external mute arrives the same way', async () => {
    const since = b.messages.length;
    mock.setMute(true);
    const rec = await b.waitForState('audio.mute', (r) => r?.v === true);
    assert.match(String(rec.via), /gena/);
    const change = await b.waitForMessage((m) => m.t === 'changedOnTv' && m.key === 'audio.mute', { since, timeout: 4000 });
    assert.deepEqual([change.from, change.to], [false, true]);
  });
});

describe('e2e: power off, then on via Wake-on-LAN', { skip }, () => {
  let stack, mock, b;
  before(async () => {
    // IP Control cannot wake this mock, so only the magic packet can bring it back.
    stack = await startStack({ mock: { standbyIpcPowerOn: false }, config: { safety: { powerCooldownMs: 200 } } });
    mock = stack.mock;
    b = stack.browser();
    await b.hello;
    await b.send('view', { name: 'remote', visible: true });
    await ready(b);
  });
  after(() => stack?.stop());

  test('off is one KEY_POWER click; REST then reports standby', async () => {
    const ack = await b.send('power', { action: 'off' }, { timeout: 15000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    await waitFor(() => mock.state.power === 'standby');
    assert.deepEqual(mock.state.keys.filter((k) => k.key === 'KEY_POWER').map((k) => k.cmd), ['Click']);
    await b.waitForState('conn.tv', (r) => r?.v === 'standby', { timeout: 8000 });
  });

  test('on sends a magic packet for the TV MAC; the TV comes back and the MAC never reaches the browser', async () => {
    await sleep(300); // past the cooldown
    const ack = await b.send('power', { action: 'on' }, { timeout: 20000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    await waitFor(() => mock.state.power === 'on', { timeout: 10000 });
    assert.ok(mock.state.wol.some((p) => p.matches && p.size === 102), JSON.stringify(mock.state.wol));
    await b.waitForState('conn.tv', (r) => r?.v === 'on', { timeout: 8000 });
    const seen = JSON.stringify(b.messages).toLowerCase();
    assert.ok(!seen.includes(mock.options.wifiMac.toLowerCase()), 'MAC not sent to the browser');
    assert.deepEqual(mock.state.violations, []);
  });
});

describe('e2e: NOTIFY blocked (e.g. by a firewall) → volume polling', { skip }, () => {
  let stack, mock, b;
  before(async () => {
    stack = await startStack({ mock: { dropNotify: true } });
    mock = stack.mock;
    b = stack.browser();
    await b.hello;
    await b.send('view', { name: 'remote', visible: true });
    await ready(b, { remote: false });
  });
  after(() => stack?.stop());

  test('conn.events falls back to polling and external changes still arrive', async () => {
    await waitFor(() => mock.state.subscriptions.size === 1, { timeout: 8000, message: 'subscribed' });
    await sleep(2000); // past timing.genaFallbackMs (1.5 s in tests)
    assert.ok(mock.state.notifies.length > 0 && mock.state.notifies.every((n) => n.status === 'dropped'));
    assert.equal(b.value('conn.events'), 'polling');
    assert.ok(b.patchesFor('conn.events').every((r) => r.v !== 'push'));
    mock.setVolume(mock.state.volume + 7);
    const rec = await b.waitForState('audio.volume', (r) => r?.v === mock.state.volume, { timeout: 5000 });
    assert.doesNotMatch(String(rec.via), /gena/);
    assert.equal(rec.src, 'live');
  });
});
