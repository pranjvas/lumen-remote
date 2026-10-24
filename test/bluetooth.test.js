// Bluetooth from Lumen (Eyes 0.4.0): Settings → Bluetooth scans for devices in pairing mode, pairs them
// (and connects audio / input devices), connects or disconnects devices paired before, and falls back to
// the TV's own menu (or Ask Lumen) when the TV refuses. The TV side is the fake Eyes in helpers.js.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startStack, waitFor, connectEyes, fakeBluetooth } from './helpers.js';
import { BT_MENU, btDevice, btError, isTvRemote } from '../server/adapters/eyes.js';
import { callTool } from '../server/ai/tools.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const HEADPHONES = 'AC:80:0A:12:34:56';
const SOUNDBAR = 'F4:4E:FD:00:11:22';
const REMOTE = '00:1A:7D:DA:71:13';

// A stack whose agent launches a fake Eyes built by `makeEyes(url)`; returns { stack, b, agent, eyes }.
// Scans take 600 ms, so a patch with devices while still scanning reaches the browser (patches batch 50 ms).
async function eyesStack({ makeEyes = (url) => connectEyes(url, { bt: fakeBluetooth({ scanMs: 600 }) }), seed } = {}) {
  const stack = await startStack({ seed });
  const b = stack.browser();
  await b.hello;
  const agent = stack.agent();
  const eyes = [];
  agent.onRequest((msg) => {
    if (msg.type === 'launch' && msg.appId === 'org.lumen.eyes') eyes.push(makeEyes(msg.data.lumen));
  });
  await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
  return { stack, b, agent, eyes };
}

describe('eyes app source: Bluetooth actions (companion/eyes)', () => {
  const src = read('companion/eyes/Program.cs');
  const manifest = read('companion/eyes/tizen-manifest.xml');

  test('both version strings moved together to 0.4.0 or later', () => {
    const inCode = /const string Version = "([\d.]+)"/.exec(src)?.[1];
    const inManifest = /<manifest[^>]*\sversion="([\d.]+)"/.exec(manifest)?.[1];
    assert.equal(inCode, inManifest);
    const [major, minor] = inCode.split('.').map(Number);
    assert.ok(major > 0 || minor >= 4, `Eyes ${inCode} must be at least 0.4.0`);
  });

  test('needs only public privileges: internet and bluetooth (no partner or platform level)', () => {
    const privileges = [...manifest.matchAll(/<privilege>([^<]+)<\/privilege>/g)].map((m) => m[1].trim()).sort();
    assert.deepEqual(privileges, ['http://tizen.org/privilege/bluetooth', 'http://tizen.org/privilege/internet']);
  });

  test('scans, pairs and connects through Tizen.Network.Bluetooth, off the receive loop', () => {
    assert.match(src, /type == "bt-scan"\) BtScan\(/);
    assert.match(src, /type == "bt-scan-stop"\) StopScan\(\)/);
    assert.match(src, /type == "bt-pair" \|\| type == "bt-connect" \|\| type == "bt-disconnect"\) BtAction\(/);
    assert.doesNotMatch(src, /type == "bt-[a-z-]+"[^\n]*\)\s*await/, 'Bluetooth actions never block captures');
    for (const api of ['BluetoothAdapter.StartDiscovery()', 'BluetoothAdapter.StopDiscovery()', 'device.CreateBond()', 'GetProfile<BluetoothAudio>()',
      'BluetoothAudioProfileType.AdvancedAudioDistribution', 'GetProfile<BluetoothHid>()', 'BluetoothAdapter.GetBondedDevice(address)']) {
      assert.ok(src.includes(api), `uses ${api}`);
    }
    assert.match(src, /await btGate\.WaitAsync\(token\)/, 'one Bluetooth action at a time');
    assert.equal((src.match(/ws\.SendAsync\(/g) ?? []).length, 1, 'only Send() calls SendAsync');
  });
});

