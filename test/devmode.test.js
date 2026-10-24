// Developer mode without the TV agent or Lumen Eyes: the built-in developer-mode TV skill
// (server/ai/skills/developer-mode.md), the flow steps it needs (waitIme, ifIme, typeDigits,
// runtime vars), the enable_developer_mode tool end to end against the mock TV's model of
// Samsung's Developer mode box, device.developerHost from REST, and the Settings button
// (web/js/views/devmode.js) through ai.ask.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FlowCheckError, createSkills, parseSkill, runFlow, validateFlows } from '../server/ai/skills.js';
import { DEV_RESTART_STEP, callTool, describeInput, describeResult } from '../server/ai/tools.js';
import { SYSTEM_PROMPT } from '../server/ai/prompt.js';
import { developerHost, normaliseDevice } from '../server/adapters/rest.js';
import { isAllowedKey } from '../server/catalog/keys.js';
import { CONFIRM_TEXT, DEV_MODE_PROMPT, RESTART_STEP, devModeStatus, startDeveloperMode } from '../web/js/views/devmode.js';
import { createTestLog, startStack, waitFor, sleep } from './helpers.js';

const SKILL_FILE = new URL('../server/ai/skills/developer-mode.md', import.meta.url);
const APPS_PANEL = 'org.volt.apps';
// Flow waits shortened for the tests; the long ones (screens settling) keep enough time for the
// mock's remote-channel events (the TV keyboard) to arrive.
const fast = (ms) => sleep(ms >= 1000 ? 150 : Math.min(ms, 30));

function fakeIo({ ime = () => false, launch } = {}) {
  const calls = [];
  return {
    calls,
    io: {
      key: async (k) => calls.push(k),
      launch: launch ?? (async (id) => { calls.push(`launch:${id}`); return { id, visible: true }; }),
      isRunning: async () => false,
      typeText: async (t, submit) => calls.push(`text:${t}:${submit}`),
      imeOpen: ime,
      sleep: async () => {},
      look: async () => null,
    },
  };
}

// Every key a flow can press, nested steps included.
function flowKeys(steps) {
  return steps.flatMap((s) => [...(s.keys ?? []), ...(s.typeDigits ? [...(s.typeDigits.home ?? []), s.typeDigits.next ?? 'KEY_RIGHT'] : []),
    ...(s.ifIme ? flowKeys(s.ifIme) : []), ...(s.ifColdStart ? flowKeys(s.ifColdStart) : [])]);
}

describe('developer-mode skill: the file', () => {
  const skill = parseSkill(fs.readFileSync(SKILL_FILE, 'utf8'), 'built-in');

  test('parses as a built-in TV skill run by enable_developer_mode, opening Apps by its known ids', () => {
    assert.equal(skill.slug, 'developer-mode');
    assert.equal(skill.scope, 'tv');
    assert.equal(skill.runWith, 'enable_developer_mode');
    assert.deepEqual(skill.appIds, ['org.volt.apps', 'com.samsung.tv.coba.apps']);
    assert.deepEqual(Object.keys(skill.flows), ['open', 'code', 'switchOn', 'hostIp', 'hostIpKeyboard', 'confirm', 'cancel']);
    assert.deepEqual(Object.keys(validateFlows(skill.flows).flows), Object.keys(skill.flows), 'the flows validate');
  });

  test('the notes cover the years, the restart and the blind-flow cautions', () => {
    for (const fact of [/2016–2023/, /2024 and later/, /App Settings/, /12345|1 2 3 4 5/, /restart/i, /Back/, /Arabic and Hebrew/, /ms\.remote\.imeStart/]) {
      assert.match(skill.notes, fact);
    }
  });

  test('the key flow: Apps → 1 2 3 4 5 → On → this PC into the IP boxes → OK, with keyboard checks', () => {
    assert.deepEqual(skill.flows.open[0], { launch: true, note: skill.flows.open[0].note });
    const code = skill.flows.code;
    assert.deepEqual(code.find((s) => s.keys).keys, ['KEY_1', 'KEY_2', 'KEY_3', 'KEY_4', 'KEY_5']);
    assert.deepEqual([code[0].waitIme, code.at(-1).waitIme], [{ open: false }, { open: false }], 'no keyboard before or after the digits');
    assert.deepEqual(skill.flows.switchOn.flatMap((s) => s.keys ?? []), ['KEY_UP', 'KEY_UP', 'KEY_LEFT', 'KEY_ENTER']);
    assert.equal(skill.flows.hostIp[0].typeDigits.var, 'pcAddress');
    assert.deepEqual(skill.flows.hostIpKeyboard.find((s) => s.typeText).typeText, { var: 'pcAddress', submit: true });
    assert.deepEqual(skill.flows.confirm.flatMap((s) => s.keys ?? []), ['KEY_UP', 'KEY_UP', 'KEY_DOWN', 'KEY_DOWN', 'KEY_LEFT', 'KEY_ENTER', 'KEY_RETURN']);
    assert.deepEqual(skill.flows.cancel.at(-2).keys, ['KEY_RETURN']);
  });

  test('no power key and nothing the remote channel would refuse', () => {
    const keys = Object.values(skill.flows).flatMap(flowKeys);
    assert.ok(keys.length > 20);
    for (const key of keys) {
      assert.ok(!/POWER/.test(key), `${key} is not a power key`);
      assert.ok(isAllowedKey(key), `${key} is in Lumen's key catalogue`);
    }
  });
});

