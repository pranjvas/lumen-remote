# Reverse engineering: deep-links

## Summary

Short answer: a launch-with-content request reaches the app as an opaque string. The TV passes it on without reading it, so whether it opens a title depends on the app. Best route per app:
- YouTube: DIAL with body `v=<id>`. This is the most certain route.
- Netflix: DIAL or REST with a Netflix-style `m=...` string. Plausible, but no confirmed working case.
- Prime Video: DIAL (name `AmazonInstantVideo`) with a GTI. Guesswork.
- TV browser: REST launch of `org.tizen.browser` with the URL as the launch string.
None of these launches were sent; the orchestrator has to run them.

How DIAL works on this TV (decompiled from the emulator's x86 `/usr/bin/remote-server`, `DIALAPIService`):
- **Path.** `Handle_POST` requires the URI to start with `/ws/app/` (singular) and be exactly `/ws/app/<Name>`. A POST to `/ws/apps/<Name>` fails in this build. GET takes the last path segment, so both `/ws/app/` and `/ws/apps/` answer GET.
- **Body.** `launchApp` reads the body with `IHTTPMessage::getBody()` (vtable slot +0x1c, checked against the `WebConvHTTPMessage` vtable). It passes it unchanged to `was_launch_webapp(appIdByRuntitle(Name), body, "remote-server", cb, 0)`.
- **YouTube is special.** The launch string becomes vconf `rtc/memory/WebApp/9Ur5IzDKqV.TizenYouTube_URL` + the app's `launch_dial.link` metadata + body, sent through `was_force_launch_webapp`. That relaunches even when YouTube is already in front. YouTube is also the only DIAL launch that can wake the TV from standby, and only when "Power On with Mobile" is on; otherwise it returns 503.
- **Checks before launch** (`onLaunchWidget`):
  - The PC is looked up by MAC (from the TV's ARP table) in the TV's allowed-device list. Unknown or denied gives 401 and may trigger the Allow prompt.
  - An Origin header that isn't allowed gives 403, so don't send one.
  - Body over 4096 bytes gives 413. Not installed gives 404. Setup wizard or channel search gives 500.
  - Success is 201 with `LOCATION: http://<host>/ws/apps/<Name>/run`.
  - `?friendlyName=` and `?clientDialVer=` are parsed (default name shown is "Smart Device").
- **Inferred:** the PC is probably already on the allowed list, because WebSocket pairing appears to use the same allowed-device list in remote-server. That points to no prompt on the first DIAL POST, but it hasn't been checked.

How REST launch works (decompiled `MSFServer::DoLaunchApplication`; msf-server, the 8001/8002 server, is missing from the emulator image):
- **Launch string.** It is `data.id`. Combined with yandex/rtv, a TV app-development tool, sending REST `{"id":"<args>"}`, the request is `POST /api/v2/applications/<id>` with body `{"id":"<payload>"}`.
- **App already in front.** If the target app is already visible, the TV refuses with error -4009 "App is running." and drops the payload. Close the app first, or use DIAL.
- **Browser.** `org.tizen.browser` is accepted without the usual app-ID check. The TV's web-app launcher (`/usr/apps/org.tizen.litewebappservice/bin/litewebappservice`, `ICAul::AulLaunchApps`) then sets the launch URI to the payload for `org.tizen.browser`, which is how a URL reaches the browser. For other apps it adds the payload as extra data `PAYLOAD`. If the app is already running, it also sends the `deep_link` operation with the URI set to the payload.
- **`/api/v2/webapplication/` is not the browser.** It goes to cloud-app container `3201412000694`. A live GET returned `{"id":"3201412000694","name":"App Launcher","version":"3.2.23"}`. Launching an arbitrary URL there needs Samsung cloud-app permission (unless `testmode` or `isContents`), so it is unsuitable.

Content-string formats:
- **Netflix:** the TV's Smart Hub app (CoBA) launches Netflix tiles with extra key `action_play_url`. Real tile data from a Tizen Smart Hub capture (yandex/rtv `eden-apps.json`, a 2016-era TV) has the form `m=70153404&trackId=...&showMovieInfoOnly=true&source_type_payload=...`, where 70153404 is Friends. Community tools use `m=https://www.netflix.com/watch/<id>&source_type=4`. Netflix's own DIAL reference server wraps the body as `source_type=12&dial=<urlencoded body>`.
- **Prime Video:** Smart Hub has an `AMAZON_LAUNCH` path; the payload format is unknown. LG's Prime app takes a raw `amzn1.dv.gti.*` ID.
- **WebSocket `ed.apps.launch`:** handled by msf-server, which isn't in the image. `ed.installedApp.get` gets no reply on this firmware, so treat `ed.apps.launch` as a low-ranked candidate.

Working files are under `C:/Users/pranj/AppData/Local/Temp/tvremote-re/deep-links/`:
- `out/`: annotated disassembly, including `launchApp.txt`, `fn_onLaunchWidget.txt`, `fn_Handle_POST.txt`, `fn_DoLaunch.txt`, `litewas.ann`
- `dl/`: downloaded sources
- `live/`: `dial-get-1..3.json`, `rest-get-1.json`
- `scripts/`: the probe and helper scripts

## Verified live

- DIAL GET http://192.168.1.2:8080/ws/app/Netflix -> 200 text/xml, dialVer 2.2, <name>Netflix</name><options allowStop="true"/><state>stopped</state><version>80.25.23140</version>, ACAO:*, ~110 ms
- DIAL GET /ws/app/YouTube -> 200, state stopped, version 2.1.498, allowStop true, additionalData present (brand Samsung, model QA55Q95TAKXXL, screenId/deviceId/yumi/passiveSessionId present but redacted, theme cl)
- DIAL GET /ws/app/AmazonInstantVideo -> 200, state stopped, version 5.3.21, allowStop true (this is Prime Video; the version matches REST 3201910019365)
- DIAL GET /ws/app/Plex -> 200, state stopped, version 5.64.1 (Plex is also DIAL-registered)
- DIAL GET /ws/app/{PrimeVideo, AmazonPrimeVideo, Amazon, YouTubeTV, YouTubeKids, Spotify, spotify, Spotify-TV, AppleTV, com.spotify.Spotify.TizenTV, Browser} -> 404 (Content-Length 0)
- DIAL GET plural /ws/apps/Netflix -> 200 with the same XML (GET accepts both paths; the decompiled POST requires singular /ws/app/)
- DIAL state differs from REST: REST says running:true, visible:false for Netflix/YouTube/Prime/Internet (preloaded), while DIAL says stopped; DIAL GET takes 20-255 ms vs REST ~1.3 s
- REST GET /api/v2/applications/3201907018807/ -> {name Netflix, running true, version 80.25.23140, visible false}; 111299001912/ -> YouTube 2.1.498; 3201910019365/ -> Prime Video 5.3.21; 3201907018784/ -> Internet 3.5.10100
- REST GET /api/v2/webapplication/ -> 200 {"appName":null,"id":"3201412000694","media_player":false,"name":"App Launcher","running":false,"version":"3.2.23","visible":false}: the webapplication endpoint is the App Launcher cloud-app container, matching the decompiled 3201412000694 branch

## Recipes

### Read DIAL state, version and allowStop cheaply (now-playing hint, already-running check)

- evidence: live-tv; needs live launch test: false
- request: GET http://192.168.1.2:8080/ws/app/<Netflix|YouTube|AmazonInstantVideo|Plex> (no headers needed). Parse <state>, <version>, allowStop. Never surface <additionalData> (screenId/deviceId are secrets).
- expected: 200 XML; state running|stopped|hidden (Netflix state comes from vconf db/netflix/status fg/bg); 404 if not DIAL-registered

### YouTube #1: play a video

- evidence: decompiled; needs live launch test: true
- request: POST http://192.168.1.2:8080/ws/app/YouTube
Content-Type: text/plain; charset="utf-8"
(no Origin header)
Body: v=jNQXAC9IVRw
- expected: 201 Created, LOCATION http://<host>/ws/apps/YouTube/run; YouTube force-relaunches with the video, even if it is already in front. Verify: REST GET /api/v2/applications/111299001912/ visible:true. 401 means the PC is not on the allowed-device list (Allow prompt; retry after Allow).

### YouTube #1b: play from an offset

- evidence: community; needs live launch test: true
- request: POST http://192.168.1.2:8080/ws/app/YouTube  body: v=jNQXAC9IVRw&t=5
- expected: 201; plays from about 5 s (t= is community usage, not seen in TV code)

### YouTube #2: control playback/queue once YouTube is open (works while YouTube is in front)

- evidence: source-code; needs live launch test: true
- request: 1) GET /ws/app/YouTube -> screenId (keep secret). 2) POST https://www.youtube.com/api/lounge/pairing/get_lounge_token_batch screen_ids=<screenId> -> loungeToken. 3) Lounge bind/setPlaylist (as in the casttube library's YouTubeSession.play_video(videoId), used by ha-samsungtv-smart samsungcast.py). Launch YouTube first with recipe #1 and an empty body, then wait about 3 s.
- expected: Video starts in the open YouTube app; queue, add and clear supported. Cloud dependency (YouTube servers).

