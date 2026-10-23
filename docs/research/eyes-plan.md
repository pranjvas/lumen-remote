# Lumen "Eyes" — giving the agent sight of the TV screen, and an any-app agent loop

Lead synthesis, 2026-10-23. TV is OFF; nothing below contacted 192.168.1.2. Every "offline"
fact is from the extracted Tizen 5.5 TV emulator image or prior read-only probes recorded in
`docs/research/`; every "live" claim is tagged as a test to run when the TV is on.

Evidence tags: **decompiled** (strings/symbols from the emulator image binaries),
**official-doc**, **community**, **live** (recorded probe on this TV), **inferred**.

---

## 0. The problem, honestly stated

Lumen can already *act* on any app: keys, pointer, text (IME), app launch, plus read-only state
(REST foreground app, UPnP/IP-Control volume & picture, on-TV agent app inventory / channel /
input). The one missing sense is **seeing arbitrary app screens** — the Netflix browse grid, the
Settings menu, a login form — so the agent can decide the next key and verify the result.

Three candidate ways to "see" were researched. Two of them (the 9119 mirror SOAP service and the
raw Wi-Fi-Display mirror protocol) turn out to deliver the *wrong* pixels for this job, and the PC
cannot even receive them. The paths that actually show app UI are: an **external camera**, an
**on-TV screen-capture D-Bus service**, and **structured text** the on-TV agent can already read.

---

## 1. Ranking the ways to see the screen

| Rank | Path | Sees app UI + menus? | DRM/HDCP content? | PC can receive? | Latency | Maturity | Verdict |
|---|---|---|---|---|---|---|---|
| **1 (primary)** | External camera (USB webcam or spare phone as MJPEG/RTSP cam) aimed at the panel | **Yes — everything the human sees** | **Yes (optical, nothing is blanked)** | Yes (UVC/USB or HTTP) | ~80–150 ms/frame | High (commodity) | **PRIMARY** |
| **2 (fallback / clean-frame)** | On-TV `samsung.tizen.dcapture` one-shot `RequestCaptureToFileSync` → JPEG/PNG file → agent reads & ships to PC | **Likely yes for the graphic/UI plane** (service has `mix_graphic_and_video_buffer`) | **No — video plane blanked** ("HDCP Source", `protected_on`) | Yes (file over the existing agent link) | ~150–400 ms/still | Unproven on real FW | **FALLBACK**, pending one supervised probe |
| **3 (always-on augment)** | Structured text the on-TV agent already reads: foreground app id+name, channel/programme, input source, volume/mute; plus AT-SPI focused-text (unproven) | Partial — identity & some labels, not layout | n/a | Yes (existing link) | <200 ms | Medium | **AUGMENT both** |
| 4 (rejected) | 9119 `X_ConnectScreenSharingTV2M` SOAP + Wi-Fi-Display mirror | **No — tuner/HDMI video only, no menus/apps** | No (DRM blanked) | **No** — PC MT7921 reports *Wireless Display: No*; needs a custom WFD sink | 100–250 ms stream | Low / fragile | **REJECT for eyes** |
| 4 (rejected) | Raw WFD/Miracast sink built in Node + WinRT Wi-Fi Direct | same as above | No | barely, custom stack | — | Low | **REJECT** |

### Why mirror (9119 / WFD) is rejected as the agent's eyes
- The TV2M stream is a **second decode of the tuner/ATV/HDMI source**, not a capture of the
  composited screen: `libtv_player` exports `tv_stream_create_dual_view_dtv/atv/ext` and labels
  "Dual-View-DTV/EXT/ATV-to-Mobile Stream"; `libtvs-live` has `IsTV2MOBILE`,
  `TV_STREAM_DUAL_VIEW_EXT_TO_MOBILE` [decompiled]. App screens and the Settings menu render on a
  separate graphics layer and never feed this pipeline [inferred]. Samsung's own support text says
  streaming apps (Netflix/Hulu) "can't be mirrored" [community]. So the agent would be blind
  exactly where it needs to see.
