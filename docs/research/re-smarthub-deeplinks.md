# Smart Hub (CoBA) deep-link recipes, decompiled 2026-10-22

Source: Tizen.TV.Service.CoBA.Core.dll / .Common.dll from the Tizen 5.5 emulator image (x86 build; the real TV runs a 2026 firmware, so verify live). Workflow wf_f57986bd-9ad.

## decompile

I recovered the Smart Hub (CoBA 1.1.1) tile-launch code without contacting the TV. There is no `AppLauncher.Impl`. All of the Launch*Preview methods are static methods on `Tizen.TV.Service.CoBA.Core.Util.AppLauncher` in Tizen.TV.Service.CoBA.Core.dll (SHA-256 48c88c93…cfb2, assembly 5.5.0.0, MVID b055edd2-d9fe-45a0-aeae-69f57e7b2026). The embedded source path is .../CoBACommon/AppLauncher.cs. The tile dispatcher is `Tizen.TV.Service.CoBA.Core.WebAppTileLauncher`.

Method (all decompiled; no C# decompiler was used):
- REA `inspect_managed_members` decoded the IL anchors: opcodes plus call, field, string and branch operands. Evidence: Core ev_89cc094ef955659cc08706c658fb5abaf232a6c557fb30c2d8511a4e94d1d3a5, Core artifact ev_eb4bcdaad979110b338fdf336a04ab6e5f66f0b75c253000dc3f01f354b31754, Common ev_99a0fcd8…742c and ev_016b1f6b…8844.
- Three small read-only scripts filled in names. They map ldstr tokens to the #US string heap, TypeRef rows to type names, and hex-read single bytes at known IL offsets to recover the ldarg/ldloc/ldc.i4.0 operands. The scripts are in C:/Users/pranj/AppData/Local/Temp/tvremote-re/deeplink2/decompile/scripts (usheap.py, typerefs.py, anchors.py, ilhex.py). The data is in the same folder: core-members.json, core-us.json, core-typerefs.json, rea-bundle-core.json.

How a tile is chosen and launched (decompiled):
1. `CompWebAppTile..ctor` (0x060003c2) gets the tile JSON from `PreviewManager.Data(instanceId)` and parses it with Newtonsoft (`LaunchData`, 0x060003cc).
2. The parsed object is `WebAppTileLaunchData`. It has exactly six fields: stored_id, action_play_url, action_type, extra_app_id, tile_id and section_title. There is no is_playable or play/details field.
3. `CompWebAppTile.OnSelected` (0x060003c5) creates `new WebAppTileLauncher(launchData).Launch()`.
4. `Launch()` (0x06000409) first calls `GetForceLaunch()`. That parses action_play_url as JSON and returns true when `force_launch == "1"`. If it is not true, `Disclaimer.Launch(0, null, null, null)` may stop the launch.
5. `Launch()` then switches on action_type:
   - NETFLIX_LAUNCH → `LaunchNetflix`
   - AMAZON_LAUNCH → `LaunchAmazon`
   - WAS_LAUNCH and APP_LAUNCH → `LaunchApps`
   - EXTRA_APP_LAUNCH → `LaunchExtraApps`
   - EXTRA_APP_CONTENTID → `LaunchContent`
   - APP_CONTROL → `LaunchAppViaAppControl`

None of the CoBA AppControls set an Operation or a LaunchMode. The "Remove" and "Clear all" menu items reuse the same payload and add `Command` = "Remove" or "ClearAll" (`RemoveMenuItem`/`ClearAllMenuItem.OnConfirmButtonSelected` → `AppLauncher.LaunchCommand`).

For Friends (70153404): the Netflix app id `org.tizen.netflix-app` and the full list of launch keys are decompiled. The value Netflix puts in action_play_url is not in these DLLs. I used the community DIAL form `m=https://www.netflix.com/watch/70153404&source_type=4`, untested. The CoBA code has no separate "details" path; any play-versus-details difference lives only in the provider's action_play_url. Nothing has been tested on the TV yet.

### Netflix

There are two branches. Both are decompiled from Tizen.TV.Service.CoBA.Core.dll.

Branch choice, `WebAppTileLauncher.LaunchNetflix()` (0x0600040b): it calls `WebAppCommon.GetInstance().LockStatus(stored_id)` (IL_0011). LockStatus is `WebAppCommonST.LockStatus` (0x06000622), which reads `FSWebApp.IsLocked(storeId)`. In Common, that is `AppDB.GetDownloadableApp(storeId).IsLocked`, the Smart Hub per-app lock. So:
- App locked → the preview/WAS branch.
- App not locked (the normal case) → the legacy direct branch.

A) Normal branch (app not locked), LaunchNetflix IL_003e..IL_00c8:
- Builds a `Dictionary<string,string>` in this order:
  - `"--root"="app"`
  - `"--app-js"="netflix"`
  - `"callerid"="com.samsung.tv.csfs"` (a hard-coded literal)
  - `"action_play_url"=<tile action_play_url, verbatim>`
  - `"__K_SPLASH_SCREEN"="LA_UI_DEFAULT"`
  - `"__LEGACY_LAUNCH__"="true"`
  - `"__K_RELOCATE_BELOW"=DB.PACKAGE_NAME`
- Then calls `AppLauncher.LaunchApp("org.tizen.netflix-app", dict, false)`. The `false` is from a hex read: 0xc6 ldloc.1, 0xc7 ldc.i4.0.
- `LaunchApp(string, Dictionary, bool, AppControlReplyCallback)` (0x060005b0) does the following:
  - Checks network, disclaimer and store-DRM conditions through `Message.Show`.
  - Creates `new Tizen.Applications.AppControl()` and sets `ApplicationId = appId`.
  - Adds every dictionary pair with `ExtraData.Add(key, value)`.
  - `AddEntryInformation` (0x060005bf) adds `"Entry" = ComponentObserver.LastFocusedComponent().Parent.Parent.ID` when it is not empty.
  - Calls `AppControl.SendLaunchRequest(ac, replyCallback)`.
  - It never calls set_Operation or set_LaunchMode. Inferred: the native app_control default operation `http://tizen.org/appcontrol/operation/default` and LaunchMode Single apply.
- `DB.PACKAGE_NAME` is the `CoBAInitData.packageName` passed to `DB.Initialize` (Common 0x06000073, called from `CoBA.Initialize` 0x06000009), so it is only known at runtime. Inferred: it equals "com.samsung.tv.csfs", because that literal is used next to it.

B) Locked branch: `AppLauncher.LaunchNetflixPreview(stored_id, action_play_url)` (0x060005b9):
- `payload = "action_play_url&" + actionUrl`. This is a plain prefix, not JSON. Hex: 0x41 ldstr, 0x46 ldarg.1, 0x47 String.Concat.
- Then `LaunchPreview(storedId, payload)` (0x060005bb):
  - `appId = new AppDB().GetAppId(storedId)`
  - `ac = new AppControl{ApplicationId = appId}`
  - ExtraData: `"CallerId"=DB.PACKAGE_NAME`, `"PayLoad"=payload`, `"Operation"="DeepLink"`, plus `Entry`.
  - Sent with `new Tizen.TV.DownloadableApplications.AppLaunch().SendLaunchRequest(ac)`.
