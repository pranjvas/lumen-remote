// Ask Lumen replies survive a dropped connection: the hub keeps each run's events (numbered with
// seq) and ai.resume replays the ones a reconnected page has not seen, then streams the rest.
// A phone that leaves the app mid-run used to show "This reply was lost when the page reloaded."
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestLog, startStack } from './helpers.js';
import { createHub } from '../server/hub.js';
import { createStore } from '../server/store.js';
import { loadConfig } from '../server/config.js';

// Stands in for Claude: one tool step, then waits until the test lets the run finish.
function gatedBackend() {
  const gates = new Map();
  const gate = (request) => {
    if (!gates.has(request)) {
      let open;
      const promise = new Promise((resolve) => { open = resolve; });
      gates.set(request, { promise, open });
    }
    return gates.get(request);
  };
  return {
    open: (request) => gate(request).open(),
    agentSdk: {
      availability: () => ({ available: true, reason: null }),
      isAvailable: async () => true,
      async run(request, { emit }) {
        emit({ kind: 'status', text: 'Thinking…' });
        emit({ kind: 'tool', name: 'mcp__lumen__get_tv_state', input: '', ok: true, result: 'Volume 12' });
        await gate(request).promise;
        return { ok: true, text: `Answer to ${request}`, tools: [{ name: 'get_tv_state', ok: true }] };
      },
    },
  };
}

describe('ai.resume', () => {
  const backend = gatedBackend();
  let stack;
  before(async () => {
    stack = await startStack({
      config: { ai: { backend: 'agent-sdk' } },
      seams: { aiBackends: { agentSdk: backend.agentSdk, api: { isConfigured: () => false } } },
    });
  });
  after(() => stack?.stop());

  const aiEvents = (b, id) => b.messages.filter((m) => m.t === 'ai' && m.id === id);

  test('events carry increasing seq numbers', async () => {
    const b = stack.browser();
    await b.hello;
    const ack = await b.send('ai.ask', { text: 'seq check' });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    const id = ack.value.id;
    await b.waitForMessage((m) => m.t === 'ai' && m.id === id && m.kind === 'tool');
    backend.open('seq check');
    await b.waitForMessage((m) => m.t === 'ai' && m.id === id && m.kind === 'done');
    assert.deepEqual(aiEvents(b, id).map((m) => m.seq), aiEvents(b, id).map((_, i) => i));
    assert.deepEqual(aiEvents(b, id).map((m) => m.kind), ['status', 'tool', 'result', 'done']);
  });

  test('a run that finished while the page was away is replayed from where the page left off', async () => {
    const a = stack.browser();
    await a.hello;
    const ack = await a.send('ai.ask', { text: 'finish while away' });
    const id = ack.value.id;
    const tool = await a.waitForMessage((m) => m.t === 'ai' && m.id === id && m.kind === 'tool');
    a.close(); // the phone left the app
    backend.open('finish while away');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const b = stack.browser();
    await b.hello;
    const resumed = await b.send('ai.resume', { target: id, after: tool.seq });
    assert.equal(resumed.ok, true, JSON.stringify(resumed.error));
    assert.deepEqual(resumed.value, { found: true, done: true });
    const replay = aiEvents(b, id);
    assert.deepEqual(replay.map((m) => m.kind), ['result', 'done'], 'only the events after the tool step');
    assert.equal(replay[0].text, 'Answer to finish while away');
    assert.equal(replay[1].ok, true);
  });

  test('a page that reconnects mid-run gets the earlier events and then the rest live', async () => {
    const a = stack.browser();
    await a.hello;
    const id = (await a.send('ai.ask', { text: 'resume mid-run' })).value.id;
    await a.waitForMessage((m) => m.t === 'ai' && m.id === id && m.kind === 'tool');
    a.close();

    const b = stack.browser();
    await b.hello;
    const resumed = await b.send('ai.resume', { target: id, after: -1 });
    assert.deepEqual(resumed.value, { found: true, done: false });
    assert.deepEqual(aiEvents(b, id).map((m) => m.kind), ['status', 'tool']);
    backend.open('resume mid-run');
    await b.waitForMessage((m) => m.t === 'ai' && m.id === id && m.kind === 'done');
    assert.deepEqual(aiEvents(b, id).map((m) => m.kind), ['status', 'tool', 'result', 'done']);
    assert.deepEqual(aiEvents(b, id).map((m) => m.seq), [0, 1, 2, 3]);
  });

  test('a run Lumen does not have → found: false', async () => {
    const b = stack.browser();
    await b.hello;
    const resumed = await b.send('ai.resume', { target: 'no-such-run' });
    assert.equal(resumed.ok, true);
    assert.deepEqual(resumed.value, { found: false, done: false });
  });

  test('resuming with the seq the page already has sends nothing again', async () => {
    const a = stack.browser();
    await a.hello;
    const id = (await a.send('ai.ask', { text: 'nothing twice' })).value.id;
    backend.open('nothing twice');
    const done = await a.waitForMessage((m) => m.t === 'ai' && m.id === id && m.kind === 'done');
    const before = aiEvents(a, id).length;
    const resumed = await a.send('ai.resume', { target: id, after: done.seq });
    assert.deepEqual(resumed.value, { found: true, done: true });
    assert.equal(aiEvents(a, id).length, before);
  });

  test('bad arguments are refused', async () => {
    const b = stack.browser();
    await b.hello;
    assert.equal((await b.send('ai.resume', {})).error?.code, 'INVALID');
    assert.equal((await b.send('ai.resume', { target: 'x', after: 'soon' })).error?.code, 'INVALID');
    assert.equal((await b.send('ai.resume', { target: 'x', after: -2 })).error?.code, 'INVALID');
  });
});

