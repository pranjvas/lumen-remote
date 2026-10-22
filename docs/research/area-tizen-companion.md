# Research area: tizen-companion

## Summary

An on-TV companion is feasible on this Q95T, and CineHD has already proven its core on this exact TV. A packaged Tizen web service (Node v4.4.3 / V8 4.5.103.35, CommonJS require, built-in http/net/https) ran under the user's Samsung distributor certificate, which the project notes call "public". The UI app started it with tizen.application.launchAppControl and talked to it over 127.0.0.1 HTTP (CineHD records from 2026-09-17 and 2026-10-19, not observed by me today). One gotcha: the Q95T reports getCapability('http://tizen.org/feature/web.service') === false, yet the service runs, so never gate on that capability. Every useful read API is public-level and documented for TV: tizen.tvaudiocontrol (volume, mute, output mode, volume-change listener), tizen.tvwindow (current input source, input signal resolution and refresh rate, with a change listener), tizen.systeminfo (VIDEOSOURCE connected inputs, DISPLAY, BUILD, CPU, MEMORY, STORAGE, LOCALE, NETWORK, and on 5.5 also PANEL and SERVICE_COUNTRY), tizen.application (running apps, app-status change events, installed apps), webapis.productinfo, webapis.tvinfo / tizen.tvinfo (caption and accessibility settings, with listeners), webapis.avinfo.isHdrTvSupport and webapis.network. Picture settings (backlight, brightness, contrast, picture mode) are NOT exposed to public or partner web apps on a 2020 consumer TV. tvdisplaycontrol only covers 3D; B2B systemcontrol and b2bapis are partner-level and B2B-only; the avinfo energy-saving reads start at Tizen 6.5. DISPLAY.brightness exists, but Samsung does not say what it means on a TV, so it needs a probe and may be a constant. TVChannel has been removed from Samsung's docs and is missing from the Tizen 5.5 TV API set. Three things decide the design and are unproven. (1) Which tizen.* and webapis.* namespaces exist inside the Node service: only tizen.application, tizen.systeminfo.getCapability and webapis.preview are evidenced. (2) How long the service survives after the UI exits. (3) Whether the service can be reached inbound from the LAN. Samsung also documents that a hidden UI app's JavaScript is paused. Consumer TVs from 2019 on have no boot auto-start: prelaunch was dropped and on-boot is undocumented. The only system-driven launch is the personal-preview bg_service relaunch every 10 minutes, which is experimental. Recommended architecture: a separate small package (UI plus service, public privileges only) whose service connects out to the PC dashboard with a token and pushes snapshots and events. The PC re-arms it by launching the companion UI with a PAYLOAD; the UI starts the service and exits. The first build should be a read-only API census that settles the unknowns. Compared with external protocols, it adds: current input source with its signal resolution and refresh rate, the list of connected HDMI inputs, audio output mode, foreground-app events and the installed-app list, caption and accessibility settings, firmware, panel and HDR flags, and CPU, memory and storage. Push volume events are a bonus, since UPnP already covers volume. Picture settings must come from SmartThings (picture and sound mode) or from tracked state that is clearly labelled.

## Capabilities