- If that throws DownLoadableAppException, it falls back to `LaunchPreviewViaAppControl(storedId, payload, null)` (0x060005bc). That uses the same keys plus `"KeyDeviceType"=BPIFactory.GetInstance().RemoteType().ToString()`. It adds `"Command"` only when non-empty. It is sent with `AppControl.SendLaunchRequest(ac)`, and appId falls back to storedId if AppDB throws.

The receiving web app sees the key PAYLOAD. Inferred: the litewas binary prints PAYLOAD/CALLER_ID and its launch parameters `payLoad=`/`callerId=`/`entry=` (tvremote-re/deep-links/out/litewas.txt).

Example for Friends, title 70153404, as an unlocked Netflix tile:
- appId: `org.tizen.netflix-app`
- operation: default
- extras: `--root=app`, `--app-js=netflix`, `callerid=com.samsung.tv.csfs`, `action_play_url=<Netflix value>`, `__K_SPLASH_SCREEN=LA_UI_DEFAULT`, `__LEGACY_LAUNCH__=true`, `__K_RELOCATE_BELOW=com.samsung.tv.csfs`

Play versus details: the CoBA code does not distinguish them. It forwards action_play_url unchanged, and the tile object has no play flag. The Netflix value is provider-supplied and does not appear in these DLLs. Candidates:
- Play (community: Netflix DIAL form from smartest-tv dial.py): `m=https://www.netflix.com/watch/70153404&source_type=4`
- Details (inferred): `m=https://www.netflix.com/title/70153404&source_type=4`
- For the locked-branch variant, also send `PayLoad`/`PAYLOAD` = `action_play_url&m=https://www.netflix.com/watch/70153404&source_type=4`, `CallerId=com.samsung.tv.csfs`, `Operation=DeepLink`.

The Netflix store id 11101200001 / 3201907018807 is community knowledge and is not in this DLL. remote-server also maps Netflix to org.tizen.netflix-app (string observed).

### YouTube

All decompiled unless marked otherwise.

- `WebAppTileLauncher.LaunchApps()` (0x0600040d) handles WAS_LAUNCH and APP_LAUNCH. If `stored_id == "111299001912"` it calls `AppLauncher.LaunchYoutubePreview(stored_id, action_play_url)`. Otherwise it calls LaunchCommonPreview.

`LaunchYoutubePreview` (0x060005b7) builds the payload in four steps (hex-confirmed):
1. `prefix`: `FSConfigAdapter.GetInstance().GetConfigStr((StrKey)1, out prefix)`.
   - StrKey 1 is inferred to be `YoutubeUrl` from declaration order (CommonKeyStart comes first).
   - Common contains the vconf key string `rtc/memory/FSWebApp/9Ur5IzDKqV.TizenYouTube_URL`; remote-server contains `rtc/memory/WebApp/9Ur5IzDKqV.TizenYouTube_URL`. Inferred: this is the source.
2. `constant`: `ApplicationManager.GetInstalledApplication("9Ur5IzDKqV")?.Metadata["http://samsung.com/tv/metadata/launch_social_v.link"]`, or null.
3. `id`: `action_play_url.Split(new[]{"v="}, RemoveEmptyEntries)`. If there are at least 2 parts, use `parts[1]`; otherwise use the whole action_play_url.
4. `payload = prefix + constant + id`. It is not wrapped in {"values":…}.

Then it calls `LaunchPreview(storedId, payload)`, the same AppLaunch/AppControl path as above:
- `ApplicationId = AppDB.GetAppId("111299001912")`. Inferred: this is `9Ur5IzDKqV.TizenYouTube`; the package id 9Ur5IzDKqV is observed.
- ExtraData: `CallerId=PACKAGE_NAME`, `PayLoad=payload`, `Operation=DeepLink`, `Entry`.
- The fallback adds `KeyDeviceType` (and `Command` if set).
- Operation is the default.

Equivalent recipe: appId `9Ur5IzDKqV.TizenYouTube`, default operation, `PAYLOAD`/`PayLoad` = `<launch_social_v.link metadata> + <11-char videoId>`, `CallerId=com.samsung.tv.csfs`, `Operation=DeepLink`.
- The prefix lives in vconf and a web app cannot read it.
- The metadata can be read with `tizen.application.getAppMetaData`.
- Fallback payload `v=<videoId>` (community: YouTube DIAL body). Unverified for this AppControl path.

### Prime Video

Decompiled from `WebAppTileLauncher.LaunchAmazon()` (0x0600040c). It handles action_type AMAZON_LAUNCH and uses the same lock check as Netflix.

Locked branch: `AppLauncher.LaunchAmazonePreview(stored_id, url)` (0x060005b8) calls `LaunchPreview(storedId, url)` with no rewriting (hex 0x41 ldarg.0, 0x42 ldarg.1). So PayLoad equals the raw action_play_url. The other keys are `CallerId=PACKAGE_NAME`, `Operation=DeepLink` and `Entry`, sent through AppLaunch with the AppControl fallback.

Normal branch (app not locked):
- Dictionary:
  - `"--root"="app"`
  - `"--app-js"="amazon"`
  - `"callerid"=DB.PACKAGE_NAME` (Netflix uses a literal here; Prime does not)
  - `"action_play_url"=<url>`
  - `"__K_SPLASH_SCREEN"="LA_UI_DEFAULT"`
  - `"__K_RELOCATE_BELOW"=DB.PACKAGE_NAME`
  - There is no `__LEGACY_LAUNCH__`.
- appId comes from `WebAppCommon.GetInstance().GetApplicationId(stored_id, out id)`. That is `WebAppCommonST.GetApplicationId`, which resolves `GetInstalledApplicationByStoreId` and caches the result. If it is empty, `new AppDB().GetAppId(stored_id)` is used.
- Then `LaunchApp(appId, dict, false)` (hex 0xf4 ldloc.2, ldloc.1, ldc.i4.0). Operation is the default and `Entry` is added.

