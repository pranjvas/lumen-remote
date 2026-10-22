# Build notes: tv-adapters

Files (and nothing else):

- `server/adapters/rest.js`
- `server/adapters/remote.js`
- `server/adapters/upnp.js`
- `server/adapters/wol.js`
- `server/catalog/keys.js`
- `server/catalog/apps.js`

Scratch checks are in `tools/scratch/tv-adapters/` (gitignored).

## Exports and signatures

### `server/catalog/keys.js`
- `KEYS`: an array of `{ key, label, group, hold, icon? }` with 59 entries. The groups are `power`, `nav`, `menu`, `volume`, `channel`, `numbers`, `colors`, `media` and `extra`.
- `isAllowedKey(key, action = 'click')` returns `boolean`.
  - `action` is `'click' | 'press' | 'hold' | 'release'`.
  - It is true only for keys in `KEYS` that match no danger pattern. The danger patterns are KEY_FACTORY, KEY_11, KEY_12, KEY_EXT\d+, KEY_PANNEL_*, KEY_AUTO_ARC_*, KEY_ID_INPUT/SETUP, KEY_DTV_SIGNAL, KEY_CONVERGENCE, KEY_3SPEED and KEY_SERVICE*.
  - For `'press'` and `'hold'` it is also false when the key's `hold` is `'none'`. KEY_POWER is in that set, so a KEY_POWER hold is never allowed.
  - `safety.js` already calls it as `isAllowedKey(key, 'hold')`.

Hold policies:
- `repeat`: the arrows, VOL± and CH±.
- `press` (a real TV long-press): OK, Back, Exit, Home, Mute (Accessibility Shortcuts), Rewind, FF (track skip) and Voice (KEY_BT_VOICE).
- `none`: every other key, including Power.

Label: KEY_MENU is shown as **TV Menu**.

Icon names, for the web-ui sprite: power, up, down, left, right, ok, back, exit, home, menu, source, info, guide, list, tools, more, vol-up, vol-down, mute, ch-up, ch-down, prev-ch, star, dash, dot-red, dot-green, dot-yellow, dot-blue, play-pause, play, pause, stop, rewind, forward, record, ambient, mic, caption, subtitles, aspect, picture, sound, audio, accessibility, multiview, eco, sleep, tv, hdmi. The digit keys have no icon; their label is the digit.

### `server/catalog/apps.js`
- `APPS`: an array of `{ id, name, color, short, dial? }` with 16 entries.
- Included: CineHD `pvcinehd01.CineHDTV`, Netflix, YouTube `111299001912`, Prime Video, JioHotstar, SonyLIV, Airtel Xstream, FanCode, Apple TV, Apple Music, Spotify, Plex, Internet, SmartThings, Gallery and Amazon Alexa.
- `dial` is set for Netflix (`Netflix`), YouTube (`YouTube`) and Prime Video (`AmazonInstantVideo`).
- Excluded: `lumenrmt01.LumenAgent`; Samsung Promotion (a system promo app); Hot IPTV and Smart IPTV (their ids are not in the research).

### `server/adapters/rest.js`
- `createRest({ config, log, store })` returns:
  - `{ baseUrl, start(), stop(), setDemand({ visible }), getDevice(), getApp(id), launch(id), foregroundCheck(), getWakeMac() }`
- `baseUrl` is `http://<tv.host>:<ports.rest>/api/v2/`. `features/cast.js` already reads it.
- `normaliseDevice(raw)` is also exported. It is a pure function.
- `getDevice()` runs a fresh `/api/v2/` read at user priority.
  - It resolves `{ value: { power, reachable, name, modelName, model, os, platform, resolution, language, country, networkType, developerMode, frameTV, year } }`.
  - It **never rejects**: an unreachable TV shows up in `power`.
- `getApp(id)` resolves `{ value: { id, name, running, version, visible } }`.
  - 404 → `UNAVAILABLE`. A malformed id → `INVALID`. A network error → `TV_OFF` when the TV is standby or off, otherwise `FAILED`.
- `launch(id)` sends POST `/api/v2/applications/<id>/` with body `{}` and `Content-Type: application/json`.
  - It then polls `visible` (gap 500 ms) for up to 6 s and resolves `{ value: { id, visible } }`.
  - `visible: false` means the POST was accepted but the app never showed. That is the normal result for the self-hiding Lumen Agent.
  - Errors: `TV_OFF` when `conn.tv` is standby or off; `UNAVAILABLE` on 404; `INVALID`; `FAILED`.
- `foregroundCheck()` runs one foreground probe now and resolves `{ value: app.foreground }`.
- `getWakeMac()` returns the `wifiMac` from the last device read. It is held in memory only and never stored or logged.
- State it writes:
  - `conn.tv` and `power.state`: `src:'live'`, `via:'rest:/api/v2/'`.
  - `conn.latency.rest`: `src:'derived'`.
  - `device.*`: `live`; `year` and `platform` are `derived`.
  - `app.foreground`: `{ id, name } | null`.

