# Build notes: cast

Status: built and verified against local stubs (see Verification). Not yet run against `test/mock-tv.js`, the real `lan.js`/`store.js`/`hub.js` (not written when I finished), or the real TV.

## Upload contract (for the web UI)

`POST /api/cast/upload` on the UI server (`http://127.0.0.1:8790`). `http.js` checks the CSRF header and Origin, then hands the request to `features.cast.acceptUpload(req, res)`.

Request:

| Header | Value |
|---|---|
| `X-Lumen-CSRF` | `hello.csrf` |
| `X-File-Name` | `encodeURIComponent(file.name)` (percent-encoded UTF-8; a plain ASCII name is accepted as is) |
| `Content-Type` | `file.type` or `application/octet-stream` (only used when the extension is unknown) |
| `Content-Length` | set by the browser for a `File`/`Blob` body |

Body: the **raw file bytes** (no multipart, no form encoding). Send it with `XMLHttpRequest` so `xhr.upload.onprogress` drives the progress bar (`fetch` has no upload progress):

```js
const xhr = new XMLHttpRequest();
xhr.open('POST', '/api/cast/upload');
xhr.setRequestHeader('X-Lumen-CSRF', hello.csrf);
xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
xhr.upload.onprogress = (e) => e.lengthComputable && showProgress(e.loaded / e.total);
xhr.onload = () => { /* 201 → JSON.parse(xhr.responseText) */ };
xhr.send(file);
```

Responses (all JSON, `Cache-Control: no-store`):

| Status | Body | When |
|---|---|---|
| `201` | `{ "fileId": "<32 hex>", "name": "<original name>", "size": <bytes>, "mime": "video/mp4" }` | stored |
| `400` | `{ "error": { "code": "INVALID", "message": "…" } }` | missing/empty `X-File-Name`, empty body |
| `413` | `{ "error": { "code": "INVALID", "message": "Files up to 4 GB can be cast" } }` | `Content-Length` or streamed size over 4 GB |
| `415` | `{ "error": { "code": "INVALID", "message": "Lumen can cast video, audio and image files" } }` | not a video/audio/image type (by extension, else by `Content-Type`) |
| `500` | `{ "error": { "code": "FAILED", "message": "…" } }` | disk error or aborted upload |

Then cast it over the live socket: `{ t: 'cmd', id, cmd: 'cast.file', fileId, name }`. The ack's `value` is the `cast.session` object.

Files are deleted 6 h after upload (checked hourly and at server start).

Supported extensions: video `mp4 m4v mkv webm mov avi ts m2ts mts mpg mpeg wmv 3gp`; audio `mp3 m4a aac flac wav ogg oga opus wma`; image `jpg jpeg png gif bmp webp`; stream `m3u8`.

## cast.session (state key)

`{ kind: 'dlna'|'dial'|'browser', title, uri, state, position, duration }`

- `state`: `PLAYING | PAUSED_PLAYBACK | STOPPED | TRANSITIONING | NO_MEDIA_PRESENT`.
- `position` and `duration` are seconds (numbers) or `null` when unknown. They are only live for `kind: 'dlna'` (polled every 1 s while a tab is visible).
- `uri` is the pasted URL. It is `null` for local files, because the TV-facing URL contains the cast secret.
- The value is `null` when nothing has been cast since the server started.
- `cast.control` (`play`/`pause`/`stop`/`seek`) only works for `kind: 'dlna'`. For `dial`/`browser` sessions it acks `INVALID`; show those sessions without transport controls ("Playing in YouTube").

## Files

- `server/adapters/avtransport.js`: DLNA renderer client (AVTransport1 + ConnectionManager1 SOAP on `tv.ports.dmr`).
- `server/adapters/dial.js`: DIAL client (`http://<tv.host>:<tv.ports.dial ?? 8080>/ws/app/<Name>`) and the launch payloads.
- `server/features/cast.js`: link classification, cast orchestration, uploads, the TV-facing file route, session polling, cleanup.

## Exports and signatures

`server/adapters/avtransport.js`
- `createAvTransport({ config, log, store })` returns:
  - `start()`, `stop()` (lifecycle only, never sends SOAP Stop), `setDemand()` (no-op)
  - `setUri(uri, metadata)` → `{}`. `metadata` is a DIDL-Lite string or `{ title?, mime? }` (built with `buildDidl`)
  - `play()` (Speed 1), `pause()`, `stopPlayback()` (SOAP Stop) → `{ value: { state, status, speed } }` (GetTransportInfo read-back)
  - `seek(seconds)` (Unit REL_TIME, `hh:mm:ss`) → `{ value: <position info> }`
  - `getTransportInfo(priority = 'user')` → `{ value: { state, status, speed } }`
  - `getPositionInfo(priority)` → `{ value: { track, position, duration, uri } }` (seconds or `null`; a duration of `0:00:00` becomes `null`)
  - `getMediaInfo(priority)` → `{ value: { tracks, duration, uri, title, medium } }` (`title` comes from the DIDL `dc:title`)
  - `getProtocolInfo(priority)` → `{ value: { sink: [...], source: [...] } }`
