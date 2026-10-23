// Agent SDK backend (spec §11.1, follow-up 1 part A): the JSON-schema → zod conversion of the Lumen
// tools, the mapping of SDK messages to Lumen `ai` events with a fake query(), the login check, and
// backend selection in server/ai/index.js. No real query() ever runs here: that would spend the
// user's Claude plan usage.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AbortError } from '@anthropic-ai/claude-agent-sdk';
import { SIGN_IN, checkClaudeLogin, createAgentSdkBackend, credentialsFile, toZodShape } from '../server/ai/agent-sdk-backend.js';
import { createAi } from '../server/ai/index.js';
import { SYSTEM_PROMPT } from '../server/ai/prompt.js';
import { TOOL_DEFINITIONS } from '../server/ai/tools.js';
import { createTestLog } from './helpers.js';

const NOTE = 'Uses your Claude Code login (personal use)';
const definition = (name) => TOOL_DEFINITIONS.find((tool) => tool.name === name);
const objectOf = (name) => z.object(toZodShape(definition(name).inputSchema));
const accepts = (name, input) => objectOf(name).safeParse(input).success;

// ---------- fixtures ----------

function fakeStore(values = {}) {
  const records = new Map(Object.entries(values).map(([key, v]) => [key, { v, src: 'live', at: Date.now() }]));
  return { get: (key) => records.get(key), set: (key, v) => records.set(key, { v, src: 'live', at: Date.now() }) };
}

function fakeHub(store) {
  const calls = [];
  return {
    calls,
    async handle(cmd) {
      calls.push(cmd);
      if (cmd.cmd === 'volume.set') {
        store.set('audio.volume', cmd.value);
        return { ok: true, value: cmd.value };
      }
      if (cmd.cmd === 'power') return { ok: false, error: { code: 'COOLDOWN', message: 'Power was toggled a moment ago' } };
      return { ok: true, value: null };
    },
  };
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ai-sdk-'));
const aiConfig = (ai = {}) => ({ ai: { backend: 'auto', model: 'claude-opus-5-5', effort: 'low', ...ai } });

// SDK message shapes (sdk.d.ts: SDKSystemMessage, SDKAssistantMessage, SDKUserMessage, SDKResultMessage).
const init = (status = 'connected') => ({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', mcp_servers: [{ name: 'lumen', status }], tools: [], session_id: 's', uuid: 'u' });
const assistant = (content, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', content: [content] }, parent_tool_use_id: null, session_id: 's', uuid: 'u', ...extra });
const textBlock = (text) => ({ type: 'text', text });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const toolResult = (id, content, isError = false) => ({
  type: 'user', parent_tool_use_id: null, session_id: 's',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError && { is_error: true }) }] },
});
const usage = { input_tokens: 1200, output_tokens: 80 };
const success = (result, extra = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result, num_turns: 3, total_cost_usd: 0.0123, usage,
  permission_denials: [], duration_ms: 1, duration_api_ms: 1, stop_reason: 'end_turn', session_id: 's', uuid: 'u', ...extra,
});
const failure = (subtype, extra = {}) => ({
  type: 'result', subtype, is_error: true, num_turns: 1, total_cost_usd: 0, usage, errors: [], permission_denials: [],
  duration_ms: 1, duration_api_ms: 1, stop_reason: null, session_id: 's', uuid: 'u', ...extra,
});

// Talks to the in-process Lumen MCP server the backend registered, the way the CLI subprocess does.
function fakeCli(options) {
  let client = null;
  return {
    async call(name, args) {
      if (!client) {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await options.mcpServers.lumen.instance.connect(serverTransport);
        client = new Client({ name: 'fake-cli', version: '0' });
        await client.connect(clientTransport);
      }
      return client.callTool({ name, arguments: args });
    },
    close: () => client?.close(),
  };
}

// script({ prompt, options, call }) is an async generator of SDK messages; captured records the query() call.
function fakeQuery(script) {
  const captured = {};
  const query = ({ prompt, options }) => {
    captured.prompt = prompt;
    captured.options = options;
    const cli = fakeCli(options);
    return (async function* run() {
      try {
        yield* script({ prompt, options, call: cli.call });
      } finally {
        await cli.close();
      }
    })();
  };
  return { query, captured };
}