### `server/adapters/remote.js`
- `createRemote({ config, data, log, store, rest })` returns:
  - `{ start(), stop(), setDemand(), click(key), press(key), release(key), text(str, submit = false), pointerMove(dx, dy), pointerClick(), pair() }`
- Key, text and pointer methods resolve `{}`. The TV never acknowledges a key, so there is no read-back to return.
- `pair()` resolves `{ value: 'paired' }`.
- Errors:
  - `INVALID`: a key that is not allowed, a hold of a `none` key, bad text or bad numbers.
  - `NOT_PAIRED`: no token, the token was rejected, or pairing was declined.
  - `TV_OFF`: no socket and `conn.tv` is not on.
  - `UNAVAILABLE`: a pointer while `touch.enabled === false`, or a call during shutdown.
  - `FAILED`: anything else.
- State it writes: `conn.remote` (with `note`), `ime { open, type, text, limit }` and `touch.enabled`. All are `src:'live'` with `ttlMs: null`.

### `server/adapters/upnp.js`
- `createUpnp({ config, data, log, store, lan })` returns:
  - `{ start(), stop(), setDemand({ visible }), getVolume(), setVolume(v), getMute(), setMute(b) }`
- Every method resolves `{ value }` with the read-back.
  - `setVolume` resolves `{ value: <volume> }` and re-reads mute into the store, because SetVolume unmutes the TV.
  - `INVALID` for a value outside 0–100, a non-number, or a non-boolean mute.
  - `FAILED` carries the UPnP fault code (for example `UPnP 501 Action Failed`).
  - `TV_OFF` for a network error while the TV is standby or off.
- `parseLastChange(body)` is also exported and returns `{ volume?, mute? } | null`.
  - It accepts an entity-encoded or CDATA LastChange.
  - `<LastChange/>`, an empty LastChange, or no Master Volume/Mute → `null`.
  - Non-Master channels are ignored.
  - `test/lastchange.test.js` imports it.
- State it writes:
  - `audio.volume` (`range [0,100]`) and `audio.mute`, with `via` = `gena` or `upnp:GetVolume` / `upnp:GetMute`.
  - `conn.upnp` (`ok|down`), `conn.events` (`push|polling|off`) and `conn.latency.upnp`.

### `server/adapters/wol.js`
- `createWol({ config, log, lan })` returns `{ start(), stop(), setDemand(), wake(mac) }`.
- `wake(mac)` resolves `{ value: { sent } }`.
  - `null` or `undefined` → `UNAVAILABLE` ("not known yet").
  - A malformed, all-zero or broadcast MAC → `INVALID`.
  - No packet sent at all → `FAILED`.
- `magicPacket(mac)` (102 bytes) and `wolTargets(config, lanAddress)` are also exported. Both are pure.

## Interpretations and deviations (simplest reading of the spec)

### Power state (rest)
- `conn.tv` is published as `'unknown'` when the adapter is created, so nothing gates on an old value.
- The state machine:
  - HTTP 200 with `PowerState:'on'` → on. 200 with any other or missing PowerState → standby.
  - ECONNREFUSED → standby.
  - My 3 s connect timeout, EHOSTUNREACH, ENETUNREACH, EHOSTDOWN or the OS's own ETIMEDOUT count as one connect failure; 3 in a row → off.
  - A response timeout (6 s), a non-200 or unreadable JSON keeps the last state.
- Device-info cadence: 3 s while a tab is visible, 15 s otherwise, and 30 s while off. The 30 s is a constant; there is no config key for it.

### Foreground app (rest)
- Probes alternate between the last foreground app and the next curated app, round-robin, at the device cadence. All REST calls go through one queue (concurrency 1, 50 ms gap) and use the trailing slash and a 10 s timeout.
- `app.foreground` becomes `null` when:
  - the known foreground app reports `visible:false`,
  - a full pass over the list finds nothing visible, or
  - the TV leaves `on`.
- `getApp` and `launch` results also update it.

### Device fields (rest)
- `device.name` drops the `[TV] ` prefix.
- `developerMode` and `frameTV` become booleans.
- `device.platform` (`Tizen 5.5`) is derived from the year, because spec §5.2 lists it and rest owns `device.*`.
- `device.panel` is left to the agent.

