// "Add to Home Screen" for Lumen (/) and for its Browser view as an app of its own (/browser). iOS has
// no install prompt a page can call, so iPhone/iPad Safari (not already opened from the Home Screen)
// shows the steps once on the first visit; Settings → This phone shows them any time.

import { h, icon } from './dom.js';
import { openSheet } from './sheet.js';

const KEY = 'lumen.installHint';
const APPS = {
  app: { name: 'Lumen', path: '/', blurb: 'One tap from your Home Screen opens the whole Lumen remote full screen, like an app.' },
  browser: { name: 'Lumen Browser', path: '/browser', blurb: 'One tap from your Home Screen opens straight into Lumen\'s browser, full screen, like an app.' },
};

export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS reports a Mac
// The iPad app (ipad/) shows this page in its own web view and adds "LumenApp" to the user agent:
// there is nothing to put on the Home Screen from in there.
export const inApp = () => /\bLumenApp\b/.test(navigator.userAgent);
export const standalone = () => inApp() || navigator.standalone === true || !!window.matchMedia?.('(display-mode: standalone)').matches;
const currentApp = () => (location.pathname === '/browser' ? 'browser' : 'app');

function seen() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return true; }
}

function remember() {
  try { localStorage.setItem(KEY, '1'); } catch { /* private mode: it shows again next time */ }
}

export function showInstallSteps(kind = currentApp()) {
  const app = APPS[kind] ?? APPS.app;
  const here = location.pathname === app.path || (app.path === '/' && location.pathname === '/index.html');
  openSheet({
    title: `${app.name} on your Home Screen`,
    className: 'install-sheet',
    build(body, sheet) {
      const open = h('a', { class: 'btn primary', href: app.path }, icon(kind === 'browser' ? 'globe' : 'remote'), `Open ${app.name}`);
      const done = h('button', { class: 'btn ghost', type: 'button', text: 'Got it' });
      done.addEventListener('click', () => sheet.close());
      const steps = isIos()
        ? [here ? null : h('li', {}, `Open ${app.name} (the button below), in Safari.`),
          h('li', {}, 'Tap ', h('b', { text: 'Share' }), ' in Safari\'s toolbar.'),
          h('li', {}, 'Choose ', h('b', { text: 'Add to Home Screen' }), ', then ', h('b', { text: 'Add' }), '.')]
        : [here ? null : h('li', {}, `Open ${app.name} (the button below).`),
          h('li', {}, 'Open the browser\'s menu (', h('b', { text: '⋮' }), ' in Chrome).'),
          h('li', {}, 'Choose ', h('b', { text: 'Add to Home screen' }), ' or ', h('b', { text: 'Install app' }), '.')];
      body.append(
        h('p', { text: app.blurb }),
        h('ol', { class: 'install-steps' }, ...steps),
        h('div', { class: 'sheet-actions' }, here ? null : open, done),
      );
    },
    onClose: remember,
  });
}

export function mountInstallHint(ctx) {
  const off = ctx.on('view', () => {
    off?.();
    if (!isIos() || standalone() || seen()) return;
    setTimeout(() => showInstallSteps(), 1500); // once the first view has settled
  });
}
