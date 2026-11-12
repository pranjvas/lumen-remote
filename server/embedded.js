// Entry point when Node runs inside an app instead of on a PC: the iPad app in ipad/ starts
// nodejs-mobile (Node 18) with this file. The PC entry point is server/index.js.
//
// What differs from the PC:
//   - the data folder comes from LUMEN_DATA_DIR (the app's Documents/data folder, visible in Files);
//   - there are no child processes, so the Browser (desktop Edge), the video converter (ffmpeg) and the
//     updater (git) are off; config.embedded tells the rest of the server and the web UI;
//   - Ask Lumen uses the Anthropic API only (ANTHROPIC_API_KEY, set by the app from its settings);
//   - iPadOS can suspend the app and take its sockets, so server/embedded-host.js watches for that
//     and restarts the server inside this same Node, and reports to the app through files.
// The process must never exit by itself: on iOS that would close the whole app.
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

// ---------- start ----------

async function main() {
  if (!process.env.LUMEN_DATA_DIR) {
    console.error('Lumen (embedded) needs LUMEN_DATA_DIR');
    return;
  }

  let host = null;
  const logger = () => host?.server?.log ?? console;
  // A remote control should keep working after one bad callback: log it and carry on.
  process.on('unhandledRejection', (reason) => {
    logger().error('unhandled rejection', reason);
  });
  process.on('uncaughtException', (err) => {
    logger().error('uncaught exception', err);
    host?.noteError(err); // a listening socket the system took away shows up here
  });

  // Imported here, not at the top, so the gaps above are filled before any module runs.
  const { startEmbeddedHost } = await import('./embedded-host.js');
  const port = Number(process.env.LUMEN_HTTP_PORT);
  host = await startEmbeddedHost({
    dataDir: path.resolve(process.env.LUMEN_DATA_DIR),
    port: Number.isInteger(port) && port > 0 ? port : null,
  });
}

main().catch((err) => console.error(`Lumen could not start: ${err?.stack ?? err}`));
