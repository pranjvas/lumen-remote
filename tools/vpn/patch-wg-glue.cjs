'use strict';
// Lumen's post-processing of the Samsung Emscripten (1.39.4.7) glue, applied after CineHD's own
// tools/patch-glue.cjs (9 anchors) whenever wg-core is rebuilt:
//   node tools/vpn/patch-wg-glue.cjs server/vpn/third_party/wg-core/wg-core.cjs
// Idempotent: an anchor that is already patched is reported and left alone. Recorded in
// server/vpn/third_party/NOTICE.md.
const fs = require('node:fs');

const PATCHES = [
  {
    name: 'blocking poll for socket-only fd sets',
    // ___syscall168 (poll) in this glue is a busy-wait: it probes every fd through
    // stream_ops.poll -> tizentvwasm poll([fd], 0) until the timeout runs out, so wg_poll(20)
    // made ~28,000 synchronous shim round trips per second at idle (one core pinned). The glue
    // already carries a blocking path, SOCKFS.callPoll (one tizentvwasm poll with the real
    // timeout); use it when every fd is a socket, which is always the case for wg-core.
    from: 'function ___syscall168(which,varargs){SYSCALLS.varargs=varargs;try{const start_time=new Date;var fds=SYSCALLS.get(),nfds=SYSCALLS.get(),timeout=SYSCALLS.get();',
    insert: 'if(nfds>0&&SOCKFS.countFDsInPollFDs(fds,nfds).sockets===nfds){return SOCKFS.callPoll(fds,nfds,timeout)}',
  },
];

function patchWgGlue(file) {
  let text = fs.readFileSync(file, 'utf8');
  const applied = [];
  const already = [];
  const missing = [];
  for (const p of PATCHES) {
    if (text.includes(p.from + p.insert)) { already.push(p.name); continue; }
    const parts = text.split(p.from);
    if (parts.length !== 2) { missing.push(`${p.name} (anchor found ${parts.length - 1} times)`); continue; }
    text = parts[0] + p.from + p.insert + parts[1];
    applied.push(p.name);
  }
  if (!missing.length) fs.writeFileSync(file, text);
  return { applied, already, missing };
}

module.exports = { patchWgGlue, PATCHES };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node tools/vpn/patch-wg-glue.cjs <wg-core.cjs>'); process.exit(2); }
  const r = patchWgGlue(file);
  console.log(`${file}: applied ${r.applied.length}, already ${r.already.length}${r.missing.length ? `; MISSING: ${r.missing.join(' | ')}` : ''}`);
  if (r.missing.length) process.exit(1);
}
