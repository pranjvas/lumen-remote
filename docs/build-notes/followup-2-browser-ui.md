# Build notes: followup-2 · browser-ui (Part B, spec §11.3)

Status: built and verified against `tools/dev-ui.mjs` (fake `/live`, fake browser frames) in headless Edge at 390×844 and 1440×900, Nocturne and Gallery. Not run against the real server's `server/features/browser.js` (Part A, written concurrently) or a real Edge screencast; the wire shapes below are what the UI sends and expects.

## Files

| Path | Change |
|---|---|
| `web/js/views/browser.js` | New. The Browser view. |
| `web/css/views.css` | Appended a `/* ---------- Browser ---------- */` section (nothing above it touched). |
| `web/js/views/chrome.js` | `VIEWS` gains `{ id: 'browser', label: 'Browser', icon: 'globe', rank: 1 }` between Cast and Settings. |
| `web/js/main.js` | Imports `mountBrowser`; `panels.browser = mountInto('browser', mountBrowser)`. |
| `web/index.html` | Unchanged: `#i-globe` already existed. |
| `web/js/views/cast.js` | Page-link preview text only: classify detail is now `<host> · Opens in Lumen's browser · Open on TV available there`; the empty-field route row reads `In Lumen’s browser · Any other web page · Open on TV from there`. |
| `web/js/views/shortcuts.js` | `b` → Browser view; help overlay row `R A . K C B E` and a new "Browser" section. |
| `tools/dev-ui.mjs` | Fake Lumen browser: `browser.*` state keys, all `browser.*` commands, `cast.url` page → browser, wireframe PNG frames with ack gating, `POST /dev/browser`. |
| `docs/build-notes/followup-2-browser-ui.md` | This file. |

Scratch (gitignored): `tools/scratch/browser-ui/{protocol,shots,keys,probe,probe2}.mjs`, screenshots in `tools/scratch/browser-ui/shots/`.

## Exports and signatures

- `web/js/views/browser.js`
  - `mountBrowser(root, ctx)` — same contract as the other views (`mountInto`).
  - `toUrl(text) → string | null` — address-bar text to URL: a scheme passes through (`javascript:` included; the server refuses it), `host:port` and anything with a dot or `localhost` gets `https://`, everything else becomes `https://duckduckgo.com/?q=…`. Pure, so a Node script can import it.
- `web/js/views/chrome.js` `VIEWS` entry as above (rank 1: in the phone tab bar and the desktop rail).

## What the view does

Layout (HALO, like the other views):
- Desktop (≥ 980 px): view head ("Browser" + sub line), one bar with back / forward / reload-or-stop, the address pill (globe, field, Go), **Open on TV** (primary) and **Close**; a status row; the page stage filling the rest.
- Phone: the address pill on top, the status row (with a small Close), the stage filling the rest, and a compact 5-button toolbar above the nav: Back · Forward · Reload/Stop · Keyboard · On TV. The ask bar is hidden on this view and the tab bar items flex so a seventh tab fits at 390 px.
- Status row: `<title or host> · Loading… · <Browser off | Starting… | Live | error message>` with a status dot, plus (desktop only) `<frame w>×<frame h> · <n fps | idle>` in mono.

States from `browser.session`:
- `off` → welcome card in the stage (orb, "A browser inside Lumen", one paragraph, quick-link chips DuckDuckGo / Wikipedia / YouTube / Hacker News). The address bar is the one at the top.
- `starting` → spinner "Starting the browser…" (address icon blinks).
- `error` → alert card with `browser.error` and **Retry** (re-opens the last URL this tab asked for, else `browser.url`, else the address text, else DuckDuckGo).
- `ready` → the canvas; until the first frame paints, a spinner "Waiting for the first frame…".

Frames: `live.on('browser.frame')` → ignored unless `ctx.viewName === 'browser' && !document.hidden` → base64 → `createImageBitmap(Blob)` → `drawImage` on a `<canvas>` whose attribute size follows the bitmap → `browser.ack { seq }` after painting. Frames paint strictly in order; one that arrives mid-decode replaces any earlier waiting one, and only painted frames are acked, so a slow phone just gets fewer frames. The canvas keeps the frame aspect inside the stage (JS fit on ResizeObserver and on size change); the stage letterboxes in near-black.

Viewport: `browser.viewport { w, h }` is posted (debounced 250 ms, only when changed) when the view is shown, on stage resize, after `hello` and when the tab becomes visible again. Size = the stage's CSS box × `devicePixelRatio`, scaled uniformly into 1280×800 and then clamped ≥ 320 (see interpretation 1).

