// App skills: how to get things done inside each TV app, as small Markdown files the AI reads and
// writes. A skill has front matter (app, appIds, summary), free-form notes, and an optional
// ```json block of named flows (open, search, type, pickResult, play, …) that Lumen runs itself,
// so a known path costs one tool call instead of a look-press-look loop.
//
// Built-in skills live in server/ai/skills/*.md; skills the AI learns or improves are saved to
// <dataDir>/skills/<slug>.md (the previous version goes to <dataDir>/skills/history/) and take
// precedence over the built-in file with the same slug.
//
// A skill with `scope: tv` is about the TV itself rather than one app (developer-mode.md). Its
// appIds are the system screens its `launch` step may open, tried in order. TV skills are built in
// only, and run through the tool named in `runWith`, which checks the TV's state before and after
// and supplies runtime values (`var`: pcAddress) that never come from the model.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILT_IN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills');
const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_SKILL_BYTES = 16 * 1024;
const MAX_STEPS = 60;
const MAX_WAIT_MS = 15000;
const FLOW_NAME = /^[a-zA-Z][a-zA-Z0-9]{0,30}$/;
const KEY = /^KEY_[A-Z0-9_]{1,24}$/;
const FORBIDDEN_KEYS = new Set(['KEY_POWER', 'KEY_POWEROFF', 'KEY_POWERON']);
const ACTIONS = 'launch, wait, keys, ifColdStart, typeGrid, typeText, exitGrid, look, waitIme, ifIme, typeDigits';
// Values Lumen fills in at run time (typeText / typeDigits `var`); the model can name one, never set it.
export const RUNTIME_VARS = Object.freeze({
  pcAddress: /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/,
});
const IME_POLL_MS = 100;

/** A state check inside a flow failed (the TV keyboard did not open or close as expected). */
export class FlowCheckError extends Error {
  constructor(message) {
    super(message);
    this.code = 'CHECK_FAILED';
  }
}

const allowedKey = (key) => typeof key === 'string' && KEY.test(key) && !FORBIDDEN_KEYS.has(key);

export const slugOf = (name) => String(name ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// ---------- parsing ----------

export function parseSkill(text, source) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const meta = {};
  let body = text;
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
      if (kv) meta[kv[1]] = kv[2].trim();
    }
    body = m[2];
  }
  let flows = {};
  const block = /```json\s*\r?\n([\s\S]*?)\r?\n```/.exec(body);
  if (block) {
    try {
      flows = JSON.parse(block[1]);
    } catch {
      flows = {};
    }
  }
  const notes = body.replace(/```json\s*\r?\n[\s\S]*?\r?\n```/, '').replace(/^##\s*Flows\s*$/m, '').trim();
  return {
    slug: meta.slug || slugOf(meta.app),
    app: meta.app || '',
    scope: meta.scope === 'tv' ? 'tv' : 'app',
    runWith: meta.runWith || null,
    appIds: (meta.appIds || '').split(',').map((s) => s.trim()).filter(Boolean),
    summary: meta.summary || '',
    updated: meta.updated || null,
    verified: meta.verified || null,
    source,
    notes,
    flows: validateFlows(flows).flows,
  };
}

export function renderSkill(skill) {
  const lines = ['---', `app: ${skill.app}`, `slug: ${skill.slug}`];
  if (skill.scope === 'tv') lines.push('scope: tv');
  if (skill.runWith) lines.push(`runWith: ${skill.runWith}`);
  lines.push(`appIds: ${skill.appIds.join(', ')}`, `summary: ${skill.summary}`, `updated: ${skill.updated}`);
  if (skill.verified) lines.push(`verified: ${skill.verified}`);
  lines.push('---', '', skill.notes.trim(), '');
  if (Object.keys(skill.flows).length) lines.push('## Flows', '', '```json', JSON.stringify(skill.flows, null, 2), '```', '');
  return lines.join('\n');
}

// ---------- flow validation ----------

