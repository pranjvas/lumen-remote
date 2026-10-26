# Lumen auto-updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Lumen copy (a git clone on Windows) finds new releases (`vX.Y.Z` tags made by `npm run release`), applies them when Lumen is idle, restarts, and rolls back if the new version does not start; Settings shows and controls it; newer TV apps are installed where the TV tooling exists.

**Architecture:** A small git layer (`server/update/git.js`) and version helpers feed an `updater` feature that checks on a schedule, publishes `update.status`, waits for idle and hands the actual swap to a detached helper (`tools/update-apply.js`) that stops nothing itself: the server shuts down, the helper fast-forwards, reinstalls if needed, starts Lumen, checks health and rolls back on failure, writing `data/update/state.json`. A release script tags and publishes; a TV-apps module compares versions and installs or advises.

**Tech Stack:** Node 22 ESM (no new dependencies), git CLI, npm CLI, PowerShell build scripts for the TV apps, Windows `sdb.exe`, node:test.

**Spec:** `docs/superpowers/specs/2026-10-26-auto-updater-design.md`

## Global Constraints

- Node 22, Windows 11; no new npm dependencies.
- Release tags are exactly `vX.Y.Z`; a tag counts only if `package.json` at that tag has version `X.Y.Z`.
- Only branch `master` is ever moved, only by fast-forward; never with uncommitted changes to tracked files; never downgrade.
- Checks: at start-up after 60 s, then every 6 h; idle must hold for 2 min before applying; health wait 60 s.
- Git runs with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `windowsHide: true`; Lumen stores no tokens.
- Files: `data/update/settings.json` (`{ auto: boolean }`, default on), `data/update/state.json`, log `data/logs/update.log`.
- Tests never touch the real repo or the network: throwaway local repos only.

## Review Focus

1. **Not a git copy / git missing** (a zip download, later distribution): status "left alone: not a git copy", never a crash or a loop. → test in Task 2.
2. **Offline or no GitHub access** (credential missing): "could not check: …" with no prompt window and no retry storm. → test in Task 2 (fetch fails against a missing remote).
3. **Old server never exits** (stuck shutdown): the helper must not start a second server or move the branch; it gives up after 30 s and records a failure. → test in Task 4.
4. **`npm ci` fails** (network) during an update: roll back to the previous commit and start the previous version. → test in Task 4.
5. **Helper interrupted** (PC switched off mid-update): next start sees a stale `applying` state older than 10 min and records it as failed instead of showing "updating" forever. → test in Task 3.

---

### Task 1: Versions and the git layer

**Files:**
- Create: `server/update/versions.js`, `server/update/git.js`
- Test: `test/update-git.test.js`

**Interfaces:**
- Produces:
  - `parseVersion(s) → [major, minor, patch] | null`, `compareVersions(a, b) → -1|0|1`, `tagFor(version) → 'vX.Y.Z'` (versions.js)
  - `createGit({ cwd, run? }) → { isRepo(), branch(), isDirty(), head(), fetchTags(), releaseTags(), versionAt(tag), isAncestor(a, b), commitOf(tag), changed(a, b, path), fastForward(tag), resetHard(sha) }` (git.js; all async; `run(args) → { code, stdout, stderr }` defaults to spawning `git` with the env above)
  - `releaseTags()` → `[{ tag, version }]` sorted newest first, only tags whose `versionAt(tag)` equals the tag's version.

- [ ] **Step 1: Write the failing tests** (`test/update-git.test.js`) building a bare "origin" and a clone in `os.tmpdir()`:
  - `compareVersions('0.10.0', '0.9.9') === 1`; `parseVersion('v1.2')` is `null`.
  - after tagging `v0.2.0` on a commit whose package.json says `0.2.0` and `v0.3.0` on a commit that still says `0.2.0`: `releaseTags()` returns only `[{ tag: 'v0.2.0', version: '0.2.0' }]`.
  - deleting `v0.2.0` in origin then `fetchTags()` → `releaseTags()` is empty (prune works).
  - `isDirty()` true after editing a tracked file, false with only an untracked file.
  - `branch()` returns `'master'`; after `git checkout --detach` returns `null`.
  - `isAncestor(head, tagCommit)` true when the tag is ahead, false when the clone has its own extra commit.
  - `fetchTags()` against a removed origin path rejects with an error whose message is shown (Review Focus 2); `createGit({ cwd: emptyDir }).isRepo()` is false (Review Focus 1).
