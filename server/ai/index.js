// "Ask Lumen": natural-language requests carried out by Claude through the Lumen tools.
// Picks a backend (the Anthropic API, or the user's own Claude Code login through the Agent SDK),
// streams progress events to the asking client and serves the same tools over MCP for other clients.
import { APPS } from '../catalog/apps.js';
import { KEYS, isAllowedKey } from '../catalog/keys.js';
import { SETTINGS } from '../catalog/settings.js';
import { SIGN_IN, createAgentSdkBackend } from './agent-sdk-backend.js';
import { createApiBackend } from './api-backend.js';
import { createMcpHandler } from './mcp.js';

const MAX_CONCURRENT = 2;
const MAX_TEXT = 1000;
const API_SETUP = 'Set ANTHROPIC_API_KEY or run `ant auth login`';
const NO_BACKEND = `${SIGN_IN}, or set ANTHROPIC_API_KEY`;
const SDK_NOTE = 'Uses your Claude Code login (personal use)';

const THREAD_TURNS = 6; // earlier exchanges replayed to Claude per chat
const THREAD_IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_THREADS = 50;
const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// "launch_app, look_at_screen ×6, press_keys ×5": what a run did, without inputs or images.
function toolDigest(tools = []) {
  const counts = new Map();
  for (const tool of tools) {
    const name = `${String(tool.name).replace(/^mcp__lumen__/, '')}${tool.ok === false ? ' (failed)' : ''}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ') || 'no tools';
}

// The request Claude sees: the new message, preceded by this chat's earlier exchanges.
export function withHistory(turns, request) {
  if (!turns?.length) return request;
  const lines = ['Earlier in this conversation (oldest first):'];
  for (const turn of turns) {
    lines.push(`User: ${turn.user}`, `Lumen did: ${turn.did}`, `Lumen replied: ${turn.reply}`, '');
  }
  lines.push(`The user's new message (it may refer to the conversation above): ${request}`);
  return lines.join('\n');
}

// backends: { api?, agentSdk? } replaces the real ones (tests).
export function createAi({ config, data, log, store, hub, adapters, backends }) {
  const logger = log.child('ai');
  const toolContext = { hub, store, eyes: adapters?.eyes, catalog: { settings: SETTINGS, keys: KEYS, apps: APPS, isAllowedKey } };
  const api = backends?.api ?? createApiBackend({ config, log });
  const agentSdk = backends?.agentSdk ?? createAgentSdkBackend({ config, log, dataDir: config.dataDir ?? data.dir });
  const runs = new Map();
  const threads = new Map(); // thread id → { turns: [{ user, did, reply }], at }
  let token = null;

  function threadTurns(thread) {
    if (!thread) return [];
    const entry = threads.get(thread);
    if (!entry || Date.now() - entry.at > THREAD_IDLE_MS) {
      threads.delete(thread);
      return [];
    }
    return entry.turns;
  }

  function remember(thread, turn) {
    if (!thread) return;
    const entry = threads.get(thread) ?? { turns: [] };
    entry.turns = [...entry.turns, turn].slice(-THREAD_TURNS);
    entry.at = Date.now();
    threads.delete(thread);
    threads.set(thread, entry);
    while (threads.size > MAX_THREADS) threads.delete(threads.keys().next().value);
  }

  const mode = () => config.ai?.backend ?? 'auto';
  const wantsSdk = () => mode() === 'agent-sdk' || (mode() === 'auto' && !api.isConfigured());

  async function mcpToken() {
    token ||= (await data.readJson('secrets.json', {}))?.mcpToken ?? null;
    return token;
  }

  // → { backend: 'api'|'agent-sdk'|'off', ready, reason, note? }
  function status() {
    const current = mode();
    if (current === 'off') return { backend: 'off', ready: false, reason: 'AI is turned off (ai.backend is "off")' };
    if (current === 'api') return api.isConfigured() ? { backend: 'api', ready: true, reason: null } : { backend: 'api', ready: false, reason: API_SETUP };
    if (current !== 'auto' && current !== 'agent-sdk') return { backend: 'off', ready: false, reason: `Unknown ai.backend "${current}"` };
    if (current === 'auto' && api.isConfigured()) return { backend: 'api', ready: true, reason: null };

    const login = agentSdk.availability();
    if (!login) {
      agentSdk.isAvailable();
      return { backend: 'agent-sdk', ready: false, reason: 'Checking the Claude Code login…', note: SDK_NOTE };
    }
    if (login.available) return { backend: 'agent-sdk', ready: true, reason: null, note: SDK_NOTE };
    return current === 'auto'
      ? { backend: 'off', ready: false, reason: NO_BACKEND }
      : { backend: 'agent-sdk', ready: false, reason: login.reason, note: SDK_NOTE };
  }

  // The status once the login check (when one is needed) has finished: hello is sent once per
  // connection, so a browser that connects right after start must not keep "Checking…".
  async function settledStatus() {
    if (wantsSdk()) await agentSdk.isAvailable();
    return status();
  }

  // emit receives complete browser messages: { t: 'ai', id, kind: 'status'|'tool'|'text'|'result'|'error'|'done', … }.
  // Resolves { ok, text?, error? } when the run is over; never rejects.
  async function ask(text, { id, emit, thread: threadId }) {
    const thread = typeof threadId === 'string' && THREAD_ID.test(threadId) ? threadId : null;
    const started = Date.now();
    const send = (event) => {
      try {
        emit({ t: 'ai', id, ...event });
      } catch (err) {
        logger.debug('ai event not delivered', { error: err.message });
      }
    };
    const request = typeof text === 'string' ? text.trim() : '';
    let backendName = status().backend;

    const finish = (outcome) => {
      if (outcome.ok) {
        send({ kind: 'result', text: outcome.text });
      } else {
        if (outcome.text) send({ kind: 'text', text: outcome.text });
        send({ kind: 'error', ...outcome.error });
      }
      const ms = Date.now() - started;
      const cost = outcome.costUsd !== undefined && { costUsd: outcome.costUsd };
      send({ kind: 'done', ok: outcome.ok, ms, ...cost, ...(outcome.usage && { usage: outcome.usage }) });
      logger.info('ask', {
        backend: backendName,
        text: clip(request, 300),
        tools: (outcome.tools ?? []).map((tool) => (tool.ok ? tool.name : `${tool.name} (failed)`)),
        ok: outcome.ok,
        ...(outcome.error && { error: `${outcome.error.code}: ${outcome.error.message}` }),
        ...(outcome.model && { model: outcome.model }),
        ...cost,
        ...(outcome.turns !== undefined && { turns: outcome.turns }),
        ms,
      });
      if (request && outcome.error?.code !== 'CANCELLED') {
        remember(thread, {
          user: clip(request, 500),
          did: toolDigest(outcome.tools),
          reply: clip(outcome.ok ? outcome.text || 'Done.' : `(failed) ${outcome.error?.message ?? ''}`, 800),
        });
      }
      return { ok: outcome.ok, text: outcome.text, error: outcome.error };
    };

    if (!request) return finish({ ok: false, error: { code: 'INVALID', message: 'Ask Lumen something' } });
    if (request.length > MAX_TEXT) return finish({ ok: false, error: { code: 'INVALID', message: `Keep requests under ${MAX_TEXT} characters` } });
    if (runs.has(id)) return finish({ ok: false, error: { code: 'BUSY', message: 'This request is already running' } });
    if (runs.size >= MAX_CONCURRENT) return finish({ ok: false, error: { code: 'BUSY', message: 'Lumen is already answering two requests; try again in a moment' } });

    const controller = new AbortController();
    runs.set(id, controller);
    try {
      if (wantsSdk()) await agentSdk.isAvailable();
      const current = status();
      backendName = current.backend;
      if (!current.ready) return finish({ ok: false, error: { code: 'UNAVAILABLE', message: current.reason } });
      const backend = current.backend === 'api' ? api : agentSdk;
      const outcome = await backend.run(withHistory(threadTurns(thread), request), { emit: send, signal: controller.signal, toolContext });
      return finish(outcome);
    } catch (err) {
      logger.error('ask failed', { error: err.message });
      return finish({ ok: false, error: { code: 'FAILED', message: 'Lumen could not finish this request' } });
    } finally {
      runs.delete(id);
    }
  }

  function cancel(id) {
    const run = runs.get(id);
    run?.abort();
    return Boolean(run);
  }

  return {
    ask,
    cancel,
    forget: (thread) => threads.delete(thread),
    status: settledStatus,
    mcpHandler: createMcpHandler({ getToken: mcpToken, toolContext, log: log.child('mcp') }),
    async start() {
      if (wantsSdk()) agentSdk.isAvailable();
    },
    async stop() {
      for (const run of runs.values()) run.abort();
    },
    setDemand() {},
  };
}
