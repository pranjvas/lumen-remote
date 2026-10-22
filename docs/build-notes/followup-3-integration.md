# Follow-up 3: integration steps for the VPN switch (orchestrator)

Written by Part B (`vpn-proxy`) on 2026-10-22 from the files as they were that day; line numbers are anchors, re-check them
before editing (`server/hub.js`, `server/app.js`, `server/features/browser.js` and `web/**` were being edited by another workflow).
Order: land Parts A, B, C → `node --test test/vpn.test.js` green → steps 1–7 below → the manual validation in step 8.

What already exists after Parts A–C:

- `server/features/vpn.js` `createVpn(ctx)` → `{ start, stop, setDemand, enable(), disable(), reload(), proxyUrl(), status() }`
  (`ctx = { config, data, log, store }` is enough; `lan` is ignored). `proxyUrl()` is `http://127.0.0.1:<port>` whenever the switch
  is on and the proxy listens — also while the tunnel is down (fail closed) — and `null` when the switch is off **or** the switch is
  on but nothing could be started (no/invalid `data/vpn/wg.conf`, tunnel modules unavailable). `status().enabled` tells the two
  apart. `enable()`/`disable()`/`reload()` resolve `{ value: status() }` or reject with `LumenError` (`INVALID` for a bad conf,
  `FAILED` when the tunnel could not start — the switch stays on and retries, `UNAVAILABLE` while Lumen stops).
- State keys (src `derived`, via `vpn`): `vpn.enabled`, `vpn.state` (`unconfigured | off | connecting | up | down | error`),
  `vpn.endpoint`, `vpn.handshakeAgeS`, `vpn.bytesIn`, `vpn.bytesOut`, `vpn.error`, `vpn.proxyPort`.
