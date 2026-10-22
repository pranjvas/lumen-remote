# Research area: ws-remote

## Summary

I did not contact the TV for this area. Everything below comes from open-source client code, official Samsung documents, GitHub issues and one decompile write-up of a 2025 Samsung TV's firmware. I also built a reference Node 22 client and ran it against a localhost mock of the TV's handshake, built from those sources (C:/Users/pranj/AppData/Local/Temp/tvremote-research/ws-remote/sketch/). The mock run passed: pairing, reconnect with token, unauthorized, heartbeat, text-input decoding and the KEY_POWER guard. On a 2020 TV that reports TokenAuthSupport (ours does), the only working control socket is wss://192.168.1.2:8002/api/v2/channels/samsung.remote.control?name=<base64 name>&token=<token>; port 8001 answers ms.channel.unauthorized. Connecting without a token shows an Allow/Deny prompt on the TV. Allow returns an 8-digit token in ms.channel.connect. Later connects may return no token, the same token, or a new one, so always save the newest. A missed new token makes the prompt reappear on every connect. Deny is remembered (fix it in the TV's Device Connection Manager > Device List). Wrong subnet, standby or a firmware lock-down returns ms.channel.timeOut. The TV sends WebSocket pings about every 6 s, so a dead link can be detected within about 10 s. Keys are fire-and-forget ms.remote.control SendRemoteKey messages with Cmd Click, Press or Release. The TV never acknowledges a key, ignores unknown keys silently, and repeats a held key itself. The socket mirrors the on-screen keyboard: ms.remote.imeStart, imeUpdate (current text in base64), imeEnd and imeDone. SendInputString replaces the whole text field, and SendInputEnd presses Done. The pointer uses ProcessMouseDevice with relative Move plus LeftClick/RightClick, and only works while the TV has sent ms.remote.touchEnable. No scroll command is known. The EDEN socket calls (ed.installedApp.get, ed.apps.icon, ed.edenApp.get) reportedly get no reply on 2020 Tizen 5.5 sets (TU7079, Q64T, Q70T, Q90T). So the app list must come from probing known app IDs, a curated list, or a companion app on the TV. App launch is most reliable via REST POST /api/v2/applications/<id> with body {}; app state comes from GET (field 'visible'). No WebSocket channel carries volume, power, picture or backlight state. That state has to come from UPnP on port 9197, REST PowerState, SmartThings, or a companion app on the TV (it can talk over a custom Smart View channel or connect out to the PC). One lead outside this area: Samsung's official consumer IP Control (HTTPS JSON-RPC on port 1516 for 2020+ models, enabled via General > Network > Expert Settings > IP Remote) exposes backlightControl, directVolumeControl and getTVStates. That could provide the 'unavailable' settings, but the port has not been checked on this TV.

## Capabilities