- [ ] **Step 2: Run** `node --test test/update-git.test.js` — expect FAIL (modules missing).
- [ ] **Step 3: Implement** versions.js and git.js. `fetchTags` = `fetch --tags --prune --prune-tags origin`; `versionAt(tag)` = `git show <tag>:package.json` parsed; `fastForward(tag)` = `merge --ff-only <tag>`.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Commit** `git add server/update test/update-git.test.js && git commit -m "Updater: versions and git layer"`.

### Task 2: The updater feature — checking and status

**Files:**
- Create: `server/features/updater.js`
- Modify: `server/app.js` (create `features.updater = createUpdater({ ...ctx, features })`), `server/hub.js` (commands below)
- Test: `test/updater.test.js`

**Interfaces:**
- Consumes: Task 1 `createGit`, `compareVersions`, `VERSION` from `server/config.js`.
- Produces: `createUpdater({ config, data, log, store, features, requestExit, git?, spawnHelper?, now? }) → { start(), stop(), check(), applyNow(), setAuto(on), status() }`.
  - Store key `update.status` = `{ current, latest, state, reason, checkedAt, auto, failed? }` where `state` ∈ `'idle'|'checking'|'up-to-date'|'available'|'waiting'|'applying'|'updated'|'failed'|'left-alone'|'unreachable'`.
  - Hub: `update.check` → `check()`; `update.apply` → `applyNow()`; `update.setAuto { on: boolean }` → `setAuto(on)`.
- [ ] **Step 1: Write the failing tests** with a fake git object (no real repo):
  - newer valid release, clean master, ancestor → state `'available'`, `latest: '0.3.0'`.
  - dirty → `'left-alone'`, reason `'local changes'`; branch `'dev'` → reason `'on branch dev'`; not ancestor → `'ahead of the release'`; `isRepo()` false → `'not a git copy'`.
  - fetch throws `Error('Authentication failed')` → `'unreachable'` with that reason; `check()` resolves (does not throw) — Review Focus 2.
  - same version as running → `'up-to-date'`.
  - `setAuto(false)` writes `data/update/settings.json` `{ auto: false }` and is reflected in `update.status.auto`.
  - hub `update.check` returns the status; `update.setAuto` rejects a non-boolean.
- [ ] **Step 2: Run** `node --test test/updater.test.js` — expect FAIL.
- [ ] **Step 3: Implement** checking, the 60 s / 6 h timers (`.unref()`), settings file, status publishing; wire into app.js and hub.js.
- [ ] **Step 4: Run** the test — PASS; run `node --test test/integration.test.js` — still PASS.
- [ ] **Step 5: Commit** "Updater: checking for releases, status, hub commands".

### Task 3: Applying — idle gate, hand-off to the helper, outcome after restart

**Files:**
- Modify: `server/features/updater.js`, `server/app.js` (passes `requestExit: () => process.emit('lumen:exit-for-update')`), `server/index.js` (on `'lumen:exit-for-update'` runs the same graceful `shutdown()` as Ctrl+C, then exits 0)
- Test: `test/updater.test.js` (more cases)

