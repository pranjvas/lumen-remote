// "api" backend: the Anthropic SDK's tool runner with the Lumen tools plus server-side web search.
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { ToolError } from '@anthropic-ai/sdk/lib/tools/ToolError';
import { SYSTEM_PROMPT } from './prompt.js';
import { TOOL_DEFINITIONS, callTool, describeInput, describeResult } from './tools.js';

const MAX_TOKENS = 16000;
const TIMEOUT_MS = 360_000; // room for a look-press-look loop inside an app
const MAX_ITERATIONS = 60;
const WEB_SEARCH = { type: 'web_search_20260209', name: 'web_search', max_uses: 3 };
const BETAS = ['server-side-fallback-2026-07-01'];

// Where the SDK looks for `ant auth login` profiles (core/credentials.js getRootConfigPath).
function profileRoot(env) {
  if (env.ANTHROPIC_CONFIG_DIR) return env.ANTHROPIC_CONFIG_DIR;
  if (process.platform === 'win32') {
    if (env.APPDATA) return path.join(env.APPDATA, 'Anthropic');
    return env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Roaming', 'Anthropic') : null;
  }
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'anthropic');
  return env.HOME ? path.join(env.HOME, '.config', 'anthropic') : null;
}

function hasProfile(env) {
  const root = profileRoot(env);
  try {
    return Boolean(root) && fs.readdirSync(path.join(root, 'configs')).some((file) => file.endsWith('.json'));
  } catch {
    return false;
  }
}

// True when the SDK can find credentials; reads only the environment and the profile directory.
export function apiConfigured(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) || hasProfile(env);
}

const textOf = (message) => message.content.filter((block) => block.type === 'text').map((block) => block.text).join('').trim();
const clip = (s, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function describeError(err, { timedOut, cancelled }) {
  if (timedOut) return { code: 'TIMEOUT', message: `Claude did not finish within ${TIMEOUT_MS / 1000} s` };
  if (cancelled) return { code: 'CANCELLED', message: 'Cancelled' };
  if (err instanceof Anthropic.AuthenticationError) return { code: 'AUTH', message: 'Claude API credentials invalid' };
  if (err instanceof Anthropic.PermissionDeniedError) return { code: 'AUTH', message: 'These Claude API credentials may not use this model' };
  if (err instanceof Anthropic.RateLimitError) return { code: 'RATE_LIMIT', message: 'Claude API rate limit reached; try again in a moment' };
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { code: 'CONNECTION', message: 'The Claude API timed out' };
  if (err instanceof Anthropic.APIConnectionError) return { code: 'CONNECTION', message: 'Cannot reach the Claude API; check the internet connection' };
  if (err instanceof Anthropic.BadRequestError) return { code: 'FAILED', message: clip(`The Claude API rejected the request: ${err.message}`) };
  if (err instanceof Anthropic.InternalServerError) return { code: 'FAILED', message: 'The Claude API is overloaded or unavailable; try again' };
  if (err instanceof Anthropic.APIError) return { code: 'FAILED', message: `Claude API error ${err.status ?? ''}`.trim() };
  return { code: 'FAILED', message: clip(err?.message ?? String(err)) };
}

function finalOutcome(message) {
  switch (message?.stop_reason) {
    case 'end_turn':
    case 'stop_sequence':
      return { ok: true, text: textOf(message) || 'Done.' };
    case 'refusal': {
      const details = message.stop_details ?? null;
      const why = details?.explanation ? `: ${details.explanation}` : '';
      return { ok: false, error: { code: 'REFUSAL', message: `Claude declined this request${why}`, stop_details: details } };
    }
    case 'max_tokens':
      return { ok: false, error: { code: 'MAX_TOKENS', message: "Claude's reply was cut off" }, text: textOf(message) };
    case 'tool_use':
    case 'pause_turn':
      return { ok: false, error: { code: 'FAILED', message: 'Stopped after too many steps' } };
    default:
      return { ok: false, error: { code: 'FAILED', message: `Claude stopped unexpectedly (${message?.stop_reason ?? 'no reply'})` } };
  }
}

// client: an Anthropic instance (tests pass one with a stub fetch); default new Anthropic() on first use.
export function createApiBackend({ config, log, client }) {
  const logger = log.child('ai-api');
  let anthropic = client;

  // emit({ kind: 'status'|'tool'|'text', … }); resolves { ok, text?, error?, tools, model?, usage? }, never rejects.
  async function run(text, { emit, signal, toolContext }) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const abort = AbortSignal.any([signal, timeout]);
    const tools = [];
    const pendingServerTools = new Map();

    const runnable = TOOL_DEFINITIONS.map((definition) => betaTool({
      ...definition,
      async run(input) {
        emit({ kind: 'status', text: `Running ${definition.name}…` });
        const out = await callTool(definition.name, input, { ...toolContext, signal: abort });
        const ok = !out.isError;
        tools.push({ name: definition.name, ok });
        emit({ kind: 'tool', name: definition.name, input: describeInput(input), ok, result: describeResult(out.result) });
        if (!ok) throw new ToolError(out.text);
        if (!out.images?.length) return out.text;
        return [
          { type: 'text', text: out.text },
          ...out.images.map(({ data, mimeType }) => ({ type: 'image', source: { type: 'base64', media_type: mimeType, data } })),
        ];
      },
    }));

    // Web search runs on Anthropic's side; report each search once its result block arrives.
    function reportServerTools(message) {
      for (const block of message.content) {
        if (block.type === 'server_tool_use') {
          pendingServerTools.set(block.id, block);
          continue;
        }
        const use = block.tool_use_id && pendingServerTools.get(block.tool_use_id);
        if (!use) continue;
        pendingServerTools.delete(block.tool_use_id);
        const failed = !Array.isArray(block.content) && /_error$/.test(block.content?.type ?? '');
        const result = failed ? `Failed (${block.content.error_code})`
          : Array.isArray(block.content) ? `${block.content.length} results` : 'Done';
        tools.push({ name: use.name, ok: !failed });
        emit({ kind: 'tool', name: use.name, input: describeInput(use.input), ok: !failed, result });
      }
    }

    anthropic ??= new Anthropic();
    const model = config.ai?.model ?? 'claude-opus-5-5';
    const runner = anthropic.beta.messages.toolRunner({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral' },
      output_config: { effort: config.ai?.effort ?? 'low' },
      tools: [...runnable, WEB_SEARCH],
      messages: [{ role: 'user', content: text }],
      betas: BETAS,
      fallbacks: 'default',
      max_iterations: MAX_ITERATIONS,
    }, { signal: abort });

    emit({ kind: 'status', text: 'Thinking…' });
    let final;
    try {
      for await (const message of runner) {
        final = message;
        reportServerTools(message);
        for (const block of message.content) {
          if (block.type === 'fallback') logger.info('served by fallback model', { from: block.from?.model, to: block.to?.model });
        }
        if (message.stop_reason === 'tool_use' || message.stop_reason === 'pause_turn') {
          const note = textOf(message);
          if (note) emit({ kind: 'text', text: note });
        }
        // A long server-side web search pauses the turn; sending the turn back resumes it.
        if (message.stop_reason === 'pause_turn') runner.pushMessages({ role: 'assistant', content: message.content });
      }
    } catch (err) {
      const error = describeError(err, { timedOut: timeout.aborted, cancelled: signal.aborted });
      if (error.code === 'FAILED') logger.warn('request failed', { error: err.message });
      return { ok: false, error, tools, model };
    }
    return { ...finalOutcome(final), tools, model: final?.model ?? model, usage: final?.usage };
  }

  return { name: 'api', isConfigured: () => apiConfigured(), run };
}
