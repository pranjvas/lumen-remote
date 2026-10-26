// Publishes a Lumen release: every copy's updater (server/features/updater.js) picks up tags vX.Y.Z whose
// package.json says X.Y.Z. A push to master alone ships nothing.
//   npm run release -- 0.2.0 [--notes "text"] [--dry-run]     bump, commit, tag, push, GitHub Release
//   npm run release -- --withdraw 0.2.0 [--dry-run]           delete the tag (and its GitHub Release)
// Copies that already run a withdrawn release keep it (no downgrades): publish a newer one to fix it.
// --repo <dir> and --no-github are for tests.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, parseVersion, tagFor, versionOfTag } from '../server/update/versions.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const repo = path.resolve(opt('repo') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const dryRun = flag('dry-run');
const github = !flag('no-github');

const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}
function step(text, run) {
  console.log(`${dryRun ? '[dry run] ' : ''}${text}`);
  if (!dryRun) run();
}
function gh(...a) {
  const r = spawnSync('gh', a, { cwd: repo, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `gh ${a[0]} failed`).trim());
  return r.stdout.trim();
}
// The first `count` "version": "<from>" in `file` become `to`, keeping the file's own formatting and line endings.
function bump(file, from, to, count) {
  const full = path.join(repo, file);
  if (!fs.existsSync(full)) return;
  let left = count;
  const text = fs.readFileSync(full, 'utf8').replace(new RegExp(`("version"\\s*:\\s*")${from.replace(/\./g, '\\.')}(")`, 'g'), (m, a, b) => (left-- > 0 ? `${a}${to}${b}` : m));
  fs.writeFileSync(full, text);
}

function withdraw(version) {
  if (!parseVersion(version)) fail('the version must be X.Y.Z');
  const tag = tagFor(version);
  step(`delete tag ${tag} on origin`, () => git('push', '--quiet', 'origin', `:refs/tags/${tag}`));
  step(`delete local tag ${tag}`, () => { try { git('tag', '-d', tag); } catch { /* not here */ } });
  if (github) step(`delete the GitHub Release ${tag}`, () => { try { gh('release', 'delete', tag, '--yes'); } catch (err) { console.log(`  (no GitHub Release removed: ${err.message})`); } });
  console.log(`${tag} withdrawn: copies that have not installed it will not.`);
}

function publish(version) {
  if (!parseVersion(version)) fail('the version must be X.Y.Z, e.g. 0.2.0');
  const current = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
  if (compareVersions(version, current) <= 0) fail(`${version} must be higher than the current version ${current}`);
  if (git('status', '--porcelain', '--untracked-files=no')) fail('there are uncommitted changes; commit or stash them first');
  const branch = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  if (branch !== 'master') fail(`releases are made from master (this copy is on ${branch || 'a detached HEAD'})`);
  git('fetch', '--quiet', 'origin');
  if (Number(git('rev-list', '--count', 'HEAD..origin/master')) > 0) fail('master is behind origin/master; pull first');
  const tag = tagFor(version);
  if (git('tag', '--list', tag)) fail(`${tag} already exists`);

  const previous = git('tag', '--list', 'v*').split('\n').map((t) => t.trim()).filter((t) => versionOfTag(t))
    .sort((a, b) => compareVersions(versionOfTag(b), versionOfTag(a)))[0];
  const notes = opt('notes') ?? (git('log', '--format=- %s', ...(previous ? [`${previous}..HEAD`] : ['-20', 'HEAD'])) || '- Maintenance');

  step(`set version ${current} -> ${version} in package.json and package-lock.json`, () => {
    bump('package.json', current, version, 1);
    bump('package-lock.json', current, version, 2); // the lockfile's own version and packages[""]
  });
  step(`commit "Release ${tag}"`, () => { git('add', 'package.json', ...(fs.existsSync(path.join(repo, 'package-lock.json')) ? ['package-lock.json'] : [])); git('commit', '--quiet', '-m', `Release ${tag}`); });
  step(`tag ${tag}`, () => git('tag', '-a', tag, '-m', `Lumen ${tag}`));
  step('push master and the tag', () => { git('push', '--quiet', 'origin', 'master'); git('push', '--quiet', 'origin', tag); });
  if (github) {
    step(`create the GitHub Release ${tag}`, () => {
      const file = path.join(os.tmpdir(), `lumen-release-notes-${process.pid}.md`);
      fs.writeFileSync(file, notes);
      try { gh('release', 'create', tag, '--title', `Lumen ${tag}`, '--notes-file', file); } finally { fs.rmSync(file, { force: true }); }
    });
  }
  console.log(`${dryRun ? 'Would release' : 'Released'} ${tag}. Notes:\n${notes}`);
}

const w = opt('withdraw');
if (w) withdraw(w);
else {
  const version = args.find((a, i) => !a.startsWith('--') && !['--notes', '--repo', '--withdraw'].includes(args[i - 1]));
  if (!version) fail('usage: npm run release -- <X.Y.Z> [--notes "text"] [--dry-run] | --withdraw <X.Y.Z>');
  publish(version);
}
