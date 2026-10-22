// Scenes: named bundles of verified writes (run, delete, capture the current look as a new one),
// the sleep timer with a live countdown, and the key-macro recorder.

import { h, icon, fill } from '../ui/dom.js';
import { openSheet } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';
import { clock, countdown, prettySource } from '../ui/format.js';

const SLEEP_CHOICES = [15, 30, 60, 90];
const CAPTURE = [
  ['picture.mode', 'Picture mode'],
  ['picture.backlight', 'Brightness'],
  ['picture.contrast', 'Contrast'],
  ['picture.colorTone', 'Color tone'],
  ['picture.localDimming', 'Local dimming'],
  ['audio.soundMode', 'Sound mode'],
  ['audio.volume', 'Volume'],
  ['input.source', 'Input'],
];

function describeStep(ctx, step) {
  if (!step) return '';
  const label = (key) => ctx.setting(key)?.label || key;
  switch (step.cmd) {
    case 'setting.set': return `${label(step.key)} ${step.value}`;
    case 'volume.set': return `Volume ${step.atMost ? '≤ ' : ''}${step.value}`;
    case 'volume.step': return `Volume ${step.delta > 0 ? '+' : ''}${step.delta}`;
    case 'mute.set': return step.value ? 'Mute' : 'Unmute';
    case 'input.set': return prettySource(step.source);
    case 'app.launch': return ctx.app(step.appId)?.name || 'Open app';
    case 'key': return ctx.keyInfo(step.key)?.label || step.key?.replace(/^KEY_/, '');
    case 'power': return step.action === 'off' ? 'Power off' : 'Power on';
    case 'sleep.set': return step.minutes ? `Sleep ${step.minutes} min` : 'Sleep off';
    default: return step.cmd || 'Step';
  }
}

export function mountScenes(root, ctx) {
  const sceneList = h('div', { class: 'scene-grid' });
  const sleepHost = h('div', { class: 'card card-pad sleep-card' });
  const macroHost = h('div', { class: 'card card-pad macro-card' });
  const newScene = h('button', { class: 'btn sm', type: 'button' }, icon('plus'), 'New from current');
  newScene.addEventListener('click', () => openCapture(ctx));

  root.append(
    h('header', { class: 'view-head' }, h('div', null, h('h1', { class: 'view-title', text: 'Scenes' }), h('p', { class: 'view-sub', text: 'One tap to a whole look — every step is verified by read-back' }))),
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'Scenes' }), h('div', { class: 'aside' }, newScene)), sceneList),
    h('div', { class: 'scenes-pair' },
      h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'Sleep timer' })), sleepHost),
      h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'Macros' })), macroHost)),
  );

  ctx.state.watch('scenes', () => renderScenes(ctx, sceneList));
  mountSleep(ctx, sleepHost);
  mountMacros(ctx, macroHost);
}

