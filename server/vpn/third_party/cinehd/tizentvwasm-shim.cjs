'use strict';
/* Node implementation of the `tizentvwasm` namespace that the Samsung Emscripten
 * glue calls (see the TV probe build for the call shapes). The TV extension is
 * synchronous and blocks the Worker thread; here every call is forwarded to an
 * I/O worker thread (tizentvwasm-io-worker.js) and the caller blocks on
 * Atomics.wait until the worker answers, which gives the same semantics.
 *
 * Call shapes mirrored from the glue (probe.js, Samsung Emscripten 1.39.4.7):
 *   SocketsManager.create(familyName, sockTypeName, sockFlags) -> fd
 *   bind(fd, NetAddress) / connect(fd, NetAddress) / listen(fd, backlog) / close(fd)
 *   send(fd, Uint8Array, msgFlags) -> n ; sendTo(fd, Uint8Array, msgFlags, NetAddress) -> n
 *   recv(fd, Uint8Array, msgFlags) -> n ; recvFrom(fd, Uint8Array, msgFlags) -> {bytesRead, peerAddress}
 *   poll([PollFd], timeoutMs) -> count (sets PollFd.revents) ; select(r, w, e, timeoutUSec) -> {getReadFds..}
 *   accept4(fd, flags) -> fd ; getSockName(fd) / getPeerName(fd) -> NetAddress
 *   setSockOpt(fd, levelName, optionName, value) / getSockOpt(fd, levelName, optionName) -> value
 *   shutdown(fd, howName) ; getErrorCode([fd]) -> ErrorCodes value
 *   new HostResolverSync().getHostByName(name) -> {name, getAddrList()} | null, .errorno
 *   NetAddress(family, bytes, port) with .family/.bytes/.port ; PollFd(fd, events) with .revents
 * Errors: every failing call throws; the glue then asks getErrorCode(fd). */
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const DATA_BYTES = 4 * 1024 * 1024;
const CONTROL_WORDS = 128;
const UDP_BATCH = 64; // datagrams per recvmany round trip (wg_poll reads at most 64 per slice)
const OUTBOX_MAX_ITEMS = 128; // queued UDP sends flushed early past this many...
const OUTBOX_MAX_BYTES = 512 * 1024; // ...or this many bytes

