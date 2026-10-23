// "agent-sdk" backend: runs the user's own Claude Code login through @anthropic-ai/claude-agent-sdk.
// The Lumen tools are registered in-process (createSdkMcpServer), the built-in tools are limited to
// web search/fetch, and nothing from the user's Claude Code setup (settings, CLAUDE.md, MCP servers,
// sessions) is loaded or written.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AbortError, USAGE_LIMIT_ERROR_PREFIXES, createSdkMcpServer, query as sdkQuery, tool } from '@anthropic-ai/claude-agent-sdk';
import { VERSION } from '../config.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { TOOL_DEFINITIONS, callTool, describeInput, describeResult } from './tools.js';

const TIMEOUT_MS = 360_000; // room for a look-press-look loop inside an app
const AUTH_STATUS_TIMEOUT_MS = 10_000;
const LOGIN_CACHE_MS = 10 * 60_000;
const MAX_TURNS = 60;
const SERVER_NAME = 'lumen';
const MCP_PREFIX = `mcp__${SERVER_NAME}__`;
const BUILTIN_TOOLS = ['WebSearch', 'WebFetch'];
const ALLOWED_TOOLS = [`${MCP_PREFIX}*`, ...BUILTIN_TOOLS];
const DISALLOWED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Task'];
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SAFE_MODEL = /^[\w.:-]+$/;
const LOGIN_PROBLEM = /log ?in|logged in|authenticat|api key|auth token|sign in/i;

export const SIGN_IN = 'Sign in to Claude Code on this PC (run `claude` once)';

const clip = (s, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const displayName = (name) => (name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name);

// ---------- JSON schema → zod raw shape (the definitions in tools.js stay the single source) ----------

function zodType(schema) {
  const types = [schema.type].flat();
  if (types.length > 1) return withDescription(z.union(types.map((type) => zodType({ ...schema, type, description: undefined }))), schema);
  let type;
  switch (types[0]) {
    case 'string':
      type = schema.enum ? z.enum(schema.enum) : bounded(z.string(), schema.minLength, schema.maxLength);
      break;
    case 'integer':
      type = bounded(z.number().int(), schema.minimum, schema.maximum);
      break;
    case 'number':
      type = bounded(z.number(), schema.minimum, schema.maximum);
      break;
    case 'boolean':
      type = z.boolean();
      break;
    case 'array':
      type = bounded(z.array(zodType(schema.items)), schema.minItems, schema.maxItems);
      break;
    case 'object':
      type = z.object(toZodShape(schema));
      break;
    default:
      throw new Error(`Unsupported schema type "${types[0]}"`);
  }
  return withDescription(type, schema);
}

const bounded = (type, min, max) => {
  let out = type;
  if (min !== undefined) out = out.min(min);
  if (max !== undefined) out = out.max(max);
  return out;
};
const withDescription = (type, schema) => (schema.description ? type.describe(schema.description) : type);

// { type: 'object', properties, required } → { key: ZodType } for the SDK's tool() helper.
export function toZodShape(inputSchema) {
  const required = new Set(inputSchema.required ?? []);
  return Object.fromEntries(Object.entries(inputSchema.properties ?? {}).map(([key, property]) => {
    const type = zodType(property);
    return [key, required.has(key) ? type : type.optional()];
  }));
}

// ---------- login check (no prompt, no usage) ----------

// Where Claude Code keeps its OAuth credentials on this PC.
export function credentialsFile(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(env.USERPROFILE || env.HOME || os.homedir(), '.claude');
  return path.join(dir, '.credentials.json');
}

// The CLI bundled with the Agent SDK (the one query() runs), or `claude` on PATH.
function claudeCli() {
  try {
    const pkg = createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const file = path.join(path.dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (fs.existsSync(file)) return file;
  } catch {
    // no platform package: fall back to PATH
  }
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

// `claude auth status --json` → loggedIn, or null when the CLI cannot be run. Account details are
// never logged or returned.
function authStatus(cli) {
  return new Promise((resolve) => {
    execFile(cli, ['auth', 'status', '--json'], { timeout: AUTH_STATUS_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      try {
        resolve(JSON.parse(stdout).loggedIn === true);
      } catch {
        resolve(null);
      }
    });
  });
}

// → { loggedIn, via: 'credentials' | 'auth-status' | 'none' }. The credentials file is the cheap
// answer; the CLI probe covers logins stored elsewhere (for example the macOS keychain).
export async function checkClaudeLogin({ file = credentialsFile(), probe = () => authStatus(claudeCli()) } = {}) {
  if (fs.existsSync(file)) return { loggedIn: true, via: 'credentials' };
  const loggedIn = await probe();
  return loggedIn === null ? { loggedIn: false, via: 'none' } : { loggedIn, via: 'auth-status' };
}

// ---------- SDK messages → Lumen AI events ----------

function toolResultText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('') : '';
}

function createMessageMapper(emit) {
  const pending = new Map();
  const tools = [];
  let held = '';
  let result = null;
  let model = null;
  let assistantError = null;

  function onAssistant(message) {
    if (message.error) assistantError = message.error;
    for (const block of message.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) {
        held = held ? `${held}\n${block.text.trim()}` : block.text.trim();
      } else if (block.type === 'tool_use') {
        // Text written before a tool call is a progress note, not the answer.
        if (held) emit({ kind: 'text', text: held });
        held = '';
        const name = displayName(block.name);
        pending.set(block.id, { name, input: block.input });
        emit({ kind: 'status', text: name === 'WebSearch' ? 'Searching the web…' : `Running ${name}…` });
      }
    }
  }

  function onUser(message) {
    const content = message.message?.content;
    for (const block of Array.isArray(content) ? content : []) {
      const use = block.type === 'tool_result' && pending.get(block.tool_use_id);
      if (!use) continue;
      pending.delete(block.tool_use_id);
      const text = toolResultText(block.content);
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Built-in tools answer in prose; Lumen tools answer in JSON.
      }
      const lumen = parsed && typeof parsed === 'object' && 'ok' in parsed;
      const ok = !block.is_error && (!lumen || parsed.ok !== false);
      const summary = lumen ? describeResult(parsed) : ok ? 'Done' : clip(text || 'Failed', 120);
      tools.push({ name: use.name, ok });
      emit({ kind: 'tool', name: use.name, input: describeInput(use.input), ok, result: summary });
    }
  }

  return {
    message(message) {
      // Subagent traffic never happens here (Task is disallowed), but it is skipped on principle.
      if (message.parent_tool_use_id) return;
      if (message.type === 'system' && message.subtype === 'init') {
        model = message.model ?? null;
        const lumen = message.mcp_servers?.find((server) => server.name === SERVER_NAME);
        if (lumen && lumen.status !== 'connected') emit({ kind: 'status', text: `Lumen tools are not reachable from Claude Code (${lumen.status})` });
        else emit({ kind: 'status', text: 'Thinking…' });
      } else if (message.type === 'assistant') {
        onAssistant(message);
      } else if (message.type === 'user') {
        onUser(message);
      } else if (message.type === 'result') {
        result = message;
      }
    },
    outcome() {
      const usage = result?.usage;
      const extra = {
        tools,
        model,
        costUsd: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : undefined,
        turns: result?.num_turns,
        usage: usage && { input: usage.input_tokens, output: usage.output_tokens },
        denied: (result?.permission_denials ?? []).map((denial) => displayName(denial.tool_name)),
      };
      if (!result) return { ok: false, error: null, ...extra };
      if (result.subtype === 'success' && !result.is_error) {
        return { ok: true, text: (typeof result.result === 'string' ? result.result.trim() : '') || held || 'Done.', ...extra };
      }
      const text = (typeof result.result === 'string' && result.result.trim()) || result.errors?.find(Boolean) || '';
      return { ok: false, error: describeResultError(result, text, assistantError), ...extra };
    },
  };
}