- The PC can't receive it anyway: `netsh wlan show drivers` on the MT7921 reports *Wireless
  Display Supported: No (Wi-Fi Driver: No)*; the Windows "Wireless Display" optional feature is
  NotPresent [live/local]. Building a WinRT Wi-Fi-Direct + custom RTSP/RTP/MPEG-TS/H.264 sink is
  high-effort, radio-sharing degrades the 8002/9197 control links, and the TV may refuse non-Galaxy
  peers (ACL MAC check + vendor P2P IE) [decompiled/inferred]. A Deny is stored per-MAC and could
  poison the existing Lumen pairing [decompiled, risk]. Not worth it for a video-only, DRM-blanked
  feed.
- Keep **one** read-only use of 9119: a GENA SUBSCRIBE to `ScreenSharingState` as a passive
  "is the TV mirroring right now" flag. Never POST `X_ConnectScreenSharing*` without the user
  present.

### Why the camera is primary
It is the only path that is **universal and DRM-proof**: an optical sensor sees Netflix playback,
HDCP HDMI sources, every menu and every third-party app exactly as the human does — none of the
on-chip blanking (`protected_on`, "HDCP Source") applies. Lumen already owns the *control* half of
the loop; a cheap camera closes the *perception* half for 100% of apps. Downsides (glare,
perspective, focus) are solved once with a fixed mount + a one-time homography calibration, and
Claude's vision handles slightly imperfect photos well.

### Why dcapture is the fallback, not the primary
`samsung.tizen.dcapture` (`/usr/bin/display-capture-service`) is attractive — pixel-perfect stills,
on-demand, local, no glare — but three unknowns keep it as fallback until one supervised probe:
1. **It may not run / may be reachable only with privilege.** In the emulator the systemd unit has
   `ExecStart` commented out and dangling; real-firmware presence is unverified [decompiled].
2. **The web (WRT) UI context cannot call D-Bus at all** (no crosswalk D-Bus plugin), and the
   Node **service** context has no `tizen` D-Bus binding either — so we would need a **pure-JS
   D-Bus client** in the Lumen service speaking EXTERNAL auth over
   `/var/run/dbus/system_bus_socket`. The service runs as `User=owner`; the bus policy in the image
   is wide-open (`<allow send_type="method_call"/>`, `AllowWorld=talk` on the busname) with no
   per-interface cynara deny [decompiled `system.conf` + `samsung.tizen.dcapture.busname`]. Real
   firmware may add a Smack/cynara gate — **unproven**.
3. **DRM/HDCP video is blanked** (`protected_on`, forced to `DC_MODE_VIDEO_MAIN_ONLY`), so dcapture
   cannot verify "is Friends actually playing" — only the camera can.

But dcapture has one real advantage worth proving: the service exports
`mix_graphic_and_video_buffer` [decompiled symbol], i.e. it composites the **graphic (UI/OSD)
plane** with the video plane. So menus, app browse grids and login forms (all drawn on the graphic
plane) are very likely **present even when the video plane is black** — exactly the non-DRM screens
where a clean frame beats a camera photo. And critically, the one-shot
`RequestCaptureToFileSync` path shows **no** `_DCTask_IsRequesterAuthorized` call in the strings —
that authorization gate appears only on the *periodic* capture path
("forced_mode disabled... requester authorization required") [decompiled]. So a single on-demand
still may be ungated even if continuous capture is not. That is the first thing to test.

---

## 2. dcapture: the exact interface (offline, decompiled)

Service `/usr/bin/display-capture-service`, ELF 32-bit i386, not stripped
(sha256 91631d14…), `User=owner Group=users Type=dbus`.
Bus name `samsung.tizen.dcapture`, object `/samsung/tizen/dcapture`, interface
`samsung.tizen.dcapture` (introspection XML embedded in the binary). Uses `g_bus_get_sync`
(GDBus). Client lib `libdisplay-capture-api.so.0.0` links `libjpeg.so.8` + `libpng16.so.16`.

One-shot still (the call we want):
```
RequestCaptureToFileSync(
  i app_type,      # DC_APP_TYPE_SOURCE = source/composited path
  i capture_mode,  # DC_MODE_VIDEO (service may force DC_MODE_VIDEO_MAIN_ONLY)
  i comp_type,     # selects JPEG vs PNG (convert_raw_to_jpeg / convert_raw_to_png both present)
  i width, i height,
  i jpeg_quality,
  s dir_path, s file_name)
 -> (i retVal, i ret_width, i ret_height, s ret_path)
```
On completion it also emits a `CaptureComplete` signal and writes vconf
`memory/display_capture_service/capture_complete` with JSON `{type, app_id, capture_path}`
[decompiled strings]. Periodic variants (`StartPeriodicCapture(... interval_msec)`,
`EndPeriodicCapture`) exist but go through `_DCTask_IsRequesterAuthorized` and
`memory/display_capture_service/missed_req_app_id` — treat periodic as privileged/unreliable; use
on-demand one-shots for the loop.

