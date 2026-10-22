# Role: agent

**Files you own:** `companion/agent/**` (Tizen web app v0.2.0: `config.xml`, `index.html`, `agent.js`, `icon.png`, `agent-config.json` generated at build time — commit an `agent-config.example.json` instead), `tools/agent/build.ps1`, `tools/agent/install.sh`, `server/adapters/agent.js`.

**Background (verified on the real TV, see live-findings):**
- The earlier probe app is `companion/probe/` (package `lumenrmt01`, app `lumenrmt01.LumenAgent`, installed as 0.1.0). Reuse the same package and app id so 0.2.0 upgrades it.
- Drop the service from `config.xml`: the service context has no TV APIs.
- Keep the privileges the probe used, minus `tv.display` and `filesystem.read` unless you need them.
- The page context has `tizen.tvaudiocontrol`, `tizen.tvwindow`, `tizen.tvchannel`, `tizen.systeminfo`, `tizen.application`, `tizen.tvinfo`, and `webapis.hybridchannelinfo`.
- `hide()` keeps it running.
- The TV runs Chromium M69: ES2017 is fine; no optional chaining, no nullish coalescing, no class fields.
- **Never put `*/` inside a block comment.**

**Build**
- `companion/agent`: spec §5.5 exactly.
  - On load, paint a small elegant "Lumen Agent · connecting to <pcHost>" card, `hide()` after 400 ms.
  - Read `agent-config.json` via XHR and connect `ws://<pcHost>:<pcPort>/agent?key=<key>` with 2/5/10/30 s backoff.
  - `hello` (agent version, pcHost, snapshot); `state` every 5 s and on change; `event` volume from `setVolumeChangeListener`.
  - Snapshot fields:
    - `source`: `tizen.tvwindow.getSource()`
    - `connected` / `disconnected`: systeminfo `VIDEOSOURCE`
    - `channel`: tvchannel `getCurrentChannel` + hybridchannelinfo `channelType`, null when not on a tuner source
    - `audio`: volume, mute, `getOutputMode`
    - `caption`: `tizen.tvinfo.getCaptionValue('CAPTION_ONOFF_KEY')` guarded
    - `build`, `panel`, `system` (cpuLoad 0–1, memAvailable/memTotal bytes via `getAvailableMemory`/`getTotalMemory`, storage bytes)
  - Requests:
    - `apps`: `getAppsInfo`, only `show:true`, minus our own id
    - `icon`: load `iconPath` into an `<img>` (`file://` path) → canvas → PNG data URL; `ok:false` on failure
    - `exit`
  - Exit after 30 min without a PC connection. Never call setters.
  - Every TV API call in try/catch so one missing API never kills the snapshot.
- `tools/agent/build.ps1` (spec §9.12):
  - Find the PC LAN address with a `UdpClient.Connect('<tv host>', 9)` trick and read the local endpoint.
  - Read or create `data/secrets.json` (same format as the core: 32-byte hex `genaSecret`, `agentKey`, `castSecret`, `mcpToken`; create only missing keys, never overwrite).
  - Write `companion/agent/agent-config.json` `{ pcHost, pcPort: 8791, key, version }`.
  - `tizen.bat build-web -out companion/build/agent -- companion/agent`.
  - `tizen.bat package -t wgt -s Q95T -- companion/build/agent` (CLI at `C:\Users\pranj\Documents\Codex\Tools\TizenStudio10\tools\ide\bin\tizen.bat`).
  - Copy to `companion/build/LumenAgent.wgt`; print the path and size.
  - The script must never print the key.
- `tools/agent/install.sh`: the WSL sdb install recipe from `tools/scratch/install-agent.sh` (check for other sdb clients first, push to `/home/owner/share/tmp/sdk_tools/tmp/LumenAgent.wgt`, `shell 0 vd_appinstall lumenrmt01.LumenAgent <path>`, show the applist entry). Do NOT run it — the orchestrator installs.
- `server/adapters/agent.js`:
  - `lan.route('/agent', { upgrade })` using a `ws` `WebSocketServer({ noServer: true })`.
  - Check `?key=` against `agentKey` with a timing-safe compare.
  - One active agent; a newer connection replaces the old one.
  - Map snapshot/state/event to store keys per §8.3 and §9.5: `src:'agent', via:'agent:<field>'`, `ttlMs` = 3 × 5 s.
  - `conn.agent` online/offline (offline 15 s after the last state).
  - Compare `hello.pcHost` / `version` with the server's lan address and expected version; publish `conn.agentNote` when a rebuild is needed.
  - `request(type, args)` with rid and 8 s timeout.
  - On `hello`, request `apps` and publish `app.installed` (merge brand colour/short from `catalog/apps.js` by id; `icon: '/api/icon/<id>'` once fetched).
  - `getIcon(appId)` → memory cache → `data/icons/<id>.png` → agent request.
  - `launch()` → `rest.launch(config.agent.appId)`, `conn.agent:'launching'` until hello or 20 s.

**Verify:**
- Run `build.ps1` locally (signing with the user's Q95T profile is allowed; installing is not) and report the WGT size.
- `node --check` the server adapter.
- Check `agent.js` parses with `new Function(src)`.
- In a scratch script, connect a fake agent WS client to a scratch `lan`-like upgrade server to exercise the adapter mapping.
