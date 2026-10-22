// Safety rules (spec §3.10, §5.3, §8.4): the key allowlist, no KEY_POWER holds, the volume cap,
// the power cooldown, the per-client rate limit and the touch gate — checked at the catalogue and
// end to end, where the mock records anything a correct client must never send.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipUnless, startStack, waitFor, sleep } from './helpers.js';

describe('key catalogue allowlist', { skip: skipUnless('server/catalog/keys.js') }, () => {
  let KEYS, isAllowedKey;
  before(async () => { ({ KEYS, isAllowedKey } = await import('../server/catalog/keys.js')); });

  test('danger keys are never allowed', () => {
    for (const key of ['KEY_FACTORY', 'KEY_11', 'KEY_12', 'KEY_EXT20', 'KEY_EXT41', 'KEY_PANNEL_POWER', 'KEY_AUTO_ARC_RESET', 'KEY_ID_SETUP', 'KEY_3SPEED']) {
      assert.equal(isAllowedKey(key), false, key);
    }
    assert.equal(isAllowedKey('KEY_SOMETHING_UNKNOWN'), false, 'unknown keys are refused too');
  });

  test('every catalogue key is well formed and allowed; KEY_POWER is click-only', () => {
    assert.ok(KEYS.length > 30);
    for (const k of KEYS) {
      assert.match(k.key, /^KEY_[A-Z0-9_]+$/);
      assert.equal(typeof k.label, 'string');
      assert.equal(typeof k.group, 'string');
      assert.ok(['repeat', 'press', 'none'].includes(k.hold), `${k.key} hold ${k.hold}`);
      assert.equal(isAllowedKey(k.key), true, k.key);
    }
    const byKey = Object.fromEntries(KEYS.map((k) => [k.key, k]));
    assert.equal(byKey.KEY_POWER.hold, 'none');
    for (const k of ['KEY_UP', 'KEY_DOWN', 'KEY_LEFT', 'KEY_RIGHT', 'KEY_VOLUP', 'KEY_VOLDOWN', 'KEY_CHUP', 'KEY_CHDOWN']) assert.equal(byKey[k].hold, 'repeat', k);
    for (const k of ['KEY_ENTER', 'KEY_RETURN', 'KEY_HOME', 'KEY_MENU', 'KEY_MUTE']) assert.ok(byKey[k], `${k} present`);
    assert.ok(['power', 'nav', 'menu', 'volume', 'channel', 'numbers', 'colors', 'media', 'extra'].every((g) => KEYS.some((k) => k.group === g)));
  });
});

