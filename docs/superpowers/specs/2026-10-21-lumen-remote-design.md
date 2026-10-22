# Lumen Remote — design (2026-10-21)

A remote control and live dashboard for the user's Samsung QA55Q95T (2020, Tizen 5.5, 192.168.1.2), hosted by a Node 22 process on their Windows PC and used from a browser at `http://127.0.0.1:8790`.

## 1. Intent

The user asked for a Samsung TV remote recreated in the browser with an **artistic and informational** UX: the main remote's volume control shows the TV's real current level and adjusts it; a Settings view displays the TV's current configuration (brightness/backlight levels and the rest); and options the TV does not expose must still be supported where possible.

Success = every physical-remote function works from the browser; every displayed value is real (read from the TV) or honestly labelled with where it came from; and the look is premium and calm rather than a grid of grey buttons.

Anti-goals: a generic button grid; numbers that look live but are guesses; anything that silently changes the TV (pairing, writes, launches) without the user's action; exposing an unauthenticated control surface on the LAN; leaking identifiers (MACs, SSID, DUID, serial, tokens) into the UI or logs.

## 2. What the TV gives us (verified live today unless noted)

See `docs/research/2026-10-21-live-findings.md` and the area reports in `docs/research/`.

| Channel | Use | Notes |
|---|---|---|
| REST `http://TV:8001/api/v2/` | device info, `PowerState` (`on`/`standby`/missing), wifiMac (server-side only, for WoL) | ~1.3 s per call; serialize |
| REST `GET /api/v2/applications/<id>/` (trailing slash!) | `{id,name,running,version,visible}`; `visible` = foreground | serialize; 404 for unknown ids |
| REST `POST /api/v2/applications/<id>/` body `{}` | launch app | research says returns `true`; verify live |
| WSS `wss://TV:8002/api/v2/channels/samsung.remote.control?name=<b64 "Lumen Remote">&token=<t>` | keys, text, pointer; TV events `ms.remote.touchEnable/Disable`, `ms.remote.imeStart/imeUpdate/imeDone/imeEnd` | **paired**, token in `data/tv.json`; self-signed TLS (`rejectUnauthorized:false`) |
| UPnP SOAP `http://TV:9197/upnp/control/RenderingControl1` | GetVolume/SetVolume/GetMute/SetMute (InstanceID 0, Channel Master) | **SetVolume unmutes the TV** |
| UPnP GENA `SUBSCRIBE http://TV:9197/upnp/event/RenderingControl1` | push of volume/mute changes (LastChange) | NOTIFY method, TIMEOUT Second-1800, renew before expiry; ignore empty LastChange; 412 → re-subscribe |
| IP Control `https://TV:1516/` JSON-RPC 2.0 | real picture/sound values + writes, input, volume, mute, power | **paired**, token in `data/ipcontrol.json`; `ciphers:'DEFAULT@SECLEVEL=0'`, `rejectUnauthorized:false`; ONE connection at a time; params with only `AccessToken` = GET, any extra key = SET |
| Wake-on-LAN | power on from standby | needs TV setting "Power On with Mobile"; magic packet to wifiMac |
| On-TV agent `lumenrmt01.LumenAgent` (our signed Tizen app) | current channel, input source, connected HDMI inputs, installed apps (406) + icons, running apps, audio output codec, caption state, firmware build, CPU/memory/storage, live volume listener | page context only (service context has no TV APIs); keeps running when hidden; lifetime not guaranteed |

### IP Control method map (all verified as GET on this TV)

| State key | Method (GET → result field) | SET params | Range / values |
|---|---|---|---|
| `picture.mode` | `pictureModeControl` → `pictureMode` | `{pictureMode}` | Dynamic, Standard, Natural, Movie (Filmmaker Mode only with FMM content) |
| `picture.size` | `pictureSizeControl` → `pictureSize` | `{pictureSize}` | 16:9, 4:3 |
| `picture.backlight` (menu "Brightness") | `backlightControl` → `backlight` | `{backlight}` | 0–50 |
| `picture.contrast` | `contrastControl` → `contrast` | `{contrast}` | 0–50 |
| `picture.shadowDetail` (IPC "brightness") | `brightnessControl` → `brightness` | `{brightness}` | −5..5 |
| `picture.sharpness` | `sharpnessControl` → `sharpness` | `{sharpness}` | 0–20 |
| `picture.color` | `colorControl` → `color` | `{color}` | 0–50 |
| `picture.tint` | `tintControl` → `tint` | `{tint}` | −50..50 (UI shows G/R; clamp on read-back) |
| `picture.colorTone` | `colorToneControl` → `colorTone` | `{colorTone}` | Cool, Standard, Warm1, Warm2 |
| `picture.localDimming` | `localDimmingControl` → `localDimming` | `{localDimming}` | Low, Standard, High |
| `picture.contrastEnhancer` | `contrastEnhancerControl` → `contrastEnhancer` | `{contrastEnhancer}` | Off, Low, High |
| `picture.clarity` | `autoMotionPlusControl` → `autoMotionPlus` | `{autoMotionPlus}` | Off, Auto, Custom |
| `picture.blurReduction` | `AMP.blurReductionControl` → `AMP.blurReduction` | same key | 0–10 (Custom only) |
| `picture.judderReduction` | `AMP.judderReductionControl` → `AMP.judderReduction` | same key | 0–10 (Custom only) |
| `picture.ledClearMotion` | `AMP.LEDClearMotionControl` → `AMP.LEDClearMotion` | same key | Off, On |
| `picture.noiseReduction` | `digitalCleanViewControl` → `digitalCleanView` | `{digitalCleanView}` | Off, Auto |
| `picture.filmMode` | `filmModeControl` → `filmMode` | `{filmMode}` | Off, Auto |
| `picture.gammaMode` | `gammaModeControl` → `gammaMode` | read-only in UI | BT.1886, ST.2084, HLG, 2.20 |
| `picture.gamma` | `gamma.BT1886Control` → `gamma.BT1886` | read-only in UI | −3..3 |
| `picture.colorSpace` | `colorSpaceControl` → `colorSpace` | read-only in UI | Auto, Native, Custom |
| `picture.whiteBalance` | `WB2PointControl` → `{R-Gain,G-Gain,B-Gain,R-Offset,G-Offset,B-Offset}` | read-only in UI | −50..50 |
| `audio.soundMode` | `soundModeControl` → `soundMode` | `{soundMode}` | Standard, Optimized, Amplify |
| `audio.speaker` | `speakerSelectControl` → `speakerSelect` | `{speakerSelect}` | Internal, AudioOut/Optical |
| `input.source` | `inputSourceControl` → `inputSource` | `{inputSource}` | TV, HDMI1–HDMI4, AV1 |
| `audio.volume` | `directVolumeControl` → `volume` | `{volume}` | 0–100 |
| `audio.mute` | `muteControl` → `mute` | `{mute}` | muteOn / muteOff |
| (bulk) | `getTVStates` → `{inputSource,mute,pictureMode,pictureSize,soundMode,speakerSelect,volume}` | — | one call for the 2–3 s poll |
| (bulk) | `getVideoStates` → `{brightness,color,contrast,sharpness,tint}` | — | |
| power | `powerControl` | `{power:'powerOff'}` / `{power:'powerOn'}` | **never `reboot`; never send powerControl without a param (unknown GET semantics)** |

