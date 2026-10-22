# Build notes: follow-up 1, part A — `ai-sdk` (Agent SDK backend)

Role `ai-sdk`, spec §11.1 and `docs/build-notes/briefs/followup-1.md` part A. Supersedes the `claude-code-backend.js` sections of `docs/build-notes/ai.md` (that file was not edited).

## Files
- **New** `server/ai/agent-sdk-backend.js` — the `agent-sdk` backend on `@anthropic-ai/claude-agent-sdk` 0.3.306 (bundled Claude Code 2.1.306) + `zod` 4.6.7.
- **Rewritten** `server/ai/index.js` — backend order, status with `note`, cost/usage on `done`; the CLI-spawn wiring is gone.
- **Deleted** `server/ai/claude-code-backend.js`.
- `server/ai/mcp.js` — header comment only (the endpoint now serves external MCP clients; behaviour unchanged).
- **New** `test/ai-agent-sdk.test.js` — 20 tests.
- `test/integration.test.js` — one `describe` ("Ask status in hello") moved from the `claudeCode` seam to `agentSdk` (see deviations).
- Unchanged: `tools.js` (still the single source of truth), `prompt.js`, `api-backend.js`, the `ai` defaults in `server/config.js` (`{ backend: 'auto', model: 'claude-opus-5-5', effort: 'low' }` — `backend` now takes `'auto' | 'api' | 'agent-sdk' | 'off'`).
- Scratch (gitignored): `tools/scratch/ai-sdk/import-smoke.mjs`, `mcp-pipeline.mjs`, `smoke-login.mjs`.

## Exports and signatures

### `server/ai/agent-sdk-backend.js`
- `createAgentSdkBackend({ config, log, dataDir, query?, checkLogin?, now?, timeoutMs? })` → `{ name: 'agent-sdk', isAvailable(): Promise<boolean>, availability(): { available, reason } | null, run(text, { emit, signal, toolContext }) }`.
  - `query` defaults to the SDK's `query`; `checkLogin` to `checkClaudeLogin`; `now` to `Date.now`; `timeoutMs` to 90 000. All four are test seams.
  - `run` emits only `status` / `tool` / `text`; it resolves `{ ok, text?, error?, tools: [{ name, ok }], model?, costUsd?, turns?, usage?: { input, output }, denied: [names] }` and never rejects.
- `toZodShape(inputSchema)` → `{ key: ZodType }` generated from a `{ type: 'object', properties, required }` definition in `tools.js`. Supported: `string` (minLength/maxLength/enum), `integer`, `number` (minimum/maximum), `boolean`, `array` (items, minItems/maxItems), nested `object`, multi-type unions (`type: [...]`), `description`; optional keys are `.optional()`. Anything else throws `Unsupported schema type "…"`.
- `credentialsFile(env = process.env)` → `$CLAUDE_CONFIG_DIR/.credentials.json`, else `<USERPROFILE | HOME | os.homedir()>/.claude/.credentials.json`.
- `checkClaudeLogin({ file?, probe? })` → `{ loggedIn, via: 'credentials' | 'auth-status' | 'none' }`. The file existing is enough; otherwise `probe()` runs `claude auth status --json` (10 s timeout) with the CLI bundled in `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` (falls back to `claude` / `claude.exe` on PATH) and reads only `loggedIn`. Stdout is parsed and dropped; no account field is logged or returned.
- `SIGN_IN` = ``Sign in to Claude Code on this PC (run `claude` once)``.

