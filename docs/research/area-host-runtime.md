# Research area: host-runtime

## Summary

I recommend a single Node 22 process with one runtime dependency, `ws` 8.x (it has zero transitive deps). It uses `ws` both as the client for the TV's wss://192.168.1.2:8002 remote channel and as the browser push channel. For the TV channel I turn off certificate checking for that connection only (rejectUnauthorized:false) and pin the TV certificate's SHA-256 fingerprint on first use. NODE_TLS_REJECT_UNAUTHORIZED is never touched. I tested this locally against a self-signed CN=SmartViewSDK mock. Node's built-in WebSocket (undici 6.21.2) can also connect without weakening TLS for the rest of the process, using a per-connection dispatcher whose Agent class is taken from Symbol.for('undici.globalDispatcher.1'). Its failure handling is broken, though: error messages have no code, no close event fires after a TLS failure, calling close() inside onerror recursed until the stack overflowed, and there is no ping() for heartbeats. So it is not recommended. UPnP needs no XML library: SOAP goes through fetch with a quoted SOAPACTION header and regex/entity parsing, and GENA SUBSCRIBE goes through node:http. The callback address is socket.localAddress from a TCP connection to the TV. If no initial NOTIFY (SEQ 0) arrives within 5 s, the app falls back to polling. That fallback is required because Microsoft's own docs say a cancelled firewall prompt, or any prompt answered by a non-admin, creates permanent inbound block rules for node.exe. By default the web server binds only 127.0.0.1, which raises no firewall prompt. It checks the Host header against an allowlist (421 otherwise) and also checks Origin. POSTs must carry a custom CSRF header, and the browser WebSocket upgrade checks Host, Origin and a cookie. Phone access is opt-in and paired with a PIN. A local end-to-end proof of concept against a full mock TV (REST, wss token issuance, SOAP, GENA with a 'firewall drop' mode) passed all 13 checks, including GENA→browser push and automatic fallback to polling. For starting at logon without admin, a Startup-folder shortcut runs wscript.exe on a JScript (not VBScript) launcher with Run(...,0). I verified this leaves both the node window and its conhost window invisible, with no handoff to Windows Terminal. A port-based single-instance lock, an IPC supervisor and log rotation with explicit reopen were also tested. The PWA works on http://127.0.0.1 (a secure context) but not over plain http on the LAN for phones. Headless screenshots work with no extra installs: Node drives the system Edge 155 over the Chrome DevTools Protocol, and the browser must be closed with Browser.close because Edge relaunches itself. None of this touched the TV. The things the design depends on but that are not yet seen live are: whether 8002 accepts a TLS handshake from Node 22/OpenSSL 3, whether the TV answers WebSocket pings, whether GENA NOTIFYs get through this PC's firewall, whether the TV emits volume events for physical-remote changes, and whether Wake-on-LAN wakes this TV.

## Capabilities

- **Remote-control channel client (wss 8002) from Node 22 with self-signed TLS** (source-code, medium; read=true write=true live=true): npm ws 8.x: new WebSocket('wss://192.168.1.2:8002/api/v2/channels/samsung.remote.control?name=<base64 name>&token=<saved>', {rejectUnauthorized:false, perMessageDeflate:false, handshakeTimeout:10000}); on 'upgrade' compare res.socket.getPeerCertificate().fingerprint256 with the pinned value (trust on first use). ws sets servername '' for IP hosts itself, so no SNI is sent.
  - Ran locally against a self-signed CN=SmartViewSDK RSA-2048 mock: works, default fetch elsewhere still rejects self-signed certs (TLS not weakened for the process), and ws reports clear error codes (DEPTH_ZERO_SELF_SIGNED_CERT, ECONNREFUSED, close 1006). Node does not call checkServerIdentity when rejectUnauthorized:false and the chain fails, so the pin must be checked manually. Pinning with ca:<TV PEM> plus a no-op checkServerIdentity also works, but would break on an expired or rotated TV cert (openHAB users report odd or expired certs), so pin the fingerprint and show a 're-trust' screen on mismatch. The TLS handshake against this TV has not been observed: a legacy cipher or TLS-version mismatch could need a per-connection ciphers:'DEFAULT@SECLEVEL=0' or minVersion setting.
- **Node global WebSocket (undici 6.21.2) as an alternative TV client** (source-code, high; read=true write=true live=true): await fetch('data:,'); const Agent = globalThis[Symbol.for('undici.globalDispatcher.1')].constructor; new WebSocket(url, {dispatcher: new Agent({connect:{rejectUnauthorized:false}}), headers:{...}})
  - Works per connection without process-wide TLS changes (tested locally). Not recommended: (a) on TLS failure the ErrorEvent says only 'Received network error or non-101 status code', with no code; (b) no close event fired and readyState stayed 0; (c) calling ws.close() inside onerror re-fires error synchronously, which overflowed the stack; (d) it auto-pongs but has no ping() API, so it cannot detect a dead link from the client side; (e) the Agent class is reached through an internal symbol, unless the npm undici package is added.
- **TV token persistence and first-pairing flow** (source-code, medium; read=true write=true live=false): Use a fixed client name (base64 in the 'name' query). On {event:'ms.channel.connect', data:{token}}, if the token differs from the stored one, save it atomically to config and reconnect later with &token=. Wait up to 35 s for the first message while the TV's Allow popup is shown; 'ms.channel.unauthorized' means stop retrying and show help.
  - samsungtvws reads data.token from ms.channel.connect and stores it in token_file. Home Assistant saves the token when remote.token changes, uses TIMEOUT_REQUEST=31 s with the comment 'waiting for auth popup is just an open socket', and TIMEOUT_WEBSOCKET=5. The token is tied to the name, so changing the name triggers a new popup. A 'Deny' may put the PC on the TV's blocked device list. Behaviour on this TV (TokenAuthSupport 'true') has not been observed.