Not on this firmware (`-32601`): gameModeControl, brightnessOptimizationControl, energySavingSolutionControl, motionLightingControl, autoPowerSavingControl, autoPowerOffControl, HDRToneMappingControl, peakBrightnessControl, colorBoosterControl, applyPictureSettingsControl, getDeviceInformation.

Error rules: `-32601` never latch permanently (re-probe after mode/power change); `-32002` = refused in this mode (e.g. Dynamic) → show "locked in this mode"; `-32010` or `-32700` with a token → token invalid → `conn.ipc = 'unpaired'`; `-32011` all token slots occupied. Errors arrive nested (`{error:{code,message}}`) or flat (`{code,message}`).

## 3. Decisions (my calls; the user delegated the how)

1. **Runtime**: one Node 22 process, ES modules, the only dependency is `ws`. No build step for the front end.
2. **Exposure**: the UI/HTTP server binds `127.0.0.1:8790` only. A second **TV-facing listener** binds the PC's LAN address (taken from `socket.localAddress` of a TCP connection to the TV — never by enumerating adapters) on port 8791 and accepts only (a) GENA `NOTIFY` on `/gena/<secret>` and (b) the agent WebSocket on `/agent` with `?key=<agentKey>`, and only from the TV's IP. Anything else gets the socket destroyed. If this listener cannot bind or no NOTIFY arrives within 8 s of a SUBSCRIBE, volume/mute fall back to polling (1 s while a browser tab is visible, 10 s otherwise).
3. **Browser security**: WebSocket upgrade requires `Host` ∈ {`127.0.0.1:8790`, `localhost:8790`} and `Origin` ∈ {`http://127.0.0.1:8790`, `http://localhost:8790`}. No CORS headers. HTTP serves static files from an in-memory map built at start (no path traversal), `GET /api/health` only. CSP `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'`. No state-changing HTTP endpoints — commands go over the WebSocket.
4. **Secrets**: `data/` is gitignored. `data/tv.json` `{host, clientName, token}`, `data/ipcontrol.json` `{token}`, `data/config.json` (settings), `data/secrets.json` `{genaSecret, agentKey}` (generated on first run), `data/state-cache.json` (last-known values for instant first paint, marked stale), `data/scenes.json`, `data/tracked.json`. Tokens, MACs, SSID, DUID, serial never go to the browser or logs (logger redacts `token`, `AccessToken`, MAC-like and UUID-like strings).
5. **One owner per TV channel**: one WSS socket, one IP Control queue (single in-flight request, user commands jump ahead of polls), one REST queue, UPnP ≤ 1 request / 200 ms.
6. **Provenance on every value** (see §5). The UI shows a small badge per value: `LIVE` (pushed or polled from the TV, fresh), `TV AGENT`, `TRACKED` (known only because Lumen set it, or the user told us), `STALE` (last known, older than its TTL), `UNAVAILABLE`.
7. **Writes**: only from explicit user actions. Every write is followed by a read-back; the UI shows the read-back value, not the requested one. Picture values are scoped to the current input × picture mode: when `picture.mode` or `input.source` changes, all picture leaves are marked stale and re-read.
8. **Unavailable options** are supported three ways, in order of preference:
   - *Exact app-owned features*: sleep timer (server-owned countdown, persisted, ends with IP Control `powerControl {power:'powerOff'}`, falls back to KEY_POWER), **Scenes** (named bundles of verified IP Control writes + optional keys, e.g. "Night": backlight 4, volume 8, sound mode Standard), absolute volume (set exact level), exact picture values the physical remote can only nudge.
   - *TV agent reads*: channel, input, connected HDMI, apps with icons, caption state, firmware, system health.
   - *Tracked settings* for things with no API on this firmware (Game Mode, Eco Solution / Ambient Light Detection / Power Saving, Intelligent Mode / Adaptive Picture, Auto Power Off, HDR Tone Mapping, sound Balance/EQ/Auto Volume, HDMI input names): the user tells Lumen the value once ("Calibrate"), Lumen shows it as `TRACKED · set 21 Oct 19:40`, and offers "Open TV menu" (KEY_MENU) so the user can change it on the TV and then confirm. Plus **user-recorded key macros** (record a key sequence with timing, replay it) for anything else.
9. **Agent transport**: the agent page connects *out* to the PC's TV-facing listener (`ws://<pcLanIp>:8791/agent?key=<agentKey>`); PC host and key are baked into `agent-config.json` at build time by `tools/agent/build.ps1`. No debug mode, no sdb at runtime (sdb is shared with the CineHD pipelines and its DevTools port is LAN-exposed). The server launches the agent only on explicit user action ("Connect TV agent") via REST POST launch, because launching flashes the agent on screen for ~0.5 s before it hides itself.
10. **Power**: off = one KEY_POWER click when REST says `on` (cooldown 15 s, never a hold); on = WoL (to directed broadcast, 255.255.255.255 and unicast, ports 9 and 7, socket bound to the LAN address) + KEY_POWER if the socket is still up + IP Control `powerOn` if reachable; poll REST every 1.5 s for 30 s.
11. **Naming**: the app is "Lumen"; the TV menu key is labelled **TV Menu**; the web app's information/configuration view is **Settings** (sections Picture, Sound, Input & Source, Device, Connection) — the user's own word.
12. **Design language**: HALO from `docs/research/area-prior-art-ux.md` §2 (Nocturne dark default, Gallery light; one warm accent tinted by the foreground app; the luminous volume ring around the d-pad; self-hosted OFL fonts or a refined system stack; inline SVG icons; calm motion; reduced-motion respected).

## 4. Module layout and ownership

