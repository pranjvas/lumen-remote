# Role: web-ui

**Files you own:** `web/**` (`index.html`, `css/`, `js/` ES modules, `icons/` (inline SVG sprite), `fonts/`, `manifest.webmanifest`, `sw.js`), `tools/dev-ui.mjs`, `tools/screenshot.mjs`.

**The user's words:** "artistic and informational UX". The volume button on the main remote shows the current volume level and adjustments; a Settings option displays current TV configuration such as brightness levels; plus a Cast option and an AI option ("play Friends on Netflix", "increase brightness"). This is the part the user will judge first. Make it beautiful, calm and premium — a piece of dark hi-fi equipment, not a grid of grey buttons.

**Design language:** HALO, spec in `docs/research/area-prior-art-ux.md` §2–§9 (tokens, typography, depth, motion, sound/haptics, iconography, IA, screen mockups S1–S10, interaction specs, provenance model, accessibility, delight details). Follow it, using your own judgement where it is vague.
- Nocturne (dark) is the default; Gallery (light) via toggle + `prefers-color-scheme`.
- **The halo:** a luminous ring around the d-pad that always shows the TV's real volume and animates when it changes from the physical remote.
- The ambient accent is tinted by the foreground app's brand colour.
- Provenance badges on every value (LIVE · TV AGENT · TRACKED · STALE · UNAVAILABLE) with a tooltip "from <via>, <age> ago".
- Fonts: you may download OFL fonts (Inter, Fraunces, JetBrains Mono — official GitHub releases / google/fonts) into `web/fonts/` as woff2 subsets if you can do it quickly; otherwise use a refined system stack (Segoe UI Variable / SF Pro / system-ui). No runtime CDN.

**Views**
Spec §6, plus §10 and §11:
- **Remote**
  - Power with state.
  - D-pad ring + OK, Back, Home, TV Menu.
  - Volume rocker with a big numeric readout, mute, and a tap-to-open precise slider (ignores incoming updates while dragging and for 1 s after).
  - Channel rocker.
  - Now-playing strip: app icon/colour, channel name, input.
  - Quick input chips.
- **Apps & Inputs**
  - Grid from `app.installed` with `/api/icon/<id>` images when present, else brand-colour tiles with short glyphs.
  - Inputs with connected dots and tracked labels (rename).
- **Settings:** sections Picture / Picture Advanced / Sound / Input & Source / General (tracked) / Device / Connection.
  - Render from `hello.catalog.settings` and live state.
  - Sliders with a numeric value and read-back animation.
  - Enum segmented controls.
  - "Locked in this mode" state on `LOCKED_IN_MODE`.
  - `dependsOn` greying.
  - Tracked rows with Calibrate + "Open TV Menu".
  - Device and Connection rows (model, firmware, resolution/panel, system health from the agent, each channel's status/latency, pairing buttons, "Connect TV agent").
  - A visible "Picture values apply to <input> · <mode>" scope line.
- **Keys:** number pad, colours, media transport, extras.
- **Touch & Text:** touchpad (swipe = arrows, tap = OK, two-finger = pointer when `touch.enabled`) and a text field that auto-opens when `ime.open`.
- **Cast:** paste-a-link box with detected type preview, drop/pick a local file (upload with progress to `POST /api/cast/upload` with header `X-Lumen-CSRF: <hello.csrf>`, multipart or raw body — coordinate by reading `docs/build-notes/cast.md` if it exists, else send the raw file body with `X-File-Name` header), now-casting card with transport controls and a scrubber from `cast.session`.
- **Scenes:** scenes list + run, sleep timer chips (15/30/60/90 min, countdown), macro recorder.
- **Ask:** an Ask bar reachable from every view (Ctrl+K / "/" focus; optional mic via `webkitSpeechRecognition` when available). It sends `{ t:'cmd', cmd:'ai.ask', id, text }` and renders the streamed `{ t:'ai', id, kind, … }` events as an elegant transcript: status line, tool chips with results, final answer. Example prompt chips: "Increase brightness", "Play Friends on Netflix", "Cinema mode", "Sleep in 30 minutes". Shows the AI backend status from `hello.ai` (ready / setup needed + reason).

**Behaviour**
- Single WebSocket to `/live` with auto-reconnect.
- State = flat map of records from `hello.state` + `patch`.
- Commands `{ t:'cmd', id, cmd, … }` with optimistic UI and reconciliation on `ack`.
- Hold-to-repeat with `hold` start/beat/end (beat every 400 ms; end on pointerup/cancel/blur/visibilitychange).
- `view` messages when the view or tab visibility changes.
- `changedOnTv` whisper toasts.
- Connection banners (TV off → Wake TV; remote/IP Control unpaired → Pair; agent offline → Connect TV agent).
- Keyboard shortcuts with a `?` overlay.
- `navigator.vibrate` on supported phones.
- `prefers-reduced-motion`; ARIA roles and labels; focus rings; responsive from 360 px phones to wide desktops (desktop = console layout with remote + status side by side).
- PWA manifest + service worker caching the shell only (never API/WS).
- Strict CSP compatible: no inline scripts; inline styles allowed.

**Dev tools**
- `tools/dev-ui.mjs`: serves `web/` on `http://127.0.0.1:8799` with a fake `/live` that sends a realistic `hello`. Use the live-findings values: volume 2, backlight 10, contrast 50, Standard / Amplify, TV source, Ace TV channel, 12+ apps, catalogs copied from the spec. It acks commands and animates a fake external volume change every 20 s.
- `tools/screenshot.mjs`: drives headless Microsoft Edge (`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`, `--headless=new --remote-debugging-port=<free>`) over CDP with Node's built-in WebSocket. It captures each view at 390×844 and 1440×900 to `docs/screenshots/` for a given base URL (default dev-ui).

**Verify:** run `dev-ui.mjs` + `screenshot.mjs`, then LOOK at the PNGs with the Read tool and iterate on the visuals at least twice until they look genuinely premium and every view renders without console errors (capture console errors via CDP and report them).
