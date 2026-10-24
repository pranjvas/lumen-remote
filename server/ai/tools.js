// AI tools: one definition list shared by the API backend and the MCP endpoint.
// Model output is untrusted, so every call is validated against its schema here and then
// checked semantically; actions go through hub.handle so the hub's safety rules and read-back
// apply exactly as they do for a browser command.
import { matchUrl, parseCastUrl } from '../features/cast.js';
import { RUNTIME_VARS, gridPath, runFlow } from './skills.js';

// The synthetic hub client for AI-issued commands; acks go nowhere (handle() returns them).
const AI_CLIENT = Object.freeze({ id: 'lumen-ai', ai: true, send() {} });

const AGENT_APP = 'lumenrmt01.LumenAgent';

const POWER_KEYS = new Set(['KEY_POWER', 'KEY_POWEROFF', 'KEY_POWERON']);


const DEFAULT_INPUTS = ['TV', 'HDMI1', 'HDMI2', 'HDMI3', 'HDMI4', 'AV1'];
const SETTING_GROUPS = ['picture', 'pictureAdvanced', 'sound', 'input', 'general'];
const PICTURE_DIGEST = ['mode', 'backlight', 'contrast', 'shadowDetail', 'sharpness', 'color', 'tint', 'colorTone', 'localDimming'];
const REFRESH_GROUP = { picture: 'picture', pictureAdvanced: 'picture', sound: 'sound' };
const APP_ALIASES = {
  amazon: 'primevideo', amazonprime: 'primevideo', amazonvideo: 'primevideo', prime: 'primevideo',
  disney: 'jiohotstar', disneyplus: 'jiohotstar', disneyhotstar: 'jiohotstar', hotstar: 'jiohotstar',
  browser: 'internet', webbrowser: 'internet',
};
const INPUT_ALIASES = { tv: 'TV', livetv: 'TV', antenna: 'TV', aerial: 'TV', broadcast: 'TV', av: 'AV1' };
const LIST_APPS_MAX = 150;

class ToolFailure extends Error {
  constructor(message, code = 'INVALID') {
    super(message);
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new ToolFailure(message, code);
};

// ---------- small helpers ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (n, [min, max]) => Math.min(max, Math.max(min, n));
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const valueOf = (store, key) => store.get(key)?.v;

function provenance(record) {
  if (record.stale || (record.ttlMs && Date.now() - record.at > record.ttlMs)) return 'stale';
  return record.src;
}

// A value with where it came from, or undefined (omitted from JSON) when unknown.
function reading(store, key) {
  const record = store.get(key);
  return record && record.v != null ? { value: record.v, src: provenance(record) } : undefined;
}

function changed(label, from, to) {
  let summary = `${label} ${from} → ${to}`;
  if (to == null) summary = `${label} changed`;
  else if (from == null) summary = `${label} ${to}`;
  else if (from === to) summary = `${label} ${to} (unchanged)`;
  return { ok: true, from: from ?? null, to: to ?? null, summary };
}

async function send(hub, cmd) {
  let res;
  try {
    res = await hub.handle(cmd, AI_CLIENT);
  } catch (err) {
    fail(err.message || 'The command failed', err.code || 'FAILED');
  }
  if (!res?.ok) fail(res?.error?.message || 'The command failed', res?.error?.code || 'FAILED');
  return res.value;
}

// The TV-side actions a skill flow needs, through the same hub commands as the remote.
function flowIo({ hub, store, eyes, signal, sleepFn = sleep }) {
  return {
    key: (key) => send(hub, { cmd: 'key', key }),
    launch: (appId) => send(hub, { cmd: 'app.launch', appId }),
    isRunning: async (appId) => (await send(hub, { cmd: 'app.status', appId }))?.running === true,
    typeText: (text, submit) => send(hub, { cmd: 'text.send', text, submit }),
    // The TV keyboard, as the remote channel reports it (ms.remote.imeStart / imeEnd).
    imeOpen: () => store?.get?.('ime')?.v?.open === true,
    sleep: sleepFn,
    aborted: () => signal?.aborted === true,
    async look() {
      if (!eyes?.latest) return null;
      try {
        const shot = await send(hub, { cmd: 'screen.capture' });
        const latest = eyes.latest();
        return latest?.at === shot.at ? { data: latest.png.toString('base64'), mimeType: 'image/png' } : null;
      } catch {
        return null;
      }
    },
  };
}

// What to type into an app's search: letters, digits and single spaces ("Harold & Kumar" → "Harold Kumar").
function cleanSearchText(text) {
  return String(text ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(above + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

// 0–100 for two normalised names; MIN_MATCH keeps typo-level matches and drops unrelated ones.
const MIN_MATCH = 45;
function similarity(query, candidate) {
  if (!query || !candidate) return 0;
  if (query === candidate) return 100;
  if (query.length < 2) return 0;
  if (candidate.startsWith(query) || (candidate.length >= 3 && query.startsWith(candidate))) return 80;
  if (candidate.includes(query) || (candidate.length >= 4 && query.includes(candidate))) return 60;
  const d = levenshtein(query, candidate);
  return d <= Math.max(1, Math.floor(candidate.length / 4)) ? 50 - d : 0;
}

// Best item whose name (or id) resembles the query; the first item wins ties, so callers order by preference.
function bestMatch(query, items, namesOf) {
  const q = norm(query);
  let best = null;
  let bestScore = MIN_MATCH - 1;
  for (const item of items) {
    const score = Math.max(...namesOf(item).map((name) => similarity(q, norm(name))));
    if (score > bestScore) [best, bestScore] = [item, score];
  }
  return best;
}

// Parse and classify a link exactly as the cast feature will.
function classifyLink(text) {
  let url;
  try {
    url = parseCastUrl(text);
  } catch (err) {
    fail(err.message);
  }
  return { href: url.href, host: url.hostname.replace(/^www\./, ''), match: matchUrl(url) };
}

function foregroundApp(store) {
  const app = valueOf(store, 'app.foreground');
  return app ? { id: app.id ?? null, name: app.name ?? app.id ?? null } : null;
}

function mergedApps(store, catalog) {
  const byId = new Map(catalog.apps.map((app) => [app.id, { id: app.id, name: app.name }]));
  const installed = (valueOf(store, 'app.installed') ?? [])
    .filter((app) => app?.id && !byId.has(app.id))
    .map((app) => ({ id: app.id, name: app.name ?? app.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...byId.values(), ...installed].filter((app) => app.id !== AGENT_APP);
}

function findSetting(catalog, key) {
  const setting = catalog.settings.find((entry) => entry.key === key);
  if (setting) return setting;
  const near = catalog.settings.filter((entry) => similarity(norm(key), norm(entry.key)) > 0 || similarity(norm(key), norm(entry.label)) > 0);
  fail(`Unknown setting "${key}". ${near.length ? `Did you mean ${near.slice(0, 4).map((e) => e.key).join(', ')}?` : 'Use list_settings.'}`);
}

function assertWritable(setting, store, catalog) {
  if (setting.type === 'tracked') {
    fail(`${setting.label} has no API on this TV, so Lumen cannot change it. It is set on the TV in ${setting.menuPath} (press_keys KEY_MENU opens the TV menu).`, 'UNAVAILABLE');
  }
  if (setting.type === 'readonly' || !setting.writable) fail(`${setting.label} is read-only`, 'UNAVAILABLE');
  const dep = setting.dependsOn;
  const current = dep && valueOf(store, dep.key);
  if (dep && current != null && current !== dep.value) {
    const depLabel = catalog.settings.find((entry) => entry.key === dep.key)?.label ?? dep.key;
    fail(`${setting.label} only applies when ${depLabel} is ${dep.value} (now ${current})`, 'UNAVAILABLE');
  }
}

function coerceValue(setting, value) {
  if (setting.type === 'range') {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) fail(`${setting.label} needs a number`);
    const [min, max] = setting.range;
    const step = setting.step ?? 1;
    const rounded = Math.round(n / step) * step;
    if (rounded < min || rounded > max) fail(`${setting.label} goes from ${min} to ${max}`);
    return rounded;
  }
  const wanted = typeof value === 'boolean' ? (value ? 'On' : 'Off') : String(value);
  const option = setting.options?.find((o) => norm(o) === norm(wanted));
  if (!option) fail(`${setting.label} can be ${setting.options?.join(', ')}`);
  return option;
}

// Read a numeric setting, re-reading the TV first when Lumen's copy is missing or stale.
async function currentNumber(setting, { hub, store }) {
  const record = store.get(setting.key);
  if (!record || typeof record.v !== 'number' || provenance(record) === 'stale') {
    await send(hub, { cmd: 'settings.refresh', group: REFRESH_GROUP[setting.group] ?? 'all' }).catch(() => {});
  }
  const value = valueOf(store, setting.key);
  if (typeof value !== 'number') fail(`The current ${setting.label} is unknown; use set_setting with an exact value`, 'UNAVAILABLE');
  return value;
}

function keyLabel(catalog, key) {
  return catalog.keys.find((entry) => entry.key === key)?.label ?? key;
}

function describeKeys(catalog, keys) {
  const runs = [];
  for (const key of keys) {
    const last = runs.at(-1);
    if (last?.key === key) last.count++;
    else runs.push({ key, count: 1 });
  }
  return runs.map(({ key, count }) => (count > 1 ? `${keyLabel(catalog, key)} ×${count}` : keyLabel(catalog, key))).join(', ');
}

function resolveInput(wanted, options, labels, connected) {
  const q = norm(wanted);
  const alias = INPUT_ALIASES[q];
  if (alias && options.includes(alias)) return alias;
  const direct = options.find((option) => norm(option) === q);
  if (direct) return direct;
  if (q === 'hdmi') {
    const hdmi = (connected ?? []).filter((s) => /^HDMI\d$/.test(s) && options.includes(s));
    if (hdmi.length === 1) return hdmi[0];
  }
  const labelled = bestMatch(wanted, Object.entries(labels ?? {}).filter(([source]) => options.includes(source)), ([, label]) => [label]);
  if (labelled) return labelled[0];
  fail(`Unknown input "${wanted}". Inputs: ${options.join(', ')}`);
}

function castSummary(session, fallback) {
  switch (session?.kind) {
    case 'youtube': return 'Playing on YouTube';
    case 'netflix': return 'Opened in Netflix';
    case 'prime': return 'Opened in Prime Video';
    case 'media': return `Casting ${session.title ?? 'media'}`;
    case 'page': return 'Opened in the TV browser';
    default: return fallback;
  }
}

// ---------- Developer mode (server/ai/skills/developer-mode.md) ----------

const DEV_SKILL = 'developer-mode';
// Arabic and Hebrew TVs show the Host PC IP boxes right to left (Moonlight-Tizen's install guide).
const RTL_LANGUAGE = /^(ar|he|iw)([_-]|$)/i;
const DEV_SETTLE_MS = 1500;
export const DEV_RESTART_STEP = 'Restart the TV so it takes effect: hold the Power button on the TV remote for about 2 seconds until the TV turns off, wait a few seconds, then turn it on again. If Developer mode is still off after that, unplug the TV for 10 seconds and plug it back in.';
const DIALOG_LOOK = 'a "Developer mode" box (Developer mode: On / Off buttons, Host PC IP in four boxes, OK / Cancel)';

// A fresh REST read of the TV (hub device.refresh); {} when the TV did not answer.
async function readDevice(hub) {
  try {
    return (await send(hub, { cmd: 'device.refresh' })) ?? {};
  } catch {
    return {};
  }
}

async function thisPcAddress(ctx) {
  let address = null;
  try {
    address = await ctx.pcAddress?.();
  } catch {
    address = null;
  }
  if (typeof address !== 'string' || !RUNTIME_VARS.pcAddress.test(address)) {
    fail('Lumen cannot tell this PC\'s address on the TV\'s network, so it cannot fill in Host PC IP', 'UNAVAILABLE');
  }
  return address;
}

// ---------- schema validation (the subset the definitions below use) ----------

const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  integer: Number.isInteger,
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

function validate(schema, value, path = 'input') {
  const types = [schema.type].flat();
  if (!types.some((type) => TYPE_CHECKS[type](value))) return `${path} must be ${types.join(' or ')}`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(', ')}`;
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) return `${path} must not be empty`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} is longer than ${schema.maxLength} characters`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} item(s)`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} allows at most ${schema.maxItems} items`;
    for (const [i, item] of value.entries()) {
      const problem = validate(schema.items, item, `${path}[${i}]`);
      if (problem) return problem;
    }
  }
  if (types.includes('object') && TYPE_CHECKS.object(value) && schema.properties) {
    for (const key of Object.keys(value)) {
      if (!(key in schema.properties)) return `${path} has an unexpected field "${key}"`;
    }
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) return `${path}.${key} is required`;
    }
    for (const [key, child] of Object.entries(value)) {
      const problem = validate(schema.properties[key], child, `${path}.${key}`);
      if (problem) return problem;
    }
  }
  return null;
}

