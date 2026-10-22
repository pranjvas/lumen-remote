# Role: ai

**Files you own:** `server/ai/index.js`, `server/ai/tools.js`, `server/ai/prompt.js`, `server/ai/api-backend.js`, `server/ai/claude-code-backend.js`, `server/ai/mcp.js`.

**Mandatory reading before writing code:** the claude-api skill docs at `C:/Users/pranj/AppData/Local/Temp/claude/bundled-skills/2.1.303/133f4056b56d79ee7a25ec2b30892c50/claude-api/`:
- `SKILL.md` if present, otherwise the files below
- `typescript/claude-api/README.md`, `typescript/claude-api/tool-use.md`, `typescript/claude-api/streaming.md`
- `shared/tool-use-concepts.md`
- `shared/model-migration.md` (the refusal-fallback section, `fallbacks: 'default'` with beta `server-side-fallback-2026-07-01`)

Never guess SDK usage: check exact names in `node_modules/@anthropic-ai/sdk` (e.g. `helpers/beta/json-schema` exports `betaTool`) if the docs leave a gap. For the CLI backend, run `claude --help` (Claude Code 2.1.303 is installed at `C:\Users\pranj\AppData\Roaming\npm\claude.cmd`) to get the exact flags. **Do not call the Claude API or run `claude -p` with a real prompt during the build**: that spends the user's money or usage. Exercise everything with mocks, and the CLI only with `--help` / `--version`.

**Build** (spec §11)
- `tools.js`:
  - One list of tool definitions: name, description, JSON Schema input with `additionalProperties: false` and `required`.
  - A `run(input, { hub, store, catalog })` per tool, calling `hub.handle({ cmd: …, … }, aiClient)` with a synthetic client object whose `send` is a no-op, so safety and read-back apply. Return a short JSON result.
  - Tools: `get_tv_state` (a compact digest: power, volume/mute, input, picture mode, key picture values with their provenance, foreground app, channel, sleep), `list_settings`, `set_setting`, `change_setting` (current + delta, clamped to the catalog range), `set_volume`, `change_volume`, `set_mute`, `press_keys` (only allowed keys, max 20), `list_apps`, `launch_app` (fuzzy match name or id over `app.installed` and the catalog), `open_netflix` (titleId or URL → `cast.url` with the Netflix URL), `play_youtube` (videoId or URL), `open_prime`, `open_url_on_tv`, `cast_media`, `set_input`, `power`, `sleep_timer`, `run_scene`, `type_text`.
  - **No tool may search or play titles inside CineHD** (it can be launched as an app only).
  - Validate inputs yourself before running (the model output is untrusted).
- `prompt.js`: a stable system prompt.
  - Lumen controls the user's Samsung Q95T.
  - Keep answers to one or two short sentences saying what changed (e.g. "Brightness 10 → 14").
  - Read state before relative changes; prefer exact settings over key presses.
  - "Increase/decrease brightness" means `picture.backlight` ±5 unless a number is given.
  - Use web_search to find official Netflix title ids (`netflix.com/title/<id>`) or YouTube video ids before opening them.
  - Never invent ids; when no tool fits, say so.
  - Ask no follow-up questions (one-shot commands); refuse unsafe actions politely.
  - Keep the prompt free of timestamps so it caches.
- `api-backend.js`:
  - `@anthropic-ai/sdk` with `new Anthropic()` (SDK credential resolution) and `client.beta.messages.toolRunner(...)`, `stream: true` or per-iteration messages.
  - Model `config.ai.model` (default `claude-opus-5-5`), `max_tokens` 16000, `output_config: { effort: config.ai.effort }`, tools = `betaTool` wrappers + `{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }`, `betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`.
  - Handle `pause_turn` (push the assistant turn and continue), `refusal` (emit an error event with `stop_details`), and `max_tokens`. Typed SDK errors → friendly messages: AuthenticationError → "Claude API credentials invalid", RateLimitError, APIConnectionError.
  - Emit events `{ kind: 'status' | 'tool' | 'text' | 'result' | 'error' | 'done' }` through the `emit` callback; tool events carry name, input summary and result summary.
  - AbortController for cancel; a 60 s overall timeout.
  - `isConfigured()`: true when `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set, or an `ant` profile exists (`%USERPROFILE%/.config/anthropic`); don't make a network call to check.
- `mcp.js`: an MCP streamable-HTTP endpoint handler (`POST /mcp`, JSON-RPC 2.0, JSON responses rather than SSE).
  - Supports `initialize` (protocolVersion echo, capabilities `{ tools: {} }`, serverInfo `lumen`), `notifications/initialized` (202), `tools/list` (from `tools.js`), `tools/call` (run the tool → `{ content: [{ type: 'text', text }], isError? }`), `ping`.
  - Require `Authorization: Bearer <mcpToken>` and a loopback remote address; 405 for GET unless you implement SSE.
  - Read the MCP spec if needed (modelcontextprotocol.io) to get the shapes right.
- `claude-code-backend.js`:
  - Spawn the CLI found on PATH (Windows: `claude.cmd` via `shell: true`, or resolve the `.cmd`) with:
    - `-p <text>`
    - `--output-format stream-json --verbose`
    - `--strict-mcp-config --mcp-config <tmp json: { mcpServers: { lumen: { type: 'http', url: 'http://127.0.0.1:<httpPort>/mcp', headers: { Authorization: 'Bearer <mcpToken>' } } } }>`
    - the tool flags from `--help` that limit tools to the Lumen MCP tools plus WebSearch/WebFetch, with no Bash/Edit/Write/Read (e.g. `--tools` and `--allowedTools 'mcp__lumen__*' WebSearch WebFetch`)
    - `--permission-mode` such that the allowed tools run without prompts
    - `--system-prompt` (from `prompt.js`), `--no-session-persistence`, `--model`, `--setting-sources` so project settings don't leak in
  - Parse the stream-json lines into the same event kinds. Kill the process on cancel or after 90 s. Delete the tmp config afterwards; never log the token.
  - `isAvailable()`: `claude --version` succeeds (cache the result).
- `index.js`: `createAi({ config, data, log, store, lan, hub, adapters })`.
  - Picks the backend per `config.ai.backend` (`auto` = api if configured, else claude-code if available, else off).
  - `ask(text, { id, emit })`; `cancel(id)` (one active run per id; max 2 concurrent).
  - `mcpHandler`; `status()` → `{ backend, ready, reason }`, where reason gives setup guidance such as "Set ANTHROPIC_API_KEY or run `ant auth login`" or "Claude Code CLI not found".
  - Log every run (text, tools called, outcome) without secrets.

**Verify:**
- `node --check` everything.
- Unit-exercise `tools.js` with a fake hub/store.
- Test `mcp.js` with a scratch HTTP server: initialize, tools/list, tools/call get_tv_state with a fake hub, plus a 401 without the bearer.
- Test `api-backend.js` with a stubbed client by injecting a fake `toolRunner`, or by testing the event mapping separately.
- Run `claude --help` to confirm the flags you use exist.
