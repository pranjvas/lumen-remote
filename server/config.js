// Configuration (defaults ← data/config.json ← overrides), atomic JSON files under the data
// directory, and the per-install secrets. Secrets and the per-process CSRF token are attached to
// the config object as non-enumerable properties so they never appear when a config is logged.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;

export const DEFAULTS = deepFreeze({
  dataDir: path.join(REPO_ROOT, 'data'),
  tv: {
    host: '192.168.1.2',
    ports: { rest: 8001, wss: 8002, dmr: 9197, ipc: 1516, dial: 8080 },
    clientName: 'Lumen Remote',
  },
  // lanAccess: also serve the UI on this PC's LAN address (phones on the same Wi-Fi). No login by the
  // owner's choice (private network); the Host and Origin checks still block other websites.
  http: { host: '127.0.0.1', port: 8790, lanAccess: false },
  lan: { enabled: true, port: 8791 },
  agent: { appId: 'lumenrmt01.LumenAgent' },
  safety: { volumeCap: 60, powerCooldownMs: 15000, keyGapMs: 120 },
  timing: {
    restVisibleMs: 3000,
    restIdleMs: 15000,
    ipcStatesMs: 2500,
    ipcPictureMs: 4000,
    volumePollVisibleMs: 1000,
    volumePollIdleMs: 10000,
    genaTimeoutS: 1800,
    genaFallbackMs: 8000,
    powerPollMs: 1500,
    powerPollTotalMs: 30000,
    holdRepeatMs: 120,
    holdWatchdogMs: 1500,
    holdMaxMs: 8000,
    reconnectBackoffMs: [1000, 2000, 5000, 10000, 30000],
  },
  wol: { targets: [], ports: [9, 7] },
  ai: { backend: 'auto', model: 'claude-opus-5-5', effort: 'low' },
  // The Browser view's headless Edge (spec §11.3): closed after idleMs without a viewer; frames are
  // JPEGs of at most maxWidth × maxHeight at up to maxFps per viewer.
  browser: {
    // Pages on this PC (127.0.0.1/localhost) are blocked; tests that serve their own pages turn this on.
    allowLoopback: false,
    edgePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    idleMs: 1_200_000,
    maxFps: 15,
    quality: 60,
    maxWidth: 1280,
    maxHeight: 800,
  },
  // Live video of the Lumen browser on the TV (features/livevideo.js): the page captured with its
  // sound, hardware-encoded on this PC and played by the TV agent's MSE player; the JPEG frames stay
  // as the fallback. maxHeight 2160 allows 4K (HEVC when the TV takes it), stepping down to 1080p60
  // and 720p60 when the TV or the link cannot keep up.
  liveVideo: { enabled: true, maxHeight: 2160, preferHevc: true, idleStopMs: 15000, gopSeconds: 2 },
  log: { level: 'info', console: true },
});

export const SECRET_NAMES = Object.freeze(['genaSecret', 'agentKey', 'castSecret', 'mcpToken']);

const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.getPrototypeOf(v) === Object.prototype;

// Recursively merges plain objects; arrays and scalars replace; undefined values are ignored.
export function deepMerge(target, source) {
  if (!isPlainObject(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(target[key])) deepMerge(target[key], value);
    else target[key] = structuredClone(value);
  }
  return target;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Writes JSON to a temp file and renames it into place. Windows briefly locks files that are
// being scanned or indexed, so the rename is retried on EPERM / EBUSY / EACCES.
export function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (err) {
      if (!RETRYABLE_RENAME.has(err.code) || attempt >= RENAME_ATTEMPTS) {
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
        throw err;
      }
      sleepSync(20 * 2 ** (attempt - 1));
    }
  }
}

// JSON files under dataDir. Names are relative ('tv.json', 'icons/x.json') and may not escape it.
// readJson returns `fallback` (default {}) when the file is missing or unreadable.
export function createDataStore(dataDir) {
  const root = path.resolve(dataDir);

  function resolve(name) {
    const file = path.resolve(root, String(name));
    if (!file.startsWith(root + path.sep)) throw new Error(`Invalid data file name: ${name}`);
    return file;
  }

  return {
    dir: root,
    path: resolve,
    readJson(name, fallback = {}) {
      const file = resolve(name);
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return structuredClone(fallback);
      }
    },
    writeJson(name, obj) {
      writeJsonAtomic(resolve(name), obj);
    },
  };
}

// Creates any missing secret (32 random bytes, hex) without touching existing ones.
export function ensureSecrets(data) {
  const saved = data.readJson('secrets.json', {});
  const secrets = isPlainObject(saved) ? { ...saved } : {};
  let changed = false;
  for (const name of SECRET_NAMES) {
    if (typeof secrets[name] === 'string' && secrets[name].length >= 16) continue;
    secrets[name] = randomBytes(32).toString('hex');
    changed = true;
  }
  if (changed) data.writeJson('secrets.json', secrets);
  return Object.freeze(Object.fromEntries(SECRET_NAMES.map((name) => [name, secrets[name]])));
}

export function loadConfig(overrides = {}) {
  const dataDir = path.resolve(overrides.dataDir ?? DEFAULTS.dataDir);
  const data = createDataStore(dataDir);
  const fromFile = data.readJson('config.json', {});
  if (isPlainObject(fromFile)) delete fromFile.dataDir;

  const config = structuredClone(DEFAULTS);
  deepMerge(config, fromFile);
  deepMerge(config, overrides);
  config.dataDir = dataDir;

  Object.defineProperties(config, {
    secrets: { value: ensureSecrets(data), enumerable: false },
    csrf: { value: randomBytes(24).toString('hex'), enumerable: false },
  });
  return config;
}
