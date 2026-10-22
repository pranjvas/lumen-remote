# Research area: prior-art-ux

## Summary

No live TV contact in this area. All claims come from web and GitHub sources plus the facts the orchestrator supplied.

1. Prior art. Four recent open-source Samsung Tizen remotes are the closest models: tedyno/tvremote (a self-hosted web remote), Couch Remote, Clicky and awake-devel/tv-remote, plus the iOS remote Tele. Their published, tested notes settle the key UX constraints:
   - Volume can be read and set exactly over UPnP RenderingControl.
   - GENA LastChange push worked on a 2025 Q7F.
   - Holding a key with WebSocket Press/Release makes the TV auto-repeat it very fast (2 s gave +30 volume).
   - Text entry is a "replace the whole field" model, and `ms.remote.imeStart` is what other remotes use to pop up a keyboard.
   - The foreground app is found by probing app IDs over REST. The installed-app list and icon calls go unanswered on 2021+ TVs.
   - Picture settings (backlight, brightness, contrast and so on) are not exposed locally on modern Tizen. SmartThings `execute` reads returned null on a 2025 TV, and SmartThings volume can be stale.
   - SmartThings personal access tokens now expire after 24 hours, and there is a 12 requests/min per-device limit.
2. Samsung's own SmartThings remote supplies the baseline interaction vocabulary: touchpad swipe moves, tap selects, double-tap goes back. A 123 pad holds numbers and colour keys, VOL/CH rockers sit with the d-pad, there is an Edit mode for shortcuts, and options for Dark/Light theme and vibration. Its known weaknesses are a stateless volume rocker, essential controls hidden behind toggles, and sub-screens that ignored dark mode.
3. Home Assistant's universal-remote-card supplies proven timing constants: hold 500 ms, repeat 100 ms, double-tap 200 ms, swipe threshold 16 px. It also supplies the slider rule: ignore server updates while dragging and for 1000 ms afterwards.
4. Proposed design language: "HALO". It is a dark-first instrument in smoked graphite and glass, inspired by Q95T Ambient Mode and the Bang & Olufsen Beoremote Halo. A luminous hairline ring around the d-pad is the live volume gauge. The light variant is "Gallery". There is one warm "Ember" signal colour, replaced at runtime by a contrast-clamped tint taken from the current app's icon. Fonts are self-hosted, all SIL OFL: Inter Variable, Fraunces Variable and JetBrains Mono. Icons are an inline SVG sprite. Sound is synthesised with Web Audio and off by default; haptics use navigator.vibrate and work on Android only.
5. Information architecture. On phones, a fixed, non-scrolling Remote screen with tabs: Remote / Touch / Keys / Apps / Status. On desktop, a 3-zone console: Now / Instrument / Status. Every displayed TV value carries a provenance badge: Live / On-TV app / SmartThings / Tracked / Estimated / Unavailable. Each badge has its own glyph and shows its age.
6. The protocol details give exact tokens (contrast checked against WCAG), layout grids, component specs, key/transport maps, gesture and hold-repeat rules, a reconciliation algorithm, the connection state machine (two hops: phone to PC to TV), keyboard shortcuts, accessibility rules and the delight details.
7. Capabilities the design depends on that nobody has checked on this TV are marked critical: GENA push, WebSocket keys and pairing, IME events, SetVolume, the 'visible' foreground-app flag, standby and wake behaviour, and SmartThings modes. The design falls back gracefully if any of them is missing.

## Capabilities

- **Read current volume level (0-100) for the Halo ring and numeric readout** (live-tv, high; read=true write=false live=false): UPnP SOAP POST http://192.168.1.2:9197/upnp/control/RenderingControl1, SOAPACTION "urn:schemas-upnp-org:service:RenderingControl:1#GetVolume", InstanceID 0, Channel Master -> CurrentVolume
  - The orchestrator saw GetVolume return 4 today. This is the single source of truth for the volume UI. If GENA push is unavailable, poll every 1.5 s while any client page is visible, every 10 s when all are hidden, and not at all with no clients (never faster than 1 per 200 ms). Clicky reports UPnP volume reflects TV speakers only; with an ARC soundbar or Bluetooth the UI must switch to stateless +/- mode and label the level Unavailable.
- **Live volume/mute updates when changed from the physical remote (Halo animates to the TV's real level)** (community, medium; read=true write=false live=true): GENA SUBSCRIBE http://192.168.1.2:9197/upnp/event/RenderingControl1 with CALLBACK: <http://<PC socket.localAddress>:<port>/gena/rc>, NT: upnp:event, TIMEOUT: Second-300; TV sends NOTIFY with LastChange XML (Volume, Mute, X_AspectRatio, captions). Renew at ~240 s; UNSUBSCRIBE on shutdown.
  - Confirmed on a 2025 Q7F: SUBSCRIBE returned 200 with an SID, and the first NOTIFY arrived in under 1 s. That project did NOT test whether change events fire when another source (the physical remote) changes the volume. The 'volume ring follows the real TV' and 'echo of physical remote' delights depend on this. Fallback is polling GetVolume/GetMute. A companion on-TV app using tizen.tvaudiocontrol.setVolumeChangeListener is a second fallback.
- **Set exact volume and step +/- without TV-side acceleration** (community, high; read=false write=true live=false): UPnP SetVolume (InstanceID 0, Channel Master, DesiredVolume n) on /upnp/control/RenderingControl1; +/- implemented as SetVolume(current +/- step). Fallback: WebSocket KEY_VOLUP/KEY_VOLDOWN Click.
  - Works on a 2021 Tizen 6.0 TV (Couch Remote 'volume 12'). Not exercised on this TV because set calls are forbidden in research. Prefer absolute SetVolume so a hold can never run away: a WebSocket Press hold raised volume by 30 in 2 s. The UI enforces a user max-volume cap (default 50) and asks for confirmation on jumps over 20.
- **Read and toggle mute state** (live-tv, high; read=true write=true live=true): UPnP GetMute (CurrentMute 0/1) / SetMute (DesiredMute 0/1) on RenderingControl1; fallback WebSocket KEY_MUTE (toggle, state unknown until re-read)
  - GetMute and SetMute are listed in this TV's RenderingControl SCPD (observed live), but GetMute was not actually called. When muted, the Halo arc desaturates and the readout shows 'MUTED' with the last level ghosted. awake-devel reports that a SmartThings setVolume unmutes the TV.
- **Send any remote key, including press-and-hold** (source-code, high; read=false write=true live=false): wss://192.168.1.2:8002/api/v2/channels/samsung.remote.control?name=<base64 name>&token=<token>; {"method":"ms.remote.control","params":{"Cmd":"Click|Press|Release","DataOfCmd":"KEY_*","Option":"false","TypeOfRemote":"SendRemoteKey"}}
  - Every button depends on this. The PC host keeps exactly one WebSocket to the TV and fans out to all browser clients, so the TV sees one client name and shows one Allow prompt. Press/Release makes the TV repeat the key itself. The server therefore runs its own repeat cadence with Click, or a watchdog that sends Release after 8 s, on client disconnect, or after 1.5 s without a hold heartbeat. Couch Remote tested KEY_UP/DOWN/LEFT/RIGHT/ENTER/RETURN/HOME/VOLUP/VOLDOWN/SOURCE/1-5; KEY_HDMI1/2, KEY_APP_LIST and KEY_CONTENTS had no effect on a 2021 TV.
- **Pairing / authorisation status ('Accept on your TV' screen) and other-client awareness** (source-code, high; read=true write=false live=true): WebSocket events: ms.channel.connect (data.token -> store), ms.channel.unauthorized (Deny), ms.channel.timeOut, ms.channel.clientConnect / ms.channel.clientDisconnect
  - Drives the pairing card, the Denied state and the 'token saved' confirmation. clientConnect/clientDisconnect can show 'another remote (e.g. SmartThings app) connected' in the Connection section. Pairing shows a dialog on the TV, so schedule it with the user.
- **Text panel that opens automatically when the TV shows its keyboard, mirrors the field and sends text** (source-code, medium; read=true write=true live=true): Events ms.remote.imeStart / ms.remote.imeUpdate (data likely base64 field text) / ms.remote.imeDone / ms.remote.imeEnd; send {"method":"ms.remote.control","params":{"Cmd":"<base64>","DataOfCmd":"base64","TypeOfRemote":"SendInputString"}} (replaces whole field) and {"params":{"TypeOfRemote":"SendInputEnd"}}
  - Used by awake-devel/tv-remote, Tele and control-tray to pop up keyboard entry. Tele decodes imeUpdate as base64 text. The REST info shows ImeSyncedSupport true on this TV, which is promising but not proof. Because SendInputString replaces the field, live typing resends the full string, debounced to 120 ms. Some apps may ignore it (tedyno). Never log the text, and offer a hide toggle since the field could be a password.
- **Pointer (mouse) mode on the touchpad when the TV app supports it** (source-code, medium; read=true write=true live=true): Events ms.remote.touchEnable / touchDisable; {"method":"ms.remote.control","params":{"Cmd":"Move","Position":{"x":dx,"y":dy,"Time":"0"},"TypeOfRemote":"ProcessMouseDevice"}} and Cmd LeftClick/RightClick
  - Move is relative, in roughly 1920x1080 units, and works in the TV browser (Couch Remote). Show the 'Pointer' segment of the touchpad mode switch only after touchEnable arrives.
- **Foreground app for the now-playing strip and the background brand tint** (live-tv, medium; read=true write=false live=false): HTTP GET http://192.168.1.2:8001/api/v2/applications/<appId>/ (trailing slash required on this TV) -> {id,name,running,visible,version}; probe a curated list of IDs, at most 1 request per 200 ms, prioritising last-known and favourites
  - The endpoint answering 200 is live-tv. The semantics of 'visible' (true = in front) are documented by Couch Remote and awake-devel for 2021/2025 TVs but not checked here. Clicky notes app status can time out while the TV is busy: only a 404 means 'not installed', and timeouts keep the cached state. Between probes, show the app as 'Tracked' with an age.
- **Enumerate installed apps with icons (apps grid)** (community, low; read=true write=false live=false): WebSocket ms.channel.emit ed.installedApp.get and ed.apps.icon {iconPath} (may not answer); fallback: curated app-ID catalogue plus bundled icons; option: companion Tizen app using tizen.application.getAppsInfo()
  - ed.installedApp.get and ed.apps.icon got no reply on 2021 and 2022 TVs. openHAB's comment says those eden calls 'do not work on >2020 TVs', so a 2020 TV might still answer. Fallbacks: tile icons copied from /opt/share/webappservice/apps_icon/all/<id>/304x304.png via sdb (Couch Remote), a companion app, or bundled icons. Never fetch icons from external services at runtime (tedyno proxies Google's favicon service, an anti-pattern here).
