# Research area: power-apps-inputs

## Summary

Live read-only REST GETs to the Q95T (17 Oct-21 2026 session, about 80 GETs spaced 400 ms or more) confirmed that GET /api/v2/ returns device.PowerState "on" plus a wifiMac field, which can be the Wake-on-LAN target. Each REST call takes 1.2-1.4 s on this TV, so polling has to be sparse. GET /api/v2/applications/<id>/ (with the trailing slash) gives {id,name,running,version,visible}. visible:true marks the app in front: right now that is the user's own CineHD TV (pvcinehd01.CineHDTV 0.17.421). running:true is noise, because Netflix, YouTube, Prime Video, Apple TV and Internet are all preloaded with running:true and visible:false. REST accepts numeric store (WAS) IDs and 10-character-package Tizen IDs such as 9Ur5IzDKqV.TizenYouTube. It returns 404 for org.tizen.* and com.samsung.* aliases even when the app is installed, and the same app can report different 'running' values under its two IDs. Installed on this TV: Netflix 3201907018807, YouTube 111299001912, Prime Video 3201910019365, Apple TV 3201807016597, Apple Music 3201908019041, Spotify 3201606009684, Plex 3201512006963, Internet 3201907018784, SmartThings 3201910019378, Gallery 3201710015037, Amazon Alexa 3202004020626, Samsung Promotion 3201807016658 and CineHD. No public source gives IDs for JioHotstar, SonyLIV, MX Player or JioCinema. ZEE5's community ID 3201810017104 returns 404 here. Samsung removed the installed-app list (WS ed.installedApp.get) on 2020 firmware, so the real app list has to come from a companion Tizen app (tizen.application.getAppsInfo), from sdb 'vd_applist' (Developer Mode is on) or from probing a curated ID list. Power: off is a WS KEY_POWER click, a toggle that must be guarded by a fresh PowerState=='on'. Never hold the key for about 5 s: Samsung documents that as a soft-reset reboot. On has three paths. Within about 1 minute of standby the IP server is still alive and KEY_POWER works. After that only a Wi-Fi magic packet works, and it needs 'Power On with Mobile' enabled. SmartThings switch.on (cloud) is the fallback. None of these power paths, nor the standby REST behaviour, could be observed because the TV is in use. Inputs cannot be read or switched over any local LAN API on 2020 models: 7676/MainTVAgent is closed and the IPControlService SCPD is empty. There are three options: SmartThings (samsungvd.)mediaInputSource, which reads and sets the input and returns CEC device names; key macros (KEY_SOURCE plus navigation, KEY_HDMI; KEY_HDMI1-4 are unreliable); or a companion app that calls tizen.tvwindow.getSource/setSource plus systeminfo VIDEOSOURCE (which ports are connected) and then launches org.tizen.tv-viewer. Community code shows that last route working on a 2022 TV; it is unverified on Tizen 5.5. Now playing: REST shows the foreground app only; 'nothing visible' means a source or a system UI. YouTube can give real now-playing data through DIAL screenId and the YouTube Lounge API (videoId, currentTime, duration, state). DLNA AVTransport covers cast media only. SmartThings tvChannel/tvChannelName gives the tuner channel or the running app's Tizen ID. CineHD itself can report its own playback. Channel keys go to the TV tuner; for an Indian HDMI set-top box they only work if Anynet+ HDMI-CEC passthrough does, which is unverified.

## Capabilities

- **Read power state (on vs standby)** (live-tv, medium; read=true write=false live=false): HTTP GET http://192.168.1.2:8001/api/v2/ -> device.PowerState ('on' | 'standby'); unreachable (ECONNREFUSED/timeout) = deep standby/off
  - Observed live: PowerState 'on', HTTP 200, 1193 ms. The value 'standby' and REST reachability during standby were NOT observed (TV in use). Community/official: TV keeps answering on 8001 for ~17 s (homebridge) up to ~1 min (Samsung IP-control worksheet) after power-off, reporting 'standby', then the IP server goes offline unless kept alive (e.g. Bixby 'keep in standby'). Homey reports periodic standby network wakes (~every 25 min, ~30 s) so reachability alone gives false 'on' -> always require PowerState=='on'. isSupport is a JSON string inside JSON (parse twice).
