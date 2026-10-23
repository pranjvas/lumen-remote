// AI tools: one definition list shared by the API backend and the MCP endpoint.
// Model output is untrusted, so every call is validated against its schema here and then
// checked semantically; actions go through hub.handle so the hub's safety rules and read-back
// apply exactly as they do for a browser command.
import { matchUrl, parseCastUrl } from '../features/cast.js';

// The synthetic hub client for AI-issued commands; acks go nowhere (handle() returns them).
const AI_CLIENT = Object.freeze({ id: 'lumen-ai', ai: true, send() {} });

const AGENT_APP = 'lumenrmt01.LumenAgent';
const isCineHd = (app) => Boolean(app) && (/^pvcinehd01\./.test(app.id ?? '') || /cine\s*hd/i.test(app.name ?? ''));
const POWER_KEYS = new Set(['KEY_POWER', 'KEY_POWEROFF', 'KEY_POWERON']);
// While CineHD is in the foreground the AI may only leave it or adjust the TV, never navigate inside it.
const CINEHD_KEYS = new Set(['KEY_HOME', 'KEY_EXIT', 'KEY_RETURN', 'KEY_VOLUP', 'KEY_VOLDOWN', 'KEY_MUTE', 'KEY_MENU', 'KEY_SOURCE']);
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

// ---------- schema validation (the subset the definitions below use) ----------

const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  integer: Number.isInteger,
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
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
  if (types.includes('object') && TYPE_CHECKS.object(value)) {
    for (const key of Object.keys(value)) {
      if (!(key in schema.properties)) return `${path} has an unexpected field "${key}"`;
    }
    for (const key of schema.required) {
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
      if (isCineHd(foregroundApp(store)) && keys.some((key) => !CINEHD_KEYS.has(key))) {
        fail('CineHD is open. Lumen does not navigate inside CineHD; it can only leave it (Home, Back, Exit) or change the volume.', 'UNAVAILABLE');
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
    description: 'Open an app on the TV by name or id (fuzzy: "netflix", "prime", "hotstar", "plex"). CineHD can be opened this way, but nothing can be searched or played inside it. To open a specific Netflix title or YouTube video use open_netflix or play_youtube instead.',
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
      if (isCineHd(foregroundApp(store))) fail('CineHD is open. Lumen does not search or type inside CineHD.', 'UNAVAILABLE');
      const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      if (!clean) fail('Nothing to type');
      await send(hub, { cmd: 'text.send', text: clean, submit });
      return { ok: true, summary: `Typed ${clean.length} characters${submit ? ' and submitted' : ''}` };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// [{ name, description, inputSchema }] in a fixed order (keeps the API prompt cache stable).
export const TOOL_DEFINITIONS = Object.freeze(TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));

export const hasTool = (name) => BY_NAME.has(name);

// ctx = { hub, store, catalog: { settings, keys, apps, isAllowedKey }, signal? }
// → { isError, result, text } where text is the JSON sent back to the model.
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
  return { isError: !result.ok, result, text: JSON.stringify(result) };
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
