// tools/start-hidden.js (how Lumen starts at sign-in): it starts server/index.js in the background, and first puts
// back a node_modules an update set aside (node_modules.lumen-prev) when an interrupted update left none.
// Run on a copy of the script in a throwaway folder with a stand-in server that only writes a file.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function copy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-start-hidden-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'tools'));
  fs.mkdirSync(path.join(root, 'server'));
  fs.copyFileSync(path.resolve('tools/start-hidden.js'), path.join(root, 'tools', 'start-hidden.js'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'server', 'index.js'), `import fs from 'node:fs';
fs.writeFileSync(new URL('../started.txt', import.meta.url), fs.existsSync(new URL('../node_modules/marker.txt', import.meta.url)) ? 'with modules' : 'without modules');`);
  return root;
}
async function startedText(root) {
  const file = path.join(root, 'started.txt');
  for (let i = 0; i < 50 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 100));
  return fs.readFileSync(file, 'utf8');
}

test('an update interrupted with node_modules set aside: it is put back before Lumen starts', async () => {
  const root = copy();
  fs.mkdirSync(path.join(root, 'node_modules.lumen-prev'));
  fs.writeFileSync(path.join(root, 'node_modules.lumen-prev', 'marker.txt'), 'previous install');
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'start-hidden.js')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await startedText(root), 'with modules');
  assert.equal(fs.existsSync(path.join(root, 'node_modules.lumen-prev')), false);
});

test('a normal start leaves node_modules and a set-aside copy alone', async () => {
  const root = copy();
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'marker.txt'), 'current');
  fs.mkdirSync(path.join(root, 'node_modules.lumen-prev'));
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'start-hidden.js')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await startedText(root), 'with modules');
  assert.equal(fs.readFileSync(path.join(root, 'node_modules', 'marker.txt'), 'utf8'), 'current');
  assert.equal(fs.existsSync(path.join(root, 'node_modules.lumen-prev')), true, 'an update in progress owns it');
});
