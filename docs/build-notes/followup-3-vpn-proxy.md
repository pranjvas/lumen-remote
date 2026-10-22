# Follow-up 3, Part B: `vpn-proxy` build notes

Date: 2026-10-22. Role: `vpn-proxy`. Plan followed: `docs/build-notes/followup-3-vpn-port-plan.md` §11.3, §11.4, §11.5, §16.
Files owned and written: `server/vpn/proxy.js`, `server/features/vpn.js`, `docs/build-notes/followup-3-integration.md`, this note.
Scratch (gitignored): `tools/scratch/vpn-proxy/fake-tunnel.mjs`, `check-proxy.mjs`, `check-feature.mjs`.

Nothing here contacted the TV, the emulator, any LAN device, any VPN endpoint or even the Go test peer: every check ran
against a fake tunnel on loopback with random throwaway bytes standing in for keys. No real `.conf` was read. No `sdb`,
no installs, no `npm` changes, nothing under `server/hub.js`, `server/app.js`, `server/features/browser.js` or `web/**`
was touched, the CineHD worktree was only read (`service/tunnel-hub.js`, for the Duplex semantics the fake mirrors).
Part A's `server/vpn/conf.js` and `server/vpn/wireguard.js` did not exist while this was built (see "Interpretations" 1); they
appeared as I finished, and the compatibility checks in "Verification" 4–5 were run against them (parser only, no tunnel start).

## Files and exports

### `server/vpn/proxy.js`

```js
createVpnProxy({ tunnel, log, maxStreams = 30, queueMs = 10000 }) → { start() → Promise<{ port }>, stop() → Promise<void>, port }
parseAuthority(text)      → { host, port } | null     // CONNECT target: host:port, IPv4/hostname only, port 1–65535
parseAbsoluteUrl(raw)     → { host, port, path } | null // absolute http:// target; relative, https://, userinfo, [IPv6] → null
```

- `http.createServer()` on `127.0.0.1`, port 0; `port` is `null` until `start()` and after `stop()`. `start()` is idempotent.
- Only outbound primitive: `tunnel.connect(host, port)`; gate: `tunnel.status().state === 'up'`. The file imports `node:http` only
  (asserted by `check-proxy.mjs`: no `node:net`, no `node:dns`, no `require`).
- `'connect'` (CONNECT): 400 `vpn: bad-request` on a bad authority; 502 `vpn: vpn-tunnel-down` when not up; otherwise a slot is
  reserved (queue below), `tunnel.connect(host, port)`, on the Duplex's `'connect'` → `HTTP/1.1 200 Connection Established`,
  `setNoDelay(true)`, `head` forwarded, `socket.pipe(up).pipe(socket)`; `'error'` before 200 → 502 `vpn: <err.code>`; after 200 →
  the client socket is destroyed. Tunnel EOF → `socket.end()`; client close → `up.destroy()`.
