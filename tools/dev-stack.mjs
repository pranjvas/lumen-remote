#!/usr/bin/env node
// Dev stack: the mock TV (test/mock-tv.js) plus the REAL Lumen server (server/app.js) wired to it,
// so the UI can be exercised end to end without the real TV. Everything binds 127.0.0.1; WoL goes
// only to the mock's UDP port; the AI backend is off unless --ai fake is given (a scripted
// stand-in that calls the real Lumen tools and never contacts Claude).
//
//   node tools/dev-stack.mjs [--port 8798] [--power on|standby] [--no-agent] [--unpaired] [--ai off|fake]
//
// --unpaired starts without the remote and IP Control tokens, so the Pair banners can be tried
// (the mock TV answers its Allow prompt by itself).
//
// Type commands on stdin to simulate the physical remote (the banner lists them). Ctrl+C stops.
// Scripts can import { startDevStack } to drive the same stack in-process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { startMockTv } from '../test/mock-tv.js';
import { connectAgent, AGENT_SNAPSHOT, AGENT_APPS } from '../test/helpers.js';
import { startServer } from '../server/app.js';
import { callTool, describeInput, describeResult } from '../server/ai/tools.js';

const AGENT_STATE_MS = 5000;

// ---------- optional scripted AI (no network, no Claude) ----------

// Stands in for the API backend: maps a few phrases to the real Lumen tools (server/ai/tools.js),
// so the Ask UI, the tool layer and the hub are exercised exactly as a Claude run would.
function fakeAiBackends() {
  const unused = { isConfigured: () => false, availability: () => ({ available: false, reason: 'not used' }), isAvailable: async () => ({ available: false }) };
  const plan = (text) => {
    if (/bright|dim/.test(text)) return ['change_setting', { key: 'picture.backlight', delta: /(dim|lower|decrease|down)/.test(text) ? -4 : 4 }];
    if (/volume|louder|quieter/.test(text)) return ['change_volume', { delta: /(down|quieter|lower|decrease)/.test(text) ? -3 : 3 }];
    if (/hdmi\s*\d/.test(text)) return ['set_input', { source: `HDMI${/hdmi\s*(\d)/.exec(text)[1]}` }];
    if (/cinema|night/.test(text)) return ['run_scene', { name: /cinema/.test(text) ? 'Cinema' : 'Night' }];
    if (/sleep/.test(text)) return ['sleep_timer', { minutes: Number(/(\d+)/.exec(text)?.[1] ?? 30) }];
    if (/showing|what/.test(text)) return ['get_tv_state', {}];
    return null;
  };
  const api = {
    isConfigured: () => true,
    async run(request, { emit, toolContext }) {
      emit({ kind: 'status', text: 'Thinking… (dev-stack scripted AI)' });
      const step = plan(request.toLowerCase());
      if (!step) return { ok: true, text: 'Scripted dev AI: try "increase brightness", "volume up", "switch to HDMI 1", "cinema mode" or "sleep in 30 minutes".', tools: [] };
      const [name, input] = step;
      emit({ kind: 'status', text: `Running ${name}…` });
      const out = await callTool(name, input, toolContext);
      emit({ kind: 'tool', name, input: describeInput(input), ok: !out.isError, result: describeResult(out.result) });
      const tools = [{ name, ok: !out.isError }];
      if (out.isError) return { ok: false, tools, error: out.result.error };
      return { ok: true, tools, text: out.result.summary ?? 'Done.' };
    },
  };
  return { api, claudeCode: unused };
}

// ---------- the stack ----------