Equivalent recipe: appId `org.tizen.ignition` (community: Prime's Tizen id, store id 3201512006785; neither appears in this DLL), default operation, extras `--root=app`, `--app-js=amazon`, `callerid=com.samsung.tv.csfs`, `action_play_url=<Amazon value>`, `__K_SPLASH_SCREEN=LA_UI_DEFAULT`, `__K_RELOCATE_BELOW=com.samsung.tv.csfs`.

The Amazon action_play_url format is provider-supplied and unknown (not in these DLLs). `GetForceLaunch` shows that action_play_url values are sometimes JSON objects, for example with force_launch.

### Generic recipe

Recipes for the other action types, all decompiled except where marked:

LaunchCommonPreview(storedId, actionUrl) (0x060005b6). Used by WAS_LAUNCH/APP_LAUNCH for apps other than YouTube, and by EXTRA_APP_LAUNCH with extra_app_id:
- `payload = "{\"values\":\"" + actionUrl.Replace("\"", "\\\"") + "\"}"`. An empty actionUrl gives `{"values":""}`.
- Then `LaunchPreview(storedId, payload)`.

LaunchPreview (0x060005bb):
- `ApplicationId = AppDB.GetAppId(storedId)`
- ExtraData `{CallerId: DB.PACKAGE_NAME, PayLoad: payload, Operation: "DeepLink", Entry: <focused row id>}`
- Sent with `Tizen.TV.DownloadableApplications.AppLaunch.SendLaunchRequest`.
- On DownLoadableAppException it calls `LaunchPreviewViaAppControl(storedId, payload, null)` (0x060005bc). That sends a direct `AppControl.SendLaunchRequest` with the same keys plus `KeyDeviceType` (and `Command` when non-empty). The appId falls back to storedId.
- No Operation or LaunchMode is set anywhere.

LaunchCommand(storedId, actionUrl, command) (0x060005b5) builds the same {"values"} payload and goes straight to LaunchPreviewViaAppControl with `Command` set to "Remove" or "ClearAll".

LaunchContentPreview(storedId, contentId) (0x060005ba). Used by EXTRA_APP_CONTENTID:
- The default payload is `"{ \"values\":" + contentId + "}"`, with no added quotes.
- If the target app has the metadata `http://samsung.com/tv/metadata/launch_social_v.link`, the code replaces `%% CONTENT_ID %%` in it with contentId. When the result contains contentId, that template becomes the payload.
- Then LaunchPreview.

APP_CONTROL action type: `LaunchAppViaAppControl` (0x06000410):
- appId = `AppDB.GetAppId(stored_id)`; it returns false if that is empty.
- Then `LaunchApp(appId, {callerid: PACKAGE_NAME, action_play_url: url, __NO_LOADING_LAUNCH: "enable"}, false)`.

Official Samsung Smart Hub Preview contract (official-doc, developer.samsung.com/smarttv/develop/guides/smart-hub-preview/implementing-public-preview.html):
- The clicked tile's action_data reaches the app as ApplicationControlData key `PAYLOAD`, with value[0] = `{"values": "<action_data>"}`.
- The app reads it through `getRequestedAppControl()`.
- The app declares the app-control operation `http://samsung.com/appcontrol/operation/eden_resume`.

This matches CoBA's {"values"} payload. CoBA's own key is spelled `PayLoad`. Inferred: WAS/AppLaunch maps it to PAYLOAD, since the litewas strings PAYLOAD and CALLER_ID are observed.

Generic replica: explicit appId, operation default (or eden_resume), extras `PAYLOAD` = `{"values":"<escaped action_data>"}` (I also send `PayLoad`), `CallerId=com.samsung.tv.csfs`, `Operation=DeepLink`.

### Code

```js
'use strict';
// Smart Hub (CoBA 1.1.1) tile-launch replica for a Tizen web app (ES2017).
// Privileges: http://tizen.org/privilege/application.launch (+ application.info for getAppMetaData).
const OP_DEFAULT = 'http://tizen.org/appcontrol/operation/default';          // CoBA sets no Operation -> native default (inferred)
const OP_EDEN_RESUME = 'http://samsung.com/appcontrol/operation/eden_resume'; // official Smart Hub Preview contract
const COBA_CALLER = 'com.samsung.tv.csfs';      // literal in LaunchNetflix; DB.PACKAGE_NAME is runtime (inferred equal)
const NETFLIX_ID = 'org.tizen.netflix-app';     // decompiled (LaunchNetflix IL_00c1)
const YOUTUBE_ID = '9Ur5IzDKqV.TizenYouTube';   // package 9Ur5IzDKqV decompiled; full app id community
const PRIME_ID = 'org.tizen.ignition';          // community; CoBA resolves it from store id at runtime
const SOCIAL_LINK_MD = 'http://samsung.com/tv/metadata/launch_social_v.link';

function toData(extras) {
  return Object.keys(extras)
    .filter((k) => extras[k] !== undefined && extras[k] !== null)
    .map((k) => new tizen.ApplicationControlData(k, [String(extras[k])]));
}

function launch(appId, operation, extras) {
  return new Promise((resolve, reject) => {
    const ac = new tizen.ApplicationControl(operation, null, null, null, toData(extras), 'SINGLE');
    tizen.application.launchAppControl(ac, appId,
      () => resolve({ appId, operation, keys: Object.keys(extras) }),
      (e) => reject(new Error(`${appId} ${operation}: ${e.name} ${e.message}`)));
  });
}

async function firstThatLaunches(attempts) {
  const errors = [];
  for (const a of attempts) {
    try { return await launch(a.appId, a.op, a.extras); } catch (e) { errors.push(e.message); }
  }
  throw new Error('all variants failed: ' + errors.join(' | '));
}

// AppLauncher.LaunchCommonPreview / LaunchCommand payload
const valuesPayload = (s) => '{"values":"' + String(s || '').replace(/"/g, '\\"') + '"}';

// LaunchPreview / LaunchPreviewViaAppControl keys (PAYLOAD added for the official contract)
const previewExtras = (payload, command) => Object.assign(
  { CallerId: COBA_CALLER, PayLoad: payload, PAYLOAD: payload, Operation: 'DeepLink' },
  command ? { Command: command } : {});

// WebAppTileLauncher.LaunchNetflix (not-locked branch), same insertion order as CoBA
const netflixLegacyExtras = (actionPlayUrl) => ({
  '--root': 'app', '--app-js': 'netflix', callerid: COBA_CALLER, action_play_url: actionPlayUrl,
  __K_SPLASH_SCREEN: 'LA_UI_DEFAULT', __LEGACY_LAUNCH__: 'true', __K_RELOCATE_BELOW: COBA_CALLER,
});

async function openNetflixTitle(titleId, { details = false, actionPlayUrl } = {}) {
  if (!/^\d+$/.test(String(titleId))) throw new Error('numeric Netflix title id required');
  // Provider value is not in the firmware; community DIAL form used as default (unverified on this path).
  const url = actionPlayUrl || `m=https://www.netflix.com/${details ? 'title' : 'watch'}/${titleId}&source_type=4`;
  return firstThatLaunches([
    { appId: NETFLIX_ID, op: OP_DEFAULT, extras: netflixLegacyExtras(url) },                  // unlocked tile
    { appId: NETFLIX_ID, op: OP_DEFAULT, extras: previewExtras('action_play_url&' + url) },   // locked/WAS tile
  ]);
}

function youtubeSocialConstant() {
  try {
    const md = tizen.application.getAppMetaData(YOUTUBE_ID) || [];
    const hit = md.find((m) => m.key === SOCIAL_LINK_MD);
    return hit ? hit.value : '';
  } catch (e) { return ''; }
}

async function openYouTubeVideo(videoId) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error('11-char YouTube video id required');
  const constant = youtubeSocialConstant(); // CoBA: vconf YoutubeUrl prefix (unreadable here) + constant + id
  const attempts = [];
  if (constant) attempts.push({ appId: YOUTUBE_ID, op: OP_DEFAULT, extras: previewExtras(constant + videoId) });
  attempts.push({ appId: YOUTUBE_ID, op: OP_DEFAULT, extras: previewExtras('v=' + videoId) }); // DIAL-style fallback
  return firstThatLaunches(attempts);
}