Integration shape (only if the probe passes): Lumen **service** (Node) → pure-JS GDBus client →
`RequestCaptureToFileSync` into a dir it can read via `tizen.filesystem` → base64 the file → send
over the existing service-dials-out link to the PC. No `sdb`, no new privilege at install time
(it is a runtime D-Bus call, not a manifest privilege).

---

## 3. Structured text the agent gets for free (augment, always on)

From the on-TV agent (UI context) and LAN probes, all already verified or low-risk:
- **Foreground app** — REST `GET /api/v2/applications/<id>/` (`visible:true`) [live]; and
  `tizen.application.getAppsContext()` for running ids, `getAppsInfo()` for the 406-app name/id map
  [live].
- **Channel / programme** — `tizen.tvchannel.getCurrentChannel()` +
  `webapis.hybridchannelinfo.getCurrentChannel()` (name, number, `channelType`) [live].
- **Input source** — `tizen.tvwindow.getSource()` + `systeminfo` VIDEOSOURCE [live]; IP-Control
  `getTVStates.inputSource` [live].
- **Volume / mute / picture mode** — IP-Control getters + UPnP, with GENA push [live].
- **AT-SPI focused-element text** (candidate, unproven): the a11y bus conf has no cynara gate
  (`auth EXTERNAL`, `allow eavesdrop`); a native/pure-JS D-Bus listener as `owner` could read
  focus/announce signals for apps that expose an AT-SPI tree. Netflix/Samsung-UI tree exposure is
  unverified [decompiled + inferred]. Secondary.

This text is cheap and fast; feed it to Claude alongside every frame so the model is grounded
("foreground app = Netflix, input = TV, vol 4") instead of inferring identity from pixels.

---

## 4. The any-app agent loop

```
             ┌──────────────── Lumen host (Node, PC) ─────────────────┐
  user goal  │                                                        │
  ──────────>│  Planner (Claude)                                      │
             │     │                                                  │
             │     v         OBSERVE                                  │
             │  observation = { frame(JPEG), text-state, last-action }│
             │     │                                                  │
             │     v         DECIDE  (Claude vision+text)             │
             │  one step: {action, args, expectation, done?, ask?}    │
             │     │                                                  │
             │     v         ACT (existing Lumen transport)           │
             │  keys / pointer / IME / app-launch / deep-link         │
             │     │                                                  │
             │     v         VERIFY                                   │
             │  re-observe; compare to expectation; retry/replan      │
             └────────────────────────────────────────────────────────┘
```

### 4.1 OBSERVE — how Claude gets the observation
Each cycle the host assembles a compact observation and sends it to the Claude Messages API:
- **Image block**: one JPEG, longest side ~1024–1280 px, quality ~70, as a base64 `image` content
  block. Source = primary camera; or dcapture still if available and the screen is non-DRM.
  Downscale on the PC (sharp/ffmpeg) before the API call to bound tokens/latency.
