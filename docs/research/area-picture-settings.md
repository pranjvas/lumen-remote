# Research area: picture-settings

## Summary

The best way to read and set picture and sound settings on a 2020 Q95T is not SmartThings, UPnP or WebSocket keys. It is Samsung's Consumer IP Control: a JSON-RPC 2.0 service over HTTPS on TCP 1516 (2020 and later; 1515 was 2019 and earlier). It turns on when the user enables Settings > General > Network > Expert Settings > IP Remote, and a one-time on-screen Allow prompt pairs a token. Samsung's own 2020 and 2023 IP command lists for consumer TVs cover getTVStates (volume, mute, input, picture size, picture mode, sound mode) and getVideoStates (contrast, Shadow Detail, sharpness, color, tint). They also list read/write methods for Backlight 0-50 (called 'Brightness' in the 2020 menu), Color Tone, Local Dimming, Picture Clarity/AMP, Noise Reduction, Film Mode, Contrast Enhancer, gamma, white balance and color space, plus sound mode, speaker select and absolute volume. Open-source code confirms the wire format and has run it live on Frames from 2020 to 2025. A 2020 Q90T user reports Color Tone reads back (Warm2), and 2020 Frames serve 1516 but need a weak-DH TLS fallback (SECLEVEL=0). None of this was observed on this TV: port 1516 was not in today's port list. One encouraging sign: the TV advertises the UPnP device urn:samsung.com:device:IPControlServer:1 on 9110, and that comes from the same firmware module as the 1516 server. Its empty SCPD matches the 2025 decompile, where the UPnP part only publishes an IPControlState event. Picture writes are refused (-32002) in Dynamic mode, and each value belongs to the current picture mode and input, so the UI must re-read after any mode or input change. SmartThings is a weak fallback: it gives picture mode, sound mode, volume and input only (no backlight), needs the cloud, new tokens expire after 24 h, and Samsung said paid API tiers start no earlier than October 2026. UPnP RenderingControl presets are only 'FactoryDefaults' (not picture modes), and this TV's SCPD has none of the optional UPnP picture actions. The vendor X_ actions only cover DLNA playback aspect ratio and captions. Settings with no IP method on 2020 firmware need menu-navigation macros with an anchor reset and a 'saturate-then-count' slider technique, or values tracked by the app with user calibration: likely Eco Solution, Game Mode, Intelligent Mode, sound EQ, balance and auto volume, and the sleep timer. Caption on/off can be read only by an on-TV companion through tizen.tvinfo / webapis.tvinfo while that app is running. Bixby/voice injection, deep-linking into Settings pages, MDC (port 1515 is closed; MDC is for commercial displays), local OCF, vconf and HDMI-CEC are not workable for this TV.

## Capabilities

- **Local IP Control channel (Samsung Consumer IP Control JSON-RPC)** (official-doc, medium; read=true write=true live=false): HTTPS POST https://192.168.1.2:1516/ (any path), JSON-RPC 2.0. createAccessToken pairs (on-screen Allow, about 30 s). Every other call carries params.AccessToken. A call with only AccessToken is a GET; any extra param makes it a SET.
  - The port follows GetTVYear()<20 ? 1515 : 1516 (decompile). It needs the TV setting IP Remote = Enable (2020/2021 path: Settings > General > Network > Expert Settings). Power On with Mobile is also recommended. Not yet observed on this TV: 1516 was not in the port list, and IP Remote is probably off. Positive hint (live-tv): this TV serves the UPnP IPControlServer device on 9110 with an empty SCPD, which matches the module that also hosts 1516. 2020 Frames negotiate a DH group under 1024 bits, so the client must use ciphers DEFAULT@SECLEVEL=0. The server handles one connection at a time: serialize all requests. Tokens survive power cycles, and error -32011 means all AccessToken slots are taken, so never re-pair casually. The TV drops off the network about 1 minute after power-off.
- **Read/set Backlight (2020 menu name: 'Brightness', 0-50)** (official-doc, medium; read=true write=true live=false): IP Control backlightControl. GET {AccessToken} returns {backlight:n}. SET {AccessToken, backlight:n}.
  - Samsung's 2020 IP list: 'Backlight Control 0~50 - TV menu name is changed from Backlight to Brightness on 2020 TV' (a 2020 change). Live-validated 0..50 on a 2025 Frame; a 2018 TV rejects it with -32003. There is no live report of backlight on a 2020 non-Frame. The nearest is a 2020 Q90T whose colorToneControl (same expert-picture map) polls fine. The value is per picture mode and per input (Apply Picture Settings). Writes may be refused with -32002 in Dynamic or HDR-dynamic modes. Fallback: MACRO Settings > Picture > Expert Settings > Brightness (first row).
- **Read Contrast / Shadow Detail / Sharpness / Color / Tint in one call** (official-doc, medium; read=true write=true live=false): IP Control getVideoStates returns {contrast, brightness, sharpness, color, tint}. Set with contrastControl{contrast}, brightnessControl{brightness}, sharpnessControl{sharpness}, colorControl{color}, tintControl{tint}.
  - Here 'brightness' is the 2020 'Shadow Detail' (-5..5). Ranges measured on Frames: contrast 0-50, sharpness 0-20, color 0-50, tint -15..15. The 2020 list contradicts itself (contrast 0~100 in one table, sharpness/color/tint 0~100 in the status table), so clamp to whatever the TV reports. Values may come back as numeric strings (2018) or ints (2025). color and tint vanish from the reply on inputs labelled PC. For reads, prefer getVideoStates over per-field getters, which some models reject with -32601. Writes are refused (-32002) in Dynamic; Standard, Movie and Filmmaker accept them. An out-of-range target such as sharpness 74 also returns -32002.
- **Read/set Picture Mode** (official-doc, medium; read=true write=true live=false): IP Control getTVStates.pictureMode (read). pictureModeControl {pictureMode:'Dynamic'|'Standard'|'Natural'|'Movie'|'Filmmaker Mode'} (set). Cloud fallback: SmartThings custom.picturemode.setPictureMode or samsungvd.pictureMode. Blind local fallback: WS keys KEY_DYNAMIC, KEY_STANDARD, KEY_MOVIE1.
  - The 2020 list adds Filmmaker Mode (only offered with FMM content); HDR+ and CAL-DAY/NIGHT are deprecated. A 2025 Frame accepted Dynamic, Standard and Movie but rejected 'Filmmaker Mode', so take the exact strings from live reads. pictureModeControl lives in the 'none-ambient' map. SmartThings quirks: some TVs report 200 COMPLETED without changing anything; the argument form matters (display name vs id such as modeMovie); ids are not standard (a 2018 TV used modeEntertainment for Dynamic); cloud state can lag tens of seconds. KEY_DYNAMIC and similar keys are community-reported to work on a 2018 TV and to fail on others. They are unverified on 2020 and there is no key for Natural or Filmmaker.