async function openPrime(actionPlayUrl) {
  if (!actionPlayUrl) throw new Error('Prime needs a provider action_play_url (format unknown)');
  return firstThatLaunches([
    { appId: PRIME_ID, op: OP_DEFAULT, extras: {
      '--root': 'app', '--app-js': 'amazon', callerid: COBA_CALLER, action_play_url: actionPlayUrl,
      __K_SPLASH_SCREEN: 'LA_UI_DEFAULT', __K_RELOCATE_BELOW: COBA_CALLER } },              // unlocked tile
    { appId: PRIME_ID, op: OP_DEFAULT, extras: previewExtras(actionPlayUrl) },             // locked tile
  ]);
}

// Generic Smart Hub Preview tile (WAS_LAUNCH / EXTRA_APP_LAUNCH)
async function openPreviewTile(appId, actionData, { command } = {}) {
  const payload = valuesPayload(actionData);
  return firstThatLaunches([
    { appId, op: OP_DEFAULT, extras: previewExtras(payload, command) },
    { appId, op: OP_EDEN_RESUME, extras: { PAYLOAD: payload } },
  ]);
}

// "play friends on netflix" -> openNetflixTitle('70153404'); details -> openNetflixTitle('70153404', { details: true })
```

### Caveats

- Not tested on the TV. Evidence comes from the extracted image's CoBA 1.1.1 (assembly 5.5.0.0, files dated Dec 2019), which may differ from the Q95T's current firmware. Per the earlier lesson, check one launch live before treating any of this as a rule.
- The Netflix and Prime action_play_url values are supplied by the providers through Smart Hub preview data. They are not in these DLLs. The Netflix value `m=https://www.netflix.com/watch|title/70153404&source_type=4` is the community DIAL convention and is unverified for this AppControl path.
- CoBA has no separate play or details path: WebAppTileLaunchData has no is_playable field, and action_play_url is forwarded unchanged (decompiled). The `title` versus `watch` details variant is an inference.
- AppControl Operation and LaunchMode are never set in CoBA (no call anchors). That the default operation `http://tizen.org/appcontrol/operation/default` applies is inferred from Tizen's app_control behaviour. The official preview doc names `eden_resume` as the operation apps declare.
- CoBA's extra key is spelled `PayLoad`. That apps receive it as `PAYLOAD` is inferred from the official doc and litewas strings, because `Tizen.TV.DownloadableApplications.AppLaunch` is not in the extracted image. The code therefore sends both, which is a design choice.
- These are inferred, not decompiled: DB.PACKAGE_NAME and CallerId at runtime, StrKey 1 being YoutubeUrl (from field order; constant values were not read), the YouTube vconf prefix, `9Ur5IzDKqV.TizenYouTube`, `org.tizen.ignition`, and the store ids 11101200001/3201907018807/3201512006785.
- `launchAppControl` success only means the target app accepted the launch, not that it opened the title. The fallback chain only moves on to the next variant on a launch error. Netflix or Prime may check the real AUL caller (`__AUL_CALLER_APPID__`), which cannot be faked, and may ignore `callerid`, `--root` or `--app-js` from a third-party app. AUL may also strip keys that start with `__`.
- Not recovered: the KeyDeviceType value (the RemoteType enum lives in the BPI assembly, which is absent), the runtime value of `Entry`, and whether LaunchApp's bool parameter is used beyond the call sites (it is always false at those sites). REA anchors leave out plain ldarg/ldloc instructions; argument order was recovered from hex at the IL offsets cited.
- `Disclaimer.Launch` and `Message.Show` network/DRM gating only affect the Smart Hub UI; `force_launch="1"` in JSON action_play_url bypasses the disclaimer. Nothing contacted 192.168.1.2 or any other LAN device, nothing was installed, and the source images were opened read-only.

## docs

"Play Friends on Netflix" is technically possible from a Tizen web app that only has the public application.launch privilege. None of these launches has been sent to the Q95T yet, so title navigation is unverified.

1. **What Samsung documents.** The official Smart Hub Preview guide covers the receiving side only:
   - The target app declares the operation `http://samsung.com/appcontrol/operation/eden_resume` with `reload='disable'`.
   - It reads extra-data key `PAYLOAD`, whose value is `["{\"values\": \"<action_data>\"}"]`.
   - It reads it through `tizen.application.getCurrentApplication().getRequestedAppControl()`, and through the `appcontrol` window event if already running.
   - Samsung documents nothing for launching another vendor's title.

2. **What the TV actually does (decompiled).** On this TV the Smart Hub launcher (CoBA, running as `com.samsung.tv.csfs`) switches on the tile's `action_type` in `Tizen.TV.Service.CoBA.Core.dll`, `WebAppTileLauncher.Launch`.
   - **NETFLIX_LAUNCH:** sends a plain Tizen AppControl to `org.tizen.netflix-app`. It sets no operation and passes these extra-data keys:
     - `--root=app`, `--app-js=netflix`
     - `callerid=com.samsung.tv.csfs`
     - `action_play_url=<tile string>`
     - `__K_SPLASH_SCREEN=LA_UI_DEFAULT`, `__LEGACY_LAUNCH__=true`
   - **Tile string for Friends** (from a 2018 Smart Hub capture): `m=70153404&trackId=15539201&showMovieInfoOnly=true&source_type_payload=groupIndex%3D1%26tileIndex%3D0%26action%3Dmdp%26movieId%3D70153404%26trackId%3D15539201`. This opens the details page.
   - **Locked apps:** these go through `LaunchNetflixPreview`, then `LaunchPreview`. That builds an AppControl with `CallerId`, `PayLoad='action_play_url&'+url` and `Operation=DeepLink`. The web-app launcher (litewebappservice) then turns it into operation `eden_resume` plus extra `PAYLOAD`. If the app is already running, it uses operation `deep_link` with the URI set to the payload.
   - **YouTube** (`9Ur5IzDKqV.TizenYouTube`): the payload is a CoBA config prefix + the app's metadata `http://samsung.com/tv/metadata/launch_social_v.link` + the video ID.
   - **Prime** (`org.tizen.primevideo`): same as Netflix, with `--app-js=amazon` and no `__LEGACY_LAUNCH__`.

3. **What our app can do.** A public-certificate app can rebuild all of these with `tizen.application.launchAppControl`; the ES2017 code is in the `code` field.

4. **How to test.**
   - First, send Netflix variant A with the exact tile string (`details:true`). It is a byte-for-byte copy of what Smart Hub sends, so it should prove the transport.
   - Then try the play variants: tile string without `showMovieInfoOnly`, the `watch/<id>&source_type=4` form, and ConnectSDK's api.netflix.com form.
   - From the PC, DIAL `POST :8080/ws/app/Netflix` with header `Origin: https://www.netflix.com` is the alternative. YouTube's DIAL equivalent returned 201 live.

Scratch files are under `C:/Users/pranj/AppData/Local/Temp/tvremote-re/deeplink2/docs/`. That includes `code/deeplink.js`, which was syntax-checked and run against a mock `tizen` object; the Friends tile string came out byte-identical.

