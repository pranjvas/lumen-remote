// Text entry for the TV keyboard. SendInputString replaces the whole field, so live typing
// resends the full string (debounced). Opens automatically when the TV reports ime.open.

import { h, icon, fill } from '../ui/dom.js';
import { openSheet } from '../ui/sheet.js';

const DEBOUNCE_MS = 260;

export function buildTextPanel(ctx, { onDone, autofocus = false } = {}) {
  let hidden = false;
  let timer = null;
  let lastSent = null;

  const mirrorText = h('span', { class: 'tv-field-text' });
  const mirror = h('div', { class: 'tv-field', 'aria-label': 'What the TV field shows' },
    h('span', { class: 'silk', text: 'TV field' }), h('span', { class: 'tv-field-line' }, mirrorText, h('i', { class: 'caret' })));
  const input = h('input', {
    class: 'field text-input',
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'done',
    placeholder: 'Type to send to the TV',
    'aria-label': 'Text to send to the TV',
  });
  if (autofocus) input.setAttribute('autofocus', '');
  const eye = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Hide text', 'aria-pressed': 'false' }, icon('eye'));
  const send = h('button', { class: 'btn primary', type: 'button' }, icon('enter'), 'Send');

  const flush = (submit) => {
    clearTimeout(timer);
    const text = input.value;
    if (!submit && text === lastSent) return;
    lastSent = text;
    ctx.cmd('text.send', { text, submit: !!submit }, { el: input });
  };

  input.addEventListener('input', () => {
    mirrorText.textContent = hidden ? '•'.repeat(input.value.length) : input.value;
    clearTimeout(timer);
    timer = setTimeout(() => flush(false), DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      flush(true);
      onDone?.();
    }
  });
  send.addEventListener('click', () => { flush(true); onDone?.(); });
  eye.addEventListener('click', () => {
    hidden = !hidden;
    input.type = hidden ? 'password' : 'text';
    eye.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    fill(eye, icon(hidden ? 'eye-off' : 'eye'));
    mirrorText.textContent = hidden ? '•'.repeat(input.value.length) : input.value;
  });

  const unwatch = ctx.state.watch('ime', () => {
    const ime = ctx.state.value('ime', null);
    if (!ime) return;
    if (ime.type === 'password' && !hidden) eye.click();
    if (Number.isFinite(ime.limit) && ime.limit > 0) input.maxLength = ime.limit;
    else input.removeAttribute('maxlength');
    if (typeof ime.text === 'string' && document.activeElement !== input) {
      input.value = ime.text;
      lastSent = ime.text;
    }
    mirrorText.textContent = hidden ? '•'.repeat((ime.text ?? input.value).length) : ime.text ?? input.value;
  });

  const el = h('div', { class: 'text-panel' },
    mirror,
    h('div', { class: 'text-row' }, input, eye),
    h('div', { class: 'text-actions' },
      h('span', { class: 'muted', style: { fontSize: '12.5px' }, text: 'Typing replaces the TV field live · Enter sends' }),
      send));
  return { el, input, dispose: unwatch };
}

let sheet = null;

export function openTextSheet(ctx, { auto = false } = {}) {
  if (sheet) {
    sheet.body.querySelector('input')?.focus();
    return sheet;
  }
  let panel = null;
  sheet = openSheet({
    title: auto ? 'The TV is asking for text' : 'Type on the TV',
    className: 'text-sheet',
    onClose: () => { panel?.dispose(); sheet = null; },
    build(body, api) {
      panel = buildTextPanel(ctx, { autofocus: true, onDone: () => api.close() });
      body.append(panel.el);
    },
  });
  sheet.auto = auto;
  return sheet;
}

export function watchIme(ctx) {
  let wasOpen = false;
  ctx.state.watch('ime', () => {
    const open = !!ctx.state.value('ime', null)?.open;
    if (open && !wasOpen) {
      if (ctx.viewName === 'touch') ctx.emit('ime-open');
      else openTextSheet(ctx, { auto: true });
    }
    if (!open && wasOpen && sheet?.auto) sheet.close();
    wasOpen = open;
  }, { immediate: false });
}
