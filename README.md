# Lumen Remote

A remote control, live dashboard and AI assistant for a Samsung QA55Q95T (2020, Tizen 5.5). Lumen runs as a small Node server on a Windows PC and is used from a browser: on the PC at **http://127.0.0.1:8790**, or on a phone on the same Wi-Fi.

Build, install and deploy steps for every part (server, TV agent, Lumen Eyes, VPN core) are in **[docs/BUILD-AND-DEPLOY.md](docs/BUILD-AND-DEPLOY.md)**.

## What it does

| Area | What you get |
|---|---|
| **Remote** | D-pad, volume with the TV's real level, channels, Back / Home / Menu, power and Wake-on-LAN, inputs, number pad, colour and media keys, text entry, a trackpad for the TV pointer. |
| **Live dashboard** | Every picture and sound setting read live from the TV and changeable; which app is on screen; firmware, inputs, network, Bluetooth (pair new devices, connect or disconnect paired ones); system health with **Free memory** (closes apps idling in the background). |
| **Screen** | A live picture of what the TV shows, via Lumen Eyes. |
| **Ask Lumen** | Natural-language control from any screen (header **Ask** button, ask bar, or the Ask view): "play Friends on Netflix", "cinema mode", "free up memory". It can see the TV screen, plays titles in any app using learned *app skills*, and finds which service has a title (JustWatch). Runs on the Claude Agent SDK. |
| **Browser** | A full Chromium (Edge) on the PC, optionally behind Lumen's own WireGuard VPN, shown on the phone and **On TV**. Taps, swipes, the keyboard and a trackpad drive it; sign-in pop-ups work. Ads, trackers and pop-under networks are blocked by Lumen itself (`browser.adBlock`, list in `server/catalog/adblock.js`, more domains in `browser.adBlockExtra`). On the TV it plays as **live video with sound** (1080p30, stepping down when needed) or as still frames. A page's video can be handed to the TV's own player: YouTube in the YouTube app, other streams through Lumen's relay with AVPlay / hls.js, DRM through the TV's own Widevine / PlayReady. |
| **Cast** | Links and files from the PC: YouTube, Netflix titles, DLNA media, pages. |
| **Scenes** | One-tap bundles (Night, Cinema), a sleep timer, key macros. |

Every value on screen says where it came from: **LIVE** (read from the TV), **TV AGENT** (read by Lumen's app on the TV), **TRACKED** (set by Lumen or you; the TV can't report it), **STALE**, **UNAVAILABLE**.

## Quick start

```powershell
cd C:\Users\pranj\source\lumen-remote
npm ci
npm start                     # then open http://127.0.0.1:8790
```

First run: Settings → Connection → **Pair** (press **Allow** on the TV), then **Connect TV agent**. The TV agent and Lumen Eyes must be installed on the TV first.

- **Setting up from scratch** (a development setup with no TV, then connecting a real one): [docs/SETUP.md](docs/SETUP.md).
- **Building and deploying changes:** [docs/BUILD-AND-DEPLOY.md](docs/BUILD-AND-DEPLOY.md).
- **Claude Code skills in this repo:** `lumen-setup` (first-time setup) and `lumen-install` (deploying changes).

Only one copy runs at a time. Logs go to `data/logs/` (`lumen.log`, `stdout.log`).

## How it talks to the TV

| Channel | Used for |
|---|---|
| Remote channel (wss 8002, paired as "Lumen Remote") | keys, text, pointer |
| REST (8001) | power state, which app is in front, launches, closing apps |
| UPnP (9197) | volume/mute with live push, DLNA cast |
| Samsung IP Control (https 1516, paired) | every picture and sound setting, input, power |
| DIAL (8080) | YouTube / Netflix / Prime launches |
| **Lumen Agent** on the TV (`lumenrmt01.LumenAgent`) | app list and icons, channel, firmware, inputs, network; app-control launches (Netflix titles); the browser screen, live video and the TV's video player; connects back to the PC on port 8791 |
| **Lumen Eyes** on the TV (`org.lumen.eyes`, Tizen .NET) | screen capture, Bluetooth (read, scan, pair, connect), memory; connects back on port 8791 |

Tokens and secrets live in `data/` (git-ignored). Port 8791 only accepts the TV's address and a shared secret.

## Phones

With `{ "http": { "lanAccess": true } }` in `data/config.json`, Lumen also serves the UI on the PC's LAN address (e.g. `http://192.168.1.7:8790`). There is no login, by the owner's choice (private home network); only the PC's own addresses are accepted as host names, so other websites can't drive it. Over plain http the phone can't use the voice button or install Lumen as an app.

## Development

```powershell
npm test                    # ~350 tests against a mock TV and fake agents; no real device needed
npm run dev:stack           # mock TV + real server on http://127.0.0.1:8798
node tools/dev-ui.mjs       # the UI with fake data on http://127.0.0.1:8799
node tools/screenshot.mjs --base http://127.0.0.1:8799   # headless Edge screenshots of every view
```

`test/browser-vpn.test.js` can time out when the PC is heavily loaded; it passes on its own.

Design, research and notes: `docs/design/2026-10-23-ux-pass.md`, `docs/superpowers/specs/2026-10-21-lumen-remote-design.md`, `docs/research/`, `docs/build-notes/`.

## Known limits

- The TV agent and Lumen Eyes need the TV in **developer mode**. The agent can be installed with Apps2Samsung, with no certificate of your own (tested on the Q95T), or signed with your own Samsung certificate. Pick one per TV: the TV won't accept the other signer for the same app. Each build carries this PC's address and key, and the apps use undocumented TV features, so Lumen is a personal tool, not a store app.
- Live video of the browser runs at 1080p60, or 4K30 with `maxHeight: 2160`, on the Q95T. The agent has still been cut off once on a heavy page (no cause found yet). When that happens, live video falls back to still frames by itself.
- Cloudflare's "verify you are human" refuses Lumen's headless browser; Google sign-in may do the same.
- The VPN's DNS (Proton NetShield) blocks ad hosts; a few hosts with very large DNS answers fail inside the tunnel.
- Ask Lumen uses this PC's Claude Code login. Anthropic doesn't allow claude.ai logins in products offered to others; a shared Lumen must use an API key (`ANTHROPIC_API_KEY`).