### Netflix

APP ID
- Tizen app ID is `org.tizen.netflix-app`. Evidence: live, `getAppsInfo` on this Q95T, `C:/Users/pranj/source/lumen-remote/data/probe/ui-probe.json`, at=2026-10-21T11:17Z, v80.25.23140.
- REST/store ID is `3201907018807`. The 2018 Smart Hub used `RN1MCdNq8t.Netflix` (`yandex_eden-apps.json`).
- REST returns 404 for the alias `org.tizen.netflix-app` (`area-power-apps-inputs.md`), but `launchAppControl` needs exactly this Tizen ID.

ROUTE A — what Smart Hub does for NETFLIX_LAUNCH tiles (decompiled)
Source: `Tizen.TV.Service.CoBA.Core.dll` (csapi-tv-service-coba-1.1.1), `WebAppTileLauncher.LaunchNetflix` (token 0x0600040b, IL at file offset 161548, decoded with `deeplink2/docs/scripts/ildump.py`). Taken when `WebAppCommon.LockStatus(stored_id)` is false.
- It builds a `Dictionary<string,string>`, then `AppLauncher.LaunchApp("org.tizen.netflix-app", dict, false)`. That does `new Tizen.Applications.AppControl{ApplicationId}`, copies the dictionary into ExtraData, adds `Entry` (`AddEntryInformation`), then `SendLaunchRequest`.
- **Operation:** none set. Inferred: the platform defaults to `http://tizen.org/appcontrol/operation/default`.
- **Extra data, exact:**
  - `--root=app`
  - `--app-js=netflix`
  - `callerid=com.samsung.tv.csfs`
  - `action_play_url=<tile action_play_url>`
  - `__K_SPLASH_SCREEN=LA_UI_DEFAULT`
  - `__LEGACY_LAUNCH__=true`
  - `__K_RELOCATE_BELOW=<CoBA PACKAGE_NAME static>`

ROUTE B — locked app (decompiled)
- `LockStatus` true leads to `AppLauncher.LaunchNetflixPreview(storedId, url)` (file offset 235080). Its IL is `ldstr "action_play_url&"; ldarg.1; String.Concat`, so payload = `"action_play_url&" + url`.
- `LaunchPreview` (offset 235444) then builds an AppControl:
  - ApplicationId = `AppDB.GetAppId("3201907018807")`
  - ExtraData: `CallerId=<pkg>`, `PayLoad=<payload>`, `Operation=DeepLink`
  - sent via `Tizen.TV.DownloadableApplications.AppLaunch.SendLaunchRequest`.
- These keys match `was_launcher_api.cpp` strings: PayLoad / CallerId / Operation / DeepLink / ForceLaunch / BackGround (`deep-links/out/waslauncher.txt` lines 651-656).
- litewebappservice `ICAul::AulLaunchApps` then does the following (`deep-links/out/litewas.ann`):
  - @0x2d427: `app_control_set_operation("http://samsung.com/appcontrol/operation/eden_resume")`
  - @0x2d4b9: `add_extra_data("PAYLOAD", payload)`
  - If the target is already running, @0x2d60e-0x2d646: `set_uri(payload)`, operation `http://samsung.com/appcontrol/operation/deep_link`, plus PAYLOAD.
- litewas does not add a `{"values":…}` wrapper. `m_AssemblePayload` only appends `&emanualurl=` and `&tts=`.

ROUTE C — DIAL/REST from the LAN (decompiled, `re-deep-links.md`)
- The body is passed unchanged as PAYLOAD.
- Netflix's reference DIAL server starts NRDP with `-Q "<defaultLaunchParam>&dial=<urlencoded body>"`, with source_type=12 (community: `dl/netflix_nf_callbacks.c` `netflix_start`).

VALUE FORMAT (Friends = 70153404)
- **Details page.** Community evidence, captured Smart Hub `ed.edenApp.get` data, `dl/yandex_eden-apps.json` line 957 (display_until 1539332867 = 2018-10-12), action_type NETFLIX_LAUNCH, isPlayable 0:
  `m=70153404&trackId=15539201&showMovieInfoOnly=true&source_type_payload=groupIndex%3D1%26tileIndex%3D0%26action%3Dmdp%26movieId%3D70153404%26trackId%3D15539201`
  - `showMovieInfoOnly=true` plus `action=mdp` (movie details page) makes it a details tile. `source_type_payload` is the URL-encoded group/tile position.
- **Play/resume.** No capture exists. Candidates in order:
  1. `m=70153404&trackId=15539201` (inferred: the tile string without the details flag)
  2. `m=https://www.netflix.com/watch/70153404&source_type=4` (community: smartest-tv `dial.py` `netflix_body` / CHANGELOG line 246)
  3. `m=http%3A%2F%2Fapi.netflix.com%2Fcatalog%2Ftitles%2Fmovies%2F70153404&source_type=4` (community: ConnectSDK `WebOSTVService.launchNetflix` line 587)
- **Play vs details in tiles.** The official JSON has no play/details field. `is_playable` only draws a Play icon (`implementing-public-preview.html`, Table 1). The difference lives inside `action_data`, which for Netflix is `showMovieInfoOnly`/`action=mdp`.

TIZEN WEB-APP RECIPE
- Variant A (Route A copy): `launchAppControl(new ApplicationControl("http://tizen.org/appcontrol/operation/default", null, null, null, [the extra data above, without __K_RELOCATE_BELOW]), "org.tizen.netflix-app")`
- Variant B: same operation, data `CallerId` / `PayLoad="action_play_url&"+url` / `Operation=DeepLink`.
- Variant C: operation eden_resume, data `PAYLOAD=url`.

### YouTube

APP ID
- `9Ur5IzDKqV.TizenYouTube`, store/REST `111299001912`, v2.1.498 (live: `ui-probe.json`).
- The same probe also lists a Cobalt runtime, `com.samsung.tv.cobalt-yt` v21.7.306, plus YouTube TV/Kids Cobalt IDs.

SMART HUB PATH (decompiled, `Tizen.TV.Service.CoBA.Core.dll`)
- `WebAppTileLauncher.Launch` sends action_type WAS_LAUNCH or APP_LAUNCH to `LaunchApps`.
- `LaunchApps` checks `stored_id == "111299001912"` and calls `AppLauncher.LaunchYoutubePreview(storedId, actionUrl)` (token 0x060005b7, offset 234684). That method:
  - prefix = `FSConfigAdapter.GetConfigStr(1)` (value unknown)
  - constant = `ApplicationManager.GetInstalledApplication(...)` → `Metadata["http://samsung.com/tv/metadata/launch_social_v.link"]`
  - id = the text after `"v="` if actionUrl contains it, otherwise the whole actionUrl
  - payload = prefix + constant + id
- `LaunchPreview` then sends an AppControl with `CallerId`, `PayLoad=<payload>`, `Operation=DeepLink` through the web-app launcher. The launcher turns it into operation `http://samsung.com/appcontrol/operation/eden_resume` plus extra `PAYLOAD` (`litewas.ann` @0x2d427/0x2d4b9).
- On exception it falls back to `LaunchPreviewViaAppControl`: a plain AppControl with the same keys plus `KeyDeviceType`.