**Interfaces:**
- Consumes: store keys `tvscreen.on`, `tvscreen.video`, `tvscreen.live`, `browser.incognito`, and `features.ai.busy?.()` (add a `busy()` returning whether an Ask Lumen run is active, if absent).
- Produces: `data/update/state.json` = `{ phase: 'applying'|'updated'|'failed', from, to, toVersion, at, error? }`; `spawnHelper(plan)` default spawns `node tools/update-apply.js <dataDir>` detached, hidden, then requests exit.
- [ ] **Step 1: Write the failing tests:**
  - available + auto on + idle for 2 min (fake clock) → `spawnHelper` called once with `{ from: head, to: 'v0.3.0', toVersion: '0.3.0' }` and `state.json.phase === 'applying'`.
  - `tvscreen.on === true` → stays `'waiting'`, no spawn; becomes idle → spawn only after 2 min of idle.
  - auto off → stays `'available'`; `applyNow()` spawns at once even when not idle.
  - at start-up, `state.json` `{ phase: 'updated', toVersion: '0.3.0' }` → status `'updated'`; `{ phase: 'failed', toVersion: '0.3.0', error }` → `'failed'` and a later check does not auto-apply 0.3.0 again (but `applyNow()` does).
  - stale `{ phase: 'applying', at: now − 11 min }` at start-up → `'failed'`, error mentions "interrupted" (Review Focus 5).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the idle watcher (re-evaluated on store patches and every 30 s), the plan write, the spawn and exit request; outcome read at `start()`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** "Updater: apply when idle through the update helper".

### Task 4: The update helper with rollback

**Files:**
- Create: `tools/update-apply.js`
- Test: `test/update-apply.test.js`

**Interfaces:**
- Consumes: `createGit` (Task 1); `state.json` plan from Task 3.
- Produces: CLI `node tools/update-apply.js <dataDir> [--repo <dir>] [--port <n>] [--start "<cmd>"] [--npm "<cmd>"]` (overrides for tests); exit code 0 on success or successful rollback, 1 if even the rollback failed. Writes `state.json` phase `'updated'` or `'failed'` and appends to `<dataDir>/logs/update.log`.
- [ ] **Step 1: Write the failing tests** using a temp repo whose "server" is a tiny script listening on a test port and answering `/api/health` with `{ ok: true, version }`:
  - happy path: helper waits for port free, fast-forwards to v0.3.0, skips npm (lockfile unchanged — fake npm records calls), starts the new server, health OK → `phase 'updated'`, branch at the tag.
  - lockfile changed → fake npm called with `ci`.
  - release whose server exits at once → no health in the wait (test uses 3 s) → branch back at `from`, previous server started and healthy, `phase 'failed'`, error names the health timeout.
  - fake npm failing → rollback as above (Review Focus 4).
  - old server still answering after the exit wait (test uses 2 s) → branch not moved, no second server started, `phase 'failed'`, error "Lumen did not stop" (Review Focus 3).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; production defaults: exit wait 30 s, health wait 60 s, start = `node tools/start-hidden.js`, npm = `npm ci --no-audit --no-fund` (via `npm.cmd` on Windows), port from `data/config.json` or 8790.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** "Updater: helper that applies a release and rolls back".

### Task 5: Release script

**Files:**
- Create: `tools/release.mjs`
- Modify: `package.json` (`"release": "node tools/release.mjs"`)
- Test: `test/release.test.js`

**Interfaces:**
- Produces: `node tools/release.mjs <version> [--notes "text"] [--dry-run] [--repo <dir>] [--no-github]` and `node tools/release.mjs --withdraw <version> [--dry-run] [--repo <dir>] [--no-github]`.
- [ ] **Step 1: Write the failing tests** on a temp repo with a bare origin (`--no-github`):
  - `0.2.0` from `0.1.0` → package.json and package-lock.json say 0.2.0, commit "Release v0.2.0", annotated tag `v0.2.0` pushed to origin, master pushed.
  - refusals (exit 1, nothing changed): dirty tree, not on master, behind origin/master, version not higher (`0.1.0` again, `0.0.9`), malformed `1.2`.
  - `--dry-run` prints the steps and leaves the repo and origin untouched.
  - `--withdraw 0.2.0` removes `v0.2.0` from origin.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; notes default to `git log --format=- %s <previousTag>..HEAD`; GitHub step = `gh release create vX --title vX --notes-file <tmp>` / `gh release delete vX --yes`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** "Release script: npm run release / --withdraw".

### Task 6: Settings → Updates

