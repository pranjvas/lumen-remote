# Setting up Lumen

This guide takes you from a fresh clone to a working Lumen. Part A gets a development setup running with no TV (mock TV, tests, the UI). Part B connects a real Samsung TV.

Every command and option is described in [BUILD-AND-DEPLOY.md](BUILD-AND-DEPLOY.md); this page is the order to do things in. The repo also has two Claude Code skills that walk through the same steps: `lumen-setup` (this page) and `lumen-install` (deploying changes).

---

## Part A: development setup (no TV needed)

### A1. Requirements

| Needed | Check | Notes |
|---|---|---|
| Windows 11 | | The server runs elsewhere too, but the browser, autostart and TV tooling assume Windows. |
| Node.js 22 or newer | `node --version` | `package.json` requires `>=22`. |
| Git | `git --version` | |
| Microsoft Edge | `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe` | Lumen's browser and the screenshot tool. Elsewhere: set `browser.edgePath`. |
| Claude Code, logged in (optional) | `claude --version` | For Ask Lumen. Otherwise set `ANTHROPIC_API_KEY`, or Ask Lumen stays off. |

### A2. Clone and install

```powershell
git clone https://github.com/pranjvas/lumen-remote.git
cd lumen-remote
npm ci
```

### A3. Check it works

```powershell
npm test                     # all tests run against a mock TV and fake agents
```

`test/browser-vpn.test.js` and a few tests that drive Edge can time out on a busy PC. Run those files on their own (`node --test test/browser-vpn.test.js`) before treating them as failures.

### A4. Run it against the mock TV

```powershell
npm run dev:stack            # mock TV + the real server: http://127.0.0.1:8798
node tools/dev-ui.mjs        # the UI alone with fake data: http://127.0.0.1:8799
node tools/screenshot.mjs --base http://127.0.0.1:8799   # screenshots of every view
```

`dev:stack` takes `--unpaired` (try the pairing banners), `--power standby`, `--no-agent` and `--ai fake` (a scripted Ask Lumen that never contacts Claude). Type commands on its stdin to press the "physical remote".

### A5. Rules for working in this repo

- **TV agent code (`companion/agent/*.js`) runs on Chromium 69:** ES2017 only (no `?.`, `??` or object spread). `test/agent-live.test.js` checks this.
- **The server loads `web/` at start-up:** restart after web changes and bump `CACHE` in `web/sw.js`, or phones keep the old UI.
- **`data/` holds every token and secret** and is git-ignored. Never commit it, and never print `data/secrets.json`.
- **Kill every headless Edge or Chrome you start.** Leftovers have pegged this PC at 100% CPU.
- **Parallel work goes in worktrees:** `git worktree add .claude/worktrees/<name> -b <branch> master`. The main branch is `master`.
- **Throwaway scripts go in `tools/scratch/`** (git-ignored).

---

## Part B: connecting a real TV

Tested on a Samsung **QA55Q95T** (2020, Tizen 5.5). Other Tizen TVs from 2016 on should pair. The TV agent and Lumen Eyes rely on this model's features.

### B1. Get the TV ready

1. **Same network:** the TV and the PC on the same LAN. Give the TV a fixed address (DHCP reservation) if you can.
2. **Find its address:** Settings → General → Network → Network status → IP settings.
3. **Developer mode** (only for the TV agent and Lumen Eyes): open **Apps**, type `1 2 3 4 5` on the remote, turn **Developer mode** on, enter **this PC's IP** as the host, then restart the TV (hold power until it restarts). On 2024 and later TVs, type the code in Apps → **App Settings**. Once Lumen is running and paired, **Settings → Connection → Enable developer mode** does the keys for you through Ask Lumen (no TV agent needed); you still restart the TV.

### B2. Configure and start Lumen

Create `data/config.json` (only the keys you change; the defaults are in `server/config.js`):

```json
{
  "tv": { "host": "192.168.1.2" },
  "http": { "lanAccess": true },
  "liveVideo": { "enabled": true, "maxHeight": 1080 }
}
```

- `tv.host`: the TV's address from B1.
- `http.lanAccess`: also serve the UI to phones on the LAN. There's no login (the owner's choice for a private network).
- `liveVideo.maxHeight`: `1080` ends at 1080p60 (smoothest); `2160` goes on to 4K30 (sharpest).

Start it:

