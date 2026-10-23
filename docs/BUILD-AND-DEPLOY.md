# Building and deploying Lumen

Lumen has four parts. Each builds and deploys on its own:

| Part | Where it runs | Source | Deployed by |
|---|---|---|---|
| **Server + web UI** | Windows PC (Node) | `server/`, `web/` | restarting the server |
| **TV agent** (`lumenrmt01.LumenAgent`, web app) | the TV | `companion/agent/` | `tools/agent/build.ps1` + `tools/agent/install.sh` |
| **Lumen Eyes** (`org.lumen.eyes`, Tizen .NET) | the TV | `companion/eyes/` | `tools/eyes/build.ps1` + `tools/eyes/install.sh` |
| **VPN core** (WireGuard in WebAssembly, from CineHD) | the PC, inside the server | `server/vpn/third_party/wg-core/` | rebuilt rarely; ships with the server |

The paths below are this PC's. Adjust them if your tools live elsewhere. For a first-time setup in order (development setup, then the TV), start with [SETUP.md](SETUP.md).

---

## 1. Prerequisites

**On the PC (Windows 11):**
- **Node.js 22+** and npm.
- **Microsoft Edge** at `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe` (Lumen's browser). Set `browser.edgePath` in `data/config.json` if it lives elsewhere.
- **Claude Code**, logged in, for Ask Lumen. Without it, set `ANTHROPIC_API_KEY` to use the API instead, or Ask Lumen stays unavailable.
- **ffmpeg** (optional; converts videos the TV can't play). Lumen looks in `data/bin/ffmpeg.exe`, then `PATH`, WinGet, Stremio's folder and Jellyfin's.
- For the TV parts:
  - **Tizen Studio CLI**: `C:\Users\pranj\Documents\Codex\Tools\TizenStudio10\tools\ide\bin\tizen.bat`.
  - **A Samsung certificate profile** named `Q95T`, holding an author and a distributor certificate that includes the TV's DUID. Create it with Tizen Studio's Certificate Manager (Samsung certificate, TV, add the TV's DUID).
  - **.NET 8 SDK**, for Lumen Eyes.
  - **WSL Ubuntu** with the Tizen SDK's `sdb` at `/home/pv/cinehd-emulator-tests/linux55-20261008-offline-a/sdk/tools/sdb`. The install scripts use this one, because the Windows `sdb` can hang on a stale relay.

**On the TV:**
- **Developer mode on.** Open Apps, type `1 2 3 4 5` on the remote, switch Developer mode **On**, enter this PC's IP as the host, then restart the TV.
- **Same network as the PC.** The TV's address goes in `data/config.json` → `tv.host` (default `192.168.1.2`).

---

## 2. The server and web UI

### First install

```powershell
cd C:\Users\pranj\source\lumen-remote
npm ci
npm start                          # foreground; Ctrl+C stops it
```

Open http://127.0.0.1:8790, then:
1. **Settings → Connection → Pair** (remote channel). Press **Allow** on the TV with the physical remote. `node tools/pair.mjs <tv-ip>` does the same from the command line.
2. **Pair Samsung IP Control** from the same page, if it asks.
3. **Connect TV agent** once the agent is installed (section 3).

Everything Lumen keeps lives in `data/` (git-ignored): `config.json`, `tv.json` and `ipcontrol.json` (pairing tokens), `secrets.json` (the agent key), `vpn/` (the WireGuard config uploaded in the Browser view), the browser profile, AI threads, learned app skills, and logs.

### `data/config.json`, the useful keys

```json
{
  "tv": { "host": "192.168.1.2" },
  "http": { "lanAccess": true },
  "liveVideo": { "enabled": true, "maxHeight": 1080 },
  "browser": { "maxFps": 24 },
  "ai": { "backend": "auto" }
}
```

- **`http.lanAccess`**: also serve the UI to phones on the LAN. There's no login (owner's choice).
- **`liveVideo.enabled`**: `false` turns the browser's live video on the TV off; still frames are the fallback.
- **`liveVideo.maxHeight`** and **`liveVideo.maxFps`**: live video starts at 1080p30, then tries 1080p60 and then 4K30, each after 30 quiet seconds (`probeAfterSec`). A step that has trouble is dropped for that session. `maxHeight: 2160` allows 4K; the default 1080 stops at 1080p60, the smoothest option. `maxFps: 30` stays at 30 fps. Measured on the Q95T: 1080p60 AVC at 12 Mbit/s decodes at 58–61 fps; 4K30 HEVC at 20 Mbit/s decodes at 28–31 fps. Both run about 0.5–0.7 s behind live.
- All the defaults are in `server/config.js`.

### Run at sign-in

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/install-autostart.ps1          # add
powershell -NoProfile -ExecutionPolicy Bypass -File tools/install-autostart.ps1 -Remove  # remove
```

The shortcut runs `node tools/start-hidden.js`, which starts the server with no window and appends its output to `data/logs/stdout.log`. The server runs at above-normal priority.

### Deploying server or web changes

The server reads `web/` into memory when it starts, so **any change to `server/` or `web/` needs a restart**:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\restart.ps1 -KeepTvPage   # stop, start hidden, wait for health, reopen the page (on the TV if it was there)
```

Or by hand:

```powershell
# stop the running server
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'lumen-remote\\server\\index.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# start it again, hidden
node tools/start-hidden.js
# check
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8790/api/health | Select-Object -Expand Content
```

- **Changes in `web/`:** bump `CACHE` in `web/sw.js` (`'lumen-shell-vN'`). Otherwise phones keep the old app; they pick up the new one after reloading once or twice.
- **What a restart interrupts:** it closes Lumen's browser and the TV screen. Reopen **On TV** afterwards. The TV agent and Eyes reconnect by themselves.

---

## 3. The TV agent (`companion/agent`)

The agent is a Tizen web app. It reads TV state, runs the browser screen, and plays live video and handed-off streams. It connects back to the PC on port 8791 with the key from `data/secrets.json`.

**Rebuild and reinstall it** when its code changes, or when the PC's LAN address changes (the address is baked into the build).

1. **Bump the version** in `companion/agent/config.xml` (`<widget … version="0.8.2">`). The TV refuses a version that isn't higher than the installed one.
2. **Build and sign.** This writes `companion/agent/agent-config.json` (PC address, port, key, version) and produces `companion/build/LumenAgent.wgt`:
   ```powershell
   npm run agent:build             # = tools/agent/build.ps1, signs with the Q95T profile
   ```
3. **Install** through WSL's `sdb`. The script connects to the TV, pushes the package, installs it, and checks the installed version:
   ```powershell
   wsl bash /mnt/c/Users/pranj/source/lumen-remote/tools/agent/install.sh
   ```
   - It stops if another `sdb` client is busy (the CineHD pipelines share the connection). `LUMEN_SDB_FORCE=1` skips that check.
   - `LUMEN_TV=<ip>:26101` targets another TV.
4. **Start it:** Settings → **Connect TV agent**, or the hub command `agent.connect`. `data/logs/lumen.log` should show `agent connected {"version":"0.8.2"}`.

Rules for agent code: the TV's engine is Chromium 69, so **no `?.`, `??` or other ES2020+ syntax** in `companion/agent/*.js`. `test/agent-live.test.js` guards this. Don't leave the agent in debug mode: its DevTools port is reachable from the LAN.

### Installing with Apps2Samsung (no Tizen Studio, no certificate profile)

[Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung) (MIT, Windows/macOS/Linux/Android) installs any `.wgt` on a Samsung TV. It re-signs the package itself: on Tizen 4.x–6.x (the Q95T is 5.5) with a bundled Tizen developer certificate and no sign-in; on Tizen 7+ with a Samsung certificate it creates after a Samsung-account sign-in. The TV still needs **Developer mode on, pointing at the machine that runs Apps2Samsung**.

1. **Package** (unsigned; no Tizen Studio needed). Writes `companion/build/LumenAgent-<version>-apps2samsung.wgt`:
   ```powershell
   npm run agent:package:a2s       # = tools/agent/package-apps2samsung.ps1 [-DataDir <data folder>]
   ```
   It bakes in this PC's address and the agent key from `data/secrets.json` (read only, never created), like `build.ps1`. **The file is a personal build: don't publish it.**
2. **Install:** open Apps2Samsung, pick the TV, choose **Custom WGT / TPK**, select the `.wgt`, and install. Leave the certificate on its default.
3. **Start it** as in step 4 above.

Things to know:
- **Tested on the Q95T (23 Oct 2026).** Signed with Apps2Samsung's bundled certificate, the agent installs, runs and connects. It reads the channel, firmware, audio output, inputs and app list, so the TV grants it the privileges it declares.
- **A TV that already had a `Q95T`-signed agent can't switch.** The TV keeps the package id `lumenrmt01` bound to the certificate it was first installed with. Even after an uninstall, a copy signed by anyone else fails with `install failed[118, -22] … Security error : :Invalid function parameter was given:<2>`. Only a Smart Hub reset clears that, or a build with another package id. So Apps2Samsung suits a TV that never had the Tizen Studio build; on this TV, keep using `install.sh`. Going the other way would hit the same wall.
- **One sdb host at a time.** Apps2Samsung talks to the TV's sdbd itself and stops a Tizen Studio `sdb` server it finds on the same PC. Don't run it while `install.sh` or a CineHD pipeline is using the TV.
- The version rule still applies: bump `config.xml` before each new build.
- If the agent is ever given a Partner privilege (`vpnservice`, `drminfo`, `*.partner`) or `on-boot="true"`, Apps2Samsung needs a Partner certificate. The script refuses such a `config.xml`.

---

## 4. Lumen Eyes (`companion/eyes`)

A windowless Tizen .NET app that captures the screen (through `libdisplay-capture-api`), reads Bluetooth and reports memory. The agent launches it with the PC's address; it connects to `ws://<pc>:8791/eyes`.

1. **Bump the version** in both `companion/eyes/tizen-manifest.xml` and `const string Version` in `companion/eyes/Program.cs`.
2. **Build and sign.** This runs `dotnet build -c Release` (Tizen.NET.Sdk from NuGet), re-signs with the `Q95T` profile, and produces `companion/build/LumenEyes.tpk`:
   ```powershell
   powershell -ExecutionPolicy Bypass -File tools\eyes\build.ps1
   ```
3. **Install:**
   ```powershell
   wsl bash /mnt/c/Users/pranj/source/lumen-remote/tools/eyes/install.sh
   ```
4. **Check:** the next screen capture (Screen view, or `GET /api/screen.png`) starts it. The log shows `eyes connected {"version":…}`.

---

## 5. The VPN core (rarely)

`server/vpn/third_party/wg-core/` is CineHD's WireGuard + lwIP core, compiled to WebAssembly. Lumen ships it pre-built; rebuild it only to change its limits (DNS table, TCP timers, stream counts).

1. **Get the sources** into a scratch folder with `git archive` from the CineHD repo, at the commit recorded in `server/vpn/third_party/NOTICE.md`. **Never edit the CineHD checkout itself.**
2. **Apply Lumen's `lwipopts.h` / mux changes**, all listed in NOTICE.md.
3. **Build** with the Samsung Emscripten SDK **1.39.4.7 (fastcomp)**:
   ```
   node work/wg-tunnel/wasm/build.cjs --target node
   ```
4. **Copy the outputs** to `server/vpn/third_party/wg-core/`.
5. **Re-apply Lumen's glue patch.** It's required after every rebuild: it turns the glue's busy-wait `poll` into a blocking one.
   ```powershell
   node tools/vpn/patch-wg-glue.cjs server/vpn/third_party/wg-core/wg-core.cjs
   ```
6. **Record the new hashes** in NOTICE.md and run `node --test test/vpn.test.js test/browser-vpn.test.js`.

The VPN configuration itself is uploaded in the Browser view (**Use a config file…**) and stored in `data/vpn/`. Never commit it.

---

## 6. Release checklist

1. `npm test`. Everything should pass. `browser-vpn` and a few Edge-driven tests can time out on a loaded PC; re-run those files on their own.
2. If `companion/agent` changed: bump the version, build, install (section 3).
3. If `companion/eyes` changed: bump both version strings, build, install (section 4).
4. If `web/` changed: bump `CACHE` in `web/sw.js`.
5. Restart the server (section 2) and check `/api/health`.
6. On the TV:
   - **Connect TV agent**, then **On TV** a page.
   - Check `lumen.log` for `agent connected`, `eyes connected`, and (for live video) `live video playing on the TV`.
   - Watch the store key `tvscreen.live` for the step, bitrate and lag.
7. `git push -u origin master`.

---

## 7. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| "Lumen is already running" | Another server holds port 8790. Stop it (section 2) or use that one. |
| Browser view: "Microsoft Edge did not start in time" | A leftover Edge still holds `data/browser-profile`, or the PC is overloaded. Lumen kills strays and retries once; otherwise press **Retry**. Check for leftover headless Edge or Chrome from test tools. |
| TV agent offline | The TV closed it (memory, or another app in front). Use **Connect TV agent**. After reinstalling, it has to be started again. |
| Eyes "did not connect" | Eyes was reinstalled or the TV restarted. The next capture relaunches it; check that the agent is online first. |
| Live video falls back to still frames | The TV stopped reporting, or the agent dropped. See the `live video …` lines in `lumen.log`. `tvscreen.live {on:true}` clears the record of agent drops. `liveVideo.enabled:false` turns it off. |
| Phone shows an old UI | Bump `CACHE` in `web/sw.js`, restart the server, and reload the phone twice. |
| `install.sh` says another `sdb` client is active | A CineHD pipeline is using the TV. Wait, or set `LUMEN_SDB_FORCE=1`. |
| High CPU on the PC | Usually leftover headless Edge or Chrome from test or screenshot runs. End the ones whose profile is under `%TEMP%`. |
| `restart.ps1` reports healthy, but the old server keeps running (same pid) | That server was started from an elevated (administrator) session, so a normal one can't stop it ("Access is denied"). Stop it from an elevated PowerShell, or restart from the same kind of session that started it. |
| Agent install fails with `[118, -22]` | The package id is bound to another signing certificate on this TV (see *Installing with Apps2Samsung*). Use the same signer as the first install. |