const ERRNO_NAMES = ['EPERM', 'ENOENT', 'ESRCH', 'EINTR', 'EIO', 'ENXIO', 'E2BIG', 'ENOEXEC', 'EBADF', 'ECHILD', 'EAGAIN', 'ENOMEM', 'EACCES', 'EFAULT', 'ENOTBLK', 'EBUSY', 'EEXIST', 'EXDEV', 'ENODEV', 'ENOTDIR', 'EISDIR', 'EINVAL', 'ENFILE', 'EMFILE', 'ENOTTY', 'ETXTBSY', 'EFBIG', 'ENOSPC', 'ESPIPE', 'EROFS', 'EMLINK', 'EPIPE', 'EDOM', 'ERANGE', 'EDEADLK', 'ENAMETOOLONG', 'ENOLCK', 'ENOSYS', 'ENOTEMPTY', 'ELOOP', 'EWOULDBLOCK', 'ENOMSG', 'EIDRM', 'ENOSTR', 'ENODATA', 'ETIME', 'ENOSR', 'EREMOTE', 'ENOLINK', 'EPROTO', 'EMULTIHOP', 'EBADMSG', 'EOVERFLOW', 'EILSEQ', 'EUSERS', 'ENOTSOCK', 'EDESTADDRREQ', 'EMSGSIZE', 'EPROTOTYPE', 'ENOPROTOOPT', 'EPROTONOSUPPORT', 'ESOCKTNOSUPPORT', 'EOPNOTSUPP', 'ENOTSUP', 'EPFNOSUPPORT', 'EAFNOSUPPORT', 'EADDRINUSE', 'EADDRNOTAVAIL', 'ENETDOWN', 'ENETUNREACH', 'ENETRESET', 'ECONNABORTED', 'ECONNRESET', 'ENOBUFS', 'EISCONN', 'ENOTCONN', 'ESHUTDOWN', 'ETOOMANYREFS', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTDOWN', 'EHOSTUNREACH', 'EALREADY', 'EINPROGRESS', 'ESTALE', 'EDQUOT', 'ECANCELED', 'EOWNERDEAD', 'ENOTRECOVERABLE', 'ENOMEDIUM', 'EMEDIUMTYPE', 'ENOKEY', 'EKEYEXPIRED', 'EKEYREVOKED', 'EKEYREJECTED', 'ERFKILL', 'EHWPOISON', 'ENOTUNIQ', 'EBADFD', 'EREMCHG', 'ELIBACC', 'ELIBBAD', 'ELIBSCN', 'ELIBMAX', 'ELIBEXEC', 'ERESTART', 'ESTRPIPE', 'EUCLEAN', 'ENOTNAM', 'ENAVAIL', 'EISNAM', 'EREMOTEIO', 'ECHRNG', 'EL2NSYNC', 'EL3HLT', 'EL3RST', 'ELNRNG', 'EUNATCH', 'ENOCSI', 'EL2HLT', 'EBADE', 'EBADR', 'EXFULL', 'ENOANO', 'EBADRQC', 'EBADSLT', 'EBFONT', 'ENONET', 'ENOPKG', 'EADV', 'ESRMNT', 'ECOMM', 'EDOTDOT', 'ENOTUNIQ2'];
// Stable, unique values (Linux-style numbering) independent of the host OS.
const ErrorCodes = {};
ERRNO_NAMES.forEach((name, i) => { ErrorCodes[name] = i + 1; });
ErrorCodes.EWOULDBLOCK = ErrorCodes.EAGAIN;
ErrorCodes.ENOTSUP = ErrorCodes.EOPNOTSUPP;

const PollFlags = { POLLIN: 1, POLLRDNORM: 2, POLLRDBAND: 4, POLLPRI: 8, POLLOUT: 16, POLLWRNORM: 32, POLLWRBAND: 64, POLLERR: 128, POLLHUP: 256, POLLNVAL: 512 };
const MsgFlags = { MSG_OOB: 1, MSG_PEEK: 2, MSG_EOR: 4, MSG_WAITALL: 8, MSG_NOSIGNAL: 16 };
const SockFlags = { SOCK_CLOEXEC: 1, SOCK_NONBLOCK: 2 };

class NetAddress {
  constructor(family, bytes, port) { this.family = family; this.bytes = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes); this.port = port; }
  toString() { return Array.from(this.bytes).join('.') + ':' + this.port; }
}
class InetAddress { constructor(bytes) { this.bytes = Uint8Array.from(bytes); } }
class PollFd { constructor(fd, events) { this.fd = fd; this.events = events; this.revents = 0; } }
class SockOptTimeVal { constructor(sec, usec) { this.sec = sec; this.usec = usec; } }
class IpMreq { constructor(multiaddr, address) { this.multiaddr = multiaddr; this.address = address; } }
class IpMreqSource { constructor(multiaddr, source, address) { this.multiaddr = multiaddr; this.source = source; this.address = address; } }
class Ipv6Mreq { constructor(multiaddr) { this.multiaddr = multiaddr; } }
class SockError extends Error { constructor(errno) { super('tizentvwasm shim errno ' + errno); this.errno = errno; } }
// Lumen: one cached instance per errno. The glue only catches the throw and asks getErrorCode(),
// and an EAGAIN on every empty nonblocking recv made stack capture 2-4.5% of the worker's time.
const SOCK_ERRORS = new Map();
function sockError(errno) {
  let err = SOCK_ERRORS.get(errno);
  if (!err) { err = new SockError(errno); SOCK_ERRORS.set(errno, err); }
  return err;
}

