# Research area: local-services-live

## Summary

I probed the Q95T (192.168.1.2) live with read-only calls only: HTTP GETs, SOAP getters, and GENA SUBSCRIBE/UNSUBSCRIBE. No other side effects. The DMR on port 9197 is the only local service that exposes live audio state. GetVolume returned 4 and GetMute returned 1, so the TV is currently muted. GetVolume answers in about 12 ms (median of 5), and the SCPD gives Volume as ui2 0-100 step 1. X_GetServiceCapabilities reports exactly "GetVolume,SetVolume,GetMute,SetMute". GENA eventing works: SUBSCRIBE returned 200 with a SID, and the initial NOTIFY reached a temporary node.exe callback server on the PC about 0.5 s later, so inbound traffic is not blocked by the firewall at the moment. That NOTIFY's LastChange carried Mute, Volume, PresetNameList, X_360View, X_AspectRatio, X_Captions, X_EnabledCaptions and X_ServiceCapabilities. I could not observe whether the TV pushes a NOTIFY when someone changes the volume with the physical remote, because nobody changed it during the window. The TV grants any requested GENA timeout, including "infinite", so subscriptions must be finite and always unsubscribed. AVTransport and ConnectionManager only describe DLNA push sessions (currently NO_MEDIA_PRESENT). They do not show what an app is playing. No local service exposes brightness, backlight, picture mode, input source or channel. RenderingControl has no Brightness/Contrast actions, port 7676 (MainTVAgent2) is closed, and IPControlService on 9110 has an empty SCPD (the samsungctl test fixture captured from a 2017 TV is also empty). Those features must come from an on-TV companion app or SmartThings. For "now playing app", GET /api/v2/applications/<id>/ on 8001 returns {id,name,running,visible,version}. CineHD TV (pvcinehd01.CineHDTV, version 0.17.421) is currently visible:true. Several apps report running:true while in the background, so only `visible` means foreground. Each app-status query takes about 1.35 s, and the TV processes them one at a time. DIAL on 8080 (/ws/app/<Name>) answers in about 30 ms with stopped/running state, which differs from REST's `running` flag. REST device info (8001 and 8002, also served over https with a self-signed SmartViewSDK cert) answers in about 13 ms. It gives PowerState, model, resolution, language and country, and it echoes the request Origin in CORS headers. I also found three unexpected things. Port 9080 is a Netflix NRDP server, and its Date header shows the TV's local time and timezone (IST). The DIAL SCPD on 7678 lists an undocumented SendKeyCode action, which I did not call. YouTube's DIAL response leaks a lounge screenId, which could be used for YouTube now-playing data.

## Capabilities

- **read current volume (0-100)** (live-tv, high; read=true write=false live=true): SOAP POST http://192.168.1.2:9197/upnp/control/RenderingControl1, SOAPACTION "urn:schemas-upnp-org:service:RenderingControl:1#GetVolume", args InstanceID=0, Channel=Master -> <CurrentVolume>
  - Returned 4 today. Latency median 11.6 ms (25.6/11.2/15.3/9.9/11.6). SCPD: Volume ui2 min 0 max 100 step 1, Channel allowedValue only 'Master'. No auth or pairing needed and no on-screen prompt. Cheap enough to poll every 1-2 s as a fallback for eventing.
- **read mute state** (live-tv, high; read=true write=false live=true): SOAP RenderingControl#GetMute (InstanceID 0, Channel Master) -> <CurrentMute>1|0</CurrentMute>
  - Returned 1 today, meaning the TV is muted. The value is '1'/'0', not 'true'/'false'. Latency about 14 ms.
- **push updates of volume/mute (GENA LastChange)** (live-tv, medium; read=true write=false live=true): SUBSCRIBE http://192.168.1.2:9197/upnp/event/RenderingControl1 with CALLBACK:<http://<pc>:<port>/path>, NT:upnp:event, TIMEOUT:Second-N; TV POSTs NOTIFY with propertyset/LastChange (escaped RCS Event XML)
  - Observed live: SUBSCRIBE returned 200, and the initial NOTIFY (SEQ 0) arrived about 510 ms later at a node.exe callback bound to 0.0.0.0 on a random port, so inbound traffic was not blocked by the firewall today. I did not change or inspect any firewall rules. NOT observed: a NOTIFY caused by a volume change from the physical remote or from keys, because nothing changed during the window. Home Assistant's samsungtv integration relies on these events (on_event plus async_subscribe_services(auto_resubscribe=True)), and a community report says HA's slider follows remote changes (on a 2015 J-series TV). Validate on this TV with the user's consent. If push does not happen, poll GetVolume.