### Netflix #1: play/resume Friends

- evidence: community; needs live launch test: true
- request: POST http://192.168.1.2:8080/ws/app/Netflix  Content-Type: text/plain; charset="utf-8"  body: m=https://www.netflix.com/watch/70153404&source_type=4
- expected: 201; Netflix opens and, if it honours the string, plays or resumes Friends (70153404). The TV passes the body unchanged; the app decides. At worst Netflix opens on its home screen.

### Netflix #2: open the Friends title page (Smart Hub tile format)

- evidence: community; needs live launch test: true
- request: POST http://192.168.1.2:8080/ws/app/Netflix  body: m=70153404&showMovieInfoOnly=true&source_type_payload=groupIndex%3D1%26tileIndex%3D0%26action%3Dmdp%26movieId%3D70153404
- expected: 201; Netflix shows the Friends details page. This is the string Smart Hub hands Netflix (under key action_play_url, not PAYLOAD), so delivery through DIAL is unproven.

### Netflix #3: numeric title variant

- evidence: inferred; needs live launch test: true
- request: POST http://192.168.1.2:8080/ws/app/Netflix  body: m=70153404&source_type=4
- expected: 201; plays/opens Friends if Netflix accepts a bare ID

### Netflix #4: same string through REST (only when Netflix is NOT in front)

