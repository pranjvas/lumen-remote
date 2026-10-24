// Settings: the TV's current configuration rendered from hello.catalog.settings and live state.
// Sliders commit on release and show the TV's read-back; enums are segmented; tracked rows offer
// Calibrate + Open TV Menu; Device and Connection rows come from device.*, system.* and conn.*.

import { h, icon, flash, fill } from '../ui/dom.js';
import { showInstallSteps } from '../ui/install-hint.js';
import { createSlider } from '../ui/slider.js';
import { createSegmented } from '../ui/segmented.js';
import { badge } from '../ui/badge.js';
import { openSheet } from '../ui/sheet.js';
import { toast, whisper } from '../ui/toast.js';
import { bytes, prettySource, stamp, titleCase } from '../ui/format.js';
import { RESTART_STEP, devModeStatus, startDeveloperMode } from './devmode.js';

const GROUPS = [
  { id: 'picture', title: 'Picture', short: 'Picture' },
  { id: 'pictureAdvanced', title: 'Picture · Advanced', short: 'Advanced' },
  { id: 'sound', title: 'Sound', short: 'Sound' },
  { id: 'input', title: 'Input & Source', short: 'Input' },
  { id: 'general', title: 'General', short: 'General', note: 'This firmware has no API for these. Tell Lumen what the TV shows once, and it keeps track.' },
  { id: 'network', title: 'Network', short: 'Network', note: 'Read from the TV by the Lumen agent.' },
  { id: 'bluetooth', title: 'Bluetooth', short: 'Bluetooth', note: 'Read by Lumen Eyes (the native helper app on the TV) when you open Settings. Pair or remove devices in the TV menu (Settings → Connection).' },
  { id: 'device', title: 'Device', short: 'Device' },
  { id: 'connection', title: 'Connection', short: 'Connection' },
  { id: 'phone', title: 'This phone', short: 'Phone', note: 'Put Lumen, or just its browser, on your Home Screen: one tap opens it full screen, like an app.' },
];

const DEVICE_ROWS = [
  ['device.name', 'Name'],
  ['device.modelName', 'Model'],
  ['device.model', 'Model code'],
  ['device.platform', 'Platform', (v, s) => v || s.value('device.os')],
  ['device.year', 'Year'],
  ['device.firmware', 'Firmware'],
  ['device.resolution', 'Resolution'],
  ['device.panel', 'Panel', (v) => (v && typeof v === 'object' ? `${v.w} × ${v.h}` : v)],
  ['device.networkType', 'Network', titleCase],
  ['device.language', 'Language'],
  ['device.country', 'Region'],
  ['device.developerMode', 'Developer mode', (v) => (v === true || v === '1' || v === 1 ? 'On' : v === false || v === '0' || v === 0 ? 'Off' : v)],
  ['caption.state', 'Captions', titleCase],
  ['audio.outputCodec', 'Audio output'],
];

const CONN_LABELS = {
  'conn.tv': { label: 'TV', values: { on: 'On', standby: 'Standby', off: 'Off / unreachable', unknown: 'Checking…' }, latency: 'rest' },
  'conn.remote': { label: 'Remote channel', hint: 'Keys, text and pointer', values: { paired: 'Paired', connecting: 'Connecting…', unpaired: 'Not paired', down: 'Down' } },
  'conn.upnp': { label: 'UPnP', hint: 'Volume and mute', values: { ok: 'OK', down: 'Down' }, latency: 'upnp' },
  'conn.events': { label: 'Live events', hint: 'Changes from the physical remote', values: { push: 'Push (GENA)', polling: 'Polling', off: 'Off' } },
  'conn.ipc': { label: 'IP Control', hint: 'Picture and sound values', values: { paired: 'Paired', unpaired: 'Not paired', down: 'Down' }, latency: 'ipc' },
  'conn.agent': { label: 'TV agent', hint: 'Channel, inputs, apps, system health', values: { online: 'Online', offline: 'Offline', launching: 'Starting…', unknown: 'Unknown' } },
};

const GOOD = new Set(['on', 'paired', 'ok', 'push', 'online']);
const WARN = new Set(['standby', 'connecting', 'polling', 'launching', 'unknown']);