function describeResultError(result, text, assistantError) {
  if (assistantError === 'authentication_failed' || LOGIN_PROBLEM.test(text)) return { code: 'AUTH', message: SIGN_IN };
  if (assistantError === 'rate_limit' || USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    return { code: 'RATE_LIMIT', message: clip(text || 'Claude usage limit reached; try again later') };
  }
  if (assistantError === 'overloaded' || assistantError === 'server_error') return { code: 'FAILED', message: 'Claude is overloaded or unavailable; try again' };
  if (assistantError === 'max_output_tokens') return { code: 'MAX_TOKENS', message: "Claude's reply was cut off" };
  if (result.subtype === 'error_max_turns') return { code: 'FAILED', message: 'Stopped after too many steps' };
  if (result.subtype === 'error_max_budget_usd') return { code: 'FAILED', message: 'Stopped: the cost budget was reached' };
  return { code: 'FAILED', message: clip(text || 'Claude Code could not finish the request') };
}

function describeThrown(err, stderrTail) {
  if (err instanceof AbortError) return { code: 'CANCELLED', message: 'Cancelled' };
  const message = err?.message ?? String(err);
  if (LOGIN_PROBLEM.test(message) || LOGIN_PROBLEM.test(stderrTail)) return { code: 'AUTH', message: SIGN_IN };
  if (/ENOENT|not found|could not (be )?(start|spawn)/i.test(message)) return { code: 'UNAVAILABLE', message: `Claude Code could not start (${clip(message, 120)})` };
  return { code: 'FAILED', message: clip(message || 'Claude Code failed') };
}