- **Channel heartbeat, reconnect and power-state liveness** (inferred, medium; read=true write=false live=true): ws.ping() every 20 s and terminate if no pong arrives before the next tick; ws._socket.setKeepAlive(true,10000); reconnect with backoff from 1 s to 30 s with ±20% jitter; GET http://192.168.1.2:8001/api/v2/ device.PowerState every 5 s while a UI is visible (30 s when idle), and no reconnect attempts while the TV is not 'on'.
  - Python websockets, which samsungtvws async uses, pings every 20 s by default and HA keeps the remote open, which suggests the TV answers pings. This is not verified. Make it adaptive: send one ping after connect; if no pong within 5 s, turn off ping-based liveness and rely on REST PowerState plus TCP keepalive. PowerState in REST is live-tv (orchestrator observed 'on'). Local mock tested ping→pong and the reconnect path.
- **UPnP SOAP actions from Node (GetVolume/GetMute/SetVolume/ListPresets...)** (live-tv, high; read=true write=true live=false): fetch POST http://192.168.1.2:9197/upnp/control/RenderingControl1 with headers Content-Type: text/xml; charset="utf-8" and SOAPACTION: "urn:schemas-upnp-org:service:RenderingControl:1#GetVolume", a standard SOAP 1.1 envelope, and a regex response parser with entity decoding; faults are parsed from <errorCode>/<errorDescription> (HTTP 500).
  - The endpoint and GetVolume=4 were observed live by the orchestrator today; my helper was tested only against the mock. On the wire, undici keeps the case of custom header names (SOAPACTION, CALLBACK, NT, TIMEOUT) and lower-cases its own. Use AbortSignal.timeout(3000). REST quirk: /api/v2/applications/<id> without a trailing slash makes fetch reject with cause.code UND_ERR_SOCKET (reproduced on the mock), so always append '/'. Samsung sends some non-standard values (HA uses non_strict), so parse tolerantly. fast-xml-parser is not needed.
- **Live volume/mute push via GENA (SUBSCRIBE/NOTIFY) with automatic polling fallback** (source-code, medium; read=true write=false live=true): node:http request SUBSCRIBE /upnp/event/RenderingControl1 on 192.168.1.2:9197 with CALLBACK:<http://<pc-lan-ip>:<port>/gena/<secret>/rc>, NT:upnp:event, TIMEOUT:Second-300; renew at 80% with SID only; 412 means subscribe again; UNSUBSCRIBE on exit. Parse the entity-escaped XML inside LastChange. No NOTIFY within 5 s means 'blocked': poll GetVolume/GetMute every 1 s while a UI is visible.
  - HA samsungtv subscribes to the Samsung DMR this same way (local IP towards the TV, port 0) and falls back to polling ('Device rejected subscription... variables will be polled'). async_upnp_client buffers NOTIFYs with an unknown SID because some devices send them before the SUBSCRIBE response. node:http parses NOTIFY/SUBSCRIBE/UNSUBSCRIBE. The PoC end-to-end test passed both 'live' and 'blocked→polling'. Not observed on this TV: whether NOTIFYs reach the PC through its firewall, and whether volume changes from the physical remote produce LastChange events.
- **Inbound connections (GENA callback, phone access) through Windows Defender Firewall without admin** (official-doc, high; read=true write=false live=false): Bind non-loopback listeners only when the user enables 'live events' or 'phone access' in the UI. Expect the one-time Windows Security Alert. Detect the result by whether the initial NOTIFY arrives, not by reading firewall rules.
  - Microsoft: an admin user is prompted (UAC); answering No or Cancel creates block rules (one TCP, one UDP) and the prompt never comes back. For a non-admin user, block rules are created whatever they click. Explicit block rules beat allow rules. The rule is per program, so allowing node.exe allows every Node script. Loopback binds never prompted in any of my tests. A rule scoped to the TV IP and port needs one elevated New-NetFirewallRule run and is overridden by any existing node.exe block rule.
- **Wake-on-LAN from Node dgram on Windows** (source-code, low; read=false write=true live=false): Create a udp4 socket, bind it to the LAN source address (port 0), then setBroadcast(true). Send the 102-byte magic packet (6x FF + 16x MAC) to the subnet's directed broadcast and to 255.255.255.255, on UDP ports 9 and 7, 3 rounds. Then poll GET /api/v2/ every 1 s for up to 20 s for PowerState 'on'.
  - Verified on loopback only: setBroadcast before bind throws EBADF, and the packet format round-trips. pywakeonlan defaults to 255.255.255.255:9 with SO_BROADCAST. On Windows, limited broadcast leaves only through the interface chosen by the route table, so bind to the LAN address and use the directed broadcast. Unicast needs an ARP entry, which fails while the TV is asleep. MAC: REST device.wifiMac (HA mac_from_device_info); persist it and keep it out of logs. Samsung WoWLAN requires the TV setting Power On with Mobile, and Samsung's SDK says the TV registers the sender's MAC after one successful connection. Not observed on this TV, and not sent (research rules).
- **Local web server: static UI + JSON commands + live state push to browsers** (source-code, high; read=true write=true live=true): node:http on 127.0.0.1:<fixed port> plus ws WebSocketServer({noServer:true}) at /ws. Host allowlist (otherwise 421), Origin allowlist (otherwise 403), POST-only commands that need Content-Type application/json and an X-TVR-CSRF header (token in a <meta> tag of index.html), no CORS headers. The /ws upgrade checks Host, Origin and the session cookie.
  - Tested locally: POST without CSRF → 403, foreign Origin → 403, DNS-rebinding Host → 421, WS evil origin → 403, no cookie → 401. SSE also works (stream survived past a 2 s requestTimeout), but over HTTP/1.1 each SSE tab uses one of the 6 per-host connections (MDN), so WebSocket is preferred. Serve static files from a preloaded in-memory map so URL paths are never joined onto the disk (no ..%5c traversal or ::$DATA on Windows). Chrome 142+ Local Network Access prompts are a bonus, not a safeguard. Bind '127.0.0.1', not 'localhost': a second instance could still bind ::1 on the same port (verified).