export function mountSettings(root, ctx) {
  const body = h('div');
  root.append(body);
  let disposers = [];

  function build() {
    disposers.forEach((d) => d());
    disposers = [];
    const scope = {
      watch: (keys, fn) => disposers.push(ctx.state.watch(keys, fn)),
      on: (type, fn) => disposers.push(ctx.on(type, fn)),
      own: (dispose) => disposers.push(dispose),
    };
    const { watch } = scope;

    const scopeLine = h('p', { class: 'view-sub scope-line' });
    watch(['input.source', 'picture.mode', 'input.labels'], () => {
      const source = ctx.state.value('input.source', null);
      const labels = ctx.state.value('input.labels', {}) || {};
      const mode = ctx.state.value('picture.mode', null);
      fill(scopeLine, 'Picture values apply to ', h('b', { text: source ? labels[source] || prettySource(source) : '—' }), ' · ', h('b', { text: mode || '—' }));
    });

    const refresh = h('button', { class: 'btn ghost sm', type: 'button' }, icon('refresh'), 'Refresh');
    refresh.addEventListener('click', async () => {
      refresh.classList.add('is-busy');
      const ack = await ctx.cmd('settings.refresh', { group: 'all' }, { el: refresh, timeoutMs: 30000 });
      refresh.classList.remove('is-busy');
      if (ack.ok) toast('Settings re-read from the TV', { level: 'ok', timeout: 2000 });
    });

    const index = h('nav', { class: 'chips scroll settings-index', 'aria-label': 'Settings sections' });
    const sections = [];
    const byGroup = new Map(GROUPS.map((g) => [g.id, []]));
    for (const s of ctx.catalog.settings) {
      if (byGroup.has(s.group)) byGroup.get(s.group).push(s);
      else byGroup.set(s.group, [s]);
    }

    for (const g of GROUPS) {
      let rows;
      if (g.id === 'device') rows = deviceRows(ctx, scope, byGroup.get('device') || []);
      else if (g.id === 'connection') rows = connectionRows(ctx, scope);
      else if (g.id === 'network') rows = networkRows(ctx, scope);
      else if (g.id === 'bluetooth') rows = bluetoothRows(ctx, scope);
      else if (g.id === 'phone') rows = phoneRows();
      else rows = (byGroup.get(g.id) || []).map((s) => settingRow(ctx, s, scope));
      if (g.id === 'sound') rows.unshift(...soundExtras(ctx, scope));
      if (!rows.length) continue;
      const id = `set-${g.id}`;
      const section = h('section', { class: 'section', id, 'aria-labelledby': `${id}-h` },
        h('div', { class: 'section-head' }, h('h2', { id: `${id}-h`, text: g.title })),
        g.note ? h('p', { class: 'section-note', text: g.note }) : null,
        h('div', { class: 'rows card' }, rows));
      sections.push(section);
      const chip = h('button', { class: 'chip', type: 'button', text: g.short, dataset: { section: id }, onClick: () => section.scrollIntoView({ behavior: 'smooth', block: 'start' }) });
      index.append(chip);
    }

    // The index follows the reading position: the section at the top lights its chip, and the chip
    // scrolls into view inside the strip.
    if ('IntersectionObserver' in window) {
      const seen = new Map();
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting ? e.boundingClientRect.top : null);
        const top = sections.filter((s) => s.id && seen.get(s.id) != null).sort((a, b) => seen.get(a.id) - seen.get(b.id))[0];
        if (!top) return;
        for (const c of index.children) {
          const on = c.dataset.section === top.id;
          if (on && c.getAttribute('aria-current') !== 'true') {
            const left = c.offsetLeft - (index.clientWidth - c.offsetWidth) / 2;
            index.scrollTo({ left, behavior: 'smooth' });
          }
          if (on) c.setAttribute('aria-current', 'true');
          else c.removeAttribute('aria-current');
        }
      }, { root, rootMargin: '-64px 0px -55% 0px' });
      for (const s of sections) if (s.id) io.observe(s);
      scope.own(() => io.disconnect());
    }

    if (!ctx.catalog.settings.length) {
      sections.unshift(h('div', { class: 'empty card' }, 'Waiting for the settings catalogue from Lumen…'));
    }

    fill(body, 
      h('header', { class: 'view-head' }, h('div', null, h('h1', { class: 'view-title', text: 'Settings' }), scopeLine), refresh),
      index,
      ...sections,
    );
  }

  ctx.on('hello', build);
  build();
}

/* ---------- Generic setting rows ---------- */

function rowShell(s, control, { value, extra, sub } = {}) {
  const label = h('div', { class: 'row-label' },
    h('span', { class: 'label', text: s.label || titleCase(s.key.split('.').pop()) }),
    s.hint ? h('span', { class: 'hint', text: s.hint }) : null,
    sub || null);
  return h('div', { class: `row row-${s.type}`, dataset: { key: s.key } },
    label,
    h('div', { class: 'row-control' }, control),
    value || null,
    h('div', { class: 'row-badge' }, badge(s.key, { compact: true }), extra || null));
}

function blocked(ctx, s) {
  if (ctx.isLocked(s.key)) return { reason: 'Locked in this picture mode', kind: 'locked' };
  if (s.dependsOn) {
    const v = ctx.state.value(s.dependsOn.key, null);
    if (v !== null && String(v) !== String(s.dependsOn.value)) {
      const dep = ctx.setting(s.dependsOn.key);
      return { reason: `Needs ${dep?.label || s.dependsOn.key} · ${s.dependsOn.value}`, kind: 'depends' };
    }
  }
  return null;
}

function settingRow(ctx, s, scope) {
  switch (s.type) {
    case 'range': return rangeRow(ctx, s, scope);
    case 'enum': return s.key === 'input.source' ? inputRow(ctx, s, scope) : enumRow(ctx, s, scope);
    case 'toggle': return toggleRow(ctx, s, scope);
    case 'tracked': return trackedRow(ctx, s, scope);
    default: return readonlyRow(ctx, s, scope);
  }
}

