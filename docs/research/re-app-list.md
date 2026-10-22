# Reverse engineering: app-list

## Summary

Root cause found and verified live. On this Q95T (Tizen 5.5, 2026 hotfix) the `samsung.remote.control` channel has NO host: the `ms.channel.connect` frame listed exactly one client (our own `Lumen Remote`, `isHost:false`) and nothing else. Emits addressed `to:"host"` therefore have no recipient and the MSF framework silently discards them. That is why `ed.installedApp.get` (and `ed.edenApp.get`, `ed.edenTV.get`) never reply, and why `ed.apps.icon` is equally dead. remote-server (the process that serves keys/IME/pointer on this channel) is NOT an emit host and has no app-list handler: its only app methods are the internal MSF dispatch `application.getApplication` (per-app status by ID), `application.launchApplication/stopApplication/installApplication`, `application.getCastingAppsInfo`, and `DoGetMSFAppsInfo` (CMSFAppsInfo -> Samsung CLOUD casting-app catalogue via /apps/store/v4/apps/ and /store/smartview/v2/multiscreen, gated by HubTerms agreement) -- none enumerate locally installed apps. This matches the community finding that Samsung removed the installed-app list from the local websocket on post-2020 models. So "other remote apps that list apps" are NOT using the remote channel; they use one of three other paths. RANKED for Lumen Remote: (1) PRIMARY, already verified -- the on-TV Lumen Agent's UI context `tizen.application.getAppsInfo()` returns all 406 apps with names + iconPath (226 visible) and `getAppsContext()` the running IDs; this is the only fully-proven local inventory and also the icon source (agent serves iconPath bytes). (2) CANDIDATE, local, no agent -- MobileBFF service on the separate MSF channel `com.samsung.tv.mobilebff` with an appdata getter (`get.apptiles`/`get.extsources`); gives home tiles + icon paths but the event-path and whether it needs a SmartThings/cloud link are unproven and it may raise an on-screen Allow prompt, so it needs a supervised launch test. (3) SmartThings cloud -- lists apps via OCF, account-bound, secondary. Per-app existence/status without a list is REST `GET /api/v2/applications/<id>/`. Icons: no TV HTTP icon endpoint exists and `ed.apps.icon` is dead (no host) -- use the agent iconPath, or MobileBFF tile icon paths, or bundle curated icons.

## Verified live

- REST GET http://192.168.1.2:8001/api/v2/ -> HTTP 200, device.PowerState=on, model QA55Q95TAKXXL / 20_NIKEM_QTV (confirmed TV awake before any socket contact)
- wss samsung.remote.control reconnect with saved token was silent (no Allow prompt); ms.channel.connect delivered ~1.5s after open
- ms.channel.connect clients[] contained ONLY our client {attributes:{name,token}, isHost:false}; NO host and no other client present on the channel
- ed.installedApp.get to host with data:'' -> 0 replies
- ed.installedApp.get to host with no data field -> 0 replies
- ed.edenApp.get to host with data:'' -> 0 replies
- ed.edenTV.get to host with data:'' -> 0 replies (whole 4-getter session ~11s, only the single connect frame was ever received)

## Recipes

### Baseline: prove the remote-channel installed-app getter is dead on this firmware

- evidence: live-tv; needs live launch test: false
- request: {"method":"ms.channel.emit","params":{"event":"ed.installedApp.get","to":"host","data":""}} on wss://192.168.1.2:8002/api/v2/channels/samsung.remote.control?name=<b64 name>&token=<token>
- expected: No reply at all (there is no host client to route the emit to). Do not build on it.

### Rule out the no-data variant

- evidence: live-tv; needs live launch test: false
- request: {"method":"ms.channel.emit","params":{"event":"ed.installedApp.get","to":"host"}}
- expected: No reply (same no-host reason).

### Rule out the Eden launcher variants used by some firmwares

- evidence: live-tv; needs live launch test: false
- request: {"method":"ms.channel.emit","params":{"event":"ed.edenApp.get","to":"host","data":""}} and ed.edenTV.get likewise
- expected: No reply (no host).

### PRIMARY recommended local inventory (already proven): on-TV Lumen Agent UI context

- evidence: live-tv; needs live launch test: false
- request: In the agent's UI (foreground) page: tizen.application.getAppsInfo() ; tizen.application.getAppsContext() ; relay the array to the PC over the agent's loopback/dial-out link
- expected: Array of ~406 app objects {id,name,iconPath,show/visible,...}; getAppsContext() returns running app IDs. iconPath is an absolute on-TV file path the agent can read and serve.

### Per-app existence/status without a list (confirm or poll a known ID)

- evidence: live-tv; needs live launch test: false
- request: GET http://192.168.1.2:8001/api/v2/applications/<appId>/   (trailing slash mandatory)
- expected: {id,name,running,version,visible} for installed apps; 404 for not-installed or org.tizen.*/com.samsung.* aliases and service apps. 'visible' = foreground; 'running' is noisy.

### CANDIDATE local app/tile list + icons without the agent: MobileBFF on its own MSF channel