- **Read/set Picture Size / aspect** (official-doc, low; read=true write=true live=false): IP Control getTVStates.pictureSize (read). pictureSizeControl {pictureSize:'16:9'|'4:3'} (set). UPnP RenderingControl X_GetAspectRatio applies to DLNA playback only (Default|FitScreen).
  - On a 2025 Frame the setter returned -32002 for '16:9', '4:3' and 'Fit to Screen', so it depends on input and state. Fit to Screen and Zoom and Position (Picture > Picture Size Settings) have no IP method and need a MACRO. X_AspectRatio comes from the DMR renderer, not the TV's picture size. Never call X_SetAspectRatio.
- **Read/set Color Tone** (community, medium; read=true write=true live=false): IP Control colorToneControl GET/SET {colorTone:'Cool'|'Standard'|'Warm1'|'Warm2'}
  - A 2020 QE55Q90TATXXU user with IP Control paired reports the Color Tone select polling and returning 'Warm2'. The method is in Samsung's 2020 list. Writes can be refused (-32002) in Dynamic. A 2018 TV rejects it with -32003.
- **Read/set Local Dimming, Picture Clarity (AMP), Blur/Judder Reduction, LED Clear Motion, Noise Reduction, Contrast Enhancer, Film Mode** (official-doc, low; read=true write=true live=false): IP Control localDimmingControl{localDimming:'Low'|'Standard'|'High'}; autoMotionPlusControl{autoMotionPlus:'Off'|'Auto'|'Custom'}; AMP.blurReductionControl{'AMP.blurReduction':0-10}; AMP.judderReductionControl{'AMP.judderReduction':0-10}; AMP.LEDClearMotionControl{'AMP.LEDClearMotion':'Off'|'On'}; digitalCleanViewControl{digitalCleanView:'Auto'|'Off'}; contrastEnhancerControl{contrastEnhancer:'Off'|'Low'|'High'}; filmModeControl{filmMode:'Off'|'Auto1'|'Auto2'}
  - All are in Samsung's 2020 IP list. 2020 renames: Auto Motion Plus is 'Picture Clarity'; Digital Clean View is 'Noise Reduction' (inside Picture Clarity Settings on 2020); Film Mode Auto1/Auto2 are treated as Auto. The AMP child values need Picture Clarity = Custom; Blur Reduction also needs a 120 Hz panel. Field names contain literal dots (JSON key 'AMP.blurReduction'). Unverified on any 2020 TV. Probe each getter once (read-only) and hide controls that return -32601. A 2025 Frame returned -32002 for the localDimming getter, so getters can be state-gated too.
- **Read/set Gamma, White Balance (2-point / 20-point), Color Space** (official-doc, low; read=true write=true live=false): IP Control gammaModeControl{gammaMode:'BT.1886'|'ST.2084'|'HLG'|'2.20'}; gamma.BT1886Control{'gamma.BT1886':-3..3} (also .ST2084, .HLG); WB2PointControl{'R-Gain','G-Gain','B-Gain','R-Offset','G-Offset','B-Offset': -50..50}; WB20PointModeControl, WB20P.IntervalControl ('5%'..'100%'), WB20P.Red/Green/BlueControl; colorSpaceControl{colorSpace:'Auto'|'Native'|'Custom'}; colorSpace.ColorControl; colorSpace.Red/Green/BlueControl 0-100
  - These are calibration-grade controls (the protocol Calman/AutoCal-style workflows use). For an info dashboard, read them only. WB2Point writes are unreliable if partial: send all six freshly read channels. Every value here depends on picture mode, gamma mode, SDR/HDR and Color Space = Custom.
- **Eco Solution (Ambient Light Detection + Minimum Brightness, Power Saving Mode, Motion Lighting, Auto Power Off), 'Brightness optimization'** (inferred, low; read=false write=false live=false): Try read-only getter probes brightnessOptimizationControl, energySavingSolutionControl, motionLightingControl, autoPowerSavingControl, autoPowerOffControl (names from the 2025 firmware). If they return -32601, use a MACRO: Settings > General > Eco Solution.
  - These methods are absent from Samsung's 2020 and 2023 consumer IP lists and exist in the 2025 Frame decompile, so they are probably missing on 2020 firmware. The 2020 Q90T Eco Solution page (RTINGS screenshot) has rows in this order: Ambient Light Detection (toggle), Minimum Brightness (slider, greyed unless ALD is on), Power Saving Mode (toggle), Motion Lighting (toggle), Auto Power Off. 'Brightness Optimization' is the later name for ALD. SmartThings custom.energyType (energySavingLevel) exists on 2024+ fixtures and is unknown on 2020.
- **Game Mode (and Game Motion Plus, Dynamic Black Equalizer)** (inferred, low; read=false write=false live=false): Read-only probe of gameModeControl GET (2025 name). Otherwise MACRO: Settings > General > External Device Manager > Game Mode Settings > Game Mode (Off/Auto/On).
  - gameModeControl is not in the 2020 or 2023 IP lists. On a 2025 Frame the getter worked and setters returned -32002 because they depend on the input. The 2020 Q90T Game Mode Settings page (RTINGS screenshot) lists Game Mode, Surround Sound, Dynamic Black Equalizer (slider) and Game Motion Plus Settings. Game Mode greys out the picture-mode menu, and on an HDMI source with ALLM the TV can switch to Auto by itself, so tracked state goes stale.
- **HDR tone mapping / HDR state** (inferred, low; read=false write=false live=false): HDRToneMappingControl exists only in 2025 firmware. The 2020 IP list has gamma ST.2084/HLG adjustment only.
  - No HDR Tone Mapping row appears in the 2020 Q90T Expert Settings captures (Sound & Vision and RTINGS settings lists). Treat it as not applicable on the Q95T unless a live menu shows it. A getter probe is harmless. 'Is HDR playing' is not exposed by IP Control. HDR picture modes do show up as their own pictureMode values and settings.
