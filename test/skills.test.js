// App skills: parsing and validation, the grid-keyboard planner (checked against the key sequence
// that typed "harold" on the real JioHotstar keyboard), the learned-skill store, flow running, the
// JustWatch title chooser, and the play_title / save_app_skill tools end to end with fakes.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSkills, gridPath, parseSkill, renderSkill, runFlow, validateFlows } from '../server/ai/skills.js';
import { createTitles, contentIdFrom } from '../server/features/titles.js';
import { callTool } from '../server/ai/tools.js';
import { createTestLog } from './helpers.js';

const HOTSTAR_ROWS = [['A', 'B', 'C', 'D', 'E', 'F', 'G'], ['H', 'I', 'J', 'K', 'L', 'M', 'N'], ['O', 'P', 'Q', 'R', 'S', 'T', 'U'],
  ['V', 'W', 'X', 'Y', 'Z', null, 'Delete'], ['Space', 'Space', 'Space', 'Space', 'Space', '123', '123']];
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-skills-'));

function fakeIo({ running = false } = {}) {
  const calls = [];
  return {
    calls,
    io: {
      key: async (k) => calls.push(k),
      launch: async (id) => calls.push(`launch:${id}`),
      isRunning: async () => running,
      typeText: async (t, submit) => calls.push(`text:${t}:${submit}`),
      sleep: async () => {},
      look: async () => ({ data: 'AAAA', mimeType: 'image/png' }),
    },
  };
}

describe('skills: format, validation, grid keyboards', () => {
  test('the JioHotstar keyboard plan for "harold" is the sequence verified on the TV', () => {
    const plan = gridPath({ rows: HOTSTAR_ROWS, start: 'A' }, 'harold');
    assert.equal(plan.keys.join(' '), 'KEY_DOWN KEY_ENTER KEY_UP KEY_ENTER KEY_DOWN KEY_DOWN KEY_RIGHT KEY_RIGHT KEY_RIGHT KEY_ENTER '
      + 'KEY_LEFT KEY_LEFT KEY_LEFT KEY_ENTER KEY_UP KEY_RIGHT KEY_RIGHT KEY_RIGHT KEY_RIGHT KEY_ENTER KEY_UP KEY_LEFT KEY_ENTER');
    assert.deepEqual(plan.end, { row: 0, col: 3 });
    const spaced = gridPath({ rows: HOTSTAR_ROWS, start: 'A' }, 'the office');
    assert.equal(spaced.typed, 'the office');
    assert.ok(spaced.keys.includes('KEY_DOWN'), 'reaches the Space key');
    assert.equal(gridPath({ rows: HOTSTAR_ROWS, start: 'A', maxChars: 3 }, 'harold').typed, 'har');
  });

  test('flows are validated: one action per step, allowed keys only, bounded waits', () => {
    assert.deepEqual(Object.keys(validateFlows({ open: [{ launch: true }, { wait: 100 }] }).flows), ['open']);
    assert.throws(() => validateFlows({ open: [{ keys: ['KEY_POWER'] }] }), /not an allowed key/);
    assert.throws(() => validateFlows({ open: [{ launch: true, wait: 5 }] }), /exactly one action/);
    assert.throws(() => validateFlows({ open: [{ shell: 'rm' }] }), /unknown action/);
    assert.throws(() => validateFlows({ open: [{ wait: 999999 }] }), /wait/);
  });

  test('render → parse round-trips notes and flows', () => {
    const skill = { slug: 'demo', app: 'Demo', appIds: ['x.Demo'], summary: 'demo app', updated: '2026-10-23', verified: null, notes: '- one fact', flows: { open: [{ launch: true }] } };
    const back = parseSkill(renderSkill(skill), 'learned');
    assert.deepEqual([back.slug, back.app, back.appIds, back.summary, back.notes, back.flows], ['demo', 'Demo', ['x.Demo'], 'demo app', '- one fact', { open: [{ launch: true }] }]);
  });

  test('store: built-in skills ship; learned skills merge flows, override, keep history, and are found by app id', () => {
    const dir = tempDir();
    const skills = createSkills({ dataDir: dir, log: createTestLog() });
    const hotstar = skills.get('fiZNCxMH9Y.Hotstar');
    assert.equal(hotstar.slug, 'jiohotstar');
    assert.deepEqual(Object.keys(hotstar.flows), ['open', 'search', 'type', 'pickResult', 'play']);
    assert.ok(skills.list().some((s) => s.slug === 'netflix'));

    skills.save({ app: 'Prime Video', appIds: ['3201910019365'], summary: 'search learned', flows: { search: [{ keys: ['KEY_UP', 'KEY_ENTER'] }] } });
    skills.save({ app: 'Prime Video', flows: { type: [{ typeText: true }] } });
    const prime = skills.get('Prime Video');
    assert.equal(prime.source, 'learned');
    assert.deepEqual(Object.keys(prime.flows).sort(), ['search', 'type']);
    assert.match(prime.notes, /rent/, 'notes carried over from the built-in skill');
    assert.equal(fs.readdirSync(path.join(dir, 'skills', 'history')).length, 1);
    assert.throws(() => skills.save({ app: 'Prime Video', flows: { bad: [{ keys: ['KEY_POWEROFF'] }] } }), /not an allowed key/);
  });

  test('runFlow: cold start picks the profile; typing and leaving the keyboard follow the grid', async () => {
    const skills = createSkills({ log: createTestLog() });
    const hotstar = skills.get('jiohotstar');
    const cold = fakeIo({ running: false });
    const state = {};
    await runFlow(hotstar, 'open', cold.io, {}, state);
    assert.deepEqual(cold.calls, ['launch:fiZNCxMH9Y.Hotstar', 'KEY_ENTER']);
    const warm = fakeIo({ running: true });
    await runFlow(hotstar, 'open', warm.io, {}, {});
    assert.deepEqual(warm.calls, ['launch:fiZNCxMH9Y.Hotstar']);

    const typing = fakeIo();
    await runFlow(hotstar, 'type', typing.io, { text: 'harold' }, state);
    await runFlow(hotstar, 'pickResult', typing.io, {}, state);
    assert.deepEqual(typing.calls.slice(-5), ['KEY_RIGHT', 'KEY_RIGHT', 'KEY_RIGHT', 'KEY_RIGHT', 'KEY_ENTER'], 'D is column 3 of 7: four Rights reach the top result');
    const played = await runFlow(hotstar, 'play', typing.io, {}, state);
    assert.equal(played.image.mimeType, 'image/png');
  });
});