- **Pair and authenticate (token issue, persist, reuse)** (source-code, high; read=true write=false live=false): wss://192.168.1.2:8002/api/v2/channels/samsung.remote.control?name=<b64(name)>[&token=<token>]; read token from ms.channel.connect data.token, falling back to data.clients[id==data.id].attributes.token
  - First connect without a token shows Allow/Deny on the TV. The user has about 30 s (openHAB docs; HA waits 31 s). Allow returns ms.channel.connect with data.token, an 8-digit string (a number in some fixtures). A reconnect with a valid token may return no data.token (token echoed in clients[].attributes.token), the same token, or a NEW one. Persist whenever it differs; failing to persist caused re-prompts on every boot (HA #54027, ollo69 #169). Deny or a forgotten token gives ms.channel.unauthorized. Standby, wrong subnet or a firmware lock gives ms.channel.timeOut. Other events such as ms.remote.touchDisable, ed.edenTV.update and ms.voiceApp.hide can arrive before ms.channel.connect and must be ignored during the handshake (HA #54027 log). ws://...:8001 on TokenAuthSupport TVs returns ms.channel.unauthorized (HA log); openHAB says secure websocket is mandatory when supported. Keep the client name constant: the token belongs to the name. Tokens can be lost after long power-off or firmware updates.
- **Avoid re-prompting / manage the Allow prompt** (community, medium; read=false write=false live=false): TV setting Settings > General > External Device Manager > Device Connection Manager > Access Notification = 'First Time Only' (or Off); Device List to Allow/Delete an entry; client side: stable name, always save the newest token, never auto-reconnect without a token
  - samsungtvws README says newer TVs default to asking on every connection unless Access Notification is 'First Time Only'. tavicu suggests Off. Deny is remembered until changed in Device List. A client on another subnet or VLAN never sees a prompt and gets ms.channel.timeOut. Because someone may be watching, pairing must be a deliberate 'Pair' button in the UI, not something done automatically.
- **Connection keepalive / dead-link detection / reconnect** (source-code, medium; read=true write=false live=true): TV sends WebSocket ping frames (payload \x00) about every 6 s; client auto-pongs (npm ws does this); treat >10-12 s silence as dead; optional client ping every 20-60 s
  - Reference timeouts: tavicu 8 s ('6 ping + 2'), ollo69 10 s (MAX_WS_PING_INTERVAL), Clicky client ping every 20 s, openHAB client ping every 4 min ('avoid 5 minute idle timeout'). samsungtvws issue #105 debug log shows TV PING frames. Only (re)connect while REST GET /api/v2/ reports PowerState=='on': HA notes that opening the socket can turn some TVs on. Back off 1/2/5/10/30 s. No documented client limit; run one TV socket in the PC hub and fan out to browsers.
- **Send remote key (tap)** (source-code, high; read=false write=true live=false): {"method":"ms.remote.control","params":{"Cmd":"Click","DataOfCmd":"KEY_*","Option":"false","TypeOfRemote":"SendRemoteKey"}}
  - Identical in every client library (samsungtvws, HA, ollo69, openHAB, Toxblh, tavicu, ColorControl). The 2025 firmware decompile maps it to remote_control_send_key_event. No acknowledgement; unknown KEY_ names are silently ignored (couch-remote: KEY_HDMI1/2, KEY_APP_LIST, KEY_CONTENTS had no effect on a 2021 Q65A). Errors only appear as ms.error. Spacing: about 100-150 ms for UI taps, 300-500 ms inside macros (openHAB 300 ms, tavicu 400 ms, ollo69 500 ms default, 200 ms minimum).
- **Long press / hold key** (source-code, medium; read=false write=true live=false): Cmd "Press" ... wait ... Cmd "Release" with the same DataOfCmd
  - The TV auto-repeats while a key is held: 2 s of KEY_VOLUP raised volume by 30 on a 2021 TV, and Press+Release 80 ms apart counts as one step (couch-remote). Known holds: KEY_RETURN 3 s exits a streaming app (openHAB); KEY_EXIT 3 s (openHAB stopBrowser); KEY_POWER 3 s on Frame TVs = real power-off (HA, ollo69); KEY_BT_VOICE Press starts and Release stops voice (samsungctl 0.8). Holding Power on the physical remote until the logo appears restarts the TV (tavicu docs), so cap KEY_POWER holds at about 1 s on this non-Frame TV. Always send Release, including on pointercancel/blur and after a reconnect.
- **Text input to focused TV field** (source-code, medium; read=false write=true live=false): {"method":"ms.remote.control","params":{"Cmd":"<base64 utf8>","DataOfCmd":"base64","TypeOfRemote":"SendInputString"}} then {"method":"ms.remote.control","params":{"TypeOfRemote":"SendInputEnd"}}
  - SendInputString REPLACES the field contents (couch-remote, 2021): live typing must resend the whole string, debounced. SendInputEnd presses the keyboard's Done. Each SendInputString is answered by ms.remote.imeDone 'disable' then 'enable'. samsungtvws (Feb 2026) first broadcasts {"method":"ms.channel.emit","params":{"event":"custom.remote.textReceived","to":"broadcast"}} because 'some TVs require' it; optional, unverified. It also has a REST variant POST /api/v2/remoteControl/imeInput/<b64>?token=<token> for passwords; unverified (the decompile lists the handler path as /remoteControl/imeInput/).
- **Detect and mirror the on-screen keyboard (IME state)** (source-code, medium; read=true write=false live=true): TV->client events: ms.remote.imeStart {data:<input type e.g. 'url'>, entrylimit:2048}; ms.remote.imeUpdate {data:<base64 current text>, entrylimit}; ms.remote.imeEnd; ms.remote.imeDone {data:'enable'|'disable'}
  - Real payloads are recorded in comments in dobrou/remote.html. openHAB and the 2025 decompile list the same four events, and our TV reports ImeSyncedSupport 'true'. UI: imeStart opens a text sheet (type and maxlength from data/entrylimit); imeUpdate sets the field from atob(data), suppressing the echo of our own sends; imeEnd closes it. Possible privacy issue: imeUpdate may echo password-field text.
- **Pointer / touchpad (mouse move and click)** (source-code, medium; read=false write=true live=true): {"method":"ms.remote.control","params":{"Cmd":"Move","Position":{"x":dx,"y":dy,"Time":"0"},"TypeOfRemote":"ProcessMouseDevice"}}; {"method":"ms.remote.control","params":{"Cmd":"LeftClick"|"RightClick","TypeOfRemote":"ProcessMouseDevice"}}
  - Move is RELATIVE, in roughly 1920x1080 units (about 250 = 1/8 of the width); negative values go left and up (couch-remote). The samsungtvws example multiplies drag deltas by 5. Time is a string and seems ignored ('0' or a timestamp both used). Works only while the TV has sent ms.remote.touchEnable (e.g. the Internet browser); openHAB blocks Move when touchDisable is active. The 2025 decompile also lists LeftPress/LeftRelease plus a virtual-mouse scroll routine, payload unknown. No public scroll command: in the TV browser use KEY_CHUP/KEY_CHDOWN Press/Release as page scroll (dobrou). CreateTouchDevice/ProcessTouchDevice/DestroyTouchDevice exist; payloads unknown.
- **Installed app list over the socket** (community, medium; read=false write=false live=false): {"method":"ms.channel.emit","params":{"event":"ed.installedApp.get","to":"host"}} -> {"event":"ed.installedApp.get","from":"host","data":{"data":[{"appId","app_type":2|4,"icon":"/opt/share/webappservice/apps_icon/FirstScreen/<id>/250x250.png","is_lock":0,"name"}]}}
  - No reply reported on 2020 Tizen 5.5 TVs: GU65TU7079 (samsungtvws #23, maintainer 'Tizen 5 dont support this command anymore'), Q90T (#99, ed.edenApp.get also silent), QE65Q64T with the same API version 2.0.25 as ours (#105), Q70T (ollo69 #27), 2021 Q65A (couch-remote). openHAB: automatic app discovery only works before 2020. Design: probe a curated list of known store/package IDs with REST GET (the 404/visible JSON tells installed vs running), let the user edit the list, or get the real list from a companion app on the TV / developer-mode sdb vd_applist (outside this area).
- **App icon fetch** (source-code, low; read=true write=false live=false): {"method":"ms.channel.emit","params":{"event":"ed.apps.icon","to":"host","data":{"iconPath":"<icon path from installed list>"}}} -> {"event":"ed.apps.icon","data":{"iconPath","imageBase64":"..."}}
  - Needs icon paths from the installed-app list, which 2020 does not return. couch-remote saw no reply on 2021. Ship bundled/fetched logos instead (ollo69 and tavicu use logo files).
- **Launch app** (source-code, medium; read=false write=true live=false): Preferred: REST POST http://192.168.1.2:8001/api/v2/applications/<appId>/ with Content-Type application/json, body {} -> true. Alternatives: ws ed.apps.launch on the remote channel; ms.application.start on the /api/v2 socket
  - REST POST is what the official Smart View JS SDK does (msf-2.0.23 Application.start: POST applications/<id> with body '{}'). tavicu: send '{}' because some TVs return a malformed reply for Content-Length 0. couch-remote: works without pairing on 2021. Both store IDs (e.g. 111299001912) and Tizen package IDs are accepted. ws form: {"method":"ms.channel.emit","params":{"event":"ed.apps.launch","to":"host","data":{"appId":"<id>","action_type":"DEEP_LINK"|"NATIVE_LAUNCH","metaTag":"<optional>"}}}; success reply {"data":200,"event":"ed.apps.launch","from":"host"}. Use DEEP_LINK for app_type 2 and NATIVE_LAUNCH for 4 (e.g. org.tizen.browser); a wrong type closed the socket with status 31522 in 2018. Ignored on a 2021 TV; openHAB says the ed.* events do not work on '>2020' TVs. /api/v2 socket: {"id":"<id>","method":"ms.application.start","params":{"id":"<id>"}} (openHAB: '2020 TVs and later use webSocketV2 for app launch'). Whether metaTag deep links are honoured depends on the app. The trailing slash is suggested because GET needs it on this TV; POST behaviour unverified.
- **Current / foreground app detection** (source-code, medium; read=true write=false live=false): REST GET http://192.168.1.2:8001/api/v2/applications/<id>/ -> {"id","name","running","version","visible"} (404 JSON if not installed); or ws /api/v2: {"id":"<id>","method":"ms.application.get","params":{"id":"<id>"}} -> {"id":"<id>","result":{"id","name","running","visible"}}
  - No push event for app changes on 2020; ed.edenTV.update {"update_type":"ed.edenApp.update"} was the old hint. Poll the user's known app IDs gently: visible:true = foreground. System screens (Apps, Settings) and HDMI/TV sources return 404, so 'nothing visible' means Live TV, an HDMI source or a system UI. Web apps use ms.webapplication.get. REST GET is read-only and another agent may verify it live; the /api/v2 socket is unverified (may need auth or pop a prompt).
- **Close app** (source-code, low; read=false write=true live=false): REST DELETE http://192.168.1.2:8001/api/v2/applications/<id>/ ; or ws /api/v2 {"id":"<id>","method":"ms.application.stop","params":{"id":"<id>"}} ; fallback: hold KEY_RETURN 3 s or KEY_EXIT
  - REST DELETE is documented by 2018 users and the libraries but untested on 2020; the claim that it is 'often broken on 2020' is unverified. On the samsung.remote.control channel ms.application.stop is rejected with {"event":"ms.error","data":{"message":"unrecognized method value : ms.application.stop"}} (samsungtvws fixture), so it belongs on the /api/v2 socket (openHAB, MSF SDK). openHAB falls back to a 2 s KEY_EXIT press. REST PUT opens the app's store page.
- **Open URL in TV browser** (source-code, low; read=false write=true live=false): ws ed.apps.launch {appId:'org.tizen.browser', action_type:'NATIVE_LAUNCH', metaTag:'<url>'} ; REST POST http://IP:8001/api/v2/webapplication/ {"url":"<url>"}
  - samsungtvws open_browser uses the ws form; the REST webapplication form was reported working in 2018. openHAB: on post-2016 TVs the browser may open without filling in the URL, then the URL is typed via SendInputString. Browser store IDs on 2019/2020+ include 3201907018784 and 3202010022079.
- **Voice (Bixby) trigger and voice UI state** (source-code, low; read=true write=true live=true): Press/Release KEY_BT_VOICE; TV->client ms.voiceApp.standby / recording / processing / hide
  - samsungctl 0.8 waits for ms.voiceApp.standby after Press and ms.voiceApp.hide after Release. The 2025 decompile lists all four events plus an ms.voice.control method (payload unknown). This only opens the TV's own voice UI, which listens on the TV/remote mic; streaming PC audio is unknown.
- **Other-remote awareness (who else is connected)** (source-code, medium; read=true write=false live=true): ms.channel.connect data.clients[]; events ms.channel.clientConnect / ms.channel.clientDisconnect with data = {attributes:{name}, connectTime, deviceName, id, isHost}
  - Lets the UI show 'phone remote connected' (e.g. the SmartThings app). deviceName is the base64 name, or 'Smart Device' when the client sent none (dobrou sample).
- **Volume / mute / power / picture / backlight state over WebSocket** (source-code, high; read=false write=false live=false): none on samsung.remote.control (no state events)
  - No library reads volume, power or picture state from this socket. Volume is read via UPnP RenderingControl on port 9197 (couch-remote, tavicu GENA) and power via REST PowerState; the volume buttons can only step via KEY_VOLUP/DOWN. Picture and backlight have no WebSocket path on a non-Frame TV; the art channel has Art Mode brightness only, and our FrameTVSupport is false. Leads for 'unavailable options': (a) Samsung consumer IP Control, HTTPS JSON-RPC on port 1516 for 2020+ (official worksheet: enable Settings > General > Network > Expert Settings > IP Remote; the TV shows a notification when pairing), with backlightControl, directVolumeControl, getTVStates, getVideoStates, pictureModeControl (per the 2025 decompile); (b) a companion Tizen app on the TV pushing state; (c) SmartThings.
- **Custom Smart View (MSF) channel for an on-TV companion app** (official-doc, medium; read=true write=true live=true): TV app: msf.local((err,svc)=>{const ch=svc.channel('com.pv.remote'); ch.connect(...); ch.on('clientConnect',c=>ch.publish('state',data,c.id))}); PC: ws://192.168.1.2:8001/api/v2/channels/com.pv.remote?name=<b64> and send {"method":"ms.channel.emit","params":{"event":"<name>","data":<any>,"to":"host"|"broadcast"|"all"|<clientId>}}
  - Official Samsung receiver-app docs say: include msf-2.0.x.min.js, call msf.local(), service.channel(id).connect(), handle clientConnect, publish(). msf-server relays ms.channel.emit; custom events must not start with 'ms.'. Messages arrive as {"event","data","from"}. Binary messages are a 2-byte JSON length + JSON + payload. Unknown: whether PC clients on a custom channel trigger the Allow prompt, and whether msf.local works for an app signed with a distributor certificate. A simpler option: the companion app opens an OUTBOUND WebSocket to the PC hub (needs the http://tizen.org/privilege/internet privilege), with no MSF and no prompt.
- **Additional system channels (gamepad, mobilebff quick settings, art)** (inferred, low; read=true write=true live=true): /api/v2/channels/samsung.gamepad.control (ms.gamepad.control); /api/v2/channels/com.samsung.tv.mobilebff (ms.channel.emit event '/sec/tv/appdata/mobilebff', data '{"version":"0.2","id":"get.settings.data","seqId":"1","params":{}}'); /api/v2/channels/com.samsung.art-app (Frame only)
  - Seen only in a 2025 Frame (Tizen 9) firmware decompile. mobilebff offers get.settings.data (quick settings), request.vconf.info.int/bool/string (reads a vconf key and broadcasts changes), and get.apptiles/get.extsources. If present on Tizen 5.5 it could expose settings state, but it is probably newer than 2020. Not usable here without a live probe and user consent. Our TV reports GamePadSupport true; the gamepad channel is not needed for a remote.

## Protocol details

## 0. Scope and evidence
No TV contact was made. The tags below are the evidence classes (source-code, community, official-doc, inferred). The reference client `C:/Users/pranj/AppData/Local/Temp/tvremote-research/ws-remote/sketch/samsung-remote.mjs` (Node 22.18 + `ws` 8.21, copied into the scratch folder) passed an offline mock test (`mock-test.mjs`, localhost only). Results: pairing returned the token; reconnect picked the token up from `clients[].attributes.token`; a bad token gave `UNAUTHORIZED`; the heartbeat survived pings; `imeUpdate` decoded `héllo`; a 4 s KEY_POWER hold was refused.

## 1. Connection
```
wss://192.168.1.2:8002/api/v2/channels/samsung.remote.control?name=UFYgVFYgUmVtb3Rl[&token=NNNNNNNN]
```
- **`name`** is base64 of the UTF-8 client name. It is shown in the Allow prompt and in Device List.
  - Pick a name whose byte length is a multiple of 3 so there is no `=` padding ("PV TV Remote" gives `UFYgVFYgUmVtb3Rl`). Otherwise percent-encode `=` as `%3D`; the TV accepts both (ollo69 log).
  - Never change the name later: the token belongs to the name.
- **Port 8001** (`ws://`, same path) returns `ms.channel.unauthorized` on TokenAuthSupport TVs (HA debug log). openHAB says wss is mandatory when supported.
- **TLS**: the certificate is self-signed with `CN=SmartViewSDK` (openHAB README).
  - Node `ws` options: `{rejectUnauthorized:false, servername:'', handshakeTimeout:5000, perMessageDeflate:false}`.
  - Optional trust-on-first-use pinning: `ws.on('upgrade', r => r.socket.getPeerCertificate().fingerprint256)`.
  - If the handshake fails under OpenSSL 3, retry with `ciphers:'DEFAULT:@SECLEVEL=0'`. openHAB enables legacy cipher suites by default for older TVs.
- **Gate every connect on REST state.** First call `GET http://192.168.1.2:8001/api/v2/` and require `device.PowerState === "on"`. HA notes that opening the socket can wake some TVs; in standby you get `ms.channel.timeOut`.

### Handshake (server to client)
These may arrive first and must be ignored while waiting for connect:
```
{"event":"ms.remote.touchDisable"}
{"event":"ed.edenTV.update", ...}
{"event":"ms.voiceApp.hide"}
```
Success:
```
{"event":"ms.channel.connect","data":{"id":"<my uuid>","token":"16642390",
  "clients":[{"attributes":{"name":"<b64>","token":"17636368"},"connectTime":1654698939419,
              "deviceName":"<b64>","id":"<uuid>","isHost":false}]}}
```
- **Token to save**: `data.token ?? clients.find(c=>c.id===data.id).attributes.token`. Save it whenever it differs from the stored one. The TV may hand out a new token on a reconnect; HA bug #54027 and ollo69 #169 caused a prompt on every boot by not saving it.
- **`{"event":"ms.channel.unauthorized"}`**: Deny was pressed, or the token/name was forgotten. Stop and show "Re-pair". Do not loop without a token, because every attempt pops the prompt.
- **`{"event":"ms.channel.timeOut"}`**: TV in standby, PC on another subnet/VLAN (no prompt is shown), or a firmware lock-down (xchwarze #184, 2026 G80SD firmware).
- **Timers**: about 35 s while pairing (the user has ~30 s to press Allow), 10 s otherwise.
- **TV settings**: Settings > General > External Device Manager > Device Connection Manager.
  - Access Notification = "First Time Only" (or Off).
  - Device List: Allow or delete the entry.

### Keepalive and reconnect
- The TV sends a ping frame (payload `\x00`) about every 6 s. `ws` answers with pongs automatically.
- Treat more than 12 s without a ping or message as a dead link: `terminate()`.
- Reconnect backoff: 1, 2, 5, 10, 30 s, only while `PowerState === "on"`. Poll REST every 5-10 s otherwise.
- There is no documented client limit. Keep one TV socket in the PC hub and fan out to browsers over your own WebSocket.

## 2. Keys
```
{"method":"ms.remote.control","params":{"Cmd":"Click|Press|Release","DataOfCmd":"KEY_VOLUP","Option":"false","TypeOfRemote":"SendRemoteKey"}}
```
- There is no acknowledgement, and unknown keys are ignored silently. Errors only come as `{"event":"ms.error","data":{"message":"..."}}`.
- **Hold**: send Press, then Release. The TV repeats the key while it is held (about 15 steps per second after the initial delay on 2021). A quick 80 ms Press+Release counts as one step.
- **Always release**: send Release on browser pointerup, pointercancel and visibilitychange, and for any key still marked held after a reconnect.
- **Known holds**:
  - RETURN 3 s: exits a streaming app.
  - EXIT 3 s: exits to TV.
  - POWER 3 s: real power-off on Frame TVs. Holding the physical Power button until the logo appears restarts the TV, so cap KEY_POWER at about 1 s.
  - BT_VOICE: Press starts voice, Release stops it.
- **Macro spacing**: 300-500 ms between keys, plus explicit waits (e.g. after KEY_SOURCE or KEY_MENU, 1000 ms).

## 3. Key list for the UI
Tags:
- **[core]**: used by HA, samsungtvws, tavicu and openHAB across 2016-2024 Tizen TVs; expected to work.
- **[modern]**: newer keys reported on 2018+ TVs.
- **[mixed]**: works on some models, ignored on others; probe on this TV.
- **[legacy]**: old C/D/E-series codes; likely ignored on 2020.
- **[danger]**: never expose.

| Group | Keys |
|---|---|
| Power | KEY_POWER [core, toggles on/standby]; KEY_POWEROFF, KEY_POWERON [legacy, pre-2016] |
| Navigation | KEY_UP, KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_ENTER, KEY_RETURN, KEY_EXIT, KEY_HOME [core] |
| Menus | KEY_MENU (Settings), KEY_TOOLS, KEY_INFO, KEY_GUIDE, KEY_CH_LIST, KEY_SOURCE [core]; KEY_MORE [modern: quick-settings hub on 2024; on 2020 maybe the 123/colour pad, probe]; KEY_CONTENTS, KEY_APP_LIST [no effect on 2021]; KEY_TOPMENU, KEY_HELP, KEY_DISC_MENU, KEY_DVR_MENU [legacy] |
| Numbers | KEY_0 to KEY_9 [core]; KEY_MINUS [modern, DTV sub-channel dash, HA docs]; KEY_11, KEY_12, KEY_PLUS100 [legacy] |
| Colours | KEY_RED, KEY_GREEN, KEY_YELLOW, KEY_BLUE [core]; KEY_CYAN [legacy alias] |
| Volume | KEY_VOLUP, KEY_VOLDOWN, KEY_MUTE [core] |
| Channels | KEY_CHUP, KEY_CHDOWN, KEY_PRECH [core]; KEY_FAVCH [mixed]; KEY_AUTO_PROGRAM, KEY_MAGIC_CHANNEL [legacy] |
| Media | KEY_PLAY, KEY_PAUSE, KEY_STOP, KEY_FF, KEY_REWIND [core]; KEY_PLAY_BACK [modern, play/pause toggle, tavicu default]; KEY_REC [mixed]; KEY_LIVE, KEY_QUICK_REPLAY, KEY_INSTANT_REPLAY, KEY_STILL_PICTURE, KEY_FF_, KEY_REWIND_ [legacy] |
| Inputs | KEY_HDMI [core, active/next HDMI]; KEY_HDMI1 to KEY_HDMI4 [mixed: ignored on 2018 Q8F, 2021 Q65A, 2023 CU8000; reported on a 2019 Q60]; KEY_TV [core, live TV]; KEY_DTV, KEY_ANTENA [mixed]; KEY_AV1-3, KEY_COMPONENT1-2, KEY_SVIDEO1-3, KEY_DVI, KEY_FM_RADIO, KEY_DVR, KEY_PCMODE [legacy] |
| Picture / sound | KEY_PMODE, KEY_PICTURE_SIZE, KEY_ASPECT, KEY_SOUND_MODE, KEY_MTS, KEY_ESAVING (eco), KEY_SLEEP [mixed, probe]; KEY_AD [modern-mixed: ColorControl uses KEY_AD, 1.4 s wait, DOWN, DOWN, ENTER to reach Picture Off]; KEY_DYNAMIC, KEY_STANDARD, KEY_MOVIE1, KEY_CUSTOM, KEY_GAME, KEY_PANORAMA, KEY_4_3, KEY_16_9, KEY_ZOOM1/2, KEY_EXT14/15, KEY_MAGIC_BRIGHT, KEY_DNIe, KEY_SRS, KEY_SEFFECT [legacy] |
| Smart features | KEY_AMBIENT [modern, 2018+ QLED Ambient Mode]; KEY_MULTI_VIEW [modern, 2020+ Multi View; also Frame rotation]; KEY_BT_VOICE [modern, hold for Bixby]; KEY_CAPTION, KEY_SUB_TITLE [mixed]; KEY_INTERNET, KEY_EXTRA [listed by openHAB/ollo69, probe]; e-Manual has no known WS key, so use a menu macro |
| PIP / teletext | KEY_PIP_* [legacy]; KEY_TTX_MIX, KEY_TTX_SUBFACE [mixed] |
| Danger | KEY_FACTORY (service menu), KEY_AUTO_ARC_*, KEY_PANNEL_*, KEY_EXT1-41, KEY_ID_INPUT/SETUP, KEY_DTV_SIGNAL, KEY_CONVERGENCE, KEY_3SPEED |

The official TizenFX `KeyCode` list (KeyPlayBack, KeyEManual, KeyMore, KeyNumberPad, KeyPictureMode, KeyPictureSize, KeySoundMode, KeyDiscretHDMI1-4, KeyAudioDescription, KeySleep, KeyMinus, KeyNetflix, KeyAmazon…) hints at more names in the TV's internal table. Their KEY_* spellings over WS are unverified.

### Mapping the 2020 physical remote
| Physical button | Key |
|---|---|
| Power | KEY_POWER |
| Mic (hold) | KEY_BT_VOICE |
| 123/colour | KEY_MORE? (probe) |
| Ambient | KEY_AMBIENT |
| Home | KEY_HOME |
| Back | KEY_RETURN (hold = exit app) |
| Play/Pause | KEY_PLAY_BACK |
| Volume rocker | KEY_VOLUP / KEY_VOLDOWN |
| Volume rocker, press | KEY_MUTE |
| Channel rocker | KEY_CHUP / KEY_CHDOWN |
| Channel rocker, press | KEY_GUIDE |
| Channel rocker, hold 1 s | KEY_CH_LIST |
| App buttons | Launch the app by ID (REST POST) |

## 4. Text and IME
**Send:**
```
{"method":"ms.remote.control","params":{"Cmd":"<base64>","DataOfCmd":"base64","TypeOfRemote":"SendInputString"}}
{"method":"ms.remote.control","params":{"TypeOfRemote":"SendInputEnd"}}
```
SendInputString replaces the field contents: resend the whole string on each change, debounced by about 150 ms. SendInputEnd presses Done.

**Receive:**
```
{"data":"url","entrylimit":2048,"event":"ms.remote.imeStart"}
{"data":"YWFh","entrylimit":2048,"event":"ms.remote.imeUpdate"}   (atob gives "aaa")
{"event":"ms.remote.imeEnd"}
{"data":"enable","event":"ms.remote.imeDone"}   (a disable/enable pair follows each SendInputString)
```

**UI**:
- imeStart: open the keyboard sheet; use `type` and `maxlength` from `data` and `entrylimit`.
- imeUpdate: set the field from the decoded text, unless it equals our last sent text (prevents echo loops).
- imeEnd: close the sheet.
- Enter key: SendInputEnd.

## 5. Pointer
```
{"method":"ms.remote.control","params":{"Cmd":"Move","Position":{"x":12,"y":-4,"Time":"0"},"TypeOfRemote":"ProcessMouseDevice"}}
{"method":"ms.remote.control","params":{"Cmd":"LeftClick","TypeOfRemote":"ProcessMouseDevice"}}   (RightClick also exists)
```
- Moves are relative, in roughly 1920x1080 units. Scale browser deltas by about 2-5 and batch with requestAnimationFrame (about 60 Hz).
- Only enable the pointer after `ms.remote.touchEnable`; disable on `ms.remote.touchDisable`.
- No scroll command is known. In the TV browser, Press/Release KEY_CHUP/KEY_CHDOWN for 400 ms works as page scroll.

## 6. Apps
**Requests over the remote channel:**
```
{"method":"ms.channel.emit","params":{"event":"ed.installedApp.get","to":"host"}}
{"method":"ms.channel.emit","params":{"event":"ed.edenApp.get","to":"host","data":""}}
{"method":"ms.channel.emit","params":{"event":"ed.apps.icon","to":"host","data":{"iconPath":"/opt/share/webappservice/apps_icon/FirstScreen/<id>/250x250.png"}}}
{"method":"ms.channel.emit","params":{"event":"ed.apps.launch","to":"host","data":{"appId":"<id>","action_type":"DEEP_LINK","metaTag":""}}}
```
- Old reply shapes: `{"event":"ed.installedApp.get","from":"host","data":{"data":[{"appId","app_type":2,"icon","is_lock":0,"name"}]}}`, `{"event":"ed.apps.icon","data":{"imageBase64":"..."}}`, `{"data":200,"event":"ed.apps.launch"}`.
- 2020 Tizen 5.5 reportedly gives no reply to installedApp, edenApp or icon (community, several models). Use timeouts and fall back.

**REST on port 8001 (no auth):**
- `GET /api/v2/applications/<id>/` (the trailing slash is required on this TV) returns `{"id":"111299001912","name":"YouTube","running":true,"version":"2.1.513","visible":true}`, or a 404 body `{"code":404,"message":"Not found error.","status":404}`.
- `POST` with `Content-Type: application/json` and body `{}` launches the app and returns `true`.
- `DELETE` closes the app (unverified on 2020).
- `PUT` opens the store page.
- `POST /api/v2/webapplication/` with `{"url":"..."}` opens a web URL (2018 report).

**`/api/v2` socket** (`wss://IP:8002/api/v2?name=<b64>`, ollo69 and openHAB): JSON-RPC style.
```
{"id":"<appId>","method":"ms.application.get|start|stop","params":{"id":"<appId>"}}
```
Replies are `{"id":"<appId>","result":{...}|true}` or `{"id":"<appId>","error":{"code":404,...}}`. Web apps use the `ms.webapplication.*` variants. Whether this socket prompts or needs the token on 2020 is unknown.

## 7. Other events

| Event | Notes |
|---|---|
| ms.channel.ready | `{}` |
| ms.channel.clientConnect / clientDisconnect | Another remote joined or left (client object) |
| ms.channel.disconnect | Channel closed |
| ed.edenTV.update | `{"update_type":"ed.edenApp.update"}`: app-change hint, pre-2020 |
| ms.voiceApp.standby / recording / processing / hide | Voice UI state |
| ms.remote.mbrlayout / ms.remote.numberpad | 2025 decompile; meaning unknown (maybe "show number pad") |
| d2d_service_message | Art channel only |

None of these carry volume, power, picture or backlight state. msf-server rejects custom events whose names start with `ms.`.

## 8. Node 22 client choice
- **Use npm `ws` (^8)**: `rejectUnauthorized:false`, `servername:''`, `handshakeTimeout`, a `ping` event for the heartbeat, `terminate()`, automatic pongs.
- **Node 22 built-in WebSocket (undici)**: stable since 22.4. It can only skip certificate checks with `new WebSocket(url, {dispatcher: new Agent({connect:{rejectUnauthorized:false}})})`, using `Agent` from the npm `undici` package, because Node exposes no Agent. The alternative, `NODE_TLS_REJECT_UNAUTHORIZED=0`, is process-wide and should not be used. It also hides ping frames, so it cannot detect a dead link from TV pings.
- **Architecture**: browser ⇄ (your WS/HTTP on the PC) ⇄ one hub ⇄ TV wss:8002. A browser can also talk to the TV directly (dobrou does this) after the user accepts the certificate at https://IP:8002/api/v2/, but that loses central token handling.

Core of the sketch:
```js
const ws = new WebSocket(`wss://${host}:8002/api/v2/channels/samsung.remote.control?name=${NAME_B64}${token?`&token=${token}`:''}`,
  {rejectUnauthorized:false, servername:'', handshakeTimeout:5000, perMessageDeflate:false});
ws.on('message', raw => { const m = JSON.parse(raw);
  if (m.event==='ms.channel.connect') { const me=(m.data.clients||[]).find(c=>c.id===m.data.id); save(m.data.token ?? me?.attributes?.token); }
  else if (m.event==='ms.channel.unauthorized') { /* show re-pair */ }
  else if (m.event==='ms.channel.timeOut') { /* asleep or other subnet */ } });
ws.on('ping', resetHeartbeat /* 12 s */);
const key = (k,cmd='Click') => ws.send(JSON.stringify({method:'ms.remote.control',params:{Cmd:cmd,DataOfCmd:k,Option:'false',TypeOfRemote:'SendRemoteKey'}}));
```

## Risks

- The Allow/Deny prompt appears over whatever is on screen. A family member pressing Deny blocks every later connection until it is fixed in Device List, so pairing must be an explicit user action and the client must never auto-retry without a token.
- Token churn: the TV can issue a new token on any reconnect and forget tokens after a long power-off or a firmware update. If the newest token is not always saved, the prompt comes back on every boot (HA #54027, ollo69 #169).
- Samsung firmware updates have broken or restricted the WS API on purpose (xchwarze #184: a 2026 monitor firmware gives ms.channel.timeOut and no prompt; ed.* APIs removed around Tizen 5). The product needs fallbacks (REST, UPnP, SmartThings, IP Control on 1516, companion app).
- Opening the socket while the TV is in standby may wake it on some models (HA comment). Reconnect loops must be gated on REST PowerState=='on'; otherwise the remote could switch the TV on unexpectedly (compare ollo69 #393, 'TV turns on suddenly').
- A long KEY_POWER hold may restart a non-Frame TV, and KEY_FACTORY or the service/AUTO_ARC/PANNEL/EXT keys can change service settings. Use a key allowlist and cap hold durations.
- Keys are fire-and-forget. Unknown or unsupported keys do nothing silently, so the UI must not claim success and must confirm through state (UPnP volume, REST app visibility).
- The installed-app list, app icons and ed.apps.launch probably do not work on Tizen 5.5. App launcher tiles need a curated or probed ID list, and app IDs differ by year and region (Netflix 11101200001 vs 3201907018807).
- Text input replaces the whole field. imeUpdate echoes field text in base64, which may expose password-field contents to every connected browser.
- Pointer moves are ignored unless touchEnable is active. There is no scroll primitive, and the touch-device payloads are unknown.
- A TV-side 'held' key with a missing Release (e.g. browser tab closed mid-press) keeps auto-repeating, e.g. volume racing up. Mitigate with Release on blur/pointercancel and a server-side watchdog that sends Release after 5 s at most.
- TLS: the TV's self-signed cert (CN=SmartViewSDK) needs certificate checks disabled. OpenSSL 3 in Node 22 may reject weak legacy ciphers or keys (openHAB keeps legacy cipher suites on), so a fallback cipher config may be needed.
- Same-subnet requirement: a PC on a VPN or another VLAN gets ms.channel.timeOut with no prompt. The PC hub must reach the TV from the TV's own subnet.
- Much of the 2020 behaviour here is inferred from other models (2018-2021 QLEDs, a 2025 Frame decompile). Nothing in this area was observed on this Q95T.

## Open questions

- On this Q95T, does wss:8002 pairing behave as described (prompt, then data.token)? What is the current Access Notification setting? Test only with the user present, or when nobody is watching.
- Do ed.installedApp.get, ed.edenApp.get and ed.apps.icon really get no reply on this firmware, and is ed.apps.launch honoured or ignored?
- Does the /api/v2 (no channel) JSON-RPC socket accept ms.application.get/start/stop on 2020, and does connecting to it pop the Allow prompt or need the token?
- Which uncertain keys do anything on this TV: KEY_HDMI1-4, KEY_MORE, KEY_PMODE, KEY_PICTURE_SIZE, KEY_SOUND_MODE, KEY_SLEEP, KEY_ESAVING, KEY_CAPTION, KEY_AD, KEY_MULTI_VIEW, KEY_PLAY_BACK, KEY_MINUS, KEY_INTERNET, KEY_EXTRA? This needs a supervised 'key lab' session.
- What does a KEY_POWER hold of 1-3 s do on the Q95T (power menu, standby, restart)? And KEY_MUTE or KEY_VOLUP holds (Accessibility Shortcuts)?
- What input-type strings does ms.remote.imeStart send on Tizen 5.5 (url/text/password/number?), and is imeUpdate masked for password fields?
- Is there any ProcessMouseDevice scroll payload (the decompile shows a virtual-mouse scroll routine)? What are the CreateTouchDevice/ProcessTouchDevice payloads?
- Does a custom MSF channel (companion app via msf.local) work for an app signed with the user's distributor certificate, and do PC clients on such a channel trigger the Allow prompt? Or should the companion app connect outbound to the PC instead?
- Does REST POST/DELETE /api/v2/applications/<id> need the trailing slash on this TV, like GET does?
- Outside this area but decisive for 'brightness/backlight' UX: is the Samsung IP Control server listening on TCP 1516 on this TV (2020 = 1516 per the Samsung worksheet and the decompile; 1515 is closed), and is 'IP Remote' available under Settings > General > Network > Expert Settings?
- Does the com.samsung.tv.mobilebff channel (get.settings.data, request.vconf.info.*) exist on Tizen 5.5, or only on newer firmware?
- How often does the TV ping on this model, and does it drop idle sockets regardless (openHAB pings every 4 min 'to avoid 5 minute idle timeout')?
