# Follow-up 3, Part A: `vpn-tunnel` build notes

Date: 2026-10-22. Role: `vpn-tunnel`. Plan followed: `docs/build-notes/followup-3-vpn-port-plan.md` §2, §4, §5, §6, §7, §9, §11.1, §11.2, §16.
Files owned and written: `server/vpn/wireguard.js`, `server/vpn/conf.js`, `server/vpn/third_party/**`, this note.
Scratch (gitignored, `tools/scratch/` is in `.gitignore`): `tools/scratch/vpn-tunnel/conf-check.mjs`, `run.mjs`, `start-fail.mjs`.

Everything below ran on this PC (Node v22.18.0, Windows 11). The only WireGuard peer contacted was the Go test peer
(`bin/testpeer.exe`) on 127.0.0.1 with throwaway keys from `testpeer genkey`; the conf parser was exercised with
`crypto.randomBytes` keys. Nothing touched the TV, the emulator, any LAN device, any internet endpoint, the Lumen server on
8790, `server/hub.js`, `server/app.js`, `server/features/browser.js` or `web/**`. No real `.conf` or real key was read, printed
or copied. No sdb, no installs, no `npm` changes, no wasm rebuild. The CineHD worktree was only read (and hashed).

## Files

### `server/vpn/third_party/` (copies, per plan §2)

All eleven copies were hashed after copying; every size/SHA-256 equals the plan's table (the shim differs only by its one
documented edit). Provenance, licences and build flags are in `server/vpn/third_party/NOTICE.md`.

| File | Bytes | Note |
|---|---:|---|
| `wg-core/wg-core.cjs` | 128724 | `wasm/dist/node/wg-core.js`, renamed `.cjs`, unedited |
| `wg-core/wg-core.wasm` | 116179 | unchanged |
| `wg-core/src/{mux.h, tunnel.h, config.h, lwipopts.h}` | 1482 / 1441 / 1393 / 2977 | reference headers, unchanged |
| `cinehd/tizentvwasm-shim.cjs` | 11014 | line 57: `'tizentvwasm-io-worker.js'` → `'tizentvwasm-io-worker.cjs'`; `diff` against the source shows only that line |
| `cinehd/tizentvwasm-io-worker.cjs` | 10457 | unchanged (copied from the worktree, **not** from the port-plan scratch, whose io-worker is a 10630-byte experimental variant) |
| `licenses/lwip-COPYING`, `licenses/wireguard-lwip-LICENSE`, `licenses/x25519-MIT` | 1450 / 1602 / 1120 | BSD-3, BSD-3, MIT notices |
| `NOTICE.md` | — | provenance table (worktree path, commit `3be48659`, hashes), licence names, SDK 1.39.4.7 fastcomp, build flags |

### `server/vpn/conf.js` (134 lines)

```js
export function parseWireGuardConf(text)
  → { privateKey, address: string[], dns: string[], peer: { publicKey, presharedKey?, endpoint: 'host:port', allowedIPs: string[], keepalive?: number } }
  throws LumenError('INVALID', message) with exactly the §9.2 messages:
    'PrivateKey is missing' | 'PrivateKey is not a 32-byte base64 key' | 'PublicKey is missing' | 'PublicKey is not a 32-byte base64 key'
    | 'PresharedKey is not a 32-byte base64 key' | 'Address needs an IPv4 entry' | 'DNS needs an IPv4 server (names are resolved inside the tunnel)'
    | 'Endpoint needs host:port' | 'Endpoint host may only contain letters, digits, dots and dashes' | 'config is larger than 16 KB'
    | 'line N is longer than 599 bytes' | 'one peer only' | 'config must be text'
export function serializeWireGuardConf(conf, { keepalive = 25 } = {}) → canonical LF text (§9.3 shape, PresharedKey line only when present)
export function summarizeWireGuardConf(conf) → { endpoint, address, dns, keepalive, publicKeyPrefix }   // the only loggable conf object
```

