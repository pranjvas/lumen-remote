# Follow-up 3, Part R: porting plan for the in-process WireGuard tunnel (`vpn-port-plan`)

Date: 2026-10-22. Author role: `vpn-port-plan`. Binding for Parts A (`vpn-tunnel`), B (`vpn-proxy`) and C (`vpn-tests`).
Source studied: the CineHD worktree `C:/Users/pranj/Documents/Codex/2026-09-16/how-x20/.worktrees/proton-wg-tunnel` at commit `3be48659`
(read-only; its `work/wg-tunnel/**` tree has no uncommitted changes), the design/plan/acceptance docs named in the brief, every
file under `work/wg-tunnel/core`, `wasm`, `service`, `protocol`, `probe`, `testing` and the vendored `third_party` licences, plus the
Lumen spec (§8, §11.3), `server/store.js`, `server/config.js`, `server/log.js`, `server/hub.js`, `server/app.js`, `test/helpers.js`.

Everything marked **observed** below was run on this PC today (Node v22.18.0, Windows 11) against the Go test peer on
127.0.0.1 only. Nothing contacted the TV, the emulator, any LAN device or any internet VPN endpoint. No real `.conf` or real key
was read; the Go peer generated throwaway keys for every run. Section 15 lists the exact commands and results.

---

## 1. What is being ported, in one picture

```
Lumen process (Node 22, ESM)
│
├─ main thread
│   ├─ server/features/vpn.js      state machine, data/vpn/wg.conf + state.json, store keys vpn.*           (Part B)
│   ├─ server/vpn/proxy.js         HTTP proxy on 127.0.0.1:<ephemeral>: CONNECT + absolute-URI; 502 when down (Part B)
│   └─ server/vpn/wireguard.js     createTunnel(): owns the "hub" (a net.Server on 127.0.0.1:<ephemeral>)      (Part A)
│                                  that speaks the mux frame protocol with the wasm, turns mux streams into
│                                  Duplex objects, resolves names through the tunnel, spawns/stops the worker
│         ▲ loopback TCP "mux link" (one connection, frames: u8 type | u32be stream | u32be len | payload)
│         │
├─ tunnel worker  (node:worker_threads Worker started by wireguard.js)
│   ├─ third_party/wg-core/wg-core.cjs   Samsung-Emscripten glue (node target) → instantiates wg-core.wasm
│   │     wg-core.wasm = wireguard-lwip (Noise IK, ChaCha20-Poly1305, BLAKE2s, X25519) + lwIP 2.2.1 (IPv4, TCP, UDP, DNS)
│   │     + CineHD core/: tunnel.c (underlay netif + UDP transport), mux.c (frame protocol), config.c (wg-quick parser)
│   ├─ third_party/cinehd/tizentvwasm-shim.cjs   implements the `tizentvwasm.SocketsManager` namespace the glue calls;
│   │     every call blocks on Atomics.wait until the I/O worker answers (the TV extension is synchronous too)
│   └─ poll loop: wg_poll(20) → setImmediate → …, status posted to main every 1 s and on every state change
│         ▲ SharedArrayBuffer (4 MiB data + 128 control words) + postMessage
│         │
└─ I/O worker  (spawned by the shim: third_party/cinehd/tizentvwasm-io-worker.cjs)
    owns the real sockets: node:dgram (the WireGuard UDP transport to the peer endpoint) and node:net
    (the mux link to the hub on the main thread); node:dns only for the *endpoint hostname* (outside the tunnel)
```

Why three threads: the shim makes the wasm's socket calls synchronous by blocking the calling thread (`Atomics.wait`), and
`wg_poll(20)` blocks up to 20 ms per call. On the main thread that would stall Lumen's WebSocket, HTTP and TV polling.
**Observed:** with the core in a Worker, the main thread's maximum event-loop lag during a 20 MB transfer at 29–37 Mbit/s was
7–16 ms (sampled every 10 ms); with the CineHD PC demos (core on the main thread) every poll slice blocks for 20 ms.

Why the loopback mux link stays: `core/mux.c` dials `127.0.0.1:<port>` with a POSIX socket inside the wasm (`socket()`
→ glue → shim → I/O worker `net.connect`). Replacing it with a MessagePort would need C changes and a rebuild with the
Samsung SDK; the brief says not to rebuild. The link costs one extra loopback hop and is exactly the path CineHD verified
(`testing/pc-worker-demo.cjs` + `testing/pc-hub-demo.cjs`), and the path I re-verified today inside a Worker.

---

## 2. Files to copy (with sizes and SHA-256) and where they go

All source paths are relative to `…/.worktrees/proton-wg-tunnel/work/wg-tunnel/`. Byte-identical copies unless a change is listed.
Lumen's `package.json` has `"type": "module"`, so every CommonJS file **must be renamed `.cjs`**; **observed:** a `.js` copy of the
shim fails inside Lumen with `require is not defined in ES module scope`, the `.cjs` copies load and run.

| Source | Bytes | SHA-256 | Destination in Lumen | Owner | Notes |
|---|---:|---|---|---|---|
| `wasm/dist/node/wg-core.js` | 128724 | `fc066832b65a1b00174ee5d1410a56f16039c2c6c999aa93755f23c23b1c6b69` | `server/vpn/third_party/wg-core/wg-core.cjs` | A | Node-target glue, already post-processed by `tools/patch-glue.cjs` (all 9 anchors present). Do not edit. |
| `wasm/dist/node/wg-core.wasm` | 116179 | `ec9a835f8b59e5143c0c907c53c9f77beb8f0bdea6264e61616f8ed76dfbcad9` | `server/vpn/third_party/wg-core/wg-core.wasm` | A | Same binary as the TV build (`dist/tv/wg-core.wasm` has the same hash). |
| `testing/tizentvwasm-shim.js` | 11013 | `873d10a7f3ec8bbb04e1a149d1700a0fa79a8f1fefc3aabd42be9ec971954e16` | `server/vpn/third_party/cinehd/tizentvwasm-shim.cjs` | A | One edit: line 57 `path.join(__dirname, 'tizentvwasm-io-worker.js')` → `'tizentvwasm-io-worker.cjs'` (verified working). |
| `testing/tizentvwasm-io-worker.js` | 10457 | `832d1b70f682ff5607ac6df452040f116eae3a1956966b83d024bfabbfd281b8` | `server/vpn/third_party/cinehd/tizentvwasm-io-worker.cjs` | A | Unchanged. |
| `third_party/lwip/COPYING` | 1450 | `d51980b934e4411a8e0d80ce61afa28978bf0d49c50d0ee93f705679cb8a6042` | `server/vpn/third_party/licenses/lwip-COPYING` | A | BSD-3 (SICS). Required: the wasm embeds lwIP 2.2.1. |
| `third_party/wireguard-lwip/LICENSE` | 1602 | `3bdbcf303414b7c8b6cb16877f41721c0ae0d97e965c1e7699bf7fc815b05965` | `server/vpn/third_party/licenses/wireguard-lwip-LICENSE` | A | BSD-3 (Daniel Hope / Floorsense). Required. |
| `third_party/wireguard-lwip/src/crypto/refc/x25519-license.txt` | 1120 | `c7090f593080b4ca211ce5229ccb5bc4f14c7a8a1eb21c8b46f921262dd94208` | `server/vpn/third_party/licenses/x25519-MIT` | A | MIT (Cryptography Research). Required: the wasm embeds this X25519. |
| `core/mux.h` | 1482 | `99abdb18ae0704c49ad8a482f2f54a3ad1bc90db5cb6ed81f9725b0be95eda66` | `server/vpn/third_party/wg-core/src/mux.h` | A | Optional but recommended: the constants the JS side must agree with (§7). |
| `core/tunnel.h` | 1441 | `ff5fb35e72a9c713db4aa81e4a1d10497e4f03f7e7b612ce76044b27e8c06b84` | `server/vpn/third_party/wg-core/src/tunnel.h` | A | Optional: documents the underlay netif design and the exports. |
| `core/config.h` | 1393 | `ed33fff075afb98893197bc334d8599d0a3e395a413c5b796266e62589294343` | `server/vpn/third_party/wg-core/src/config.h` | A | Optional: the C error codes (§9). |
| `core/lwipopts.h` | 2977 | `827336b49fd6536469967e09d5c6ded859309255cc9c2f1e58c9dc14a8a25412` | `server/vpn/third_party/wg-core/src/lwipopts.h` | A | Optional: the buffer sizes behind the limits in §7. |
| `testing/testpeer/main.go` | 1870 | `7a3515bd4656f3c03c280a1a0623a15eaffdfd52b6b5240600b8c16f1b9adde5` | `test/fixtures/vpn/testpeer-src/main.go` | C | Go sources so the peer can be rebuilt (`go1.25.5 windows/amd64` is installed). |
| `testing/testpeer/peer.go` | 6728 | `19f3c5ba7855d1775a8fc1620254a22352cb4260b1a53c92cace72e607b56ab9` | `test/fixtures/vpn/testpeer-src/peer.go` | C | |
| `testing/testpeer/exit.go` | 8280 | `d263dc93413aea4a2a957f87fbb975ea5810163a742a1ddef68578a58b1e5bce` | `test/fixtures/vpn/testpeer-src/exit.go` | C | Compiles the `-exit` mode; tests must never pass `-exit` (it forwards to the real internet). |
| `testing/testpeer/client.go` | 7773 | `c02eb9c598e67757c41943d983a0f393d3ad181f6551a71d85d3412e177a44e8` | `test/fixtures/vpn/testpeer-src/client.go` | C | `client` mode contacts real endpoints; never used by tests. |
| `testing/testpeer/peer_test.go` | 2886 | `da53f50562c909af5d36319205346cf3f368ae6a88f5bfdfdf301564b521289a` | `test/fixtures/vpn/testpeer-src/peer_test.go` | C | |
| `testing/testpeer/go.mod` | 429 | `3d4fdf69bd4178f1c1ea8e794f65dac291c708834e638453303ba8ef6181857a` | `test/fixtures/vpn/testpeer-src/go.mod` | C | module `testpeer`; wireguard `v0.0.0-20261006164505-2631ce99a06f`, gvisor `v0.0.0-20250503011706-39ed1f5ac29c`. |
| `testing/testpeer/go.sum` | 1440 | `444c109ab9cd7b3144cb098ac0b60eaf91b19b087ed880353676aaddb72c74e0` | `test/fixtures/vpn/testpeer-src/go.sum` | C | |
| `testing/testpeer/README.md` | 825 | `0a09472aa2854cee7aa34dced3981b69479d6e6c6dd7e5a9bac8a9498758d92d` | `test/fixtures/vpn/testpeer-src/README.md` | C | |
| `bin/testpeer.exe` | 14280192 | `81827742c509d1543efafeb5236628a020ba115be78f86e2d11a1388b80bb1f8` | `test/fixtures/vpn/bin/testpeer.exe` | C | PE32+ x86-64 console binary. 14 MB: the orchestrator should add `test/fixtures/vpn/bin/` to `.gitignore` (nobody in this follow-up owns `.gitignore`); tests resolve the binary as in §10.4 and skip cleanly when absent. |