describe('ai.resume and incognito', () => {
  // The hub alone: an Ask Lumen run made while Lumen's browser is incognito can be resumed while
  // incognito lasts, and is gone once it ends (the incognito promise: Lumen forgets the session).
  let incognito = false;
  let finish;
  const ai = {
    async ask(question, { emit }) {
      emit({ kind: 'tool', name: 'mcp__lumen__browser_read', input: '', ok: true, result: 'The private page says hello' });
      await new Promise((resolve) => { finish = resolve; });
      emit({ kind: 'result', text: `Private answer to ${question}` });
      emit({ kind: 'done', ok: true });
    },
  };
  const client = () => {
    const messages = [];
    return { messages, send: (msg) => messages.push(typeof msg === 'string' ? JSON.parse(msg) : msg) };
  };
  const hub = createHub({ config: loadConfig({}), log: createTestLog(), store: createStore({}), features: { ai, browser: { incognito: () => incognito } } });
  after(() => hub.stop());

  test('kept while incognito lasts, dropped when it ends', async () => {
    incognito = true;
    const asker = client();
    const ack = await hub.handle({ cmd: 'ai.ask', id: 'private-1', text: 'summarise this page' }, asker);
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(asker.messages.map((m) => m.kind), ['tool', 'result', 'done']);

    const during = client();
    assert.deepEqual((await hub.handle({ cmd: 'ai.resume', target: 'private-1' }, during)).value, { found: true, done: true });
    assert.equal(during.messages.length, 3);

    incognito = false;
    assert.equal(hub.forgetPrivateAiRuns(), 1);
    const after = client();
    assert.deepEqual((await hub.handle({ cmd: 'ai.resume', target: 'private-1' }, after)).value, { found: false, done: false });
    assert.equal(after.messages.length, 0);
  });

  test('runs made outside incognito are kept', async () => {
    incognito = false;
    const asker = client();
    await hub.handle({ cmd: 'ai.ask', id: 'normal-1', text: 'volume' }, asker);
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(hub.forgetPrivateAiRuns(), 0);
    assert.equal((await hub.handle({ cmd: 'ai.resume', target: 'normal-1' }, client())).value.found, true);
  });
});