Input (`browser.input`, coordinates in frame pixels, `modifiers` = CDP bits Alt 1 · Ctrl 2 · Meta 4 · Shift 8):
- Mouse/pen: `move` at ≤ 30/s (latest wins), `down` / `up` with `button: 'left'|'middle'|'right'` (a pending move is flushed first), `wheel` with `deltaX/deltaY` scaled to frame px (line-mode deltas × 40), coalesced at ≤ 30/s; right-click menu suppressed.
- Touch: tap → `click` (left); long press 550 ms → `click` with `button: 'right'`; drag past 10 px → `wheel` with the negated finger delta (the page follows the finger); a second finger is ignored.
- Typing: a hidden `<input class="browser-typer">` in the stage. Desktop: any click on the canvas (or Tab-focusing it) focuses it. Phone: the **Keyboard** toolbar toggle focuses it (and a tap re-focuses it while the toggle is on). The field is kept empty: each `input` event sends `{ kind: 'text', text }` and clears; `compositionend` sends the composed word; paste sends the clipboard text; Enter / Backspace / Delete / Tab / Escape / arrows / Home / End / PageUp / PageDown and Ctrl/Meta+letter (except V) go as `{ kind: 'key', key, code, modifiers }`; Android keyboards that report Backspace/Enter only through `beforeinput` are handled there. Leaving the view blurs it; while it has focus the single-key shortcuts are inactive (existing `typing()` rule).

Commands: `browser.open { url }` (30 s timeout, errors toast through `ctx.cmd`), `browser.nav { action }` with `back` / `forward` / `reload` / `stop` (reload becomes Stop while `browser.loading`), `browser.openOnTv {}` (or `{ url }` when no page is open and the address bar has text; "Enter an address first" otherwise), `browser.close {}`. Back/forward follow `browser.canGoBack` / `browser.canGoForward`; Close is disabled when off.

## Interpretations and deviations

