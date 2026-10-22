# Build notes: web-ui

Status: built and verified against `tools/dev-ui.mjs` and against the real server (`server/app.js` + `test/mock-tv.js`, loopback only). Not run against the real TV.

## Files

| Path | What |
|---|---|
| `web/index.html` | Shell, inline SVG sprite (24 px grid, 1.75 stroke, `currentColor`), no inline script |
| `web/js/boot-theme.js` | Classic script that applies a saved theme before first paint (CSP-safe) |
| `web/js/main.js` | Entry: live link, hello/patch handling, routing, presence, tint, service worker |
| `web/js/core/live.js` | WebSocket `/live` with reconnect and ack correlation |
| `web/js/core/state.js` | Flat record map from `hello.state` + `patch`, prefix watchers, UI-only optimistic overlay |
| `web/js/core/ctx.js` | Shared context: commands with friendly errors, catalogue lookups, locked-in-mode tracking |
| `web/js/core/volume.js`, `core/power.js` | Volume and power controllers (optimistic, reconciled) |
| `web/js/ui/*.js` | `dom`, `format`, `badge` (provenance), `toast`, `haptics`, `sheet`, `press` (hold protocol), `slider`, `segmented`, `tint` (OKLCH clamp), `apptile` |
| `web/js/views/*.js` | `remote` (instrument), `volume-sheet`, `text`, `now` (desktop dashboard), `apps`, `settings`, `keys`, `touch`, `cast`, `scenes`, `ask`, `chrome` (power, chain, theme, banners, nav, More), `shortcuts` |
| `web/css/` | `tokens.css` (HALO Nocturne/Gallery tokens, fonts), `base.css` (frame, header, nav, ask bar, banners), `components.css`, `remote.css`, `views.css` |
| `web/fonts/` | Inter, Fraunces (roman + italic), JetBrains Mono — variable woff2, Latin subsets, plus `OFL-*.txt` |
| `web/icons/` | `lumen.svg`, `lumen-192.png`, `lumen-512.png` (PNGs rendered from the SVG with headless Edge `--screenshot`) |
| `web/manifest.webmanifest`, `web/sw.js` | PWA manifest; service worker caching the shell only |
| `tools/dev-ui.mjs` | Dev server with a fake `/live` |
| `tools/screenshot.mjs` | Headless Edge over CDP; screenshots + console report |
| `docs/screenshots/*.png` | 70 screenshots from the final run (both themes, 390×844 and 1440×900, scrolled pages, interaction extras) |

Fonts come from the Fontsource packages (`@fontsource-variable/inter`, `fraunces`, `jetbrains-mono`, which repackage the google/fonts builds), fetched once from jsDelivr at build time into `web/fonts/`. Nothing is loaded from a CDN at runtime.

## Internal module API

- `core/live.js`
  - `createLive({ url })` → `{ connect(), send(cmd, args, { timeoutMs, id }) → Promise<ack>, post(cmd, args) → boolean, retryNow(), on(type, fn) → off, status, retryAt, rtt }`
  - `makeId()`
  - `send` always resolves: when offline it resolves `{ ok:false, error:{ code:'OFFLINE' } }`, and after `timeoutMs` it resolves `TIMEOUT`.
- `core/state.js`: `createState()` → `{ load(snapshot), apply(patch), get(key), truth(key), value(key, fallback), watch(patterns, fn, { immediate }) → off, setOverlay(key, v), clearOverlay(key) }`.
  - Patterns can be exact keys, `prefix.*` or `*`.
  - A nested snapshot is flattened defensively.
- `core/ctx.js`: `createContext({ live, state })` → `ctx` with:
  - `cmd(name, args, { el, silent, timeoutMs })`: toast, haptic and shake on error
  - `key(key)`, `holdPolicy(key)`, `keyInfo(key)`, `hasKey(key)`
  - `setting(key)`, `apps()`, `app(id)`
  - `isLocked(key)`, `lock(key)`
  - `navigate(view)`, `on`/`emit`
  - `setHello(hello)`, `csrf`, `ai`, `version`
  - `main.js` adds `volume`, `power` and `viewName`.
