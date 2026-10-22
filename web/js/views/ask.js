// Ask Lumen: the ask bar (every view) and the Ask view, which renders the streamed
// { t:'ai', id, kind: status|tool|text|result|error|done } events as a transcript.

import { h, icon, fill } from '../ui/dom.js';
import { makeId } from '../core/live.js';
import { toast } from '../ui/toast.js';
import { backendName } from './settings.js';

const EXAMPLES = ['Increase brightness', 'Play Friends on Netflix', 'Cinema mode', 'Sleep in 30 minutes', 'Switch to HDMI 1', 'What is the TV showing?'];
// Speech recognition needs a secure context: available on localhost, not over plain http on the LAN.
const Recognition = globalThis.isSecureContext ? (globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition) : null;

const toolTitle = (name) => String(name || 'tool')
  .replace(/^mcp__lumen__/, '')
  .split('_')
  .map((w, i) => (/^(tv|url|ip)$/i.test(w) ? w.toUpperCase() : i ? w : w.charAt(0).toUpperCase() + w.slice(1)))
  .join(' ');

export function createAsk(ctx) {
  const runs = new Map();
  const transcript = h('div', { class: 'transcript', role: 'log', 'aria-live': 'polite', 'aria-label': 'Ask Lumen conversation' });
  const empty = h('div', { class: 'ask-empty' });
  const statusPill = h('span', { class: 'ai-pill' });
  const inputs = new Set();

  function paintStatus() {
    const ai = ctx.ai;
    statusPill.className = `ai-pill ${ai?.ready ? 'ready' : 'setup'}`;
    fill(statusPill, h('i'), ai ? (ai.ready ? `${backendName(ai.backend)} · ready` : 'Setup needed') : 'Checking…');
    statusPill.title = ai?.reason || '';
    fill(empty, 
      h('div', { class: 'ask-orb', 'aria-hidden': 'true' }, icon('spark', 'lg')),
      h('p', { class: 'ask-lead', text: 'Say what you want the TV to do.' }),
      ai && !ai.ready ? h('p', { class: 'ask-setup' }, icon('alert', 'sm'), h('span', { text: ai.reason || 'Ask Lumen is not set up yet' })) : null,
      h('div', { class: 'chips ask-examples' }, EXAMPLES.map((text) => h('button', { class: 'chip', type: 'button', text, onClick: () => submit(text) }))));
    for (const input of inputs) input.placeholder = ai && !ai.ready ? 'Ask Lumen — setup needed' : 'Ask Lumen… “play Friends on Netflix”';
  }

  function makeRun(id, text) {
    const status = h('div', { class: 'run-status' }, h('span', { class: 'spinner' }), h('span', { text: 'Sending…' }));
    const tools = h('div', { class: 'run-tools' });
    const notes = h('div', { class: 'run-notes' });
    const answer = h('div', { class: 'run-answer' });
    const cancel = h('button', { class: 'btn sm ghost', type: 'button', text: 'Cancel' });
    const el = h('article', { class: 'run is-running' },
      h('div', { class: 'run-ask' }, h('span', { class: 'run-quote', text: text })),
      h('div', { class: 'run-body' }, status, tools, notes, answer, h('div', { class: 'run-foot' }, cancel)));
    cancel.addEventListener('click', () => ctx.cmd('ai.cancel', { target: id }, { el: cancel }));
    const run = { id, el, status, tools, notes, answer, cancel, done: false };
    runs.set(id, run);
    empty.remove();
    transcript.append(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return run;
  }

  function setStatus(run, text, busy = true) {
    fill(run.status, busy ? h('span', { class: 'spinner' }) : icon('check', 'xs'), h('span', { text }));
  }

  function finish(run, ok, ms) {
    if (run.done) return;
    run.done = true;
    run.el.classList.remove('is-running');
    run.el.classList.toggle('is-failed', ok === false);
    run.cancel.remove();
    setStatus(run, ok === false ? 'Stopped' : Number.isFinite(ms) ? `Done in ${(ms / 1000).toFixed(1)} s` : 'Done', false);
  }

  function onEvent(msg) {
    const run = runs.get(msg.id);
    if (!run) return;
    switch (msg.kind) {
      case 'status':
        setStatus(run, msg.text || 'Working…');
        break;
      case 'tool':
        run.tools.append(h('div', { class: `tool-chip${msg.ok === false ? ' is-failed' : ''}` },
          h('span', { class: 'tool-icon' }, icon(msg.ok === false ? 'alert' : 'check', 'xs')),
          h('span', { class: 'tool-name', text: toolTitle(msg.name) }),
          msg.input ? h('span', { class: 'tool-input mono', text: msg.input }) : null,
          msg.result ? h('span', { class: 'tool-result', text: msg.result }) : null));
        break;
      case 'text':
        if (msg.text) run.notes.append(h('p', { text: msg.text }));
        break;
      case 'result':
        run.answer.textContent = msg.text || 'Done.';
        break;
      case 'error':
        fill(run.answer, h('p', { class: 'run-error' }, icon('alert', 'sm'), h('span', { text: msg.message || 'Something went wrong' })));
        break;
      case 'done':
        finish(run, msg.ok, msg.ms);
        break;
      default:
        break;
    }
    if (ctx.viewName === 'ask') run.el.scrollIntoView({ block: 'end' });
  }

  async function submit(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    ctx.navigate('ask');
    const id = makeId();
    const run = makeRun(id, clean);
    const ack = await ctx.live.send('ai.ask', { text: clean }, { id, timeoutMs: 15000 });
    if (!ack.ok) {
      fill(run.answer, h('p', { class: 'run-error' }, icon('alert', 'sm'), h('span', { text: ack.error?.message || 'Ask Lumen is not available' })));
      finish(run, false);
    }
  }

  function bindComposer(form, input, mic) {
    inputs.add(input);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value;
      input.value = '';
      input.blur();
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
        if (result.isFinal) { const text = input.value; input.value = ''; submit(text); }
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

  function mountView(root) {
    const { form } = composer({ big: true });
    root.append(
      h('header', { class: 'view-head' },
        h('div', null, h('h1', { class: 'view-title', text: 'Ask Lumen' }), h('p', { class: 'view-sub', text: 'Claude does it with the same safe commands as the remote' })),
        statusPill),
      form,
      h('div', { class: 'ask-thread' }, empty, transcript));
  }

  ctx.live.on('ai', onEvent);
  ctx.on('hello', paintStatus);
  paintStatus();

  return { submit, composer, mountView, inputs };
}