**Ported, not copied** (rewrite as ESM inside the owner's file; the originals are the reference implementation):

| Source | Bytes | SHA-256 | Becomes |
|---|---:|---|---|
| `service/tunnel-hub.js` | 10070 | `9a83d31138f034c77bf9367d167ac5444475f32f18a8f589c431140d3362a4c4` | the hub inside `server/vpn/wireguard.js` (Part A), with the changes in §7.6 |
| `protocol/frames.js` | 3743 | `341610c74315278adcd7b4b29e6f29fcabd86de265663b174df6fd1d6a9483ae` | `encodeFrame` / `createFrameDecoder` inside `server/vpn/wireguard.js` (Part A) |
| `testing/with-testpeer.cjs` | 3509 | `25a8f552effb12524983f4a6ffac788ec47ef6ba5a661fc4a5d7e6bf0e29d279` | `startTestPeer()` / `clientConf()` additions to `test/helpers.js` (Part C), see §10 |
| `wasm/loader.js` | 6094 | `e70c6fcfa599e84fcc10887cedee1f5ae50fcc2ae1c372beffe3a73f31e8088c` | the worker body of `server/vpn/wireguard.js` (Part A), see §5.4; it is the TV Worker script, the same loop ported to `worker_threads` |

**Do not copy:** `wasm/dist/tv/*` (Worker-environment glue, needs `XMLHttpRequest`/`importScripts`), `service/tunnel-agent.js`
(an `https.Agent` for the TV service's own fetches; Lumen's proxy terminates nothing, it pipes bytes), `service/tunnel-roots.pem`
(a CA bundle for Node 4; Edge has its own roots), `probe/**` (the Tizen socket-extension probe app, see §10.5), `third_party/lwip/src/**`
and `third_party/wireguard-lwip/src/**` C sources (2.3 MB; only needed for a rebuild), `tools/emcc-env.cjs`, `tools/patch-glue.cjs`,
`tools/node4.cjs`, `testing/fake-*.cjs`, `testing/socket-echo.c`, `core/bench.c`, `core/selftest.c`, `core/main.c`.

**`server/vpn/third_party/NOTICE.md`** (Part A writes it): provenance line per copied file — worktree path, commit `3be48659`,
SHA-256 from the table — the three licence names, the Samsung Emscripten SDK version (1.39.4.7 fastcomp) and the build flags below.

**Rebuild recipe (only if a C change is ever needed; not part of this follow-up):** in the worktree,
`node work/wg-tunnel/wasm/build.cjs --target node` compiles `third_party/lwip/src/core/*.c`, `…/core/ipv4/*.c`,
`third_party/wireguard-lwip/src/*.c`, `…/crypto/refc/*.c` and `core/*.c` with
`-Os -std=gnu99 -s WASM=1 -s ALLOW_MEMORY_GROWTH=1 -s TOTAL_MEMORY=67108864 -s ENVIRONMENT=node -s ENVIRONMENT_MAY_BE_TIZEN=1
-s MODULARIZE=1 -s EXPORT_NAME=createWgCore -s INVOKE_RUN=0 -s EXIT_RUNTIME=0 -s ERROR_ON_UNDEFINED_SYMBOLS=1`, exports from
`dist/node/wg-core-exports.json`, runtime methods from `runtime-exports.json`, then runs `tools/patch-glue.cjs` on the glue.
The SDK must be at `C:/Users/pranj/Documents/Codex/Tools/SamsungEmscripten/emscripten-release-bundle/emsdk` with `~/.emscripten` present.

---

## 3. What the glue needs from its host (`tizentvwasm`) and how the shim provides it

The glue compiles POSIX socket calls to `SOCKFS.webengine_sock_ops`, which call the Samsung TV extension namespace
`tizentvwasm`. Call shapes read from `wg-core.js` (the shim implements exactly these):

| C call in the core | Glue path | `tizentvwasm` call | Shim → I/O worker op |
|---|---|---|---|
| `socket(AF_INET, SOCK_DGRAM\|SOCK_NONBLOCK, 0)` (udp_transport.c) / `socket(AF_INET, SOCK_STREAM\|SOCK_NONBLOCK, 0)` (mux.c) | `___syscall102` call 1 → `SOCKFS.createSocket` | `SocketsManager.create('af_inet', 'sock_dgram' \| 'sock_stream', SockFlags.SOCK_NONBLOCK)` → fd | `create` → `dgram.createSocket('udp4')` lazily / a `net` socket record |
| `bind(fd, 0.0.0.0:0)` | call 2 → `sock_ops.bind` | `SocketsManager.bind(fd, NetAddress('af_inet', bytes[4], port))` | `bind` → `udp.bind(0, '0.0.0.0')` |
| `connect(fd, 127.0.0.1:muxPort)` (non-blocking) | call 3 → `sock_ops.connect` | `SocketsManager.connect(fd, NetAddress)`; throws → `getErrorCode(fd)` → `EINPROGRESS` | `connect` → `net.connect`, replies `-EINPROGRESS` |
| `getsockopt(SOL_SOCKET, SO_ERROR)` after `POLLOUT` | call 15 → `sock_ops.getsockopt` (option table maps `SO_ERROR` = 4 → name `so_error`) | `SocketsManager.getSockOpt(fd, 'sol_socket', 'so_error')` | `getsockopt` → pending connect error or 0 |
| `sendto(fd, buf, len, 0, peer)` | call 11 → `sock_ops.sendto` | `SocketsManager.sendTo(fd, new Uint8Array(copy), msgFlags, NetAddress)` → n | `send` → `udp.send(payload, port, ip)` |
| `send(fd, buf, len, 0)` (mux) | musl implements `send` as `sendto(…, NULL, 0)` → call 11 → `sock_ops.sendto` with `dest = 0` (there is no case 9/10 in this glue) | `SocketsManager.send(fd, new Uint8Array(copy), msgFlags)` → n or throws `EAGAIN` when > 4 MiB queued | `send` → `tcp.write` |
| `recvfrom(fd, buf, cap, 0, &from)` | call 12 → `sock_ops.recvfrom` | `SocketsManager.recvFrom(fd, Uint8Array, msgFlags)` → `{ bytesRead, peerAddress }`; copy back into the heap | `recv` with `from: true` → one queued datagram |
| `recv(fd, buf, cap, 0)` (mux) | musl `recv` = `recvfrom(…, NULL, NULL)` → call 12 → `sock_ops.recvfrom` with `addrPtr = 0` | `SocketsManager.recv(fd, Uint8Array, msgFlags)` → n, 0 at EOF, throws `EAGAIN` | `recv` → bytes from the TCP receive queue |
| `poll(fds, n, timeout_ms)` | `___syscall168` → `stream_ops.poll` per fd, **timeout 0** each, loops until something is ready or the C timeout elapses | `SocketsManager.poll([PollFd(fd, POLLIN\|POLLRDNORM\|POLLPRI\|POLLOUT\|POLLWRNORM)], 0)` and reads `PollFd.revents` | `poll` → readiness from the socket records |
| `close(fd)` | WASI `_fd_close` → `FS.close(stream)` → `SOCKFS.stream_ops.close` → `sock_ops.close` (no `___syscall6` in this glue) | `SocketsManager.close(fd)` | `close` → `udp.close()` / `tcp.destroy()` |
| `gethostbyname(endpointHost)` (udp_transport.c, endpoint only) | `_gethostbyname` → `__gethostbyname` | `new HostResolverSync().getHostByName(name)` → `{ name, getAddrList() }` or `null` with `.errorno` | `resolve` → `dns.lookup(name, { all: true, family: 4 })` **on the PC's resolver** (correct: the endpoint must be reached outside the tunnel) |
| errors | every failing call throws; glue calls `SocketsManager.getErrorCode(fd)` and maps `tizentvwasm.ErrorCodes.*` to musl errno (`EAGAIN`→6, `EINPROGRESS`→26, `ECONNREFUSED`→14, `ECONNRESET`→15, `EINVAL`→28, …) | `ErrorCodes` object (Linux-style numbering, host-independent) | each op replies `-errno` |

Also referenced by the glue and provided by the shim: `NetAddress(family, bytes, port)`, `InetAddress`, `PollFd(fd, events)` with
`.revents`, `PollFlags`, `MsgFlags`, `SockFlags`, `SockOptTimeVal`, `IpMreq`, `IpMreqSource`, `Ipv6Mreq`, `Ipv`, `HostResolverSync`,
`SocketsManager.{listen, accept4, getSockName, getPeerName, setSockOpt, shutdown, select, sendMsg, recvMsg}` (present; `listen/accept`
are never exercised by the core).

How the shim works (keep as is): `installTizenSocketsShim(globalThis)` defines `globalThis.tizentvwasm`. The first socket call
creates a `Bridge`: `new Worker(<io-worker>)`, a `SharedArrayBuffer` of 128 Int32 control words and one of 4 MiB for payloads.
Each call copies the payload into the shared buffer, `postMessage`s `{ op, fd, … }`, then spins `Atomics.wait(control, 0, 0, 1000)`
until the worker sets `control[0]=1` (`control[1]` = rc or `-errno`, `control[2]` = payload length, `control[3..62]` = aux ints:
port, 4 address bytes, `revents` per fd). The worker owns the `dgram`/`net` sockets and its own event loop keeps running while
the caller is blocked. `shutdownShim()` terminates the I/O worker. The I/O worker's TCP write high-water mark is 4 MiB; UDP
receive datagrams queue unbounded in JS (`s.rx`). `poll` with `timeout > 0` arms a timer in the worker; the glue only ever passes 0,
and the C `wg_poll(timeout_ms)` loop in `___syscall168` re-polls until the C timeout — this is why `wg_poll(20)` costs up to 20 ms
of wall time per call and dozens of shim round-trips.

Host bindings: the glue's `createWasm()` first looks for `tizentvwasm.SocketsHostBindings.*` (19 imports) and, with the patched
line `component = (self.__wgHostBindings === true) ? self : {}`, never finds them unless `self.__wgHostBindings` is set. **Never set
it** in Lumen; `USE_HOST_BINDINGS` then becomes `false` and the JS `SocketsManager` path (the shim) is used.

Possible future change (NOT verified, not required): the I/O worker could skip real TCP for the mux link and hand frames to the
main thread over a MessagePort. Measured today, the loopback TCP hop is not the bottleneck worth chasing first (§14).

---

## 4. Instantiating the wasm in Node 22 (ESM) — exact recipe

Verified today from an `.mjs` file inside the Lumen repo, loading the `.cjs` copies (§15 run A):

```js
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);

globalThis.self = globalThis;                        // Samsung's fork references the worker global `self` on the node target too
const shim = require('./third_party/cinehd/tizentvwasm-shim.cjs');
shim.installTizenSocketsShim(globalThis);            // must precede createWgCore(): the glue reads `tizentvwasm` at instantiation
const createWgCore = require('./third_party/wg-core/wg-core.cjs');   // MODULARIZE factory; CJS export `module.exports = createWgCore`

const Module = await new Promise((resolve, reject) => {
  const m = {
    wasmBinary: fs.readFileSync(new URL('./third_party/wg-core/wg-core.wasm', import.meta.url)),   // see note 1
    print: (line) => …,          // lwIP/wireguard-lwip diagnostics ("Device init took 2ms", "Adding peer took 2ms", lwIP asserts)
    printErr: (line) => …,
    onRuntimeInitialized() { delete m.then; resolve(m); },   // see note 2
    onAbort: (reason) => reject(new Error(`wasm abort: ${reason}`)),
  };
  createWgCore(m);
});
```

Notes:
1. Pass `wasmBinary`. Node 22 has a global `fetch`; the 2019 glue's `instantiateAsync` would otherwise try `fetch("<dir>/wg-core.wasm")`
   with a filesystem path, log an error and only then fall back to `readBinary`.
2. With `MODULARIZE=1` the module object is a thenable; resolving a Promise with it recurses, hence `delete m.then` (same as CineHD's
   `load-core.cjs`).
3. `INVOKE_RUN=0`: `main()` never runs. Exports present (**observed**): `_wg_selftest, _wg_bench_aead, _wg_config_parse, _wg_start,
   _wg_poll, _wg_stop, _wg_status, _wg_mux_connect, _wg_mux_close, _malloc, _free`; runtime methods `ccall, cwrap, UTF8ToString,
   stringToUTF8, lengthBytesUTF8`; `Module.HEAP8/HEAPU8/HEAP32`. Initial heap 67,108,864 bytes (`TOTAL_MEMORY`), growth allowed.
4. The node-target glue registers `process.on('uncaughtException', rethrow-unless-ExitStatus)` and
   `process.on('unhandledRejection', abort)` and sets `quit_ = process.exit`. Inside a `worker_threads` Worker these affect only
   that thread — another reason the core must live in a Worker and never on Lumen's main thread.
5. `_emscripten_get_now` uses `process.hrtime()` on the node target; `wireguard_sys_now`/lwIP `sys_now` derive from it;
   `tai64n` uses `Date.now()`; randomness uses `require('crypto').randomBytes` (the `wg_platform.c` EM_JS falls through to it
   because `crypto.getRandomValues` exists in Node 22 too — either source is a CSPRNG).
6. Calling convention: `Module.ccall('wg_start', 'number', ['string'], [confText])` (the glue copies the string into the heap);
   buffers for `wg_status`/`wg_config_parse`: `const p = Module._malloc(2048); Module.ccall('wg_status', 'number', ['number','number'], [p, 2048]); Module.UTF8ToString(p); Module._free(p)`.
   `wg_status` needs ≤ 2048 bytes (returns −1 if `cap` is too small); `wg_config_parse` ≤ 1024.

**C exports and return codes** (from `core/tunnel.c`, `core/mux.c`, `core/config.c`):

| Export | Signature | Returns |
|---|---|---|
| `wg_selftest()` | `int wg_selftest(void)` | 0 when the RFC 7748 / 8439 / 7693 vectors pass (**observed** 0). Run it once at worker start. |
| `wg_config_parse(text, out, cap)` | `int (const char*, char*, int)` | 0 and key-free JSON `{"address","dns","endpointHost","endpointPort","peerPublicKeyPrefix"(8 chars),"keepalive","hasPresharedKey","allowsDefaultRoute"}`; or a `WG_CONFIG_*` code (§9). Lumen's `conf.js` replaces this; optional cross-check only. |
| `wg_start(confText)` | `int (const char*)` | 0; config codes −1…−7; −100 endpoint resolution failed; −101 UDP socket failed; −102 underlay netif failed; −103 bad tunnel address; −104 wireguard netif failed (bad private key, **or a second start in the same instance**, see §12.1); −105 add peer failed (bad public key); −106 connect failed. On failure `wg_status().lastError` has the text. |
| `wg_mux_connect(ip, port)` | `int (const char*, uint16_t)` | 0 (connecting or connected); negative errno/−EINVAL on immediate failure. Re-callable; closes a previous link first. |
| `wg_poll(timeoutMs)` | `int (int)` | −1 when stopped, else 0. Waits up to `timeoutMs` on the UDP fd and the mux fd, feeds datagrams to WireGuard, runs lwIP timers, services the mux (frames in/out, STATUS every 1000 ms while linked). |
| `wg_stop()` | `void (void)` | Closes the mux link (all streams freed, no RST frames sent — the hub sees the TCP close), removes the netifs, closes the UDP socket. |
| `wg_status(out, cap)` | `int (char*, int)` | 0 and JSON: `{"state":"stopped\|starting\|handshaking\|up","handshake":"pending\|ok","handshakeAgeMs":n,"retries":n,"rx":n,"tx":n,"endpoint":"host:port","uptimeMs":n,"mux":{"linked":bool,"streams":n,"framesIn":n,"framesOut":n},"lastError":"…"}`. Never contains keys (**observed**). |
| `wg_mux_close()` | `void (void)` | Drops the link only. |

Field semantics (important for `vpn.*`): `rx`/`tx` count **UDP payload bytes** on the wire (encrypted transport messages,
handshakes, keepalives), not plaintext — a 20,971,520-byte download showed `rx` ≈ 31.7–34.0 MB (§14.2). `handshakeAgeMs` is the
time since the tunnel **first** came up in this instance (`now − up_since`), not the time since the latest rekey (wireguard-lwip
rekeys transparently every `REKEY_AFTER_TIME` = 120 s and `wireguardif_peer_is_up` stays true while either keypair is valid).
`retries` = handshake initiations sent − 1. `state` returns from `up` to `handshaking` when no keypair is valid any more
(`REJECT_AFTER_TIME` = 180 s after the last successful handshake with no rekey). `endpoint` is the conf text `host:port`
(hostnames unresolved).

---

## 5. The tunnel worker (Part A, inside `server/vpn/wireguard.js`)

Single-file pattern so Part A stays inside its ownership: `wireguard.js` imports `{ Worker, isMainThread, parentPort, workerData }`
from `node:worker_threads`; when `!isMainThread` it runs the worker body and nothing else; the main-thread half spawns
`new Worker(new URL(import.meta.url), { workerData })`.

### 5.1 workerData (never logged)
`{ confText, muxPort, openTimeoutMs? }` — `confText` is the canonical wg-quick text from `serializeWireGuardConf` (§9.3). It crosses
thread memory only; it must never reach `log`, `store`, messages back to main, or error texts.

### 5.2 Messages worker → main
| `t` | When | Payload |
|---|---|---|
| `ready` | glue instantiated, `wg_selftest()` run | `{ selftest }` (non-zero → main treats as `error` code `selftest-failed`) |
| `started` | `wg_start` returned 0 and `wg_mux_connect` returned 0 | `{}` |
| `error` | any failure | `{ code, message, rc? }` codes: `load-failed`, `selftest-failed`, `start-failed` (with `rc` and `lastError`), `mux-connect-failed`, `poll-failed`, `wasm-abort` |
| `status` | every 1000 ms **and** immediately when `state`, `handshake` or `mux.linked` changed since the last post | `{ status: <wg_status JSON>, heap: Module.HEAP8.length }` |
| `log` | glue `print`/`printErr` | `{ line }` → `log.debug` |
| `stopped` | after `wg_stop()` | `{}` |

### 5.3 Messages main → worker
`{ cmd: 'stop' }` → `wg_stop()`, `shutdownShim()`, post `stopped`, `process.exit(0)` (ends the worker thread only).
`{ cmd: 'status' }` → one `status` post now. Main also hard-terminates (`worker.terminate()`) if `stopped` has not arrived within 1000 ms.

### 5.4 Loop (port of `wasm/loader.js` + `testing/pc-worker-demo.cjs`)
```
wg_start(confText) → wg_mux_connect('127.0.0.1', muxPort) →
loop: wg_poll(20); maybe post status; if (!status.mux.linked && now - lastDial > 500) wg_mux_connect(...); setImmediate(loop)
```
`setImmediate` (not a tight `while`) so `parentPort` messages are processed between slices (**observed** responsive with 20 ms slices).
The re-dial mirrors loader.js (500 ms); in Lumen the hub listens before the worker starts, so the first dial normally succeeds
(**observed**: `mux rc 0`, hub `linked` before the handshake completed).

### 5.5 Lifecycle rule: one worker per `start()`
`wg_stop()` followed by `wg_start()` in the same wasm instance fails with −104 (wireguard-lwip has no shutdown; CineHD acceptance
2026-10-19, fixed there by discarding the worker). Therefore `tunnel.stop()` always ends the worker and `tunnel.start()` always
creates a new one. Cost: wasm load + selftest + handshake, **observed** ≈ 0.5 s end to end on this PC.

---

## 6. DNS inside the tunnel

- `wg_start` calls `dns_setserver(0, <DNS from the conf>)`; lwIP's DNS client sends UDP/53 queries through `wg0` (the default
  netif), i.e. **inside the tunnel**. Only `DNS_MAX_SERVERS` slot 0 is set; only the first IPv4 `DNS=` entry is used.
