# Build notes: ipcontrol

## Files

- `server/catalog/settings.js`: the settings catalogue (34 entries).
- `server/adapters/ipcontrol.js`: the Samsung Consumer IP Control adapter.
- Scratch, gitignored, under `tools/scratch/ipcontrol/`:
  - `stub-tv.mjs`: a TLS JSON-RPC stub.
  - `run.mjs`: 22 scenarios.
  - `smoke-server.mjs`: a smoke test through the real `startServer` and hub.
  - `stand-ins/` + `hooks.mjs` + `register.mjs`: stand-ins for the core files, used only while those files were missing. The real files exist now, and the hook only redirects on `ERR_MODULE_NOT_FOUND`.
  - `tls/`: a self-signed cert (CN `Samsung IP Control G2`) and 1024-bit DH params, both made with Git's `openssl`.

## Exports

### `server/catalog/settings.js`

- `SETTINGS`: a deep-frozen array of entries. Fields follow spec §9.3: `key, label, hint?, group, type, range?, step?, options?, ipc? { method, field }, scoped?, writable?, dependsOn?, display?, menuPath?`.
- `getSetting(key)`: returns the entry or `undefined`.
- `settingsByGroup()`: returns `{ picture, pictureAdvanced, sound, input, general }`, each an array in catalogue order.

Groups:

| Group | Entries |
|---|---|
| `picture` | mode, backlight (label "Brightness", hint "Panel backlight"), contrast, shadowDetail, sharpness, color, tint (`display:'gr'`), colorTone, size |
| `pictureAdvanced` | localDimming, contrastEnhancer, clarity, blurReduction and judderReduction (both `dependsOn {key:'picture.clarity', value:'Custom'}`), ledClearMotion, noiseReduction, filmMode, gammaMode, gamma, colorSpace, whiteBalance (the last four are `type:'readonly', writable:false`), plus tracked `picture.hdrToneMapping` |
| `sound` | `audio.soundMode`, `audio.speaker` (options `Internal` / `External`), plus tracked `sound.autoVolume` and `sound.balance` (range −50..50) |
| `input` | `input.source` (TV, HDMI1–4, AV1) |
| `general` | tracked gameMode, ambientLight, powerSaving, motionLighting, autoPowerOff (`Off/4h/6h/8h`), adaptivePicture, adaptiveSound |

- Tracked entries carry `options` (or `range`) and `menuPath`. They have no `ipc` and no `writable`.
- `scoped: true` is set on every picture value except `picture.mode` and `picture.size`.

### `server/adapters/ipcontrol.js`

`createIpControl({ config, data, log, store })` returns these methods:

- `start()`
  - Async and idempotent.
  - If there is no token, it publishes `conn.ipc:'unpaired'`.
  - It then applies the current demand.
- `stop()`
  - Async and idempotent.
  - Stops both loops, calls `queue.clear()` and destroys the https.Agent.
- `setDemand({ clients, visible, views })`
  - `views` may be a Set or an array.
- `get(method)`
  - Resolves `{ value }`. It sends a GET (params `{AccessToken}` only), publishes the result and returns it in UI units.
  - For a bulk getter, `value` is a flat map such as `{ 'audio.volume': 2, … }`.
  - Only known getters are allowed: `getTVStates`, `getVideoStates`, every catalogue method, `directVolumeControl` and `muteControl`. Anything else gets `INVALID`, because methods like `getDeviceInformation` and `externalSpeakerControl` can return serials or MACs.
- `set(method, params)`
  - Resolves `{ value }` after a SET and a GET read-back.
  - Allowed: writable catalogue methods, `directVolumeControl {volume}`, `muteControl {mute}` and `powerControl {power:'powerOn'|'powerOff'}`.
  - `powerControl` gets no read-back and resolves `{}`.
  - `mute` accepts a boolean or `muteOn`/`muteOff`. `speakerSelect` accepts `Internal`/`External`/`AudioOut/Optical`.
