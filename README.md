# Lumen Remote

A remote control and live dashboard for the Samsung QA55Q95T (2020, Tizen 5.5) at 192.168.1.2. It runs as a small Node server on this PC and is used from a browser at **http://127.0.0.1:8790**.

Every value on screen carries a badge saying where it came from:

| Badge | Meaning |
|---|---|
| **LIVE** | read from the TV |
| **TV AGENT** | read by the Lumen app on the TV |
| **TRACKED** | set by Lumen or entered by you; the TV can't report it |
| **STALE** | an old reading |
| **UNAVAILABLE** | nothing can read it |

## Run it

```powershell
cd C:\Users\pranj\source\lumen-remote
npm start                     # then open http://127.0.0.1:8790
```

To start at sign-in, add a hidden Startup-folder shortcut:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/install-autostart.ps1          # add
powershell -NoProfile -ExecutionPolicy Bypass -File tools/install-autostart.ps1 -Remove  # remove
```

Only one copy runs at a time; a second start says "Lumen is already running". Logs go to `data/logs/`.

### From a phone (same Wi-Fi)

`data/config.json` has `{ "http": { "lanAccess": true } }`, so Lumen also serves **http://192.168.1.7:8790** to the home network.

- There's no login, by the owner's choice: it's a private network.
- Only the PC's LAN address and localhost are accepted as host names, and other websites can't drive it from a browser.
- Over plain http on the LAN, phones can't use the voice button or install Lumen as an app. Everything else works.
- Set `lanAccess` to `false` to go back to this-PC-only.

## What it does

### Views

| View | What it does |
|---|---|
| **Remote** | D-pad ring with the TV's real volume as a glowing halo, which follows changes made with the physical remote. Volume rocker with the exact level and mute, channel rocker, Back / Home / TV Menu, power, an on-screen-now strip and input chips. |
| **Settings** | Every picture and sound value read live from the TV: Brightness (backlight 0–50), contrast, shadow detail, sharpness, colour, tint, colour tone, local dimming, picture clarity, gamma, white balance, picture/sound mode, speaker, input. Changes are read back from the TV, and values blocked in a picture mode say "locked in this mode". Settings this firmware can't report (Game Mode, Eco, Auto Power Off, …) are tracked: tell Lumen once and it remembers. Device and Connection sections show firmware, inputs, system health and each channel's status. |
| **Apps & Inputs** | The TV's own app list with its icons (from the TV agent), launch, connected-input dots, and names for your HDMI ports. |
| **Mouse** | The TV's on-screen cursor. Phone: a trackpad (tap = click, two-finger tap or long press = right-click, two-finger drag = scroll). Desktop: press **U** or "Use this PC's mouse" to drive the TV cursor with your mouse (Esc releases). |
| **Cast** | Paste a link: YouTube plays the video, Netflix/Prime open their app, media files play over DLNA, other pages open the TV browser. Or drop a file from this PC. Play / pause / seek while casting. |
| **Keys, Touch & Text** | Number pad, colour keys, media keys, a swipe pad, and a text box that opens when the TV shows its keyboard. |
| **Scenes** | One-tap bundles such as Night and Cinema, a sleep timer, and a key-macro recorder. |

### Ask Lumen

Natural-language commands from any view (Ctrl+K or `/`): "increase brightness", "cinema mode", "switch to HDMI 1", "sleep in 30 minutes", "play <video> on YouTube". It runs through the Claude Agent SDK on this PC's Claude Code login, with no API key, and uses your Claude plan. Anthropic doesn't allow claude.ai logins in products offered to others, so if Lumen is ever shared it must switch to an API key (`ANTHROPIC_API_KEY`).

Press **?** in the app for keyboard shortcuts.

## How it talks to the TV

| Channel | Used for |
|---|---|
| Remote channel (wss 8002, paired as "Lumen Remote") | keys, text, pointer |
| REST (8001) | power state, which app is in front, launches |
| UPnP (9197) | volume/mute with live push, and DLNA cast |
| Samsung IP Control (https 1516, paired) | every picture and sound setting, input, power |
| DIAL (8080) | YouTube/Netflix/Prime launches; needs the app's Origin header |
| Lumen Agent on the TV (`lumenrmt01.LumenAgent` 0.2.0) | channel, firmware, connected inputs, app list and icons, captions, system health; it connects back to this PC on port 8791 |

Tokens and secrets live in `data/` (git-ignored). With `lanAccess` off, the web server only listens on 127.0.0.1. The port-8791 listener accepts only the TV's address and a secret.

### Pairing

If a pairing is ever lost, Settings › Connection shows a **Pair** button. Press **Allow** on the TV prompt.

### TV agent

Rebuild and reinstall when this PC's address changes. The TV rejects lower versions, so bump the version in `companion/agent/config.xml` first.

```powershell
npm run agent:build                                              # signs with the Q95T profile
wsl -d Ubuntu -u pv -- bash /mnt/c/Users/pranj/source/lumen-remote/tools/agent/install.sh
```

"Connect TV agent" in Settings starts it. Whatever app is in front goes to the background, and the TV returns to live TV when the agent hides. The TV may close the agent when memory runs low; just connect it again.

## Verified on the TV (21–22 Oct 2026) and known limits

**Works:**
- Keys and volume
- Exact volume with live push
- Every IP Control reading, plus a backlight write with read-back
- Pointer over CineHD
- YouTube video by DIAL
- DLNA cast of a photo and of an H.264+AAC video from this PC
- The TV agent
- One real Ask Lumen command

**Limits:**
- Netflix opens on its home screen even with a title link; three launch formats were tried.
- Sending a page to the TV browser opens the browser but not the URL.
- Video-only MP4 clips are refused by the TV's player (`ERR_NOT_SUPPORTED_FORMAT`).
- KEY_HDMI1–4 do nothing on this model; Lumen switches inputs through IP Control instead.

## Development

```powershell
npm test                   # 147 tests against a mock TV, no real device involved
npm run dev:stack          # mock TV + real server on http://127.0.0.1:8798
node tools/screenshot.mjs --base http://127.0.0.1:8798   # headless Edge screenshots of every view
```

Design and research: `docs/superpowers/specs/2026-10-21-lumen-remote-design.md`, `docs/research/`.