- Two ways names get resolved, both in C (`core/mux.c`):
  1. `OPEN` with a hostname payload (`"443:example.com"`): `dns_gethostbyname` → `start_connect` on the answer; `RST dns-failed` on failure.
     This is what the proxy uses for CONNECT/absolute-URI requests — the hostname is passed straight through, so **neither Edge nor
     Lumen resolves it locally**.
  2. `DNS` frame (stream 0, ASCII name) → `DNSANSWER` frame `"name=ip"` or `"name="` on failure. This backs `tunnel.resolve(host)`.
  Dotted IPv4 payloads skip DNS (`ipaddr_aton`).
- lwIP DNS timing: `DNS_TMR_INTERVAL` 1000 ms, `DNS_MAX_RETRIES` 4 (so a dead resolver fails in ~4–8 s), `DNS_TABLE_SIZE` 8 cached
  entries honouring TTL, `DNS_MAX_NAME_LENGTH` 256. A-records only (no AAAA, no CNAME chasing beyond what the server returns in the
  answer section). **Observed:** `resolve('anything.test')` → `10.66.0.1` in 7 ms with the Go peer's responder; CineHD measured a
  first resolve of 4.7 s through Proton's 10.2.0.1.
- Hub side: `resolve()` dedupes concurrent lookups of the same name; `dnsTimeoutMs` 10,000 → error code `vpn-dns-timeout`;
  non-IPv4 answer → `vpn-dns-failed`; tunnel not up → `vpn-tunnel-down`.
