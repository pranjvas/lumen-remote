# Research area: smartthings

## Summary

SmartThings can handle the "state" layer of the remote: power, volume, mute, picture mode, sound mode, input source with the user's own input names, the foreground app or channel name, app launch, 17 navigation and media keys, ambient mode, and a few device facts. It cannot do picture tuning. No capability on any Samsung TV profile exposes backlight, brightness, contrast, sharpness, colour, colour tone, eco, ambient-light detection, or EQ/balance. Energy-saving level (custom.energyType) only appears on 2022+ profiles, and samsungvd.lightControl is Philips Hue Sync, not panel light.

Public dumps suggest 2018–2020 TVs, including Tizen 5.5 sets from 2020, report the legacy 'VD-STV_2018_K' profile with about 27 capabilities. Picture mode there is custom.picturemode; samsungvd.pictureMode returns 422.

The deprecated 'execute' capability can reach the TV's OCF resources. A 2020 Tizen 5.5 TU7172 lists /sec/tv/mode/picture, /sec/tv/mode/sound, /sec/tv/optioncontrol, /sec/tv/uicontrol, /sec/tv/contentinfo, /sec/tv/deviceinfo and others, but none of them is a backlight resource. Only reads of /sec/tv/deviceinfo (model id, year, panel hours, country) are demonstrated on TVs. Read and write via execute is demonstrated on soundbars.

Picture tuning the user asked for (backlight 0-50, contrast, brightness, sharpness, colour, tint, colour tone) appears to live in the local Samsung "IP Control" JSON-RPC on TCP 1516. That applies to 2020+ sets, needs 'IP Remote' enabled, and pairs once with an on-screen prompt. That is outside this area and needs verification by the LAN agent.

Auth in Oct 2026: PATs issued after 30 Dec 2024 live 24 h (official). The working self-hosted path is an OAuth-In (API_ONLY) app created with `smartthings apps:create`. Access tokens last 24 h; refresh tokens last 30 days and are single-use. A redirect to localhost gets 403 on some accounts, so use the https://httpbin.org/get copy-paste flow.

Samsung announced that free API access is phased out from October 2026, with a $4.99/month personal plan. The docs now return 402 when a plan is missing or over quota, and SSE push is officially a paid Developer/Business feature. A plain PC app is therefore realistically limited to polling within per-device rate limits: officially 12/min in one table, 120-350/min observed in another.

SmartThings state is often stale. Volume has been seen lagging, or stuck for weeks, until a 'refresh' command is sent. The 'switch' can read 'on' after the panel is off. Picture-mode commands sometimes return COMPLETED without being applied. So local UPnP should be the source of truth for volume and mute; SmartThings covers modes, input names and power-on.

Power-on from standby via switch.on is supported on 2019+ sets that report supportsPowerOnByOcf 'true' and have 'Power On with Mobile' enabled. Its latency is unmeasured. Nothing here was observed on this TV, because the task did not allow contacting SmartThings or the TV.

## Capabilities

