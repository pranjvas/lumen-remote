// The updater's view of this copy's git repository. Every git call runs without a console window and
// can never prompt (no terminal prompt, no credential manager dialog): on a collaborator's PC a check
// that needs a login fails and says why instead of popping something up.
import { spawn } from 'node:child_process';
import { compareVersions, versionOfTag } from './versions.js';

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
const TIMEOUT_MS = 60_000;

/** One git command in `cwd` → { code, stdout, stderr } (never rejects except when git cannot start). */
export function runGit(cwd, args, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, env: { ...process.env, ...GIT_ENV } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}

export function createGit({ cwd, run = (args) => runGit(cwd, args) }) {
  async function ok(args) {
    const r = await run(args);
    if (r.code !== 0) throw new Error(r.stderr.split('\n').filter(Boolean).at(-1) || `git ${args[0]} failed`);
    return r.stdout;
  }

  async function versionAt(tag) {
    const r = await run(['show', `${tag}:package.json`]);
    if (r.code !== 0) return null;
    try { return JSON.parse(r.stdout).version ?? null; } catch { return null; }
  }

  return {
    async isRepo() {
      try {
        const r = await run(['rev-parse', '--is-inside-work-tree']);
        return r.code === 0 && r.stdout === 'true';
      } catch {
        return false; // git itself is missing
      }
    },
    /** The checked-out branch, or null on a detached HEAD. */
    async branch() {
      const r = await run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
      return r.code === 0 && r.stdout ? r.stdout : null;
    },
    /** Uncommitted changes to tracked files (untracked files do not count). */
    async isDirty() {
      return (await ok(['status', '--porcelain', '--untracked-files=no'])).length > 0;
    },
    head: () => ok(['rev-parse', 'HEAD']),
    commitOf: (tag) => ok(['rev-parse', `${tag}^{commit}`]),
    /** Tags from origin; tags deleted there (withdrawn releases) are removed here too. */
    async fetchTags() {
      await ok(['fetch', '--quiet', '--tags', '--prune', '--prune-tags', 'origin']);
    },
    versionAt,
    /** Release tags, newest first: vX.Y.Z whose package.json at the tag says X.Y.Z. */
    async releaseTags() {
      const tags = (await ok(['tag', '--list', 'v*'])).split('\n').map((t) => t.trim()).filter((t) => versionOfTag(t));
      const found = [];
      for (const tag of tags) {
        const version = versionOfTag(tag);
        if ((await versionAt(tag)) === version) found.push({ tag, version });
      }
      return found.sort((a, b) => compareVersions(b.version, a.version));
    },
    async isAncestor(a, b) {
      const r = await run(['merge-base', '--is-ancestor', a, b]);
      return r.code === 0;
    },
    /** Whether the dependencies differ between commits a and b: package-lock.json without its own version
     *  (which every release bumps), so only a real dependency change needs `npm ci`. */
    async depsChanged(a, b) {
      const deps = async (commit) => {
        const r = await run(['show', `${commit}:package-lock.json`]);
        if (r.code !== 0) return null;
        try {
          const lock = JSON.parse(r.stdout);
          delete lock.version;
          if (lock.packages?.['']) delete lock.packages[''].version;
          return JSON.stringify(lock);
        } catch {
          return r.stdout;
        }
      };
      return (await deps(a)) !== (await deps(b));
    },
    fastForward: (tag) => ok(['merge', '--ff-only', '--quiet', tag]),
    /** Back to `sha` keeping local edits; refuses (throws) rather than overwrite an edited file. */
    resetKeep: (sha) => ok(['reset', '--keep', '--quiet', sha]),
    /** Puts the working tree's changes in a stash named `message` (recoverable, never deleted). */
    setAside: (message) => ok(['stash', 'push', '--quiet', '-m', message]),
  };
}
