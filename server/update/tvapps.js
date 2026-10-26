// TV apps (the Lumen agent and Lumen Eyes) after an update: the versions this copy carries against those the TV
// runs, where this PC's Tizen tooling is, and installing a newer one with it (tools/tvapp-install.ps1:
// build and sign with the app's own build script, then push and install through sdb).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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

// The signing profile the Tizen CLI would use: the active one in the Tizen Studio data folder (sdk.info's
// TIZEN_SDK_DATA_PATH, else %USERPROFILE%\tizen-studio-data) → its name, or null when there is none.
function activeProfile(root, home, readFile) {
  const dataDirs = [];
  try {
    const m = /^TIZEN_SDK_DATA_PATH=(.+)$/m.exec(readFile(path.win32.join(root, 'sdk.info')));
    if (m) dataDirs.push(m[1].trim());
  } catch { /* no sdk.info */ }
  if (home) dataDirs.push(path.win32.join(home, 'tizen-studio-data'));
  for (const dir of dataDirs) {
    try {
      const xml = readFile(path.win32.join(dir, 'profile', 'profiles.xml'));
      const active = /<profiles\b[^>]*\bactive="([^"]+)"/.exec(xml)?.[1];
      if (active && xml.includes(`<profile name="${active}"`)) return active;
    } catch { /* no profiles here */ }
  }
  return null;
}

// dotnet (to build Eyes) on PATH or in its usual folder.
function hasDotnet(env, exists) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  return [...dirs, 'C:\\Program Files\\dotnet'].some((dir) => exists(path.win32.join(dir, 'dotnet.exe')));
}

/** This PC's Tizen CLI, sdb and signing profile: config.tvTooling, else the usual Tizen Studio folders
 *  → { tizenCli, sdb, profile, dotnet } | null (no tooling, or no certificate profile to sign with). */
export function findTooling({ config = {}, env = process.env, exists = fs.existsSync, readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const home = env.USERPROFILE ?? env.HOME ?? '';
  const dotnet = hasDotnet(env, exists);
  const set = config.tvTooling;
  if (set?.tizenCli && set?.sdb && exists(set.tizenCli) && exists(set.sdb)) {
    const profile = set.profile ?? activeProfile(path.win32.dirname(path.win32.dirname(path.win32.dirname(path.win32.dirname(set.tizenCli)))), home, readFile);
    return profile ? { tizenCli: set.tizenCli, sdb: set.sdb, profile, dotnet } : null;
  }
  const roots = ['C:\\tizen-studio', ...(home ? [path.win32.join(home, 'tizen-studio'), path.win32.join(home, 'Documents', 'Codex', 'Tools', 'TizenStudio10')] : [])];
  for (const root of roots) {
    const tizenCli = path.win32.join(root, 'tools', 'ide', 'bin', 'tizen.bat');
    const sdb = path.win32.join(root, 'tools', 'sdb.exe');
    if (!exists(tizenCli) || !exists(sdb)) continue;
    const profile = activeProfile(root, home, readFile);
    if (profile) return { tizenCli, sdb, profile, dotnet };
  }
  return null;
}

/** Whether this tooling can build `app` (Eyes is a .NET app). */
export function canInstall(app, tooling) {
  return Boolean(tooling) && (app !== 'eyes' || tooling.dotnet === true);
}

/** The PowerShell command line for tools/tvapp-install.ps1. */
export function installArgs(app, tooling, { tvHost, repo = REPO_ROOT } = {}) {
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'tools', 'tvapp-install.ps1'),
    '-App', app, '-TizenCli', tooling.tizenCli, '-Sdb', tooling.sdb, '-TvHost', tvHost, ...(tooling.profile ? ['-SigningProfile', tooling.profile] : [])];
}

// A process and everything it started (the build, sdb).
function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** Builds, signs and installs `app` on the TV with tools/tvapp-install.ps1 → { ok, error? }. Ends with the script's
 *  own exit (not its output pipes, which a daemon sdb starts can hold open); one that hangs is stopped with
 *  everything it started after `timeoutMs`. */
export function installTvApp(app, tooling, { tvHost, repo = REPO_ROOT, log, timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn('powershell', installArgs(app, tooling, { tvHost, repo }), { cwd: repo, windowsHide: true });
    let out = '';
    let settled = false;
    const keep = (d) => { out = (out + d).slice(-4000); };
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!result.ok) log?.warn?.('TV app install failed', { app, error: result.error });
      resolve(result);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      killTree(child.pid);
      settle({ ok: false, error: `the install did not finish within ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    child.on('error', (err) => settle({ ok: false, error: err.message }));
    child.on('exit', (code) => {
      // The last output may still be on its way.
      setTimeout(() => {
        if (code === 0) return settle({ ok: true });
        settle({ ok: false, error: out.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? `exit ${code}` });
      }, 200);
    });
  });
}
