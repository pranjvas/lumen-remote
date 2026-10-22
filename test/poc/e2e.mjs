// End-to-end: mock TV <-> host runtime <-> "browser" (fetch + SSE reader). Loopback only.
import { startMockTv } from './mock-tv.mjs';
import { soap, GenaSubscriber, RemoteChannel, createWebServer, localAddressTowards } from './host-poc.mjs';

const RCS = 'urn:schemas-upnp-org:service:RenderingControl:1';
const tv = await startMockTv({ rest: 18001, wss: 18002, dmr: 19197 });
const WEB = 18790;
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// state + TV clients
const state = { volume: null, mute: null, volumeSource: null, events: 'unknown', channel: 'down' };
const ctl = 'http://127.0.0.1:19197/upnp/control/RenderingControl1';
async function pollVolume(src) { const r = await soap(ctl, RCS, 'GetVolume', { InstanceID: 0, Channel: 'Master' }); update({ volume: +r.CurrentVolume, volumeSource: src }); }
let web;
function update(p) { Object.assign(state, p); web?.broadcast('state', state); }

const callbackHost = await localAddressTowards('127.0.0.1', 19197);
ok(callbackHost === '127.0.0.1', 'localAddressTowards gives callback address ' + callbackHost);
const gena = new GenaSubscriber({ eventUrl: 'http://127.0.0.1:19197/upnp/event/RenderingControl1', callbackHost, callbackPort: WEB, path: '/gena/rc', firstEventMs: 1500 });
gena.on('change', (c) => update({ ...(c.Volume ? { volume: +c.Volume.Master } : {}), ...(c.Mute ? { mute: c.Mute.Master === '1' } : {}), volumeSource: 'gena', events: 'live' }));
let pollTimer;
gena.on('blocked', () => { update({ events: 'blocked-polling' }); pollTimer = setInterval(() => pollVolume('poll').catch(() => {}), 500); });

const remote = new RemoteChannel({ host: '127.0.0.1', port: 18002, name: 'WebRemote' });
let savedToken; remote.on('token', (t) => (savedToken = t)); remote.on('ready', () => update({ channel: 'ready' }));

web = createWebServer({ port: WEB, gena, getState: () => state, onCommand: async (path, body) => {
  if (path === '/api/key') { remote.sendKey(body.key); return { ok: true }; }
  if (path === '/api/volume/get') { await pollVolume('get'); return state; }
  throw new Error('unknown');
} });
await web.listen();
remote.connect();
await gena.subscribe();

// SSE reader using fetch streaming (Node 22 has no global EventSource without a flag)
const seen = [];
const ac = new AbortController();
(async () => {
  const r = await fetch(`http://127.0.0.1:${WEB}/api/events`, { signal: ac.signal });
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of r.body) { buf += dec.decode(chunk, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); const d = /^data: (.*)$/m.exec(f)?.[1]; if (d) seen.push(JSON.parse(d)); } }
})().catch(() => {});

await sleep(800);
ok(state.channel === 'ready' && savedToken === '87654321', `8002 channel ready, token issued+captured for persistence (${savedToken})`);
ok(state.events === 'live' && state.volume === 4, `initial GENA event (SEQ 0) delivered volume=${state.volume}`);

const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:${WEB}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
ok((await post('/api/key', { key: 'KEY_VOLUP' })).status === 403, 'POST without CSRF header rejected (403)');
ok((await post('/api/key', { key: 'KEY_VOLUP' }, { 'x-tvr-csrf': web.csrf, origin: 'http://evil.example' })).status === 403, 'POST with foreign Origin rejected (403)');
const rebind = await new Promise((resolve) => { // DNS-rebinding style request: right socket, wrong Host
  import('node:http').then(({ default: http }) => http.get({ host: '127.0.0.1', port: WEB, path: '/api/state', headers: { Host: 'attacker.example:' + WEB } }, (r) => { r.resume(); resolve(r.statusCode); }));
});
ok(rebind === 421, 'request with foreign Host header rejected (421)');

ok((await post('/api/key', { key: 'KEY_VOLUP' }, { 'x-tvr-csrf': web.csrf })).status === 200, 'KEY_VOLUP accepted with CSRF header');
await sleep(4000); // longer than requestTimeout=2000 to show SSE survives
ok(state.volume === 5 && seen.at(-1)?.volume === 5 && seen.at(-1)?.volumeSource === 'gena', `volume pushed TV->GENA->SSE->browser: ${JSON.stringify(seen.at(-1))} (SSE frames seen ${seen.length}, stream alive after 4s)`);

// Simulate Windows Firewall blocking inbound NOTIFY: resubscribe with drops on
tv.setDropNotify(true);
await gena.unsubscribe(); await gena.subscribe();
await sleep(2000);
ok(state.events === 'blocked-polling', 'no initial NOTIFY within 1.5s => marked blocked, polling fallback engaged');
await post('/api/key', { key: 'KEY_VOLUP' }, { 'x-tvr-csrf': web.csrf });
await sleep(1200);
ok(state.volume === 6 && seen.at(-1)?.volumeSource === 'poll', `volume still reaches browser via polling: ${JSON.stringify(seen.at(-1))}`);

// REST quirk
const rest = await (await fetch('http://127.0.0.1:18001/api/v2/')).json();
ok(rest.device.PowerState === 'on', 'REST PowerState read');
const noSlash = await fetch('http://127.0.0.1:18001/api/v2/applications/111299001912').then(() => 'resolved', (e) => e.cause?.code || e.message);
ok(noSlash !== 'resolved', 'app URL without trailing slash => connection dropped (' + noSlash + ')');

// UPnP fault surfaces as error code
const fault = await soap(ctl, RCS, 'X_Nope', {}).catch((e) => e.upnpCode);
ok(fault === 401, 'SOAP fault parsed to UPnP errorCode ' + fault);

clearInterval(pollTimer); ac.abort(); remote.close(); await gena.unsubscribe(); web.server.close(); tv.close();
setTimeout(() => process.exit(0), 300);
