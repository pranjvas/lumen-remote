## Lumen Remote — recommended architecture

### 1. Topology
```
Browsers (PC Edge PWA on http://127.0.0.1:8790; phones opt-in via http://<pc-lan>:8790 + PIN)
   │  same-origin static UI + POST /api/* (X-TVR-CSRF) + WS /ws (state patches, commands)
   ▼
Lumen host (Node 22, single process under a supervisor)
   web/ (http, live WS, auth) -> core/ (provenance store, reconciler, command router, scheduler) -> adapters/
   adapters: rest · remote-ws · upnp-soap · gena(LAN listener :8791) · dial · ipcontrol(1516) · wol
             · agent-bridge(companion ingress) · smartthings(optional) · macros · youtube-lounge(opt)
   │8001 REST  │8002 wss  │9197 SOAP  │9197 GENA<-NOTIFY in  │1516 HTTPS JSON-RPC  │UDP 9/7 WoL
   ▼
Samsung QA55Q95T (192.168.1.2)
   └ Lumen Agent (lumenrmt01): service dials OUT to PC :8790/agent/v1 (token); UI snapshot on demand;
     optional avocd D-Bus reader on the system bus; optional MobileBFF MSF client
Optional cloud: api.smartthings.com (OAuth), youtube.com lounge (opt-in)
```
All TV traffic goes through the PC: one token, one TV socket, CORS handled once, rate control in one place.

### 2. Module breakdown (matches package.json -> node server/index.js)
- `server/index.js` entry: single-instance port lock + /api/health, forks app.js under the supervisor (exit 0 stop / 75 restart / else backoff 1->60 s).
- `server/app.js` wires config, store, adapters, web.
- `server/config.js` data/ (gitignored) or %LOCALAPPDATA%/LumenRemote; atomic tmp+rename with EPERM retry; DPAPI helper for cloud/IP tokens.
- `server/log.js` rotating logs (1 MB × 5, end->rename->reopen) + redaction filter (token, MAC, SSID, DUID, serial, screenId, SID).
- `core/store.js` state tree; every leaf is a provenance record; RFC 7386 merge patches to clients.
- `core/reconcile.js` source ranking, TTL/staleness, pending/confirmed optimistic UI, 'Changed on TV' detection.
- `core/router.js` command -> adapter selection with fallbacks; per-command readback verification.
- `core/scheduler.js` single-flight queues: rest (1 in flight), ipcontrol (1 connection), upnp (<=1 req/200 ms), smartthings (12/min), macros (exclusive lock over remote-ws).
- `core/safety.js` key allowlist, hold watchdog, power cooldown, volume cap, write confirmations, calibration snapshot.
- adapters as above; `adapters/keymap.js` KEY_* catalogue with tags and per-key hold policy.
- `web/http.js` 127.0.0.1 bind, Host allowlist (421), Origin check (403), CSRF header, static in-memory map, CSP.
- `web/live.js` /ws upgrade (Host+Origin+cookie), fan-out, command intake with ids/acks.
- `web/auth.js` LAN PIN/QR pairing, session cookies (hash stored, revocable), rate limiting.
- `public/` index.html (inline SVG sprite, CSRF meta), app.js (ES modules/Web Components), styles.css (Halo tokens), manifest.webmanifest, sw.js, fonts/, icons/, apps/.
- `companion/` Lumen Agent (lumenrmt01): config.xml, UI (snapshot + arm service), service/index.js (ES5, Node 4.4.3), optional dbus-avoc.js reader.
- `test/` mock-tv/ (REST, wss, SOAP, GENA, IP Control, avocd, SmartThings, agent), fixtures/ (redacted live payloads), *.test.js (node --test), cdp-shot.mjs.

### 3. Data flow
Reads: adapters poll or receive events -> write a provenance record -> store emits a merge patch -> live.js fans out to visible tabs. Polling cadence follows demand (fast when a tab is visible, slow when hidden, stopped with no clients; the Settings view raises IP Control expert polling only while open). Commands: browser -> /ws {t,id,…} -> router picks transport + safety check -> adapter executes -> ack {ok,ms} -> readback (GetVolume, REST visible, IP Control GET) moves pending->confirmed; on disagreement the UI springs to the TV's value. External changes (a GENA NOTIFY or poll diff with nothing pending) show a 'Changed on TV' whisper and announce it via aria-live. Companion: PC launches the agent via REST POST only when the user enables it; the UI starts the service and exits; the service dials out hello/state(5 s)/events; UI snapshots (channel, output codec, captions, resolution) are user-triggered because they flash the screen; the optional avocd reader pushes picture values + change signals.

