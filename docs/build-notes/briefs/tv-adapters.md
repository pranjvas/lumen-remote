# Role: tv-adapters

**Files you own:** `server/adapters/rest.js`, `server/adapters/remote.js`, `server/adapters/upnp.js`, `server/adapters/wol.js`, `server/catalog/keys.js`, `server/catalog/apps.js`.

**Build**
- `rest.js` (spec §2, §5.4, §8.3):
  - Device info poll with the demand cadence and the power state machine.
  - `device.*` keys, normalised and with **no identifiers**: name, modelName, model, os, resolution, language, country, networkType, developerMode, frameTV, year = '2020' from the model code prefix.
  - Keep `wifiMac` only in memory for `getWakeMac()`.
  - `app.foreground`: poll the last foreground app plus the curated apps from `catalog/apps.js` round-robin, one request in flight, trailing slash, 10 s timeout; `visible: true` → foreground.
  - `launch(id)`: POST `/api/v2/applications/<id>/` body `{}`, then confirm `visible` within 6 s and return `{ value: { id, visible } }`.
  - `getApp(id)`, `getDevice()`; `conn.latency.rest`.
- `remote.js`:
  - The WSS channel from §2 with the saved token (`data.readJson('tv.json')`).
  - Connect only while `conn.tv === 'on'`; `perMessageDeflate: false`; handshake timeout 10 s; wait up to 35 s for `ms.channel.connect`, ignoring early touch events.
  - Store a changed `data.token`; dead after 12 s without a frame; reconnect backoff from `timing.reconnectBackoffMs`.
  - `click`/`press`/`release` (`ms.remote.control` `SendRemoteKey`, Option 'false') with `safety.keyGapMs` spacing via a queue; release every pressed key on reconnect and stop.
  - `text(str, submit)` (`SendInputString` base64 UTF-8, `TypeOfRemote 'SendInputString'`, then `SendInputEnd` when submit).
  - `pointerMove` / `pointerClick` (`ProcessMouseDevice`).
  - IME events → `ime` `{ open, type, text, limit }` (imeStart opens; imeUpdate base64 → text; imeEnd closes; imeDone is not a close). Touch events → `touch.enabled`.
  - `pair()`: connect without a token, publish `conn.remote:'connecting'` with note "Accept on your TV", wait 45 s for the token, save it. On `ms.channel.unauthorized` with a token → `conn.remote:'unpaired'` and stop retrying.
- `upnp.js`:
  - SOAP Get/SetVolume and Get/SetMute (InstanceID 0, Channel Master) with ≤ 1 request / 200 ms; SetVolume read-back (note: SetVolume unmutes the TV — after a SetVolume, re-read mute too).
  - GENA via `lan.route('/gena/' + genaSecret, { request })`: SUBSCRIBE with CALLBACK `<http://lanAddress:lanPort/gena/secret>`, `NT: upnp:event`, `TIMEOUT: Second-<genaTimeoutS>`; renew at 80 % of the granted timeout; 412 → fresh SUBSCRIBE; UNSUBSCRIBE on stop.
  - Parse the HTML-entity-encoded LastChange; merge only the present Master Volume/Mute; ignore empty LastChange.
  - `conn.events` = 'push' after the first NOTIFY, else 'polling' with the poll cadence from `timing` (fallback after `genaFallbackMs`).
  - `conn.upnp`, `conn.latency.upnp`.
- `wol.js`: 102-byte magic packet from a socket bound to the LAN address (`lan.ready` or the UDP-connect trick), `setBroadcast(true)` after bind, sent to `config.wol.targets` (empty = 255.255.255.255 + directed broadcast of the /24 + TV unicast) on `config.wol.ports`, 3 repeats 100 ms apart; `wake(mac)` validates the MAC.
- `catalog/keys.js`:
  - `KEYS` grouped `power`, `nav`, `menu`, `volume`, `channel`, `numbers`, `colors`, `media`, `extra`, from `docs/research/area-ws-remote.md`, with `hold` policies (`repeat` for arrows/volume/channel, `press` for long-press-meaningful keys like KEY_HOME/KEY_RETURN, `none` for KEY_POWER).
  - `isAllowedKey(key)` false for danger keys (KEY_FACTORY, KEY_11, KEY_12, KEY_EXT*, KEY_PANNEL_*, service keys, KEY_POWER hold).
  - Labels and small icon names for the UI.
- `catalog/apps.js`: `APPS` for the apps installed on this TV per research report §13–15 (CineHD `pvcinehd01.CineHDTV`, Netflix, YouTube, Prime Video, Apple TV, Apple Music, Spotify, Plex, Internet, SmartThings, Gallery, JioHotstar `fiZNCxMH9Y.Hotstar`, SonyLIV `EUKHUxrGQA.SonyLIV`, Airtel Xstream `dY5YOOBTrj.airtelxstream`, FanCode `0KIXYIdUgJ.FanCode`, …) with official brand colours, short glyph labels, and `dial` names where known (Netflix, YouTube, AmazonInstantVideo). Exclude `lumenrmt01.LumenAgent`.

**Verify** with scratch stubs: a tiny local HTTP server for REST/SOAP/GENA NOTIFY and a `ws` server (self-signed cert via Git's `openssl` into `tools/scratch/tv-adapters/`) for the remote channel, all on 127.0.0.1.