function backendWith(script, { ai, loggedIn = true, timeoutMs } = {}) {
  const { query, captured } = fakeQuery(script);
  const log = createTestLog();
  const dataDir = tempDir();
  const backend = createAgentSdkBackend({
    config: aiConfig(ai), log, dataDir, query, timeoutMs,
    checkLogin: async () => ({ loggedIn, via: 'credentials' }),
  });
  const store = fakeStore({ 'audio.volume': 10 });
  const hub = fakeHub(store);
  const toolContext = { hub, store, catalog: { settings: [], keys: [], apps: [], isAllowedKey: () => true } };
  const events = [];
  const run = (text = 'volume 20', signal = new AbortController().signal) => backend.run(text, { emit: (e) => events.push(e), signal, toolContext });
  return { backend, captured, log, dataDir, hub, events, run };
}

// ---------- tests ----------

describe('agent-sdk: zod shapes from the tool definitions', () => {
  test('every tool converts; required, optional and descriptions carry over', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const shape = toZodShape(tool.inputSchema);
      assert.deepEqual(Object.keys(shape), Object.keys(tool.inputSchema.properties), tool.name);
      for (const [key, property] of Object.entries(tool.inputSchema.properties)) {
        const required = tool.inputSchema.required.includes(key);
        assert.equal(shape[key].safeParse(undefined).success, !required, `${tool.name}.${key} optional`);
        // Optional fields are wrapped; the description lives on the inner type (and reaches the JSON schema).
        const inner = required ? shape[key] : shape[key].unwrap();
        assert.equal(inner.description, property.description, `${tool.name}.${key} description`);
      }
    }
    assert.equal(accepts('get_tv_state', {}), true);
    assert.equal(accepts('list_settings', {}), true);
    assert.equal(accepts('set_volume', {}), false, 'level is required');
  });

  test('integers, ranges, enums, unions and array bounds match the JSON schema', () => {
    assert.equal(accepts('set_volume', { level: 50 }), true);
    assert.equal(accepts('set_volume', { level: 101 }), false);
    assert.equal(accepts('set_volume', { level: 1.5 }), false);
    assert.equal(accepts('change_setting', { key: 'picture.backlight', delta: -100 }), true);
    assert.equal(accepts('change_setting', { key: 'picture.backlight', delta: 101 }), false);
    assert.equal(accepts('power', { action: 'on' }), true);
    assert.equal(accepts('power', { action: 'reboot' }), false);
    assert.equal(accepts('list_settings', { group: 'picture' }), true);
    assert.equal(accepts('list_settings', { group: 'other' }), false);
    for (const value of [14, 'Movie', true]) assert.equal(accepts('set_setting', { key: 'x', value }), true, String(value));
    assert.equal(accepts('set_setting', { key: 'x', value: { a: 1 } }), false);
    assert.equal(accepts('press_keys', { keys: ['KEY_UP'] }), true);
    assert.equal(accepts('press_keys', { keys: [] }), false);
    assert.equal(accepts('press_keys', { keys: Array(21).fill('KEY_UP') }), false);
    assert.equal(accepts('press_keys', { keys: ['KEY_UP'], gapMs: 100 }), false);
    assert.equal(accepts('type_text', { text: 'hi', submit: true }), true);
    assert.equal(accepts('type_text', { text: '' }), false);
    assert.equal(accepts('open_netflix', { url: 'x'.repeat(2049) }), false);
  });

  test('a schema type outside the subset the tools use is rejected loudly', () => {
    assert.throws(() => toZodShape({ properties: { x: { type: 'null' } }, required: [] }), /Unsupported schema type "null"/);
  });
});