- **Phone/LAN access with pairing** (official-doc, medium; read=true write=true live=true): Opt-in: listen on the LAN address (triggers the firewall prompt). The loopback UI shows a 6-digit PIN (120 s, single use) and a QR code for http://<lan-ip>:<port>/pair. POST /api/pair sets cookie tvr_sess (32 random bytes; HttpOnly; SameSite=Strict; Path=/; long Max-Age). Store its sha256 hash with a label and last-seen time, and make it revocable. Rate-limit PIN attempts.
  - Plain http on a LAN IP is not a secure context (MDN), so phones get no service worker, PWA install or Wake Lock, only a home-screen bookmark. Cookies travel in clear text on the LAN, which is acceptable at home but should be documented.
- **Start hidden at user logon without admin** (official-doc, high; read=false write=false live=false): Shortcut in the per-user Startup folder → %WINDIR%/System32/wscript.exe //B //Nologo "%LOCALAPPDATA%/TvRemote/app/bin/launch.js". The JScript launcher calls WScript.Shell.Run('"node.exe" "supervisor.js"', 0, false). Alternatives: an HKCU Run value, or a per-user Task Scheduler task (interactive token, RunLevel Limited).
  - Verified locally: node and its conhost windows both report IsWindowVisible=False, and no Windows Terminal or OpenConsole process was spawned. Caveat: this session was elevated. Microsoft docs say a non-admin may register a task for their own account with the interactive logon type and LUA run level. 'schtasks /sc onlogon' from a limited token is reported to fail with Access denied (community). Avoid: VBScript (.vbs is off by default around 2027), conhost --headless (flagged by EDR detection rules), PowerShell -WindowStyle Hidden (window flash), a minimised shortcut (leaves a Windows Terminal tab). Fallback: a pythonw.exe launcher with CREATE_NO_WINDOW.
- **Single instance, supervisor/graceful restart, log rotation** (official-doc, high; read=false write=false live=false): Port lock (EADDRINUSE → GET /api/health → {app:'tv-remote',pid} → exit 0). supervisor.js uses child_process.fork('server.js') with IPC: exit 0 means stop, 75 means restart now, anything else restarts with 1→60 s backoff. Graceful shutdown over IPC: UNSUBSCRIBE GENA, close the 8002 socket with 1000, close servers, hard exit after 5 s. Logs: end stream, rename the .1-.5 chain, reopen.
  - Node docs: SIGTERM cannot be delivered on Windows; process.kill is an unconditional terminate; SIGHUP fires on console close with about 10 s grace. So use IPC or HTTP for graceful stop. Verified: second bind on 127.0.0.1 → EADDRINUSE; ::1 on the same port succeeds. Renaming an open log file succeeds but writes keep going to the renamed file, so the stream must be reopened. Renaming onto a target that another handle holds open fails with EPERM.
- **Installable PWA / app window on the PC** (official-doc, high; read=false write=false live=false): manifest.webmanifest (name, short_name, start_url '/', scope '/', display 'standalone', display_override ['window-controls-overlay','standalone'], 192 and 512 PNG icons plus a maskable one) and sw.js (versioned app-shell cache; /api and /ws network-only), served from http://127.0.0.1:<fixed port>. Quick alternative: msedge.exe --app=http://127.0.0.1:<port>/
  - 127.0.0.0/8 and localhost count as secure contexts (MDN), so the service worker and install work without HTTPS. Install criteria per web.dev. The PWA's identity is its origin, so keep the port fixed. PNG icons can be rendered from an SVG with the CDP screenshot tool, so no image libraries are needed.
- **Secrets and config storage** (community, medium; read=true write=true live=false): %LOCALAPPDATA%/TvRemote/config.json, outside the app and public folders. Atomic write: write tmp, then renameSync, retrying on EPERM/EBUSY/EACCES. Optional DPAPI (CurrentUser) through powershell.exe [Security.Cryptography.ProtectedData] for the SmartThings token. Never send secrets to the browser and redact them in logs.
  - Verified locally: rename over an existing file works; rename while the target is held open → EPERM; DPAPI round-trip works (about 1.9 s for 2 PowerShell calls, so decrypt once at startup). SmartThings personal access tokens created after 2024-12-30 expire after 24 h (community/staff). Use OAuth (an API_ONLY app made with the CLI): access token 24 h, refresh token 29 days. Every refresh-token rotation must be persisted atomically.
- **Offline mock Samsung TV for end-to-end tests** (source-code, high; read=true write=true live=true): poc/mock-tv.mjs on 127.0.0.1 only: REST /api/v2/ (PowerState; app URL without slash → socket.destroy), wss with a self-signed CN=SmartViewSDK cert (zero-dependency RFC 6455 server, token issuance, key effects), DMR SOAP (GetVolume/GetMute/SetVolume, UPnP fault 401), GENA (SID, Second-300, initial SEQ 0, renewal 412, dropNotify mode to mimic the firewall). The host code takes TV endpoints from config.
  - poc/e2e.mjs: 13/13 PASS (token captured, initial event, CSRF/Origin/Host rejections, KEY_VOLUP → GENA → SSE → browser, blocked-NOTIFY → polling, REST quirk, SOAP fault). Still to add: Allow-popup delay and unauthorized, standby, SEQ gaps, no-pong mode, cert rotation. Run with the built-in node --test.
