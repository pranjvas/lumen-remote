// Wake-on-LAN. Packets leave from a socket bound to the PC's LAN address, because Windows may otherwise
// route a broadcast out of a VPN or virtual adapter.
import dgram from 'node:dgram';
import { LumenError } from '../errors.js';

const REPEATS = 3;
const REPEAT_GAP_MS = 100;
const MAC = /^[0-9A-Fa-f]{2}([:-]?[0-9A-Fa-f]{2}){5}$/;

// 6 × 0xFF followed by the MAC 16 times = 102 bytes.
export function magicPacket(mac) {
  const bytes = Buffer.from(mac.replace(/[^0-9A-Fa-f]/g, ''), 'hex');
  const packet = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i++) bytes.copy(packet, 6 + i * 6);
  return packet;
}

// Configured targets, else limited broadcast + the /24 directed broadcast + the TV itself.
export function wolTargets(config, lanAddress) {
  if (config.wol.targets?.length) return [...config.wol.targets];
  const targets = new Set(['255.255.255.255']);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(lanAddress ?? '')) targets.add(lanAddress.replace(/\.\d+$/, '.255'));
  targets.add(config.tv.host);
  return [...targets];
}

// The UDP-connect trick: no packet is sent, the OS just picks the interface that routes to the TV.
function routeAddress(host) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const done = (address) => { socket.close(); resolve(address); };
    socket.once('error', () => done(null));
    socket.connect(9, host, () => {
      try { done(socket.address().address); } catch { done(null); }
    });
  });
}

function bind(socket, address) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind({ port: 0, ...(address ? { address } : {}) }, () => {
      socket.off('error', reject);
      resolve();
    });
  });
}

export function createWol({ config, log: rootLog, lan }) {
  const log = rootLog.child('wol');

  async function localAddress() {
    const listener = await Promise.resolve(lan?.ready).catch(() => null);
    return listener?.address ?? routeAddress(config.tv.host);
  }

  async function openSocket(address) {
    let socket = dgram.createSocket('udp4');
    try {
      await bind(socket, address);
    } catch (err) {
      socket.close();
      log.warn(`could not bind to the LAN address (${err.code ?? err.message}); sending unbound`);
      socket = dgram.createSocket('udp4');
      await bind(socket, null);
    }
    socket.setBroadcast(true);
    socket.on('error', (err) => log.debug(`wake socket error: ${err.code ?? err.message}`));
    return socket;
  }

  async function wake(mac) {
    if (mac == null) throw new LumenError('UNAVAILABLE', "The TV's network address is not known yet; turn the TV on once with its own remote");
    const hex = typeof mac === 'string' ? mac.replace(/[:-]/g, '') : '';
    if (!MAC.test(mac ?? '') || /^0+$/.test(hex) || /^f+$/i.test(hex)) throw new LumenError('INVALID', 'Invalid MAC address');

    const packet = magicPacket(mac);
    const address = await localAddress();
    const targets = wolTargets(config, address);
    const socket = await openSocket(address);
    let sent = 0;
    try {
      for (let round = 0; round < REPEATS; round++) {
        if (round) await new Promise((r) => setTimeout(r, REPEAT_GAP_MS));
        for (const target of targets) {
          for (const port of config.wol.ports) {
            try {
              await new Promise((resolve, reject) => socket.send(packet, port, target, (err) => (err ? reject(err) : resolve())));
              sent += 1;
            } catch (err) {
              log.debug(`wake packet to ${target}:${port} failed: ${err.code ?? err.message}`);
            }
          }
        }
      }
    } finally {
      socket.close();
    }
    if (!sent) throw new LumenError('FAILED', 'Could not send the wake-up packet');
    log.info(`sent ${sent} wake packets to ${targets.length} target(s)`);
    return { value: { sent } };
  }

  return {
    start() {},
    async stop() {},
    setDemand() {},
    wake,
  };
}