### 4. State model with provenance
```json
{ "key":"picture.backlight", "value":32, "range":[0,50],
  "source":"live|polled|companion|smartthings|tracked|estimated|unavailable",
  "transport":"upnp:GetVolume|gena:LastChange|rest:/api/v2/|ws:imeUpdate|ipc:backlightControl|dbus:GetBacklight|st:custom.picturemode|agent:systeminfo|user|macro|derived",
  "scope":{"input":"HDMI1","pictureMode":"Movie","dynamicRange":"SDR"},
  "observedAt":"2026-10-21T19:40:12.345Z", "ttlMs":10000, "confidence":1.0, "pending":null, "note":null }
```
Ranking: live/polled (LAN) ≈ dbus > companion > smartthings > tracked > estimated. Scoped picture values invalidate on pictureMode/input change. TTLs: polled LAN 2-3× the interval; GENA until SID expiry + 30 s safety; REST device info 60 s; IP Control 10 s (Settings open); SmartThings 120 s; companion 3× heartbeat. Tracked confidence starts 1.0, halves on a related unexplained change, reset by 'Calibrate: what does your TV show?'; estimated never above 0.5.

### 5. Scheduling and load budget
REST one in flight (device info 3-5 s visible / 30 s idle; app probes last-visible + favourites ~10 s; 3 s connect / 8 s response, 10-15 s app status). UPnP <=1 req/200 ms; volume/mute polls only when GENA is not live. IP Control one connection; getTVStates 2-3 s visible; expert getters only while Settings is open; user commands jump the queue. avocd D-Bus: one call at a time over a persistent system-bus connection; rely on change signals, not polling. SmartThings 12/min; full status 60-120 s + on demand; refresh <=1/60 s and only while the TV is on locally. WS keys >=200 ms taps, 300-500 ms macros; a macro takes an exclusive lock, pauses UI keys, shows progress + abort.

### 6. Command safety
Key allowlist blocks danger keys server-side. Holds run the server repeat cadence; native Press/Release only for deliberate long-presses; Release on disconnect, missed 1.5 s heartbeat, 8 s total, and after reconnect. Power: KEY_POWER Click only after a fresh 'on', 5-20 s cooldown, never a hold, never IP reboot. Volume: absolute SetVolume, user cap (default 50), confirmation for jumps >20. Picture writes: snapshot all readable values before batch changes; WB/gamma/colour space read-only unless confirmed; read back each write; -32002 shows a 'locked in this mode' badge. Pairing (WS, IP Control, avocd) and companion launches are explicit user actions with an on-screen-dialog warning, never automatic, never looped.

### 7. Security model
Default exposure loopback only (no firewall prompt). LAN mode (opt-in): PIN-paired session cookie (HttpOnly, SameSite=Strict, hash stored, revocable), PIN rate limits, a device list. Request checks: Host allowlist (DNS rebinding), Origin check, CSRF header on POST, Host+Origin+cookie on the WS upgrade; no CORS headers; CSP default-src 'self'; static from an in-memory map. Inbound GENA: a separate LAN listener accepting NOTIFY only, only from 192.168.1.2, only on a random secret path. Companion ingress: a shared token from the launch payload; the agent is read-only and dials out; the PC answers CORS Origin:null. Secrets (TV token, IP Control token, SmartThings OAuth, YouTube screenId) stay server-side, optional DPAPI, redacted in logs. Identifiers masked in the UI behind 'Reveal'. TLS to the TV: verification disabled per connection only, with fingerprint pinning (TOFU) before any token is sent and a re-trust screen on change.