### Remote channel
- **Reacting to `conn.tv`.** Rest re-publishes `conn.tv` on every poll, so remote and upnp react only to **transitions**. Otherwise every poll would reset the reconnect backoff and renew GENA.
- **Socket lifetime.** The socket is opened only while `conn.tv === 'on'`. It is not closed when the TV goes to standby, so the hub's "KEY_POWER if the socket is still up" power-on path works in the standby window.
- **Fresh read before reconnecting.** Before each automatic reconnect, remote calls `rest.getDevice()` and reconnects only if that read still says `on`. This avoids reopening the socket, which could wake the TV, just after it went to standby.
- **Touch events.** `ms.remote.touchEnable/Disable` are recorded whenever they arrive, including before `ms.channel.connect`, because they describe the current screen. They never end the handshake wait.
- **Dead link.** The 12 s rule applies from `ms.channel.connect` on. Before that only the 35 s wait applies (45 s when pairing), so a slow Allow prompt is not cut off. The client sends a ping after 5 s without frames.
- **Waiting for a reconnect.** Commands wait up to 4 s for a reconnect that is already under way.
- **Held keys.**
  - A held key is auto-released after `holdMaxMs + 1 s`, as a backstop behind the hub's watchdog.
  - Every pressed key is released after each (re)connect and on `stop()`.
- **Text.** `SendInputEnd` is queued as its own step after `SendInputString`, so the key gap separates them.
- **Pointer.** Moves are coalesced to at most about 30 per second, clamped to ±1920, with `Time:'0'`.
- **IME.**
  - `text` is blanked for IME types that contain "pass", so passwords are never echoed to browsers.
  - `ime` closes when the socket closes.
  - `imeDone` is ignored; it is not a close.
- `ed.edenTV.update` triggers `rest.foregroundCheck()`.
- **Pairing.**
  - `pair()` closes any current socket after releasing held keys, publishes `connecting` with the note "Accept on your TV", and connects without a token.
  - Concurrent calls share one attempt. A declined prompt → `NOT_PAIRED`. A timeout or `ms.channel.timeOut` → `FAILED`.
  - On success it saves `{ ...existing tv.json, token, pairedAt }` and the pairing socket becomes the live channel.
  - Automatic connections never go out without a token.

### UPnP / GENA
- **Polling vs push.** Volume and mute are polled whenever push has not been proven: 1 s while a tab is visible, 10 s otherwise. After the first NOTIFY, `conn.events` is `push` and a 30 s safety poll keeps the TTLs fresh.
- **Fallback.** After every fresh SUBSCRIBE, a `genaFallbackMs` timer switches back to `polling` if no NOTIFY has arrived.
- **No listener.** When `lan.ready` resolves `null`, there is no SUBSCRIBE and the adapter polls.
- **Renewal.** Subscriptions are renewed at 80 % of the granted timeout. A 412 → a fresh SUBSCRIBE; other failures → polling, with a retry after 30 s.
- **When the TV leaves `on`.**
  - `conn.events` becomes `off` and `conn.upnp` becomes `down`, and no SOAP is sent.
  - When the TV comes back, the old SID gets a best-effort UNSUBSCRIBE and a fresh SUBSCRIBE follows. The live TV restarts its DMR in standby, and the fresh subscription's initial NOTIFY proves push again.
- **The NOTIFY route.**
  - An unknown SID → 412, so the TV drops subscriptions we abandoned.
  - A NOTIFY that arrives while a SUBSCRIBE is in flight is accepted.
  - A wrong path → 404; a method other than NOTIFY → 405; the body is capped at 64 KB.
- **Request pacing.** SOAP and GENA requests share one queue with at most 1 request per 200 ms. Only UNSUBSCRIBE on stop goes direct.
- **The GENA secret.** It comes from `config.secrets.genaSecret` (core attaches it), else `data.readJson('secrets.json')`, else a random value for this process.

### Wake-on-LAN
- **The bind address** is taken from `lan.ready`. Without it, the UDP-connect trick to `tv.host` finds it; that trick sends no packet.
- **Fallback.** If the bind fails, packets are sent unbound and a warning is logged.
- **Packets.** `setBroadcast(true)` is called after the bind. The packet goes to every target × `config.wol.ports`, 3 rounds, 100 ms apart.

### App colours
- CineHD has no brand colour; I chose gold `#D4A24C`.
- These colours are close to the brand primaries but I did not check them against brand guides: JioHotstar, SonyLIV, Internet, SmartThings, Gallery and FanCode.

## Known gaps

- Nothing in this role ran against the real TV (by rule). Still unverified live:
  - SetMute.
  - Behaviour of the "mixed/modern" keys, which the TV ignores silently if it does not know them: MORE, PMODE, SOUND_MODE, SLEEP, ESAVING, AD, MULTI_VIEW, CAPTION, SUB_TITLE, FAVCH, REC, MINUS, PLAY_BACK.
  - The `ime` type strings the TV sends.
  - Whether REST POST needs the trailing slash.
