# Follow-up 2: the Browser view (spec §11.3)

Read `docs/build-notes/briefs/00-common.md` for the shared rules, then spec §11.3 in `docs/superpowers/specs/2026-10-21-lumen-remote-design.md`, which is binding. The code base passes `npm test` (147 tests; one new DIAL regression test in `test/cast.test.js` may still be failing — Part D owns it). `tools/screenshot.mjs` already contains a working headless-Edge CDP launcher and client; reuse its approach (launch flags, DevTools discovery, the close-then-taskkill shutdown).

Live facts: the headless Edge binary is at `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`. The TV agent 0.2.0 is installed and online; it handles requests `apps`, `icon`, `exit` in `companion/agent/agent.js` (`msg.type` switch near the bottom) and already has the `application.launch` privilege.

## Part A — role `browser-server` (owns `server/features/browser.js`, `server/hub.js` (browser.* commands, `sendToView`, the view-presence hook that stops frames), `server/app.js` (wiring: `features.browser = createBrowser({ ...ctx, hub })` after the hub), `server/features/cast.js` (the `page` branch only), `server/config.js` (`browser` defaults only))

- Implement `createBrowser` exactly per §11.3: lazy Edge launch, screencast, input dispatch, viewport, idle shutdown (`config.browser.idleMs`, default 20 min), state keys, frame fan-out through `hub.sendToView`, per-client ack gating, URL validation, `evaluate(expr)` for tests.
- Config: `browser: { edgePath, idleMs: 1200000, maxFps: 15, quality: 60, maxWidth: 1280, maxHeight: 800 }`.
- Hub: commands `browser.open`, `browser.nav`, `browser.input`, `browser.viewport`, `browser.ack`, `browser.close`, `browser.openOnTv` (→ `adapters.agent.request('open-url', { url })` with a 10 s timeout, else the REST browser launch via `features.cast.openPage`, so make `openPage` reachable: export it on the cast feature as `openOnTv(url)`); `hub.sendToView(view, msg)`; presence changes call `features.browser.viewers(set of clients on the browser view)`.
- `cast.url` with `kind: 'page'` → `features.browser.open(url)` → `{ value: { kind: 'browser', url } }` (keep `openPage` for Open on TV).
- Frames: JSON `{ t: 'browser.frame', data, w, h, seq }`. Measure: at 15 fps and ~40 KB per JPEG that is ~600 KB/s per viewer — acceptable on a LAN; throttle to 5 fps when the page is idle (identical frame bytes).
- Never leave Edge running after `stop()`; never open a port on anything but 127.0.0.1.

## Part B — role `browser-ui` (owns `web/js/views/browser.js`, `web/css/views.css` (append a Browser section only), `web/js/views/chrome.js` (VIEWS entry only), `web/js/main.js` (mount only), `web/index.html` (add a `globe` icon symbol only if missing), `web/js/views/cast.js` (the page-link preview text only), `web/js/views/shortcuts.js` (add `B` → Browser view and update the help overlay only), `tools/dev-ui.mjs` (fake browser frames so screenshots work without Edge))

- Build the Browser view per §11.3 in the HALO style of the other views: address bar with search fallback, nav buttons, Open on TV, Close, status line, canvas page area that keeps the frame aspect and letterboxes, pointer → `browser.input` (move throttled to ~30/s, down/up/click, wheel; touch drag = wheel on phones, tap = click), a hidden text field for typing (text → `browser.input {kind:'text'}`; Enter/Backspace/arrows → `key`), `browser.viewport` sent on mount/resize with the canvas's CSS size (device pixels, clamped), `browser.ack` after painting each frame, frames ignored when the view is hidden.
- States: `browser.session` off → a welcome card with the address bar; starting → spinner "Starting the browser…"; error → the message with Retry; ready → the page.
- Phone layout: address bar on top, page area filling the rest, a compact toolbar (back, forward, reload, keyboard, Open on TV) at the bottom above the nav.
- Verify with `tools/dev-ui.mjs` + `tools/screenshot.mjs --views browser` at 390×844 and 1440×900 and LOOK at the PNGs; iterate until it looks premium and has no console errors.

## Part C — role `agent-open-url` (owns `companion/agent/**` and `server/adapters/agent.js`)

- Agent 0.3.0: bump the version in `config.xml`; add request `open-url { url }` → validate http(s) → `tizen.application.launchAppControl(new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', url, null, null, []), null, ok, fail)`; on failure retry with the explicit app id `org.tizen.browser`; reply `{ ok, data: { method: 'view' | 'browser' } }` or `{ ok: false, error }`. Keep ES2017, no optional chaining, never `*/` inside a block comment; check with `new Function(src)`.
- `server/adapters/agent.js`: nothing new is needed if `request(type, args)` is generic; verify it forwards `open-url` and returns the reply, and that an offline agent rejects with `UNAVAILABLE` promptly.
- Do NOT build/sign/install; the orchestrator does that. Update `docs/build-notes/agent.md` with the new request.

## Part D — role `browser-tests` (owns `test/browser.test.js`, `test/cast.test.js` (fix the failing DIAL-stop regression test near its end: its `cast.control stop` assertion or the mock's DELETE recording is wrong — make the test match the spec'd behaviour), `test/helpers.js` (additions only), `tools/dev-stack.mjs` (nothing unless needed))

- Write `test/browser.test.js` per §11.3 against the real headless Edge, skipping cleanly when `msedge.exe` is missing. Serve the test page from a local HTTP server inside the test. Use short `browser.idleMs` via config overrides.
- Run `npm test` at the end; every test must pass. Coordinate through the spec, not by editing other parts' files.

All parts: write `docs/build-notes/followup-2-<role>.md` with exact exports, deviations and what was verified.
