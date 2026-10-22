# Build notes: ai ("Ask Lumen")

Role `ai`, spec §11. Files: `server/ai/index.js`, `server/ai/tools.js`, `server/ai/prompt.js`, `server/ai/api-backend.js`, `server/ai/claude-code-backend.js`, `server/ai/mcp.js`. No new dependencies.

## Exports and signatures

### `server/ai/index.js`
`createAi({ config, data, log, store, hub, httpPort?, backends? })` (extra ctx keys such as `lan` and `adapters` are accepted and ignored) →
- `ask(text, { id, emit })` → `Promise<{ ok, text?, error? }>`. It never rejects. `emit` receives **complete** browser messages `{ t: 'ai', id, kind, … }`; the hub's own `{ ...event, t: 'ai', id }` wrapper is harmless on top. Every call ends with exactly one `done`.
- `cancel(id)` → `boolean` (true if a run with that id was aborted).
- `status()` → `{ backend: 'api' | 'claude-code' | 'off', ready, reason }` (synchronous; safe to put in `hello.ai`).
- `mcpHandler(req, res)` (see mcp.js).
- `start()`: starts the `claude --version` probe when the CLI backend may be needed. `stop()`: aborts all runs. `setDemand()`: no-op (the hub calls it on every feature).
- Limits: one active run per id; at most 2 at once (`BUSY`); request text from 1 to 1000 characters (`INVALID`).
- Backend choice per `config.ai.backend`: `off`; `api` (needs credentials); `claude-code` (needs the CLI); `auto` = api if configured, else claude-code if `claude --version` works, else off. `ai.model` defaults to `claude-opus-5-5` and `ai.effort` to `low`.
- `reason` strings:
  - `AI is turned off (ai.backend is "off")`
  - ``Set ANTHROPIC_API_KEY or run `ant auth login` ``
  - `Claude Code CLI not found`
  - ``Set ANTHROPIC_API_KEY or run `ant auth login`, or install the Claude Code CLI`` (auto with neither available)
  - `Checking for the Claude Code CLI…` (only while the ~0.2 s probe runs)
- Log line per run, under tag `ai`, message `ask`: `{ backend, text (≤300 chars), tools: [names, "x (failed)"], ok, error: "CODE: message", model?, ms }`. No tool inputs and no tokens.
- `httpPort` (a number, or `() => number`) overrides `config.http.port` when building the MCP URL for the CLI. **Note for core:** `app.js` currently passes nothing, which is fine in production (8790). With `http.port: 0` (tests) the CLI backend reports "The Lumen MCP endpoint is not ready". To support that, pass `httpPort: () => http.port`.
- `backends: { api?, claudeCode? }` replaces the real backends. It is a test seam only.

### Event kinds (`{ t: 'ai', id, kind, … }`)
| kind | fields |
|---|---|
| `status` | `text`: "Thinking…", "Running set_setting…", "Starting Claude Code…", "Lumen tools are not reachable from Claude Code (failed)" |
| `tool` | one per completed call: `name` (Lumen tool name, `web_search`, or `WebSearch`/`WebFetch` on the CLI), `input` (a ≤120-char `k=v` summary), `ok`, `result` (summary such as "Brightness 10 → 15", or the error message) |
| `text` | a progress note written before a tool call (also partial text before a `MAX_TOKENS` error) |
| `result` | `text`: the final short answer |
| `error` | `code`, `message`, plus `stop_details` on `REFUSAL`. Codes: `INVALID`, `BUSY`, `UNAVAILABLE`, `AUTH`, `RATE_LIMIT`, `CONNECTION`, `TIMEOUT`, `CANCELLED`, `REFUSAL`, `MAX_TOKENS`, `FAILED` |
| `done` | `ok`, `ms` |