- `core/volume.js`: `createVolume(ctx)` → `{ step(delta), set(value), toggleMute(), shown(), truth(), snapshot(), subscribe(fn) }`.
- `core/power.js`: `createPower(ctx)` → `{ current(), wake(), off(), wakingFor(), subscribe(fn) }`.
- `ui/press.js`: `keyPress(ctx, key, policy)` → `{ down, up, cancel }`; `bindPress(el, { down, up, cancel })`; `bindKey(el, ctx, key, opts)`.
- `ui/slider.js`: `createSlider({ min, max, step, value, label, bipolar, big, format, onInput, onCommit, detents, ticks })` → `{ el, value, busy, set(v, { force }), setPending, setDisabled }`.

## Wire protocol as used

Received:
- `hello` (`state`, `catalog.{keys,settings,apps}`, `csrf`, `ai`, `version`)
- `patch`
- `ack`
- `toast`
- `changedOnTv`
- `ai` (`status` text, `tool` `{ name, input, ok, result }`, `text`, `result`, `error` `{ code, message }`, `done` `{ ok, ms }`), as emitted by `server/ai/index.js`

Sent: `key`, `hold` (start/beat/end), `volume.set`, `volume.step`, `mute.set`, `power`, `app.launch`, `input.set`, `setting.set` (also for tracked calibration), `settings.refresh` (`all`), `input.label`, `text.send`, `pointer.move`, `pointer.click`, `sleep.set`, `scene.run`, `scene.save` (`{ name, steps }`, the server assigns the id), `scene.delete`, `macro.record`, `macro.run`, `macro.delete`, `agent.connect`, `pair.remote`, `pair.ipcontrol`, `view`, `cast.url`, `cast.file`, `cast.control`, `ai.ask` (the cmd `id` is the run id), `ai.cancel` (`{ target: runId }`).

Upload: `POST /api/cast/upload` with the raw body via XHR (for progress), headers `X-Lumen-CSRF`, `X-File-Name` (encodeURIComponent) and `Content-Type`, exactly as in `docs/build-notes/cast.md`.

## Interpretations and deviations

1. **Presence.** The hub keeps one view per client.
   - The UI reports the panel view, or `remote` when the instrument (or the desktop "Now" dashboard) is what is shown.
   - It sends `visible:false` when the tab is hidden and re-reports after every `hello`.
   - View names: `remote`, `apps`, `settings`, `keys`, `touch`, `cast`, `scenes`, `ask`.
2. **Hold protocol** (`ui/press.js`), following the catalogue's `hold` policy:
   - `repeat`: click on press; `hold start` after 500 ms; `beat` every 400 ms; `end` on release, cancel, blur or visibilitychange.
   - `press` (OK, Back, Home, Exit, REW/FF, …): click on release if under 500 ms, otherwise `hold start`/`end` (a real TV long-press).
   - `none`: click on press.
   - Keyboard shortcuts use the same engine and ignore OS auto-repeat.
3. **Volume rocker.**
   - Tap → `volume.step ±1`.
   - Hold → repeated `volume.step`, each one sent only after the previous ack, so releasing never leaves queued steps. I did not use the key hold protocol here, so volume always goes through the absolute set path.
   - The tap-to-open precise sheet uses `volume.set`, coalesced (one in flight, newest queued). It ignores incoming updates while dragging and for 1 s after.
   - Readouts show the ack read-back until the patch confirms it, so values don't bounce.
4. **Settings writes.**
   - A slider sends one `setting.set` on release (keyboard: 450 ms after the last arrow).
   - It shows the ack `value` (read-back) with a glow, and whispers when the TV settled on a different value.
   - Enums use segmented controls.
   - `LOCKED_IN_MODE` locks the row for the current input × picture mode: red LOCKED badge, note, control disabled. The lock clears itself when the input or mode changes.
   - `dependsOn` greys the row with "Needs Picture Clarity · Custom".
5. **Badges.** LIVE, TV AGENT, TRACKED, STALE and UNAVAILABLE as briefed, plus:
   - DERIVED for `src:'derived'` (curated app list, latencies)
   - LOCKED (UI-only)
   - `src:'cache'`, `stale:true` or an age past `ttlMs` all show STALE.
   - Tooltip "from <via>, <age>" (also the aria-label). Ages re-render every 5 s.
