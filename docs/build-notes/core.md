# Build notes: core

## Files

`server/app.js`, `server/index.js`, `server/config.js`, `server/log.js`, `server/store.js`, `server/hub.js`, `server/safety.js`, `server/errors.js`, `server/util/queue.js`, `server/http.js`, `server/lan.js`, `server/features/sleep.js`, `server/features/scenes.js`, `server/features/tracked.js`, `server/features/macros.js`, `tools/start-hidden.js`, `tools/install-autostart.ps1`.

## Exports and signatures

- `errors.js`: `ERROR_CODES`, `class LumenError(code, message)` (an unknown code becomes `FAILED`), `toErrorPayload(err) → { code, message }`.
- `util/queue.js`: `createQueue({ concurrency = 1, minGapMs = 0 }) → { push(fn, { priority: 'user' | 'poll' = 'user' }) → Promise, clear(err?), size, active }`. `minGapMs` is the idle gap between the end of one task and the start of the next. `user` tasks always run before waiting `poll` tasks. `clear()` rejects tasks that have not started (default `LumenError('UNAVAILABLE', 'Stopped')`).
- `config.js`:
  - `REPO_ROOT`, `VERSION` (from package.json), `DEFAULTS` (deep-frozen), `SECRET_NAMES`.
  - `loadConfig(overrides)`, `createDataStore(dataDir) → { dir, path(name), readJson(name, fallback = {}), writeJson(name, obj) }`.
  - `writeJsonAtomic(file, obj)`, `ensureSecrets(data)`, `deepMerge(target, source)`.
- `log.js`: `createLogger({ dir, level, console, consoleLevel, maxBytes, keep }) → { debug, info, warn, error, child(tag), close() }`, `redact(value)`, `redactString(text)`. `child` nests as `a:b`.
- `store.js`:
  - `createStore({ cachePath, log?, batchMs = 50, persistMs = 10000 })`. The store has these methods:
    - `set(key, v, meta) → boolean` (true when the value changed)
    - `mark(pattern, { stale?, note? }) → count`
    - `delete(key)`, `get(key)`, `has(key)`, `snapshot()` (flat)
    - `on('patch', fn) → unsubscribe`, `off('patch', fn)`
    - `flush()`, `persist()`, `stop({ save = true })`
  - `deepEqual(a, b)` is also exported.
- `safety.js`: `createSafety({ config }) → { volumeCap, checkKey(key, action = 'click'), checkPower(), notePower(), limitVolume(target, current), checkRate(client, cmd) }`.
- `lan.js`: `createLan({ config, log }) → { ready, address, port, route(prefix, { request?, upgrade? }) → unregister, stop() }`. Also exports `discoverLanAddress(host, port = 9)`.
- `hub.js`: `createHub({ config, log, store, adapters, features }) → { handle(cmd, client?) → ack, attach(client), detach(client), broadcast(msg), stop() }`.
- `http.js`: `createHttp({ config, log, store, hub, adapters, features }) → Promise<{ port, server, stop() }>`. Also exports `loadStatic(dir)`.
- `app.js`: `startServer(overrides) → { httpPort, lanPort, lanAddress, agentKey, store, hub, config, log, stop() }`. `stop` is idempotent.
- Features (each also has `start()`, `stop()` and a no-op `setDemand()`):
  - `createSleep({ data, log, store, ipc, remote }) → { set(minutes) }`
  - `createScenes({ data, log, store }) → { list(), save(scene), remove(id), run(id, { hub }) }`
  - `createTracked({ data, log, store }) → { set(key, value), setLabel(source, label) }`
  - `createMacros({ data, log, store, remote }) → { list(), isRecording(client), record(client, phase, name), capture(client, key), discard(client), remove(id), run(id) }`

## Interpretations and deviations

### Protocol collision: read this, web-ui

Browser frames are `{ t, id: <uuid>, cmd, ...args }`, but spec §5.3 also gives `scene.run`, `scene.delete`, `macro.run` and `macro.delete` an argument named `id`. When a scene id is spread into the frame it replaces the request id, so the ack goes out with the scene id.