function validateStep(step, where) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`${where}: a step is an object`);
  const kinds = Object.keys(step).filter((k) => k !== 'gapMs' && k !== 'note');
  if (kinds.length !== 1) throw new Error(`${where}: a step has exactly one action (${ACTIONS})`);
  const [kind] = kinds;
  const value = step[kind];
  if (step.gapMs !== undefined && (!Number.isInteger(step.gapMs) || step.gapMs < 0 || step.gapMs > 5000)) throw new Error(`${where}: gapMs is 0–5000 ms`);
  switch (kind) {
    case 'launch':
    case 'look':
      if (value !== true) throw new Error(`${where}: ${kind} is true`);
      break;
    case 'wait':
      if (!Number.isInteger(value) || value < 0 || value > MAX_WAIT_MS) throw new Error(`${where}: wait is 0–${MAX_WAIT_MS} ms`);
      break;
    case 'keys':
      if (!Array.isArray(value) || !value.length || value.length > 40) throw new Error(`${where}: keys is a list of 1–40 key codes`);
      for (const key of value) {
        if (!allowedKey(key)) throw new Error(`${where}: ${key} is not an allowed key`);
      }
      break;
    case 'ifColdStart':
    case 'ifIme':
      if (!Array.isArray(value)) throw new Error(`${where}: ${kind} is a list of steps`);
      value.forEach((s, i) => validateStep(s, `${where}.${kind}[${i}]`));
      break;
    case 'waitIme':
      // The TV keyboard's state from the remote channel (ms.remote.imeStart / imeEnd): wait until it is
      // open (or closed); timeoutMs 0 checks it once. A miss stops the flow (FlowCheckError).
      if (!value || typeof value !== 'object' || typeof value.open !== 'boolean') throw new Error(`${where}: waitIme is { open: true|false, timeoutMs }`);
      if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 0 || value.timeoutMs > MAX_WAIT_MS)) {
        throw new Error(`${where}: waitIme.timeoutMs is 0–${MAX_WAIT_MS} ms`);
      }
      break;
    case 'typeDigits': {
      // A runtime value typed as number keys, one part at a time (an IP address into four boxes).
      // Before part i: the `home` keys (back to the first box from anywhere), then `next` i times.
      if (!value || typeof value !== 'object' || !Object.hasOwn(RUNTIME_VARS, value.var)) {
        throw new Error(`${where}: typeDigits.var is one of ${Object.keys(RUNTIME_VARS).join(', ')}`);
      }
      if (value.split !== undefined && (typeof value.split !== 'string' || value.split.length !== 1)) throw new Error(`${where}: typeDigits.split is one character`);
      if (value.home !== undefined && (!Array.isArray(value.home) || value.home.length > 12 || !value.home.every(allowedKey))) {
        throw new Error(`${where}: typeDigits.home is a list of at most 12 allowed keys`);
      }
      if (value.next !== undefined && !allowedKey(value.next)) throw new Error(`${where}: typeDigits.next is an allowed key`);
      break;
    }
    case 'typeGrid': {
      const rows = value?.rows;
      if (!Array.isArray(rows) || !rows.length || rows.length > 10 || !rows.every((r) => Array.isArray(r) && r.length && r.length <= 16)) {
        throw new Error(`${where}: typeGrid.rows is a list of key-label rows`);
      }
      if (typeof value.start !== 'string' || !rows.some((r) => r.includes(value.start))) throw new Error(`${where}: typeGrid.start names a key in rows`);
      break;
    }
    case 'typeText':
      if (value !== true && !(value && typeof value === 'object' && !Array.isArray(value))) throw new Error(`${where}: typeText is true or { submit, var }`);
      if (value?.var !== undefined && !Object.hasOwn(RUNTIME_VARS, value.var)) throw new Error(`${where}: typeText.var is one of ${Object.keys(RUNTIME_VARS).join(', ')}`);
      break;
    case 'exitGrid':
      if (value !== 'right') throw new Error(`${where}: exitGrid is "right" (leave the keyboard into the results beside it)`);
      break;
    default:
      throw new Error(`${where}: unknown action "${kind}"`);
  }
}

export function validateFlows(flows) {
  if (!flows || typeof flows !== 'object' || Array.isArray(flows)) return { flows: {} };
  const out = {};
  let count = 0;
  for (const [name, steps] of Object.entries(flows)) {
    if (!FLOW_NAME.test(name)) throw new Error(`flow name "${name}" is not valid`);
    if (!Array.isArray(steps)) throw new Error(`flow ${name} is a list of steps`);
    steps.forEach((s, i) => validateStep(s, `${name}[${i}]`));
    count += steps.length;
    out[name] = steps;
  }
  if (count > MAX_STEPS) throw new Error(`at most ${MAX_STEPS} steps across all flows`);
  return { flows: out };
}