- **Headless UI screenshots without Playwright** (source-code, high; read=true write=false live=false): cdp-shot.mjs: spawn system Edge (--headless=new --remote-debugging-port=0 --user-data-dir=<private dir>); read the DevToolsActivePort file; /json/list; connect with Node's global WebSocket; Emulation.setDeviceMetricsOverride, Page.navigate, wait for loadEventFired, Page.captureScreenshot; quit with Browser.close via /json/version.
  - Verified locally: Edge 155, about 2.9 s per shot. Gotcha: edge.kill() does not end the browser because msedge relaunches itself (the --do-not-de-elevate seen here comes from the elevated session), so use Browser.close. 'msedge --headless=new --screenshot=... --virtual-time-budget=1500' from Node's spawnSync returned exit 0 after 0.5 s and wrote the PNG about 1-3 s later, so poll for the file. Running it from Git Bash failed with exit 2. Chrome 139 is also installed.

## Protocol details

# Host runtime: engineering notes (Windows 11 26200, Node 22.18.0, undici 6.21.2, OpenSSL 3.0.16, ws 8.22.0)

**About evidence tags.** Items tagged `source-code` were also run on this PC against loopback mocks. Nothing contacted the TV. The scratch files are in `C:/Users/pranj/AppData/Local/Temp/tvremote-research/host-runtime/`; the main proof of concept is in `poc/` (mock-tv.mjs, host-poc.mjs, e2e.mjs, 13/13 PASS).

**Elevation caveat.** This Claude session ran at High integrity (elevated). The real app will run non-elevated at logon. Two things behave differently when non-elevated: Edge's de-elevation relaunch, and the UAC step behind the firewall prompt. The launcher and screenshot checks should be re-run once without elevation.

---
## 1. wss://192.168.1.2:8002 client (recommended: npm `ws`)
```js
import WebSocket from 'ws';
const NAME = 'TV Web Remote';                       // NEVER change: the TV binds the token to this name
const q = new URLSearchParams({ name: Buffer.from(NAME).toString('base64') });
if (cfg.tv.token) q.set('token', cfg.tv.token);
const ws = new WebSocket(`wss://192.168.1.2:8002/api/v2/channels/samsung.remote.control?${q}`, {
  rejectUnauthorized: false,    // self-signed TV cert (CN=SmartViewSDK or 'Samsung SmartViewSDK Cert. G2', no SAN)
  perMessageDeflate: false,
  handshakeTimeout: 10000,
  // servername: leave unset. ws sets '' for IP hosts (lib/websocket.js:1100-1101) -> no SNI, no DEP0123 warning
  // Escape hatch if the TV's TLS stack is old (per connection only): ciphers: 'DEFAULT@SECLEVEL=0', minVersion: 'TLSv1.2'
});
ws.on('upgrade', (res) => {               // TOFU pin; checkServerIdentity is NOT called when rejectUnauthorized:false
  const fp = res.socket.getPeerCertificate().fingerprint256;
  if (cfg.tv.certFp && fp !== cfg.tv.certFp) { ws.terminate(); ui.ask('TV certificate changed - trust?', fp); }
  else if (!cfg.tv.certFp) saveConfig({ tv: { certFp: fp } });
});
const firstMsg = setTimeout(() => ws.terminate(), cfg.tv.token ? 10000 : 35000); // Allow popup (HA waits 31 s)
ws.on('message', (buf) => {
  const m = JSON.parse(buf.toString());
  if (m.event === 'ms.channel.connect') { clearTimeout(firstMsg); if (m.data?.token && m.data.token !== cfg.tv.token) saveConfig({ tv: { token: m.data.token } }); ready = true; }
  else if (m.event === 'ms.channel.unauthorized') { stopRetrying('Denied on TV - remove the PC from Device Connection Manager / accept the popup'); }
  else bus.emit('tv-event', m);   // ms.channel.clientConnect, ms.remote.imeStart, ed.installedApp.get, ms.error ...
});
// Key: (samsungtvws remote.py) Cmd = Click | Press | Release
ws.send(JSON.stringify({ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: 'KEY_VOLUP', Option: 'false', TypeOfRemote: 'SendRemoteKey' } }));
```
- **Hold-to-repeat.** Browser pointerdown sends `Press`. Pointerup, pointercancel, a blur, or a dropped WebSocket sends `Release`. A server watchdog also sends `Release` after 3-5 s so a key can never stick on the TV.
- **Heartbeat.** Call `ws.ping()` every 20 s. If no pong arrives before the next tick, terminate and reconnect. Also set `ws._socket.setKeepAlive(true, 10000)`.
- **Adaptive heartbeat.** Send one ping after connecting. If no pong arrives within 5 s, turn off ping-based liveness and rely on REST `GET http://192.168.1.2:8001/api/v2/` → `device.PowerState`. Poll it every 5 s while a UI is visible and every 30 s otherwise.
- **Reconnect.** Back off from 1 s to 30 s with ±20% jitter and reset the backoff on `ms.channel.connect`. Don't reconnect while PowerState is not `on` or the TV is unreachable. Keep exactly one channel instance.
- **Why `ca` pinning is avoided.** Pinning with `ca: <TV PEM>` plus `checkServerIdentity: () => undefined` also works locally. It fails once the TV cert expires or rotates (openHAB users report odd or expired TV certs). The fingerprint pin with a re-trust screen is sturdier.