- Only the **endpoint host** is resolved outside the tunnel (glue `gethostbyname` → shim → `dns.lookup` on the PC). Proton confs
  use IP literals; the resolution path is still exercised for hostnames.

---

## 7. The mux protocol (JS hub ↔ wasm) — binding facts

### 7.1 Frame
`u8 type | u32be stream | u32be len | payload`, header 9 bytes. Types: `1 OPEN`, `2 OPENED`, `3 DATA`, `4 EOF`, `5 RST`, `6 CREDIT`,
`7 DNS`, `8 DNSANSWER`, `9 STATUS`, `10 HELLO`. Unknown type or `len > 1 MiB` on the JS side → protocol error, drop the link.

### 7.2 Handshake and status
Both sides send `HELLO` (stream 0, `{"muxVersion":1}`) as their first frame; the wasm answers the hub's HELLO with its own, and
clears `lastError`. `STATUS` (stream 0, the `wg_status` JSON) arrives every 1000 ms while linked. The hub treats the link as usable
only while the latest STATUS says `handshake:"ok"` (`state 'up'`); before that it is `'linked'`.

### 7.3 Streams (the hub is the only opener)
`OPEN(id, "port:host")` → `OPENED(id)` once the lwIP TCP connection is established (or `RST(id, code)`); then `DATA` both ways;
`EOF` = half-close (the C side calls `tcp_shutdown(tx)`), `RST` = abort. A stream is gone when both sides sent `EOF`, or on any RST.
Ids are u32, never reused while open (hub counter wraps at 4,294,967,000). `MUX_MAX_STREAMS` = **32** concurrently open streams;
the 33rd OPEN gets `RST too-many-streams`. Each stream is one lwIP `tcp_pcb` (`MEMP_NUM_TCP_PCB` 32), Nagle disabled.

RST codes from the wasm: `too-many-streams`, `bad-open`, `vpn-tunnel-down` (OPEN while not up), `dns-failed`, `connect-failed`,
`connection-reset`, `connection-aborted`, `connection-failed`, `no-pcb`, `not-open` (DATA before OPENED), `credit-exceeded`,
`write-failed` (lwIP `tcp_write` ERR_MEM, see 7.5). Codes the hub generates: `vpn-tunnel-down`, `vpn-open-timeout` (15 s),
`vpn-dns-timeout`, `vpn-dns-failed`, `vpn-link-lost`, `vpn-stream-closed`; it sends `RST unknown-stream` for frames on unknown ids and
`RST closed` (or the error code) when a Duplex is destroyed.

### 7.4 Flow control (credit)
Per stream, per direction. Wasm → hub: the wasm starts with `MUX_INITIAL_CREDIT` = 1,048,576 bytes of credit; it sends DATA frames of
at most 65,536 bytes while credit remains and `tcp_recved`s lwIP only for bytes it actually forwarded (so lwIP's 706 KB receive
window — `TCP_WND` = 512 × 1380, `TCP_RCV_SCALE` 4 — closes when the hub stops granting). The hub grants `CREDIT n` once it has
pushed ≥ 32,768 unacknowledged bytes to its consumer (`CREDIT_GRANT`); credit is granted from `Duplex._read()`, so a paused consumer
stops the flow. **Observed:** with no grants the wasm delivered exactly 1,048,576 bytes and stopped (the worktree test still asserts
the old 64 KiB window and fails for that reason only, §15).
Hub → wasm: the wasm advertises 1 MiB too and grants back after lwIP acks (`on_sent`, ≥ 32 KiB). **The hub must not use that
window** — see 7.5.