function formatterFor(s, rec) {
  if (s.display === 'gr') {
    const half = (rec?.range || s.range || [-50, 50])[1];
    return (v) => (Number.isFinite(v) ? `G${half - v} / R${half + v}` : '—');
  }
  return (v) => (v === null || v === undefined ? '—' : String(v));
}

function applyBlocked(row, b, note) {
  row.classList.toggle('is-locked', b?.kind === 'locked');
  row.classList.toggle('is-dependent', b?.kind === 'depends');
  note.textContent = b ? b.reason : '';
  note.hidden = !b;
}

function rangeRow(ctx, s, { watch, on }) {
  const rec0 = ctx.state.get(s.key);
  const [min, max] = rec0?.range || s.range || [0, 100];
  const fmt = formatterFor(s, rec0);
  const valueEl = h('span', { class: 'row-value num', text: '—' });
  const note = h('span', { class: 'row-note', hidden: true });
  const slider = createSlider({
    min, max, step: s.step || 1, value: Number.isFinite(rec0?.v) ? rec0.v : min, label: s.label, bipolar: min < 0,
    format: fmt,
    onInput: (v) => { valueEl.textContent = fmt(v); },
    onCommit: (v) => commit(v),
  });
  const writable = s.writable !== false && !!s.ipc;
  const row = rowShell(s, slider.el, { value: valueEl, sub: note });

  async function commit(v) {
    const truth = ctx.state.truth(s.key)?.v;
    if (v === truth) return;
    slider.setPending(true);
    row.classList.add('is-pending');
    ctx.state.setOverlay(s.key, v);
    const ack = await ctx.cmd('setting.set', { key: s.key, value: v }, { el: row });
    ctx.state.clearOverlay(s.key);
    slider.setPending(false);
    row.classList.remove('is-pending');
    if (ack.ok) {
      const readBack = Number.isFinite(ack.value) ? ack.value : v;
      slider.set(readBack, { force: true });
      valueEl.textContent = fmt(readBack);
      flash(valueEl, 'is-settled', 900);
      if (readBack !== v) whisper(`${s.label}: the TV settled on ${fmt(readBack)}`);
    } else {
      const back = ctx.state.truth(s.key)?.v;
      slider.set(back, { force: true });
      valueEl.textContent = fmt(back);
      update();
    }
  }

  function update() {
    const rec = ctx.state.get(s.key);
    const v = Number.isFinite(rec?.v) ? rec.v : null;
    if (!slider.busy) valueEl.textContent = fmt(v);
    if (v !== null) slider.set(v);
    const b = blocked(ctx, s);
    applyBlocked(row, b, note);
    slider.setDisabled(!writable || v === null || !!b);
  }
  watch([s.key, s.dependsOn?.key, 'input.source', 'picture.mode'].filter(Boolean), update);
  on('locks', update);
  return row;
}

function enumOptions(s, rec) {
  const opts = [...(rec?.options || s.options || [])];
  if (rec?.v != null && !opts.map(String).includes(String(rec.v))) opts.push(rec.v);
  return opts;
}

function enumRow(ctx, s, { watch, on }) {
  const note = h('span', { class: 'row-note', hidden: true });
  const host = h('div', { class: 'row-enum' });
  const writable = s.writable !== false && !!s.ipc;
  let seg = null;
  let optsSig = '';
  const row = rowShell(s, host, { sub: note });

  async function select(opt) {
    seg.setPending(opt);
    ctx.state.setOverlay(s.key, opt);
    const ack = await ctx.cmd('setting.set', { key: s.key, value: opt }, { el: row });
    ctx.state.clearOverlay(s.key);
    seg.setPending(null);
    if (ack.ok && ack.value != null && String(ack.value) !== String(opt)) whisper(`${s.label}: the TV stayed on ${ack.value}`);
  }

  function update() {
    const rec = ctx.state.get(s.key);
    const opts = enumOptions(s, rec);
    if (!writable || !opts.length) {
      fill(host, h('span', { class: 'row-text', text: rec?.v ?? '—' }));
      optsSig = '';
      return;
    }
    const sig = opts.join('|');
    if (sig !== optsSig) {
      optsSig = sig;
      seg = createSegmented({ options: opts, value: rec?.v, label: s.label, onSelect: select });
      fill(host, seg.el);
    }
    seg.set(rec?.v);
    const b = blocked(ctx, s);
    applyBlocked(row, b, note);
    seg.setDisabled(rec?.v == null || !!b);
  }
  watch([s.key, s.dependsOn?.key, 'input.source', 'picture.mode'].filter(Boolean), update);
  on('locks', update);
  return row;
}

