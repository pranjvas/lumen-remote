// Modal sheet (bottom sheet on phones, dialog on wider screens) with focus trap and Esc.

import { h, icon } from './dom.js';

const open = [];

export function openSheet({ title, label, build, onClose, className = '' }) {
  const previous = document.activeElement;
  const scrim = h('div', { class: 'scrim' });
  const titleId = `sheet-${Math.random().toString(36).slice(2, 8)}`;
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Close', type: 'button' }, icon('close'));
  const body = h('div', { class: 'sheet-body' });
  const sheet = h('section', {
    class: `sheet ${className}`.trim(),
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': title ? titleId : null,
    'aria-label': title ? null : label,
    tabindex: '-1',
  },
  title ? h('header', { class: 'sheet-head' }, h('h2', { class: 'sheet-title', id: titleId, text: title }), closeBtn) : null,
  body);

  let closed = false;
  const api = {
    el: sheet,
    body,
    close() {
      if (closed) return;
      closed = true;
      const i = open.indexOf(api);
      if (i >= 0) open.splice(i, 1);
      sheet.classList.add('is-closing');
      scrim.classList.add('is-closing');
      setTimeout(() => { sheet.remove(); scrim.remove(); }, 200);
      document.removeEventListener('keydown', onKey, true);
      onClose?.();
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    },
  };

  function onKey(e) {
    if (open[open.length - 1] !== api) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      api.close();
    } else if (e.key === 'Tab') {
      const items = [...sheet.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  closeBtn.addEventListener('click', () => api.close());
  scrim.addEventListener('click', () => api.close());
  document.addEventListener('keydown', onKey, true);
  build?.(body, api);
  document.body.append(scrim, sheet);
  open.push(api);
  requestAnimationFrame(() => {
    const target = sheet.querySelector('[autofocus]') || sheet;
    target.focus({ preventScroll: true });
  });
  return api;
}

export const sheetOpen = () => open.length > 0;
