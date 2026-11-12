// Entry point when Node runs inside an app instead of on a PC: the iPad app in ipad/ starts
// nodejs-mobile (Node 18) with this file. The PC entry point is server/index.js.
//
// What differs from the PC:
//   - the data folder comes from LUMEN_DATA_DIR (the app's Documents/data folder, visible in Files);
//   - there are no child processes, so the Browser (desktop Edge), the video converter (ffmpeg) and the
//     updater (git) are off; config.embedded tells the rest of the server and the web UI;
//   - Ask Lumen uses the Anthropic API only (ANTHROPIC_API_KEY, set by the app from its settings);
//   - the outcome of the start is written to <data>/host-status.json, which the app reads, because the
//     app cannot see this process's console.
// The process must never exit by itself: on iOS that would close the whole app.
import fs from 'node:fs';
import path from 'node:path';

// ---------- Node 18 gaps ----------

// AbortSignal.any arrived in Node 20.3; the DIAL, AVTransport and API clients use it.
if (typeof AbortSignal.any !== 'function') {
  AbortSignal.any = function any(signals) {
    const list = [...signals];
    const controller = new AbortController();
    const done = list.find((signal) => signal.aborted);
    if (done) {
      controller.abort(done.reason);
      return controller.signal;
    }
    const onAbort = (event) => {
      for (const signal of list) signal.removeEventListener('abort', onAbort);
      controller.abort(event.target.reason);
    };
    for (const signal of list) signal.addEventListener('abort', onAbort, { once: true });
    return controller.signal;
  };
}

// ---------- status file ----------

const dataDir = process.env.LUMEN_DATA_DIR ? path.resolve(process.env.LUMEN_DATA_DIR) : null;
const statusFile = dataDir ? path.join(dataDir, 'host-status.json') : null;

function writeStatus(status) {
  if (!statusFile) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${statusFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...status, pid: process.pid, at: new Date().toISOString() }));
    fs.renameSync(tmp, statusFile);
  } catch (err) {
    console.error(`Lumen could not write its status file: ${err.message}`);
  }
}

// ---------- start ----------

async function main() {
  if (!dataDir) {
    console.error('Lumen (embedded) needs LUMEN_DATA_DIR');
    return;
  }
  writeStatus({ state: 'starting' });

  let log = null;
  // A remote control should keep working after one bad callback: log it and carry on.
  process.on('unhandledRejection', (reason) => {
    if (log) log.error('unhandled rejection', reason);
    else console.error('unhandled rejection', reason);
  });
  process.on('uncaughtException', (err) => {
    if (log) log.error('uncaught exception', err);
    else console.error('uncaught exception', err);
  });

  try {
    // Imported here, not at the top, so the gaps above are filled before any module runs.
    const { startServer } = await import('./app.js');
    const { VERSION } = await import('./config.js');
    const port = Number(process.env.LUMEN_HTTP_PORT);
    const server = await startServer({
      dataDir,
      embedded: true,
      ...(Number.isInteger(port) && port > 0 && { http: { port } }),
      update: { enabled: false },
      ai: { backend: 'api' },
      log: { console: false },
    });
    log = server.log;
    writeStatus({
      state: 'ready',
      version: VERSION,
      httpPort: server.httpPort,
      lanPort: server.lanPort ?? null,
      lanUrl: server.lanUrl ?? null,
      tv: server.config.tv.host,
    });
  } catch (err) {
    console.error(`Lumen could not start: ${err?.stack ?? err}`);
    writeStatus({ state: 'failed', code: err?.code ?? null, error: String(err?.message ?? err) });
  }
}

main();