- The hub therefore takes **`target`** as the id of the thing acted on, falling back to `id` for internal callers (`server/ai/tools.js` sends `{ cmd: 'scene.run', id }`, which works).
- `ai.cancel` takes `target` too, which is what `web/js/views/ask.js` already sends.
- **`web/js/views/scenes.js` and `now.js` currently send `{ id: scene.id }` / `{ id: m.id }`.** The scene or macro still runs, but the ack carries the scene id, so the UI's pending command waits until its 60 s timeout. The fix is on the web side: send `{ target: scene.id }` (and the same for macros).

### Config

- Load order: defaults ← `data/config.json` (user settings, spec §3.4; a `dataDir` inside it is ignored) ← overrides.
- Added keys:
  - `tv.ports.dial: 8080`
  - `log: { level: 'info', console: true }`
  - environment variables `LUMEN_LOG_LEVEL` and `LUMEN_CONSOLE_LEVEL`
- Secrets: `secrets.json` gains any missing `genaSecret`, `agentKey`, `castSecret`, `mcpToken` (32-byte hex). Existing values are never overwritten and unknown keys are kept. The secrets are also exposed as `config.secrets.*`.
- `config.csrf` is new on every `loadConfig`. `secrets` and `csrf` are **non-enumerable**, so logging or serialising a config never leaks them.
- `readJson` returns `fallback` (default `{}`) when the file is missing or invalid. Names that escape `dataDir` throw.
- `writeJson` is synchronous (awaiting it still works). It writes a temp file and renames it, retrying 5 times with 20 → 320 ms backoff on EPERM, EBUSY or EACCES.

### Log

- "1 MB × 3" means `lumen.log` plus three rotated files (`.1`–`.3`).
- Redaction:
  - by object key: token, secret, authorization, password, cookie, csrf, agentkey, wifiMac, mac, sid, duid, serial
  - by pattern in strings: `Bearer …`, `key=`, `token=`, `secret=`, JSON `"…token": "…"`, MAC-like, UUID-like, and hex runs of 32 or more characters (our secrets)

### Store

- **Ranking:** a write from `agent`, `derived` or `cache` is refused only when the existing record is `live`, not stale, has `ttlMs > 0` and is younger than that TTL. A live record without a TTL is not protected.
- Every accepted `set` emits a patch, even with an unchanged value, because `at` moves. The return value reports whether `v` changed.
- `range` and `options` carry over from the previous record when a write omits them. Values are copied with `structuredClone`, and records are frozen.
- **Cache:** only `live`, `agent` and `cache` records are persisted. These keys never are: `conn.*`, `power.*`, `ime`, `touch.*`, `sleep`, `scenes`, `macros`, `cast.*`. A cached `conn.tv: 'on'` would mislead adapters that gate on it, and features republish their own keys on start.

### Safety

- **Volume cap:**
  - Lowering is always allowed.
  - Raising stops at the cap, or at the current level when the TV is already above the cap.
  - `volume.set` above the cap is clamped. A step up at the cap acks `INVALID` "Volume is capped at 60".
- **Power cooldown** (15 s) applies to `power on`, `power off` and the `key` command with `KEY_POWER`.
- **Rate limit:** a per-client token bucket of 30 per second (burst 30). `pointer.move` has its own bucket of 120 per second, because a touchpad streams.

### Hub routing

- `volume.set`, `volume.step` and `mute.set` run one at a time. Fallback order:
  - IP Control is skipped when `conn.ipc` is `unpaired` or `down`.
  - UPnP is skipped when `conn.upnp` is `down`.
  - Keys come last.
  - `INVALID` and `TV_OFF` stop the chain.
- Volume and mute use `ipc.set('directVolumeControl', { volume })` and `ipc.set('muteControl', { mute })`. These two are not in the settings catalogue; the ipcontrol adapter handles them in `set` and returns the read-back.
- Key fallbacks:
  - An absolute volume set by keys needs a trusted current level: a fresh `live` or `agent` record, or our own read-back from the last 3 s. It sends at most 25 clicks.
  - `volume.step` with an unknown level just clicks `|delta|` times.
  - `KEY_MUTE` is clicked only when the trusted mute state differs from the request.
