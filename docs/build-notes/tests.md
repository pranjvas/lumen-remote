# Build notes: tests

Status: built and verified. Every suite ran against the real modules the other builders wrote at the same time (the server stack existed by the end of my build): **98 tests, 98 pass, 0 skipped**. The final version passed 6 consecutive full runs, plus 2 full runs started at the same time (double load). Nothing here contacts the TV or the LAN. Everything binds 127.0.0.1, and the AI backend is forced `off`.

**Run it with `node --test "test/*.test.js"`.** The `npm test` script in `package.json` (`node --test test/`) does not work on Node 22.18: the runner treats `test/` as a module path and fails with `Cannot find module '…\test'` (I saw this myself). A bare `node --test` would also run `test/helpers.js`, `test/mock-tv.js` and `test/poc/*.mjs` as tests. `package.json` is not on my file list, so its owner should change the script to `"test": "node --test \"test/*.test.js\""`.

## Files

| File | What it is |
|---|---|
| `test/mock-tv.js` | The mock Q95T: REST, WSS remote, DMR (RenderingControl, AVTransport, ConnectionManager, GENA), IP Control (TLS), DIAL, WoL. All channels share one state. |
| `test/helpers.js` | `startStack`, the browser WS client, the fake agent, a test lan, `waitFor`, plus small utilities |
| `test/mock-tv.test.js` | Self-test of the mock, each channel exercised with raw clients (36 tests) |
| `test/store.test.js` | Store contract (8) |
| `test/lastchange.test.js` | LastChange parser, as a unit and through the UPnP adapter's GENA route (8) |
| `test/ipcontrol.test.js` | IP Control client against the mock's JSON-RPC server (14) |
| `test/safety.test.js` | Key catalogue allowlist, and the safety rules end to end through the hub (9) |
| `test/e2e.test.js` | Browser ↔ `startServer` ↔ mock TV (23) |
| `test/fixtures/tls/mock-tv-{cert,key}.pem` | Self-signed test-only cert (`CN=Lumen Mock TV (test only)`, SAN 127.0.0.1/localhost, 10 years). Made once with Git's `openssl`. `testCert()` regenerates it if it is missing. |
| `test/fixtures/upnp/*` | Real Q95T payloads, redacted (see Fixtures) |
| `test/fixtures/rest/*`, `ipc/*`, `dial/*` | Real REST, IP Control and DIAL shapes and values, redacted |

I left `test/poc/` untouched.

## `test/mock-tv.js`

```js
import { startMockTv, testCert, fixture, fixtureJson, parseMagicPacket } from './mock-tv.js';
const mock = await startMockTv(options?);
// → { ports: { rest, wss, dmr, ipc, dial, wolUdp }, state, events, options, tokens: { remote, ipc },
//     tv: { host: '127.0.0.1', ports: { rest, wss, dmr, ipc, dial } },          // drop-in for startServer({ tv })
//     setPower('on'|'standby'|'off'), setVolume(v), setMute(b), setPictureMode(m), setInput(src),
//     setPicture(field, v), setForeground(appId), setTouch(b),
//     ime: { start(type='text', limit=2048), update(text), done(enabled=true), end() },
//     notifyRaw(body, service='RenderingControl'), flushNotifies(), keysSent(), remoteClients(), stop() }
```

The `set*` methods simulate changes made with the physical remote, so they trigger GENA NOTIFYs the same way.

**Options.** Defaults are shown. `mock.options` is live, so a test can flip these mid-run.

| Option | Default | Meaning |
|---|---|---|
| `power` | `'on'` | Initial power state |
| `remoteToken` | `'13572468'` | Pre-paired WSS token |
| `ipcToken` | `'MOCKIPCTOKEN0001'` | Pre-paired IP Control token |
| `wifiMac` | `'02:4c:55:4d:45:4e'` | Locally administered MAC; never a real device |
| `allow` | `true` | Viewer's answer to the on-screen Allow prompt (both channels) |
| `allowDelayMs` | `150` | How long the viewer takes to answer |
| `rotateToken` | `false` | Hand out a fresh token on every authorised reconnect |
| `earlyEvents` | `true` | Send the touch state before `ms.channel.connect`, as the TV does |
| `pingMs` | `5000` | WSS ping interval |
| `initialNotifyDelayMs` | `50` | Delay before the first NOTIFY after SUBSCRIBE |
| `emptyNotifies` | `true` | Follow each RenderingControl change NOTIFY with an empty `<LastChange/>` |
| `dropNotify` | `false` | Firewall simulation: NOTIFYs are counted but never delivered |
| `ipcErrorStyle` | `'nested'` | `'nested'` or `'flat'` JSON-RPC error shape |
| `ipcSlotsFull` | `false` | `createAccessToken` answers -32011 |
| `ipcFail` | `{}` | `{ [method]: code }` forces that error for that method |
| `ipcTransform` | `{}` | `{ [method]: requested => stored }`, e.g. a firmware clamp, to prove the UI shows the read-back |
| `standbyIpcPowerOn` | `true` | In standby, IP Control still accepts `powerControl powerOn` |
| `fmmContent` | `false` | Whether Filmmaker Mode can be selected |
| `restDelayMs` | `0` | Added REST latency |
| `ipcDelayMs` | `0` | Added IP Control latency |
| `wakeDelayMs` | `50` | Time from a wake trigger to `power: 'on'` |
| `mediaDurationS` | `600` | Media duration when the DIDL has none |

