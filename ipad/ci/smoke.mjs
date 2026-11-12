#!/usr/bin/env node
// CI check for the iPad app (.github/workflows/ipad.yml): a mock TV on the build machine, the app
// in the iOS simulator pointed at it, and a browser-like client that drives the app's server.
//
//   node ipad/ci/smoke.mjs --data <the app's Documents/data folder> [--port 8790]
//                          [--out <folder for results>] [--wait <seconds>]
//                          [--page] [--screenshot <png>]
//
// --page also expects the app's own web view to load the UI and connect (not for a bare server).
//
// It seeds the data folder (config, pairing tokens, secrets), writes <data>/.seeded, then waits for
// the app to be launched and its server to answer. Exit code 0 means every check passed.
// The same script works against `node server/embedded.js` on any machine (no simulator needed).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { startMockTv } from '../../test/mock-tv.js';
import { connectBrowser, connectAgent, AGENT_SNAPSHOT, AGENT_APPS, sleep, waitFor } from '../../test/helpers.js';

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const m = /^--([\w-]+)$/.exec(list[i]);
    if (m) out[m[1]] = list[i + 1] && !list[i + 1].startsWith('--') ? list[++i] : 'true';
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.data) {
  console.error('usage: node ipad/ci/smoke.mjs --data <data folder> [--port 8790] [--out <folder>] [--screenshot <png>] [--wait <seconds>]');
  process.exit(2);
}
const dataDir = path.resolve(args.data);
const port = Number(args.port ?? 8790);
const outDir = args.out ? path.resolve(args.out) : null;
const waitS = Number(args.wait ?? 180);
const base = `http://127.0.0.1:${port}`;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
async function check(name, fn) {
  try {
    record(name, true, (await fn()) ?? '');
  } catch (err) {
    record(name, false, err?.message ?? err);
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------- the mock TV and the seeded data folder ----------

const mock = await startMockTv({ power: 'on' });
const hex = () => randomBytes(32).toString('hex');
const secrets = { genaSecret: hex(), agentKey: hex(), castSecret: hex(), mcpToken: hex() };
const seed = {
  'config.json': { tv: mock.tv, http: { port }, wol: { targets: ['127.0.0.1'], ports: [mock.ports.wolUdp] } },
  'tv.json': { token: mock.tokens.remote },
  'ipcontrol.json': { token: mock.tokens.ipc },
  'secrets.json': secrets,
};
fs.mkdirSync(dataDir, { recursive: true });
for (const [name, obj] of Object.entries(seed)) fs.writeFileSync(path.join(dataDir, name), JSON.stringify(obj, null, 2));
fs.rmSync(path.join(dataDir, 'host-status.json'), { force: true });
fs.writeFileSync(path.join(dataDir, '.seeded'), new Date().toISOString());
console.log(`mock TV on 127.0.0.1 (rest ${mock.ports.rest}, wss ${mock.ports.wss}, dmr ${mock.ports.dmr}, ipc ${mock.ports.ipc}); data folder seeded: ${dataDir}`);
console.log(`waiting up to ${waitS} s for Lumen on ${base} ...`);

// ---------- wait for the app's server ----------

async function health() {
  const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
  return res.json();
}

let up = null;
const began = Date.now();
while (Date.now() - began < waitS * 1000) {
  try {
    const h = await health();
    if (h?.app === 'lumen' && h.ready) {
      up = h;
      break;
    }
  } catch { /* not up yet */ }
  await sleep(1000);
}
record('the server inside the app answers', Boolean(up), up ? `version ${up.version}, after ${Math.round((Date.now() - began) / 1000)} s` : `nothing on ${base} after ${waitS} s`);

let browser = null;
let agent = null;
if (up) {
  await check('host-status.json says ready', () => {
    const status = JSON.parse(fs.readFileSync(path.join(dataDir, 'host-status.json'), 'utf8'));
    expect(status.state === 'ready' && status.httpPort === port, JSON.stringify(status));
    return `lan port ${status.lanPort}`;
  });

  await check('the web UI is served', async () => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    expect(res.status === 200 && html.includes('<title>Lumen</title>'), `HTTP ${res.status}`);
    return `${html.length} bytes`;
  });

  await check('a browser client connects and sees an embedded host', async () => {
    browser = connectBrowser(port);
    await browser.hello;
    expect(browser.value('host.embedded') === true, `host.embedded is ${JSON.stringify(browser.value('host.embedded'))}`);
  });

  if (browser) {
    await check('the TV shows as on', async () => {
      await browser.waitForState('conn.tv', (r) => r?.v === 'on', { timeout: 30000 });
    });

    await check('a key press reaches the TV (remote channel, wss)', async () => {
      const ack = await browser.send('key', { key: 'KEY_UP' }, { timeout: 30000 });
      expect(ack.ok === true, JSON.stringify(ack.error));
      await waitFor(() => mock.state.keys.some((k) => k.key === 'KEY_UP' && k.cmd === 'Click'), { timeout: 10000 });
      return `${ack.ms} ms`;
    });

    await check('volume.set changes the TV volume (UPnP)', async () => {
      const ack = await browser.send('volume.set', { value: 23 }, { timeout: 30000 });
      expect(ack.ok === true, JSON.stringify(ack.error));
      expect(mock.state.volume === 23, `the mock TV is at ${mock.state.volume}`);
    });

    await check('a picture setting changes (IP Control, old TLS with 1024-bit DH)', async () => {
      const ack = await browser.send('setting.set', { key: 'picture.backlight', value: 17 }, { timeout: 30000 });
      expect(ack.ok === true, JSON.stringify(ack.error));
      expect(mock.state.picture.backlight === 17, `the mock TV is at ${mock.state.picture.backlight}`);
      const rec = await browser.waitForState('picture.backlight', (r) => r?.v === 17, { timeout: 10000 });
      return `source ${rec.src}`;
    });

    await check('the TV agent can call in (port from host-status.json)', async () => {
      const status = JSON.parse(fs.readFileSync(path.join(dataDir, 'host-status.json'), 'utf8'));
      agent = connectAgent({ port: status.lanPort, key: secrets.agentKey, snapshot: AGENT_SNAPSHOT, apps: AGENT_APPS, icons: {}, version: '0.3.0' });
      await agent.opened;
      await browser.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 20000 });
    });

    await check('the Browser says why it is unavailable', async () => {
      const ack = await browser.send('browser.open', { url: 'https://example.com' }, { timeout: 30000 });
      expect(ack.ok === false && /iPad/.test(JSON.stringify(ack.error ?? '')), JSON.stringify(ack));
      return ack.error?.message ?? '';
    });
  }
}