- **Power state read + power off/on (switch)** (source-code, high; read=true write=true live=false): GET /v1/devices/{id}/components/main/capabilities/switch/status -> {switch:{value:'on'|'off'}}; POST /v1/devices/{id}/commands {component:'main',capability:'switch',command:'on'|'off'}
  - Present in every TV fixture 2017-2024. Cloud value can stay 'on' after the panel is off (TheFab21 PR #308) and refresh then returns FAILED, so combine it with local REST PowerState (port 8001 /api/v2/ already shows PowerState on this TV). Live push only via the paid SSE feature.
- **Power ON from standby via cloud** (official-doc, medium; read=false write=true live=false): switch.on (same payload as above); precondition attribute samsungvd.supportsPowerOnByOcf.supportsPowerOnByOcf == 'true'; TV setting Settings > General > Network > Expert Settings > Power On with Mobile (2017-2021 menu path)
  - Samsung support pages say power-on via SmartThings needs 'Power On with Mobile'. TVs older than 2019 may show offline when off and cannot be powered on this way. The 2018/2019/2021-2023 fixtures report supportsPowerOnByOcf 'true'; the Q95T value is unverified. A 409 Conflict means the cloud considers the device offline. TheFab21 says a TV in deep standby keeps an outbound cloud connection, which is why this works even when the TV drops off the LAN. No published latency; anecdotal cloud command latency is about 1-3 s plus TV wake time, so measure it. Keep Wake-on-LAN as a parallel path (WoL is another area; it was not sent here).
- **Read current volume (cloud)** (source-code, medium; read=true write=false live=false): GET .../components/main/capabilities/audioVolume/status -> {volume:{value:0-100,unit:'%',timestamp}}
  - Known to be stale. pysmartthings issue #38 shows volume and timestamp frozen for a month; the AdyRock dump shows volume 0 with a timestamp 6 weeks old; awake tv-remote saw SmartThings report 0 while the TV was at 3. Sending 'refresh' first helps. Use local UPnP RenderingControl GetVolume (already live-verified on this TV, returned 4) as the source of truth and SmartThings only as a fallback, so the design does not depend on this.
- **Set exact volume / step volume** (source-code, high; read=false write=true live=false): audioVolume.setVolume [int 0-100]; audioVolume.volumeUp / volumeDown (no args)
  - Schema: volume integer 0..100. awake tv-remote reports that setVolume through SmartThings also unmutes the TV. Rate limit is 12 commands/min/device in the conservative official table, so a dragging slider must be debounced to the final value.
- **Mute read/write** (source-code, high; read=true write=true live=false): audioMute.mute {value:'muted'|'unmuted'}; commands mute, unmute, setMute ['muted'|'unmuted']
  - The same staleness as volume applies. Prefer local UPnP GetMute.
- **Picture mode read/write (Standard/Movie/Dynamic/Natural/Filmmaker...)** (source-code, medium; read=true write=true live=false): custom.picturemode: attrs pictureMode, supportedPictureModes [names], supportedPictureModesMap [{id:'modeMovie',name:'Movie'}]; command setPictureMode [mode]
  - The 2018_K profile (2018-2020 TVs) has custom.picturemode only; samsungvd.pictureMode returns 422 there. Send the display NAME (e.g. 'Movie'); TheFab21 #116 found the id form returned COMPLETED but did nothing on an S90C. The list is per input and per signal: a PC input gives Entertain/Graphic, and HDR content returned just ['HDR+'] on a 2018 Q8. Names are localized (e.g. 'Dynamisk'). awake tv-remote (2025 Q7F) saw picture and sound mode commands return COMPLETED without the TV applying them, so read back about 5 s after a refresh. The command returns 409 when the cloud thinks the TV is off.
- **Sound mode read/write** (source-code, medium; read=true write=true live=false): custom.soundmode: soundMode, supportedSoundModes, supportedSoundModesMap; setSoundMode [name]
  - The list changes with the audio output; external output gives ids like modeExternalAdaptive/modeExternalGame. The same 'accepted but not applied' risk as picture mode.
- **Input source read/write incl. user-assigned HDMI names** (source-code, medium; read=true write=true live=false): samsungvd.mediaInputSource: inputSource ('HDMI1'|'dtv'...), supportedInputSourcesMap [{id:'HDMI1',name:'PlayStation 4'}]; setInputSource [id]. Standard mediaInputSource: setInputSource [enum digitalTv|HDMI1..HDMI6|USB|...]
  - This is the only known source of the friendly HDMI names (device names set by CEC or the user), which the informational UI needs. On newer firmware the standard capability's supportedInputSources is often []. Use the samsungvd map. inputSource can lag.
- **Foreground app / channel indicator** (source-code, medium; read=true write=false live=false): tvChannel.tvChannelName (string) and tvChannel.tvChannel
  - When an app is in front, tvChannelName carries the Tizen app id, e.g. '9Ur5IzDKqV.TizenYouTube', 'qvVcLChmPo.NPO', or 'art' on Frames. On the tuner it carries the channel name ('TLC HD') and tvChannel the number. Often '' or stale; refresh first.
- **Channel control** (source-code, medium; read=true write=true live=false): tvChannel.setTvChannel ['5'] (string), channelUp, channelDown
  - Only meaningful on the tuner (dtv).
- **Launch app** (community, medium; read=false write=true live=false): custom.launchapp.launchApp [appId?, appName?] e.g. ['111299001912'] (YouTube), ['3201907018807'] (Netflix), ['3201910019365'] (Prime), or [null,'YouTube'] by name
  - Both arguments are optional strings. A single argument is treated as appId, so to launch by name send [null, name] (joeblack2k). Community reports it works on 2018-2023 sets, but one report says it failed on a QN900A (2021). The TV can be slow to switch.
- **Remote keys via cloud (fallback remote)** (source-code, medium; read=false write=true live=false): samsungvd.remoteControl.send [keyValue, keyState?]; keyValue enum UP, DOWN, LEFT, RIGHT, OK, BACK, EXIT, MENU, HOME, MUTE, PLAY, PAUSE, STOP, REWIND, FF, PLAY_BACK, SOURCE; keyState enum PRESSED, RELEASED, PRESS_AND_RELEASED
  - The 2018_K profile (Q60R Oct-2026 dump, 2019 Q70R) includes it. There are no number, volume, channel, power or colour keys; use the other capabilities for those. PRESSED followed by RELEASED allows long-press. A community post shows ['OK','PRESS_AND_RELEASED'] returning COMPLETED. Too slow and rate-limited for primary navigation; use it only when the LAN WebSocket is unavailable.
- **Media transport** (source-code, medium; read=false write=true live=false): mediaPlayback play|pause|stop|fastForward|rewind; mediaTrackControl nextTrack|previousTrack
  - On TVs playbackStatus is always null and supportedTrackControlCommands null, so treat these as write-only buttons.
- **Backlight / brightness / contrast / sharpness / colour / tint / colour tone / eco / ambient light detection via SmartThings** (source-code, medium; read=false write=false live=false): NONE. No capability on any TV profile; the OCF resource directory of a 2020 Tizen 5.5 TV (via execute) has no backlight/picture-adjust resource
  - The full capability dumps (pySmartThings/capabilities) and all TV fixtures 2017-2024 show nothing beyond picture mode. SmartThings staff answer that what is not a capability 'is unknown to us'. awake tv-remote: 'There is no brightness control through SmartThings'. Unexplored candidates are execute on '/sec/tv/optioncontrol' or '/sec/tv/uicontrol', whose payloads are unknown and need live discovery. For actual backlight/contrast/brightness/sharpness/color/tint/colorTone values, see the IP Control entry below (LAN, not SmartThings). samsungvd.lightControl is Philips Hue Sync and relativeBrightness belongs to a separate 2023+ Frame light-sensor device, so neither applies to the Q95T.
- **Picture calibration values (backlight 0-50, contrast, brightness, sharpness, color, tint, color tone) via local Samsung IP Control - cross-area pointer, NOT SmartThings** (source-code, low; read=true write=true live=false): HTTPS POST https://192.168.1.2:1516/ JSON-RPC 2.0: createAccessToken (on-screen prompt) then getTVStates, getVideoStates, backlightControl {backlight}, contrastControl, brightnessControl, sharpnessControl, colorControl, tintControl, colorToneControl, directVolumeControl, powerControl; params.AccessToken
  - Per the TheFab21 fork's protocol reference, 2020+ models use port 1516 and need the TV setting 'IP Remote' in Expert Settings. Samsung's integrator worksheet confirms the 2020 port change. Self-signed TLS; pairing prompts on screen. Getters are listed as read and set through the same method with no params. Writes are gated by picture mode (-32002 in Dynamic). A 2018 set returns -32003 for backlightControl, and 2020 Q95T behaviour is unknown. Port 1516 on this TV was not in the scanned list, so the LAN agent must check it with a TCP connect only (pairing shows a dialog). This is the most promising route to the 'brightness levels' Settings view.
- **Device facts via OCF execute (/sec/tv/deviceinfo)** (source-code, medium; read=true write=false live=false): POST commands {capability:'execute',command:'execute',arguments:['/sec/tv/deviceinfo']}; then GET .../components/main/capabilities/execute/status -> data.value.payload
  - The payload rt is x.com.samsung.tv.deviceinfo. Fields include x.com.samsung.modelid (e.g. '23_PONTUSM_QTV'), .infolinkversion, .country, tv.year, tv.paneltime (looks like panel hours), tv.category, tv.countrycode, tv.language, tv.swmodel, tv.thingversion, tv.onsupport, tv.ambientsupport. It also carries serial number, DUID and all MACs: never log, display or store those. The execute capability status is 'deprecated' and may disappear. Only the last execute result is kept (one shared 'data' attribute), so serialize execute calls.
- **Other OCF resources reachable via execute (mode/picture, mode/sound, optioncontrol, uicontrol, contentinfo, audio, channel, inputsource, launchapp, remotecontrol, showmenu, ime, searchall)** (community, low; read=true write=true live=false): execute [href] to read, execute [href, {property: value}] to write; hrefs from a 2020 TU7172 /oic/res: /sec/tv/mode/picture, /sec/tv/mode/sound, /sec/tv/optioncontrol, /sec/tv/uicontrol, /sec/tv/contentinfo, /sec/tv/contentinfo/thumbnail, /sec/tv/audio (oic.r.audio), /sec/tv/channel, /sec/tv/inputsource, /sec/tv/launchapp, /sec/tv/launchnativeapp, /sec/tv/remotecontrol, /sec/tv/showmenu, /sec/tv/ime, /sec/tv/searchall, /sec/tv/searchonweb, /sec/tv/msoinfo, /sec/tv/onsupport, /sec/tv/tapview, /sec/tv/mediaInput
  - The only known TV write format is a 2018-era log of postOcfCommand('/oic/route/<di>/sec/tv/inputsource', {'x.com.samsung.tv.currentMode':['dtv']}). By analogy /sec/tv/mode/picture probably uses x.com.samsung.tv.currentMode (unverified). Soundbar read/write via execute is demonstrated (/sec/networkaudio/advancedaudio {'x.com.samsung.networkaudio.nightmode':1}). Discovery recipe (community): change a setting in the SmartThings phone app's TV plugin, then GET the execute status to see which href and payload the plugin used. Read-only probing of these hrefs is the first live experiment worth running; it is cloud-mediated and does not touch the TV UI.
- **Sound EQ / balance / speaker select on TV** (source-code, medium; read=false write=false live=false): None for TVs. samsungvd.soundFrom (setSoundFrom [int mode, detailName?]) and /sec/networkaudio/eq etc. exist only on soundbars
  - The TV OCF directory has only /sec/tv/audio (oic.r.audio = volume and mute) and /sec/tv/mode/sound. Speaker select is available through local IP Control (speakerSelectControl) per TheFab21.
- **Ambient mode** (source-code, low; read=true write=true live=false): samsungvd.ambient.setAmbientOn (no args), samsungvd.ambient18.setAmbientOn, samsungvd.ambientContent.setAmbientContent [id] with supportedAmbientApps attr
  - These are often listed in custom.disabledCapabilities; check that list first. The Q95T supports Ambient Mode, so these may be enabled there. There is no 'ambient off' command (exit with a key).
- **Universal search, PVR record, accessibility** (source-code, low; read=false write=true live=false): custom.tvsearch.search [query, url] (both required strings); custom.recording.recordStart / recordStop; custom.accessibility.setAccessibility [menuName, menuId, option?]
  - Argument values are undocumented (SmartThings staff say 'the value accepted by the device is unknown to us'). These need live experiments. Accessibility might allow 'Picture Off' (screen off with sound).
- **Identity / firmware / health** (official-doc, high; read=true write=false live=false): ocf attrs (n, mnmo, mnfv, vid, mnpv, mnos, mndt, di); samsungvd.firmwareVersion; samsungvd.deviceCategory; samsungvd.thingStatus {status:'Idle'|'AgentUpdate Started', updatedTime}; GET /v1/devices/{id}/health -> {state:'ONLINE'|'OFFLINE'|'UNHEALTHY'}
  - Good material for an 'About this TV' card: model, firmware (mnfv e.g. T-KTM2DEUC-...), platform, mndt year. Health is the reliable online signal.
- **Force cloud re-read (stale-state workaround)** (source-code, medium; read=false write=true live=false): refresh.refresh (no args)
  - TheFab21 says Samsung confirmed this is the recommended workaround; the SmartThings app does it when opened. Throttle to at most 1 per 60 s while the panel is confirmed on locally; to a sleeping TV it returns FAILED. It counts against the command rate limit.
- **Live push of state changes (SSE)** (official-doc, medium; read=true write=false live=true): POST https://api.smartthings.com/v1/sse/subscriptions {name, subscriptionFilters:[{type:'DEVICEIDS'|'LOCATIONIDS', value:[...], eventType:['DEVICE_EVENT','DEVICE_HEALTH_EVENT']}]} then GET registrationUrl with Accept: text/event-stream
  - Officially documented 2026-10-20 as a paid feature that needs a qualifying Developer or Business plan (403 otherwise) and the 'sse' scope. The CLI's OAuth-In scope list does not offer 'sse'; HA got it as a special grant. Limits: 2 active subscriptions per integration, 1 connection per token, 20 API calls/min, variable TTL, 'goodbye' control event, no resume. The legacy undocumented POST https://api.smartthings.com/subscriptions (used by openHAB with PATs and by HA) may still work, but whether it works with a self-made OAuth app is unverified. Webhook subscriptions (POST /v1/installedapps/{iaid}/subscriptions) need a public HTTPS target URL (tunnel). Even with a push channel, TV attributes only change when the TV reports them, so staleness remains.
- **Polling status (no public URL)** (official-doc, high; read=true write=false live=false): GET /v1/devices/{id}/status (all components) or /v1/devices/{id}/components/main/capabilities/{cap}/status
  - The official rate-limit page gives 12 req/min per device for get state and 12/min for commands. The API overview's 'observed' table gives GET status 350/60 s per device, POST commands 120/60 s per device, and GET /devices 1000/900 s. Responses carry x-ratelimit-limit/remaining/reset headers. Design for the conservative figure: one full status every 10-15 s only while a browser tab is open, then back off.
- **Auth for a self-hosted PC app (OAuth-In / API_ONLY app)** (official-doc, medium; read=true write=true live=false): npx @smartthings/cli apps:create -i app.json; authorize https://api.smartthings.com/oauth/authorize (or /v1/oauth/authorize); token POST https://auth-global.api.smartthings.com/oauth/token (or https://api.smartthings.com/v1/oauth/token) with HTTP Basic client_id:client_secret
  - Access token about 24 h (expires_in about 86399). Refresh token 30 days and single-use (each refresh returns a new pair; persist both atomically and never refresh concurrently). Refresh at least daily even when idle. Scopes: r:devices:* x:devices:* (+ r:locations:*; w:devices:* only for rename/delete). The response includes installed_app_id. Staff (Jun 2026) say OAuth integrations can only be created with the CLI, are limited to 500 installs, and a localhost redirect can give '403 Access forbidden to this app'. Use https://httpbin.org/get and paste the code (codes are single-use, about 5 min). New official 'API Access Apps' are listed as paid and 'coming soon'.
- **Personal Access Token** (official-doc, high; read=true write=true live=false): https://account.smartthings.com/tokens; header Authorization: Bearer <PAT>
  - Verified: PATs created after 30 Dec 2024 are valid 24 h (announcement 13 Dec 2024, release note 16 Jan 2025). Earlier PATs can last up to 50 years. They also get lower /devices rate limits. Fine for a one-day experiment, not for the product.
- **Energy saving level / power consumption** (source-code, low; read=true write=true live=false): custom.energyType.setEnergySavingLevel [int], attrs energySavingLevel, supportedEnergySavingLevels; powerConsumptionReport.powerConsumption
  - Only seen on 2022+ profiles (VD-STV-2022/2023, Frame 2024). Not in the 2018_K profile that 2018-2020 TVs report, so probably absent on the Q95T.

## Protocol details

## 0. Expected device shape for a 2020 Q95T (inferred)
- Public dumps: a 2020 Tizen 5.5 TU7172 reports `vid` **`VD-STV_2018_K`**; a 2019 Q60R dump from Oct 2026 shows `presentationId: VD-STV_2018_K`, `deviceTypeName: "Samsung OCF TV"`, `type: "OCF"`, `ocf.ocfDeviceType: "oic.d.tv"`.
- **Expected `main` component (27 capabilities):**
  - Standard: `ocf, switch, audioVolume, audioMute, tvChannel, mediaInputSource, mediaPlayback, mediaTrackControl, refresh, execute`
  - Custom: `custom.error, custom.picturemode, custom.soundmode, custom.accessibility, custom.launchapp, custom.recording, custom.tvsearch, custom.disabledCapabilities`
  - Samsung: `samsungvd.remoteControl, samsungvd.ambient, samsungvd.ambientContent, samsungvd.ambient18, samsungvd.mediaInputSource, samsungvd.deviceCategory, samsungvd.firmwareVersion, samsungvd.supportsPowerOnByOcf, sec.diagnosticsInformation`
- Newer profiles (2021+) add `samsungvd.thingStatus, samsungvd.supportsFeatures, samsungim.fixedFindNode, powerConsumptionReport`. 2022+ adds `custom.energyType`, `sec.deviceConnectionState` and sometimes `samsungvd.pictureMode` / `samsungvd.soundMode` / `samsungvd.lightControl`.
- No sub-components on TVs. A 2023+ Frame registers its light and sound sensors as separate devices.
- Always honour `custom.disabledCapabilities.disabledCapabilities` (e.g. `["samsungvd.ambient18","samsungvd.ambientContent","sec.diagnosticsInformation"]`).
- Live-tv hint from the task facts: DMR ProductCap contains `OCF=1`.

## 1. Auth (self-hosted, Oct 2026)

**One-time app creation (Node available):** `npx --yes @smartthings/cli apps:create -i st-app.json -o st-app-created.json -j`
```json
{"appName":"tvremote-<unique>","displayName":"TV Remote","description":"Local web remote","appType":"API_ONLY",
 "classifications":["CONNECTED_SERVICE"],"singleInstance":true,
 "oauth":{"clientName":"TV Remote","scope":["r:devices:*","x:devices:*","r:locations:*"],
          "redirectUris":["https://httpbin.org/get","http://localhost:47811/callback"]}}
```
- Interactive mode: choose "OAuth-In App". The CLI only offers OAuth-In, `appType` API_ONLY, `principalType` LOCATION.
- The CLI scope list is: `r/w/x:devices:*`, `r:hubs:*`, `r/w/x:locations:*`, `r/x:scenes:*`, `r/w:rules:*`, `r/w:installedapps`. There is **no `sse`**.
- The CLI validator allows `http://localhost`, but staff confirm localhost redirects can 403. Use httpbin and have the user paste the URL/code.
- Save `oauthClientId` and `oauthClientSecret`; the secret is shown once.

**Authorize:**
`https://api.smartthings.com/oauth/authorize?client_id={cid}&response_type=code&redirect_uri=https%3A%2F%2Fhttpbin.org%2Fget&scope=r%3Adevices%3A*%20x%3Adevices%3A*%20r%3Alocations%3A*&state={rand}`
- The new docs spell it `/v1/oauth/authorize`.
- Requesting a scope that is not on the app gives an error.

**Token exchange** (credentials MUST be HTTP Basic; credentials in the body give `invalid_grant`):
```
POST https://auth-global.api.smartthings.com/oauth/token      (docs: https://api.smartthings.com/v1/oauth/token)
Authorization: Basic base64(clientId:clientSecret)
Content-Type: application/x-www-form-urlencoded
grant_type=authorization_code&code={code}&client_id={cid}&redirect_uri=https%3A%2F%2Fhttpbin.org%2Fget
```
Response:
`{access_token, token_type:"bearer", refresh_token, expires_in:86399, scope, installed_app_id, access_tier, ...}`

**Refresh** (single-use; store both new tokens atomically; one refresher at a time; run at least daily or the 30-day refresh token dies):
`grant_type=refresh_token&refresh_token={rt}&client_id={cid}` with the same Basic header.

**Node library:** `@smartthings/core-sdk` `SmartThingsClient` + `RefreshTokenAuthenticator` (used by homebridge-smartthings-tv). Plain `fetch` is also fine.

**PAT:** 24 h if created after 2024-12-30. Use only for experiments.

**Paid-API transition:**
- Samsung blog (2026-06-23): free access through Q3; from Oct 2026 new usage limits and a $4.99/mo personal plan.
- The docs now define **402 Payment Required** (plan missing, lapsed or over quota). Do not retry 402s in a loop.
- Surface the 402 in the UI, then degrade to LAN-only.

## 2. REST endpoints
Headers: `Authorization: Bearer {at}`, `Accept: application/json`, plus `Content-Type: application/json` on POST.
- `GET https://api.smartthings.com/v1/locations`
- `GET /v1/devices?capability=samsungvd.remoteControl` (or `?locationId=`). Pick `deviceTypeName=="Samsung OCF TV"` or `ocf.ocfDeviceType=="oic.d.tv"`. Match to the LAN TV by `ocf` `mnmo` / name. The deviceinfo `x.com.samsung.tv.duid` would also match the REST DUID, but treat it as sensitive and don't store or log it.
- `GET /v1/devices/{id}` (profile and capability list)
- `GET /v1/devices/{id}/status`
- `GET /v1/devices/{id}/components/main/capabilities/{cap}/status`
- `GET /v1/devices/{id}/health` → `{"state":"ONLINE"}`
- `POST /v1/devices/{id}/commands` with `{"commands":[{"component":"main","capability":...,"command":...,"arguments":[...]}]}`. At most 10 commands per request.
- Response: `{"results":[{"id":"…","status":"ACCEPTED"|"COMPLETED"|"FAILED"}]}`. FAILED means the cloud could not reach the TV.
- Errors: `{"requestId","error":{"code","message","details"}}`.
  - 401: refresh the token.
  - 402: payment required.
  - 403: scope or plan.
  - 409: device offline or wrong state (e.g. setPictureMode while switch=off).
  - 422: capability absent or guardrail.
  - 429: back off using `x-ratelimit-reset`.
- `GET /v1/capabilities/{capId}/1` returns the capability definition (what the CLI's `capabilities <id> -j` prints).

## 3. Command payloads (component always "main")
```json
{"capability":"switch","command":"on"}
{"capability":"audioVolume","command":"setVolume","arguments":[15]}
{"capability":"audioVolume","command":"volumeUp"}
{"capability":"audioMute","command":"setMute","arguments":["muted"]}
{"capability":"custom.picturemode","command":"setPictureMode","arguments":["Movie"]}
{"capability":"custom.soundmode","command":"setSoundMode","arguments":["Standard"]}
{"capability":"samsungvd.mediaInputSource","command":"setInputSource","arguments":["HDMI1"]}
{"capability":"mediaInputSource","command":"setInputSource","arguments":["digitalTv"]}
{"capability":"tvChannel","command":"setTvChannel","arguments":["5"]}
{"capability":"custom.launchapp","command":"launchApp","arguments":["111299001912"]}
{"capability":"custom.launchapp","command":"launchApp","arguments":[null,"Netflix"]}
{"capability":"samsungvd.remoteControl","command":"send","arguments":["OK","PRESS_AND_RELEASED"]}
{"capability":"samsungvd.remoteControl","command":"send","arguments":["UP","PRESSED"]}
{"capability":"samsungvd.remoteControl","command":"send","arguments":["UP","RELEASED"]}
{"capability":"samsungvd.ambient","command":"setAmbientOn"}
{"capability":"custom.tvsearch","command":"search","arguments":["<query>",""]}
{"capability":"refresh","command":"refresh"}
{"capability":"execute","command":"execute","arguments":["/sec/tv/deviceinfo"]}
{"capability":"execute","command":"execute","arguments":["/sec/tv/inputsource",{"x.com.samsung.tv.currentMode":"dtv"}]}
```
- The last line is unverified on TVs. It is adapted from the legacy `postOcfCommand` log, which wrapped the value as `["dtv"]`.

**Picture mode:**
- Send the display NAME from `supportedPictureModes` (localized).
- If the read-back after about 5 s (refresh, then GET) doesn't match, retry with the `supportedPictureModesMap` id (`modeMovie`).
- `samsungvd.pictureMode` will 422 on the 2018_K profile.

**Execute read pattern:**
1. POST the execute command.
2. Wait about 1 s.
3. `GET .../capabilities/execute/status`. Response shape:
   `{"data":{"value":{"payload":{"rt":["x.com.samsung.tv.deviceinfo"],"if":[...],"x.com.samsung.tv.year":2023,"x.com.samsung.tv.paneltime":197,...}},"data":{"href":"/sec/tv/deviceinfo"},"timestamp":"…"}}`
- There is one shared slot, so serialize execute calls and check `data.data.href` matches.
- Strip `x.com.samsung.tv.sn`, `duid`, `*mac`, `udn`, `setupid` before anything is displayed or logged.

**Candidate hrefs** (2020 TU7172 `/oic/res`):
- Settings-like: `/sec/tv/mode/picture`, `/sec/tv/mode/sound`, `/sec/tv/optioncontrol`, `/sec/tv/uicontrol`, `/sec/tv/showmenu`
- Content and state: `/sec/tv/contentinfo`, `/sec/tv/contentinfo/thumbnail`, `/sec/tv/audio`, `/sec/tv/channel`, `/sec/tv/inputsource`, `/sec/tv/mediaInput`, `/sec/tv/msoinfo`, `/sec/tv/onsupport`
- Actions: `/sec/tv/launchapp`, `/sec/tv/launchnativeapp`, `/sec/tv/remotecontrol`, `/sec/tv/ime`, `/sec/tv/searchall`

**Discovery trick:** change a setting in the SmartThings phone app's TV panel, then read execute status to see the href and payload it used.

## 4. Live updates
- **Without a paid plan:** poll. Example cadence:
  - One full `/status` every 10-15 s while a UI client is connected; 60 s or stop when idle.
  - `refresh` at most every 60 s, and only when local REST PowerState=='on'.
  - Re-read the specific capability 3-5 s after each command.
  - Budget against 12 req/min/device for state and 12 for commands (conservative official table).
- **With a plan:** SSE.
  1. `POST https://api.smartthings.com/v1/sse/subscriptions` (send a descriptive `User-Agent`).
  2. Within 1 min, `GET registrationUrl` with `Accept: text/event-stream`.
  3. First event is `event: CONTROL_EVENT` / `data: welcome`.
  4. Events look like `event: DEVICE_EVENT` with `data: {"eventType":"DEVICE_EVENT","deviceEvent":{"deviceId","componentId":"main","capability":"audioVolume","attribute":"volume","value":12,"stateChange":true}}`.
  5. On `goodbye`, create a new subscription. After reconnecting, reconcile with GET `/status`.
  - Limits: 1 connection per token, 2 subscriptions per integration, 20 calls/min.
- **Webhooks:** `POST /v1/installedapps/{installed_app_id}/subscriptions` `{"sourceType":"DEVICE","device":{"deviceId":"…","componentId":"main","capability":"*","attribute":"*","stateChangeOnly":true,"subscriptionName":"tv_all"}}`.
  - Needs the app's targetUrl to be public HTTPS (tunnel) and to answer the CONFIRMATION and HTTP-signature lifecycle.

## 5. Gotchas
- Cloud volume, mute and input can be minutes to weeks stale. Show a "via cloud, as of {timestamp}" badge from each attribute's `timestamp` and prefer LAN reads (UPnP RenderingControl GetVolume/GetMute on 9197, already live-verified).
- `switch` may say 'on' after the TV goes to standby. Cross-check local REST PowerState and `/health`.
- `supportedPictureModes` changes with input and HDR. Re-read it on every poll and on source change.
- A COMPLETED status does not prove the TV applied the change. Verify by reading back.
- `setVolume` via cloud unmutes the TV (awake report).
- `tvChannelName` doubles as the foreground app id (e.g. `9Ur5IzDKqV.TizenYouTube`) and can feed a "Now on screen" tile.
- Remote keys via cloud are rate-limited (≤12/min conservative) and slow. Use them only as a fallback.
- The `execute` and `ocf` capabilities are marked deprecated.
- TVs that are not in the user's SmartThings account need to be added with the phone app first.

## Risks

- SmartThings API monetization: Samsung said free access ends from October 2026 (today is 2026-10-21) with a $4.99/month personal plan and unpublished quotas. Calls may start returning 402 Payment Required at any time, so the design must degrade gracefully to LAN-only.
- SSE push is officially a paid feature (Developer/Business plan) that requires an 'sse' scope the CLI cannot grant. A free self-hosted app can only poll, so cloud-sourced fields are near-real-time at best.
- State staleness: volume, mute, input, switch and picture mode can lag by minutes to weeks unless a 'refresh' command is sent; 'switch' can read 'on' after standby. Treating cloud values as live would show wrong numbers.
- Write commands can return COMPLETED without the TV applying them. This is seen for picture and sound mode on several models and with self-published OAuth clients, so every write needs a verify-by-readback loop.
- Rate limits: the official table gives 12 req/min per device for status and 12 for commands. Fast remote use or slider drags will hit 429.
- OAuth-In app creation is only possible through the CLI. Localhost redirects are known to 403 on some accounts. Refresh tokens are single-use and expire after 30 days (some die earlier), and concurrent refreshes invalidate each other. Samsung is moving registration to paid 'API Access Apps', which may close the free OAuth-In path.
- The execute and ocf capabilities are deprecated, and TV OCF payload formats beyond /sec/tv/deviceinfo are undocumented. Any picture or settings control built on them is speculative and may disappear.
- No SmartThings route to backlight, brightness, contrast, sharpness, colour, tone, EQ or balance exists. The user's 'brightness levels' requirement must come from local IP Control (port 1516, unverified on this TV), menu-navigation macros, or tracked or estimated state.
- Privacy: the /sec/tv/deviceinfo payload and the TV's ocf data include serial number, DUID and Wi-Fi/Ethernet/BT/BLE/P2P MACs. These must never be logged, displayed or written to disk.
- Power-on via cloud depends on 'Power On with Mobile' being enabled and on the TV keeping its cloud link in standby. Routers that drop idle clients can break it, and latency is unmeasured.
- The Q95T may not even be registered in the user's SmartThings account, and its actual profile (VD-STV_2018_K is assumed) and disabled capabilities are unverified.

## Open questions

- Is the Q95T registered in the user's SmartThings account, and what do GET /v1/devices/{id} and /status actually return? Specifically: presentationId/vid (VD-STV_2018_K expected), supportsPowerOnByOcf, disabledCapabilities, and whether samsungvd.thingStatus or samsungvd.supportsFeatures exist.
- Does the user accept a SmartThings paid plan ($4.99/month personal), and is free API access still working for their account today? Only a call with their token can tell (watch for 402).
- Can a CLI-created OAuth-In app still be created and authorized on this account in Oct 2026? Does httpbin.org/get work as the redirect and does http://localhost get the 403?
- Do execute reads of /sec/tv/mode/picture, /sec/tv/optioncontrol, /sec/tv/uicontrol, /sec/tv/contentinfo and /sec/tv/audio return payloads on this TV via the cloud? These are read-only and need no on-screen interaction, but need the user's token.
- Does custom.picturemode setPictureMode actuate the Q95T panel with a self-made OAuth client, and in name form or id form?
- How stale is cloud volume after a physical-remote change, with and without a preceding refresh? Measure the timestamp deltas.
- Is 'Power On with Mobile' enabled on the TV, and what is the measured switch.on latency from standby?
- Cross-area: is TCP 1516 (Samsung IP Control JSON-RPC) open on 192.168.1.2 once 'IP Remote' is enabled in Settings > General > Network > Expert Settings? Do getVideoStates and backlightControl answer on a 2020 Q95T? Pairing pops an on-screen prompt, so it needs the user's consent.
- Does the legacy undocumented POST https://api.smartthings.com/subscriptions SSE endpoint (used by openHAB with PATs) still accept a self-made OAuth token without the 'sse' scope? This is unlikely, but cheap to test once.
