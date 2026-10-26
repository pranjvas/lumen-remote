// The release script (tools/release.mjs) on a throwaway repo with a bare "origin" (no GitHub: --no-github):
// it bumps the version, commits, tags vX.Y.Z and pushes; it refuses when the copy is not ready; --dry-run
// changes nothing; --withdraw removes a release tag from origin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve('tools/release.mjs');
let root, origin, repo;
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const release = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--repo', repo, '--no-github'], { encoding: 'utf8' });
const pkgVersion = () => JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const originTags = () => sh(repo, 'ls-remote', '--tags', 'origin').split('\n').filter(Boolean).map((l) => l.split('refs/tags/')[1]).filter((t) => !t.endsWith('^{}'));

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-release-'));
  origin = path.join(root, 'origin.git');
  repo = path.join(root, 'repo');
  sh(root, 'init', '-q', '--bare', '-b', 'master', origin);
  sh(root, 'clone', '-q', origin, repo);
  sh(repo, 'config', 'user.email', 't@example.invalid');
  sh(repo, 'config', 'user.name', 'T');
  sh(repo, 'checkout', '-q', '-B', 'master');
  fs.writeFileSync(path.join(repo, 'package.json'), '{\r\n  "name": "lumen-remote",\r\n  "version": "0.1.0",\r\n  "private": true\r\n}\r\n');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{\r\n  "name": "lumen-remote",\r\n  "version": "0.1.0",\r\n  "lockfileVersion": 3,\r\n  "packages": {\r\n    "": {\r\n      "name": "lumen-remote",\r\n      "version": "0.1.0"\r\n    },\r\n    "node_modules/x": {\r\n      "version": "0.1.0"\r\n    }\r\n  }\r\n}\r\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'first');
  sh(repo, 'push', '-q', 'origin', 'master');
});
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('--dry-run says what it would do and changes nothing', () => {
  const r = release('0.2.0', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /v0\.2\.0/);
  assert.equal(pkgVersion(), '0.1.0');
  assert.deepEqual(originTags(), []);
});

test('a release bumps the version (lockfile too, a dependency\'s own version untouched), commits, tags and pushes', () => {
  const r = release('0.2.0', '--notes', 'First release with updates');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(pkgVersion(), '0.2.0');
  const lock = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, '0.2.0');
  assert.equal(lock.packages[''].version, '0.2.0');
  assert.equal(lock.packages['node_modules/x'].version, '0.1.0');
  assert.match(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'), /\r\n/, 'line endings kept');
  assert.equal(sh(repo, 'log', '-1', '--format=%s'), 'Release v0.2.0');
  assert.equal(sh(repo, 'cat-file', '-t', 'v0.2.0'), 'tag', 'annotated');
  assert.deepEqual(originTags(), ['v0.2.0']);
  assert.equal(sh(repo, 'rev-parse', 'origin/master'), sh(repo, 'rev-parse', 'HEAD'), 'master pushed');
});

test('a release alone changes no dependencies: the update helper does not reinstall for it', async () => {
  const { createGit } = await import('../server/update/git.js');
  assert.equal(await createGit({ cwd: repo }).depsChanged('HEAD~1', 'v0.2.0'), false);
});

test('refuses (and changes nothing) when the copy is not ready or the version is wrong', () => {
  const head = sh(repo, 'rev-parse', 'HEAD');
  for (const [args, why] of [[['0.2.0'], /higher/], [['0.1.9'], /higher/], [['1.2'], /X\.Y\.Z/]]) {
    const r = release(...args);
    assert.equal(r.status, 1, `${args}: ${r.stdout}`);
    assert.match(r.stderr + r.stdout, why);
  }
  fs.writeFileSync(path.join(repo, 'package.json'), fs.readFileSync(path.join(repo, 'package.json'), 'utf8') + ' ');
  let r = release('0.3.0');
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /uncommitted/);
  sh(repo, 'checkout', '-q', '--', 'package.json');

  sh(repo, 'checkout', '-q', '-b', 'side');
  r = release('0.3.0');
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /master/);
  sh(repo, 'checkout', '-q', 'master');

  // Behind origin: someone else pushed.
  const other = path.join(root, 'other');
  sh(root, 'clone', '-q', origin, other);
  sh(other, 'config', 'user.email', 'o@example.invalid');
  sh(other, 'config', 'user.name', 'O');
  fs.writeFileSync(path.join(other, 'x.txt'), 'x');
  sh(other, 'add', 'x.txt');
  sh(other, 'commit', '-q', '-m', 'elsewhere');
  sh(other, 'push', '-q', 'origin', 'master');
  r = release('0.3.0');
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /behind|pull/i);
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(originTags(), ['v0.2.0']);
});

test('--withdraw removes the release tag from origin', () => {
  const r = release('--withdraw', '0.2.0');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(originTags(), []);
});