- **Text block**: the structured state from §3 as a few lines (foreground app+id, input,
  channel/programme, volume/mute, and the agent's own last action + elapsed ms), plus the user
  goal and a short rolling action history (last 3–5 steps).
- Prefer **one frame per decision**, not video. For "did the screen change?" the host does a cheap
  local perceptual-hash / frame-diff and only re-queries Claude when the frame is stable AND
  changed, or after a fixed settle timeout (~800 ms after a key, matching Lumen's menu timing).
- Model: use a vision-capable Claude model for the decide step (a fast Sonnet-class model for the
  tight loop; escalate to an Opus-class model for ambiguous/first-time screens). **Pin exact model
  IDs and pricing via the `claude-api` skill reference — do not hardcode from memory.** Enable
  prompt caching on the static system prompt (tool/action schema + safety rules) to cut cost.

### 4.2 DECIDE — the model contract
Expose the agent's actions to Claude as a **tool/function schema** so every decision is one
structured action, never free text:
```
press_key(key: KEY_UP|KEY_DOWN|KEY_LEFT|KEY_RIGHT|KEY_ENTER|KEY_RETURN|KEY_HOME|KEY_MENU|
          KEY_PLAY|KEY_PAUSE|KEY_VOLUP|KEY_VOLDOWN|KEY_MUTE|KEY_CHUP|KEY_CHDOWN|0-9|KEY_EXIT, repeat?)
move_pointer(dx, dy) / click(left|right)         # only after touchEnable
type_text(text, secret?: bool)                   # IME SendInputString+SendInputEnd
launch_app(appId) | deep_link(appId, payload)    # REST launch / known deep links
wait(ms)                                          # let a screen settle / content load
report(status: done|blocked|need_confirm, message, evidence_frame)
```
Model returns exactly one action **plus** `expectation` (what the next frame should show) and an
optional `confidence`. The host executes it, waits the settle time, re-observes, and feeds the new
frame back labelled "result of <action>; expectation was <…>".

### 4.3 ACT — reuse what Lumen already proved
Keys over wss 8002 (`ms.remote.control`, Click/Press/Release, ≥200 ms spacing, always Release on
reconnect/blur), pointer `ProcessMouseDevice` after `touchEnable`, IME `SendInputString` +
`SendInputEnd` (native Tizen fields only — YouTube/Prime ignore IME, so fall back to on-screen
keyboard navigation with arrow keys for those), app launch via REST `POST
/api/v2/applications/<id>/`. Never send KEY_POWER hold; never KEY_FACTORY/service keys (server
allowlist already blocks them).

### 4.4 VERIFY
After each action, re-observe and let Claude compare the frame to its stated `expectation`:
- match → continue;
- no change after settle + one retry → treat the key as lost (re-check wss, resend once);
- unexpected screen (e.g. a login wall, an error toast, a "are you sure?" dialog) → replan, and if
  it is a gated/destructive screen (§6) → `need_confirm`.
Ground truth for "app changed" also comes from REST `visible` and the channel/source text, so
verification is not pixels-only.

---

## 5. Step budget (bound cost, latency, and runaway loops)

- **Per goal**: hard cap **20 decision steps** (configurable 12–25). Most real tasks
  ("play Friends on Netflix", "turn on Game Mode") are 6–14 steps.
- **Per screen**: max **3 attempts** at the same screen signature (perceptual hash). On the 3rd
  no-progress, stop and `report(blocked)` with the last frame — do not thrash the UI.
- **Settle timing**: 800 ms after a navigation key before re-observing; 150 ms Up/Down, 75 ms
  Left/Right in a repeat run (Lumen's measured macro timings); up to 5 s `wait` for app cold-start
  / content load, gated by REST `visible` flipping.
- **Watchdog**: whole-goal wall-clock cap (e.g. 90 s) and a token cap; on breach → `report(blocked)`.
- **Idempotence guard**: the host records the last N frame-hash + action pairs; if the model
  proposes the same action on the same screen hash twice with no change, force a replan prompt
  ("that did nothing, choose a different approach") rather than repeating.
- **Frame economy**: skip the Claude call entirely while frames are mid-transition (local
  frame-diff), so a 14-step task is ~14 vision calls, not one per 100 ms.

---

## 6. Safety

The agent presses real buttons on a live account. Rules, enforced in the **host** (not left to the
model):
- **Never, without an explicit fresh user confirmation**: anything that spends money or changes the
  account — purchase/rent/subscribe/upgrade buttons, "Buy", "Rent", in-app store, add payment,
  change PIN/parental settings, sign in / sign out / switch profile, delete, factory reset, SmartThings
  account actions. The model must emit `report(need_confirm)` with the frame; the host blocks the
  action and surfaces the screenshot to the user for a yes/no.
- **Destructive-key allowlist**: reuse Lumen's existing server-side block of KEY_FACTORY / service /
  panel / ARC keys. KEY_POWER only via the existing guarded path (Click only, when REST says `on`).
- **Confirm-screen classifier**: before executing a `click`/`KEY_ENTER`, the host checks the
  model's own screen label and a keyword check on any OCR'd button text ("Buy", "Purchase",
  "Confirm payment", "Sign out", "Delete", "Reset", "₹", "$") → force `need_confirm`. Two layers
  (model intent + text match) so a vision miss alone can't authorize a purchase.
- **No account typing by default**: `type_text(secret:true)` (passwords, card numbers) is refused —
  the agent asks the user to type credentials on the TV themselves. Never log `secret` text or IME
  `imeUpdate` for masked fields.
- **Read-before-write on the mirror service**: GENA SUBSCRIBE only; no `X_ConnectScreenSharing*`
  POST without the user present (a Deny is stored per-MAC and can break the Lumen pairing).
- **Rate & visibility**: respect SmartThings 12/min budget if used; keep the TV responsive — the
  user can interrupt at any time, and any physical-remote keypress pauses the agent.
- **Privacy**: redact MAC/BSSID/serial/SSID from any logged frame metadata and never upload frames
  that show the IME password overlay.

---

## 7. Live tests to run when the TV is ON (user present, in order)

Camera (primary) — no TV network contact needed:
1. Mount a USB webcam (or spare phone running an MJPEG/RTSP cam app) facing the panel; grab one
   frame at home screen, Settings menu, a Samsung-TV-Plus channel, HDMI1, Netflix browse, and
   Netflix *playback*. Confirm all six are legible (including DRM playback — the optical win).
2. Run a one-time homography calibration (show a known test pattern or the home grid; store the
   perspective transform + crop) and re-grab; confirm de-skewed frames are clean for Claude.
3. End-to-end dry run: goal "open Settings and show the picture menu" with the agent loop live,
   camera as eyes, 20-step cap; measure steps, wall-clock, and vision-call count.

dcapture (fallback) — supervised, on-TV agent:
4. From the Lumen **service**, bring up a pure-JS GDBus client on
   `/var/run/dbus/system_bus_socket` (EXTERNAL auth) and `Introspect` `samsung.tizen.dcapture` at
   `/samsung/tizen/dcapture`. Record whether the name is owned (service running) and introspection
   matches the offline XML.
5. Call `RequestCaptureToFileSync(DC_APP_TYPE_SOURCE, DC_MODE_VIDEO, comp=JPEG, 1280, 720, q=70,
   dir=<agent-readable tmp>, file="eye.jpg")`. Record `retVal`, `ret_path`, and whether the file
   appears; read it via `tizen.filesystem`. **Test on three scenes: (a) Settings menu, (b) a
   non-DRM app browse grid, (c) Netflix playback** — note which planes are present/black. This
   decides whether dcapture can serve non-DRM UI frames.
6. If step 5 works, measure one-shot latency and whether repeated one-shots (not periodic) stay
   ungated (`_DCTask_IsRequesterAuthorized` only guards the periodic path offline — verify live).

Text augment & mirror flag — read-only:
7. On-TV agent: confirm `getAppsContext`, `tvchannel`, `hybridchannelinfo`, `tvwindow.getSource`,
   VIDEOSOURCE all answer for the *current* foreground app (incl. Netflix) so the text channel is
   reliable while vision runs.
8. 9119 read-only: `GET /screen_sharing` + its SCPD (redact MACs), then GENA SUBSCRIBE to
   `ScreenSharingState` (TIMEOUT Second-1800); confirm the passive mirror flag works; UNSUBSCRIBE.
   Do **not** POST any X_ConnectScreenSharing action.

Decision gate: if test 5 shows dcapture returns legible graphic-plane frames for Settings/app UIs,
adopt **dcapture for non-DRM screens + camera for DRM/playback verification**; otherwise run
**camera-only** and keep dcapture parked. Either way the loop, step budget and safety in §4–6 are
unchanged — only the OBSERVE frame source differs.

---

## 8. One-paragraph recommendation

Build the agent loop now against an **external camera** as the primary eye (universal, DRM-proof,
PC-attached) plus the on-TV **text state** the agent already reads; wire OBSERVE→DECIDE→ACT→VERIFY
with a 20-step budget, a structured action tool-schema, and host-enforced confirm-gates on any
spend/account/destructive screen. Treat the on-TV **dcapture one-shot still** as a clean-frame
fallback for non-DRM UIs, to be switched on only after the single supervised probe (tests 4–6)
proves it runs from the Lumen service and composites the UI plane. **Drop the 9119/WFD mirror as an
eye** — it is video-only, DRM-blanked, and unreceivable on this PC — keeping just its read-only
`ScreenSharingState` subscription as a "TV is mirroring" flag.
