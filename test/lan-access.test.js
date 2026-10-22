// http.lanAccess: the UI is also served on the PC's LAN address (owner's choice, no login), while the
// Host and Origin allowlists keep blocking other sites. In tests the TV is 127.0.0.1, so the LAN
// address the server discovers is 127.0.0.1 too.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, request, tryUpgrade } from './helpers.js';

describe('LAN access', () => {
  let stack;
  before(async () => {
    stack = await startStack({ config: { http: { lanAccess: true } } });
  });
  after(() => stack?.stop());

  test('the server reports a phone URL on the LAN address and listens on all interfaces', () => {
    assert.equal(stack.server.lanUrl, `http://127.0.0.1:${stack.httpPort}`);
  });

  test('the LAN host is served; foreign hosts and origins are still refused', async () => {
    const port = stack.httpPort;
    const ok = await request({ port, path: '/api/health', headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(ok.status, 200);
    const foreign = await request({ port, path: '/api/health', headers: { Host: `attacker.example:${port}` } });
    assert.equal(foreign.status, 421);
    assert.equal((await tryUpgrade(port, { origin: `http://127.0.0.1:${port}` })).status, 101);
    assert.equal((await tryUpgrade(port, { origin: 'http://evil.example' })).status, 403);
  });

  test('without lanAccess there is no phone URL', async () => {
    const plain = await startStack();
    try {
      assert.equal(plain.server.lanUrl, null);
    } finally {
      await plain.stop();
    }
  });
});