function inputRow(ctx, s, { watch }) {
  const host = h('div', { class: 'row-enum' });
  const row = rowShell({ ...s, label: s.label || 'Source' }, host);
  let seg = null;
  let sig = '';
  watch(['input.*'], () => {
    const rec = ctx.state.get('input.source');
    const labels = ctx.state.value('input.labels', {}) || {};
    const connected = new Set(ctx.state.value('input.connected', []) || []);
    const opts = enumOptions(s, rec);
    const nextSig = JSON.stringify([opts, labels, [...connected]]);
    if (nextSig === sig && seg) { seg.set(rec?.v); return; }
    sig = nextSig;
    seg = createSegmented({
      options: opts,
      value: rec?.v,
      label: 'Input source',
      format: (o) => labels[o] || prettySource(o),
      onSelect: async (opt) => {
        seg.setPending(opt);
        const ack = await ctx.cmd('input.set', { source: opt }, { el: row });
        seg.setPending(null);
        if (!ack.ok) seg.set(ctx.state.value('input.source'));
      },
    });
    for (const b of seg.el.children) if (connected.has(b.dataset.value) || (b.dataset.value === 'TV' && connected.has('TV1'))) b.classList.add('is-connected');
    fill(host, seg.el);
  });
  return row;
}

function toggleRow(ctx, s, { watch }) {
  const sw = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-label': s.label, 'aria-checked': 'false' });
  const row = rowShell(s, sw);
  const isOn = (v) => v === true || v === 'On' || v === 'on';
  sw.addEventListener('click', async () => {
    const next = !isOn(ctx.state.value(s.key));
    const opts = s.options || [];
    const value = opts.length === 2 ? opts[next ? 1 : 0] : next;
    ctx.state.setOverlay(s.key, value);
    await ctx.cmd('setting.set', { key: s.key, value }, { el: row });
    ctx.state.clearOverlay(s.key);
  });
  watch([s.key], () => sw.setAttribute('aria-checked', isOn(ctx.state.value(s.key)) ? 'true' : 'false'));
  return row;
}

function readonlyValue(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') {
    const entries = Object.entries(v);
    if (!entries.length) return '—';
    return h('span', { class: 'kv' }, entries.map(([k, x]) => h('span', null, h('i', { text: k.replace(/-?Gain$/, ' gain').replace(/-?Offset$/, ' offset') }), h('b', { class: 'num', text: String(x) }))));
  }
  return String(v);
}

function readonlyRow(ctx, s, { watch }) {
  const text = h('span', { class: 'row-text' });
  const row = rowShell(s, text);
  watch([s.key], () => fill(text, readonlyValue(ctx.state.value(s.key, null))));
  return row;
}

/* ---------- Tracked settings ---------- */

function trackedRow(ctx, s, { watch }) {
  const text = h('span', { class: 'row-text' });
  const set = h('span', { class: 'row-note tracked-note' });
  const calibrate = h('button', { class: 'btn sm', type: 'button', text: 'Calibrate' });
  const menu = h('button', { class: 'btn sm ghost', type: 'button' }, icon('tvmenu'), 'Open TV Menu');
  const row = rowShell(s, h('div', { class: 'tracked-control' }, text, h('div', { class: 'tracked-actions' }, calibrate, menu)), { sub: set });
  calibrate.addEventListener('click', () => openCalibrate(ctx, s));
  menu.addEventListener('click', async () => {
    const ack = await ctx.key('KEY_MENU');
    if (ack.ok) toast(s.menuPath ? `On the TV: ${s.menuPath}` : 'TV menu opened', { level: 'info', timeout: 6000 });
  });
  watch([s.key], () => {
    const rec = ctx.state.get(s.key);
    text.textContent = rec?.v != null ? String(rec.v) : 'Not calibrated';
    text.classList.toggle('muted', rec?.v == null);
    set.textContent = rec?.v != null && rec.at ? `Set ${stamp(rec.at)}` : s.menuPath || '';
  });
  return row;
}

function openCalibrate(ctx, s) {
  openSheet({
    title: s.label,
    build(body, sheet) {
      body.append(h('p', { class: 'sheet-lead', text: `What does your TV show for ${s.label}?` }));
      if (s.menuPath) body.append(h('p', { class: 'menu-path' }, icon('tvmenu', 'sm'), h('span', { text: s.menuPath })));
      const save = async (value, el) => {
        const ack = await ctx.cmd('setting.set', { key: s.key, value }, { el });
        if (ack.ok) {
          toast(`${s.label} tracked as ${value}`, { level: 'ok', timeout: 2400 });
          sheet.close();
        }
      };
      if (s.range) {
        const [min, max] = s.range;
        const current = ctx.state.value(s.key, Math.round((min + max) / 2));
        const valueEl = h('span', { class: 'cal-value num', text: String(current) });
        const slider = createSlider({ min, max, step: s.step || 1, value: current, label: s.label, bipolar: min < 0, big: true, onInput: (v) => { valueEl.textContent = String(v); } });
        const ok = h('button', { class: 'btn primary lg', type: 'button', text: 'Save' });
        ok.addEventListener('click', () => save(slider.value, ok));
        body.append(valueEl, slider.el, h('div', { class: 'sheet-actions' }, ok));
      } else {
        const current = ctx.state.value(s.key, null);
        body.append(h('div', { class: 'chips cal-chips' }, (s.options || []).map((opt) => {
          const chip = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(opt) === String(current) ? 'true' : 'false', text: String(opt) });
          chip.addEventListener('click', () => save(opt, chip));
          return chip;
        })));
      }
      const open = h('button', { class: 'btn ghost', type: 'button' }, icon('tvmenu'), 'Open TV Menu to check');
      open.addEventListener('click', () => ctx.key('KEY_MENU'));
      body.append(h('div', { class: 'sheet-foot' }, open));
    },
  });
}