- **set exact volume / set mute** (source-code, medium; read=false write=true live=false): SOAP RenderingControl#SetVolume (InstanceID 0, Channel Master, DesiredVolume 0-100) and #SetMute (DesiredMute 0/1)
  - The actions are listed in the live SCPD, and live X_GetServiceCapabilities reports 'GetVolume,SetVolume,GetMute,SetMute'. I did not call them, per the hard rules. HA uses async_set_volume_level through DMR but sends KEY_VOLUP/KEY_VOLDOWN over WebSocket for step changes. Community reports show UPnP 501 'Action Failed' on SetVolume for some models. Untested on this TV, and it may not apply when audio goes to an external output (ARC/BT).
- **read DMR extras: aspect ratio, captions, slideshow, presets** (live-tv, high; read=true write=false live=true): SOAP RenderingControl#X_GetAspectRatio, #X_GetCaptionState, #X_GetTVSlideShow, #ListPresets, #X_GetServiceCapabilities (all InstanceID 0)
  - AspectRatio=Default (allowed values: Default, FitScreen). Captions and EnabledCaptions are empty. TVSlideShow returns CurrentShowState 0, CurrentThemeId 0, TotalThemeNumber 0. Presets list only 'FactoryDefaults'. These values almost certainly describe the DMR player session, not the TV's global picture settings (inferred). LastChange also carries X_360View with latitudeCenter 0.0000, longitudeCenter 0.0000 and scaleFactor 2.4000.
- **DLNA transport state / now-playing for DLNA-pushed media** (live-tv, high; read=true write=false live=true): SOAP AVTransport1 GetTransportInfo, GetMediaInfo, GetPositionInfo, GetTransportSettings, GetCurrentTransportActions, GetDeviceCapabilities, X_GetStoppedReason; GENA /upnp/event/AVTransport1
  - Every getter returned 200. TransportState is NO_MEDIA_PRESENT, Status OK, Speed 1, NrTracks 0, MediaDuration 0:00:00, PlayMedium NETWORK,NONE, and Actions is empty. The AVTransport initial NOTIFY arrived and contained 22 variables. This only reflects media pushed over DLNA/UPnP (SetAVTransportURI). It does NOT reflect playback inside Netflix, YouTube or CineHD. It is still useful if the remote offers 'cast URL to TV': ProductCap includes WebURIPlayable.
- **supported DLNA media formats** (live-tv, high; read=true write=false live=true): SOAP ConnectionManager1#GetProtocolInfo; GetCurrentConnectionIDs; GetCurrentConnectionInfo(ConnectionID 0)
  - The Sink list has 292 http-get entries (29 KB) across 34 MIME types, including video/mp4, video/x-mkv, video/hevc, video/webm, audio/x-flac, image/jpeg, image/png and smi/caption. Source is empty. ConnectionIDs is 0. ConnectionInfo returns Direction Input, Status Unknown, PeerConnectionID -1.
- **foreground ('now playing') app detection** (live-tv, high; read=true write=false live=false): GET http://192.168.1.2:8001/api/v2/applications/<appId>/ (trailing slash mandatory) -> {"id","name","running","version","visible"}
  - CineHD TV (pvcinehd01.CineHDTV, v0.17.421) is running:true, visible:true. Netflix, YouTube, Prime Video, Apple TV and Internet report running:true, visible:false, so they are background or preloaded processes. Only `visible` means foreground. running and visible are JSON booleans. Each query takes about 1.3-1.4 s (CineHD median 1407 ms; a 404 costs 1347 ms). The TV handles them serially: three requests started 250 ms apart finished at 1.38 s, 3.98 s and 3.98 s. Two bursts of consecutive requests hit 6 s client timeouts, and the same IDs returned 200 in about 1.4 s on retry. Use one single-flight queue with 10-15 s timeouts and only probe a short list of likely apps. If no listed app is visible, the TV is probably on Live TV/HDMI or a system app (inferred). openHAB uses the same signal through the WebSocket method ms.application.get and notes 'app does not report visible' until about 3 s after launch.