describe('agent-sdk: query options and event mapping (fake query, no Claude)', () => {
  test('passes exactly the documented options and registers the Lumen tools in-process', async () => {
    const { captured, run, dataDir } = backendWith(async function* script() {
      yield init();
      yield success('Done.');
    });
    const outcome = await run('turn it up');
    assert.equal(outcome.ok, true);
    assert.equal(captured.prompt, 'turn it up');
    const options = captured.options;
    assert.deepEqual(Object.keys(options).sort(), [
      'abortController', 'allowedTools', 'cwd', 'disallowedTools', 'effort', 'env', 'maxTurns', 'mcpServers', 'model',
      'permissionMode', 'persistSession', 'settingSources', 'stderr', 'strictMcpConfig', 'systemPrompt', 'tools', 'verbatimPrompts',
    ]);
    assert.deepEqual(options.allowedTools, ['mcp__lumen__*', 'WebSearch', 'WebFetch']);
    assert.deepEqual(options.tools, ['WebSearch', 'WebFetch']);
    assert.deepEqual(options.disallowedTools, ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Task']);
    assert.equal(options.permissionMode, 'dontAsk');
    assert.equal(options.systemPrompt, SYSTEM_PROMPT);
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.persistSession, false);
    assert.equal(options.strictMcpConfig, true);
    assert.equal(options.verbatimPrompts, true);
    assert.equal(options.maxTurns, 60);
    assert.equal(options.model, 'claude-opus-5-5');
    assert.equal(options.effort, 'low');
    assert.ok(options.abortController instanceof AbortController);
    assert.equal(options.cwd, path.join(dataDir, 'ai-sandbox'));
    assert.ok(fs.statSync(options.cwd).isDirectory(), 'the sandbox directory is created');
    assert.equal(options.env.PATH ?? options.env.Path, process.env.PATH ?? process.env.Path, 'inherits the environment');
    assert.match(options.env.CLAUDE_AGENT_SDK_CLIENT_APP, /^lumen-remote\/\d/);
    assert.equal(typeof options.stderr, 'function');
    assert.equal(options.mcpServers.lumen.type, 'sdk');
    assert.equal(options.mcpServers.lumen.name, 'lumen');
  });

  test('the in-process server lists all 20 tools with the JSON schema of tools.js and validates inputs', async () => {
    const { captured, run } = backendWith(async function* script() {
      yield init();
      yield success('Done.');
    });
    await run();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await captured.options.mcpServers.lumen.instance.connect(serverTransport);
    const client = new Client({ name: 'probe', version: '0' });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name), TOOL_DEFINITIONS.map((tool) => tool.name));
      for (const tool of tools) {
        const want = definition(tool.name);
        assert.equal(tool.description, want.description);
        assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), Object.keys(want.inputSchema.properties), tool.name);
        assert.deepEqual(tool.inputSchema.required ?? [], want.inputSchema.required, `${tool.name} required`);
        for (const [key, property] of Object.entries(want.inputSchema.properties)) {
          assert.equal(tool.inputSchema.properties[key].description, property.description, `${tool.name}.${key} description reaches the model`);
        }
        assert.equal(tool._meta?.['anthropic/alwaysLoad'], true, `${tool.name} is never deferred behind tool search`);
      }
      const ok = await client.callTool({ name: 'set_volume', arguments: { level: 20 } });
      assert.equal(ok.isError, undefined);
      assert.equal(JSON.parse(ok.content[0].text).summary, 'Volume 10 → 20');
      const bad = await client.callTool({ name: 'set_volume', arguments: { level: 101 } });
      assert.equal(bad.isError, true);
      assert.match(bad.content[0].text, /Invalid arguments for tool set_volume/);
      const refused = await client.callTool({ name: 'power', arguments: { action: 'on' } });
      assert.equal(refused.isError, true, 'a hub error is a tool error');
      assert.equal(JSON.parse(refused.content[0].text).error.message, 'Power was toggled a moment ago');
    } finally {
      await client.close();
    }
  });

  test('assistant text, tool_use and tool_result map to text/status/tool events; result carries cost and usage', async () => {
    const { run, events, hub, log } = backendWith(async function* script({ call }) {
      yield init();
      yield assistant(textBlock('Setting the volume.'));
      yield assistant(toolUse('t1', 'mcp__lumen__set_volume', { level: 20 }));
      const volume = await call('set_volume', { level: 20 });
      yield toolResult('t1', volume.content);
      yield assistant(toolUse('t2', 'WebSearch', { query: 'friends netflix title id' }));
      yield toolResult('t2', 'Found netflix.com/title/70153404');
      yield assistant(toolUse('t3', 'mcp__lumen__power', { action: 'on' }));
      const power = await call('power', { action: 'on' });
      yield toolResult('t3', power.content, power.isError);
      yield assistant(textBlock('Volume is now 20.'));
      yield success('Volume 10 → 20.', { permission_denials: [{ tool_name: 'mcp__lumen__type_text', tool_use_id: 'x', tool_input: {} }] });
    });
    const outcome = await run('volume 20');
    assert.deepEqual(events, [
      { kind: 'status', text: 'Thinking…' },
      { kind: 'text', text: 'Setting the volume.' },
      { kind: 'status', text: 'Running set_volume…' },
      { kind: 'tool', name: 'set_volume', input: 'level=20', ok: true, result: 'Volume 10 → 20' },
      { kind: 'status', text: 'Searching the web…' },
      { kind: 'tool', name: 'WebSearch', input: 'query=friends netflix title id', ok: true, result: 'Done' },
      { kind: 'status', text: 'Running power…' },
      { kind: 'tool', name: 'power', input: 'action=on', ok: false, result: 'Power was toggled a moment ago' },
    ]);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.text, 'Volume 10 → 20.');
    assert.deepEqual(outcome.tools, [{ name: 'set_volume', ok: true }, { name: 'WebSearch', ok: true }, { name: 'power', ok: false }]);
    assert.equal(outcome.model, 'claude-opus-5-5');
    assert.equal(outcome.costUsd, 0.0123);
    assert.equal(outcome.turns, 3);
    assert.deepEqual(outcome.usage, { input: 1200, output: 80 });
    assert.deepEqual(outcome.denied, ['type_text']);
    assert.deepEqual(hub.calls, [{ cmd: 'volume.set', value: 20 }, { cmd: 'power', action: 'on' }]);
    assert.ok(log.lines.some((line) => line.level === 'warn' && /denied tools/.test(line.msg) && line.obj.tools[0] === 'type_text'));
  });

  test('an empty result falls back to the last assistant text; a lumen server that failed to connect is reported', async () => {
    const { run, events } = backendWith(async function* script() {
      yield init('failed');
      yield assistant(textBlock('Done it.'));
      yield success('');
    });
    const outcome = await run();
    assert.equal(events[0].text, 'Lumen tools are not reachable from Claude Code (failed)');
    assert.deepEqual([outcome.ok, outcome.text], [true, 'Done it.']);
  });

  test('a not-logged-in result becomes an AUTH error with the sign-in hint', async () => {
    const { run } = backendWith(async function* script() {
      yield init();
      yield success('Not logged in · Please run /login', { is_error: true });
    });
    assert.deepEqual((await run()).error, { code: 'AUTH', message: SIGN_IN });
    assert.equal(SIGN_IN, 'Sign in to Claude Code on this PC (run `claude` once)');
  });

  test('assistant error kinds and result subtypes map to friendly errors', async () => {
    const cases = [
      [[init(), assistant(textBlock('x'), { error: 'authentication_failed' }), success('API Error: 401', { is_error: true })], { code: 'AUTH', message: SIGN_IN }],
      [[init(), assistant(textBlock('x'), { error: 'rate_limit' }), success("You've hit your limit · resets at 5pm", { is_error: true })], { code: 'RATE_LIMIT', message: "You've hit your limit · resets at 5pm" }],
      [[init(), assistant(textBlock('x'), { error: 'overloaded' }), success('API Error: 529', { is_error: true })], { code: 'FAILED', message: 'Claude is overloaded or unavailable; try again' }],
      [[init(), assistant(textBlock('x'), { error: 'max_output_tokens' }), success('', { is_error: true })], { code: 'MAX_TOKENS', message: "Claude's reply was cut off" }],
      [[init(), failure('error_max_turns')], { code: 'FAILED', message: 'Stopped after too many steps' }],
      [[init(), failure('error_max_budget_usd')], { code: 'FAILED', message: 'Stopped: the cost budget was reached' }],
      [[init(), failure('error_during_execution', { errors: ['MCP server lumen failed to start'] })], { code: 'FAILED', message: 'MCP server lumen failed to start' }],
      [[init()], { code: 'FAILED', message: 'Claude Code ended without an answer' }],
    ];
    for (const [messages, expected] of cases) {
      const { run } = backendWith(async function* script() {
        yield* messages;
      });
      const outcome = await run();
      assert.equal(outcome.ok, false);
      assert.deepEqual(outcome.error, expected, JSON.stringify(expected));
    }
  });

  test('errors thrown by query() are mapped, and never escape run()', async () => {
    const thrown = async (err) => (await backendWith(async function* script() {
      yield init();
      throw err;
    }).run()).error;
    assert.deepEqual(await thrown(new Error('Claude Code process exited with code 1')), { code: 'FAILED', message: 'Claude Code process exited with code 1' });
    assert.deepEqual(await thrown(new Error('Invalid API key · Please run /login')), { code: 'AUTH', message: SIGN_IN });
    assert.equal((await thrown(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))).code, 'UNAVAILABLE');
    assert.deepEqual(await thrown(new AbortError('aborted')), { code: 'CANCELLED', message: 'Cancelled' });
  });

  test('cancel aborts the SDK controller and reports CANCELLED; a stuck run times out', async () => {
    const waitForAbort = (options) => new Promise((resolve) => options.abortController.signal.addEventListener('abort', resolve, { once: true }));
    const controller = new AbortController();
    const cancelled = backendWith(async function* script({ options }) {
      yield init();
      await waitForAbort(options);
      throw new AbortError('aborted');
    });
    const pending = cancelled.run('wait', controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const outcome = await pending;
    assert.deepEqual(outcome.error, { code: 'CANCELLED', message: 'Cancelled' });
    assert.equal(cancelled.captured.options.abortController.signal.aborted, true);

    const stuck = backendWith(async function* script({ options }) {
      yield init();
      await waitForAbort(options);
    }, { timeoutMs: 600 });
    const late = await stuck.run('wait');
    assert.deepEqual(late.error, { code: 'TIMEOUT', message: 'Claude Code did not finish within 1 s' });
    assert.equal(stuck.captured.options.abortController.signal.aborted, true);

    const early = backendWith(async function* script() {
      throw new Error('must not run');
    });
    const aborted = new AbortController();
    aborted.abort();
    assert.equal((await early.run('x', aborted.signal)).error.code, 'CANCELLED');
    assert.equal(early.captured.prompt, undefined, 'query() is not called after a cancel');
  });

  test('without a login, or with a bad model/effort, query() is never called', async () => {
    const signedOut = backendWith(async function* script() {
      throw new Error('must not run');
    }, { loggedIn: false });
    assert.deepEqual((await signedOut.run()).error, { code: 'AUTH', message: SIGN_IN });
    assert.equal(signedOut.captured.prompt, undefined);
    const badEffort = backendWith(async function* script() {
      throw new Error('must not run');
    }, { ai: { effort: 'turbo' } });
    assert.equal((await badEffort.run()).error.code, 'INVALID');
    const badModel = backendWith(async function* script() {
      throw new Error('must not run');
    }, { ai: { model: 'opus 5 --bad' } });
    assert.equal((await badModel.run()).error.code, 'INVALID');
  });
});

