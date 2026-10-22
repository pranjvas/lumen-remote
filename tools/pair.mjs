// One-time pairing with the TV's remote-control channel.
// Shows the TV's "Allow" prompt; someone must accept it with the physical remote.
// Saves the issued token to data/tv.json, then reads the installed-app list (no visible effect on the TV).
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';

const host = process.argv[2] || '192.168.1.2';
const clientName = 'Lumen Remote';
const dataDir = path.resolve(import.meta.dirname, '..', 'data');
const file = path.join(dataDir, 'tv.json');
const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const name = Buffer.from(clientName).toString('base64');
const tokenPart = saved.token ? `&token=${saved.token}` : '';
const url = `wss://${host}:8002/api/v2/channels/samsung.remote.control?name=${name}${tokenPart}`;

console.log(`[pair] connecting ${url.replace(/token=[^&]+/, 'token=***')}`);
const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 10000 });
const t0 = Date.now();
const stop = setTimeout(() => { console.log('[pair] no answer after 90 s; giving up'); ws.terminate(); }, 90000);

ws.on('open', () => console.log(`[pair] socket open after ${Date.now() - t0} ms; waiting for the TV (accept the prompt on screen)`));
ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString());
  const summary = JSON.stringify(msg).slice(0, 400).replace(/"token":"[^"]+"/, '"token":"***"');
  console.log(`[pair] +${Date.now() - t0} ms ${msg.event}: ${summary}`);
  if (msg.event === 'ms.channel.connect') {
    const token = msg.data && msg.data.token;
    if (token) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...saved, host, clientName, token, pairedAt: new Date().toISOString() }, null, 2));
      console.log('[pair] token saved to data/tv.json');
    } else {
      console.log('[pair] connected without a new token (existing token accepted)');
    }
    ws.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host' } }));
  }
  if (msg.event === 'ed.installedApp.get') {
    const apps = (msg.data && msg.data.data) || [];
    console.log(`[pair] installed apps: ${apps.length}`);
    for (const a of apps) console.log(`  ${a.appId}  ${a.name}  type=${a.app_type}`);
    clearTimeout(stop);
    ws.close();
  }
  if (msg.event === 'ms.channel.unauthorized' || msg.event === 'ms.channel.timeOut') {
    clearTimeout(stop);
    ws.close();
  }
});
ws.on('error', (e) => console.log(`[pair] error: ${e.message}`));
ws.on('close', (code, reason) => console.log(`[pair] closed ${code} ${reason}`));