- evidence: decompiled; needs live launch test: true
- request: POST http://192.168.1.2:8001/api/v2/applications/3201907018807/  Content-Type: application/json  body: {"id":"m=https://www.netflix.com/watch/70153404&source_type=4"}  (try without the trailing slash if the socket drops)
- expected: 200 true. Error -4009 "App is running." if Netflix is in front (payload dropped); -4001 Unauthorized if the PC is not allowed. Netflix receives the string as extra data PAYLOAD.

### Netflix #5: legacy Netflix DIAL play intent

- evidence: source-code; needs live launch test: true
- request: POST http://192.168.1.2:8080/ws/app/Netflix  body: intent=play&titleid=http://api.netflix.com/catalog/titles/series/70153404
- expected: 201; old Netflix DIAL format (2011 Google TV Netflix DIAL doc); low odds

### Netflix #6: WebSocket launch on the paired remote channel

- evidence: community; needs live launch test: true
- request: {"method":"ms.channel.emit","params":{"event":"ed.apps.launch","to":"host","data":{"appId":"3201907018807","action_type":"DEEP_LINK","metaTag":"m=70153404&showMovieInfoOnly=true"}}}
- expected: Reply {"event":"ed.apps.launch","data":200|true,"from":"host"} if supported; likely silent on this 2020 firmware (ed.installedApp.get gets no reply)

### Prime Video #1: open title by Prime detail URL

- evidence: inferred; needs live launch test: true
- request: POST http://192.168.1.2:8080/ws/app/AmazonInstantVideo  Content-Type: text/plain; charset="utf-8"  body: https://app.primevideo.com/detail?gti=amzn1.dv.gti.9ab600aa-6625-b547-cfc0-190e3ad8a27d
- expected: 201; Prime Video (3201910019365, v5.3.21) opens; it navigates to The Boys only if Amazon's TV app parses this form. The GTI comes from the primevideo.com The Boys S1 page and its exact mapping is unverified.

### Prime Video #2: raw GTI (LG contentTarget style)

- evidence: community; needs live launch test: true
- request: POST http://192.168.1.2:8080/ws/app/AmazonInstantVideo  body: amzn1.dv.gti.9ab600aa-6625-b547-cfc0-190e3ad8a27d
- expected: 201; title page if accepted