// ---------- grid keyboards ----------

/**
 * Key presses that type `text` on an on-screen grid keyboard. rows: label rows (null = no key; a
 * label repeated across columns is one wide key, e.g. "Space"); focus starts on `start`.
 * Moves go vertically first on the current column, then horizontally; a wide key is crossed in one
 * press. Characters the grid lacks are skipped. Returns { keys, typed, end: { row, col }, cols }.
 */
export function gridPath({ rows, start, space = 'Space', maxChars = 24 }, text) {
  const cols = Math.max(...rows.map((r) => r.length));
  // A row's keys left to right; a label repeated in adjacent columns is one wide key.
  const slotsOf = (row) => {
    const out = [];
    row.forEach((label, c) => {
      if (label == null) return;
      const last = out[out.length - 1];
      if (last && last.label === label && last.end === c - 1) last.end = c;
      else out.push({ label, start: c, end: c });
    });
    return out;
  };
  const slotIndex = (r, c) => {
    const slots = slotsOf(rows[r]);
    let best = 0;
    let dist = Infinity;
    slots.forEach((s, i) => {
      const d = c < s.start ? s.start - c : c > s.end ? c - s.end : 0;
      if (d < dist) { dist = d; best = i; }
    });
    return best;
  };
  const find = (label) => {
    for (let r = 0; r < rows.length; r++) {
      const c = rows[r].findIndex((cell) => cell != null && String(cell).toLowerCase() === String(label).toLowerCase());
      if (c >= 0) return { r, c };
    }
    return null;
  };
  let pos = find(start);
  const keys = [];
  let typed = '';
  for (const ch of String(text)) {
    if (typed.replace(/ /g, '').length >= maxChars) break;
    if (ch === ' ' && (!typed || typed.endsWith(' ') || !space)) continue;
    const target = find(ch === ' ' ? space : ch);
    if (!target) continue;
    // vertical on the current column (TV keyboards return to the column you left), then horizontal
    while (pos.r !== target.r) {
      keys.push(pos.r < target.r ? 'KEY_DOWN' : 'KEY_UP');
      pos = { r: pos.r + (pos.r < target.r ? 1 : -1), c: pos.c };
    }
    const from = slotIndex(pos.r, pos.c);
    const to = slotIndex(target.r, target.c);
    for (let i = 0; i < Math.abs(to - from); i++) keys.push(to > from ? 'KEY_RIGHT' : 'KEY_LEFT');
    if (to !== from) pos = { r: target.r, c: target.c };
    keys.push('KEY_ENTER');
    typed += ch;
  }
  return { keys, typed: typed.trim(), end: { row: pos.r, col: pos.c }, cols };
}

// ---------- store ----------

