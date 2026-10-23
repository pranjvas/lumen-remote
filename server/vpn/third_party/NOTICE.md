# Third-party code under `server/vpn/third_party/`

Everything in this directory was copied, byte for byte unless noted, from the CineHD worktree
`C:/Users/pranj/Documents/Codex/2026-09-16/how-x20/.worktrees/proton-wg-tunnel` at commit `3be48659`
(paths below are relative to `work/wg-tunnel/` in that worktree). Copied on 2026-10-22 for Lumen
follow-up 3 (Part A, `vpn-tunnel`); the porting plan is `docs/build-notes/followup-3-vpn-port-plan.md`.

| File here | Source in the worktree | Bytes | SHA-256 | Change |
|---|---|---:|---|---|
| `wg-core/wg-core.cjs` | `wasm/dist/node/wg-core.js` | 128735 | `cae989c4fafd05f638c0b9ce7815f96de71ab33f1e3ace5de414a90b3c53760c` | rebuilt for Lumen with more streams (see below); renamed `.js` → `.cjs`; Lumen poll anchor (see the last section) |
| `wg-core/wg-core.wasm` | `wasm/dist/node/wg-core.wasm` | 116185 | `4ed046b3bb7195342081f69c0ee57a918f487acc408ec39dbeef902323ad715a` | rebuilt for Lumen with more streams (see below), then with a larger DNS table (see the last section) |
| `wg-core/src/mux.h` | `core/mux.h` | 1483 | `127875d1456b61e4c8bc7b69a9958ab243a6334fcce16e2b76ba59ce7c85ee45` | `MUX_MAX_STREAMS` 32 → 260 (reference: mux constants) |
| `wg-core/src/tunnel.h` | `core/tunnel.h` | 1441 | `ff5fb35e72a9c713db4aa81e4a1d10497e4f03f7e7b612ce76044b27e8c06b84` | none (reference: exports) |
| `wg-core/src/config.h` | `core/config.h` | 1393 | `ed33fff075afb98893197bc334d8599d0a3e395a413c5b796266e62589294343` | none (reference: error codes) |
| `wg-core/src/lwipopts.h` | `core/lwipopts.h` | 2979 | `78c0c8a0f6180686f78182c2ae047c888b9561027f56218df8809d839e9ca595` | `MEMP_NUM_TCP_PCB` 32 → 300, `MEMP_NUM_TCP_SEG` 1024 → 6144, `PBUF_POOL_SIZE` 2048 → 6144, `MEM_SIZE` 4 → 12 MiB, then `DNS_TABLE_SIZE` 8 → 64, `MEMP_NUM_UDP_PCB` 8 → 72, `LWIP_TCP_RTO_TIME` 1000 (reference: buffer sizes) |
| `cinehd/tizentvwasm-shim.cjs` | `testing/tizentvwasm-shim.js` | 11013 → 11014 | source `873d10a7f3ec8bbb04e1a149d1700a0fa79a8f1fefc3aabd42be9ec971954e16` | renamed `.cjs`; line 57 loads `tizentvwasm-io-worker.cjs` instead of `.js`; Lumen performance edits (see the last section) |
| `cinehd/tizentvwasm-io-worker.cjs` | `testing/tizentvwasm-io-worker.js` | 10457 | `832d1b70f682ff5607ac6df452040f116eae3a1956966b83d024bfabbfd281b8` | renamed `.cjs`; Lumen performance edits (see the last section) |
| `licenses/lwip-COPYING` | `third_party/lwip/COPYING` | 1450 | `d51980b934e4411a8e0d80ce61afa28978bf0d49c50d0ee93f705679cb8a6042` | none |
| `licenses/wireguard-lwip-LICENSE` | `third_party/wireguard-lwip/LICENSE` | 1602 | `3bdbcf303414b7c8b6cb16877f41721c0ae0d97e965c1e7699bf7fc815b05965` | none |
| `licenses/x25519-MIT` | `third_party/wireguard-lwip/src/crypto/refc/x25519-license.txt` | 1120 | `c7090f593080b4ca211ce5229ccb5bc4f14c7a8a1eb21c8b46f921262dd94208` | none |

## What `wg-core.wasm` contains and the licences that apply

- **lwIP 2.2.1** (IPv4, TCP, UDP, DNS client) — BSD-3-Clause, Swedish Institute of Computer Science.
  Notice: `licenses/lwip-COPYING`.
- **wireguard-lwip** (Noise IK handshake, ChaCha20-Poly1305, BLAKE2s, X25519 glue) — BSD-3-Clause,
  Daniel Hope / Floorsense. Notice: `licenses/wireguard-lwip-LICENSE`.
- **X25519 reference implementation** embedded in wireguard-lwip (`crypto/refc/x25519.c`) — MIT,
  Cryptography Research, Inc. Notice: `licenses/x25519-MIT`.
- **CineHD core** (`core/tunnel.c` underlay netif + UDP transport, `core/mux.c` frame protocol,
  `core/config.c` wg-quick parser, `core/wg_platform.c`) — the user's own project code.

The redistributed binary keeps these notices alongside it, as the BSD and MIT terms require.

## Build provenance (not rebuilt here)