/* ---------- Sound extras: live volume and mute in the Sound section ---------- */

function soundExtras(ctx, { watch, own }) {
  const volValue = h('span', { class: 'row-value num', text: '—' });
  const slider = createSlider({
    min: 0, max: 100, step: 1, value: ctx.volume.shown() ?? 0, label: 'Volume', detents: true,
    format: (v) => `Volume ${v}`,
    onInput: (v) => { volValue.textContent = String(v); ctx.volume.set(v); },
  });
  const vol = rowShell({ key: 'audio.volume', label: 'Volume', hint: 'Exact level, read back from the TV', type: 'range' }, slider.el, { value: volValue });
  own(ctx.volume.subscribe((s) => {
    if (!slider.busy) { volValue.textContent = s.value === null ? '—' : String(s.value); slider.set(s.value); }
    slider.setPending(s.pending);
    slider.setDisabled(s.value === null);
  }));
  const sw = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-label': 'Mute', 'aria-checked': 'false' });
  sw.addEventListener('click', () => ctx.volume.toggleMute({ el: sw }));
  const mute = rowShell({ key: 'audio.mute', label: 'Mute', type: 'toggle' }, sw);
  watch(['audio.mute'], () => sw.setAttribute('aria-checked', ctx.state.value('audio.mute', false) ? 'true' : 'false'));
  return [vol, mute];
}

/* ---------- Device ---------- */

function deviceRows(ctx, scope, catalogRows) {
  const { watch } = scope;
  const labelFor = new Map(catalogRows.map((s) => [s.key, s.label]));
  const rows = [];
  for (const [key, label, format = (v) => v] of DEVICE_ROWS) {
    const text = h('span', { class: 'row-text' });
    const row = rowShell({ key, label: labelFor.get(key) || label, type: 'readonly' }, text);
    watch([key, 'device.os'], () => {
      const raw = ctx.state.value(key, null);
      const v = format(raw, ctx.state);
      text.textContent = v == null || v === '' ? '—' : String(v);
      row.hidden = v == null && !['device.modelName', 'device.firmware', 'device.platform', 'device.resolution'].includes(key);
    });
    rows.push(row);
  }
  rows.push(healthRow(ctx, scope));
  return rows;
}

function healthRow(ctx, { watch }) {
  const meter = (label) => {
    const fill = h('i');
    const value = h('span', { class: 'num' });
    return { el: h('div', { class: 'health-item' }, h('span', { class: 'silk', text: label }), h('div', { class: 'meter' }, fill), value), fill, value };
  };
  const cpu = meter('CPU');
  const mem = meter('Memory');
  const disk = meter('Storage');
  // Free memory: closes apps running in the background (not on screen); they start fresh next time.
  const freeBtn = h('button', { class: 'btn sm', type: 'button', text: 'Free memory', title: 'Closes apps running in the background on the TV (not the one on screen). They start fresh next time.' });
  const freeNote = h('p', { class: 'row-note silk', hidden: true });
  freeBtn.addEventListener('click', async () => {
    freeBtn.classList.add('is-busy');
    const ack = await ctx.cmd('tv.freeMemory', {}, { el: freeBtn, timeoutMs: 90000 });
    freeBtn.classList.remove('is-busy');
    if (!ack.ok) return;
    const { closed = [], failed = [], freedMb, after } = ack.value ?? {};
    const names = (list) => list.map((c) => c.name || c.id).join(', ');
    const parts = [];
    if (closed.length) parts.push(`Closed ${names(closed)}${freedMb > 0 ? ` · about ${freedMb} MB freed` : ''}`);
    if (failed.length) parts.push(`Could not close ${names(failed)}`);
    if (!parts.length) parts.push('No apps were running in the background');
    if (after && (closed.length || failed.length)) parts.push(`${after.availableMb} MB available`);
    const msg = parts.join(' · ');
    freeNote.textContent = msg;
    freeNote.hidden = false;
    freeNote.title = failed.map((f) => `${f.name || f.id}: ${f.error}`).join('\n');
    toast(msg, { level: failed.length ? 'warn' : closed.length ? 'ok' : 'info' });
  });
  const row = rowShell({ key: 'system.cpuLoad', label: 'System health', hint: 'From the TV agent and Lumen Eyes', type: 'readonly' },
    h('div', { class: 'health-wrap' }, h('div', { class: 'health' }, cpu.el, mem.el, disk.el), h('div', { class: 'health-actions' }, freeBtn, freeNote)));
  const paint = (m, frac, text) => {
    const pct = Number.isFinite(frac) ? Math.round(frac * 100) : null;
    m.fill.style.setProperty('--pct', `${pct ?? 0}%`);
    m.fill.parentElement.classList.toggle('warn', pct !== null && pct >= 80);
    m.fill.parentElement.classList.toggle('bad', pct !== null && pct >= 93);
    m.value.textContent = text;
  };
  watch(['system.*', 'tv.memory'], () => {
    const v = (k) => ctx.state.value(`system.${k}`, null);
    const load = v('cpuLoad');
    paint(cpu, load, Number.isFinite(load) ? `${Math.round(load * 100)}%` : '—');
    // Eyes reads what the TV can actually use (MemAvailable, counting reclaimable cache); the agent's
    // web-API figure is closer to completely unused memory and reads much lower.
    const real = ctx.state.value('tv.memory', null);
    if (real && Number.isFinite(real.availableMb) && real.totalMb) {
      paint(mem, 1 - real.availableMb / real.totalMb, `${bytes(real.availableMb * 1048576)} free of ${bytes(real.totalMb * 1048576)}`);
      mem.value.title = Number.isFinite(real.swapFreeMb) ? `Usable memory, counting cache the TV can reclaim · swap ${real.swapFreeMb} MB free` : '';
    } else {
      const total = v('memTotal');
      const avail = v('memAvailable');
      paint(mem, total ? 1 - avail / total : null, total ? `${bytes(avail)} free of ${bytes(total)}` : '—');
    }
    const st = v('storageTotal');
    const sf = v('storageFree');
    paint(disk, st ? 1 - sf / st : null, st ? `${bytes(sf)} free` : '—');
  });
  return row;
}

