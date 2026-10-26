// Starts the Lumen server in the background with no console window; its output is appended
// to data/logs/stdout.log. Used by the Startup-folder shortcut (tools/install-autostart.ps1).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'data', 'logs');
const OUT = path.join(LOG_DIR, 'stdout.log');
const MAX_OUT_BYTES = 5 * 1024 * 1024;

// An update interrupted between setting the previous node_modules aside and putting the new one in place
// (tools/update-apply.js) leaves none: put the previous one back so Lumen can start.
const MODULES = path.join(ROOT, 'node_modules');
const KEPT_MODULES = path.join(ROOT, 'node_modules.lumen-prev');
if (!fs.existsSync(MODULES) && fs.existsSync(KEPT_MODULES)) {
  try { fs.renameSync(KEPT_MODULES, MODULES); } catch { /* Lumen will say what is missing */ }
}

fs.mkdirSync(LOG_DIR, { recursive: true });
try {
  if (fs.statSync(OUT).size > MAX_OUT_BYTES) fs.renameSync(OUT, `${OUT}.1`);
} catch {
  // no previous output yet
}

const out = fs.openSync(OUT, 'a');
fs.writeSync(out, `\n--- ${new Date().toISOString()} starting Lumen ---\n`);
const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  cwd: ROOT,
  detached: true,
  windowsHide: true,
  stdio: ['ignore', out, out],
  // The detailed log is data/logs/lumen.log; the console copy only needs warnings.
  env: { ...process.env, LUMEN_CONSOLE_LEVEL: process.env.LUMEN_CONSOLE_LEVEL ?? 'warn' },
});
child.unref();
fs.closeSync(out);
console.log(`Lumen started in the background (pid ${child.pid}); output goes to ${OUT}`);
