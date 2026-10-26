// The updater's version helpers and git layer (server/update/versions.js, server/update/git.js), against a
// throwaway bare "origin" and a clone of it in the temp folder: release tags (only those whose package.json
// says the same version), pruned withdrawals, dirty trees, branches and fast-forward checks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions, parseVersion, tagFor } from '../server/update/versions.js';
import { createGit } from '../server/update/git.js';

let root, origin, work;
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commitVersion(version, message = `version ${version}`) {
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'lumen-remote', version }, null, 2));
  sh(work, 'add', 'package.json');
  sh(work, 'commit', '-q', '-m', message);
  return sh(work, 'rev-parse', 'HEAD');
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-update-git-'));
  origin = path.join(root, 'origin.git');
  work = path.join(root, 'work');
  sh(root, 'init', '-q', '--bare', '-b', 'master', origin);
  sh(root, 'clone', '-q', origin, work);
  sh(work, 'config', 'user.email', 'test@example.invalid');
  sh(work, 'config', 'user.name', 'Test');
  sh(work, 'checkout', '-q', '-B', 'master');
  commitVersion('0.1.0');
  sh(work, 'push', '-q', 'origin', 'master');
});
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('versions: parse, compare and name tags', () => {
  assert.deepEqual(parseVersion('0.10.2'), [0, 10, 2]);
  assert.equal(parseVersion('v1.2'), null);
  assert.equal(parseVersion('1.2.3-beta'), null);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1);
  assert.equal(tagFor('0.2.0'), 'v0.2.0');
});

test('release tags: only vX.Y.Z tags whose package.json says that version count; withdrawn ones are pruned', async () => {
  const git = createGit({ cwd: work });
  assert.equal(await git.isRepo(), true);
  // In a separate clone (the owner's), two tags: a proper release and a stray tag on an unbumped commit.
  const owner = path.join(root, 'owner');
  sh(root, 'clone', '-q', origin, owner);
  sh(owner, 'config', 'user.email', 'o@example.invalid');
  sh(owner, 'config', 'user.name', 'Owner');
  fs.writeFileSync(path.join(owner, 'package.json'), JSON.stringify({ name: 'lumen-remote', version: '0.2.0' }));
  sh(owner, 'commit', '-q', '-am', 'Release v0.2.0');
  sh(owner, 'tag', '-a', 'v0.2.0', '-m', 'v0.2.0');
  fs.writeFileSync(path.join(owner, 'notes.txt'), 'x');
  sh(owner, 'add', 'notes.txt');
  sh(owner, 'commit', '-q', '-m', 'unreleased work');
  sh(owner, 'tag', 'v0.3.0'); // package.json still says 0.2.0
  sh(owner, 'push', '-q', 'origin', 'master', '--tags');

  await git.fetchTags();
  assert.deepEqual(await git.releaseTags(), [{ tag: 'v0.2.0', version: '0.2.0' }]);
  assert.equal(await git.versionAt('v0.2.0'), '0.2.0');

  // Withdrawn: deleted on origin, gone here after the next fetch.
  sh(owner, 'push', '-q', 'origin', ':refs/tags/v0.2.0');
  await git.fetchTags();
  assert.deepEqual(await git.releaseTags(), []);
});

test('dirty tree, branch, ancestry and fast-forward', async () => {
  const git = createGit({ cwd: work });
  assert.equal(await git.branch(), 'master');
  assert.equal(await git.isDirty(), false);
  fs.writeFileSync(path.join(work, 'untracked.txt'), 'only untracked');
  assert.equal(await git.isDirty(), false, 'untracked files do not count');
  fs.writeFileSync(path.join(work, 'package.json'), '{"version":"9.9.9"}');
  assert.equal(await git.isDirty(), true);
  sh(work, 'checkout', '-q', '--', 'package.json');

  // A release ahead of this copy: an ancestor check passes and a fast-forward reaches it.
  const owner = path.join(root, 'owner');
  fs.writeFileSync(path.join(owner, 'package.json'), JSON.stringify({ name: 'lumen-remote', version: '0.4.0' }));
  sh(owner, 'commit', '-q', '-am', 'Release v0.4.0');
  sh(owner, 'tag', '-a', 'v0.4.0', '-m', 'v0.4.0');
  sh(owner, 'push', '-q', 'origin', 'master', '--tags');
  await git.fetchTags();
  const head = await git.head();
  const tagCommit = await git.commitOf('v0.4.0');
  assert.equal(await git.isAncestor(head, tagCommit), true);
  assert.equal(await git.depsChanged(head, tagCommit), false, 'no package-lock.json on either side');
  await git.fastForward('v0.4.0');
  assert.equal(await git.head(), tagCommit);
  await git.resetKeep(head);
  assert.equal(await git.head(), head);

  // This copy with its own commit is not an ancestor of the release.
  fs.writeFileSync(path.join(work, 'local.txt'), 'local work');
  sh(work, 'add', 'local.txt');
  sh(work, 'commit', '-q', '-m', 'local work');
  assert.equal(await git.isAncestor(await git.head(), tagCommit), false);

  sh(work, 'checkout', '-q', '--detach');
  assert.equal(await git.branch(), null, 'detached HEAD');
  sh(work, 'checkout', '-q', 'master');
});