```
package.json            (type: module; deps: ws; scripts: start, test)
server/
  index.js              entry: config → store → adapters → http/lan; SIGINT/SIGTERM graceful stop; port 8790 bind = single-instance lock
  config.js             data dir, JSON load/save (atomic tmp+rename, retry on EPERM), defaults, secret generation
  log.js                leveled logger to console + data/logs/lumen.log (1 MB × 3 rotation), redaction
  store.js              provenance store + merge-patch emitter + state-cache persistence
  hub.js                command router: validates browser commands, applies safety, calls adapters, sends acks
  safety.js             key allowlist, power cooldown, volume cap (config, default 60), rate limits
  http.js               static in-memory server + /api/health + browser WebSocket /live
  lan.js                TV-facing listener: route(path, handler) for GENA + agent WS upgrade; IP allowlist
  features/sleep.js     sleep timer
  features/scenes.js    scenes (IP Control bundles + keys)
  features/tracked.js   tracked settings ledger + calibration
  features/macros.js    recorded key macros (record/replay)
  adapters/rest.js      device info, power state machine, app status, app launch
  adapters/remote.js    WSS remote channel
  adapters/upnp.js      RenderingControl SOAP + GENA subscription lifecycle + poll fallback
  adapters/ipcontrol.js IP Control queue, getters/setters, polling cadence, error rules
  adapters/agent.js     agent ingress (WebSocket via lan.js), state mapping, requests, launch
  adapters/wol.js       magic packets
  catalog/keys.js       KEY_* catalogue (groups, labels, repeatable flag, allowlist)
  catalog/settings.js   settings catalogue (the IP Control map above + tracked-only settings), ranges, labels, UI grouping
  catalog/apps.js       curated app table (id, name, brand colour, short label) for the installed apps listed in the research report §13–15
web/                    static front end (index.html, css/, js/ ES modules, icons/, fonts/, manifest.webmanifest, sw.js)
companion/agent/        Lumen Agent v0.2 Tizen web app (config.xml, index.html, agent.js, icon.png)
tools/agent/            build.ps1 (writes agent-config.json, build-web, sign with profile Q95T), install.sh (WSL sdb push + vd_appinstall)
tools/                  pair.mjs (exists), screenshot.mjs (headless Edge via CDP), start-hidden.js + install-autostart.ps1 (Startup-folder launcher)
test/mock-tv.js         mock TV: REST 8001, WSS 8002 (self-signed), SOAP+GENA 9197, IP Control 1516 (TLS), agent client simulator
test/*.test.js          node --test suites
```

## 5. Contracts

### 5.1 Store (`server/store.js`)

```js
import { createStore } from './store.js';
const store = createStore({ cachePath });     // loads state-cache.json, marks all leaves stale
store.set('audio.volume', 12, { src: 'live', via: 'gena', ttlMs: 60000 });   // returns true if changed
store.set('picture.backlight', 10, { src: 'live', via: 'ipc:backlightControl', range: [0, 50], scope: { input: 'TV', mode: 'Standard' } });
store.mark('picture.*', { stale: true });     // glob on prefix
store.get('audio.volume')                     // → record or undefined
store.snapshot()                              // → nested plain object of records
store.on('patch', (patch) => {})              // batched every 50 ms: { 'audio.volume': record, ... } (flat dotted keys → record or null for deletion)
```

Record shape (what the browser receives):

```json
{ "v": 12, "src": "live|agent|tracked|cache|derived", "via": "gena", "at": 1792589137065, "ttlMs": 60000, "stale": false,
  "range": [0, 100], "options": null, "scope": null, "pending": null, "note": null }
```

`src` values: `live` (from a TV protocol), `agent` (from the on-TV agent), `tracked` (set by Lumen or the user, not readable), `cache` (restored at start, always `stale: true` until confirmed), `derived` (computed). The browser computes the badge: stale or `Date.now() - at > ttlMs` → STALE.

### 5.2 State keys

```
conn.tv           'on' | 'standby' | 'off' | 'unknown'         (REST power state machine)
conn.remote       'paired' | 'connecting' | 'unpaired' | 'down'
conn.upnp         'ok' | 'down'
conn.events       'push' | 'polling' | 'off'                   (GENA live vs fallback)
conn.ipc          'paired' | 'unpaired' | 'down'
conn.agent        'online' | 'offline' | 'launching' | 'unknown'
conn.latency      { rest, upnp, ipc } ms (derived)
power.state       same as conn.tv (UI convenience)
device.*          name, modelName, model, os, platform ('Tizen 5.5'), firmware (agent build string), resolution, panel, year ('2020'), language, country, networkType, developerMode, frameTV
audio.volume      0–100     audio.mute  boolean     audio.soundMode   audio.speaker   audio.outputCodec (agent)
picture.*         see §2 map
input.source      'TV' | 'HDMI1'… (ipc or agent)   input.connected [ 'TV1','HDMI1' ] (agent)   input.available [...]
app.foreground    { id, name } | null              app.installed [ {id,name,color,icon?} ] (agent or curated)
channel.current   { name, number, type } | null (agent)
system.*          cpuLoad, memAvailable, memTotal, storageFree, storageTotal (agent)
ime               { open, type, text, limit } (remote events; text never logged)
touch.enabled     boolean (remote events)
caption.state     'on' | 'off' (agent)
sleep             { endsAt, minutes } | null
general.* / sound.balance …   tracked-only settings from catalog/settings.js, under their own keys, src 'tracked'
input.labels      { HDMI1: 'PlayStation', … } (tracked, user-entered)
scenes            [ { id, name, steps } ]      macros [ { id, name, steps } ]
```

### 5.3 Browser protocol (WebSocket `ws://127.0.0.1:8790/live`, JSON text frames)

Server → browser:
- `{ "t": "hello", "version": "0.1.0", "state": <store.snapshot()>, "catalog": { "keys": [...], "settings": [...], "apps": [...] } }`
- `{ "t": "patch", "patch": { "<dotted.key>": <record|null>, ... } }`
- `{ "t": "ack", "id": "<client id>", "ok": true, "ms": 132, "value": <optional read-back> }` or `{ "t":"ack", "id", "ok": false, "error": { "code": "LOCKED_IN_MODE|UNAVAILABLE|NOT_PAIRED|TV_OFF|RATE_LIMIT|INVALID|FAILED", "message": "…" } }`
- `{ "t": "toast", "level": "info|warn|error", "text": "…" }`
- `{ "t": "changedOnTv", "key": "audio.volume", "from": 10, "to": 12 }` (external change with nothing pending)

Browser → server: `{ "t": "cmd", "id": "<uuid>", "cmd": "<name>", ...args }`