- `volume.set` also accepts `atMost: true` (do nothing if the TV is already at or below the value). The default Night scene uses it for "volume ≤ 8".
- **Power off:** one `KEY_POWER` only when `conn.tv` is `on`. If the click fails it falls back to `ipc.power('off')`. `standby` or `off` acks ok with that value; `unknown` acks `UNAVAILABLE`.
- **Power on:**
  1. Wake-on-LAN, if REST knows the MAC.
  2. `KEY_POWER`, only when `conn.remote` is `paired`.
  3. `ipc.power('on')`.

  The steps run in that order, sequentially, so the absolute powerOn can never be undone by the toggle. The hub then polls `rest.getDevice()` every `powerPollMs` and acks `on`, or `FAILED` (with a "Power On with Mobile" hint) after `powerPollTotalMs`.
- Commands that need the TV ack `TV_OFF` at once when `conn.tv` is `standby` or `off`.
- `pointer.move` acks `UNAVAILABLE` unless `touch.enabled` is true, and `dx`/`dy` are rounded.
- `agent.connect` acks ok if the agent is already online. On failure it gives the fixed §9.1 message.
- **Holds:**
  - Catalogue `hold: 'repeat'` keys are clicked every `holdRepeatMs`; `'press'` keys get Press … Release; `'none'` keys are `INVALID`.
  - A watchdog ends a hold after `holdWatchdogMs` without a beat, or after `holdMaxMs` in total.
  - Holds also end on detach and on stop.
  - A repeat that fails mid-hold sends the client a toast.
- **Presence:** one view per client. A client that attaches counts as visible on `remote` until it says otherwise, and `visible:false` for a view other than the current one is ignored. This matches `web/js/main.js`.
  - Every adapter and feature with a `setDemand` (including `features.ai` and `features.cast`, resolved at call time) receives `setDemand({ clients, visible: boolean, views: Set })`, only when the result changes.
- **changedOnTv** (§9.4) also needs:
  - both the previous and the new record from `live` or `agent` and not stale
  - an equal `scope`, since a picture-mode or input change re-reads values in a new scope and is not a change on the TV
  - non-null values

  `KEY_VOLUP`, `KEY_VOLDOWN`, `KEY_MUTE`, `KEY_SOURCE`, `KEY_HDMI` and `KEY_TV` touch their state keys.
- **AI:** `ai.ask` acks at once with `{ value: { id } }`, where `id` is the command id; events stream to the asking client as `{ t:'ai', id, … }`.
- **hello:** sent before the client joins broadcasts, so no patch can precede it. Its `ai` field is `features.ai.status()`, waited on for at most 1.5 s.
- `hub.stop()` is an extra method.

### HTTP and LAN

- **Host and Origin:** a bad Host gets 421 and a bad Origin gets 403, for both requests and the `/live` upgrade. The upgrade *requires* an Origin.
- **CSP** is spec §3.3 plus:
  - `connect-src 'self' ws://127.0.0.1:<port> ws://localhost:<port>`
  - `object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`
- **Static files:**
  - `Cache-Control: no-cache` with ETag/304.
  - A request whose last path segment has no `.` falls back to `index.html`.
  - Dotfiles are skipped.
- **`/api/health`:** `{ ok, app: 'lumen', version, pid, uptimeS, tv }`.
- **`/api/icon/<id>`:** 404 for bad ids, when there is no agent, or when there is no icon.
- **Upload:** needs an allowed Origin *and* `X-Lumen-CSRF`, then goes to `features.cast.acceptUpload`.
- **`/mcp`:** loopback remote address only.
- **Timeouts:** `requestTimeout` is 0 so large uploads are not cut off; `headersTimeout` is 20 s.
- **WebSocket:** ping every 20 s, and a client that missed a pong is terminated. A client with more than 4 MB buffered is dropped. `maxPayload` is 64 KB.
- **lan.js:**
  - Sockets from anything but `tv.host` are destroyed on connect, and so are unrouted requests and upgrades. NOTIFY is handled natively by `node:http`.
  - Prefix matching is exact or `prefix/…`, longest prefix first.
  - `ready` resolves `null` when the listener is disabled or fails, with a warning that live events fall back to polling.