// query: the SDK's query function (tests inject a fake async generator); checkLogin: see checkClaudeLogin;
// now: clock for the login cache; timeoutMs: per-run limit.
export function createAgentSdkBackend({ config, log, dataDir, query = sdkQuery, checkLogin = checkClaudeLogin, now = Date.now, timeoutMs = TIMEOUT_MS }) {
  const logger = log.child('ai-sdk');
  const sandbox = path.join(dataDir, 'ai-sandbox');
  let cached = null;
  let probe = null;

  // → Promise<boolean>; the answer is kept for 10 minutes so hello and ask never spawn repeatedly.
  function isAvailable() {
    if (cached && now() - cached.at < LOGIN_CACHE_MS) return Promise.resolve(cached.available);
    probe ??= Promise.resolve()
      .then(() => checkLogin())
      .then(({ loggedIn, via }) => {
        cached = { at: now(), available: loggedIn, reason: loggedIn ? null : SIGN_IN };
        logger.info(loggedIn ? `Claude Code login found (${via})` : 'No Claude Code login on this PC');
        return loggedIn;
      }, (err) => {
        cached = { at: now(), available: false, reason: SIGN_IN };
        logger.warn('Claude Code login check failed', { error: err.message });
        return false;
      })
      .finally(() => {
        probe = null;
      });
    return probe;
  }

  const availability = () => (cached ? { available: cached.available, reason: cached.reason } : null);

  function lumenTools(toolContext, signal) {
    return TOOL_DEFINITIONS.map((definition) => tool(
      definition.name,
      definition.description,
      toZodShape(definition.inputSchema),
      async (args) => {
        const out = await callTool(definition.name, args, { ...toolContext, signal });
        const images = (out.images ?? []).map(({ data, mimeType }) => ({ type: 'image', data, mimeType }));
        return { content: [{ type: 'text', text: out.text }, ...images], ...(out.isError && { isError: true }) };
      },
    ));
  }

  // emit({ kind: 'status'|'tool'|'text', … }); resolves { ok, text?, error?, tools, model?, costUsd?, … }, never rejects.
  async function run(text, { emit, signal, toolContext }) {
    if (!(await isAvailable())) return { ok: false, error: { code: 'AUTH', message: SIGN_IN }, tools: [] };
    if (signal.aborted) return { ok: false, error: { code: 'CANCELLED', message: 'Cancelled' }, tools: [] };
    const model = config.ai?.model ?? 'claude-opus-5-5';
    const effort = config.ai?.effort ?? 'low';
    if (!SAFE_MODEL.test(model) || !EFFORT_LEVELS.has(effort)) return { ok: false, error: { code: 'INVALID', message: 'ai.model or ai.effort is not valid' }, tools: [] };
    await fsp.mkdir(sandbox, { recursive: true });

    const controller = new AbortController();
    const mapper = createMessageMapper(emit);
    const lumen = createSdkMcpServer({ name: SERVER_NAME, version: VERSION, tools: lumenTools(toolContext, controller.signal), alwaysLoad: true });
    let stderrTail = '';
    const options = {
      mcpServers: { [SERVER_NAME]: lumen },
      strictMcpConfig: true,
      allowedTools: ALLOWED_TOOLS,
      tools: BUILTIN_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
      permissionMode: 'dontAsk',
      systemPrompt: SYSTEM_PROMPT,
      settingSources: [],
      persistSession: false,
      verbatimPrompts: true,
      maxTurns: MAX_TURNS,
      model,
      effort,
      abortController: controller,
      // An empty directory: no project CLAUDE.md, settings or .mcp.json can be picked up.
      cwd: sandbox,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `lumen-remote/${VERSION}` },
      stderr: (data) => {
        stderrTail = (stderrTail + data).slice(-2000);
      },
    };

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let thrown = null;
    try {
      // The generator ends when the one-shot run is over; every message is mapped on the way.
      for await (const message of query({ prompt: text, options })) mapper.message(message);
    } catch (err) {
      thrown = err;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }

    const outcome = mapper.outcome();
    if (signal.aborted) outcome.error = { code: 'CANCELLED', message: 'Cancelled' };
    else if (timedOut) outcome.error = { code: 'TIMEOUT', message: `Claude Code did not finish within ${Math.round(timeoutMs / 1000)} s` };
    else if (thrown) outcome.error = describeThrown(thrown, stderrTail);
    if (outcome.error) outcome.ok = false;
    if (!outcome.ok && !outcome.error) outcome.error = { code: 'FAILED', message: 'Claude Code ended without an answer' };
    if (!outcome.ok && (thrown || stderrTail)) logger.debug('run failed', { error: thrown?.message, stderr: stderrTail });
    if (outcome.denied.length) logger.warn('Claude Code denied tools', { tools: outcome.denied });
    return outcome;
  }

  return { name: 'agent-sdk', isAvailable, availability, run };
}