**`state`** (shared by every channel):

- TV values: `power`, `volume`, `mute`, `input`, `pictureMode`, `pictureSize`, `soundMode`, `speaker`.
- `picture`: the current input × mode scope. Other scopes are kept in `pictureScopes`, so switching mode really changes the values.
- `apps`: a Map of `{id, name, running, version, visible}`.
- Remote channel: `keys` (`{key, cmd, at}`), `pressed`, `texts`, `inputEnds`, `pointer`, `ime`, `touch`.
- `avtransport`: `{ uri, metadata, state, …, actions: [{ action, uri, didl: { title, upnpClass, protocolInfo, duration, url } }] }`.
- `dial`: `{ apps, launches: [{ name, body, contentType }] }`.
- Launch records: `launches` (REST POST), `webapps`.
- `wol`: `{ mac, matches, from, size }`.
- Pairing: `tokens`, `pairRequests`.
- GENA: `subscriptions`, `notifies` (`{ sid, seq, body, status }`).
- Request logs per channel: `requests.{rest, remote, soap, gena, ipc, dial}`. IP Control entries are `{ method, kind: 'get'|'set', params (token removed), tokenOk }`.
- `stats.{ipcConnections, ipcResets}`.
- **`violations`**: anything a correct client must never do. These are recorded, not acted on:
  - `danger-key`, `power-hold`
  - `rest-missing-trailing-slash`
  - `ipc-overlapping-connection`, `ipc-powerControl-without-param`, `ipc-reboot`
  - `gena-callback-not-loopback`, `gena-infinite-timeout`
  - `pointer-while-touch-disabled`, `didl-malformed`
  - `remote-bad-json`, `remote-unknown-type`, `remote-unknown-cmd`
- `errors`: the mock's own handler failures (a suite can assert there were none).

**`events`**:

- Commands received: `key`, `text`, `inputEnd`, `pointer`, `ipc`, `soap`.
- Pairing and connection: `pairRequest`, `remoteConnect`.
- Launches and wake: `launch`, `dialLaunch`, `webapp`, `wol`.
- GENA: `subscribe`, `renew`, `unsubscribe`, `notify`.
- State: `power`, `change`.
- Problems: `violation`, `failure`.

**Behaviour, per channel**

- **REST**
  - `GET /api/v2/` returns the live device shape (`fixtures/rest/device.json`) with the current `PowerState` and `wifiMac`.
  - `GET /api/v2/applications/<id>/` returns `{id,name,running,version,visible}`. Without the trailing slash the socket is destroyed and a violation is recorded. Unknown ids get 404 with the TV's real body.
  - `POST` (with or without the slash) returns `true` and makes the app the only visible one. `DELETE` closes the app. `POST /api/v2/webapplication/` is recorded.
  - Unknown paths get 404. The real TV hangs instead; a 404 keeps tests fast.
- **WSS** (`wss://…/api/v2/channels/samsung.remote.control`, self-signed)
  - With a valid token, the client gets `ms.channel.connect` (token in `clients[0].attributes.token`), then `ms.channel.ready`.
  - With a bad token: `ms.channel.unauthorized`, then close.
  - Without a token: `pairRequest`, then after `allowDelayMs` either `data.token` (8 digits) or unauthorized.
  - Keys are recorded. Volume up/down changes the volume by 1 and unmutes (the live GENA capture shows a Mute 0 event before the first volume step). `KEY_MUTE` toggles. A `KEY_POWER` click puts the TV in standby.
  - `SendInputString` is recorded and answered with imeDone disable then enable. `SendInputEnd` closes the IME (imeEnd).
  - `ProcessMouseDevice` is recorded, and flagged when touch is disabled.
  - `ms.channel.emit` gets no reply, as on this firmware.