### Prime Video #3: key=value forms

- evidence: inferred; needs live launch test: true
- request: POST http://192.168.1.2:8080/ws/app/AmazonInstantVideo  body: gti=amzn1.dv.gti.9ab600aa-6625-b547-cfc0-190e3ad8a27d   (then try: deeplink=https%3A%2F%2Fapp.primevideo.com%2Fdetail%3Fgti%3Damzn1.dv.gti.9ab600aa-6625-b547-cfc0-190e3ad8a27d)
- expected: 201; title page if accepted

### Prime Video #4: REST with payload (Prime not in front)

- evidence: decompiled; needs live launch test: true
- request: POST http://192.168.1.2:8001/api/v2/applications/3201910019365/  Content-Type: application/json  body: {"id":"https://app.primevideo.com/detail?gti=amzn1.dv.gti.9ab600aa-6625-b547-cfc0-190e3ad8a27d"}
- expected: 200 true; app gets PAYLOAD; navigation unknown

### Plain app open (fallback for any app, and Prime/Netflix when the content string is ignored)

- evidence: decompiled; needs live launch test: true
- request: DIAL: POST http://192.168.1.2:8080/ws/app/<Name> with empty body; or REST: POST http://192.168.1.2:8001/api/v2/applications/<id>/ body {}
- expected: 201 (DIAL) / 200 true (REST); REST returns -4009 if the app is already in front

### Browser URL #1

- evidence: decompiled; needs live launch test: true
- request: POST http://192.168.1.2:8001/api/v2/applications/org.tizen.browser  Content-Type: application/json  body: {"id":"https://example.com/"}
- expected: 200 true; Internet opens example.com. remote-server accepts org.tizen.browser without the usual ID check, and the web-app launcher sets the launch URI to the payload for org.tizen.browser. Risk: msf-server may reject org.tizen.* IDs (GET returns 404 for them).

### Browser URL #2 (store ID)

- evidence: inferred; needs live launch test: true
- request: POST http://192.168.1.2:8001/api/v2/applications/3201907018784/  Content-Type: application/json  body: {"id":"https://example.com/"}
- expected: 200 true; the URL opens only if the store ID resolves to the org.tizen.browser record at launch; otherwise the browser home opens

### Browser URL #3 (samsungtvws open_browser)

- evidence: source-code; needs live launch test: true
- request: {"method":"ms.channel.emit","params":{"event":"ed.apps.launch","to":"host","data":{"appId":"org.tizen.browser","action_type":"NATIVE_LAUNCH","metaTag":"https://example.com/"}}}
- expected: Reply data 200/true and the browser opens the URL on older firmware; likely silent here

### Chromeless URL via App Launcher (not the browser)

- evidence: decompiled; needs live launch test: true
- request: POST http://192.168.1.2:8001/api/v2/webapplication/  Content-Type: application/json  body: {"url":"https://example.com/"}
- expected: Most likely error -4004 "1. Need to get permission for the cloud app..." (needs Samsung cloud permission unless testmode/isContents); if allowed, the URL runs in App Launcher 3201412000694

### DIAL with a friendly name (only matters if the Allow prompt appears)

- evidence: decompiled; needs live launch test: true
- request: POST http://192.168.1.2:8080/ws/app/YouTube?friendlyName=Lumen%20Remote  body: v=jNQXAC9IVRw
- expected: Same as YouTube #1; any Allow prompt shows "Lumen Remote" instead of "Smart Device"

## Code sketch