**Node global WebSocket alternative (works, not recommended):**
```js
await fetch('data:,');
const Agent = globalThis[Symbol.for('undici.globalDispatcher.1')].constructor; // internal symbol; or npm undici
new WebSocket(url, { dispatcher: new Agent({ connect: { rejectUnauthorized: false } }), headers: { 'User-Agent': 'TVRemote' } });
```
What I saw locally:
- A default `fetch` to the same server still failed with DEPTH_ZERO_SELF_SIGNED_CERT, so TLS was not weakened for the rest of the process.
- On a TLS failure the ErrorEvent message is only "Received network error or non-101 status code", with no code. No close event fired and readyState stayed 0.
- `ws.close()` inside onerror re-fires error synchronously. That recursed until "Maximum call stack size exceeded".
- It auto-pongs but has no `ping()`.
- It sends `user-agent: node`, `sec-fetch-mode: websocket` and a permessage-deflate offer.

## 2. UPnP SOAP and GENA without XML libraries
**SOAP request:**
```
POST /upnp/control/RenderingControl1 HTTP/1.1      (192.168.1.2:9197)
Content-Type: text/xml; charset="utf-8"
SOAPACTION: "urn:schemas-upnp-org:service:RenderingControl:1#GetVolume"

<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetVolume></s:Body></s:Envelope>
```
- **Response parsing:**
  - Capture the body of `/<(?:[\w-]+:)?GetVolumeResponse\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?GetVolumeResponse>/`.
  - Read its arguments with `/<([\w-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g`.
  - Decode entities: `&lt; &gt; &quot; &apos; &amp; &#N; &#xH;`.
- **Faults** come back as HTTP 500 with `<errorCode>` and `<errorDescription>`.
- **Request options.** Use `AbortSignal.timeout(3000)`. Retry once on UND_ERR_SOCKET, because the TV may drop idle keep-alive sockets (inferred).
- **Header case on the wire.** undici kept SOAPACTION, CALLBACK, NT and TIMEOUT uppercase and lower-cased its own headers. Tested with a raw socket.
- **REST quirk.** A REST app URL without the trailing slash makes fetch reject with `TypeError: fetch failed`, `cause.code === 'UND_ERR_SOCKET'`. Always send `/api/v2/applications/<id>/`.
- **LastChange parsing.** Take the text of `<LastChange>`, decode the entities, then match `/<([\w-]+)((?:\s+[\w:-]+="[^"]*")*)\s*\/?>/g`. For each match, collect `val` keyed by `channel`. Result: `{Volume:{Master:'7'}, Mute:{Master:'0'}}`.

**GENA subscription:**
```
SUBSCRIBE /upnp/event/RenderingControl1 HTTP/1.1
HOST: 192.168.1.2:9197
CALLBACK: <http://<pc-lan-ip>:8791/gena/<32-hex-secret>/rc>
NT: upnp:event
TIMEOUT: Second-300
-> 200, SID: uuid:..., TIMEOUT: Second-N
renew at 0.8*N:  SUBSCRIBE + SID + TIMEOUT only (no NT/CALLBACK); 412 => new SUBSCRIBE
exit:            UNSUBSCRIBE + SID
NOTIFY in:       NT: upnp:event, NTS: upnp:propchange, SID, SEQ (0 first) -> reply 200 immediately
```
- **HTTP client.** Use `node:http` `request({method:'SUBSCRIBE', headers:{HOST:...}})`. It keeps header case and lets you set HOST. fetch also accepts `method:'SUBSCRIBE'`.
- **HTTP server.** `node:http` servers parse NOTIFY, SUBSCRIBE and UNSUBSCRIBE (tested).
- **Callback address.** `net.connect(9197,'192.168.1.2')` → `socket.localAddress`. HA does the same with async_get_local_ip. Cache it so it's available when the TV is off.
- **Listener.** If the UI is loopback-only, run a separate listener on that LAN address and a fixed port. It accepts only NOTIFY from remoteAddress 192.168.1.2 on the secret path; everything else gets 403.
- **Early NOTIFYs.** If a NOTIFY arrives with no SID yet while a SUBSCRIBE is in flight, buffer it. async_upnp_client keeps a backlog because some devices notify before the SUBSCRIBE response.
- **SEQ gaps.** On a gap, resync with GetVolume and GetMute.
- **Blocked detection.** UPnP requires an initial event right after a subscription. If no NOTIFY arrives within 5 s, set `events='blocked'` and poll GetVolume and GetMute. Poll every 1 s while a UI is visible, every 5 s otherwise, and stop when the TV is in standby.
- **Safety-net poll.** Even when events are live, poll every 30 s.
- **UI status chip:** "Live" vs "Polling (firewall)".

## 3. Firewall behaviour (Microsoft Learn: windows-firewall/rules)
- The first non-loopback listen with no existing rule raises a prompt.
- **Admin user:** prompted, with a UAC step. No or Cancel creates block rules (TCP and UDP), and the prompt never returns.
- **Non-admin user:** block rules are created whatever they click.
- **Rule precedence:** explicit block rules beat allow rules.
- **Scope:** the rule covers the whole program, so it applies to every script run by `C:\Program Files\nodejs\node.exe`.
- **Loopback:** binding loopback never prompts.
- **Design: no surprise binds.** Never bind a non-loopback address implicitly. Show an "Enable live updates / phone access" button that explains the dialog first.
- **Optional tighter rule.** A one-time elevated helper (UAC) can add a narrow rule:
  `New-NetFirewallRule -DisplayName 'TV Remote events' -Direction Inbound -Action Allow -Program 'C:\Program Files\nodejs\node.exe' -Protocol TCP -LocalPort 8791 -RemoteAddress 192.168.1.2 -Profile Private`
  It has no effect if a node.exe block rule already exists.

