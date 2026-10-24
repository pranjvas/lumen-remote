// Browser: headless Edge on the Lumen PC renders the page and streams it here as frames; pointer,
// wheel and typing go back as browser.input in frame pixels. One shared session for every client;
// Show on TV puts the page on the TV. The Mouse toggle opens a trackpad that moves one pointer over
// the page (browser.pointer), the same pointer the TV shows and the TV remote moves.

import { h, icon, fill } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { openSheet } from '../ui/sheet.js';
import { haptic } from '../ui/haptics.js';
import { accelerate, bindTrackpad, readGain } from '../ui/trackpad.js';
import { fitFrame, sizeDiffers, viewportFor } from './browser-fit.js';

const RATE_MS = 33;          // moves and wheel deltas coalesce to ~30 messages/s
const VIEWPORT_MS = 250;     // resize settle before browser.viewport
const TAP_SLOP = 10;
const LONG_PRESS_MS = 650;   // a still finger held this long is a right-click; any shorter still press is a click
const FINGER_PX = 12;        // finger contact radius (CSS px) for the server's touch adjustment
const WHEEL_LINE_PX = 40;
const PAD_KEY = 'lumen.browser.pad';
const POINTER_EDGE = 0.002;  // the server keeps the pointer this far (fraction of the page) inside
const PAD_SCROLL = 1.5;      // two-finger scroll: page pixels per stage pixel the fingers travel
const SEARCH = 'https://duckduckgo.com/?q=';
const SUGGESTIONS = [['DuckDuckGo', 'https://duckduckgo.com/'], ['Wikipedia', 'https://en.wikipedia.org/'], ['YouTube', 'https://www.youtube.com/'], ['Hacker News', 'https://news.ycombinator.com/']];
const BUTTONS = ['left', 'middle', 'right'];
const SPECIAL_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const SESSION = { off: ['off', 'Browser off'], starting: ['warn', 'Starting…'], ready: ['good', 'Live'], error: ['bad', 'Error'] };
// Clear history: what each choice removes (server/features/browser.js PROFILE_* and features/history.js).
const CLEAR_CHOICES = [
  ['history', 'Browsing history', 'Pages opened, back and forward, recent sites and suggestions, open tabs, and the page addresses in Lumen’s logs', true],
  ['cache', 'Cached images and files', 'Copies of pages and pictures kept so they load faster', true],
  ['cookies', 'Cookies and site data', 'Signs you out of most sites and removes what sites stored', false],
];

// Address-bar text → URL: schemes pass through (the server refuses anything but http/https),
// host-like text gets https://, anything else becomes a DuckDuckGo search.
export function toUrl(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:(?!\d+(\/|$))/i.test(t)) return t; // a scheme, not host:port
  if (!/\s/.test(t) && (/\.[a-z0-9]/i.test(t) || /^localhost(:\d+)?(\/|$)/i.test(t))) return `https://${t}`;
  return `${SEARCH}${encodeURIComponent(t)}`;
}

// CDP modifier bits, which is what the server hands to Input.dispatch*Event.
const modifiers = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

// Sends the newest payload at most once per RATE_MS; `merge` folds a burst into one message.
function coalescer(send, merge) {
  let pending = null;
  let at = 0;
  let timer = 0;
  const flush = () => {
    clearTimeout(timer);
    timer = 0;
    if (!pending) return;
    at = performance.now();
    send(pending);
    pending = null;
  };
  return {
    flush,
    get pending() { return !!pending; },
    push(ev) {
      pending = pending && merge ? merge(pending, ev) : ev;
      const wait = RATE_MS - (performance.now() - at);
      if (wait <= 0) flush();
      else if (!timer) timer = setTimeout(flush, wait);
    },
  };
}