- **DMR**
  - SOAP responses are byte-identical to the TV's: XML declaration, attribute order, and `\r\n` after each value.
  - RenderingControl: Get/SetVolume and Get/SetMute. SetVolume unmutes.
  - Faults:
    - 401: wrong action or URN
    - 402: missing or invalid argument, or InstanceID ≠ 0
    - 601: volume above 100
    - 701: invalid transition
    - 710: seek unit other than REL_TIME
    - 711: illegal seek target
  - AVTransport:
    - SetAVTransportURI decodes the DIDL-Lite once and the `res` URL twice.
    - Supports Play, Pause, Stop and Seek (REL_TIME).
    - GetTransportInfo, GetPositionInfo and GetMediaInfo report the position, which advances while PLAYING.
    - GetCurrentTransportActions is supported.
  - ConnectionManager returns the real 292-entry `GetProtocolInfo` response, plus the connection IDs and connection info.
  - GENA, for both RenderingControl and AVTransport:
    - SUBSCRIBE needs `NT: upnp:event` and a CALLBACK; otherwise it gets 412. The requested TIMEOUT is granted as asked, as the Q95T does.
    - Renewal keeps the original timeout. An unknown or expired SID gets 412. SID together with CALLBACK or NT gets 400. UNSUBSCRIBE answers 200, or 412 if repeated.
    - The initial NOTIFY carries SEQ 0 and the TV's full initial event. After that, one NOTIFY per changed variable, with SEQ in order.
    - NOTIFYs are only sent to loopback callbacks.