- `'request'` (absolute URI): 400 for anything but `http://host[:port]/…`; 502 when not up; else `http.request({ createConnection:
  () => up, host, port, method, path, headers, setHost: false })` (no agent, so Node's `createConnection` path is used), end-to-end
  headers only (`proxy-connection`, `connection`, `keep-alive`, `proxy-authorization`, `te`, `trailer`, `upgrade` and whatever the
  `Connection` header names are dropped both ways), body piped both ways, status + message + headers copied; upstream error → 502
  if headers are not sent yet, else `res.destroy()`; client gone → `upReq.destroy()`.
- Concurrency: `active` streams ≤ `maxStreams`; further CONNECT/requests wait up to `queueMs` for a slot (a freed slot passes
  straight to the oldest waiter), then 502 `vpn: busy`. A slot is held from `tunnel.connect()` until the Duplex's first `'close'`
  or `'error'`.
- All error bodies are one line, `vpn: <code>\n`, with `Connection: close`.
- Logging: `log.child('vpn-proxy')`; `info` only for start/stop (`{ port, maxStreams }`); per-request lines (`method/host:port/
  code`) at `debug`; never a URL or path.
- `stop()`: rejects waiters, destroys client sockets and open tunnel streams, closes the listener, `port = null`. Idempotent.

### `server/features/vpn.js`

```js
createVpn({ config, data, log, store, seams? }) → { start, stop, setDemand, enable(), disable(), reload(), proxyUrl(), status() }
```

- `seams` (optional, tests only): `{ createTunnel?, parseWireGuardConf? }` replace the real `server/vpn/wireguard.js` /
  `server/vpn/conf.js` exports. Without seams both modules are loaded with a dynamic `import()` on `start()` (Interpretations 1).
- Files: `path.join(config.dataDir, 'vpn', 'wg.conf')` read with `fs.readFileSync` (text); `data.readJson('vpn/state.json',
  { enabled: false })` / `data.writeJson('vpn/state.json', { enabled })`.
- `start()`: reads the switch, loads the modules (failure → `vpn.state 'error'`, `vpn.error 'VPN modules are not available: …'`),
  parses the conf (missing → `'unconfigured'` + `No VPN configuration: save the WireGuard .conf as data/vpn/wg.conf`; invalid →
  `'unconfigured'` + the parser's message), and when the switch is on and the conf is valid brings the VPN up (proxy first, then
  the tunnel), logging rather than throwing if that fails. Never throws.
- `enable()` → `{ value: status() }`. Persists `enabled: true`, starts the proxy, then `tunnel.start()`. Invalid/missing conf →
  `LumenError('INVALID', <parse message>)` and the switch stays off. Tunnel start failure → `LumenError('FAILED', message)` while
  the switch stays on, the proxy keeps answering 502 and a restart is scheduled (fail closed). Idempotent while running.
- `disable()` → `{ value: status() }`: persists `enabled: false`, stops the proxy then the tunnel (`stop()` capped at 5 s), state `'off'`.
- `reload()`: re-reads and re-parses. Disabled → just republishes. Enabled → tears down, and if the conf is now invalid turns the
  switch off and throws `INVALID`; otherwise brings the VPN up again (new proxy port).
- Worker death (`tunnel 'error'` / `'exit'`) or a failed `start()` while enabled: `vpn.state 'error'`, `vpn.error` = the message,
  a fresh `createTunnel()` after 5 s, 10 s, 30 s, 30 s … (`RESTART_BACKOFF_MS`); the counter resets when the tunnel reports `'up'`.
  The proxy is never restarted for this: it holds a facade `{ status, connect }` that always points at the current tunnel.
- `proxyUrl()` → `http://127.0.0.1:<port>` whenever the switch is on and the proxy listens (also while the tunnel is down or in
  error), else `null`.
- `status()` → `{ state, enabled, endpoint, handshakeAgeS, bytesIn, bytesOut, error, proxyPort }` — exactly the eight `vpn.*` keys.
- `setDemand()` no-op. `enable` / `disable` / `reload` / `stop` run one at a time (promise chain).
- Store: `store.set('vpn.<key>', value, { src: 'derived', via: 'vpn' })` on every tunnel `'status'` event and on transitions; an
  unchanged primitive is not re-set. Values:

| Key | Value |
|---|---|
| `vpn.enabled` | the persisted switch |
| `vpn.state` | `'unconfigured'` (no/invalid conf, or modules unavailable → `'error'`) · `'off'` · `'connecting'` (tunnel `starting`/`handshaking`) · `'up'` · `'down'` (tunnel reports `down`) · `'error'` (tunnel `error`/`stopped`, no tunnel yet, or a restart pending) |
| `vpn.endpoint` | `conf.peer.endpoint`, `null` when unconfigured |
| `vpn.handshakeAgeS` | `Math.round(handshakeAgeMs / 1000)` while up, else `null` |
| `vpn.bytesIn` / `vpn.bytesOut` | tunnel `rx` / `tx` while enabled, else `null` |
| `vpn.error` | module load error · parse message · tunnel/worker failure message · tunnel `lastError` while not up · `null` |
| `vpn.proxyPort` | the loopback port while enabled, else `null` |

- Logging: `log.child('vpn')`; the tunnel and the proxy receive the root logger (`createTunnel({ conf, log: rootLog })`) so each
  derives its own tag. Logged conf-derived data: `peer.endpoint` only. Keys never reach the store, logs, errors or messages.

## Interpretations and deviations from the plan

1. **Lazy loading of Part A's modules.** `features/vpn.js` imports `server/vpn/conf.js` and `server/vpn/wireguard.js` with a
   dynamic `import()` inside `start()` instead of static imports. Reasons: Part A's files did not exist while Part B was built and
   verified, and this way Lumen boots (with `vpn.state 'error'` and a one-line `vpn.error`) even if the wasm tunnel module is
   missing or fails to load, which matches "never a crash". The `seams` option exists for the same reason (tests inject a fake
   tunnel). Everything else in the plan's API is unchanged.
2. **`enable()` on a tunnel start failure rejects with `FAILED`** (the plan only specifies the invalid-conf case). The switch stays
   on, the proxy stays up (502), and the restart back-off runs — so the ack tells the user what went wrong while the system stays
   fail-closed. `reload()` behaves the same way.
3. **The switch survives a Lumen restart.** `start()` brings the VPN up when `state.json` says `enabled: true` (plan §11.4 implies it:
   "the tunnel runs whenever enabled"). The proxy is listening before `start()` resolves, so `proxyUrl()` is set before the browser
   can ask. If the switch is on but the conf is missing/invalid, the switch stays on, `vpn.state` is `'unconfigured'` and
   `proxyUrl()` is `null`; the browser wiring must therefore refuse to launch Edge while `vpn.enabled && !proxyUrl()` (written into
   the integration note).
4. **`vpn.bytesIn`/`bytesOut` are `null` while disabled** (the plan does not say). While enabled they are the tunnel's wire byte
   counters (UDP payload bytes, as §4 of the plan explains).
5. **`vpn.state 'error'` also covers "no tunnel object yet / tunnel reports `stopped` while enabled"**, which only happens for a
   moment between `enable()` and `createTunnel()` or between a worker death and its restart.
6. **Proxy facade.** Because every restart creates a fresh tunnel object (plan §5.5), the proxy is given `{ status(), connect() }`
   delegating to the current tunnel rather than the tunnel itself. Part C tests that build `createVpnProxy({ tunnel })` with a real
   tunnel are unaffected.
7. **Hostname validation** in the proxy is stricter than "no `[`": `^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$`, no userinfo, port 1–65535.
   Anything the tunnel (IPv4, A records) could not serve is refused with 400 rather than sent into the tunnel.
8. **`maxStreams` default 30**, the plan's number (the C side caps at 32).

## Known gaps

- Not run against the real tunnel (`server/vpn/wireguard.js`) or the Go test peer: those are Part A's and Part C's deliverables.
  The fake tunnel follows the plan's §11.2 API and §7.6 Duplex semantics (`'connect'` after a delay with writes buffered before
  it, `'error'` with `code`, one `'close'`, `allowHalfOpen`, no-op `setTimeout`/`setNoDelay`/`setKeepAlive`/`ref`/`unref`).