1. **Viewport scaling.** The brief says "the canvas's CSS size (device pixels, clamped)". A phone at 2× (358×541 CSS → 716×1082) would hit the 800 px height cap alone and be letterboxed with a 716×800 frame. The UI instead scales the device-pixel size uniformly into the 1280×800 box (→ 530×800), so the frame has the stage's aspect and fills it; desktop sizes under the cap are sent as-is (864×631 at 1440×900). The server's own clamp still applies.
2. **Tap-to-focus on phones.** Spec: "a tap focuses a hidden input so phone keyboards type into the page". Focusing on every tap would raise the soft keyboard on every link tap, so a tap only clicks; the Keyboard toggle (in the brief's toolbar) focuses the field and keeps it focused across taps. On desktop a click does focus it.
3. **Welcome card "with the address bar".** One address bar, always at the top; the card carries the explanation and quick links. The welcome card copy explains the shared session and Open on TV.
4. **Close on phones** sits in the status row (the toolbar has the brief's five buttons).
5. **`modifiers`** is the CDP bitmask, the simplest pass-through for `Input.dispatch*Event`.
6. **`home`** nav action is not surfaced in the UI.
7. **Cast.** Only the preview copy changed. The Cast view still toasts "Casting web page to the TV" and stays on Cast after a page link; see gaps.
8. **Phone tab bar.** `.nav-item { min-width: 0; flex: 1 1 0 }` under 980 px, in the Browser CSS section, so seven tabs fit (Remote · Apps · Cast · Browser · Settings · Mouse · More).
9. **Frame format sniffing.** `draw()` types the Blob `image/png` when the first byte is 0x89, else `image/jpeg`, because the dev server's fake frames are PNG (no JPEG encoder without dependencies). Edge's JPEG path is the same `createImageBitmap` call.
10. **Ack gating in dev-ui** counts from the client's last `view` change (`sent`/`acked` reset to the current seq), skipping a viewer with two unacked frames; frames are 5 fps while something changed and a 1.5 s heartbeat otherwise. `view` and `browser.*` commands skip dev-ui's fake TV latency, because in the real server they are handled on the PC and their order matters (typed text, acks).

## tools/dev-ui.mjs additions

- State: `browser.session|error|url|title|loading|canGoBack|canGoForward` as `{ src: 'derived', via: 'browser' }`.
- Commands: `browser.open` (http/https only, `INVALID` otherwise; `starting` → 900 ms → `ready`; navigation sets `loading` for 700 ms then a derived title), `browser.nav`, `browser.input` (header links and story cards navigate, wheel/PageUp/PageDown/arrows scroll, text/Backspace edit the page's search box, Enter / the Search button search DuckDuckGo), `browser.viewport` (clamped), `browser.ack`, `browser.close`, `browser.openOnTv` (needs the TV on, 500 ms, `{ url, method: 'view' }`); `cast.url` with a plain page → `browser.open` and `{ kind: 'browser', url }`.
- Frames: `{ t: 'browser.frame', data, w, h, seq }` with a wireframe page (fixed header with the host in a 5×7 bitmap font, path, clock, three nav pills; hero; search box; three cards; paragraph bars; footer; a loading bar while loading) encoded as PNG (RGB, zlib) — about 8–60 KB.
- `POST /dev/browser?url=<page>` | `?close=1` | `?error=<message>` for screenshots of each state.
- `view` presence is tracked per client (`name`, `visible`) and only browser-view clients with a visible tab get frames.

## Verification performed

All with `tools/dev-ui.mjs --port 8796` (never 8790) and headless Edge bound to 127.0.0.1, closed afterwards. No TV, LAN, sdb, emulator or API contact.

1. `node --check` on `web/js/views/browser.js`, `chrome.js`, `main.js`, `shortcuts.js`, `cast.js`, `tools/dev-ui.mjs` — all OK.
2. `node tools/scratch/browser-ui/protocol.mjs 8796` (raw `ws` client, imports `toUrl`): **ALL OK** —
   - `toUrl`: 9 cases (scheme pass-through, `host:port`, bare host, path+query, `localhost:3000`, two searches, `javascript:` pass-through).
   - hello carries `browser.*` (`derived`), session `off`; `browser.open javascript:` → `INVALID`; `browser.open https://example.com/` → `starting` → `ready` → `browser.title` "Example Domain"; no frames while the client is on `remote`.
   - `browser.viewport 2000×100` → `1280×…`, `640×480` accepted; on `view browser` a frame arrives: PNG signature, IHDR 640×480, IDAT inflates to `(640·3+1)·480` bytes.
   - Ack gating: after the first frame exactly one more arrives without acks; after `browser.ack` frames resume (seq 7).
   - `click` on the header link → `browser.url` example.com/news and `canGoBack`; `text "lumen"`, `key Backspace`, `text "ns"`, `key Enter` → `duckduckgo.com/?q=lumens`; `nav back` → `canGoForward`; `browser.openOnTv` acks with the current url; `browser.close` → `off`; `cast.url https://example.org/page` → `{ kind: 'browser', url }` and `browser.url` follows.
   - First run found a real bug: `localhost:3000` was treated as a scheme; fixed (`:(?!\d+(\/|$))`).
3. `node tools/scratch/browser-ui/shots.mjs 8796` (headless Edge over CDP, 390×844 mobile+touch and 1440×900, Nocturne; 1440×900 Gallery): **51/51 PASS, no console errors, warnings, exceptions or failed requests.** Per size: off state text; `browser.viewport` equals the stage size scaled uniformly (530×800 on the phone, 864×631 on desktop); the starting spinner; ready meta (`530×800 · 1 fps`); address bar shows the url; acks sent; canvas aspect = frame aspect; a real tap (`Input.dispatchTouchEvent`) / click (`Input.dispatchMouseEvent`) on the fake page's header link navigates to `/news` (touch sent `click`; mouse sent `move,down,up`); `Input.insertText "hi"` + Backspace reach the page as `text:hi key:Backspace` with the address bar untouched and the hidden field empty; drag (3 wheel messages, ΣdeltaY 180) / wheel (1 message, ΣdeltaY 241) scroll; the error card shows the message and Retry reopens the page; leaving the view changes presence (`remote` on the phone, `now` on desktop) and blurs the hidden field. Screenshots: `browser-{off,starting,ready,scrolled,error}-{390x844,1440x900,1440x900-gallery}.png`, all looked at: welcome card centred in the dark stage, spinner, the page filling the stage edge-to-edge on the phone (after the viewport change) and letterboxed inside the rounded stage on desktop, the error card, 7 tabs fitting at 390 px.
   - The first driver run exposed two dev-ui problems that are fixed: ack gating compared a fresh viewer's `acked = 0` with the global seq (a late joiner got one frame then stalled), and the random "TV latency" could apply `view now` / `view browser` out of order so no frames were rendered.
4. `node tools/screenshot.mjs --base http://127.0.0.1:8796 --views browser --theme both` with the session off and again after `POST /dev/browser?url=https://en.wikipedia.org/wiki/Samsung`: 4 + 4 screenshots each run, **"No console errors, warnings, exceptions or failed requests."** (written under `tools/scratch/browser-ui/shots/official-{off,open}/`).
5. `node tools/scratch/browser-ui/keys.mjs`: `B` on the Remote view → `#/browser`, rail marks Browser current, title "Browser · Lumen"; `r` typed into the hidden field does not switch views; the `?` overlay lists `R A . K C B E` and the Browser section; the Cast preview for `https://example.com/some/page` reads "Web page · example.com · Opens in Lumen's browser · Open on TV available there" and the empty-field routes mention Lumen's browser.
6. After each run `msedge.exe` with a `lumen-*` profile was gone (Browser.close, then taskkill fallback as in `tools/screenshot.mjs`); the dev server was stopped at the end.

## Known gaps

- Not exercised against Part A's real `createBrowser` / Edge JPEG screencast or the hub's `browser.*` validation; field names follow §11.3 and the brief literally, `modifiers` as the CDP bitmask is my reading.
- (Closed at integration) Cast now toasts "Opened in Lumen’s browser" and navigates to the Browser view when the ack carries `kind: 'browser'`; the link field's placeholder mentions web links.
- No pinch zoom, double-click (`clickCount`), drag-to-select or middle-button autoscroll; `home` nav not surfaced.
- On Android the soft keyboard shrinks the layout viewport, so a `browser.viewport` resend (debounced) follows; the frame re-fits either way. Phone soft keyboards could not be exercised headless (text path verified with `Input.insertText` / `beforeinput` logic by reading).
- `npm test` was not run here (Part D owns the tests; running it would start other parts' Edge/server fixtures).