- **Run a packaged background Node service on this Q95T** (source-code, high; read=true write=false live=false): config.xml <tizen:service id="<pkg>.Agent"><tizen:content src="service/index.js"/></tizen:service> + <feature name="http://tizen.org/feature/web.service"/>; module.exports.onStart/onRequest/onStop/onExit; started from UI via tizen.application.launchAppControl(new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service'), '<pkg>.Agent', ok, err)
  - These are earlier probe records on THIS TV, read from local files; I did not observe this today. ChdSvcT055 probe on 2026-09-17 returned node v4.4.3, v8 4.5.103.35, http/net/Buffer/Promise true, fetch false. The V2 probe confirmed https with verified TLS. CineHD 0.17.351+ /health also reported Node v4.4.3 on the Q95T on 2026-10-19. The Tizen doc says 'The TV Web service requires partner-level certification in Tizen 3.0', but on this 5.5 TV it ran with the user's distributor certificate, which the notes call 'public'. TizenBrew relies on the same mechanism on many consumer TVs. GOTCHA: the Q95T reports web.service=false (docs/acceptance/2026-10-19-proton-wg-tunnel.md), yet the service runs. Do not gate on getCapability.
- **Which tizen.*/webapis.* APIs exist inside the service (Node) context** (source-code, low; read=true write=false live=false): Inside onStart: typeof tizen.tvaudiocontrol / tizen.tvwindow / tizen.systeminfo.getPropertyValue / tizen.tvinfo / tizen.application.addAppStatusChangeListener / tizen.messageport / webapis.productinfo / webapis.tvinfo / webapis.avinfo / webapis.network; Object.keys(tizen), Object.keys(webapis)
  - Evidenced in the service context: tizen.application.getCurrentApplication().getRequestedAppControl()/replyResult()/exit() and tizen.ApplicationControlData (CineHD service-index.js, run on the TV), tizen.application.getAppInfo() and tizen.systeminfo.getCapability() (TizenBrew service), and webapis.preview.setPreviewData() as a global (Samsung personal preview guide). There is NO evidence for tvaudiocontrol, tvwindow, tvinfo, productinfo or network in the service. productinfo is created through a hidden <embed> by the shipped webapis.js (CineHD saw the ProductInfo EMBED), so it probably needs a DOM, which means the UI context only. The whole always-on design depends on this; a read-only census build must settle it first.
- **Service keeps running after the UI app exits / long-lived service** (community, medium; read=true write=false live=false): UI launches the service, then calls tizen.application.getCurrentApplication().exit(); the service keeps its timers and sockets and exits only on its own tizen.application.getCurrentApplication().exit() or a system stop (onStop)
  - TizenBrew's UI first tries ws://localhost:8081. If that connects it reports 'service.alreadyRunning', which implies the service outlives UI exits. TizenBrew issue #19 suggests the state is unclear after about 15-20 minutes. CineHD's own service ends itself after an 18 s idle lease, with MAX_SESSION_MS = 4 h while in use. Samsung's personal-preview guide says a system-launched preview service 'is automatically terminated after 5 minutes' if it does not exit. Samsung documents nothing about user-launched services, or about what happens in standby or Instant On. A heartbeat to the PC must measure this.
- **Service/app connects OUT to the PC dashboard over the LAN** (source-code, high; read=true write=true live=true): Node 4 http.request({host:<PC>, port:47800, method:'POST', path:'/agent/v1/state'}) or a ws@4 client to ws://<PC>:47800/agent/v1?token=...; UI context: XHR/WebSocket with <access origin="*"/> and CSP connect-src for the PC
  - Recorded on this TV: from the UI context, the tizentvwasm socket extension sent UDP and completed a WireGuard handshake with a test peer on the PC (0.17.350, 2026-10-19). From the service, outbound HTTPS to the internet worked (V2 probe). Outbound LAN HTTP from the service itself is inferred, not recorded. Node 4.4.3's TLS root store dates from 2016, so plain http/ws on the LAN avoids certificate issues. This is the recommended transport because it needs no inbound port on the TV.
- **Service listening on a LAN-reachable port (inbound from PC)** (inferred, low; read=true write=true live=true): require('http').createServer(h).listen(47811, '0.0.0.0')
  - Node http/net exist, but every known example binds 127.0.0.1 only: CineHD uses 18881, 18882, 18884 and 18885, and TizenBrew uses 8081. No document or source shows the TV allowing inbound connections to an app port, and the dead Samsung forum threads mentioned failures. Not needed if the agent connects out to the PC; keep this as a census experiment only.
- **UI <-> service bridge on the TV** (source-code, high; read=true write=true live=true): Loopback HTTP: the service listens on 127.0.0.1:<port>, and the UI uses XHR with CSP connect-src http://127.0.0.1:<port> and a per-run nonce; alternative tizen.messageport.requestLocalMessagePort('agent') in the service plus requestRemoteMessagePort('<pkg>.Agent','agent').sendMessage([{key:'state',value:json}]) in the UI
  - CineHD's loopback HTTP bridge works on this TV: a nonce in the URL, replyResult 'armed' ONLY after the server emits 'listening' (the 0.17.368 fix), host/origin guards, and CSP connect-src http://127.0.0.1:18884. MessagePort is documented for TV (no privilege listed) and named in the preview guide as the way to share data, but it has not been shown to work in a Node service.
- **Hidden UI app keeps running JS (hide())** (official-doc, medium; read=true write=false live=false): tizen.application.getCurrentApplication().hide(); <tizen:setting background-support="enable"/> (+ <tizen:background-category value="media"/> in generic Tizen)
  - Samsung multitasking guide: 'When the user switches from your application to another application or TV channel, JavaScript execution is paused'. Tizen config reference: since 2.4 even background-support=enable can be suspended unless a background category is declared, and the TV categories are undocumented. The 2020 multitasking row lists 20TV_PREMIUM. So the UI context can only sample while it is visible. A UI-only fallback would be on-demand snapshots with a brief visible flash.
- **Auto-start the companion/service at TV boot** (official-doc, high; read=false write=false live=false): None documented for 2019+ consumer TVs. Experimental: <tizen:metadata key="http://samsung.com/tv/metadata/use.preview" value="bg_service"/> (system launches the service about every 10 min); untested <tizen:service on-boot/auto-restart> attributes
  - The prelaunch guide says 'It is not supported anymore since 2019 smart TV'. The current tizen-docs config reference does not list on-boot or auto-restart for tizen:service; only the preview sample uses auto-restart="false". The personal-preview guide says 'service application is automatically launched by system every 10 mins regular basis', but such a service is 'automatically terminated after 5 minutes' if it does not exit. Whether that works for a sideloaded app on a 2020 TV is unknown. TizenBrew 'autolaunch' only acts when the TizenBrew UI is opened, and issue #151 shows it is unreliable. Design for re-arming from the PC.
- **Read current volume and get volume push events (on-TV)** (official-doc, high; read=true write=true live=true): tizen.tvaudiocontrol.getVolume() -> 0..100; setVolumeChangeListener(function(v){}) / unsetVolumeChangeListener(); setVolume(0..100), setVolumeUp(), setVolumeDown(); privilege http://tizen.org/privilege/tv.audio (public, 'deprecated since 5.0', i.e. no longer enforced); feature http://tizen.org/feature/tv.audio
  - Works in the UI context: CineHD ships 'audio boost' using getVolume, setVolume and setVolumeChangeListener, and the 5.5 emulator read volume 20. The listener does not fire on mute changes. Not critical because external UPnP RenderingControl GetVolume already worked live on this TV today (returned 4). The companion adds push events and a second source. Caveat: with ARC or optical external audio the TV-side level may not reflect actual loudness. Availability in the service context is unknown.
- **Read mute state** (official-doc, high; read=true write=true live=false): tizen.tvaudiocontrol.isMute() -> boolean; setMute(bool)
  - Public. No mute listener exists, so poll every 1-2 s, or use UPnP GetMute or GENA LastChange externally.
- **Read audio output mode** (official-doc, high; read=true write=false live=false): tizen.tvaudiocontrol.getOutputMode() -> 'PCM'|'DOLBY'|'DTS'|'AAC'|'DOLBY_DIGITAL_PLUS' (DD+ since 5.5)
  - Only available on the TV; no external protocol exposes it. It does not identify the output device (TV speaker, ARC or Bluetooth).
- **Read current input source** (official-doc, medium; read=true write=true live=false): tizen.tvwindow.getSource() (WindowType MAIN default) -> SystemInfoVideoSourceInfo {type:'TV'|'AV'|'SVIDEO'|'COMP'|'PC'|'HDMI'|'SCART'|'DVI'|'MEDIA', number, name}; privilege http://tizen.org/privilege/tv.window (public)
  - There is no external REST or UPnP equivalent on this TV; SmartThings mediaInputSource is the alternative. Unknowns: (a) whether it works when tizen.org/feature/tv.pip is false (the page lists tv.pip as a requirement); (b) what it returns while another app such as Netflix is in the foreground (probably the last broadcast or external source, so combine it with app-status events); (c) whether it exists in the service context. setSource has side effects; never call it in probes.
- **Read current input signal resolution / refresh rate** (official-doc, medium; read=true write=false live=true): tizen.tvwindow.getVideoResolution() -> {width, height, frequency, aspectRatio:'ASPECT_RATIO_16x9'|...}; addVideoResolutionChangeListener(cb) / removeVideoResolutionChangeListener(id); privilege tv.window (public)
  - Equivalent to the TV's own 'Info' banner (for example 3840x2160 at 60 Hz), with push changes. HDR state of the signal is not exposed. Same tv.pip and context unknowns as getSource.
- **List connected video inputs (HDMI ports in use)** (official-doc, medium; read=true write=false live=true): tizen.systeminfo.getPropertyValue('VIDEOSOURCE', cb) -> {connected:[{type:'HDMI',number:2}], disconnected:[...]}; addPropertyValueChangeListener('VIDEOSOURCE', cb)
  - No privilege. The 'signal' member is supported only through TVWindow. Since 2.3 on TV.
- **Read display brightness** (official-doc, low; read=true write=false live=true): tizen.systeminfo.getPropertyValue('DISPLAY', cb) -> {resolutionWidth, resolutionHeight, dotsPerInchWidth/Height, physicalWidth/Height, brightness (0..1)}; addPropertyValueChangeListener('DISPLAY', cb, {highThreshold, lowThreshold})
  - Documented generically: 'The current brightness of a display ranging between 0 to 1'. Samsung's TV page gives no TV remark, and a 2017 community post called TV systeminfo read-only and not implemented. It probably does NOT track the picture-menu Backlight, but it is the only on-TV brightness-like value, so the census must log it while the user changes Backlight. Label it 'unverified' in the UI until correlated.
- **Read picture settings (backlight, brightness, contrast, sharpness, colour, picture mode, colour tone)** (official-doc, high; read=false write=false live=false): None for public/partner web apps on 2020 consumer TVs. tizen.tvdisplaycontrol covers only 3D (get3DEffectMode/is3DModeEnabled/getSupported3DEffectModeList, tv.display public); webapis.systemcontrol / b2bapis.b2bcontrol are Product B2B, Privilege Level Partner (only getScreenLampSchedule is lamp-related); no picture API in TizenFX TV; Tizen native and vconf are not open to third-party TV apps
  - The design must source picture mode and sound mode from SmartThings (other area), or show 'tracked' or 'estimated' values set through the dashboard's own menu macros, clearly labelled. The UPnP RenderingControl SCPD on 9197 (from the task facts) also lacks brightness and contrast actions. Possible deep paths, both experimental and low-likelihood: tizen.iotcon (public, internet privilege) querying the TV's own OCF/SmartThings resources locally, which are probably secured by OCF ownership; and the DISPLAY.brightness correlation test above.
- **Energy saving / eco sensor level** (official-doc, low; read=true write=true live=false): webapis.avinfo.getEnergySaving() -> 'OFF'|'LOW'|'MEDIUM'|'HIGH'; webapis.avinfo.getEcoSensor() -> 'OFF'|'ON'
  - Documented 'Since 6.5' (2021+), so it is probably NotSupportedError on this 5.5 firmware. Worth one guarded try in the census because energy saving dims the panel.
- **HDR capability flag** (official-doc, high; read=true write=false live=false): webapis.avinfo.isHdrTvSupport() -> boolean (getDolbyDigitalCompMode deprecated since 4.0)
  - Capability only, not whether the current signal is HDR. No privilege listed. Needs $WEBAPIS/webapis/webapis.js in the UI.
- **Product / firmware info** (official-doc, high; read=true write=false live=true): webapis.productinfo.getFirmware(), getModel(), getModelCode(), getRealModel(), getLocalSet(), getSystemConfig(webapis.productinfo.ProductInfoConfigKey.CONFIG_KEY_SERVICE_COUNTRY), isUdPanelSupported(), is8KPanelSupported(), isUHDAModel(), isWallModel(), getSmartTVServerType(), getSmartTVServerVersion(), isDisplayRotatorSupported(); privilege http://developer.samsung.com/privilege/productinfo (public); getDuid() also exists
  - Already accepted at install by this TV with this certificate (the CineHD config declares productinfo). addSystemConfigChangeListener gives push. It probably needs the UI context because webapis.js creates an <embed> plugin; read it once and cache it in the service. Do not display the DUID.
- **Caption / accessibility / UI menu settings** (official-doc, medium; read=true write=false live=true): webapis.tvinfo.getMenuValue(webapis.tvinfo.TvInfoMenuKey.CAPTION_ONOFF_KEY | VOICE_GUIDE_KEY | ACCESSIBILITY_HIGH_CONTRAST | ACCESSIBILITY_FOCUS_ZOOM | SUBTITLE_ONOFF_KEY | PRIMARY_AUDIO_LANGUAGE_KEY | SECONDARY_AUDIO_LANGUAGE_KEY | UI_TIMEOUT ...); addCaptionChangeListener(key, cb); Tizen-level tizen.tvinfo.getCaptionValue('CAPTION_ONOFF_KEY') + addCaptionValueChangeListener (feature http://tizen.org/feature/tv.information)
  - Reading needs no privilege. setMenuValue is B2B only (tvinfo privilege). This is real TV menu state for an 'Accessibility and Captions' card.
- **Smart remote battery / board temperature** (official-doc, low; read=true write=false live=false): webapis.tvinfo.getTvInfoValue('SMART_RC_BATTERY') -> 0..100; getTvInfoValue('BOARD_TEMPERATURE') -> long
  - Documented 'Since 6.5', so it is probably NotSupportedError on 5.5. Try it once in the census.
- **Foreground app changes and installed/running apps** (official-doc, medium; read=true write=false live=true): tizen.application.addAppStatusChangeListener(function(appId,isActive){}) (since 4.0, no privilege listed); tizen.application.getAppsContext(cb) -> [{id, appId}]; tizen.application.getAppsInfo(cb) -> [{id,name,iconPath,version,packageId,show,...}]
  - CineHD already uses getAppsContext on the TV (service-exit.ts). Whether status events fire for OTHER apps, and fire inside the service, is unknown. External fallback: poll REST GET http://<tv>:8001/api/v2/applications/<appId>/ (trailing slash) for 'visible'. Do NOT use tizen.application.kill (appmanager.kill is partner level and would break install or calls).
- **Now-playing metadata of other apps** (official-doc, low; read=true write=true live=true): tizen.mediacontroller.getClient().findServers(cb) / getLatestServerInfo() -> playbackInfo {state, position, metadata{title,...}}; privilege http://tizen.org/privilege/mediacontroller.client (public)
  - Present in the Tizen 5.5 TV device API set but not in Samsung's TV API index. Only useful if Netflix, YouTube or Prime publish media-controller servers on Samsung TVs, which is unknown. Add the privilege only after the census shows tizen.mediacontroller exists.
- **System stats (CPU, memory, storage, build, locale, panel, service country)** (official-doc, high; read=true write=false live=true): tizen.systeminfo.getPropertyValue('CPU'|'STORAGE'|'BUILD'|'LOCALE'|'NETWORK'|'PANEL'|'SERVICE_COUNTRY'|'SOURCE_INFO', cb); tizen.systeminfo.getTotalMemory(), getAvailableMemory(); tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version') etc.
  - PANEL {panelWidth, panelHeight}, SERVICE_COUNTRY and SOURCE_INFO are 'supported since Tizen 5.5'; PANEL listeners raise NotSupportedError, and SOURCE_INFO has no documented interface. CineHD read STORAGE on the emulator. CPU load and MEMORY support listeners or thresholds.
- **Network status** (official-doc, high; read=true write=false live=true): webapis.network.getActiveConnectionType(), isConnectedToGateway(), getTVName(), getWiFiSignalStrengthLevel(), addNetworkStateChangeListener(cb); privilege http://developer.samsung.com/privilege/network.public (public)
  - getMac(), getIp(), getWiFiSsid() and getDns() also exist. The agent must NOT read or forward those (user privacy rule); whitelist only type, connected, signal level and TV name. TizenBrew declares network.public on consumer TVs.
- **Current channel / programme (EPG)** (official-doc, medium; read=false write=false live=false): tizen.tvchannel (privilege http://tizen.org/privilege/tv.channel) - removed
  - The Samsung tvchannel-api.html now returns 404, and tvchannel is absent from the tizen-docs 4.0, 5.0 and 5.5 TV API sets. A forum post says the TV Channel API was unavailable from mid-April 2024. It is also of little use in India if a set-top box feeds HDMI.
- **Key capture / key injection from the TV app** (official-doc, high; read=true write=false live=true): tizen.tvinputdevice.getSupportedKeys()/registerKey('VolumeUp')/registerKeyBatch([...]) (tv.inputdevice public) - receive only while the app is focused; no injection API
  - Arrow keys, Enter and Back are mandatory and cannot be registered. The companion cannot send keys; keys stay on the PC's ws/wss remote channel (other area).
- **Smart View (MSF) app channel as PC<->TV-app transport** (source-code, medium; read=true write=true live=true): TV: msf.local(cb) -> GET http://127.0.0.1:8001/api/v2/ -> service.channel('com.pv.remote').connect({name:'TV'}); PC: ws://<tv>:8001/api/v2/channels/com.pv.remote?name=<b64> sending {"method":"ms.channel.emit","params":{"event":"state","data":{...},"to":"host"|"broadcast"|<clientId>}}; events ms.channel.connect/clientConnect/clientDisconnect/ready
  - Format taken from MultiScreenSDK msf-2.0.21.min.js (connectionUrl = 'ws://'+host+pathname+'channels/'+id). It needs the UI app running (msf is a UI library) and uses port 8001, where an access 'Allow' prompt may appear. Not recommended for the always-on path. Launch args reach the TV app as appControl data key 'PAYLOAD'.
- **Privilege level of the user's certificate and safe privilege set** (source-code, medium; read=true write=false live=false): Public-level privileges only: internet, application.launch, application.info, tv.audio, tv.window, tv.inputdevice, filesystem.read, developer.samsung.com/privilege/productinfo, developer.samsung.com/privilege/network.public (optional mediacontroller.client). Avoid partner ones: appmanager.kill, appmanager.certificate, network.dhcpoption60, systemcontrol, broadcast
  - CineHD notes describe the Q95T certificate as 'public' and the emulator profile as 'distributor Public'. CineHD packages with internet, download, tv.audio, tv.inputdevice, filesystem.read, application.launch and productinfo install and run on the Q95T. A partner privilege under a public certificate is the classic PRIVILEGE_LEVEL_VIOLATION install failure. The SDK on disk (TizenStudio10) has no TV privilege-level tables: platforms/tizen-5.5/tv-samsung contains only the emulator, and privilege-wrt.properties lists generic Tizen privileges.

## Protocol details

## Evidence key
live-tv = observed on this TV today (I made no TV contact). source-code = code or recorded results in local repos or GitHub. official-doc = Samsung or Tizen docs. community = forums or issues. inferred = reasoning.

## 1. Already established on THIS Q95T (CineHD records, source-code, not re-observed today)
- **Service runtime.** The packaged web service runs Node `v4.4.3` with V8 `4.5.103.35`. CommonJS `require('./x')` works. Built-ins `http`, `net`, `https` and `Buffer` exist; `fetch` does not (`work/standalone-service-probe/tv-result.json`, 2026-09-17).
- **Loopback.** From the service, `GET http://127.0.0.1:8001/api/v2/` works, and a TCP connect to 127.0.0.1:26101 works (the SDB handshake is rejected, `peer-closed`).
- **Capability flag is wrong.** The Q95T reports `tizen.systeminfo.getCapability('http://tizen.org/feature/web.service') === false`, yet `launchAppControl` to the service works and `/health` answers (`docs/acceptance/2026-10-19-proton-wg-tunnel.md`). **Never gate on this capability.**
- **Reply order matters.** Reply `armed` with `request.replyResult([...])` only after `server.once('listening')`. Earlier replies caused status-0 POSTs (0.17.368 fix).
- **TLS on Node 4.4.3.** Its root store is from 2016, so HTTPS needs a bundled `ca:` list (0.17.371). Plain LAN `http`/`ws` avoids this.
- **UI-context sockets.** The `tizentvwasm` socket extension is present on the Q95T, and UDP from a UI worker to the PC completed a WireGuard handshake.
- **Privileges this certificate accepts** (CineHD `work/provider-controls-app/static/config.xml`): `internet`, `download`, `tv.audio`, `tv.inputdevice`, `filesystem.read`, `application.launch`, `http://developer.samsung.com/privilege/productinfo`, plus `<feature name="http://tizen.org/feature/web.service"/>`.
- **CineHD's own service.** It binds 127.0.0.1:18884 (media) and 127.0.0.1:18885 (VPN hub), uses nonce URL paths, and leases for 18 s idle with `MAX_SESSION_MS = 4h`. Do not reuse these ports. TizenBrew uses 127.0.0.1:8081.

## 2. Proposed companion package
Make it separate from CineHD, because CineHD is owned by other agents. The package ID must be 10 alphanumeric characters.
```xml
<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="https://local.example/tv-companion" version="0.1.0" viewmodes="maximized">
  <tizen:application id="pvremote01.Companion" package="pvremote01" required_version="5.5"/>
  <content src="index.html"/><name>TV Companion</name><icon src="icon.png"/>
  <tizen:profile name="tv-samsung"/>
  <feature name="http://tizen.org/feature/web.service"/>
  <tizen:service id="pvremote01.Agent">
    <tizen:content src="service/index.js"/>
    <tizen:name>TV state agent</tizen:name>
    <tizen:description>Reports TV state to the PC dashboard</tizen:description>
  </tizen:service>
  <tizen:privilege name="http://tizen.org/privilege/internet"/>
  <tizen:privilege name="http://tizen.org/privilege/application.launch"/>
  <tizen:privilege name="http://tizen.org/privilege/application.info"/>
  <tizen:privilege name="http://tizen.org/privilege/tv.audio"/>
  <tizen:privilege name="http://tizen.org/privilege/tv.window"/>
  <tizen:privilege name="http://developer.samsung.com/privilege/productinfo"/>
  <tizen:privilege name="http://developer.samsung.com/privilege/network.public"/>
  <access origin="*" subdomains="true"/>
  <tizen:setting screen-orientation="landscape" context-menu="disable" background-support="enable" encryption="disable" install-location="auto" hwkey-event="enable"/>
  <tizen:metadata key="http://samsung.com/tv/metadata/devel.api.version" value="5.5"/>
  <tizen:content-security-policy>default-src 'self'; script-src 'self'; connect-src 'self' http://127.0.0.1:47811 http://PC_LAN_IP:47800 ws://PC_LAN_IP:47800</tizen:content-security-policy>
</widget>
```
- Never add `appmanager.kill`, `appmanager.certificate`, `network.dhcpoption60`, `systemcontrol` or `broadcast`. They are partner-level, and under a public certificate the install fails.
- Add `mediacontroller.client` only in a second build, after the census shows `tizen.mediacontroller` exists.
- Experimental, gated by the census: `<tizen:metadata key="http://samsung.com/tv/metadata/use.preview" value="bg_service"/>`. Samsung says this makes the system launch the service about every 10 minutes, and that a preview-launched service is killed after 5 minutes if it does not exit.

## 3. UI starts the service, then gets out of the way (UI context)
TizenBrew pattern (`tizenbrew-ui/src/app.jsx`), plus a PAYLOAD hand-off:
```js
var app = tizen.application.getCurrentApplication();
var pc = null, rq = app.getRequestedAppControl();          // PC launch args arrive as key 'PAYLOAD'
if (rq && rq.appControl) rq.appControl.data.forEach(function (d) { if (d.key === 'PAYLOAD') pc = d.value[0]; });
pc = pc || localStorage.getItem('pcAgentUrl');            // e.g. 'http://<pc>:47800|<token>'
tizen.application.launchAppControl(
  new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service', null, null, null,
    [new tizen.ApplicationControlData('pc', [pc])]),
  'pvremote01.Agent',
  function () { /* optional: read UI-only APIs (productinfo, tvwindow if absent in service) and POST them to http://127.0.0.1:47811/ui-report?nonce=... */
                setTimeout(function () { app.exit(); }, 1500); },   // or app.hide()
  function (e) { /* show error */ }, null);
```
- **PC-side re-arm (product time, not research).** Launch `pvremote01.Companion` over the already-authorised remote WebSocket: `{"method":"ms.channel.emit","params":{"event":"ed.apps.launch","to":"host","data":{"appId":"pvremote01.Companion","action_type":"NATIVE_LAUNCH","metaTag":"http://<pc>:47800|<token>"}}}`. metaTag arriving as PAYLOAD is community/inferred. Smart View startArgs arriving as `PAYLOAD` is source-code (SamsungDForum sample).
- **Cost.** A brief visible flash, and it may pause whatever app is playing.

## 4. Service skeleton (ES5, Node 4.4.3 safe; dial-out, no inbound port)
```js
'use strict';
var http = require('http');
var PC = null, TOKEN = null, started = false, seq = 0, volWatch = false;
function safe(f){ try { return {ok:true, v:f()}; } catch (e) { return {ok:false, err:String(e && e.name || e)}; } }
function post(path, body){
  if (!PC) return; var s = JSON.stringify(body);
  var r = http.request({hostname:PC.host, port:PC.port, path:path, method:'POST',
    headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(s),'X-Agent-Token':TOKEN}});
  r.on('error', function(){}); r.setTimeout(4000, function(){ r.abort(); }); r.end(s);
}
function sysinfo(prop, cb){ try { tizen.systeminfo.getPropertyValue(prop, function(v){ cb({ok:true,v:v}); }, function(e){ cb({ok:false,err:e && e.name}); }); } catch (e) { cb({ok:false,err:e.name}); } }
function snapshot(){
  var t = global.tizen || {}, s = {type:'state', seq:++seq, ts:Date.now(), node:process.version};
  if (t.tvaudiocontrol){ s.volume = safe(function(){ return t.tvaudiocontrol.getVolume(); });
    s.mute = safe(function(){ return t.tvaudiocontrol.isMute(); });
    s.outputMode = safe(function(){ return t.tvaudiocontrol.getOutputMode(); }); }
  if (t.tvwindow){ s.source = safe(function(){ var x = t.tvwindow.getSource(); return {type:x.type, number:x.number, name:x.name}; });
    s.video = safe(function(){ var r = t.tvwindow.getVideoResolution(); return {w:r.width, h:r.height, hz:r.frequency, ar:r.aspectRatio}; }); }
  s.mem = safe(function(){ return {total:t.systeminfo.getTotalMemory(), avail:t.systeminfo.getAvailableMemory()}; });
  post('/agent/v1/state', s);
}
function arm(){
  if (started) return; started = true;
  var t = global.tizen || {};
  if (t.tvaudiocontrol && !volWatch){ try { t.tvaudiocontrol.setVolumeChangeListener(function(v){ post('/agent/v1/event', {type:'volume', v:v, ts:Date.now()}); }); volWatch = true; } catch (e) {} }
  if (t.application && t.application.addAppStatusChangeListener){ try { t.application.addAppStatusChangeListener(function(id, active){ post('/agent/v1/event', {type:'app', appId:id, active:active, ts:Date.now()}); }); } catch (e) {} }
  if (t.tvwindow && t.tvwindow.addVideoResolutionChangeListener){ try { t.tvwindow.addVideoResolutionChangeListener(function(r){ post('/agent/v1/event', {type:'video', w:r.width, h:r.height, hz:r.frequency}); }); } catch (e) {} }
  ['VIDEOSOURCE','DISPLAY','CPU'].forEach(function(p){ try { tizen.systeminfo.addPropertyValueChangeListener(p, function(v){ post('/agent/v1/event', {type:'sys', prop:p, v:v}); }); } catch (e) {} });
  setInterval(snapshot, 5000); snapshot();                 // gentle: 1 snapshot / 5 s + events
}
module.exports.onStart = function(){};
module.exports.onRequest = function(){
  var rq = tizen.application.getCurrentApplication().getRequestedAppControl();
  (rq.appControl.data || []).forEach(function(d){ if (d.key === 'pc' && d.value[0]) {
    var m = /^http:\/\/([^:\/|]+):(\d+)\|([A-Za-z0-9_-]{16,})$/.exec(d.value[0]);
    if (m) { PC = {host:m[1], port:+m[2]}; TOKEN = m[3]; } } });
  arm(); try { rq.replyResult([new tizen.ApplicationControlData('agent-state', ['armed'])]); } catch (e) {}
};
module.exports.onStop = function(){ post('/agent/v1/event', {type:'bye', ts:Date.now()}); };
module.exports.onExit = module.exports.onStop;
```
- **Commands from the PC.** Use a long-poll, `GET /agent/v1/commands?wait=25` (Node 4 `http.get`), or bundle `ws@4` the way TizenBrew does (`"ws-old": "npm:ws@^4.1.0"` with babel + `@vercel/ncc`) for a WebSocket.
- **Gentle by design.** Only read-only commands: `{"cmd":"snapshot"}`, `{"cmd":"census"}`.

## 5. Wire shapes (TV to PC)
- `POST /agent/v1/hello`: `{"agent":"pvremote01.Agent","node":"v4.4.3","apis":{"tvaudiocontrol":true,"tvwindow":false,...}}`
- `POST /agent/v1/state`: `{"type":"state","seq":12,"ts":...,"volume":{"ok":true,"v":12},"mute":{"ok":true,"v":false},"outputMode":{"ok":true,"v":"PCM"},"source":{"ok":true,"v":{"type":"HDMI","number":2}},"video":{"ok":true,"v":{"w":3840,"h":2160,"hz":60,"ar":"ASPECT_RATIO_16x9"}}}`
- `POST /agent/v1/event`: `{"type":"volume","v":13}`, `{"type":"app","appId":"...","active":true}`, `{"type":"video",...}`, `{"type":"sys","prop":"VIDEOSOURCE","v":{"connected":[{"type":"HDMI","number":1}]}}`
- **Liveness.** The PC marks the agent offline after 15 s without state, and offers re-arm only when REST `GET http://<tv>:8001/api/v2/` shows `PowerState` `on`.

## 6. First build = read-only API census (settles the critical unknowns)
**In BOTH the UI and the service, record:**
- `typeof` and `Object.keys` of `tizen` and `webapis`, plus `process.version`.
- Calls guarded with try/catch:
  - `tvaudiocontrol.getVolume`, `isMute` and `getOutputMode`
  - `tvwindow.getSource`, `getVideoResolution` and `getAvailableWindows`
  - `systeminfo.getPropertyValue` for each of `BUILD`, `CPU`, `MEMORY`, `STORAGE`, `DISPLAY`, `LOCALE`, `NETWORK`, `PERIPHERAL`, `VIDEOSOURCE`, `PANEL`, `SERVICE_COUNTRY`, `SOURCE_INFO`
  - `getCapability('http://tizen.org/feature/tv.pip')`, `.../tv.audio`, `.../tv.information`, `.../web.service`
  - `application.getAppsContext` and `getAppsInfo`, and whether `addAppStatusChangeListener` fires when the user switches apps
  - `tvinfo.getCaptionValue`; `webapis.tvinfo.getMenuValue` over all keys; `getTvInfoValue('SMART_RC_BATTERY')`
  - `webapis.productinfo.*` getters, `webapis.avinfo.isHdrTvSupport`, `getEnergySaving` and `getEcoSensor`
  - `webapis.network.getActiveConnectionType`, `getTVName` and `getWiFiSignalStrengthLevel`. Never `getMac`, `getIp`, `getWiFiSsid` or `getDns`.

**Also measure:**
- Service lifetime after UI `exit()`: a heartbeat every 30 s until it stops, across Netflix, HDMI and standby.
- Whether `listen(47811,'0.0.0.0')` is reachable from the PC.
- `DISPLAY.brightness` before and after the user changes Backlight.

No `set*` or `tune`, no audio, no `setSource`.

## 7. Gotchas
- REST `/api/v2/applications/<id>/` needs the trailing slash (task facts).
- Do not call `setSource`, `setVolume` or `setMute` from probes.
- `tvaudiocontrol` privilege text says 'deprecated since 5.0'. That means it is not enforced; declaring it is harmless and already accepted.
- The `tizen:service` element in newer Tizen Studio IDE validators may demand `type="ui"`. CineHD builds without it via `tizen package`.
- Node 4.4.3 lacks: `fetch`, `Array.prototype.includes`, and safe ES2015+ outside strict mode. Transpile to ES5.
- `productinfo` and other `$WEBAPIS/webapis/webapis.js` APIs may require the UI DOM (embed plugin).
- `getSource()` describes the TV video window, not which app is on screen. Combine it with app-status events or REST `visible`.
- The service must call `tizen.application.getCurrentApplication().exit()` itself when done. Samsung warns that otherwise preview relaunch fails for 10 minutes.

## 8. What the companion cannot add
- **Picture settings.** Backlight, brightness, contrast and picture mode have no public or partner API on 2020 consumer TVs. Use SmartThings `custom.picturemode` (other area) or labelled tracked state.
- **Key injection.** None.
- **Channel / EPG.** TVChannel has been removed.
- **Boot auto-start.** Not supported on 2019+ TVs.

## Risks

- The always-on design depends on tizen.tvaudiocontrol, tizen.tvwindow and tizen.systeminfo existing inside the Node service context, and none of that is evidenced. If they are missing, the UI context must read them, and Samsung documents that a hidden UI app's JavaScript is paused. The companion would then shrink to on-demand snapshots with a visible flash on screen.
- The service may be killed after the UI exits, under memory pressure, or in standby/Instant On. Samsung documents no lifetime for user-launched services and says preview-launched services end after 5 minutes. The PC must detect this and re-arm.
- Consumer TVs from 2019 on have no supported boot auto-start. After every cold boot, someone (the PC or the user) must launch the companion once. That flashes it on screen and may pause the app that is playing.
- tizen.tvwindow.getSource may throw NotSupportedError on a TV without picture-in-picture (tv.pip). It may also return the last broadcast or HDMI source rather than what is actually on screen while another app is in the foreground.
- DISPLAY.brightness probably does not track the picture-menu Backlight on TVs. Showing it as 'brightness' without correlation would mislead. Picture settings are simply unavailable on the TV, so they must come from SmartThings or clearly labelled tracked state.
- Declaring any partner-level privilege (appmanager.kill, appmanager.certificate, network.dhcpoption60, systemcontrol, broadcast) under the public certificate makes installation fail. Unknown privileges such as mediacontroller.client should go in a second build, not the first.
- Installing a new package needs sdb on port 26101 and the Q95T signing profile, which other agents and the CineHD deploy pipeline own. It also needs the user's approval. Package leaf certificates expire in September 2027, and the distributor certificate is tied to the TV's DUID.
- Product APIs that depend on webapis.js (productinfo and possibly network) may need the UI DOM, because webapis.js creates them through an <embed>. They may not work in the service.
- Node 4.4.3 limits: no fetch, old TLS roots, ES5 or transpiled code only. npm dependencies must be Node 4 compatible (TizenBrew pins ws@4).
- Privacy: webapis.network can return the MAC, IP, SSID and DNS. The agent must whitelist only connection type, signal level and TV name, and must never log or forward the others.
- Security: a TV agent that accepts commands is a LAN attack surface. Dial out only, use a shared token, keep the agent read-only, and bind any listener to 127.0.0.1.
- A firmware update can remove APIs without warning; TVChannel has already disappeared. Keep every read guarded and capability-reported, and degrade the UI gracefully.
- Port and namespace collisions with CineHD (127.0.0.1:18881-18885) or TizenBrew (8081). Use a separate package and port range, for example 47811 on the TV and 47800 on the PC.

## Open questions

- Which namespaces do Object.keys(tizen) and Object.keys(webapis) return inside the pvremote01.Agent Node service on this firmware, compared with the UI context?
- Does tizen.tvwindow.getSource() / getVideoResolution() work on the Q95T, where tv.pip is probably false? What does it return while Netflix or YouTube is in the foreground, and while an HDMI input is shown?
- Does tizen.systeminfo DISPLAY.brightness change when the user changes Settings > Picture > Expert Settings > Backlight or Brightness, or is it constant?
- How long does a user-launched service survive after the UI calls exit()? Does it survive standby (Instant On), and does onStop fire?
- Does tizen.application.addAppStatusChangeListener fire for other apps' activation, and does it fire inside the service?
- Can a Node service socket bound to 0.0.0.0 be reached from the PC, or does the TV filter inbound ports?
- Does metadata use.preview=bg_service make the system launch a sideloaded app's service every ~10 minutes on a 2020 TV? Is that service then killed after 5 minutes even while it holds sockets open?
- Are on-boot / auto-restart attributes on <tizen:service> honoured or rejected by the 5.5 TV installer?
- Do webapis.avinfo.getEnergySaving(), getEcoSensor() and webapis.tvinfo.getTvInfoValue('SMART_RC_BATTERY') exist on 5.5 firmware, despite being documented 'since 6.5'?
- Does tizen.mediacontroller expose now-playing data from Netflix, YouTube or Prime on Samsung TVs?
- Does tizen.iotcon on the TV reach the TV's own OCF/SmartThings resources (for example picture mode) over loopback, or are they secured?
- Does a PC client connecting to an MSF app channel (ws://<tv>:8001/api/v2/channels/<id>) trigger the TV's access 'Allow' prompt?
- Does an ed.apps.launch metaTag from the PC remote channel arrive in the companion as appControl data key 'PAYLOAD'? (Smart View startArgs do, per the SamsungDForum sample.)
- Confirm from installer output that the Q95T distributor certificate is Public level. The notes say 'public'; nothing private was read.