- The `Upgrade` path (WebSocket over an absolute-URI http request) is not implemented; Chromium tunnels WebSockets through
  CONNECT, which is covered. A client that sends `Upgrade` on the http path gets Node's default (connection closed).
- `Expect: 100-continue` is forwarded as a header, not negotiated.
- Dead-peer detection, `handshakeAgeS` semantics and the 32-stream ceiling are the tunnel's (plan §12 items 6, 7, 9).
- Edge flags in the integration note are recorded as *to be validated* (plan §11.5); no Edge was launched here.

## Verification performed (what was actually run)

Node v22.18.0, Windows 11, repo `C:/Users/pranj/source/lumen-remote`. Both check scripts live in `tools/scratch/vpn-proxy/`
(gitignored) and use `createTestLog`, `waitFor`, `sleep` from `test/helpers.js`, the real `createStore` and `createDataStore`.

1. `node --check server/vpn/proxy.js` and `node --check server/features/vpn.js`: both OK (run after the final edit as well).
2. `node tools/scratch/vpn-proxy/check-proxy.mjs` → **19/19 ok**, process exited on its own (no leaked handles):
   parse helpers (accept/refuse lists); absolute-URI GET → 200 with the body from the "inside" server and `tunnel.connect`
   called with `{ host: 'example.test', port: 80 }` (hostname unresolved); POST with path/query/body and `x-test` forwarded while
   `proxy-connection`, `x-hop` (named by `Connection: close, X-Hop`) and `proxy-authorization` are stripped; chunked request body
   intact; duplicate `Set-Cookie` preserved and port 8080 honoured; 5 MB absolute-URI body in 123 ms; CONNECT `example.test:443`
   → 200 then plain HTTP inside; CONNECT by IPv4 literal; 5 MB through CONNECT in 36 ms; 400 for `[::1]:443`, `example.test`,
   `:0`, `:70000`, relative URL, `https://`, userinfo; tunnel `handshaking` → 502 `vpn: vpn-tunnel-down` on both paths with no
   `connect()` call; **fail closed**: CONNECT and GET to `127.0.0.1:<decoy>` both went into the tunnel (`connects` shows the decoy
   target), got 502 `vpn: connect-failed`, and the decoy server's connection count stayed 0; stream reset after CONNECT 200 →
   client socket destroyed; upstream reset mid-response → client response aborted (not hung); client gone before OPENED →
   tunnel stream released (`streams` back to 0); `maxStreams: 2, queueMs: 300` → third CONNECT queued, completed when a slot
   freed, fourth got 502 `vpn: busy` after the queue timeout; `stop()` → `port === null`, held socket closed, streams 0,
   `ECONNREFUSED` on the old port, second `stop()` a no-op; the module's only `import` line is `node:http`; info-level lines
   contain no host or URL, debug lines carry `host`.