### 7.5 Three limits in the C side the hub MUST respect (all **observed** today)
1. **DATA frames toward the wasm must be ≤ 65,535 bytes.** `mux.c` calls `tcp_write(pcb, payload, (u16_t)len, …)`: a 204,800-byte
   frame was silently truncated to 8,192 bytes (`tx` grew by 8,832 bytes, no error, stream left "healthy").
2. **Any frame ≥ 262,145 bytes (`MUX_MAX_FRAME` = 256 KiB) kills the link.** A 307,200-byte DATA frame → wasm `lastError
   "mux frame too large"`, `mux.linked false`, hub state `down`, every open stream `vpn-link-lost`.
3. **Outstanding unacked bytes toward one stream must stay under `TCP_SND_BUF` = 88,320.** Two back-to-back 61,440-byte frames →
   the second `tcp_write` returned ERR_MEM → `RST write-failed`. The 1 MiB credit the wasm advertises is not backed by lwIP's send
   buffer (`TCP_SND_BUF` 64 × 1380; `TCP_SND_QUEUELEN` 256).
   Rule: hub-side initial transmit window **65,536 bytes per stream**, replenished only by CREDIT frames (which the wasm sends after
   lwIP acks, in ≥ 32 KiB steps), and DATA chunks of **≤ 32,768 bytes**. Worst case outstanding ≈ 64 KiB + 32 KiB grant < 88,320.

### 7.6 Changes when porting `service/tunnel-hub.js` into `wireguard.js` (everything else: keep)
1. ESM; `class TunnelStream extends Duplex` with `allowHalfOpen: true`.
2. `TX_INITIAL_CREDIT = 65536` (was `frames.INITIAL_CREDIT` 1 MiB) and `MAX_DATA_FRAME = 32768` (was `MAX_PAYLOAD` 1 MiB) in `_flushWrites`.
3. Emit `'connect'` on the Duplex when `OPENED` arrives (in addition to the open callback), so `http.request({ createConnection })`
   and the proxy's CONNECT handler have a socket-like signal. Add no-op `setTimeout`, `setNoDelay`, `setKeepAlive`, `ref`, `unref`.
   (**Observed:** `http.request` over the unmodified `TunnelStream` already works on Node 22; the no-ops are for robustness.)
4. Listener: `net.createServer` on `127.0.0.1`, port 0, read the port from `server.address()`. Accept only `remoteAddress` `127.0.0.1`
   / `::ffff:127.0.0.1`; while a link is active, **destroy** further connections (CineHD replaced the link; in Lumen a second dial while
   linked can only be another local process). Require the first frame to be `HELLO` within 2 s, else destroy.
5. Cap concurrent streams at 30 (`vpn-too-many-streams` error from `connect()`), leaving headroom under the C limit of 32.
6. `connect(host, port)` returns the Duplex; when the tunnel is not `up` it returns a Duplex that emits `error` `{ code: 'vpn-tunnel-down' }`
   on the next tick (never a direct socket, never `null`).
7. Keep: decoder with the 1 MiB cap, `openTimeoutMs` 15,000 (make it an option for tests), `dnsTimeoutMs` 10,000, link loss →
   every stream fails with `vpn-link-lost`, `EOF` half-close handling, `_read`-driven CREDIT grants, STATUS → state transitions.

---

## 8. Status, keepalive, timers, MTU

| Item | Value / behaviour | Source |
|---|---|---|
| MTU inside the tunnel | 1420 (`WIREGUARDIF_MTU`); TCP MSS 1380 (`lwipopts.h`) | wireguardif.h, lwipopts.h |
| Keepalive | `PersistentKeepalive = n` → `peer.keep_alive = n` seconds; 0/absent → none. Lumen's serializer defaults to **25** (§9.3). Each keepalive is a 32-byte UDP payload. | tunnel.c, config.c |
| Handshake retry | initiation re-sent every `REKEY_TIMEOUT` = 5 s while pending; `retries` counts them (**observed** `retries ≥ 1` after 7 s with a wrong peer key in the worktree suite) | wireguard.h |
| Rekey | `REKEY_AFTER_TIME` 120 s (transparent; `state` stays `up`); keys rejected after `REJECT_AFTER_TIME` 180 s → `state` back to `handshaking` until a new handshake succeeds; `KEEPALIVE_TIMEOUT` 10 s | wireguard.h |
| Dead peer detection | none beyond the above: after the peer disappears the status stays `up` for up to 180 s; new OPENs then time out (`vpn-open-timeout` after 15 s; lwIP SYN retries `TCP_SYNMAXRTX` 6) | tcp_priv.h, hub |
| Handshake time | **observed** 486–529 ms from `wg_start` to `handshake:"ok"` (5 runs, loopback peer); the hub sees `up` ≤ 1 s later (STATUS cadence) | §15 |
| Throughput | **observed** 28.6–37.4 Mbit/s for 20 MB, 30.7 Mbit/s for 50 MB (worktree suite), all on this PC via loopback peer; CineHD measured 46–57 Mbit/s PC→Proton with the same core and 31.7 Mbit/s in this test | §15, acceptance doc |
| Memory | wasm heap 64 MiB initial + growth; shim 4 MiB shared buffer; `PBUF_POOL_SIZE` 2048 × 1536 B; `MEM_SIZE` 4 MiB (lwIP heap) | lwipopts.h, build flags |

---

## 9. The `.conf`: fields the core uses and the rules `conf.js` must mirror (Part A)

### 9.1 What `core/config.c` reads (everything else is ignored: `MTU`, `Table`, `ListenPort`, `FwMark`, `PostUp`…)
| Key | Rule in C | Lumen `conf.js` |
|---|---|---|
| `PrivateKey` | required; exactly 44 chars of standard base64 decoding to 32 bytes (`WG_CONFIG_NO_PRIVATE_KEY` −2 / `WG_CONFIG_BAD_KEY` −3) | `privateKey` (string); error text never includes the value |
| `Address` | required; first IPv4 of a comma list, mask dropped, IPv6 skipped (`WG_CONFIG_NO_ADDRESS` −6) | `address: string[]` (all entries as written); require ≥ 1 IPv4 |
| `DNS` | optional in C; first IPv4 of the list | `dns: string[]`; **Lumen requires ≥ 1 IPv4** (hostnames are resolved only inside the tunnel) |
| `PublicKey` | required; same key rule (`WG_CONFIG_NO_PUBLIC_KEY` −5) | `peer.publicKey` |
| `PresharedKey` | optional; same key rule | `peer.presharedKey?` |
| `AllowedIPs` | only the presence of `0.0.0.0/0` is noted (lwIP routes everything via wg0 regardless) | `peer.allowedIPs: string[]` |
| `Endpoint` | required; split at the **last** `:`; host chars `[A-Za-z0-9.-]` only (no `[` → IPv6 literals rejected); port 1–65535 (`WG_CONFIG_BAD_ENDPOINT` −4) | `peer.endpoint: 'host:port'` |
| `PersistentKeepalive` | integer 1–65535 else 0 | `peer.keepalive?: number` |
| whole file | ≤ 16,384 bytes (`WG_CONFIG_TOO_LONG` −7); any line ≤ 599 bytes; `#` starts a comment anywhere on a line (`Endpoint = 1.2.3.4:51820  # x` is fine); CRLF accepted; section headers skipped and **not tracked** (keys are global) | mirror the limits; treat a second `[Peer]` as an error ('one peer only') |

### 9.2 `parseWireGuardConf(text)` → `{ privateKey, address: [], dns: [], peer: { publicKey, presharedKey?, endpoint, allowedIPs: [], keepalive? } }`
Throws `LumenError('INVALID', message)`; messages: `PrivateKey is missing`, `PrivateKey is not a 32-byte base64 key`,
`PublicKey is missing`, `PublicKey is not a 32-byte base64 key`, `PresharedKey is not a 32-byte base64 key`, `Address needs an IPv4
entry`, `DNS needs an IPv4 server (names are resolved inside the tunnel)`, `Endpoint needs host:port`, `Endpoint host may only
contain letters, digits, dots and dashes`, `config is larger than 16 KB`, `line N is longer than 599 bytes`. Never echo a value in a
message. Base64 check: `Buffer.from(v, 'base64').length === 32 && v.length === 44 && /^[A-Za-z0-9+/]{43}=$/.test(v)`.

