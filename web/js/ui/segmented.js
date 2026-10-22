// Segmented control for enum values (role=radiogroup with roving arrow keys).

import { h } from './dom.js';

export function createSegmented({ options, value, label, format = (o) => o, onSelect }) {
  const el = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  let current = value;
  let pending = null;

  const buttons = options.map((opt) =>
    h('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': 'false',
      tabindex: '-1',
      dataset: { value: String(opt) },
      onClick: () => select(opt),
      text: format(opt),
    }));
  el.append(...buttons);

  el.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    const i = options.findIndex((o) => String(o) === String(pending ?? current));
    const next = options[(i + dir + options.length) % options.length];
    select(next);
    buttons[options.indexOf(next)]?.focus();
  });

  function select(opt) {
    if (String(opt) === String(pending ?? current)) return;
    onSelect?.(opt);
  }

  function paint() {
    const shown = pending ?? current;
    let focusable = false;
    for (const b of buttons) {
      const on = b.dataset.value === String(shown);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.classList.toggle('is-pending', pending !== null && on);
      b.tabIndex = on ? 0 : -1;
      if (on) focusable = true;
    }
    if (!focusable && buttons[0]) buttons[0].tabIndex = 0;
  }

  paint();
  return {
    el,
    set(v) { current = v; paint(); },
    setPending(v) { pending = v ?? null; paint(); },
    setDisabled(on) { el.setAttribute('aria-disabled', on ? 'true' : 'false'); },
  };
}
