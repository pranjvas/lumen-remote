// Wiring (spec §8.2): config → store → TV-facing listener → adapters → features → hub → HTTP.
// startServer() is the single entry point for index.js and the tests.
import path from 'node:path';
import { loadConfig, createDataStore } from './config.js';
import { createLogger } from './log.js';
import { createStore } from './store.js';
import { createLan } from './lan.js';
import { createHub } from './hub.js';
import { createHttp } from './http.js';
import { createRest } from './adapters/rest.js';
import { createRemote } from './adapters/remote.js';
import { createUpnp } from './adapters/upnp.js';
import { createIpControl } from './adapters/ipcontrol.js';
import { createAgent } from './adapters/agent.js';
import { createEyes } from './adapters/eyes.js';
import { createWol } from './adapters/wol.js';
import { createAvTransport } from './adapters/avtransport.js';
import { createDial } from './adapters/dial.js';
import { createSleep } from './features/sleep.js';
import { createScenes } from './features/scenes.js';
import { createTracked } from './features/tracked.js';
import { createMacros } from './features/macros.js';
import { createCast } from './features/cast.js';
import { createBrowser } from './features/browser.js';
import { createVpn } from './features/vpn.js';
import { createRelay } from './features/relay.js';
import { createTvScreen } from './features/tvscreen.js';
import { createTranscoder } from './features/transcode.js';
import { createLiveVideo } from './features/livevideo.js';
import { createMemory } from './features/memory.js';
import { createHistory } from './features/history.js';
import { createIncognito } from './features/incognito.js';
import { createUpdater } from './features/updater.js';
import { createAi } from './ai/index.js';
import { APPS } from './catalog/apps.js';

const START_WAIT_MS = 3000;
const STOP_WAIT_MS = 5000;
const LATE = Symbol('late');

// Awaits `work` but gives up waiting (calling onLate) after `ms`. Rejections propagate.
async function within(work, ms, onLate) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, ms, LATE); });
  try {
    if ((await Promise.race([work, late])) === LATE) onLate();
  } finally {
    clearTimeout(timer);
  }
}