describe('flow steps for TV skills', () => {
  test('validation: waitIme, ifIme, typeDigits and typeText runtime vars', () => {
    assert.ok(validateFlows({ a: [{ waitIme: { open: true, timeoutMs: 3000 } }, { ifIme: [{ keys: ['KEY_RETURN'] }] }] }));
    assert.ok(validateFlows({ a: [{ typeDigits: { var: 'pcAddress', home: ['KEY_LEFT'], next: 'KEY_RIGHT' } }, { typeText: { var: 'pcAddress', submit: true } }] }));
    assert.throws(() => validateFlows({ a: [{ waitIme: true }] }), /waitIme is/);
    assert.throws(() => validateFlows({ a: [{ waitIme: { open: true, timeoutMs: 99999 } }] }), /timeoutMs/);
    assert.throws(() => validateFlows({ a: [{ ifIme: [{ keys: ['KEY_POWER'] }] }] }), /not an allowed key/);
    assert.throws(() => validateFlows({ a: [{ typeDigits: { var: 'password' } }] }), /typeDigits.var/);
    assert.throws(() => validateFlows({ a: [{ typeDigits: { var: 'pcAddress', home: ['KEY_POWEROFF'] } }] }), /home/);
    assert.throws(() => validateFlows({ a: [{ typeText: { var: 'secret' } }] }), /typeText.var/);
    assert.throws(() => validateFlows({ a: [{ keys: ['KEY_1'], gapMs: -1 }] }), /gapMs/);
  });

  test('typeDigits returns to the first box before every part, so auto-advancing boxes do not matter', async () => {
    const skill = { app: 'T', appIds: [], flows: { ip: [{ typeDigits: { var: 'pcAddress', home: ['KEY_UP', 'KEY_LEFT'], next: 'KEY_RIGHT' } }] } };
    const { io, calls } = fakeIo();
    const out = await runFlow(skill, 'ip', io, { vars: { pcAddress: '192.168.1.7' } });
    assert.deepEqual(calls, [
      'KEY_UP', 'KEY_LEFT', 'KEY_1', 'KEY_9', 'KEY_2',
      'KEY_UP', 'KEY_LEFT', 'KEY_RIGHT', 'KEY_1', 'KEY_6', 'KEY_8',
      'KEY_UP', 'KEY_LEFT', 'KEY_RIGHT', 'KEY_RIGHT', 'KEY_1',
      'KEY_UP', 'KEY_LEFT', 'KEY_RIGHT', 'KEY_RIGHT', 'KEY_RIGHT', 'KEY_7',
    ]);
    assert.match(out.steps[0], /pcAddress with number keys \(4 fields\)/);
    await assert.rejects(runFlow(skill, 'ip', io, { vars: {} }), /does not know pcAddress/);
    await assert.rejects(runFlow(skill, 'ip', io, { vars: { pcAddress: '1.2.3.4; rm' } }), /does not know pcAddress/);
  });

  test('typeText with a var types the runtime value, never model text', async () => {
    const skill = { app: 'T', appIds: [], flows: { ip: [{ typeText: { var: 'pcAddress', submit: true } }] } };
    const { io, calls } = fakeIo();
    await runFlow(skill, 'ip', io, { text: 'ignored', vars: { pcAddress: '10.0.0.5' } });
    assert.deepEqual(calls, ['text:10.0.0.5:true']);
  });

  test('waitIme passes when the keyboard state matches and throws FlowCheckError when it never does; ifIme branches', async () => {
    let open = false;
    const skill = { app: 'T', appIds: [], flows: {
      closed: [{ waitIme: { open: false } }],
      opens: [{ waitIme: { open: true, timeoutMs: 500 } }],
      back: [{ ifIme: [{ keys: ['KEY_RETURN'] }] }, { keys: ['KEY_EXIT'] }],
    } };
    const { io, calls } = fakeIo({ ime: () => open });
    await runFlow(skill, 'closed', io);
    const err = await runFlow(skill, 'opens', io).catch((e) => e);
    assert.ok(err instanceof FlowCheckError);
    assert.equal(err.code, 'CHECK_FAILED');
    assert.match(err.message, /keyboard did not open/);
    let polls = 0;
    const later = fakeIo({ ime: () => ++polls > 3 });
    await runFlow(skill, 'opens', later.io);
    await runFlow(skill, 'back', io);
    open = true;
    await runFlow(skill, 'back', io);
    assert.deepEqual(calls, ['KEY_EXIT', 'KEY_RETURN', 'KEY_EXIT']);
  });

  test('hostIpKeyboard (a TV whose Host PC IP opens the TV keyboard): OK, keyboard opens, address typed and submitted, keyboard closes', async () => {
    const skill = createSkills({ log: createTestLog() }).get('developer-mode');
    let open = false;
    const calls = [];
    const io = {
      key: async (k) => { calls.push(k); if (k === 'KEY_ENTER') open = true; },
      typeText: async (t, submit) => { calls.push(`text:${t}:${submit}`); if (submit) open = false; },
      imeOpen: () => open,
      sleep: async () => {},
    };
    await runFlow(skill, 'hostIpKeyboard', io, { vars: { pcAddress: '192.168.1.7' } });
    assert.deepEqual(calls.slice(-2), ['KEY_ENTER', 'text:192.168.1.7:true']);
    // A field that never opens the keyboard: the flow stops before typing anything.
    const stuck = { ...io, key: async (k) => calls.push(k), imeOpen: () => false };
    const mark = calls.length;
    await assert.rejects(runFlow(skill, 'hostIpKeyboard', stuck, { vars: { pcAddress: '192.168.1.7' } }), FlowCheckError);
    assert.ok(!calls.slice(mark).some((c) => c.startsWith('text:')));
  });

  test('launch tries the skill\'s ids in order when the TV does not have one, and stops on anything else', async () => {
    const skill = { app: 'Developer mode', scope: 'tv', appIds: ['org.volt.apps', 'com.samsung.tv.coba.apps'], flows: { open: [{ launch: true }] } };
    const fail = (code) => Object.assign(new Error(code), { code });
    const tried = [];
    const state = {};
    const fallback = fakeIo({ launch: async (id) => { tried.push(id); if (id === 'org.volt.apps') throw fail('UNAVAILABLE'); return { id, visible: true }; } });
    await runFlow(skill, 'open', fallback.io, {}, state);
    assert.deepEqual(tried, ['org.volt.apps', 'com.samsung.tv.coba.apps']);
    assert.deepEqual(state.launched, { id: 'com.samsung.tv.coba.apps', visible: true });
    const off = fakeIo({ launch: async () => { throw fail('TV_OFF'); } });
    await assert.rejects(runFlow(skill, 'open', off.io), /TV_OFF/);
    const none = fakeIo({ launch: async () => { throw fail('UNAVAILABLE'); } });
    await assert.rejects(runFlow(skill, 'open', none.io), (e) => e.code === 'UNAVAILABLE');
  });

  test('TV skills are built in only: not saved over, not inherited by an app skill, not run by run_app_flow', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-devmode-'));
    try {
      const skills = createSkills({ dataDir: dir, log: createTestLog() });
      assert.throws(() => skills.save({ app: 'Developer mode', flows: { open: [{ keys: ['KEY_HOME'] }] } }), /built-in TV skill/);
      const other = skills.save({ app: 'Developer', notes: '- an app named Developer' });
      assert.deepEqual(Object.keys(other.flows), [], 'no flows inherited from the TV skill');
      assert.equal(skills.list().find((s) => s.slug === 'developer-mode').scope, 'tv');
      const ran = await callTool('run_app_flow', { app: 'developer-mode', flow: 'code' }, { skills, hub: { handle: async () => ({ ok: true }) } });
      assert.equal(ran.isError, true);
      assert.match(ran.result.error.message, /TV skill; run it with enable_developer_mode/);
      const read = await callTool('get_app_skill', { app: 'developer mode' }, { skills });
      assert.equal(read.result.skill.runWith, 'enable_developer_mode');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('device.developerHost (REST)', () => {
  test('a category, never the address', () => {
    assert.equal(developerHost('192.168.1.7', '192.168.1.7'), 'this-pc');
    assert.equal(developerHost('192.168.1.9', '192.168.1.7'), 'other');
    assert.equal(developerHost('0.0.0.0', '192.168.1.7'), 'none');
    assert.equal(developerHost('', null), 'none');
    assert.equal(developerHost(undefined, '192.168.1.7'), undefined);
    assert.equal(developerHost('192.168.1.9', null), undefined, 'unknown until this PC\'s address is known');
    const device = normaliseDevice({ developerMode: '1', developerIP: '192.168.1.7', model: '20_NIKEM_QTV' }, { pcAddress: '192.168.1.7' });
    assert.deepEqual([device.developerMode, device.developerHost, device.year], [true, 'this-pc', '2020']);
    assert.ok(!JSON.stringify(device).includes('192.168'), 'no IP address is kept');
  });
});

describe('enable_developer_mode against the mock TV', () => {
  let stack, mock, ctx;
  const run = (args = {}) => callTool('enable_developer_mode', args, ctx);
  const dev = () => mock.state.dev;
  const keysSince = (mark) => mock.state.keys.slice(mark).map((k) => k.key);
  const reset = ({ mode = '0', ip = '0.0.0.0', autoAdvance = true } = {}) => {
    Object.assign(dev(), { mode, ip, dialog: null, notice: false, code: '' });
    Object.assign(mock.options, { devIpAutoAdvance: autoAdvance, devDigitsOpenIme: false, model: undefined, language: undefined });
    mock.setForeground('3201907018807'); // Netflix in front, as when the owner is watching
  };

  before(async () => {
    stack = await startStack({ mock: { appsPanel: APPS_PANEL } });
    ({ mock } = stack);
    const b = stack.browser();
    await b.hello;
    await b.waitForState('conn.tv', (r) => r?.v === 'on', { timeout: 8000 });
    await b.waitForState('conn.remote', (r) => r?.v === 'paired', { timeout: 8000 });
    ctx = {
      hub: stack.server.hub, store: stack.server.store, eyes: stack.server.adapters.eyes,
      skills: createSkills({ log: createTestLog() }),
      pcAddress: async () => stack.server.lanAddress, // 127.0.0.1: this PC's address towards the mock
      sleepFn: fast,
    };
  });
  after(() => stack?.stop());

  test('already on with this PC as host: nothing is pressed', async () => {
    reset({ mode: '1', ip: stack.server.lanAddress });
    const mark = mock.state.keys.length;
    const out = await run();
    assert.equal(out.isError, false, out.text);
    assert.equal(out.result.already, true);
    assert.deepEqual(keysSince(mark), []);
  });

  test('off → Apps, 1 2 3 4 5, then (after the owner confirms the box) On, this PC, OK; REST confirms', async () => {
    reset();
    const mark = mock.state.keys.length;
    const first = await run();
    assert.equal(first.isError, false, first.text);
    assert.equal(first.result.stage, 'dialog');
    assert.equal(first.result.needsUser, 'confirmDialog', 'no Eyes: the owner is asked whether the box is on screen');
    assert.match(first.result.next, /Developer mode" box/);
    assert.doesNotMatch(first.result.summary, /enable_developer_mode|dialogOpen/, 'the user-facing line has no tool jargon');
    assert.equal(mock.state.launches.at(-1).appId, APPS_PANEL, 'Apps opened over REST');
    assert.deepEqual(keysSince(mark), ['KEY_1', 'KEY_2', 'KEY_3', 'KEY_4', 'KEY_5']);
    assert.ok(dev().dialog, 'the mock TV shows the Developer mode box');
    assert.equal(dev().saved, 0, 'nothing saved before the owner confirms');

    const second = await run({ dialogOpen: true });
    assert.equal(second.isError, false, second.text);
    assert.deepEqual([dev().mode, dev().ip], ['1', stack.server.lanAddress]);
    assert.equal(dev().dialog, null);
    assert.equal(dev().notice, false, 'the restart notice was closed with Back');
    assert.equal(second.result.confirmedByTv, true);
    assert.equal(second.result.needsRestart, true);
    assert.ok(second.result.summary.includes(DEV_RESTART_STEP), 'the restart step is in the reply');
    await waitFor(() => stack.server.store.get('device.developerHost')?.v === 'this-pc', { timeout: 5000 });
    assert.ok(!mock.keysSent().some((k) => /POWER/.test(k)), 'no power key');
  });

  test('IP boxes that do not jump after three digits, and a box pointing at another PC, get the same result', async () => {
    reset({ mode: '1', ip: '10.20.30.40', autoAdvance: false });
    const first = await run();
    assert.equal(first.result.stage, 'dialog', first.text);
    const second = await run({ dialogOpen: true });
    assert.equal(second.isError, false, second.text);
    assert.deepEqual([dev().mode, dev().ip], ['1', stack.server.lanAddress]);
  });

  test('right-to-left menus get the address in reverse box order', async () => {
    reset();
    mock.options.language = 'ar_AE';
    await run();
    const out = await run({ dialogOpen: true });
    assert.equal(out.result.confirmedByTv, true, out.text);
    assert.equal(dev().ip, stack.server.lanAddress);
  });

  test('probe opens the box and closes it with Back: nothing changes', async () => {
    reset();
    const before = { ...dev() };
    const out = await run({ probe: true });
    assert.equal(out.isError, false, out.text);
    assert.equal(out.result.probe, true);
    assert.equal(dev().opened, before.opened + 1, 'the box opened');
    assert.equal(dev().cancelled, before.cancelled + 1, 'and was closed with Back');
    assert.deepEqual([dev().mode, dev().ip, dev().saved], ['0', '0.0.0.0', before.saved]);
  });

  test('cancel closes an open box without saving', async () => {
    reset();
    await run();
    assert.ok(dev().dialog);
    const out = await run({ cancel: true });
    assert.equal(out.result.changed, false);
    assert.equal(dev().dialog, null);
    assert.equal(dev().mode, '0');
  });

  test('digits that open the TV keyboard (a text field had focus): Back, stop, nothing changed', async () => {
    reset();
    mock.options.devDigitsOpenIme = true;
    const saved = dev().saved;
    const out = await run();
    assert.equal(out.isError, true);
    assert.equal(out.result.error.code, 'CHECK_FAILED');
    assert.match(out.result.error.message, /keyboard is open.*pressed Back/);
    assert.equal(mock.state.ime.open, false, 'Back closed the keyboard');
    assert.deepEqual([dev().mode, dev().saved, dev().dialog], ['0', saved, null]);
  });

  test('a TV that refuses both Apps ids: the owner opens Apps, then Lumen continues from the code', async () => {
    reset();
    const panel = mock.state.apps.get(APPS_PANEL);
    mock.state.apps.delete(APPS_PANEL);
    try {
      const mark = mock.state.keys.length;
      const out = await run();
      assert.equal(out.result.needsUser, 'openApps', out.text);
      assert.match(out.result.next, /appsOpen: true/);
      assert.deepEqual(keysSince(mark), [], 'no digits typed on whatever is on screen');
      assert.deepEqual(mock.state.requests.rest.filter((r) => r.method === 'POST').slice(-2).map((r) => r.path),
        ['/api/v2/applications/org.volt.apps/', '/api/v2/applications/com.samsung.tv.coba.apps/']);
    } finally {
      mock.state.apps.set(APPS_PANEL, panel);
    }
    mock.setForeground(APPS_PANEL); // the owner opened Apps
    const next = await run({ appsOpen: true });
    assert.equal(next.result.stage, 'dialog', next.text);
    assert.ok(dev().dialog);
    await run({ cancel: true });
  });

  test('2024 and later: the owner opens App Settings first', async () => {
    reset();
    mock.options.model = '24_PONTUSM_UHD';
    const mark = mock.state.keys.length;
    const out = await run();
    assert.equal(out.result.needsUser, 'openAppSettings', out.text);
    assert.match(out.result.summary, /App Settings/);
    assert.deepEqual(keysSince(mark), []);
  });

  test('device.refresh gives the category, never the developer IP', async () => {
    reset({ mode: '1', ip: '10.20.30.40' });
    const ack = await stack.server.hub.handle({ cmd: 'device.refresh' });
    assert.equal(ack.ok, true);
    assert.deepEqual([ack.value.developerMode, ack.value.developerHost, ack.value.year], [true, 'other', '2020']);
    assert.ok(!JSON.stringify(ack).includes('10.20.30.40'));
  });

  test('the TV saw nothing a correct client must not send', () => {
    assert.deepEqual(mock.state.violations, []);
  });
});

describe('enable_developer_mode: preconditions', () => {
  const store = (values) => ({ get: (key) => (key in values ? { v: values[key] } : undefined) });
  const skills = createSkills({ log: createTestLog() });
  const hub = { handle: async () => ({ ok: true, value: {} }) };

  test('needs the TV on and the remote channel paired', async () => {
    const off = await callTool('enable_developer_mode', {}, { hub, skills, store: store({ 'conn.tv': 'standby', 'conn.remote': 'paired' }) });
    assert.equal(off.result.error.code, 'TV_OFF');
    const unpaired = await callTool('enable_developer_mode', {}, { hub, skills, store: store({ 'conn.tv': 'on', 'conn.remote': 'unpaired' }) });
    assert.equal(unpaired.result.error.code, 'NOT_PAIRED');
  });

  test('dialogOpen needs this PC\'s address', async () => {
    const out = await callTool('enable_developer_mode', { dialogOpen: true }, { hub, skills, store: store({ 'conn.tv': 'on', 'conn.remote': 'paired' }), pcAddress: async () => null });
    assert.equal(out.result.error.code, 'UNAVAILABLE');
    assert.match(out.result.error.message, /Host PC IP/);
  });

  test('the system prompt sends developer mode requests to the tool and asks for the restart step', () => {
    assert.match(SYSTEM_PROMPT, /enable_developer_mode/);
    assert.match(SYSTEM_PROMPT, /restart the TV/);
  });
});

describe('Settings → Enable developer mode', () => {
  const values = (v) => (key) => v[key] ?? null;
  const ready = { tv: 'on', remote: 'paired', ai: { ready: true } };

  test('the row: state from REST, a button when there is something to do, and why it is disabled', () => {
    assert.deepEqual(devModeStatus(values({ 'device.developerMode': true, 'device.developerHost': 'this-pc' }), ready),
      { dot: 'good', text: 'On · this PC is the host', action: null, blocked: null });
    assert.equal(devModeStatus(values({ 'device.developerMode': true, 'device.developerHost': 'other' }), ready).action, 'Point at this PC');
    assert.equal(devModeStatus(values({ 'device.developerMode': false }), ready).action, 'Enable developer mode');
    assert.equal(devModeStatus(values({}), ready).text, 'Unknown');
    assert.equal(devModeStatus(values({}), { ...ready, tv: 'standby' }).blocked, 'Turn the TV on first');
    assert.equal(devModeStatus(values({}), { ...ready, remote: 'unpaired' }).blocked, 'Pair the remote channel first');
    assert.equal(devModeStatus(values({}), { ...ready, ai: { ready: false } }).blocked, 'Ask Lumen needs setting up first');
  });

  test('the button confirms first, then starts an Ask Lumen run with the developer-mode prompt', () => {
    const submitted = [];
    const ctx = { ask: { submit: (text) => submitted.push(text) } };
    let asked = null;
    assert.equal(startDeveloperMode(ctx, (msg) => { asked = msg; return false; }), false);
    assert.deepEqual(submitted, [], 'declined: nothing starts');
    assert.match(asked, /takes over the TV/);
    assert.match(asked, /hold Power .* about 2 seconds/);
    assert.equal(startDeveloperMode(ctx, () => true), true);
    assert.deepEqual(submitted, [DEV_MODE_PROMPT]);
    assert.match(DEV_MODE_PROMPT, /developer mode/i);
    assert.match(SYSTEM_PROMPT, /Developer mode .*enable_developer_mode/, 'the system prompt sends it to the tool');
    assert.match(RESTART_STEP, /hold Power/);
    assert.equal(CONFIRM_TEXT.includes('1 2 3 4 5'), true);
  });
});

describe('Settings button → ai.ask → enable_developer_mode on the mock TV', () => {
  // Stands in for Claude: what the prompt and tool results tell it to do (run the tool, the owner
  // answers "yes, the box is there", run it again with dialogOpen, reply with the restart step).
  const runs = [];
  const agentSdk = {
    availability: () => ({ available: true, reason: null }),
    isAvailable: async () => true,
    async run(request, { emit, toolContext }) {
      runs.push(request);
      const tools = [];
      const call = async (input) => {
        const out = await callTool('enable_developer_mode', input, { ...toolContext, sleepFn: fast });
        emit({ kind: 'tool', name: 'mcp__lumen__enable_developer_mode', input: describeInput(input), ok: !out.isError, result: describeResult(out.result) });
        tools.push({ name: 'enable_developer_mode', ok: !out.isError });
        return out.result;
      };
      if (!/developer mode/i.test(request)) return { ok: true, text: 'Not a developer mode request.', tools };
      const first = await call({});
      if (first.stage !== 'dialog') return { ok: true, text: first.summary, tools };
      const done = await call({ dialogOpen: true });
      return { ok: done.ok !== false, text: done.summary, tools };
    },
  };
  let stack;
  before(async () => {
    stack = await startStack({
      mock: { appsPanel: APPS_PANEL, developerMode: '0', developerIP: '0.0.0.0' },
      config: { ai: { backend: 'agent-sdk' } },
      seams: { aiBackends: { agentSdk, api: { isConfigured: () => false } } },
    });
  });
  after(() => stack?.stop());

  test('the prompt the button sends runs the skill, streams its steps and ends with the restart step', async () => {
    const b = stack.browser();
    const hello = await b.hello;
    assert.equal(hello.ai.ready, true);
    await b.waitForState('conn.remote', (r) => r?.v === 'paired', { timeout: 8000 });
    await b.waitForState('device.developerMode', (r) => r?.v === false, { timeout: 8000 });
    const ack = await b.send('ai.ask', { text: DEV_MODE_PROMPT, thread: 'settings-devmode' });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    const id = ack.value.id;
    const done = await b.waitForMessage((m) => m.t === 'ai' && m.id === id && m.kind === 'done', { timeout: 60000 });
    assert.equal(done.ok, true);
    const events = b.messages.filter((m) => m.t === 'ai' && m.id === id);
    assert.equal(events.filter((m) => m.kind === 'tool' && /enable_developer_mode/.test(m.name)).length, 2, 'two tool steps shown in Ask');
    const result = events.find((m) => m.kind === 'result');
    assert.ok(result.text.includes(DEV_RESTART_STEP), result.text);
    assert.deepEqual([stack.mock.state.dev.mode, stack.mock.state.dev.ip], ['1', stack.server.lanAddress]);
    await b.waitForState('device.developerHost', (r) => r?.v === 'this-pc', { timeout: 8000 });
    assert.equal(runs[0], DEV_MODE_PROMPT);
  });
});