- Files under `data/` (already git-ignored): `data/vpn/wg.conf` (the user's WireGuard conf, as downloaded), `data/vpn/state.json`.

## 1. `server/app.js` — create the feature and hand it to the browser

- Line 23 area (imports): `import { createVpn } from './features/vpn.js';`
- Lines 89–96, inside the `features` object (before `cast`, order is irrelevant): `vpn: createVpn(ctx),`
  `ctx` is `{ config, data, log, store, lan }` (line 85 area). Being in `features` puts it in `startable` (line 103), so
  `start()`/`stop()` run with the other features; `start()` never throws and takes < 1 s even when the switch is on (the proxy
  listens, the tunnel handshakes in the background).
- Line 101: `features.browser = createBrowser({ ...ctx, hub, vpn: () => features.vpn });` — a getter, like `browser: () =>
  features.browser` on line 95, so the browser reads the VPN lazily at launch time.

## 2. `server/hub.js` — the two commands

- Lines 47–50 `NAMES`: add `vpn: 'The VPN'` (used by `feature()` on line 165 for the UNAVAILABLE message).
- `COMMANDS` (line 587), after `'browser.openOnTv': openOnTv,` (line 737):

```js
    'vpn.set': async ({ on }) => {
      const ack = await feature('vpn', boolean(on, 'on') ? 'enable' : 'disable');
      await features.browser?.applyProxy?.(); // the running Edge gets the new --proxy-server (step 3)
      return ack;
    },
    'vpn.reload': async () => {
      const ack = await feature('vpn', 'reload');
      await features.browser?.applyProxy?.();
      return ack;
    },
```

`boolean()` exists (line 79). The commands are not pointer-streamed, so the default rate bucket applies. `enable()` returns once
the proxy listens and the tunnel worker has started (≈ 0.3 s); the handshake (≈ 0.5 s) shows up as `vpn.state` `connecting → up`.
If `enable()` rejects with `FAILED`, the switch is still on and the proxy answers 502 — call `applyProxy()` anyway (it is in the
`finally` sense: put it in a `try/finally` if you prefer the ack error to propagate, which it should).

## 3. `server/features/browser.js` — proxy flags, fail-closed launch, restart on change

- Line 191: `export function createBrowser({ config, log: rootLog, store, hub, vpn = () => null })`.
- Near line 209 (state): `let launchedProxy = null; // the --proxy-server Edge was started with`.
- `launch()` (line 436), after the Edge-exists check (lines 438–440):

```js
    const vpnFeature = vpn();
    const proxyUrl = vpnFeature?.proxyUrl() ?? null;
    if (vpnFeature?.status().enabled && !proxyUrl) {
      // The switch is on but nothing can carry the traffic: never start Edge without the proxy.
      throw new LumenError('UNAVAILABLE', `The VPN is on but not ready: ${vpnFeature.status().error ?? 'starting'}`);
    }
```

- The spawn (lines 444–453): add, before `'about:blank'`,

```js
      ...(proxyUrl ? [
        `--proxy-server=${proxyUrl}`,
        // To be validated (plan §11.5): no local name resolution except for the proxy itself, no QUIC (UDP cannot use an
        // HTTP proxy), no WebRTC leaks. Chromium bypasses the proxy for loopback by default, which keeps Lumen's own UI reachable.
        '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ] : []),
```

  and right after the spawn: `launchedProxy = proxyUrl;`. Log it in the `browser started` line (line 513): `{ port, pid: browserPid,
  viewport, proxy: !!proxyUrl }` (a boolean, not the URL — the port is in `vpn.proxyPort` anyway).

- New method, exported from the object on lines 664–686 next to `close`:

```js
  // Restarts Edge when the VPN switch changed what --proxy-server must be; reopens the current page.
  async function applyProxy() {
    const want = vpn()?.proxyUrl() ?? null;
    if (want === launchedProxy || (!child && !page && !starting)) return {};
    const url = store.get('browser.url')?.v;
    await close();
    if (url) await open(url); // launch() re-reads proxyUrl(); a fail-closed refusal surfaces as browser.session 'error'
    return {};
  }
```

  `close()` (line 531) already tears Edge down and sets `browser.session 'off'`; `open()` (line 545) relaunches through
  `ensureRunning()`, whose catch turns a `LumenError` from `launch()` into `browser.session 'error'` + `browser.error` (lines 520–526).
  Reset `launchedProxy = null` inside `teardown()` (line 388) so a later launch compares against "no proxy".

- Worker death does **not** change the proxy port (the feature restarts the tunnel behind the same proxy), so nothing else needs to
  restart Edge; pages simply get 502s until `vpn.state` is `up` again.

## 4. `web/js/views/browser.js` — the VPN toggle and status

- Toolbar (lines 141–152): a toggle in `.browser-bar` (desktop) and `.browser-tools` (phone), e.g.

```js
  const vpnButton = (cls) => {
    const b = h('button', { class: `btn ghost browser-vpn ${cls}`.trim(), type: 'button', 'aria-pressed': 'false', title: 'Route this browser through your WireGuard VPN' },
      icon('lock'), h('span', { text: 'VPN' }));
    b.addEventListener('click', () => ctx.cmd('vpn.set', { on: !ctx.state.value('vpn.enabled', false) }, { el: b, timeoutMs: 20000 }));
    return b;
  };
  const vpnButtons = [vpnButton(''), vpnButton('sm')];
```

  (`icon('lock')` or whichever existing glyph the UI builder prefers; `h`, `icon`, `fill` come from `../ui/dom.js`, line 5.)
  Place `vpnButtons[0]` before `closeButtons[0]` on line 148 and `vpnButtons[1]` before `tvButton('tool')` on line 151.

- A `paintVpn()` next to `paintState()` (line 192), watched with `ctx.state.watch(['vpn.*'], paintVpn)` beside line 261:

```js
  const VPN = { unconfigured: ['off', 'VPN: no config'], off: ['off', 'VPN off'], connecting: ['warn', 'VPN connecting…'], up: ['good', 'VPN on'], down: ['bad', 'VPN down'], error: ['bad', 'VPN error'] };
  function paintVpn() {
    const enabled = !!ctx.state.value('vpn.enabled', false);
    const state = ctx.state.value('vpn.state', 'unconfigured');
    const [tone, label] = VPN[state] || VPN.off;
    for (const b of vpnButtons) {
      b.setAttribute('aria-pressed', String(enabled));
      b.disabled = state === 'unconfigured' && !enabled;
      b.title = state === 'unconfigured' ? 'Save your WireGuard .conf as data/vpn/wg.conf on the Lumen PC, then reload' : 'Route this browser through your WireGuard VPN';
      b.dataset.tone = tone;
    }
    vpnText.textContent = enabled ? `${label}${enabled && state !== 'up' && ctx.state.value('vpn.error', null) ? ` · ${ctx.state.value('vpn.error')}` : ''}` : '';
  }
```

  with `const vpnText = h('span', { class: 'browser-vpn-text' });` appended to the `.browser-status` line (line 149) after `meta`.
  While `vpn.enabled` is true and `vpn.state` is not `up`, the page area shows 502s from the proxy; the status line carrying
  `vpn.error` is what tells the user why ("Fail closed … the Browser view shows the VPN error" in the brief).
- Optional: the `welcome()` copy (line 240) can mention "VPN routes this browser through your own WireGuard tunnel".
- Optional `vpn.reload`: a small "Reload VPN config" button in Settings › Connection, or a long-press on the toggle — the
  command exists; the UI is the builder's call.

## 5. `web/css/views.css`

Near `.browser-bar` (line 859) / `.browser-tools .btn[aria-pressed="true"]` (line 1009), style `.browser-vpn[aria-pressed="true"]`
with the accent (the phone rule on line 1009 already covers `.browser-tools`), `.browser-vpn[data-tone="bad"]` with the bad tone,
and `.browser-vpn-text` like `.browser-meta` (muted, truncating).

## 6. `server/store.js` (optional)

Line 12 `EPHEMERAL`: add `vpn\.` so a stale `vpn.*` record can never come back from `state-cache.json` (`derived` records are not
persisted today anyway — `PERSISTED_SOURCES` on line 10 — so this is belt and braces).

## 7. `.gitignore` and the spec

- Add `test/fixtures/vpn/bin/` (Part C's 14 MB `testpeer.exe`; plan §2). `data/` already covers `data/vpn/**`.
- `docs/superpowers/specs/2026-10-21-lumen-remote-design.md` §11.3: add a "VPN" paragraph — the switch, the files, the keys,
  the two commands, fail-closed behaviour — so the spec stays the binding reference.

## 8. Manual validation (never with a real conf or a real endpoint)

1. Start the Go test peer from Part C's helper (`startTestPeer()` in `test/helpers.js`, or `test/fixtures/vpn/bin/testpeer.exe serve
   -listen 127.0.0.1:0 -private <genkey> -peer <genkey public> -ip 10.66.0.1 -client 10.66.0.2`), and write its `clientConf` as
   `vpn/wg.conf` under a **temporary dataDir** passed to `startServer({ dataDir })` (never the real `data/`).
2. In the UI: Browser view → VPN toggle → `vpn.state` goes `connecting → up`, `vpn.proxyPort` set; open `http://10.66.0.1/hello` →
   the page shows `hello from wg peer` (10.66.0.1 only exists inside the tunnel, so this proves Edge used the proxy).
3. Fail closed: open `http://127.0.0.1:<any local http server>/` → still loads (Chromium's loopback bypass, intended for Lumen's own UI);
   open `http://example.invalid/` → an error page (proxy 502 `vpn: dns-failed`); stop the peer → within the tunnel's detection window
   new pages fail with 502 and `vpn.state` eventually shows `down`; `vpn.set { on: false }` → Edge restarts without the proxy.
4. Edge flags: confirm in the CDP `Browser.getVersion`/`chrome://version` that `--proxy-server` and the three recommended flags are
   present, and that a page with WebRTC/QUIC does not leak (e.g. a local HTTP/3-only test server stays unreachable).
5. `node --test` for the whole suite still exits by itself (no leaked worker threads or sockets).

Edge flags in step 3 of §3 are **recommended, not validated** by Part B (plan §11.5); drop `--host-resolver-rules` if it breaks
Lumen's own UI in Edge, keep `--proxy-server` and `--disable-quic` in any case.