### 9.3 `serializeWireGuardConf(conf, { keepalive = 25 } = {})` → canonical LF text for `wg_start`
```
[Interface]
PrivateKey = <conf.privateKey>
Address = <first IPv4 in conf.address>/32
DNS = <first IPv4 in conf.dns>
[Peer]
PublicKey = <conf.peer.publicKey>
PresharedKey = <conf.peer.presharedKey>          (only when present)
AllowedIPs = 0.0.0.0/0
Endpoint = <conf.peer.endpoint>
PersistentKeepalive = <conf.peer.keepalive ?? keepalive>
```
Why serialize instead of passing the user's text: the keepalive default (a PC behind NAT needs it), no comments/device names
reach the wasm, and `conf.js` is the single validator. **Observed:** the C parser accepts this shape (`wg_config_parse` rc 0 on a
CRLF/commented/IPv6-bearing synthetic conf).

### 9.4 `summarizeWireGuardConf(conf)` → `{ endpoint, address, dns, keepalive, publicKeyPrefix }` (8-char prefix) — the only conf-derived object
that may be logged or stored.

---

## 10. The Go test peer (`bin/testpeer.exe`) and how it is driven (Part C)

### 10.1 Correction to the brief
`probe/probe-peer.cjs` does **not** drive `testpeer.exe`. It is the PC side of the Tizen *socket-extension probe app*: a UDP echo
(default 51820), a TCP echo (51821) and an HTTP `POST /report` sink (51822) that stores the TV probe's JSON under `probe/reports/`.
Nothing in Lumen needs it. The driver of the WireGuard peer is **`testing/with-testpeer.cjs`**, ported into `test/helpers.js`.

### 10.2 Binary facts (**observed**)
`testpeer.exe` 14,280,192 bytes, SHA-256 `81827742c509d1543efafeb5236628a020ba115be78f86e2d11a1388b80bb1f8`, PE32+ x86-64 console,
built from `testing/testpeer` (`golang.zx2c4.com/wireguard` netstack, pure userspace: no driver, no admin). No args → usage on stderr,
exit 2.

### 10.3 CLI
- `testpeer.exe genkey` → stdout `private=<44-char base64> public=<44-char base64>` (fresh X25519 pair, clamped). Call twice per
  test: once for the peer, once for the client. Throwaway; never write them to disk or logs.
- `testpeer.exe serve -listen 127.0.0.1:0 -private <peerPriv> -peer <clientPub> -ip 10.66.0.1 -client 10.66.0.2`
  - stdout line 1: `listening on udp :<PORT>, http 10.66.0.1:80, dns 10.66.0.1:53` → parse `/listening on udp :(\d+)/`.
  - later: `handshake ok` once `last_handshake_time_sec` becomes non-zero (polled every 100 ms via UAPI).
  - `wg error: …` lines on device errors.
  - Serves **inside the tunnel**: `GET http://10.66.0.1/hello` → `hello from wg peer\n`; `GET http://10.66.0.1/blob?bytes=N` →
    N bytes of `0x5a` (`Content-Length` set; N ≤ 1 GiB else 400); UDP DNS on `10.66.0.1:53` answering every `A` question with
    `10.66.0.1` (other qtypes: empty answer). Connections to any other port inside the tunnel are refused by the netstack
    (**observed** in the worktree suite: `RST connection-reset|failed`).
  - Only one client peer, `allowed_ip = <client>/32`; the client must use `Address = 10.66.0.2/32`.
  - Stop with `child.kill()`; the process exits on SIGINT/termination.
- **Never** pass `-exit` (forwards tunnel traffic to the real internet and uses `1.1.1.1:53`) and never use `client` mode (dials a
  real endpoint from a real conf). Both violate the rules of this follow-up.
- Private keys are passed on the command line (visible to local process listing). Acceptable for throwaway keys only.

### 10.4 Locating the binary (skip cleanly when absent)
Order: `process.env.LUMEN_TESTPEER` → `test/fixtures/vpn/bin/testpeer.exe` → the worktree path
`C:/Users/pranj/Documents/Codex/2026-09-16/how-x20/.worktrees/proton-wg-tunnel/work/wg-tunnel/bin/testpeer.exe` → `describe(name, { skip: 'testpeer.exe not found' })`.
Rebuild (if ever needed): `go build -o <dest>/testpeer.exe .` inside `test/fixtures/vpn/testpeer-src` (Go 1.25.5 is installed;
first build fetches modules from the internet, so it is not something tests do).

### 10.5 Client conf for tests (`clientConf` helper; keys from `genkey`)
```
[Interface]
PrivateKey = <clientPriv>
Address = 10.66.0.2/32
DNS = 10.66.0.1

[Peer]
PublicKey = <peerPub>
AllowedIPs = 0.0.0.0/0
Endpoint = 127.0.0.1:<PORT>
PersistentKeepalive = 25
```
`wrongPeerConf` = the same with a third `genkey` public key → handshake stays `pending`, `retries ≥ 1` after ~7 s.

---

## 11. Minimal API (binding for Parts A, B, C)

### 11.1 `server/vpn/conf.js` (Part A)
`parseWireGuardConf(text)`, `serializeWireGuardConf(conf, { keepalive = 25 } = {})`, `summarizeWireGuardConf(conf)` — §9.

### 11.2 `server/vpn/wireguard.js` (Part A)
```js
createTunnel({ conf, log, openTimeoutMs = 15000, dnsTimeoutMs = 10000 }) → tunnel   // conf = parseWireGuardConf() result
tunnel.start()            → Promise<void>   resolves when the worker reported `started` and the hub link is `linked`
                                            (typically < 300 ms); rejects Error{code} on load/start failure. Idempotent while running.
tunnel.stop()             → Promise<void>   ends the worker (and its I/O worker), closes the listener, fails open streams with
                                            'vpn-tunnel-down'. Idempotent. After it, status().state === 'stopped'.
tunnel.connect(host, port) → Duplex         events: 'connect' (OPENED), 'error' (err.code: see §7.3), 'close'. Writes before
                                            'connect' are buffered. Not up → Duplex that errors 'vpn-tunnel-down' next tick.
                                            > 30 open streams → errors 'vpn-too-many-streams'.
tunnel.resolve(host)      → Promise<string> dotted IPv4 (an IPv4 literal resolves to itself without a frame); rejects Error{code}
                                            'vpn-dns-failed' | 'vpn-dns-timeout' | 'vpn-tunnel-down'.
tunnel.status()           → { state, handshake, handshakeAgeMs, retries, rx, tx, endpoint, uptimeMs, linked, streams, lastError }
                              state: 'stopped' | 'starting' | 'handshaking' | 'up' | 'down' | 'error'
                              ('down' = was up in this worker and the core now reports handshaking or the link is lost;
                               'error' = worker/start failure; the other names are the core's)
tunnel.on('status', fn)   EventEmitter: 'status' (every status post, ≤ ~1 Hz + transitions), 'up', 'down', 'error', 'exit'.
tunnel.port               the hub's loopback port (tests only).
```
Keys never appear in `status()`, events, errors or logs. Log tag `log.child('vpn')`; lifecycle at `info`, per-stream at `debug`.

### 11.3 `server/vpn/proxy.js` (Part B)
```js
createVpnProxy({ tunnel, log, maxStreams = 30, queueMs = 10000 }) → { start() → Promise<{ port }>, stop() → Promise<void>, port }
```
- `http.createServer()` on `127.0.0.1:0`. `port` is set after `start()`.
- `'connect'` (CONNECT `host:port`): validate authority (no `[`, port 1–65535) else 400; `tunnel.status().state !== 'up'` → 502;
  `const up = tunnel.connect(host, port)`; on `'connect'` write `HTTP/1.1 200 Connection Established\r\n\r\n`, forward `head`,
  `socket.pipe(up).pipe(socket)`, `socket.setNoDelay(true)`; on `'error'` before 200 → `HTTP/1.1 502 Bad Gateway` with a one-line
  text body `vpn: <code>`; after 200 → destroy both. Close one side when the other ends.
- `'request'` (absolute-URI): `req.url` must parse as `http://host[:port]/…` (relative paths and `https://` → 400). Forward with
  `http.request({ createConnection: () => tunnel.connect(host, port), host, port, method, path, headers, setHost: false })`,
  strip hop-by-hop headers (`proxy-connection`, `connection`, `keep-alive`, `proxy-authorization`, `te`, `trailer`, `upgrade`),
  pipe body both ways, copy status + headers; upstream error → 502 if headers not yet sent, else destroy.
- Concurrency: track open streams; above `maxStreams` queue new CONNECT/requests up to `queueMs`, then 502 (`vpn: busy`).
- **Fail closed:** `proxy.js` imports neither `node:net` nor `node:dns`; the only outbound primitive is `tunnel.connect`. Requests to
  loopback/LAN addresses go into the tunnel too (and die there) — Edge bypasses the proxy for loopback by default, which is the
  desired behaviour for Lumen's own UI.
- Log at `debug`: method/host:port/outcome; at `info`: start/stop with port; never log URLs at `info`.