```js
// lumen/deeplink.mjs - Node 22 ESM. Launch-with-content for the Q95T. Never logs tokens or DIAL additionalData.
import http from 'node:http';
const TV = '192.168.1.2';
export const DIAL_NAME = { netflix: 'Netflix', youtube: 'YouTube', prime: 'AmazonInstantVideo', plex: 'Plex' }; // GET-verified
export const APP_ID = { netflix: '3201907018807', youtube: '111299001912', prime: '3201910019365', browser: '3201907018784' };

function req({ port, method, path, body = null, headers = {}, timeout = 10000 }) {
  return new Promise((resolve, reject) => {
    const buf = body == null ? null : Buffer.from(body, 'utf8');
    const r = http.request({ host: TV, port, method, path, timeout, agent: false, // node:http sends no Origin (DIAL returns 403 on a foreign Origin)
      headers: { ...headers, ...(buf ? { 'Content-Length': buf.length } : {}) } }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', reject);
    if (buf) r.write(buf); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- DIAL (port 8080). POST must use /ws/app/<Name> (singular); body is passed raw to the app.
export async function dialState(name) {
  const r = await req({ port: 8080, method: 'GET', path: `/ws/app/${encodeURIComponent(name)}`, timeout: 4000 });
  if (r.status !== 200) return { registered: false, status: r.status };
  const tag = t => (r.body.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1];
  return { registered: true, state: tag('state'), version: tag('version'), allowStop: /allowStop="true"/.test(r.body) };
}
const DIAL_ERR = { 401: 'PC not on the allowed-device list (Allow prompt on TV; retry after Allow)', 403: 'Origin rejected', 404: 'not installed / not DIAL-registered',
  413: 'payload > 4096 bytes', 500: 'TV in setup wizard / channel search', 503: 'standby and Power On with Mobile off (YouTube)' };
export async function dialLaunch(name, payload = '', { friendlyName } = {}) {
  if (Buffer.byteLength(payload) > 4096) return { ok: false, reason: DIAL_ERR[413] };
  const q = friendlyName ? `?friendlyName=${encodeURIComponent(friendlyName)}` : '';
  const r = await req({ port: 8080, method: 'POST', path: `/ws/app/${encodeURIComponent(name)}${q}`, body: payload,
    headers: { 'Content-Type': 'text/plain; charset="utf-8"' } });
  return { ok: r.status === 201, status: r.status, location: r.headers.location, reason: DIAL_ERR[r.status] };
}

// ---- REST (port 8001). Payload goes in {"id": ...} and reaches the app as extra data PAYLOAD.
export async function restLaunch(appId, payload) {
  const body = payload == null ? '{}' : JSON.stringify({ id: payload });
  for (const p of [`/api/v2/applications/${appId}/`, `/api/v2/applications/${appId}`]) {
    try {
      const r = await req({ port: 8001, method: 'POST', path: p, body, headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
      const running = /App is running/i.test(r.body); // -4009: target already in front, payload dropped
      return { ok: r.status === 200 && /true/.test(r.body), status: r.status, alreadyForeground: running, body: r.body.slice(0, 200) };
    } catch (e) { if (p.endsWith('/')) continue; return { ok: false, error: String(e.message) }; }
  }
}
export async function restVisible(appId) {
  const r = await req({ port: 8001, method: 'GET', path: `/api/v2/applications/${appId}/`, timeout: 15000 });
  try { return JSON.parse(r.body).visible === true; } catch { return false; }
}
async function waitVisible(appId, ms = 12000) { const end = Date.now() + ms; while (Date.now() < end) { if (await restVisible(appId)) return true; await sleep(1500); } return false; }

// ---- Payload builders (ranked; the app decides whether it navigates)
export const payloads = {
  youtube: (videoId, t) => [`v=${videoId}${t ? `&t=${Math.floor(t)}` : ''}`],
  netflix: (titleId, open = false) => open
    ? [`m=${titleId}&showMovieInfoOnly=true&source_type_payload=groupIndex%3D1%26tileIndex%3D0%26action%3Dmdp%26movieId%3D${titleId}`, `m=https://www.netflix.com/title/${titleId}&source_type=4`]
    : [`m=https://www.netflix.com/watch/${titleId}&source_type=4`, `m=${titleId}&source_type=4`],
  prime: gti => [`https://app.primevideo.com/detail?gti=${gti}`, gti, `gti=${gti}`],
};

// play('youtube','jNQXAC9IVRw') | play('netflix','70153404') | play('prime','amzn1.dv.gti....')
// Sends ONE launch per call (candidate index chosen by the caller) so a person can judge navigation.
export async function play(app, contentId, { candidate = 0, open = false, via = 'dial' } = {}) {
  const p = payloads[app](contentId, open)[candidate];
  const res = via === 'rest' ? await restLaunch(APP_ID[app], p) : await dialLaunch(DIAL_NAME[app], p);
  return { ...res, payload: p, visible: res.ok ? await waitVisible(APP_ID[app]) : false };
}

