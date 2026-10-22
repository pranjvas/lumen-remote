# Live findings on the Q95T (2026-10-21)

TV: Samsung QA55Q95TAKXXL (2020, Tizen 5.5, firmware build `TIZEN-TRUNK2020-NikeM-HOTFIX-RELEASE_20260703.2`) at 192.168.1.2.
Everything below was observed on this TV today unless marked otherwise. Network identifiers (MACs, SSID) are deliberately left out.

## Control surfaces that work

| Surface | Port | Auth | Verified today |
|---|---|---|---|
| REST device/app status | 8001 HTTP | none | `GET /api/v2/` (PowerState, model, resolution, developer mode); `GET /api/v2/applications/<id>/` (trailing slash required) returns `running` / `visible` / `version` for an app ID |
| Remote-control channel | 8002 WSS (self-signed) | token, issued once after the on-screen "Allow" | Paired as **Lumen Remote**; token reconnect is silent (~1.3 s). TV pushes `ms.remote.touchEnable` / `touchDisable` as screens change. `ed.installedApp.get` gets **no reply** on this firmware |
| UPnP RenderingControl | 9197 HTTP SOAP | none | `GetVolume`/`GetMute` and `SetVolume`/`SetMute` work (~0.4 s). **SetVolume unmutes the TV.** |
| Samsung Consumer IP Control | 1516 HTTPS JSON-RPC 2.0 | `createAccessToken` + on-screen Allow | Server `Samsung IP Control Server/1.0`, cert CN `Samsung IP Control G2`; Node needs `ciphers: 'DEFAULT@SECLEVEL=0'`. Token-less call -> `-32700`. All getters below answered |
| On-TV agent (our Tizen app) | DevTools via `sdb debug` | developer mode + our signed app | See "On-TV agent" |

### IP Control getters that answered (GET = params contain only `AccessToken`)

```
getTVStates      {inputSource:"TV", mute:"muteOff", pictureMode:"Standard", pictureSize:"16:9", soundMode:"Amplify", speakerSelect:"internal", volume:2}
getVideoStates   {brightness:2, color:25, contrast:50, sharpness:7, tint:0}      (brightness = Shadow Detail)
backlightControl {backlight:10}                                                   (menu "Brightness", 0-50)
colorToneControl {colorTone:"Standard"}      localDimmingControl {localDimming:"High"}
autoMotionPlusControl {autoMotionPlus:"Off"} digitalCleanViewControl {digitalCleanView:"Off"}
contrastEnhancerControl {contrastEnhancer:"High"} filmModeControl {filmMode:"Off"}
gammaModeControl {gammaMode:"BT.1886"}       speakerSelectControl {speakerSelect:"Internal"}
externalSpeakerControl {}                    pictureModeControl {pictureMode:"Standard"}  soundModeControl {soundMode:"Amplify"}
```

UPnP and IP Control agreed on volume and mute when read back to back.

## On-TV agent (`lumenrmt01.LumenAgent`, signed with the user's Q95T profile)

- Installed with `sdb push` + `shell 0 vd_appinstall`. The TV accepted every requested privilege, including `tv.audio`, `tv.window`, `tv.display`, `tv.channel`, `application.info`, `application.launch`, `productinfo`.
- **UI page context** can read:
  - `tizen.tvaudiocontrol`: volume, mute, output mode (`PCM`), and `setVolumeChangeListener` fires on every change (verified with UPnP 4->5->4). Mute changes do not fire it.
  - `tizen.tvwindow.getSource()` -> `{type:"TV", number:1}`; `tizen.systeminfo` `VIDEOSOURCE` lists connected inputs (TV, HDMI1) and disconnected ones (AV1, HDMI2-4).
  - `tizen.tvchannel.getCurrentChannel()` -> channel name/number (Samsung TV Plus "Ace TV" 1927); `webapis.hybridchannelinfo.getCurrentChannel()` adds `channelType: TVPLUS`.
  - `tizen.systeminfo`: BUILD (firmware build string), PANEL 3840x2160, CPU load, memory (1.97 GB total, ~84 MB available at the time), STORAGE, LOCALE. `DISPLAY.brightness` is a constant `1` (not the backlight).
  - `tizen.application.getAppsInfo()` -> all 406 installed apps with names and icon paths (226 visible); `getAppsContext()` -> running app IDs.
  - Only `avplay, avplaystore, bixby, featureconfig, hybridchannelinfo` exist on `webapis` unless the page loads `$WEBAPIS/webapis/webapis.js`.
- **Service context** (Node v4.4.3): `tizen` has only application, systeminfo, datacontrol, filesystem, messageport, package, alarm, time. **No TV APIs.** The page must run to read TV state.
- **Hidden operation works**: after `tizen.application.getCurrentApplication().hide()` the page kept a 1 s timer at full rate and every TV API kept answering; REST reported `running:true, visible:false`.
- **Lifetime is not guaranteed**: some minutes later the agent (and CineHD) were no longer running. Cause unknown (low memory, or a user Exit/Home).
- **Security**: while an app runs in debug mode, its DevTools port is reachable from the whole LAN (`GET http://192.168.1.2:<port>/json` -> 200). The long-running agent must not stay in debug mode; it should talk to its own loopback service, which the PC reaches through the developer-mode sdb tunnel.

## Emulator

The Tizen 5.5 TV emulator (QEMU user networking) runs DIAL (7678, 8080) but **not** the remote channel (8001/8002), the DMR (9197) or IP Control. It can host the agent's UI for development only.

## Gaps still open

- Key sending over the paired channel has not been exercised yet.
- IP Control writes (e.g. backlight) not yet tried; research says they are refused (-32002) in Dynamic mode.
- Agent lifetime while hidden needs measuring; relaunch path without debug mode (`ed.apps.launch` or REST) untested.

## Soak check (2026-10-22 02:55 IST)

- Lumen ran overnight against the TV (server up 46 min since the last restart, earlier runs before that): 58 INFO log lines, **no WARN or ERROR**, GENA push still live, both pairings intact.
- **Agent 0.2.0 lifetime:** launched 00:34 IST, still online at 02:55 (2 h 20 min), while CineHD was opened in front of it. It reconnected by itself within seconds after each of two server restarts (backoff 2/5/10/30 s). The TV had about 79 MB free at the time.