6. **Banners.**
   - Lumen host lost (with countdown and Retry), TV standby/off (Wake TV), remote unpaired (Pair), IP Control unpaired (Pair).
   - The agent-offline banner (Connect TV agent, dismissible) shows only on Apps and Settings, so it never pushes the phone remote off screen.
   - At most two banners at a time.
7. **Navigation.**
   - Phones: tab bar with Remote / Apps / Cast / Settings / More; More holds Keys, Touch & Text, Scenes, Ask, theme and vibration. The remote's centre cluster also jumps to Keys (123) and Touch.
   - The ask bar is on every view, except the phone Ask view, which has its own composer.
   - At 980 px and wider: rail + instrument + panel. Selecting Remote shows a "Now" dashboard in the panel (mini-TV, live readouts with badges, power, scenes, sleep).
8. **Power.**
   - When on: hold 600 ms to turn off (a tap shows a hint). From the keyboard, press twice within 2.5 s, or hold P for 500 ms.
   - When standby, off or unknown: tap to wake, with a "Waking… n s" state until REST reports on.
9. **Text entry.**
   - `text.send` is live: debounced 260 ms, sending the whole string each time; Enter sends `submit:true`.
   - The sheet opens automatically on `ime.open` (on the Touch view it focuses the inline field instead) and closes when the TV closes its keyboard, if it was auto-opened.
   - A password-type field is masked.
10. **Touchpad.**
    - Swipe ≥ 16 px → arrow; a continued drag adds an arrow every 40 px (desktop) or 56 px (touch).
    - Tap → OK.
    - Two-finger tap → Back, or a pointer click when `touch.enabled`.
    - Two-finger drag, or the Pointer mode segment (shown only when `touch.enabled`), → `pointer.move` at ≤ 30 Hz with gain 2.2.
11. **Cast.** Client-side link classification is only a preview (the server classifies authoritatively). DIAL and browser sessions show no transport controls, as `cast.md` says.
12. **Tint.** The catalogue has no precomputed tint, so the browser converts the brand colour to OKLCH with the HALO clamp (Nocturne L 0.72–0.82, Gallery L 0.42–0.52, C ≤ 0.16) and crossfades a registered `--tint` property.
13. **Shortcuts.** `/` and Ctrl+K focus Ask (brief), T opens the text sheet, and R A . K C E switch views. Single-key shortcuts can be turned off in the `?` overlay (WCAG 2.1.4).
14. **Service worker.**
    - Network-first for same-origin static GETs; never `/api`, `/live`, `/mcp`.
    - After registering, the page posts the paths it actually loaded, so the offline shell is complete from the first visit without a hand-kept file list.
15. **dev-ui catalogues.** `dev-ui.mjs` imports the real `server/catalog/*.js` instead of copies, so it renders exactly what the server will send. Values come from the live findings (volume 2, backlight 10, contrast 50, Standard/Amplify, TV source, Ace TV 1927, 22 apps).

## tools/dev-ui.mjs

- Usage: `node tools/dev-ui.mjs [--port 8799] [--scenario live-tv|netflix|standby|unpaired|dynamic]`.
- Serves `web/` from disk (edits show on reload) with the same CSP as `server/http.js`.
- Fake `/live` with the same Origin check:
  - acks every command with plausible TV behaviour: cap 60, `LOCKED_IN_MODE` for picture writes in Dynamic, scope re-reads, power, casting with a moving position, scenes, macro recording
  - streams fake Ask runs
  - keeps live/agent records fresh, like the real pollers
  - changes volume "from the physical remote" every 20 s, with a `changedOnTv`
- Also serves `/api/icon/<id>` (SVG for three apps) and `POST /api/cast/upload` (CSRF-checked, 201 JSON).
- Dev-only endpoints: `POST /dev/ime?open=1|0` and `GET /dev/commands` (the last 300 commands received).

## tools/screenshot.mjs

- Usage: `node tools/screenshot.mjs [--base URL] [--out dir] [--views …] [--sizes 390x844,1440x900] [--theme nocturne|gallery|both] [--pages N] [--extras] [--motion] [--edge path]`.
- Starts headless Edge on a free DevTools port and drives it over CDP with Node's built-in WebSocket.
- Emulates the device, colour scheme and (by default) reduced motion.
- Captures each view plus scrolled pages. `--extras` adds the volume sheet, an Ask run, a cast, the shortcuts overlay, the More sheet and the TV keyboard (these need dev-ui).
- Reports every console error or warning, exception and failed request per view, and exits 1 if there were any.
- Shutdown:
  - It disables Windows occlusion and backgrounding, so a locked or sleeping desktop cannot make the page "hidden".
  - It closes Edge with CDP `Browser.close`, because on Windows the spawned `msedge.exe` hands off to another process and killing its PID would leak the browser.