TILE VALUE (community, `yandex_eden-apps.json` lines 666-904, WAS_LAUNCH)
- `action_play_url = "<videoId>&launch=launcher"`, e.g. `dbovpJhKV5w&launch=launcher`.

DIAL (decompiled + live)
- Body `v=<id>` (optional `&t=<sec>`, community) goes to vconf `rtc/memory/WebApp/9Ur5IzDKqV.TizenYouTube_URL` + the app's `launch_dial.link` metadata + body, via `was_force_launch_webapp` (`re-deep-links.md`).
- Live 2026-10-21: `POST :8080/ws/app/YouTube` with body `v=jNQXAC9IVRw` and header `Origin: https://www.youtube.com` returned 201, and REST then showed visible:true. Without Origin it returned 403.
- ConnectSDK's DIAL body is `pairingCode=<uuid>&v=<id>&t=<sec>` (community: `DIALService.launchYouTube` line 222).

TIZEN WEB-APP RECIPE
1. Read `tizen.application.getAppMetaData("9Ur5IzDKqV.TizenYouTube")` (application.info, public) and take key `http://samsung.com/tv/metadata/launch_social_v.link`.
2. Send `launchAppControl(new ApplicationControl("http://tizen.org/appcontrol/operation/default", null, null, null, [CallerId, PayLoad=<link>+<videoId>, Operation=DeepLink]), "9Ur5IzDKqV.TizenYouTube")`.
3. Fallbacks: operation eden_resume with `PAYLOAD=<link>+<id>`, then eden_resume with `PAYLOAD="v=<id>"`.

Known failure (community, Tizen forum 2022-06-22 'Youtube DeepLink from Tizen App', Wayback copy): `PAYLOAD=JSON {items:[{kind:'youtube#video',id}]}` with operation `.../pick` and appId null did not work, and youtube:// / vnd.youtube:// URIs failed. Treat app-control YouTube as unproven. DIAL is the one verified path.

### Prime Video

APP ID
- `org.tizen.primevideo`, store/REST `3201910019365`, v5.3.21. The probe also lists `org.tizen.primevideo-dummy` and `org.tizen.primevideo_companionapp` (live: `ui-probe.json`).
- DIAL name `AmazonInstantVideo` (GET verified live, `re-deep-links.md`).

SMART HUB PATH (decompiled)
Source: `WebAppTileLauncher.LaunchAmazon` (token 0x0600040c, offset 161776), action_type AMAZON_LAUNCH.
- **Unlocked:** a plain AppControl. ApplicationId = `WebAppCommon.GetApplicationId(stored_id)`, or `AppDB.GetAppId(stored_id)` if that is empty. Extra data:
  - `--root=app`
  - `--app-js=amazon`
  - `callerid=<CoBA PACKAGE_NAME>`
  - `action_play_url=<url>`
  - `__K_SPLASH_SCREEN=LA_UI_DEFAULT`
  - `__K_RELOCATE_BELOW=<PACKAGE_NAME>`
  - There is no `__LEGACY_LAUNCH__`. Operation is not set (inferred default).
- **Locked:** `AppLauncher.LaunchAmazonePreview(storedId, actionUrl)` calls `LaunchPreview` with the raw actionUrl (no prefix). The AppControl carries `CallerId` / `PayLoad` / `Operation=DeepLink`, and the web-app launcher turns that into `eden_resume` + `PAYLOAD`.