Rules mirrored from `config.c`: `#` starts a comment anywhere; CRLF accepted; whole file ≤ 16,384 bytes; each line ≤ 599 bytes
*including* a trailing `\r` (the C counts bytes up to `\n`); keys are global (section headers skipped) but a second `[Peer]` is an
error; key = 44 chars `[A-Za-z0-9+/]{43}=` decoding to 32 bytes; `Address`/`DNS`/`AllowedIPs` are comma lists kept as written, with
the first IPv4 (mask dropped) used for serialisation; `Endpoint` split at the last `:`, host `[A-Za-z0-9.-]+`, port 1–65535, `[` rejected;
`PersistentKeepalive` 1–65535 kept, anything else omitted; `MTU`, `Table`, `ListenPort`, `FwMark`, `PostUp` … ignored. No message ever
includes a value.

### `server/vpn/wireguard.js` (752 lines; main-thread hub + worker body in one file, plan §5)

```js
export function createTunnel({ conf, log, openTimeoutMs = 15000, dnsTimeoutMs = 10000, startTimeoutMs = 15000 }) → tunnel
  // conf = parseWireGuardConf() result (TypeError when it has no peer.endpoint); log = Lumen logger (tag log.child('vpn')) or absent
tunnel.start()             → Promise<void>  resolves when the worker posted `started` and the wasm's HELLO arrived on the hub link;
                                            rejects Error{ code, rc? } — codes: 'load-failed' | 'selftest-failed' | 'start-failed' (rc = wg_start code,
                                            message carries the core's lastError) | 'mux-connect-failed' | 'poll-failed' | 'wasm-abort' | 'worker-crashed'
                                            | 'vpn-worker-exit' | 'vpn-start-timeout' | 'vpn-tunnel-down' (stop() during start). Idempotent while running/starting.
tunnel.stop()              → Promise<void>  fails open streams with 'vpn-tunnel-down', sends {cmd:'stop'} (wg_stop + shutdownShim + thread exit),
                                            terminate()s after 1 s if needed, closes the listener. Idempotent; afterwards status().state === 'stopped'.
tunnel.connect(host, port) → Duplex         'connect' on OPENED, 'error' (err.code: §7.3 codes + 'vpn-open-timeout' | 'vpn-link-lost' | 'vpn-stream-closed'
                                            | 'vpn-tunnel-down' | 'vpn-too-many-streams'), 'close'. Writes before 'connect' are buffered. Not up → a Duplex
                                            that errors 'vpn-tunnel-down' on the next tick; > 30 open → 'vpn-too-many-streams'. Has no-op setTimeout/
                                            setNoDelay/setKeepAlive/ref/unref so http.request({ createConnection }) and the proxy can treat it as a socket.
tunnel.resolve(host)       → Promise<string> IPv4 literal → itself (no frame); else DNS frame through the tunnel; rejects 'vpn-dns-failed' | 'vpn-dns-timeout'
                                            | 'vpn-tunnel-down' | 'vpn-link-lost'. Concurrent lookups of one name share a frame.
tunnel.status()            → { state, handshake, handshakeAgeMs, retries, rx, tx, endpoint, uptimeMs, linked, streams, lastError }
                              state: 'stopped' | 'starting' | 'handshaking' | 'up' | 'down' | 'error'
tunnel.port                → hub loopback port while listening, else null (tests only)
events: 'status' (every worker status post: 1 Hz + every state/handshake/link transition; payload = status()), 'up', 'down',
        'error' (worker failure after a successful start; emitted only when a listener exists), 'exit' ({ code }: worker died on its own after a successful start)
export const FRAME_TYPES; export function encodeFrame(type, stream, payload); export function createFrameDecoder(onFrame, onError)
```