describe('safety through the hub', { skip: skipUnless('server/app.js') }, () => {
  let stack, b, mock;
  before(async () => {
    stack = await startStack({ config: { safety: { volumeCap: 60, powerCooldownMs: 5000, keyGapMs: 20 } } });
    mock = stack.mock;
    b = stack.browser();
    await b.hello;
    await b.send('view', { name: 'remote', visible: true });
    await b.waitForState('conn.tv', (r) => r?.v === 'on', { timeout: 8000 });
    await b.waitForState('conn.remote', (r) => r?.v === 'paired', { timeout: 8000 });
  });
  after(() => stack?.stop());

  const sent = (key, cmd) => mock.state.keys.filter((k) => k.key === key && (!cmd || k.cmd === cmd)).length;

  test('a danger key is refused with INVALID and never reaches the TV', async () => {
    for (const key of ['KEY_FACTORY', 'KEY_EXT20', 'KEY_PANNEL_CHDOWN']) {
      const ack = await b.send('key', { key });
      assert.equal(ack.ok, false, key);
      assert.equal(ack.error.code, 'INVALID', key);
      assert.equal(sent(key), 0, key);
    }
  });

  test('KEY_POWER can never be held', async () => {
    const ack = await b.send('hold', { key: 'KEY_POWER', phase: 'start' });
    assert.equal(ack.ok, false);
    assert.equal(ack.error.code, 'INVALID');
    await b.send('hold', { key: 'KEY_POWER', phase: 'end' });
    await sleep(200);
    assert.equal(sent('KEY_POWER', 'Press'), 0);
    assert.equal(sent('KEY_POWER'), 0, 'no power key at all');
  });

  test('volume never goes above the cap', async () => {
    const ack = await b.send('volume.set', { value: 90 });
    if (ack.ok) assert.ok(ack.value <= 60, `acked ${ack.value}`);
    else assert.ok(['INVALID', 'RATE_LIMIT'].includes(ack.error.code), ack.error.code);
    assert.ok(mock.state.volume <= 60, `TV at ${mock.state.volume}`);

    const set = await b.send('volume.set', { value: 58 });
    assert.equal(set.ok, true, JSON.stringify(set.error));
    for (let i = 0; i < 2; i++) await b.send('volume.step', { delta: 5 });
    assert.ok(mock.state.volume <= 60, `stepped to ${mock.state.volume}`);
    await b.send('volume.set', { value: 10 });
    assert.equal(mock.state.volume, 10, 'lowering is always allowed');
  });

  test('the pointer works with or without the TV touch hint; right click and scroll', async () => {
    const before = mock.state.pointer.length;
    mock.setTouch(false);
    await b.waitForState('touch.enabled', (r) => r?.v === false);
    const moved = await b.send('pointer.move', { dx: 10, dy: 5 });
    assert.equal(moved.ok, true, JSON.stringify(moved.error));
    await waitFor(() => mock.state.pointer.length > before);
    assert.equal(mock.state.pointer.at(-1).cmd, 'Move');
    assert.deepEqual([mock.state.pointer.at(-1).x, mock.state.pointer.at(-1).y], [10, 5]);
    const right = await b.send('pointer.click', { button: 'right' });
    assert.equal(right.ok, true, JSON.stringify(right.error));
    await waitFor(() => mock.state.pointer.at(-1)?.cmd === 'RightClick');
    const keysBefore = mock.state.keys.length;
    const scrolled = await b.send('pointer.scroll', { dy: 240 });
    assert.equal(scrolled.ok, true, JSON.stringify(scrolled.error));
    await waitFor(() => mock.state.keys.length >= keysBefore + 2);
    assert.deepEqual(mock.state.keys.slice(keysBefore).map((k) => k.key), ['KEY_CHDOWN', 'KEY_CHDOWN']);
    const bad = await b.send('pointer.click', { button: 'middle' });
    assert.equal(bad.ok, false);
  });

  test('a burst of commands from one client is rate limited', async () => {
    await sleep(1100); // refill the bucket
    const before = sent('KEY_UP');
    const ids = Array.from({ length: 60 }, () => b.fire('key', { key: 'KEY_UP' }));
    const acks = await Promise.all(ids.map((id) => b.waitForMessage((m) => m.t === 'ack' && m.id === id, { timeout: 15000 })));
    const limited = acks.filter((a) => !a.ok && a.error.code === 'RATE_LIMIT').length;
    assert.ok(limited > 0, 'some commands were rate limited');
    await waitFor(() => sent('KEY_UP') - before === acks.filter((a) => a.ok).length, { timeout: 8000, message: 'accepted keys reached the TV' });
    assert.ok(sent('KEY_UP') - before < 60);
  });

  test('power has a cooldown: a second toggle right after the first is refused', async () => {
    await sleep(1100);
    const first = await b.send('power', { action: 'off' }, { timeout: 15000 });
    assert.equal(first.ok, true, JSON.stringify(first.error));
    const second = await b.send('power', { action: 'off' }, { timeout: 15000 });
    assert.equal(second.ok, false);
    assert.ok(['RATE_LIMIT', 'TV_OFF'].includes(second.error.code), second.error.code);
    await sleep(200);
    assert.equal(sent('KEY_POWER', 'Click'), 1, 'exactly one KEY_POWER toggle');
  });

  test('the TV never saw anything a correct client must not send', () => {
    assert.deepEqual(mock.state.violations, []);
    assert.deepEqual(mock.state.pairRequests, { remote: 0, ipc: 0 }, 'no pairing without the Pair button');
  });
});