- **Detect power transitions robustly** (source-code, medium; read=true write=false live=true): REST /api/v2/ poll every 3-5 s (timeout 2.5 s, TV latency ~1.2 s) + WS remote-channel close event + optional passive SSDP NOTIFY alive/byebye listener; optimistic latch after own commands (3 s on, up to 20 s off)
  - homebridge-samsung-tizen PowerMonitor: poll 45 s, SSDP byebye -> off, latch 3 s (20 s when PowerState unsupported). HA core polls every 10 s and checks PowerState first because 'on some TVs, opening a websocket turns on the TV' -> never use WS connects as a probe. ha-samsungtv-smart rescans apps on WS event ed.edenTV.update. States to model: on / standby(REST 200, PowerState standby) / offline(no TCP) / transitioning / unknown.
- **Turn TV off (to standby)** (source-code, high; read=false write=true live=false): WS wss://192.168.1.2:8002/api/v2/channels/samsung.remote.control?name=<b64>&token=<t> message {method:'ms.remote.control',params:{Cmd:'Click',DataOfCmd:'KEY_POWER',Option:'false',TypeOfRemote:'SendRemoteKey'}}
  - Non-Frame 2020 TVs: KEY_POWER click (HA core, homebridge). KEY_POWEROFF/KEY_POWERON are ignored on newer TVs (community). KEY_POWER is a TOGGLE: Homey issue #60 shows an 'off' sent to an already-off TV turning it ON -> only send when a fresh REST read says PowerState=='on'. Long hold: Samsung documents holding Power ~5 s while on = soft reset (TV reboots); the 3 s hold used by HA/homebridge is Frame-only (FrameTVSupport 'false' live). There is no 'real off' over network; the TV only goes to (network) standby. SmartThings switch.off also works (cloud). Not observed live (WS forbidden).
- **Turn TV on from recent standby (IP server still alive)** (official-doc, medium; read=false write=true live=false): If TCP 8001 answers (REST 200 with PowerState 'standby'), open WS remote channel and send KEY_POWER Click
  - Samsung IP-control worksheet: within <1 min of power-off the TV 'has the potential to still have an active IP server', bypassing WoL; after ~1 min WoL is required. homebridge controller.powerOn(): port 8001 reachable -> KEY_POWER, else WoL. openHAB: may need to wait up to 60 s ('instant on'). Not observed live.
- **Turn TV on via Wake-on-LAN over Wi-Fi** (community, medium; read=false write=true live=false): UDP magic packet (6x0xFF + 16x MAC) to port 9: limited broadcast 255.255.255.255, subnet-directed broadcast, and unicast 192.168.1.2; 3 packets 100 ms apart, re-burst every ~2-3 s while polling REST up to ~30 s; MAC = device.wifiMac from REST
  - TV setting required on 2020: Settings > General > Network > Expert Settings > Power On with Mobile (2022+: Connection > Network > Expert Settings). Samsung worksheet: use the Wireless MAC when on Wi-Fi; wrong MAC is the top failure. openHAB: WoL 'Works on WiFi connected TVs'; fails on wired TVs with ARC/eARC soundbar. couch-remote (2021 Q65A, Wi-Fi): WoL + KEY_POWER wakes it. Homey: many users find WoL unreliable (AP broadcast filtering, client isolation, wrong adapter). On a multi-adapter Windows PC (VPN etc.) bind the UDP socket to the LAN-facing local address (socket.localAddress of a TCP connection to 192.168.1.2) before broadcasting. wifiMac field presence observed live (value not recorded). Wake not observed live.
