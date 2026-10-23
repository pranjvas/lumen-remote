// The Tizen agent's CSP (companion/agent/config.xml): its in-page player may fetch only from Lumen's
// TV-facing relay port, never the whole http: scheme (which would let an unrewritten playlist URI go
// from the TV straight to the stream host, outside the VPN).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULTS } from '../server/config.js';

const xml = fs.readFileSync(new URL('../companion/agent/config.xml', import.meta.url), 'utf8');
const csp = /<tizen:content-security-policy>([^<]*)<\/tizen:content-security-policy>/.exec(xml)?.[1] ?? '';
const directive = (name) => csp.split(';').map((d) => d.trim().split(/\s+/)).find(([n]) => n === name)?.slice(1) ?? null;

test('agent CSP: connect-src and media-src allow only the relay port over http', () => {
  assert.ok(csp, 'config.xml has a CSP');
  const relay = `http://*:${DEFAULTS.lan.port}`;
  for (const name of ['connect-src', 'media-src']) {
    const sources = directive(name);
    assert.ok(sources, `${name} is set`);
    assert.ok(sources.includes(relay), `${name} allows the relay (${relay})`);
    for (const s of sources) {
      assert.ok(!['http:', 'https:', '*', 'http://*', 'https://*'].includes(s), `${name} must not allow ${s}`);
      if (/^https?:\/\//.test(s)) assert.equal(s, relay, `${name}: ${s} is not the relay origin`);
    }
  }
  assert.deepEqual(directive('object-src'), ["'none'"]);
});
