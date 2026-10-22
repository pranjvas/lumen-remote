// Leveled logger: console + <dir>/lumen.log (rotated at 1 MB, three old files kept).
// Every message and object is redacted first: tokens, keys, MAC-like and UUID-like strings.
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 1024 * 1024;
const KEEP = 3;
const MAX_DEPTH = 6;

const SENSITIVE_KEY = /token|secret|authorization|password|cookie|csrf|agentkey|wifimac|^mac$|^sid$|duid|serial/i;
const STRING_RULES = [
  [/\b(bearer)\s+[\w.~+/=-]+/gi, '$1 [redacted]'],
  [/("(?:[\w-]*(?:token|secret|authorization|key))"\s*:\s*")[^"]*"/gi, '$1[redacted]"'],
  [/((?:key|token|secret)=)[^&\s"',;]+/gi, '$1[redacted]'],
  [/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, '[mac]'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[uuid]'],
  [/\b[0-9a-f]{32,}\b/gi, '[hex]'],
];

export function redactString(text) {
  let out = String(text);
  for (const [pattern, replacement] of STRING_RULES) out = out.replace(pattern, replacement);
  return out;
}

// Deep copy of `value` that is safe to print.
export function redact(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return `<${value.length} bytes>`;
  if (value instanceof Error) {
    const out = { error: redactString(value.message) };
    if (value.code !== undefined) out.code = value.code;
    return out;
  }
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[…]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));
  if (value instanceof Set) return [...value].map((item) => redact(item, depth + 1, seen));
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(child, depth + 1, seen);
  }
  return out;
}

function levelOf(name, fallback) {
  return LEVELS[String(name ?? '').toLowerCase()] ?? fallback;
}

function createFileSink(dir, { maxBytes = MAX_BYTES, keep = KEEP } = {}) {
  const file = path.join(dir, 'lumen.log');
  let fd = null;
  let size = 0;
  let broken = false;

  function open() {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(file, 'a');
    size = fs.fstatSync(fd).size;
  }

  function rotate() {
    fs.closeSync(fd);
    fd = null;
    for (let i = keep - 1; i >= 1; i -= 1) {
      try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* gap in the chain */ }
    }
    try { fs.renameSync(file, `${file}.1`); } catch { /* keep appending to the current file */ }
    open();
  }

  return {
    write(line) {
      if (broken) return;
      try {
        if (fd === null) open();
        const bytes = Buffer.byteLength(line);
        if (size > 0 && size + bytes > maxBytes) rotate();
        fs.writeSync(fd, line);
        size += bytes;
      } catch (err) {
        broken = true;
        console.error(`lumen: file logging disabled (${err.code ?? err.message})`);
      }
    },
    close() {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
      }
      fd = null;
      broken = true;
    },
  };
}

function formatExtra(obj, includeStack) {
  if (obj === undefined) return '';
  const safe = redact(obj);
  if (includeStack && obj instanceof Error && obj.stack) safe.stack = redactString(obj.stack);
  try {
    return ` ${JSON.stringify(safe)}`;
  } catch {
    return ' [unserialisable]';
  }
}

export function createLogger({
  dir,
  level = process.env.LUMEN_LOG_LEVEL ?? 'info',
  console: toConsole = true,
  consoleLevel = process.env.LUMEN_CONSOLE_LEVEL,
  maxBytes,
  keep,
} = {}) {
  const fileMin = levelOf(level, LEVELS.info);
  const consoleMin = levelOf(consoleLevel, fileMin);
  const sink = dir ? createFileSink(dir, { maxBytes, keep }) : null;

  function write(lvl, tag, msg, obj) {
    const rank = LEVELS[lvl];
    const toFile = sink && rank >= fileMin;
    const toTerm = toConsole && rank >= consoleMin;
    if (!toFile && !toTerm) return;
    const now = new Date();
    const head = `${lvl.toUpperCase().padEnd(5)}${tag ? ` [${tag}]` : ''} ${redactString(msg instanceof Error ? msg.message : msg)}`;
    if (toFile) sink.write(`${now.toISOString()} ${head}${formatExtra(obj, rank >= LEVELS.error)}\n`);
    if (toTerm) {
      const line = `${now.toTimeString().slice(0, 8)} ${head}${formatExtra(obj, false)}`;
      (rank >= LEVELS.warn ? console.error : console.log)(line);
    }
  }

  function make(tag) {
    return {
      debug: (msg, obj) => write('debug', tag, msg, obj),
      info: (msg, obj) => write('info', tag, msg, obj),
      warn: (msg, obj) => write('warn', tag, msg, obj),
      error: (msg, obj) => write('error', tag, msg, obj),
      child: (sub) => make(tag ? `${tag}:${sub}` : String(sub)),
    };
  }

  return { ...make(null), close: () => sink?.close() };
}
