// TV-facing listener (spec §3.2, §9.8). Binds the PC address that routes to the TV, accepts
// connections from the TV's address only, and hands requests (GENA NOTIFY, cast file GETs) and
// upgrades (agent WebSocket) to prefix routes. Anything unrouted has its socket destroyed.
import http from 'node:http';
import dgram from 'node:dgram';
import net from 'node:net';
import { lookup } from 'node:dns/promises';

const DISCOVERY_TIMEOUT_MS = 2000;

const plainAddress = (address) => String(address ?? '').replace(/^::ffff:/i, '');

// The local address of a UDP socket "connected" to host:port. connect() only picks a route;
// nothing is sent, so this works while the TV is asleep.
export function discoverLanAddress(host, port = 9) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    const done = (address) => {
      clearTimeout(timer);
      socket.close();
      resolve(address);
    };
    const timer = setTimeout(() => done(null), DISCOVERY_TIMEOUT_MS);
    socket.once('error', () => done(null));
    socket.connect(port, host, () => {
      try {
        done(socket.address().address);
      } catch {
        done(null);
      }
    });
  });
}

async function resolveHost(host) {
  if (net.isIP(host)) return plainAddress(host);
  return plainAddress((await lookup(host)).address);
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

export function createLan({ config, log: rootLog }) {
  const log = rootLog.child('lan');
  const routes = [];
  const sockets = new Set();
  let server = null;
  let info = null;
  let allowed = null;
  let stopping = null;

  function find(url) {
    const pathname = String(url ?? '/').split('?')[0];
    return routes.find(({ prefix }) => pathname === prefix
      || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
  }

  function onConnection(socket) {
    if (plainAddress(socket.remoteAddress) !== allowed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  }

  function failed(err, res) {
    log.warn('TV-facing handler failed', err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    } else {
      res.destroy();
    }
  }

  function onRequest(req, res) {
    const route = find(req.url);
    if (!route?.request) {
      req.socket.destroy();
      return;
    }
    try {
      Promise.resolve(route.request(req, res)).catch((err) => failed(err, res));
    } catch (err) {
      failed(err, res);
    }
  }

  function onUpgrade(req, socket, head) {
    const route = find(req.url);
    if (!route?.upgrade) {
      socket.destroy();
      return;
    }
    try {
      Promise.resolve(route.upgrade(req, socket, head)).catch((err) => {
        log.warn('TV-facing upgrade failed', err);
        socket.destroy();
      });
    } catch (err) {
      log.warn('TV-facing upgrade failed', err);
      socket.destroy();
    }
  }

  const ready = (async () => {
    if (!config.lan?.enabled) {
      log.info('TV-facing listener disabled; live events fall back to polling');
      return null;
    }
    try {
      allowed = await resolveHost(config.tv.host);
      const address = await discoverLanAddress(config.tv.host);
      if (!address) throw new Error('no route to the TV');
      server = http.createServer(onRequest);
      server.on('connection', onConnection);
      server.on('upgrade', onUpgrade);
      server.on('clientError', (err, socket) => socket.destroy());
      await listen(server, config.lan.port, address);
      info = { address, port: server.address().port };
      log.info(`TV-facing listener on ${info.address}:${info.port}`);
      return info;
    } catch (err) {
      log.warn(`TV-facing listener unavailable (${err.code ?? err.message}); live events fall back to polling`);
      server?.close();
      server = null;
      return null;
    }
  })();

  return {
    ready,
    get address() {
      return info?.address ?? null;
    },
    get port() {
      return info?.port ?? null;
    },

    // handlers: { request?(req, res), upgrade?(req, socket, head) }. Returns an unregister function.
    route(prefix, handlers = {}) {
      if (typeof prefix !== 'string' || !prefix.startsWith('/')) throw new TypeError('route prefix must start with /');
      const entry = { prefix, request: handlers.request, upgrade: handlers.upgrade };
      routes.push(entry);
      routes.sort((a, b) => b.prefix.length - a.prefix.length);
      return () => {
        const index = routes.indexOf(entry);
        if (index >= 0) routes.splice(index, 1);
      };
    },

    stop() {
      stopping ??= (async () => {
        await ready;
        if (!server) return;
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(() => resolve()));
        server = null;
      })();
      return stopping;
    },
  };
}