## 4. Wake-on-LAN
```js
import dgram from 'node:dgram';
const magic = (mac) => { const m = Buffer.from(mac.replace(/[^0-9a-f]/gi, ''), 'hex'); return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(m)]); }; // 102 B
export async function wake(mac, lanAddr, directedBcast) {   // directedBcast = addr | ~netmask from os.networkInterfaces() entry == lanAddr
  const s = dgram.createSocket('udp4');
  await new Promise((r) => s.bind({ address: lanAddr, port: 0 }, r));  // pins the LAN NIC (VPN/virtual adapters can win otherwise)
  s.setBroadcast(true);                                                // EBADF if called before bind (verified)
  const pkt = magic(mac);
  for (let i = 0; i < 3; i++) for (const [h, p] of [[directedBcast, 9], ['255.255.255.255', 9], [directedBcast, 7]]) await new Promise((r) => s.send(pkt, p, h, r));
  s.close();
}
```
- **Why bind and use directed broadcast.** On Windows, 255.255.255.255 leaves only through the interface the route table picks. Unicast to 192.168.1.2 needs a live ARP entry, which fails while the TV is asleep.
- **MAC source.** `GET /api/v2/` → `device.wifiMac`. Save it while the TV is on and never log it.
- **After sending,** poll REST every 1 s for up to 20 s.
- **TV-side requirements.** The TV needs the setting Power On with Mobile. Samsung's Smart View SDK says the TV registers the sender's MAC after one successful connection.
- **Unverified.** Whether the UDP bind can itself trigger the firewall prompt (inferred: possible).

## 5. Web server design
- **Binding and port.** Bind `127.0.0.1` on a fixed configurable port, e.g. 8790. Don't use 'localhost': a second instance could still bind ::1 on the same port (verified).
- **Host allowlist.** Accept only `127.0.0.1:P`, `localhost:P` and `[::1]:P`; in LAN mode also `<lan-ip>:P` and `<hostname>:P`. Anything else gets 421. This blocks DNS rebinding (cf. Vite GHSA-vg6x-rcgg-rjx6).
- **Origin and CSRF.** If an Origin header is present, it must be `http://<allowed host>`.
  - Commands are POST only, need `Content-Type: application/json`, and need an `X-TVR-CSRF` header. The per-process random token sits in `<meta name="tvr-csrf">` of index.html.
  - Never send CORS headers. GET never changes state.
- **Browser channel.** Use a `ws` WebSocketServer with `{noServer:true, maxPayload:65536}` at `/ws`.
  - Do the upgrade checks by hand: Host, then Origin, then the session cookie, otherwise `HTTP/1.1 4xx` and end the socket. This blocks cross-site WebSocket hijacking.
  - Tested: evil origin → 403, no cookie → 401, rebinding Host → 421.
  - Messages: server→client `{type:'state', ...}` with per-field provenance (`source: live|polled|estimated|unknown`, `at`); client→server `{type:'key', key, cmd}`, `{type:'visible', v}`.
- **SSE fallback.** SSE is a zero-dependency fallback (tested). The catch: over HTTP/1.1 each SSE tab uses one of the browser's 6 connections per host, the same pool commands need (MDN).
- **Static files.** Preload `public/` into a `Map` at startup and serve exact keys only. URL paths are never joined onto the disk, so there is no `..%5c` traversal or `::$DATA` stream trick.
  - Headers: CSP `default-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'`.
- **Sessions.** Loopback clients get a session automatically only if `req.socket.remoteAddress` is loopback and the Host is loopback.
- **LAN pairing.** A 6-digit PIN (120 s, single use) and a QR code. `POST /api/pair` → `Set-Cookie: tvr_sess=<32B b64url>; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` (no `Secure` over http).
  - Store sha256(session) with a label and last-seen time.
  - Allow 5 PIN tries per 5 min per IP, and lock out globally after 20 failures.
- **Chrome Local Network Access.** Chrome 142+ asks before public sites can reach localhost. That's extra cover, not a safeguard.

## 6. Hosting at logon without admin
`%LOCALAPPDATA%\TvRemote\app\bin\launch.js` (JScript; verified hidden: node and conhost both IsWindowVisible=False, no Windows Terminal handoff):
```js
var sh = new ActiveXObject("WScript.Shell"), fso = new ActiveXObject("Scripting.FileSystemObject");
var app = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName));
sh.CurrentDirectory = app;
sh.Run('"' + sh.ExpandEnvironmentStrings("%ProgramFiles%") + '\\nodejs\\node.exe" "' + app + '\\src\\supervisor.js"', 0, false);
```
**Install script (per user, no admin):**
```powershell
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'TV Remote.lnk'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = "$env:WINDIR\System32\wscript.exe"
$s.Arguments = '//B //Nologo "' + "$env:LOCALAPPDATA\TvRemote\app\bin\launch.js" + '"'
$s.WorkingDirectory = "$env:LOCALAPPDATA\TvRemote\app"; $s.Save()
```
- **Alternative 1, HKCU Run value:** `Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' TVRemote 'wscript.exe //B //Nologo "...\launch.js"'`
- **Alternative 2, Task Scheduler.** Microsoft's docs allow a non-admin to register a task for their own account with an interactive token and RunLevel Limited. Not yet tested non-elevated. Its advantage is automatic restart on failure.
  ```
  Register-ScheduledTask -TaskName TVRemote
    -Action (New-ScheduledTaskAction -Execute wscript.exe -Argument '//B //Nologo "...\launch.js"')
    -Trigger (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME")
    -Principal (New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited)
    -Settings (New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0)
  ```
  Community reports say `schtasks /create /sc onlogon` from a limited token fails with Access denied.
- **Avoid:**
  - .vbs launchers: VBScript will be off by default around 2027.
  - `conhost --headless`: it matches EDR detection rules and can still flash a window.
  - `powershell -WindowStyle Hidden`: flashes a window.
  - A shortcut set to Minimized: leaves a Windows Terminal tab.
- **Fallback launcher:** `pythonw.exe` (Python 3.13 is installed) with `subprocess.Popen([...], creationflags=0x08000000)`.

