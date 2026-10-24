// Browser: headless Edge on the Lumen PC renders the page and streams it here as frames; pointer,
// wheel and typing go back as browser.input in frame pixels. One shared session for every client;
// Show on TV puts the page on the TV. The Mouse toggle opens a trackpad that moves one pointer over
// the page (browser.pointer), the same pointer the TV shows and the TV remote moves.

import { h, icon, fill } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { openSheet } from '../ui/sheet.js';
import { haptic } from '../ui/haptics.js';
import { accelerate, bindTrackpad, readGain } from '../ui/trackpad.js';

const RATE_MS = 33;          // moves and wheel deltas coalesce to ~30 messages/s
const VIEWPORT_MS = 250;     // resize settle before browser.viewport
const TAP_SLOP = 10;
const LONG_PRESS_MS = 650;   // a still finger held this long is a right-click; any shorter still press is a click
const FINGER_PX = 12;        // finger contact radius (CSS px) for the server's touch adjustment
const WHEEL_LINE_PX = 40;
const PAD_KEY = 'lumen.browser.pad';
const POINTER_EDGE = 0.002;  // the server keeps the pointer this far (fraction of the page) inside
const PAD_SCROLL = 1.5;      // two-finger scroll: page pixels per stage pixel the fingers travel
const VIEWPORT_MIN = 320;
const VIEWPORT_MAX = { w: 1280, h: 800 };
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

  const address = h('input', {
    class: 'browser-address', type: 'text', inputmode: 'url', enterkeyhint: 'go', placeholder: 'Search or enter an address',
    'aria-label': 'Address or search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
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
  const tvExtra = (cls, label, iconName, cmd, done, short = label) => {
    const b = h('button', { class: `btn ghost ${cls}`.trim(), type: 'button', hidden: true, 'aria-label': label, title: label }, icon(iconName), h('span', { text: short }));
    b.addEventListener('click', async () => {
      b.classList.add('is-busy');
      const ack = await ctx.cmd(cmd, {}, { el: b, timeoutMs: 20000 });
      b.classList.remove('is-busy');
      if (ack.ok) toast(done, { level: 'ok' });
    });
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

  root.append(
    h('header', { class: 'view-head browser-head' },
      h('div', null,
        h('h1', { class: 'view-title', text: 'Browser' }),
        h('p', { class: 'view-sub', text: 'Pages render in Edge on this PC and stream here · Open on TV hands them to the TV' }))),
    h('div', { class: 'browser-bar' },
      h('div', { class: 'browser-navgroup' }, desktopNav.back, desktopNav.forward, desktopNav.reload, padButtons[0]),
      form, vpnButtons[0], tvButton('primary'), tvExtra('browser-tvx', 'Video → TV', 'play', 'tvscreen.playVideo', 'Playing on the TV'), tvExtra('browser-tvx', 'Close TV', 'close', 'tvscreen.close', 'Closed on the TV'), closeButtons[0]),
    h('div', { class: 'browser-status' }, dot, statusText, meta, clearButton, closeButtons[1]),
    vpnRow,
    stage,
    pad,
    // One row on phones; while the TV shows the page its two buttons take the place of On TV.
    h('div', { class: 'browser-tools' }, phoneNav.back, phoneNav.forward, phoneNav.reload, padButtons[1], keyboardBtn, tvButton('tool'),
      tvExtra('', 'Video → TV', 'play', 'tvscreen.playVideo', 'Playing on the TV', 'Video'), tvExtra('', 'Close TV', 'close', 'tvscreen.close', 'Closed on the TV')),
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

  ctx.state.watch('tvscreen.on', () => {
    const on = ctx.state.value('tvscreen.on', false) === true;
    for (const b of tvExtras) b.hidden = !on;
    for (const b of tvButtons) b.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (padOn) syncPointer();
  });
  // The TV dropped Lumen's page (it closed it, or the agent crashed): say so, once, as it happens.
  ctx.state.watch('tvscreen.lost', () => {
    const lost = ctx.state.value('tvscreen.lost', null);
    if (lost?.at && Date.now() - lost.at < 30000) toast(`${lost.reason || 'The TV closed Lumen’s page'}. Tap On TV to show it again.`, { level: 'warn', timeout: 6000 });
  });

  function retry() {
    open(lastUrl || url() || toUrl(address.value) || SUGGESTIONS[0][1]);
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

  function failure(message) {
    const again = h('button', { class: 'btn primary', type: 'button' }, icon('refresh'), 'Retry');
    again.addEventListener('click', retry);
    return h('div', { class: 'browser-welcome browser-error', role: 'alert' },
      h('div', { class: 'browser-orb', 'aria-hidden': 'true' }, icon('alert', 'lg')),
      h('h2', { class: 'browser-lead', text: 'The browser could not start' }),
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
    if (showing()) paintMeta();
  }, 1000);

  /* ---------- frames ---------- */

  let decoding = false;
  let queued = null;

  // Every frame is acked as it arrives: the server's per-client window paces the network, and a frame
  // that arrives mid-decode replaces any earlier waiting one, so a slow phone paints fewer frames
  // without making the stream wait for it. A frame that fails to decode is skipped, not the next one.
  async function onFrame(msg) {
    ctx.live.post('browser.ack', { seq: msg.seq });
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

  // The canvas keeps the frame's aspect inside the stage; the stage letterboxes the rest.
  function fit() {
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height || !frame.w) return;
    const s = Math.min(r.width / frame.w, r.height / frame.h);
    canvas.style.width = `${Math.floor(frame.w * s)}px`;
    canvas.style.height = `${Math.floor(frame.h * s)}px`;
    placePointer();
  }

  ctx.live.on('browser.frame', onFrame);

  /* ---------- viewport ---------- */

  let viewportTimer = 0;
  let sentViewport = '';
  function viewport(force = false) {
    clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => {
      if (!showing()) return;
      const r = stage.getBoundingClientRect();
      if (!r.width || !r.height) return;
      // The page is laid out at the stage's CSS size so text appears at its normal size (laying it
      // out in device pixels made a phone show 16 px text at about 11 px). Scaled uniformly into the
      // server's clamp box so the frame keeps the stage's aspect.
      const s = Math.min(1, VIEWPORT_MAX.w / r.width, VIEWPORT_MAX.h / r.height);
      const w = clamp(Math.round(r.width * s), VIEWPORT_MIN, VIEWPORT_MAX.w);
      const hh = clamp(Math.round(r.height * s), VIEWPORT_MIN, VIEWPORT_MAX.h);
      const key = `${w}x${hh}`;
      if (!force && key === sentViewport) return;
      if (ctx.live.post('browser.viewport', { w, h: hh })) sentViewport = key;
    }, VIEWPORT_MS);
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
    input({ kind: 'click', ...at(pt), button: long ? 'right' : 'left', modifiers: 0, touch: Math.max(1, Math.round(FINGER_PX * scale())) });
    if (keyboardOn && !long) typer.focus({ preventScroll: true });
  }

  if (TOUCH_EVENTS) {
    const ours = (e) => (touch ? [...e.changedTouches].find((t) => t.identifier === touch.id) : null);
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
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
      // No compatibility mouse events: they would focus the canvas and, through it, the hidden
      // text field, which opens the keyboard on every tap.
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
      touchStart(e.pointerId, e, e.timeStamp);
      return;
    }
    lastPointer = e.pointerType;
    if (!frame.w) return;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    e.preventDefault();
    moves.flush();
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
    if (!frame.w) return;
    moves.flush();
    input({ kind: 'up', ...at(e), button: BUTTONS[e.button] || 'left', modifiers: modifiers(e) });
  });
  canvas.addEventListener('pointercancel', (e) => { if (finger(e) && !TOUCH_EVENTS) touchEnd(e.pointerId, e, true, e.timeStamp); });
  // Capture lost without a pointerup (the system took the touch): the gesture is over, not a tap.
  canvas.addEventListener('lostpointercapture', (e) => { if (finger(e) && !TOUCH_EVENTS) touchEnd(e.pointerId, e, true, e.timeStamp); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    if (!frame.w) return;
    e.preventDefault();
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
  // The TV's pointer is the one the owner aims with: after a stroke (or a tap) the phone's pointer
  // takes the TV pointer's real position, so the two always show the same spot. (Nudging the TV
  // towards the phone's estimate left them apart, as the TV accelerates its pointer its own way.)
  let alignRun = 0;
  async function alignTv() {
    const run = ++alignRun;
    const ack = await ctx.live.send('browser.pointer', { native: true }, { timeoutMs: 5000 });
    const at = ack?.ok ? ack.value?.native : null;
    if (!at || run !== alignRun || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
    ptr = { x: clamp(at.x, 0, 1), y: clamp(at.y, 0, 1) };
    placePointer();
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
      if (nativeTv()) {
        if (nativeFrame) { cancelAnimationFrame(nativeFrame); flushNative(); }
        // A tap clicks where the TV's pointer is, as the Mouse view does: moving it to the phone's
        // estimate first made it jump to another spot on the TV before clicking.
        clearTimeout(nativeSync);
        alignRun += 1;
        ctx.cmd('pointer.click', { button: button === 'right' ? 'right' : 'left' });
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
  // "delete in the page", never "delete in the field".
  function setKeyboard(on) {
    keyboardOn = on;
    keyboardBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) typer.focus({ preventScroll: true });
    else if (document.activeElement === typer && matchMedia('(pointer: coarse)').matches) typer.blur();
  }

  typer.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.isComposing || e.key === 'Unidentified' || e.key === 'Process') return;
    // Esc leaves the page (so keyboard users are never trapped); Shift+Esc sends Escape to the page.
    if (e.key === 'Escape' && !e.shiftKey) {
      e.preventDefault();
      setKeyboard(false);
      typer.blur();
      keyboardBtn.focus({ preventScroll: true });
      return;
    }
    const combo = (e.ctrlKey || e.metaKey) && e.key.length === 1;
    if (combo && e.key.toLowerCase() === 'v') return; // paste arrives through the paste event
    if (SPECIAL_KEYS.has(e.key) || combo) {
      e.preventDefault();
      input({ kind: 'key', key: e.key, code: e.code, modifiers: modifiers(e) });
    }
  });
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
    const text = typer.value;
    typer.value = '';
    if (text) input({ kind: 'text', text });
  };
  typer.addEventListener('input', (e) => { if (!e.isComposing) sendTyped(); });
  typer.addEventListener('compositionend', sendTyped);
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
  typer.addEventListener('blur', () => {
    keyboardOn = false;
    keyboardBtn.setAttribute('aria-pressed', 'false');
    stage.classList.remove('is-typing');
  });
}
