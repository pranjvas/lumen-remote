// Ask Lumen: the ask bar (every view) and the Ask view, a chat with Claude. Messages in one chat
// share a thread id, so the server replays the earlier exchanges and follow-ups ("it can be on any
// app") are understood. Each reply shows a live status, a thumbnail of what Lumen is looking at,
// the steps it took (collapsed), and the answer. The chat is kept in localStorage across reloads.

import { h, icon, fill } from '../ui/dom.js';
import { makeId } from '../core/live.js';
import { toast } from '../ui/toast.js';
import { backendName } from './settings.js';
import { openSheet } from '../ui/sheet.js';

const EXAMPLES = ['Increase brightness', 'Play Friends on Netflix', 'What is on the TV right now?', 'Sleep in 30 minutes', 'Switch to HDMI 1', 'Find a comedy on Prime Video'];
const STORE_KEY = 'lumen.ask.chat';
const MAX_RUNS = 40;
const MAX_STEPS = 80;
// Speech recognition needs a secure context: available on localhost, not over plain http on the LAN.
const Recognition = globalThis.isSecureContext ? (globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition) : null;

const bareName = (name) => String(name || 'tool').replace(/^mcp__lumen__/, '');
const toolTitle = (name) => bareName(name)
  .split('_')
  .map((w, i) => (/^(tv|url|ip)$/i.test(w) ? w.toUpperCase() : i ? w : w.charAt(0).toUpperCase() + w.slice(1)))
  .join(' ');
const STEP_TEXT = {
  look_at_screen: 'Looked at the screen',
  get_app_skill: 'Read the app skill',
  WebSearch: 'Searched the web',
  WebFetch: 'Read a web page',
};

function stepText(step) {
  const name = bareName(step.name);
  if (name === 'WebSearch' && step.input) return `Searched the web for ${step.input.replace(/^query=/, '“')}${/^query=/.test(step.input) ? '”' : ''}`;
  if (STEP_TEXT[name]) return STEP_TEXT[name];
  if (step.result && step.result !== 'Done') return step.result;
  return toolTitle(step.name);
}