- Helpers: `DLNA_FLAGS`, `escapeXml`, `decodeEntities` (single pass), `parseTime`, `formatTime`, `upnpClass(mime)`, `protocolInfo(mime)`, `buildDidl({ uri, title, mime })`, `buildEnvelope(urn, action, args)`, `parseResponse(xml, action)`.
- Requests go through `createQueue({ concurrency: 1, minGapMs: 200 })`. Polls use priority `'poll'`. Timeout is 6 s.

`server/adapters/dial.js`
- `PAYLOADS = { youtube, netflix, prime }`, each `{ app: <DIAL name>, body: (arg) => string }`. **Correct reverse-engineered formats here, in one place**, including the DIAL app name.
- `youtubeBody(videoId)` → `v=<id>`; `netflixBody(titleId)` → `m=https%3A%2F%2Fwww.netflix.com%2Ftitle%2F<id>&source_type=4`; `primeBody(url)` → `deeplink=<encoded url>`.
- `createDial({ config, log, store })` returns:
  - `start()`, `stop()`, `setDemand()`
  - `appState(name)` → `{ value: 'running' | 'stopped' | … | null }`. Only `<state>` is parsed; YouTube's `additionalData` (screenId/deviceId) is never logged or returned
  - `launch(name, body)` → `{ value: { status, location } }` (POST, `Content-Type: text/plain; charset=utf-8`)

`server/features/cast.js`
- `createCast({ config, data, log, store, lan, avtransport, dial, rest })` returns:
  - `start()`: reads `castSecret` from `secrets.json`, registers `lan.route('/cast/<castSecret>/', { request })`, publishes `cast.session = null`, cleans up, then runs cleanup hourly. **`start()` must be called, because it registers the file route.**
  - `stop()`, `setDemand({ visible })`
  - `classify(url)`
  - `castUrl(url)` → `{ value: session }`
  - `castFile(fileId, name)` → `{ value: session }`
  - `control(action, position)` → `{ value: session }`
  - `acceptUpload(req, res)`
- Helpers: `MIME_BY_EXT`, `mimeFromName(name)`, `parseCastUrl(input)`, `matchUrl(url)` (pattern only), `classify(input)` (async, HEAD probe with a 4 s timeout) → `{ kind, url, id?, mime? }`, `parseRange(header, size)`, `cleanFileName(raw)`.
- Routing:
  - youtube → `dial.launch(PAYLOADS.youtube.app, youtubeBody(id))`
  - netflix → `Netflix` + `netflixBody(id)`
  - prime → `AmazonInstantVideo` + `primeBody(url)`
  - media → `avtransport.setUri` + `play`
  - page → `POST ${rest.baseUrl}webapplication/` with JSON `{ url }`. `rest.baseUrl` falls back to `http://<tv.host>:<tv.ports.rest>/api/v2/`.
- `cast.session` is written with `src: 'live', via: 'avtransport'` for DLNA, and `src: 'derived'` (via `dial`/`rest`) otherwise.

## Spec deviations and interpretations

1. **`avtransport.stopPlayback()` instead of `avtransport.stop()`.** Every adapter's `stop()` is the lifecycle stop that `app.js` calls at shutdown. If `stop()` also sent SOAP Stop, shutting Lumen down would stop the user's playback on the TV. Only `features/cast.js` calls transport methods, and `cast.control('stop')` maps to `stopPlayback()`.
2. **DIAL and browser sessions** get `state: 'PLAYING'` once the TV accepts the launch (DIAL 200/201, REST 2xx). The app's own playback cannot be observed, so these sessions are not polled. `cast.control` on them acks `INVALID` ("YouTube is controlled with the TV remote").
3. `cast.session` is reset to `null` at start, so a session restored from the state cache is not shown as current.
4. Images are served with `transferMode.dlna.org: Interactive` (the DLNA rule for images). Video and audio use `Streaming`.
5. Read-backs: `play`/`pause`/`stopPlayback` read back GetTransportInfo, `seek` reads back GetPositionInfo, and `setUri` has none (the Play read-back confirms it).
6. Commands reject `TV_OFF` without contacting the TV when `conn.tv` is `standby` or `off`. Unreachable gives `UNAVAILABLE`. A SOAP fault gives `FAILED` with the UPnP code and description. DIAL 404 gives `UNAVAILABLE`.
7. Classification:
   - A link without a scheme gets `https://`.
   - YouTube also matches `/embed/<id>` and `/live/<id>`, plus the `m.` and `www.` hosts.
   - Netflix accepts a locale prefix (`/in/title/<id>`).
   - Prime is `primevideo.com`, or `amazon.*` paths under `/gp/video/`.
   - The HEAD probe treats non-2xx and `image/svg+xml` as a page.
