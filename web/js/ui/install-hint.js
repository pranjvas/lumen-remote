// "Add to Home Screen" for the Browser view's own app (/browser). iOS has no install prompt a page
// can trigger, so in iPhone/iPad Safari (not already opened from the Home Screen) the first visit
// to the Browser view shows the steps once. Elsewhere it never shows.

import { h, icon } from './dom.js';
import { openSheet } from './sheet.js';

const KEY = 'lumen.installHint.browser';

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS reports a Mac
const standalone = () => navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;

function seen() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return true; }
}

function remember() {
  try { localStorage.setItem(KEY, '1'); } catch { /* private mode: it shows again next time */ }
}

export function showInstallSteps() {
  openSheet({
    title: 'Lumen Browser on your Home Screen',
    className: 'install-sheet',
    build(body, sheet) {
      const onBrowserPage = location.pathname === '/browser';
      const open = h('a', { class: 'btn primary', href: '/browser' }, icon('globe'), 'Open the Browser app page');
      const done = h('button', { class: 'btn ghost', type: 'button', text: 'Got it' });
      done.addEventListener('click', () => sheet.close());
      body.append(
        h('p', { text: 'One tap from your Home Screen opens Lumen\'s browser full screen, like an app.' }),
        h('ol', { class: 'install-steps' },
          onBrowserPage ? null : h('li', {}, 'Open the Browser app page (button below).'),
          h('li', {}, 'Tap ', h('b', { text: 'Share' }), ' in Safari\'s toolbar.'),
          h('li', {}, 'Choose ', h('b', { text: 'Add to Home Screen' }), ', then ', h('b', { text: 'Add' }), '.')),
        h('div', { class: 'sheet-actions' }, onBrowserPage ? null : open, done),
      );
    },
    onClose: remember,
  });
}

export function mountInstallHint(ctx) {
  ctx.on('view', (name) => {
    if (name !== 'browser' || !isIos() || standalone() || seen()) return;
    setTimeout(showInstallSteps, 1200); // after the view has settled
  });
}
