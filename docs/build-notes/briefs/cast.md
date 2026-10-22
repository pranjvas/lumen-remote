# Role: cast

**Files you own:** `server/features/cast.js`, `server/adapters/avtransport.js`, `server/adapters/dial.js`.

**Build** (spec §10)
- `adapters/avtransport.js`:
  - SOAP client for `http://<tv.host>:<ports.dmr>/upnp/control/AVTransport1` and ConnectionManager.
  - `setUri(uri, metadata)` with a DIDL-Lite builder: `dc:title`, `upnp:class` `object.item.videoItem` / `audioItem.musicTrack` / `imageItem.photo`, and `res` with protocolInfo `http-get:*:<mime>:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000` (XML-escaped twice correctly inside CurrentURIMetaData).
  - `play()` (Speed 1), `pause()`, `stop()`, `seek(seconds)` (Unit REL_TIME, hh:mm:ss).
  - `getTransportInfo()`, `getPositionInfo()` (parse RelTime/TrackDuration to seconds), `getMediaInfo()`, `getProtocolInfo()`.
  - Minimal regex/entity XML parsing (no XML library). ≤ 1 request / 200 ms queue.
- `adapters/dial.js`: Application-URL `http://<tv.host>:<ports.dial default 8080>/ws/app/`. `appState(name)` GETs and parses `<state>`; `launch(name, body)` POSTs with `Content-Type: text/plain; charset=utf-8` and returns `{ value: { status, location } }`. Payload builders: `youtubeBody(videoId)` → `v=<id>`, `netflixBody(titleId)`, `primeBody(url)`. Keep payloads in one exported `PAYLOADS` object, because the formats are being reverse-engineered in parallel and will be corrected there.
- `features/cast.js`:
  - `classify(url)` → `youtube` (watch?v=, youtu.be/, shorts/), `netflix` (netflix.com/title/<id> or /watch/<id>), `prime`, `media` (by extension, or `Content-Type` from a HEAD with 4 s timeout), `page`.
  - `castUrl(url)`:
    - youtube → `dial.launch('YouTube', youtubeBody(id))`
    - netflix → `dial.launch('Netflix', netflixBody(id))`
    - prime → `dial.launch('AmazonInstantVideo', …)`
    - media → avtransport `setUri` + `play`
    - page → REST `POST /api/v2/webapplication/` with JSON `{ url }` (use `rest`'s base URL and a plain fetch)
    - publish `cast.session` `{ kind, title, uri, state, position, duration }` and return `{ value: session }`.
  - Local files:
    - `acceptUpload(req, res)` streams the body to `data/cast/<fileId>` (random id, keep the original name from the `X-File-Name` header, 4 GB cap, 201 with `{ fileId, name, size, mime }`).
    - Serve files to the TV through `lan.route('/cast/' + castSecret + '/', { request })` with GET/HEAD and Range support, plus the DLNA headers `contentFeatures.dlna.org` and `transferMode.dlna.org: Streaming`, and the correct `Content-Type`.
    - `castFile(fileId, name)` casts `http://<lanAddress>:<lanPort>/cast/<secret>/<fileId>/<encoded name>`.
    - Clean up files older than 6 h hourly and on start.
  - `control(action, position)` → avtransport.
  - While a DLNA session is active and any client is visible, poll transport + position every 1 s (stop when STOPPED/NO_MEDIA_PRESENT for 10 s).
  - Write the upload contract (headers, response) into `docs/build-notes/cast.md` early, because the web-ui builder reads it.

**Verify** with scratch stubs on 127.0.0.1: a fake DMR SOAP server that records SetAVTransportURI and reflects state, a fake DIAL server, and a Range request to the file route.