const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const urlProp = (description) => ({ type: 'string', minLength: 1, maxLength: 2048, description });

// ---------- the tools ----------

const TOOLS = [
  {
    name: 'get_tv_state',
    description: 'Read a compact digest of the TV right now: power, volume and mute, input, picture mode and key picture values, sound mode, foreground app, channel, sleep timer. Each value carries its source (live, agent, tracked, cache, derived or stale). Call this before any relative change and whenever the user asks what is on or what a value is.',
    inputSchema: object(),
    run(_input, { store }) {
      const labels = valueOf(store, 'input.labels') ?? {};
      const source = reading(store, 'input.source');
      const sleepState = valueOf(store, 'sleep');
      const picture = Object.fromEntries(PICTURE_DIGEST
        .map((name) => [name, reading(store, `picture.${name}`)])
        .filter(([, r]) => r));
      const state = {
        power: valueOf(store, 'power.state') ?? valueOf(store, 'conn.tv') ?? 'unknown',
        volume: reading(store, 'audio.volume'),
        muted: reading(store, 'audio.mute'),
        input: source && { ...source, label: labels[source.value] },
        picture,
        sound: { mode: reading(store, 'audio.soundMode'), output: reading(store, 'audio.speaker') },
        app: foregroundApp(store),
        channel: valueOf(store, 'channel.current') ?? null,
        sleep: sleepState?.endsAt ? { minutesLeft: Math.max(0, Math.ceil((sleepState.endsAt - Date.now()) / 60_000)) } : null,
        links: { remote: valueOf(store, 'conn.remote'), ipControl: valueOf(store, 'conn.ipc'), agent: valueOf(store, 'conn.agent') },
      };
      const summary = [
        `TV ${state.power}`,
        state.volume && `volume ${state.volume.value}${state.muted?.value ? ' (muted)' : ''}`,
        source?.value,
        picture.mode?.value,
        state.app?.name,
      ].filter(Boolean).join(' · ');
      return { ok: true, summary, state };
    },
  },
  {
    name: 'list_settings',
    description: 'List the TV settings Lumen knows: key, label, type, range or options, the current value with its source, and whether Lumen can change it. Call this to find the right setting key before set_setting or change_setting.',
    inputSchema: object({
      group: { type: 'string', enum: SETTING_GROUPS, description: 'Only this group (picture, pictureAdvanced, sound, input, general)' },
    }),
    run({ group }, { store, catalog }) {
      const settings = catalog.settings
        .filter((setting) => !group || setting.group === group)
        .map((setting) => {
          const current = reading(store, setting.key);
          return {
            key: setting.key,
            label: setting.label,
            type: setting.type,
            ...(setting.range && { range: setting.range }),
            ...(setting.options && { options: setting.options }),
            ...(current && { value: current.value, src: current.src }),
            writable: setting.type !== 'tracked' && setting.type !== 'readonly' && Boolean(setting.writable),
            ...(setting.dependsOn && { dependsOn: setting.dependsOn }),
          };
        });
      return { ok: true, summary: `${settings.length} settings`, settings };
    },
  },
  {
    name: 'set_setting',
    description: 'Set one TV setting to an exact value: a number inside its range or one of its options (for example picture.backlight 14, picture.mode "Movie", picture.localDimming "High"). Returns the value read back from the TV. Use change_setting for "a bit more" or "up by N".',
    inputSchema: object({
      key: { type: 'string', minLength: 1, maxLength: 64, description: 'Setting key from list_settings, e.g. picture.backlight' },
      value: { type: ['number', 'string', 'boolean'], description: 'A number for range settings, an option name for the others' },
    }, ['key', 'value']),
    async run({ key, value }, { hub, store, catalog }) {
      const setting = findSetting(catalog, key);
      assertWritable(setting, store, catalog);
      const target = coerceValue(setting, value);
      const from = valueOf(store, key);
      const to = await send(hub, { cmd: 'setting.set', key, value: target });
      return { key, ...changed(setting.label, from, to ?? target) };
    },
  },
  {
    name: 'change_setting',
    description: 'Change a numeric TV setting relative to its current value (for example picture.backlight +5 for "increase brightness"). Reads the current value, clamps the result to the setting\'s range and returns the value read back from the TV.',
    inputSchema: object({
      key: { type: 'string', minLength: 1, maxLength: 64, description: 'Numeric setting key, e.g. picture.backlight' },
      delta: { type: 'integer', minimum: -100, maximum: 100, description: 'Amount to add (negative to lower)' },
    }, ['key', 'delta']),
    async run({ key, delta }, ctx) {
      const { hub, store, catalog } = ctx;
      const setting = findSetting(catalog, key);
      if (setting.type !== 'range') fail(`${setting.label} is not numeric; use set_setting with one of: ${setting.options?.join(', ')}`);
      assertWritable(setting, store, catalog);
      if (delta === 0) fail('delta must not be 0');
      const from = await currentNumber(setting, ctx);
      const target = clamp(from + delta, setting.range);
      if (target === from) return { ok: true, key, from, to: from, summary: `${setting.label} is already at ${from} (range ${setting.range.join('–')})` };
      const to = await send(hub, { cmd: 'setting.set', key, value: target });
      return { key, ...changed(setting.label, from, to ?? target) };
    },
  },
  {
    name: 'set_volume',
    description: 'Set the TV volume to an exact level (0–100). Lumen enforces a safety cap; the result is the level read back from the TV. Setting the volume also unmutes the TV.',
    inputSchema: object({
      level: { type: 'integer', minimum: 0, maximum: 100, description: 'Volume level 0–100' },
    }, ['level']),
    async run({ level }, { hub, store }) {
      const from = valueOf(store, 'audio.volume');
      const to = await send(hub, { cmd: 'volume.set', value: level });
      return changed('Volume', from, to ?? level);
    },
  },
  {
    name: 'change_volume',
    description: 'Raise or lower the TV volume relative to its current level ("a bit louder" = +3, "quieter" = -3). Returns the level read back from the TV.',
    inputSchema: object({
      delta: { type: 'integer', minimum: -100, maximum: 100, description: 'Steps to add (negative to lower)' },
    }, ['delta']),
    async run({ delta }, { hub, store }) {
      if (delta === 0) fail('delta must not be 0');
      const from = valueOf(store, 'audio.volume');
      let to;
      if (Math.abs(delta) <= 5) {
        to = await send(hub, { cmd: 'volume.step', delta });
      } else {
        if (typeof from !== 'number') fail('The current volume is unknown; use set_volume with an exact level', 'UNAVAILABLE');
        to = await send(hub, { cmd: 'volume.set', value: clamp(from + delta, [0, 100]) });
      }
      return changed('Volume', from, to);
    },
  },
  {
    name: 'set_mute',
    description: 'Mute or unmute the TV sound.',
    inputSchema: object({ muted: { type: 'boolean', description: 'true to mute, false to unmute' } }, ['muted']),
    async run({ muted }, { hub }) {
      const value = await send(hub, { cmd: 'mute.set', value: muted });
      const now = value ?? muted;
      return { ok: true, muted: now, summary: now ? 'Muted' : 'Unmuted' };
    },
  },
  {
    name: 'press_keys',
    description: 'Press remote-control keys in order, like the physical remote (KEY_UP, KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_ENTER, KEY_RETURN, KEY_HOME, KEY_MENU, KEY_SOURCE, KEY_PLAY, KEY_PAUSE, KEY_PLAY_BACK, KEY_CHUP, KEY_CHDOWN, KEY_0…KEY_9, colour keys…). Use only when no exact tool fits. Power keys are not allowed (use power). At most 20 keys.',
    inputSchema: object({
      keys: {
        type: 'array', minItems: 1, maxItems: 20,
        items: { type: 'string', minLength: 1, maxLength: 32 },
        description: 'Key codes such as KEY_DOWN',
      },
      gapMs: { type: 'integer', minimum: 120, maximum: 2000, description: 'Pause between keys in ms (default 300)' },
    }, ['keys']),
    async run({ keys: raw, gapMs = 300 }, { hub, store, catalog, signal }) {
      const keys = raw.map((k) => {
        const key = k.trim().toUpperCase();
        return key.startsWith('KEY_') ? key : `KEY_${key}`;
      });
      for (const key of keys) {
        if (POWER_KEYS.has(key)) fail('Power keys are not allowed here; use the power tool');
        if (!catalog.isAllowedKey(key)) fail(`${key} is not an allowed key`);
      }
      for (const [i, key] of keys.entries()) {
        if (signal?.aborted) fail(`Cancelled after ${i} of ${keys.length} keys`, 'FAILED');
        try {
          await send(hub, { cmd: 'key', key });
        } catch (err) {
          fail(`${err.message} (after ${i} of ${keys.length} keys)`, err.code);
        }
        if (i < keys.length - 1) await sleep(gapMs);
      }
      return { ok: true, pressed: keys.length, summary: `Pressed ${describeKeys(catalog, keys)}` };
    },
  },
  {
    name: 'list_apps',
    description: 'List the apps that can be launched on the TV, and the app in the foreground.',
    inputSchema: object(),
    run(_input, { store, catalog }) {
      const apps = mergedApps(store, catalog);
      return {
        ok: true,
        summary: `${apps.length} apps`,
        foreground: foregroundApp(store)?.name ?? null,
        apps: apps.slice(0, LIST_APPS_MAX).map((app) => app.name),
        ...(apps.length > LIST_APPS_MAX && { more: apps.length - LIST_APPS_MAX }),
      };
    },
  },
  {
    name: 'launch_app',
    description: 'Open an app on the TV by name or id (fuzzy: "netflix", "prime", "hotstar", "plex"). To open a specific Netflix title or YouTube video use open_netflix or play_youtube instead.',
    inputSchema: object({
      app: { type: 'string', minLength: 1, maxLength: 80, description: 'App name or id' },
    }, ['app']),
    async run({ app }, { hub, store, catalog }) {
      const apps = mergedApps(store, catalog);
      const alias = APP_ALIASES[norm(app)];
      const match = bestMatch(alias ?? app, apps, (entry) => [entry.name, entry.id]);
      if (!match) fail(`No app matches "${app}". Some apps: ${apps.slice(0, 12).map((a) => a.name).join(', ')}`, 'UNAVAILABLE');
      await send(hub, { cmd: 'app.launch', appId: match.id });
      return { ok: true, app: match.name, summary: `Opened ${match.name}` };
    },
  },
  {
    name: 'free_tv_memory',
    description: 'Free memory on the TV by closing apps running in the background (never the one on screen; they start fresh next time). Use when the TV is slow or low on memory.',
    inputSchema: object({}, []),
    async run(_args, { hub }) {
      const r = await send(hub, { cmd: 'tv.freeMemory' });
      const names = (r?.closed ?? []).map((c) => c.name);
      return {
        ok: true, closed: names, freedMb: r?.freedMb ?? null, availableMb: r?.after?.availableMb ?? null,
        summary: names.length ? `Closed ${names.join(', ')}` : 'No apps were running in the background',
      };
    },
  },
  {
    name: 'enable_developer_mode',
    description: 'Turn on the TV\'s Developer mode with this PC as Host PC IP (the TV agent and Lumen Eyes need it), with the built-in developer-mode TV skill. It works without the TV agent or Lumen Eyes: a fixed key sequence over the remote channel, checked with what the TV reports itself (the app launch, the TV keyboard state, Developer mode over REST). It runs in two calls. The first opens Apps and enters 1 2 3 4 5; Lumen cannot see whether the Developer mode box appeared, so unless the result has a picture of the screen, ask the user one short question: is that box on the TV? If yes, call again with dialogOpen: true (Lumen switches it On, types this PC\'s address, presses OK and checks); if no, call with cancel: true. Each result\'s `next` says what to do; when the user must open Apps (or App Settings on 2024+ TVs) themselves, ask them to, then call with appsOpen: true. Afterwards always tell the user plainly to restart the TV (the result\'s `restart`). probe: true only opens the box and closes it with Back (nothing changes).',
    inputSchema: object({
      appsOpen: { type: 'boolean', description: 'The user has opened Apps (on 2024+ TVs: Apps, then App Settings at the bottom) on the TV, so Lumen does not open it' },
      dialogOpen: { type: 'boolean', description: 'The Developer mode box is on the TV (the user said so, or you saw it): switch it On, enter this PC as Host PC IP, press OK' },
      cancel: { type: 'boolean', description: 'Close the Developer mode box with Back without changing anything' },
      probe: { type: 'boolean', description: 'Only check the path: open Apps, enter 1 2 3 4 5, then close the box with Back; nothing is changed' },
      ipEntry: { type: 'string', enum: ['digits', 'keyboard'], description: 'How Host PC IP is typed: number keys into its four boxes (default; every documented model) or the TV keyboard (only if pressing OK on the field opens a keyboard)' },
      force: { type: 'boolean', description: 'Run even though the TV already reports Developer mode on for this PC' },
    }),
    async run(args, ctx) {
      const { hub, store, skills } = ctx;
      const skill = skills?.get(DEV_SKILL);
      if (!skill || skill.scope !== 'tv') fail('The developer-mode skill is missing', 'UNAVAILABLE');
      if (valueOf(store, 'conn.tv') !== 'on') fail('The TV is off or not reachable; turn it on first', 'TV_OFF');
      if (valueOf(store, 'conn.remote') !== 'paired') fail('The remote channel is not paired, so Lumen cannot press keys on the TV. Pair it first (Settings → Connection → Remote channel)', 'NOT_PAIRED');
      const io = flowIo(ctx);
      const state = {};
      const steps = [];
      const run = async (flow, vars) => {
        const out = await runFlow(skill, flow, io, { vars }, state);
        steps.push(...out.steps);
        return out;
      };
      // A failed check inside the box: Back closes it without saving.
      const stopped = async (err, what) => {
        if (err?.code !== 'CHECK_FAILED') throw err;
        try {
          await run('cancel');
        } catch {
          // the report below still says what happened
        }
        return { ok: false, steps, error: { code: 'CHECK_FAILED', message: `${err.message}. Lumen pressed Back and stopped; ${what}` } };
      };

      if (args.cancel) {
        await run('cancel');
        return { ok: true, changed: false, steps, summary: 'Closed the Developer mode box with Back; nothing was changed.' };
      }

      const before = await readDevice(hub);

      if (args.dialogOpen) {
        const pc = await thisPcAddress(ctx);
        // The four boxes run right to left in RTL menus; one text field takes the address as written.
        const typed = args.ipEntry !== 'keyboard' && RTL_LANGUAGE.test(before.language ?? '') ? pc.split('.').reverse().join('.') : pc;
        try {
          await run('switchOn');
          await run(args.ipEntry === 'keyboard' ? 'hostIpKeyboard' : 'hostIp', { pcAddress: typed });
        } catch (err) {
          return stopped(err, 'nothing was saved.');
        }
        await run('confirm');
        await (ctx.sleepFn ?? sleep)(DEV_SETTLE_MS);
        const after = await readDevice(hub);
        const confirmed = after.developerMode === true && after.developerHost === 'this-pc';
        const wrongHost = after.developerMode === true && after.developerHost === 'other' && before.developerHost !== 'other';
        return {
          ok: true, changed: true, pcAddress: pc, confirmedByTv: confirmed, needsRestart: true, restart: DEV_RESTART_STEP, steps,
          next: 'Tell the user plainly what changed and how to restart the TV (the restart text), in your own short words.',
          ...(wrongHost && { warning: 'The TV reports a Host PC IP that is not this PC: the boxes may not have taken the digits. Check the box on the TV before restarting.' }),
          summary: `${confirmed
            ? `Developer mode is set On with this PC (${pc}) as Host PC IP; the TV confirms it.`
            : `Lumen switched Developer mode On, entered this PC (${pc}) as Host PC IP and pressed OK. The TV only reports it after a restart.`} ${DEV_RESTART_STEP}`,
        };
      }

      if (!args.probe && !args.force && before.developerMode === true && before.developerHost === 'this-pc') {
        return { ok: true, already: true, changed: false, steps, summary: 'Developer mode is already on with this PC as Host PC IP. Nothing was changed.' };
      }
      // `summary` is for the user (it shows in Ask); `next` tells the model what to do.
      const OPEN_APPS_NEXT = 'Ask the user to press Home on the TV remote and select Apps, and to tell you when Apps is open; then call enable_developer_mode with appsOpen: true.';
      const year = Number(before.year) || null;
      if (!args.appsOpen && year >= 2024) {
        return {
          ok: true, changed: false, needsUser: 'openAppSettings', steps,
          summary: `On ${year} TVs the code goes into Apps → App Settings, which Lumen cannot reach without seeing the screen. Open Apps on the TV, scroll to the bottom and select App Settings.`,
          next: 'Ask the user to open Apps → App Settings on the TV and to tell you when it is open; then call enable_developer_mode with appsOpen: true.',
        };
      }
      if (!args.appsOpen) {
        const front = foregroundApp(store)?.id;
        try {
          await run('open');
        } catch (err) {
          if (!['UNAVAILABLE', 'NOT_FOUND', 'FAILED'].includes(err?.code)) throw err;
          return {
            ok: true, changed: false, needsUser: 'openApps', steps, next: OPEN_APPS_NEXT,
            summary: `This TV did not open Apps for Lumen (${err.message}). Open Apps on the TV: press Home, then select Apps.`,
          };
        }
        if (front && front !== state.launched?.id) {
          const still = await send(hub, { cmd: 'app.status', appId: front }).catch(() => null);
          if (still?.visible === true) {
            return {
              ok: true, changed: false, needsUser: 'openApps', steps, next: OPEN_APPS_NEXT,
              summary: `Apps did not come to the front (${foregroundApp(store)?.name ?? 'an app'} is still on screen), so Lumen did not type the code. Open Apps on the TV: press Home, then select Apps.`,
            };
          }
        }
      }
      try {
        await run('code');
      } catch (err) {
        return stopped(err, 'nothing was changed.');
      }
      const image = await io.look(); // only with Lumen Eyes; never needed
      if (args.probe) {
        await run('cancel');
        return {
          ok: true, changed: false, probe: true, steps, ...(image && { image }),
          summary: `Opened Apps, entered 1 2 3 4 5, then pressed Back. ${DIALOG_LOOK[0].toUpperCase()}${DIALOG_LOOK.slice(1)} should have shown and closed again; nothing was changed.`,
        };
      }
      return {
        ok: true, changed: false, stage: 'dialog', needsUser: image ? null : 'confirmDialog', steps, ...(image && { image }),
        summary: 'Opened Apps and entered 1 2 3 4 5. The Developer mode box should be on the TV now.',
        next: image
          ? `Check the picture for ${DIALOG_LOOK}. If it is there, call enable_developer_mode with dialogOpen: true; if not, call it with cancel: true.`
          : `Lumen cannot see the screen. Ask the user one short question: is ${DIALOG_LOOK} on the TV now? If yes, call enable_developer_mode with dialogOpen: true; if not, call it with cancel: true.`,
      };
    },
  },
  {
    name: 'bluetooth',
    description: 'The TV\'s Bluetooth (headphones, speakers, keyboards, game pads), through Lumen Eyes on the TV. list: paired devices and which are connected. scan: look for nearby devices in pairing mode (about 15 s; ask the user to put the device in pairing mode first). pair: pair a device found by scan (audio and input devices are connected too). connect / disconnect: a paired device. Give the device by address or name. open_tv_menu: when the TV refuses (UNAVAILABLE), open the TV\'s own menu, then finish there by sight (look_at_screen) along the returned menuPath.',
    inputSchema: object({
      action: { type: 'string', enum: ['list', 'scan', 'pair', 'connect', 'disconnect', 'open_tv_menu'] },
      device: { type: 'string', minLength: 1, maxLength: 60, description: 'Device address (AA:BB:CC:DD:EE:FF) or name, for pair, connect and disconnect' },
      audio: { type: 'boolean', description: 'open_tv_menu: true for headphones and speakers (Sound Output list), false for input devices' },
    }, ['action']),
    async run({ action, device, audio = true }, { hub, store }) {
      const shown = (d) => ({ name: d.name ?? 'Unnamed device', address: d.address, kind: d.kind ?? null, paired: d.paired ?? d.bonded ?? false, connected: d.connected === true });
      if (action === 'list') {
        const state = await send(hub, { cmd: 'bluetooth.refresh' });
        const devices = (state?.devices ?? []).map(shown);
        return { ok: true, powered: state?.powered ?? null, devices, summary: devices.length ? devices.map((d) => `${d.name}${d.connected ? ' (connected)' : ''}`).join(', ') : 'No paired devices' };
      }
      if (action === 'scan') {
        const found = await send(hub, { cmd: 'bluetooth.scan', secs: 15 });
        const devices = (found?.devices ?? []).map(shown);
        return { ok: true, devices, summary: devices.length ? `Found ${devices.map((d) => d.name).join(', ')}` : 'No devices in pairing mode were found' };
      }
      if (action === 'open_tv_menu') {
        const r = await send(hub, { cmd: 'bluetooth.openTv', kind: audio ? 'audio' : 'other' });
        return { ok: true, method: r?.method, menuPath: r?.menuPath, summary: `TV menu opened; go to ${r?.menuPath}` };
      }
      if (!device) fail('device is required for this action');
      let address = /^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$/.test(device) ? device.toUpperCase() : null;
      if (!address) {
        const pool = [...(valueOf(store, 'bluetooth.scan')?.devices ?? []), ...(valueOf(store, 'bluetooth.state')?.devices ?? [])];
        const want = norm(device);
        const match = pool.find((d) => d.address && norm(d.name) === want) ?? pool.find((d) => d.address && norm(d.name).includes(want));
        if (!match) fail(`No Bluetooth device called "${device}" is known; run scan (new devices) or list (paired ones) first`);
        address = match.address;
      }
      const r = await send(hub, { cmd: `bluetooth.${action}`, address });
      const name = r?.name ?? device;
      const summary = action === 'disconnect' ? `Disconnected ${name}`
        : action === 'pair' ? `Paired ${name}${r?.connected ? ' and connected it' : r?.connectError ? ` (not connected: ${r.connectError})` : ''}`
          : `Connected ${name}`;
      return { ok: true, ...r, summary };
    },
  },
  {
    name: 'open_netflix',
    description: 'Open a specific title in the Netflix app. Give the official title id (the number in netflix.com/title/<id>) or a netflix.com title link. Find the id with web search first; never guess it. To open Netflix without a title use launch_app.',
    inputSchema: object({
      titleId: { type: 'string', minLength: 1, maxLength: 16, description: 'Netflix title id, digits only' },
      url: urlProp('A netflix.com/title/<id> or /watch/<id> link'),
    }),
    async run({ titleId, url }, { hub }) {
      let id;
      if (titleId !== undefined) {
        id = titleId.trim();
        if (!/^\d{4,12}$/.test(id)) fail('A Netflix title id is the number in netflix.com/title/<id>');
      } else if (url !== undefined) {
        const { match } = classifyLink(url);
        if (match?.kind !== 'netflix') fail('That is not a netflix.com/title link');
        id = match.id;
      } else {
        fail('Give titleId or url. To open Netflix without a title use launch_app.');
      }
      const session = await send(hub, { cmd: 'cast.url', url: `https://www.netflix.com/title/${id}` });
      // Live on the Q95T: through the TV agent (Smart Hub's app-control launch) the title starts playing
      // (2026-10-23); over DIAL every format only opened Netflix's home or profile screen (2026-10-21).
      const played = session?.via === 'agent';
      return {
        ok: true, titleId: id, landsOnTitle: played,
        summary: played
          ? castSummary(session, 'Started the title in Netflix. If Netflix asks who is watching, the user picks a profile and it plays')
          : castSummary(session, 'Opened Netflix without the TV agent, so it opens on its home screen and the user picks the title there. Connecting the TV agent (Settings) lets titles play directly'),
      };
    },
  },
  {
    name: 'play_youtube',
    description: 'Play a specific YouTube video on the TV. Give the 11-character video id or a youtube.com / youtu.be link. Find the id with web search first; never guess it. To open YouTube without a video use launch_app.',
    inputSchema: object({
      videoId: { type: 'string', minLength: 1, maxLength: 16, description: 'YouTube video id (11 characters)' },
      url: urlProp('A youtube.com/watch?v=…, youtu.be/… or /shorts/… link'),
    }),
    async run({ videoId, url }, { hub }) {
      let id;
      if (videoId !== undefined) {
        id = videoId.trim();
        if (!/^[\w-]{11}$/.test(id)) fail('A YouTube video id has 11 characters (letters, digits, - and _)');
      } else if (url !== undefined) {
        const { match } = classifyLink(url);
        if (match?.kind !== 'youtube') fail('That is not a YouTube video link');
        id = match.id;
      } else {
        fail('Give videoId or url. To open YouTube without a video use launch_app.');
      }
      const session = await send(hub, { cmd: 'cast.url', url: `https://www.youtube.com/watch?v=${id}` });
      return { ok: true, videoId: id, summary: castSummary(session, `Playing YouTube video ${id}`) };
    },
  },
  {
    name: 'open_prime',
    description: 'Open a specific Prime Video title from its primevideo.com or amazon.<tld>/gp/video/ link. Find the link with web search first. To open Prime Video without a title use launch_app.',
    inputSchema: object({ url: urlProp('A primevideo.com or amazon.<tld>/gp/video/ link') }, ['url']),
    async run({ url }, { hub }) {
      const link = classifyLink(url);
      if (link.match?.kind !== 'prime') fail('That is not a Prime Video link (primevideo.com or amazon.<tld>/gp/video/)');
      const session = await send(hub, { cmd: 'cast.url', url: link.href });
      return { ok: true, summary: castSummary(session, 'Opened in Prime Video') };
    },
  },
  {
    name: 'open_url_on_tv',
    description: 'Open a web page on the TV (http or https). YouTube, Netflix and Prime Video links open in their apps and media files play directly.',
    inputSchema: object({ url: urlProp('The page to open') }, ['url']),
    async run({ url }, { hub }) {
      const link = classifyLink(url);
      const session = await send(hub, { cmd: 'cast.url', url: link.href });
      return { ok: true, summary: castSummary(session, `Opened ${link.host} on the TV`) };
    },
  },
  {
    name: 'cast_media',
    description: 'Play a direct media file URL on the TV over DLNA (video, audio, image or HLS: .mp4, .mkv, .webm, .mp3, .m4a, .flac, .jpg, .png, .m3u8 …).',
    inputSchema: object({ url: urlProp('Direct link to the media file') }, ['url']),
    async run({ url }, { hub }) {
      const link = classifyLink(url);
      const other = { youtube: 'play_youtube', netflix: 'open_netflix', prime: 'open_prime' }[link.match?.kind];
      if (other) fail(`That is a ${link.match.kind} link; use ${other}`);
      const session = await send(hub, { cmd: 'cast.url', url: link.href });
      return { ok: true, summary: castSummary(session, `Casting ${link.host}`) };
    },
  },
  {
    name: 'set_input',
    description: 'Switch the TV input source: TV (antenna / live TV), HDMI1–HDMI4 or AV1, or a name the user gave an input (for example "PlayStation").',
    inputSchema: object({
      source: { type: 'string', minLength: 1, maxLength: 40, description: 'TV, HDMI1–HDMI4, AV1 or an input name' },
    }, ['source']),
    async run({ source }, { hub, store, catalog }) {
      const options = catalog.settings.find((entry) => entry.key === 'input.source')?.options ?? DEFAULT_INPUTS;
      const labels = valueOf(store, 'input.labels') ?? {};
      const target = resolveInput(source, options, labels, valueOf(store, 'input.connected'));
      const name = (s) => (s && labels[s] ? `${s} (${labels[s]})` : s);
      const from = valueOf(store, 'input.source');
      const to = await send(hub, { cmd: 'input.set', source: target });
      return changed('Input', name(from), name(to ?? target));
    },
  },
  {
    name: 'power',
    description: 'Turn the TV on or off.',
    inputSchema: object({ action: { type: 'string', enum: ['on', 'off'] } }, ['action']),
    async run({ action }, { hub }) {
      await send(hub, { cmd: 'power', action });
      return { ok: true, action, summary: action === 'on' ? 'Turning the TV on' : 'Turning the TV off' };
    },
  },
  {
    name: 'sleep_timer',
    description: 'Turn the TV off after a number of minutes (1–240), or cancel the sleep timer with 0.',
    inputSchema: object({
      minutes: { type: 'integer', minimum: 0, maximum: 240, description: 'Minutes until power off; 0 cancels' },
    }, ['minutes']),
    async run({ minutes }, { hub }) {
      await send(hub, { cmd: 'sleep.set', minutes });
      return { ok: true, minutes, summary: minutes ? `Sleep in ${minutes} min` : 'Sleep timer cancelled' };
    },
  },
  {
    name: 'run_scene',
    description: 'Run one of the user\'s saved scenes by name (for example "Night" or "Cinema"): a bundle of exact settings applied in order.',
    inputSchema: object({ name: { type: 'string', minLength: 1, maxLength: 60, description: 'Scene name' } }, ['name']),
    async run({ name }, { hub, store }) {
      const scenes = valueOf(store, 'scenes') ?? [];
      const scene = bestMatch(name, scenes, (entry) => [entry.name]);
      if (!scene) fail(`No scene named "${name}". Scenes: ${scenes.map((s) => s.name).join(', ') || 'none'}`, 'UNAVAILABLE');
      await send(hub, { cmd: 'scene.run', target: scene.id });
      return { ok: true, scene: scene.name, summary: `Ran scene ${scene.name}` };
    },
  },
  {
    name: 'type_text',
    description: 'Type text into the text field the TV is showing (its on-screen keyboard must be open, e.g. a search box), optionally submitting it.',
    inputSchema: object({
      text: { type: 'string', minLength: 1, maxLength: 200, description: 'Text to type' },
      submit: { type: 'boolean', description: 'Press Done/Enter after typing' },
    }, ['text']),
    async run({ text, submit = false }, { hub, store }) {
      const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      if (!clean) fail('Nothing to type');
      await send(hub, { cmd: 'text.send', text: clean, submit });
      return { ok: true, summary: `Typed ${clean.length} characters${submit ? ' and submitted' : ''}` };
    },
  },
  {
    name: 'look_at_screen',
    description: 'See the TV screen right now: returns a picture of it (video plus any menus, apps and on-screen keyboards, 16:9, about 960x540). Use it to learn where you are in an app, read lists and buttons, find what is focused, and check that your last action worked. Screens animate, so after pressing keys pass waitMs (about 800) before looking.',
    inputSchema: object({
      waitMs: { type: 'integer', minimum: 0, maximum: 5000, description: 'Wait this long before capturing (let the screen settle)' },
    }),
    async run({ waitMs = 0 }, { hub, store, eyes, signal }) {
      if (!eyes?.latest) fail('Seeing the screen is not available', 'UNAVAILABLE');
      if (waitMs) await sleep(waitMs);
      if (signal?.aborted) fail('Cancelled', 'CANCELLED');
      const shot = await send(hub, { cmd: 'screen.capture' });
      const latest = eyes.latest();
      if (!latest?.png || latest.at !== shot.at) fail('The screen capture went missing');
      const app = foregroundApp(store);
      return {
        ok: true,
        summary: `Looked at the screen (${shot.width}x${shot.height})`,
        foregroundApp: app ? { id: app.id ?? null, name: app.name ?? null } : null,
        image: { data: latest.png.toString('base64'), mimeType: 'image/png' },
      };
    },
  },
  {
    name: 'play_title',
    description: 'Play a film, show or video by name, in one step. Lumen finds where it streams in India (JustWatch), picks a service on this TV where it is included (never rent or buy), and plays it: Netflix and YouTube by deep link, other apps with that app\'s skill (open, search, type, open the result, play). Returns what it did and a picture of the screen to confirm. Use this first for any "play X" request; pass app when the user names one.',
    inputSchema: object({
      title: { type: 'string', minLength: 1, maxLength: 120, description: 'The title as the user said it (fix obvious typos)' },
      year: { type: 'integer', minimum: 1900, maximum: 2100, description: 'Release year, when known, to pick the right one' },
      type: { type: 'string', enum: ['movie', 'show'], description: 'Film or series, when known' },
      app: { type: 'string', maxLength: 40, description: 'Only use this app (name or id), when the user asked for one' },
    }, ['title']),
    async run({ title, year, type, app }, ctx) {
      const { hub, store, titles, skills } = ctx;
      if (!titles || !skills) fail('Playing titles is not available', 'UNAVAILABLE');
      const installedIds = (valueOf(store, 'app.installed') ?? []).map((a) => a?.id).filter(Boolean);
      const found = await titles.find(title, { year, type, installedIds, preferApp: app });
      if (!found.match) return { ok: false, error: { code: 'NOT_FOUND', message: `"${title}" was not found in the India catalogue; try web search for the exact title` } };
      const where = found.match.offers.map((o) => `${o.service} (${o.monetization.toLowerCase()})`);
      const label = `${found.match.title}${found.match.year ? ` (${found.match.year})` : ''}`;
      if (!found.choice) {
        const message = {
          'rent-or-buy-only': `${label} is only to rent or buy here (${where.join(', ')}). Renting costs money, so Lumen did not do it; tell the user.`,
          'paid-add-on': `${label} streams only on a paid Prime Video add-on channel here (${where.join(', ')}); that costs extra, so Lumen did not subscribe. Tell the user.`,
          'not-on-requested-app': `${label} is not included on ${app}; it is on ${where.join(', ')}.`,
          'not-on-installed-apps': `${label} streams on ${where.join(', ')}, none of which is installed on this TV.`,
          'not-streaming': `${label} is not streaming in India right now.`,
        }[found.why] ?? `${label} could not be played.`;
        return { ok: true, played: false, title: label, availableOn: where, otherMatches: found.candidates, summary: message };
      }
      const choice = found.choice;
      const steps = [`found ${label} on ${choice.service} (${choice.monetization.toLowerCase()})`];
      if (choice.kind === 'netflix' && /^\d{4,12}$/.test(choice.contentId ?? '')) {
        const session = await send(hub, { cmd: 'cast.url', url: `https://www.netflix.com/title/${choice.contentId}` });
        const viaAgent = session?.via === 'agent';
        steps.push(viaAgent ? 'started it in Netflix by deep link' : 'opened Netflix (no TV agent, so on its home screen)');
        return { ok: true, played: viaAgent, title: label, service: choice.service, steps, summary: viaAgent ? `Playing ${label} on Netflix` : `Opened Netflix; ${label} needs choosing there` };
      }
      if (choice.kind === 'youtube' && /^[\w-]{11}$/.test(choice.contentId ?? '')) {
        await send(hub, { cmd: 'cast.url', url: `https://www.youtube.com/watch?v=${choice.contentId}` });
        steps.push('started it in YouTube');
        return { ok: true, played: true, title: label, service: choice.service, steps, summary: `Playing ${label} on YouTube` };
      }
      const skill = skills.get(choice.skill) ?? skills.get(choice.appId);
      const io = flowIo(ctx);
      const state = {};
      const full = ['open', 'search', 'type', 'pickResult', 'play'];
      if (skill && full.every((f) => skill.flows[f])) {
        let image = null;
        const searchText = cleanSearchText(found.match.title);
        for (const flow of full) {
          const out = await runFlow(skill, flow, io, { text: searchText }, state);
          steps.push(...out.steps);
          image = out.image ?? image;
        }
        image ??= await io.look();
        return {
          ok: true, played: 'check', title: label, service: choice.service, skill: skill.slug, steps,
          summary: `Ran the ${skill.app} skill for ${label}; check the picture: it should be playing. If it is not, finish by sight and fix the skill with save_app_skill.`,
          image,
        };
      }
      // No complete skill yet: open the app and hand over to sight.
      if (skill?.flows.open) steps.push(...(await runFlow(skill, 'open', io, {}, state)).steps);
      else {
        await send(hub, { cmd: 'app.launch', appId: choice.appId });
        steps.push(`opened ${choice.service}`);
        await (ctx.sleepFn ?? sleep)(5000);
      }
      return {
        ok: true, played: false, title: label, service: choice.service, searchFor: cleanSearchText(found.match.title), steps,
        skill: skill ? { slug: skill.slug, notes: skill.notes, flows: Object.keys(skill.flows) } : null,
        summary: `Opened ${choice.service} for ${label}. Lumen has no complete ${choice.service} skill yet: find and play it by sight (search, open the title, play), then save the steps with save_app_skill so next time is automatic.`,
        image: await io.look(),
      };
    },
  },
  {
    name: 'type_on_keyboard',
    description: 'Type text on an app\'s own on-screen keyboard in one call, without looking between letters. Look at the keyboard once, then give its keys row by row exactly as shown (null for an empty spot; repeat a label across columns for a wide key such as "Space") and the key that is focused now. Lumen works out the arrow presses. Use exitRight to move off the keyboard to the results on its right afterwards. Save the layout in the app skill (typeGrid) when it worked.',
    inputSchema: object({
      rows: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'array', minItems: 1, maxItems: 16, items: { type: ['string', 'null'], maxLength: 12 } }, description: 'Keyboard rows, left to right' },
      start: { type: 'string', minLength: 1, maxLength: 12, description: 'The key that has focus now' },
      text: { type: 'string', minLength: 1, maxLength: 60, description: 'What to type' },
      exitRight: { type: 'boolean', description: 'Afterwards, press Right until focus leaves the keyboard' },
    }, ['rows', 'start', 'text']),
    async run({ rows, start, text, exitRight = false }, ctx) {
      const { hub } = ctx;
      if (!rows.some((r) => r.some((k) => k != null && String(k).toLowerCase() === start.toLowerCase()))) fail(`"${start}" is not one of the keys you listed`);
      const plan = gridPath({ rows, start, maxChars: 40 }, cleanSearchText(text));
      if (!plan.typed) fail('None of those characters are on that keyboard');
      const keys = [...plan.keys];
      if (exitRight) for (let i = 0; i < Math.max(1, plan.cols - plan.end.col); i++) keys.push('KEY_RIGHT');
      const pause = ctx.sleepFn ?? sleep;
      for (const [i, key] of keys.entries()) {
        if (ctx.signal?.aborted) fail('Cancelled', 'CANCELLED');
        await send(hub, { cmd: 'key', key });
        if (i < keys.length - 1) await pause(260);
      }
      return { ok: true, typed: plan.typed, presses: keys.length, summary: `Typed "${plan.typed}" on the app keyboard (${keys.length} presses)` };
    },
  },
  {
    name: 'browser_open',
    description: 'Open a web page in Lumen\'s own browser (it runs on the PC, behind the VPN when that is on). Use it for anything on the web: reading, searching sites, watching web videos. Set onTv to show it full screen on the TV (the TV remote then drives it). Prefer this over the TV\'s built-in browser, which cannot open modern sites.',
    inputSchema: object({
      url: urlProp('The page (http or https); a search phrase is not a URL — use https://duckduckgo.com/?q=… for searches'),
      onTv: { type: 'boolean', description: 'Also show the browser full screen on the TV' },
    }, ['url']),
    async run({ url, onTv = false }, { hub }) {
      await send(hub, { cmd: onTv ? 'tvscreen.open' : 'browser.open', url });
      return { ok: true, onTv, summary: onTv ? `Showing ${url} on the TV` : `Opened ${url} in Lumen's browser` };
    },
  },
  {
    name: 'browser_read',
    description: 'Read the page open in Lumen\'s browser: title, URL, visible text, and the links, buttons and fields on screen, numbered for browser_click. Read again after anything that changes the page.',
    inputSchema: object(),
    async run(_, { browser }) {
      const b = browser?.();
      if (!b?.snapshot) fail('Lumen\'s browser is not available', 'UNAVAILABLE');
      const snap = await b.snapshot();
      return {
        ok: true, url: snap.url, title: snap.title, scroll: `${snap.scrollY} of ${snap.pageHeight}px`,
        text: snap.text, elements: snap.elements.map((e) => ({ i: e.i, tag: e.tag, text: e.text, ...(e.href && { href: e.href }) })),
        summary: `Read "${snap.title}" (${snap.elements.length} things to click)`,
      };
    },
  },
  {
    name: 'browser_click',
    description: 'Click something on the page in Lumen\'s browser: give its number from browser_read (preferred) or its visible text.',
    inputSchema: object({
      index: { type: 'integer', minimum: 1, maximum: 500, description: 'Element number from browser_read' },
      text: { type: 'string', minLength: 1, maxLength: 80, description: 'Visible text of the link or button' },
    }),
    async run({ index, text }, { browser }) {
      const b = browser?.();
      if (!b?.clickElement) fail('Lumen\'s browser is not available', 'UNAVAILABLE');
      if (!index && !text) fail('Give index or text');
      const res = await b.clickElement({ index, text });
      await sleep(1200);
      return { ok: true, summary: `Clicked ${res.value.clicked}` };
    },
  },
  {
    name: 'browser_type',
    description: 'Type into the focused field of the page in Lumen\'s browser (click the field first), optionally pressing Enter.',
    inputSchema: object({
      text: { type: 'string', minLength: 1, maxLength: 500, description: 'Text to type' },
      submit: { type: 'boolean', description: 'Press Enter afterwards' },
    }, ['text']),
    async run({ text, submit = false }, { hub }) {
      await send(hub, { cmd: 'browser.input', kind: 'text', text });
      if (submit) await send(hub, { cmd: 'browser.input', kind: 'key', key: 'Enter' });
      await sleep(submit ? 1500 : 200);
      return { ok: true, summary: `Typed ${text.length} characters${submit ? ' and pressed Enter' : ''}` };
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page in Lumen\'s browser.',
    inputSchema: object({ direction: { type: 'string', enum: ['up', 'down'], description: 'Which way' } }, ['direction']),
    async run({ direction }, { hub }) {
      await send(hub, { cmd: 'browser.input', kind: 'wheel', x: 400, y: 300, deltaY: direction === 'down' ? 600 : -600 });
      await sleep(400);
      return { ok: true, summary: `Scrolled ${direction}` };
    },
  },
  {
    name: 'browser_look',
    description: 'See the page in Lumen\'s browser as a picture (layout, images, video players). Use browser_read for text.',
    inputSchema: object(),
    async run(_, { browser }) {
      const b = browser?.();
      if (!b?.screenshot) fail('Lumen\'s browser is not available', 'UNAVAILABLE');
      const jpeg = await b.screenshot();
      return { ok: true, summary: 'Looked at the page', image: { data: jpeg.toString('base64'), mimeType: 'image/jpeg' } };
    },
  },
  {
    name: 'browser_play_video_on_tv',
    description: 'Play the video of the page open in Lumen\'s browser on the TV\'s own player (full screen, full quality, with sound, through the VPN when it is on). Start the video on the page first (click its play button) so Lumen can see its stream. Works for normal web video; protected (DRM) streams cannot be handed over. A YouTube video (a watch, Shorts or embed page, or a YouTube embed on the page) opens in the TV\'s YouTube app at the same position instead; it need not be started first.',
    inputSchema: object({
      convert: { type: 'boolean', description: 'Convert the video on this PC first. Use when the TV shows a black picture or could not play it' },
    }),
    async run({ convert } = {}, { hub }) {
      const res = await send(hub, { cmd: 'tvscreen.playVideo', ...(convert === true && { convert: true }) });
      const what = res?.title ? `"${res.title}"` : 'the video';
      if (res?.converted) return { ok: true, converted: true, summary: `Playing ${what} on the TV, converted on this PC` };
      if (res?.app === 'youtube') {
        return { ok: true, app: 'youtube', videoId: res.videoId, t: res.t, summary: `Playing ${what} in the TV's YouTube app${res.t ? ` from ${res.t} s` : ''}` };
      }
      return { ok: true, summary: `Playing ${what} on the TV` };
    },
  },
  {
    name: 'find_title',
    description: 'Where a film or show streams in India (JustWatch), on which services, and whether it is included or rent/buy. Use when the user asks where something is, or before choosing an app yourself.',
    inputSchema: object({
      title: { type: 'string', minLength: 1, maxLength: 120, description: 'Title to look up' },
      year: { type: 'integer', minimum: 1900, maximum: 2100, description: 'Release year, when known' },
    }, ['title']),
    async run({ title, year }, { store, titles }) {
      if (!titles) fail('Title lookup is not available', 'UNAVAILABLE');
      const installedIds = (valueOf(store, 'app.installed') ?? []).map((a) => a?.id).filter(Boolean);
      const found = await titles.find(title, { year, installedIds });
      if (!found.match) return { ok: true, found: false, summary: `"${title}" is not in the India catalogue` };
      return {
        ok: true, found: true,
        title: found.match.title, year: found.match.year, type: found.match.type,
        offers: found.match.offers.map((o) => ({ service: o.service, monetization: o.monetization, url: o.url })),
        bestOnThisTv: found.choice ? { service: found.choice.service, monetization: found.choice.monetization } : null,
        otherMatches: found.candidates,
        summary: found.choice ? `${found.match.title}: ${found.choice.service} (${found.choice.monetization.toLowerCase()})` : `${found.match.title}: no included service on this TV`,
      };
    },
  },
  {
    name: 'get_app_skill',
    description: 'Read what Lumen knows about working inside a TV app: notes and runnable flows (open, search, type, pickResult, play …). Call it before navigating any app by sight. Without app, lists all skills.',
    inputSchema: object({
      app: { type: 'string', maxLength: 60, description: 'App name or id; omit to list skills' },
    }),
    async run({ app }, { skills }) {
      if (!skills) fail('Skills are not available', 'UNAVAILABLE');
      if (!app) return { ok: true, skills: skills.list(), summary: `${skills.list().length} app skills` };
      const skill = skills.get(app);
      if (!skill) return { ok: true, found: false, summary: `No skill for ${app} yet; work by sight and save one with save_app_skill` };
      return {
        ok: true, found: true,
        skill: { slug: skill.slug, app: skill.app, scope: skill.scope, ...(skill.runWith && { runWith: skill.runWith }), appIds: skill.appIds, summary: skill.summary, notes: skill.notes, flows: skill.flows, source: skill.source, updated: skill.updated },
        summary: `${skill.app} ${skill.scope === 'tv' ? 'TV ' : ''}skill (${Object.keys(skill.flows).join(', ') || 'notes only'})${skill.runWith ? `; run it with ${skill.runWith}` : ''}`,
      };
    },
  },
  {
    name: 'run_app_flow',
    description: 'Run one flow of an app skill (for example open, search, type with text, pickResult, play) in one step, then see the screen. Prefer this over pressing keys yourself whenever the skill has the flow.',
    inputSchema: object({
      app: { type: 'string', minLength: 1, maxLength: 60, description: 'App name or id' },
      flow: { type: 'string', minLength: 1, maxLength: 30, description: 'Flow name from the skill' },
      text: { type: 'string', maxLength: 120, description: 'Text for typing flows' },
    }, ['app', 'flow']),
    async run({ app, flow, text }, ctx) {
      const { skills } = ctx;
      if (!skills) fail('Skills are not available', 'UNAVAILABLE');
      const skill = skills.get(app);
      if (!skill) fail(`No skill for ${app}`, 'NOT_FOUND');
      if (skill.scope === 'tv') fail(`${skill.app} is a TV skill; run it with ${skill.runWith ?? 'its own tool'}`, 'INVALID');
      if (!skill.flows[flow]) fail(`${skill.app} has no "${flow}" flow (it has ${Object.keys(skill.flows).join(', ') || 'none'})`, 'NOT_FOUND');
      const io = flowIo(ctx);
      const out = await runFlow(skill, flow, io, { text: text ? cleanSearchText(text) : '' }, {});
      return { ok: true, steps: out.steps, summary: `Ran ${skill.app} ${flow}`, image: out.image ?? (await io.look()) };
    },
  },
  {
    name: 'save_app_skill',
    description: 'Save or improve what you learned about an app so the next request is automatic. Call it, without being asked, after you completed something inside an app by sight, or fixed a flow that did not work. notes: short factual bullets (layout, where search is, keyboard, quirks). flows: runnable steps; each step has one action: {"launch":true}, {"wait":ms}, {"keys":["KEY_LEFT",…]}, {"ifColdStart":[steps]}, {"typeGrid":{"rows":[["A","B",…],…],"start":"A","maxChars":16}} for the app\'s own keyboard (repeat a label across columns for a wide key like Space; null for a gap), {"typeText":true} for the TV keyboard, {"exitGrid":"right"} to move from the keyboard into results, {"look":true}. Standard flow names for titles: open, search, type, pickResult, play.',
    inputSchema: object({
      app: { type: 'string', minLength: 1, maxLength: 60, description: 'App name as shown on the TV' },
      appId: { type: 'string', maxLength: 64, description: 'The app id (from list_apps), when known' },
      summary: { type: 'string', maxLength: 200, description: 'One line: what the skill does' },
      notes: { type: 'string', maxLength: 4000, description: 'Markdown bullets of facts about the app' },
      flows: { type: 'object', description: 'Named flows (lists of steps); merged into the existing ones' },
      verified: { type: 'string', maxLength: 120, description: 'What you just confirmed on screen, e.g. "2026-10-23: The Office search"' },
    }, ['app']),
    async run({ app, appId, summary, notes, flows, verified }, { skills, store }) {
      if (!skills) fail('Skills are not available', 'UNAVAILABLE');
      const fromList = (valueOf(store, 'app.installed') ?? []).find((a) => norm(a?.name) === norm(app));
      let saved;
      try {
        saved = skills.save({ app, appIds: [appId, fromList?.id].filter(Boolean), summary, notes, flows, verified });
      } catch (err) {
        fail(`The skill was not saved: ${err.message}`, 'INVALID');
      }
      return { ok: true, skill: saved.slug, flows: Object.keys(saved.flows), summary: `Saved the ${saved.app} skill (${Object.keys(saved.flows).join(', ') || 'notes'})` };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// [{ name, description, inputSchema }] in a fixed order (keeps the API prompt cache stable).
export const TOOL_DEFINITIONS = Object.freeze(TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));

export const hasTool = (name) => BY_NAME.has(name);

// ctx = { hub, store, catalog: { settings, keys, apps, isAllowedKey }, signal? }
// → { isError, result, text, images } where text is the JSON sent back to the model and images are
// [{ data: base64, mimeType }] sent with it.
export async function callTool(name, input, ctx) {
  const tool = BY_NAME.get(name);
  let result;
  try {
    if (!tool) fail(`Unknown tool ${name}`);
    const args = input === undefined ? {} : input;
    const problem = validate(tool.inputSchema, args);
    if (problem) fail(problem);
    result = await tool.run(args, ctx);
  } catch (err) {
    result = { ok: false, error: { code: err.code ?? 'FAILED', message: err.message } };
  }
  // Pictures (look_at_screen) travel beside the JSON text as image content, never inside it.
  const { image, ...rest } = result ?? {};
  const images = image?.data && image?.mimeType ? [image] : [];
  return { isError: !rest.ok, result: rest, text: JSON.stringify(rest), images };
}

// One short line for UI events: "key=picture.backlight, delta=5".
export function describeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const text = Object.entries(input)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ');
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

export function describeResult(result) {
  return result?.ok ? result.summary ?? 'Done' : result?.error?.message ?? 'Failed';
}