### 11.4 `server/features/vpn.js` (Part B)
```js
createVpn(ctx) → { start, stop, setDemand, enable(), disable(), proxyUrl(), status(), reload() }
```
- Files: `path.join(config.dataDir, 'vpn', 'wg.conf')` read with `fs` (text; `data.readJson` is JSON-only); `data/vpn/state.json`
  `{ enabled: boolean }` via `data.readJson('vpn/state.json', { enabled: false })` / `data.writeJson` (sub-paths are allowed by
  `createDataStore`). Missing/invalid conf → `vpn.state 'unconfigured'`, `vpn.error` = the parse message, never a throw out of `start()`.
- `enable()`: persist `enabled: true`; `tunnel = createTunnel({ conf, log }); await tunnel.start(); proxy = createVpnProxy({ tunnel, log });
  const { port } = await proxy.start();` publish keys; return `{ value: status() }`. If the conf is invalid → `LumenError('INVALID', msg)`
  and `enabled` stays false.
- `disable()`: persist `enabled: false`; `await proxy.stop(); await tunnel.stop();` state `'off'`, `proxyPort null`.
- `reload()`: re-read + re-parse; when disabled only refresh `unconfigured`/`off` + `vpn.endpoint`; when enabled: `disable()` then
  `enable()` (a new proxy port is expected; the orchestrator's browser wiring restarts Edge on `vpn.proxyPort` changes).
- Worker death while enabled (`tunnel 'exit'`/`'error'`): state `'error'`, then restart the tunnel with backoff 5 s, 10 s, 30 s (cap)
  while `enabled`; the proxy stays up and answers 502 meanwhile.
- `proxyUrl()` → `http://127.0.0.1:<port>` while enabled (even when the tunnel is down: fail closed), else `null`.
- `status()` → `{ state, enabled, endpoint, handshakeAgeS, bytesIn, bytesOut, error, proxyPort }`.
- `setDemand()`: no-op (the tunnel runs whenever enabled; keepalives are 32 bytes every 25 s).
- Store writes `store.set(key, value, { src: 'derived', via: 'vpn' })`, from the tunnel's `'status'` events (≤ ~1 Hz) and on transitions:

| Key | Value |
|---|---|
| `vpn.enabled` | boolean from `state.json` |
| `vpn.state` | `'unconfigured'` (no/invalid conf) · `'off'` (valid conf, disabled) · `'connecting'` (enabled; tunnel `starting`/`handshaking` and never up in this worker) · `'up'` (`tunnel.status().state === 'up'`) · `'down'` (enabled; was up, now not) · `'error'` (worker/start failure, retrying) |
| `vpn.endpoint` | `conf.peer.endpoint` (`host:port`), `null` when unconfigured |
| `vpn.handshakeAgeS` | `Math.round(handshakeAgeMs / 1000)` while up, else `null` (semantics §4: seconds since the tunnel came up) |
| `vpn.bytesIn` / `vpn.bytesOut` | `rx` / `tx` (UDP payload bytes incl. WireGuard overhead) |
| `vpn.error` | parse message · tunnel `lastError` · worker error message · `null` |
| `vpn.proxyPort` | loopback port while enabled, else `null` |

### 11.5 Edge flags for the orchestrator (recorded here for Part B's `followup-3-integration.md`; **not verified in this plan**)
Current launch is `server/features/browser.js` ≈ lines 411–420 (`spawn(edgePath, ['--headless=new', '--remote-debugging-port=…', …])`).
While `features.vpn.proxyUrl()` is non-null add `--proxy-server=http://127.0.0.1:<port>`. Recommended, to be validated by whoever wires
it: `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1` (Chromium then cannot resolve any name locally; proxied requests
carry the hostname to the proxy and need no local lookup), `--disable-quic` (QUIC/UDP cannot traverse an HTTP proxy), and
`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`. A proxy change needs an Edge restart (no CDP method changes
`--proxy-server`). Hub wiring shape today: `COMMANDS` table in `server/hub.js` (≈ line 587) with `feature(name, method, ...args)`
(line 165), e.g. `'vpn.set': async ({ on }) => feature('vpn', on ? 'enable' : 'disable')`, `'vpn.reload': async () => feature('vpn', 'reload')`;
`features.vpn = createVpn(ctx)` next to the other features in `server/app.js` (≈ line 89, before `createBrowser`). Optional:
add `vpn\.` to `EPHEMERAL` in `server/store.js` (derived records are not persisted anyway).

---

## 12. Gotchas carried over from CineHD (acceptance doc 2026-10-19/20) and from today's reading

1. **Restart in the same wasm instance fails** (`wg_start` → −104 after `wg_stop`). One worker per start (§5.5).
2. **Sticky `lastError "mux connect failed"`** was fixed in commit b7283427 (clears on immediate success); the copied glue/wasm include it
   (**observed** `lastError ""` after linking).
3. **Re-dial until linked**: loader.js dials every 500 ms while `mux.linked` is false; keep it (§5.4).
4. **Credit window**: 64 KiB capped Proton downloads at ~3 Mbit/s over a 58 ms path; the core now has 1 MiB with 32 KiB grants. A JS
   side with a different grant threshold still interoperates (grants are independent of the window).
5. **u16 `tcp_write`, 256 KiB frame cap, 88 KB send buffer** (§7.5) — the first was listed as "deferred: u16 truncation of >64 KiB
   request bodies" in CineHD; all three reproduced today.
6. **32 streams** (§7.3). A browser page can exceed it; the proxy queues (§11.3). Lifting it needs a rebuild (`MUX_MAX_STREAMS`,
   `MEMP_NUM_TCP_PCB`).
7. **Dead peer is detected late** (§8): the tunnel reports `up` for up to 180 s after the endpoint vanishes; connects time out after
   15 s. Fail-closed is preserved (502), but the UI will say "up" for a while. Not fixable without C changes.
8. **IPv4 only**: no IPv6 inside (lwIP IPv6 off), no IPv6 endpoints (parser rejects `[…]`), A records only.
9. **`handshakeAgeMs` is uptime-since-first-handshake**, `rx/tx` are wire bytes (§4).
10. **Throughput ceiling on the PC is the shim path**, not crypto: CineHD measured ~850 Mbit/s plaintext AEAD on the PC versus
    30–57 Mbit/s end to end. Enough for browsing and ≤ 1080p video; not for 4K.
11. **lwIP asserts abort the wasm** (`LWIP_PLATFORM_ASSERT` → `abort()`): the worker dies with `onAbort`; the feature restarts it (§11.4).
12. **Loopback hub port is unauthenticated** (any local process can connect; CineHD deferred a session token). Mitigations in §7.6 (accept
    only loopback, one link, HELLO within 2 s, destroy extra connections). Same trust level as Lumen's own 127.0.0.1:8790.
13. **Node 22 `fetch` vs the 2019 glue** (§4 note 1) and **`.cjs` renaming** (§2) — both observed today.
14. The worktree's own `mux.test.cjs` #14 fails against the current core (stale 64 KiB assertion), everything else passes (§15). Not a
    tunnel defect.

---

## 13. Test plan for Part C (`test/vpn.test.js`, `test/fixtures/vpn/**`, `test/helpers.js` additions)

Helpers to add to `test/helpers.js`: `testpeerPath()` (§10.4), `genTestpeerKeys()` (spawnSync `genkey`), `clientConf(keys, peerPub, port, opts)`,
`startTestPeer(opts) → { port, conf, wrongPeerConf, waitForLog(re, ms), log(), close() }` (port of `with-testpeer.cjs`: spawn, parse
`listening on udp :(\d+)`, collect stdout/stderr lines, 10 s start timeout), `syntheticConf()` (random 32-byte base64 keys; parse tests only).
Skip the whole suite with `describe(name, { skip })` when `server/vpn/wireguard.js` is missing (`skipUnless`) or `testpeerPath()` is null.

| # | Test | Expectation (numbers observed today unless noted) |
|---|---|---|
| 1 | `parseWireGuardConf` on a Proton-shaped synthetic conf: CRLF, `# comments`, trailing comment on `Endpoint`, `AllowedIPs = 0.0.0.0/0, ::/0` | fields per §9.2; JSON of the result's summary never contains the private key; `serializeWireGuardConf` output has LF only, `PersistentKeepalive = 25` when absent |
| 2 | parse errors | missing PrivateKey, bad base64, endpoint without port, missing DNS, missing Address, > 16 KB, > 599-byte line → `LumenError` `INVALID` with the §9.2 message and no key material in `message` |
| 3 | handshake | `createTunnel({ conf: parse(peer.conf), log })` → `start()` resolves; `status().state === 'up'` within 5 s (observed ≈ 0.5 s + ≤ 1 s STATUS cadence); `endpoint === '127.0.0.1:' + peer.port`; `rx > 0 && tx > 0`; `peer.waitForLog(/handshake ok/, 3000)` |
| 4 | DNS in tunnel | `await tunnel.resolve('anything.test') === '10.66.0.1'` (observed 7 ms); `resolve('10.66.0.1')` returns itself |
| 5 | proxy, absolute-URI | `createVpnProxy({ tunnel, log })`; `GET http://10.66.0.1/hello` sent to `127.0.0.1:<proxyPort>` with the full URL in the request line → 200, body `hello from wg peer\n` (observed 12 ms end to end) |
| 6 | proxy, CONNECT | `CONNECT 10.66.0.1:80` → `HTTP/1.1 200`, then a raw `GET /hello HTTP/1.1\r\nHost: 10.66.0.1\r\n\r\n` → body; also `CONNECT anything.test:80` (name resolved inside the tunnel by the core) → same body |
| 7 | throughput smoke | `GET http://10.66.0.1/blob?bytes=5242880` through the proxy completes with the right length in < 15 s (observed 28–37 Mbit/s → ≈ 1.5 s); assert the byte count, print Mbit/s |
| 8 | fail closed, never up | tunnel from `wrongPeerConf` (handshake pending) + proxy: CONNECT to a local `http.createServer` on 127.0.0.1 → 502 immediately; that server's `connection` count stays 0 |
| 9 | fail closed, peer gone | tunnel up, then `await peer.close()`; CONNECT `127.0.0.1:<localServerPort>` → 502 (arrives after `openTimeoutMs`; pass `openTimeoutMs: 2000` to `createTunnel` to keep the test short); local server count 0; absolute-URI GET → 502 too |
| 10 | fail closed, disabled | `features.vpn` with `enabled:false` → `proxyUrl() === null`; after `disable()` the old proxy port refuses connections |
| 11 | keepalive | conf with `PersistentKeepalive = 1`: `tx` grows by ≥ 64 bytes over 3 s with no streams open |
| 12 | re-handshake | not testable quickly (`REKEY_AFTER_TIME` 120 s, `REJECT_AFTER_TIME` 180 s); the Go peer never initiates. Record as skipped with the reason. |
| 13 | stop() hygiene | `await tunnel.stop()`: `status().state === 'stopped'`; connecting to `tunnel.port` is refused; the Worker emitted `exit`; `node --test` exits without `--test-force-exit` (a leaked I/O worker or socket would keep it alive) |
| 14 | 32-stream limit | open 31 CONNECTs to `10.66.0.1:80` and hold them: the 31st is queued (proxy `maxStreams` 30) and completes after one is closed; with `maxStreams: 32` the core answers `RST too-many-streams` on the 33rd (optional) |
| 15 | feature state keys | `features/vpn.js` with a temp `dataDir`: no conf → `vpn.state 'unconfigured'` + `vpn.error`; valid conf disabled → `'off'`; `enable()` → `'connecting'` then `'up'`, `vpn.proxyPort` number, `vpn.endpoint`, counters increase; `disable()` → `'off'`, `proxyPort null`; `state.json` round-trips `enabled` |

Timing budget: one peer spawn ≈ < 1 s; handshake ≈ 0.5 s; use `waitFor` from helpers with 5–8 s timeouts; whole suite well under a minute.
Never print `peer.conf`, keys or the serialized conf in assertions' messages.

---

## 14. Open observations (not blockers; recorded so nobody re-derives them)

1. **UDP receive buffer is not the limiter.** Hypothesis from `rx ≈ 1.5–1.6 × payload`: datagram drops in the I/O worker causing
   retransmits. Tested by copying the shim to scratch and calling `socket.setRecvBufferSize(4 MiB)` on the dgram socket: 37.4 and
   28.6 Mbit/s versus 30.3 Mbit/s with 64 KiB and 29–34 Mbit/s stock — within run-to-run noise, and `rx` stayed ≈ 1.5×. The excess
   bytes remain unexplained (candidates: retransmissions from the Go netstack, lwIP's window/ACK pattern). Do not ship the buffer
   change as a fix; it is harmless but unproven.
2. **Throughput on this PC** is 29–37 Mbit/s for the CineHD code path, consistent with CineHD's 31.7 Mbit/s; the shim round-trip
   per socket call (Atomics + postMessage) and the 20 ms poll slices dominate. Lower `wg_poll` timeouts raise CPU, not throughput
   (not measured today).
3. **STATUS cadence** is 1 s; `vpn.*` updates are therefore ≤ 1 Hz unless the worker posts on transitions (§5.2 requires that).

---

## 15. What I ran and observed (2026-10-22, Node v22.18.0)

1. `node --test work/wg-tunnel/testing/handshake.test.cjs work/wg-tunnel/testing/mux.test.cjs work/wg-tunnel/testing/core.test.cjs`
   from the worktree (read-only): 14 tests, **13 pass, 1 fail**. Passing: crypto KATs, parser (5), handshake 1.56 s total,
   wrong-key pending with retries (7.18 s), HELLO/STATUS, OPEN → `/hello` body, closed port → RST, DNS `a.test` → `10.66.0.1`,
   **50 MB blob 30.7 Mbit/s over 13.7 s**. Failing: "paused consumer" asserts `got <= 65536 + 2048` but the core delivered exactly
   `1048576` (the 1 MiB window) — stale assertion, credit stop confirmed.
2. `./bin/testpeer.exe` (usage, exit 2), `genkey` (redacted to shape), `serve -h` (flags listed in §10.3).
3. `tools/scratch/vpn-port-plan/probe.mjs` (gitignored; ESM; worker_threads Worker running glue + shim + wasm; CineHD hub on main):
   - stock paths from the worktree: `selftest 0`, `wg_config_parse` rc 0 on the synthetic conf (summary without keys), heap 67,108,864,
     `wg_start 0`, `wg_mux_connect 0`, hub `linked`, **handshake 498 ms**, hub `up` 397 ms later, peer log `handshake ok`,
     `resolve anything.test → 10.66.0.1` 7 ms, `GET /hello` 200 in 12 ms, **20 MB in 4.94 s = 34 Mbit/s, main-thread max lag 7 ms**
     (456 samples at 10 ms), `rx` 33,415,740 / `tx` 1,179,012 after the blob;
   - gotcha A: 204,800-byte DATA frame → `tx` +8,832, no error (truncation to 8,192 + overhead);
   - gotcha C: 2 × 61,440-byte frames → stream error `write-failed`;
   - gotcha B: 307,200-byte frame → hub `down`, stream `vpn-link-lost`, worker `lastError "mux frame too large"`, `mux.linked false`;
   - stop: `wg_stop` → `state "stopped"`, worker exit, peer closed; hub states `linked → up → down`.
4. Second stock run (`PROBE_SKIP_GOTCHAS=1`): handshake 529 ms, **20 MB 5.78 s = 29 Mbit/s**, lag 11 ms, `rx` 32,223,116.
5. `.js` copies of the shim placed inside Lumen's tree: worker error `require is not defined in ES module scope … rename it to use
   the '.cjs' file extension` → renamed to `.cjs` (and the io-worker path inside the shim), then:
   - run A (glue + wasm copied into Lumen as `wg-core.cjs`/`wg-core.wasm`, shim `.cjs`, 4 MiB UDP buffers): ready/selftest 0,
     handshake 486 ms, **37.4 Mbit/s**, lag 8 ms, `rx` 34,022,236;
   - run B (same): handshake 497 ms, 28.6 Mbit/s, lag 16 ms, `rx` 31,719,564;
   - run C (same shim, 64 KiB UDP buffer): handshake 522 ms, 30.3 Mbit/s, lag 10 ms, `rx` 32,094,012.
6. Hashes/sizes in §2: `stat -c %s` + `sha256sum` on the worktree files; `git log -1` → `3be48659`; `git status` showed no changes
   under `work/wg-tunnel/`. In Lumen, `git status` shows only other workflows' files; my writes are this document and
   `tools/scratch/vpn-port-plan/**` (gitignored).

Not done (and not needed for this plan): no Edge launch, no real `.conf`, no TV/emulator/LAN contact, no wasm rebuild, no `npm` changes.

---

## 16. Builders' checklists

**Part A (`vpn-tunnel`)**: copy the §2 files for owner A (rename to `.cjs`, one path edit in the shim), write `NOTICE.md` and the
`licenses/` copies; `conf.js` per §9; `wireguard.js` per §5 (worker body) + §7.6 (hub port) + §11.2 (API); `node --check` everything;
scratch-verify with the Go peer (handshake, `/hello`, resolve, a 5 MB blob, stop) and record numbers in `docs/build-notes/followup-3-vpn-tunnel.md`.

**Part B (`vpn-proxy`)**: `proxy.js` per §11.3 and `features/vpn.js` per §11.4 against a fake tunnel (`connect` returning
`PassThrough`-based duplexes with a `'connect'` event; a `state` you can flip to `'down'`); confirm the fail-closed paths (502, no
`net`/`dns` import); write `followup-3-integration.md` with the exact `hub.js`/`app.js`/`browser.js`/`web` steps (§11.5 gives today's
line anchors) and the Edge flags as *to be validated*.

**Part C (`vpn-tests`)**: fixtures per §2 (Go sources; binary location per §10.4), helpers per §13, `test/vpn.test.js` per the §13 table,
clean skips, no key material in output.