describe('titles: JustWatch India → this TV', () => {
  const offer = (tech, service, monetization, url) => ({ monetizationType: monetization, presentationType: 'HD', standardWebURL: url, package: { clearName: service, technicalName: tech } });
  const catalogue = (nodes) => async () => ({ ok: true, json: async () => ({ data: { popularTitles: { edges: nodes.map((node) => ({ node })) } } }) });
  const node = (title, year, offers, objectType = 'MOVIE') => ({ id: title, objectType, content: { title, originalReleaseYear: year }, offers });
  const HK2 = node('Harold & Kumar Escape from Guantanamo Bay', 2008, [
    offer('amazon', 'Amazon Video', 'RENT', 'https://app.primevideo.com/detail?gti=amzn1.dv.gti.x'),
    offer('jiohotstar', 'JioHotstar', 'FLATRATE', 'https://www.hotstar.com/in/movies/harold-and-kumar/1971000669'),
  ]);

  test('picks the included service on an installed app, never the rental', async () => {
    const titles = createTitles({ log: createTestLog(), fetchImpl: catalogue([HK2]) });
    const found = await titles.find('harold and kumar guantanamo', { installedIds: ['fiZNCxMH9Y.Hotstar', '3201910019365'] });
    assert.equal(found.choice.service, 'JioHotstar');
    assert.equal(found.choice.contentId, '1971000669');
    assert.equal(found.choice.skill, 'jiohotstar');
  });

  test('rent-only, not installed, and a requested app that lacks it are reported, not chosen', async () => {
    const rentOnly = node('Rental Film', 2020, [offer('amazon', 'Amazon Video', 'RENT', 'https://app.primevideo.com/detail?gti=a')]);
    let titles = createTitles({ log: createTestLog(), fetchImpl: catalogue([rentOnly]) });
    assert.equal((await titles.find('Rental Film', { installedIds: ['3201910019365'] })).why, 'rent-or-buy-only');
    titles = createTitles({ log: createTestLog(), fetchImpl: catalogue([HK2]) });
    assert.equal((await titles.find('harold', { installedIds: ['3201907018807'] })).why, 'not-on-installed-apps');
    assert.equal((await titles.find('harold', { installedIds: ['fiZNCxMH9Y.Hotstar'], preferApp: 'netflix' })).why, 'not-on-requested-app');
    assert.equal(contentIdFrom('https://www.netflix.com/title/70153404'), '70153404');
  });
});

