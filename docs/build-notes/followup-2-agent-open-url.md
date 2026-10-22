# Build notes: follow-up 2, Part C — role `agent-open-url`

Spec §11.3 "Open on TV": the TV agent gains request `open-url { url }`; the server adapter forwards it. Files owned: `companion/agent/**`, `server/adapters/agent.js`. Nothing was built, signed or installed (the orchestrator does that); the real TV was never contacted.

## Files changed

| File | Change |
|---|---|
| `companion/agent/config.xml` | `version="0.3.0"` (was 0.2.0). Nothing else: `application.launch` was already granted, which is the privilege `launchAppControl` needs. |
| `companion/agent/agent.js` | Agent 0.3: request `open-url` (URL check → `view` app control → `org.tizen.browser` fallback, 3.5 s per attempt). Header comment updated. Still ES2017, line comments only. |
| `companion/agent/agent-config.example.json` | `"version": "0.3.0"` (documentation of the generated file; build.ps1 stamps the real value from config.xml). |
| `server/adapters/agent.js` | `REQUEST_TYPES` gains `'open-url'`; `request('open-url', { url })` rejects `INVALID` for anything but an http(s) URL (≤ 4096 chars) before looking at the connection. Header comment lists the new request. |
| `docs/build-notes/agent.md` | Updated for 0.3.0 and the new request. |

Not touched: `companion/agent/index.html`, `icon.png`, `agent-config.json` (generated; carries the key — never read), `tools/agent/*` (not mine; build.ps1 already derives the version from config.xml, so no change is needed there).

## Exports and signatures (unchanged shape)

`server/adapters/agent.js`

```js
export function createAgent({ config, data, log, store, lan, rest })
// → { start(), stop(): Promise<void>, setDemand() {}, launch(): Promise<{ value }>,
//     request(type, args?): Promise<{ value }>, getIcon(appId): Promise<{ type: 'image/png', buffer } | null> }
```

`request(type, args = {})`, in order of checks:

1. `type` ∉ `apps | icon | exit | open-url` → rejects `LumenError('INVALID', 'Unknown agent request "<type>"')`.
2. `type === 'open-url'` and `args.url` is not a string, is empty, is longer than 4096 characters, does not parse with `new URL`, or its protocol is not `http:`/`https:` → rejects `LumenError('INVALID', 'Open on TV needs an http(s) URL')`. This happens even when the agent is offline.
3. No agent socket open → rejects `LumenError('UNAVAILABLE', 'The TV agent is not connected')` (measured 0 ms).
4. Otherwise sends `{ t: 'req', rid: <uuid>, type: 'open-url', url }` (exactly those four keys) and:
   - `{ t:'reply', rid, ok:true, data }` → resolves `{ value: data }`, i.e. `{ value: { method: 'view' } }` or `{ value: { method: 'browser' } }`;
   - `{ ok:false, error }` → rejects `LumenError('FAILED', 'The TV agent could not do that: <error>')`;
   - no reply within 8 s → rejects `LumenError('FAILED', 'The TV agent did not answer in time')` (measured 8002 ms);
   - the agent disconnects first → rejects `LumenError('UNAVAILABLE', 'The TV agent disconnected')`.

For the hub (Part A): the brief's 10 s hub timeout never fires first, because the adapter settles every `open-url` within 8 s. Treat `UNAVAILABLE` and `FAILED` as "fall back to the REST browser launch"; `INVALID` means the URL itself is bad and should be shown, not retried over REST.

## Agent protocol (spec §5.5 + §11.3)

PC → agent: `{ t:'req', rid, type:'open-url', url }`.

Agent:

1. `url` must be a string ≤ 4096 chars that `new URL()` parses with protocol `http:` or `https:`; otherwise reply `{ t:'reply', rid, ok:false, error:'open-url needs an http(s) URL' }` without calling any TV API.
2. `tizen.application.launchAppControl(new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', url, null, null, []), null, ok, fail)`. Success → `{ ok:true, data:{ method:'view' } }`.
3. If that calls `fail`, throws synchronously, or does not answer within 3.5 s: the same control with the explicit app id `'org.tizen.browser'`. Success → `{ ok:true, data:{ method:'browser' } }`.
4. Both fail → `{ ok:false, error:'view: <msg>; org.tizen.browser: <msg>' }`, where `<msg>` is the WebAPIError's `message`, else its `name`, else `launch timed out`.