describe('agent-sdk: login check', () => {
  test('credentialsFile follows CLAUDE_CONFIG_DIR, then the home directory', () => {
    assert.equal(credentialsFile({ CLAUDE_CONFIG_DIR: '/cfg' }), path.join('/cfg', '.credentials.json'));
    assert.equal(credentialsFile({ USERPROFILE: 'C:\\Users\\me' }), path.join('C:\\Users\\me', '.claude', '.credentials.json'));
    assert.equal(credentialsFile({ HOME: '/home/me' }), path.join('/home/me', '.claude', '.credentials.json'));
  });

  test('an existing credentials file counts as logged in; otherwise `claude auth status` decides', async () => {
    const dir = tempDir();
    const file = path.join(dir, '.credentials.json');
    fs.writeFileSync(file, '{}');
    let probed = 0;
    const probe = async () => {
      probed++;
      return true;
    };
    assert.deepEqual(await checkClaudeLogin({ file, probe }), { loggedIn: true, via: 'credentials' });
    assert.equal(probed, 0);
    const missing = path.join(dir, 'missing.json');
    assert.deepEqual(await checkClaudeLogin({ file: missing, probe }), { loggedIn: true, via: 'auth-status' });
    assert.deepEqual(await checkClaudeLogin({ file: missing, probe: async () => false }), { loggedIn: false, via: 'auth-status' });
    assert.deepEqual(await checkClaudeLogin({ file: missing, probe: async () => null }), { loggedIn: false, via: 'none' });
  });

  test('isAvailable caches the answer for 10 minutes and shares one probe', async () => {
    let clock = 1_000_000;
    let checks = 0;
    let answer = true;
    const log = createTestLog();
    const backend = createAgentSdkBackend({
      config: aiConfig(), log, dataDir: tempDir(), query: () => assert.fail('no query'), now: () => clock,
      checkLogin: async () => {
        checks++;
        return { loggedIn: answer, via: 'credentials' };
      },
    });
    assert.equal(backend.availability(), null);
    const [a, b] = await Promise.all([backend.isAvailable(), backend.isAvailable()]);
    assert.deepEqual([a, b, checks], [true, true, 1]);
    assert.deepEqual(backend.availability(), { available: true, reason: null });
    clock += 9 * 60_000;
    assert.equal(await backend.isAvailable(), true);
    assert.equal(checks, 1);
    clock += 2 * 60_000;
    answer = false;
    assert.equal(await backend.isAvailable(), false);
    assert.equal(checks, 2);
    assert.deepEqual(backend.availability(), { available: false, reason: SIGN_IN });
    assert.ok(!log.text().includes('@'), 'no account details are logged');
  });

  test('a failing check means not available, with a warning', async () => {
    const log = createTestLog();
    const backend = createAgentSdkBackend({
      config: aiConfig(), log, dataDir: tempDir(), query: () => assert.fail('no query'),
      checkLogin: async () => { throw new Error('boom'); },
    });
    assert.equal(await backend.isAvailable(), false);
    assert.deepEqual(backend.availability(), { available: false, reason: SIGN_IN });
    assert.ok(log.lines.some((line) => line.level === 'warn' && /login check failed/.test(line.msg)));
  });
});