**Supervisor (launch.js → supervisor.js → `fork('server.js')` with IPC):**
- **Exit codes:**
  - 0: stop.
  - 75: restart now (UI Restart button or config change).
  - Anything else: restart with backoff of 1, 2, 4 … 60 s, reset after 5 min healthy.
- **Graceful stop.** Send `{cmd:'shutdown'}` over IPC. The server unsubscribes GENA, closes the 8002 socket with 1000, closes its servers, flushes the log and exits; hard kill after 5 s.
- **Windows signals.** Node docs: SIGTERM cannot be delivered on Windows; `process.kill` terminates unconditionally; SIGHUP fires on console close with about 10 s grace.

**Single instance:**
- The port is the lock. On `EADDRINUSE`, call `GET http://127.0.0.1:P/api/health` → `{app:'tv-remote', pid}`. If it's ours, exit 0; otherwise report the port clash.
- Also write `%LOCALAPPDATA%\TvRemote\run\server.json` with `{pid, port, startedAt}`.

**Logs:**
- Write to `%LOCALAPPDATA%\TvRemote\logs\server.log`. Rotate at 1 MB and keep 5.
- To rotate: `stream.end()` → unlink `.5` → rename `.4`→`.5` … `server.log`→`.1` → reopen.
- Verified: renaming an open log file works, but writes keep going into the renamed file. Renaming onto a target another process holds open fails with EPERM.

**PWA:**
- `http://127.0.0.1:P` is a secure context, so the manifest and service worker work.
- Manifest: `{"name":"TV Remote","short_name":"Remote","start_url":"/","scope":"/","display":"standalone","display_override":["window-controls-overlay","standalone"],"background_color":"#0b0d10","theme_color":"#0b0d10","icons":[{"src":"/icons/192.png","sizes":"192x192","type":"image/png"},{"src":"/icons/512.png","sizes":"512x512","type":"image/png"},{"src":"/icons/maskable-512.png","sizes":"512x512","type":"image/png","purpose":"maskable"}]}`
- Service worker: versioned cache-first app shell; `/api` and `/ws` network-only.
- Install from Edge's "Install this site as an app", or open `msedge --app=http://127.0.0.1:P/`.
- Keep the port fixed: the PWA's identity is its origin.

## 7. Testing without the TV
**Mock TV (`poc/mock-tv.mjs`), all on 127.0.0.1:**
- **REST on :18001** (`PowerState`, app URL without slash → `socket.destroy()`).
- **wss on :18002:**
  - Self-signed CN=SmartViewSDK cert; zero-dependency RFC 6455 server in `mini-ws-server.mjs`.
  - `data.token` is returned only when the caller's token differs from the issued one.
  - KEY_VOLUP, KEY_VOLDOWN and KEY_MUTE change state and trigger GENA.
- **DMR on :19197:**
  - SOAP GetVolume, GetMute and SetVolume, plus UPnP fault 401.
  - GENA: SID, Second-300, initial SEQ 0 sent 50 ms after the 200, SEQ++, renewal 412.
  - A `setDropNotify(true)` switch mimics the firewall.
- **To add:** Allow-popup delay and `ms.channel.unauthorized`, standby mode, SEQ gaps, no-pong mode, cert rotation.
- **Wiring:** the host reads TV endpoints from config, so production code runs against the mock unchanged. Use the built-in `node --test`.

**e2e.mjs results (13/13 PASS):**
- Callback address detected.
- Token issued and captured.
- Initial GENA event: volume=4.
- POST without CSRF → 403.
- Foreign Origin → 403.
- Rebinding Host → 421.
- KEY_VOLUP pushed through GENA and SSE to the browser: volume 5. The stream was alive after 4 s with requestTimeout set to 2 s.
- Dropped NOTIFY → marked blocked and polling started.
- Volume 6 delivered by polling.
- REST PowerState read.
- Slashless app URL → UND_ERR_SOCKET.
- SOAP fault → errorCode 401.

**Screenshots (`cdp-shot.mjs`, about 2.9 s, no installs):**
- Spawn `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe --headless=new --disable-gpu --no-first-run --user-data-dir=<dir under the project temp> --remote-debugging-port=0 --window-size=W,H about:blank`.
- Read `<profile>/DevToolsActivePort` → `GET /json/list` → page `webSocketDebuggerUrl`. Connect with the global WebSocket.
- Run `Page.enable`, `Emulation.setDeviceMetricsOverride`, `Page.navigate`, wait for `Page.loadEventFired` plus a settle delay, then `Page.captureScreenshot`.
- Close with `Browser.close` over `/json/version` `webSocketDebuggerUrl`. `child.kill()` leaves Edge running because Edge relaunches itself.
- `msedge --screenshot=... --virtual-time-budget=1500` also works, but from an elevated parent it returned after 0.5 s and wrote the PNG 1-3 s later, so poll for the file. Run from Git Bash it failed with exit 2.
- Chrome 139 is at `C:/Program Files/Google/Chrome/Application/chrome.exe`.

## 8. Dependencies, layout, secrets
**Runtime dependency:** `ws@^8.18` only (8.22.0 checked: `dependencies:{}`; bufferutil and utf-8-validate are optional peers). No express, fast-xml-parser (it pulls in `strnum`), undici package or Playwright.

**Layout:**
```
tv-remote/ package.json {"type":"module","engines":{"node":">=22"},"dependencies":{"ws":"^8.18.0"},"scripts":{"test":"node --test"}}
  bin/launch.js  bin/install-startup.ps1  bin/uninstall-startup.ps1
  src/supervisor.js src/server.js src/config.js src/log.js
  src/web/http.js (security, static map, REST)  src/web/live.js (ws browser channel, pairing)
  src/tv/rest.js src/tv/channel.js src/tv/upnp.js src/tv/gena.js src/tv/wol.js src/tv/state.js (state + provenance)
  public/ index.html app.js styles.css manifest.webmanifest sw.js icons/
  test/mock-tv/*.js test/*.test.js tools/cdp-shot.js
```

