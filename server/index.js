// Entry point: start Lumen, print where to open it, stop gracefully on Ctrl+C / console close.
import os from 'node:os';
import { startServer } from './app.js';
import { DEFAULTS, VERSION } from './config.js';

const FORCE_EXIT_MS = 6000;

// Lumen relays the browser, the VPN tunnel and the TV's video while the PC may be busy with other
// work; above-normal priority kept them smooth under CPU contention (measured 3.7x better). Its worker
// threads (the VPN) inherit it.
try { os.setPriority(os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch { /* not allowed here: keep the default */ }

async function whoHasPort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return (await res.json())?.app === 'lumen' ? 'lumen' : 'other';
  } catch {
    return 'other';
  }
}

async function main() {
  let server;
  try {
    server = await startServer();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      const port = err.port ?? DEFAULTS.http.port;
      console.error((await whoHasPort(port)) === 'lumen'
        ? `Lumen is already running: open http://127.0.0.1:${port}`
        : `Port ${port} is in use by another program, so Lumen cannot start.`);
    } else {
      console.error(`Lumen could not start: ${err.message}`);
    }
    process.exit(1);
  }

  const { httpPort, lanPort, lanAddress, lanUrl, config, log } = server;
  console.log([
    '',
    `  Lumen Remote ${VERSION}`,
    `  Open  http://127.0.0.1:${httpPort}`,
    ...(lanUrl ? [`  Phone ${lanUrl}  (same Wi-Fi)`] : []),
    `  TV    ${config.tv.host}`,
    `  Live events  ${lanPort ? `listening on ${lanAddress}:${lanPort}` : 'off (polling instead)'}`,
    '  Press Ctrl+C to stop.',
    '',
  ].join('\n'));

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) {
      process.exit(1); // a second signal forces the exit
    }
    stopping = true;
    log.info(`stopping (${signal})`);
    setTimeout(() => process.exit(1), FORCE_EXIT_MS).unref();
    await server.stop();
    process.exit(0);
  }

  // SIGBREAK is Ctrl+Break and SIGHUP is the console window closing on Windows.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(signal, () => shutdown(signal));
  // An update (features/updater.js): the same graceful stop; tools/update-apply.js starts Lumen again.
  process.on('lumen:exit-for-update', () => shutdown('update'));

  // A remote control should keep working after one bad callback: log it and carry on.
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', reason));
  process.on('uncaughtException', (err) => log.error('uncaught exception', err));
}

main();
