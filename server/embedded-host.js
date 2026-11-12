// Runs the server inside an app (the iPad app in ipad/, started by server/embedded.js) and keeps it
// usable there.
//
// iPadOS suspends an app that is off screen, and can take its network sockets away while it is
// suspended. Node itself survives that, and it cannot be started a second time in one process, so
// the host rebuilds the *server* inside the running Node instead (stop, then start again; the
// tests do the same many times per process). It restarts the server:
//   - after a long pause, always: every socket, to the TV and from the page, is rebuilt;
//   - after a short pause, only if a listener no longer accepts connections;
//   - when a listening socket reports an accept error;
//   - when the app asks, by writing <data>/host-control.json: { "restart": "<any new value>" }.
// A pause shows as the tick timer skipping: timers do not run while the app is suspended.
//
// Every start writes its outcome to <data>/host-status.json, which the app reads because it cannot
// see this process's console: { state: starting | ready | failed | stopped, generation, reason,
// httpPort, lanPort, ... }. generation counts the starts, so the app can tell a restart happened.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startServer } from './app.js';
import { VERSION } from './config.js';

const STOP_TIMEOUT_MS = 8000;

// Tells how long the process was paused between two ticks: 'none', 'short' or 'long'.
export function createPauseWatch({ now = Date.now, shortMs = 8000, longMs = 30000 } = {}) {
  let last = now();
  return {
    tick() {
      const t = now();
      const gap = t - last;
      last = t;
      if (gap >= longMs) return 'long';
      if (gap >= shortMs) return 'short';
      return 'none';
    },
  };
}

// True when something accepts a TCP connection on host:port.
export function canConnect(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * Starts the server for an embedding app and watches over it.
 * @param {object} opts
 * @param {string} opts.dataDir   the app's data folder
 * @param {number} [opts.port]    HTTP port, instead of the one in config.json
 * @param {object} [opts.overrides] extra config overrides (tests)
 * @returns the host: { server, generation, restart(reason), check(), noteError(err), stop() }.
 *          server is null when the last start failed; host-status.json says why.
 */
export async function startEmbeddedHost({
  dataDir: dataDirOpt,
  port = null,
  overrides = {},
  tickMs = 2000,
  shortPauseMs = 8000,
  longPauseMs = 30000,
  retryMs = 5000,
  now = Date.now,
  start = startServer,
} = {}) {
  if (!dataDirOpt) throw new Error('startEmbeddedHost needs dataDir');
  const dataDir = path.resolve(dataDirOpt);
  const statusFile = path.join(dataDir, 'host-status.json');
  const controlFile = path.join(dataDir, 'host-control.json');

  let server = null;
  let generation = 0;
  let stopped = false;
  let busy = null; // the restart in progress, if any
  let lastStart = 0;

  function writeStatus(status) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = `${statusFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...status, generation, pid: process.pid, at: new Date().toISOString() }));
      fs.renameSync(tmp, statusFile);
    } catch (err) {
      console.error(`Lumen could not write its status file: ${err.message}`);
    }
  }

  // The app's latest request, as a string; null when there is none.
  function readControl() {
    try {
      const request = JSON.parse(fs.readFileSync(controlFile, 'utf8'))?.restart;
      return request === undefined || request === null ? null : String(request);
    } catch {
      return null;
    }
  }
  let lastControl = readControl(); // a request left over from an earlier run is not a new one

  // Starting takes a while on a slow device, and must not be read as a pause afterwards: the
  // watch begins again after every start.
  let watch = null;
  const resetWatch = () => {
    watch = createPauseWatch({ now, shortMs: shortPauseMs, longMs: longPauseMs });
  };

  async function boot(reason) {
    generation += 1;
    lastStart = now();
    writeStatus({ state: 'starting', reason });
    try {
      server = await start({
        ...overrides,
        dataDir,
        embedded: true,
        http: { ...overrides.http, ...(Number.isInteger(port) && port > 0 && { port }) },
        update: { ...overrides.update, enabled: false },
        ai: { ...overrides.ai, backend: 'api' },
        log: { console: false, ...overrides.log },
      });
      writeStatus({
        state: 'ready',
        reason,
        version: VERSION,
        httpPort: server.httpPort,
        lanPort: server.lanPort ?? null,
        lanUrl: server.lanUrl ?? null,
        tv: server.config.tv.host,
      });
      if (generation > 1) server.log.info(`embedded host: the server was restarted (${reason})`);
      return true;
    } catch (err) {
      server = null;
      console.error(`Lumen could not start (${reason}): ${err?.stack ?? err}`);
      writeStatus({ state: 'failed', reason, code: err?.code ?? null, error: String(err?.message ?? err) });
      return false;
    } finally {
      resetWatch();
    }
  }

  // Stops the server, if it runs, and starts it again. Calls made meanwhile share the one restart.
  function restart(reason) {
    if (stopped) return Promise.resolve(false);
    busy ??= (async () => {
      try {
        const old = server;
        server = null;
        if (old) {
          old.log.warn(`embedded host: restarting the server (${reason})`);
          // Sockets the system took away may never report that they closed: do not wait forever.
          await withTimeout(Promise.resolve(old.stop()).catch(() => {}), STOP_TIMEOUT_MS);
        }
        return stopped ? false : await boot(reason);
      } finally {
        busy = null;
      }
    })();
    return busy;
  }

  // Both listeners: the page's (HTTP) and the TV's (agent, Eyes, GENA events).
  async function listenersAnswer() {
    const current = server;
    if (!current) return false;
    const checks = [canConnect('127.0.0.1', current.httpPort)];
    if (current.lanPort && current.lanAddress) checks.push(canConnect(current.lanAddress, current.lanPort));
    return (await Promise.all(checks)).every(Boolean);
  }

  // One look at everything that can call for a restart. Runs on every tick; tests call it directly.
  async function check() {
    if (stopped) return false;
    const pause = watch.tick();

    const control = readControl();
    if (control !== lastControl) {
      lastControl = control;
      if (control !== null) return restart('the app asked');
    }
    if (busy) return false;
    if (!server) {
      // A restart that failed (the port not free yet, say) is tried again; a first start is not,
      // because the app has already shown why it failed.
      if (generation > 1 && now() - lastStart >= retryMs) return restart('trying again after a failed restart');
      return false;
    }
    if (pause === 'long') return restart('resumed after a long pause');
    if (pause === 'short' && !(await listenersAnswer())) return restart('a listener stopped answering after a pause');
    return false;
  }

  // An accept error means a listening socket is gone (the system took it): rebuild.
  function noteError(err) {
    if (stopped || busy || !server || err?.syscall !== 'accept') return;
    restart(`a listening socket failed (${err.code ?? err.message})`);
  }

  await boot('start');

  // Not unref'd: this timer is also what keeps Node running if a start fails.
  const timer = setInterval(() => {
    check().catch((err) => console.error('embedded host: check failed', err));
  }, tickMs);

  return {
    get server() {
      return server;
    },
    get generation() {
      return generation;
    },
    statusFile,
    controlFile,
    restart,
    check,
    noteError,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await busy?.catch(() => {});
      const old = server;
      server = null;
      await old?.stop();
      writeStatus({ state: 'stopped' });
    },
  };
}