- Left out of the catalogue: e-Manual (no known WS key) and KEY_HDMI1–4 (no-ops on 2020 sets).
- No TLS fingerprint pinning (trust on first use) on wss 8002.
- The WoL MAC lives in memory only, as the spec requires. After a Lumen restart while the TV is in deep standby, `wake()` returns `UNAVAILABLE` until REST has seen the TV once.
- The directed broadcast assumes a /24 subnet.
- **REST load.** At the visible cadence, the foreground probe adds about one 1.35 s app query every 3 s. If that proves heavy on the real TV, slow the foreground loop on its own.
- **Not my file:** `npm test` (`node --test test/`) fails on Node 22.18 with `Cannot find module …\test`; `node --test test/*.test.js` works.

## Verification performed

All of it ran on 127.0.0.1. Commands:

- `node --check` on all six files: OK.
- `node tools/scratch/tv-adapters/check.mjs`: **51/51 checks passed**. It uses `stub-tv.mjs` (REST, SOAP+GENA, WSS on `ws` with a self-signed cert made by Git's openssl in that folder), a lan stand-in, and UDP sockets. It covers:
  - **Catalogues:** shape, groups, the allowlist and hold policies, the app ids, and no agent.
  - **`parseLastChange`:** the shared fixtures plus CDATA, `<LastChange/>` and non-Master channels.
  - **REST device info and power:**
    - the device fields with no identifiers anywhere in the store snapshot; the MAC is available only through `getWakeMac`;
    - standby, and ECONNREFUSED → standby;
    - 3 simulated EHOSTUNREACH → off (`http.request` patched, nothing sent);
    - a 6 s response timeout keeps the state;
    - the idle cadence;
    - stop.
  - **REST apps:**
    - foreground round-robin and following a change, with the trailing slash on every app call;
    - launch POST `{}` + JSON content type, with confirmed `visible`;
    - the error codes.
  - **Remote, connection and pairing:**
    - the token/name URL;
    - the early touch event;
    - token rotation saved with the other `tv.json` fields kept;
    - TV-off gating (no connection attempts, `TV_OFF`), with the socket kept for KEY_POWER;
    - unauthorized → unpaired with no retries;
    - pair declined, and pair allowed (note, `pairedAt`, live channel);
    - stop releases held keys;
    - no token → never connects.
  - **Remote, keys and input:**
    - the exact click payload and the key gaps (125–128 ms observed);
    - the allowlist;
    - pointer coalescing (3 moves → 1 Move x16 y4) and LeftClick;
    - touch gating;
    - IME start/update/done/end with password masking;
    - SendInputString base64 UTF-8 + SendInputEnd;
    - ed.edenTV.update → foregroundCheck.
  - **Remote, keepalive and backoff:**
    - Release on reconnect, after a fresh REST read;
    - the safety release;
    - dead after 12.0 s of silence, then reconnect;
    - backoff not reset by re-published `on` (5 attempts in 3.1 s).
  - **UPnP / GENA:**
    - the SUBSCRIBE headers (CALLBACK `<http://127.0.0.1:<lanPort>/gena/<secret>>`, NT, TIMEOUT);
    - the initial NOTIFY → push;
    - a change NOTIFY merged, an empty one ignored, an unknown SID → 412;
    - renewal after 1.61 s with a 2 s grant, and 412 → a fresh SUBSCRIBE;
    - get/set read-back with the unmute re-read;
    - SOAP gaps ≥ 204 ms;
    - INVALID and the UPnP 501 fault;
    - TV off → events off and no SOAP, back on → push again;
    - re-published `on` → no extra traffic;
    - UNSUBSCRIBE on stop;
    - no NOTIFY → polling at the visible cadence;
    - no listener → polling.
  - **WoL:**
    - the magic packet layout;
    - the default targets as a pure computation (nothing sent);
    - 6 packets of 102 bytes from 127.0.0.1 for 2 ports, with and without `lan.ready`;
    - MAC validation.
  - **Logs:** the debug-level log file contains no token, MAC, DUID, SSID, GENA secret or IME text.
- `node tools/scratch/tv-adapters/mock-integration.mjs` against the shared `test/mock-tv.js`: **7/7**. It covers:
  - pairing state and GENA push live;
  - KEY_VOLUP coming back over GENA;
  - an external volume change;
  - setVolume;
  - IME and text;
  - launch and foreground;
  - standby → WoL with the REST MAC → on, with the remote and GENA recovering.
- `node tools/scratch/tv-adapters/stack.mjs` (full `startServer` via `test/helpers.js` startStack on the mock): **8/8**. It covers:
  - the hello catalogues;
  - power, remote and events state;
  - a key reaching the mock, and a danger key refused;
  - the GENA patch;
  - `app.launch`;
  - `text.send`;
  - power off, then on through my WoL. The mock got 3 packets with the matching MAC.
- `node --test test/lastchange.test.js`: 8/8 pass. `node --test test/*.test.js`: 66/66 pass in the run I did.