- evidence: inferred; needs live launch test: true
- request: Open wss://192.168.1.2:8002/api/v2/channels/com.samsung.tv.mobilebff?name=<b64 name>&token=<token>; after ms.channel.connect send {"method":"ms.channel.emit","params":{"event":"/sec/tv/appdata/mobilebff","to":"host","data":"{\"version\":\"0.2\",\"id\":\"get.apptiles\",\"seqId\":\"1\",\"params\":{}}"}}  (also try id get.extsources, get.settings.data; the mobilebff-probe.mjs allow-list drives this)
- expected: If a mobilebff host is present: a notify/reply frame whose inner data JSON holds an array of home-screen tiles (app id/name + icon path/url) and external sources. UNPROVEN: the /sec/tv/appdata/mobilebff event path is inferred, not a binary literal; get.apptiles may return only home tiles not every installed app; the ADC (ifw-thing-2.3.0) exposes GetCloudConnection so it may require a SmartThings/cloud link; and opening this channel may pop an on-screen Allow for this client.

### SmartThings cloud as the cross-check list (secondary)

- evidence: community; needs live launch test: true
- request: SmartThings API device list + capabilities for the TV (OCF VD-STV_2018_K); custom.launchapp / mediaInputSource name maps
- expected: Cloud-reported app list and friendly names; account/OAuth bound, rate-limited, not local.

### Icons: confirm there is no local icon getter over the remote channel

- evidence: live-tv; needs live launch test: false
- request: {"method":"ms.channel.emit","params":{"event":"ed.apps.icon","to":"host","data":"{\"iconPath\":\"<path>\"}"}}
- expected: No reply (same no-host cause) and there is no TV HTTP icon endpoint. Use agent iconPath bytes, MobileBFF tile icon paths, or bundled curated icons instead.

## Code sketch

```js
// Node 22 ESM. App-list paths for the Q95T (Tizen 5.5, 2020). import WebSocket from 'ws';
//
// WHY the remote channel cannot list apps (VERIFIED live 2026-10-21):
// On samsung.remote.control, ms.channel.connect returned clients=[self], isHost:false -> NO host.
// These getters have no recipient and NEVER reply (do not build on them):
//   {method:'ms.channel.emit',params:{event:'ed.installedApp.get',to:'host',data:''}}
//   {method:'ms.channel.emit',params:{event:'ed.installedApp.get',to:'host'}}
//   {method:'ms.channel.emit',params:{event:'ed.edenApp.get',to:'host',data:''}}
//   {method:'ms.channel.emit',params:{event:'ed.apps.icon',to:'host',data:'{...}'}}
//
// PRIMARY (verified local): on-TV Lumen Agent, UI/foreground context ----------------------
//   const apps = tizen.application.getAppsInfo();      // ~406 entries {id,name,iconPath,show}
//   const running = tizen.application.getAppsContext(); // running app IDs
//   // agent dials out to the PC and returns `apps`; for each tile the agent reads iconPath
//   // bytes off disk and serves them (no TV icon HTTP endpoint exists).
//
// CANDIDATE (SUPERVISED launch test): MobileBFF, local, no agent --------------------------
const NAME_B64 = Buffer.from('Lumen Remote').toString('base64'); // THVtZW4gUmVtb3Rl
const url = `wss://192.168.1.2:8002/api/v2/channels/com.samsung.tv.mobilebff?name=${NAME_B64}&token=${TOKEN}`;
const ws = new WebSocket(url, { rejectUnauthorized: false, perMessageDeflate: false });
ws.on('message', (b) => {
  const m = JSON.parse(b.toString());
  if (m.event === 'ms.channel.connect') {
    const inner = { version: '0.2', id: 'get.apptiles', seqId: '1', params: {} }; // try also get.extsources
    ws.send(JSON.stringify({ method: 'ms.channel.emit',
      params: { event: '/sec/tv/appdata/mobilebff', to: 'host', data: JSON.stringify(inner) } }));
  } else { /* inner reply: JSON.parse(m.data) -> {id, params:{tiles:[{id,name,icon...}]}} (shape UNVERIFIED) */ }
});
// NOTE: event path '/sec/tv/appdata/mobilebff' is INFERRED (not a binary literal); the mobilebff
// service binary is not in the extracted image. Connecting may raise an on-screen Allow prompt
// and the ifw-thing ADC exposes GetCloudConnection, so a SmartThings/cloud link may be required.
//
// Per-app status without a list: GET http://192.168.1.2:8001/api/v2/applications/<id>/  (slash required)
```

## Open questions

- Does any component ever register as host on samsung.remote.control transiently (e.g. only while the Smart Hub/home screen is foreground, or just after launching a specific app)? Our probe ran with the TV idle and saw no host; a quick supervised recheck with the home screen in front would settle whether a short-lived host exists.
- Is the MobileBFF event path really /sec/tv/appdata/<appName> and is the registered app name 'mobilebff'? The event path is inferred; the mobilebff service binary was not in the extracted emulator image, so the exact event string and command ids (get.apptiles vs get.installedApp) are unconfirmed.
- Does MobileBFF/the ifw-thing app-data-channel require an active SmartThings/cloud connection (GetCloudConnection) to answer, or does it serve purely locally over the paired socket?
- Does opening the com.samsung.tv.mobilebff channel with the EXISTING remote token reuse the pairing silently, or does it trigger a fresh on-screen Allow (ACL is per client MAC)? This decides whether MobileBFF is usable without bothering the user.
- If MobileBFF answers, does get.apptiles enumerate ALL installed apps or only pinned home-screen tiles, and does it deliver icons as on-TV file paths or inline base64?
- SmartThings: exact capability/field that returns the installed-app list on a 2020 VD-STV_2018_K device, and whether custom.launchapp lists apps or only launches them.