- **Read/set Sound Mode** (official-doc, medium; read=true write=true live=false): IP Control getTVStates.soundMode (read). soundModeControl{soundMode:'Standard'|'Optimized'|'Amplify'} (set). SmartThings custom.soundmode.setSoundMode (supportedSoundModes list).
  - The 2020 list marks 'Optimized' as deprecated. 'Adaptive Sound+' is not a sound mode on 2020; it is a toggle under General > Intelligent Mode Settings (MACRO). Writes may fail when output is not the TV speaker.
- **Read/set Sound Output (TV speaker / HDMI-eARC / Bluetooth / Optical)** (official-doc, low; read=true write=true live=false): IP Control getTVStates.speakerSelect (lowercase 'internal'/'external') or speakerSelectControl GET (capitalized); speakerSelectControl{speakerSelect:'Internal'|'AudioOut/Optical'}; externalSpeakerControl GET returns [{deviceName, deviceId}] and SET {deviceName, deviceId} chooses an eARC or BT device
  - A bare 'External' value is rejected; pick from the externalSpeakerControl list. Some firmware returns a device id in speakerSelect, which must be resolved through that list. When output is external, directVolumeControl reads return -32002 and the TV volume number is meaningless, so the UI should say so.
- **Read current volume/mute (and push updates)** (live-tv, high; read=true write=true live=true): UPnP RenderingControl GetVolume/GetMute (InstanceID 0, Channel Master) on :9197/upnp/control/RenderingControl1. Push: GENA SUBSCRIBE :9197/upnp/event/RenderingControl1 delivers LastChange NOTIFY. Also IP Control directVolumeControl (0-100) / getTVStates.volume, and on-TV tizen.tvaudiocontrol.getVolume plus setVolumeChangeListener.
  - GetVolume returned 4 on this TV today (live-tv). GENA was not tested here; on a 2025 Samsung, SUBSCRIBE returned 200 with SID and TIMEOUT Second-300 and the first NOTIFY carried Volume, Mute, X_AspectRatio, captions and X_ServiceCapabilities within 1 s. CineHD's own on-TV code already uses tizen.tvaudiocontrol.isMute/setMute; the tv.audio privilege has been deprecated (no longer required) since 5.0. Volume belongs to another area; it is listed here only to show it is the one setting with a true push path.
- **Balance, Equalizer, Auto Volume, Digital Output Audio Format, HDMI-eARC mode** (inferred, medium; read=false write=false live=false): No API: MACRO via Settings > Sound > Expert Settings, then TRACKED
  - No IP Control, SmartThings, UPnP or Tizen public API covers these on consumer TVs. The IP lists' only sound methods are sound mode, speaker select, external speaker, volume and mute. The menu order under Sound > Expert Settings must be captured live.
- **Sleep timer** (inferred, medium; read=false write=true live=false): Best: a PC-side timer owned by our app that issues IP Control powerControl{power:'powerOff'} (or KEY_POWER) when due; the countdown is exact because we own it. Optional: MACRO to the TV's own timer (Settings > General > System Manager > Time > Sleep Timer: Off/30/60/90/120/150/180).
  - There is no API anywhere to read the TV's own sleep timer. KEY_SLEEP appears in legacy key tables but is unverified on 2020; a 2020 Smart Remote has no sleep key. If our app sets the TV's own timer by macro, the UI shows an estimated countdown started at set-time.
- **Caption / subtitle state** (official-doc, low; read=true write=false live=true): Read only from an on-TV app: tizen.tvinfo.getCaptionValue('CAPTION_ONOFF_KEY') plus addCaptionValueChangeListener, or webapis.tvinfo.getMenuValue(webapis.tvinfo.TvInfoMenuKey.CAPTION_ONOFF_KEY) plus addCaptionChangeListener. Set: no consumer API (webapis.tvinfo.setMenuValue is B2B-only). Use IP remoteKeyControl{remoteKey:'caption'} / KEY_CAPTION (behaviour unknown) or a MACRO: Settings > General > Accessibility > Caption Settings > Caption.
  - The read works only while our companion code runs on the TV. A foreground web app would cover the user's content. Whether a Tizen web service (like pvcinehd01.MediaService, which already runs an HTTP server) may call tizen.tvinfo or tvaudiocontrol is unverified. UPnP X_GetCaptionState and LastChange captions cover DLNA-played content only, not broadcast or HDMI captions.
- **SmartThings cloud capabilities (fallback)** (source-code, medium; read=true write=true live=false): GET https://api.smartthings.com/v1/devices/{id}/status. POST /v1/devices/{id}/commands with custom.picturemode.setPictureMode, custom.soundmode.setSoundMode, audioVolume.setVolume, audioMute, mediaInputSource.setInputSource, samsungvd.remoteControl.send(key, 'PRESS_AND_RELEASED'), custom.launchapp, execute('/sec/tv/deviceinfo')
  - The capability surface has picture mode, sound mode, volume, mute, input, channel and app launch only. No backlight, contrast, eco or sleep capability exists. The OCF hrefs /sec/tv/mode/picture, /sec/tv/optioncontrol, /sec/tv/uicontrol and /sec/tv/showmenu exist on 2020 Tizen 5.5 TVs, but cloud execute reads returned null for an API client on a 2025 TV, and locally they answer CoAP 4.01 Unauthorized. Constraints: new personal access tokens expire after 24 h (since 30 Dec 2024); Samsung's blog says paid API tiers start no earlier than October 2026; cloud volume and picture mode can be stale. Whether this TV is registered in SmartThings is unknown.
- **UPnP RenderingControl presets / picture actions** (live-tv, high; read=true write=false live=false): ListPresets (InstanceID 0) returns CurrentPresetNameList. The SCPD allows only A_ARG_TYPE_PresetName='FactoryDefaults'.
  - Presets do not map to picture modes. SelectPreset(FactoryDefaults) would reset renderer state and must never be called. This TV's live SCPD action list has none of the optional UPnP RCS picture actions (GetBrightness, GetContrast, GetSharpness, Get*VideoGain...), so UPnP cannot read picture levels (live-tv, from today's SCPD listing). The Samsung X_ actions cover the DMR aspect ratio and DLNA captions only. On a 2025 TV, X_GetServiceCapabilities / X_ServiceCapabilities returned 'GetVolume,SetVolume,GetMute,SetMute'.