// → { url, mock, server, dataDir, agent, stop() }
export async function startDevStack({ port = 8798, power = 'on', agent: withAgent = true, ai = 'off', paired = true } = {}) {
  const mock = await startMockTv({ power });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-dev-'));
  const hex = () => randomBytes(32).toString('hex');
  const seed = {
    ...(paired && { 'tv.json': { token: mock.tokens.remote }, 'ipcontrol.json': { token: mock.tokens.ipc } }),
    'secrets.json': { genaSecret: hex(), agentKey: hex(), castSecret: hex(), mcpToken: hex() },
  };
  for (const [name, obj] of Object.entries(seed)) fs.writeFileSync(path.join(dataDir, name), JSON.stringify(obj, null, 2));

  let server;
  try {
    server = await startServer({
      dataDir,
      tv: mock.tv,
      http: { host: '127.0.0.1', port },
      lan: { enabled: true, port: 0 },
      wol: { targets: ['127.0.0.1'], ports: [mock.ports.wolUdp] },
      ai: { backend: ai === 'fake' ? 'api' : 'off' },
      log: { level: 'info', console: false },
    }, ai === 'fake' ? { aiBackends: fakeAiBackends() } : {});
  } catch (err) {
    await mock.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw err;
  }

  // A fake on-TV agent (spec §5.5) whose snapshot follows the mock, re-sent like the real one.
  const agentSnapshot = () => {
    const m = /^([A-Z]+?)(\d*)$/.exec(mock.state.input ?? 'TV');
    return {
      ...AGENT_SNAPSHOT,
      source: { type: m?.[1] ?? 'TV', number: Number(m?.[2] || 1) },
      audio: { ...AGENT_SNAPSHOT.audio, volume: mock.state.volume, mute: mock.state.mute },
    };
  };
  let agent = null;
  let agentTimer = null;
  if (withAgent) {
    // No icons: the test PNG is a single pixel, so the tiles show their brand monograms instead.
    agent = connectAgent({ port: server.lanPort, key: server.agentKey, snapshot: agentSnapshot(), apps: AGENT_APPS, icons: {} });
    agentTimer = setInterval(() => {
      if (agent.ws.readyState === agent.ws.OPEN && mock.state.power === 'on') agent.sendState(agentSnapshot());
    }, AGENT_STATE_MS);
  }

  let stopping = null;
  return {
    url: `http://127.0.0.1:${server.httpPort}`,
    mock,
    server,
    dataDir,
    agent,
    stop() {
      stopping ??= (async () => {
        clearInterval(agentTimer);
        agent?.close();
        await server.stop().catch(() => {});
        await mock.stop().catch(() => {});
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      })();
      return stopping;
    },
  };
}

// ---------- command line ----------

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(list[i]);
    if (!m) continue;
    out[m[1]] = m[2] ?? (list[i + 1] && !list[i + 1].startsWith('--') ? list[++i] : 'true');
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port ?? 8798);
  let stack;
  try {
    stack = await startDevStack({
      port,
      power: args.power === 'standby' ? 'standby' : 'on',
      agent: args['no-agent'] === undefined,
      paired: args.unpaired === undefined,
      ai: args.ai === 'fake' ? 'fake' : 'off',
    });
  } catch (err) {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use; pass --port <n>` : `Lumen could not start: ${err.message}`);
    process.exit(1);
  }
  const { mock, server } = stack;
  console.log(`Lumen dev stack: ${stack.url}`);
  console.log(`  mock TV on 127.0.0.1 (rest ${mock.ports.rest}, wss ${mock.ports.wss}, dmr ${mock.ports.dmr}, ipc ${mock.ports.ipc}, dial ${mock.ports.dial}); TV-facing listener :${server.lanPort}`);
  console.log(`  agent: ${stack.agent ? 'fake agent connected' : 'off'} · ai: ${args.ai === 'fake' ? 'scripted fake' : 'off'} · data: ${stack.dataDir}`);
  console.log('  stdin: vol <n> | mute on|off | input <TV|HDMI1..4> | mode <Dynamic|Standard|Natural|Movie> | backlight <n> | power on|standby | app <id> | ime open|close | touch on|off | quit');

  const commands = {
    vol: (v) => mock.setVolume(Number(v)),
    mute: (v) => mock.setMute(v === 'on'),
    input: (v) => mock.setInput(v),
    mode: (v) => mock.setPictureMode(v),
    backlight: (v) => mock.setPicture('backlight', Number(v)),
    power: (v) => mock.setPower(v),
    app: (v) => mock.setForeground(v),
    ime: (v) => (v === 'open' ? mock.ime.start('text') : mock.ime.end()),
    touch: (v) => mock.setTouch(v === 'on'),
  };

  const shutdown = async () => {
    rl?.close();
    await stack.stop();
    console.log('dev stack stopped');
    process.exit(0);
  };
  const rl = process.stdin.isTTY || args.stdin ? readline.createInterface({ input: process.stdin }) : null;
  rl?.on('line', (line) => {
    const [name, value] = line.trim().split(/\s+/);
    if (!name) return;
    if (name === 'quit' || name === 'exit') return shutdown();
    const run = commands[name];
    if (!run) return console.log(`unknown: ${name}`);
    try {
      run(value);
      console.log(`ok: ${line.trim()}`);
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