// "34 steps · looked at the screen 17 times"
function stepsSummary(steps) {
  const looks = steps.filter((s) => bareName(s.name) === 'look_at_screen').length;
  const failed = steps.filter((s) => s.ok === false).length;
  const parts = [`${steps.length} step${steps.length === 1 ? '' : 's'}`];
  if (looks) parts.push(`looked at the screen ${looks === 1 ? 'once' : `${looks} times`}`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(' · ');
}

// A small, safe Markdown subset for answers: paragraphs, "- " lists, **bold**, [text](https://…).
function renderInline(text) {
  const out = [];
  const pattern = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h('strong', { text: m[1] }));
    else {
      const href = m[3] || m[4];
      const label = m[2] || (() => { try { return new URL(href).hostname.replace(/^www\./, ''); } catch { return href; } })();
      out.push(h('a', { href, target: '_blank', rel: 'noopener noreferrer', text: label }));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderAnswer(text) {
  const blocks = [];
  let list = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const item = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (item) {
      list ??= h('ul');
      list.append(h('li', null, ...renderInline(item[1])));
      continue;
    }
    if (list) { blocks.push(list); list = null; }
    if (line.trim()) blocks.push(h('p', null, ...renderInline(line.replace(/^#+\s*/, ''))));
  }
  if (list) blocks.push(list);
  return blocks.length ? blocks : [h('p', { text: 'Done.' })];
}

function loadChat() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && typeof saved.thread === 'string' && Array.isArray(saved.runs)) return saved;
  } catch { /* a corrupt entry starts a new chat */ }
  return { thread: makeId(), runs: [] };
}

export function createAsk(ctx) {
  let chat = loadChat();
  const runs = new Map(); // id → run view
  const thread = h('div', { class: 'ask-thread' });
  const transcript = h('div', { class: 'transcript', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation with Lumen' });
  const empty = h('div', { class: 'ask-empty' });
  const statusPill = h('span', { class: 'ai-pill' });
  const inputs = new Set();
  thread.append(empty, transcript);

  // Runs left "running" by a reload never get their end: say so instead of spinning forever.
  for (const saved of chat.runs) {
    if (!saved.done) Object.assign(saved, { done: true, ok: false, error: 'This reply was lost when the page reloaded.' });
  }

  function save() {
    chat.runs = chat.runs.slice(-MAX_RUNS);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(chat));
    } catch { /* storage full: the chat still works for this session */ }
  }

  function paintStatus() {
    const ai = ctx.ai;
    statusPill.className = `ai-pill ${ai?.ready ? 'ready' : 'setup'}`;
    fill(statusPill, h('i'), ai ? (ai.ready ? `${backendName(ai.backend)} · ready` : 'Setup needed') : 'Checking…');
    statusPill.title = ai?.reason || '';
    fill(empty,
      h('div', { class: 'ask-orb', 'aria-hidden': 'true' }, icon('spark', 'lg')),
      h('p', { class: 'ask-lead', text: 'What should the TV do?' }),
      h('p', { class: 'ask-sub', text: 'Lumen can change settings, open apps, find and play titles, and see the screen to work inside any app. Follow-ups continue the same chat.' }),
      ai && !ai.ready ? h('p', { class: 'ask-setup' }, icon('alert', 'sm'), h('span', { text: ai.reason || 'Ask Lumen is not set up yet' })) : null,
      h('div', { class: 'chips ask-examples' }, EXAMPLES.map((text) => h('button', { class: 'chip', type: 'button', text, onClick: () => submit(text) }))));
    empty.hidden = chat.runs.length > 0;
    for (const input of inputs) input.placeholder = ai && !ai.ready ? 'Ask Lumen — setup needed' : chat.runs.length ? 'Reply or ask something else…' : 'Ask Lumen… “play Friends on Netflix”';
  }

  // ---- one exchange: the user's message and Lumen's reply ----

  function view(record) {
    const status = h('div', { class: 'run-status' });
    const eye = h('img', { class: 'run-eye', alt: 'What Lumen saw on the TV', hidden: true, decoding: 'async' });
    const stepsList = h('ol', { class: 'run-steps-list' });
    const stepsSummaryEl = h('summary', { class: 'run-steps-summary' });
    const steps = h('details', { class: 'run-steps', hidden: true }, stepsSummaryEl, stepsList);
    const answer = h('div', { class: 'run-answer' });
    const meta = h('div', { class: 'run-meta' });
    const cancel = h('button', { class: 'btn sm ghost run-cancel', type: 'button', text: 'Stop' });
    const el = h('article', { class: 'run' },
      h('div', { class: 'run-ask' }, h('p', { class: 'run-quote', text: record.text })),
      h('div', { class: 'run-reply' },
        h('div', { class: 'run-avatar', 'aria-hidden': 'true' }, icon('spark', 'sm')),
        h('div', { class: 'run-body' }, status, eye, answer, steps, h('div', { class: 'run-foot' }, meta, cancel))));
    cancel.addEventListener('click', () => ctx.cmd('ai.cancel', { target: record.id }, { el: cancel }));
    const run = { record, el, status, eye, steps, stepsList, stepsSummaryEl, answer, meta, cancel };
    runs.set(record.id, run);
    for (const step of record.steps) addStep(run, step, false);
    paint(run);
    return run;
  }

  function addStep(run, step, live = true) {
    const failed = step.ok === false;
    run.stepsList.append(h('li', { class: `run-step${failed ? ' is-failed' : ''}${step.note ? ' is-note' : ''}` },
      step.note ? h('span', { class: 'run-step-text', text: step.note })
        : [h('span', { class: 'run-step-icon' }, icon(failed ? 'alert' : bareName(step.name) === 'look_at_screen' ? 'eye' : 'check', 'xs')),
          h('span', { class: 'run-step-text', text: stepText(step) })]));
    if (live) paint(run);
  }

  function paint(run) {
    const { record } = run;
    const toolSteps = record.steps.filter((s) => !s.note);
    run.el.classList.toggle('is-running', !record.done);
    run.el.classList.toggle('is-failed', record.done && record.ok === false);
    run.steps.hidden = toolSteps.length === 0 && !record.steps.length;
    run.stepsSummaryEl.textContent = toolSteps.length ? stepsSummary(toolSteps) : 'Notes';
    if (!record.done) {
      const last = toolSteps.at(-1);
      fill(run.status, h('span', { class: 'spinner' }), h('span', { text: record.status || (last ? `${stepText(last)}…` : 'Thinking…') }));
      run.status.hidden = false;
    } else {
      run.status.hidden = true;
    }
    if (record.answer) fill(run.answer, ...renderAnswer(record.answer));
    else if (record.error) fill(run.answer, h('p', { class: 'run-error' }, icon('alert', 'sm'), h('span', { text: record.error })));
    else fill(run.answer);
    run.cancel.hidden = record.done;
    const secs = Number.isFinite(record.ms) ? `${record.ms < 10000 ? (record.ms / 1000).toFixed(1) : Math.round(record.ms / 1000)} s` : null;
    run.meta.textContent = record.done ? [record.ok === false ? 'Stopped' : 'Done', secs].filter(Boolean).join(' · ') : '';
  }

  function showEye(run) {
    const at = ctx.state.value('screen.at', 0);
    if (!at) return;
    run.eye.src = `/api/screen.png?at=${at}`;
    run.eye.hidden = false;
  }

  function append(record) {
    const run = view(record);
    transcript.append(run.el);
    empty.hidden = true;
    return run;
  }

  function scrollToEnd(smooth = false) {
    const last = transcript.lastElementChild;
    if (last && ctx.viewName === 'ask') last.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' });
  }

  function onEvent(msg) {
    const run = runs.get(msg.id);
    if (!run) return;
    const { record } = run;
    switch (msg.kind) {
      case 'status':
        record.status = msg.text || 'Working…';
        break;
      case 'tool': {
        const step = { name: msg.name, ok: msg.ok, input: msg.input || '', result: msg.result || '' };
        if (record.steps.length < MAX_STEPS) record.steps.push(step);
        record.status = '';
        addStep(run, step);
        if (bareName(msg.name) === 'look_at_screen' && msg.ok !== false) showEye(run);
        if (bareName(msg.name) === 'save_app_skill' && msg.ok !== false) loadSkills();
        break;
      }
      case 'text':
        if (msg.text && record.steps.length < MAX_STEPS) {
          const step = { note: msg.text };
          record.steps.push(step);
          addStep(run, step);
        }
        break;
      case 'result':
        record.answer = msg.text || 'Done.';
        break;
      case 'error':
        record.error = msg.message || 'Something went wrong';
        break;
      case 'done':
        record.done = true;
        record.ok = msg.ok !== false && !record.error;
        record.ms = msg.ms;
        break;
      default:
        return;
    }
    paint(run);
    if (msg.kind === 'done' || msg.kind === 'result' || msg.kind === 'error') save();
    scrollToEnd();
  }

  async function submit(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    ctx.navigate('ask');
    const record = { id: makeId(), text: clean, at: Date.now(), steps: [], done: false };
    chat.runs.push(record);
    save();
    append(record);
    paintStatus();
    requestAnimationFrame(() => scrollToEnd(true));
    const ack = await ctx.live.send('ai.ask', { text: clean, thread: chat.thread }, { id: record.id, timeoutMs: 15000 });
    if (!ack.ok) {
      Object.assign(record, { done: true, ok: false, error: ack.error?.message || 'Ask Lumen is not available' });
      paint(runs.get(record.id));
      save();
    }
  }

  function newChat() {
    for (const record of chat.runs) if (!record.done) ctx.cmd('ai.cancel', { target: record.id }, { silent: true });
    chat = { thread: makeId(), runs: [] };
    save();
    runs.clear();
    fill(transcript);
    paintStatus();
    for (const input of inputs) input.focus();
  }

  function bindComposer(form, input, mic) {
    inputs.add(input);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value;
      input.value = '';
      if (!form.classList.contains('ask-composer')) input.blur();
      submit(text);
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') input.blur();
    });
    if (!Recognition) { mic?.remove(); return; }
    let rec = null;
    mic.addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      rec = new Recognition();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      mic.classList.add('is-listening');
      rec.onresult = (e) => {
        const result = e.results[e.results.length - 1];
        input.value = result[0].transcript;
        // Submitting through the form lets its owner react as to a typed request (the header Ask sheet
        // closes itself on submit).
        if (!result.isFinal) return;
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else { const text = input.value; input.value = ''; submit(text); }
      };
      rec.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast('The microphone is not available', { level: 'warn' }); };
      rec.onend = () => { mic.classList.remove('is-listening'); rec = null; };
      rec.start();
    });
  }

  function composer({ big = false } = {}) {
    const input = h('input', { type: 'text', autocomplete: 'off', enterkeyhint: 'send', 'aria-label': 'Ask Lumen', maxlength: 2000 });
    const mic = h('button', { class: 'icon-btn mic', type: 'button', 'aria-label': 'Speak your request', title: 'Speak' }, icon('mic', 'sm'));
    const send = h('button', { class: 'icon-btn send', type: 'submit', 'aria-label': 'Send' }, icon('send', 'sm'));
    const hint = big ? null : h('span', { class: 'kbd ask-kbd', 'aria-hidden': 'true', text: '/' });
    const form = h('form', { class: big ? 'ask-composer' : 'askbar', role: 'search' }, icon('spark', 'sm'), input, hint, mic, send);
    bindComposer(form, input, mic);
    return { form, input };
  }

  // ---- app skills: what Lumen knows about each app (built in or learned by the AI) ----

  const FLOW_LABEL = {
    open: 'Open', search: 'Search', type: 'Type', pickResult: 'Pick result', play: 'Play',
    code: 'Code', switchOn: 'Switch on', hostIp: 'Host PC IP', hostIpKeyboard: 'Host PC IP (keyboard)', confirm: 'OK', cancel: 'Back out',
  };
  const skillsList = h('div', { class: 'skills-list' });
  const skillsCount = h('span', { class: 'skills-count' });
  const skillsPanel = h('details', { class: 'skills-panel' },
    h('summary', { class: 'skills-summary' }, icon('agent', 'xs'), h('span', { text: 'App skills' }), skillsCount,
      h('span', { class: 'skills-hint', text: 'How Lumen works inside each app. It adds to these as it learns.' })),
    skillsList);

  async function loadSkills() {
    const ack = await ctx.live.send('skills.list', {}, { timeoutMs: 8000 });
    if (!ack.ok) return;
    const skills = ack.value || [];
    skillsCount.textContent = String(skills.length);
    fill(skillsList, ...skills.map((s) => h('button', { class: 'skill-card', type: 'button', onClick: () => showSkill(s.slug) },
      h('span', { class: 'skill-app', text: s.app }),
      h('span', { class: `skill-source is-${s.source}`, text: s.source === 'learned' ? 'Learned' : s.scope === 'tv' ? 'TV · built in' : 'Built in' }),
      h('span', { class: 'skill-flows', text: s.flows.length ? s.flows.map((f) => FLOW_LABEL[f] || f).join(' · ') : 'Notes only' }),
      s.verified ? h('span', { class: 'skill-verified', text: `Verified ${s.verified}` }) : null)));
  }

  function describeStep(step) {
    if (step.launch) return step.note ? `Open ${step.note}` : 'Open the app';
    if (step.wait !== undefined) return `Wait ${(step.wait / 1000).toFixed(1)} s`;
    if (step.keys) return `Press ${step.keys.map((k) => k.replace(/^KEY_/, '').toLowerCase()).join(', ')}`;
    if (step.ifColdStart) return `If the app was closed: ${step.ifColdStart.map(describeStep).join('; ')}`;
    if (step.typeGrid) return 'Type the title on the app\u2019s own keyboard';
    if (step.typeText?.var === 'pcAddress') return 'Type this PC\u2019s address with the TV keyboard';
    if (step.typeText) return 'Type the title with the TV keyboard';
    if (step.typeDigits) return 'Type this PC\u2019s address into the number boxes, one box at a time';
    if (step.waitIme) return step.waitIme.open ? 'Check that the TV keyboard opened' : 'Check that no TV keyboard is open';
    if (step.ifIme) return `If the TV keyboard is open: ${step.ifIme.map(describeStep).join('; ')}`;
    if (step.exitGrid) return 'Move from the keyboard to the results';
    if (step.look) return 'Look at the screen';
    return JSON.stringify(step);
  }

  async function showSkill(slug) {
    const ack = await ctx.live.send('skills.get', { slug }, { timeoutMs: 8000 });
    if (!ack.ok) { toast(ack.error?.message || 'Could not read the skill', { level: 'error' }); return; }
    const skill = ack.value;
    openSheet({
      title: skill.app,
      className: 'skill-sheet',
      build(body, sheet) {
        body.append(
          h('p', { class: 'skill-sheet-summary', text: skill.summary }),
          h('div', { class: 'skill-sheet-meta' },
            h('span', { text: skill.source === 'learned' ? 'Learned by Lumen' : 'Built in' }),
            skill.updated ? h('span', { text: `Updated ${skill.updated}` }) : null,
            skill.verified ? h('span', { text: `Verified ${skill.verified}` }) : null),
          h('div', { class: 'run-answer skill-notes' }, ...renderAnswer(skill.notes)),
          ...Object.entries(skill.flows).map(([name, steps]) => h('section', { class: 'skill-flow' },
            h('h3', { text: FLOW_LABEL[name] || name }),
            h('ol', null, ...steps.map((step) => h('li', { text: describeStep(step) }))))),
          skill.source === 'learned' ? h('button', { class: 'btn ghost sm', type: 'button', onClick: async () => {
            const res = await ctx.cmd('skills.forget', { slug: skill.slug });
            if (res.ok) { toast(`Forgot what Lumen learned about ${skill.app}`, { level: 'ok' }); sheet.close(); loadSkills(); }
          } }, icon('trash', 'xs'), h('span', { text: 'Forget what was learned' })) : null);
      },
    });
  }

  function mountView(root) {
    const { form } = composer({ big: true });
    const fresh = h('button', { class: 'btn sm ghost', type: 'button', onclick: newChat }, icon('plus', 'xs'), h('span', { text: 'New chat' }));
    root.classList.add('ask-view');
    root.append(
      h('header', { class: 'view-head' },
        h('div', null, h('h1', { class: 'view-title', text: 'Ask Lumen' }), h('p', { class: 'view-sub', text: 'Claude runs the TV with the same commands as the remote' })),
        h('div', { class: 'ask-head-actions' }, statusPill, fresh)),
      skillsPanel,
      thread,
      h('div', { class: 'ask-dock' }, form));
    ctx.on('view', (name) => { if (name === 'ask') { loadSkills(); requestAnimationFrame(() => scrollToEnd()); } });
    ctx.on('hello', () => { if (ctx.viewName === 'ask') loadSkills(); });
  }

  for (const record of chat.runs) append(record);
  ctx.live.on('ai', onEvent);
  ctx.state.watch('screen.at', () => {
    for (const run of runs.values()) if (!run.record.done && !run.eye.hidden) showEye(run);
  });
  ctx.on('hello', paintStatus);
  paintStatus();

  return { submit, composer, mountView, inputs };
}