### App wiring and entry point

- Wiring follows spec §8.2 plus `avtransport`, `dial`, cast and ai. `app.installed` is always seeded from `catalog/apps.js` as `src:'derived'`.
- The HTTP port is bound before any adapter starts; it doubles as the single-instance lock. Every part with a `start()` is started; startServer waits up to 3 s for each.
- Stop order: http → hub → ai → cast → macros → tracked → scenes → sleep → dial → avtransport → wol → agent → ipc → upnp → remote → rest → lan → store (saves the cache) → log.
- A failed start stops whatever was created, without saving the cache. A busy port is not logged as an error.
- `index.js`:
  - Prints a banner.
  - Handles SIGINT, SIGTERM, SIGBREAK and SIGHUP. A second signal, or 6 s, forces the exit.
  - On EADDRINUSE it calls `/api/health` and prints "Lumen is already running: open …" or "Port N is in use by another program", then exits 1.
  - Unhandled rejections and uncaught exceptions are logged and the server keeps running (a remote control should survive one bad callback).

### Features

- **sleep:**
  - State key `sleep` (`src:'tracked'`, `via:'lumen'`).
  - Allows 1–720 minutes; 0 cancels.
  - Re-reads the wall clock every 30 s, so PC sleep cannot stretch the timer.
  - A timer that ended less than 2 min before a restart still fires; older ones are discarded.
  - At expiry it calls `ipc.set('powerControl', { power: 'powerOff' })`, then `KEY_POWER` only if `conn.tv` is `on`. Nothing is sent if the TV is already off.
- **scenes:**
  - Allowed step commands: `key`, `volume.*`, `mute.set`, `power`, `app.launch`, `input.set`, `setting.set`, `tracked.set`, `settings.refresh`, `text.send`, `sleep.set`, `cast.url`.
  - `waitMs` 0–10 s; at most 30 steps and 50 scenes. `t` and `id` are stripped from steps.
  - One scene runs at a time (a second run gets `RATE_LIMIT`).
  - Every step runs even if one fails. Any failure rejects the run with a summary such as `Night: 1 of 2 steps failed (picture.backlight: Locked in Dynamic mode)`.
  - Defaults: Night is backlight 4, then volume at most 8. Cinema is Movie (then 800 ms), backlight 8, local dimming High.
- **tracked:**
  - `tracked.json` is `{ values: { key: { v, at } }, labels, labelsAt }`.
  - Values are validated against the catalogue options or range. `value: null` forgets a setting.
  - Labels are at most 32 characters; an empty label removes it. `input.labels` is always published.
- **macros:**
  - `KEY_POWER` is never recorded or replayed.
  - Gaps are clamped to 150 ms–10 s; at most 100 steps and 50 macros.
  - Recording is per client and dropped on detach.
  - A saved macro containing a disallowed key is refused before anything is sent.

### Tools

- `start-hidden.js` rotates `stdout.log` to `.1` above 5 MB, and sets `LUMEN_CONSOLE_LEVEL=warn` for the child; the full log is `lumen.log`.
- `install-autostart.ps1` creates a Startup-folder shortcut to `node.exe "tools/start-hidden.js"` (window minimised); `-Remove` deletes it.

## Known gaps

- **Web UI scene and macro acks:** see the collision above. The UI must send `target`.
- **`npm test`:** `package.json` runs `node --test test/`, which fails on Node 22.18 ("Cannot find module …\test"). `node --test test/*.test.js` works. package.json is not mine to change.
- **Console flash at sign-in:** the autostart shortcut starts `node.exe`, a console program, so a window may flash briefly before `start-hidden.js` exits. The research's fully hidden route, a wscript + JScript launcher, needs a file outside my list.
- **LAN address:** the TV-facing address is discovered once at start; if the PC changes networks, Lumen must be restarted.
- **Retry stall:** the EPERM retry is synchronous, so the event loop can stall for up to about 620 ms in the worst case.
- **Untested signal handling:** sending SIGINT to a child process on Windows just kills it, so the signal path was not exercised. Graceful stop was verified through `stop()` instead.
- **Not run, per the brief:** `install-autostart.ps1`. `start-hidden.js` ran only from a sandbox copy with a fake `server/index.js`. Nothing contacted the real TV or the LAN.