describe('bluetooth helpers (server/adapters/eyes.js)', () => {
  test('btDevice keeps only the known fields and normalises the address', () => {
    assert.deepEqual(btDevice({ address: 'ac:80:0a:12:34:56', name: '  WH-1000XM4 ', kind: 'AudioVideo', minor: 'AudioVideoHeadphones', rssi: -52, paired: false, connected: false, cmd: 'x' }),
      { address: HEADPHONES, name: 'WH-1000XM4', kind: 'AudioVideo', minor: 'AudioVideoHeadphones', rssi: -52, paired: false, connected: false });
    assert.equal(btDevice({ address: 'not-an-address', rssi: 0 }).address, null);
    assert.equal(btDevice({ rssi: 0 }).rssi, null, '0 dBm means unknown');
  });

  test('a refusal by the TV says to finish on the TV; a device failure says why', () => {
    const refused = btError('NotSupportedException: Unsupported', 'pair', { kind: 'AudioVideo', name: 'WH-1000XM4' });
    assert.equal(refused.code, 'UNAVAILABLE');
    assert.ok(refused.message.includes(BT_MENU.audio), refused.message);
    const denied = btError('InvalidOperationException: Permission denied', 'connect', { kind: 'Peripheral' });
    assert.equal(denied.code, 'UNAVAILABLE');
    assert.ok(denied.message.includes(BT_MENU.other), denied.message);
    const rejected = btError('AuthRejected: pairing failed', 'pair', { name: 'WH-1000XM4' });
    assert.equal(rejected.code, 'FAILED');
    assert.match(rejected.message, /Could not pair WH-1000XM4: the device turned the pairing down/);
    assert.equal(btError('NotEnabled: Bluetooth is off on the TV', 'pair', null).code, 'UNAVAILABLE');
  });

  test('the TV remote is recognised, so it is never disconnected', () => {
    assert.equal(isTvRemote({ kind: 'Peripheral', minor: 'PeripheralRemoteControl', name: 'BT Remote' }), true);
    assert.equal(isTvRemote({ kind: 'Peripheral', minor: 'PeripheralGamePad', name: 'Samsung Smart Remote' }), true);
    assert.equal(isTvRemote({ kind: 'Peripheral', minor: 'PeripheralGamePad', name: 'Xbox Wireless Controller' }), false);
  });

  test('the web UI shows the same TV menu paths as the server', () => {
    const web = read('web/js/views/settings.js');
    assert.ok(web.includes(`audio: '${BT_MENU.audio}'`) && web.includes(`other: '${BT_MENU.other}'`));
  });
});