## Known gaps

- Not built from HALO: the ambient idle poster (S10), the activity ribbon, Web Audio sound, "your usual levels" volume chips, Lite mode auto-detection, and per-key "unverified on this TV" marks.
- The scene editor captures current values only (no arbitrary steps, no dry run).
- The volume cap is not shown, because it is not in `hello`.
- When the agent is offline, input chips show every input, because connection state is unknown.
- The mic uses `webkitSpeechRecognition`. In Edge and Chrome that sends audio to the browser vendor's speech service; the button appears only where the API exists.
- Not tried on a physical phone. Phone layouts are verified only by emulation at 390×844 (plus the 640 px-height rules).

## Verification performed

All from `C:/Users/pranj/source/lumen-remote`, against loopback only.

1. `node --check` on all 32 `web/**/*.js` files, `tools/dev-ui.mjs` and `tools/screenshot.mjs`: 0 failures.
2. `node tools/dev-ui.mjs` then `node tools/screenshot.mjs --pages 2 --theme both --extras` wrote 70 PNGs to `docs/screenshots/` and reported "No console errors, warnings, exceptions or failed requests." The dev server sends the same CSP as the real server.
3. I looked at the PNGs over several rounds. Fixes made after looking:
   - A `.app` class collision broke the console grid (renamed the tile button to `.app-btn`).
   - Brand colours never applied, because `Object.assign(el.style, {'--c': …})` ignores custom properties.
   - `replaceChildren` printed "null" (added `fill()`).
   - Scene steps were rendered before the catalogue arrived.
   - Ask-bar icons inherited the accent colour, and nav links were underlined.
   - The settings index had a harsh band (now a floating glass pill), and the tint value wrapped.
   - The scrubber's tick ruler was too dense, and toasts covered sheets on phones.
   - A banner squashed the halo into an ellipse, overflowing input chips were clipped, and the phone number pad and cast field were cramped.
   - The instrument shadow was clipped, and the dialog showed a focus frame.
4. `node tools/scratch/web-ui/behaviour.mjs` drives real CDP mouse and keyboard input against dev-ui and asserts the `/live` commands. Fresh server per scenario:
   - live-tv 21/21:
     - d-pad tap is one `key`; a 1.5 s hold is click + `hold start` + beats + `end`
     - OK tap is a click on release; a long OK is `hold start`/`end` with no click
     - VOL ± tap and hold, mute, input chip
     - keyboard ↓ m = 5; view presence
     - a brightness drag sends exactly one `setting.set` and shows the read-back; picture mode; the scope line
     - `/` + Enter sends `ai.ask` and the transcript answers
     - power tap sends nothing; a hold turns it off; the standby banner's Wake TV turns it on
   - dynamic 4/4: a refused write gives the LOCKED badge and restores the value; a mode change clears the lock.
   - unpaired 4/4: both Pair banners appear, and AI "Setup needed" with its reason.
5. `node tools/scratch/web-ui/real-stack.mjs --shots` uses `test/helpers.js` `startStack()`: the real `server/app.js` + `test/mock-tv.js` on 127.0.0.1, a temp data dir, AI off, WoL to 127.0.0.1. 14/14:
   - hello from the real hub; power on; the volume readout equals the mock's level
   - d-pad Up reaches the mock as KEY_UP; VOL+ moves the mock 2 → 3 and the readout follows
   - a GENA push moves the halo, with a "changed on TV" whisper
   - Settings shows the mock backlight with a LIVE badge; a slider tap writes 30 to the mock and shows the read-back
   - Mute toggles the mock
   - `screenshot.mjs` against the real server (real CSP) reported no console problems
6. Service worker check (headless probe): activated; 44 cached paths (31 modules); none under `/api`, `/live`, `/mcp` or `/dev`.
7. After the tools finish, 0 headless `msedge.exe` processes remain. Earlier runs had leaked some; they were stopped by matching only their temp profile directories.