export function createSkills({ dataDir, log }) {
  const logger = log?.child?.('skills') ?? { info() {}, warn() {}, debug() {} };
  const learnedDir = dataDir ? path.join(dataDir, 'skills') : null;

  function readDir(dir, source) {
    const out = new Map();
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
    } catch {
      return out;
    }
    for (const name of names) {
      try {
        const skill = parseSkill(fs.readFileSync(path.join(dir, name), 'utf8'), source);
        if (SLUG.test(skill.slug)) out.set(skill.slug, skill);
      } catch (err) {
        logger.warn('skill not readable', { file: name, error: err.message });
      }
    }
    return out;
  }

  function all() {
    const skills = readDir(BUILT_IN_DIR, 'built-in');
    if (learnedDir) for (const [slug, skill] of readDir(learnedDir, 'learned')) skills.set(slug, skill);
    return skills;
  }

  /** By slug, app name or app id. */
  function get(query) {
    const q = String(query ?? '').trim();
    if (!q) return null;
    const skills = all();
    const slug = slugOf(q);
    if (skills.has(slug)) return skills.get(slug);
    for (const skill of skills.values()) {
      if (skill.appIds.includes(q) || slugOf(skill.app) === slug || slugOf(skill.app).includes(slug) || (slug && slug.includes(slugOf(skill.app)))) return skill;
    }
    return null;
  }

  function list() {
    return [...all().values()].map(({ slug, app, scope, appIds, summary, updated, source, verified, flows }) => ({
      slug, app, scope, appIds, summary, updated, source, verified, flows: Object.keys(flows),
    })).sort((a, b) => a.app.localeCompare(b.app));
  }

  /** Writes a learned skill; merges flows into the existing skill unless replaceFlows. */
  function save({ app, appIds = [], summary, notes, flows, replaceFlows = false, verified }) {
    if (!learnedDir) throw new Error('skills cannot be saved here');
    const slug = slugOf(app);
    if (!SLUG.test(slug)) throw new Error('app name is not usable');
    let current = get(slug);
    // TV skills drive system screens blind with runtime values; only the built-in file defines them,
    // and an app skill never inherits their flows through a loose name match.
    if (current?.scope === 'tv') {
      if (current.slug === slug) throw new Error(`${current.app} is a built-in TV skill and cannot be changed`);
      current = null;
    }
    const merged = {
      slug,
      app: String(app).slice(0, 60),
      appIds: [...new Set([...(current?.appIds ?? []), ...appIds])].slice(0, 8),
      summary: String(summary ?? current?.summary ?? '').replace(/\s+/g, ' ').slice(0, 200),
      notes: String(notes ?? current?.notes ?? '').slice(0, 8000),
      flows: replaceFlows ? validateFlows(flows ?? {}).flows : { ...(current?.flows ?? {}), ...validateFlows(flows ?? {}).flows },
      updated: new Date().toISOString().slice(0, 10),
      verified: verified ?? current?.verified ?? null,
    };
    const text = renderSkill(merged);
    if (Buffer.byteLength(text) > MAX_SKILL_BYTES) throw new Error(`a skill is at most ${MAX_SKILL_BYTES / 1024} KB`);
    fs.mkdirSync(path.join(learnedDir, 'history'), { recursive: true });
    const file = path.join(learnedDir, `${slug}.md`);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(learnedDir, 'history', `${slug}-${Date.now()}.md`));
    fs.writeFileSync(file, text, 'utf8');
    logger.info('skill saved', { slug, flows: Object.keys(merged.flows) });
    return { ...merged, source: 'learned' };
  }

  function remove(slug) {
    if (!learnedDir || !SLUG.test(slug)) return false;
    const file = path.join(learnedDir, `${slug}.md`);
    if (!fs.existsSync(file)) return false;
    fs.mkdirSync(path.join(learnedDir, 'history'), { recursive: true });
    fs.renameSync(file, path.join(learnedDir, 'history', `${slug}-${Date.now()}-removed.md`));
    return true;
  }

  return { get, list, save, remove };
}

// ---------- running flows ----------

// A launch that fails with one of these codes moves on to the skill's next app id (the TV does not
// have that id); anything else (TV off, not paired, cancelled) stops the flow.
const TRY_NEXT_ID = new Set(['UNAVAILABLE', 'NOT_FOUND', 'FAILED']);

function runtimeValue(ctx, name) {
  const value = ctx.vars?.[name];
  if (typeof value !== 'string' || !RUNTIME_VARS[name]?.test(value)) throw new Error(`Lumen does not know ${name} right now`);
  return value;
}

/**
 * Runs one flow of a skill. io: { key(k), launch(appId) → { visible }?, isRunning(appId),
 * typeText(text, submit), imeOpen() → boolean, look() → image, sleep(ms), aborted() }.
 * ctx: { text } for typing steps, { vars } for runtime values. State carries across flows of one
 * task (coldStart, grid end position, launched id). → { steps, image }; a failed state check throws
 * FlowCheckError.
 */