3. `node tools/scratch/vpn-proxy/check-feature.mjs` → **12/12 ok** (one run with a fake-tunnel counter bug first, fixed in the
   fake, then all green), process exited on its own, temp data dir removed:
   no conf → `vpn.state 'unconfigured'`, `vpn.error` naming `data/vpn/wg.conf`, `src 'derived'`, `via 'vpn'`, `enable()` →
   `INVALID`, `proxyUrl() === null`; invalid conf + `reload()` → `'unconfigured'`, `PrivateKey is missing`; valid conf → `'off'`,
   `vpn.endpoint '127.0.0.1:51820'`; `enable()` → ack `state 'connecting'` with a numeric `proxyPort`, `proxyUrl()` matches,
   `state.json { enabled: true }`, then `'up'`, `handshakeAgeS` a number, GET through the real proxy → 200, `bytesIn`/`bytesOut`
   grow, second `enable()` idempotent (same port, no new tunnel); worker death → `'error'` with `vpn.error 'mux frame too large'`,
   proxy still listening and answering 502, **restart after 4995 ms** on the same port → `'up'`, `vpn.error null`, GET 200 again;
   `disable()` → `'off'`, every key as expected, `state.json { enabled: false }`, old port `ECONNREFUSED`, tunnel `'stopped'`,
   second `disable()` a no-op; `reload()` while enabled → new port, old port refused, old tunnel stopped, GET 200 on the new one;
   `reload()` with a now-invalid conf → `INVALID`, switch off, proxy closed; `enable()` whose tunnel start fails → `FAILED
   'wasm abort: selftest'`, `vpn.enabled true`, proxy up answering 502, retry after the back-off → `'up'` on the same port;
   `stop()` then a fresh instance over the same data dir → `start()` brings the VPN up by itself with `proxyUrl()` set when
   `start()` resolves; switch on + conf removed → `'unconfigured'`, `enabled true`, `proxyUrl() null`, `enable()` `INVALID`;
   the throwaway "private key" and "public key" strings appear nowhere in the log text, `store.snapshot()` or `status()`; final
   `stop()` leaves every fake tunnel stopped (8 tunnels created over the run).
4. Compatibility with Part A once its files landed (`server/vpn/conf.js` 5466 B, `server/vpn/wireguard.js` 26401 B, both written
   at 15:43–15:45): `grep ^export` + a one-off `import()` of both modules from the repo root → `conf.js` exports
   `parseWireGuardConf, serializeWireGuardConf, summarizeWireGuardConf`; `wireguard.js` exports `FRAME_TYPES, createFrameDecoder,
   createTunnel, encodeFrame` (its signature: `createTunnel({ conf, log, openTimeoutMs = 15000, dnsTimeoutMs = 10000,
   startTimeoutMs = 15000 })`) — the two names `features/vpn.js` imports lazily. The real parser on a synthetic conf (random
   32-byte base64 "keys") returned `{ privateKey, address: ['10.66.0.2/32'], dns: ['10.66.0.1'], peer: { publicKey, endpoint:
   '127.0.0.1:51820', allowedIPs: ['0.0.0.0/0'] } }` and, without `PrivateKey`, a `LumenError` with code `INVALID` and message
   `PrivateKey is missing` — the shape and messages the feature relies on. Importing `wireguard.js` on the main thread started nothing.
5. `REAL_CONF=1 node tools/scratch/vpn-proxy/check-feature.mjs` (parser seam dropped, so the feature loads `server/vpn/conf.js`
   itself; the tunnel still faked) → **12/12 ok**, restart after 4982 ms, clean exit. The real tunnel was not started (that needs the
   Go peer and is Part C's end-to-end test).
6. `git status`: my writes are `server/vpn/proxy.js`, `server/features/vpn.js`, the two docs, and `tools/scratch/vpn-proxy/**`
   (gitignored). `tools/scratch/` is confirmed ignored by `git check-ignore`.

Not done: no Edge launch, no real `.conf`, no real tunnel, no Go peer, no TV/emulator/LAN contact, no `npm` changes.
