// Browser: headless Edge on the Lumen PC renders the page and streams it here as frames; pointer,
// wheel and typing go back as browser.input in frame pixels. One shared session for every client;
// Open on TV hands the page to the TV's own browser.

import { h, icon, fill } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { haptic } from '../ui/haptics.js';

const RATE_MS = 33;          // moves and wheel deltas coalesce to ~30 messages/s
const VIEWPORT_MS = 250;     // resize settle before browser.viewport
const TAP_MS = 350;
const TAP_SLOP = 10;
const LONG_PRESS_MS = 550;
const WHEEL_LINE_PX = 40;
const VIEWPORT_MIN = 320;
const VIEWPORT_MAX = { w: 1280, h: 800 };
const SEARCH = 'https://duckduckgo.com/?q=';
const SUGGESTIONS = [['DuckDuckGo', 'https://duckduckgo.com/'], ['Wikipedia', 'https://en.wikipedia.org/'], ['YouTube', 'https://www.youtube.com/'], ['Hacker News', 'https://news.ycombinator.com/']];
const BUTTONS = ['left', 'middle', 'right'];
const SPECIAL_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const SESSION = { off: ['off', 'Browser off'], starting: ['warn', 'Starting…'], ready: ['good', 'Live'], error: ['bad', 'Error'] };

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
  const stage = h('div', { class: 'browser-stage' }, canvas, typer, overlay);

  let frame = { w: 0, h: 0 };
  let hasFrame = false;
  let painted = 0;
  let fps = 0;
  let lastUrl = null;
  let keyboardOn = false;

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
  const tvExtra = (cls, label, iconName, cmd, done) => {
    const b = h('button', { class: `btn ghost ${cls}`.trim(), type: 'button', hidden: true, 'aria-label': label }, icon(iconName), h('span', { text: label }));
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
  const keyboardBtn = h('button', { class: 'btn ghost', type: 'button', 'aria-label': 'Keyboard', 'aria-pressed': 'false' }, icon('keyboard'), h('span', { text: 'Keyboard' }));
  keyboardBtn.addEventListener('click', () => setKeyboard(!keyboardOn));

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
  const vpnButtons = [vpnButton(''), vpnButton('tool')];
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
      h('div', { class: 'browser-navgroup' }, desktopNav.back, desktopNav.forward, desktopNav.reload),
      form, vpnButtons[0], tvButton('primary'), tvExtra('browser-tvx', 'Video → TV', 'play', 'tvscreen.playVideo', 'Playing on the TV'), tvExtra('browser-tvx', 'Close TV', 'close', 'tvscreen.close', 'Closed on the TV'), closeButtons[0]),
    h('div', { class: 'browser-status' }, dot, statusText, meta, closeButtons[1]),
    vpnRow,
    stage,
    h('div', { class: 'browser-tools' }, phoneNav.back, phoneNav.forward, phoneNav.reload, keyboardBtn, vpnButtons[1], tvButton('tool'),
      tvExtra('', 'Video → TV', 'play', 'tvscreen.playVideo', 'Playing on the TV'), tvExtra('', 'Close TV', 'close', 'tvscreen.close', 'Closed on the TV')),
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
  });

  function retry() {
    open(lastUrl || url() || toUrl(address.value) || SUGGESTIONS[0][1]);
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

  // Frames paint in order; a frame that arrives mid-decode replaces any earlier waiting one, and
  // only painted frames are acked, so a slow phone simply gets fewer frames.
  async function onFrame(msg) {
    if (!showing()) return;
    if (decoding) { queued = msg; return; }
    decoding = true;
    try {
      let m = msg;
      while (m) {
        await draw(m);
        ctx.live.post('browser.ack', { seq: m.seq });
        m = queued;
        queued = null;
      }
    } catch (err) {
      console.warn('Browser frame dropped', err);
    } finally {
      decoding = false;
    }
  }

  async function draw({ data }) {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
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
    }
  }

  // The canvas keeps the frame's aspect inside the stage; the stage letterboxes the rest.
  function fit() {
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height || !frame.w) return;
    const s = Math.min(r.width / frame.w, r.height / frame.h);
    canvas.style.width = `${Math.floor(frame.w * s)}px`;
    canvas.style.height = `${Math.floor(frame.h * s)}px`;
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
    if (name === 'browser') { fit(); viewport(true); }
    else { setKeyboard(false); typer.blur(); }
  });
  ctx.on('hello', () => { sentViewport = ''; viewport(true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) viewport(true); });

  /* ---------- pointer ---------- */

  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * frame.w), y: Math.round(((e.clientY - r.top) / r.height) * frame.h) };
  };
  const scale = () => frame.w / (canvas.getBoundingClientRect().width || 1);
  const moves = coalescer(input);
  const wheels = coalescer(input, (a, b) => ({ ...b, deltaX: a.deltaX + b.deltaX, deltaY: a.deltaY + b.deltaY }));

  let touch = null;
  let longTimer = 0;

  canvas.addEventListener('pointerdown', (e) => {
    if (!frame.w) return;
    canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch') {
      if (touch) return;
      touch = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, start: performance.now(), moved: false, long: false };
      longTimer = setTimeout(() => {
        if (!touch || touch.moved) return;
        touch.long = true;
        haptic('key');
        input({ kind: 'click', ...at(e), button: 'right', modifiers: 0 });
      }, LONG_PRESS_MS);
      return;
    }
    e.preventDefault();
    moves.flush();
    input({ kind: 'down', ...at(e), button: BUTTONS[e.button] || 'left', modifiers: modifiers(e) });
    typer.focus({ preventScroll: true });
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!frame.w) return;
    if (e.pointerType === 'touch') {
      if (!touch || e.pointerId !== touch.id) return;
      const dx = e.clientX - touch.lastX;
      const dy = e.clientY - touch.lastY;
      touch.lastX = e.clientX;
      touch.lastY = e.clientY;
      if (!touch.moved && Math.hypot(e.clientX - touch.x, e.clientY - touch.y) < TAP_SLOP) return;
      touch.moved = true;
      clearTimeout(longTimer);
      // Dragging a finger scrolls the page under it, like a touch screen.
      const s = scale();
      wheels.push({ kind: 'wheel', ...at(e), deltaX: Math.round(-dx * s), deltaY: Math.round(-dy * s), modifiers: 0 });
      return;
    }
    moves.push({ kind: 'move', ...at(e), modifiers: modifiers(e) });
  });

  const endTouch = (e) => {
    if (!touch || e.pointerId !== touch.id) return;
    clearTimeout(longTimer);
    const tap = !touch.moved && !touch.long && performance.now() - touch.start < TAP_MS;
    touch = null;
    wheels.flush();
    if (tap && e.type === 'pointerup') {
      haptic('key');
      input({ kind: 'click', ...at(e), button: 'left', modifiers: 0 });
      if (keyboardOn) typer.focus({ preventScroll: true });
    }
  };

  canvas.addEventListener('pointerup', (e) => {
    if (!frame.w) return;
    if (e.pointerType === 'touch') { endTouch(e); return; }
    moves.flush();
    input({ kind: 'up', ...at(e), button: BUTTONS[e.button] || 'left', modifiers: modifiers(e) });
  });
  canvas.addEventListener('pointercancel', endTouch);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    if (!frame.w) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : 1;
    const s = scale();
    wheels.push({ kind: 'wheel', ...at(e), deltaX: Math.round(e.deltaX * unit * s), deltaY: Math.round(e.deltaY * unit * s), modifiers: modifiers(e) });
  }, { passive: false });
  canvas.addEventListener('focus', () => typer.focus({ preventScroll: true }));

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
