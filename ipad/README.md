# Lumen for iPad

The Lumen server and its web UI in one iPad app, for when there is no PC to run the server on. The app carries Node (nodejs-mobile, Node 18) and the same `server/` and `web/` as the PC version, and shows the remote in a web view. Nothing is ported: the server's entry point here is `server/embedded.js` instead of `server/index.js`.

It also runs on an iPhone.

## What works, and what does not

| Area | On the iPad |
|---|---|
| Remote, volume, power, inputs, apps, scenes, macros, sleep timer | Works |
| Picture and sound settings (IP Control) | Works. Node brings its own OpenSSL, so the TV's old TLS is not a problem |
| App list, Screen, Bluetooth, memory (Lumen Agent, Lumen Eyes) | Works once the TV apps can reach the iPad (see *The TV apps*) |
| Cast | Links and DLNA work. Files that need converting do not: there is no ffmpeg |
| Ask Lumen | Works with an Anthropic API key (iPad Settings → Lumen). There is no Claude Code login on an iPad |
| Browser, VPN, live video on the TV | Not available: they drive Microsoft Edge on a PC. The Browser view is hidden |
| Updates | Not available: there is no git. Install a newer `.ipa` instead |
| Phones on the same Wi-Fi | Work with `http.lanAccess` on, while the app is running |

**The server lives only while the app is on screen**, unless you say otherwise. iPadOS suspends an app soon after it leaves the screen, and can take its network connections away while it is suspended. When you come back, the server rebuilds itself inside the app (a few seconds, see *How the server survives a pause*) and the page reconnects. While Lumen is off screen the sleep timer does not fire, the TV apps are disconnected, and phones cannot reach the remote.

Turn on *Keep running in the background* (iPad Settings → Lumen) if you need those: the app then plays silence so iPadOS lets it keep running. That holds in normal use; iPadOS can still end the app when memory is short.

## Install

The build is unsigned. [Sideloadly](https://sideloadly.io) signs it with your Apple ID and installs it. A free Apple ID works; the signature then lasts 7 days.

1. On the iPad: Settings → Privacy & Security → **Developer Mode** → on, then restart when asked.
2. On a Windows PC or a Mac: install Sideloadly. On Windows it also needs the web (not Microsoft Store) versions of iTunes and iCloud, for the device drivers.
3. Download `Lumen.ipa` from the [`ipad-latest` release](https://github.com/pranjvas/lumen-remote/releases/tag/ipad-latest).
4. Connect the iPad by USB, drop the `.ipa` on Sideloadly, enter your Apple ID, press **Start**.
5. On the iPad: Settings → General → VPN & Device Management → trust your Apple ID.

**Every 7 days** the app has to be signed again: the same steps 4 with the same Apple ID, or let Sideloadly's helper do it over Wi-Fi while the computer is on. The app is replaced in place and keeps its data. Do not delete the app from the iPad, and do not switch Apple ID: either one removes its data.

## First start

1. Open Lumen and allow **local network** access when iPadOS asks. Without it the app cannot reach the TV.
2. Bring the data over from the PC. In the Files app, open **On My iPad → Lumen → data** and copy these from the PC's `lumen-remote/data` folder into it:
   - `secrets.json`: the key the TV apps use
   - `tv.json` and `ipcontrol.json`: the pairings
   - `config.json`: your settings (`tv.host` is the TV's address)
   - optionally `scenes.json`, `macros.json`, `tracked.json` and the `skills` folder: your scenes, macros, tracked values and learned app skills
3. Close Lumen from the app switcher and open it again.

Without those files Lumen still starts: set the TV's address in `data/config.json` (`{ "tv": { "host": "192.168.1.2" } }`), reopen, and pair from Settings → Connection.

## The TV apps

Lumen Agent and Lumen Eyes have the PC's address and key built in (`docs/BUILD-AND-DEPLOY.md`, section 3). To make them call the iPad instead, either:

- **give the iPad the PC's old address**: iPad Settings → Wi-Fi → (i) next to your network → Configure IP → Manual, with the PC's former address, your router as the router, and the usual subnet mask. The PC must be off that address. With `secrets.json` copied over, nothing on the TV changes; or
- **rebuild the TV apps** for the iPad's address from a computer, as in `docs/BUILD-AND-DEPLOY.md`.

Reserve the iPad's address in the router either way, so it does not change.

## Settings

iPad Settings → Lumen:

- **Keep running in the background** (off): see above.
- **Keep the screen on** (on): no auto-lock while Lumen is in front.
- **API key**: for Ask Lumen. Close and reopen Lumen after changing it.

Logs are in **On My iPad → Lumen → data → logs** (`lumen.log`, and `node-console.log` for anything Node printed).

## How the server survives a pause

Node can be started only once per launch of the app, so the app never restarts Node. `server/embedded-host.js` restarts the *server* inside the running Node instead (stop, then start, exactly what the tests do between cases):

- after a long pause (30 s or more), always, so every connection is new;
- after a short pause, if one of its listeners no longer accepts connections;
- when a listening socket reports an error;
- when the app asks, by writing `data/host-control.json`. The app does that if the server has not answered a few seconds after it came back on screen.

It notices a pause because its 2-second timer skipped: timers do not run while the app is suspended. Each start is recorded in `data/host-status.json` (`generation` counts them), and the app reloads the page when the generation changed. If the server cannot be brought back within 45 seconds, the app says so and shows the log.

## Building

`.github/workflows/ipad.yml` does everything on a GitHub macOS runner, on every push to `claude/ipad-app`:

1. downloads `NodeMobile.xcframework` (nodejs-mobile `v18.20.4`);
2. copies `server/`, `web/` and the production `node_modules` into the app as `nodejs-project/`;
3. generates the Xcode project from `project.yml` (XcodeGen) and builds for the simulator;
4. runs `ci/smoke.mjs`: the app in an iPad simulator against the mock TV (a key press, the volume, a picture setting over IP Control, the TV agent calling in, a restart of the server in place), plus a screenshot;
5. builds for iPad without signing, packs `Lumen.ipa`, and replaces the `ipad-latest` release.

Logs, the check's results and the screenshot go to the `ci/ipad-output` branch.

The check also runs without a Mac, against the same entry point on Node 18:

```sh
node ipad/ci/smoke.mjs --data /tmp/lumen-ipad-data --port 8796 &
LUMEN_DATA_DIR=/tmp/lumen-ipad-data npx -y node@18 server/embedded.js
```

Rules for server code that the iPad runs: it is Node 18 (no `AbortSignal.any` without the fill in `server/embedded.js`, no global `WebSocket`), and there are no child processes (check `config.embedded` before starting one).