8. Uploads:
   - `415` for non-media types and `400` for an empty body.
   - Over 4 GB by `Content-Length` gets a clean `413`. A chunked upload that grows past 4 GB has its connection reset, because the pipeline destroys the request. Browsers always send `Content-Length` for a File.
   - Data is written to `<fileId>.part` and renamed when complete, so the TV never sees a partial file. Leftover `.part` files are removed at start.
9. File metadata (mime) is kept in memory. After a restart, the file route takes the mime from the name segment of the URL, so files uploaded before the restart still play.
10. The cast secret never reaches state or logs: `session.uri` is `null` for local files, and the LAN URL is never logged. If `castSecret` is missing from `secrets.json`, a per-process secret is used with a warning (core generates it, so this should not happen).
11. Polling: every 1 s while a DLNA session is active and `setDemand` reports `visible`. A failed poll counts as idle. Polling stops after 10 s of `STOPPED`/`NO_MEDIA_PRESENT`/failures, and `control()` restarts it. A generation counter discards late polls from a superseded session.

## Known gaps

- **Netflix and Prime DIAL payloads are unverified guesses.** YouTube `v=<id>` is the documented DIAL form but has not been tried on this TV either. All three are in `PAYLOADS`.
- `POST /api/v2/webapplication/` is only known from a 2018 report and is unverified on this 2020 firmware. There is no fallback to `ed.apps.launch` with `org.tizen.browser`, because the remote adapter has no generic emit method.
- MIME aliases: Samsung DMRs sometimes list `video/x-mkv` or `video/avi` rather than `video/x-matroska` or `video/x-msvideo`. Picking the alias from the GetProtocolInfo sink list is not done.
- No subtitles (Samsung `sec:CaptionInfoEx`). No AVTransport GENA (polling only). External DLNA casts by other controllers are not detected (TrackURI is not compared).
- A DIAL/browser session cannot be stopped from Lumen. DIAL DELETE on `location` exists but is untested.

## Verification performed

- `node --check` on `server/adapters/avtransport.js`, `server/adapters/dial.js`, `server/features/cast.js`: all OK.
- `node --import ./tools/scratch/cast/register.mjs tools/scratch/cast/run.mjs` (scratch harness under `tools/scratch/cast/`, all servers on 127.0.0.1 ephemeral ports: a fake DMR that records SOAP actions and reflects state with advancing RelTime, a fake DIAL server, a fake REST `webapplication` endpoint, a fake web origin for HEAD probes, a stub `lan` with prefix routes on a real listener, and stub store/log/data). Result: **39 passed, 0 failed** (~26 s). Coverage:
  - Helpers: time parse/format, single-pass entity decoding, response parsing, DIDL classes/protocolInfo, `parseRange`, `cleanFileName`, payload builders.
  - classify: all YouTube/Netflix/Prime forms, media by extension and by HEAD Content-Type (mp4, x-mpegURL), page fallback, the 4 s HEAD timeout (measured ≈ 4.0 s), and rejection of ftp/javascript/blank.
  - DIAL: `appState` parses `<state>` and never logs the screenId. Unknown app gives UNAVAILABLE, a bad name gives INVALID. `launch` returns `{ status: 201, location }`. YouTube/Netflix/Prime POST bodies, with `Content-Type: text/plain; charset=utf-8`.
  - Browser path: POST `/api/v2/webapplication/` with `{ url }`.
  - Media cast: SetAVTransportURI has `CurrentURI` escaped once and the DIDL title/res escaped twice (`Tom &amp;amp; Jerry`, `&amp;amp;b=2`). The DMR decodes it to valid DIDL with `object.item.videoItem` and the exact protocolInfo, and Play has `Speed 1`.
  - Queue: ≥ 190 ms measured between DMR requests.
  - Polling: none while not visible. Position/duration update while visible. pause/seek(75 → `00:01:15`)/play read-backs. A 701 fault gives FAILED. Polling stops after STOPPED for 10 s.
  - Uploads: 201 + bytes on disk with the UTF-8 name; 400/415/400/413 error cases; unknown extension accepted by `Content-Type`.
  - castFile: DMR gets `http://127.0.0.1:<lanPort>/cast/<secret>/<fileId>/Clip%20%C3%BC.mp4`, session `uri: null`, secret absent from logs and state.
  - File route: HEAD headers (Content-Type, Content-Length, Accept-Ranges, `contentFeatures.dlna.org`, `transferMode.dlna.org: Streaming`). `Range: bytes=0-99` gives 206 with the correct bytes and Content-Range, `bytes=-10` gives the last 10 bytes, past-the-end gives 416 `bytes */size`, the full GET matches. Wrong secret 404, bad id 404, POST 405.
  - Gating and lifecycle: standby gives TV_OFF with no request to the DMR or DIAL, an unreachable DMR gives UNAVAILABLE. Cleanup on start removes a 7 h-old file and a leftover `.part` and keeps fresh and foreign files. Lifecycle `stop()` sends no SOAP Stop and later calls reject UNAVAILABLE.
- The first run used scratch stubs for `server/errors.js` and `server/util/queue.js` (they did not exist yet). The final run used core's real files (the hook printed no stub lines): 39/39 again.