- **IP Control** (HTTPS, any path, the test cert)
  - GET/SET is decided by whether params contain only `AccessToken`.
  - Implements:
    - every getter and setter in spec §2 with its range
    - `getTVStates` (with the TV's lowercase `speakerSelect: 'internal'`) and `getVideoStates`
    - `externalSpeakerControl` GET `{}`, `volumeUpDnControl`, `createAccessToken`
  - Picture values are stored per input × picture mode. The live readings seed TV|Standard; the other modes start from plausible presets (Movie backlight 8, Dynamic 50, …).
  - Error codes:
    - `-32002`: picture writes in Dynamic, out-of-range values, unknown enum values, `AMP.*` when Picture Clarity is not Custom, Filmmaker Mode without FMM content, and `directVolumeControl` (get and set) while the speaker is external
    - `-32601`: the 2025-only methods and unknown methods
    - `-32700`: no token
    - `-32010`: wrong token
    - `-32011`: when `ipcSlotsFull`
  - `powerControl`:
    - without `power`: -32602 plus a violation
    - `reboot`: refused plus a violation
    - `powerOff`: standby
    - `powerOn`: wakes the TV
  - **One connection at a time.** A TCP connection that arrives while another is open is reset (`resetAndDestroy`) and counted. The slot is freed as soon as the response has been written, so a correctly serialised client never trips it.
- **DIAL**
  - `GET /ws/app/<Name>` (or `/ws/apps/`) returns the real state XML for Netflix, YouTube and AmazonInstantVideo.
  - `POST` records the body and content type, answers 201 with a LOCATION (200 if the app is already running), and makes the matching REST app visible.
  - `DELETE …/run` stops the app. Bodies over 4096 bytes get 413.
- **WoL**: a UDP socket parses magic packets (6×FF + 16×MAC). Every packet is recorded. A packet for the right MAC wakes the TV from standby or off.
- **Power**
  - **standby**: REST answers with `PowerState: 'standby'`. WSS, DMR and DIAL drop every connection. IP Control accepts only `powerControl powerOn` with a valid token (when `standbyIpcPowerOn`).
  - **off**: REST accepts connections and never answers, IP Control is refused too, and requests time out.
  - **Leaving `on`**: WSS clients are dropped, GENA subscriptions are forgotten (so renewals get 412), and AVTransport resets.

## `test/helpers.js`

- `startStack({ mock?, config?, seed? })` → `{ mock, server, data, dataDir, secrets, httpPort, lanPort, url(p), browser(opts), agent(opts), stop() }`.
  - Starts the mock, then a temp `dataDir` seeded with `tv.json {token}`, `ipcontrol.json {token}` and a full `secrets.json` (32-byte hex `genaSecret`, `agentKey`, `castSecret`, `mcpToken`, known to the test), then `startServer(testConfig(...))`.
  - `stop()` closes the clients, the server and the mock, and deletes the directory.
- `testConfig(mock, dataDir, overrides)`:
  - `tv: mock.tv`, `http.port 0`, `lan.port 0` (enabled)
  - `wol: { targets: ['127.0.0.1'], ports: [mock.ports.wolUdp] }`
  - `FAST_TIMING`, `FAST_SAFETY` (cap 60, cooldown 300 ms, key gap 20 ms)
  - **`ai.backend 'off'`**, log level `warn` with no console output
- `connectBrowser(port, { origin, host, headers })` (also `stack.browser()`): a WS `/live` client with the right Origin.
  - Mirrors the flat state from hello and patches, and collects every message.
  - Methods: `hello`, `opened`, `state`, `value(key)`, `of(t)`, `patchesFor(key)`, `waitForMessage(pred, { since, timeout })`, `waitForState(key, pred)`, `send(cmd, args) → ack`, `fire(cmd, args) → id`, `close()`.
- `connectAgent({ port, key, snapshot, apps, icons, version, pcHost, autoHello })` (also `stack.agent()`): a fake Lumen Agent following spec §5.5.
  - Sends hello with `AGENT_SNAPSHOT`, and answers `apps` (`AGENT_APPS`), `icon` (`TINY_PNG` for Netflix, `ok:false` otherwise) and `exit`.
  - Also provides `sendState`, `sendEvent`, `waitForRequest`.
- `createTestLan()`: the `lan.js` surface (`ready`, `address`, `port`, `route`, `stop`) on 127.0.0.1, for adapter-level tests.
- `createTestLog()`: a `child()`-capable logger that records every line (`log.text()`), for "never logs a token" checks.
- Other utilities:
  - `waitFor(predicate, { timeout, interval, message })`
  - `sleep`
  - `request({ port, path, method, headers, body, tls, agent, timeout })`
  - `tryUpgrade(port, { path, host, origin })` → `{ status }` or `{ error }`
  - `makeDataDir`, `merge`
  - `missingFiles` / `skipUnless(...files)`: a suite is skipped only when the module file does not exist yet, so import errors in an existing module still fail loudly.

## What the suites cover

- **store**:
  - record shape; `set` returns whether the value changed
  - range, options and scope are kept on the record
  - flat snapshot equals the patch shape
  - batching: one patch about 50 ms later, never synchronous, latest value wins
  - `mark('picture.*')`
  - the §9.4 ranking rule (agent, derived and cache never beat fresh live; they do once live expires; live always wins)
  - the state cache coming back as `cache`/stale after `stop()`
  - delete → `null`
- **lastchange**:
  - Unit `parseLastChange` on the real initial, partial (mute, volume), empty and AVTransport bodies, plus a non-Master channel.
  - Through `createUpnp`: subscribes with a loopback CALLBACK and TIMEOUT 1800, goes to `push` on the initial NOTIFY, and answers 200.
  - The adapter writes exactly the values of the real 14-NOTIFY capture in order (`[5,6,7,8,9,8,9,10,9]` and the mute values), and an empty LastChange changes nothing.
- **ipcontrol**:
  - GET sends only the token; values are normalised (mute boolean, `internal` → `Internal`).
  - `setSetting` does SET then a GET read-back; the record carries `via`, `range` and `scope`. The read-back is the TV's value, not the requested one (clamp).
  - Validation happens before anything is sent.
  - Error mapping:
    - -32002 → LOCKED_IN_MODE, for both nested and flat error shapes
    - -32601 → UNAVAILABLE, re-probed after a mode change
    - -32010 and -32700 → NOT_PAIRED with `conn.ipc` unpaired; no token → NOT_PAIRED
    - -32003 → FAILED
  - A mode change marks scoped values stale, then re-reads them in the new scope.
  - The queue never overlaps and keeps ≥ 150 ms between requests. A user write beats a running picture poll (< 1.2 s).
  - Polling follows demand.
  - `power` uses only powerOff/powerOn.
  - `pair()` persists the issued token, never logs it, and maps -32011 to FAILED.
- **safety**:
  - Danger keys and unknown keys are disallowed. The catalogue is well formed and KEY_POWER is click-only.
  - Through the hub: danger keys → INVALID and never reach the TV; KEY_POWER cannot be held.
  - Volume: the cap holds for both set and step; lowering is always allowed.
  - The pointer is gated by `touch.enabled`.
  - A 60-command burst gets RATE_LIMIT.
  - Power cooldown: exactly one KEY_POWER toggle.
  - No violations and no pairing at the end.
- **e2e**:
  - hello: flat state, catalogues (keys, settings incl. tracked, apps with colours, agent excluded), csrf, `ai: { backend: 'off', ready: false }`, and no MAC, token or secret in it.
  - Upgrade checks: correct Origin → 101 for both 127.0.0.1 and localhost; foreign Origin → 403; no Origin, foreign Host, or the wrong port's Origin → not 101.
  - `/api/health` is JSON with no CORS header; path-traversal attempts leak nothing; `/` carries the CSP.
  - Remote channel: a key click reaches the TV with name "Lumen Remote" and a token; `text.send` with submit types into the TV field.
  - `volume.set` acks the read-back 23.
  - `setting.set picture.backlight` acks 17, and acks 40 (not 45) under a firmware clamp; Dynamic → LOCKED_IN_MODE.
  - `general.gameMode` is stored as tracked: persisted in `tracked.json`, never sent to IP Control, invalid value → INVALID. `input.label` is stored as tracked.
  - `app.launch` goes through REST POST.
  - Agent: hello → `input.connected ['TV','HDMI1']`, `channel.current`, `app.installed` (src agent, brand colours merged), `caption.state`, `device.firmware`. `/api/icon/<id>` serves the PNG (404 for a failed icon). A wrong agent key is refused.
  - `cast.url`:
    - media link → SetAVTransportURI (correct DIDL class, protocolInfo, URL) then Play, and `cast.session` kind `dlna`
    - YouTube link → DIAL POST containing the video id
  - MCP: initialize (`serverInfo.name: 'lumen'`), `notifications/initialized` → 202, tools/list, tools/call `get_tv_state` with the bearer; 401 without it or with a wrong one.
  - `ai.ask` with backend off → an `{t:'ai', kind:'error'}` event and nothing sent to the TV.
  - At the end: no violations, no pairing, no mock errors, and the debug-level `lumen.log` contains no token, MAC or secret.
  - Separate stacks:
    - an external volume or mute change arrives via GENA as a patch plus `changedOnTv {from, to}` (polls slowed to 60 s, so only GENA could deliver it)
    - power off is one KEY_POWER click, and REST then reports standby; on wakes the TV via a 102-byte magic packet for the TV MAC (IP Control wake disabled in the mock), and the MAC never reaches the browser
    - NOTIFY dropped → `conn.events` stays `polling` past `genaFallbackMs`, and external changes still arrive through polls

## Fixtures (real payloads, redacted)

Built by a throwaway script (`tools/scratch/tests/build-fixtures.mjs`, gitignored). Sources were the research captures in `%TEMP%/tvremote-research/local-services-live/` (`gena_log.txt`, `soap_results.json`, `dmr.xml`, `rest_apps.json`) and `…/gena-seq/monitor_log.txt`.

**What was redacted:**

- SIDs/UUIDs → `uuid:00000000-…`
- MACs → `02:00:00:00:00:00`
- the serial → `MOCKSERIAL0000`
- LAN IPs → `127.0.0.1`
- the TV name → `[TV] Mock TV`

The script refuses to write a fixture that still contains an identifier.

**What each fixture is:**

- `upnp/notify-rc-initial.xml` and `notify-avt-initial.xml` are the TV's bytes verbatim (820 and 1450 bytes, matching their Content-Length).
- The partial and empty RenderingControl bodies and `gena-sequence.json` (SEQ 1–14) were rebuilt from the logged inner XML in the TV's CRLF envelope. Every rebuilt body has exactly the byte length the TV sent.
- The SOAP responses are verbatim bodies.
- `soap-fault-402.xml` uses the fault format seen on port 8187.
- `rest/device.json` is the live shape from the research report, with all identifiers replaced; its `isSupport` keeps only the keys the research quotes.
- `ipc/live-getters.json` holds the live IP Control GET results, which seed the mock's state.
- `dial/netflix.xml` is the live Netflix DIAL reply.

The mock's generated GENA bodies, SOAP getter answers and DIAL XML are asserted byte-for-byte against these fixtures in `mock-tv.test.js`.

## Interpretations and deviations

- `tv.json` is seeded as `{ token }`, following §8.1 (binding), not the `{host, clientName, token}` in §3.4.
- Standby (brief: "8002/9197/1516 refuse") is reconciled with §9.2 ("the mock leaves standby … on IPC powerControl powerOn"): in standby, IP Control accepts only that call. `standbyIpcPowerOn: false` makes it refuse everything, which the WoL e2e uses so that only the magic packet can wake the TV. DIAL also refuses in standby.
- "Refuse" is implemented as destroying the accepted socket (ECONNRESET), not a true ECONNREFUSED. REST in the fully `off` state hangs instead, which models a TV that is gone from the network (requests time out).
- I did not observe several IP Control details live, so I picked plausible behaviour:
  - a SET returns the same shape as a GET
  - out-of-range and unknown enum values return -32002 (the research reports -32002 for out-of-range)
  - a param-less powerControl returns -32602
  - the error message strings are guesses
- `emptyNotifies` sends an empty LastChange after every RenderingControl change. The Q95T does this sometimes, so it is a superset of the real behaviour; adapters must ignore them anyway.
- The fake agent's `channel.number` is a number (1927). The agent adapter publishes it as the string `'1927'`. The spec does not fix the type, so the e2e compares `String(number)`.
- App ids in `AGENT_APPS` follow real Tizen shapes (numeric store ids, or a 10-character package plus `.Name`), because the agent adapter keeps only REST-launchable ids.
- The in-process fake agent lives in `helpers.js`, as the tests brief says. Spec §4 lists an "agent client simulator" inside `mock-tv.js`; I followed the brief.

## Observations for other builders (not failures)

- **`package.json`**: the `test` script must change (see the top of this file).
- **ipcontrol**: the "mode changed → mark stale and re-read" path needs a previously known scope. If the very first IP Control action after start is a `setSetting('picture.mode', …)`, before any `getTVStates`, no re-read is triggered. In practice the states poll or `refresh` establishes the scope first, so this has low impact. The tests call `refresh` first.

## Not covered (known gaps)

- **Hub commands**: `hold` repeat and watchdog timing, `volume.step` via keys, `mute.set` fallbacks, `input.set`, `settings.refresh`, `pair.remote` / `pair.ipcontrol`, `agent.connect`, and `ai.cancel`. The mock supports pairing and launches; there are just no e2e cases for them.
- **Features**: sleep, scenes, macros, `cast.file` upload with Range serving, `cast.control`, and the Netflix/Prime/page cast paths.
- **GENA renewal** at 80 % of the timeout. This needs a short `genaTimeoutS`; the mock grants whatever is requested, so a test could ask for `Second-2`.
- **Remote adapter**: reconnect backoff, the 12 s dead-link rule, and token rotation (`rotateToken` exists in the mock).
- **Elsewhere**: the `tools/screenshot.mjs` flow and the web UI itself are not exercised.

## Verification performed

- `node --check` on every file I wrote: `test/mock-tv.js`, `test/helpers.js` and all six `test/*.test.js` files. All passed.
- Per-file runs (`node --test test/<file>`), all with 0 failures and 0 skipped:

  | File | Tests passed |
  |---|---|
  | `mock-tv.test.js` | 36 |
  | `store.test.js` | 8 |
  | `lastchange.test.js` | 8 |
  | `ipcontrol.test.js` | 14 |
  | `safety.test.js` | 9 |
  | `e2e.test.js` | 23 |

- Full suite: `node --test "test/*.test.js"` → **98 tests, 16 suites, 98 pass, 0 fail, 0 skipped**, about 17–22 s.
  - The final version passed 6 consecutive runs.
  - It also passed 2 runs started at the same time, i.e. 12 test processes on double load.
  - The mock self-test alone passed 3 repeated runs.
- `npm test` → fails before any test runs (`Cannot find module …\test`), as described at the top.
- Problems found and fixed during the build:
  - **Test isolation (ipcontrol)**: leftover adapter instances from earlier tests polled the single-connection mock at the same time. Fixed by stopping each adapter before the next test starts.
  - **Fixture realism**: the fake agent used an app id with an 11-character package, which the agent adapter rightly drops. Changed to a real Tizen shape.
  - **Flaky failures in repeated full runs** (each fixed, then re-verified with the runs above):
    - The LastChange replay raced the UPnP adapter's start-up reads. The test now waits for them, and sets the mock's own state to the replay's final values.
    - The test read a NOTIFY's 200 status before the mock had received the response. It now awaits `flushNotifies()`.
    - Store-test sleeps became `waitFor` so they hold under load.
- Temp directories: none of mine are left behind (`lumen-test-*`, `lumen-ipc-*`, `lumen-store-*`, `lumen-lastchange-*` are all cleaned up). Other builders' `lumen-app-*` / `lumen-core-*` / `lumen-feat-*` scratch directories are still in `%TEMP%`.