export function mountBrowser(root, ctx) {
  root.classList.add('browser-view');
  const showing = () => ctx.viewName === 'browser' && !document.hidden;
  const url = () => ctx.state.value('browser.url', null);
  const session = () => ctx.state.value('browser.session', 'off');
  const input = (ev) => ctx.live.post('browser.input', ev);

  /* ---------- page area ---------- */

  const canvas = h('canvas', {
    class: 'browser-canvas', width: 1280, height: 800, tabindex: '0', role: 'application',
    'aria-roledescription': 'web page', 'aria-label': 'The page, streamed from the browser on this PC. Click or tap to interact, then type.',
  });
  const paint = canvas.getContext('2d', { alpha: false });
  const typer = h('input', {
    class: 'browser-typer', type: 'text', tabindex: '-1', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
    enterkeyhint: 'enter', 'aria-label': 'Type into the page',
  });
  const overlay = h('div', { class: 'browser-overlay' });
  const pointerEl = h('div', { class: 'browser-pointer', hidden: true, 'aria-hidden': 'true' }, icon('cursor'));
  const stage = h('div', { class: 'browser-stage' }, canvas, typer, pointerEl, overlay);
  const pad = h('div', {
    class: 'touchpad browser-pad', role: 'application', 'aria-roledescription': 'trackpad', hidden: true,
    'aria-label': 'Trackpad. Drag to move the pointer over the page, tap to click, long press to right-click, two-finger drag to scroll.',
  }, h('p', { class: 'touch-hint', text: 'Drag to move · Tap to click · Two fingers scroll' }));

  let frame = { w: 0, h: 0 };
  let hasFrame = false;
  let painted = 0;
  let fps = 0;
  let lastUrl = null;
  let keyboardOn = false;
  let padOn = localStorage.getItem(PAD_KEY) === '1';
  let ptr = { x: 0.5, y: 0.45 }; // the shared pointer, as fractions of the page

  /* ---------- address bar, nav, actions ---------- */

  // inputmode search, not url: the iPhone's URL keyboard has no space bar, and text with spaces is a
  // search (toUrl). type stays text (type=search brings WebKit's own search-field styling).
  const address = h('input', {
    class: 'browser-address', type: 'text', inputmode: 'search', enterkeyhint: 'go', placeholder: 'Search or enter an address',
    'aria-label': 'Address or search', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
  });
  const addressIcon = h('span', { class: 'browser-address-icon' }, icon('globe', 'sm'));
  const go = h('button', { class: 'icon-btn browser-go', type: 'submit', 'aria-label': 'Go', title: 'Go' }, icon('enter', 'sm'));
  const form = h('form', { class: 'browser-address-box', role: 'search' }, addressIcon, address, go);

  const navSets = [];
  function navButtons(kind) {
    const make = (label, iconName, action) => {
      const b = kind === 'tool'
        ? h('button', { class: 'btn ghost', type: 'button', 'aria-label': label }, icon(iconName), h('span', { text: label }))
        : h('button', { class: 'icon-btn browser-nav', type: 'button', 'aria-label': label, title: label }, icon(iconName));
      b.addEventListener('click', () => { haptic('key'); nav(action(), b); });
      return b;
    };
    const set = {
      kind,
      back: make('Back', 'left', () => 'back'),
      forward: make('Forward', 'right', () => 'forward'),
      reload: make('Reload', 'refresh', () => (ctx.state.value('browser.loading', false) ? 'stop' : 'reload')),
    };
    navSets.push(set);
    return set;
  }
  const desktopNav = navButtons('icon');
  const phoneNav = navButtons('tool');

  const tvButton = (cls) => {
    const b = cls === 'tool'
      ? h('button', { class: 'btn ghost browser-tv', type: 'button', 'aria-label': 'Show on TV' }, icon('tv'), h('span', { text: 'On TV' }))
      : h('button', { class: 'btn primary browser-tv', type: 'button', title: 'Show this page on the TV in Lumen’s browser (the remote drives it)' }, icon('tv'), 'Show on TV');
    b.addEventListener('click', () => openOnTv(b));
    tvButtons.push(b);
    return b;
  };
  const tvButtons = [];
  // While the TV shows Lumen's browser: hand the page's video to the TV's player, or close it.
  const tvExtras = [];
  // A TV command from a button: busy while it runs, `done` toasted when it is accepted.
  async function tvCommand(b, cmd, { args = {}, timeoutMs = 20000, done = null } = {}) {
    if (b.classList.contains('is-busy')) return;
    b.classList.add('is-busy');
    const ack = await ctx.cmd(cmd, args, { el: b, timeoutMs });
    b.classList.remove('is-busy');
    if (ack.ok && done) toast(done, { level: 'ok' });
  }
  const tvExtra = (cls, label, iconName, cmd, done, short = label, { args = {}, timeoutMs = 20000 } = {}) => {
    const b = h('button', { class: `btn ghost ${cls}`.trim(), type: 'button', hidden: true, 'aria-label': label, title: label }, icon(iconName), h('span', { text: short }));
    b.addEventListener('click', () => tvCommand(b, cmd, { args, timeoutMs, done }));
    tvExtras.push(b);
    return b;
  };
  const closeButton = (cls) => {
    const b = h('button', { class: `btn ghost browser-close ${cls}`.trim(), type: 'button', title: 'Close the browser on the PC' }, icon('close'), 'Close');
    b.addEventListener('click', () => ctx.cmd('browser.close', {}, { el: b }));
    return b;
  };
  const closeButtons = [closeButton(''), closeButton('sm')];
  const clearButton = h('button', {
    class: 'btn ghost sm browser-clear', type: 'button', 'aria-label': 'Clear history', title: 'Clear the browser’s history, cache or cookies',
  }, icon('trash', 'sm'), h('span', { text: 'Clear history' }));
  clearButton.addEventListener('click', () => { haptic('key'); openClear(); });
  const keyboardBtn = h('button', { class: 'btn ghost', type: 'button', 'aria-label': 'Keyboard', 'aria-pressed': 'false' }, icon('keyboard'), h('span', { text: 'Keyboard' }));
  // Chromium (Android, desktop) focuses a pressed button, which blurred the text field (keyboard off)
  // before the click toggled it straight back on. The press must leave focus where it is.
  keyboardBtn.addEventListener('pointerdown', (e) => e.preventDefault());
  keyboardBtn.addEventListener('mousedown', (e) => e.preventDefault());
  keyboardBtn.addEventListener('click', () => setKeyboard(!keyboardOn));
  const padButtons = [
    h('button', { class: 'icon-btn browser-nav', type: 'button', 'aria-label': 'Mouse', title: 'Trackpad: move a pointer over the page (and the TV)', 'aria-pressed': 'false' }, icon('mouse')),
    h('button', { class: 'btn ghost', type: 'button', 'aria-label': 'Mouse', 'aria-pressed': 'false' }, icon('mouse'), h('span', { text: 'Mouse' })),
  ];
  for (const b of padButtons) b.addEventListener('click', () => { haptic('key'); setPad(!padOn); });

  /* ---------- VPN (follow-up 3): the switch, its status, and "Use a config file" ---------- */

  const VPN = {
    unconfigured: ['off', 'VPN: no config'], off: ['off', 'VPN off'], connecting: ['warn', 'VPN connecting…'],
    up: ['good', 'VPN on'], down: ['bad', 'VPN down'], error: ['bad', 'VPN error'],
  };
  const vpnButton = (cls) => {
    const b = h('button', {
      class: `btn ghost browser-vpn ${cls}`.trim(), type: 'button', 'aria-pressed': 'false',
      title: 'Route this browser through your WireGuard VPN',
    }, icon('lock'), h('span', { text: 'VPN' }));
    b.addEventListener('click', async () => {
      haptic('key');
      const on = !ctx.state.value('vpn.enabled', false);
      const ack = await ctx.cmd('vpn.set', { on }, { el: b, timeoutMs: 30000 });
      if (ack.ok) toast(on ? 'VPN on · the browser restarts through the tunnel' : 'VPN off', { level: 'info' });
    });
    return b;
  };
  // One switch, beside the address (phones too: a second one in the toolbar crowded it off one row).
  const vpnButtons = [vpnButton('')];
  const vpnDot = h('span', { class: 'status-dot off', 'aria-hidden': 'true' });
  const vpnText = h('span', { class: 'browser-vpn-text' });
  const vpnFile = h('input', { type: 'file', accept: '.conf,text/plain', hidden: true });
  const vpnUse = h('button', { class: 'btn ghost sm', type: 'button', title: 'Choose a WireGuard .conf file' }, icon('upload', 'sm'), 'Use a config file…');
  const vpnUndo = h('button', { class: 'btn ghost sm', type: 'button', title: 'Go back to the previous VPN config', hidden: true }, 'Undo');
  vpnUse.addEventListener('click', () => vpnFile.click());
  vpnFile.addEventListener('change', async () => {
    const file = vpnFile.files?.[0];
    vpnFile.value = '';
    if (!file) return;
    if (file.size > 8192) { toast('That is not a WireGuard config (too large)', { level: 'error' }); return; }
    if (!ctx.csrf) { toast('Not connected to Lumen yet', { level: 'warn' }); return; }
    vpnUse.classList.add('is-busy');
    try {
      const res = await fetch('/api/vpn/config', {
        method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Lumen-CSRF': ctx.csrf }, body: await file.text(),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        const c = body.value?.config;
        toast(`VPN config saved${c?.endpoint ? ` · ${c.endpoint}` : ''}`, { level: 'ok' });
      } else {
        toast(body.error?.message || `The config was not accepted (HTTP ${res.status})`, { level: 'error' });
      }
    } catch {
      toast('Could not reach Lumen to save the config', { level: 'error' });
    } finally {
      vpnUse.classList.remove('is-busy');
    }
  });
  vpnUndo.addEventListener('click', async () => {
    const ack = await ctx.cmd('vpn.restoreBackup', {}, { el: vpnUndo, timeoutMs: 30000 });
    if (ack.ok) toast('Previous VPN config restored', { level: 'ok' });
  });
  const vpnRow = h('div', { class: 'browser-vpn-row' }, vpnDot, vpnText, vpnUse, vpnUndo, vpnFile);

  const bytes = (n) => (n == null ? '' : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  function paintVpn() {
    const enabled = !!ctx.state.value('vpn.enabled', false);
    const state = ctx.state.value('vpn.state', 'unconfigured');
    const [tone, label] = VPN[state] || VPN.off;
    for (const b of vpnButtons) {
      b.setAttribute('aria-pressed', String(enabled));
      b.disabled = state === 'unconfigured' && !enabled;
      b.dataset.tone = tone;
      b.title = state === 'unconfigured' ? 'Choose a WireGuard config first (Use a config file…)' : 'Route this browser through your WireGuard VPN';
    }
    vpnDot.className = `status-dot ${enabled ? tone : 'off'}`;
    const endpoint = ctx.state.value('vpn.endpoint', null);
    const parts = [enabled ? label : state === 'unconfigured' ? 'VPN: no config yet' : 'VPN off'];
    if (endpoint) parts.push(endpoint);
    if (enabled && state === 'up') {
      const age = ctx.state.value('vpn.handshakeAgeS', null);
      if (age != null) parts.push(`handshake ${age} s ago`);
      parts.push(`↓ ${bytes(ctx.state.value('vpn.bytesIn', 0))} ↑ ${bytes(ctx.state.value('vpn.bytesOut', 0))}`);
    }
    const err = ctx.state.value('vpn.error', null);
    if (enabled && state !== 'up' && err) parts.push(err);
    vpnText.textContent = parts.join(' · ');
    vpnUndo.hidden = !ctx.state.value('vpn.hasBackup', false);
  }
  ctx.state.watch(['vpn.*'], paintVpn);

  const dot = h('span', { class: 'status-dot off', 'aria-hidden': 'true' });
  const statusText = h('span', { class: 'browser-status-text', 'aria-live': 'polite' });
  const meta = h('span', { class: 'browser-meta muted' });
  // One status chip: what the TV is really doing while it shows the page (the agent closed, a
  // conversion, a failed or black video, live video turned off) with the one thing to do about it,
  // or, with the TV off, that the page is laid out for another device.
  const chipLong = h('span', { class: 'browser-chip-long' });
  const chipShort = h('span', { class: 'browser-chip-short' });
  const chipText = h('span', { class: 'browser-chip-text' }, chipLong, chipShort);
  const chipAction = h('button', { class: 'browser-chip-action', type: 'button', hidden: true });
  const chip = h('span', { class: 'browser-chip', role: 'status', hidden: true }, h('span', { class: 'browser-chip-dot', 'aria-hidden': 'true' }), chipText, chipAction);
  let chipRun = null;
  chipAction.addEventListener('click', () => { haptic('key'); chipRun?.(chipAction); });

  root.append(
    h('header', { class: 'view-head browser-head' },
      h('div', null,
        h('h1', { class: 'view-title', text: 'Browser' }),
        h('p', { class: 'view-sub', text: 'Pages render in Edge on this PC and stream here · Open on TV hands them to the TV' }))),
    h('div', { class: 'browser-bar' },
      h('div', { class: 'browser-navgroup' }, desktopNav.back, desktopNav.forward, desktopNav.reload, padButtons[0]),
      form, vpnButtons[0], tvButton('primary'), tvExtra('browser-tvx', 'Video → TV', 'play', 'tvscreen.playVideo', 'Sent to the TV'), tvExtra('browser-tvx', 'Close TV', 'close', 'tvscreen.close', 'Closed on the TV'), closeButtons[0]),
    h('div', { class: 'browser-status' }, dot, statusText, meta, chip, clearButton, closeButtons[1]),
    vpnRow,
    stage,
    pad,
    // One row on phones; while the TV shows the page its two buttons take the place of On TV.
    h('div', { class: 'browser-tools' }, phoneNav.back, phoneNav.forward, phoneNav.reload, padButtons[1], keyboardBtn, tvButton('tool'),
      tvExtra('', 'Video → TV', 'play', 'tvscreen.playVideo', 'Sent to the TV', 'Video'), tvExtra('', 'Close TV', 'close', 'tvscreen.close', 'Closed on the TV')),
  );

  /* ---------- commands ---------- */

  async function open(target, el = go) {
    if (!target) return;
    lastUrl = target;
    address.blur();
    await ctx.cmd('browser.open', { url: target }, { el, timeoutMs: 30000 });
  }

  function nav(action, el) {
    ctx.cmd('browser.nav', { action }, { el });
  }

  async function openOnTv(el) {
    const current = url();
    const typed = toUrl(address.value);
    if (!current && !typed) { toast('Enter an address first', { level: 'info' }); address.focus(); return; }
    el.classList.add('is-busy');
    const ack = await ctx.cmd('browser.openOnTv', current ? {} : { url: typed }, { el, timeoutMs: 45000 });
    el.classList.remove('is-busy');
    if (ack.ok) toast('On the TV · arrows move, OK clicks, Yellow plays the video', { level: 'ok' });
  }

  /* ---------- the status chip ---------- */

  const VIDEO_ACTIVE = new Set(['loading', 'playing', 'paused', 'fallback']);
  const convertForTv = (b) => tvCommand(b, 'tvscreen.playVideo', { args: { convert: true }, timeoutMs: 90000, done: 'Converting for the TV' });

  // → { tone, text, action?, run?, busy? } or null. The server's keys: tvscreen.video (the TV
  // player's state), tvscreen.handoff ({ stage: 'direct' | 'copy' | 'encode' | 'drm', converting }),
  // tvscreen.liveBlocked (live video stopped offering itself after the TV dropped it twice).
  function tvChip() {
    if (ctx.state.value('tvscreen.on', false) !== true) return null;
    const agent = ctx.state.value('conn.agent', null);
    if (agent === 'launching') return { tone: 'warn', text: 'Starting the TV agent…', busy: true };
    if (agent !== 'online') return { tone: 'bad', text: 'TV agent closed', action: 'Reopen on TV', run: openOnTv };
    const video = ctx.state.value('tvscreen.video', null);
    const handoff = ctx.state.value('tvscreen.handoff', null);
    const stage = handoff && typeof handoff === 'object' && typeof handoff.stage === 'string' ? handoff.stage : null;
    const converted = stage === 'copy' || stage === 'encode';
    const active = VIDEO_ACTIVE.has(video);
    // Only while ffmpeg runs. Once the copy is sent, the TV plays it but the video stays 'loading' (the
    // agent sends no 'playing' for a converted stream), so a converted 'loading' shows no chip.
    if (handoff?.converting === true) return { tone: 'warn', text: 'Converting for the TV…', busy: true };
    if (stage !== 'drm') {
      if (video === 'error') return { tone: 'bad', text: 'The TV could not play the video', short: 'TV player failed', action: 'Convert for TV', run: convertForTv };
      if (active && stage && !converted) return { tone: 'info', text: 'Black picture?', action: 'Convert for TV', run: convertForTv };
    }
    if (active) return null; // the TV's player is in front: live video waits behind it
    const blocked = ctx.state.value('tvscreen.liveBlocked', false);
    if (blocked) {
      const drops = typeof blocked === 'object' && Number.isFinite(blocked.strikes) ? blocked.strikes : 2;
      return {
        tone: 'warn', text: `Still frames (live video off after ${drops} drops)`, short: 'Still frames', action: 'Turn live on',
        run: (b) => tvCommand(b, 'tvscreen.live', { args: { on: true }, timeoutMs: 15000, done: 'Live video on' }),
      };
    }
    return null;
  }

  // Shown once the frames have kept another device's size for a while after this phone last asked.
  function sizeChip() {
    const now = performance.now();
    if (session() !== 'ready' || !hasFrame || now - sentAt < 3000 || now - reclaimedAt < 3000 || !sizedElsewhere()) return null;
    return { tone: 'info', text: 'Sized for another device', short: 'Other device’s size', action: 'Tap to fit', run: () => { reclaimedAt = performance.now(); viewport(true); } };
  }

  let chipShape = '';
  function paintChip() {
    const c = tvChip() || sizeChip();
    const shape = c ? `${c.tone}|${c.text}|${c.action || ''}|${!!c.busy}` : '';
    if (shape === chipShape) return; // rebuilding the button between press and click would swallow it
    chipShape = shape;
    chip.hidden = !c;
    root.classList.toggle('has-chip', !!c);
    if (!c) { chipRun = null; return; }
    chip.dataset.tone = c.tone;
    chip.classList.toggle('is-working', !!c.busy);
    // Narrow phones show the short wording when there is one; the whole sentence stays the chip's title.
    chipLong.textContent = c.text;
    chipShort.textContent = c.short || c.text;
    chip.title = c.text;
    chipAction.hidden = !c.action;
    chipAction.textContent = c.action || '';
    chipAction.classList.remove('is-busy');
    chipRun = c.run || null;
  }

  function retry() {
    // The page that is open (a crashed browser keeps it), else the last one asked for.
    open(url() || lastUrl || toUrl(address.value) || SUGGESTIONS[0][1]);
  }

  /* ---------- clear history ---------- */

  // This phone's own copy: the last address, the page picture and any browser keys it saved (only
  // the trackpad switch is a setting, and it stays). Every client does this on browser.cleared.
  function forgetLocal() {
    lastUrl = null;
    queued = null;
    hasFrame = false;
    paint.fillStyle = '#000';
    paint.fillRect(0, 0, canvas.width, canvas.height);
    if (document.activeElement !== address) address.value = url() || '';
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith('lumen.browser.') && key !== PAD_KEY) localStorage.removeItem(key);
    } catch { /* storage unavailable */ }
    shape = '';
    paintState();
  }
  ctx.live.on('browser.cleared', forgetLocal);

  const listOf = (words) => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]);

  function openClear() {
    openSheet({
      title: 'Clear browsing data',
      className: 'clear-sheet',
      build(body, sheet) {
        const choices = CLEAR_CHOICES.map(([key, label, detail, on]) => {
          const box = h('input', { type: 'checkbox', checked: on ? true : null });
          return { key, box, el: h('label', { class: 'capture-row clear-row' }, box, h('span', { class: 'clear-text' }, h('b', { text: label }), h('small', { text: detail }))) };
        });
        const cancel = h('button', { class: 'btn ghost', type: 'button', text: 'Cancel' });
        const confirm = h('button', { class: 'btn primary', type: 'button' }, icon('trash'), 'Clear data');
        const sync = () => { confirm.disabled = !choices.some((c) => c.box.checked); };
        for (const c of choices) c.box.addEventListener('change', sync);
        cancel.addEventListener('click', () => sheet.close());
        confirm.addEventListener('click', async () => {
          const args = Object.fromEntries(choices.map((c) => [c.key, c.box.checked]));
          confirm.classList.add('is-busy');
          confirm.disabled = true;
          // Edge closes and its files are deleted, which can take a while on a busy PC.
          const ack = await ctx.cmd('browser.clearHistory', args, { el: confirm, timeoutMs: 120000 });
          confirm.classList.remove('is-busy');
          if (!ack.ok) { sync(); return; }
          sheet.close();
          forgetLocal();
          const what = listOf([args.history && 'history', args.cache && 'cached files', args.cookies && 'cookies'].filter(Boolean));
          if (ack.value?.left?.length) toast(`Cleared ${what}, but some browser files were in use · try again`, { level: 'warn', timeout: 6000 });
          else toast(`Cleared ${what}${args.cookies ? ' · signed out of sites' : ''}`, { level: 'ok' });
        });
        body.append(
          h('p', { class: 'sheet-lead', text: 'Removes what Lumen’s browser on this PC has kept. Everyone using Lumen shares this browser, so it clears for them too.' }),
          h('div', { class: 'capture-list' }, choices.map((c) => c.el)),
          h('p', { class: 'clear-note', text: 'Kept: bookmarks, saved passwords, site permissions, the VPN and Lumen’s settings. The browser closes while it clears; Ask Lumen chats are not touched.' }),
          h('div', { class: 'sheet-actions' }, cancel, confirm));
      },
    });
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); open(toUrl(address.value)); });
  address.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { address.value = url() || ''; address.blur(); }
  });
  address.addEventListener('focus', () => address.select());
  address.addEventListener('blur', () => { if (!address.value.trim()) address.value = url() || ''; });

  /* ---------- state ---------- */

  let shape = '';
  function paintState() {
    const s = session();
    const current = url();
    const title = ctx.state.value('browser.title', null);
    const loading = !!ctx.state.value('browser.loading', false);
    const error = ctx.state.value('browser.error', null);
    const ready = s === 'ready';
    root.dataset.session = s;
    if (!ready) hasFrame = false;
    if (document.activeElement !== address) address.value = current || (s === 'starting' ? lastUrl || '' : '');

    for (const set of navSets) {
      set.back.disabled = !ready || !ctx.state.value('browser.canGoBack', false);
      set.forward.disabled = !ready || !ctx.state.value('browser.canGoForward', false);
      set.reload.disabled = !ready || !current;
      if (set.loading === loading) continue;
      // Only swap the glyph when loading actually flips, so a press in flight keeps its target.
      set.loading = loading;
      const label = loading ? 'Stop' : 'Reload';
      set.reload.setAttribute('aria-label', label);
      fill(set.reload, icon(loading ? 'close' : 'refresh'), set.kind === 'tool' ? h('span', { text: label }) : null);
      if (set.kind !== 'tool') set.reload.title = label;
    }
    for (const b of closeButtons) b.disabled = s === 'off';
    keyboardBtn.disabled = !ready;
    for (const b of padButtons) b.disabled = !ready;
    pad.hidden = !(padOn && ready);
    placePointer();

    const [tone, sessionLabel] = SESSION[s] || SESSION.off;
    dot.className = `status-dot ${tone}`;
    fill(statusText,
      h('b', { text: title || (current ? hostOf(current) : s === 'starting' && lastUrl ? hostOf(lastUrl) : 'No page open') }),
      loading ? ' · Loading…' : '',
      ` · ${s === 'error' && error ? error : sessionLabel}`);
    paintMeta();

    const next = `${s}|${hasFrame}|${s === 'error' ? error : ''}`;
    if (next === shape) return;
    shape = next;
    if (s === 'off') fill(overlay, welcome());
    else if (s === 'starting') fill(overlay, wait('Starting the browser…'));
    else if (s === 'error') fill(overlay, failure(error));
    else if (!hasFrame) fill(overlay, wait('Waiting for the first frame…'));
    else fill(overlay);
  }

  function welcome() {
    return h('div', { class: 'browser-welcome' },
      h('div', { class: 'browser-orb', 'aria-hidden': 'true' }, icon('globe', 'lg')),
      h('h2', { class: 'browser-lead', text: 'A browser inside Lumen' }),
      h('p', { class: 'browser-copy', text: 'Pages open in Microsoft Edge on the Lumen PC and stream here, so sites that refuse embedding still work and logins persist. Everyone on Lumen sees the same page; Open on TV hands it to the TV.' }),
      h('div', { class: 'chips browser-suggest' }, SUGGESTIONS.map(([label, target]) => h('button', { class: 'chip', type: 'button', text: label, onClick: () => open(target) }))));
  }

  const wait = (text) => h('div', { class: 'browser-wait', role: 'status' }, h('span', { class: 'spinner' }), h('span', { text }));

  // The session's error covers a start that failed and a browser that went away later (Edge or its
  // page crashed), so the heading says which when the message does.
  const failureTitle = (message) => (/crash/i.test(message || '') ? 'The browser crashed'
    : /could not start|did not start/i.test(message || '') ? 'The browser could not start' : 'The browser stopped');

  function failure(message) {
    const again = h('button', { class: 'btn primary', type: 'button' }, icon('refresh'), 'Retry');
    again.addEventListener('click', retry);
    return h('div', { class: 'browser-welcome browser-error', role: 'alert' },
      h('div', { class: 'browser-orb', 'aria-hidden': 'true' }, icon('alert', 'lg')),
      h('h2', { class: 'browser-lead', text: failureTitle(message) }),
      h('p', { class: 'browser-copy', text: message || 'Something went wrong on the PC.' }),
      again);
  }

  function paintMeta() {
    if (session() !== 'ready' || !hasFrame) { meta.textContent = ''; return; }
    meta.textContent = `${frame.w}×${frame.h} · ${fps ? `${fps} fps` : 'idle'}`;
  }

  ctx.state.watch(['browser.*'], paintState);
  setInterval(() => {
    fps = painted;
    painted = 0;
    if (showing()) { paintMeta(); paintChip(); }
  }, 1000);

  /* ---------- frames ---------- */

  let decoding = false;
  let queued = null;

  // Every frame is acked as it arrives: the server's per-client window paces the network, and a frame
  // that arrives mid-decode replaces any earlier waiting one, so a slow phone paints fewer frames
  // without making the stream wait for it. A frame that fails to decode is skipped, not the next one.
  async function onFrame(msg) {
    ctx.live.post('browser.ack', { seq: msg.seq });
    if (msg.w > 0 && msg.h > 0) lastFrameCss = { w: msg.w, h: msg.h };
    if (!showing()) return;
    if (decoding) { queued = msg; return; }
    decoding = true;
    try {
      let m = msg;
      while (m) {
        try {
          await draw(m);
        } catch (err) {
          console.warn('Browser frame dropped', err);
        }
        m = queued;
        queued = null;
      }
    } finally {
      decoding = false;
    }
  }

  // Binary frames carry the JPEG bytes; JSON ones (older servers, the dev server) base64.
  function base64Bytes(data) {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(data);
    const text = atob(data);
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
    return out;
  }

  async function draw({ bytes: raw, data }) {
    const bytes = raw ?? base64Bytes(data);
    // Edge sends JPEG; the dev server's fake frames are PNG.
    const bitmap = await createImageBitmap(new Blob([bytes], { type: bytes[0] === 0x89 ? 'image/png' : 'image/jpeg' }));
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    paint.drawImage(bitmap, 0, 0);
    bitmap.close();
    painted += 1;
    if (frame.w !== canvas.width || frame.h !== canvas.height) {
      frame = { w: canvas.width, h: canvas.height };
      fit();
    }
    if (!hasFrame) {
      hasFrame = true;
      paintState();
      if (padOn) syncPointer();
    }
  }

  // The stage's content box (it has a border and no padding). Its border box would be 2 px larger,
  // and on short phones the stage is sized from its content: each resize then grew it by 2 px.
  const stageBox = () => ({ width: stage.clientWidth, height: stage.clientHeight });

  // The canvas keeps the frame's aspect inside the stage; the stage letterboxes the rest.
  function fit() {
    const r = stageBox();
    const size = frame.w ? fitFrame(r.width, r.height, frame.w, frame.h) : null;
    if (!size) return;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    placePointer();
  }

  ctx.live.on('browser.frame', onFrame);

  /* ---------- viewport ---------- */

  let viewportTimer = 0;
  let sentViewport = '';
  let sentSize = null;     // the page size this phone last asked for
  let sentAt = -Infinity;
  let lastFrameCss = null; // the page size the newest frame was laid out at (CSS px, from its header)
  let mouseHeld = false;
  function viewport(force = false, since = performance.now()) {
    clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => {
      if (!showing()) return;
      // Never re-laid out under a finger or a held button (the click would land on what moved there),
      // for up to 3 s.
      if ((touch || mouseHeld) && performance.now() - since < 3000) { viewport(force, since); return; }
      // The page is laid out at the stage's CSS size, scaled uniformly into the server's box so the
      // frame keeps the stage's shape (browser-fit.js viewportFor).
      const r = stageBox();
      const size = viewportFor(r.width, r.height);
      if (!size) return;
      const { w, h: hh } = size;
      const key = `${w}x${hh}`;
      if (!force && key === sentViewport) return;
      if (ctx.live.post('browser.viewport', { w, h: hh })) {
        sentViewport = key;
        sentSize = { w, h: hh };
        sentAt = performance.now();
      }
    }, VIEWPORT_MS);
  }

  // The page has one size for every client. When another device (on the Browser view too) asked for
  // its own size last, the page this phone shows is laid out for that one; using this phone (a tap,
  // a click, the wheel, the trackpad, a key) asks for this phone's size again. Not while the TV shows
  // the page: its 1280×720 layout holds then.
  let reclaimedAt = -Infinity;
  const tvOn = () => ctx.state.value('tvscreen.on', false) === true;
  const sizedElsewhere = () => !tvOn() && sizeDiffers(lastFrameCss, sentSize);
  function reclaim() {
    if (tvOn()) return;
    const now = performance.now();
    if (now - reclaimedAt < 1500) return;
    if (!sizeDiffers(lastFrameCss, sentSize)) return;
    reclaimedAt = now;
    viewport(true);
  }

  new ResizeObserver(() => { fit(); viewport(); }).observe(stage);
  ctx.on('view', (name) => {
    if (name === 'browser') { fit(); viewport(true); if (padOn) syncPointer(); }
    else { setKeyboard(false); typer.blur(); }
  });
  ctx.on('hello', () => { sentViewport = ''; viewport(true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) viewport(true); });

  /* ---------- pointer ---------- */

  // Canvas position → frame pixels, plus the size of the frame on screen (fw×fh): the server undoes
  // exactly that scale, even when newer frames of another size are already on their way here.
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: clamp(Math.round(((e.clientX - r.left) / r.width) * frame.w), 0, frame.w),
      y: clamp(Math.round(((e.clientY - r.top) / r.height) * frame.h), 0, frame.h),
      fw: frame.w, fh: frame.h,
    };
  };
  const scale = () => frame.w / (canvas.getBoundingClientRect().width || 1);
  const moves = coalescer(input);
  const wheels = coalescer(input, (a, b) => ({ ...b, deltaX: a.deltaX + b.deltaX, deltaY: a.deltaY + b.deltaY }));

  // Fingers. Where the browser has Touch Events (iPhone Safari and Chrome, Android), they drive the
  // page: a non-passive touchstart/touchmove that calls preventDefault keeps the whole gesture for
  // the canvas (no native scroll or zoom, no pointercancel, no compatibility mouse events, so no
  // focus on the hidden text field and no keyboard popping up). Touch-type pointer events are then
  // ignored; without Touch Events they do the same job.
  const TOUCH_EVENTS = 'ontouchstart' in window;
  let touch = null;
  let longTimer = 0;
  let lastPointer = 'mouse';

  // `when` is the event's timeStamp: tap or long press is decided on release from when the finger
  // really went down and up, so a busy phone (a timer firing late) never turns a tap into a right-click.
  function touchStart(id, pt, when) {
    lastPointer = 'touch';
    if (!frame.w) return;
    if (touch && touch.id !== id && when - touch.start < 10000) return; // a second finger
    clearTimeout(longTimer);
    touch = { id, x: pt.clientX, y: pt.clientY, lastX: pt.clientX, lastY: pt.clientY, start: when, moved: false };
    longTimer = setTimeout(() => { if (touch && !touch.moved) haptic('key'); }, LONG_PRESS_MS); // feel the long press
  }

  function touchMove(id, pt) {
    if (!touch || id !== touch.id || !frame.w) return;
    const dx = pt.clientX - touch.lastX;
    const dy = pt.clientY - touch.lastY;
    touch.lastX = pt.clientX;
    touch.lastY = pt.clientY;
    if (!touch.moved && Math.hypot(pt.clientX - touch.x, pt.clientY - touch.y) < TAP_SLOP) return;
    touch.moved = true;
    clearTimeout(longTimer);
    // Dragging a finger scrolls the page under it, like a touch screen.
    const s = scale();
    wheels.push({ kind: 'wheel', ...at(pt), deltaX: Math.round(-dx * s), deltaY: Math.round(-dy * s), modifiers: 0 });
  }

  function touchEnd(id, pt, cancelled, when) {
    if (!touch || id !== touch.id) return;
    clearTimeout(longTimer);
    // A finger that stayed put is a click however long it was held (careful presses on small targets
    // are often longer than a quick tap); held past the long press it is a right-click.
    const still = !touch.moved && !cancelled;
    const long = when - touch.start >= LONG_PRESS_MS;
    touch = null;
    wheels.flush();
    if (!still || !frame.w) return;
    if (!long) haptic('key');
    commitTyping(); // a word still being composed reaches the page before the tap does
    input({ kind: 'click', ...at(pt), button: long ? 'right' : 'left', modifiers: 0, touch: Math.max(1, Math.round(FINGER_PX * scale())) });
    if (keyboardOn && !long) typer.focus({ preventScroll: true });
  }

  if (TOUCH_EVENTS) {
    const ours = (e) => (touch ? [...e.changedTouches].find((t) => t.identifier === touch.id) : null);
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      reclaim();
      const t = e.changedTouches[0];
      if (t) touchStart(t.identifier, t, e.timeStamp);
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = ours(e);
      if (t) touchMove(t.identifier, t);
    }, { passive: false });
    canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      const t = ours(e);
      if (t) touchEnd(t.identifier, t, false, e.timeStamp);
    }, { passive: false });
    canvas.addEventListener('touchcancel', (e) => {
      const t = ours(e);
      if (t) touchEnd(t.identifier, t, true, e.timeStamp);
    });
  }

  const finger = (e) => e.pointerType === 'touch';

  canvas.addEventListener('pointerdown', (e) => {
    if (finger(e)) {
      if (TOUCH_EVENTS) return;
      reclaim();
      // No compatibility mouse events: they would focus the canvas and, through it, the hidden
      // text field, which opens the keyboard on every tap.
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
      touchStart(e.pointerId, e, e.timeStamp);
      return;
    }
    lastPointer = e.pointerType;
    if (!frame.w) return;
    reclaim();
    mouseHeld = true;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    e.preventDefault();
    moves.flush();
    commitTyping();
    input({ kind: 'down', ...at(e), button: BUTTONS[e.button] || 'left', modifiers: modifiers(e) });
    typer.focus({ preventScroll: true });
  });

  canvas.addEventListener('pointermove', (e) => {
    if (finger(e)) {
      if (!TOUCH_EVENTS) touchMove(e.pointerId, e);
      return;
    }
    if (!frame.w) return;
    moves.push({ kind: 'move', ...at(e), modifiers: modifiers(e) });
  });

  canvas.addEventListener('pointerup', (e) => {
    if (finger(e)) {
      if (!TOUCH_EVENTS) touchEnd(e.pointerId, e, false, e.timeStamp);
      return;
    }
    mouseHeld = false;
    if (!frame.w) return;
    moves.flush();
    input({ kind: 'up', ...at(e), button: BUTTONS[e.button] || 'left', modifiers: modifiers(e) });
  });
  canvas.addEventListener('pointercancel', (e) => {
    if (!finger(e)) mouseHeld = false;
    else if (!TOUCH_EVENTS) touchEnd(e.pointerId, e, true, e.timeStamp);
  });
  // Capture lost without a pointerup (the system took the touch): the gesture is over, not a tap.
  canvas.addEventListener('lostpointercapture', (e) => {
    if (!finger(e)) mouseHeld = false;
    else if (!TOUCH_EVENTS) touchEnd(e.pointerId, e, true, e.timeStamp);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    if (!frame.w) return;
    e.preventDefault();
    reclaim();
    const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : 1;
    const s = scale();
    wheels.push({ kind: 'wheel', ...at(e), deltaX: Math.round(e.deltaX * unit * s), deltaY: Math.round(e.deltaY * unit * s), modifiers: modifiers(e) });
  }, { passive: false });
  // Keyboard focus (Tab) or a mouse click passes keys to the page; a finger only does with Keyboard on.
  canvas.addEventListener('focus', () => { if (lastPointer !== 'touch' || keyboardOn) typer.focus({ preventScroll: true }); });

  /* ---------- trackpad: one pointer over the page (and the TV's cursor while it shows the page) ---------- */

  // Moves are predicted here and sent as deltas, so the TV remote can move the same pointer between
  // strokes; the server's answer is adopted once nothing is in flight.
  let inflight = 0;
  function sendPointer(ev) {
    inflight += 1;
    ctx.live.send('browser.pointer', ev, { timeoutMs: 5000 }).then((ack) => {
      inflight -= 1;
      if (!ack.ok || !ack.value || inflight || pointerMoves.pending) return;
      ptr = { x: ack.value.x, y: ack.value.y };
      placePointer();
    });
  }
  const pointerMoves = coalescer(sendPointer, (a, b) => ({ dx: a.dx + b.dx, dy: a.dy + b.dy }));
  const pointerWheels = coalescer(sendPointer, (a, b) => ({ ...b, deltaX: a.deltaX + b.deltaX, deltaY: a.deltaY + b.deltaY }));
  const padLive = () => padOn && session() === 'ready' && frame.w > 0;

  // Where the shared pointer is now (the TV remote may have moved it): a move of nothing reports it.
  function syncPointer() {
    if (session() === 'ready' && !inflight) sendPointer({});
  }

  function placePointer() {
    const show = padOn && hasFrame && session() === 'ready';
    pointerEl.hidden = !show;
    if (!show) return;
    const c = canvas.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const x = c.left - s.left - stage.clientLeft + ptr.x * c.width;
    const y = c.top - s.top - stage.clientTop + ptr.y * c.height;
    pointerEl.style.transform = `translate(${x}px, ${y}px)`;
  }

  function setPad(on) {
    padOn = on;
    localStorage.setItem(PAD_KEY, on ? '1' : '0');
    for (const b of padButtons) b.setAttribute('aria-pressed', String(on));
    pad.hidden = !(on && session() === 'ready');
    if (on) syncPointer();
    placePointer();
  }

  // While the TV shows the page, moves and clicks drive the TV's own pointer (as the Mouse view does):
  // the TV draws it, so it is smooth, and the agent turns it into page moves and clicks. Scrolling still
  // goes to the page directly. The phone's pointer catches up with the TV's once a stroke ends.
  const nativeTv = () => ctx.state.value('tvscreen.on', false) === true && ctx.state.value('conn.remote', null) === 'paired';
  let native = { dx: 0, dy: 0 };
  let nativeFrame = 0;
  let nativeSync = 0;
  // After a stroke the phone's position is the one that counts: the page's pointer is put exactly
  // there, then the TV's pointer is checked and nudged towards it, a few times if it lands off.
  let alignRun = 0;
  const ALIGN_TRIES = 3;
  async function alignTv() {
    const run = ++alignRun;
    const target = { ...ptr };
    const placed = await ctx.live.send('browser.pointer', { x: target.x, y: target.y, native: true }, { timeoutMs: 5000 });
    if (!placed?.ok) return;
    for (let i = 0; i < ALIGN_TRIES; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (run !== alignRun) return; // a new stroke took over
      const ack = await ctx.live.send('browser.pointer', { native: true }, { timeoutMs: 5000 });
      const at = ack?.ok ? ack.value?.native : null;
      if (!at || run !== alignRun) return;
      const ex = target.x - at.x;
      const ey = target.y - at.y;
      if (Math.abs(ex) < 0.006 && Math.abs(ey) < 0.01) return;
      ctx.live.post('pointer.move', { dx: clamp(Math.round(ex * 1920), -400, 400), dy: clamp(Math.round(ey * 1080), -400, 400) });
    }
  }

  const flushNative = () => {
    nativeFrame = 0;
    const dx = Math.round(native.dx);
    const dy = Math.round(native.dy);
    native = { dx: 0, dy: 0 };
    if (dx || dy) ctx.live.post('pointer.move', { dx: clamp(dx, -400, 400), dy: clamp(dy, -400, 400) });
    clearTimeout(nativeSync);
    alignRun += 1; // a stroke in progress: no alignment until it pauses
    nativeSync = setTimeout(alignTv, 300);
  };

  pad.addEventListener('pointerdown', () => { if (padLive()) reclaim(); });
  bindTrackpad(pad, {
    // A slow stroke across the pad crosses the page; a finger's travel is the same page distance
    // either way, so the pointer moves the way the finger does.
    move(dx, dy) {
      if (!padLive()) return;
      if (nativeTv()) {
        const gain = readGain();
        const ax = accelerate(dx, gain);
        const ay = accelerate(dy, gain);
        native.dx += ax;
        native.dy += ay;
        if (!nativeFrame) nativeFrame = requestAnimationFrame(flushNative);
        // The phone's pointer follows along (the TV's pointer moves in 1920x1080 screen pixels).
        ptr = { x: clamp(ptr.x + ax / 1920, POINTER_EDGE, 1 - POINTER_EDGE), y: clamp(ptr.y + ay / 1080, POINTER_EDGE, 1 - POINTER_EDGE) };
        placePointer();
        return;
      }
      const p = pad.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      if (!p.width || !c.height) return;
      const k = 1 / (2 * p.width);
      const gain = readGain();
      const x = clamp(ptr.x + accelerate(dx, gain) * k, POINTER_EDGE, 1 - POINTER_EDGE);
      const y = clamp(ptr.y + accelerate(dy, gain) * k * (c.width / c.height), POINTER_EDGE, 1 - POINTER_EDGE);
      if (x === ptr.x && y === ptr.y) return;
      pointerMoves.push({ dx: x - ptr.x, dy: y - ptr.y });
      ptr = { x, y };
      placePointer();
    },
    click(button) {
      if (!padLive()) return;
      commitTyping();
      if (nativeTv()) {
        if (nativeFrame) { cancelAnimationFrame(nativeFrame); flushNative(); }
        // The click lands where the phone shows the pointer, whatever the TV pointer did.
        clearTimeout(nativeSync);
        alignRun += 1;
        sendPointer({ x: ptr.x, y: ptr.y, action: 'click', button, native: true });
        nativeSync = setTimeout(alignTv, 300);
        pad.classList.remove('is-tap');
        void pad.offsetWidth;
        pad.classList.add('is-tap');
        return;
      }
      pointerMoves.flush();
      sendPointer({ action: 'click', button });
      pad.classList.remove('is-tap');
      void pad.offsetWidth;
      pad.classList.add('is-tap');
    },
    // Natural scrolling, like dragging the page itself: the content follows the fingers.
    scroll(dx, dy) {
      if (!padLive()) return;
      const s = scale() * PAD_SCROLL;
      pointerWheels.push({ action: 'wheel', deltaX: -dx * s, deltaY: -dy * s });
    },
  });
  pad.addEventListener('wheel', (e) => {
    if (!padLive()) return;
    e.preventDefault();
    const unit = (e.deltaMode === 1 ? WHEEL_LINE_PX : 1) * scale();
    pointerWheels.push({ action: 'wheel', deltaX: e.deltaX * unit, deltaY: e.deltaY * unit });
  }, { passive: false });
  setPad(padOn);

  /* ---------- typing ---------- */

  // The field stays empty: each character goes out as it is typed, so Backspace always means
  // "delete in the page", never "delete in the field". Android keyboards (Gboard, Samsung) keep the
  // word being typed in a composition and send it only when it ends.
  let composing = false;
  let committing = false;

  // A tap or click on the page while a word is still being composed: the word goes to the page first
  // (taps keep focus in the field, so nothing else would end the composition and the click would run
  // first, e.g. a search with an empty box). Blurring ends the composition; the field is focused again
  // so the keyboard stays.
  function commitTyping() {
    if (!composing) return;
    if (document.activeElement !== typer) { composing = false; return; }
    const word = typer.value;
    committing = true;
    try {
      typer.blur();
    } finally {
      committing = false;
    }
    composing = false;
    typer.value = '';
    if (word) input({ kind: 'text', text: word });
    typer.focus({ preventScroll: true });
    if (document.activeElement !== typer) typingOff();
  }

  function setKeyboard(on) {
    keyboardOn = on;
    keyboardBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) typer.focus({ preventScroll: true });
    else if (document.activeElement === typer) typer.blur(); // with a mouse too: keys stop going to the page
  }

  typer.addEventListener('keydown', (e) => {
    e.stopPropagation();
    reclaim();
    if (e.isComposing || e.key === 'Unidentified' || e.key === 'Process') return;
    // Esc leaves the page (so keyboard users are never trapped); Shift+Esc sends Escape to the page.
    if (e.key === 'Escape' && !e.shiftKey) {
      e.preventDefault();
      setKeyboard(false);
      typer.blur();
      keyboardBtn.focus({ preventScroll: true });
      return;
    }
    // AltGr (Windows reports it as Ctrl+Alt) types characters (@ { [ \ €, Polish letters): they go
    // through the input event as text, not as a Ctrl shortcut the server refuses. Ctrl+Alt with a
    // plain letter or digit stays a shortcut (US layouts have no AltGr characters).
    const altGr = (e.getModifierState && e.getModifierState('AltGraph'))
      || (e.ctrlKey && e.altKey && !e.metaKey && !/^[a-z0-9]$/i.test(e.key));
    const combo = !altGr && (e.ctrlKey || e.metaKey) && e.key.length === 1;
    if (combo && e.key.toLowerCase() === 'v') return; // paste arrives through the paste event
    if (SPECIAL_KEYS.has(e.key) || combo) {
      e.preventDefault();
      sendKey({ kind: 'key', key: e.key, code: e.code, modifiers: modifiers(e) });
    }
  });
  // Keys are sent with an ack so a shortcut the server will not pass on says so (at most every 5 s).
  let refusedAt = 0;
  function sendKey(ev) {
    ctx.live.send('browser.input', ev, { timeoutMs: 5000 }).then((ack) => {
      if (ack.ok || ack.error?.code !== 'INVALID' || performance.now() - refusedAt < 5000) return;
      refusedAt = performance.now();
      toast(ack.error.message || 'The page did not take that key', { level: 'warn' });
    });
  }
  typer.addEventListener('beforeinput', (e) => {
    // Phone keyboards report Backspace and Enter only here (keydown says Unidentified).
    if (e.inputType === 'deleteContentBackward' && !typer.value) {
      e.preventDefault();
      input({ kind: 'key', key: 'Backspace', code: 'Backspace', modifiers: 0 });
    } else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      e.preventDefault();
      input({ kind: 'key', key: 'Enter', code: 'Enter', modifiers: 0 });
    }
  });
  const sendTyped = () => {
    if (committing) return; // commitTyping sends the word itself, once
    const text = typer.value;
    typer.value = '';
    if (text) input({ kind: 'text', text });
  };
  typer.addEventListener('input', (e) => { if (!e.isComposing) sendTyped(); });
  typer.addEventListener('compositionstart', () => { composing = true; });
  typer.addEventListener('compositionend', () => { composing = false; sendTyped(); });
  typer.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text');
    if (text) input({ kind: 'text', text });
  });
  // The toggle and the stage outline follow where keys really go.
  typer.addEventListener('focus', () => {
    keyboardOn = true;
    keyboardBtn.setAttribute('aria-pressed', 'true');
    stage.classList.add('is-typing');
  });
  function typingOff() {
    keyboardOn = false;
    keyboardBtn.setAttribute('aria-pressed', 'false');
    stage.classList.remove('is-typing');
  }
  // commitTyping's blur is only to end a composition (the field is focused again right after).
  typer.addEventListener('blur', () => { if (!committing) typingOff(); });

  /* ---------- the TV's side (last: it paints with everything above) ---------- */

  let tvWasOn = null;
  ctx.state.watch(['tvscreen.*', 'conn.agent'], () => {
    const on = ctx.state.value('tvscreen.on', false) === true;
    if (on !== tvWasOn) {
      tvWasOn = on;
      for (const b of tvExtras) b.hidden = !on;
      for (const b of tvButtons) b.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (padOn) syncPointer();
    }
    paintChip();
  });
}