- **installed-app check and app version** (live-tv, high; read=true write=false live=false): Same REST GET: 200 = installed (with version), 404 {"code":404,"message":"Not found error.","status":404} = not installed or wrong ID
  - Returned 200: 3201907018807 Netflix 80.25.23140; 111299001912 YouTube 2.1.498; 9Ur5IzDKqV.TizenYouTube (same app, but reported running:false); 3201910019365 Prime Video 5.3.21; 3201807016597 Apple TV 16.2.0; 3201606009684 Spotify 2.1.66; 3201512006963 Plex 5.64.1; 3201907018784 Internet 3.5.10100; 3201910019378 SmartThings 2.0.116; 3201710015037 Gallery 2.0.46; 3201908019041 Apple Music 16.2.0; 3202004020626 Amazon Alexa 0.20.08060; 3201807016658 Samsung Promotion 3.2.96; pvcinehd01.CineHDTV. Returned 404: 11101200001, org.tizen.netflixapp, 3201512006785, 3201901017640 (Disney+), 3201810017104 (ZEE5), org.tizen.browser, 3201710015016, com.samsung.tv.iotdashboard, 3201909019211, 20202100002, 3202008021577, 3201808016802, 3201707014489, 3202004020674, 3202203026841, pvcinehd01 (package ID rather than app ID). 3202203026799 (Xbox) timed out once and I did not retry it. I found no sourced IDs for Disney+ Hotstar, JioCinema, SonyLIV or Samsung TV Plus, so I did not guess. The REST API has no list endpoint: GET /api/v2/applications/ hung.
- **DIAL app state (Netflix, YouTube)** (live-tv, high; read=true write=false live=false): GET http://192.168.1.2:8080/ws/app/<Name> (the Application-URL header from 7678/nservice/ is http://192.168.1.2:8080/ws/app/; /ws/apps/<Name> also works)
  - Netflix: state stopped, version 80.25.23140, allowStop true. YouTube: state stopped, version 2.1.498, plus additionalData with brand, model, screenId, deviceId and theme. Median latency 31.6 ms, and the response includes Access-Control-Allow-Origin: *. DIAL says 'stopped' while REST says running:true, so DIAL state is closer to 'active session' (inferred). Treat the YouTube screenId as a secret.
- **power state** (live-tv, medium; read=true write=false live=false): GET http://192.168.1.2:8001/api/v2/ -> device.PowerState
  - 'on' was observed today, with about 13 ms latency. The standby value and whether the endpoint answers in standby were NOT observed. HA treats PowerState == 'on' as on and anything else as off, and checks it before opening a WebSocket because opening one can wake the TV.
- **device/system info for the Info view** (live-tv, high; read=true write=false live=false): GET http://192.168.1.2:8001/api/v2/ (also https://192.168.1.2:8002/api/v2/), plus DMR description /dmr on 9197
  - Available fields: name '[TV] PV-TV', modelName QA55Q95TAKXXL, model 20_NIKEM_QTV, resolution 3840x2160, OS Tizen, Language en_GB, countryCode IN, networkType wireless, developerMode 1 (developerIP is set to this PC), smartHubAgreement true, VoiceSupport, GamePadSupport, FrameTVSupport false, WallService false, firmwareVersion 'Unknown', and isSupport flags DMP_DRM_PLAYREADY false and DMP_DRM_WIDEVINE false. The response also contains wifiMac and a BSSID-like 'ssid' field. Redact those, and the serial number from the descriptions, before showing anything.
- **read brightness/backlight/contrast/picture mode** (live-tv, high; read=false write=false live=false): None on local services: no Brightness/Contrast/Sharpness actions in RenderingControl, MainTVAgent2 (port 7676) closed, IPControlService SCPD empty
  - The live SCPD contains no picture actions, and the X_ServiceCapabilities event only lists volume and mute. openHAB docs say brightness, contrast, sharpness and colorTemperature 'only work on legacy interface TV's (<2016)'. samsungctl captures from 2017 Tizen TVs show the same gap. These settings must come from an on-TV companion app, SmartThings, or menu-navigation and tracked state.
