// Mock Samsung 2020 TV for offline end-to-end tests. Loopback only. Zero dependencies.
//   REST   http://127.0.0.1:<rest>/api/v2/            (8001 analogue)
//   remote wss://127.0.0.1:<wss>/api/v2/channels/samsung.remote.control (8002 analogue, self-signed)
//   UPnP   http://127.0.0.1:<dmr>/dmr + RenderingControl SOAP + GENA (9197 analogue)
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { encodeFrame, makeFrameParser } from '../mini-ws-server.mjs';

const RCS = 'urn:schemas-upnp-org:service:RenderingControl:1';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function startMockTv({ rest = 18001, wss = 18002, dmr = 19197, dropNotify = false, log = () => {} } = {}) {
  const state = { volume: 4, mute: false, power: 'on', token: '87654321', subs: new Map(), keys: [] };

  // ---------- REST ----------
  const restSrv = http.createServer((req, res) => {
    if (req.url === '/api/v2/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ device: { PowerState: state.power, TokenAuthSupport: 'true', modelName: 'MOCK55Q95T', name: 'Mock TV', type: 'Samsung SmartTV' }, isSupport: '{"remote_available":"true"}', remote: '1.0', version: '2.0.25' }));
    }
    const m = /^\/api\/v2\/applications\/([^/]+)(\/?)$/.exec(req.url);
    if (m && !m[2]) return req.socket.destroy(); // real TV drops the connection without the trailing slash
    if (m) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: m[1], name: m[1], running: false, visible: false, version: '1' })); }
    res.writeHead(404); res.end();
  });

  // ---------- GENA publisher ----------
  let seqBySid = new Map();
  function lastChangeXml() {
    const inner = `<Event xmlns="urn:schemas-upnp-org:metadata-1-0/RCS/"><InstanceID val="0"><Volume channel="Master" val="${state.volume}"/><Mute channel="Master" val="${state.mute ? 1 : 0}"/></InstanceID></Event>`;
    return `<?xml version="1.0"?><e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><LastChange>${esc(inner)}</LastChange></e:property></e:propertyset>`;
  }
  function notify(sid) {
    const sub = state.subs.get(sid); if (!sub || dropNotify) return;
    const seq = seqBySid.get(sid) ?? 0; seqBySid.set(sid, seq + 1);
    const body = lastChangeXml();
    const u = new URL(sub.callback);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'NOTIFY', headers: {
      HOST: u.host, 'CONTENT-TYPE': 'text/xml; charset="utf-8"', NT: 'upnp:event', NTS: 'upnp:propchange', SID: sid, SEQ: String(seq), 'CONTENT-LENGTH': Buffer.byteLength(body) } });
    req.on('error', (e) => log('[mock] notify failed', e.code)); req.on('response', (r) => r.resume()); req.end(body);
  }
  const notifyAll = () => { for (const sid of state.subs.keys()) notify(sid); };

  // ---------- DMR (UPnP) ----------
  const dmrSrv = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
      if (req.method === 'POST' && req.url === '/upnp/control/RenderingControl1') {
        const action = (req.headers.soapaction || '').replace(/"/g, '').split('#')[1];
        const arg = (n) => new RegExp(`<${n}>([^<]*)</${n}>`).exec(body)?.[1];
        let out = '';
        if (action === 'GetVolume') out = `<CurrentVolume>${state.volume}</CurrentVolume>`;
        else if (action === 'GetMute') out = `<CurrentMute>${state.mute ? 1 : 0}</CurrentMute>`;
        else if (action === 'SetVolume') { state.volume = Math.max(0, Math.min(100, +arg('DesiredVolume'))); notifyAll(); }
        else {
          res.writeHead(500, { 'content-type': 'text/xml; charset="utf-8"' });
          return res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>401</errorCode><errorDescription>Invalid Action</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
        }
        res.writeHead(200, { 'content-type': 'text/xml; charset="utf-8"' });
        return res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action}Response xmlns:u="${RCS}">${out}</u:${action}Response></s:Body></s:Envelope>`);
      }
      if (req.url === '/upnp/event/RenderingControl1' && req.method === 'SUBSCRIBE') {
        if (req.headers.sid) { // renewal
          if (!state.subs.has(req.headers.sid)) { res.writeHead(412); return res.end(); }
          res.writeHead(200, { SID: req.headers.sid, TIMEOUT: 'Second-300' }); return res.end();
        }
        const cb = /<([^>]+)>/.exec(req.headers.callback || '')?.[1];
        if (!cb || req.headers.nt !== 'upnp:event') { res.writeHead(412); return res.end(); }
        const sid = 'uuid:' + crypto.randomUUID();
        state.subs.set(sid, { callback: cb });
        res.writeHead(200, { SID: sid, TIMEOUT: 'Second-300', 'Content-Length': 0 }); res.end();
        setTimeout(() => notify(sid), 50); // initial event (SEQ 0) right after SUBSCRIBE, as UDA requires
        return;
      }
      if (req.url === '/upnp/event/RenderingControl1' && req.method === 'UNSUBSCRIBE') {
        res.writeHead(state.subs.delete(req.headers.sid) ? 200 : 412); return res.end();
      }
      res.writeHead(404); res.end();
    });
  });

  // ---------- 8002 remote channel ----------
  const wssSrv = https.createServer({ key: fs.readFileSync(new URL('../mock-key.pem', import.meta.url)), cert: fs.readFileSync(new URL('../mock-cert.pem', import.meta.url)) });
  wssSrv.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'https://x');
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const data = { id: crypto.randomUUID(), clients: [] };
    if (url.searchParams.get('token') !== state.token) data.token = state.token; // first pairing: TV hands out a token
    socket.write(encodeFrame(1, JSON.stringify({ event: 'ms.channel.connect', data })));
    socket.on('data', makeFrameParser((op, p) => {
      if (op === 0x9) return socket.write(encodeFrame(0xA, p));
      if (op === 0x8) return socket.end(encodeFrame(0x8, p.subarray(0, 2)));
      if (op !== 0x1) return;
      const msg = JSON.parse(p.toString());
      if (msg.method === 'ms.remote.control') {
        const key = msg.params.DataOfCmd; state.keys.push(key);
        if (key === 'KEY_VOLUP') state.volume = Math.min(100, state.volume + 1);
        if (key === 'KEY_VOLDOWN') state.volume = Math.max(0, state.volume - 1);
        if (key === 'KEY_MUTE') state.mute = !state.mute;
        if (/^KEY_VOL|^KEY_MUTE/.test(key)) notifyAll();
      }
    }));
    socket.on('error', () => {});
  });

  await Promise.all([[restSrv, rest], [dmrSrv, dmr], [wssSrv, wss]].map(([s, p]) => new Promise((r) => s.listen(p, '127.0.0.1', r))));
  return { state, close: () => { restSrv.close(); dmrSrv.close(); wssSrv.close(); }, setDropNotify: (v) => { dropNotify = v; } };
}