// Browser: REST launch of org.tizen.browser with the URL as payload (the launcher sets the launch URI = payload), then the store-ID fallback.
export async function openUrl(url) {
  let r = await restLaunch('org.tizen.browser', url);
  if (!r?.ok) r = await restLaunch(APP_ID.browser, url);
  return { ...r, visible: r?.ok ? await waitVisible(APP_ID.browser) : false };
}
// Optional last resort over the existing paired socket (ws): likely silent on this firmware.
export const edLaunch = (appId, action_type, metaTag) => JSON.stringify({ method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: { appId, action_type, metaTag } } });
```

## Open questions

- Netflix: which content string (if any) makes the Tizen Netflix app (v80.25.23140) navigate when it arrives as PAYLOAD through DIAL or REST? The Smart Hub app hands Netflix tiles over under key action_play_url, not PAYLOAD. Test N#1 (watch URL), then N#2 (showMovieInfoOnly title page), then N#3, and record which navigates.
- Prime Video (AmazonInstantVideo DIAL, 3201910019365): the launch-string format is unknown. Test the URL, raw GTI and gti= forms. The GTI for a title has to come from primevideo.com pages, and the mapping used here (The Boys S1, amzn1.dv.gti.9ab600aa-6625-b547-cfc0-190e3ad8a27d) is unverified.
- msf-server (/usr/bin/msf-server, the 8001/8002 server) is absent from the emulator image. That REST body {"id":...} becomes remote-server's data.id rests on yandex/rtv usage plus the remote-server decompile. Confirm with one REST launch carrying a payload, and check whether POST needs the trailing slash on this firmware.
- Does the 2026 firmware still reject DIAL POST on /ws/apps/<Name> (plural)? Use /ws/app/ as Application-URL advertises; some community clients (Homey, Apps2Samsung) POST to /ws/apps/ and report authorization failures.
- Is the PC's MAC already on the TV's allowed-device list for DIAL (expected via WebSocket pairing, since both appear to go through the same list in remote-server)? If the first POST returns 401, the Allow prompt appears and needs the user.
- Is ed.apps.launch handled at all on this 2020 firmware (the Smart Hub component the ed.* events relied on was replaced by CoBA in 2020)? One send with action_type DEEP_LINK and one with NATIVE_LAUNCH would settle it; look for a {"event":"ed.apps.launch","data":200|true} reply.
- Browser: does msf-server accept POST /api/v2/applications/org.tizen.browser (GET returns 404 for org.tizen.* IDs)? Does the store ID 3201907018784 carry the URL through?
- YouTube: the exact launch_dial.link metadata value, and whether search strings (e.g. search_query=) work via DIAL. v=<id> is the only well-supported form.
- Verifying navigation: REST visible:true and DIAL state=running only prove the app is in front. Title navigation needs the user to look, or an on-TV companion check.

## Live corrections (2026-10-21 ~21:10 IST, orchestrator)

- **DIAL POST needs an app-matching Origin header on this firmware.** `POST /ws/app/YouTube` with body `v=jNQXAC9IVRw` returned **403** with no Origin header (with and without `?friendlyName=`), and **201 Created** (`LOCATION: http://192.168.1.2:8080/ws/apps/YouTube/run`) with `Origin: https://www.youtube.com`. Afterwards DIAL state was `running` and REST `111299001912/` reported `visible: true`. The emulator decompile suggested an empty origin is allowed; the 2026 firmware evidently differs. Use `Origin: https://www.youtube.com` / `https://www.netflix.com` / `https://www.primevideo.com` per app.
- **Browser URL via REST works:** `POST http://192.168.1.2:8001/api/v2/applications/org.tizen.browser` (no trailing slash) with `{"id":"https://example.com/"}` returned 200 `true`; the foreground app changed. Side effect: the CineHD app that was in front went to `running: false` (closed), so launching the browser can kill a running app.
- `KEY_VOLUP` / `KEY_VOLDOWN` over the paired channel changed UPnP volume 0→1→0; IP Control `backlightControl {backlight:11}` applied and read back, then restored to 10; `ProcessMouseDevice` Move drew a visible cursor square over CineHD (user confirmed).