export async function runFlow(skill, name, io, ctx = {}, state = {}) {
  const steps = skill.flows?.[name];
  if (!steps) throw new Error(`${skill.app} has no "${name}" flow`);
  const done = [];
  let image = null;
  const pressAll = async (keys, gapMs) => {
    for (const [i, key] of keys.entries()) {
      if (io.aborted?.()) throw new Error('Cancelled');
      await io.key(key);
      if (i < keys.length - 1) await io.sleep(gapMs);
    }
  };
  async function launch() {
    let firstError = null;
    for (const appId of skill.appIds) {
      try {
        state.coldStart = !(await io.isRunning(appId).catch(() => false));
        const res = await io.launch(appId);
        state.launched = { id: appId, visible: res?.visible === true };
        done.push(`launched ${skill.app}${skill.scope === 'tv' ? ` (${appId})` : ''}${state.coldStart ? ' (cold start)' : ''}`);
        return;
      } catch (err) {
        firstError ??= err; // the main id's failure says the most
        if (!TRY_NEXT_ID.has(err?.code)) throw err;
      }
    }
    throw firstError ?? new Error(`${skill.app} has no app id to open`);
  }
  async function waitIme({ open, timeoutMs = 0 }) {
    if (typeof io.imeOpen !== 'function') throw new FlowCheckError('Lumen cannot see whether the TV keyboard is open');
    // Counted polls rather than a clock, so a test's instant sleep ends the wait at once.
    for (let polls = Math.ceil(timeoutMs / IME_POLL_MS); ; polls--) {
      if (io.imeOpen() === open) return;
      if (polls <= 0) {
        throw new FlowCheckError(open ? 'The TV keyboard did not open, so the text field was not reached' : 'The TV keyboard is open, so the keys went into a text field');
      }
      if (io.aborted?.()) throw new Error('Cancelled');
      await io.sleep(IME_POLL_MS);
    }
  }
  async function run(list) {
    for (const step of list) {
      if (io.aborted?.()) throw new Error('Cancelled');
      if (step.launch) {
        await launch();
      } else if (step.waitIme) {
        await waitIme(step.waitIme);
        done.push(step.waitIme.open ? 'the TV keyboard opened' : 'no TV keyboard open');
      } else if (step.ifIme) {
        if (io.imeOpen?.() === true) await run(step.ifIme);
      } else if (step.typeDigits) {
        const { var: name, split = '.', home = [], next = 'KEY_RIGHT' } = step.typeDigits;
        const parts = runtimeValue(ctx, name).split(split);
        if (!parts.every((part) => /^\d{1,4}$/.test(part))) throw new Error(`${name} is not made of number fields`);
        for (const [i, part] of parts.entries()) {
          const keys = [...home, ...Array.from({ length: i }, () => next), ...[...part].map((d) => `KEY_${d}`)];
          await pressAll(keys, step.gapMs ?? 300);
          if (i < parts.length - 1) await io.sleep(step.gapMs ?? 300);
        }
        done.push(`typed ${name} with number keys (${parts.length} fields)`);
      } else if (step.wait !== undefined) {
        await io.sleep(step.wait);
      } else if (step.keys) {
        await pressAll(step.keys, step.gapMs ?? 350);
        done.push(`pressed ${step.keys.length} key${step.keys.length === 1 ? '' : 's'}`);
      } else if (step.ifColdStart) {
        if (state.coldStart) await run(step.ifColdStart);
      } else if (step.typeGrid) {
        const text = ctx.text ?? '';
        const plan = gridPath(step.typeGrid, text);
        for (const [i, key] of plan.keys.entries()) {
          await io.key(key);
          if (i < plan.keys.length - 1) await io.sleep(step.gapMs ?? 280);
        }
        state.grid = { ...plan.end, cols: plan.cols };
        state.typed = plan.typed;
        done.push(`typed "${plan.typed}" on the app's keyboard`);
      } else if (step.typeText) {
        const name = step.typeText?.var;
        const text = name ? runtimeValue(ctx, name) : ctx.text ?? '';
        await io.typeText(text, step.typeText?.submit === true);
        state.typed = text;
        done.push(name ? `typed ${name}` : `typed "${text}"`);
      } else if (step.exitGrid) {
        const keys = exitRightKeys(state);
        for (const key of keys) { await io.key(key); await io.sleep(step.gapMs ?? 300); }
        done.push('moved into the results');
      } else if (step.look) {
        image = await io.look();
      }
    }
  }
  await run(steps);
  return { steps: done, image };
}

/** Right presses that leave a grid keyboard from its last typed key into the results beside it. */
export function exitRightKeys(state) {
  if (!state.grid) return [];
  return Array.from({ length: Math.max(1, state.grid.cols - state.grid.col) }, () => 'KEY_RIGHT');
}
