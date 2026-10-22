# Follow-up 1 (after the first build): Agent SDK backend + cast/deep-link corrections

Read `docs/build-notes/briefs/00-common.md` for the shared rules. Ownership is listed per part, and the two parts run in parallel.

## Part A — role `ai-sdk` (owns `server/ai/**` and the `ai` section of `server/config.js` defaults only)

Spec §11.1 is binding: the user has no API key, and the local Claude Code CLI is logged in with claude.ai.

1. Add `server/ai/agent-sdk-backend.js` using `@anthropic-ai/claude-agent-sdk` (installed together with `zod`). Exact API, verified from `code.claude.com/docs/en/agent-sdk/typescript`:
   - `import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'`.
   - `query({ prompt, options })` is an `AsyncGenerator<SDKMessage>`; discriminate on `message.type` (`'assistant'` carries `message.message.content` blocks, `'result'` ends the run, `'system'` init).
   - `tool(name, description, zodRawShape, async (args) => ({ content: [{ type: 'text', text }], isError? }))`.
   - `createSdkMcpServer({ name: 'lumen', version, tools })` → `mcpServers: { lumen }`; tool names are `mcp__lumen__<name>`.
   - Options: `allowedTools: ['mcp__lumen__*', 'WebSearch', 'WebFetch']`, `tools: ['WebSearch', 'WebFetch']` (built-in tool list; verify the semantics in the docs or the package's `.d.ts`), `disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Task']`, `permissionMode: 'dontAsk'`, `systemPrompt: <prompt.js string>`, `settingSources: []`, `persistSession: false`, `maxTurns: 12`, `model: config.ai.model`, `effort: config.ai.effort`, `abortController`, `cwd: <dataDir>/ai-sandbox` (create it), `env: { ...process.env }`.
   - Confirm every option name against `node_modules/@anthropic-ai/claude-agent-sdk/*.d.ts` before relying on it.
2. Convert the tool list in `tools.js` to zod raw shapes for this backend. Generate them from the existing JSON-schema definitions, or add a parallel zod definition per tool; keep one source of truth.
3. Map messages to Lumen `ai` events:
   - assistant text → `text`
   - `tool_use` blocks → `tool` (name + short input)
   - tool results → `tool` (result summary)
   - `result` → `result`/`done` (include `total_cost_usd` or usage if present, no secrets)
   - errors → `error` with friendly text (not logged in → "Sign in to Claude Code on this PC (run `claude` once)")
4. `isAvailable()`: `claude auth status`-equivalent without spawning a prompt. Prefer checking that `%USERPROFILE%/.claude/.credentials.json` exists, or run `claude auth status` once with a 10 s timeout and parse `loggedIn` (never print account details). Cache the result for 10 min.
5. `index.js`: backend order for `auto` = `api` (only if SDK credentials exist) → `agent-sdk` → `off`. **Remove the CLI-spawn backend** (`claude-code-backend.js`): delete the file and its wiring; the Agent SDK replaces it. Keep `/mcp`. `status()` reports `{ backend: 'agent-sdk', ready, reason, note: 'Uses your Claude Code login (personal use)' }`.
6. Tests: add `test/ai-agent-sdk.test.js`, which you own. It covers tool zod conversion, event mapping with a fake async generator in place of `query` (inject it), and backend selection. **Do not run a real query** — that spends the user's plan usage. The orchestrator runs one real command afterwards.


> **LIVE CORRECTION (2026-10-21 21:10, verified on the TV):** DIAL `POST /ws/app/<Name>` returns **403 without an Origin header** and **201** with an app-matching one. Send `Origin: https://www.youtube.com` (YouTube, verified: `v=jNQXAC9IVRw` played), `https://www.netflix.com` (Netflix), `https://www.primevideo.com` (Prime). The "no Origin header" sentence below is wrong. Browser: REST `POST /api/v2/applications/org.tizen.browser` with `{"id": "<url>"}` opens the browser but **not** the URL; keep the candidate list and mark it unverified. See docs/research/re-deep-links.md "Live corrections".

## Part B — role `cast-fix` (owns `server/features/cast.js`, `server/adapters/avtransport.js`, `server/adapters/dial.js`, and the cast parts of `test/mock-tv.js` + cast tests)

Apply the reverse-engineering results in `docs/research/re-dlna-cast.md` and `docs/research/re-deep-links.md`:

1. **MIME names the TV accepts** (live Sink list):
   - video: mp4/m4v `video/mp4`, mov `video/quicktime`, mkv `video/x-mkv`, webm `video/webm`, ts `video/mpeg`, m2ts/mts `video/vnd.dlna.mpeg-tts`, avi `video/x-msvideo`, wmv `video/x-ms-wmv`, flv `video/x-flv`, 3gp `video/3gpp`
   - audio: mp3 `audio/mpeg`, m4a `audio/mp4`, aac `audio/vnd.dlna.adts`, flac `audio/x-flac`, wav `audio/x-wav`, ogg `audio/ogg`, wma `audio/x-ms-wma`
   - image: jpg `image/jpeg`, png `image/png`, bmp `image/bmp`
   - Remove or gate gif/webp; HLS (m3u8) goes through the internet-URL path with `application/vnd.apple.mpegurl`, marked experimental.
2. **Media-server contract** (decompiled DLNA reader):
   - answer HEAD with 200 and full headers
   - single-range GET → 206 / 416
   - headers: `Content-Type`, `Content-Length`, `Accept-Ranges: bytes`, `contentFeatures.dlna.org` (video/audio `DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000`, images `…FLAGS=00F00000000000000000000000000000`), `transferMode.dlna.org` echoed from the request (default Streaming for AV, Interactive for images)
   - never redirect; `Connection: close` is fine
3. **Cast flow:**
   - `Stop` first when the state is PLAYING/PAUSED_PLAYBACK/TRANSITIONING (ignore errors)
   - `SetAVTransportURI` with DIDL-Lite (`id="0" parentID="-1" restricted="1"`, `object.item.videoItem.movie` / `audioItem.musicTrack` / `imageItem.photo`), escaped correctly
   - `Play` Speed 1, retried every 500 ms on UPnP errors 705/701 (up to 10 s)
   - seek clamps to duration − 1 s and retries 701 every 200 ms ×8
   - images stay PLAYING at 0:00: end a session only after PLAYING then STOPPED/NO_MEDIA_PRESENT; never-started after 30 s
4. **URL classification:** follow redirects yourself and cast the final URL (`res.url`); when HEAD is refused, retry GET with `Range: bytes=0-0`.
5. **DIAL / deep links:**
   - POST only to the singular `/ws/app/<Name>`, `Content-Type: text/plain; charset="utf-8"`, **no Origin header**, body ≤ 4096 bytes, success = 201 + LOCATION; 401 means the TV needs to allow this PC (surface "Allow on your TV")
   - YouTube body `v=<id>` (and `&t=<seconds>` when present)
   - Netflix: keep a ranked candidate list in `PAYLOADS.netflix = [(id) => 'm=https://www.netflix.com/watch/' + id + '&source_type=4', (id) => 'm=' + id + '&showMovieInfoOnly=true&source_type_payload=groupIndex%3D1%26tileIndex%3D0%26action%3Dmdp%26movieId%3D' + id, (id) => 'm=' + id + '&source_type=4']` and use index `config.cast.netflixPayload ?? 0`
   - Prime (`AmazonInstantVideo`): candidates `[url, gti, 'gti=' + gti]` with the same config index
   - **Browser:** REST `POST /api/v2/applications/org.tizen.browser` (try with and without the trailing slash) with JSON `{ "id": "<url>" }`. Do NOT use `/api/v2/webapplication/` (that is the Samsung App Launcher cloud container).
   - A REST launch with a payload fails with -4009 when the app is already in front: use DIAL or say so.
6. Update `test/mock-tv.js`'s DMR to the reader behaviour (HEAD then GET with the DLNA headers, 705 on the first Play) and the DIAL 201/401 behaviour, then extend the cast tests.

## Part C — role `mouse` (owns `web/**`, `server/adapters/remote.js`, and only the `pointer.*` command handling inside `server/hub.js`)

Implement spec §11.2 end to end:
- remote.js:
  - coalescing pointer queue (≤ 30 msgs/s, sums dx/dy between sends, drops nothing)
  - `pointerMove(dx, dy)`, `pointerClick(button)` with RightClick
  - `pointerScroll(dy)` using the configured scroll keys
  - `Time` field
  - moves only while `conn.remote === 'paired'`
- hub: validate `pointer.move` (finite numbers, clamp ±400 per message), `pointer.click`, `pointer.scroll`; per-client rate limit generous enough for 60 Hz input.
- web:
  - the Mouse view (phone trackpad + desktop Pointer Lock mode, sensitivity, gestures, pointer availability line, d-pad fallback when `touch.enabled` is false, keyboard button)
  - send moves with requestAnimationFrame batching (one message per frame at most)
  - keep the existing HALO look
  - add the view to navigation and the `?` shortcuts overlay ("M" toggles Mouse mode on desktop)
- Tests: extend the mock's WSS channel to record ProcessMouseDevice frames, then test coalescing (100 rapid moves → ≤ 4 frames in 100 ms with the summed deltas), clicks, scroll → keys, and validation.
- Verify the UI with `tools/dev-stack.mjs` + `tools/screenshot.mjs` (add the Mouse view to the screenshot list).

Parts A, B and C have disjoint file sets except `test/mock-tv.js`: B owns the DMR/DIAL sections and C owns the WSS section. Edit only your section and re-read the file just before writing.

All parts: `npm test` must be green at the end; write `docs/build-notes/followup-1-<role>.md`.
