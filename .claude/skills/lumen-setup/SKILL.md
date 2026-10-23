---
name: lumen-setup
description: Set up the Lumen Remote repo from scratch: a development environment on a new machine (Node, npm ci, tests, mock-TV dev stack), and first-time connection to a real Samsung TV (config, pairing, TV agent via Apps2Samsung or Tizen Studio, Lumen Eyes, autostart). Use when asked to set up, bootstrap or onboard Lumen, get a clone running, or connect Lumen to a TV for the first time. For deploying later changes, use lumen-install.
---

# Setting up Lumen

The reference is `docs/SETUP.md` (Part A: development, Part B: real TV). Every command and option is in `docs/BUILD-AND-DEPLOY.md`. This skill is the procedure: check each step's result before going on, and finish with the checks in SETUP.md B7. "Set up" means a working, verified install, not a list of commands.

## Ground rules

- **Steps on the TV need the owner.** They press **Allow** to pair, turn on developer mode, and may be using the TV. Ask once, at the start, for everything the setup will need on the TV: pairing the remote channel, pairing IP Control, installing the agent and Eyes.
- **Secrets:** never print `data/secrets.json`, pairing tokens, VPN configs or certificate passwords. Don't commit `data/`. The agent packages (`companion/build/*.wgt`) contain the agent key: they stay on this PC.
- **Signing certificates are the owner's.** Don't create, import or switch Tizen certificate profiles, or sign with third-party certificates (including Apps2Samsung's bundled one), without the owner explicitly asking. Apps2Samsung is a GUI: the owner runs it; you build the package and verify afterwards.
- **`sdb` is shared with the CineHD pipelines.** If `install.sh` reports another sdb client, wait.
- **Mute the TV for tests that play sound**, and restore its mute state afterwards.
- **Kill every headless Edge or Chrome you start.**

## Part A: development environment

1. **Requirements:** `node --version` (22 or newer), `git --version`, and Edge at its default path (or `browser.edgePath`). Claude Code logged in, or `ANTHROPIC_API_KEY`, is needed only for Ask Lumen.
2. **Install:** `npm ci` in the repo root.
3. **Tests:** `npm test`. Re-run a file that times out (`browser-vpn`, Edge-driven ones) on its own before calling it a failure. Report the pass and fail counts.
4. **Smoke run:** `npm run dev:stack` (mock TV + real server on :8798). Check `GET http://127.0.0.1:8798/api/health`, then stop it. Optionally run `node tools/dev-ui.mjs` (:8799) and `node tools/screenshot.mjs --base http://127.0.0.1:8799`.
5. **Tell the user the repo rules** from SETUP.md A5, the ones that bite: ES2017 only in `companion/agent`; restart and bump `web/sw.js` CACHE after web changes; `data/` stays private; worktrees for parallel work; the main branch is `master`.

## Part B: first connection to a real TV

1. **TV address and developer mode:** ask the owner for the TV's IP, or find it from a running Lumen's log or the router. Don't scan or inspect their network settings. Developer mode is needed only for the agent and Eyes (SETUP.md B1).
2. **Config:** create `data/config.json` with `tv.host` and, if phones should reach it, `http.lanAccess: true`. Keep any existing keys.
3. **Start:** `node tools/start-hidden.js`, or `powershell -NoProfile -ExecutionPolicy Bypass -File tools\restart.ps1` if Lumen already runs. Wait for `/api/health` → `"ok":true`. Only one copy can run (port 8790).
4. **Pair:** the owner presses **Allow** on the TV for Settings → Connection → **Pair**, then IP Control. Verify with `lumen.log` (`IP Control paired`, `GENA push is live`) and one harmless key such as `KEY_INFO`.
5. **TV agent:** pick the route with the owner (SETUP.md B4).
   - **Apps2Samsung:** run `npm run agent:package:a2s`. Give the owner the package path and the four Apps2Samsung steps. After they install it, run `agent.connect` and verify.
   - **Tizen Studio:** run `npm run agent:build`, then `wsl bash /mnt/c/Users/pranj/source/lumen-remote/tools/agent/install.sh`. If the TV already has the other route's build, it must be uninstalled first; that clears the agent's stored data, so ask.
   - **Verify:** `agent connected {"version":"<config.xml version>"}` in `lumen.log`.
6. **Lumen Eyes (optional):** `tools\eyes\build.ps1` + `tools/eyes/install.sh`. Verify with `screen.capture` and `eyes connected` in the log.
7. **Optional extras:** autostart (`tools/install-autostart.ps1`), the phone URL, ffmpeg in `data/bin/`. The VPN config is uploaded by the owner in the Browser view; never handle the file yourself.
8. **Final check:** run the table in SETUP.md B7 and report it, keeping what you verified on the real TV separate from what only passed tests. Put the TV back as it was: the page the owner had, and their mute state.

## When something fails

Use `docs/BUILD-AND-DEPLOY.md` §7. The usual causes:
- **"Edge did not start in time":** leftover headless Edge.
- **Agent offline after an install:** start it with `agent.connect`.
- **The TV refuses the Apps2Samsung build:** use the Tizen Studio route.
- **Live video falls back to still frames:** check the `live video …` lines in `lumen.log`.