### Query options (every name checked against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, `Options` at lines 1553–2460)
```
mcpServers: { lumen }                 // createSdkMcpServer({ name: 'lumen', version: VERSION, tools, alwaysLoad: true })
strictMcpConfig: true
allowedTools: ['mcp__lumen__*', 'WebSearch', 'WebFetch']
tools: ['WebSearch', 'WebFetch']      // "Specify the base set of available built-in tools" (string[] = exactly these)
disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Task']
permissionMode: 'dontAsk'
systemPrompt: SYSTEM_PROMPT           // string form
settingSources: []
persistSession: false
verbatimPrompts: true
maxTurns: 12
model: config.ai.model, effort: config.ai.effort
abortController
cwd: <dataDir>/ai-sandbox             // created (recursive mkdir) at the start of every run
env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'lumen-remote/<version>' }   // env REPLACES the child env, so process.env is spread
stderr: (data) => tail kept for error mapping / debug log
```
Tools are `tool(name, description, toZodShape(def.inputSchema), handler)` for all 20 `TOOL_DEFINITIONS`; the handler calls `callTool(name, args, { ...toolContext, signal })` and returns `{ content: [{ type: 'text', text }], isError? }`. The MCP server validates arguments with zod before the handler runs; `callTool` re-validates against the JSON schema (unknown keys are stripped by zod first).

### Event mapping (SDK message → `{ kind, … }`)
| SDK message | event |
|---|---|
| `system/init` | `status` "Thinking…", or "Lumen tools are not reachable from Claude Code (<status>)" when `mcp_servers[lumen].status !== 'connected'` |
| `assistant` text block | held; emitted as `text` only when a `tool_use` follows (progress note), or used as the answer when `result.result` is empty |
| `assistant` `tool_use` block | `status` "Running <name>…" (`mcp__lumen__` stripped) or "Searching the web…" for WebSearch |
| `user` `tool_result` block | one `tool` `{ name, input: describeInput(input) (≤120 chars), ok, result }`; Lumen results are parsed from their JSON (`describeResult`), built-ins give "Done" or the clipped error |
| `assistant.error` (`authentication_failed`, `rate_limit`, `overloaded`, `server_error`, `max_output_tokens`) | remembered for the final error code |
| `result` | outcome: `success && !is_error` → ok with `result.result` (trimmed) / held text / "Done."; otherwise an error (below). `total_cost_usd` → `costUsd`, `usage.{input,output}_tokens` → `usage`, `num_turns` → `turns`, `permission_denials` → `denied` (logged as a warning) |
| anything with `parent_tool_use_id` | ignored (Task is disallowed anyway) |

