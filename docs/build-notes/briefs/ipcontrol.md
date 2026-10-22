# Role: ipcontrol

**Files you own:** `server/adapters/ipcontrol.js`, `server/catalog/settings.js`.

**Build**
- `catalog/settings.js`:
  - `SETTINGS` with every row of the IP Control map in spec §2, using the field schema from §9.3.
  - Groups:
    - `picture`: mode, backlight (label "Brightness", hint "Panel backlight"), contrast, shadowDetail, sharpness, color, tint (display `gr`), colorTone, size.
    - `pictureAdvanced`: localDimming, contrastEnhancer, clarity, blurReduction / judderReduction (`dependsOn { key: 'picture.clarity', value: 'Custom' }`), ledClearMotion, noiseReduction, filmMode, gammaMode, gamma, colorSpace, whiteBalance — the last four read-only.
    - `sound`: soundMode, speaker.
    - `input`: source.
  - Tracked-only settings (type `tracked`, with `options` and `menuPath`) for what this firmware lacks:
    - `general.gameMode` (Off/Auto/On)
    - `general.ambientLight` (Ambient Light Detection Off/On)
    - `general.powerSaving` (Off/Low/Medium/High)
    - `general.motionLighting` (Off/On)
    - `general.autoPowerOff` (Off/4h/6h/8h)
    - `general.adaptivePicture` (Off/On)
    - `general.adaptiveSound` (Off/On)
    - `sound.autoVolume` (Off/Normal/Night)
    - `sound.balance` (range −50..50)
    - `picture.hdrToneMapping` (Off/Active/Static)
  - Export `SETTINGS` plus helpers `getSetting(key)`, `settingsByGroup()`.
- `ipcontrol.js`:
  - HTTPS JSON-RPC 2.0 client for `https://<tv.host>:<ports.ipc>/` with an https.Agent of `{ keepAlive: false, maxSockets: 1, rejectUnauthorized: false, ciphers: 'DEFAULT@SECLEVEL=0', minVersion: 'TLSv1' }`.
  - One queue (`minGapMs` 150, user priority ahead of polls); 6 s timeout (45 s for `createAccessToken`).
  - Token from `data.readJson('ipcontrol.json')`; **a call with only AccessToken is a GET, any extra key is a SET**; parse nested and flat errors.
  - Error rules (spec §2):
    - `-32601` / `-32002` / `-32003` → LumenError `UNAVAILABLE` / `LOCKED_IN_MODE` / `FAILED`.
    - `-32010` or `-32700` with a token → `conn.ipc = 'unpaired'` and LumenError `NOT_PAIRED`.
    - `-32011` → FAILED "all IP Remote slots are in use".
  - `get(method)`, `set(method, params)`.
  - `setSetting(key, value)`: catalog lookup → validate range/options → SET → GET read-back → `store.set` normalised → `{ value }`.
  - `refresh(group)`.
  - `power('on'|'off')` → powerControl powerOn / powerOff only (never reboot, never a param-less powerControl).
  - `pair()`: createAccessToken, which prompts on the TV; called only via `pair.ipcontrol`. **Persist the token before anything else.**
  - Polling via `setDemand`:
    - `getTVStates` every `timing.ipcStatesMs` while any client is visible → audio.volume, audio.mute (boolean), audio.soundMode, audio.speaker ('Internal'/'External'), input.source, picture.mode, picture.size.
    - All picture getters one at a time every `timing.ipcPictureMs` while the `settings` view is visible, otherwise on demand.
    - When `picture.mode` or `input.source` changes, mark `picture.*` stale and re-read.
    - Pause while `conn.tv !== 'on'`; stop with zero clients.
    - Records: `src:'live', via:'ipc:<method>'`, `range`/`options` from the catalog, `scope { input, mode }` for scoped settings.
    - `conn.ipc`, `conn.latency.ipc`.
  - Never log tokens.

**Verify** against a scratch TLS JSON-RPC stub on 127.0.0.1 (self-signed cert via Git's `openssl`) that implements the GET/SET rule, a `-32002` "locked" mode and the one-connection rule.
