// Self-test of the mock TV: every channel exercised directly with raw clients.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { WebSocket } from 'ws';
import { startMockTv, fixture, parseMagicPacket } from './mock-tv.js';
import { request, waitFor, sleep } from './helpers.js';

const RCS = 'urn:schemas-upnp-org:service:RenderingControl:1';
const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const CM = 'urn:schemas-upnp-org:service:ConnectionManager:1';
const b64 = (s) => Buffer.from(s).toString('base64');

function soap(port, service, urn, action, args = {}) {
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
  const body = '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
    + `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${urn}">${inner}</u:${action}></s:Body></s:Envelope>`;
  return request({
    port, path: `/upnp/control/${service}1`, method: 'POST', body,
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${urn}#${action}"` },
  });
}
const tag = (xml, name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];
const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function ipc(port, method, params, { agent } = {}) {
  const msg = { jsonrpc: '2.0', id: String(Date.now()), method, ...(params ? { params } : {}) };
  return request({
    port, method: 'POST', tls: true, agent, body: JSON.stringify(msg),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  }).then((r) => ({ ...r, json: JSON.parse(r.body) }));
}

async function callbackServer() {
  const notifies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      notifies.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/gena/test`,
    notifies,
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function remote(mock, { token = mock.tokens.remote, name = 'Lumen Remote' } = {}) {
  const query = `name=${encodeURIComponent(b64(name))}${token ? `&token=${token}` : ''}`;
  const ws = new WebSocket(`wss://127.0.0.1:${mock.ports.wss}/api/v2/channels/samsung.remote.control?${query}`, { rejectUnauthorized: false });
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  ws.on('error', () => {});
  return {
    ws,
    messages,
    opened: new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }),
    closed: new Promise((resolve) => ws.once('close', resolve)),
    event: (name) => waitFor(() => messages.find((m) => m.event === name), { message: name }),
    key: (key, cmd = 'Click') => ws.send(JSON.stringify({ method: 'ms.remote.control', params: { Cmd: cmd, DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' } })),
    send: (params) => ws.send(JSON.stringify({ method: 'ms.remote.control', params })),
  };
}

describe('REST (8001)', () => {
  let mock;
  before(async () => { mock = await startMockTv(); });
  after(() => mock.stop());

  test('device info carries PowerState and wifiMac in the live shape', async () => {
    const r = await request({ port: mock.ports.rest, path: '/api/v2/' });
    assert.equal(r.status, 200);
    const info = JSON.parse(r.body);
    assert.equal(info.device.PowerState, 'on');
    assert.equal(info.device.wifiMac, mock.options.wifiMac);
    assert.equal(info.device.modelName, 'QA55Q95TAKXXL');
    assert.equal(info.device.TokenAuthSupport, 'true');
    assert.equal(JSON.parse(info.isSupport).remote_available, 'true');
  });

  test('app status needs the trailing slash; unknown ids are 404', async () => {
    const ok = await request({ port: mock.ports.rest, path: '/api/v2/applications/pvcinehd01.CineHDTV/' });
    assert.deepEqual(JSON.parse(ok.body), { id: 'pvcinehd01.CineHDTV', name: 'CineHD TV', running: true, version: '0.17.421', visible: true });
    await assert.rejects(request({ port: mock.ports.rest, path: '/api/v2/applications/pvcinehd01.CineHDTV' }));
    assert.equal(mock.state.violations.at(-1).kind, 'rest-missing-trailing-slash');
    const missing = await request({ port: mock.ports.rest, path: '/api/v2/applications/org.tizen.netflixapp/' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body, fixture('rest/not-found.json'));
  });

  test('POST launch returns true and makes the app the visible one', async () => {
    const r = await request({ port: mock.ports.rest, path: '/api/v2/applications/3201907018807/', method: 'POST', body: '{}' });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'true');
    const netflix = JSON.parse((await request({ port: mock.ports.rest, path: '/api/v2/applications/3201907018807/' })).body);
    const cinehd = JSON.parse((await request({ port: mock.ports.rest, path: '/api/v2/applications/pvcinehd01.CineHDTV/' })).body);
    assert.equal(netflix.visible, true);
    assert.equal(cinehd.visible, false);
    assert.deepEqual(mock.state.launches.map((l) => l.id), ['3201907018807']);
  });

  test('standby reports PowerState standby; fully off never answers', async () => {
    mock.setPower('standby');
    const info = JSON.parse((await request({ port: mock.ports.rest, path: '/api/v2/' })).body);
    assert.equal(info.device.PowerState, 'standby');
    mock.setPower('off');
    await assert.rejects(request({ port: mock.ports.rest, path: '/api/v2/', timeout: 300 }), { code: 'ETIMEDOUT' });
    mock.setPower('on');
  });
});

describe('remote channel WSS (8002)', () => {
  let mock;
  before(async () => { mock = await startMockTv({ allowDelayMs: 50 }); });
  after(() => mock.stop());

  test('a saved token connects silently; early touch event precedes ms.channel.connect', async () => {
    const c = remote(mock);
    const connect = await c.event('ms.channel.connect');
    assert.equal(c.messages[0].event, 'ms.remote.touchDisable');
    assert.equal(connect.data.token, undefined);
    assert.equal(connect.data.clients[0].attributes.token, mock.tokens.remote);
    assert.equal(Buffer.from(connect.data.clients[0].attributes.name, 'base64').toString(), 'Lumen Remote');
    await c.event('ms.channel.ready');
    c.ws.close();
  });

  test('a bad token gets ms.channel.unauthorized and the socket closes', async () => {
    const c = remote(mock, { token: '00000000' });
    await c.event('ms.channel.unauthorized');
    await c.closed;
  });

  test('pairing without a token issues an 8-digit token after the Allow delay', async () => {
    const c = remote(mock, { token: null });
    const connect = await c.event('ms.channel.connect');
    assert.match(connect.data.token, /^\d{8}$/);
    assert.equal(mock.state.pairRequests.remote, 1);
    c.ws.close();
    const again = remote(mock, { token: connect.data.token });
    await again.event('ms.channel.connect');
    again.ws.close();
  });

  test('Deny at the prompt → ms.channel.unauthorized', async () => {
    mock.options.allow = false;
    const c = remote(mock, { token: null });
    await c.event('ms.channel.unauthorized');
    mock.options.allow = true;
  });

  test('keys are recorded; volume and mute keys change the shared state', async () => {
    const c = remote(mock);
    await c.event('ms.channel.connect');
    mock.setMute(true);
    const before = mock.state.volume;
    c.key('KEY_VOLUP');
    await waitFor(() => mock.state.volume === before + 1);
    assert.equal(mock.state.mute, false, 'volume up unmutes');
    c.key('KEY_MUTE');
    await waitFor(() => mock.state.mute === true);
    c.key('KEY_UP', 'Press');
    c.key('KEY_UP', 'Release');
    await waitFor(() => mock.state.keys.length >= 4);
    assert.deepEqual(mock.state.keys.slice(-4).map((k) => `${k.cmd}:${k.key}`), ['Click:KEY_VOLUP', 'Click:KEY_MUTE', 'Press:KEY_UP', 'Release:KEY_UP']);
    assert.equal(mock.state.pressed.size, 0);
    c.key('KEY_FACTORY');
    c.key('KEY_POWER', 'Press');
    await waitFor(() => mock.state.violations.some((v) => v.kind === 'power-hold'));
    assert.ok(mock.state.violations.some((v) => v.kind === 'danger-key' && v.key === 'KEY_FACTORY'));
    c.ws.close();
  });

  test('IME events are scripted; SendInputString and SendInputEnd are recorded', async () => {
    const c = remote(mock);
    await c.event('ms.channel.connect');
    mock.ime.start('url', 100);
    const start = await c.event('ms.remote.imeStart');
    assert.deepEqual([start.data, start.entrylimit], ['url', 100]);
    mock.ime.update('héllo');
    const update = await c.event('ms.remote.imeUpdate');
    assert.equal(Buffer.from(update.data, 'base64').toString(), 'héllo');
    c.send({ Cmd: b64('lumen ✓'), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' });
    await waitFor(() => c.messages.filter((m) => m.event === 'ms.remote.imeDone').length === 2);
    assert.deepEqual(mock.state.texts, ['lumen ✓']);
    c.send({ TypeOfRemote: 'SendInputEnd' });
    await c.event('ms.remote.imeEnd');
    assert.equal(mock.state.ime.open, false);
    assert.equal(mock.state.inputEnds, 1);
    c.ws.close();
  });

  test('the pointer is recorded with the touch flag as a hint, never refused', async () => {
    const c = remote(mock);
    await c.event('ms.channel.connect');
    mock.setTouch(true);
    await c.event('ms.remote.touchEnable');
    c.send({ Cmd: 'Move', Position: { x: 12, y: -4, Time: '0' }, TypeOfRemote: 'ProcessMouseDevice' });
    c.send({ Cmd: 'LeftClick', TypeOfRemote: 'ProcessMouseDevice' });
    await waitFor(() => mock.state.pointer.length === 2);
    assert.deepEqual(mock.state.pointer[0], { cmd: 'Move', x: 12, y: -4, touch: true });
    mock.setTouch(false);
    await c.event('ms.remote.touchDisable');
    c.send({ Cmd: 'RightClick', TypeOfRemote: 'ProcessMouseDevice' });
    await waitFor(() => mock.state.pointer.length === 3);
    assert.deepEqual(mock.state.pointer[2], { cmd: 'RightClick', touch: false });
    assert.ok(!mock.state.violations.some((v) => v.kind.startsWith('pointer')), 'no pointer violations');
    c.ws.close();
  });

  test('KEY_POWER click puts the TV in standby: the socket drops and new connections are refused', async () => {
    const c = remote(mock);
    await c.event('ms.channel.connect');
    c.key('KEY_POWER');
    await c.closed;
    assert.equal(mock.state.power, 'standby');
    const refused = remote(mock);
    await assert.rejects(refused.opened);
    mock.setPower('on');
  });
});

describe('DMR (9197): RenderingControl, GENA, AVTransport, ConnectionManager', () => {
  let mock, cb;
  before(async () => { mock = await startMockTv(); cb = await callbackServer(); });
  after(async () => { await cb.stop(); await mock.stop(); });

  test('GetVolume/GetMute answer in the exact format the Q95T uses', async () => {
    mock.setVolume(4);
    mock.setMute(true);
    const vol = await soap(mock.ports.dmr, 'RenderingControl', RCS, 'GetVolume', { InstanceID: 0, Channel: 'Master' });
    assert.equal(vol.body, fixture('upnp/soap-GetVolume.xml'));
    const mute = await soap(mock.ports.dmr, 'RenderingControl', RCS, 'GetMute', { InstanceID: 0, Channel: 'Master' });
    assert.equal(mute.body, fixture('upnp/soap-GetMute.xml'));
  });

  test('SetVolume unmutes; SetMute; faults for bad actions and values', async () => {
    mock.setMute(true);
    const set = await soap(mock.ports.dmr, 'RenderingControl', RCS, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: 12 });
    assert.equal(set.status, 200);
    assert.equal(mock.state.volume, 12);
    assert.equal(mock.state.mute, false);
    await soap(mock.ports.dmr, 'RenderingControl', RCS, 'SetMute', { InstanceID: 0, Channel: 'Master', DesiredMute: 1 });
    assert.equal(mock.state.mute, true);
    const range = await soap(mock.ports.dmr, 'RenderingControl', RCS, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: 150 });
    assert.equal(range.status, 500);
    assert.equal(tag(range.body, 'errorCode'), '601');
    const bad = await soap(mock.ports.dmr, 'RenderingControl', RCS, 'X_Nope');
    assert.equal(tag(bad.body, 'errorCode'), '401');
    const args = await soap(mock.ports.dmr, 'RenderingControl', RCS, 'GetVolume', { InstanceID: 0 });
    assert.equal(tag(args.body, 'errorCode'), '402');
  });

  test('GENA: SUBSCRIBE → initial NOTIFY, change NOTIFYs + empty LastChange, byte-identical to the TV', async () => {
    mock.setVolume(4);
    mock.setMute(true);
    const sub = await request({
      port: mock.ports.dmr, path: '/upnp/event/RenderingControl1', method: 'SUBSCRIBE',
      headers: { CALLBACK: `<${cb.url}>`, NT: 'upnp:event', TIMEOUT: 'Second-1800' },
    });
    assert.equal(sub.status, 200);
    assert.match(sub.headers.sid, /^uuid:[0-9a-f-]{36}$/);
    assert.equal(sub.headers.timeout, 'Second-1800');
    await waitFor(() => cb.notifies.length === 1);
    const first = cb.notifies[0];
    assert.equal(first.method, 'NOTIFY');
    assert.deepEqual([first.headers.sid, first.headers.seq, first.headers.nt, first.headers.nts], [sub.headers.sid, '0', 'upnp:event', 'upnp:propchange']);
    assert.equal(first.body, fixture('upnp/notify-rc-initial.xml'));

    mock.setMute(false);
    mock.setVolume(5);
    await waitFor(() => cb.notifies.length === 5);
    assert.deepEqual(cb.notifies.map((n) => n.headers.seq), ['0', '1', '2', '3', '4']);
    assert.equal(cb.notifies[1].body, fixture('upnp/notify-rc-mute-0.xml'));
    assert.equal(cb.notifies[2].body, fixture('upnp/notify-rc-empty.xml'));
    assert.equal(cb.notifies[3].body, fixture('upnp/notify-rc-volume-5.xml'));

    const renew = await request({ port: mock.ports.dmr, path: '/upnp/event/RenderingControl1', method: 'SUBSCRIBE', headers: { SID: sub.headers.sid, TIMEOUT: 'Second-300' } });
    assert.deepEqual([renew.status, renew.headers.sid, renew.headers.timeout], [200, sub.headers.sid, 'Second-1800']);
    const unknown = await request({ port: mock.ports.dmr, path: '/upnp/event/RenderingControl1', method: 'SUBSCRIBE', headers: { SID: 'uuid:00000000-0000-0000-0000-000000000000', TIMEOUT: 'Second-300' } });
    assert.equal(unknown.status, 412);
    const mixed = await request({ port: mock.ports.dmr, path: '/upnp/event/RenderingControl1', method: 'SUBSCRIBE', headers: { SID: sub.headers.sid, CALLBACK: `<${cb.url}>`, NT: 'upnp:event' } });
    assert.equal(mixed.status, 400);
    const unsub = await request({ port: mock.ports.dmr, path: '/upnp/event/RenderingControl1', method: 'UNSUBSCRIBE', headers: { SID: sub.headers.sid } });
    assert.equal(unsub.status, 200);
    const again = await request({ port: mock.ports.dmr, path: '/upnp/event/RenderingControl1', method: 'UNSUBSCRIBE', headers: { SID: sub.headers.sid } });
    assert.equal(again.status, 412);
  });

  test('GENA refuses non-loopback callbacks and can drop NOTIFY like a firewall', async () => {
    const lan = await request({ port: mock.ports.dmr, path: '/upnp/event/RenderingControl1', method: 'SUBSCRIBE', headers: { CALLBACK: '<http://192.0.2.10:8791/gena/x>', NT: 'upnp:event', TIMEOUT: 'Second-60' } });
    assert.equal(lan.status, 412);
    assert.ok(mock.state.violations.some((v) => v.kind === 'gena-callback-not-loopback'));
    mock.options.dropNotify = true;
    const before = cb.notifies.length;
    const sub = await request({ port: mock.ports.dmr, path: '/upnp/event/RenderingControl1', method: 'SUBSCRIBE', headers: { CALLBACK: `<${cb.url}>`, NT: 'upnp:event', TIMEOUT: 'Second-60' } });
    await sleep(200);
    assert.equal(cb.notifies.length, before);
    assert.equal(mock.state.notifies.at(-1).status, 'dropped');
    mock.options.dropNotify = false;
    await request({ port: mock.ports.dmr, path: '/upnp/event/RenderingControl1', method: 'UNSUBSCRIBE', headers: { SID: sub.headers.sid } });
  });

  test('notifyRaw delivers fixture bodies to subscribers in order', async () => {
    const sub = await request({ port: mock.ports.dmr, path: '/upnp/event/RenderingControl1', method: 'SUBSCRIBE', headers: { CALLBACK: `<${cb.url}>`, NT: 'upnp:event', TIMEOUT: 'Second-60' } });
    await waitFor(() => cb.notifies.some((n) => n.headers.sid === sub.headers.sid));
    mock.notifyRaw(fixture('upnp/notify-rc-volume-10.xml'));
    await mock.flushNotifies();
    const mine = cb.notifies.filter((n) => n.headers.sid === sub.headers.sid);
    assert.equal(mine.at(-1).body, fixture('upnp/notify-rc-volume-10.xml'));
    assert.equal(mine.at(-1).headers.seq, '1');
    await request({ port: mock.ports.dmr, path: '/upnp/event/RenderingControl1', method: 'UNSUBSCRIBE', headers: { SID: sub.headers.sid } });
  });

  test('AVTransport idle answers match the TV byte for byte', async () => {
    for (const action of ['GetTransportInfo', 'GetMediaInfo', 'GetPositionInfo']) {
      const r = await soap(mock.ports.dmr, 'AVTransport', AVT, action, { InstanceID: 0 });
      assert.equal(r.body, fixture(`upnp/soap-${action}.xml`), action);
    }
    const sub = await request({ port: mock.ports.dmr, path: '/upnp/event/AVTransport1', method: 'SUBSCRIBE', headers: { CALLBACK: `<${cb.url}>`, NT: 'upnp:event', TIMEOUT: 'Second-60' } });
    const initial = await waitFor(() => cb.notifies.find((n) => n.headers.sid === sub.headers.sid));
    assert.equal(initial.body, fixture('upnp/notify-avt-initial.xml'));
    await request({ port: mock.ports.dmr, path: '/upnp/event/AVTransport1', method: 'UNSUBSCRIBE', headers: { SID: sub.headers.sid } });
  });

  test('AVTransport: SetAVTransportURI with DIDL-Lite, Play, Pause, Seek, Stop', async () => {
    const uri = 'http://127.0.0.1:9/media/clip one.mp4?a=1&b=2';
    Object.assign(mock.options, { playLockedOnce: false, dmrFetch: false }); // raw SOAP mechanics; the reader flow is in cast.test.js
    const didl = '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">'
      + `<item id="0" parentID="-1" restricted="1"><dc:title>Clip &amp; More</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo="http-get:*:video/mp4:DLNA.ORG_OP=01" duration="0:02:00">${xmlEscape(uri)}</res></item></DIDL-Lite>`;
    const set = await soap(mock.ports.dmr, 'AVTransport', AVT, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: xmlEscape(uri), CurrentURIMetaData: xmlEscape(didl) });
    assert.equal(set.status, 200);
    const recorded = mock.state.avtransport.actions.at(-1);
    assert.equal(recorded.uri, uri);
    assert.deepEqual(recorded.didl, { title: 'Clip & More', upnpClass: 'object.item.videoItem', protocolInfo: 'http-get:*:video/mp4:DLNA.ORG_OP=01', duration: 120, url: uri });
    await soap(mock.ports.dmr, 'AVTransport', AVT, 'Play', { InstanceID: 0, Speed: 1 });
    assert.equal(tag((await soap(mock.ports.dmr, 'AVTransport', AVT, 'GetTransportInfo', { InstanceID: 0 })).body, 'CurrentTransportState'), 'PLAYING');
    await soap(mock.ports.dmr, 'AVTransport', AVT, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: '0:01:00' });
    await soap(mock.ports.dmr, 'AVTransport', AVT, 'Pause', { InstanceID: 0 });
    const pos = (await soap(mock.ports.dmr, 'AVTransport', AVT, 'GetPositionInfo', { InstanceID: 0 })).body;
    assert.equal(tag(pos, 'TrackDuration'), '0:02:00');
    assert.equal(tag(pos, 'RelTime'), '0:01:00');
    assert.equal(tag(pos, 'TrackURI'), xmlEscape(uri));
    assert.equal(mock.state.avtransport.state, 'PAUSED_PLAYBACK');
    const badSeek = await soap(mock.ports.dmr, 'AVTransport', AVT, 'Seek', { InstanceID: 0, Unit: 'ABS_COUNT', Target: '1' });
    assert.equal(tag(badSeek.body, 'errorCode'), '710');
    await soap(mock.ports.dmr, 'AVTransport', AVT, 'Stop', { InstanceID: 0 });
    assert.equal(mock.state.avtransport.state, 'STOPPED');
    assert.deepEqual(mock.state.avtransport.actions.map((a) => a.action), ['SetAVTransportURI', 'Play', 'Seek', 'Pause', 'Seek', 'Stop']);
    Object.assign(mock.options, { playLockedOnce: true, dmrFetch: true });
  });

  test('ConnectionManager GetProtocolInfo is the real 292-entry sink list', async () => {
    const r = await soap(mock.ports.dmr, 'ConnectionManager', CM, 'GetProtocolInfo');
    assert.equal(r.body, fixture('upnp/soap-GetProtocolInfo.xml'));
    assert.equal(tag(r.body, 'Sink').split(',').length, 292);
  });

  test('standby refuses the DMR', async () => {
    mock.setPower('standby');
    await assert.rejects(soap(mock.ports.dmr, 'RenderingControl', RCS, 'GetVolume', { InstanceID: 0, Channel: 'Master' }));
    mock.setPower('on');
  });
});