- `setSetting(key, value)`
  - Steps: catalogue lookup, validation (range and step rounding, or a case-insensitive option match normalised to the TV's spelling), SET, GET read-back, `store.set`. Resolves `{ value }` with the read-back.
  - Tracked keys, read-only keys and unknown keys get `INVALID`.
- `refresh(group = 'all')`
  - `'sound'` reads `getTVStates`.
  - `'picture'` and `'all'` read `getTVStates` and then a full picture sweep with re-probing.
  - Resolves `{}`.
- `power('on' | 'off')`: calls `powerControl` with `powerOn` or `powerOff`. Nothing else is ever sent, and the method is safe to call unbound.
- `pair()`
  - Sends `createAccessToken` with no params and a 45 s timeout.
  - The token is written with `data.writeJson('ipcontrol.json', { token, pairedAt })` before anything else. After that comes `conn.ipc:'paired'`, then polling resumes.
  - Resolves `{}`; the token is never returned.

## Behaviour

### Transport and queue

- Transport: `https.request` POST to `/` with Content-Type and Accept set to JSON and a Content-Length.
- The Agent is `{ keepAlive:false, maxSockets:1, rejectUnauthorized:false, ciphers:'DEFAULT@SECLEVEL=0', minVersion:'TLSv1' }`.
- Timeouts: an overall deadline of 6 s per call, 45 s for `createAccessToken`. Replies are capped at 1 MB.
- One queue: `createQueue({ concurrency:1, minGapMs:150 })`. User calls go in as `priority:'user'`, polls as `'poll'`.
- A reset (`ECONNRESET`/`EPIPE`, which is what the one-connection server sends when another client holds it) is retried once after 300 ms. `createAccessToken` is never retried.

### Error rules

| Code | Result |
|---|---|
| `-32601` / `-32001` | `UNAVAILABLE` |
| `-32002` | `LOCKED_IN_MODE` ("Locked in Dynamic mode") |
| `-32003` | `FAILED` |
| `-32011` | `FAILED` "All IP Remote slots are in use" |
| `-32602` | `INVALID` |
| `-32010` or `-32700` (a token is always sent) | `conn.ipc:'unpaired'` + `NOT_PAIRED` |

- Nested (`{error:{…}}`) and flat (`{code,message}`) errors are both parsed.
- After a token is rejected, it is not sent again. Calls fail fast with `NOT_PAIRED` until `ipcontrol.json` holds a different token (from pairing or an external re-pair).
- Network errors set `conn.ipc:'down'` and back polls off for 10 s. Commands get `TV_OFF` when `conn.tv` is standby or off, otherwise `FAILED`.

### Polling

- `getTVStates` runs every `timing.ipcStatesMs` while a client is visible.
- Picture sweeps run every `timing.ipcPictureMs` while the `settings` view is visible. The interval is measured from the end of one sweep to the start of the next.
- A sweep is: `getVideoStates` (contrast, Shadow Detail, sharpness, color, tint in one verified call), then `backlightControl`, `colorToneControl`, the 9 advanced getters and `WB2PointControl`, one at a time.
- Polling pauses while `conn.tv !== 'on'`, and a poll sweep stops mid-way if the TV leaves `on`. It stops with zero clients.
- On a change of `picture.mode` or `input.source` (seen by any read or read-back):
  - every scoped key is marked `{ stale:true }`;
  - the `-32601` latch is cleared;
  - a picture sweep runs on demand, whatever the demand.

### Records

- Every record is `src:'live', via:'ipc:<method>'`, with `range`/`options` from the catalogue. `options` also gets the current value appended when the TV reports one outside the list (e.g. `Filmmaker Mode`).
- Scoped settings carry `scope:{ input, mode }`.
- `conn.ipc` is `'paired' | 'unpaired' | 'down'`. `conn.latency.ipc` is in ms, `src:'derived'`.
- Normalisation:
  - mute is a boolean;
  - speaker is `'Internal'`/`'External'`;
  - numeric strings become numbers;
  - enums keep the TV's spelling;
  - tint is clamped to −50..50;
  - white balance is an object of six numbers.

### Logging

Tokens and parameter values are never logged. Log lines carry the method, latency, codes and connection-state transitions only.

## Interpretations and deviations

- **`audio.volume` and `audio.mute` are not in `SETTINGS`.** The brief's group list leaves them out. They also have to stay out of `setting.set`, which would otherwise bypass the hub's volume cap. The adapter handles them internally: they are published from `getTVStates` and written through `set('directVolumeControl' | 'muteControl')`, which is how `hub.js` calls them.
- **Bulk reads instead of per-field getters.**
  - Reads and read-backs for state keys (mode, size, sound mode, speaker, source, volume, mute) use `getTVStates`.
  - Reads and read-backs for contrast, Shadow Detail, sharpness, color and tint use `getVideoStates`.
  - Both calls are verified live on this TV. The per-field GETs for those keys are not in the live findings (spec §2 says "all verified", but the evidence shows only the bulk calls).
  - `get('<perFieldMethod>')` still sends exactly that method.
- **Unreadable getters.** A getter that answers `-32601` or `-32002` publishes `v:null` with `note:'unavailable'` or `note:'locked'` and `ttlMs:null`, so the UI can show UNAVAILABLE / locked rather than STALE. Methods that answered `-32601` are skipped in poll sweeps until the mode, input or power changes, or a `settings.refresh` runs. They are never latched for good.
- **Picture TTL.** The TTL is `3 × (ipcPictureMs + last sweep duration)`, not `3 × ipcPictureMs`. A full sweep is 15 calls of at least 150 ms each, and a fixed TTL would make values flicker to STALE in the Settings view. State keys use `3 × ipcStatesMs`.
- **`picture.gamma`** gets `dependsOn { key:'picture.gammaMode', value:'BT.1886' }`, because the method is the BT.1886 adjustment. This field is not in the brief.
- **Read-back failure after a successful SET** resolves `{}` (no value) and logs a warning, rather than reporting the write as failed.
- **`createAccessToken` refusals:** `-32011` maps to the slots message. Any other error becomes `FAILED` "The TV did not allow pairing (<code>)". It does not mark the existing token unpaired.

## Known gaps

- **Weak DH below 1024 bits is unverified.** `DEFAULT@SECLEVEL=0` exists for TVs that offer DH groups under 1024 bits. Neither Node nor this machine's OpenSSL 3.5.4 will serve a group that small, even at SECLEVEL 0 ("dh key too small" / "unknown security bits"), so I could not build such a server. The stub uses DHE-RSA with 1024-bit DH, which is what this TV negotiates according to the research report. The adapter's agent completes that handshake: TLSv1.2 DHE-RSA-AES128-GCM-SHA256, DH 1024.
- **Not live-verified on the TV:**
  - the per-field GETs for AMP.*, colorSpace, `gamma.BT1886` and WB2Point;
  - every SET, including whether a read-back right after a SET already shows the new value.
- **`conn.ipc:'down'` recovers only through a successful call.** The hub skips IP Control for volume and mute while `conn.ipc` is `'down'`. With zero clients nothing polls, so `conn.ipc` stays `'down'` until a visible client resumes polling or a `setting.set`/`refresh` goes through.
- **`settings.refresh` waits for a fresh sweep.** When a poll sweep is already running, the refresh waits for it to finish and then runs one more full sweep at user priority. That took about 5.9 s in the smoke test; patches stream in as values arrive.

## Verification performed

- `node --check` on both server files and every scratch file: all OK.
- `node --disable-warning=SecurityWarning --import ./tools/scratch/ipcontrol/register.mjs tools/scratch/ipcontrol/run.mjs`: **22/22 scenarios passed**. These ran against core's real `server/errors.js`, `server/util/queue.js` and `server/store.js`; the run reported `core files: errors.js=true queue.js=true store.js=true`. The scenarios covered:
  - Catalogue schema, groups and tracked entries.
  - No token: `NOT_PAIRED`, nothing sent.
  - Pairing:
    - `createAccessToken` goes out with no params;
    - the order of events was `write:ipcontrol.json` then `conn.ipc:paired`;
    - `-32011` returns the slots message and nothing is written.
  - `getTVStates` normalisation, including numeric strings and `muteOn` → `true`.
  - Set and read back:
    - backlight sends `backlightControl {"backlight":14}`, then `getTVStates`, then `backlightControl {}`, and gets the read-back 14 with scope and range;
    - contrast is read back via `getVideoStates`;
    - `warm1` is sent as `Warm1`.
  - Validation sends nothing to the TV.
  - Dynamic mode and scope:
    - writes in Dynamic get `LOCKED_IN_MODE` "Locked in Dynamic mode";
    - after a mode or input change, scoped keys are stale and then re-read with per-scope values (10 / 14 / 10).
  - Blur Reduction is locked until Picture Clarity is Custom.
  - Concurrency: 8 concurrent commands made 27 requests with maxActive 1, 0 resets and a minimum gap of 154–156 ms.
  - Token errors: `-32010` and `-32700` lead to unpaired, fail fast, then recover with a new token.
  - Error mapping works with both nested and flat errors.
  - A `-32601` getter becomes null/unavailable, stays latched, and is re-probed after a mode change.
  - Power sends only `powerOff` / `powerOn` and 0 param-less `powerControl` calls; reboot, `toString` and `get('powerControl')` are rejected.
  - Speaker `External` is sent as `AudioOut/Optical`; mute, volume, tint clamping (70 → 50) and string numbers all work.
  - Polling:
    - nothing polls without clients;
    - Remote view: only `getTVStates`;
    - Settings view: picture getters (measured picture TTL 11478 ms);
    - it pauses in standby, resumes when the TV is on, and stops with zero clients.
  - A mode change made on the TV side was picked up by a poll and triggered a re-read.
  - Resets and timeouts:
    - a reset was retried once and succeeded;
    - a held connection gave `FAILED` with `conn.ipc` down, then recovered;
    - a 6 s timeout gave `FAILED`, and `TV_OFF` in standby;
    - after `stop()`, calls are rejected.
  - TLS handshake: TLSv1.2 DHE 1024.
  - Across 257 log lines, no token appeared.
- `node --disable-warning=SecurityWarning tools/scratch/ipcontrol/smoke-server.mjs` ran the real `startServer` with a temp dataDir, the stub, a fake REST endpoint on loopback, `lan.enabled:false` and WoL targets `127.0.0.1`. Result: **SMOKE PASS**.
  - `hello` carried the catalogue.
  - The `view settings` command polled backlight 10.
  - Hub results:

    | Command | Result |
    |---|---|
    | `setting.set backlight 14` | `{ok:true, value:14}` |
    | `volume.set 9` | `{ok:true, value:9}` |
    | `mute.set true` | `{ok:true, value:true}` |
    | `setting.set mode Dynamic` | ok |
    | `setting.set backlight 5` | `LOCKED_IN_MODE` "Locked in Dynamic mode" |
    | `input.set HDMI1` | value `HDMI1`, and picture scope moved to `{input:'HDMI1', mode:'Dynamic'}` |
    | `settings.refresh all` | ok in 5930 ms |
    | `setting.set whiteBalance` | `INVALID` |

  - The stub saw 50 requests with maxActive 1 and 0 param-less `powerControl` calls. No token appeared in `lumen.log`.
- No real TV, LAN device, sdb or emulator was contacted. `data/ipcontrol.json` was never read; tests used temp data and in-memory stand-ins.