Internals that follow the plan exactly: frame header `u8 type | u32be stream | u32be len`, decoder cap 1 MiB; `TX_INITIAL_CREDIT`
65,536 and `MAX_DATA_FRAME` 32,768 toward the wasm, `CREDIT_GRANT` 32,768 from `_read()`; stream ids wrap at 4,294,967,000; hub cap
30 streams; listener on `127.0.0.1:0`, loopback peers only, one link at a time (further connections destroyed), first frame must be
HELLO within 2 s; link loss fails every stream with `vpn-link-lost`; EOF = half-close (`allowHalfOpen`), RST = abort, a stream whose
both sides sent EOF is released without an RST. Worker: `globalThis.self = globalThis`, `installTizenSocketsShim` before
`createWgCore({ wasmBinary, print, printErr, onRuntimeInitialized (delete m.then), onAbort })`, `wg_selftest` once, `wg_start(confText)`,
`wg_mux_connect('127.0.0.1', muxPort)`, then `wg_poll(20)` → `wg_status` → `setImmediate`, status posted on any
`state|handshake|mux.linked` change or every 1000 ms, re-dial every 500 ms while unlinked; `{cmd:'stop'}` → `wg_stop`, `shutdownShim`,
`stopped`, `process.exit(0)` (thread only). `workerData` = `{ role, confText, muxPort }`; `confText` never appears in posts, logs, errors.

## Interpretations and deviations from the plan

1. **`startTimeoutMs` (15 s, option).** Not in the plan. Without it a stuck worker would hang `start()` forever; on timeout the worker is
   stopped/terminated and `start()` rejects `vpn-start-timeout`.
2. **When `'error'` / `'exit'` fire.** The plan lists both without saying when. Here a failure *during* `start()` only rejects the
   promise (no event); a failure *after* a successful start emits `'error'` (worker-posted or thrown error) or `'exit'` (the thread
   died without posting one); a requested `stop()` emits neither. Part C's suite was adjusted to this (its note, deviation 1) and
   Part B's feature restarts on either event, so a `disable()` never triggers a restart.
3. **`'status'` events come only from the worker's posts**, not from the STATUS frames on the mux (both carry the same `wg_status`
   JSON at 1 Hz; the frames just refresh the cached status). So `status()` can be up to ~1 s stale for counters, as the plan's §14.3 notes.
4. **`linked` means "the wasm's HELLO arrived"**, not "a TCP connection was accepted" (plan §7.6.4 says require HELLO within 2 s; I
   also gate `start()` and `state 'up'` on it so a stray local connection cannot look like the link).