**Files:**
- Modify: `web/js/views/settings.js` (a GROUP `{ id: 'updates', title: 'Updates', short: 'Updates' }` and `updateRows(ctx, scope)`), `web/css/views.css` if needed, `web/sw.js` (cache v32), `tools/dev-ui.mjs` (fake `update.*` commands and an `update.status` value)
- Test: `tools/scratch/updates-check.mjs` (headless phone check against dev-ui, like `tvplayback-check.mjs`)

**Interfaces:**
- Consumes: `update.status` (Task 2/3), hub `update.check`, `update.apply`, `update.setAuto`, `update.tvApps` (Task 7).
- [ ] **Step 1: Write the check script:** with dev-ui state `{ current: '0.2.0', latest: '0.3.0', state: 'available', auto: true, checkedAt }` the Updates section shows "0.2.0", "0.3.0 available", an "Update now" button and a switch; tapping "Check now" sends `update.check`; toggling sends `update.setAuto { on: false }`; state `'left-alone'` with reason shows the reason and no "Update now"; state `'failed'` shows the error and a "Try again" button that sends `update.apply`.
- [ ] **Step 2: Run** `node tools/scratch/updates-check.mjs` with `node tools/dev-ui.mjs` running — FAIL.
- [ ] **Step 3: Implement** the rows (labels per the spec's state list) and the dev-ui fakes.
- [ ] **Step 4: Run** — ALL PASS; `node --test test/web-build.test.js` PASS.
- [ ] **Step 5: Commit** "Settings: Updates (version, status, automatic switch, check and update now)".

### Task 7: TV apps after an update

**Files:**
- Create: `server/update/tvapps.js`, `tools/tvapp-install.ps1` (build with `tools/agent/build.ps1 -TizenCli <found>` or `tools/eyes/build.ps1`, then Windows sdb push + `vd_appinstall` + `vd_applist` version check)
- Modify: `server/features/updater.js` (publish `update.tvApps`, run installs when idle)
- Test: `test/update-tvapps.test.js`

**Interfaces:**
- Consumes: repo versions from `companion/agent/config.xml` (`version="…"`) and the Eyes manifest; connected versions from the agent/eyes adapters (`agent connected {version}`; add `version()` getters if missing).
- Produces: `findTooling(env) → { tizenCli, sdb } | null` (looks in `config.tvTooling`, then `C:\tizen-studio`, `%USERPROFILE%\tizen-studio`, the owner's `Documents\Codex\Tools\TizenStudio10`); `tvAppUpdates({ repo, connected }) → [{ app: 'agent'|'eyes', from, to }]`; store `update.tvApps = { updates, tooling: boolean, installing?, lastResult? }`.
- [ ] **Step 1: Write the failing tests:** repo agent 0.9.5 vs connected 0.9.4 → one update; equal → none; unknown connected → none (do not install blind); `findTooling` with a fake fs returns null when neither tizen.bat nor sdb.exe exists; updater with tooling null publishes the update without trying to install; with tooling and idle runs the injected installer once per version.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; after a successful agent install call `agent.connect` through the hub path used by Settings.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** "Updater: TV apps (install when the tooling is here, else advise)".

### Task 8: Docs, full suite, first release

**Files:**
- Modify: `docs/SETUP.md` (updates section: automatic, Settings → Updates, `npm run release`), `README.md` (one line), `.claude/skills/lumen-install/SKILL.md` (§6 Publish: `npm run release`)
- [ ] **Step 1:** Update the docs.
- [ ] **Step 2: Run** `bash tools/test-batches.sh` — every batch `fail 0`.
- [ ] **Step 3: Live check on this PC:** restart Lumen; Settings → Updates shows 0.1.0 and "up to date" (no release yet); `data/logs/lumen.log` shows the check.
- [ ] **Step 4: Commit and push**, then `npm run release -- 0.2.0` (the first release; collaborators need one manual `git pull` to get the updater itself, which the release notes say).
- [ ] **Step 5:** Confirm on this PC: Settings shows 0.2.0 up to date; `git ls-remote --tags origin` lists `v0.2.0`; the GitHub Release exists.
