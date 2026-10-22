# Common brief for every Lumen builder

You are a builder on **Lumen Remote** in `C:/Users/pranj/source/lumen-remote`: a Node 22 (ES modules) server that controls the user's Samsung Q95T TV and serves an artistic, information-rich browser UI at `http://127.0.0.1:8790`. Runtime dependencies already installed: `ws`, `@anthropic-ai/sdk`. Do not add runtime dependencies and do not run npm commands that change `package.json` (if you truly need one, say so in your build notes).

**Read first (binding):** `docs/superpowers/specs/2026-10-21-lumen-remote-design.md` — sections 8, 9, 10 and 11 override earlier text. Also `docs/research/2026-10-21-live-findings.md`. Area research is in `docs/research/area-*.md`; read the parts relevant to you.

**File ownership:** you own ONLY the files listed in your role brief. Seven other builders are writing the other files at the same time — never create or edit files outside your list. Code against the contracts in the spec; where a detail is missing, pick the simplest reading consistent with the spec and record it in your build notes.

**Hard rules**
- Never contact the real TV (192.168.1.2) or any other LAN device; never run sdb, the Tizen emulator or app installs; never send Wake-on-LAN onto the real network. Use local stubs only.
- Never read or print `data/tv.json`, `data/ipcontrol.json`, `data/secrets.json` or any token.
- Match the spec's names exactly (state keys, commands, factory names, exports).
- Clean, modern, readable code; comments only where they help; no dead code.
- Verify your own work: `node --check` every JS file you write and exercise your module with a throwaway script under `tools/scratch/<role>/` (gitignored). Report exactly what you ran and the real results — never claim what you did not observe.
- Finish by writing `docs/build-notes/<role>.md`: files, exact exports and signatures, spec deviations or interpretations, known gaps, verification performed.

**Shared factory signatures (everyone relies on these)**

Core:
- `server/app.js` `startServer(overrides)` → `{ httpPort, lanPort, agentKey, store, hub, config, stop }`
- `server/config.js` `loadConfig(overrides)`, `createDataStore(dataDir)` → `{ readJson(name, fallback), writeJson(name, obj) }`
- `server/log.js` `createLogger({ dir })` → logger with `child(tag)` → `{ debug, info, warn, error }(msg, obj?)`
- `server/store.js` `createStore({ cachePath })` (spec §5.1 + §9.4: flat `snapshot()`, patches batched 50 ms, ranking rule)
- `server/errors.js` `class LumenError extends Error { constructor(code, message) }`
- `server/util/queue.js` `createQueue({ concurrency: 1, minGapMs })` → `{ push(fn, { priority: 'user' | 'poll' }) → Promise }`
- `server/lan.js` `createLan({ config, log })` → `{ ready, address, port, route(prefix, { request?, upgrade? }), stop }`
- `server/hub.js` `createHub({ config, data, log, store, lan, adapters, features })` → `{ handle(cmd, client), attach(client), detach(client), broadcast(msg) }`; resolves `features.ai` / `features.cast` lazily at call time
- `server/http.js` `createHttp({ ...ctx, hub, adapters, features })`: serves `web/`, `/api/health`, `/api/icon/<appId>` (`adapters.agent.getIcon`), `POST /api/cast/upload` (`features.cast.acceptUpload(req, res)`), `/mcp` (`features.ai.mcpHandler(req, res)`), WS `/live`

Adapters (`ctx = { config, data, log, store, lan }`): `createRest(ctx)`, `createRemote({ ...ctx, rest })`, `createUpnp(ctx)`, `createIpControl(ctx)`, `createAgent({ ...ctx, rest })`, `createWol(ctx)`, `createAvTransport(ctx)`, `createDial(ctx)`. Each returns `start()`, `stop()`, `setDemand({ clients, visible, views })` plus its command methods; command methods resolve `{ value? }` (the read-back) or reject with `LumenError`.

Features: `createSleep({ ...ctx, ipc, remote })`, `createScenes(ctx)` with `run(id, { hub })`, `createTracked(ctx)`, `createMacros({ ...ctx, remote })`, `createCast({ ...ctx, avtransport, dial, rest, lan })` → `{ castUrl(url), castFile(fileId, name), control(action, position), acceptUpload(req, res), start, stop, setDemand }`, `createAi({ ...ctx, hub, adapters })` (`server/ai/index.js`) → `{ ask(text, { id, emit }), cancel(id), mcpHandler(req, res), status() → { backend, ready, reason }, start, stop }`.

Method names the hub calls (implementers must provide exactly these):
- rest: `getDevice()`, `getApp(id)`, `launch(id)`, `getWakeMac()`
- remote: `click(key)`, `press(key)`, `release(key)`, `text(str, submit)`, `pointerMove(dx, dy)`, `pointerClick()`, `pair()`
- upnp: `getVolume()`, `setVolume(v)`, `getMute()`, `setMute(b)`
- ipcontrol: `get(method)`, `set(method, params)`, `setSetting(key, value)` (catalog-driven, read-back), `refresh(group)`, `power(action)` (`'on'|'off'`), `pair()`
- agent: `launch()`, `request(type, args)`, `getIcon(appId)`
- wol: `wake(mac)`
- avtransport: `setUri(uri, metadata)`, `play()`, `pause()`, `stop()`, `seek(seconds)`, `getTransportInfo()`, `getPositionInfo()`, `getMediaInfo()`, `getProtocolInfo()`
- dial: `appState(name)`, `launch(name, body)`