describe('IP Control (1516)', () => {
  let mock, token;
  before(async () => { mock = await startMockTv({ allowDelayMs: 30 }); token = mock.tokens.ipc; });
  after(() => mock.stop());

  test('GET = params with only AccessToken; SET = any extra key, with read-back', async () => {
    const states = await ipc(mock.ports.ipc, 'getTVStates', { AccessToken: token });
    assert.equal(states.headers.server, 'Samsung IP Control Server/1.0');
    assert.deepEqual(states.json.result, { inputSource: 'TV', mute: 'muteOff', pictureMode: 'Standard', pictureSize: '16:9', soundMode: 'Amplify', speakerSelect: 'internal', volume: 2 });
    assert.deepEqual((await ipc(mock.ports.ipc, 'getVideoStates', { AccessToken: token })).json.result, { brightness: 2, color: 25, contrast: 50, sharpness: 7, tint: 0 });
    assert.deepEqual((await ipc(mock.ports.ipc, 'backlightControl', { AccessToken: token })).json.result, { backlight: 10 });
    await ipc(mock.ports.ipc, 'backlightControl', { AccessToken: token, backlight: 20 });
    assert.deepEqual((await ipc(mock.ports.ipc, 'backlightControl', { AccessToken: token })).json.result, { backlight: 20 });
    assert.deepEqual(mock.state.requests.ipc.slice(-2).map((r) => r.kind), ['set', 'get']);
    assert.equal(mock.state.requests.ipc.at(-2).params.backlight, 20);
  });

  test('picture values are per picture mode; Dynamic refuses picture writes with -32002', async () => {
    await ipc(mock.ports.ipc, 'pictureModeControl', { AccessToken: token, pictureMode: 'Movie' });
    assert.deepEqual((await ipc(mock.ports.ipc, 'backlightControl', { AccessToken: token })).json.result, { backlight: 8 });
    await ipc(mock.ports.ipc, 'pictureModeControl', { AccessToken: token, pictureMode: 'Standard' });
    assert.deepEqual((await ipc(mock.ports.ipc, 'backlightControl', { AccessToken: token })).json.result, { backlight: 20 });
    mock.setPictureMode('Dynamic');
    const locked = await ipc(mock.ports.ipc, 'backlightControl', { AccessToken: token, backlight: 5 });
    assert.equal(locked.json.error.code, -32002);
    assert.equal((await ipc(mock.ports.ipc, 'backlightControl', { AccessToken: token })).json.result.backlight, 50);
    mock.setPictureMode('Standard');
  });

  test('ranges, Custom-only AMP values and Filmmaker Mode are enforced', async () => {
    assert.equal((await ipc(mock.ports.ipc, 'sharpnessControl', { AccessToken: token, sharpness: 74 })).json.error.code, -32002);
    assert.equal((await ipc(mock.ports.ipc, 'tintControl', { AccessToken: token, tint: -50 })).json.result.tint, -50);
    assert.equal((await ipc(mock.ports.ipc, 'AMP.blurReductionControl', { AccessToken: token, 'AMP.blurReduction': 3 })).json.error.code, -32002);
    await ipc(mock.ports.ipc, 'autoMotionPlusControl', { AccessToken: token, autoMotionPlus: 'Custom' });
    assert.equal((await ipc(mock.ports.ipc, 'AMP.blurReductionControl', { AccessToken: token, 'AMP.blurReduction': 3 })).json.result['AMP.blurReduction'], 3);
    assert.equal((await ipc(mock.ports.ipc, 'pictureModeControl', { AccessToken: token, pictureMode: 'Filmmaker Mode' })).json.error.code, -32002);
    assert.equal((await ipc(mock.ports.ipc, 'colorToneControl', { AccessToken: token, colorTone: 'Warm9' })).json.error.code, -32002);
  });

  test('ipcFail forces an error code; ipcTransform changes what a SET stores', async () => {
    mock.options.ipcFail = { colorToneControl: -32601 };
    assert.equal((await ipc(mock.ports.ipc, 'colorToneControl', { AccessToken: token })).json.error.code, -32601);
    mock.options.ipcFail = {};
    assert.equal((await ipc(mock.ports.ipc, 'colorToneControl', { AccessToken: token })).json.result.colorTone, 'Standard');
    mock.options.ipcTransform = { contrastControl: (v) => Math.min(v, 40) };
    assert.equal((await ipc(mock.ports.ipc, 'contrastControl', { AccessToken: token, contrast: 45 })).json.result.contrast, 40);
    mock.options.ipcTransform = {};
  });

  test('2025-only methods answer -32601', async () => {
    for (const method of ['gameModeControl', 'HDRToneMappingControl', 'autoPowerOffControl', 'getDeviceInformation']) {
      assert.equal((await ipc(mock.ports.ipc, method, { AccessToken: token })).json.error.code, -32601, method);
    }
  });

  test('token errors: none → -32700, wrong → -32010; flat error style', async () => {
    assert.equal((await ipc(mock.ports.ipc, 'getTVStates')).json.error.code, -32700);
    assert.equal((await ipc(mock.ports.ipc, 'getTVStates', { AccessToken: 'nope' })).json.error.code, -32010);
    mock.options.ipcErrorStyle = 'flat';
    const flat = (await ipc(mock.ports.ipc, 'getTVStates', { AccessToken: 'nope' })).json;
    assert.deepEqual(flat, { code: -32010, message: 'Unauthorized' });
    mock.options.ipcErrorStyle = 'nested';
  });

  test('volume and mute writes share state with UPnP', async () => {
    await ipc(mock.ports.ipc, 'directVolumeControl', { AccessToken: token, volume: 30 });
    await ipc(mock.ports.ipc, 'muteControl', { AccessToken: token, mute: 'muteOn' });
    assert.deepEqual([mock.state.volume, mock.state.mute], [30, true]);
    const upnp = await soap(mock.ports.dmr, 'RenderingControl', RCS, 'GetVolume', { InstanceID: 0, Channel: 'Master' });
    assert.equal(tag(upnp.body, 'CurrentVolume'), '30');
    await ipc(mock.ports.ipc, 'muteControl', { AccessToken: token, mute: 'muteOff' });
  });

  test('createAccessToken pairs after the Allow delay; -32011 when every slot is taken', async () => {
    const pair = await ipc(mock.ports.ipc, 'createAccessToken');
    const fresh = pair.json.result.AccessToken;
    assert.ok(fresh);
    assert.ok((await ipc(mock.ports.ipc, 'getTVStates', { AccessToken: fresh })).json.result);
    mock.options.ipcSlotsFull = true;
    assert.equal((await ipc(mock.ports.ipc, 'createAccessToken')).json.error.code, -32011);
    mock.options.ipcSlotsFull = false;
  });

  test('one connection at a time: an overlapping socket is reset, serialized calls are fine', async () => {
    mock.options.ipcDelayMs = 150;
    const separate = () => new https.Agent({ rejectUnauthorized: false, keepAlive: false });
    const results = await Promise.allSettled([
      ipc(mock.ports.ipc, 'getTVStates', { AccessToken: token }, { agent: separate() }),
      sleep(30).then(() => ipc(mock.ports.ipc, 'getTVStates', { AccessToken: token }, { agent: separate() })),
    ]);
    mock.options.ipcDelayMs = 0;
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.equal(mock.state.stats.ipcResets, 1);
    mock.state.violations.length = 0;
    const serial = new https.Agent({ rejectUnauthorized: false, keepAlive: false, maxSockets: 1 });
    const many = await Promise.all(Array.from({ length: 5 }, () => ipc(mock.ports.ipc, 'backlightControl', { AccessToken: token }, { agent: serial })));
    assert.ok(many.every((r) => r.json.result));
    assert.equal(mock.state.stats.ipcResets, 1);
  });

  test('powerControl: never param-less, never reboot; powerOff → standby; powerOn wakes from standby', async () => {
    assert.equal((await ipc(mock.ports.ipc, 'powerControl', { AccessToken: token })).json.error.code, -32602);
    await ipc(mock.ports.ipc, 'powerControl', { AccessToken: token, power: 'reboot' });
    assert.deepEqual(mock.state.violations.map((v) => v.kind), ['ipc-powerControl-without-param', 'ipc-reboot']);
    await ipc(mock.ports.ipc, 'powerControl', { AccessToken: token, power: 'powerOff' });
    await waitFor(() => mock.state.power === 'standby');
    await assert.rejects(ipc(mock.ports.ipc, 'getTVStates', { AccessToken: token }));
    await ipc(mock.ports.ipc, 'powerControl', { AccessToken: token, power: 'powerOn' });
    await waitFor(() => mock.state.power === 'on');
    mock.options.standbyIpcPowerOn = false;
    mock.setPower('standby');
    await assert.rejects(ipc(mock.ports.ipc, 'powerControl', { AccessToken: token, power: 'powerOn' }));
    mock.setPower('on');
  });
});

