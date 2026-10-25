// The TV agent starting again by itself: it quits when the TV sleeps (or the TV closes it for memory),
// and channel, input and app updates stop with it (seen 25 Oct). While a phone shows Lumen and the TV
// is on, an offline agent is launched again, never over another app (the TV is asked about every app
// first), at most once per 10 minutes.
// Mock TV and fake agents (no TV, no Edge).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AGENT_APP = 'lumenrmt01.LumenAgent';

describe('the TV agent starting again by itself', () => {
  let stack, b;
  const launches = () => stack.mock.state.launches.filter((l) => l.appId === AGENT_APP).length;
  const ok = (ack) => { assert.equal(ack.ok, true, JSON.stringify(ack.error)); return ack.value; };

  before(async () => {
    stack = await startStack();
    b = stack.browser();
    await b.hello;
  });
  after(async () => { await stack?.stop(); });

  async function agentGoes() {
    const a = stack.agent({});
    await b.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
    a.close();
    await b.waitForState('conn.agent', (r) => r?.v !== 'online', { timeout: 10000 });
  }

  test('nobody looking: an agent that goes away is left alone', async () => {
    ok(await b.send('view', { name: 'remote', visible: false })); // the phone app in the background
    stack.mock.setForeground(null);
    const before = launches();
    await agentGoes();
    await sleep(800);
    assert.equal(launches(), before);
  });

  test('a phone opens Lumen: not over another app; opened again back on TV it starts, then not again within 10 minutes', async () => {
    const before = launches();
    // YouTube in front, opened with the TV remote: Lumen's polled foreground has not seen it yet (it
    // still says nothing is in front), so the TV is asked about every app before anything is launched.
    stack.server.store.set('app.foreground', null, { src: 'live', via: 'test', ttlMs: 15000 });
    stack.mock.setForeground('111299001912');
    ok(await b.send('view', { name: 'remote', visible: true })); // the phone opens Lumen
    await b.waitForState('app.foreground', (r) => !!r?.v, { timeout: 8000 });
    await sleep(800);
    assert.equal(launches(), before, 'not over YouTube');
    stack.mock.setForeground(null); // back on the TV's own picture; the phone app opens again
    ok(await b.send('view', { name: 'remote', visible: false }));
    ok(await b.send('view', { name: 'remote', visible: true }));
    await waitFor(() => launches() === before + 1, { timeout: 8000, message: 'the agent launched once back on TV' });
    // It connects, then goes away again (the TV closed it): within 10 minutes nothing more is launched.
    stack.mock.setForeground(null);
    await agentGoes();
    await sleep(800);
    assert.equal(launches(), before + 1, 'at most once per 10 minutes');
  });

  test('the TV wakes with a phone showing Lumen: the agent that quit at standby starts again', async () => {
    // A fresh stack: the 10-minute limit of the test before does not apply.
    const own = await startStack();
    try {
      const phone = own.browser();
      await phone.hello;
      const count = () => own.mock.state.launches.filter((l) => l.appId === AGENT_APP).length;
      const a = own.agent({});
      await phone.waitForState('conn.agent', (r) => r?.v === 'online', { timeout: 10000 });
      own.mock.setForeground(null);
      own.mock.setPower('standby');
      a.close();
      await phone.waitForState('conn.tv', (r) => r?.v === 'standby' || r?.v === 'off', { timeout: 10000 });
      const before = count();
      await sleep(500);
      assert.equal(count(), before, 'nothing launched on a sleeping TV');
      own.mock.setPower('on');
      await phone.waitForState('conn.tv', (r) => r?.v === 'on', { timeout: 10000 });
      await waitFor(() => count() === before + 1, { timeout: 8000, message: 'the agent launched when the TV woke' });
    } finally {
      await own.stop();
    }
  });
});