Worst case (both attempts hang) answers in ~7.0 s (measured 7007–7011 ms), inside the PC's 8 s request timeout. The agent stays connected and keeps reporting state throughout; `open-url` never makes it exit.

## Interpretations and deviations

1. **The adapter was not generic.** `request()` whitelists types (`REQUEST_TYPES`), so without a change `open-url` would have been rejected `INVALID`. Added the type; the message shape, rid handling and timeouts are shared with the other requests.
2. **URL validation on both sides.** Spec §11.3 says URLs are validated server-side and bans `javascript:` / `file:`. The adapter checks before sending (so a bad URL is `INVALID`, not a TV round-trip), and the agent checks again (defense in depth for anything that reaches the socket). Both use the same rule: string, ≤ 4096 chars, parses, `http:`/`https:`.
3. **Per-attempt timeout 3.5 s** in the agent (`LAUNCH_TIMEOUT_MS`). The spec gives none; two attempts have to fit under the adapter's 8 s, which in turn is under the hub's 10 s (Part A brief). A late success callback after the timeout is ignored (`settled` guard), so at worst the browser receives the same URL twice.
4. **`ApplicationControl(operation, uri, null, null, [])`** exactly as the brief; a `TypeMismatchError` or `SecurityError` thrown synchronously by the TV is caught and reported like a callback error. Tizen's `WebAPIException` is not an `instanceof Error`, so the message is read from `message || name` (the first e2e run caught `[object Object]` here and the fix is in).
5. **Reply on double failure** is one string `view: …; org.tizen.browser: …` so the Lumen UI can show why both routes failed. The adapter caps it at 200 chars (existing `str()`).
6. **Header comment** of agent.js now says "hands-off" rather than "read-only": the agent still never changes a TV setting; opening the browser is its only action.
7. `agent-config.example.json` version bumped for accuracy only; the real `agent-config.json` is rewritten by build.ps1 from config.xml.

## Known gaps / for the orchestrator and other parts