### `server/ai/tools.js`
- `TOOL_DEFINITIONS`: a frozen `[{ name, description, inputSchema }]` in a fixed order (which keeps the prompt cache stable). Every schema is `type: object`, `additionalProperties: false`, with `required`.
- `callTool(name, input, ctx)` → `{ isError, result, text }`. `ctx = { hub, store, catalog: { settings, keys, apps, isAllowedKey }, signal? }`. `text` is the JSON for the model; `result.summary` is the one-liner.
- `hasTool(name)`, `describeInput(input)`, `describeResult(result)`.
- Each tool validates its input against its own schema (a small validator for the subset used), then checks semantics, then calls `hub.handle({ cmd, … }, AI_CLIENT)`. `AI_CLIENT = { id: 'lumen-ai', ai: true, send() {} }`, so hub safety, rate limits, read-back and `changedOnTv` suppression all apply.
- The tools and the hub commands they use:
  - `get_tv_state`: store only. A compact digest where each value is `{ value, src }`; `src` becomes `stale` when the record is stale or older than its TTL.
  - `list_settings {group?}`
  - `set_setting {key, value}` → `setting.set`. Range is checked and rounded to `step`. Enum options match case- and space-insensitively. `tracked` and `readonly` settings are refused with the menu path. `dependsOn` is checked when the other value is known.
  - `change_setting {key, delta}`: range settings only. Runs `settings.refresh` first when the stored value is missing or stale, clamps to the range, then `setting.set`.
  - `set_volume {level}` → `volume.set`.
  - `change_volume {delta}`: `volume.step` for |delta| ≤ 5 (the hub's limit), otherwise `volume.set` with current + delta.
  - `set_mute {muted}` → `mute.set`.
  - `press_keys {keys ≤20, gapMs 120–2000, default 300}` → one `key` per item.
    - `up` is accepted as `KEY_UP`.
    - Keys must pass `catalog.isAllowedKey`. `KEY_POWER*` are refused (use `power`).
    - Stops between keys when the run is cancelled, and reports partial progress.
  - `list_apps`
  - `launch_app {app}` → `app.launch`. Fuzzy match over curated + installed apps (aliases: amazon/prime, hotstar/disney, browser). The Lumen Agent is excluded.
  - `open_netflix {titleId|url}` → `cast.url https://www.netflix.com/title/<id>`.
  - `play_youtube {videoId|url}` → `cast.url https://www.youtube.com/watch?v=<id>`.
  - `open_prime {url}` → `cast.url`, only if cast classifies it as Prime.
  - `open_url_on_tv {url}` → `cast.url`.
  - `cast_media {url}` → `cast.url`. YouTube, Netflix and Prime links are redirected to their own tools.
  - `set_input {source}` → `input.set`. Accepts `HDMI 1`, `live tv`, `av`, a bare `hdmi` when exactly one HDMI is connected, or a user label from `input.labels`.
  - `power {action}` → `power`.
  - `sleep_timer {minutes 0–240}` → `sleep.set`.
  - `run_scene {name}` → `scene.run`, fuzzy match on `scenes`.
  - `type_text {text ≤200, submit?}` → `text.send`, with control characters stripped.
- Links are parsed and classified with cast's own exported `parseCastUrl` / `matchUrl` (`server/features/cast.js`), so a tool accepts exactly what cast will route.
- **CineHD rule:** no tool searches or plays inside CineHD. `launch_app` can open it. While it is the foreground app, `type_text` is refused and `press_keys` allows only Home, Back, Exit, Volume ±, Mute, TV Menu and Source.

### `server/ai/prompt.js`
`SYSTEM_PROMPT`: one constant with no timestamps or per-request values. It covers:
- one-shot answers in 1–2 sentences that report what changed;
- read the state before relative changes, and prefer exact settings over keys;
- "increase/decrease brightness" means `picture.backlight` ±5;
- find Netflix/YouTube ids with web search and never invent one;
- the CineHD rule, tracked settings, and "say so when no tool fits";
- no follow-up questions, and politely refuse anything unsafe.

### `server/ai/api-backend.js`
- `apiConfigured(env = process.env)` and `createApiBackend({ config, log, client? })` → `{ name: 'api', isConfigured(), run(text, { emit, signal, toolContext }) }`.
- `run` uses `client.beta.messages.toolRunner` with these parameters:
  - `model`, `max_tokens: 16000`, `system`, top-level `cache_control: {type:'ephemeral'}`, `output_config: { effort }`
  - tools: 20 `betaTool` wrappers + `{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }`
  - `betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`, `max_iterations: 10`
  - request option `{ signal }`
- There is no `thinking` parameter (always on for Opus 5.5) and no `tool_choice` (forced choice is a 400 on Opus 5.5).
- The runner is iterated per message, not streamed:
  - On `pause_turn` the paused assistant turn is pushed back and the loop continues.
  - Web searches are reported once their result block arrives.
  - `fallback` blocks are logged.
- Final stop reasons:
  - `end_turn` → result
  - `refusal` → `REFUSAL` with `stop_details`
  - `max_tokens` → `MAX_TOKENS`
  - still `tool_use` after 10 iterations → "Stopped after too many steps"
- SDK errors map to friendly messages:
  - `AuthenticationError` → "Claude API credentials invalid"
  - `PermissionDeniedError` → `AUTH`
  - `RateLimitError` → `RATE_LIMIT`
  - `APIConnectionTimeoutError` / `APIConnectionError` → `CONNECTION`
  - `BadRequestError` → message clipped to 200 characters
  - `InternalServerError` → overloaded
  - any other `APIError` → status
- Cancel uses the caller's `AbortSignal`, combined with a 60 s `AbortSignal.timeout` (`TIMEOUT` vs `CANCELLED`).
- `client` is injectable; tests pass `new Anthropic({ apiKey, fetch: stub })`. By default `new Anthropic()` is created on first use, so the SDK resolves the credentials.

### `server/ai/claude-code-backend.js`
- `resolveCli(env, platform)` → `{ command, args, shell? } | null`; `createClaudeCodeBackend({ config, log, cli? })` → `{ name: 'claude-code', isAvailable(): Promise<boolean> (cached), availability(): { available, cli, version } | { available:false, reason } | null, run(text, { emit, signal, mcp: { url, token } }) }`.
- How the CLI is found on Windows:
  1. `claude.exe` on PATH.
  2. Otherwise the npm shim `claude.cmd`, read to find the `"%dp0%\…\claude.exe"` it wraps, or a `.js` entry that is then run with node. **No shell sits between Lumen and the user's text.**
  3. A `.cmd` that cannot be parsed runs with `shell: true`. Every argument is quoted for cmd.exe, and the prompt comes from a file.
- On this machine it resolves to `…\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`.
- Command line: `-p --output-format stream-json --verbose --strict-mcp-config --mcp-config <tmp>/mcp.json --tools WebSearch,WebFetch --allowedTools mcp__lumen,WebSearch,WebFetch --permission-mode dontAsk --system-prompt <SYSTEM_PROMPT> --no-session-persistence --setting-sources "" --disable-slash-commands --model <ai.model> --effort <ai.effort>`.
  - `cwd` is the new temp dir, so no project CLAUDE.md, settings or `.mcp.json` is picked up.
  - The child gets `ENABLE_TOOL_SEARCH=false`, so the 20 tools load up front.
  - `mcp.json` = `{ mcpServers: { lumen: { type: 'http', url: 'http://127.0.0.1:<port>/mcp', headers: { Authorization: 'Bearer <mcpToken>' } } } }`.
  - The temp dir is removed after every run, including runs that were killed. The token is never logged: stderr is redacted before its debug log.
- How the stream-json lines map to events:
  - `system/init` → status, plus a warning when the `lumen` MCP server is not `connected`.
  - Assistant text followed by a `tool_use` → `text`.
  - `tool_use` → status.
  - Matching `tool_result` → `tool`, with the summary taken from the Lumen JSON.
  - `result` → result, or error (the CLI's own message, e.g. "Invalid API key · Please run /login").
  - `permission_denials` are logged as warnings.
- The process tree is killed (`taskkill /T /F` on Windows) on cancel or after 90 s.

### `server/ai/mcp.js`
- `createMcpHandler({ getToken, toolContext, log })` → `async (req, res)`. It implements MCP over streamable HTTP with JSON responses and no SSE stream.
- Checks, in order:
  1. Loopback remote address, and no `Origin` header → else 403.
  2. `Authorization: Bearer <mcpToken>`, compared in constant time → else 401 with `WWW-Authenticate: Bearer`.
  3. POST only → 405 with `Allow: POST`.
  4. `Content-Type: application/json` → else 415.
  5. Body of at most 1 MB (413), valid JSON (400 with `-32700`), a single JSON-RPC 2.0 message (batches → 400 with `-32600`).
- Methods:
  - `initialize`: echoes a well-formed `protocolVersion` (default `2025-06-18`), `capabilities: { tools: {} }`, `serverInfo: { name: 'lumen', version: '0.1.0' }`, `instructions`.
  - Notifications such as `notifications/initialized`, and client responses → 202 with no body.
  - `ping` → `{}`.
  - `tools/list` → `TOOL_DEFINITIONS`.
  - `tools/call` → `{ content: [{ type: 'text', text }], isError? }`.
  - An unknown tool → `-32602`; an unknown method → `-32601`.
- Each call is logged as `tool <name> { ok, summary }`, without arguments. index.js reads the token as `data.readJson('secrets.json').mcpToken` and caches it.

## Deviations and interpretations
- **Request text goes on stdin, not `-p <text>`.** `-p` is the print flag; the prompt is read from stdin. That way user text can never be parsed as a CLI option (for example text starting with `--`) or reach a shell.
- **`ant` profile location.** `isConfigured` mirrors the SDK's own lookup (`core/credentials.js` `getRootConfigPath`, and `shared/anthropic-cli.md`): `$ANTHROPIC_CONFIG_DIR`, else `%APPDATA%\Anthropic` on Windows, else `$XDG_CONFIG_HOME/anthropic` or `~/.config/anthropic`. A profile counts when `configs/*.json` exists. The brief named `%USERPROFILE%/.config/anthropic`, but the SDK does not read that path on Windows.
- **`pause_turn`.** SDK 0.137 already resumes `pause_turn` inside its runner. The docs (written for 0.110) say to push the turn back. I push it as the docs say; the runner then treats the history as caller-owned, so the turn is sent exactly once (verified in the test).
- **Who emits what.** Backends emit only `status`/`tool`/`text`; index.js emits `result`/`error`/`done` from the backend's outcome, so both backends end the same way.
- **Extra flags not named in the brief:**
  - `--disable-slash-commands` (no skills or slash commands from user text)
  - `--effort` (from `ai.effort`)
  - `ENABLE_TOOL_SEARCH=false` (verified in the 2.1.303 binary: a false value selects "standard" mode, i.e. no deferral)
- **`--setting-sources ""`.** This loads no user, project or local settings. The CLI login is not a setting, so it still applies.
- **`set_setting` on tracked keys is refused.** A tracked value records what the user says the TV is set to. The AI writing one would claim a change that never happened on the TV.
- **Extra CineHD guard.** `press_keys` and `type_text` are limited while CineHD is in the foreground. The brief only said "launch only"; this stops the model from navigating inside CineHD by key presses.

## Known gaps
- No real Claude API call and no real `claude -p` run were made, as the brief requires. Everything model-facing ran against stubs: the SDK through a stub `fetch`, and the CLI through a fake node script.
- The real CLI was exercised only with `--help` and `--version`.
- Not confirmed live:
  - that Claude Code 2.1.303 reads the `-p` prompt from stdin;
  - that it accepts an empty `--setting-sources`;
  - that it honours `mcp__lumen` as an allow rule for every tool of the server.
- `--system-prompt-file` is used only by the shell fallback (a `.cmd` that cannot be parsed). It is not listed on its own in `--help`; it appears only as `--system-prompt[-file]` in the `--bare` text and in the binary's strings.
- Possible live mismatches the stubs cannot catch:
  - the MCP shapes follow the 2025-06-18 streamable-HTTP spec from memory, not re-fetched;
  - the exact stream-json event shapes come from Claude Code's documented format, not from a live capture.
- `status()` can show "Checking for the Claude Code CLI…" for about 0.2 s after start. `hello` is not re-sent when the probe finishes.

## Verification performed
All of these ran on 2026-10-21 on this machine, with results as observed:
- `node --check` on all six files: ok.
- `node tools/scratch/ai/test-tools.mjs`: **16 passed**. Fake hub and store with the real catalogs: definitions, digest provenance, every tool's happy path, refusals, schema junk, hub errors, cancel between keys.
- `node tools/scratch/ai/test-mcp.mjs`: **10 passed**. A scratch `http.Server` on 127.0.0.1:
  - initialize, notifications/initialized → 202, ping, tools/list (20);
  - tools/call `get_tv_state` and `set_volume` with the fake hub, an isError path, unknown tool/method;
  - 401 with no, a wrong, or a short bearer; 403 with an Origin; 405 for GET; 415, 400 and batch rejection;
  - logs contain no arguments.
- `node tools/scratch/ai/test-api.mjs`: **12 passed**. The real SDK `BetaToolRunner` with `new Anthropic({ apiKey: 'sk-test-not-real', fetch: stub, maxRetries: 0 })`:
  - exact request body and beta header;
  - a tool loop through the hub; an invalid tool input → `is_error`; `pause_turn` resumed once, with the web-search event;
  - refusal with `stop_details`, `max_tokens`;
  - 401/429/529/400 and a network failure mapped to friendly errors;
  - cancel in flight, a cancel that arrived before the run started (no request sent), timeout (with `AbortSignal.timeout` shortened), `max_iterations`;
  - `apiConfigured` env and profile rules.
  - Also observed: this machine has no API credentials, so `auto` picks the CLI.
- `node tools/scratch/ai/test-cli.mjs`: **7 passed**. index.js plus the CLI backend, with a fake `claude` (`tools/scratch/ai/fake-claude.mjs`) that calls the real MCP handler from its `--mcp-config`:
  - `resolveCli` for an exe, an npm exe shim, a node shim, an opaque `.cmd`, and nothing found;
  - the exact args, stdin, the `ENABLE_TOOL_SEARCH` env, the MCP round trip into the fake hub, the event order, and the temp dir removed;
  - a CLI error result, a crash with stderr, MCP `failed`, permission denials;
  - cancel (process-tree kill, 222–650 ms), the 2-concurrent limit, duplicate ids, a cancel before the CLI starts;
  - status and routing for off/api/auto/claude-code, invalid text, an emit that throws.
- Real CLI:
  - `claude --version` → `2.1.303 (Claude Code)`; the probe through `isAvailable()` took 225 ms.
  - `claude --help` saved to `tools/scratch/ai/claude-help.txt`. `node tools/scratch/ai/check-flags.mjs` found every flag the main path uses listed there (`dontAsk` is a `--permission-mode` choice). It reports `--system-prompt-file` as not separately listed (see gaps).
- `node tools/scratch/ai/smoke-server.mjs`, through core's real `startServer`:
  - Setup: temp dataDir, TV host 127.0.0.1 on closed ports, LAN listener off, `ai.backend: 'off'`.
  - `/mcp` gave 401 without the bearer, tools/list 20, `get_tv_state` → "TV standby", `list_apps` → "16 apps", `set_volume` → `TV_OFF` from the real hub.
  - Over the WebSocket `/live`: `hello.ai` = `{"backend":"off","ready":false,…}`; `ai.ask` produced `{t:'ai',kind:'error',code:'UNAVAILABLE',…}` then `{kind:'done'}`, plus the hub's ack.
- No real TV, LAN device, sdb, Claude API call, or `claude -p` prompt was used.
