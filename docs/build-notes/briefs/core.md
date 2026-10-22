# Role: core

**Files you own:** `server/app.js`, `server/index.js`, `server/config.js`, `server/log.js`, `server/store.js`, `server/hub.js`, `server/safety.js`, `server/errors.js`, `server/util/queue.js`, `server/http.js`, `server/lan.js`, `server/features/sleep.js`, `server/features/scenes.js`, `server/features/tracked.js`, `server/features/macros.js`, `tools/start-hidden.js`, `tools/install-autostart.ps1`.

**Build**
- `config.js`: defaults from spec §8.1 + §9.2 (+ `ai: { backend: 'auto', model: 'claude-opus-5-5', effort: 'low' }`), deep merge of overrides, `createDataStore` with atomic writes (tmp + rename, retry on EPERM/EBUSY). Generate `secrets.json` on first run with 32-byte hex `genaSecret`, `agentKey`, `castSecret`, `mcpToken`. A fresh `csrf` token per process (not persisted).
- `log.js`: console + `data/logs/lumen.log`, 1 MB × 3 rotation, redaction of `token`, `AccessToken`, `Authorization`, `key=`, MAC-like and UUID-like strings.
- `store.js`: spec §5.1 with the §9.4 rules (flat snapshot, ranking, 50 ms batched patches, state-cache persistence every 10 s and on stop; restored records are `src:'cache', stale:true`).
- `util/queue.js`, `errors.js`.
- `safety.js`: key allowlist (`isAllowedKey` from `server/catalog/keys.js`), power cooldown, volume cap, per-client command rate limit (e.g. 30/s).
- `hub.js`: implement every browser command in spec §5.3, §8.5, §10 (`cast.url`, `cast.file`, `cast.control`) and §11 (`ai.ask` streams `{t:'ai', …}` events to the asking client via `features.ai.ask(text, { id, emit })`; `ai.cancel`). Validation, routing with the fallbacks in §5.3, acks with `ms`, presence → `setDemand` on every adapter and feature, the `changedOnTv` rule (§9.4), and the `hello` payload `{ t:'hello', version, state, catalog: { keys, settings, apps }, csrf, ai: features.ai?.status() }`.
  - `key`: `remote.click`
  - `hold`: the repeat/press rules in §5.3 with the `timing` values
  - `volume.set`/`volume.step`: ipc, falling back to upnp, then keys
  - `mute.set`: ipc → upnp → KEY_MUTE when the state differs
  - `power`: §3.10 (off: KEY_POWER click when `conn.tv` is on, with cooldown; on: `wol.wake(rest.getWakeMac())` + `ipc.power('on')` + KEY_POWER if the socket is up, then poll REST)
  - `app.launch`: `rest.launch`
  - `input.set`: ipc `inputSourceControl`
  - `setting.set`: catalog type `tracked` → `features.tracked`, else `ipc.setSetting`
  - `settings.refresh`: `ipc.refresh`
  - `text.send`, `pointer.*`: remote
  - `sleep.set`, `scene.*`, `macro.*`, `input.label`: features
  - `agent.connect`: `agent.launch`
  - `pair.remote`: `remote.pair`; `pair.ipcontrol`: `ipc.pair`
  - `view`: presence
- `http.js`: bind `config.http.host:port`; Host/Origin allowlist built from the bound port; CSP from §3.3; static in-memory map of `web/` (correct MIME types, `index.html` at `/`, no path traversal, ETag or no-cache); `/api/health`; `/api/icon/<appId>`; `POST /api/cast/upload` (require header `X-Lumen-CSRF` == csrf and same Origin, then delegate to `features.cast.acceptUpload`); `/mcp` → `features.ai.mcpHandler` (loopback only); WS `/live` with Host+Origin checks, JSON frames, ping/pong keepalive, and per-client send helper for the hub.
- `lan.js`: spec §9.8 — UDP-connect address discovery, bind `address:config.lan.port`, reject remote addresses other than `config.tv.host`, prefix routes, handle the NOTIFY method, upgrade routing, `ready` promise, graceful stop. If `lan.enabled` is false or the bind fails, `ready` resolves `null`.
- `app.js`: wiring exactly as §8.2, plus `const avtransport = createAvTransport(ctx); const dial = createDial(ctx);`, `features.cast = createCast({ ...ctx, avtransport, dial, rest, lan })`, then after the hub `features.ai = createAi({ ...ctx, hub, adapters })`. `adapters = { rest, remote, upnp, ipc, agent, wol, avtransport, dial }`. Seed `app.installed` from `catalog/apps.js` (`src:'derived'`). Start adapters and features, return the handle in §9.2, and stop everything cleanly in reverse order.
- `index.js`: `startServer()`, a clear console banner with the URL, SIGINT/SIGTERM graceful stop, and exit code 1 with a friendly message if port 8790 is already in use ("Lumen is already running").
- Features:
  - sleep: persisted countdown in `sleep.json`; at expiry `ipc.set('powerControl', { power: 'powerOff' })`, falling back to `remote.click('KEY_POWER')` when `conn.tv` is on; state key `sleep`.
  - scenes: CRUD in `scenes.json` and `run(id, { hub })` executing steps through `hub.handle` with `waitMs`; ship two default scenes, "Night" (backlight 4, volume ≤ 8) and "Cinema" (picture mode Movie, backlight 8, local dimming High), created only when `scenes.json` is absent.
  - tracked: catalog entries of type `tracked` plus `input.labels`, persisted in `tracked.json`, published with `src:'tracked', via:'user'`.
  - macros: record/replay (`gapMs` clamped to at least 150 ms), persisted in `macros.json`.
- `tools/start-hidden.js`: spawn `node server/index.js` detached, `windowsHide`, logs appended to `data/logs/stdout.log`. `tools/install-autostart.ps1`: create a Startup-folder shortcut running `node tools/start-hidden.js` in the repo, plus `-Remove` to delete it. Do NOT run it.

**Verify:** start the server on port 0 with `lan.enabled:false` and TV host 127.0.0.1 (adapters may be stubbed in your scratch script if theirs are not there yet). Connect a WS client to `/live`, receive `hello`, send a `view` and a `key` command, and confirm a rejected Origin gets 403.