describe('agent-sdk: backend selection in createAi', () => {
  const sdkFake = (available) => {
    let state = null;
    return {
      availability: () => state,
      async isAvailable() {
        state = { available, reason: available ? null : SIGN_IN };
        return available;
      },
      async run(text, { emit }) {
        emit({ kind: 'status', text: 'Thinking…' });
        return { ok: true, text: `did ${text}`, tools: [{ name: 'set_volume', ok: true }], model: 'claude-opus-5-5', costUsd: 0.01, usage: { input: 10, output: 2 }, turns: 2 };
      },
    };
  };
  const apiFake = (configured) => ({ isConfigured: () => configured, run: async () => ({ ok: true, text: 'api answer', tools: [] }) });

  function makeAi(ai, { api, agentSdk }) {
    const log = createTestLog();
    const store = fakeStore();
    const feature = createAi({
      config: { ...aiConfig(ai), dataDir: tempDir() }, data: { dir: tempDir(), readJson: () => ({}) }, log, store, hub: fakeHub(store),
      backends: { api, agentSdk },
    });
    return { feature, log };
  }

  test('auto: api when configured, else the Agent SDK with the personal-use note, else off', async () => {
    const api = (await makeAi({}, { api: apiFake(true), agentSdk: sdkFake(true) }).feature.status());
    assert.deepEqual(api, { backend: 'api', ready: true, reason: null });
    const sdk = await makeAi({}, { api: apiFake(false), agentSdk: sdkFake(true) }).feature.status();
    assert.deepEqual(sdk, { backend: 'agent-sdk', ready: true, reason: null, note: NOTE });
    const none = await makeAi({}, { api: apiFake(false), agentSdk: sdkFake(false) }).feature.status();
    assert.deepEqual(none, { backend: 'off', ready: false, reason: `${SIGN_IN}, or set ANTHROPIC_API_KEY` });
  });

  test('a chat thread replays earlier exchanges to Claude; other threads and thread-less asks start fresh', async () => {
    const seen = [];
    const agentSdk = sdkFake(true);
    agentSdk.run = async (text) => {
      seen.push(text);
      return { ok: true, text: `answer ${seen.length}`, tools: [{ name: 'WebSearch', ok: true }, { name: 'mcp__lumen__look_at_screen', ok: true }, { name: 'mcp__lumen__look_at_screen', ok: true }] };
    };
    const { feature } = makeAi({}, { api: apiFake(false), agentSdk });
    const emit = () => {};
    await feature.ask('Find and play Harold and Kumar', { id: 'r1', emit, thread: 'chat-1' });
    await feature.ask('It can be on any app', { id: 'r2', emit, thread: 'chat-1' });
    await feature.ask('Mute the TV', { id: 'r3', emit, thread: 'chat-2' });
    await feature.ask('Mute the TV', { id: 'r4', emit });
    assert.equal(seen[0], 'Find and play Harold and Kumar');
    assert.match(seen[1], /^Earlier in this conversation/);
    assert.match(seen[1], /User: Find and play Harold and Kumar\nLumen did: WebSearch, look_at_screen ×2\nLumen replied: answer 1/);
    assert.match(seen[1], /new message \(it may refer to the conversation above\): It can be on any app$/);
    assert.equal(seen[2], 'Mute the TV');
    assert.equal(seen[3], 'Mute the TV');
    feature.forget('chat-1');
    await feature.ask('Again', { id: 'r5', emit, thread: 'chat-1' });
    assert.equal(seen[4], 'Again');
  });

  test('explicit backends: agent-sdk without a login, off, and the retired claude-code value', async () => {
    const signedOut = await makeAi({ backend: 'agent-sdk' }, { api: apiFake(true), agentSdk: sdkFake(false) }).feature.status();
    assert.deepEqual(signedOut, { backend: 'agent-sdk', ready: false, reason: SIGN_IN, note: NOTE });
    const forced = await makeAi({ backend: 'agent-sdk' }, { api: apiFake(true), agentSdk: sdkFake(true) }).feature.status();
    assert.equal(forced.backend, 'agent-sdk');
    const off = await makeAi({ backend: 'off' }, { api: apiFake(true), agentSdk: sdkFake(true) }).feature.status();
    assert.deepEqual([off.backend, off.ready], ['off', false]);
    const retired = await makeAi({ backend: 'claude-code' }, { api: apiFake(true), agentSdk: sdkFake(true) }).feature.status();
    assert.deepEqual(retired, { backend: 'off', ready: false, reason: 'Unknown ai.backend "claude-code"' });
  });

  test('ask runs through the Agent SDK backend and ends with result + done (cost and usage, no secrets)', async () => {
    const { feature, log } = makeAi({}, { api: apiFake(false), agentSdk: sdkFake(true) });
    const events = [];
    const outcome = await feature.ask('volume 20', { id: 'r1', emit: (e) => events.push(e) });
    assert.deepEqual(outcome, { ok: true, text: 'did volume 20', error: undefined });
    assert.deepEqual(events.map((e) => e.kind), ['status', 'result', 'done']);
    assert.deepEqual(events[2], { t: 'ai', id: 'r1', kind: 'done', ok: true, ms: events[2].ms, costUsd: 0.01, usage: { input: 10, output: 2 } });
    const line = log.lines.find((l) => l.msg === 'ask');
    assert.deepEqual([line.obj.backend, line.obj.tools, line.obj.costUsd, line.obj.turns, line.obj.model], ['agent-sdk', ['set_volume'], 0.01, 2, 'claude-opus-5-5']);
  });

  test('ask with no usable backend emits a clean UNAVAILABLE error and done', async () => {
    const { feature } = makeAi({ backend: 'agent-sdk' }, { api: apiFake(false), agentSdk: sdkFake(false) });
    const events = [];
    const outcome = await feature.ask('volume 20', { id: 'r2', emit: (e) => events.push(e) });
    assert.equal(outcome.ok, false);
    assert.deepEqual(events.map((e) => e.kind), ['error', 'done']);
    assert.deepEqual([events[0].code, events[0].message], ['UNAVAILABLE', SIGN_IN]);
    assert.equal(events[1].costUsd, undefined);
  });
});
