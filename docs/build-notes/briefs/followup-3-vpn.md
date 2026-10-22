# Follow-up 3: VPN inside Lumen (for the Browser view)

Read `docs/build-notes/briefs/00-common.md` for the shared rules.

## What the user asked

"It will have a VPN option. The VPN routing will be limited inside Lumen so it can be done at the TV level without requiring external dependencies." The user owns the VPN (WireGuard `.conf` files, e.g. Proton's), the network and the device; the purpose is securing the traffic. So: a **VPN switch in the Browser view**. When it is on, the traffic of Lumen's own browser (headless Edge, spec §11.3) goes through a **user-space WireGuard tunnel that runs inside the Lumen process** and is exposed as a **local HTTP proxy** (CONNECT for https, absolute-URI for http) on 127.0.0.1. Edge is started with `--proxy-server=http://127.0.0.1:<port>` while the switch is on (switching restarts the headless browser). Nothing else on the PC, the router or the TV changes, and no OS VPN client, driver or admin rights are needed.

## Reuse (read these first)

CineHD already did the hard part, in the worktree `C:/Users/pranj/Documents/Codex/2026-09-16/how-x20/.worktrees/proton-wg-tunnel` (read-only; never commit, build, install or run anything that touches the TV or the emulator from there; never read or print private keys):
- `docs/superpowers/specs/2026-10-19-proton-wg-tunnel-design.md`, `docs/superpowers/plans/2026-10-19-proton-wg-tunnel.md`, `docs/acceptance/2026-10-19-proton-wg-tunnel.md` — design, plan, what was verified.
- `work/wg-tunnel/core/*.c|h` (wireguard-lwip + lwIP, mux, udp transport, config), `work/wg-tunnel/wasm/` (the built `.wasm` and JS glue), `work/wg-tunnel/service/tunnel-hub.js` (Node-side multiplexer: TCP streams over the tunnel, DNS inside the tunnel), `work/wg-tunnel/service/tunnel-agent.js` (an http.Agent whose sockets are tunnel streams), `work/wg-tunnel/probe/` (`probe-peer.cjs` drives `bin/testpeer.exe`, a Go user-space WireGuard **test peer** with an HTTP responder behind it), `work/wg-tunnel/protocol/`, `work/wg-tunnel/testing/`, `work/wg-tunnel/tools/` (build scripts; the Samsung Emscripten SDK is at `C:/Users/pranj/Documents/Codex/Tools/SamsungEmscripten/...` — rebuilding the wasm should not be necessary; copy the built artefact).
- Licences: wireguard-lwip and lwIP are BSD-style; keep their notices with any copied code (`third_party/` in Lumen).

## Deliverable (Lumen side, Node 22 ESM; keep runtime deps as they are — copied wasm/JS is fine)

```
server/vpn/wireguard.js   createTunnel({ conf, log }) → { start(), stop(), connect(host, port) → Duplex, resolve(host) → ip, status() }
server/vpn/proxy.js       createVpnProxy({ tunnel, log }) → { start() → { port }, stop(), port }   // 127.0.0.1 only; fail-closed: tunnel down → 502
server/vpn/conf.js        parseWireGuardConf(text) → { privateKey, address[], dns[], peer: { publicKey, presharedKey?, endpoint, allowedIPs[], keepalive? } }   // never logs keys
server/features/vpn.js    createVpn(ctx) → { start, stop, setDemand, enable(), disable(), proxyUrl(), status(), reload() }
server/vpn/third_party/   copied wasm + glue + licence notices
test/vpn.test.js          end-to-end with bin/testpeer.exe (copied into test/fixtures/vpn/ or referenced by absolute path, with a clean skip when missing)
docs/build-notes/followup-3-<role>.md
```

- Config file: `data/vpn/wg.conf` (standard WireGuard INI as downloaded from the provider; git-ignored — `data/` already is). `features.vpn` loads it at start and on `reload()`; missing or invalid → state `vpn.state = 'unconfigured'` with a one-line `vpn.error`, never a crash.
- State keys (src `derived`, via `vpn`): `vpn.state` (`'unconfigured' | 'off' | 'connecting' | 'up' | 'down' | 'error'`), `vpn.endpoint` (host:port of the peer, no keys), `vpn.handshakeAgeS`, `vpn.bytesIn`, `vpn.bytesOut`, `vpn.error`, `vpn.proxyPort` (loopback port while up), `vpn.enabled` (persisted in `data/vpn/state.json`).
- Fail closed: while `vpn.enabled` is true, the proxy never falls back to a direct connection. If the tunnel is down, requests get 502 and the Browser view shows the VPN error.
- DNS: hostnames are resolved **inside the tunnel** through the DNS servers from the `.conf` (as tunnel-hub does), never through the PC's resolver; the proxy receives hostnames (CONNECT host:port), so Edge never resolves them locally.
- Keepalive: honour `PersistentKeepalive`; re-handshake on expiry as wireguard-lwip does; `status()` exposes handshake age and byte counters.
- **Not in this follow-up** (the orchestrator wires them after the parallel Browser-view build lands, to avoid file clashes): `server/hub.js` commands (`vpn.set { on }`, `vpn.reload`), `server/app.js` wiring, `server/features/browser.js` proxy flag + restart, and the UI toggle in `web/js/views/browser.js`. Write the exact integration steps into `docs/build-notes/followup-3-integration.md` (which file, which lines, which calls).

## Roles

- **Part R — `vpn-port-plan`** (owns only `docs/build-notes/followup-3-vpn-port-plan.md`): study the CineHD implementation and write the porting plan that the three builders follow: exactly which files to copy (with sizes/hashes), how the wasm is instantiated in Node 22 (the socket shim: map the Tizen/Emscripten socket calls to `node:dgram` for the WireGuard UDP transport), the mux protocol between JS and wasm (frame formats, how a TCP stream is opened/closed, backpressure), how DNS-in-tunnel works, the conf fields used, how `probe-peer.cjs` drives `bin/testpeer.exe` (arguments, generated keys, the HTTP responder it exposes, ports), known gotchas from the acceptance doc (MTU, keepalive, handshake retry, throughput numbers), and a minimal API design matching the deliverable above. Be concrete and complete; the builders will not go back to the worktree for anything you leave out.
- **Part A — `vpn-tunnel`** (owns `server/vpn/wireguard.js`, `server/vpn/conf.js`, `server/vpn/third_party/**`): port the tunnel per the plan.
- **Part B — `vpn-proxy`** (owns `server/vpn/proxy.js`, `server/features/vpn.js`, `docs/build-notes/followup-3-integration.md`): the HTTP proxy and the feature, coded against the tunnel API in the plan (use a fake tunnel for your own checks).
- **Part C — `vpn-tests`** (owns `test/vpn.test.js`, `test/fixtures/vpn/**`, `test/helpers.js` additions only): end-to-end tests with the Go test peer on loopback: handshake up → `status()`; HTTP GET through the proxy to the responder behind the peer; CONNECT to it; DNS resolved through the tunnel (the test peer or a tiny UDP DNS responder inside the test); fail-closed when the peer is stopped (502, no direct fallback — assert with a local HTTP server that must NOT be reached); keepalive/re-handshake if the peer supports it; stop() leaves no sockets or child processes. Also parse tests for `conf.js` with a synthetic conf (generated keys, never real ones).

Parts A, B and C start after R and run in parallel; they must agree on the plan's API. Finish each with `docs/build-notes/followup-3-<role>.md`.

## Orchestrator integration step (after the Browser-view and VPN workflows land)

- **Config in place (2026-10-22):** `data/vpn/wg.conf` is the WireGuard config CineHD used (Proton `wg-LK-6`, Sri Lanka, endpoint 45.83.127.1:51820; copied from the CineHD VPN session's scratchpad; never print it).
- **"Use a config file" (user request 2026-10-22: "also add option to lumen to use the file provided, in case i want to change the config"):**
  - `POST /api/vpn/config` (same-origin, `X-Lumen-CSRF`, body = the `.conf` text, at most 8 KB) → `parseWireGuardConf` must succeed → keep the old file as `data/vpn/wg.conf.bak`, write the new one atomically → `features.vpn.reload()` (reconnects if enabled) → `{ ok, endpoint, address }`. Never echo keys; reject anything that isn't a WireGuard INI.
  - UI: in the Browser view's VPN panel, a **Use a config file…** button (`<input type=file accept=".conf,text/plain">`, works from phones), showing the current endpoint/address and an "Undo" to restore `wg.conf.bak`.
- Hub commands `vpn.set { on }`, `vpn.reload`, `vpn.restoreBackup`; `features.browser` starts Edge with `--proxy-server=http://127.0.0.1:<vpn.proxyPort>` while `vpn.enabled` and restarts it on toggle; the Browser toolbar shows a VPN pill (state, endpoint, handshake age, bytes) and the switch.