describe('bluetooth: pair, connect and disconnect through Lumen Eyes', () => {
  let stack, b, eyes;

  before(async () => {
    ({ stack, b, eyes } = await eyesStack());
  });
  after(async () => {
    for (const e of eyes) e.close();
    await stack?.stop();
  });

  test('bluetooth.scan launches Eyes and streams the devices it finds into bluetooth.scan', async () => {
    const seenWhileScanning = [];
    const off = b.onMessage((m) => {
      const rec = m.t === 'patch' ? m.patch?.['bluetooth.scan'] : null;
      if (rec?.v?.state === 'scanning') seenWhileScanning.push(rec.v.devices.length);
    });
    const ack = await b.send('bluetooth.scan', { secs: 10 }, { timeout: 20000 });
    off();
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.deepEqual(ack.value.devices.map((d) => d.address).sort(), [HEADPHONES, '9C:2E:A1:65:43:21'].sort());
    assert.ok(seenWhileScanning.some((n) => n > 0), 'devices appear before the scan ends');
    const scan = await b.waitForState('bluetooth.scan', (r) => r?.v?.state === 'done');
    assert.equal(scan.v.devices.find((d) => d.address === HEADPHONES).name, 'WH-1000XM4');
    assert.equal(eyes.at(-1).received.find((m) => m.t === 'bt-scan').secs, 10);
  });

  test('pairing a found device connects it and refreshes the paired list', async () => {
    const ack = await b.send('bluetooth.pair', { address: HEADPHONES.toLowerCase() }, { timeout: 20000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.deepEqual({ ...ack.value }, { address: HEADPHONES, name: 'WH-1000XM4', kind: 'AudioVideo', paired: true, connected: true, profile: 'a2dp' });
    const state = await b.waitForState('bluetooth.state', (r) => r?.v?.devices?.some((d) => d.address === HEADPHONES));
    assert.deepEqual(state.v.devices.find((d) => d.address === HEADPHONES),
      { name: 'WH-1000XM4', connected: true, bonded: true, kind: 'AudioVideo', minor: 'AudioVideoHeadphones', address: HEADPHONES });
    const scan = await b.waitForState('bluetooth.scan', (r) => r?.v?.devices?.find((d) => d.address === HEADPHONES)?.connected);
    assert.equal(scan.v.devices.find((d) => d.address === HEADPHONES).paired, true);
  });

  test('a device paired before connects and disconnects (it stays paired)', async () => {
    const connected = await b.send('bluetooth.connect', { address: SOUNDBAR }, { timeout: 20000 });
    assert.equal(connected.ok, true, JSON.stringify(connected.error));
    assert.equal(connected.value.connected, true);
    await b.waitForState('bluetooth.state', (r) => r?.v?.devices?.find((d) => d.address === SOUNDBAR)?.connected === true);

    const dropped = await b.send('bluetooth.disconnect', { address: SOUNDBAR }, { timeout: 20000 });
    assert.equal(dropped.ok, true, JSON.stringify(dropped.error));
    assert.equal(dropped.value.connected, false);
    const state = await b.waitForState('bluetooth.state', (r) => r?.v?.devices?.find((d) => d.address === SOUNDBAR)?.connected === false);
    assert.equal(state.v.devices.find((d) => d.address === SOUNDBAR).bonded, true);
  });

  test('the TV remote is never disconnected, and bad addresses are refused before Eyes is asked', async () => {
    await b.send('bluetooth.refresh', {}, { timeout: 10000 });
    const before = eyes.at(-1).received.length;
    const remote = await b.send('bluetooth.disconnect', { address: REMOTE });
    assert.equal(remote.ok, false);
    assert.equal(remote.error.code, 'INVALID');
    const bad = await b.send('bluetooth.pair', { address: 'AC:80:0A:12:34' });
    assert.equal(bad.error.code, 'INVALID');
    const scanSecs = await b.send('bluetooth.scan', { secs: 99 });
    assert.equal(scanSecs.error.code, 'INVALID');
    assert.equal(eyes.at(-1).received.length, before, 'Eyes got no request');
  });

  test('a device that turns the pairing down is reported with the reason', async () => {
    eyes.at(-1).bt.failPair['9C:2E:A1:65:43:21'] = 'AuthRejected: pairing failed';
    const ack = await b.send('bluetooth.pair', { address: '9C:2E:A1:65:43:21' }, { timeout: 20000 });
    assert.equal(ack.ok, false);
    assert.equal(ack.error.code, 'FAILED');
    assert.match(ack.error.message, /Could not pair Xbox Wireless Controller: the device turned the pairing down/);
  });

  test('closing the sheet stops a running scan early', async () => {
    eyes.at(-1).bt.scanMs = 10000;
    const scanning = b.send('bluetooth.scan', { secs: 30 }, { timeout: 20000 });
    await b.waitForState('bluetooth.scan', (r) => r?.v?.state === 'scanning', { timeout: 5000 });
    const stop = await b.send('bluetooth.stopScan', {});
    assert.equal(stop.ok, true);
    assert.equal(stop.value.stopped, true);
    const t0 = Date.now();
    assert.equal((await scanning).ok, true);
    assert.ok(Date.now() - t0 < 3000, 'the scan ended at once');
    assert.ok(eyes.at(-1).received.some((m) => m.t === 'bt-scan-stop'));
    eyes.at(-1).bt.scanMs = 600;
  });

  test('Ask Lumen pairs by name through the bluetooth tool', async () => {
    const ctx = { hub: stack.server.hub, store: stack.server.store };
    const scan = await callTool('bluetooth', { action: 'scan' }, ctx);
    assert.equal(scan.isError, false, scan.text);
    const out = await callTool('bluetooth', { action: 'pair', device: 'wh-1000xm4' }, ctx);
    assert.equal(out.isError, false, out.text);
    assert.equal(out.result.address, HEADPHONES);
    assert.match(out.result.summary, /Paired WH-1000XM4 and connected it/);
    const list = await callTool('bluetooth', { action: 'list' }, ctx);
    assert.ok(list.result.devices.some((d) => d.name === 'WH-1000XM4' && d.connected));
    const unknown = await callTool('bluetooth', { action: 'connect', device: 'Nonexistent Speaker' }, ctx);
    assert.equal(unknown.isError, true);
  });

  test('bluetooth.openTv opens the TV menu with the Menu key and names the list to open', async () => {
    const keys = stack.mock.keysSent().length;
    const ack = await b.send('bluetooth.openTv', { kind: 'audio' }, { timeout: 10000 });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal(ack.value.method, 'menu-key');
    assert.equal(ack.value.menuPath, BT_MENU.audio);
    await waitFor(() => stack.mock.keysSent().slice(keys).includes('KEY_MENU'), { timeout: 3000, message: 'KEY_MENU sent' });
    assert.equal((await b.send('bluetooth.openTv', { kind: 'everything' })).error.code, 'INVALID');
  });
});

describe('bluetooth: when the TV refuses or Eyes is too old', () => {
  test('a TV that refuses the Bluetooth API gets UNAVAILABLE with the menu path to finish on the TV', async () => {
    const { stack, b, eyes } = await eyesStack({ makeEyes: (url) => connectEyes(url, { bt: fakeBluetooth({ refuse: 'NotSupportedException: Unsupported' }) }) });
    try {
      const scan = await b.send('bluetooth.scan', {}, { timeout: 20000 });
      assert.equal(scan.ok, false);
      assert.equal(scan.error.code, 'UNAVAILABLE');
      assert.ok(scan.error.message.includes('Finish on the TV'), scan.error.message);
      const rec = await b.waitForState('bluetooth.scan', (r) => r?.v?.state === 'error');
      assert.equal(rec.v.error.code, 'UNAVAILABLE');

      const pair = await b.send('bluetooth.connect', { address: SOUNDBAR }, { timeout: 20000 });
      assert.equal(pair.error.code, 'UNAVAILABLE');
      assert.ok(pair.error.message.includes(BT_MENU.audio), pair.error.message);
    } finally {
      for (const e of eyes) e.close();
      await stack.stop();
    }
  });

  test('Eyes older than 0.4.0 is told to update instead of timing out', async () => {
    const { stack, b, eyes } = await eyesStack({ makeEyes: (url) => connectEyes(url, { version: '0.3.3' }) });
    try {
      const t0 = Date.now();
      const ack = await b.send('bluetooth.pair', { address: HEADPHONES }, { timeout: 20000 });
      assert.equal(ack.ok, false);
      assert.equal(ack.error.code, 'UNAVAILABLE');
      assert.match(ack.error.message, /needs Lumen Eyes 0\.4\.0 on the TV \(it has 0\.3\.3\)/);
      assert.ok(Date.now() - t0 < 8000);
      assert.ok(!eyes.at(-1).received.some((m) => m.t === 'bt-pair'), 'no request the old app cannot answer');
    } finally {
      for (const e of eyes) e.close();
      await stack.stop();
    }
  });

  test('without the remote channel, openTv starts the TV Settings app through the agent', async () => {
    const { stack, b, agent, eyes } = await eyesStack({ seed: { remoteToken: null } });
    try {
      await b.waitForState('conn.remote', (r) => r?.v && r.v !== 'paired', { timeout: 5000 });
      const ack = await b.send('bluetooth.openTv', { kind: 'other' }, { timeout: 10000 });
      assert.equal(ack.ok, true, JSON.stringify(ack.error));
      assert.equal(ack.value.method, 'settings-app');
      assert.equal(ack.value.menuPath, BT_MENU.other);
      assert.ok(agent.requests.some((r) => r.type === 'launch' && r.appId === 'com.samsung.tv.coba.setting'));
    } finally {
      for (const e of eyes) e.close();
      await stack.stop();
    }
  });
});