- **Build, sign and install 0.3.0** (`npm run agent:build`, then `tools/agent/install.sh`); not done here. Until then the installed 0.2.0 agent answers `open-url` with `ok:false, error:'unknown request: open-url'` → adapter `FAILED` → the hub should fall back to the REST browser launch; and the server shows `conn.agentNote` "Rebuild the TV agent: it runs 0.2.0, this server expects 0.3.0" (observed in the adapter scratch test).
- **Unverified on the Q95T** (no TV access): whether the generic `view` operation resolves to the Samsung browser or the fallback is what works; whether a hidden (background) agent is allowed to call `launchAppControl`; whether the browser opens the given URL from the app control `uri`. If the TV requires the data array form instead, only `launchView` in agent.js needs changing.
- `test/helpers.js` `connectAgent` defaults to `version = '0.2.0'` and answers unknown requests with `ok:false` (Part D's file). No current test asserts on `conn.agentNote`, and `connectAgent` is not called by any test today, but Part D may want `version = '0.3.0'` and an `open-url` branch replying `{ method: 'view' }` for the hub's `browser.openOnTv` test.
- `tools/dev-stack.mjs`, `tools/dev-ui.mjs` and `test/mock-tv.js` contain no fake agent request handler (grep for `type === 'apps'` / `'open-url'` found nothing), so the dev stack has no agent and `browser.openOnTv` there will take the REST fallback path.

## Verification performed (exact commands, observed results)

All on 127.0.0.1 with throwaway data dirs and keys; the real TV, sdb, the emulator and port 8790 were never touched; no npm install.

- `node --check server/adapters/agent.js` → ok.
- `node tools/scratch/agent/check-agent-syntax.mjs companion/agent/agent.js` → `new Function: ok`, `acorn ecmaVersion 2017 script: ok (acorn 8.18.0)`, `block comments: 0` (acorn read from `C:/Users/pranj/source/Pantheon/web/node_modules`, nothing installed). `grep -nE '\?\.|\?\?|\*/' companion/agent/agent.js` → no matches (no optional chaining, nullish coalescing or `*/`).
- `grep -n "0\.2\.0"` over config.xml, agent.js, agent-config.example.json, index.html, server/adapters/agent.js → no matches.
- `node tools/scratch/agent-open-url/adapter-open-url.mjs` (real `config.js`, `log.js`, `store.js`, `lan.js` + the adapter, a fake agent WS client) → **12 checks passed**:
  - offline `open-url` → `UNAVAILABLE` in 0 ms;
  - `javascript:`, `file:`, `ftp:`, `about:blank`, `example.com`, `https://`, `''`, `42`, `null`, `undefined`, a 5000-char URL and a missing `url` → `INVALID` "Open on TV needs an http(s) URL"; unknown types still `INVALID`;
  - online: the frame on the wire is `{ rid, t, type, url }` with the URL verbatim; `{ method:'view' }` and `{ method:'browser' }` replies come back as `{ value }`; `ok:false` → `FAILED` with the agent's text; a 0.3.0 hello leaves `conn.agentNote` null;
  - unanswered → `FAILED` "did not answer" after 8002 ms; disconnect mid-request → `UNAVAILABLE` and `conn.agent` offline;
  - a 0.2.0 agent → note `Rebuild the TV agent: it runs 0.2.0, this server expects 0.3.0`;
  - the key never appears in the log.
- `node tools/scratch/agent-open-url/page-e2e.mjs` — the real `companion/agent/agent.js` + `index.html` in headless Edge (`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`, `--headless=new`, DevTools on a random 127.0.0.1 port, `file://` + `--allow-file-access-from-files`, stubbed `tizen` whose `launchAppControl` is scripted). Phase 1 talks to the real lan listener + adapter, phase 2 to a raw `ws` server so requests the adapter would refuse still reach the page. Final run: **13 checks passed, exit 0, "headless Edge processes left from this run: 0"**:
  - hello as 0.3.0 in 158 ms, note null;
  - `open-url` → exactly one `launchAppControl` with `{ operation:'http://tizen.org/appcontrol/operation/view', uri:<url>, mime:null, category:null, data:[], appId:null }` → `{ value:{ method:'view' } }`;
  - view `fail` → second call with `appId:'org.tizen.browser'` → `{ method:'browser' }`;
  - both fail → `FAILED` "The TV agent could not do that: view: no handler for view; org.tizen.browser: browser missing";
  - a synchronous `{ name:'SecurityError' }` throw → `FAILED` "view: SecurityError; org.tizen.browser: SecurityError" (this case failed on the first run with `[object Object]`; fixed, re-run passed);
  - view hangs → fallback answers in 3528 ms; both hang → "launch timed out" twice in 7007 ms (< 8 s);
  - afterwards the agent is still online and answers again; `hide()` ≥ 1, `exit()` 0;
  - raw phase: hello `agent:'0.3.0'`; the reply is exactly `{ t:'reply', rid, ok:true, data:{ method:'view' } }`; the eleven bad URLs above are all answered `ok:false, error:'open-url needs an http(s) URL'` with no `launchAppControl` call; `reboot` → `ok:false, error:'unknown request: reboot'`.
  - An earlier run reported 1 leftover process because the count ran right after `Stop-Process`; a manual `Get-CimInstance` check seconds later showed 0, and the script now polls up to 5 s. A final `Get-CimInstance Win32_Process` count of `msedge.exe` after everything: 0.
- `node --test test/e2e.test.js test/integration.test.js` (the suites that load the full server stack with this adapter) → `tests 33, pass 33, fail 0`. The full `npm test` was left to Part D as the brief assigns it; three other builders were editing the hub, cast and browser files during this work.