- **Hidden IPControlService UPnP actions (port 9110)** (source-code, medium; read=false write=false live=true): urn:samsung.com:service:IPControlService:1, control /upnp/control/IPControlService1, event /upnp/event/IPControlService1
  - Decompiled 2025 firmware: IPControlServiceHelper::dispatchAction() always returns 401 Invalid Action. The service only publishes the evented state variable IPControlState (initial 'RUNNING'). This TV's SCPD is empty (live-tv), which matches. A future read-only GENA SUBSCRIBE to the event URL could show whether IP Control is running before asking the user to enable IP Remote. No picture actions exist here.
- **WebSocket keys that change settings directly** (community, low; read=false write=true live=false): wss://192.168.1.2:8002/api/v2/channels/samsung.remote.control ms.remote.control SendRemoteKey with KEY_PMODE, KEY_DYNAMIC, KEY_STANDARD, KEY_MOVIE1, KEY_GAME, KEY_PICTURE_SIZE, KEY_ASPECT, KEY_4_3, KEY_16_9, KEY_ESAVING, KEY_SLEEP, KEY_CAPTION, KEY_AMBIENT. Same transport family as IP remoteKeyControl.
  - These are blind SET-ONLY commands. They come from legacy samsungctl key tables, and none is documented for 2020 Tizen. KEY_DYNAMIC worked on a 2018 Norwegian TV and failed for another user. Cycling keys (KEY_PMODE, KEY_PICTURE_SIZE, KEY_ESAVING, KEY_SLEEP) would give unknown results even if accepted. Use them only as last-resort fallbacks, after a one-time live probe with the user watching. Connecting to 8001/8002 triggers the Allow prompt (owned by the remote/WS area).
- **Menu-navigation macros for settings with no API** (source-code, low; read=false write=true live=false): Key sequences over WS SendRemoteKey (KEY_MENU, KEY_UP/DOWN/LEFT/RIGHT, KEY_ENTER, KEY_RETURN, KEY_EXIT, KEY_HOME) or IP remoteKeyControl (menu, cursorUp/Dn/Left/Right, enter, return, exit, firstScreen). Planner and state model: anchor reset, then a verified route, then slider adjust (saturate-then-count).
  - The TV never reports the focused row or a menu value, so macros are predicted-state only. The SamsungController project (2025 S95F) uses exactly this model: an anchor 'normal-video' (KEY_RETURN / KEY_EXIT), KEY_MENU to open settings, explicit per-route transitions, three visual verification passes, and a 'Probable vs Synchronized' confidence shown in the UI. Layout changes with input, HDR, Game Mode, picture mode (greyed rows still take cursor steps; hidden rows do not) and firmware. Saturate-then-count sets a slider without knowing its value: LEFT x(range) then RIGHT x(target), about 150-250 ms per key, roughly 10-20 s for a 0-50 slider. Also unverified on the Q95T: what KEY_MENU opens on 2020 (full Settings vs quick-settings row), whether lists wrap, and the menu auto-close timeout.
- **Deep-link into a specific Settings page** (inferred, low; read=false write=false live=false): None known. REST /api/v2/applications/<id> and ed.apps.launch only launch apps. The OCF resource /sec/tv/showmenu exists but is reachable only by Samsung's own SmartThings plugin.
  - No public Settings app id or Tizen app-control operation for TV settings pages was found. The QuiteYellow OCF inventory of a 2020 Tizen 5.5 TV lists /sec/tv/showmenu, but locally it answers 4.01 and cloud execute reads return null for API clients. A companion app could list installed app ids with tizen.application.getAppsInfo (harmless) to look for a settings app id. Treat this as IMPOSSIBLE until proven.
- **Bixby / voice text-command injection ('set brightness to 30')** (inferred, medium; read=false write=false live=false): None
  - msf-server exposes only voice status events (ms.voiceApp.*, /remoteControl/voiceStatus) and IME text injection (SendInputString goes into a focused text field, not into Bixby). Remote-mic voice runs over BLE audio. webapis.voiceinteraction works the other way: Bixby talks to an app. Alexa and Google smart-home skills reach Samsung TVs through SmartThings capabilities, which have no picture levels. IMPOSSIBLE in practice.
- **On-TV app reading picture settings (vconf, system_settings, b2bapis)** (official-doc, medium; read=false write=false live=false): None for consumer firmware with a public-level distributor certificate
  - Samsung's TV web API list has no picture or sound-level API. The TV-control APIs are TVAudioControl (volume/mute/output codec), TVDisplayControl (3D only), TVInfo (captions only), TVInputDevice and TVWindow. vconf and native settings need native partner or platform apps, which a distributor certificate cannot sign. b2bapis exist on signage/hospitality firmware only. The on-TV app could still reach the IP Control server at 127.0.0.1:1516, but that gains nothing over the PC.
- **Samsung MDC (port 1515)** (live-tv, high; read=false write=false live=false): MDC binary protocol, TCP 1515
  - Port 1515 is closed on this TV (live-tv). MDC is the protocol for commercial signage displays. Consumer TVs use Consumer IP Control instead, which used port 1515 only up to 2019 and moved to 1516 in 2020 (Samsung worksheet).
- **Creative read-back: HDMI-CEC, OSD capture/OCR, Remote Management, local OCF** (inferred, medium; read=false write=false live=false): None practical
  - CEC needs a USB-CEC adapter (PC GPUs have no CEC). It offers power, input, routing and pass-through keys only, with no picture-setting opcodes, and Samsung's integrator worksheet asks for Anynet+ off with IP control. OSD capture: the TV has no video output, and third-party apps have no screen-capture API, so this would mean pointing a webcam at the TV and running OCR (invasive and fragile). Support > Remote Management is a Samsung-agent session. Local OCF/CoAP resources return 4.01 without re-claiming ownership from SmartThings, which would mean circumventing Samsung's ownership model.
- **Intelligent Mode / Adaptive Picture / Adaptive Sound+ / Adaptive Volume / Active Voice Amplifier** (official-doc, medium; read=false write=false live=false): MACRO: Settings > General > Intelligent Mode Settings, then TRACKED
  - Samsung IN support page (updated Sep 2020; QLED except Q6): Home > Settings > General > Intelligent Mode Settings. Every option except Adaptive Picture works only with TV Speaker output. No IP method exists for these. While Adaptive Picture is on, the TV may adjust brightness on its own, so the UI should flag that read values can drift.

