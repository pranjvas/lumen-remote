// tools/tvapp-install.ps1 (the updater's TV app install) with a stand-in sdb and an already built package: it must
// survive sdb writing to stderr (it does when it starts its server) under Windows PowerShell 5.1, connect, push and
// check vd_appinstall's answer. Windows only (it runs powershell.exe).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = process.env.TVAPP_INSTALL_SCRIPT ?? path.resolve('tools/tvapp-install.ps1');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tvapp-install-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// The stand-in sdb: `devices` warns on stderr as a starting sdb server does; `shell … vd_appinstall` answers as the
// TV does (or fails when FAKE_SDB_FAIL is set). Every call goes to calls.log.
fs.writeFileSync(path.join(dir, 'fakesdb.js'), `const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.log'))}, a.join(' ') + '\\n');
if (a[0] === 'devices') { process.stderr.write('* server not running. starting it now on port 26099 *\\n'); console.log('List of devices attached'); }
else if (a[0] === 'connect') console.log('connected to ' + a[1]);
else if (a[2] === 'push') console.log('1 file(s) pushed');
else if (a[2] === 'shell') console.log(process.env.FAKE_SDB_FAIL ? 'app_id[' + a[5] + '] install failed[118]' : 'app_id[' + a[5] + '] install completed');
`);
const sdb = path.join(dir, 'sdb.cmd');
fs.writeFileSync(sdb, `@"${process.execPath}" "%~dp0fakesdb.js" %*\r\n`);
const pkg = path.join(dir, 'LumenAgent.wgt');
fs.writeFileSync(pkg, 'not really a widget');

function install(env = {}) {
  return spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-App', 'agent', '-TizenCli', 'unused.bat',
    '-Sdb', sdb, '-TvHost', '10.0.0.9', '-Package', pkg], { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
}

test('installs through sdb even when sdb writes to stderr', { skip: process.platform !== 'win32' }, () => {
  const r = install();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /agent installed/);
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8');
  assert.match(calls, /^connect 10\.0\.0\.9:26101$/m);
  assert.match(calls, /^-s 10\.0\.0\.9:26101 push .*LumenAgent\.wgt \/home\/owner\/share\/tmp\/sdk_tools\/tmp\/LumenAgent\.wgt$/m);
  assert.match(calls, /^-s 10\.0\.0\.9:26101 shell 0 vd_appinstall lumenrmt01\.LumenAgent /m);
});

test('a TV that refuses the install fails the script', { skip: process.platform !== 'win32' }, () => {
  const r = install({ FAKE_SDB_FAIL: '1' });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /agent installed/);
});