- **read input source / channel / program** (live-tv, high; read=false write=false live=false): None on local services (2016+ TVs dropped MainTVAgent2 GetCurrentExternalSource/GetCurrentMainTVChannel)
  - Port 7676 is closed and no service on 9197, 9110, 9119 or 7678 exposes source or channel. openHAB says sourceName, sourceId, channel, channelName and programTitle need the SmartThings cloud on TVs newer than 2016.
- **IPControlService (9110) actions** (source-code, medium; read=false write=false live=false): http://192.168.1.2:9110/ip_control -> service urn:samsung.com:service:IPControlService:1, control /upnp/control/IPControlService1, SCPD /IPControlService_1.xml
  - Both /IPControlService_1.xml and /ip_control/IPControlService_1.xml return an empty 165-byte <scpd> with no actions. The kdschlosser/samsungctl test fixture captured from a 2017 TV is identical (176 bytes, empty). No public source documents any action, so I did not probe any. Samsung's consumer IP Control worksheet says control partners write their own drivers. It says 'IP Remote' must be enabled under Settings > General > Network > Expert Settings (2021 and older), and 'Power On With Mobile' enables wake-up.
- **key send via DIAL RCR SendKeyCode (possible alternative to the WebSocket)** (live-tv, low; read=false write=true live=false): SOAP POST http://192.168.1.2:7678/RCR/control/dial, action urn:dial-multiscreen-org:service:dial:1#SendKeyCode(KeyCode ui4, KeyDescription string)
  - The action is listed in the live SCPD (/nservice/dial.xml), and the same SCPD is in the samsungctl 2017 fixture. It is undocumented, and I found no source showing it works or which KeyCode values it takes. I did NOT call it because it has side effects. Test it only with the user present.
- **GENA subscription lifecycle semantics** (live-tv, high; read=true write=false live=true): SUBSCRIBE (new: CALLBACK+NT+TIMEOUT; renew: SID+TIMEOUT), UNSUBSCRIBE (SID)
  - Requested Second-60, Second-1800 and 'infinite' were all granted as requested ('Second-infinite'). A renewal asking for Second-300 returned the original Second-1800 with the same SID. Renewing an unknown SID returns 412. UNSUBSCRIBE returns 200, and 412 if repeated. Every NOTIFY has SEQ 0 on a new subscription, NTS upnp:propchange, Connection: close, and a Host header naming the PC. The server header is 'UPnP/1.1 Samsung AllShare Server/1.0'. All test subscriptions were unsubscribed.
- **TV local clock / timezone** (live-tv, medium; read=true write=false live=false): GET http://192.168.1.2:9080/ -> 'status=ok', Date header in TV local time
  - Server: NRDP/2025.2.3.0-8005e55f285 (Netflix Ready Device Platform). Date: 'Wed, 21 Oct 2026 15:20:51 IST', while the other servers send GMT. Usable as a small 'TV clock/timezone' readout, though it is obscure.
- **YouTube now-playing via Lounge API (screenId from DIAL)** (source-code, low; read=true write=true live=true): DIAL GET /ws/app/YouTube additionalData.screenId -> pyytlounge get_screen_id_from_dial / pair_with_screen_id / get_now_playing (cloud YouTube lounge)
  - The screenId is present live, but I did not test pairing (it goes to the cloud and may show 'device connected' in the YouTube app). This only works while YouTube is the active app. It is an optional enrichment for the dashboard.
- **browser direct access / CORS** (live-tv, high; read=true write=false live=false): Origin header test on GETs
  - 8001 REST echoes the request Origin in Access-Control-Allow-Origin. 8080 DIAL sends ACAO: *. 9197 DMR sends no CORS headers, and SOAP needs a SOAPACTION header plus a preflight, so a browser cannot call it directly. 8002 uses a self-signed cert (subject CN=SmartViewSDK, issuer 'SmartViewSDK Root Ceritificate Authority', 2016-09-21 to 2036-09-21, RSA 2048, TLS1.2 ECDHE-RSA-AES256-SHA384). Recommendation: proxy everything through the PC's Node server.
