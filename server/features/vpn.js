// The VPN switch for the Browser view (follow-up 3): a user-space WireGuard tunnel inside the Lumen
// process (server/vpn/wireguard.js) exposed to the headless browser as a loopback HTTP proxy
// (server/vpn/proxy.js). Reads data/vpn/wg.conf, persists the switch in data/vpn/state.json and
// publishes the vpn.* state keys. Fail closed: while the switch is on, the proxy exists even when the
// tunnel is down, so the browser never has a direct route. Keys never reach logs or the store.
import fs from 'node:fs';
import path from 'node:path';
import { LumenError } from '../errors.js';
import { createVpnProxy } from '../vpn/proxy.js';
import { parseWireGuardConf, summarizeWireGuardConf } from '../vpn/conf.js';

const CONF_FILE = 'vpn/wg.conf';
const STATE_FILE = 'vpn/state.json';
const MAX_CONF_BYTES = 8192;
const RESTART_BACKOFF_MS = [5000, 10000, 30000];
const STOP_TIMEOUT_MS = 5000;
const NO_CONF = 'No VPN configuration: save the WireGuard .conf as data/vpn/wg.conf';

function within(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export function createVpn({ config, data, log: rootLog, store, seams = {} }) {
  const log = rootLog.child('vpn');
  const confPath = path.join(config.dataDir, CONF_FILE);
  let mods = null; // { parseWireGuardConf, createTunnel }
  let loadError = null;
  let conf = null; // parsed data/vpn/wg.conf
  let confError = null;
  let enabled = false; // the persisted switch
  let tunnel = null;
  let proxy = null;
  let error = null; // a tunnel/worker failure message behind vpn.error
  let retryTimer = null;
  let retries = 0;
  let stopped = false;
  let chain = Promise.resolve();

  // enable / disable / reload / stop run one at a time.
  function run(fn) {
    const next = chain.then(fn, fn);
    chain = next.then(() => {}, () => {});
    return next;
  }

  // The tunnel modules load on first use so Lumen boots even when they are missing or broken.
  async function load() {
    if (mods) return mods;
    const [confModule, wgModule] = await Promise.all([
      seams.parseWireGuardConf ? null : import('../vpn/conf.js'),
      seams.createTunnel ? null : import('../vpn/wireguard.js'),
    ]);
    mods = {
      parseWireGuardConf: seams.parseWireGuardConf ?? confModule.parseWireGuardConf,
      createTunnel: seams.createTunnel ?? wgModule.createTunnel,
    };
    return mods;
  }

  // ---------- files ----------

  function readConf() {
    let text;
    try {
      text = fs.readFileSync(confPath, 'utf8');
    } catch (err) {
      conf = null;
      confError = err.code === 'ENOENT' ? NO_CONF : `VPN configuration could not be read (${err.code ?? err.message})`;
      return;
    }
    try {
      conf = mods.parseWireGuardConf(text);
      confError = null;
    } catch (err) {
      conf = null;
      confError = err.message;
    }
  }

  function readEnabled() {
    enabled = data.readJson(STATE_FILE, { enabled: false })?.enabled === true;
  }

  function saveEnabled(value) {
    enabled = value;
    try {
      data.writeJson(STATE_FILE, { enabled: value });
    } catch (err) {
      log.warn('vpn switch not saved', err);
    }
  }

  // ---------- state ----------

  const tunnelStatus = () => (tunnel ? tunnel.status() : null);

  function state() {
    if (loadError) return 'error';
    if (!conf) return 'unconfigured';
    if (!enabled) return 'off';
    const t = tunnelStatus();
    if (retryTimer || !t || t.state === 'error') return 'error';
    if (t.state === 'up') return 'up';
    if (t.state === 'down') return 'down';
    return 'connecting'; // 'starting' / 'handshaking', or 'stopped' on a tunnel whose start() is about to run
  }

  function errorText() {
    if (loadError) return loadError;
    if (!conf) return confError;
    if (!enabled) return null;
    if (error) return error;
    const t = tunnelStatus();
    return t && t.state !== 'up' && t.lastError ? t.lastError : null;
  }

  function status() {
    const t = enabled ? tunnelStatus() : null;
    const up = t?.state === 'up';
    return {
      state: state(),
      enabled,
      endpoint: conf?.peer.endpoint ?? null,
      handshakeAgeS: up && Number.isFinite(t.handshakeAgeMs) ? Math.round(t.handshakeAgeMs / 1000) : null,
      bytesIn: t ? t.rx ?? 0 : null,
      bytesOut: t ? t.tx ?? 0 : null,
      error: errorText(),
      proxyPort: enabled && proxy ? proxy.port : null,
      address: conf ? summarizeWireGuardConf(conf).address ?? null : null,
      hasBackup: fs.existsSync(`${confPath}.bak`),
    };
  }

  // Values are primitives; an unchanged value is not re-published (the store would still emit a patch).
  function publish(key, value) {
    const current = store.get(`vpn.${key}`);
    if (current && current.src === 'derived' && current.v === value) return;
    store.set(`vpn.${key}`, value, { src: 'derived', via: 'vpn' });
  }

  function publishAll() {
    for (const [key, value] of Object.entries(status())) publish(key, value);
  }

  // ---------- tunnel ----------

  function attach(t) {
    const current = () => t === tunnel && !stopped;
    t.on('status', () => { if (current()) publishAll(); });
    t.on('up', () => {
      if (!current()) return;
      retries = 0;
      error = null;
      log.info('vpn tunnel up', { endpoint: conf?.peer.endpoint });
      publishAll();
    });
    t.on('down', () => {
      if (!current()) return;
      log.warn('vpn tunnel down', { lastError: t.status().lastError });
      publishAll();
    });
    t.on('error', (err) => {
      if (!current()) return;
      error = err?.message ?? 'VPN tunnel failed';
      log.warn('vpn tunnel failed', { code: err?.code, message: error });
      scheduleRestart(t);
    });
    t.on('exit', () => {
      if (!current()) return;
      error ??= 'VPN worker exited';
      scheduleRestart(t);
    });
  }

  async function startTunnel() {
    const t = mods.createTunnel({ conf, log: rootLog });
    tunnel = t;
    attach(t);
    // start() moves the tunnel to 'starting' synchronously, so the first state published for a
    // switch-on is 'connecting' (never a flash of 'error' from a tunnel that has not started yet).
    const starting = t.start();
    publishAll();
    try {
      await starting;
    } catch (err) {
      if (t !== tunnel) return; // disabled meanwhile
      error = err?.message ?? 'VPN tunnel failed to start';
      log.warn('vpn tunnel start failed', { code: err?.code, message: error });
      scheduleRestart(t);
      throw new LumenError('FAILED', error);
    }
    publishAll();
  }

  async function stopTunnel() {
    const t = tunnel;
    tunnel = null;
    if (!t) return;
    try {
      await within(t.stop(), STOP_TIMEOUT_MS, 'tunnel stop timed out');
    } catch (err) {
      log.warn('vpn tunnel stop failed', { message: err.message });
    }
  }

  // Worker death or a failed start while the switch is on: a fresh tunnel after 5 s, 10 s, then 30 s;
  // the proxy stays up and answers 502 meanwhile.
  function scheduleRestart(t) {
    if (stopped || !enabled || t !== tunnel || retryTimer) return;
    const delay = RESTART_BACKOFF_MS[Math.min(retries, RESTART_BACKOFF_MS.length - 1)];
    retries += 1;
    log.info(`restarting the vpn tunnel in ${delay / 1000} s`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      run(async () => {
        if (stopped || !enabled || t !== tunnel) return;
        await stopTunnel();
        await startTunnel().catch(() => {}); // a failed restart schedules the next one itself
      });
    }, delay);
    publishAll();
  }

  // ---------- proxy ----------

  // The proxy outlives tunnel restarts, so it sees whichever tunnel is current.
  const currentTunnel = {
    status: () => tunnel?.status() ?? { state: 'stopped' },
    connect: (host, port) => tunnel.connect(host, port),
  };

  async function startProxy() {
    if (proxy) return;
    const p = createVpnProxy({ tunnel: currentTunnel, log: rootLog });
    await p.start();
    proxy = p;
  }

  async function stopProxy() {
    const p = proxy;
    proxy = null;
    if (p) await p.stop();
  }

  // The proxy comes first so proxyUrl() is set before the browser could ask (fail closed); the
  // keys are published once the tunnel object exists, from startTunnel().
  async function bringUp() {
    await startProxy();
    await startTunnel();
  }

  async function tearDown() {
    clearTimeout(retryTimer);
    retryTimer = null;
    retries = 0;
    error = null;
    await stopProxy();
    await stopTunnel();
  }

  async function reloadNow() {
    if (stopped) throw new LumenError('UNAVAILABLE', 'Lumen is stopping');
    if (loadError) throw new LumenError('UNAVAILABLE', loadError);
    readConf();
    if (!enabled) {
      publishAll();
      return { value: status() };
    }
    await tearDown();
    if (!conf) {
      saveEnabled(false);
      publishAll();
      throw new LumenError('INVALID', confError);
    }
    try {
      await bringUp();
    } finally {
      publishAll();
    }
    return { value: status() };
  }

  return {
    async start() {
      stopped = false;
      readEnabled();
      try {
        await load();
        loadError = null;
      } catch (err) {
        loadError = `VPN modules are not available: ${err.message}`;
        log.error('vpn modules failed to load', err);
        publishAll();
        return;
      }
      readConf();
      if (enabled && conf) {
        await run(bringUp).catch((err) => log.warn('vpn did not come up at start', { message: err.message }));
      } else if (enabled) {
        log.warn('vpn is switched on but has no usable configuration', { message: confError });
      }
      publishAll();
    },
    async stop() {
      stopped = true;
      await run(tearDown);
    },
    setDemand() {},

    enable: () => run(async () => {
      if (stopped) throw new LumenError('UNAVAILABLE', 'Lumen is stopping');
      if (loadError) throw new LumenError('UNAVAILABLE', loadError);
      if (!conf) throw new LumenError('INVALID', confError);
      if (!enabled) saveEnabled(true);
      if (!proxy || !tunnel) {
        try {
          await bringUp();
        } finally {
          publishAll();
        }
      }
      return { value: status() };
    }),

    disable: () => run(async () => {
      if (enabled) saveEnabled(false);
      await tearDown();
      publishAll();
      log.info('vpn switched off');
      return { value: status() };
    }),

    // Re-reads the conf; while enabled the tunnel and proxy restart on it (a new proxy port).
    reload: () => run(reloadNow),

    // "Use a config file": validates the uploaded WireGuard INI, keeps the current file as
    // wg.conf.bak, writes the new one atomically and reconnects. Only the summary goes back.
    saveConfig: (text) => run(async () => {
      if (stopped) throw new LumenError('UNAVAILABLE', 'Lumen is stopping');
      if (typeof text !== 'string' || !text.trim()) throw new LumenError('INVALID', 'The file is empty');
      if (Buffer.byteLength(text, 'utf8') > MAX_CONF_BYTES) throw new LumenError('INVALID', 'That is not a WireGuard config (too large)');
      let parsed;
      try {
        parsed = parseWireGuardConf(text);
      } catch (err) {
        throw new LumenError('INVALID', `That is not a usable WireGuard config: ${err.message}`);
      }
      fs.mkdirSync(path.dirname(confPath), { recursive: true });
      if (fs.existsSync(confPath)) fs.copyFileSync(confPath, `${confPath}.bak`);
      const tmp = `${confPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, confPath);
      log.info('vpn config replaced', summarizeWireGuardConf(parsed));
      await reloadNow();
      return { value: { ...status(), config: summarizeWireGuardConf(parsed), hasBackup: true } };
    }),

    // Puts wg.conf.bak back (the previous config) and reconnects.
    restoreBackup: () => run(async () => {
      if (stopped) throw new LumenError('UNAVAILABLE', 'Lumen is stopping');
      const backup = `${confPath}.bak`;
      if (!fs.existsSync(backup)) throw new LumenError('INVALID', 'There is no previous VPN config to restore');
      const current = fs.existsSync(confPath) ? fs.readFileSync(confPath) : null;
      fs.copyFileSync(backup, confPath);
      if (current) fs.writeFileSync(backup, current, { mode: 0o600 }); // Undo of the undo
      log.info('vpn config restored from backup');
      await reloadNow();
      return { value: status() };
    }),

    proxyUrl: () => (enabled && proxy ? `http://127.0.0.1:${proxy.port}` : null),
    status,
  };
}