## Protocol details

## 1. Primary channel: Samsung Consumer IP Control (JSON-RPC 2.0 over HTTPS, port 1516)

**Prerequisites (the user does these on the TV, with the remote):**
1. Turn on IP Remote. On 2021-and-older models (Q95T): Settings > General > Network > Expert Settings > IP Remote = Enable. Also set Power On with Mobile = ON. (Samsung Consumer IP Control Worksheet; Portrait/Calman KB for 2019/2020.) Samsung warns that turning this on lets other IP controllers on the LAN control the TV.
2. Pairing: call `createAccessToken` while the TV is on and in normal viewing. The TV shows an "IP Remote - Your permission is required to connect your device to this TV" dialog (Allow/Deny/Close). The user must press Allow within about 30 s. Store the token (it survives power cycles). Token slots are limited (`-32011 All AccessToken occupied`), so pair once only.

**Transport facts (2025 decompile + 2020-2025 field code):**
- `POST` to any path (use `/`), HTTP/1.0 or 1.1, no chunked encoding.
- Required headers: `Content-Type: application/json`, `Accept: application/json`, `Host`, `Content-Length`.
- Self-signed certificate (`CN = Samsung IP Control G2`); response banner `Server: Samsung IP Control Server/1.0`.
- **2020-era TVs negotiate a DH group under 1024 bits.** OpenSSL 3 (Node 22) rejects it unless `ciphers: 'DEFAULT@SECLEVEL=0'`.
- **One connection at a time.** Overlapping requests get reset, so funnel every call through a single queue, with user actions given priority over polls.
- The TV goes offline about 1 minute after power-off. Power-on needs WoL (another area's job).

**Envelope**
```json
{"jsonrpc":"2.0","id":"1","method":"createAccessToken"}
-> {"jsonrpc":"2.0","id":"1","result":{"AccessToken":"<token>"}}
{"jsonrpc":"2.0","id":"2","method":"getTVStates","params":{"AccessToken":"<token>"}}
-> {"result":{"inputSource":"HDMI1","mute":"muteOff","pictureMode":"Standard","pictureSize":"16:9","soundMode":"Standard","speakerSelect":"internal","volume":12}}
{"jsonrpc":"2.0","id":"3","method":"getVideoStates","params":{"AccessToken":"<token>"}}
-> {"result":{"brightness":0,"color":25,"contrast":45,"sharpness":0,"tint":0}}   // 2018 sets return numeric STRINGS
{"jsonrpc":"2.0","id":"4","method":"backlightControl","params":{"AccessToken":"<token>"}}                // GET
{"jsonrpc":"2.0","id":"5","method":"backlightControl","params":{"AccessToken":"<token>","backlight":25}}  // SET
```
- GET vs SET is decided by the params: only `AccessToken` means GET; any other key means SET. **So a capability probe that sends only the token is read-only.** Use this to discover which methods the 2020 firmware implements before showing a control.
- Errors come either nested (`{"error":{"code","message"}}`) or flat (`{"code":-32700,"message":"Parse error"}`). Handle both.
  - `-32010` Unauthorized: re-pair.
  - `-32700` with a token sent: stale token, re-pair.
  - `-32601` Method not found: absent on this model, **or** unavailable in the current mode. Do not latch it permanently.
  - `-32002` Failed: blocked by the current picture mode (Dynamic/HDR-dynamic), out of range, or a state/input dependency.
  - `-32003` Invalid operation: unsupported on older sets.
  - `-32602` Invalid params.

**Node 22 client sketch (PC server)**
```js
import https from 'node:https';
const agent = new https.Agent({ keepAlive: false, maxSockets: 1, rejectUnauthorized: false, ciphers: 'DEFAULT@SECLEVEL=0' });
export function rpc(method, params = {}, token) {
  const msg = { jsonrpc: '2.0', id: String(Date.now()), method };
  if (method !== 'createAccessToken') msg.params = { AccessToken: token, ...params };
  const body = JSON.stringify(msg);
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '192.168.1.2', port: 1516, path: '/', method: 'POST', agent,
      timeout: method === 'createAccessToken' ? 30000 : 5000,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { const j = JSON.parse(d);
        const err = j.error || (('code' in j && !('result' in j)) ? { code: j.code, message: j.message } : null);
        err ? reject(Object.assign(new Error(err.message), { code: err.code })) : resolve(j.result); } catch (e) { reject(e); } }); });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end(body);
  });
}
// all calls MUST go through one serialized queue
```

**2020 method map** (Samsung 2020 IP command list. "2020 change" = yellow in the PDF. Exact field names come from the 2025 decompile and py-samsungtv.)

| UI (2020 menu) | Method | GET result / SET param | Range / values |
|---|---|---|---|
| Picture > Expert > **Brightness** (= backlight) | `backlightControl` | `backlight` | 0-50 |
| Expert > Contrast | read via `getVideoStates.contrast`, set via `contrastControl` | `contrast` | 0-50 |
| Expert > **Shadow Detail** | `getVideoStates.brightness` / `brightnessControl` | `brightness` | -5..5 |
| Expert > Sharpness | `sharpnessControl` | `sharpness` | 0-20 |
| Expert > Color | `colorControl` | `color` | 0-50 |
| Expert > Tint (G/R) | `tintControl` | `tint` | -15..15 (check the menu display) |
| Picture Mode | `getTVStates.pictureMode` / `pictureModeControl` | `pictureMode` | Dynamic, Standard, Natural, Movie, Filmmaker Mode (FMM content only) |
| Picture Size | `getTVStates.pictureSize` / `pictureSizeControl` | `pictureSize` | 16:9, 4:3 |
| Picture Clarity (= AMP) | `autoMotionPlusControl` | `autoMotionPlus` | Off, Auto, Custom |
| Blur / Judder Reduction | `AMP.blurReductionControl` / `AMP.judderReductionControl` | `AMP.blurReduction` / `AMP.judderReduction` | 0-10 (needs Custom) |
| LED Clear Motion | `AMP.LEDClearMotionControl` | `AMP.LEDClearMotion` | Off, On |
| Noise Reduction (= Digital Clean View) | `digitalCleanViewControl` | `digitalCleanView` | Auto, Off |
| Local Dimming | `localDimmingControl` | `localDimming` | Low, Standard, High |
| Contrast Enhancer | `contrastEnhancerControl` | `contrastEnhancer` | Off, Low, High |
| Film Mode | `filmModeControl` | `filmMode` | Off, Auto1/Auto2 (= Auto on 2020) |
| Color Tone | `colorToneControl` | `colorTone` | Cool, Standard, Warm1, Warm2 |
| White Balance 2-pt | `WB2PointControl` | `R-Gain`, `G-Gain`, `B-Gain`, `R-Offset`, `G-Offset`, `B-Offset` | -50..50 (send all six) |
| 20-pt | `WB20PointModeControl`, `WB20P.IntervalControl`, `WB20P.RedControl`/`Green`/`Blue` | `WB20PointMode`, `WB20P.Interval` ('5%'..'100%'), `WB20P.Red` ... | -50..50 |
| Gamma | `gammaModeControl` + `gamma.BT1886Control` (also `.ST2084`, `.HLG`) | `gammaMode`, `gamma.BT1886` | BT.1886, ST.2084, HLG, 2.20; -3..3 |
| Color Space | `colorSpaceControl`, `colorSpace.ColorControl`, `colorSpace.RedControl`/`Green`/`Blue` | `colorSpace` ... | Auto, Native, Custom; 0-100 |
| Sound Mode | `getTVStates.soundMode` / `soundModeControl` | `soundMode` | Standard, Optimized (deprecated), Amplify |
| Sound Output | `getTVStates.speakerSelect` / `speakerSelectControl`; `externalSpeakerControl` | `speakerSelect` ('Internal', 'AudioOut/Optical'); `deviceName` + `deviceId` | the GET lists devices |
| Volume / Mute | `directVolumeControl`, `volumeUpDnControl`, `muteControl` | `volume` 0-100; `control` volumeUp/volumeDn; `mute` muteOn/muteOff | |
| Input | `getTVStates.inputSource` / `inputSourceControl` | `inputSource` | TV, HDMI1-4, AV1, COMPONENT1, USB |
| Keys | `remoteKeyControl` | `remoteKey` | cursorUp, cursorDn, cursorLeft, cursorRight, menu, firstScreen, enter, return, exit, caption, number0-9, red/green/yellow/blue, play/pause/stop/rewind/fastforward, power |
| Power | `powerControl` | `power` | powerOn, powerOff, reboot. **Never reboot or force-reboot.** |

Probe these only with a GET; they exist in 2025 firmware but are absent from the 2020/2023 lists: `brightnessOptimizationControl`, `energySavingSolutionControl`, `motionLightingControl`, `autoPowerSavingControl`, `autoPowerOffControl`, `gameModeControl`, `HDRToneMappingControl`, `peakBrightnessControl`, `colorBoosterControl`, `applyPictureSettingsControl`, `getDeviceInformation`.

**Polling:** no push exists, so poll gently.
- `getTVStates` every 2-3 s while a browser tab is open; `getVideoStates` plus the expert getters only when the Settings view is open, or right after a pictureMode/inputSource change.
- Back off to about 30 s, or stop, while the TV is off.
- Values are per (input x picture mode), plus SDR/HDR. When `pictureMode` or `inputSource` changes, invalidate the whole picture cache and re-read.
- Write-then-read-back: after a SET, re-GET the field and show what the TV reports, not what we sent.

## 2. Settings menu tree for macros (2020 Tizen 5.5, from 2020 Q90T captures; must be verified live on this Q95T)

- **Left rail** (icons, top to bottom): Picture, Sound, Broadcasting, General, Support, plus a shield icon whose label was not captured.
- **Picture > Picture Mode** pop-up: Dynamic, Standard, Natural, Movie (+ Filmmaker Mode with FMM content).
- **Picture > Picture Size Settings:** Picture Size (e.g. '16:9 Standard'), Fit to Screen (Off/On/Auto), Zoom and Position.
- **Picture > Expert Settings** (row order from the RTINGS Q90T screenshots):
  1. Brightness (0-50) 2. Contrast (0-50) 3. Sharpness (0-20) 4. Color (0-50) 5. Tint (G/R)
  6. Apply Picture Settings (Current Source/All Sources) 7. Picture Clarity Settings (submenu: Picture Clarity Off/Auto/Custom, Blur Reduction, Judder Reduction, LED Clear Motion, Noise Reduction)
  8. Local Dimming 9. Contrast Enhancer 10. Film Mode (often greyed) 11. Color Tone 12. White Balance (2 Point / 20 Point Settings) 13. Gamma 14. Shadow Detail
  15+ (not captured): Color Space Settings, RGB Only Mode, Reset Picture.
- **General > Eco Solution:** Ambient Light Detection, Minimum Brightness (greyed unless ALD on), Power Saving Mode, Motion Lighting, Auto Power Off.
- **General > External Device Manager > Game Mode Settings:** Game Mode, Surround Sound, Dynamic Black Equalizer, Game Motion Plus Settings. Input Signal Plus is in the same area.
- **General > Intelligent Mode Settings:** Adaptive Picture, Adaptive Voice Amplifier, Adaptive Sound+, Adaptive Volume.
- **Likely, to verify:** General > System Manager > Time > Sleep Timer; General > Accessibility > Caption Settings; Sound > Sound Mode / Sound Output / Expert Settings (Balance, Equalizer, HDMI-eARC Mode, Digital Output Audio Format, Audio Delay, Auto Volume, Sound Feedback, Reset Sound).

**Macro engine rules** (pattern from the whipstein/SamsungController menu model):
- **Anchor 'normal-video'.** Send KEY_RETURN x3 then KEY_EXIT, 400 ms apart. After that, the state counts as Synchronized.
- **Open the menu** with KEY_MENU. What it opens on 2020 (full Settings at the Picture page, or a quick-settings row) must be discovered once, live.
- **Re-home the cursor.** Press LEFT until the focus is in the rail, then UP xN (more than the number of items). This assumes lists do not wrap, which must be verified.
- **Navigate by a fixed row index.** Greyed rows still take a cursor step; hidden rows do not. Keep a separate layout for each condition: HDR, Game Mode on, PC input, Filmmaker.
- **Sliders, saturate-then-count.** Press ENTER on the row to open the slider bar, then LEFT x(max-min), then RIGHT x(target-min), then RETURN. The result is absolute and needs no prior knowledge of the value.
- **Key timing.** About 200 ms between Up/Down/Left/Right keys, about 600-800 ms after keys that open a screen.
- **Finish** by running the anchor again.
- **Read back over IP Control where possible**, for example backlight via `backlightControl` GET. Otherwise record the value as TRACKED and timestamp it.
- **Never chain a macro after a failed key send.** Show 'menu position unknown', re-anchor, then retry once.
- **Safety:** macros are visible on screen (the menu flashes), so warn the user. Default to the IP method whenever one exists.

## 3. SmartThings (fallback only)
```http
GET  https://api.smartthings.com/v1/devices/{deviceId}/status      Authorization: Bearer <token>
  -> components.main["custom.picturemode"].pictureMode.value, .supportedPictureModesMap.value=[{"id":"modeStandard","name":"Standard"},...]
  -> components.main["custom.soundmode"].soundMode.value; ["audioVolume"].volume.value; ["mediaInputSource"].inputSource.value
POST https://api.smartthings.com/v1/devices/{deviceId}/commands
  {"commands":[{"component":"main","capability":"custom.picturemode","command":"setPictureMode","arguments":["Movie"]}]}
  {"commands":[{"component":"main","capability":"custom.soundmode","command":"setSoundMode","arguments":["Standard"]}]}
```
- HTTP 200 only means the cloud accepted the command. Check `results[].status` (FAILED means the TV is not reachable from the cloud), then read the status back.
- Try the display name first, then the id form.
- Some models use `samsungvd.pictureMode` / `samsungvd.soundMode` instead.
- No backlight or eco capability exists.
- New personal access tokens last 24 h. OAuth is required for long-term use, and paid tiers start no earlier than October 2026.

## 4. UPnP (what not to expect)
- RenderingControl `ListPresets` returns only `FactoryDefaults`. Presets are not picture modes. **Never call SelectPreset.**
- The SCPD has no Get/SetBrightness, Get/SetContrast or Get/SetSharpness (live SCPD).
- `X_GetAspectRatio` returns Default/FitScreen for DLNA playback only. `X_GetCaptionState` covers DLNA captions only.
- The IPControlService on 9110 has no actions; it only events `IPControlState`.

## 5. On-TV companion APIs (only useful while our code runs on the TV)
```js
tizen.tvaudiocontrol.getVolume(); tizen.tvaudiocontrol.isMute(); tizen.tvaudiocontrol.setVolumeChangeListener(v => ...); tizen.tvaudiocontrol.getOutputMode(); // PCM|DOLBY|DTS|AAC|DOLBY_DIGITAL_PLUS (codec, not speaker)
tizen.tvinfo.getCaptionValue('CAPTION_ONOFF_KEY');  // 'CAPTION_ON'|'CAPTION_OFF'; addCaptionValueChangeListener(key, cb)
webapis.tvinfo.getMenuValue(webapis.tvinfo.TvInfoMenuKey.CAPTION_ONOFF_KEY); webapis.tvinfo.isTvsPicSizeResized();
```
- There is no API for picture levels, sound EQ, eco or sleep. `webapis.tvinfo.setMenuValue` is B2B-only.

## 6. Recommended strategy per setting and honest UI labels

**Label vocabulary:**
- `LIVE`: read from the TV; show the read timestamp.
- `LIVE-SET`: read + write, with the value read back after each write.
- `SET-ONLY`: blind command; nothing can confirm it.
- `MACRO`: the app drives the TV menu. Show 'about Ns, the TV menu will appear' and keep the value as TRACKED.
- `TRACKED`: 'last set by this app at hh:mm'. It can be wrong if someone uses the physical remote; offer 'Calibrate: what does your TV show?'.
- `N/A`: not available on this TV.

| Setting | Strategy (if IP Remote is enabled) | Without IP Control | Label |
|---|---|---|---|
| Brightness (backlight 0-50) | READ+SET backlightControl | MACRO slider + TRACKED | LIVE-SET / MACRO |
| Contrast, Sharpness, Color, Tint, Shadow Detail | READ getVideoStates + SET <field>Control (locked in Dynamic) | MACRO + TRACKED | LIVE-SET ('locked in Dynamic mode' badge on -32002) |
| Picture Mode | READ getTVStates + SET pictureModeControl | SmartThings custom.picturemode (READ+SET, cloud lag); KEY_DYNAMIC/STANDARD/MOVIE1 SET-ONLY; MACRO | LIVE-SET |
| Picture Size | READ getTVStates + SET pictureSizeControl (16:9/4:3) | MACRO | LIVE-SET (Fit to Screen = MACRO) |
| Color Tone, Local Dimming, Picture Clarity/AMP, Noise Reduction, Contrast Enhancer, Film Mode, Gamma, WB, Color Space | READ+SET after the getter probe succeeds | MACRO / TRACKED | LIVE-SET, or hidden if -32601 |
| Eco Solution (ALD, Min Brightness, Power Saving, Motion Lighting, Auto Power Off) | probe 2025 getters; probably absent, so MACRO + TRACKED | MACRO + TRACKED | MACRO |
| Intelligent Mode / Adaptive Picture / Adaptive Sound+ | MACRO + TRACKED | same | MACRO (warn that Adaptive Picture changes brightness by itself) |
| Game Mode | probe gameModeControl; else MACRO + TRACKED | MACRO | MACRO ('Auto' may change by itself via ALLM) |
| HDR tone mapping | N/A on Q95T (no menu item seen in the 2020 captures) | N/A | N/A |
| Sound Mode | READ+SET soundModeControl / getTVStates | SmartThings custom.soundmode | LIVE-SET |
| Sound Output | READ getTVStates.speakerSelect + SET speakerSelectControl / externalSpeakerControl | MACRO | LIVE-SET |
| Volume / Mute | READ UPnP GetVolume/GetMute + GENA push (live), SET IP directVolumeControl/muteControl | UPnP or WS keys | LIVE ('external speaker: TV volume not meaningful') |
| Balance, Equalizer, Auto Volume, Digital Output format | MACRO + TRACKED | same | MACRO |
| Sleep timer | the app's own timer, then powerControl powerOff (exact countdown) | app timer + KEY_POWER | TRACKED ('app timer'); a MACRO to the TV's own timer is optional |
| Caption | READ only via the on-TV companion if it runs, else TRACKED; SET via remoteKeyControl caption / KEY_CAPTION (unverified) or MACRO | MACRO | TRACKED unless the companion is live |

## 7. Safe live-verification sequence (future task, user present)
1. TCP connect only (no payload) to 192.168.1.2:1516 and :1515.
2. Optional: GENA SUBSCRIBE http://192.168.1.2:9110/upnp/event/IPControlService1 to read `IPControlState`, then UNSUBSCRIBE.
3. If 1516 is closed: the user enables IP Remote and Power On with Mobile.
4. The user is present: run createAccessToken and the user presses Allow.
5. Read-only GETs, one per 500 ms or slower: getTVStates, getVideoStates, backlightControl, colorToneControl, localDimmingControl, autoMotionPlusControl, digitalCleanViewControl, contrastEnhancerControl, filmModeControl, gammaModeControl, then the 2025-only names. Record which return -32601.
6. With explicit user consent: one reversible write (backlight +1, read back, restore).
7. Separately: discover the macro layout with the user watching, at one key per second at first.

## Risks

- IP Control may not be reachable on this unit. Port 1516 is not in today's open-port list, so IP Remote is probably disabled. The IP Remote menu may be missing on Indian-region firmware, and the fab21 README warns that some models never run the server even with IP Remote on. Everything marked LIVE-SET for picture levels depends on this.
- The 2020 Q95T firmware may implement fewer expert methods than the 2025 decompile, and some 2020 IP-list entries may be greyed or state-gated. Never assume a method exists: probe each getter and hide controls that answer -32601. Also -32601 can mean 'not in this mode' (ambient/art), so re-probe later.
- Picture writes are refused in Dynamic and HDR-dynamic modes (-32002), and values are per input and picture mode, plus SDR/HDR. A UI that caches one 'backlight' value will show wrong data after a source or mode change.
- Every write permanently changes the user's calibration, and the TV keeps no undo. Before a batch change, snapshot all readable values. Ask for confirmation on WB, gamma or color-space writes, or keep those read-only.
- Pairing (createAccessToken) puts an Allow dialog on the TV screen, as WebSocket pairing does. It must only happen with the user present and consenting, and never automatically or in a retry loop. Token slots are limited (-32011).
- Security: with IP Remote enabled, anyone on the LAN who obtains or pairs a token can control power and settings. Store the token like a secret on the PC and never log it. Write logs with the serial number and MACs redacted (getDeviceInformation returns serialNumber).
- TLS: 2020-era TVs need DEFAULT@SECLEVEL=0 (DH key below 1024 bits). The certificate is self-signed, so the client trusts the LAN endpoint without verification; pinning the cert fingerprint after first contact is advisable.
- The 1516 server takes one connection at a time. Concurrent polls, from other agents or a Home Assistant install, can cause resets and flapping availability. Use one serialized client, with user actions jumping ahead of polls.
- Menu macros are inherently fragile: the menu tree differs by input, HDR, Game Mode and firmware updates, keys can drop, menus auto-close, and the remote's own use desyncs the predicted state. The TV gives no cursor feedback. Macros briefly cover what the user is watching.
- SmartThings fallback: cloud dependency, new personal access tokens expire after 24 h, paid API tiers from about October 2026, state lag (tens of seconds), commands acknowledged but not applied, and non-standard mode ids.
- Legacy WebSocket setting keys (KEY_PMODE, KEY_ESAVING, KEY_SLEEP, KEY_PICTURE_SIZE, KEY_CAPTION, KEY_GAME) are undocumented on 2020 and may be ignored, may cycle unpredictably, or may open pop-ups. Treat them as SET-ONLY and probe them once with the user watching.
- Volume read over IP or UPnP is meaningless or refused (-32002) when output goes to an eARC receiver, Bluetooth or optical. The UI must say so rather than show 0.
- Adaptive Picture (Intelligent Mode) and Ambient Light Detection change brightness by themselves, so a LIVE read of backlight is the menu value, not the real-time panel luminance.

## Open questions

- Is anything listening on 192.168.1.2:1516 right now (TCP connect only)? If not, does the IP Remote option exist under Settings > General > Network > Expert Settings on this Indian-region Q95T firmware?
- Does a read-only GENA SUBSCRIBE to http://192.168.1.2:9110/upnp/event/IPControlService1 return IPControlState, and does that value reflect the IP Remote setting?
- After pairing, which getters answer on this 2020 firmware: backlightControl, colorToneControl, localDimmingControl, autoMotionPlusControl, AMP.*, digitalCleanViewControl, contrastEnhancerControl, filmModeControl, gammaModeControl, WB2PointControl, colorSpaceControl, and the 2025-only brightnessOptimizationControl, energySavingSolutionControl, motionLightingControl, autoPowerOffControl, gameModeControl, HDRToneMappingControl? Does getTVStates include speakerSelect on 2020?
- What are the exact ranges and display mapping on this TV: Tint (G/R) shown as G15/R15 or G50/R50 compared with the protocol's -15..15, and is contrast 0-50 rather than the 0-100 printed in the 2020 PDF?
- What exact pictureMode and soundMode strings does this TV return, including 'Filmmaker Mode' and HDR variants, and which ones does pictureModeControl accept?
- What does KEY_MENU (WebSocket) or remoteKeyControl 'menu' open on this 2020 firmware: full Settings at Picture, or a quick-settings row? Do menu lists wrap at the ends? How long until the menu auto-closes? What is the exact row order of Picture, Sound, General, System Manager > Time, and Accessibility on this firmware?
- Can a Tizen web service app (like pvcinehd01.MediaService, Node 4.4.3) call tizen.tvinfo / webapis.tvinfo and tizen.tvaudiocontrol in the background, so it can expose caption and volume state over its HTTP server without a foreground UI?
- Is this TV registered in the user's SmartThings account, and does the user want a cloud dependency at all, given the paid tiers from October 2026?
- What do remoteKeyControl 'caption' and KEY_CAPTION do on this TV: toggle captions, or open Accessibility Shortcuts? Are KEY_DYNAMIC, KEY_STANDARD, KEY_MOVIE1 and KEY_ESAVING honoured?
- Does the TV keep 1516 alive in standby when 'Power On with Mobile' or Bixby standby is on? This decides whether status can be shown while the TV is off.