- **Power button showing state (On / Standby / Waking / Unreachable) and wake strategy** (live-tv, medium; read=true write=true live=false): REST GET /api/v2/ device.PowerState ('on' observed; 'standby' expected); off = WebSocket KEY_POWER (hold-to-confirm in UI); wake = KEY_POWER while REST reports standby and the socket accepts, else Wake-on-LAN (needs 'Power On with Mobile'); SmartThings switch.on as last resort
  - Only PowerState 'on' was observed. Clicky's tested sequence on a 2022 TV: about 20 s of network standby after power-off, during which REST says standby, WoL is ignored and KEY_POWER wakes the TV in about 0.5 s. After that the TV leaves the network and WoL wakes it in about 2 s. The UI shows 'Waking... 1.8 s' and keeps trying the fitting signal until REST says on. Fully off means no REST answer at all, shown as 'Unreachable, last seen 14:02'.
- **Picture settings readout: backlight, brightness, contrast, sharpness, colour, tint, colour tone** (community, medium; read=false write=false live=false): No known local API on modern Tizen. SmartThings 'execute' /sec/tv/mode/picture and /sec/tv/optioncontrol returned null payloads on a 2025 TV. UI shows these as Unavailable, with 'Track it' (user-entered value), an optional companion app (unknown API) and an experimental 'Open on TV' menu jump
  - The user's 'brightness levels' example is exactly what the TV does not expose. openHAB's README says the brightness/contrast/sharpness/colorTemperature channels 'don't work on newer TV's', and Clicky lists picture settings as not exposed locally. The design must never present these as Live: values are Tracked (entered by the user, or set by a verified macro) with confidence that decays, or shown as an em dash with an explanation. Menu-navigation macros are fragile (awake-devel removed them), so offer them only as labelled 'Experimental' jumps that open the TV's own picture menu, never as silent setters.
- **Picture mode, sound mode, input source, channel (Status view, 'From SmartThings' badge)** (source-code, medium; read=true write=true live=false): SmartThings REST GET https://api.smartthings.com/v1/devices/{id}/status; capabilities custom.picturemode / samsungvd.pictureMode, custom.soundmode, mediaInputSource / samsungvd.mediaInputSource, tvChannel, audioVolume; OAuth app recommended (PATs created after 2024-12-30 last 24 h)
  - The rate limit is 12 requests/min per device across status reads and commands, so refresh no more than every 60-120 s and on demand. Always show the age. awake-devel saw stale cloud volume (audioVolume 0 while the TV was at 3), and pictureMode writes ignored on a Q7F. Cloud values rank below LAN values. SSE subscription returned 403 with OAuth, so there is no cloud push.
- **Aspect ratio and caption state in the Status view** (live-tv, medium; read=true write=false live=true): UPnP X_GetAspectRatio and X_GetCaptionState on /upnp/control/RenderingControl1 (read-only); also carried in GENA LastChange (X_AspectRatio, captions)
  - Both actions are listed in this TV's SCPD (observed), but they have not been invoked, so the response argument names must be checked. Nice-to-have rows in the Picture section.
- **Device identity panel: name, model, model code, OS, resolution, developer mode, feature flags, API version** (live-tv, high; read=true write=false live=false): HTTP GET http://192.168.1.2:8001/api/v2/ (device.*, isSupport, version)
  - Fully live. Year 2020 and Tizen 5.5 are derived from the model code '20_NIKEM_QTV', shown with a 'derived' tooltip. firmwareVersion was 'Unknown' on a 2025 TV, so source firmware from SmartThings samsungvd.firmwareVersion or a companion app (tizen.systeminfo BUILD). Mask MAC/DUID/serial by default behind a 'Reveal' button so screenshots are safe.
- **Connection health and latency (two-hop chain phone/PC/TV, connection pulse)** (live-tv, high; read=true write=false live=true): PC measures REST GET /api/v2/ round trip every 10 s (5 s while a client is visible), WebSocket send-to-ack timing, GENA last-NOTIFY age and SID expiry; browser measures its ping to the PC over its WebSocket every 5 s
  - REST is reachable today. Shows a sparkline and a classification: healthy under 150 ms, degraded 150-600 ms or reconnecting, offline. The pulse cadence is driven by these numbers.
- **Companion on-TV app as a fallback for live volume, mute and audio output format** (official-doc, medium; read=true write=true live=true): tizen.tvaudiocontrol.getVolume() (0-100), isMute(), setVolumeChangeListener(cb), getOutputMode() -> 'PCM'|'DOLBY'|'DTS'|'AAC'|'DOLBY_DIGITAL_PLUS'; privilege http://tizen.org/privilege/tv.audio (public; flagged deprecated at public level since Tizen 5.0)
  - The user can sign their own .wgt, and CineHD's Node service already exists. A small background service could push volume events and an 'output format' to the PC, with an 'On-TV app' provenance badge. Whether the deprecated public privilege still works on 5.5 is open.