/* ---------- Connection ---------- */

function latencyOf(ctx, which) {
  const direct = ctx.state.value(`conn.latency.${which}`, null);
  if (Number.isFinite(direct)) return direct;
  const all = ctx.state.value('conn.latency', null);
  return all && Number.isFinite(all[which]) ? all[which] : null;
}

function phoneRows() {
  return [['app', 'Lumen', 'The whole remote'], ['browser', 'Lumen Browser', 'Opens straight into the browser']].map(([kind, label, hint]) => {
    const add = h('button', { class: 'btn ghost sm', type: 'button' }, icon('plus'), 'Add to Home Screen');
    add.addEventListener('click', () => showInstallSteps(kind));
    return h('div', { class: 'row row-readonly' },
      h('div', { class: 'row-label' }, h('span', { class: 'label', text: label }), h('span', { class: 'hint', text: hint })),
      h('div', { class: 'row-control' }, add), h('div', { class: 'row-badge' }));
  });
}

function connectionRows(ctx, { watch, on, own }) {
  const rows = [];

  const linkText = h('span', { class: 'row-text' });
  const link = h('div', { class: 'row row-readonly' },
    h('div', { class: 'row-label' }, h('span', { class: 'label', text: 'Lumen on this PC' }), h('span', { class: 'hint', text: 'Browser ↔ Lumen server' })),
    h('div', { class: 'row-control' }, linkText), h('div', { class: 'row-badge' }));
  const paintLink = () => {
    const st = ctx.live.status;
    fill(linkText, statusDot(st === 'open' ? 'good' : st === 'connecting' ? 'warn' : 'bad'),
      st === 'open' ? 'Connected' : st === 'connecting' ? 'Connecting…' : 'Disconnected',
      ctx.live.rtt != null && st === 'open' ? h('span', { class: 'mono muted', text: ` · ${ctx.live.rtt} ms` }) : null,
      ctx.version ? h('span', { class: 'mono muted', text: ` · v${ctx.version}` }) : null);
  };
  own(ctx.live.on('status', paintLink));
  own(ctx.live.on('ack', paintLink));
  paintLink();
  rows.push(link);

  for (const [key, meta] of Object.entries(CONN_LABELS)) {
    const text = h('span', { class: 'row-text' });
    const actions = h('div', { class: 'row-actions' });
    const sub = h('span', { class: 'row-note', hidden: true });
    const row = rowShell({ key, label: meta.label, hint: meta.hint, type: 'readonly' }, h('div', { class: 'conn-control' }, text, actions), { sub });
    let shownActions;
    watch([key, 'conn.latency', 'conn.latency.*', key === 'conn.agent' ? 'conn.agentNote' : key], () => {
      const rec = ctx.state.get(key);
      const v = rec?.v ?? null;
      const lat = meta.latency ? latencyOf(ctx, meta.latency) : null;
      fill(text, statusDot(GOOD.has(v) ? 'good' : WARN.has(v) || v == null ? 'warn' : 'bad'),
        meta.values[v] || (v == null ? '—' : String(v)),
        Number.isFinite(lat) ? h('span', { class: 'mono muted', text: ` · ${lat} ms` }) : null);
      const note = key === 'conn.agent' ? ctx.state.value('conn.agentNote', null) || rec?.note : rec?.note;
      sub.textContent = note || '';
      sub.hidden = !note;
      // Rebuild the buttons only when the state changes: polls re-publish these keys every few
      // seconds, and a button replaced mid-click would swallow the click.
      if (shownActions !== v) {
        shownActions = v;
        fill(actions, ...connActions(ctx, key, v));
      }
    });
    rows.push(row);
    if (key === 'conn.agent') rows.push(developerModeRow(ctx, { watch, on }));
  }

  const aiText = h('span', { class: 'row-text' });
  const aiRow = h('div', { class: 'row row-readonly' },
    h('div', { class: 'row-label' }, h('span', { class: 'label', text: 'Ask Lumen (AI)' }), h('span', { class: 'hint', text: 'Natural-language control' })),
    h('div', { class: 'row-control' }, aiText), h('div', { class: 'row-badge' }));
  const paintAi = () => {
    const ai = ctx.ai;
    if (!ai) { aiText.textContent = '—'; return; }
    fill(aiText, statusDot(ai.ready ? 'good' : 'warn'),
      ai.ready ? `Ready · ${backendName(ai.backend)}` : 'Setup needed',
      !ai.ready && ai.reason ? h('span', { class: 'row-note', text: ai.reason }) : null);
  };
  on('ai-status', paintAi);
  paintAi();
  rows.push(aiRow);
  return rows;
}

