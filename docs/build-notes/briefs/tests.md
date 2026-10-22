# Role: tests

**Files you own:** `test/mock-tv.js`, `test/fixtures/**`, `test/*.test.js`, `test/helpers.js`. (`test/poc/` holds a research prototype you can mine; leave it as is.)

**Build**
- `test/mock-tv.js`: `startMockTv(options)` → `{ ports: { rest, wss, dmr, ipc, dial, wolUdp }, state, events (EventEmitter), setPower(state), stop() }`. Everything binds 127.0.0.1 on ephemeral ports. State is shared (volume, mute, power, picture values, input, apps, keys pressed, IME, AVTransport). It implements:
  - REST 8001: device info with PowerState and `wifiMac`; app status with the trailing-slash rule (no slash → socket destroy); POST launch → `true` and `visible`; 404 for unknown ids.
  - WSS 8002 (self-signed cert generated once with Git's `openssl` into `test/fixtures/tls/`, test-only):
    - token issuance after a configurable Allow delay; `ms.channel.unauthorized` for a bad token
    - key events recorded; KEY_VOLUP/DOWN/MUTE/POWER change state
    - IME scripted events; touchEnable/Disable
  - DMR 9197: RenderingControl Get/SetVolume and Get/SetMute (SetVolume unmutes); SOAP faults; GENA SUBSCRIBE/renew/UNSUBSCRIBE with SID/TIMEOUT, NOTIFY with LastChange on every change, 412 for an unknown SID; AVTransport SetAVTransportURI/Play/Pause/Stop/Seek/GetTransportInfo/GetPositionInfo/GetMediaInfo; ConnectionManager GetProtocolInfo.
  - IP Control 1516 (TLS with the same test cert): the GET/SET rule, every getter and setter in spec §2 with ranges, `-32601` for the 2025-only methods, `-32002` for picture writes in Dynamic mode, `-32010` for a bad token, createAccessToken, `powerControl`, and the one-connection-at-a-time rule (reset overlapping sockets).
  - DIAL 8080: `GET /ws/app/<Name>` state XML, `POST /ws/app/<Name>` launch recorded with its body.
  - A UDP WoL listener that wakes the mock from standby.
  - Standby mode: REST says `standby`, 8002/9197/1516 refuse.
- `test/helpers.js`:
  - `startStack(opts)`: start the mock and `startServer` from `server/app.js` with overrides (tmp `dataDir` seeded with `tv.json` / `ipcontrol.json` tokens the mock accepts, TV host 127.0.0.1 + mock ports, `http.port` 0, `lan.port` 0, `wol` targets 127.0.0.1 + the mock UDP port, fast timings).
  - A browser WS client helper with the right Origin that collects hello / patches / acks.
  - A fake agent client.
  - `waitFor(predicate)`.
- Test suites (`node --test`):
  - store (ranking, flat snapshot, batching)
  - LastChange parser (fixtures with entity-encoded payloads and empty LastChange)
  - IP Control client (errors, GET/SET, queue)
  - safety
  - e2e:
    - hello contains catalogs
    - key click reaches the mock
    - `volume.set` acks with the read-back
    - an external volume change on the mock arrives as a patch via GENA and as `changedOnTv`
    - `setting.set picture.backlight` read-back
    - `LOCKED_IN_MODE` in Dynamic
    - tracked setting
    - power off then on via WoL
    - agent hello → `input.connected` / `channel.current` / `app.installed`
    - Origin rejection
    - `/api/health`
    - cast.url with a direct media URL → mock AVTransport got SetAVTransportURI + Play
    - cast.url with a YouTube URL → mock DIAL POST
    - MCP endpoint `tools/list` + `tools/call get_tv_state` with the bearer token, and rejection without it
    - `ai.ask` with backend `off` → a clean error event
  - Use fixtures from real payloads where available (`docs/research/2026-10-21-live-findings.md`, `C:/Users/pranj/AppData/Local/Temp/tvremote-research/local-services-live/soap_results.json` and `gena-seq/`), redacting SIDs, UUIDs and MACs.

**Verify:** the other modules are being written concurrently, so you cannot run the full suite until they exist. Make the mock self-tested now (`test/mock-tv.test.js` exercising each channel directly). Write the e2e tests against the spec contracts, and run whatever can already run. Report precisely which tests ran and passed, and which wait on other modules.
