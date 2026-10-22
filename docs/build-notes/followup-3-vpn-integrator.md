# Follow-up 3: VPN port integration (`vpn-integrator`)

Date: 2026-10-22. Role: integrator for Parts A (`vpn-tunnel`), B (`vpn-proxy`) and C (`vpn-tests`) of
`docs/build-notes/briefs/followup-3-vpn.md`. Files touched: `server/features/vpn.js`, `test/vpn.test.js`,
`test/fixtures/vpn/bin/.gitignore` (new), this note. Scratch (gitignored): `tools/scratch/vpn-integrate/{transitions,throughput}.mjs`,
`run1.tap`, `run2.tap`, `full1.tap`, `full2.tap`.

Everything below ran on this PC (Node v22.18.0, Windows 11) against the Go test peer `test/fixtures/vpn/bin/testpeer.exe` on
127.0.0.1 with throwaway `genkey` keys. No TV, emulator, LAN device, internet VPN endpoint, real `.conf` or real key was touched;
no sdb, no installs, no `npm` changes; `server/hub.js`, `server/app.js`, `server/features/browser.js` and `web/**` were not edited
(their mtimes predate this work).

## Do the four pieces agree?

Read side by side: `server/vpn/wireguard.js` (tunnel), `server/vpn/conf.js`, `server/vpn/proxy.js`, `server/features/vpn.js`,
`test/vpn.test.js`, `test/helpers.js` (VPN block), the plan and the three builder notes. Checked: `createTunnel` signature and
`status()` fields the feature reads (`state`, `handshakeAgeMs`, `rx`, `tx`, `lastError`); Duplex events the proxy relies on
(`connect`, `error` only when a listener exists, one `close`); proxy `maxStreams` 30 = tunnel `MAX_STREAMS` 30 and the proxy's
slot count is always >= the tunnel's stream count (tunnel releases ids before the Duplex closes), so the proxy never asks for a 31st
stream; `http.request({ createConnection })` without an agent; `LumenError` codes used by the feature (`INVALID`, `FAILED`,
`UNAVAILABLE`) exist in `server/errors.js`; `data.readJson/writeJson` accept the `vpn/state.json` sub-path; store writes use
`src 'derived'` / `via 'vpn'` and never carry key material (asserted by the tests through `peer.containsKey`).

One real disagreement, fixed:

- **`vpn.state` flashed `'error'` on every switch-on.** `features/vpn.js` published the keys before calling `tunnel.start()`; a tunnel
  that has not started reports `state 'stopped'`, which the feature mapped to `'error'`. Observed with a store recorder
  (`tools/scratch/vpn-integrate/transitions.mjs`): `enable()` → `["error","connecting","up"]`, the same for a re-enable and for
  `reload()`. Fix in `server/features/vpn.js`: `startTunnel()` now calls `t.start()` (which moves the tunnel to `'starting'`
  synchronously) before the first `publishAll()`, `bringUp()` no longer publishes between the proxy and the tunnel, and `state()`
  maps a `'stopped'` tunnel object to `'connecting'` instead of `'error'` (`'error'` remains for a worker/start failure, a pending
  restart or no tunnel object). After the fix the recorder shows `["connecting","up"]` for `enable()`, re-enable and `reload()`.
  Regression assertions added to `test/vpn.test.js` (feature suite, tests 3 and 4): every value written to `vpn.state` during
  `enable()` and during a `start()` with the persisted switch on must be exactly `['connecting', 'up']` (recorded by wrapping
  `store.set`, because the store batches patches every 50 ms and a flash could hide inside one patch).

Documented deviations that stand (already in the builder notes, listed here so the orchestrator has one place):

- Tunnel `'exit'`/`'error'` fire only for an unrequested worker death after a successful `start()`; a requested `stop()` emits
  neither, a failure during `start()` only rejects. The feature restarts on both events; the tests assert no event on `stop()`.
- `features/vpn.js` loads `conf.js`/`wireguard.js` with a dynamic `import()` in `start()` and accepts a `seams` field for tests.
- `enable()`/`reload()` reject with `FAILED` when the tunnel cannot start; the switch stays on, the proxy answers 502, restarts
  run with 5/10/30 s back-off. The persisted switch brings the VPN up at `start()`.