5. **Stream errors are emitted only when someone listens** (as CineHD's hub did); the stream always closes and a pending write's
   callback gets the error. A consumer that forgets an `'error'` listener therefore cannot crash Lumen. Verified (`noListenerFailureClosedQuietly`).
6. **`stop()` fails streams with `'vpn-tunnel-down'` before telling the worker to stop**, so consumers see that code rather than the
   `vpn-link-lost` they would get from the link closing a few ms later.
7. **conf.js is a slight superset of config.c**: key names are matched case-insensitively (the C needs exact case; the serialiser
   emits canonical names anyway); `PersistentKeepalive = 0` is treated as "absent" and therefore becomes the 25-second default on
   serialisation (plan §9.3: a PC behind NAT needs it); `summarizeWireGuardConf` returns the *first IPv4* of `address`/`dns` as
   strings and the effective `keepalive` (25 when absent), i.e. the values that actually go to the wasm.
8. **`FRAME_TYPES`, `encodeFrame`, `createFrameDecoder` are exported** (the plan has them "inside wireguard.js"); exporting them lets
   tests speak the protocol without a copy. `createTunnel` throws `TypeError` for a conf without `peer.endpoint`.
9. **The worker reads `wg_status` after every 20 ms poll slice** (≈ 50 Hz, a 2 KB malloc + JSON parse) so transitions are posted
   immediately; the plan's "immediately when state, handshake or mux.linked changed" needs this. Cost is invisible next to `wg_poll`.
10. **No log line at `info` for `tunnel starting`** beyond the state-transition lines (`tunnel starting` / `handshaking` / `up` /
    `down` / `error` / `stopped` with `{ from, endpoint }`); `hubPort`, stream opens, link up/down and wasm `print` lines are `debug`.

## Known gaps

- **Rekey / re-handshake not observed** (needs 120–180 s; the Go peer never initiates). The core does it transparently (plan §8);
  `handshakeAgeMs` is the core's "since first up", `rx`/`tx` are UDP wire bytes.
- **Dead peer is detected late** (plan §12.7): with the peer killed the state stayed `up` and `connect()` failed with
  `vpn-open-timeout` after `openTimeoutMs` (2001–2006 ms observed with 2000). Fail-closed holds; the UI will say "up" for up to 180 s.
- **Not exercised with the real core:** `load-failed`, `selftest-failed`, `mux-connect-failed`, `poll-failed`, `wasm-abort`,
  `worker-crashed`, the `terminate()` fallback (graceful stop always completed in 15–37 ms) and `vpn-start-timeout`. They are
  straight-line code; Part B exercised the feature's restart logic against a fake tunnel.
- **Backpressure on the loopback link socket is not applied** (`link.write()` return value ignored, as in CineHD); the outstanding
  volume is bounded by 64 KiB credit × 30 streams ≈ 2 MB.
- **The hub port is an unauthenticated loopback listener** (plan §12.12); the mitigations are implemented (loopback only, one link,
  HELLO within 2 s, extra connections destroyed) but HELLO is a fixed public string, not a secret.
- Stream-id reuse after the 4.29-billion wrap is theoretically possible with long-lived streams (same as CineHD). IPv4 only.
- Timing on this PC today varies with the load from the other workflows: handshake 411–902 ms, 5 MiB blob 16.8–33.8 Mbit/s (my runs) and
  29.7 Mbit/s (Part C's run), DNS resolve 5–827 ms (one slow outlier, 5–7 ms otherwise).

## Verification performed (exactly what ran)

1. **Copies and hashes.** `stat -c %s` + `sha256sum` on the 14 worktree sources (plan §2) → all equal the plan; the same on the 11
   copies in `server/vpn/third_party/` → equal (shim 11014 bytes with its one-line diff; `diff` output is only line 57).
   `git -C <worktree> log -1` → `3be48659`.
2. **`node --check`** on `server/vpn/conf.js`, `server/vpn/wireguard.js`, `third_party/cinehd/tizentvwasm-shim.cjs`,
   `third_party/cinehd/tizentvwasm-io-worker.cjs`, `third_party/wg-core/wg-core.cjs` → OK (repeated after every edit).
3. **`node tools/scratch/vpn-tunnel/conf-check.mjs`** → **30/30** (first run 28/29: my 599-byte test forgot that a CRLF line of 599 visible
   chars is 600 bytes, which `config.c` also rejects; fixed the test, added the 600-byte rejection case). Covers the Proton-shaped CRLF
   conf with comments/IPv6 entries, summary without keys, canonical serialisation (LF only, PSK kept, user keepalive kept, default 25,
   option `{ keepalive: 7 }`), round-trip, hostname endpoint, case-insensitive keys, ignored keys, `PersistentKeepalive = 0`, and 21
   error cases each asserted as `LumenError` `INVALID` with the exact message and no key fragment in the message.
4. **`node tools/scratch/vpn-tunnel/run.mjs`** (ESM; spawns the Go peer with `genkey` keys; `createTunnel` + `http.request({ createConnection })`),
   three full runs, all exit 0 with the process ending by itself (no handle left). Final run, in order:
   - `start()` resolved in 247 ms (`state 'handshaking'`, `linked true`, `uptimeMs 15`); `'up'` event and `state 'up'` at 865 ms from `start()`
     (core: `handshakeAgeMs 0`, `uptimeMs 411`, `rx 92`, `tx 180`, `retries 0`); status trace `[248 handshaking/pending, 841 up/ok]` — the
     transition was posted the moment the core saw it; peer log `handshake ok`. Earlier runs: up at 1115 ms (core 415 ms) and 1203 ms (core 902 ms).
   - `resolve('anything.test')` → `10.66.0.1` in 5 ms (827 ms in run 2); `resolve('10.66.0.1')` → itself; two concurrent resolves of one name → both `10.66.0.1`.
   - `GET /hello` → 200 `hello from wg peer` in 11 ms; the same with host `name.test` (resolved by the core inside the tunnel) → same body.
   - 5 MiB blob → 5,242,880 bytes in 1242 ms = **33.8 Mbit/s**, main-thread max event-loop lag **8 ms** (runs 1–2: 28.3 Mbit/s / 11 ms, 16.8 Mbit/s / 12 ms).
   - Upload: keep-alive `POST /hello` with a 204,800-byte body then `GET /hello` on the same stream → two `HTTP/1.1 200` responses, two
     bodies, write callback fired at 32 ms, **no stream error**, `tx` +216,960 wire bytes: the 64 KiB window / 32 KiB frames / CREDIT
     refill path carries > 64 KiB without `write-failed`.
   - `'connect'` event fires; `streams` 1 → 0 after `destroy()`; port 81 inside the tunnel → `RST connection-reset`; a failing stream with a
     pending write and no `'error'` listener closed quietly (no throw); 30 held streams → the 31st errors `vpn-too-many-streams` without an
     OPEN frame; all released → 0. 5 `'status'` events over ~5 s of running.
   - `stop()` in 33 ms → `state 'stopped'`, every counter 0, `linked false`; old hub port `ECONNREFUSED`; `connect()`/`resolve()` while
     stopped → `vpn-tunnel-down`; second `stop()` a no-op; `start()` again on the same object → `up` in 669 ms, `/hello` OK; events seen: `up, up`
     (no `down`/`error`/`exit`).
   - `PersistentKeepalive = 1`, no streams, 3 s idle → `tx` +64 bytes (two 32-byte keepalives).
   - Wrong peer key: `start()` resolved in 227 ms with `state 'handshaking'`; `connect()` → `vpn-tunnel-down`; after 7 s `handshake 'pending'`,
     `retries 1`, `tx 296`; `stop()` → `stopped`.
   - Peer killed while up: `connect()` → `vpn-open-timeout` after 2006 ms (`openTimeoutMs: 2000`), state still `up` (plan §12.7).
   - `logLinesWithKeyMaterial: 0` — no 44-char key-shaped string in any captured log line.
5. **`node tools/scratch/vpn-tunnel/start-fail.mjs`** (offline: conf object with `address: []`): `start()` rejected in 117 ms with
   `{ code: 'start-failed', rc: -6, message: 'wg_start returned -6: config error -6' }`, `state 'error'`, `lastError` the same text, `port null`
   (listener closed), no events, `stop()` → `stopped`, no key fragment in the error/status, process exited by itself.
6. **Part C's suite against this code:** `node --test test/vpn.test.js` → **20 tests, 19 pass, 0 fail, 1 skipped** (re-handshake, by design),
   exit 0, 21.0 s wall, exits without `--test-force-exit`; its diagnostics: handshake ready 1476 ms, resolve 7 ms, GET 39 ms, 5 MiB 29.7 Mbit/s,
   two 502s while handshaking in 10 ms, three 502s with the peer gone in 2015 ms, keepalive +96 bytes / 4.5 s, **worker threads 2 while up → 0
   after `stop()`**. `tasklist` afterwards: 0 `testpeer.exe`.
7. **Footprint:** `git status` shows `?? server/vpn/` (my files plus Part B's `proxy.js`) and this note; `tools/scratch/vpn-tunnel/**` is
   ignored (`git check-ignore`). No other file was touched by this role.

Not done: no Edge launch, no real `.conf`, no TV/emulator/LAN/internet contact, no wasm rebuild, no `npm` changes, no edits outside Part A's files.