describe('tools: play_title and save_app_skill', () => {
  function fakeHub() {
    const cmds = [];
    return {
      cmds,
      async handle(cmd) {
        cmds.push(cmd);
        if (cmd.cmd === 'app.status') return { ok: true, value: { running: false } };
        if (cmd.cmd === 'cast.url') return { ok: true, value: { kind: 'dial', via: 'agent' } };
        if (cmd.cmd === 'screen.capture') return { ok: true, value: { at: 1 } };
        return { ok: true, value: {} };
      },
    };
  }
  const store = (installed) => ({ get: (key) => (key === 'app.installed' ? { v: installed.map((id) => ({ id })) } : undefined) });
  const eyes = { latest: () => ({ at: 1, png: Buffer.from('png') }) };
  const titlesWith = (choice, match = { title: 'Harold & Kumar Escape from Guantanamo Bay', year: 2008, offers: [] }) => ({ find: async () => ({ match, candidates: [], choice, why: choice ? 'included' : 'rent-or-buy-only' }) });

  test('JioHotstar: one call runs open → search → type → pickResult → play from the skill and returns the screen', async () => {
    const hub = fakeHub();
    const ctx = {
      hub, store: store(['fiZNCxMH9Y.Hotstar']), eyes, skills: createSkills({ log: createTestLog() }), sleepFn: async () => {},
      titles: titlesWith({ service: 'JioHotstar', appId: 'fiZNCxMH9Y.Hotstar', skill: 'jiohotstar', kind: 'app', monetization: 'FLATRATE', contentId: '1971000669' }),
    };
    const out = await callTool('play_title', { title: 'harold and kumar 2' }, ctx);
    assert.equal(out.isError, false, out.text);
    assert.equal(out.images.length, 1);
    const keys = hub.cmds.filter((c) => c.cmd === 'key').map((c) => c.key);
    assert.equal(hub.cmds.find((c) => c.cmd === 'app.launch').appId, 'fiZNCxMH9Y.Hotstar');
    assert.equal(keys[0], 'KEY_ENTER', 'cold start: the profile picker');
    assert.deepEqual(keys.slice(1, 4), ['KEY_LEFT', 'KEY_UP', 'KEY_ENTER'], 'side menu → Search');
    assert.equal(keys.at(-1), 'KEY_ENTER', 'Watch Now');
    assert.match(out.result.steps.join(' | '), /typed "Harold Kumar Escap"/);
  });

  test('Netflix titles go through the deep link; rentals are refused with where it is', async () => {
    const hub = fakeHub();
    const netflix = await callTool('play_title', { title: 'Friends' }, {
      hub, store: store(['3201907018807']), eyes, skills: createSkills({ log: createTestLog() }),
      titles: titlesWith({ service: 'Netflix', appId: '3201907018807', skill: 'netflix', kind: 'netflix', monetization: 'FLATRATE', contentId: '70153404' }, { title: 'Friends', year: 1994, offers: [] }),
    });
    assert.equal(netflix.result.played, true);
    assert.equal(hub.cmds.find((c) => c.cmd === 'cast.url').url, 'https://www.netflix.com/title/70153404');

    const rental = await callTool('play_title', { title: 'Rental Film' }, {
      hub: fakeHub(), store: store([]), eyes, skills: createSkills({ log: createTestLog() }),
      titles: titlesWith(null, { title: 'Rental Film', year: 2020, offers: [{ service: 'Amazon Video', monetization: 'RENT' }] }),
    });
    assert.equal(rental.result.played, false);
    assert.match(rental.result.summary, /only to rent or buy/);
  });

  test('save_app_skill records a learned flow', async () => {
    const skills = createSkills({ dataDir: tempDir(), log: createTestLog() });
    const ctx = { hub: fakeHub(), store: store([]), skills };
    const saved = await callTool('save_app_skill', { app: 'SonyLIV', flows: { search: [{ keys: ['KEY_UP', 'KEY_ENTER'] }] }, notes: '- search is at the top', verified: 'test' }, ctx);
    assert.equal(saved.isError, false, saved.text);
    assert.deepEqual(skills.get('sonyliv').flows.search, [{ keys: ['KEY_UP', 'KEY_ENTER'] }]);
    const cine = await callTool('save_app_skill', { app: 'CineHD TV', notes: '- movie player' }, ctx);
    assert.equal(cine.isError, false);
  });
});