| cmd | args | effect |
|---|---|---|
| `key` | `key`, `action?: 'click'` | one key click via remote channel |
| `hold` | `key`, `phase: 'start'|'beat'|'end'` | repeatable keys: server repeats click every 120 ms while beats arrive (beat every ≤ 600 ms; watchdog stops after 1.5 s without beat and after 8 s total). Non-repeatable keys: Press on start, Release on end/watchdog |
| `volume.set` | `value` | IPC `directVolumeControl` (fallback UPnP SetVolume) then read-back; respects cap |
| `volume.step` | `delta` (±1…±5) | absolute set to current+delta (fallback KEY_VOLUP/DOWN) |
| `mute.set` | `value: boolean` | IPC `muteControl` (fallback UPnP SetMute, then KEY_MUTE) |
| `power` | `action: 'on'|'off'` | §3.10 |
| `app.launch` | `appId` | REST POST launch; confirm via `visible` |
| `input.set` | `source` | IPC `inputSourceControl` |
| `setting.set` | `key`, `value` | IPC write per catalog, read-back; tracked keys → store as tracked |
| `settings.refresh` | `group?: 'picture'|'sound'|'all'` | immediate re-read |
| `text.send` | `text`, `submit?: boolean` | `SendInputString` (base64 UTF-8) then `SendInputEnd` if submit |
| `pointer.move` | `dx`, `dy` | `ProcessMouseDevice` Move (only when `touch.enabled`) |
| `pointer.click` | `button?: 'left'` | `ProcessMouseDevice` LeftClick |
| `sleep.set` | `minutes` (0 = cancel) | sleep timer |
| `scene.run` | `id` | run scene steps sequentially with read-back |
| `scene.save` / `scene.delete` | `scene` / `id` | persist |
| `macro.record` | `phase: 'start'|'stop'`, `name?` | record subsequent `key` cmds with timing |
| `macro.run` / `macro.delete` | `id` | replay with recorded timing (min 150 ms gap) |
| `agent.connect` | — | REST launch of the agent app |
| `view` | `name: 'remote'|'settings'|'apps'|...`, `visible: boolean` | tells the server what is on screen (drives polling cadence) |

### 5.4 Adapter interface

Each adapter is created as `createX({ config, store, log, lan?, queue? })` and returns an object with `start()`, `stop()` and its command methods; adapters write state only through `store.set`. Adapters must never throw out of timers; errors become state (`conn.*`) and log lines.

- `rest`: `start()` polls device info (3 s while any browser visible, 15 s otherwise; 30 s when off); `getApp(id)`, `launch(id)`, `foregroundCheck()` (polls the last foreground app plus the curated installed apps round-robin, one in flight). Power state machine: `"on"` → on; `"standby"` or missing PowerState with HTTP OK → standby; 3 consecutive connect timeouts → off; ECONNREFUSED → standby.
- `remote`: `start()` connects only while `conn.tv === 'on'`; `click(key)`, `press(key)`, `release(key)`, `text(str, submit)`, `pointerMove(dx,dy)`, `pointerClick()`; emits `ime`, `touch.enabled`; reconnect backoff 1/2/5/10/30 s; treat 12 s without any frame as dead; on reconnect send Release for any key still pressed.
- `upnp`: `getVolume()`, `setVolume(v)`, `getMute()`, `setMute(b)`; GENA via `lan.route('/gena/<secret>', handler)`; SUBSCRIBE with `CALLBACK: <http://lanIp:8791/gena/secret>`, `NT: upnp:event`, `TIMEOUT: Second-1800`; renew at 80 % of granted timeout; parse `LastChange` (HTML-entity-encoded XML inside `<e:property>`), merge only present `Volume channel="Master"` / `Mute channel="Master"`; `conn.events` = 'push' after the first NOTIFY, else 'polling'.
- `ipcontrol`: single queue; `get(method)`, `set(method, params)`; `pollStates()` every 2.5 s while any browser visible (`getTVStates`), `pollPicture()` every 4 s while the Settings view is visible (all picture getters, one at a time, ≥ 150 ms apart), on demand otherwise; paused while `conn.tv !== 'on'`.
- `agent`: `lan.route('/agent', { upgrade })`; messages from the agent (below); `launch()` → `rest.launch('lumenrmt01.LumenAgent')`; `request(type, args)` with timeout.
- `wol`: `wake(mac)`.

### 5.5 Agent ↔ PC protocol (agent page is a WebSocket client)

Agent → PC: `{ "t": "hello", "agent": "0.2.0", "snapshot": {...} }`, `{ "t": "state", "snapshot": {...} }` (every 5 s and on change), `{ "t": "event", "kind": "volume", "value": 12 }`, `{ "t": "reply", "rid": "…", "ok": true, "data": … }`.
Snapshot fields: `source {type, number}`, `connected [ {type, number} ]`, `channel {name, number, type}|null`, `audio {volume, mute, outputCodec}`, `caption 'on'|'off'|null`, `build`, `panel {w,h}`, `system {cpuLoad, memAvailable, memTotal, storageFree, storageTotal}`, `foreground` (from `tizen.application.getAppsContext` is NOT foreground; leave null — REST gives foreground).
PC → agent: `{ "t": "req", "rid": "…", "type": "apps" }` → `data: [ {id, name, show, iconPath} ]` (only `show: true`), `{ "type": "icon", "appId" }` → `data: "data:image/png;base64,…"` (page reads the icon via XHR/`<img>` + canvas; may fail → `ok:false`), `{ "type": "exit" }`.
Agent behaviour: on load paint a tiny "Lumen Agent" card, `hide()` after 400 ms, connect with backoff 2/5/10/30 s; exit after 30 min without a PC connection; never call setters.

## 6. Front end

Single page, no framework, ES modules, works at 360 px phone width up to wide desktop. Views: **Remote** (default: power with state, d-pad ring with the volume HALO showing the real level and changing live, OK, Back, Home, TV Menu, volume rocker with numeric readout and mute, channel rocker, now-playing app/channel strip, quick input chips), **Apps & Inputs** (apps grid with brand colour / icons, inputs with connected dots), **Settings** (Picture, Sound, Input & Source, Device, Connection — each value with its provenance badge; sliders for numeric values with read-back; selects for enums; "locked in this mode" state; tracked-only settings with Calibrate and Open TV Menu; refresh), **Keys** (number pad, colour keys, media transport, extra keys like Info, Guide, Source, Caption, e-Manual, Picture Size, Ambient), **Touch & Text** (touchpad gestures when the TV allows a pointer; text field that auto-opens when the TV shows its keyboard), **Scenes** (scenes, sleep timer, macro recorder). Desktop keyboard shortcuts (arrows, Enter, Backspace = Back, H = Home, +/- volume, M mute, digits, Space play/pause, ? overlay). Optimistic UI with pending state and reconciliation; the volume slider ignores incoming updates while dragging and for 1 s after. Connection banner states (TV off → "Wake TV", remote unpaired, IP Control unpaired, agent offline → "Connect TV agent"). PWA manifest + service worker (offline shell only).

## 7. Testing