// `seams` is for tests and tools/dev-stack.mjs only: { aiBackends } replaces the AI backends, { updateGit }
// the updater's git layer.
export async function startServer(overrides = {}, seams = {}) {
  const config = loadConfig(overrides);
  const data = createDataStore(config.dataDir);
  const log = createLogger({ dir: path.join(config.dataDir, 'logs'), ...config.log });
  const store = createStore({ cachePath: path.join(config.dataDir, 'state-cache.json'), log: log.child('store') });
  const lan = createLan({ config, log });

  // [name, stop] for everything created so far; stopped in reverse order.
  const parts = [
    ['log', async () => log.close()],
    ['store', (save) => store.stop({ save })],
    ['lan', () => lan.stop()],
  ];

  async function stopAll(save) {
    for (const [name, stopPart] of [...parts].reverse()) {
      try {
        await within(Promise.resolve().then(() => stopPart(save)), STOP_WAIT_MS,
          () => log.warn(`${name} did not stop within ${STOP_WAIT_MS} ms`));
      } catch (err) {
        log.warn(`${name} failed to stop`, err);
      }
    }
  }

  try {
    await lan.ready;
    const ctx = { config, data, log, store, lan };

    // The web UI hides what an embedded host (the iPad app) cannot do: the Browser and the updater.
    store.set('host.embedded', config.embedded === true, { src: 'derived', via: 'config' });

    // Curated apps until the TV agent reports the real list (a list cached from the agent is kept:
    // it is the TV's own, shown as stale until the agent says hello again).
    if (!store.get('app.installed')) {
      store.set('app.installed', APPS.map(({ id, name, color, short }) => ({ id, name, color, short })),
        { src: 'derived', via: 'catalog' });
    }

    const rest = createRest(ctx);
    const remote = createRemote({ ...ctx, rest });
    const upnp = createUpnp(ctx);
    const ipc = createIpControl(ctx);
    const agent = createAgent({ ...ctx, rest });
    const wol = createWol(ctx);
    const avtransport = createAvTransport(ctx);
    const dial = createDial(ctx);
    const eyes = createEyes({ ...ctx, agent: () => agent });
    const adapters = { rest, remote, upnp, ipc, agent, eyes, wol, avtransport, dial };

    const features = {
      vpn: createVpn(ctx),
      sleep: createSleep({ ...ctx, ipc, remote }),
      scenes: createScenes(ctx),
      tracked: createTracked(ctx),
      macros: createMacros({ ...ctx, remote }),
      // Page links from Cast open in the Browser view, which is created after the hub (it sends frames through it).
      cast: createCast({ ...ctx, avtransport, dial, rest, lan, browser: () => features.browser, agent: () => agent }),
      transcode: createTranscoder(ctx),
      memory: createMemory({ ...ctx, rest, eyes: () => eyes, agent: () => agent }),
      relay: createRelay({ ...ctx, vpn: () => features.vpn, transcoder: () => features.transcode }),
    };
    const hub = createHub({ ...ctx, adapters, features });
    let http = null;
    // The MCP URL handed to the Claude Code CLI must use the bound port (port 0 in tests).
    features.ai = createAi({ ...ctx, hub, adapters, browser: () => features.browser, httpPort: () => http?.port ?? config.http.port, backends: seams.aiBackends });
    features.browser = createBrowser({ ...ctx, hub, vpn: () => features.vpn });
    features.livevideo = createLiveVideo({ ...ctx, browser: () => features.browser });
    features.tvscreen = createTvScreen({ ...ctx, agent: () => agent, rest, browser: () => features.browser, relay: () => features.relay, transcoder: () => features.transcode, cast: () => features.cast, liveVideo: () => features.livevideo });
    // Clear history (hub browser.clearHistory) reaches the browser, the TV screen, the relay, the
    // converter and the log files.
    features.history = createHistory({ ...ctx, features });
    // Incognito (hub browser.incognito): the browser on a throwaway profile, and no record of its pages.
    features.incognito = createIncognito({ ...ctx, features });
    // Automatic updates from this copy's git origin (features/updater.js).
    // To apply an update Lumen shuts down as on Ctrl+C (server/index.js) and the update helper takes over.
    features.updater = createUpdater({
      ...ctx, features, adapters, requestExit: () => process.emit('lumen:exit-for-update'), httpPort: () => http?.port ?? config.http.port,
      ...(seams.updateGit && { git: seams.updateGit }),
    });

    const startable = [...Object.entries(adapters), ...Object.entries(features)];
    for (const [name, part] of startable) parts.push([name, () => part.stop?.()]);
    parts.push(['hub', () => hub.stop()]);

    // Binding the HTTP port doubles as the single-instance lock, so it happens before anything
    // talks to the TV.
    http = await createHttp({ ...ctx, hub, adapters, features });
    parts.push(['http', () => http.stop()]);

    for (const [name, part] of startable) {
      if (typeof part?.start !== 'function') continue;
      try {
        await within(Promise.resolve().then(() => part.start()), START_WAIT_MS, () => log.warn(`${name} is still starting`));
      } catch (err) {
        log.error(`${name} failed to start`, err);
      }
    }
    log.info('Lumen ready', { httpPort: http.port, lanPort: lan.port });
    http.markReady();

    let stopping = null;
    return {
      httpPort: http.port,
      lanPort: lan.port,
      lanAddress: lan.address,
      lanUrl: http.lanUrl,
      agentKey: config.secrets.agentKey,
      store,
      hub,
      adapters, // tests reach adapters.eyes (look_at_screen) through this
      features, // tests reach features.browser.evaluate (spec §11.3) through this
      config,
      log,
      stop() {
        stopping ??= stopAll(true);
        return stopping;
      },
    };
  } catch (err) {
    if (err.code !== 'EADDRINUSE') log.error('startup failed', err);
    await stopAll(false);
    throw err;
  }
}