function ipToBytes(ip) { return Uint8Array.from(ip.split('.').map(Number)); }
function bytesToIp(bytes) { return Array.from(bytes.subarray(0, 4)).join('.'); }

class Bridge {
  constructor() {
    this.control = new Int32Array(new SharedArrayBuffer(CONTROL_WORDS * 4));
    this.data = new Uint8Array(new SharedArrayBuffer(DATA_BYTES));
    this.worker = new Worker(path.join(__dirname, 'tizentvwasm-io-worker.cjs'), { workerData: { control: this.control.buffer, data: this.data.buffer, errorCodes: ErrorCodes } });
    this.worker.unref();
    this.ready = false;
    this.worker.on('error', error => { this.failure = error; Atomics.store(this.control, 0, 2); Atomics.notify(this.control, 0); });
    this.lastErrno = 0;
    this.perFd = new Map();
    // Lumen: nonblocking UDP fds skip the per-datagram round trip. Sends are queued here and posted
    // as one 'sendbatch' message ahead of the next synchronous call (postMessage keeps the order);
    // receives are fetched up to UDP_BATCH at a time by one 'recvmany' call and served locally.
    this.udpFds = new Set();
    this.udpRx = new Map(); // fd -> { items: [{ buf, ip, port }], head }
    this.outbox = [];
    this.outboxBytes = 0;
  }
  queueSend(fd, ip, port, data) {
    // Transfer the bytes to the I/O worker; copy unless this view owns its whole (small) buffer.
    const own = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength && !(data.buffer instanceof SharedArrayBuffer) && data.byteLength <= 65536;
    const buf = own ? data : data.slice();
    this.outbox.push({ fd, ip, port, buf });
    this.outboxBytes += buf.length;
    if (this.outbox.length >= OUTBOX_MAX_ITEMS || this.outboxBytes >= OUTBOX_MAX_BYTES) this.flushOutbox();
  }
  flushOutbox() {
    if (!this.outbox.length || this.failure) return;
    const items = this.outbox;
    this.outbox = [];
    this.outboxBytes = 0;
    this.worker.postMessage({ op: 'sendbatch', len: 0, items }, items.map(i => i.buf.buffer));
  }
  // Next queued datagram of a nonblocking UDP fd (fetching a batch when the local queue is empty);
  // throws EAGAIN like recv when nothing has arrived.
  nextDatagram(fd, max, peek) {
    let q = this.udpRx.get(fd);
    if (!q || q.head >= q.items.length) {
      const out = this.call('recvmany', { fd, max, count: UDP_BATCH });
      q = { items: [], head: 0 };
      let off = 0;
      for (let i = 0; i < out.rc; i++) {
        const n = this.data[off] | (this.data[off + 1] << 8);
        const port = this.data[off + 2] | (this.data[off + 3] << 8);
        const ip = this.data.slice(off + 4, off + 8);
        off += 8;
        q.items.push({ buf: this.data.slice(off, off + n), ip, port });
        off += n;
      }
      this.udpRx.set(fd, q);
    }
    const d = q.items[q.head];
    if (!peek) { q.items[q.head] = null; q.head += 1; }
    this.perFd.set(fd, 0);
    return d;
  }
  hasQueuedDatagram(fd) { const q = this.udpRx.get(fd); return !!q && q.head < q.items.length; }
  call(op, args, payload) {
    if (this.failure) throw this.failure;
    if (this.outbox.length) this.flushOutbox();
    const len = payload ? payload.length : 0;
    if (len > DATA_BYTES) throw sockError(ErrorCodes.EMSGSIZE);
    if (len) this.data.set(payload, 0);
    Atomics.store(this.control, 0, 0);
    this.worker.postMessage(Object.assign({ op, len }, args));
    while (Atomics.load(this.control, 0) === 0) Atomics.wait(this.control, 0, 0, 1000);
    if (Atomics.load(this.control, 0) === 2) throw this.failure || new Error('io worker died');
    const rc = Atomics.load(this.control, 1);
    const out = { rc, len: Atomics.load(this.control, 2), aux: this.control.slice(3, 3 + 60) };
    if (rc < 0) { this.lastErrno = -rc; if (args && typeof args.fd === 'number') this.perFd.set(args.fd, -rc); throw sockError(-rc); }
    if (args && typeof args.fd === 'number') this.perFd.set(args.fd, 0);
    return out;
  }
  payloadCopy(len) { return this.data.slice(0, len); }
}

