# Lumen auto-updater — design

Date: 26 Oct 2026 · Status: approved by the owner in chat (26 Oct), builder-checked

## Why

Lumen now runs on more than one PC: the owner's, and those of GitHub collaborators who cloned the
private repo. Today each of them has to `git pull`, `npm ci` and restart by hand, so their copies fall
behind and bugs fixed on the owner's PC live on elsewhere. The owner plans to distribute Lumen more
widely later. From now on, everyone's Lumen should pick up new versions by itself.

## What the owner decided

- **Releases, not pushes.** A push to `master` ships nothing. Only a version the owner marks as a
  release reaches other PCs.
- **Collaborators now, wider distribution later.** Today every copy is a git clone whose owner has
  GitHub access to the private repo. The design must not need redoing for later distribution
  (copies that are not git clones, or a public release feed).
- The rest of the behaviour below was played back to the owner and accepted as is ("looks good").

## Goals

1. One command publishes a release: `npm run release -- <version>`.
2. Every Lumen checks for a newer release by itself, applies it when nobody is using Lumen, restarts,
   and rolls back by itself if the new version does not start.
3. Settings shows the version, the last check and what the updater is doing, with a switch and a
   "Check now" button.
4. A newer TV app (agent, Eyes) in a release is installed by itself where this PC has the TV tooling
   set up; elsewhere Settings says a TV app update is available and how to install it.

## Non-goals (for now)

- Distribution to non-git copies (an installer or zip). The update source is an interface so a
  "feed" source can be added later; only the git source is built now.
- Signed releases or verifying signatures (git + the private repo's access control is the trust
  boundary for collaborators; revisit with public distribution).
- Downgrades. A copy never moves to an older version, even if a release is withdrawn.
- Updating Node.js itself or other system prerequisites.

## Anti-goals (would make it a failure even if it "works")

- Restarting Lumen while someone is watching through it (Lumen's browser on the TV, a video handed
  to the TV, live video, incognito browsing, an Ask Lumen run).
- Touching a copy with local work: uncommitted edits, a different branch, or commits that are not
  in the release (the owner's own development PC is exactly this).
- An update that leaves Lumen not running. A failed update must end with the previous version
  running again.
- A login prompt or a console window popping up on someone's PC.

## Behaviour

### Publishing (owner's PC)

`npm run release -- 0.2.0 [--notes "text"]`:
1. Refuses unless the tree is clean, the branch is `master`, it is up to date with `origin/master`,
   and 0.2.0 is higher than the current `package.json` version.
2. Sets the version in `package.json` (and `package-lock.json`), commits "Release v0.2.0", creates an
   annotated tag `v0.2.0`, pushes `master` and the tag.
3. Creates a GitHub Release for the tag (`gh release create`) with the notes, or by default the
   commit subjects since the previous release tag.
4. `--dry-run` prints what it would do and changes nothing.
5. `npm run release -- --withdraw 0.2.0` deletes the tag `v0.2.0` on GitHub and its GitHub Release.
   Copies that have not installed it drop it at their next check; copies that already run it stay on
   it (no downgrades), so a broken release is fixed by publishing a newer one. *(Builder's call, owner
   away: no waiting period before copies install a release.)*

### Checking (every copy)

- At start-up (after a short delay) and every 6 hours; "Check now" in Settings at any time.
- Git source: `git fetch --tags --prune --prune-tags origin` with prompts disabled
  (`GIT_TERMINAL_PROMPT=0`, no console window), so withdrawn tags disappear. The newest tag `vX.Y.Z`
  (semantic version order) **whose `package.json` at that tag says the same version** is the latest
  release; any other tag is ignored (a tag made outside the release script must not cause an update
  loop). *(Builder's call: the tag is the release; the GitHub Release is for people to read.)*
- An update is available when the latest release is newer than the running version
  (`package.json`) **and** this copy can move to it without losing anything:
  - the working tree has no uncommitted changes to tracked files;
  - the branch `master` is checked out (a copy on another branch or a detached HEAD is left alone:
    "left alone: on branch X"); *(builder's call)*
  - the current commit is an ancestor of the release commit (fast-forward only).
  Otherwise the status says why the copy is left alone ("local changes", "ahead of the release",
  "on branch X").
- Network or auth failure: the status shows "could not check" with the reason; nothing else happens.

### Applying

- When an update is available and automatic updates are on, Lumen waits until it is idle, then
  applies it. Idle: Lumen's browser is not on the TV, no video in the TV's player, no live video,
  not incognito, no Ask Lumen run, and that has been so for 2 minutes. A phone merely having Lumen
  open does not block an update (it reconnects by itself after the restart).
- "Update now" in Settings applies at once (the user chose to).
- The running server writes the plan (from-commit, to-release) and starts a detached helper
  (`node tools/update-apply.js`), then shuts itself down. The helper:
  1. waits for the old server to exit;
  2. fast-forwards the branch to the release commit;
  3. runs `npm ci` if `package-lock.json` changed between the two commits;
  4. starts Lumen the usual way (`tools/start-hidden.js`) and waits for `/api/health` (60 s);
  5. on failure (any step, or no health), returns the branch to the from-commit, runs `npm ci` again
     if needed, starts Lumen again, and records the failure. A release that failed here is not
     retried automatically (Settings shows it with "Try again").
- Everything the helper does goes to `data/logs/update.log`; the outcome goes to
  `data/update/state.json`, which the new (or restored) server reads and shows.

### Settings → Updates

Shows: running version; latest release and when it was checked; state (up to date · update available
· waiting until Lumen is not in use · updating · updated to vX at time · failed: reason · left alone:
reason · could not check: reason). Controls: "Automatic updates" switch (on by default, stored in
`data/update/settings.json`), "Check now", and "Update now" when an update is available.

### TV apps

After an update, Lumen compares the TV agent version in the repo (`companion/agent/config.xml`)
with the agent the TV reports (`agent connected {version}`), and likewise Eyes.
- If newer and this PC has the TV tooling set up (the Tizen CLI with a certificate profile, and a
  working `sdb` that sees the TV), Lumen builds and installs it when idle, the way
  `tools/agent/build.ps1` and the install step do, then reconnects the agent.
- Otherwise Settings shows "TV app update available: agent 0.9.4 → 0.9.5" with the steps from
  `docs/SETUP.md` (Apps2Samsung route or Tizen Studio route).

## Constraints

- Windows 11, Node 22 (as today). Git for Windows is already required by the setup guide.
- The repo is private: checking uses the collaborator's own git credentials (Git Credential
  Manager). No tokens are stored by Lumen.
- Lumen's single-instance rule (the HTTP port) stays; the helper must not start a second server while
  the old one is still exiting.
- Tests must not touch the real repo or the network: they run against a throwaway local "origin".

## Left to the builder

File and module layout, the exact store keys and hub command names, the state file format, the
timing constants other than those above, how the TV-tooling probe is done, and test structure.