// The page in the app's web view reports its screen size once its connection is open; the server
// logs that as "phone screen" (the smoke test's own client never sends it).
if (up && args.page) {
  await check("the app's own page loads and connects (web view)", async () => {
    const logFile = path.join(dataDir, 'logs', 'lumen.log');
    const began = Date.now();
    await waitFor(() => {
      try {
        return fs.readFileSync(logFile, 'utf8').includes('phone screen');
      } catch {
        return false;
      }
    }, { timeout: 120000, interval: 500, message: 'no "phone screen" line in lumen.log' });
    return `after ${Math.round((Date.now() - began) / 1000)} s`;
  });
}

// ---------- results ----------

if (args.screenshot) {
  await sleep(4000); // let the page in the app paint the state it just received
  try {
    execFileSync('xcrun', ['simctl', 'io', 'booted', 'screenshot', path.resolve(args.screenshot)], { stdio: 'ignore' });
    console.log(`screenshot saved: ${args.screenshot}`);
  } catch (err) {
    console.log(`screenshot failed: ${err.message}`);
  }
}

const failed = results.filter((r) => !r.ok);
if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'smoke.json'), JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
}
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);

browser?.close();
agent?.close();
await mock.stop().catch(() => {});
process.exit(failed.length ? 1 : 0);