- `test/mock-tv.js` implements every channel in §2 with stateful behaviour (volume/mute shared between UPnP and IPC, GENA NOTIFY on change, IP Control errors, single-connection rule, WSS token issuance, IME events, power standby) and is started by tests on ephemeral ports; the server takes the TV host/ports from config so tests point it at the mock.
- `node --test` suites: store/provenance, LastChange parser, IP Control client (errors, queue), safety, browser protocol end-to-end (browser WS client ↔ server ↔ mock TV: key click reaches mock, volume.set read-back, GENA push reaches browser patch, setting.set picture.backlight, locked-in-mode error, power off/on, agent hello → state keys).
- `tools/screenshot.mjs` drives headless Edge over CDP against a server running on the mock and saves PNGs of each view at phone and desktop sizes.
- Live checks on the real TV are done by the orchestrating session with the user's consent, not by tests.

## 8. Integration contracts (binding for all builders)

### 8.1 Entry points and config

- `server/app.js` exports `async function startServer(overrides = {})` → `{ httpPort, lanPort, store, hub, config, stop: async () => {} }`. `server/index.js` only does `startServer()` plus signal handling. Tests always use `startServer`.
- `server/config.js` exports `loadConfig(overrides)` → deep-merged config, and `createDataStore(dataDir)` → `{ readJson(name, fallback), writeJson(name, obj) }` (atomic). Shape (defaults shown):

```json
{
  "dataDir": "<repo>/data",
  "tv": { "host": "192.168.1.2", "ports": { "rest": 8001, "wss": 8002, "dmr": 9197, "ipc": 1516 }, "clientName": "Lumen Remote" },
  "http": { "host": "127.0.0.1", "port": 8790 },
  "lan": { "enabled": true, "port": 8791 },
  "agent": { "appId": "lumenrmt01.LumenAgent" },
  "safety": { "volumeCap": 60, "powerCooldownMs": 15000, "keyGapMs": 120 },
  "timing": { "restVisibleMs": 3000, "restIdleMs": 15000, "ipcStatesMs": 2500, "ipcPictureMs": 4000, "volumePollVisibleMs": 1000, "volumePollIdleMs": 10000, "genaTimeoutS": 1800 }
}
```

`overrides` may set any field; tests pass `{ dataDir: <tmp>, tv: { host: '127.0.0.1', ports: <mock ports> }, http: { port: 0 }, lan: { port: 0 }, timing: { …faster… } }`. Port 0 = ephemeral; `startServer` returns the bound ports. The TV-facing listener binds the local address of a TCP connection to `tv.host` (127.0.0.1 in tests) and allows only `tv.host` as the remote address.
- Data files under `dataDir`: `tv.json` `{ token }` (read by remote adapter; written on pairing), `ipcontrol.json` `{ token }`, `secrets.json` `{ genaSecret, agentKey }` (generated by config.js if missing), `state-cache.json`, `scenes.json`, `macros.json`, `tracked.json`, `sleep.json`, `logs/`.

### 8.2 Wiring

```js
// server/app.js (core builder)
const config = loadConfig(overrides);
const data = createDataStore(config.dataDir);
const log = createLogger({ dir: path.join(config.dataDir, 'logs') });
const store = createStore({ cachePath: path.join(config.dataDir, 'state-cache.json') });
const lan = await createLan({ config, log });            // { port, address, route(pathPrefix, { request?, upgrade? }), stop() }
const ctx = { config, data, log, store, lan };
const rest = createRest(ctx);           const remote = createRemote({ ...ctx, rest });
const upnp = createUpnp(ctx);           const ipc = createIpControl(ctx);
const agent = createAgent({ ...ctx, rest }); const wol = createWol(ctx);
const features = { sleep: createSleep({...ctx, ipc, remote}), scenes: createScenes({...ctx}), tracked: createTracked(ctx), macros: createMacros({...ctx, remote}) };
const hub = createHub({ ...ctx, adapters: { rest, remote, upnp, ipc, agent, wol }, features });
const http = await createHttp({ ...ctx, hub });          // serves web/, /api/health, /api/icon/<appId>, WS /live
for (const a of [rest, remote, upnp, ipc, agent]) a.start();
```

- Every adapter: `start()`, `stop()` (async, idempotent), `setDemand({ clients, visible, views })` (no-op allowed). `views` is a Set of view names currently visible in any tab ('remote', 'settings', 'apps', 'keys', 'touch', 'scenes').
- Adapters read tokens with `data.readJson('tv.json')` / `data.readJson('ipcontrol.json')`; pairing writes them.
- `hub.handle(cmd, client)` → `Promise<{ ok: true, value?, ms } | { ok: false, error: { code, message } }>`; `hub.attach(client)` / `hub.detach(client)` on WS open/close; `client.send(obj)`. Hub owns presence (`view` cmds) → `setDemand` on adapters, and `changedOnTv` detection (store patch for `audio.volume`, `audio.mute`, `input.source`, `picture.*` with no command of the same key in the last 3 s).
- `features.scenes.run(id, { hub })` executes steps by calling `hub.handle` internally (so safety applies).
- Icons: `agent.getIcon(appId)` → `{ type, buffer } | null`; http.js serves it at `/api/icon/<appId>`.

### 8.3 Ownership of state keys

| Writer | Keys |
|---|---|
| rest | `conn.tv`, `power.state`, `conn.latency.rest`, `device.*` (except firmware), `app.foreground` |
| remote | `conn.remote`, `ime`, `touch.enabled` |
| upnp | `conn.upnp`, `conn.events`, `conn.latency.upnp`, `audio.volume`, `audio.mute` |
| ipcontrol | `conn.ipc`, `conn.latency.ipc`, `audio.volume`, `audio.mute`, `audio.soundMode`, `audio.speaker`, `input.source`, `picture.*` |
| agent | `conn.agent`, `device.firmware`, `input.connected`, `channel.current`, `audio.outputCodec`, `caption.state`, `system.*`, `app.installed` (when online; else hub seeds it from catalog/apps.js with `src:'derived'`) |
| features | `sleep`, `scenes`, `macros`, tracked-only settings under their own catalog keys (e.g. `general.gameMode`) with `src:'tracked'`, `input.labels` (tracked HDMI names) |

Several writers may set `audio.volume`/`audio.mute`/`input.source`; the store keeps the newest. Values are always set in UI units (mute as boolean, volume 0–100).

### 8.4 Catalogue shapes (sent in `hello.catalog`)