describe('DIAL (8080)', () => {
  let mock;
  before(async () => { mock = await startMockTv(); });
  after(() => mock.stop());

  test('GET /ws/app/<Name> returns the real state XML', async () => {
    const r = await request({ port: mock.ports.dial, path: '/ws/app/Netflix' });
    assert.equal(r.status, 200);
    assert.equal(r.body, fixture('dial/netflix.xml'));
    assert.equal((await request({ port: mock.ports.dial, path: '/ws/app/NoSuchApp' })).status, 404);
  });

  test('POST /ws/app/<Name> launches with its body recorded', async () => {
    const r = await request({ port: mock.ports.dial, path: '/ws/app/YouTube', method: 'POST', body: 'v=dQw4w9WgXcQ', headers: { 'Content-Type': 'text/plain; charset=utf-8', Origin: 'https://www.youtube.com' } });
    assert.equal(r.status, 201);
    assert.equal(r.headers.location, `http://127.0.0.1:${mock.ports.dial}/ws/apps/YouTube/run`);
    assert.deepEqual(mock.state.dial.launches.map(({ name, body, contentType }) => ({ name, body, contentType })),
      [{ name: 'YouTube', body: 'v=dQw4w9WgXcQ', contentType: 'text/plain; charset=utf-8' }]);
    assert.match((await request({ port: mock.ports.dial, path: '/ws/app/YouTube' })).body, /<state>running<\/state>/);
    const yt = JSON.parse((await request({ port: mock.ports.rest, path: '/api/v2/applications/111299001912/' })).body);
    assert.equal(yt.visible, true);
  });
});

