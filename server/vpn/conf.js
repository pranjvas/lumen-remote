// WireGuard .conf handling for the in-process tunnel (follow-up 3, port plan §9).
// Mirrors the rules of the wasm core's config.c so anything accepted here starts there,
// and re-serialises a canonical text so comments, device names and unused keys never
// reach the wasm. Error messages never echo a value: keys stay out of logs and state.
import { LumenError } from '../errors.js';

const MAX_CONF_BYTES = 16384;
const MAX_LINE_BYTES = 599;
const DEFAULT_KEEPALIVE = 25;
const KEY_SHAPE = /^[A-Za-z0-9+/]{43}=$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const ENDPOINT_HOST = /^[A-Za-z0-9.-]+$/;
const PEER_HEADER = /^\[\s*peer\s*\]/i;

function invalid(message) {
  return new LumenError('INVALID', message);
}

// 44 chars of standard base64 decoding to exactly 32 bytes.
function isKey(value) {
  return value.length === 44 && KEY_SHAPE.test(value) && Buffer.from(value, 'base64').length === 32;
}

// Dotted IPv4 of an Address/DNS/AllowedIPs entry (an optional /mask is dropped), or null.
function ipv4Of(entry) {
  const host = entry.split('/')[0];
  const match = IPV4.exec(host);
  if (!match || match.slice(1).some((octet) => Number(octet) > 255)) return null;
  return host;
}

function firstIPv4(entries) {
  for (const entry of entries) {
    const ip = ipv4Of(entry);
    if (ip) return ip;
  }
  return null;
}

function splitList(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

// host:port split at the last colon; IPv6 literals are rejected like the core does.
function parseEndpoint(value) {
  const colon = value.lastIndexOf(':');
  if (colon <= 0 || colon === value.length - 1) throw invalid('Endpoint needs host:port');
  const host = value.slice(0, colon);
  const port = value.slice(colon + 1);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw invalid('Endpoint needs host:port');
  if (!ENDPOINT_HOST.test(host)) throw invalid('Endpoint host may only contain letters, digits, dots and dashes');
  return `${host}:${Number(port)}`;
}

function requireKey(name, value) {
  if (!isKey(value)) throw invalid(`${name} is not a 32-byte base64 key`);
  return value;
}

export function parseWireGuardConf(text) {
  if (typeof text !== 'string') throw invalid('config must be text');
  if (Buffer.byteLength(text, 'utf8') > MAX_CONF_BYTES) throw invalid('config is larger than 16 KB');

  const conf = { privateKey: null, address: [], dns: [], peer: { publicKey: null, endpoint: null, allowedIPs: [] } };
  let peers = 0;

  text.split('\n').forEach((raw, index) => {
    if (Buffer.byteLength(raw, 'utf8') > MAX_LINE_BYTES) throw invalid(`line ${index + 1} is longer than 599 bytes`);
    const hash = raw.indexOf('#');
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (!line) return;
    if (line.startsWith('[')) {
      if (PEER_HEADER.test(line) && ++peers > 1) throw invalid('one peer only');
      return;
    }
    const eq = line.indexOf('=');
    if (eq < 0) return;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    switch (key) {
      case 'privatekey': conf.privateKey = requireKey('PrivateKey', value); break;
      case 'publickey': conf.peer.publicKey = requireKey('PublicKey', value); break;
      case 'presharedkey': conf.peer.presharedKey = requireKey('PresharedKey', value); break;
      case 'address': conf.address.push(...splitList(value)); break;
      case 'dns': conf.dns.push(...splitList(value)); break;
      case 'allowedips': conf.peer.allowedIPs.push(...splitList(value)); break;
      case 'endpoint': conf.peer.endpoint = parseEndpoint(value); break;
      case 'persistentkeepalive': {
        const seconds = parseInt(value, 10);
        if (seconds >= 1 && seconds <= 65535) conf.peer.keepalive = seconds;
        break;
      }
      default: // MTU, Table, ListenPort, FwMark, PostUp…: ignored, as in the core
    }
  });

  if (!conf.privateKey) throw invalid('PrivateKey is missing');
  if (!conf.peer.publicKey) throw invalid('PublicKey is missing');
  if (!conf.peer.endpoint) throw invalid('Endpoint needs host:port');
  if (!firstIPv4(conf.address)) throw invalid('Address needs an IPv4 entry');
  if (!firstIPv4(conf.dns)) throw invalid('DNS needs an IPv4 server (names are resolved inside the tunnel)');
  return conf;
}

// Canonical LF text for wg_start: one IPv4 address, one DNS server, the default route and a
// keepalive (a PC behind NAT needs one; the user's value wins when present).
export function serializeWireGuardConf(conf, { keepalive = DEFAULT_KEEPALIVE } = {}) {
  const lines = [
    '[Interface]',
    `PrivateKey = ${conf.privateKey}`,
    `Address = ${firstIPv4(conf.address)}/32`,
    `DNS = ${firstIPv4(conf.dns)}`,
    '[Peer]',
    `PublicKey = ${conf.peer.publicKey}`,
  ];
  if (conf.peer.presharedKey) lines.push(`PresharedKey = ${conf.peer.presharedKey}`);
  lines.push(
    'AllowedIPs = 0.0.0.0/0',
    `Endpoint = ${conf.peer.endpoint}`,
    `PersistentKeepalive = ${conf.peer.keepalive ?? keepalive}`,
  );
  return `${lines.join('\n')}\n`;
}

// The only conf-derived object that may be logged or stored: no key material.
export function summarizeWireGuardConf(conf) {
  return {
    endpoint: conf.peer.endpoint,
    address: firstIPv4(conf.address),
    dns: firstIPv4(conf.dns),
    keepalive: conf.peer.keepalive ?? DEFAULT_KEEPALIVE,
    publicKeyPrefix: conf.peer.publicKey.slice(0, 8),
  };
}