// Developer mode (the TV agent and Lumen Eyes need it): its state from REST, and a button that has
// Ask Lumen turn it on with the built-in developer-mode TV skill (views/devmode.js).
function developerModeRow(ctx, { watch, on }) {
  const text = h('span', { class: 'row-text' });
  const actions = h('div', { class: 'row-actions' });
  const sub = h('span', { class: 'row-note devmode-note' });
  const row = rowShell({ key: 'device.developerMode', label: 'Developer mode', hint: 'Needed for the TV agent and Lumen Eyes', type: 'readonly' },
    h('div', { class: 'conn-control' }, text, actions), { sub });
  const button = h('button', { class: 'btn sm primary', type: 'button' });
  button.addEventListener('click', () => {
    if (startDeveloperMode(ctx, (msg) => window.confirm(msg))) {
      toast(`Lumen is turning on Developer mode. Follow it in Ask. ${RESTART_STEP}`, { level: 'info', timeout: 12000 });
    }
  });
  const paint = () => {
    const status = devModeStatus((key) => ctx.state.value(key, null), {
      tv: ctx.state.value('conn.tv', null), remote: ctx.state.value('conn.remote', null), ai: ctx.ai,
    });
    fill(text, statusDot(status.dot), status.text);
    button.textContent = status.action || '';
    button.disabled = !!status.blocked;
    button.title = status.blocked || 'Ask Lumen opens Apps, enters 1 2 3 4 5 and sets this PC as Host PC IP. No TV agent needed.';
    // device.* is re-published on every REST poll: move the button only when it appears or goes,
    // so a click in progress is never lost.
    if (actions.contains(button) !== !!status.action) fill(actions, ...(status.action ? [button] : []));
    sub.textContent = status.action ? (status.blocked ? `${status.blocked}. ` : '') + `Lumen does it with the remote keys. ${RESTART_STEP}` : '';
    sub.hidden = !status.action;
  };
  watch(['device.developerMode', 'device.developerHost', 'conn.tv', 'conn.remote'], paint);
  on('ai-status', paint);
  return row;
}

export function backendName(b) {
  return { api: 'Claude API', 'claude-code': 'Claude Code', off: 'Off' }[b] || b || '—';
}

function statusDot(kind) {
  return h('i', { class: `status-dot ${kind}`, 'aria-hidden': 'true' });
}

export function pairButton(ctx, cmd, label = 'Pair') {
  const b = h('button', { class: 'btn sm primary', type: 'button', text: label });
  b.addEventListener('click', async () => {
    b.classList.add('is-busy');
    toast('Look at your TV and choose Allow', { level: 'info', timeout: 8000 });
    const ack = await ctx.cmd(cmd, {}, { el: b, timeoutMs: 60000 });
    b.classList.remove('is-busy');
    if (ack.ok) toast('Paired', { level: 'ok' });
  });
  return b;
}

export function agentButton(ctx, label = 'Connect TV agent') {
  const b = h('button', {
    class: 'btn sm', type: 'button', text: label,
    title: 'Starts the Lumen Agent on the TV. Whatever app is in front goes to the background; the TV returns to live TV when the agent hides.',
  });
  b.addEventListener('click', async () => {
    const fg = ctx.state.value('app.foreground', null);
    if (fg && !window.confirm(`Connecting the TV agent sends ${fg.name || 'the current app'} to the background and the TV returns to live TV. Continue?`)) return;
    b.classList.add('is-busy');
    const ack = await ctx.cmd('agent.connect', {}, { el: b, timeoutMs: 30000 });
    b.classList.remove('is-busy');
    if (ack.ok) toast('Starting the TV agent — it flashes on screen for a moment', { level: 'info' });
  });
  return b;
}