Error codes: `AUTH` (`authentication_failed`, or result/thrown text matching login / API key / authentication → message `SIGN_IN`), `RATE_LIMIT` (`rate_limit` or a `USAGE_LIMIT_ERROR_PREFIXES` match; the CLI's own text is shown), `MAX_TOKENS`, `FAILED` (overloaded/server error, `error_max_turns` → "Stopped after too many steps", `error_max_budget_usd`, `error_during_execution` → `errors[0]`, no result → "Claude Code ended without an answer", other thrown errors → clipped message), `UNAVAILABLE` (spawn failures: ENOENT / "could not start"), `CANCELLED` (caller's signal → `abortController.abort()`, or the SDK's `AbortError`), `TIMEOUT` (90 s → abort). `index.js` turns the outcome into `result`/`error` + `done`.

### `server/ai/index.js`
- `createAi({ config, data, log, store, hub, backends? })`; `backends: { api?, agentSdk? }` is the test seam. Extra keys (`lan`, `adapters`, `httpPort`) are ignored — `httpPort` is no longer needed since nothing is handed an MCP URL (core may drop it from `app.js`).
- Backend choice: `off`; `api` (needs credentials); `agent-sdk` (needs the login); `auto` = api if configured → agent-sdk if logged in → off. Unknown values (including the retired `claude-code`) → off with ``Unknown ai.backend "…"``.
- `status()` (async, settled): `{ backend: 'api' | 'agent-sdk' | 'off', ready, reason, note? }`, `note: 'Uses your Claude Code login (personal use)'` whenever the backend is `agent-sdk`. `reason` strings: `AI is turned off (ai.backend is "off")`, ``Set ANTHROPIC_API_KEY or run `ant auth login` ``, `SIGN_IN`, ``<SIGN_IN>, or set ANTHROPIC_API_KEY`` (auto, neither), `Checking the Claude Code login…` (sync status while the first check runs).
- `done` now carries `costUsd` and `usage` when the backend reported them; the `ask` log line adds `costUsd` and `turns`. Nothing else in the event contract changed.
- `start()` kicks off the login check when the SDK backend may be used; the answer is cached 10 minutes.

## Deviations and interpretations
- **`test/integration.test.js` was edited** (outside my list): its "Ask status in hello" test injected a fake `claudeCode` backend and asserted `'claude-code'`; after removing that backend the test could only pass by moving it to the `agentSdk` seam (`availability()` / `isAvailable()` / `run`, expecting `'agent-sdk'`). Nothing else in the file changed.
- **`tool` events keep the existing UI contract.** The brief lists `tool_use → tool (name + short input)` and `tool results → tool (result summary)`; `web/js/views/ask.js` appends one chip per `tool` event, so two per call would double the chips. A `tool_use` is reported as `status` ("Running …") and the single `tool` event (name, short input, ok, result) is sent when the result arrives — the same shape the api backend and the old CLI backend used.
- **Options added beyond the brief**, all verified in the `.d.ts`: `strictMcpConfig: true` (user-level MCP servers live in `~/.claude.json`, which `settingSources: []` does not cover); `verbatimPrompts: true` (no `@path` expansion and no slash-command dispatch on the user's text — the replacement for the old `--disable-slash-commands`); `stderr`; `env.CLAUDE_AGENT_SDK_CLIENT_APP`; `alwaysLoad: true` on the server (replaces `ENABLE_TOOL_SEARCH=false`, so the 20 tools are never deferred behind tool search).
- `allowedTools` uses `mcp__lumen__*` exactly as the spec says. The bundled CLI's rule validator (strings in `claude-agent-sdk-win32-x64/claude.exe`) states "globs are permitted only in the tool position after a literal `mcp__<server>__` prefix", with `mcp__puppeteer__*` as its example, so this form is valid.
- `costUsd`/`usage` ride on `done` (and the log), not on `result`.
- `effort` is validated against the SDK's `EffortLevel` set and `model` against `/^[\w.:-]+$/`; anything else → `INVALID` without a run.
- The async generator is iterated to its end (the one-shot process exits after the turn) instead of breaking at `result`; the 90 s timer aborts a run that never ends.
- Login check order: credentials file (cheap, no spawn) → `auth status --json` with the SDK's bundled binary → PATH. Both positive and negative answers are cached for 10 minutes; concurrent callers share one probe.
- The test file imports `@modelcontextprotocol/sdk` (client + in-memory transport) to drive the registered tools the way the CLI does. It is not in `package.json`; it is installed as the Agent SDK's peer dependency (1.32.1 present).

## Known gaps
- **No real `query()` was run** (the brief forbids it), so these are unconfirmed live: that `verbatimPrompts` leaves the MCP tools available (its doc says the turn-start attachment pass is skipped; the Lumen tools are `alwaysLoad`, which is a different mechanism); that `tools: ['WebSearch', 'WebFetch']` plus `disallowedTools` behave as documented; the exact not-logged-in shapes (mapped from `SDKAssistantMessageError` and the CLI's own strings "Not logged in · Please run /login", "Invalid API key · Please run /login"); that the SDK streams `user` messages with `tool_result` blocks for in-process MCP tools (if it did not, tool chips would be missing while the tools still run and the answer still arrives). If the orchestrator's real run shows missing tools, the fallback is `extraArgs: { 'disable-slash-commands': null }` instead of `verbatimPrompts`.
- `config.ai.model` stays `claude-opus-5-5`; whether the claude.ai login accepts that id in the CLI is not verified. Override with `ai.model` in `data/config.json` if the real run reports a model error.
- Web (Part C / web owner): `backendName()` in `web/js/views/settings.js` has no entry for `agent-sdk` (shows the raw id); `status().note` is not displayed; `tools/dev-ui.mjs` still mocks `backend: 'claude-code'`.
- `tools/dev-stack.mjs` still returns `claudeCode: unused` in its fake backends; the key is now ignored (harmless).
- `docs/build-notes/ai.md` keeps its CLI-backend sections (superseded by this file).
- The full `npm test` at the end of my work had **4 failures, all in part B's area** (see below); every AI-related test passes.

## Verification performed (2026-10-21, this machine; nothing contacted the TV, the LAN, sdb, the Claude API, or ran a query)
- `node --check` on `server/ai/*.js`, `test/ai-agent-sdk.test.js`, `test/integration.test.js`: all ok.
- `node tools/scratch/ai-sdk/import-smoke.mjs`: the SDK imports; `tool()` + `createSdkMcpServer()` register a zod tool in-process (`ZodMiniObject`, `safeParse` rejects `{ value: '' }`, accepts `{ value: 'ok' }`). No subprocess.
- `node tools/scratch/ai-sdk/mcp-pipeline.mjs` — a real MCP `Client` over `InMemoryTransport` against the server built from `toZodShape`: 20 tools listed in `TOOL_DEFINITIONS` order; for every tool the property names, `required` list and description match tools.js (0 mismatches), each with `_meta['anthropic/alwaysLoad']: true`; the emitted JSON schema keeps `minLength`/`maxLength`/`enum`/`minimum`/`maximum`/`integer`/array bounds and the `["number","string","boolean"]` union. `set_volume {level:20}` ran through the fake hub ("Volume 10 → 20"); `level: 101`, a missing `level`, `delta: 1.5`, `action: 'reboot'`, an object `value` and 21 keys were rejected as `-32602 Input validation error` before any hub call; an extra field is stripped.
- `node --test test/ai-agent-sdk.test.js`: **20 passed, 0 failed** (4 suites): zod conversion for all 20 tools, exact query option set, the in-process server contract, event mapping with a scripted `query` that really calls the tools, result/assistant error mapping (AUTH, RATE_LIMIT, MAX_TOKENS, max turns, budget, execution error, no result), thrown errors, cancel (SDK controller aborted), timeout, cancel-before-start and sign-out paths never calling `query`, `credentialsFile`, `checkClaudeLogin`, the 10-minute cache, and backend selection / `done` contents in `index.js`.
- `node tools/scratch/ai-sdk/smoke-login.mjs`: credentials file exists on this PC; `checkClaudeLogin()` → `{ loggedIn: true, via: 'credentials' }` in 0 ms; the probe path with a missing file → `{ loggedIn: true, via: 'auth-status' }` in 1486 ms (bundled `claude.exe auth status --json`; only `loggedIn` read). Through core's real `startServer` with `ai.backend: 'auto'`, `hello.ai` = `{"backend":"agent-sdk","ready":true,"reason":null,"note":"Uses your Claude Code login (personal use)"}`; the sandbox directory is created only by a run, not at construction. No `ai.ask` was sent.
- Once, by hand: `claude auth status --json` (user's CLI 2.1.303) printed only its key names, `loggedIn: true`, `authMethod: claude.ai`; `claude auth status --help` confirms `--json` is the default.
- `npm test`: **128 tests, 124 pass, 4 fail** (108 before + 20 new). The 4 failures are in `test/e2e.test.js` ("cast.url with a direct media link": DIDL class `object.item.videoItem.movie` vs the old `object.item.videoItem`), `test/integration.test.js` ("a cast control is not undone by a transport poll": the mock now answers Pause with 701), and `test/mock-tv.test.js` (AVTransport state `STOPPED` after the first Play; DIAL location `/ws/apps/` vs `/ws/app/`). `server/features/cast.js`, `server/adapters/avtransport.js`, `server/adapters/dial.js` and `test/mock-tv.js` were rewritten at 23:05–23:10 by part B while the corresponding tests (19:36 / 19:50) still assert the old behaviour; part B owns those tests. None of the failures mentions AI, and the AI tests in the same suites ("Ask status in hello", "ai.ask with the backend off", the dev-stack scripted AI) pass.