VALUE FORMAT: unknown. There is no Prime tile capture and no official documentation. Candidates:
1. Raw GTI `amzn1.dv.gti.<uuid>` (community: LG contentTarget style, `re-deep-links.md`; boringtv README uses the Amazon title ID `amzn1.dv.gti.…`)
2. `https://app.primevideo.com/detail?gti=<GTI>` (inferred from Amazon's web deep links)
3. `gti=<GTI>` (inferred)

The example GTI `amzn1.dv.gti.9ab600aa-6625-b547-cfc0-190e3ad8a27d` (The Boys S1) is unverified. smartest-tv's matrix lists Prime DEEP_LINK as "mixed reports" (`dl/Hybirdss_smartest-tv-docs_reference_deep-link-support.md`).

TIZEN WEB-APP RECIPE
- `launchAppControl(new ApplicationControl("http://tizen.org/appcontrol/operation/default", null, null, null, [the extras above]), "org.tizen.primevideo")`
- Fallbacks: `CallerId` / `PayLoad` / `Operation=DeepLink`, then eden_resume + `PAYLOAD`.

### Generic recipe

OFFICIAL DOCS (receiving side)
Source: https://developer.samsung.com/smarttv/develop/guides/smart-hub-preview/implementing-public-preview.html; local text `deeplink2/docs/public.html.txt` lines 491-494 and 598-635. Personal preview is the same: `implementing-personal-preview.html`, `personal.html.txt` lines 506-510.
- config.xml:
  - `<tizen:metadata key='http://samsung.com/tv/metadata/use.preview' value='endpoint_URL=…'/>` (or `value='bg_service'` for a personal preview)
  - `<tizen:app-control><tizen:src name='index.html' reload='disable'/><tizen:operation name='http://samsung.com/appcontrol/operation/eden_resume'/></tizen:app-control>`
- The tile JSON field `action_data` is a string, e.g. `"{\"videoIdx\": 1}"`. `is_playable` only shows a Play icon.
- On click, `action_data` arrives as ApplicationControlData `{key:'PAYLOAD', value:["{\"values\": \"{\\\"videoIdx\\\": 1}\"}"]}`.
- The app listens with `window.addEventListener('appcontrol', deepLink)`. It reads `tizen.application.getCurrentApplication().getRequestedAppControl().appControl.data`, finds `key=='PAYLOAD'`, and does `actionData = JSON.parse(value[0]).values; JSON.parse(actionData)`.
- The guide names no privilege.
- Support: the FAQ says "since 2016 TV models" (`faq.html.txt` line 487). The overview says 2016-2021 (`overview.html.txt` line 477), which covers the 2020 Q95T.

DECOMPILED SENDER SIDE (CoBA, `Tizen.TV.Service.CoBA.Core.dll`)
`WebAppTileLauncher.Launch` switches on action_type:
- NETFLIX_LAUNCH → `LaunchNetflix`
- AMAZON_LAUNCH → `LaunchAmazon`
- WAS_LAUNCH / APP_LAUNCH → `LaunchApps` (YouTube, or `LaunchCommonPreview`)
- EXTRA_APP_LAUNCH → `LaunchExtraApps` → `LaunchCommonPreview`
- EXTRA_APP_CONTENTID → `LaunchContent` → `LaunchContentPreview`
- APP_CONTROL → `LaunchAppViaAppControl`. That sends an AppControl to `AppDB.GetAppId(storedId)` with `callerid`, `action_play_url` and `__NO_LOADING_LAUNCH=enable`.

How the payload is built and sent:
- **`LaunchCommonPreview`** (offset 234508): payload = `'{"values":"' + actionUrl.Replace('"','\\"') + '"}'`. This is exactly the documented PAYLOAD JSON.
- **`LaunchPreview(storedId, payload)`** (offset 235444): builds `new AppControl{ApplicationId = AppDB.GetAppId(storedId)}` with ExtraData `CallerId=<PACKAGE_NAME>`, `PayLoad=payload`, `Operation="DeepLink"`, plus `Entry`. It sends via `Tizen.TV.DownloadableApplications.AppLaunch.SendLaunchRequest`.
- **On exception, `LaunchPreviewViaAppControl`** (offset 235760): the same keys plus `KeyDeviceType=<remote type>` and an optional `Command`, sent with a plain `AppControl.SendLaunchRequest`. It logs "AppControl permission denied" or "Launch rejected" on failure.
- **Web-app launcher** (litewebappservice `ICAul::AulLaunchApps`, `litewas.ann`):
  - Operation=DeepLink → `app_control_set_operation(eden_resume)` (@0x2d427) and `add_extra_data("PAYLOAD", payload)` (@0x2d4b9).
  - For `org.tizen.browser` the payload becomes the URI instead.
  - Not a deep link and the app is running → `set_uri(payload)` + operation `http://samsung.com/appcontrol/operation/deep_link` + PAYLOAD (@0x2d60e-0x2d646).
  - Otherwise → `http://tizen.org/appcontrol/operation/default` (@0x2d11a).

THIRD-PARTY EQUIVALENT (public certificate)
```
tizen.application.launchAppControl(
  new tizen.ApplicationControl('http://samsung.com/appcontrol/operation/eden_resume', null, null, null,
    [new tizen.ApplicationControlData('PAYLOAD', [JSON.stringify({values: actionDataString})])]),
  '<target Tizen appId>', ok, err)
```
- This reaches any app that implements the documented receiver. Inferred: an explicit app ID launches even if the target never declared the operation.
- For WAS web apps, also try CoBA's own shape: operation default with `CallerId` / `PayLoad` / `Operation=DeepLink`.
- Discovery helpers:
  - `tizen.application.findAppControl` (lists apps that accept an operation)
  - `getAppMetaData(appId)` (reveals keys like `launch_social_v.link` / `launch_dial.link`)
  - `getAppsInfo` (Tizen IDs)
  - All three are public (application.info for the metadata/info calls).

### Code

```js
'use strict';
// Tizen web app (Tizen 5.5, ES2017). config.xml, public certificate is enough:
//   <tizen:privilege name="http://tizen.org/privilege/application.launch"/>   (launchAppControl)
//   <tizen:privilege name="http://tizen.org/privilege/application.info"/>     (getAppInfo / getAppMetaData only)
const OP = {
  DEFAULT: 'http://tizen.org/appcontrol/operation/default',          // CoBA's plain AppControl (no operation set)
  EDEN_RESUME: 'http://samsung.com/appcontrol/operation/eden_resume', // litewas, deeplink=true
  DEEP_LINK: 'http://samsung.com/appcontrol/operation/deep_link',     // litewas, target already running (URI = payload)
};
const APP = {                                 // Tizen app ids from getAppsInfo on this Q95T (ui-probe.json)
  netflix: 'org.tizen.netflix-app',           // store/REST id 3201907018807
  youtube: '9Ur5IzDKqV.TizenYouTube',         // store/REST id 111299001912
  prime: 'org.tizen.primevideo',              // store/REST id 3201910019365
};
const SH_CALLER = 'com.samsung.tv.csfs';      // CoBA host; the callerid CoBA hard-codes for Netflix

const acd = (key, value) => new tizen.ApplicationControlData(key, [String(value)]);
const extras = obj => Object.keys(obj).filter(k => obj[k] != null).map(k => acd(k, obj[k]));

function launchAppControl(appId, operation, data, uri = null) {
  return new Promise((resolve, reject) => {
    try {
      const ctl = new tizen.ApplicationControl(operation, uri, null, null, data);
      tizen.application.launchAppControl(ctl, appId,
        () => resolve({ appId, operation, keys: data.map(d => d.key) }),
        e => reject(new Error(`${appId} ${operation}: ${e.name}: ${e.message}`)));
    } catch (e) { reject(e); }
  });
}
const isInstalled = appId => { try { return !!tizen.application.getAppInfo(appId); } catch (e) { return false; } };

// ---------- Netflix ----------
// details=true reproduces the captured Smart Hub tile string byte for byte (opens the title page).
// details=false drops showMovieInfoOnly/source_type_payload (INFERRED play/resume form).
function netflixActionUrl(titleId, { details = false, trackId = '15539201', tileIndex = 0 } = {}) {
  const stp = `groupIndex=1&tileIndex=${tileIndex}&action=mdp&movieId=${titleId}&trackId=${trackId}`;
  return details
    ? `m=${titleId}&trackId=${trackId}&showMovieInfoOnly=true&source_type_payload=${encodeURIComponent(stp)}`
    : `m=${titleId}&trackId=${trackId}`;
}
const NETFLIX_PLAY_ALTS = id => [                                   // try in order if the first is ignored
  netflixActionUrl(id),                                             // inferred (tile form, no details flag)
  `m=https://www.netflix.com/watch/${id}&source_type=4`,            // community (smartest-tv DIAL body)
  `m=http%3A%2F%2Fapi.netflix.com%2Fcatalog%2Ftitles%2Fmovies%2F${id}&source_type=4`, // community (ConnectSDK webOS)
];
function netflixControl(url, variant) {
  switch (variant) {
    case 'A': return [OP.DEFAULT, extras({ '--root': 'app', '--app-js': 'netflix', callerid: SH_CALLER,
      action_play_url: url, __K_SPLASH_SCREEN: 'LA_UI_DEFAULT', __LEGACY_LAUNCH__: 'true' })]; // CoBA LaunchNetflix
    case 'B': return [OP.DEFAULT, extras({ CallerId: SH_CALLER, PayLoad: `action_play_url&${url}`, Operation: 'DeepLink' })]; // LaunchNetflixPreview -> LaunchPreview
    case 'C': return [OP.EDEN_RESUME, extras({ PAYLOAD: url })];      // what litewas hands an app (DIAL/REST path)
    default: throw new Error(`variant ${variant}`);
  }
}
async function playNetflix(titleId, { details = false, variant = 'A', alt = 0 } = {}) {
  const url = details ? netflixActionUrl(titleId, { details: true }) : NETFLIX_PLAY_ALTS(titleId)[alt];
  const [op, data] = netflixControl(url, variant);
  return Object.assign(await launchAppControl(APP.netflix, op, data), { url });
}