Built in the worktree with `node work/wg-tunnel/wasm/build.cjs --target node` using the Samsung
Emscripten SDK **1.39.4.7 (fastcomp)** at `C:/Users/pranj/Documents/Codex/Tools/SamsungEmscripten/emscripten-release-bundle/emsdk`.
Flags: `-Os -std=gnu99 -s WASM=1 -s ALLOW_MEMORY_GROWTH=1 -s TOTAL_MEMORY=67108864 -s ENVIRONMENT=node
-s ENVIRONMENT_MAY_BE_TIZEN=1 -s MODULARIZE=1 -s EXPORT_NAME=createWgCore -s INVOKE_RUN=0 -s EXIT_RUNTIME=0
-s ERROR_ON_UNDEFINED_SYMBOLS=1`, exports from `wasm/dist/node/wg-core-exports.json`, runtime methods
from `wasm/runtime-exports.json`; the glue was then post-processed by `tools/patch-glue.cjs` (9 anchors).
`dist/tv/wg-core.wasm` has the same hash as the node binary copied here.

## How the pieces fit in Lumen

`server/vpn/wireguard.js` starts a `worker_threads` Worker that `require()`s `cinehd/tizentvwasm-shim.cjs`
(which provides the `tizentvwasm` sockets namespace the Samsung glue expects, backed by an I/O worker that
owns the real `node:dgram` / `node:net` sockets) and then `wg-core/wg-core.cjs`, which instantiates
`wg-core.wasm`. Edits beyond the renames are listed in the last section.

## Lumen rebuild (2026-10-23): more concurrent streams (160, then 260 with Lumen capping at 250)

A web page through the Browser view's VPN opens far more than 32 connections (Edge alone keeps up to
32 sockets per proxy), so the original core's 32-stream mux made pages such as Dailymotion fail with
`ERR_TUNNEL_CONNECTION_FAILED`. The core was rebuilt from the same commit (`3be48659`, exported with
`git archive`, the worktree untouched) with only the constants listed above changed, using the same
Samsung Emscripten SDK and `node work/wg-tunnel/wasm/build.cjs --target node`. An unmodified rebuild
first reproduced the shipped `wg-core.wasm` byte for byte (`ec9a835f…`), so the toolchain is the same.

## Lumen performance edits (2026-10-23, branch `perf/vpn`)

Measured problems and numbers: `docs/build-notes/2026-10-23-browser-perf-measurements.json`
(`vpnTunnel`, `pageLoad`). Edits to the vendored files, in order:

1. **Blocking poll.** `wg-core.cjs` gets a 10th glue anchor, applied after CineHD's 9 by
   `node tools/vpn/patch-wg-glue.cjs server/vpn/third_party/wg-core/wg-core.cjs` (idempotent; rerun it
   after every rebuild). `___syscall168` was a busy-wait that probed each fd with `poll(timeout 0)`
   until the timeout ran out (about 28,000 shim round trips a second at idle, one core pinned); a
   socket-only fd set now goes to the glue's own blocking `SOCKFS.callPoll`. Idle CPU with the tunnel
   up: 1.05 → 0.03 cores. `tizentvwasm-io-worker.cjs` `ops.poll` now removes its waiter from every
   socket when it finishes and registers once per socket, so waiter lists stay bounded now that
   poll blocks.
2. **Per-call overhead.** `tizentvwasm-shim.cjs` throws one cached `SockError` per errno (no stack
   capture for every EAGAIN) and copies the aux words with `Int32Array.slice` instead of
   `Array.from`. `tizentvwasm-io-worker.cjs` no longer runs `JSON.stringify` on every request when
   debugging is off, copies a request payload once instead of twice, and sets the UDP socket's
   receive buffer to 8 MiB and its send buffer to 1 MiB (the 64 KB default fills in ~3 ms at line
   rate while lwIP's window allows ~500 datagrams in one burst).
3. **Rebuilt core: DNS table 64, 1 s first retry.** Rebuilt as above (same `3be48659` archive, same
   Samsung SDK, `node work/wg-tunnel/wasm/build.cjs --target node`) with three more `lwipopts.h`
   changes: `DNS_TABLE_SIZE` 8 → 64 (lookups pending at once and names cached; the 9th concurrent
   lookup used to fail at once with `dns-failed`), `MEMP_NUM_UDP_PCB` 8 → 72 (lwIP's DNS takes a
   random source port per pending lookup) and `LWIP_TCP_RTO_TIME` 3000 → 1000 ms (a lost SYN cost a
   3 s stall; 1 s is the RFC 6298 initial value). The glue differs from the previous build only in
   static memory addresses; the poll anchor from item 1 was re-applied. New hashes:
   `wg-core.wasm` 116201 bytes `057a44177827ba4285ef0806b3e61fc596304612ff61f9c94aa291caf31bde4e`;
   glue as emitted `cfe448a6d73df83ad71c76dd4e524493f3b6ee18e97ab40687f113634dfdf9ca`
   (128735 bytes, before the Lumen anchor); `src/lwipopts.h` is the file used.
4. **Batched UDP.** Every WireGuard datagram in or out was one synchronous shim round trip. For
   nonblocking UDP fds, `tizentvwasm-shim.cjs` now queues `sendTo` and posts the queue as one
   `sendbatch` message ahead of the next synchronous call (or at 128 datagrams / 512 KB);
   `recvFrom` is served from a local queue that one `recvmany` call fills with up to 64 datagrams;
   `poll` reports POLLIN for fds with queued datagrams and then only probes the worker.
   `tizentvwasm-io-worker.cjs` gains the `recvmany` op and the `sendbatch` message (never replied
   to). A UDP send already answered "sent" before dgram's callback, so no visible error changes.
   TCP paths and MSG_PEEK semantics are unchanged.