**Config:**
- Location: `%LOCALAPPDATA%\TvRemote\config.json`, outside `app/` and `public/`. It inherits the profile ACL (user, SYSTEM, Administrators).
- Shape: `{tv:{host,port8001,port8002,dmrPort,mac,token,certFp,clientName,lanAddr,directedBcast}, server:{port:8790, lan:false, genaPort:8791}, sessions:[{hash,label,lastSeen}], smartthings:{clientId, refreshTokenDpapi, accessTokenDpapi, expiresAt}}`.
- Atomic write: write a tmp file, then `renameSync`, retrying 5x with backoff on EPERM, EBUSY or EACCES. EPERM was verified when another handle held the target open.

**Secrets:**
- Optional DPAPI (verified round-trip; about 1 s per PowerShell call, so decrypt once at startup):
  `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,'CurrentUser'))`. Pass the secret through stdin, never argv.
- SmartThings personal access tokens created after 2024-12-30 last 24 h. Use OAuth from an API_ONLY app instead: access token 24 h, refresh token 29 days. Persist every refresh-token rotation atomically.
- Never send secrets to the browser. Redact the token, MAC and SID in logs.

## Risks

- 8002 TLS handshake from Node 22 / OpenSSL 3.0.16 is unverified against this TV. An old cipher, TLS version or key could fail even with rejectUnauthorized:false. The fallback is a per-connection ciphers:'DEFAULT@SECLEVEL=0' or minVersion setting, never NODE_TLS_REJECT_UNAUTHORIZED=0.
- Windows Firewall: a cancelled prompt, or any prompt answered by a non-admin, creates permanent node.exe inbound block rules. Block rules beat allow rules, and removing them needs admin. GENA events and phone access would then stay dead, and the app must run on polling indefinitely.
- Allowing node.exe through the firewall applies to every Node script on the PC, which widens the attack surface. A narrow rule for one port and the TV's IP needs a single elevated setup step.
- The TV may not send RenderingControl LastChange NOTIFYs for volume changed with the physical remote or by apps (only for DMR sessions). Live volume would then rely on 1 s polling while a UI is visible, which must stay gentle on the TV.
- The first 8002 connection shows an Allow/Deny popup on the TV while someone may be watching. 'Deny' can blacklist the PC in Device Connection Manager. Changing the client name, or the TV's Access Notification set to 'Always', re-prompts.
- Wake-on-LAN may not work: Wi-Fi deep standby, Power On with Mobile switched off, the PC's MAC not yet registered by the TV, limited broadcast leaving via a VPN or virtual adapter, or a firewall prompt triggered by the UDP bind.
- The global-WebSocket route depends on the internal symbol Symbol.for('undici.globalDispatcher.1') and showed broken error handling (stack-overflow recursion, no close event). Using it risks silent failures after a Node update.
- The hidden launcher depends on Windows Script Host (JScript). Group Policy or EDR can disable or flag it. VBScript is being retired; JScript is not announced as retired (inferred). Fallbacks: pythonw, or a Task Scheduler task.
- All local experiments ran in an elevated (High integrity) session. Behaviour when non-elevated at logon may differ, for example Edge's relaunch and the UAC step in the firewall prompt.
- Plain-HTTP LAN access sends session cookies in clear text. A 6-digit PIN needs strict rate limiting. Phones get no PWA, service worker or Wake Lock because the origin is not a secure context.
- SSE over HTTP/1.1 uses one of the browser's 6 connections per host per tab and can starve command POSTs with many tabs open, so a WebSocket browser channel is preferred.
- The PWA's identity is tied to http://127.0.0.1:<port>. Changing the port orphans the installed app and its storage, and another program may already be using the chosen port.
- Antivirus or indexers holding config.json open cause EPERM on atomic rename, so the retry loop is mandatory. Refresh-token rotations (SmartThings) are lost if a write fails.

## Open questions

- Does 192.168.1.2:8002 complete a TLS handshake with Node 22.18 (OpenSSL 3.0.16) default settings, and what is its certificate (CN, issuer, expiry, key size, signature algorithm, TLS version, cipher)? An agent with live permission could check with tls.connect plus getPeerCertificate and no HTTP upgrade, or with a read-only GET https://192.168.1.2:8002/api/v2/; no WebSocket is needed.
- Does this TV answer WebSocket ping frames on the 8002 channel, and does it send any periodic events itself?
- After SUBSCRIBE to /upnp/event/RenderingControl1, does the TV send the initial NOTIFY (SEQ 0) with Volume and Mute in LastChange, and does it send NOTIFYs when volume changes through the physical remote or KEY_VOL* keys? What TIMEOUT does it grant?
- Is there already a Windows Firewall rule for C:/Program Files/nodejs/node.exe on this PC, and is the home network set to Private? The user can check (e.g. Get-NetFirewallApplicationFilter -Program ... | Get-NetFirewallRule). I did not inspect it, per the rules.
- Is the TV on Ethernet or Wi-Fi, and is 'Power On with Mobile' enabled? Does a magic packet from this PC wake it (only after at least one successful 8002 pairing)?
- TV setting Device Connection Manager > Access Notification: is it 'First Time Only' (token reuse works) or 'Always' (prompt on every connect)?
- Should phone/LAN access be in v1, given it requires the firewall prompt? Or should v1 stay loopback-only, with events falling back to polling?
- Does Register-ScheduledTask with an AtLogOn trigger for the current user succeed from a non-elevated PowerShell on this PC, or should the Startup-folder shortcut be the only install path?
- For SmartThings OAuth (API_ONLY app): is a http://127.0.0.1 redirect URI accepted, or is an https redirect required? This affects how the local server completes the auth code flow.