function connActions(ctx, key, v) {
  if (key === 'conn.remote' && (v === 'unpaired' || v === 'down')) return [pairButton(ctx, 'pair.remote')];
  if (key === 'conn.ipc' && (v === 'unpaired' || v === 'down')) return [pairButton(ctx, 'pair.ipcontrol')];
  if (key === 'conn.agent' && v !== 'online' && v !== 'launching') return [agentButton(ctx)];
  if (key === 'conn.tv' && (v === 'standby' || v === 'off')) {
    const b = h('button', { class: 'btn sm primary', type: 'button', text: 'Wake TV' });
    b.addEventListener('click', () => ctx.power.wake());
    return [b];
  }
  return [];
}

/* ---------- Network and Bluetooth (agent 0.6.3+), read-only ---------- */

function infoRow(ctx, scope, key, label, hint, format) {
  const text = h('span', { class: 'row-text' });
  const row = rowShell({ key, label, hint, type: 'readonly' }, text);
  scope.watch([key], () => {
    const v = ctx.state.value(key, null);
    const shown = v == null ? null : format(v);
    fill(text, shown == null || shown === '' ? h('span', { class: 'muted', text: '—' }) : shown);
  });
  return row;
}

function networkRows(ctx, scope) {
  const typeName = { WIFI: 'Wi-Fi', ETHERNET: 'Ethernet (cable)', NONE: 'Not connected' };
  const signal = (s) => (typeof s === 'number' ? `${Math.round(s * 100)}%` : null);
  return [
    infoRow(ctx, scope, 'network.type', 'Connection', 'How the TV reaches your network', (v) => typeName[v] || v),
    infoRow(ctx, scope, 'network.wifi', 'Wi-Fi', 'Network name and signal', (w) => (w.status === 'ON' || w.ssid
      ? [statusDot(w.ssid ? 'good' : 'warn'), w.ssid || 'On, not joined', signal(w.signal) ? h('span', { class: 'mono muted', text: ` · signal ${signal(w.signal)}` }) : null]
      : [statusDot('off'), 'Off'])),
    infoRow(ctx, scope, 'network.wifi', 'IP address', 'Wi-Fi', (w) => (w.ip ? h('span', { class: 'mono', text: w.ip }) : null)),
    infoRow(ctx, scope, 'network.wifi', 'Gateway · DNS', 'Wi-Fi', (w) => (w.gateway || w.dns ? h('span', { class: 'mono', text: [w.gateway, w.dns].filter(Boolean).join(' · ') }) : null)),
    infoRow(ctx, scope, 'network.wifi', 'Wi-Fi MAC', null, (w) => (w.mac ? h('span', { class: 'mono', text: w.mac }) : null)),
    infoRow(ctx, scope, 'network.ethernet', 'Ethernet', 'Cable and address', (e) => [statusDot(e.cable === 'ATTACHED' ? 'good' : 'off'),
      e.cable === 'ATTACHED' ? 'Cable connected' : 'No cable', e.ip ? h('span', { class: 'mono muted', text: ` · ${e.ip}` }) : null]),
  ];
}

function bluetoothRows(ctx, scope) {
  const KIND = { AudioVideo: 'Audio', Peripheral: 'Remote or input device', Phone: 'Phone', Computer: 'Computer', Wearable: 'Wearable', Toy: 'Toy', Health: 'Health', Imaging: 'Camera or printer' };
  const adapter = infoRow(ctx, scope, 'bluetooth.state', 'Bluetooth', 'The TV’s adapter', (b) => [statusDot(b.powered ? 'good' : 'off'),
    b.powered === false ? 'Off' : 'On', b.name ? h('span', { class: 'muted', text: ` · ${b.name}` }) : null]);
  const list = h('div', { class: 'bt-devices' });
  const devices = h('div', { class: 'row row-readonly' },
    h('div', { class: 'row-label' }, h('span', { class: 'label', text: 'Paired devices' }), h('span', { class: 'hint', text: 'Connected ones first' })),
    h('div', { class: 'row-control' }, list), h('div', { class: 'row-badge' }, badge('bluetooth.state', { compact: true })));
  scope.watch(['bluetooth.state'], () => {
    const b = ctx.state.value('bluetooth.state', null);
    const items = (b?.devices ?? []).slice().sort((x, y) => (y.connected - x.connected) || x.name.localeCompare(y.name));
    fill(list, ...(items.length ? items.map((d) => h('div', { class: 'bt-device' },
      statusDot(d.connected ? 'good' : 'off'), h('span', { text: d.name }),
      h('span', { class: 'muted', text: ` · ${d.connected ? 'Connected' : 'Paired'}${KIND[d.kind] ? ` · ${KIND[d.kind]}` : ''}` })))
      : [h('span', { class: 'muted', text: b ? 'No paired devices' : '—' })]));
  });
  return [adapter, devices];
}