```js
// catalog/keys.js
export const KEYS = [{ key: 'KEY_UP', label: 'Up', group: 'nav', hold: 'repeat' /* 'repeat' | 'press' | 'none' */ }, ...];
export function isAllowedKey(key) {}            // false for danger keys (KEY_FACTORY, KEY_11, KEY_12, service/panel/EXT keys)
// catalog/settings.js
export const SETTINGS = [{ key: 'picture.backlight', label: 'Brightness', hint: 'Panel backlight', group: 'picture', type: 'range', range: [0, 50], step: 1,
  ipc: { method: 'backlightControl', field: 'backlight' }, scoped: true, writable: true },
  { key: 'picture.mode', type: 'enum', options: ['Dynamic','Standard','Natural','Movie'], ipc: { method: 'pictureModeControl', field: 'pictureMode' }, writable: true },
  { key: 'picture.whiteBalance', type: 'readonly', ipc: { method: 'WB2PointControl', field: null } },
  { key: 'general.gameMode', label: 'Game Mode', group: 'general', type: 'tracked', options: ['Off','Auto','On'], menuPath: 'Settings > General > External Device Manager > Game Mode Settings' }, ...];
// catalog/apps.js
export const APPS = [{ id: '3201907018807', name: 'Netflix', color: '#E50914', short: 'N' }, ...];
```

Groups: `picture`, `pictureAdvanced`, `sound`, `input`, `general` (tracked-only), `device` (read-only info rows rendered from `device.*`/`system.*`).

### 8.5 Additional browser commands

`pair.remote` (connect without token, wait up to 45 s for the on-screen Allow), `pair.ipcontrol` (`createAccessToken`), `input.label { source, label }` (tracked name), `tracked.set { key, value }` is the same as `setting.set` on a tracked key. Pairing commands are only sent from explicit buttons and never retried automatically.

## 9. Binding answers to the builder check (override anything above that conflicts)

1. **Debug port**: dev-time reverse-engineering only, never a runtime channel. If the REST launch of the agent fails, `agent.connect` acks `{ ok:false, error:{ code:'FAILED', message:'Open "Lumen Agent" from the TV Apps screen' } }`.
2. **Test surface**: `startServer(overrides)` returns `{ httpPort, lanPort, agentKey, store, hub, config, stop }`. Host/Origin allowlists are built from the bound HTTP port. Config also has `wol: { targets: [], ports: [9, 7] }` (empty targets = 255.255.255.255 + directed broadcast + TV unicast; tests set `['127.0.0.1']` and a mock UDP port) and `timing` gains `genaFallbackMs 8000, powerPollMs 1500, powerPollTotalMs 30000, holdRepeatMs 120, holdWatchdogMs 1500, holdMaxMs 8000, reconnectBackoffMs [1000,2000,5000,10000,30000]`. The mock leaves standby on a WoL packet to its UDP port or on IPC `powerControl {power:'powerOn'}`.
3. **Normalisation**: the adapter that reads a value normalises it before `store.set`: mute → boolean; speaker → `'Internal'` | `'External'`; enums keep the TV's spelling (`Warm1`, `Standard`, `Filmmaker Mode`); numbers stay numbers. Setters map back. Settings catalogue entry fields: `key, label, hint?, group, type ('range'|'enum'|'toggle'|'readonly'|'tracked'), range?, step?, options?, ipc? { method, field, param? (defaults to field) }, scoped?, writable?, dependsOn? { key, value }, display? ('gr' = tint shown as G/R), menuPath? (tracked)`. Keys catalogue: `{ key, label, group, hold, icon? }`. Apps catalogue: `{ id, name, color, short, dial? }`.
4. **Store rules**: `snapshot()` returns the same **flat** map as patches (`{ 'audio.volume': record, … }`); the UI works with flat keys. Every state key is a record (object values allowed in `v`). Last writer wins, except that a write with `src` `agent`, `derived` or `cache` does not replace a `live` record younger than its `ttlMs`. `pending` is unused (always null): optimistic state lives in the UI. `changedOnTv` is emitted by the hub only when the value really differs from the last broadcast value, came from `live` or `agent`, no command touched that key in the last 3 s, debounced 1 s.
5. **Agent mapping** (in `adapters/agent.js`): `{type:'TV'}` → `'TV'`, `HDMI n` → `'HDMIn'`, `AV n` → `'AVn'`, `COMP n` → `'COMPONENTn'`, other → `${type}${number}`. `input.connected` and `input.available` (connected + disconnected) are arrays of those strings. `system.cpuLoad` 0–1; memory and storage in bytes.
6. **Demand**: zero clients → REST idle cadence; IP Control polling stops (resumes on attach); GENA stays subscribed; volume poll fallback idles at 10 s.
7. **Adapter contract**: dependencies are injected (see §8.2); adapters read `store.get('conn.tv')?.v` to gate. `rest.getWakeMac()` returns the MAC for WoL (never stored). Command methods resolve to `{ value? }` (the read-back) or reject with `LumenError` from `server/errors.js` (`new LumenError(code, message)`, codes as in §5.3). **The adapter does the read-back** and returns it; the hub just acks. `log.child(tag)` → `{ debug, info, warn, error }(msg, obj?)`. Tokens are saved with `data.writeJson`. Each adapter owns its queue via `server/util/queue.js` `createQueue({ concurrency: 1, minGapMs })` → `queue.push(fn, { priority: 'user' | 'poll' })` (core owns the file).
8. **lan.js**: `lan.route(prefix, { request?(req, res), upgrade?(req, socket, head) })`, prefix match on the pathname. lan.js rejects any remote address other than `tv.host`; handlers check the secret/key. `lan.ready` → `Promise<{ address, port } | null>`. The LAN address is found by a UDP `connect()` to `tv.host` port 9 and reading `socket.address()` (no packet is sent; works while the TV is off).
9. **Pairing**: the remote adapter never connects without a token except during `pair.remote`. An `ms.channel.unauthorized` with a token → `conn.remote = 'unpaired'`, stop retrying. Banners offer a **Pair** button (`pair.remote` / `pair.ipcontrol`).
10. **Steps**: a scene step is a browser command without `t`/`id` plus optional `waitMs` (e.g. `{ cmd: 'setting.set', key: 'picture.backlight', value: 4 }`); a macro step is `{ key, gapMs }`. Files hold `[{ id, name, steps, createdAt }]`.
11. **Icons**: fetched lazily by `agent.getIcon(appId)` (agent `icon` request), cached in memory and `data/icons/`; `app.installed[].icon` is `/api/icon/<appId>` once one exists.
12. **Agent build**: `agent-config.json` = `{ pcHost, pcPort, key, version }`; `build.ps1` finds the PC address with the same UDP-connect trick (PowerShell `UdpClient.Connect`), creates `data/secrets.json` if it is missing (same format, 32-byte hex secrets), and stamps the version. The agent reports `pcHost` and `version` in `hello`; when they don't match the server's view, Settings › Connection says "Rebuild the TV agent".

## 10. Cast