- **Rich now-playing (title, poster, progress) when CineHD is in front** (inferred, medium; read=true write=false live=true): CineHD's own service (pvcinehd01.MediaService) reports playback state to the PC host over a LAN HTTP/WebSocket channel the user implements
  - The only way to get real titles and progress for the user's main app. Other apps only get name, icon and tint.
- **Source/input switching and current input display** (community, low; read=true write=true live=false): WebSocket KEY_SOURCE (opens TV source bar), KEY_HDMI1..KEY_HDMI4 / KEY_HDMI (may be ignored), SmartThings mediaInputSource.setInputSource; current input from SmartThings or Tracked (last chosen here)
  - Clicky: the TV doesn't report the active source locally, and on Tizen 6.5 KEY_HDMI1-4 are ignored while KEY_HDMI goes to the last-used HDMI input. Couch Remote: KEY_HDMI1/2 had no effect on a 2021 TV. Inputs can be user-named ('PS5') with a Tracked badge.
- **Haptic feedback on phones** (community, medium; read=false write=true live=false): navigator.vibrate(pattern) after user activation; no-op where unsupported
  - Works in Android Chrome. iOS Safari does not implement it (secondary sources; MDN says the API is not Baseline). The design must not depend on it. SmartThings has a 'Remote vibration effect' toggle; mirror it as a setting, on by default on Android.
- **Keep phone screen awake / installable PWA / clipboard paste** (official-doc, high; read=false write=false live=false): navigator.wakeLock.request('screen'), service worker + manifest, navigator.clipboard.readText()
  - These require a secure context. http://localhost on the PC qualifies, but http://<PC-LAN-IP>:port on a phone does not. Options: HTTPS with a self-signed or local-CA certificate (whether the click-through counts as a secure context is unconfirmed), or accept no Wake Lock or install. Plain paste into a textarea works everywhere.
- **Activity and energy: 'on since', daily on-time per app, estimated kWh** (community, medium; read=true write=false live=true): PC host records PowerState transitions and the foreground app over time (Tracked); energy = on-time x user-configured rated watts (Estimated); optional SmartThings powerConsumptionReport
  - Precedents: Clicky's Activity tab (screen time per app and input, counted locally) and control-tray's estimated kWh from on-time x configured power. Uptime is only known since the PC host started watching, shown as 'On for at least 2 h 10 m'.

## Protocol details

# HALO: design spec for the Q95T browser remote (area: prior-art-ux)

Evidence tags: [live-tv] = the orchestrator observed it on this TV today; [src] = source code; [doc] = official docs; [comm] = community, forum or blog; [inf] = inferred.

---
## 1. Prior-art survey

| Product | Copy this | Avoid this | Evidence |
|---|---|---|---|
| **SmartThings mobile remote** (2023 dark redesign, 2024 support doc, 2026 app redesign) | Power top-left. VOL rocker (up/down plus mute) and CH rocker (browse, opens Guide). Swiping left over VOL/CH reveals apps, programs and inputs. The square icon toggles the d-pad versus a **touchpad (swipe = move, tap = select, double-tap = back)**. The **123** icon opens the numbers + colour keys pad. Back bottom-left, Home centre, Mic bottom-right. More > Edit adds or removes shortcut groups ('Sources & Apps', 'Media Control'). Remote options: Dark/Light and 'Remote vibration effect'. 2026: light mode, resizable and movable remote. | Volume rocker shows **no level**. The d-pad and number pad hide behind toggles. The 2023 critique called the old layout 'buttons placed seemingly at random', and the source/app picker ignored dark mode. | [doc] samsung.com/latin_en/support/tv-audio-video/how-to-control-your-tv-from-mobile-smartthings-app/ ; samsung.com/pe/support/.../controlling-a-2024-samsung-smart-tv-with-the-smartthings-app-mobile-remote ; [comm] sammobile.com/opinion/smartthings-tv-remote-redesigned-dark-mode/ (2023-10-23); androidauthority / sammyfans 2026-09/10 |
| **Apple TV Remote (Control Center)** | Touch area: swipe to highlight, tap to select, touch-and-hold for options. A **keyboard notification appears automatically when a text field opens on the TV.** | n/a | [doc] support.apple.com/guide/tv/atvb827791d6 ; atvb701cadc1 |
| **Google TV / Google Home remote** | Swipe pad by default, with a **user-selectable D-pad** (Google Home 2.47.10, three-dot menu). Phone keyboard for passwords and search. Quick Settings tile. | Swipe-only by default frustrated users. | [comm] 9to5google 2021-11-09; howtogeek 757203 |
| **Roku app** | Keyboard, voice. 'Private listening' (not feasible here). | n/a | [comm] |
| **LG ThinQ** | Pointer (Magic Remote emulation), scroll, arrows + OK. | n/a | [doc] lg.com help library CT10000018 |
| **HA universal-remote-card (Nerwyn)** | Composable rows and columns. Elements: circlepad (with clickwheel ring), touchpad (multi-touch, drag mode), slider, numpad, xpad. tap/double_tap/hold per element. **Constants:** HOLD_TIME 500 ms, REPEAT_DELAY 100 ms, DOUBLE_TAP_WINDOW 200 ms, SWIPE_THRESHOLD 16 px, CLICKWHEEL_THRESHOLD 20, UPDATE_AFTER_ACTION_DELAY 1000 ms, haptics on by default. **The slider ignores state updates while touched and for 1 s after release.** Samsung keyboard uses replace-on-send. | Generic HA look; YAML-heavy. | [src] github.com/Nerwyn/universal-remote-card src/models/constants.ts, src/classes/remote-slider.ts, src/classes/dialogs/keyboards/samsung-tv-keyboard.ts, src/models/maps/samsung_tv/defaultKeys.ts |
| **mini-media-player** | `volume_stateless` vs slider, `volume_step`, `max_volume`, `artwork: material` (dynamic colours from art), `idle_view` (when idle, paused or standby), shortcuts grid. | n/a | [src] github.com/kalkih/mini-media-player README |
| **tedyno/tvremote** (Go, self-hosted **web** remote, PWA) | Press-and-hold repeat with acceleration. Types into the TV's focused field. Favourites by long-press. Live power and active app. OLED black. **Tap detection so swipes don't fire buttons.** | **No auth** on the LAN. App icons **proxied from Google's favicon service** (runtime external dependency). Typed text not echoed. | [src] github.com/tedyno/tvremote README |
| **Couch Remote** (macOS) | Real icons, drag to reorder. Hold repeats. **Volume slider reads and sets the real TV volume (UPnP).** Trackpad pointer mode. Live typing field. Shortcuts: arrows, Return=OK, Delete=Back, Space=Play/Pause, H/I, M, +/-, 0-9. 'Remote button rules'. | n/a | [src] github.com/HelgeSverre/couch-remote README and docs/PROTOCOL.md |
| **Clicky** (macOS, Frame) | **Now Playing tab with a TV mock-up showing what's on screen.** Activity (screen time per app and input). State-aware power. An honest **'What Samsung doesn't expose locally'** section: current input, HDMI port selection, picture settings; UPnP volume only applies to TV speakers. | n/a | [src] github.com/iamvivekkaushik/Clicky README |
| **awake-devel/tv-remote** (GTK/TUI/Android) | Keyboard entry when `ms.remote.imeStart` arrives. SmartThings via OAuth. Picture and sound mode via the cloud. **Removed key-navigation macros as fragile.** | n/a | [src] github.com/awake-devel/tv-remote README, docs/ideas/feature-research.md |
| **Tele** (iOS) | **'A fixed, non-scrolling instrument'**: app tiles at the top, playback/Back/Home/Source in the middle, and a **navigation disc with OK in thumb reach, flanked by VOL/CH rockers whose middle press mutes or opens the guide**. Keys fire on touch-down. Follows the TV keyboard (imeStart/imeUpdate base64/imeEnd). | n/a | [src] github.com/willysvarela/tele README |
| **control-tray** (Windows tray) | Highlights the open app. Types from the PC when the TV keyboard opens. Sleep timer. **'Estimated' kWh** from on-time x configured watts. | n/a | [src] github.com/Zalasik01/control-tray README |
| **Samsung Ambient Mode / Ambient Mode+** | Décor / Artwork / Info (time, weather) that blends into the wall. Model for the idle screen. | n/a | [doc] samsung.com/latin_en/support/tv-audio-video/how-to-use-ambient-mode-on-samsung-qled-tv |
| **B&O Beoremote Halo** | Aluminium ring around a 'floating' display; the ring is the volume control; the display wakes on approach. Model for the Halo ring. | n/a | [comm] retailer copy (avstore.in, selfridges) |