- **Power on/off via SmartThings cloud** (source-code, medium; read=true write=true live=false): POST https://api.smartthings.com/v1/devices/{deviceId}/commands {"commands":[{"component":"main","capability":"switch","command":"on"}]}; health: GET /v1/devices/{id}/health -> {state:'ONLINE'|'OFFLINE'}
  - Requires the TV registered in SmartThings, Samsung account, 'Power On with Mobile' on. SmartThings PATs expire after 24 h since 30 Dec 2024 -> use an OAuth client (refresh_token grant at https://api.smartthings.com/oauth/token, as homebridge does). Commands return 409 Conflict when the TV is offline. Fallback path when WoL fails; adds internet latency.
- **Read current input source (local LAN, no cloud)** (live-tv, high; read=false write=false live=false): None on 2020 firmware over LAN APIs: REST has no source field; UPnP MainTVAgent2 (port 7676) closed; IPControlService (9110) SCPD empty
  - Port scan/SCPD facts given for this TV. openHAB README: 'there is no local control capable of switching the TV input' on newer TVs; needs SmartThings. Indirect local signal: if no store app is visible via REST and PowerState is on, the TV is showing a source or a system UI (Home, Settings, Source bar).
- **Read/switch input via SmartThings** (source-code, medium; read=true write=true live=false): Read: POST refresh then GET /v1/devices/{id}/status -> main['samsungvd.mediaInputSource'].inputSource / supportedInputSourcesMap [{id:'dtv',name:'TV'},{id:'HDMI1',name:'PlayStation 4'}]; main.mediaInputSource.supportedInputSources ['digitalTv','HDMI1',...]. Write: command samsungvd.mediaInputSource setInputSource ['HDMI1'] (or mediaInputSource setInputSource ['HDMI1'|'digitalTv'])
  - supportedInputSourcesMap carries the CEC/user names of HDMI devices, which is good for the UI. Values are stale unless a 'refresh' command is sent first; ha-samsungtv-smart throttles to >=5-10 s. homebridge: tvChannelName containing '.' means an app is running (the value is the Tizen app id), and dtv with an empty channel is not a selectable input. Homey reports empty source lists and 409 errors for many users. Not observed (no SmartThings token).
- **Switch input via remote keys / menu macro (local)** (community, low; read=false write=true live=false): WS keys: KEY_SOURCE (opens source bar) then KEY_LEFT/KEY_RIGHT x n + KEY_ENTER; KEY_HDMI (jumps to or cycles HDMI, model-dependent); KEY_HDMI1..KEY_HDMI4; KEY_TV / KEY_DTV for tuner
  - couch-remote on 2021 Q65A: KEY_SOURCE works, KEY_HDMI1/KEY_HDMI2 have no effect. Homey users: repeated KEY_HDMI cycles inputs; KEY_HDMIn works on some models. HA defaults: {'TV':'KEY_TV','HDMI':'KEY_HDMI'}. A macro must know the source-bar order, so learn it once and pair it with a read-back (SmartThings or companion) to verify. Space keys 400-500 ms or more (Tizen drops fast sequences).
- **Read and switch input via on-TV companion app** (source-code, low; read=true write=true live=false): Tizen web app: tizen.systeminfo.getPropertyValue('VIDEOSOURCE') -> {connected[],disconnected[]} of {type:'HDMI',number:n}; tizen.tvwindow.getSource('MAIN') -> {type,number,signal(5.5+)}; tizen.tvwindow.setSource(src, ok, err, 'MAIN') then tizen.application.launch('org.tizen.tv-viewer'); privileges http://tizen.org/privilege/tv.window and application.launch (public)
  - Official doc: TVWindow setSource 'Changes the source of a TV window' and is public-level. It does not say whether the physical input changes after the app exits. arn0-tv (tested on a 2022 Q70B, Tizen 6.5) uses setSource and then launches org.tizen.tv-viewer by default to show the console full screen, with a fallback that shows the source inside the app. VIDEOSOURCE gives per-port 'connected' state. SOURCE_INFO (Tizen 5.5) exists in the property enum but is undocumented. On Q95T Tizen 5.5 this is unverified, and getSource probably only works while the companion is in the foreground.
- **Foreground app detection** (live-tv, high; read=true write=false live=false): GET http://192.168.1.2:8001/api/v2/applications/<WAS id or 10-char-pkg Tizen id>/ (trailing slash) -> {id,name,running,version,visible}; visible:true = in front
  - Live: pvcinehd01.CineHDTV visible:true. Netflix, YouTube(111299001912), Prime, Apple TV and Internet report running:true but visible:false (preloaded), so ignore 'running'. 9Ur5IzDKqV.TizenYouTube reports running:false for the same app. org.tizen.* and com.samsung.* aliases return 404 even when installed (e.g. org.tizen.browser, com.samsung.tv.gallery, org.tizen.netflixapp, com.samsung.tv.ariavideo). Not installed: HTTP 404 {code:404,message:'Not found error.',status:404}. System apps (Home, Settings, source UI) are invisible to REST. Each call takes 1.27-1.43 s, so poll only the last-visible app plus a short list. The WS ed.edenTV.update event or companion addAppStatusChangeListener can trigger a rescan.
- **Enumerate installed apps** (source-code, medium; read=true write=false live=true): (a) WS ed.installedApp.get on the remote channel (returns null on 2020+ firmware); (b) companion tizen.application.getAppsInfo(); (c) sdb 'shell:0 vd_applist' on 26101 (Developer Mode); (d) REST probing of a curated ID list (works, live)
  - Reports for 2020 TU8000, Q80T and TU7000 show ed.installedApp.get answered with data:null ('Cannot read property forEach of null'); openHAB says the API was removed around 2020; couch-remote (2021) gets no reply. Companion: ApplicationInformation {id,name,iconPath,version,show,categories,installDate,size,packageId}; arn0-tv filters store apps (AbCdEfGhIj.Name or numeric). addAppStatusChangeListener((appId,isActive)) since 4.0 can push changes. sdb vd_applist returns store ID, Tizen ID, title, version and icon folder, but sdb is shared with the CineHD deploy tooling and only reachable from the TV's developerIP host. (d) is what this report did live.
- **Launch / close apps (incl. deep link, browser URL)** (source-code, medium; read=false write=true live=false): REST POST http://192.168.1.2:8001/api/v2/applications/<id> (body '{}', Content-Type application/json); REST DELETE same URL = close; WS remote channel ed.apps.launch {appId, action_type:'DEEP_LINK'|'NATIVE_LAUNCH', metaTag}; WS control channel /api/v2 ms.application.start {id}; companion tizen.application.launch(appId)
  - homebridge sends an empty JSON body because some TVs return malformed replies to POSTs with no body. couch-remote: REST POST worked without pairing on a 2021 TV, and ed.apps.launch was ignored there. On 2020 TVs launches by the OLD Netflix id 11101200001 fail; use the IDs found live here. Browser: appId 'org.tizen.browser' with NATIVE_LAUNCH and metaTag=<url> (an alias that launches but cannot be queried; query 3201907018784). PUT on the same URL opens the store install page. Not observed (POST/DELETE forbidden).
- **App icons** (community, medium; read=true write=false live=false): WS ed.apps.icon {iconPath:'/opt/share/webappservice/apps_icon/FirstScreen/<appId>/250x250.png'} -> event data.imageBase64 (older TVs); Samsung TV-store CDN https://d1oxlq5h9kq8q5.cloudfront.net/tvstore/contents/<WASid>/icon_198x198_<timestamp>.png; companion iconPath; sdb pull /opt/share/webappservice/apps_icon/all/<id>/304x304.png
  - There is no HTTP icon endpoint on the TV's REST API. ed.apps.icon gets no reply on a 2021 TV and its path normally comes from ed.installedApp.get, which 2020 firmware no longer returns. The CDN URL needs the per-app timestamp, which rs.ltd and Apps2Samsung publish for about 40 apps (the YouTube icon URL returned 200 image/png from the PC). The most robust option is to bundle curated icons in the PC server, with companion iconPath for others.
- **Now playing: YouTube video, position, state** (source-code, medium; read=true write=true live=true): DIAL: GET device description (Application-URL header, typically http://192.168.1.2:8080/ws/apps/) then GET .../YouTube -> <state>running|stopped</state>, <additionalData><screenId>; then YouTube Lounge API: POST https://www.youtube.com/api/lounge/pairing/get_lounge_token_batch screen_ids=<screenId> -> loungeToken; POST /api/lounge/bc/bind?RID=1&VER=8&CVER=1 -> event stream nowPlaying/onStateChange {videoId,currentTime,duration,state}
  - pyytlounge implements screenId discovery from DIAL and the lounge bind/long-poll. Events give videoId, currentTime, duration, play state, volume and ad state. Title comes from YouTube oEmbed and the thumbnail from https://img.youtube.com/vi/<id>/0.jpg. The YouTube app may show a 'device connected' toast. The API is unofficial. Port 8080 is open on this TV, but DIAL GETs were outside this task's allowed live scope.
- **Now playing: other apps / tuner** (source-code, medium; read=true write=false live=false): REST visible app name+version (local); DIAL GET http://192.168.1.2:8080/ws/apps/<Netflix|YouTube|...> state only; SmartThings tvChannel.tvChannel/tvChannelName + mediaPlayback.playbackStatus; DLNA AVTransport GetTransportInfo/GetPositionInfo/GetMediaInfo on 9197 (only for media cast to the DMR); CineHD self-report
  - Third-party apps are sandboxed, so neither a companion app nor any API exposes the Netflix or Prime title. SmartThings tvChannelName holds the running app's Tizen ID (e.g. org.tizen.netflix-app), which maps to a name via a static table (REST 404s those aliases). playbackStatus is usually null. The real 'now playing' sources are YouTube (Lounge), DLNA-cast media, and the user's own CineHD app, which can push title/position/duration to the PC server because the user controls its code.
- **Channel up/down, number entry, previous channel** (source-code, low; read=false write=true live=false): WS keys KEY_CHUP, KEY_CHDOWN, KEY_PRECH, KEY_CH_LIST, KEY_GUIDE, KEY_0..KEY_9 then KEY_ENTER (400 ms spacing); SmartThings tvChannel channelUp/channelDown/setTvChannel ['<num>'] (tuner only)
  - The keys go to the TV. With an HDMI set-top box (typical in India) they only reach the box if Anynet+ (HDMI-CEC) passes them through and the box supports CEC remote passthrough; otherwise the box needs its own control (IR blaster, or its own IP API if it is an Android TV box). Samsung's 'Universal Remote' is IR from the physical remote; whether network keys are relayed through it is unknown. The SmartThings tvChannel value is meaningful only for the built-in tuner. Samsung's TV Channel Web API was reportedly retired from the docs in 2024.
- **Read TV identity / MAC / developer host for setup** (live-tv, high; read=true write=false live=false): GET /api/v2/ device.{modelName,model,name,countryCode,Language,wifiMac,networkType,developerMode,developerIP,TokenAuthSupport,FrameTVSupport,resolution}
  - Live: modelName QA55Q95TAKXXL, model 20_NIKEM_QTV, countryCode IN, Language en_GB, networkType wireless, TokenAuthSupport true (so use wss 8002 + token), FrameTVSupport false, firmwareVersion 'Unknown' (not exposed), version 2.0.25. Store wifiMac server-side for WoL and never display or log it.

## Protocol details

## Live observations on this TV (read-only GET, spaced 400 ms or more)

`GET http://192.168.1.2:8001/api/v2/` -> 200 in 1193 ms. Shape (network identifiers redacted):
```json
{"device":{"FrameTVSupport":"false","GamePadSupport":"true","ImeSyncedSupport":"true","Language":"en_GB","OS":"Tizen",
 "PowerState":"on","TokenAuthSupport":"true","VoiceSupport":"true","WallScreenRatio":"0","WallService":"false",
 "countryCode":"IN","description":"Samsung DTV RCR","developerIP":"<dev PC>","developerMode":"1","duid":"uuid:...",
 "firmwareVersion":"Unknown","id":"uuid:...","ip":"192.168.1.2","model":"20_NIKEM_QTV","modelName":"QA55Q95TAKXXL",
 "name":"[TV] PV-TV","networkType":"wireless","resolution":"3840x2160","smartHubAgreement":"true","ssid":"<redacted>",
 "type":"Samsung SmartTV","udn":"uuid:...","wifiMac":"<redacted>"},
 "isSupport":"{\"DMP_DRM_PLAYREADY\":\"false\",...,\"remote_voiceControl\":\"true\"}\n",
 "name":"[TV] PV-TV","remote":"1.0","type":"Samsung SmartTV","uri":"http://192.168.1.2:8001/api/v2/","version":"2.0.25"}
```
`isSupport` is a JSON-encoded string, so parse it twice.

`GET /api/v2/applications/<id>/` (trailing slash required here) -> 200 `{"id":"3201907018807","name":"Netflix","running":true,"version":"80.25.23140","visible":false}` or 404 `{"code":404,"message":"Not found error.","status":404}`. Each call takes 1.27-1.43 s.

| App | ID that answers 200 on this TV | version | state now |
|---|---|---|---|
| CineHD TV | pvcinehd01.CineHDTV | 0.17.421 | running, **visible** |
| Netflix | 3201907018807 | 80.25.23140 | running (preloaded) |
| YouTube | 111299001912 (also 9Ur5IzDKqV.TizenYouTube, which reports running:false) | 2.1.498 | running (preloaded) |
| Prime Video | 3201910019365 | 5.3.21 | running (preloaded) |
| Apple TV | 3201807016597 | 16.2.0 | running (preloaded) |
| Internet | 3201907018784 | 3.5.10100 | running (preloaded) |
| Apple Music | 3201908019041 | 16.2.0 | - |
| Spotify | 3201606009684 / rJeHak5zRg.Spotify | 2.1.66 | - |
| Plex | 3201512006963 | 5.64.1 | - |
| SmartThings | 3201910019378 | 2.0.116 | - |
| Gallery | 3201710015037 | 2.0.46 | - |
| Amazon Alexa | 3202004020626 / AQKO41xyKP.AmazonAlexa | 0.20.08060 | - |
| Samsung Promotion | 3201807016658 | 3.2.96 | - |

404 here (not installed, or the ID differs): 11101200001, 3201611010983 (YouTube Kids), 3201707014489, 3201512006785, Disney+ 3201901017640/3202009021709/3202204027038, 3202106024097, 3201606009872 (Emby), org.tizen.browser, 3202010022079, 3201710015016, 3202311033054, 3201710015067 (Universal Guide), 3201601007250, 3202405035480 (Samsung TV Plus 2024 ID), 3202203026841 (Twitch), 3202203026799 (Xbox), 3202203026819 (Luna), 11091000000, 3201710014874, 3201504001965 (Tubi), 3201702011851, 3202008021577, 3201807016555 (Viu), 3202006020934 (iQIYI), 3202004020575, 3202004020674, 3201601007492 (YuppTV), 20172100006/20202100002 (e-Manual), 3201909019271, 3201612011418, 3202009021877, 3201608010191, 121299000101, 3201805016367, 3201808016802, 3201803015944, 3201806016390, 3202008021439, 111299001922, 3201810017104 (ZEE5, community ID), 3201909019211 (Samsung Health). Alias forms that also returned 404: org.tizen.netflix-app, org.tizen.netflixapp, org.tizen.ignition, org.tizen.primevideo, com.samsung.tv.store, com.samsung.tv.gallery, com.samsung.tv.aria-video, com.samsung.tv.ariavideo, org.tizen.apple.apple-music, org.tizen.apple.applemusic, com.samsung.tv.iotdashboard, MCmYXNxgcu.DisneyPlus, pvcinehd01.
Rule: REST takes WAS (store) IDs and `<10charPkg>.<Name>` Tizen IDs. It rejects `org.tizen.*` and `com.samsung.*` IDs.

India apps (JioHotstar, which since Feb 2025 includes JioCinema; SonyLIV; ZEE5-IN; MX Player; Sun NXT; aha; Samsung TV Plus IN): no public source gives IDs. Find them on this TV with the companion `getAppsInfo()`, with sdb `vd_applist`, or by reading SmartThings `tvChannelName` while each app is open. Voot was merged into JioCinema and ALTBalaji is defunct. Gaming Hub is a 2022+ feature (Xbox ID 404 here). Kodi is not in the Samsung store.

## Power
```js
// state probe (REST only; never use a WS connect as a probe)
async function power(){ try{ const j = await getJSON('http://192.168.1.2:8001/api/v2/',{timeout:2500});
  return j.device.PowerState === 'on' ? 'on' : (j.device.PowerState || 'unknown'); }  // 'standby'
  catch { return 'offline'; } }
```
- **Off**: only if `power()==='on'` *now*, send over `wss://192.168.1.2:8002/api/v2/channels/samsung.remote.control?name=<base64 name>&token=<token>` (self-signed TLS; first connect shows Allow on the TV; the token comes back in `ms.channel.connect` data.token):
`{"method":"ms.remote.control","params":{"Cmd":"Click","DataOfCmd":"KEY_POWER","Option":"false","TypeOfRemote":"SendRemoteKey"}}`
Never send Press/Release holds of KEY_POWER of 3 s or more. A ~5 s hold is Samsung's documented soft reset (reboot), and the 3 s hold is Frame-only. Then latch 'turning-off' and poll until PowerState is 'standby' or the TV is offline.
- **On**: (1) If REST answers (standby window, about 17-60 s after off), send KEY_POWER click over WS. (2) Otherwise send WoL. (3) Optionally fall back to SmartThings `switch.on`. Poll REST every 2 s for up to 30 s, re-sending WoL bursts every 3 s.
```js
const dgram=require('dgram'),net=require('net');
function magic(mac){const m=Buffer.from(mac.replace(/[^0-9a-f]/gi,''),'hex');const b=Buffer.alloc(102,0xff);for(let i=0;i<16;i++)m.copy(b,6+i*6);return b;}
async function lanAddr(){return new Promise((res,rej)=>{const s=net.connect(8001,'192.168.1.2',()=>{res(s.localAddress);s.destroy();});s.on('error',rej);s.setTimeout(1500,()=>{s.destroy();rej(new Error('t'));});});}
async function wol(mac,localIP){const pkt=magic(mac);const s=dgram.createSocket('udp4');
 await new Promise(r=>s.bind(0,localIP,r)); s.setBroadcast(true);
 const targets=['255.255.255.255', localIP.replace(/\d+$/,'255') /* assumes /24; compute from netmask */, '192.168.1.2'];
 for(let i=0;i<3;i++){for(const t of targets) s.send(pkt,9,t); await new Promise(r=>setTimeout(r,100));} s.close();}
```
`lanAddr()` needs the TV's IP server to be alive. If it is not, use the cached LAN address from earlier sessions. Unicast to 192.168.1.2 also needs a live ARP entry. TV prerequisite on a 2020 model: Settings > General > Network > Expert Settings > **Power On with Mobile = On**. The same menu has **IP Remote** (used by control-system partners).
- Transitions: REST poll every 3-5 s, plus WS `close` and `ms.channel.disconnect`, plus optional passive SSDP `NOTIFY ssdp:byebye`. Debounce: require two consecutive reads, and ignore 'reachable' without PowerState=='on' (standby wakes happen about every 25 min).

## Inputs
SmartThings (cloud): `POST https://api.smartthings.com/v1/devices/{id}/commands`
`{"commands":[{"component":"main","capability":"samsungvd.mediaInputSource","command":"setInputSource","arguments":["HDMI2"]}]}`. Send `{"capability":"refresh","command":"refresh"}` first, then `GET /v1/devices/{id}/status`, and read `components.main["samsungvd.mediaInputSource"].inputSource.value` and `.supportedInputSourcesMap.value` (`[{"id":"dtv","name":"TV"},{"id":"HDMI1","name":"PlayStation 4"}]`). The standard `mediaInputSource` uses `digitalTv`.
Keys: `KEY_SOURCE` -> source bar, then `KEY_LEFT`/`KEY_RIGHT` and `KEY_ENTER` (learn the order once). `KEY_HDMI`, `KEY_HDMI1..4` and `KEY_TV` depend on the model; test each.
Companion (config.xml): `<tizen:privilege name="http://tizen.org/privilege/tv.window"/>`, `.../application.launch`, `.../application.info`, `.../internet`.
```js
tizen.systeminfo.getPropertyValue('VIDEOSOURCE', v => report(v.connected, v.disconnected));   // {type:'HDMI',number:2}
const cur = tizen.tvwindow.getSource('MAIN');                                                // {type,number,signal}
tizen.tvwindow.setSource(src, () => tizen.application.launch('org.tizen.tv-viewer', ok, err), err, 'MAIN');
tizen.application.addAppStatusChangeListener((appId, isActive) => push({appId, isActive}));  // since 4.0, all apps
tizen.application.getAppsInfo(list => push(list.map(a => ({id:a.id,name:a.name,icon:a.iconPath,ver:a.version,pkg:a.packageId}))));
```

## Apps over WS (not live-tested)
- Remote channel launch: `{"method":"ms.channel.emit","params":{"event":"ed.apps.launch","to":"host","data":{"appId":"111299001912","action_type":"DEEP_LINK","metaTag":""}}}`. For the browser, use `appId:"org.tizen.browser"`, `action_type:"NATIVE_LAUNCH"`, `metaTag:"https://..."`.
- Control channel `ws://192.168.1.2:8001/api/v2?name=<b64>` (or wss 8002): `{"id":"<appId>","method":"ms.application.start","params":{"id":"<appId>"}}` and `{"id":"<appId>","method":"ms.application.get","params":{"id":"<appId>"}}` -> `{"id":..,"result":{"visible":..}}`. Error 404 means not found.
- `{"method":"ms.channel.emit","params":{"event":"ed.installedApp.get","to":"host","data":""}}` returns `data.data:null` on 2020 firmware. Older firmware gave `[{appId,name,app_type(2=deep link,4=native),icon}]`.
- `{"method":"ms.channel.emit","params":{"event":"ed.apps.icon","to":"host","data":{"iconPath":"/opt/share/webappservice/apps_icon/FirstScreen/<appId>/250x250.png"}}}` -> `ed.apps.icon` with `imageBase64` (older TVs only).
- The `ed.edenTV.update` event on the remote channel marks a Smart Hub/app change and should trigger a REST rescan.
- Block dangerous keys: KEY_FACTORY (service menu) and the 3D/service sequences.

## Now playing
YouTube: SSDP or DIAL description -> `Application-URL` header -> `GET <appUrl>YouTube` -> `<additionalData><screenId>`. Then `POST https://www.youtube.com/api/lounge/pairing/get_lounge_token_batch` (screen_ids=<screenId>) -> loungeToken, then `POST https://www.youtube.com/api/lounge/bc/bind?RID=1&VER=8&CVER=1&auth_failure_option=send_error` with `{app:'web','mdx-version':'3',name,id:screenId,device:'REMOTE_CONTROL',capabilities:'que,dsdtr,atp,vsp',magnaKey:'cloudPairedDevice',ui:'false',theme:'cl',loungeIdToken}`. Long-poll for `nowPlaying` and `onStateChange` `{videoId,currentTime,duration,state}`.
DIAL state for other apps: `GET http://192.168.1.2:8080/ws/apps/Netflix` -> `<state>running|stopped</state>`.
CineHD: have pvcinehd01.MediaService push `{title, source, position, duration, decodedSize}` to the PC server (WebSocket client to the PC) as first-party now-playing data.

## Channels
`KEY_CHUP`, `KEY_CHDOWN`, `KEY_PRECH`, `KEY_CH_LIST`, `KEY_GUIDE`, digits `KEY_0..KEY_9` with 400 ms gaps then `KEY_ENTER`. On an HDMI set-top box these only work through Anynet+ CEC passthrough (verify per box). The SmartThings `tvChannel` commands apply to the built-in tuner only.

## Risks

- KEY_POWER is a toggle. With a stale state, 'off' turns the TV ON (Homey issue #60). Always re-read REST PowerState right before sending, and treat 'unknown' as do-nothing.
- A Press/Release hold of KEY_POWER of about 5 s is Samsung's documented soft reset (the TV reboots). The 3 s hold used by HA/homebridge is Frame-only; never use it on the Q95T.
- WS connects can pop the Allow dialog, and HA notes that on some TVs opening a websocket turns the TV on. Use REST, never WS, for status polling.
- Wi-Fi WoL depends on the access point forwarding broadcasts, client isolation, the correct wifiMac and 'Power On with Mobile'. Many users report it unreliable. On Windows with extra adapters (VPN, Hyper-V, WSL) a broadcast may leave on the wrong interface unless the socket is bound to the LAN address.
- The standby REST window is short (about 17-60 s), and standby network wakes (about every 25 min) can produce false 'on' events if reachability is used instead of PowerState.
- REST latency is about 1.3 s per call on this TV. Sweeping many app IDs is slow and adds load while someone is watching. Poll only the last-visible app and a short list; whether parallel requests are safe is untested.
- 'running' is meaningless (preloaded apps), and the same app reports different 'running' values under its WAS and Tizen IDs. Only 'visible' is usable.
- There is no local API for the installed-app list on 2020 firmware, and India app IDs are not public. The app grid needs a companion app, sdb, or manual learning.
- sdb (26101) is shared with the CineHD deploy and emulator agents and only accepts the TV's developerIP host. Using it from the remote server can collide with their sessions.
- SmartThings is cloud-only, adds latency, and is stale without a refresh command. PATs expire every 24 h (since 30 Dec 2024), so an OAuth app is needed. Commands return 409 when the TV is offline.
- The companion input-switch route (tvwindow.setSource plus launching org.tizen.tv-viewer) is proven only on a 2022 Tizen 6.5 TV. Launching system apps from a third-party app may be blocked on Tizen 5.5, and tvwindow likely needs the companion in the foreground.
- Key macros through the source bar break if the bar order changes (new HDMI device, CEC names) and give no read-back.
- The YouTube Lounge API is unofficial, may show a connected-device toast on the TV, and can change without notice.
- Channel keys may not reach an HDMI set-top box (CEC passthrough varies by box), so channel controls could silently do nothing on HDMI inputs.

## Open questions

- Does this Q95T keep answering REST /api/v2/ in standby, and for how long? Does PowerState read exactly 'standby'? Do 8002 and 9197 stay up? (Needs a supervised off/on cycle while nobody is watching.)
- Does Wi-Fi WoL wake this Q95T after more than 1 minute of standby? Is 'Power On with Mobile' enabled? Does KEY_POWER over WS wake it inside the standby window?
- On this firmware, do KEY_HDMI, KEY_HDMI1..4 or KEY_TV do anything? What is the source-bar order after KEY_SOURCE?
- Does ws ed.installedApp.get return data (or null) on this 2020 firmware? Does ed.apps.icon reply?
- Does REST POST /api/v2/applications/<id> launch apps without pairing on this TV, and does DELETE close them?
- Is the TV linked to SmartThings (device ID, supportedInputSourcesMap names, tvChannelName values for the Indian apps)?
- Exact WAS and Tizen IDs on this TV for JioHotstar, SonyLIV, ZEE5 (India), Sun NXT, MX Player and Samsung TV Plus. These can be learned once via companion getAppsInfo or Tizen Studio 'Installed Web App List'.
- On Tizen 5.5, does tizen.tvwindow.setSource + tizen.application.launch('org.tizen.tv-viewer') from a user-signed app switch the real input? Does getSource('MAIN') report the real last input? What does systeminfo SOURCE_INFO return?
- Does addAppStatusChangeListener fire for system apps such as org.tizen.tv-viewer, which would give a local 'watching HDMI n' signal? Can a background web service app (like pvcinehd01.MediaService) use it?
- Which set-top box is on which HDMI port, and does it obey Anynet+/CEC channel and number passthrough?
- Does enabling Expert Settings > IP Remote populate the empty IPControlService SCPD on port 9110 with actions (for example, input or power)?
- Does the TV tolerate parallel REST app queries, or are they serialized (which affects sweep time)?