test('not a git copy, and a fetch that fails, are reported rather than thrown away', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-update-plain-'));
  try {
    assert.equal(await createGit({ cwd: plain }).isRepo(), false);
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
  const lost = path.join(root, 'lost');
  sh(root, 'clone', '-q', origin, lost);
  sh(lost, 'remote', 'set-url', 'origin', path.join(root, 'no-such-origin.git'));
  await assert.rejects(createGit({ cwd: lost }).fetchTags(), (err) => /origin|repository|not found|does not appear/i.test(err.message));
});

function scratchRepo(name) {
  const dir = path.join(root, name);
  sh(root, 'init', '-q', '-b', 'master', dir);
  sh(dir, 'config', 'user.email', 'test@example.invalid');
  sh(dir, 'config', 'user.name', 'Test');
  const commit = (files, message) => {
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', message);
    return sh(dir, 'rev-parse', 'HEAD');
  };
  return { dir, commit };
}

test('dependencies changed: package-lock.json compared without its own version, so a release bump alone is no change', async () => {
  const { dir, commit } = scratchRepo('deps');
  const lock = (v, ws) => JSON.stringify({ name: 'lumen-remote', version: v, lockfileVersion: 3, requires: true, packages: {
    '': { name: 'lumen-remote', version: v, dependencies: { ws: `^${ws}` } }, 'node_modules/ws': { version: ws } } }, null, 2);
  const none = commit({ 'README.md': 'x' }, 'no lockfile yet');
  const a = commit({ 'package-lock.json': lock('0.1.0', '8.0.0') }, 'lock');
  const b = commit({ 'package-lock.json': lock('0.2.0', '8.0.0') }, 'Release v0.2.0');
  const c = commit({ 'package-lock.json': lock('0.2.0', '8.1.0') }, 'ws 8.1.0');
  const git = createGit({ cwd: dir });
  assert.equal(await git.depsChanged(a, b), false, 'only the version bump');
  assert.equal(await git.depsChanged(b, c), true, 'a dependency changed');
  assert.equal(await git.depsChanged(a, c), true);
  assert.equal(await git.depsChanged(none, a), true, 'a lockfile appeared');
  assert.equal(await git.depsChanged(none, none), false);
});

test('going back keeps local edits: a file the move does not touch stays edited, and an edited file it would overwrite stops it', async () => {
  const { dir, commit } = scratchRepo('keep');
  const c1 = commit({ 'a.txt': '1', 'b.txt': '1' }, 'one');
  const c2 = commit({ 'a.txt': '2' }, 'two');
  const git = createGit({ cwd: dir });
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'edited');
  await git.resetKeep(c1);
  assert.equal(await git.head(), c1);
  assert.equal(read('a.txt'), '1');
  assert.equal(read('b.txt'), 'edited', 'the edit survives going back');
  sh(dir, 'reset', '-q', '--keep', c2);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'mine');
  await assert.rejects(git.resetKeep(c1));
  assert.equal(read('a.txt'), 'mine', 'never overwritten');
  assert.equal(await git.head(), c2);
});

test('what a failed move left in the working tree is set aside (git stash), not deleted', async () => {
  const { dir, commit } = scratchRepo('aside');
  commit({ 'a.txt': '1' }, 'one');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'half-written');
  const git = createGit({ cwd: dir });
  await git.setAside('Lumen update: left by a failed move');
  assert.equal(await git.isDirty(), false);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), '1');
  assert.match(sh(dir, 'stash', 'list'), /Lumen update: left by a failed move/);
  assert.match(sh(dir, 'stash', 'show', '-p'), /half-written/);
});

test('a file as it is in a commit (null when it is not there), and the files a commit range adds', async () => {
  const { dir, commit } = scratchRepo('files');
  const a = commit({ 'package.json': '{"version":"0.1.0"}' }, 'one');
  const b = commit({ 'package.json': '{"version":"0.2.0"}', 'new.txt': 'n', 'lib.js': 'x' }, 'two');
  const git = createGit({ cwd: dir });
  assert.equal(await git.fileAt(a, 'package.json'), '{"version":"0.1.0"}');
  assert.equal(await git.fileAt(a, 'package-lock.json'), null);
  assert.deepEqual((await git.addedFiles(a, b)).sort(), ['lib.js', 'new.txt']);
  assert.deepEqual(await git.addedFiles(b, b), []);
});