let bridge = null;
function bridgeInstance() { if (!bridge) bridge = new Bridge(); return bridge; }

const SocketsManager = {
  create(familyName, sockTypeName, flags) {
    const b = bridgeInstance();
    const fd = b.call('create', { family: familyName, type: sockTypeName, nonblock: !!(flags & SockFlags.SOCK_NONBLOCK) }).rc;
    if (sockTypeName === 'sock_dgram' && (flags & SockFlags.SOCK_NONBLOCK)) b.udpFds.add(fd);
    return fd;
  },
  bind(fd, addr) { bridgeInstance().call('bind', { fd, ip: bytesToIp(addr.bytes), port: addr.port }); },
  connect(fd, addr) { bridgeInstance().call('connect', { fd, ip: bytesToIp(addr.bytes), port: addr.port }); },
  listen(fd, backlog) { bridgeInstance().call('listen', { fd, backlog }); },
  accept4(fd) { return bridgeInstance().call('accept', { fd }).rc; },
  accept(fd) { return SocketsManager.accept4(fd, 0); },
  close(fd) {
    const b = bridgeInstance();
    b.call('close', { fd }); // flushes queued sends first
    b.udpFds.delete(fd); b.udpRx.delete(fd);
  },
  send(fd, data, flags) { return bridgeInstance().call('send', { fd, flags }, data).rc; },
  sendTo(fd, data, flags, addr) {
    const b = bridgeInstance();
    // A UDP send already answered "sent" before the datagram left (the reply never waited for
    // dgram's callback), so queueing it changes no error the caller could see.
    if (b.udpFds.has(fd)) { b.queueSend(fd, bytesToIp(addr.bytes), addr.port, data); return data.length; }
    return b.call('send', { fd, flags, ip: bytesToIp(addr.bytes), port: addr.port }, data).rc;
  },
  recv(fd, data, flags) {
    const b = bridgeInstance();
    if (b.udpFds.has(fd)) { const d = b.nextDatagram(fd, data.length, !!(flags & MsgFlags.MSG_PEEK)); const n = Math.min(d.buf.length, data.length); data.set(d.buf.subarray(0, n)); return n; }
    const out = b.call('recv', { fd, max: data.length, peek: !!(flags & MsgFlags.MSG_PEEK) });
    data.set(b.data.subarray(0, out.len));
    return out.len;
  },
  recvFrom(fd, data, flags) {
    const b = bridgeInstance();
    if (b.udpFds.has(fd)) {
      const d = b.nextDatagram(fd, data.length, !!(flags & MsgFlags.MSG_PEEK));
      const n = Math.min(d.buf.length, data.length);
      data.set(d.buf.subarray(0, n));
      return { bytesRead: n, peerAddress: new NetAddress('af_inet', d.ip, d.port) };
    }
    const out = b.call('recv', { fd, max: data.length, peek: !!(flags & MsgFlags.MSG_PEEK), from: true });
    data.set(b.data.subarray(0, out.len));
    const peerAddress = out.aux[0] > 0 ? new NetAddress('af_inet', Uint8Array.from(out.aux.slice(1, 5)), out.aux[0]) : null;
    return { bytesRead: out.len, peerAddress };
  },
  poll(pollFds, timeout) {
    const b = bridgeInstance();
    // Datagrams already fetched by recvmany are readable here; the worker is then only probed.
    const local = pollFds.map(p => ((p.events & (PollFlags.POLLIN | PollFlags.POLLRDNORM)) && b.hasQueuedDatagram(p.fd) ? p.events & (PollFlags.POLLIN | PollFlags.POLLRDNORM) : 0));
    const anyLocal = local.some(Boolean);
    const out = b.call('poll', { fds: pollFds.map(p => ({ fd: p.fd, events: p.events })), timeout: anyLocal ? 0 : timeout });
    let count = 0;
    pollFds.forEach((p, i) => { p.revents = out.aux[i] | local[i]; if (p.revents) count++; });
    return count;
  },
  select(readSeq, writeSeq, exceptSeq, timeoutUSec) {
    const fds = new Map();
    for (const fd of readSeq) fds.set(fd, (fds.get(fd) || 0) | PollFlags.POLLIN);
    for (const fd of writeSeq) fds.set(fd, (fds.get(fd) || 0) | PollFlags.POLLOUT);
    for (const fd of exceptSeq) fds.set(fd, (fds.get(fd) || 0) | PollFlags.POLLPRI);
    const list = Array.from(fds, ([fd, events]) => new PollFd(fd, events));
    SocketsManager.poll(list, timeoutUSec < 0 ? -1 : Math.ceil(timeoutUSec / 1000));
    const pick = mask => list.filter(p => p.revents & mask).map(p => p.fd);
    const r = pick(PollFlags.POLLIN | PollFlags.POLLHUP | PollFlags.POLLERR), w = pick(PollFlags.POLLOUT), e = pick(PollFlags.POLLERR | PollFlags.POLLPRI);
    return { getReadFds: () => r, getWriteFds: () => w, getExceptFds: () => e };
  },
  getSockName(fd) { const out = bridgeInstance().call('sockname', { fd }); return new NetAddress('af_inet', Uint8Array.from(out.aux.slice(1, 5)), out.aux[0]); },
  getPeerName(fd) { const out = bridgeInstance().call('peername', { fd }); return new NetAddress('af_inet', Uint8Array.from(out.aux.slice(1, 5)), out.aux[0]); },
  setSockOpt(fd, level, option, value) { bridgeInstance().call('setsockopt', { fd, level, option, value: typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value }); },
  getSockOpt(fd, level, option) { return bridgeInstance().call('getsockopt', { fd, level, option }).rc; },
  shutdown(fd, how) { bridgeInstance().call('shutdown', { fd, how }); },
  getErrorCode(fd) { const b = bridgeInstance(); return typeof fd === 'number' && b.perFd.has(fd) ? b.perFd.get(fd) : b.lastErrno; },
};

class HostResolverSync {
  constructor() { this.errorno = 0; }
  getHostByName(name) {
    try {
      const b = bridgeInstance();
      const out = b.call('resolve', { name });
      const addresses = JSON.parse(Buffer.from(b.payloadCopy(out.len)).toString('utf8'));
      if (!addresses.length) { this.errorno = 1; return null; }
      return { name, getAddrList: () => addresses.map(ip => ({ family: 'af_inet', bytes: ipToBytes(ip) })) };
    } catch (error) { this.errorno = 1; return null; }
  }
}

function installTizenSocketsShim(target) {
  const g = target || globalThis;
  g.tizentvwasm = { SocketsManager, NetAddress, InetAddress, PollFd, PollFlags, MsgFlags, SockFlags, SockOptTimeVal, IpMreq, IpMreqSource, Ipv6Mreq, Ipv: { V4: 'af_inet', V6: 'af_inet6' }, ErrorCodes, HostResolverSync };
  return g.tizentvwasm;
}

function shutdownShim() { if (bridge) { bridge.worker.terminate(); bridge = null; } }

module.exports = { installTizenSocketsShim, shutdownShim, ErrorCodes, PollFlags, MsgFlags, SockFlags, NetAddress, PollFd };
