// TV apps (the Lumen agent and Lumen Eyes) after an update: the versions this copy carries against those the TV
// runs, where this PC's Tizen tooling is, and installing a newer one with it (tools/tvapp-install.ps1:
// build and sign with the app's own build script, then push and install through sdb).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT } from '../config.js';
import { compareVersions, parseVersion } from './versions.js';

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
export const TV_APPS = ['agent', 'eyes'];

/** The versions in this copy's app manifests → { agent, eyes } (null when unreadable). */
export function repoVersions(repo = REPO_ROOT) {
  const read = (file) => { try { return fs.readFileSync(path.join(repo, file), 'utf8'); } catch { return ''; } };
  return {
    agent: /<widget\b[^>]*\bversion="(\d+\.\d+\.\d+)"/.exec(read('companion/agent/config.xml'))?.[1] ?? null,
    eyes: /<manifest\b[^>]*\bversion="(\d+\.\d+\.\d+)"/.exec(read('companion/eyes/tizen-manifest.xml'))?.[1] ?? null,
  };
}

/** Apps whose TV version is known and older than this copy's → [{ app, from, to }]. */
export function tvAppUpdates({ repo, connected }) {
  return TV_APPS
    .filter((app) => parseVersion(repo?.[app]) && parseVersion(connected?.[app]) && compareVersions(repo[app], connected[app]) > 0)
    .map((app) => ({ app, from: connected[app], to: repo[app] }));
}

/** This PC's Tizen CLI and sdb: config.tvTooling, else the usual Tizen Studio folders → { tizenCli, sdb } | null. */
export function findTooling({ config = {}, env = process.env, exists = fs.existsSync } = {}) {
  const set = config.tvTooling;
  if (set?.tizenCli && set?.sdb && exists(set.tizenCli) && exists(set.sdb)) return { tizenCli: set.tizenCli, sdb: set.sdb };
  const home = env.USERPROFILE ?? env.HOME ?? '';
  const roots = ['C:\\tizen-studio', ...(home ? [path.win32.join(home, 'tizen-studio'), path.win32.join(home, 'Documents', 'Codex', 'Tools', 'TizenStudio10')] : [])];
  for (const root of roots) {
    const tizenCli = path.win32.join(root, 'tools', 'ide', 'bin', 'tizen.bat');
    const sdb = path.win32.join(root, 'tools', 'sdb.exe');
    if (exists(tizenCli) && exists(sdb)) return { tizenCli, sdb };
  }
  return null;
}

/** Builds, signs and installs `app` on the TV with tools/tvapp-install.ps1 → { ok, error? }. */
export function installTvApp(app, tooling, { tvHost, repo = REPO_ROOT, log } = {}) {
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'tools', 'tvapp-install.ps1'),
      '-App', app, '-TizenCli', tooling.tizenCli, '-Sdb', tooling.sdb, '-TvHost', tvHost], { cwd: repo, windowsHide: true });
    let out = '';
    const keep = (d) => { out = (out + d).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true });
      const last = out.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? `exit ${code}`;
      log?.warn?.('TV app install failed', { app, error: last });
      resolve({ ok: false, error: last });
    });
  });
}