### 8. Companion (Lumen Agent) design
Reuse the installed lumenrmt01 package (UI + LumenService). Service (Node 4.4.3, ES5): arm on onRequest, parse pc=http://<ip>:8790|<token>, reply 'armed' only after listeners are ready; push hello (census), state every 5 s, events from addAppStatusChangeListener/systeminfo listeners (VIDEOSOURCE, SOURCE_INFO, CPU)/hybridchannelinfo if present; guard Node 4's timer bug (setTimeout(Infinity) fires at ~1 ms); onExit sends a best-effort bye. Optional avocd reader: a pure-JS D-Bus client over /var/run/dbus/system_bus_socket (EXTERNAL auth) calling GetBacklight(1) etc. and AddMatch for the change signals. UI: a snapshot on user request (tvchannel/hybridchannelinfo, tvaudiocontrol.getOutputMode, tvinfo caption, tvwindow.getSource) then exit(). Re-arm: PC marks offline after 15 s without state, offers re-arm only when PowerState is on (flashes the UI); experiments use.preview=bg_service and tizen.alarm. Install/update only with the user's go-ahead (shares sdb with CineHD).

### 9. SmartThings (optional module)
OAuth-In app, single-use refresh token refreshed atomically and serially. Used for friendly input names, cloud power-on fallback, picture/sound mode fallback, tvChannelName. Disabled cleanly on 402. 'SmartThings · age' badges.

### 10. Test strategy (mock TV)
Unit/contract parsers (SOAP, LastChange incl. empty clears, REST, IME base64/UTF-8, IP Control errors, avocd D-Bus messages) against redacted live fixtures. Mock TV from the 13/13 PoC, extended with Allow-delay/unauthorized/timeOut, standby (9197 closed, `""`/`standby`), SEQ gaps, no-pong, cert rotation, serialized slow app status, a 1516 mock (GET/SET, -32601/-32002/-32011, one connection, weak-DH TLS), an avocd mock, a SmartThings mock (402/409/429, COMPLETED-but-not-applied), agent ingress. End-to-end browser↔host↔mock via node --test; headless Edge over CDP for screenshots.

### 11. Phased build order (local-only remote first)
- Phase 0 — foundations (no TV changes): repo layout + config; move the mock TV into test/; store/provenance/reconciler; web security; Halo UI shell with the provenance-badge system; redaction-aware logging; supervisor; Startup-folder launcher. Exit: e2e passes against the mock; screenshots render.
- Phase 1 — fully working local remote (paired WS token + REST + UPnP only): remote-ws keys/holds/IME/pointer/client events; REST power state machine + device Info view + app tiles (curated table) with launch and foreground detection; UPnP volume/mute read with GENA push (already verified) and poll fallback; SetVolume slider after one supervised write test; mute via GetMute + KEY_MUTE; power off with cooldown; WoL power on (after the user enables Power On with Mobile); channel/number/colour/media keys; Status view with LAN-sourced rows, everything else UNAVAILABLE/TRACKED. Exit: every physical-remote function reachable from the browser; the volume ring shows the real level; nothing needs the cloud.
- Phase 2 — real picture settings: ipcontrol adapter (TLS, single queue, error-latch rules) + the Settings view (picture mode, Brightness/backlight, Contrast, Shadow Detail, Sharpness, Color, Tint, Color Tone, advanced picture, sound mode, sound output, input read/switch) with readback/snapshot/confirm; in parallel, the supervised avocd D-Bus probe — if it works, promote picture reads to LIVE with push via the companion. Exit: Settings shows LIVE values matching the TV menu.
- Phase 3 — on-TV companion (read-only): app inventory, app-status events, VIDEOSOURCE/SOURCE_INFO, system health, hybridchannelinfo; UI snapshots for channel/programme, audio format, captions; lifetime measurement + re-arm; optional MobileBFF probe. Exit: the app grid comes from the real inventory (incl. the India apps); connected-input dots; a now-on-TV channel card.
- Phase 4 — remaining 'unavailable' options: macro engine with a per-condition route table recorded with the user (Eco Solution, Intelligent Mode, Game Mode, sound expert, Fit to Screen); TRACKED records with calibration prompts; app-owned sleep timer; anchored input-switch macro fallback.
- Phase 5 — optional cloud/enrichment: SmartThings (friendly HDMI names, cloud power-on, mode fallback); YouTube Lounge now-playing; CineHD now-playing feed; DLNA cast URL; activity/energy ribbon.
- Phase 6 — reach/polish: LAN phone mode with PIN pairing; optional HTTPS with a local CA for phone PWA/Wake Lock; ambient idle poster; accessibility audit; Lite mode for low-end phones.