A **Cast** view sends media to the TV:
- **Link**: the user pastes a URL. YouTube links → DIAL `YouTube` launch with the video id; Netflix title links → Netflix launch with that title; Prime links → Prime launch; direct media (`.mp4`, `.mkv`, `.webm`, `.mp3`, `.m4a`, `.flac`, `.jpg`, `.png`, `.m3u8`) → DLNA AVTransport (`SetAVTransportURI` with DIDL-Lite metadata and the right protocolInfo, then `Play`); any other web page → the TV browser (REST `POST /api/v2/webapplication/` `{ url }` or launching the browser app with the URL). The exact launch payloads are being reverse-engineered in parallel; implement each path behind `adapters/dial.js` / `adapters/avtransport.js` functions so the payloads can be corrected in one place.
- **File**: the user picks or drops a file from the PC. It is uploaded to the server (`POST /api/cast/upload`, same-origin, header `X-Lumen-CSRF` from a token in `hello`, Origin checked, streamed to `data/cast/`, 4 GB cap, deleted after 6 h) and served to the TV from the TV-facing listener at `/cast/<castSecret>/<fileId>` with Range support, then played over DLNA.
- **Now casting**: AVTransport `GetTransportInfo` / `GetPositionInfo` / `GetMediaInfo` polled every 1 s while casting; play/pause/stop/seek controls.
- State keys: `cast.session` `{ kind: 'dlna'|'dial'|'browser', title, uri?, state: 'PLAYING'|'PAUSED_PLAYBACK'|'STOPPED'|'TRANSITIONING'|'NO_MEDIA_PRESENT', position, duration }`. Commands: `cast.url { url }`, `cast.file { fileId, name }`, `cast.control { action: 'play'|'pause'|'stop'|'seek', position? }`.
- Modules: `features/cast.js` (classification + orchestration), `adapters/avtransport.js`, `adapters/dial.js` (also used by the AI tools).

## 11. AI ("Ask Lumen")

An **Ask** bar on every view (and a full Ask view) takes a natural-language request — "play Friends on Netflix", "increase brightness", "make it cinema-dark", "switch to HDMI 1", "sleep in 30 minutes" — and Claude performs it with tools that call `hub.handle`, so every safety rule still applies. Progress streams back to the UI as `{ t: 'ai', id, kind: 'status'|'tool'|'result'|'text'|'error'|'done', … }`; the browser sends `{ t:'cmd', cmd:'ai.ask', text, id }` and `ai.cancel`.

- **Backends** (`server/ai/`): `api` — the official Anthropic TypeScript/JavaScript SDK (`@anthropic-ai/sdk`, installed), `client.beta.messages.toolRunner` with `betaTool` JSON-schema tools (`@anthropic-ai/sdk/helpers/beta/json-schema`) plus the server tool `{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }` for looking up title/video ids; model `claude-opus-5-5`, `output_config: { effort: 'low' }` (config `ai.effort`), server-side refusal fallbacks (`betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'`); credentials resolved by the SDK (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profile); handle `pause_turn`, `refusal`, `max_tokens`; validate every tool input before running it. `claude-code` — when no API credentials exist, spawn the local Claude Code CLI (`claude -p … --output-format stream-json --verbose --strict-mcp-config --mcp-config <file> --no-session-persistence`, with only the Lumen tools plus WebSearch allowed and a Lumen system prompt), which uses the user's own Claude login; Lumen exposes the same tools at `http://127.0.0.1:<port>/mcp` (MCP streamable HTTP, JSON responses, bearer `mcpToken` from `secrets.json`, loopback only). Builders must read the claude-api skill docs at `C:/Users/pranj/AppData/Local/Temp/claude/bundled-skills/2.1.303/133f4056b56d79ee7a25ec2b30892c50/claude-api/` (typescript/claude-api/README.md, tool-use.md, streaming.md, shared/tool-use-concepts.md, shared/model-migration.md for fallbacks) and `claude --help` instead of guessing APIs or flags. Config `ai: { backend: 'auto'|'api'|'claude-code'|'off', model: 'claude-opus-5-5', effort: 'low' }`.
- **Tools** (`server/ai/tools.js`, one definition list shared by both backends): `get_tv_state`, `list_settings`, `set_setting {key, value}`, `change_setting {key, delta}`, `set_volume {level}`, `change_volume {delta}`, `set_mute {muted}`, `press_keys {keys[], gapMs?}`, `list_apps`, `launch_app {app}` (name or id, fuzzy-matched against installed + curated apps), `open_netflix {titleId? , url?}`, `play_youtube {videoId? , url?}`, `open_prime {url}`, `open_url_on_tv {url}`, `cast_media {url}`, `set_input {source}`, `power {action}`, `sleep_timer {minutes}`, `run_scene {name}`, `type_text {text, submit?}`. Content lookups use web search to find official IDs/URLs (netflix.com/title/…, youtube.com/watch?v=…). There is deliberately **no tool that searches for or plays titles inside CineHD**; CineHD can only be launched as an app.
- Answers are short and say what was done ("Brightness 10 → 14"). If no tool fits, Claude says so instead of guessing. Every run is logged (request text, tools called, results) without secrets.

### 11.1 Decision update (2026-10-21, user: "We don't have claude api key. Can agent sdk be used?")

- The user has **no Claude API key**. The local Claude Code CLI is logged in with their claude.ai account (`claude auth status` → `loggedIn: true, authMethod: claude.ai`).
- New default backend **`agent-sdk`**: `@anthropic-ai/claude-agent-sdk` (installed, with `zod`), `query({ prompt, options })`. Lumen's tools are registered in-process with `createSdkMcpServer({ name: 'lumen', version, tools })` and `tool(name, description, zodRawShape, handler)`, where the handler returns `{ content: [{ type: 'text', text }], isError? }`.
- Options:
  - `mcpServers: { lumen }`
  - `allowedTools: ['mcp__lumen__*', 'WebSearch', 'WebFetch']`; built-in tools limited to WebSearch/WebFetch (`tools`), with Bash/Read/Write/Edit etc. denied
  - `permissionMode: 'dontAsk'`
  - `systemPrompt: <Lumen prompt>`
  - `settingSources: []`, so the user's CLAUDE.md, memory and skills do not load
  - `persistSession: false`, `maxTurns: 12`
  - `model: config.ai.model`, `effort: config.ai.effort`
  - `abortController` for cancel
  - `cwd`: an empty `data/ai-sandbox/`
  
  Stream `assistant` / `result` messages into the same `ai` events.
- Backend order for `auto`: `api` (only if SDK credentials exist) → `agent-sdk` (Claude Code login present) → `off`. The CLI-spawn backend is dropped in favour of the Agent SDK (same binary, no shell, no HTTP hop). The `/mcp` endpoint stays, so external MCP clients can drive Lumen too.
- Policy note shown in Settings › Connection: Anthropic does not allow third-party products to offer claude.ai login. Lumen uses the owner's own Claude Code login on their own PC for personal use; if Lumen is ever shared, switch to API-key auth.