describe('tools: typing on an app keyboard and the Agent SDK schema', () => {
  test('type_on_keyboard types in one call and can leave the keyboard to the right', async () => {
    const keys = [];
    const hub = { async handle(cmd) { if (cmd.cmd === 'key') keys.push(cmd.key); return { ok: true, value: {} }; } };
    const ctx = { hub, store: { get: () => undefined }, sleepFn: async () => {} };
    const out = await callTool('type_on_keyboard', { rows: HOTSTAR_ROWS, start: 'A', text: 'Harold!', exitRight: true }, ctx);
    assert.equal(out.isError, false, out.text);
    assert.equal(out.result.typed, 'Harold');
    assert.deepEqual(keys.slice(-4), ['KEY_RIGHT', 'KEY_RIGHT', 'KEY_RIGHT', 'KEY_RIGHT']);
    const bad = await callTool('type_on_keyboard', { rows: HOTSTAR_ROWS, start: 'Q9', text: 'a' }, ctx);
    assert.equal(bad.isError, true);
  });

  test('save_app_skill flows survive the Agent SDK schema (a free-form object keeps its keys)', async () => {
    const { toZodShape } = await import('../server/ai/agent-sdk-backend.js');
    const { TOOL_DEFINITIONS } = await import('../server/ai/tools.js');
    const { z } = await import('zod');
    const def = TOOL_DEFINITIONS.find((t) => t.name === 'save_app_skill');
    const parsed = z.object(toZodShape(def.inputSchema)).parse({ app: 'X', flows: { open: [{ launch: true }] } });
    assert.deepEqual(parsed.flows, { open: [{ launch: true }] });
  });
});

describe('titles: Prime Video add-on channels', () => {
  test('an "Amazon Channel" offer is a paid add-on, not chosen, and reported as such', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ data: { popularTitles: { edges: [{ node: { id: 'c', objectType: 'SHOW', content: { title: 'Counterpart', originalReleaseYear: 2017 },
      offers: [{ monetizationType: 'FLATRATE', presentationType: 'HD', standardWebURL: 'https://app.primevideo.com/detail?gti=x', package: { clearName: 'Sony Pictures Amazon Channel', technicalName: 'amazonsonypictures' } }] } }] } } }) });
    const titles = createTitles({ log: createTestLog(), fetchImpl });
    const found = await titles.find('counterpart', { installedIds: ['3201910019365'] });
    assert.equal(found.choice, null);
    assert.equal(found.why, 'paid-add-on');
  });

  test('the Apple TV skill ships with the full title flow', () => {
    const skill = createSkills({ log: createTestLog() }).get('3201807016597');
    assert.equal(skill.slug, 'apple-tv');
    assert.deepEqual(Object.keys(skill.flows), ['open', 'search', 'type', 'pickResult', 'play']);
  });
});