- `vpn.bytesIn/bytesOut` are UDP wire bytes (null while disabled); `vpn.handshakeAgeS` is seconds since the tunnel first came up.
- Dead peer is detected late (state stays `up` for up to 180 s; new connects fail with `vpn-open-timeout`); fail-closed holds.

## Housekeeping

- `test/fixtures/vpn/bin/.gitignore` (new, inside Part C's glob) ignores the 14 MB `testpeer.exe`; `git check-ignore -v` now
  reports it ignored. The Go sources stay tracked; the suites fall back to `LUMEN_TESTPEER` or the CineHD worktree copy and skip
  cleanly when no binary exists (plan §10.4). Revert this file if the binary should be committed instead.

## What ran

| Step | Result |
|---|---|
| `node --test test/vpn.test.js` before any change | 20 tests, 19 pass, 0 fail, 1 skipped (re-handshake, by design), exit 0, 25.2 s; handshake ready 1663 ms, resolve 7 ms, GET 37 ms, 5 MiB 17.1 Mbit/s (full suite was running in parallel), three 502s with the peer gone 2023 ms |
| `npm test` before any change | 187 tests, 186 pass, 0 fail, 1 skipped, exit 0, 38.0 s |
| `node tools/scratch/vpn-integrate/transitions.mjs` before the fix | `enable()` → `error, connecting, up`; re-enable and `reload()` the same |
| the same after the fix | `connecting, up` for all three; `disable()` → `off`; no key in the log |
| `node --test test/vpn.test.js` after the fix + new assertions | 20 tests, 19 pass, 0 fail, 1 skipped, exit 0, 21.0 s; handshake ready 926 ms, resolve 4 ms, GET 18 ms, 5 MiB 38.4 Mbit/s, worker threads 2 → 0 after `stop()`, keepalive +96 bytes / 4.5 s |
| `node tools/scratch/vpn-integrate/throughput.mjs` (20 MB) | see below |
| `npm test` after all changes | 187 tests, 186 pass, 0 fail, 1 skipped, exit 0, 45.6 s; runner exited by itself; `tasklist` shows 0 `testpeer.exe` |
| `node --check` on `server/vpn/*.js`, `server/features/vpn.js`, `test/vpn.test.js`, `test/helpers.js` | OK |

## Throughput: one 20 MB transfer through the proxy over the loopback tunnel

`tools/scratch/vpn-integrate/throughput.mjs`: Go peer → `createTunnel` (up in 592 ms) → `createVpnProxy` → one
`GET http://10.66.0.1/blob?bytes=20971520` sent to the proxy as an absolute URI, then the same blob once more over `CONNECT`.

| Path | Bytes | Time | Throughput |
|---|---:|---:|---:|
| absolute-URI GET via the proxy | 20,971,520 received, Content-Length 20,971,520, every byte `0x5a` | 4,349 ms | **38.6 Mbit/s** |
| CONNECT 10.66.0.1:80 + raw GET via the proxy | 20,971,520 received | 3,802 ms | 44.1 Mbit/s |

Wire counters over the absolute-URI download: `rx` +34,480,032 bytes, `tx` +1,225,776 bytes (rx/payload 1.64, the unexplained
overhead the plan §14.1 records). Main-thread max event-loop lag during the transfers: 16 ms (10 ms sampler). Afterwards
`tunnel.stop()` → `stopped`, proxy port `null`, no key in the log, process exited by itself. Numbers are from this PC with the
other workflows running; the plan observed 28.6–37.4 Mbit/s for the same transfer.

## Open items for the orchestrator

- Integration into `server/hub.js`, `server/app.js`, `server/features/browser.js`, `web/**`, `server/store.js` EPHEMERAL and the
  spec paragraph: steps in `docs/build-notes/followup-3-integration.md` (not applied here; those files belong to the other workflow).
- Edge flags (`--proxy-server`, `--host-resolver-rules`, `--disable-quic`, WebRTC policy) remain to be validated with a real launch.
- Re-handshake/rekey is not observed by any test (needs 120–180 s; the Go peer never initiates).
- The `rx` ≈ 1.6× payload overhead and the ~40 Mbit/s loopback ceiling are inherent to the copied wasm/shim path.
