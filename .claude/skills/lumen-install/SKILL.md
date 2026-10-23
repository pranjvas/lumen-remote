---
name: lumen-install
description: Install, build, deploy or update Lumen Remote — the Node server and web UI on the Windows PC, the TV agent (lumenrmt01.LumenAgent) and Lumen Eyes (org.lumen.eyes) on the Samsung Q95T, and the VPN core. Use when asked to set up Lumen on a new PC, deploy/redeploy/restart it, install or update the TV agent or Eyes, or ship changes to the TV.
---

# Installing and deploying Lumen

The full reference is `docs/BUILD-AND-DEPLOY.md` (prerequisites, every command, troubleshooting). This skill is the procedure: decide what changed, deploy exactly that, verify it on the real TV, and leave the owner's TV as it was.

## Ground rules

- **The TV belongs to the owner, who may be using it right now.** Say before anything takes over the TV: an agent or Eyes install, a server restart while the browser is on the TV, a live test. Put their page back afterwards (`tools/restart.ps1 -KeepTvPage` does it for restarts).
- **Mute the TV during tests that play sound**, and restore the previous mute state after (hub command `mute.set {value}`).
- **Never print secrets:** `data/secrets.json`, pairing tokens, WireGuard keys or configs, the VPN endpoint, or the owner's public IP. `data/` stays out of git.
- **`sdb` is shared with the CineHD pipelines.** If `install.sh` reports another sdb client, wait. Use `LUMEN_SDB_FORCE=1` only when the owner agrees.
- **Don't leave the TV agent in debug mode;** its DevTools port is reachable from the LAN.
- **Kill every headless Edge or Chrome you start** (`taskkill /PID <pid> /T /F`). Leftovers have pegged this PC at 100% CPU before and made Lumen feel broken.

## 1. Fresh install (new PC or clean checkout)

Use the **lumen-setup** skill (`docs/SETUP.md`). This skill takes over once Lumen is set up and paired.

## 2. Deploying changes: work out what changed

```powershell
git diff --stat <last-deployed-commit>..HEAD
```

| Changed | Do |
|---|---|
| `server/**` | `npm test` (or the relevant `test/*.test.js`), then `tools/restart.ps1 -KeepTvPage` |
| `web/**` | bump `CACHE` in `web/sw.js` (`lumen-shell-vN` → N+1), then restart. Phones reload once or twice. |
| `companion/agent/**` | bump `version` in `companion/agent/config.xml`, then build and install the agent (§3) |
| `companion/eyes/**` | bump the version in `companion/eyes/tizen-manifest.xml` **and** `Version` in `Program.cs`, then build and install Eyes (§4) |
| `server/vpn/third_party/wg-core/**` | rebuild procedure in doc §5. Re-run `node tools/vpn/patch-wg-glue.cjs server/vpn/third_party/wg-core/wg-core.cjs` after every rebuild. |

Restart Lumen after agent or server changes so both sides match. The TV refuses an agent or Eyes version that isn't higher than the installed one.

## 3. TV agent

```powershell
npm run agent:build                                                      # tools/agent/build.ps1 → companion/build/LumenAgent.wgt
wsl bash /mnt/c/Users/pranj/source/lumen-remote/tools/agent/install.sh   # push + vd_appinstall + version check
```

- Rebuild when `companion/agent` changes, **and when the PC's LAN address changes**: the build bakes in the PC address and the agent key.
- After installing, the agent is stopped. Start it with the hub command `agent.connect` (Settings → Connect TV agent).
- Verify: `data/logs/lumen.log` shows `agent connected {"version":"<new>"}`.
- Agent JS runs on Chromium 69: no `?.`, `??` or other ES2020+ syntax (`test/agent-live.test.js` checks this).

## 4. Lumen Eyes

```powershell
powershell -ExecutionPolicy Bypass -File tools\eyes\build.ps1           # dotnet build + re-sign → companion/build/LumenEyes.tpk
wsl bash /mnt/c/Users/pranj/source/lumen-remote/tools/eyes/install.sh
```

Verify: trigger a capture (`screen.capture` or `GET /api/screen.png`). The log shows `eyes connected {"version":"<new>"}`.

## 5. Restart and verify

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\restart.ps1 -KeepTvPage
```

It stops the server, starts it hidden, waits for `/api/health`, and reopens the page Lumen's browser had (on the TV if it was there). Then check:

1. **Health:** `GET http://127.0.0.1:8790/api/health` → `"ok":true` and `"tv":"on"`.
2. **Links:** `lumen.log` shows the TV paired (`IP Control paired`, `GENA push is live`), `agent connected` and `eyes connected`.
3. **For browser and TV changes:**
   - **On TV** a page and capture the screen (`screen.capture`) to confirm what the TV shows.
   - For live video: `live video playing on the TV` in the log and the store key `tvscreen.live` (step, bitrate, `lagMs`).
4. **Report what you verified on the real TV**, separately from what only passed tests.

## 6. Publish

```powershell
git status                              # nothing secret staged (data/ is ignored)
git push -u origin master               # the repo's main branch is master
```

Retry a failed push up to 4 times with backoff (2, 4, 8, 16 s) when the failure is a network error.

## Troubleshooting

See the table in `docs/BUILD-AND-DEPLOY.md` §7. The most common:
- **"Edge did not start in time":** stale headless Edge, or an overloaded PC.
- **Agent offline after an install:** start it with `agent.connect`.
- **A phone shows the old UI:** the `sw.js` cache wasn't bumped.
- **Live video falls back to still frames:** see the `live video …` log lines. `tvscreen.live {on:true}` re-enables it.