// ---------- YouTube ----------
// CoBA LaunchYoutubePreview: payload = <CoBA config prefix> + metadata[launch_social_v.link] + <videoId>.
function youtubeSocialLink() {
  try {
    const hit = tizen.application.getAppMetaData(APP.youtube)
      .find(m => m.key === 'http://samsung.com/tv/metadata/launch_social_v.link');
    return hit ? hit.value : null;
  } catch (e) { return null; }
}
async function playYouTube(videoId, { variant = 'A' } = {}) {
  const link = youtubeSocialLink();
  const payload = link != null ? `${link}${videoId}` : `v=${videoId}`;
  const v = {
    A: [OP.DEFAULT, extras({ CallerId: SH_CALLER, PayLoad: payload, Operation: 'DeepLink' })], // LaunchPreview shape
    B: [OP.EDEN_RESUME, extras({ PAYLOAD: payload })],                                        // litewas output shape
    C: [OP.EDEN_RESUME, extras({ PAYLOAD: `v=${videoId}` })],                                 // DIAL-body form
  }[variant];
  return Object.assign(await launchAppControl(APP.youtube, v[0], v[1]), { payload, link });
}

// ---------- Prime Video ----------
const PRIME_ALTS = gti => [gti, `https://app.primevideo.com/detail?gti=${gti}`, `gti=${gti}`]; // all unverified
async function playPrime(gti, { variant = 'A', alt = 0 } = {}) {
  const url = PRIME_ALTS(gti)[alt];
  const v = {
    A: [OP.DEFAULT, extras({ '--root': 'app', '--app-js': 'amazon', callerid: SH_CALLER,
      action_play_url: url, __K_SPLASH_SCREEN: 'LA_UI_DEFAULT' })],                          // CoBA LaunchAmazon
    B: [OP.DEFAULT, extras({ CallerId: SH_CALLER, PayLoad: url, Operation: 'DeepLink' })],   // LaunchAmazonePreview
    C: [OP.EDEN_RESUME, extras({ PAYLOAD: url })],
  }[variant];
  return Object.assign(await launchAppControl(APP.prime, v[0], v[1]), { url });
}

// ---------- Generic Smart Hub Preview target (any app implementing the documented receiver) ----------
function launchPreviewTile(appId, actionData) {
  const values = typeof actionData === 'string' ? actionData : JSON.stringify(actionData);
  return launchAppControl(appId, OP.EDEN_RESUME, [acd('PAYLOAD', JSON.stringify({ values }))]);
}

// "play friends on netflix":
// playNetflix('70153404').then(r => console.log('sent', r)).catch(e => console.log(e.message));
// playNetflix('70153404', { details: true });            // Friends title page (exact Smart Hub tile string)
// playYouTube('jNQXAC9IVRw');
// playPrime('amzn1.dv.gti.9ab600aa-6625-b547-cfc0-190e3ad8a27d');

if (typeof module !== 'undefined') module.exports = { OP, APP, netflixActionUrl, NETFLIX_PLAY_ALTS, playNetflix, playYouTube, playPrime, launchPreviewTile, isInstalled };

```

### Caveats

- Nothing in this report was sent to the TV. No app-control launch to Netflix, YouTube or Prime has been run, so navigation to a title is unverified on the Q95T. The only live deep-link proof is YouTube via DIAL (201 with header Origin: https://www.youtube.com; re-deep-links.md, 'Live corrections').
- Provenance of the decompiled CoBA code. It comes from C:/Users/pranj/AppData/Local/Temp/tvremote-research/mobilebff-gap/img/common/usr/share/dotnet.tizen/framework/Tizen.TV.Service.CoBA.Core.dll (csapi-tv-service-coba-1.1.1, sha256 48c88c93…). I used a sibling worker's REA output (deeplink2/decompile/core-members.json, core-us.json) plus my own raw IL decode (deeplink2/docs/scripts/ildump.py). The TV does run com.samsung.tv.csfs, the CoBA host (ui-probe.json 'running'), but this exact build has not been matched to the Q95T firmware. The litewas evidence is from the emulator x86 image.
- Two points are inferred, not proven. (1) CoBA never calls set_Operation, so the operation becomes http://tizen.org/appcontrol/operation/default; this relies on Tizen app_control defaulting. (2) WebAppCommon.LockStatus true means a locked app (the web-app launcher/PIN route).
- Keys beginning __K_ (and __LEGACY_LAUNCH__) look like launcher-internal hints. The web runtime or launcher may strip or reject them when a third-party app sends them. If launchAppControl throws, drop those keys and keep --root, --app-js, callerid and action_play_url. Sending callerid=com.samsung.tv.csfs copies Samsung's caller string; whether Netflix or Prime checks the caller is unknown.
- Privileges a public-certificate app lacks: http://tizen.org/privilege/appmanager.kill (partner), so we cannot close Netflix, YouTube or Prime to force a cold start. On this TV all three are preloaded (REST running:true, visible:false). A launch while the app is in the background may just resume it without navigating. appmanager.certificate is also partner but not needed. application.launch (launchAppControl/launch) and application.info (getAppInfo/getAppMetaData/getAppsInfo) are public (tizen-docs 5.5 TV application.html via raw.githubusercontent.com/Samsung/tizen-docs). The Tizen 2.3 deep-linking guide's appmanager.launch is the old name. No documented privilege guards eden_resume or deep_link, but CoBA itself logs 'AppControl permission denied' and 'Launch rejected' cases, so the platform can refuse.
- Samsung's own TV Application API page (developer.samsung.com/smarttv/…/application-api.html, fetched 2026-10-22) currently leaves launch() and launchAppControl() out of the ApplicationManager IDL, though tizen-docs 5.5 TV lists them. CineHD and the Lumen agent already call launchAppControl successfully on this TV (agent.md, area-tizen-companion.md). Tizen docs also remark: 'Do not abuse the API for other app(s) launch without business consideration'. That only matters for store certification. Whether a hidden or background agent may launch apps is unknown; Samsung pauses a hidden UI app's JavaScript.
- Netflix: the details string is a real Smart Hub tile (2018 capture). The play strings are inferred or community-sourced. Friends is a series ID, so 'play' presumably means resume or next episode for the current profile (inferred), and a 'Who's watching?' profile picker may appear first. On Tizen 9, smartest-tv issue #8 reports that Netflix and Disney+ ignore the WebSocket DEEP_LINK metaTag (community, anecdotal). That is a different route from app control.
- YouTube: the CoBA config prefix (FSConfigAdapter.GetConfigStr(1)) and the launch_social_v.link metadata value are unknown; read them on the TV with getAppMetaData. It is unknown whether 9Ur5IzDKqV.TizenYouTube or the Cobalt runtime (com.samsung.tv.cobalt-yt) parses PAYLOAD. A 2022 community attempt with a PAYLOAD JSON and the pick operation failed.
- Prime: no action_play_url sample exists. All GTI forms are guesses, and the example GTI mapping is unverified.
- Sources reached indirectly: developer.tizen.org and docs.tizen.org now redirect to samsungtizenos.com, so I used the tizen-docs GitHub raw files. forum.developer.samsung.com is now a Salesforce SPA, so I read threads from Wayback copies (18518, 33864, 34889; 34889 got only a 'ask in Seller Office' reply). Everything is saved under C:/Users/pranj/AppData/Local/Temp/tvremote-re/deeplink2/docs/.
- Local files were only read; nothing was installed, no sdb was run, and no LAN device was contacted. The only writes were under deeplink2/docs/: code/deeplink.js, scripts/{render.py,render2.py,ildump.py,mocktest.js}, and the downloaded docs.