## Verification performed

All scratch scripts are in `tools/scratch/core/` (gitignored).

- **Syntax:** `node --check` on all 16 JS files passed. `install-autostart.ps1` parsed with the PowerShell `Parser::ParseFile`: no errors.
- **`node --test tools/scratch/core/unit.test.mjs tools/scratch/core/features.test.mjs`: 18/18 pass.**
  - config: merge order, frozen defaults, secrets (generated, kept, non-enumerable), csrf per load
  - data store: fallback, path escape refused, atomic writes
  - log: redaction, rotation to exactly 4 files of at most 400 B with `maxBytes` 400
  - store: ranking, flat snapshot, 50 ms batching, delete patch, copies, cache restored as `cache`/stale with conn/sleep/tracked excluded
  - queue: priority, gap of at least 38 ms with `minGapMs` 40, `clear`
  - safety
  - lan: UDP-connect discovery, NOTIFY route, `/gena/secretX` reset, upgrade routing, a TV at 127.0.0.2 refusing 127.0.0.1, disabled → null
  - sleep (expiry fallback, discard, TV off), scenes (defaults, `waitMs` honoured, failure summary, validation), tracked, macros (gaps, KEY_POWER excluded, replay timing, tampered file refused)
- **EPERM retry (`eperm-check.mjs`):** PowerShell held the target with `FileShare.None` for 300 ms. A direct rename got `EPERM`; `writeJsonAtomic` succeeded after 379 ms.
- **Stubbed end-to-end: `LUMEN_STUBS=1 node --import ./tools/scratch/core/register.mjs --test tools/scratch/core/app.test.mjs`: 7/7 pass.** A resolve hook swaps adapters, cast and ai for recording fakes. Covered:
  - hello contents and no secrets in it
  - presence → `setDemand` on adapters and features
  - key routing; INVALID, TV_OFF and NOT_PAIRED acks; malformed JSON → toast
  - volume: IP Control first, cap, UPnP then key fallback, INVALID not falling back
  - mute key fallback only when the state differs
  - Night scene with `atMost`
  - power off/on with cooldown and Wake-on-LAN
  - repeat, press and watchdog holds, plus release on disconnect
  - changedOnTv debounced 10 → 12, suppressed after our own command and across a scope change
  - Origin 403, Host 421, health, icons, upload CSRF and Origin checks, `/mcp`, static ETag/304, traversal → 404
  - AI streaming and cancel, tracked settings and labels, cast, macros through the hub, rate limit
  - stop in reverse order, idempotent; EADDRINUSE on a second start
- **Shared suite: `node --test test/*.test.js` (tests builder; real adapters + mock TV): 97/97 pass.** This includes the e2e for browser ↔ server ↔ mock, GENA → patch → changedOnTv, and power off then on via Wake-on-LAN.
- **The brief's check (`brief-verify.mjs`), real modules:** port 0, `lan.enabled:false`, TV 127.0.0.1 on closed ports.
  - Started in 53 ms; hello had 15 state keys, 59 keys, 34 settings, 16 apps, a csrf and `ai` = off.
  - `view` ack ok. `key KEY_UP` acked `TV_OFF` in 1 ms, because REST reported standby on ECONNREFUSED.
  - Origin `http://evil.example` was refused with 403.
  - Stop took 316 ms; `lumen.log` contained no secret and no csrf.
- **`index-check.mjs`** (`server/app.js` stubbed):
  - port held by Lumen → "Lumen is already running: open http://127.0.0.1:52642", exit 1
  - port held by another server → "Port 52643 is in use by another program…", exit 1
  - other startup error → "Lumen could not start: disk on fire", exit 1
  - normal start → banner printed, and a stray rejection was logged while the process stayed alive
- **start-hidden.js** from a temp copy with a fake `server/index.js`: the detached child started in the repo root with `LUMEN_CONSOLE_LEVEL=warn`, and both stdout and stderr were appended to `data/logs/stdout.log`.
