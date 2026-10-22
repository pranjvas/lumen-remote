// Desktop keyboard shortcuts (inactive while typing or with a sheet open) and the "?" overlay.
// Holds use the same hold protocol as the on-screen keys; OS auto-repeat is ignored.

import { h, icon } from '../ui/dom.js';
import { keyPress } from '../ui/press.js';
import { openSheet, sheetOpen } from '../ui/sheet.js';
import { openTextSheet } from './text.js';

const KEY_MAP = {
  ArrowUp: 'KEY_UP', ArrowDown: 'KEY_DOWN', ArrowLeft: 'KEY_LEFT', ArrowRight: 'KEY_RIGHT',
  Enter: 'KEY_ENTER', Backspace: 'KEY_RETURN', PageUp: 'KEY_CHUP', PageDown: 'KEY_CHDOWN',
  h: 'KEY_HOME', ',': 'KEY_MENU', i: 'KEY_INFO', g: 'KEY_GUIDE', s: 'KEY_SOURCE', '[': 'KEY_REWIND', ']': 'KEY_FF',
};

const VIEW_KEYS = { r: 'remote', a: 'apps', '.': 'settings', k: 'keys', c: 'cast', b: 'browser', e: 'scenes' };

const HELP = [
  ['Navigate', [['← ↑ → ↓', 'D-pad (hold to repeat)'], ['Enter', 'OK'], ['Backspace', 'Back'], ['Shift + Backspace', 'Exit'], ['H', 'Home'], [',', 'TV Menu']]],
  ['Sound & channels', [['+ / −', 'Volume ±1 (Shift ±5)'], ['M', 'Mute'], ['Page Up / Down', 'Channel ±'], ['0 – 9', 'Digits']]],
  ['Mouse', [['U', 'Use this PC’s mouse on the TV (Esc releases)']]],
  ['Playback', [['Space', 'Play / Pause'], ['[ / ]', 'Rewind / Fast forward'], ['I / G / S', 'Info / Guide / Source'], ['Alt + 1–4', 'Red, Green, Yellow, Blue']]],
  ['Lumen', [['/ or Ctrl + K', 'Ask Lumen'], ['T', 'Type on the TV'], ['R A . K C B E', 'Remote, Apps, Settings, Keys, Cast, Browser, Scenes'], ['P (hold)', 'Power'], ['?', 'This overlay']]],
  ['Browser', [['B', 'Open the Browser view'], ['Click the page', 'Keys and text go to the page until you click elsewhere']]],
];

const shortcutsEnabled = () => localStorage.getItem('lumen.shortcuts') !== 'off';

function typing(target) {
  const el = target instanceof Element ? target : null;
  return !!el?.closest('input, textarea, select, [contenteditable="true"]');
}

export function mountShortcuts(ctx, { focusAsk }) {
  const held = new Map();
  let powerTimer = null;

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      focusAsk();
      return;
    }
    if (e.defaultPrevented || typing(e.target) || sheetOpen()) return;
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === '?') { e.preventDefault(); openHelp(); return; }
    if (!shortcutsEnabled()) return;
    if (e.key === '/') { e.preventDefault(); focusAsk(); return; }

    // Enter / Space on a focused control is that control's own activation.
    const onControl = e.target instanceof Element && e.target.closest('button, a');
    if (onControl && (e.key === 'Enter' || e.key === ' ')) return;

    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (e.altKey && /^[1-4]$/.test(e.key)) {
      e.preventDefault();
      ctx.key(['KEY_RED', 'KEY_GREEN', 'KEY_YELLOW', ctx.hasKey('KEY_BLUE') ? 'KEY_BLUE' : 'KEY_CYAN'][Number(e.key) - 1]);
      return;
    }
    if (e.altKey) return;

    if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '+') {
      e.preventDefault();
      if (!e.repeat) ctx.volume.step(e.shiftKey ? 5 : 1);
      return;
    }
    if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
      e.preventDefault();
      if (!e.repeat) ctx.volume.step(e.shiftKey ? -5 : -1);
      return;
    }
    if (k === 'm') { e.preventDefault(); if (!e.repeat) ctx.volume.toggleMute(); return; }
    if (k === 'u') { e.preventDefault(); if (!e.repeat) { ctx.emit('navigate', 'mouse'); ctx.emit('mouse-lock'); } return; }
    if (k === 't') { e.preventDefault(); openTextSheet(ctx); return; }
    if (k === 'p') {
      e.preventDefault();
      if (e.repeat || powerTimer) return;
      powerTimer = setTimeout(() => {
        powerTimer = null;
        if (ctx.power.current() === 'on') ctx.power.off();
        else ctx.power.wake();
      }, 500);
      return;
    }
    if (VIEW_KEYS[k] && !e.shiftKey) { e.preventDefault(); ctx.navigate(VIEW_KEYS[k]); return; }
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); if (!e.repeat) ctx.key(`KEY_${e.key}`); return; }
    if (e.key === ' ') { e.preventDefault(); if (!e.repeat) ctx.key(ctx.hasKey('KEY_PLAY_BACK') ? 'KEY_PLAY_BACK' : 'KEY_PLAY'); return; }
    if (e.key === 'Backspace' && e.shiftKey) { e.preventDefault(); if (!e.repeat) ctx.key('KEY_EXIT'); return; }

    const code = KEY_MAP[k];
    if (!code) return;
    e.preventDefault();
    if (e.repeat || held.has(e.key)) return;
    const press = keyPress(ctx, code);
    held.set(e.key, press);
    press.down();
  });

  document.addEventListener('keyup', (e) => {
    if (e.key.toLowerCase() === 'p' && powerTimer) { clearTimeout(powerTimer); powerTimer = null; }
    const press = held.get(e.key) || held.get(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    if (!press) return;
    held.delete(e.key);
    press.up();
  });

  const releaseAll = () => {
    for (const press of held.values()) press.cancel();
    held.clear();
    clearTimeout(powerTimer);
    powerTimer = null;
  };
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
}

export function openHelp() {
  openSheet({
    title: 'Keyboard shortcuts',
    className: 'help-sheet',
    build(body) {
      const sw = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': shortcutsEnabled() ? 'true' : 'false', 'aria-label': 'Single-key shortcuts' });
      sw.addEventListener('click', () => {
        localStorage.setItem('lumen.shortcuts', shortcutsEnabled() ? 'off' : 'on');
        sw.setAttribute('aria-checked', shortcutsEnabled() ? 'true' : 'false');
      });
      body.append(
        h('div', { class: 'help-grid' }, HELP.map(([title, rows]) => h('section', null,
          h('h3', { class: 'silk', text: title }),
          h('dl', null, rows.flatMap(([keys, what]) => [h('dt', null, keys.split(' / ').map((k, i) => [i ? h('span', { class: 'muted', text: ' / ' }) : null, h('kbd', { class: 'kbd', text: k })])), h('dd', { text: what })]))))),
        h('div', { class: 'more-row' }, h('span', null, icon('keyboard', 'sm'), ' Single-key shortcuts'), sw));
    },
  });
}