function renderScenes(ctx, host) {
  const scenes = ctx.state.value('scenes', []) || [];
  if (!scenes.length) {
    fill(host, h('div', { class: 'empty card', text: 'No scenes yet — capture the current picture and sound as one.' }));
    return;
  }
  fill(host, ...scenes.map((scene) => {
    const run = h('button', { class: 'btn primary', type: 'button' }, icon('play'), 'Run');
    const del = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete ${scene.name}`, title: 'Delete' }, icon('trash', 'sm'));
    run.addEventListener('click', async () => {
      run.classList.add('is-busy');
      const ack = await ctx.cmd('scene.run', { target: scene.id }, { el: run, timeoutMs: 60000 });
      run.classList.remove('is-busy');
      if (ack.ok) toast(`${scene.name} applied`, { level: 'ok' });
    });
    let armed = false;
    del.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        del.classList.add('is-armed');
        del.setAttribute('aria-label', `Tap again to delete ${scene.name}`);
        setTimeout(() => { armed = false; del.classList.remove('is-armed'); }, 2500);
        return;
      }
      await ctx.cmd('scene.delete', { target: scene.id }, { el: del });
    });
    return h('article', { class: 'scene card' },
      h('div', { class: 'scene-head' }, h('h3', { class: 'scene-name', text: scene.name }), del),
      h('div', { class: 'scene-steps' }, (scene.steps || []).map((step) => h('span', { class: 'step', text: describeStep(ctx, step) }))),
      h('div', { class: 'scene-foot' }, h('span', { class: 'muted', text: `${scene.steps?.length || 0} steps` }), run));
  }));
}

function openCapture(ctx) {
  openSheet({
    title: 'New scene',
    build(body, sheet) {
      const name = h('input', { class: 'field', placeholder: 'Name, e.g. Late film', maxlength: 40, autofocus: true, 'aria-label': 'Scene name' });
      name.addEventListener('keydown', (e) => e.stopPropagation());
      const checks = CAPTURE.map(([key, label]) => {
        const v = ctx.state.value(key, null);
        const box = h('input', { type: 'checkbox', checked: v !== null && key !== 'input.source' ? true : null, disabled: v === null ? true : null });
        return { key, v, box, el: h('label', { class: `capture-row${v === null ? ' is-off' : ''}` }, box, h('span', { text: label }), h('b', { class: 'num', text: v === null ? '—' : key === 'input.source' ? prettySource(v) : String(v) })) };
      });
      const save = h('button', { class: 'btn primary lg', type: 'button', text: 'Save scene' });
      save.addEventListener('click', async () => {
        const steps = checks.filter((c) => c.box.checked && c.v !== null).map(({ key, v }) =>
          key === 'audio.volume' ? { cmd: 'volume.set', value: v }
            : key === 'input.source' ? { cmd: 'input.set', source: v }
              : { cmd: 'setting.set', key, value: v });
        if (!name.value.trim()) { name.focus(); name.classList.add('shake'); setTimeout(() => name.classList.remove('shake'), 400); return; }
        if (!steps.length) { toast('Pick at least one value', { level: 'warn' }); return; }
        const ack = await ctx.cmd('scene.save', { scene: { name: name.value.trim(), steps } }, { el: save });
        if (ack.ok) { toast(`Saved “${name.value.trim()}”`, { level: 'ok' }); sheet.close(); }
      });
      body.append(
        h('p', { class: 'sheet-lead', text: 'Capture what the TV is showing now. Each value is written and read back when the scene runs.' }),
        name,
        h('div', { class: 'capture-list' }, checks.map((c) => c.el)),
        h('div', { class: 'sheet-actions' }, save));
    },
  });
}

function mountSleep(ctx, host) {
  const ringFill = h('i');
  const remain = h('span', { class: 'sleep-remain num' });
  const at = h('span', { class: 'muted' });
  const chips = h('div', { class: 'chips' });
  const cancel = h('button', { class: 'btn sm ghost', type: 'button', text: 'Cancel timer' });
  const status = h('div', { class: 'sleep-status' }, h('span', { class: 'sleep-ring', style: { '--p': '0' } }, ringFill, icon('sleep')), h('div', null, remain, at));
  host.append(status, chips, cancel);
  let timer = null;

  const set = async (minutes, el) => {
    const ack = await ctx.cmd('sleep.set', { minutes }, { el });
    if (ack.ok) toast(minutes ? `The TV will turn off in ${minutes} minutes` : 'Sleep timer cancelled', { level: 'ok' });
  };
  cancel.addEventListener('click', () => set(0, cancel));

  function paint() {
    const sleep = ctx.state.value('sleep', null);
    const active = sleep && sleep.endsAt && sleep.endsAt > Date.now();
    host.classList.toggle('is-active', !!active);
    cancel.hidden = !active;
    fill(chips, ...SLEEP_CHOICES.map((m) => {
      const chip = h('button', { class: 'chip', type: 'button', 'aria-pressed': active && sleep.minutes === m ? 'true' : 'false', text: `${m} min` });
      chip.addEventListener('click', () => set(m, chip));
      return chip;
    }));
    clearInterval(timer);
    if (!active) {
      remain.textContent = 'Off';
      at.textContent = 'Lumen turns the TV off for you';
      status.firstChild.style.setProperty('--p', '0');
      return;
    }
    const tick = () => {
      const left = sleep.endsAt - Date.now();
      if (left <= 0) { paint(); return; }
      remain.textContent = countdown(left);
      at.textContent = `Turns off at ${clock(sleep.endsAt)}`;
      const total = (sleep.minutes || 1) * 60000;
      status.firstChild.style.setProperty('--p', String(Math.max(0, Math.min(1, left / total))));
    };
    tick();
    timer = setInterval(tick, 1000);
  }
  ctx.state.watch('sleep', paint);
}

function mountMacros(ctx, host) {
  const list = h('div', { class: 'macro-list' });
  const name = h('input', { class: 'field', placeholder: 'Macro name', maxlength: 40, 'aria-label': 'Macro name' });
  name.addEventListener('keydown', (e) => e.stopPropagation());
  const rec = h('button', { class: 'btn', type: 'button' }, h('i', { class: 'rec-dot' }), 'Record');
  const stop = h('button', { class: 'btn primary', type: 'button', hidden: true }, icon('stop'), 'Stop & save');
  const hint = h('p', { class: 'muted macro-hint', text: 'Record a sequence of remote keys with its timing, then replay it in one tap.' });
  let recording = false;

  rec.addEventListener('click', async () => {
    const ack = await ctx.cmd('macro.record', { phase: 'start' }, { el: rec });
    if (!ack.ok) return;
    recording = true;
    paintRec();
    toast('Recording — use the remote, then come back and stop', { level: 'info', timeout: 4000 });
  });
  stop.addEventListener('click', async () => {
    const ack = await ctx.cmd('macro.record', { phase: 'stop', name: name.value.trim() || `Macro ${clock(Date.now())}` }, { el: stop });
    recording = false;
    paintRec();
    if (ack.ok) { name.value = ''; toast('Macro saved', { level: 'ok' }); }
  });

  function paintRec() {
    host.classList.toggle('is-recording', recording);
    rec.hidden = recording;
    stop.hidden = !recording;
    hint.textContent = recording ? 'Recording… every key you press on the Remote or Keys view is captured.' : 'Record a sequence of remote keys with its timing, then replay it in one tap.';
  }

  ctx.state.watch('macros', () => {
    const macros = ctx.state.value('macros', []) || [];
    fill(list, ...(macros.length ? macros.map((m) => {
      const run = h('button', { class: 'btn sm', type: 'button' }, icon('play'), 'Run');
      run.addEventListener('click', async () => {
        run.classList.add('is-busy');
        await ctx.cmd('macro.run', { target: m.id }, { el: run, timeoutMs: 60000 });
        run.classList.remove('is-busy');
      });
      const del = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete ${m.name}`, title: 'Delete' }, icon('trash', 'sm'));
      del.addEventListener('click', () => ctx.cmd('macro.delete', { target: m.id }, { el: del }));
      return h('div', { class: 'macro' },
        h('div', { class: 'macro-text' }, h('b', { text: m.name }), h('span', { class: 'muted', text: (m.steps || []).slice(0, 6).map((s) => ctx.keyInfo(s.key)?.label || s.key?.replace(/^KEY_/, '')).join(' › ') + ((m.steps || []).length > 6 ? ' …' : '') })),
        run, del);
    }) : [h('div', { class: 'empty', text: 'No macros recorded' })]));
  });

  host.append(hint, h('div', { class: 'macro-rec' }, name, rec, stop), list);
}