**Anti-patterns to design out:**
1. A stateless volume rocker.
2. Essentials hidden behind mode toggles on desktop.
3. A slider that bounces between old and new values.
4. Swipes that trigger buttons.
5. Double-tap detection that delays every single tap.
6. Accidental power-off from a single tap.
7. Runtime CDNs or icon proxies.
8. Showing cloud or guessed values as if they were live.
9. Silent, fragile menu macros.
10. Sub-screens that ignore the theme.
11. Promising phone hardware volume keys. The browser cannot capture them [inf].

---
## 2. Design language: **HALO**

**Concept.** 'An ambient instrument for the Q95T.' The remote is a piece of dark hi-fi equipment: smoked glass over graphite, a single warm signal light, and one luminous hairline ring (the *halo*) around the d-pad that always shows the TV's real volume. It is calm while idle and comes alive only when something changes. Two themes: **Nocturne** (dark, default) and **Gallery** (warm paper, light).

### 2.1 Tokens (contrast checked with the WCAG formula; ratios are against the named surface)
```css
:root{ /* Nocturne */
  --void:#07080A; --chassis:#0E1013; --panel:#15181D; --key:#1D2128; --key-hi:#262B33;
  --hair:rgba(255,255,255,.08); --hair-strong:rgba(255,255,255,.16);
  --ink:#F2EFE8;   /* 16.6:1 chassis, 14.1 key */
  --ink-2:#B4B9C2; /* 9.7 chassis, 8.2 key */
  --ink-3:#8F95A0; /* 6.3 chassis, 5.4 key, 4.7 key-hi */
  --ember:#FFB454; /* default signal accent, 10.8 chassis */
  --quantum:#7CC8FF; --live:#5FD99E; --warn:#FFC85C; --danger:#FF7A70; --violet:#B9A4FF;
  --focus:#FFD089; /* 11.3:1 on key */
  --accent:var(--ember); --tint-rgb:255 180 84; /* replaced by app tint */
  --r-key:14px; --r-card:20px; --r-pill:999px;
  --dur-press:90ms; --dur-state:160ms; --dur-panel:280ms; --dur-scene:520ms; --dur-tint:1200ms;
  --ease-out:cubic-bezier(.2,.8,.2,1); --ease-io:cubic-bezier(.65,0,.35,1);
}
[data-theme="gallery"]{
  --void:#F3F0E9; --chassis:#F3F0E9; --panel:#FFFFFF; --key:#E9E5DC; --key-hi:#DED9CE;
  --hair:rgba(0,0,0,.08); --hair-strong:rgba(0,0,0,.18);
  --ink:#16181C; --ink-2:#474D57; --ink-3:#5A606A; /* 5.0 on key */
  --ember:#8F5400; --quantum:#0B5E9F; --live:#0F6E44; --warn:#7F5900; --danger:#B3261E; --violet:#5B45B8;
  --focus:#0B5E9F;
}
@media (prefers-color-scheme: light){ :root:not([data-theme]){ /* apply gallery */ } }
```
- **Optional 'True black'** toggle for OLED phones: `--void:#000`.
- **Key surfaces are only about 1.2:1 against the chassis.** Buttons are identified by icon or label contrast (at least 3:1, actually 8:1 or more). Under `prefers-contrast: more`, add a 1px `--ink-3` border.
- **App tint pipeline.** Take the dominant colour of the bundled app icon (k-means at build time, or a canvas sample of a same-origin icon). Convert to OKLCH and clamp:
  - Nocturne: L 0.72-0.82, C ≤ 0.16.
  - Gallery: L 0.42-0.52.

  Use the result only for glows, the halo arc and focus accents, never for large fills. Raw brand reds fail contrast (Netflix #E50914 on void = 4.18:1). Precompute on the server; don't rely on CSS relative-colour syntax.

### 2.2 Typography (self-hosted woff2, all SIL OFL 1.1, subset with fonttools `pyftsubset` to Latin + digits + symbols; `font-display:swap`)
- **Inter Variable** (github.com/rsms/inter) for UI. Use `font-feature-settings:"tnum" 1,"cv11" 1` for every number.
- **Fraunces Variable** (github.com/undercasetype/Fraunces, opsz axis) for editorial display: app names, the ambient clock, screen titles.
- **JetBrains Mono** (github.com/JetBrains/JetBrainsMono) for technical readouts: IP, IDs, latency.
- Fallbacks: `"Segoe UI Variable", system-ui, Roboto, -apple-system, sans-serif`; mono `"Cascadia Mono", ui-monospace, monospace`.
- **Scale:**

| Role | Font, weight | Size / line-height | Extra |
|---|---|---|---|
| Ambient clock | Fraunces 300, opsz 144 | 96/1 | -0.02em |
| Screen title | Fraunces 400 | 28/1.15 | |
| Now-playing app | Fraunces 500 italic | 20 | |
| Volume readout | Inter 300 | 56 | tnum, -0.03em |
| Status value | Inter 500 | 20 | tnum |
| Body | Inter 400 | 15/1.45 | |
| Key silkscreen label | Inter 600 | 11 | uppercase, +0.12em, `--ink-2`, like printing on audio gear |
| Mono | JetBrains Mono 400 | 13 | |

### 2.3 Depth and material
- **Chassis:** `linear-gradient(180deg,#121419,#0B0C0F)` plus a 3% grain overlay (a 128px tiled noise PNG generated once, data-URI, no network).
- **Key cap:** `background:linear-gradient(180deg,#232830,#1A1E24); box-shadow: inset 0 1px 0 rgba(255,255,255,.06), inset 0 -1px 0 rgba(0,0,0,.5), 0 1px 2px rgba(0,0,0,.6), 0 8px 16px -8px rgba(0,0,0,.7)`.
  - **Pressed:** `translateY(1px)`; `inset 0 2px 6px rgba(0,0,0,.6), 0 0 0 1px rgb(var(--tint-rgb)/.4), 0 0 18px rgb(var(--tint-rgb)/.25)`.
- **D-pad ring:** brushed metal with `repeating-conic-gradient(from 0deg,#1c2027 0 1.5deg,#20252d 1.5deg 3deg)` under a radial highlight. On desktop, a specular highlight follows the pointer (CSS vars `--mx/--my`); disabled under reduced motion.
- **Glass panels** (sheets, Status cards): `rgba(21,24,29,.72)` with `backdrop-filter: blur(20px) saturate(140%)`. Fall back to solid `--panel`, and use solid in 'Lite mode' on low-end phones.

### 2.4 Motion
- **Timing:** press 90 ms; state changes 160 ms; panels and sheets 280 ms using `--ease-out`; scene changes 520 ms; app-tint crossfade 1200 ms.
- **Springs:** the volume arc and readout use a critically damped spring (stiffness 300, damping 30, about 250 ms settle) toward the target value.
- **Reduced motion** (`prefers-reduced-motion: reduce`): no springs, pulse, parallax or specular effects; values jump instantly; only opacity fades of 120 ms or less remain.

### 2.5 Sound and haptics
- **Sound:** off by default. Synthesised with Web Audio, no files: a key tick is a 25 ms burst of filtered noise (bandpass 3.2 kHz, Q 4, gain 0.08, exponential decay). Volume detents are a 6 ms sine whose pitch maps to level (600 Hz at 0 rising to 1100 Hz at 100). The AudioContext is created on the first user gesture.
- **Haptics:** Android only; on iOS they silently do nothing. A settings toggle, like SmartThings 'Remote vibration effect'.

| Event | navigator.vibrate pattern |
|---|---|
| key | 8 |
| volume detent | 4, throttled to 1 per 40 ms |
| long-press armed | 15 |
| power hold complete | [10,40,10] |
| error or blocked | [20,60,20] |

### 2.6 Iconography
- One inline SVG `<symbol>` sprite in index.html: 24px grid, 1.75px stroke, round caps and joins, `currentColor` (works in forced-colours mode).
- Custom glyphs: Source, Ambient, 123/colour, Smart Hub, TV-settings gear, Status gauge, Halo, and the provenance glyphs.
- App icons are bundled or cached locally. Fallback is a monogram tile: the tint colour plus a Fraunces initial.

---
## 3. Information architecture

**Breakpoints:**

| Width | Layout |
|---|---|
| < 760 px | Phone. Fixed screens with a bottom tab bar: **Remote, Touch, Keys, Apps, Status**. |
| 760-1279 px | Two columns, split 7/5: Instrument, then a tabbed Now + Status column. |
| ≥ 1280 px | Console. 12 columns, 24px gutters, 32px margins, max width 1440. Now spans cols 1-3, Instrument cols 4-8, Status cols 9-12. |

Landscape phone uses the two-column layout.

**Naming:** the TV's own menu key is labelled **'TV Settings'** (gear, sends KEY_MENU). The web app's information view is **'Status'** (gauge icon) so the two are never confused. Long-press on TV Settings opens Status.

**State tree served by the PC** (browser clients only render it):
`power`, `connection{phonePc,pcTv,remoteWs,gena,smartthings,companion}`, `sound{volume,mute,mode,output}`, `picture{mode,backlight,brightness,contrast,sharpness,colour,tint,aspect,captions}`, `device{...}`, `network{...}`, `app{foreground,since,tint}`, `input`, `ime{active,text}`, `activity{...}`. Every leaf is a **provenance record** (section 6).

---
## 4. Screen mockups

### S1 Phone: Remote (reference 390x844 CSS px, minimum 360x640; fixed, `overscroll-behavior:none`, `height:100dvh`, safe-area insets respected)
1. **Header, 56px.** `[Power 44x44]` at the left (16px margin). Centre: two lines, 'Q95T' in Inter 600 15 and, below, a **connection chain** `phone ●──● PC ●──● TV` (8px dots, each segment coloured live/warn/danger) with latency '18 ms' in mono 12 `--ink-3`. Right: `[Status 44x44]`.
2. **Now strip, 64px** (card r16, margins 16). Contents: app icon 40 (r10), app name in Fraunces 500 italic 20, a sub-line 'Since 20:14 · Live' with a badge, and on the far right a chip 'VOL 12'. The background is a left-to-right gradient of the tint at 14%.
3. **Instrument, flexible (minimum 260px).**
   - **Halo d-pad** diameter `clamp(240px, min(72vw, 42dvh), 320px)`, centred.
   - The outer **halo arc** is a 3px stroke, 270° sweep from 225° clockwise, with a track of `--hair` and the level in `--accent`. It shows volume/max and has an 8px glow while changing.
   - Four ring segments 2px apart, ring thickness 30% of the radius, inline-SVG chevrons.
   - **OK** in the centre at 38% of the diameter, a convex cap, with the label 'OK' in silkscreen style.
4. **Nav row, 56px.** Three keys of 72x48 with 24px gaps: Back (↶), Home (⌂), TV Settings (gear).
5. **Rocker row, 136px.**
   - **VOL rocker** at the left: a 64x136 pill. The top half is '+', the bottom half '−'. The centre is a vertical 10-segment LED ladder (4x6 px segments, 3px gaps) lit to volume/max. A centre tap toggles mute (as on Tele); a long-press opens the **Volume sheet**.
   - **Centre cluster:** a 2x2 grid of 52px round keys: Source, Play/Pause, Keyboard, 123 (jumps to the Keys tab).
   - **CH rocker** at the right: 64x136. A centre tap sends KEY_CH_LIST; a long-press sends KEY_GUIDE. If SmartThings provides a channel number, it shows inside the rocker.
6. **Tab bar,** 64px plus the bottom safe area.

On 640px-tall screens: the Halo shrinks to 240, rockers to 112 and the Now strip to 56.

**Volume sheet** (bottom sheet at 60% height):
- Readout in Inter 300 72, with the provenance badge and its age.
- A horizontal slider from 0 to the cap: ticks every 5 with majors every 10, a 28px thumb, `role=slider`.
- −/+ keys of 56px.
- Chips for the user's three most-used levels (Tracked).
- Mute switch and the 'Max volume limit' setting (default 50).

### S2 Desktop console (1440x900)
- **Top bar, 64px:** wordmark 'HALO' (Fraunces 500 22, +0.2em), TV name, connection chain with a latency sparkline (80x20), theme toggle, '?' for shortcuts, and 'Approve devices' (section 9).
- **Now column (cols 1-3), stacked with 16px gaps:**
  1. **Now Playing card,** 100% x 260. A **mini-TV silhouette** (16:9, r6, 2px bezel) holds the app tile on a tint glow (Clicky's mock-up idea). Then the app name in Fraunces 28, 'Since 20:14', input, and badges. Actions: Close app, Info.
  2. **Power card,** 120px: a large ring button with a state label.
  3. **Scenes** (S8 list).
  4. **Activity ribbon:** 24 hours, one 12px bar per hour segment, coloured by app tint.
- **Instrument (cols 4-8):**
  - Halo d-pad at 360px, with the volume halo and a large readout 'VOL 12' under the ring.
  - The Back/Home/TV Settings row.
  - Rockers plus the centre cluster.
  - A **key drawer** with tabs [Numbers | Colours | Media | More keys], always visible on desktop.
  - A 'Touchpad' toggle replaces the d-pad with a 360x360 surface.
  - The text panel docks at the bottom of this column (S7).
- **Status (cols 9-12):** S6 in a scrollable column.

### S3 Touch (phone)
- A full-bleed surface down to the tab bar, with a faint 24px dot grid and a hint line 'Swipe to move · Tap = OK · Two-finger tap = Back'.
- A **mode switch [Swipe | Pointer]**. Pointer appears only after `ms.remote.touchEnable`.
- A trail of light follows the finger (tint, fades over 300 ms).
- A **two-finger vertical drag adjusts volume** (±1 per 24px) and lights the halo mini-gauge in the corner.

### S4 Keys
- **Number pad:** 3x4 grid of 72x56 keys: 1-9, then [PRE-CH, 0, CH LIST].
- **Colour keys:** 4 pills of 72x28: red #E53935, green #43A047, yellow #FDD835, blue #1E88E5 (KEY_RED, KEY_GREEN, KEY_YELLOW, KEY_CYAN).
- **Media row:** ⏮ REW, ⏯, ⏭ FF, ■ STOP, ● REC.
- **More grid:** Info, Guide, Tools, Exit, Picture size, Caption, AD, Sleep, Ambient, Picture mode, Sound mode. Each 'unverified on this TV' key shows a small dashed corner mark until it has been seen to work once (record per key in settings).

### S5 Apps and Inputs
- A hero 'Now playing' (S2 card style).
- **Favourites row** (long-press any tile to pin, as in tedyno and Tele).
- **All apps** grid: 4 columns on phone, 6-8 on desktop. 72px tiles (r18) with the name below (Inter 500 12). A 6px live dot when running and a ring when visible.
- **Inputs:** a list of HDMI1-4 with user names ('PS5', 'Set-top box'), each with a Tracked badge, and a 'Source bar on TV' key.
- Desktop adds drag-reorder and right-click Hide.

### S6 Status (the 'Settings / TV info' view)
- **Sections:** Picture · Sound · Device · Network · Connection · Activity. Each header is a silkscreen 11px label plus a hairline.
- **Row (56px):** `[label Inter 14 --ink-2] [value Inter 500 20 tnum] [optional meter 96x4, r2] [badge] [age mono 12 --ink-3] [action chevron]`.

| Section | Rows and their sources |
|---|---|
| **Picture** | Picture mode (SmartThings). Backlight, Brightness, Contrast, Sharpness, Colour, Tint (G/R), Colour tone: **Unavailable**, value '—' in --ink-3. On tap a sheet explains 'Your TV doesn't share this over the network' and offers **Track it** (stepper for the value the TV shows; becomes Tracked), **Open on TV** (experimental menu jump), and 'On-TV app' if the companion exists. Aspect ratio and Captions (Live · UPnP). HDR / signal: Unavailable. |
| **Sound** | Volume (Live · UPnP, with meter). Mute (Live). Sound mode (SmartThings). Output: TV speaker / external (Unavailable, or 'Digital out: DOLBY' via the companion). Max-volume cap (local setting). |
| **Device** | Name, Model QA55Q95TAKXXL, Model code 20_NIKEM_QTV, Year 2020 and OS Tizen 5.5 (Live, derived), Resolution 3840x2160, Region, Developer mode, API 2.0.25, feature chips (Voice, GamePad, Touchpad, IME sync, 4-direction) from isSupport, Firmware (SmartThings or companion). Serial, DUID and MACs masked behind 'Reveal'. |
| **Network** | IP 192.168.1.2, link type if REST reports it, reachable services (REST 8001, remote 8002, UPnP 9197), shown only from health checks of endpoints already in use. |
| **Connection** | Phone↔PC RTT. PC↔TV REST RTT sparkline over 10 minutes. Remote channel: paired, token age. GENA: SID age, 'renews in 3:12', last event age. SmartThings: OAuth expiry, rate budget left (X-RateLimit-* headers). Companion heartbeat. |
| **Activity** | On since (Tracked), today's on-time, per-app minutes (Tracked), energy ≈ kWh (Estimated, user-set rated watts). |

### S7 Text entry (opens automatically)
- **Trigger:** `ms.remote.imeStart`. A sheet slides up (280 ms) with a glow on its top edge and an optional haptic of 15.
- **Mirror:** a 'TV field' strip in mono shows the imeUpdate text if provided; otherwise the local text.
- **Input:** a textarea with `autocapitalize=off autocomplete=off spellcheck=false enterkeyhint=done` and an eye toggle to hide.
- **Live send:** debounced 120 ms, sending the full string each time (replace semantics).
- **Buttons:** **Done** sends SendInputEnd; **Paste** uses a textarea paste, so it works without clipboard permissions.
- **Close:** on `imeEnd`, or with a 'Keep open' pin.
- **Desktop:** typing while the sheet is focused goes to the TV; Esc closes it.
- **Without imeStart:** a Keyboard key opens the same sheet manually.

### S8 Scenes and Macros
- **Scene cards:** title (Fraunces 20), the list of steps, and a big Run button.
- **Each step shows its transport chip:** LAN key, UPnP, REST, SmartThings, Companion, Wait.
  - Example **'Movie night'**: SmartThings picture mode Movie; UPnP volume 18; REST launch CineHD.
- **Editor:**
  - Steps: key (click, or hold N ms), wait N ms (default gap 300 ms, as openHAB's `KEY_MENU, 1000, KEY_DOWN` syntax), set volume, launch app, SmartThings command.
  - **Dry run** shows the timeline without sending.
  - **Guards:** 'only if app X is visible' and 'abort if power ≠ on'.
- **Menu-navigation macros** are badged **'Fragile: depends on TV menu layout'**, require confirmation, and any value they 'set' is recorded as **Tracked (unverified)**, never Live.

### S9 Connection states (full-screen or banner)
| State | Trigger | UI |
|---|---|---|
| Host lost | browser↔PC socket closed | Top banner 'Can't reach the remote host (PC)', retry countdown. The chain's first segment turns red. Controls disabled (40% opacity). |
| Connecting | PC↔TV REST pending | Chain dots pulse grey; the remote stays usable for UPnP-only actions. |
| Pairing needed | no token, first WS connect | Card: TV illustration with the dialog drawn at its real position, **'Look at your TV and choose Allow'**, 30 s ring countdown, 'Try again'. |
| Denied | ms.channel.unauthorized | 'Denied on the TV', 'Ask again' (warns it will pop up on the TV). |
| Connected | WS open + REST ok | Healthy connection pulse. |
| Degraded | RTT > 150 ms or WS reconnecting | Amber chain segment and amber pulse; optimistic UI still on, pending marks show. |
| Standby | REST PowerState=standby | Remote dims to 55%, the Power button is enlarged with 'Wake TV'; the volume halo shows its last value ghosted. |
| Waking | user pressed wake | Arc spinner on Power with elapsed time; the strategy is shown in small text ('Key over network' or 'Wake-on-LAN'). |
| Unreachable | REST timeout x3 | 'TV is off or off the network · last seen 22:41', with a 'Wake-on-LAN' button. |

### S10 Ambient idle (desktop or docked tablet; after 60 s without input, toggle in settings)
- The remote fades into a poster: a large Fraunces clock, the app name with a tint glow, a small volume halo and the connection pulse.
- Any key or tap wakes it in 160 ms. Disabled under reduced motion; then it is a static dim.

---
## 5. Interaction specs

### 5.1 Control map (UI → transport)
| Control | Primary | Fallback / notes |
|---|---|---|
| D-pad / OK | WS Click KEY_UP/DOWN/LEFT/RIGHT/ENTER | Long OK: Press KEY_ENTER, Release on lift (context menus) |
| Back | KEY_RETURN | Long press (≥ 1 s): Press/Release, held 3 s exits the app (openHAB note) |
| Home / TV Settings / Exit / Info / Guide / Tools / Source | KEY_HOME / KEY_MENU / KEY_EXIT / KEY_INFO / KEY_GUIDE / KEY_TOOLS / KEY_SOURCE | n/a |
| Volume ± / exact | UPnP SetVolume(abs) | KEY_VOLUP/KEY_VOLDOWN when output is external or UPnP fails |
| Mute | UPnP SetMute(!current) | KEY_MUTE |
| CH ± / list / previous | KEY_CHUP / KEY_CHDOWN / KEY_CH_LIST / KEY_PRECH | n/a |
| Digits / colours | KEY_0..KEY_9 / KEY_RED, KEY_GREEN, KEY_YELLOW, KEY_CYAN (blue) | Verify KEY_CYAN vs KEY_BLUE |
| Media | KEY_PLAY, KEY_PAUSE, KEY_STOP, KEY_REWIND, KEY_FF, KEY_REC | Play/Pause toggle is open (section 'open questions') |
| Extra | KEY_AMBIENT, KEY_PMODE, KEY_SOUND_MODE, KEY_PICTURE_SIZE, KEY_CAPTION, KEY_AD, KEY_SLEEP | All unverified on this TV |
| Text | SendInputString (base64, replace) / SendInputEnd | n/a |
| Pointer | ProcessMouseDevice Move {x,y,Time:"0"} / LeftClick / RightClick | Only after touchEnable |
| Apps | REST POST /api/v2/applications/<id>/ (launch) | WS ed.apps.launch |
| Inputs | KEY_HDMI1..4 / KEY_SOURCE | SmartThings setInputSource |
| Power | KEY_POWER (hold-to-confirm 500 ms when on) | WoL / SmartThings switch.on |

### 5.2 Gestures (touchpad)
| Gesture | Recognition | Action |
|---|---|---|
| Tap | lift < 250 ms and movement < 10 px | OK, fired immediately. Double-tap = Back is opt-in; only then is the tap delayed by 200 ms (avoids the SmartThings-style lag). |
| Swipe | movement ≥ 16 px with a dominant axis (\|dx\|−\|dy\| > 16) | One arrow |
| Continued drag | each further 56 px (phone), 40 px (desktop) | One more arrow, no fling momentum (overshoot risk) |
| Hold after swipe | finger still for ≥ 500 ms | Arrow repeat until lift (5.3 cadence) |
| Long-press | no movement for 500 ms | Long OK |
| Two-finger tap | n/a | Back |
| Two-finger vertical drag | n/a | Volume ±1 per 24 px |

CSS: `touch-action:none` on the d-pad and touchpad; `touch-action:manipulation` on buttons (no double-tap zoom); `user-select:none; -webkit-tap-highlight-color:transparent`. Buttons fire on **pointerdown** (as Tele does). Use `setPointerCapture`. Cancel on `pointercancel`, `lostpointercapture`, `blur` or `visibilitychange`.

### 5.3 Hold and auto-repeat (stuck-key safe)
- **Protocol:** the client sends `{t:"hold",id,key,phase:"start"}`, then `{phase:"keep"}` every 500 ms, then `{phase:"end"}`.
- **Server behaviour:** sends one Click immediately. If still held at 400 ms, it Clicks every 110 ms; after 1.6 s, every 70 ms.
- **Volume:** one step per 150 ms, two per tick after 1.2 s, always via absolute SetVolume and never past the cap.
- **Watchdog:** the server ends the hold if no 'keep' arrives for 1.5 s, after 8 s total, or when the client socket closes.
- **Native WS Press/Release** is used only for long-OK and long-Back. The server sends Release on any of the conditions above. TV-side repeat is very fast: 2 s of VOLUP gave +30 on a 2021 TV [src].

### 5.4 Desktop keyboard shortcuts (inactive while focus is in an input; toggle in settings; '?' shows an overlay)
| Key | Action | Key | Action |
|---|---|---|---|
| ← ↑ → ↓ | D-pad (hold = repeat; ignore `event.repeat`, use 5.3) | Enter | OK (hold = long OK) |
| Backspace | Back | Shift+Backspace / Esc×2 | Exit |
| H | Home | , (comma) | TV Settings |
| + or = / − | Volume ±1 (Shift = ±5) | M | Mute |
| 0-9 | Digits | Space | Play/Pause |
| PageUp / PageDown | CH ± | [ / ] | Rewind / FF |
| I | Info | G | Guide |
| S | Source | T or / | Text sheet |
| A | Apps | . (period) | Status |
| P (hold 500 ms) | Power | Alt+1..4 | Red/Green/Yellow/Blue |
| ? | Shortcut overlay | Esc | Close sheet / overlay |

Use `event.key` for characters and digits and `event.code` for arrows. Call `preventDefault` only for handled keys.

### 5.5 Optimistic UI with reconciliation (volume, mute, power, app, input)
```js
// one controller per stateful value
const c = { truth:null, shown:null, pending:null, holdOffUntil:0, touching:false };
function userSet(v){
  c.shown = v; c.pending = { v, id: send({t:'volume', set:v}), at: performance.now() };
  c.holdOffUntil = performance.now() + 1000;   // URC UPDATE_AFTER_ACTION_DELAY
  render({ value:v, state:'pending' });        // dashed halo end-cap, readout at 70% opacity
}
function onTruth(v, rec){                      // from GENA NOTIFY, poll, or ack read-back
  c.truth = v;
  if (c.touching || performance.now() < c.holdOffUntil) return;
  const external = !c.pending;
  if (c.pending && v === c.pending.v) { c.pending = null; render({ value:v, state:'confirmed' }); return; }
  c.pending = null; springTo(v);
  if (external) whisper('Changed on TV');      // 1.5 s caption under readout + aria-live
}
setInterval(() => { if (c.pending && performance.now() - c.pending.at > 1500) requestRead('sound.volume'); }, 500);
```
- Every client command carries an `id`. The server replies `{t:"ack",id,ok,ms}` once the TV write succeeds. On failure: shake the control (6px, 2 cycles, none under reduced motion), haptic [20,60,20], and a toast with the reason.
- Pressed state appears locally within 16 ms. Latency never gates feedback.

### 5.6 Browser ↔ PC messages (single WebSocket, same origin, JSON)
- **Server → client:**
  - `{t:"state",patch:{...}}`: RFC 7386 merge patch of the state tree; the first message is the full snapshot.
  - `{t:"event",name:"ime.start"|"ime.update"|"ime.end"|"touch.enable"|"pairing.prompt"|"external.volume",data}`
  - `{t:"ack",id,ok,err?,ms}`
  - `{t:"health",phonePcMs,pcTvMs,remoteWs,gena,st}`
- **Client → server:**
  - `{t:"key",id,key,mode:"click"}`
  - `{t:"hold",id,key,phase}`
  - `{t:"volume",id,set}` or `{t:"volume",id,step}`
  - `{t:"mute",id,set}`
  - `{t:"text",id,value,final}`
  - `{t:"pointer",dx,dy}` (throttled to 30 Hz) / `{t:"click",button}`
  - `{t:"launch",id,appId}`
  - `{t:"scene",id,name}`
  - `{t:"read",key}`

---
## 6. Provenance model
```json
{ "key":"sound.volume", "value":12, "range":[0,100],
  "source":"live|companion|cloud|tracked|estimated|unavailable",
  "transport":"upnp:GetVolume|gena:LastChange|rest:/api/v2/|ws:ms.remote.imeUpdate|st:audioVolume|companion:tvaudiocontrol|user|derived",
  "observedAt":"2026-10-21T19:40:12.345Z", "ttlMs":10000, "confidence":1.0, "note":null }
```
- **Ranking when sources disagree:** live > companion > cloud > tracked > estimated. Show the best fresh value. The tooltip lists the others, e.g. 'SmartThings says 0 · 3 min old (stale)'.
- **TTLs:**

| Source | TTL |
|---|---|
| Polled live | 10 s |
| GENA-backed | until the SID expires |
| REST device info | 60 s |
| SmartThings | 120 s |
| Companion | heartbeat × 3 |

- **Tracked confidence:** starts at 1.0 when set. It halves when an unexplained related change is detected (for example a picture-mode change in SmartThings, or a TV restart) and is reset by the user. Estimated is always ≤ 0.5.
- **Badge spec:** 20px tall, r10, 0 8px padding, Inter 600 11px uppercase +0.06em, 8px leading glyph. Colour is never the only cue; each badge has a distinct glyph.

| Badge | Glyph | Colour | Wording |
|---|---|---|---|
| LIVE | solid dot (600 ms ring pulse on update) | --live | 'Live · TV' |
| ON-TV APP | solid diamond | --violet | 'Live · on-TV app' |
| SMARTTHINGS | cloud | --quantum | 'SmartThings · 2 min' |
| TRACKED | half-filled circle | --ember | 'Tracked · set 14:02' |
| ESTIMATED | '≈' with dashed outline | --ink-3 | 'Estimated' |
| UNAVAILABLE | hollow circle with slash; value '—' | --ink-3 | 'Not exposed by TV' |

  **STALE** (past TTL) switches the badge to outline-only and turns the age text --warn.

---
## 7. Accessibility
- **D-pad:** `role=group aria-label="Navigation"`. Segments are `<button aria-label="Up">` and so on. OK is `aria-label="OK, select"`.
- **Volume:** `role=slider aria-valuemin=0 aria-valuemax=100 aria-valuenow=12 aria-valuetext="Volume 12, muted"`. Arrow keys ±1 and PageUp/PageDown ±5 when focused.
- **Live region:** one `aria-live="polite"` region for external changes ('Volume 14, changed on TV'), throttled to one message per 2 s.
- **Focus:** `:focus-visible` ring of 2px `--focus` with 2px offset (11:1 on keys). DOM focus order follows visual order. Sheets trap focus and Esc closes them.
- **Targets:** at least 44x44 px (exceeds WCAG 2.2 AA 2.5.8, which requires 24x24). Rockers use 64px widths.
- **Preferences:** honour `prefers-reduced-motion`, `prefers-contrast: more` (borders and stronger hairlines), and `forced-colors: active` (system colours, SVG `currentColor`, badges keep their glyphs). Layout in rem, usable at 200% zoom.
- **Shortcuts:** single-key shortcuts can be turned off (WCAG 2.1.4). The remote surface does not use `role=application`.

---
## 8. Delight details
1. **The halo breathes with the TV.** The volume arc springs to the real level when the physical remote changes it. The VOL rocker LEDs flicker once as an 'echo' of the press made elsewhere.
2. **App-tinted room light.** A radial glow behind the instrument (14% tint, 1.2 s crossfade) takes the foreground app's icon colour. CineHD gets a bespoke tint.
3. **Connection pulse.** The TV dot breathes on a 4 s cycle while healthy. Its cadence slows and turns amber as RTT grows. It goes flat and hollow when offline. Each chain segment is independently coloured.
4. **Power-on light line.** On wake, a 1px horizontal line expands across the mini-TV silhouette and blooms into the app tile (600 ms).
5. **Detents.** Dragging volume gives a 4 ms haptic and a pitch-mapped tick per step, so it feels like a stepped audio pot.
6. **Key light.** A pressed key emits an inner glow that travels outward like LED light through smoked glass (160 ms).
7. **Specular ring** (desktop): the brushed ring's highlight follows the pointer.
8. **Typing mirror.** Characters appear in a 'TV field' strip as they will on screen; the cursor blinks in the tint colour.
9. **Activity ribbon.** A 24-hour strip of tinted bars showing what the TV did today.
10. **Ambient idle poster** with a big Fraunces clock, inspired by Samsung Ambient Mode.
11. **'Your usual levels'.** The volume sheet learns the three most-used levels per time of day, Tracked locally.
12. **Honest dashes.** Unavailable values come with a one-line explanation and a 'Track it' stepper, never a fake number.

---
## 9. Front-end and hosting notes
- Static assets are served by the PC host: `index.html` (with the SVG sprite inline), one CSS file, one ES module bundle (vanilla Web Components or Preact compiled locally), `/assets/fonts/*.woff2` and `/assets/apps/*.png`. **No runtime CDN or icon proxies.**
- **Viewport:** `<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">`, `100dvh`, `env(safe-area-inset-*)`.
- **Secure-context gating:** Wake Lock, service workers (PWA) and the clipboard API are unavailable over `http://<PC-IP>`. Feature-detect and hide those settings. Offer optional HTTPS (self-signed or local CA) as an advanced setting.
- **LAN security:** the server binds to the LAN interface only. A new browser must be approved: it shows a 4-digit code that the desktop UI (localhost) approves, after which an HttpOnly cookie token is issued. 'Approve devices' lives in the top bar. This avoids tedyno's 'anyone on Wi-Fi controls the TV'.
- **Performance:** 'Lite mode' (auto-enabled when `navigator.hardwareConcurrency <= 4` or on a frame drop over 50 ms) disables backdrop-filter, grain and specular effects. Animate only transform and opacity, plus an SVG `stroke-dashoffset` for the halo.

## Risks

- Design-critical LAN features are unverified on this 2020 Tizen 5.5 TV. That covers GENA change events from the physical remote, IME events, WebSocket key behaviour and SetVolume. Evidence comes only from 2021-2025 TVs and source code. Each needs a graceful fallback: polling, a manual keyboard button, and KEY_VOLUP/KEY_VOLDOWN.
- Runaway or stuck keys. WebSocket Press/Release makes the TV auto-repeat (2 s = +30 volume on a 2021 TV). If a browser drops mid-hold, volume or navigation can run away. Use server-side repeat cadence, heartbeat-based release, an 8 s watchdog, and absolute SetVolume with a user cap.
- Users may assume picture settings are readable. Backlight, brightness and contrast are not exposed locally, and SmartThings execute reads returned null on a 2025 TV. Showing Tracked or Estimated values too prominently could mislead, so badges must be unmistakable.
- Menu-navigation macros can change the wrong setting if the TV is in an unexpected state (an app open, a different menu tree after a firmware update). Keep them opt-in, guarded, confirmed and labelled Fragile.
- SmartThings: personal access tokens created after 2024-12-30 expire in 24 h; OAuth setup is complex; the rate limit is 12 requests/min per device; cloud values can be stale (audioVolume 0 while the TV was at 3); SSE push returned 403. Cloud data must stay secondary and timestamped.
- Secure context: phones reach the PC over plain http on the LAN, which disables Wake Lock, PWA install, service workers and the clipboard API. HTTPS with a self-signed certificate may not restore all of these.
- Haptics: navigator.vibrate is absent on iOS Safari, so the design must not depend on it.
- Security: an unauthenticated LAN web server would let anyone on the Wi-Fi control the TV. A device-approval flow is required.
- Pairing: the first WebSocket connection pops an Allow dialog on the TV while someone may be watching. Schedule pairing with the user, and keep one shared PC-side connection so it happens once.
- Volume with external audio: with an ARC soundbar or Bluetooth output, UPnP volume may not reflect the real level (Clicky). The UI must detect or offer 'external output' mode and switch to stateless +/-.
- App catalogue: if ed.installedApp.get is ignored, the app list relies on probing known IDs, which misses unknown apps. Probing many IDs must stay gentle (at most 1 request per 200 ms) and be cached.
- Performance: backdrop-filter, conic gradients and grain may drop frames on low-end Android phones. Lite mode is required.
- Trademarks: bundled third-party app icons are fine for personal use but should not be redistributed. Use monogram fallbacks.
- Privacy: the Status view can surface MAC, DUID and serial number. Mask them by default so screenshots don't leak identifiers.

## Open questions

- Does this Q95T send GENA LastChange NOTIFY events for volume and mute changes made with the physical remote, and how quickly? Or only the first NOTIFY after SUBSCRIBE?
- Does ms.remote.imeStart fire on Tizen 5.5 for the system keyboard and inside apps (YouTube, Netflix, CineHD)? Does imeUpdate carry the field's current text in base64?
- Does ed.installedApp.get (and ed.apps.icon) answer on this 2020 TV? openHAB says those eden calls break only on TVs newer than 2020.
- Which keys work on this TV: KEY_HDMI1..4, KEY_AMBIENT, KEY_PMODE, KEY_SOUND_MODE, KEY_PICTURE_SIZE, KEY_CYAN vs KEY_BLUE? Does KEY_PLAY or KEY_PAUSE toggle in common apps, or must Play/Pause alternate based on tracked state?
- Does REST PowerState report 'standby' on this TV? How long does network standby last, and does 'Power On with Mobile' make Wake-on-LAN work?
- Is the TV registered in the user's SmartThings account, and will the user set up an OAuth app? Do custom.picturemode, custom.soundmode and mediaInputSource report current values reliably on this 2020 model?
- When audio goes to an ARC soundbar or Bluetooth, what does UPnP GetVolume return, and can the PC detect that state?
- Can a signed companion Tizen app on 5.5 still use tizen.tvaudiocontrol (privilege tv.audio is deprecated at public level since 5.0)? Is there any partner-level API to read picture settings (backlight and so on), or the foreground app?
- What exact value ranges does this Q95T show for Backlight, Brightness, Contrast, Sharpness, Colour and Tint? Needed so 'Track it' steppers match the TV menu; the user should confirm.
- How long does the TV's Allow prompt stay on screen before it times out, and does a timeout count as Deny?
- Will the user accept a self-signed or local-CA HTTPS setup on their phone, so Wake Lock, PWA install and clipboard work over the LAN?
- Should CineHD's MediaService expose now-playing (title, poster, progress) to the PC host for the rich now-playing card?