describe('Wake-on-LAN (UDP)', () => {
  let mock;
  before(async () => { mock = await startMockTv({ power: 'standby', wakeDelayMs: 10 }); });
  after(() => mock.stop());

  const magic = (mac) => {
    const bytes = Buffer.from(mac.replace(/:/g, ''), 'hex');
    return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
  };
  const send = (buf) => new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.send(buf, mock.ports.wolUdp, '127.0.0.1', (err) => { s.close(); if (err) reject(err); else resolve(); });
  });

  test('parseMagicPacket accepts 6×FF + 16×MAC only', () => {
    assert.equal(parseMagicPacket(magic('02:4c:55:4d:45:4e')), '02:4c:55:4d:45:4e');
    assert.equal(parseMagicPacket(Buffer.alloc(102, 0xff).fill(0, 0, 1)), null);
  });

  test('a packet for another MAC is recorded but does not wake the TV', async () => {
    await send(magic('02:00:00:00:00:99'));
    await waitFor(() => mock.state.wol.length === 1);
    assert.deepEqual([mock.state.wol[0].mac, mock.state.wol[0].matches], ['02:00:00:00:00:99', false]);
    await sleep(50);
    assert.equal(mock.state.power, 'standby');
  });

  test('the right magic packet wakes the mock from standby', async () => {
    await send(magic(mock.options.wifiMac));
    await waitFor(() => mock.state.power === 'on');
    assert.equal(mock.state.wol.at(-1).matches, true);
  });
});
