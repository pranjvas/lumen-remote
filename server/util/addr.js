// Host and IP address classification shared by the browser (pages on this PC are off-limits) and,
// later, the relay. Copied from features/relay.js, with bareHost stripping every trailing dot
// ("localhost.." is localhost too).
import net from 'node:net';

/** Lower case, without IPv6 brackets or trailing dots: "[::1]" → "::1", "LocalHost.." → "localhost". */
export const bareHost = (host) => String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');

/** IPv6 text → its eight 16-bit groups, or null. */
export function ipv6Groups(text) {
  let s = String(text).replace(/%.*$/, '');
  if (!net.isIPv6(s)) return null;
  const quad = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (quad) {
    const [a, b, c, d] = quad.slice(2).map(Number);
    s = `${quad[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? null : tail ? tail.split(':') : [];
  const groups = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.length === 8 ? groups.map((g) => parseInt(g, 16)) : null;
}

/** An IP address in canonical form (IPv4-mapped / -compatible / NAT64 IPv6 → the IPv4 inside), or null. */
export function canonicalIp(address) {
  const a = bareHost(address);
  if (net.isIPv4(a)) return a;
  const g = ipv6Groups(a);
  if (!g) return null;
  const embedded = (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || (g[5] === 0 && (g[6] || g[7] > 1))))
    || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
  if (embedded) return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  return g.map((x) => x.toString(16)).join(':');
}

/** 'loopback' (this PC), 'private' (LAN, link-local, CGNAT), 'reserved' (multicast, broadcast, 240/4) or null. */
export function addressClass(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127 || a === 0) return 'loopback';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return 'private';
    if (a >= 224) return 'reserved';
    return null;
  }
  const g = ip.split(':').map((x) => parseInt(x, 16));
  if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return 'loopback'; // :: and ::1
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xfe00) === 0xfc00) return 'private'; // link-local, unique-local
  if ((g[0] & 0xff00) === 0xff00) return 'reserved'; // multicast
  return null;
}

const isLocalhostName = (h) => h === 'localhost' || h.endsWith('.localhost');

/**
 * Whether `hostname` (a URL hostname, or a host typed some other way) is this PC itself: localhost and
 * its subdomains (with or without trailing dots), 127/8 and 0.0.0.0, ::1 and ::, and IPv6 forms that
 * carry one of those IPv4 addresses (::ffff:127.0.0.1, [::ffff:7f00:1], ::7f00:1, 64:ff9b::7f00:1).
 * Integer and hex IPv4 forms (2130706433, 0x7f000001, 127.1) count as the address a browser reads them as.
 */
export function isLoopbackHost(hostname) {
  const h = bareHost(hostname);
  if (!h) return false;
  if (isLocalhostName(h)) return true;
  let ip = canonicalIp(h);
  if (!ip) {
    // Not an address as written: the WHATWG host parser reads 0x7f000001, 2130706433 and 127.1 as
    // 127.0.0.1 and decodes %-escapes, as Edge does.
    let parsed;
    try { parsed = bareHost(new URL(`http://${h}/`).hostname); } catch { return false; }
    if (isLocalhostName(parsed)) return true;
    ip = canonicalIp(parsed);
  }
  return !!ip && addressClass(ip) === 'loopback';
}