## 11.2 Mouse / trackpad (user request 2026-10-21: "a trackpad which can be used as a mouse in different apps like the tv browser, cinehd etc")

- Transport: the paired remote channel's `ProcessMouseDevice`:
  - Move: `{"method":"ms.remote.control","params":{"Cmd":"Move","Position":{"x":dx,"y":dy,"Time":"<ms since epoch>"},"TypeOfRemote":"ProcessMouseDevice"}}` (relative, roughly 1920×1080 space)
  - clicks: `{"Cmd":"LeftClick","TypeOfRemote":"ProcessMouseDevice"}` / `RightClick`
  
  The TV's `ms.remote.touchEnable` / `touchDisable` events (state `touch.enabled`) tell whether the screen in front accepts a pointer.
- Commands:
  - `pointer.move { dx, dy }`: the server coalesces deltas into at most 30 messages/s, so slow TV processing never builds a backlog
  - `pointer.click { button: 'left'|'right' }`
  - `pointer.scroll { dy }`: no native wheel exists. Emulate with KEY_CHUP/KEY_CHDOWN (pages in the TV browser) or KEY_UP/KEY_DOWN, chosen by `config.pointer.scrollKeys`, with one key per accumulated 120 wheel units, rate-limited
- **Mouse** view:
  - Phone/tablet: a full-surface trackpad with an acceleration curve, tap = left click, two-finger tap = right click, two-finger drag = scroll, long-press = right click; sensitivity slider persisted in localStorage; haptic tick on click.
  - Desktop: "Mouse mode" uses the Pointer Lock API (`requestPointerLock`), so the PC mouse drives the TV cursor (`movementX/Y` → `pointer.move`; buttons → clicks; wheel → scroll); Esc exits.
  - Header line from `touch.enabled`: "Pointer active in this app" vs "This app doesn't take a pointer — the pad works as a d-pad". Without pointer support, swipes become arrows and a tap becomes OK.
- Text: a keyboard button opens the text field (IME path) without leaving Mouse mode.
- Live verification (orchestrator): TV browser, YouTube, CineHD, Home. Record per app whether `touchEnable` arrives and the cursor moves.

## 11.3 Browser view (user request 2026-10-22: "Build the browser interface for lumen. I put the link in cast option, the link opens inside lumen")

The user chose "a Browser tab in Lumen with an address bar; links from Cast open there, rendered inside Lumen, with an Open on TV button".

**Rendering (my call):** a real browser on the PC, not an iframe. Many sites refuse framing (X-Frame-Options / frame-ancestors), so Lumen drives **headless Microsoft Edge over CDP** (`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`, `--headless=new --remote-debugging-port=<random loopback port> --user-data-dir=<dataDir>/browser-profile`, so logins persist) and streams its screen to the Lumen UI with `Page.startScreencast` (JPEG, quality ~60, max 1280×800, `everyNthFrame` 1), acknowledging each frame with `Page.screencastFrameAck`. Input goes back with `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText` / `Input.dispatchMouseEvent type=mouseWheel`. One shared browser session (every Lumen client sees the same page), started lazily on first use and closed after 20 min without a viewer. The Edge process is closed over CDP (`Browser.close`), then `taskkill` as a fallback, as `tools/screenshot.mjs` already does.

**Server:** `server/features/browser.js` `createBrowser({ ...ctx, hub })` → `{ open(url), nav(action), input(event), setViewport(w, h), viewers(set), start, stop, setDemand }`. State keys (src `derived`, via `browser`): `browser.url`, `browser.title`, `browser.loading` (boolean), `browser.canGoBack`, `browser.canGoForward`, `browser.session` (`'off' | 'starting' | 'ready' | 'error'`), `browser.error` (string | null). Frames are **not** store records; the hub sends `{ t: 'browser.frame', data: <base64 jpeg>, w, h, seq }` only to clients whose current view is `browser` and whose tab is visible (`hub.sendToView('browser', msg)`, added to the hub), at most 15 frames/s per client; a client that has not acked (`browser.ack { seq }`) within 2 frames is skipped until it does.

**Commands:** `browser.open { url }` (http/https only; `javascript:`/`file:` refused), `browser.nav { action: 'back'|'forward'|'reload'|'stop'|'home' }`, `browser.input { kind: 'move'|'down'|'up'|'click'|'wheel'|'key'|'text', x, y, button, deltaX, deltaY, key, code, text, modifiers }` with coordinates in frame pixels (the server scales them to the viewport), `browser.viewport { w, h }` (clamped 320–1280 × 320–800), `browser.ack { seq }`, `browser.close`. `cast.url` with a `page` link now opens it in the Lumen browser (`features.browser.open`) and returns `{ kind: 'browser', url }`; the TV-browser launch moves behind the Open on TV button.

**Open on TV:** the TV agent gains request `open-url { url }` → `tizen.application.launchAppControl(new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', url), null, …)`, falling back to `launchAppControl(…, 'org.tizen.browser')`. Command `browser.openOnTv { url? }` (default: the current page) → `agent.request('open-url', { url })`, falling back to the REST browser launch when the agent is offline. Agent version 0.3.0 (the TV rejects lower versions); the orchestrator builds and installs it.

**UI:** a **Browser** view (nav rank 1, icon `globe`): address bar (URL or search → `https://duckduckgo.com/?q=` when the text has no dot/scheme), back / forward / reload / stop, Open on TV, Close, a status line (title · loading · session state). The page area shows the latest frame on a `<canvas>` sized to the viewport aspect; pointer events map to frame coordinates; wheel/two-finger drag → `wheel`; a tap focuses a hidden input so phone keyboards type into the page (`text` events; special keys as `key`). Page frames stop when the view is hidden (`view` presence). Cast's link box: a `page` link shows "Opens in Lumen's browser · Open on TV available there".

**Security:** CDP port on loopback only; the profile dir under `data/` (git-ignored); URLs validated server-side; no file:// or javascript:; frames go only to attached Lumen clients (same LAN trust as the rest of Lumen).

**Tests:** the real headless Edge is on this PC, so tests start it against pages served by the test itself (a tiny local HTTP page with a title, a link and a text input): open → `browser.title`/`browser.url` patches, a frame arrives for a client on the `browser` view and none for one on `remote`, click on the link → url changes, text input → the page's input value (read back via a second `Runtime.evaluate` in the test through the same CDP endpoint, exposed as `features.browser.evaluate(expr)` for tests only), back/forward flags, viewport clamp, URL validation, idle shutdown (short timeout in tests), and `cast.url` with a page → `browser.url`. Skip cleanly (not fail) when Edge is absent.

## 12. Left to the builder

Exact visual details within HALO, icon drawing, copy, animation curves, internal helper structure, test granularity.
