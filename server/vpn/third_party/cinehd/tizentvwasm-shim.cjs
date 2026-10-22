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
  }
  call(op, args, payload) {
    if (this.failure) throw this.failure;
    const len = payload ? payload.length : 0;
    if (len > DATA_BYTES) throw new SockError(ErrorCodes.EMSGSIZE);
    if (len) this.data.set(payload, 0);
    Atomics.store(this.control, 0, 0);
    this.worker.postMessage(Object.assign({ op, len }, args));
    while (Atomics.load(this.control, 0) === 0) Atomics.wait(this.control, 0, 0, 1000);
    if (Atomics.load(this.control, 0) === 2) throw this.failure || new Error('io worker died');
    const rc = Atomics.load(this.control, 1);
    const out = { rc, len: Atomics.load(this.control, 2), aux: Array.from(this.control.subarray(3, 3 + 60)) };
    if (rc < 0) { this.lastErrno = -rc; if (args && typeof args.fd === 'number') this.perFd.set(args.fd, -rc); throw new SockError(-rc); }
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
    return b.call('create', { family: familyName, type: sockTypeName, nonblock: !!(flags & SockFlags.SOCK_NONBLOCK) }).rc;
  },
  bind(fd, addr) { bridgeInstance().call('bind', { fd, ip: bytesToIp(addr.bytes), port: addr.port }); },
  connect(fd, addr) { bridgeInstance().call('connect', { fd, ip: bytesToIp(addr.bytes), port: addr.port }); },
  listen(fd, backlog) { bridgeInstance().call('listen', { fd, backlog }); },
  accept4(fd) { return bridgeInstance().call('accept', { fd }).rc; },
  accept(fd) { return SocketsManager.accept4(fd, 0); },
  close(fd) { bridgeInstance().call('close', { fd }); },
  send(fd, data, flags) { return bridgeInstance().call('send', { fd, flags }, data).rc; },
  sendTo(fd, data, flags, addr) { return bridgeInstance().call('send', { fd, flags, ip: bytesToIp(addr.bytes), port: addr.port }, data).rc; },
  recv(fd, data, flags) {
    const b = bridgeInstance();
    const out = b.call('recv', { fd, max: data.length, peek: !!(flags & MsgFlags.MSG_PEEK) });
    data.set(b.data.subarray(0, out.len));
    return out.len;
  },
  recvFrom(fd, data, flags) {
    const b = bridgeInstance();
    const out = b.call('recv', { fd, max: data.length, peek: !!(flags & MsgFlags.MSG_PEEK), from: true });
    data.set(b.data.subarray(0, out.len));
    const peerAddress = out.aux[0] > 0 ? new NetAddress('af_inet', Uint8Array.from(out.aux.slice(1, 5)), out.aux[0]) : null;
    return { bytesRead: out.len, peerAddress };
  },
  poll(pollFds, timeout) {
    const b = bridgeInstance();
    const out = b.call('poll', { fds: pollFds.map(p => ({ fd: p.fd, events: p.events })), timeout });
    pollFds.forEach((p, i) => { p.revents = out.aux[i]; });
    return out.rc;
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