```powershell
npm start                          # foreground; Ctrl+C stops it
# or, in the background (output in data/logs/stdout.log):
node tools/start-hidden.js
```

Open http://127.0.0.1:8790. `GET /api/health` should report `"ok":true`. `data/secrets.json` (the agent key) is created on the first start.

### B3. Pair (the TV owner presses Allow)

1. **Settings → Connection → Pair.** The TV asks to allow "Lumen Remote": press **Allow** with the physical remote. (`node tools/pair.mjs <tv-ip>` does the same from the command line.)
2. **Pair Samsung IP Control** from the same page if it asks (picture and sound settings, input, power).

Keys, volume, apps and casting now work. The rest needs the TV apps below.

### B4. Install the TV agent

The agent (`lumenrmt01.LumenAgent`) provides the app list, channel and inputs, Lumen's browser on the TV, live video and the TV's video player. It connects back to the PC on port 8791, and the build bakes in **this PC's address and the agent key**. So start Lumen once first (B2), and rebuild the agent whenever the PC's address changes.

Pick one of two ways:

**Option 1: Apps2Samsung (no Tizen Studio, no certificate of your own).**
1. `npm run agent:package:a2s` writes an unsigned package: `companion/build/LumenAgent-<version>-apps2samsung.wgt`.
2. Install [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung/releases), open it, pick the TV, choose **Custom WGT / TPK**, select the package, keep the default certificate, and install. On Tizen 4–6 it signs with a bundled developer certificate. On Tizen 7+ it asks you to sign in to a Samsung account.
3. Tested on the Q95T: the agent installs, connects and gets its TV privileges. One catch: a TV that has ever had the Tizen Studio build (option 2) refuses another signer for the same app, even after an uninstall (`[118, -22]`). Pick one route per TV and stay on it.

**Option 2: Tizen Studio (your own Samsung certificate).**
1. Install the Tizen Studio CLI. Create a Samsung certificate profile named `Q95T` (Certificate Manager → Samsung → TV) that includes the TV's DUID.
2. Set up WSL Ubuntu with the Tizen SDK's `sdb` (the install script's path is in [BUILD-AND-DEPLOY.md](BUILD-AND-DEPLOY.md) §1).
3. Build and install:
   ```powershell
   npm run agent:build
   wsl bash /mnt/c/Users/pranj/source/lumen-remote/tools/agent/install.sh
   ```

The two options sign differently and can't replace each other on the same TV, so choose once.

Then **Settings → Connect TV agent**. `data/logs/lumen.log` should show `agent connected {"version":…}`.

### B5. Install Lumen Eyes (optional)

Lumen Eyes (`org.lumen.eyes`) adds screen capture, Bluetooth and the TV's real memory figures. It needs the .NET 8 SDK and the Tizen Studio route:

```powershell
powershell -ExecutionPolicy Bypass -File tools\eyes\build.ps1
wsl bash /mnt/c/Users/pranj/source/lumen-remote/tools/eyes/install.sh
```

The agent starts it on the first screen capture. The log then shows `eyes connected`.

### B6. Finishing touches

- **Start at sign-in:** `powershell -NoProfile -ExecutionPolicy Bypass -File tools/install-autostart.ps1`. Add `-Remove` to undo.
- **Phones:** with `lanAccess` on, open `http://<pc-ip>:8790` on the phone.
- **VPN for Lumen's browser (optional):** Browser view → **Use a config file…** with a WireGuard `.conf`. It's stored in `data/vpn/`.
- **ffmpeg (optional):** put `ffmpeg.exe` in `data/bin/` (or on `PATH`) to convert videos the TV can't play.

### B7. Check the whole setup

| Check | Expect |
|---|---|
| `GET http://127.0.0.1:8790/api/health` | `"ok":true`, `"tv":"on"` |
| Remote view: press Home | the TV opens its home bar |
| `lumen.log` | `IP Control paired`, `GENA push is live`, `agent connected` (and `eyes connected` if installed) |
| Browser view → **On TV** a page with movement | `live video playing on the TV` in the log; the store key `tvscreen.live` shows the step and `tvFps` |
| Ask Lumen: "what's on the TV?" | an answer naming the current app or input |

Problems: see the troubleshooting table in [BUILD-AND-DEPLOY.md](BUILD-AND-DEPLOY.md) §7.