- **on-TV volume listener (cross-reference for when GENA does not push)** (source-code, medium; read=true write=true live=true): tizen.tvaudiocontrol.setVolumeChangeListener / getVolume / isMute / getOutputMode in a companion Tizen app (privilege believed to be http://tizen.org/privilege/tv.audio)
  - The SDK's TV simulator stub (tools/sec-tv-simulator/ripple.js) implements setVolumeChangeListener and getOutputMode. The official doc URL now redirects, and the privilege string is from memory (inferred). Not this area's focus; listed as a fallback.

## Protocol details

## Port map (live, 2026-10-21)
| Port | What it is | Notes |
|---|---|---|
| 7678 | `/nservice/` DIAL dialreceiver ("Samsung DTV RCR"). `Application-URL: http://192.168.1.2:8080/ws/app/`. SCPD `/nservice/dial.xml` (also `/dial.xml`) lists **SendKeyCode(KeyCode ui4, KeyDescription string)**, control `/RCR/control/dial`, event `/RCR/event/dial`. `sec:Capability samsung:multiscreen:1 port=8001 location=/ms/1.0/` | SendKeyCode not called |
| 8001 / 8002 | REST `/api/v2/` (http and https, same JSON). App status at `/api/v2/applications/<id>/` | Unknown or slashless paths hang with no response |
| 8080 | DIAL REST `/ws/app/<Name>` and `/ws/apps/<Name>` (XML, dialVer 2.2, ACAO *). `/` returns 404 html | Never touch `/ws/pairing` |
| 8187 | "UPnP/1.1 Samsung AllShare Server/1.0". Any GET (`/`, `/smp_2_`) returns HTTP/1.0 400 with a SOAP Fault UPnPError 402 "Invalid Args" | No description found; likely an internal SOAP/GENA sink (inferred) |
| 9080 | Netflix NRDP/2025.2.3.0. `GET /` returns `status=ok`. Date header in local time (IST) | |
| 9110 | `/ip_control` IPControlServer. SCPD `/IPControlService_1.xml` is empty | |
| 9119 | `/screen_sharing`. SCPD `/ScreenSharingService1_1.xml`: X_ConnectScreenSharingM2TV / X_ConnectScreenSharingTV2M (writes) and evented ScreenSharingState (RUNNING, CHECKING_ACL). The description embeds MAC/BSSID values, so redact them | |
| 9197 | `/dmr` MediaRenderer (RenderingControl_1.xml, AVTransport_1.xml, ConnectionManager_1.xml) | Main live-state source |
| 9999 | Accepts TCP, sends no banner in 3 s, returns an empty reply to HTTP (curl exit 52) | Unknown |
| 8000 | Now closed (connection refused) | |

## Working SOAP envelope (any getter)
```http
POST /upnp/control/RenderingControl1 HTTP/1.1
Host: 192.168.1.2:9197
Content-Type: text/xml; charset="utf-8"
SOAPACTION: "urn:schemas-upnp-org:service:RenderingControl:1#GetVolume"

<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetVolume></s:Body></s:Envelope>
```
Response: `<u:GetVolumeResponse ...><CurrentVolume>4</CurrentVolume>\n</u:GetVolumeResponse>`. Each value is followed by a newline, so trim it. Mute is `1` or `0`.

Use the same pattern for AVTransport (`urn:schemas-upnp-org:service:AVTransport:1`, `/upnp/control/AVTransport1`, arg InstanceID 0) and ConnectionManager (`/upnp/control/ConnectionManager1`; GetProtocolInfo and GetCurrentConnectionIDs take no args; GetCurrentConnectionInfo takes ConnectionID 0).

Exact responses today:
- RC: ListPresets returned `FactoryDefaults`. X_GetAspectRatio returned `Default`. X_GetCaptionState returned empty Captions and EnabledCaptions. X_GetServiceCapabilities returned `GetVolume,SetVolume,GetMute,SetMute`. X_GetTVSlideShow returned 0/0/0.
- AVT: GetTransportInfo returned NO_MEDIA_PRESENT / OK / 1. GetMediaInfo returned NrTracks 0, MediaDuration `0:00:00` (single-digit hour, unlike the SCPD default `00:00:00`), empty URIs, PlayMedium `NETWORK,NONE`, Rec* NOT_IMPLEMENTED. GetPositionInfo returned Track 0, times `0:00:00`, RelCount/AbsCount 2147483647. GetDeviceCapabilities returned `NETWORK,NONE`. GetTransportSettings returned NORMAL. GetCurrentTransportActions returned empty. X_GetStoppedReason returned empty.
- CM: Sink lists 292 entries. ConnectionIDs is `0`. ConnectionInfo returns Rcs 0, AVT 0, Direction Input, Status Unknown, Peer -1.
- Not called because the name is outside the Get/List/X_Get rule: X_DLNA_GetBytePositionInfo, X_PlayerAppHint, X_PrefetchURI.

Error format (seen on 8187): `<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>402</errorCode><errorDescription>Invalid Args</errorDescription></UPnPError></detail></s:Fault>`. HA builds its UPnP factory with `non_strict=True` "to avoid invalid data sent by Samsung TV".

## GENA (live-verified)
```http
SUBSCRIBE /upnp/event/RenderingControl1 HTTP/1.1
Host: 192.168.1.2:9197
CALLBACK: <http://<pc-lan-ip>:<port>/rc>
NT: upnp:event
TIMEOUT: Second-300
```
Reply: `200`, `SID: uuid:...`, `TIMEOUT: Second-300` (granted exactly as requested; `infinite` is also accepted, so never use it).
- Renew: `SUBSCRIBE` with `SID:` and `TIMEOUT:` and no CALLBACK/NT. The TV keeps the original timeout. An unknown SID returns 412, so resubscribe from scratch.
- Cancel: `UNSUBSCRIBE` with `SID:` returns 200. A repeat returns 412.
- The initial NOTIFY arrives about 0.5 s after subscribe. Headers: `NT: upnp:event`, `NTS: upnp:propchange`, `SEQ: 0`, `SID`, `Connection: close`. The callback must answer 200.

RenderingControl initial body (unescaped inner XML):
```xml
<Event xmlns="urn:schemas-upnp-org:metadata-1-0/RCS/"><InstanceID val="0"><Mute channel="Master" val="1"/><PresetNameList val="FactoryDefaults"/><Volume channel="Master" val="4"/><X_360View latitudeCenter="0.0000" longitudeCenter="0.0000" scaleFactor="2.4000" val=""/><X_AspectRatio val="Default"/><X_Captions val=""/><X_EnabledCaptions val=""/><X_ServiceCapabilities val="GetVolume,SetVolume,GetMute,SetMute"/></InstanceID></Event>
```
The AVTransport initial event carries 22 variables, including TransportState NO_MEDIA_PRESENT, CurrentTransportActions, AVTransportURI and PlaybackStorageMedium.

Parsing: the outer document is `e:propertyset/e:property/LastChange`. Its text is entity-escaped XML, so parse it twice:
```js
const lc = /<LastChange>([\s\S]*?)<\/LastChange>/.exec(body)[1]
  .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&');
const state = {}; for (const m of lc.matchAll(/<(\w+)((?:\s+\w+="[^"]*")*)\s*\/>/g)) {
  const attrs = Object.fromEntries([...m[2].matchAll(/(\w+)="([^"]*)"/g)].map(a=>[a[1],a[2]]));
  state[m[1]] = attrs.val; }   // state.Volume === '4', state.Mute === '1'
```
Treat each NOTIFY as a partial update (merge it into stored state). Keep a 1-2 s GetVolume poll as a safety net until change-push is confirmed.

## REST
- `GET http://192.168.1.2:8001/api/v2/` takes about 13 ms. `isSupport` is a JSON string inside JSON, so parse it twice.
- `GET /api/v2/applications/<id>/` returns `{"id":"pvcinehd01.CineHDTV","name":"CineHD TV","running":true,"version":"0.17.421","visible":true}` or a 404 `{"code":404,"message":"Not found error.","status":404}`.
- The trailing slash is mandatory. `/api/v2` (no slash), `/ms/1.0/` and `/api/v2/applications/` never respond and time out after 6 s. Always set client timeouts.
- App status costs about 1.35 s each and the TV processes requests serially. Bursts produced several 6 s timeouts. Use one queue and 10-15 s timeouts, and poll the foreground app about every 10 s over a short candidate list. openHAB polls every 10 s.
- `running` is not the same as foreground. Use `visible`.

## DIAL
`GET http://192.168.1.2:8080/ws/app/Netflix` returns
`<service xmlns="urn:dial-multiscreen-org:schemas:dial" dialVer="2.2"><name>Netflix</name><options allowStop="true"/><state>stopped</state><version>80.25.23140</version><link rel="run" href="run"/></service>`.
YouTube adds `<additionalData>` with brand, model, screenId, deviceId, theme, yumi and passiveSessionId. That is sensitive, so do not log it.

## Latency (median of 5, spaced 350 ms)
| Call | Median |
|---|---|
| GetVolume | 11.6 ms |
| REST /api/v2/ | 13.3 ms |
| REST app (CineHD, 200) | 1406.9 ms |
| REST app (404) | 1346.6 ms |
| DIAL Netflix | 31.6 ms |

GENA initial NOTIFY: about 0.5 s.

## Scratch scripts
All under C:/Users/pranj/AppData/Local/Temp/tvremote-research/local-services-live/: soap.js, rest.js, retry.js, latency.js, overlap.js, gena.js, gena2.js. Raw results are in soap_results.json and rest_apps.json.

## Risks

- The live design depends on push updates for volume that I could not confirm. The initial GENA NOTIFY arrives, but I did not observe a NOTIFY after a remote-driven volume change. Ship with a 1-2 s GetVolume poll (about 12 ms per call) as a fallback.
- The TV grants GENA timeouts as requested, including 'infinite'. A crashed PC server could leave stale subscriptions that the TV keeps notifying. Always use finite timeouts (300-1800 s), renew at about 80% of the timeout, resubscribe on 412, and UNSUBSCRIBE on shutdown.
- Windows Firewall allowed inbound NOTIFY to node.exe today. That may change with the network profile (Public vs Private) or a different exe or port. Do not change firewall settings automatically; detect a missing initial NOTIFY and fall back to polling.
- REST app-status calls are slow (about 1.35 s) and handled one at a time. Polling many app IDs makes the 'now playing' readout lag by tens of seconds and can starve other clients such as HA or SmartThings. Bursts caused 6 s timeouts.
- The REST server never answers unknown paths or paths without the trailing slash. Without client timeouts, sockets hang.
- SetVolume/SetMute are untested on this TV. Community reports show UPnP 501 on some Samsung models, and DMR volume may not apply when audio goes to ARC/optical/Bluetooth.
- REST `running` is true for background or preloaded apps (Netflix, YouTube, Prime, Apple TV, Internet). Using it for 'now playing' would be wrong; only `visible` is reliable. DIAL `state` disagrees with REST `running`.
- Some services return identifying data: device info and descriptions include Wi-Fi/Ethernet/Bluetooth MACs, a BSSID-like 'ssid' field, and the serial number, and YouTube DIAL includes screenId/deviceId. Redact these in the UI and logs.
- DIAL SendKeyCode on 7678 is undocumented. Calling it could do anything, including showing a prompt on the TV, so test it only with the user present.
- Local services expose no picture settings (backlight, brightness, picture mode), no input source and no channel. The 'Settings/Info' view must rely on an on-TV companion app, SmartThings, or tracked/estimated state clearly labelled as such.

## Open questions

- Does the RenderingControl LastChange NOTIFY fire when volume or mute is changed with the physical remote or with WebSocket KEY_VOLUP/KEY_VOLDOWN? Test with the user's consent: subscribe, have them press volume, and watch SEQ increment.
- What does REST device.PowerState report in standby (expected 'standby'), and do ports 9197 and 8001 stay reachable then?
- Does GetVolume follow the real speaker level when sound output is a soundbar, ARC or Bluetooth device?
- Does DIAL SendKeyCode (7678 /RCR/control/dial) work on Tizen 5.5 without pairing, and which KeyCode values does it use?
- What are ports 8187 (AllShare SOAP, description unknown) and 9999 (TCP, empty reply) for?
- When the TV is on Live TV or an HDMI input, is every app visible:false? That would allow inferring 'TV/HDMI' as the source.
- What are the Tizen app IDs for Disney+ Hotstar, JioCinema, SonyLIV and Samsung TV Plus in the IN region? No public source had them. Getting them on the TV with tizen.application.getAppsInfo() in the CineHD service would also replace slow REST probing with an exact installed-app list.
- How many concurrent GENA subscribers does the TV allow, and does it drop subscribers whose callback is unreachable?
- Does the TV now run CineHD 0.17.421? REST reports version 0.17.421 for pvcinehd01.CineHDTV, which differs from the 0.17.411 recorded in memory.
