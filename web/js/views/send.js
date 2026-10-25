// Send to TV: a page from the phone's own browser (Brave, Safari) sent to the TV in one tap, through the
// share sheet's "Play on TV" shortcut or the "▶ TV" bookmarklet (Settings → This phone shows both):
//   http://<this PC>:<port>/#/send?url=<page address>
// YouTube, Netflix and Prime Video links open in their TV apps and media files on the TV's player (as
// Cast does); any other page opens in Lumen's browser on the TV, which hands its video to the TV's
// player by itself. Lumen's browser is its own: the phone's sign-ins do not come along.

import { h, icon, fill } from '../ui/dom.js';
import { openSheet } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';
import { classifyLink } from './cast.js';

const SENT_KEY = 'lumen.sent'; // the last link sent from this tab: a reload does not send it again

export function mountSend(root, ctx) {
  const title = h('h1', { class: 'view-title', text: 'Send to TV' });
  const sub = h('p', { class: 'view-sub' });
  const status = h('div', { class: 'send-status' });
  const actions = h('div', { class: 'send-actions' });
  root.append(h('header', { class: 'view-head' }, h('div', null, title, sub)), h('section', { class: 'card card-pad send-card' }, status, actions));

  let link = null; // classifyLink() of the link being sent
  let phase = 'idle'; // sending · page · app · failed
  let error = null;
  let unwatch = null;

  const back = h('button', { class: 'btn primary', type: 'button' }, icon('back'), 'Back to the page');
  back.addEventListener('click', () => { if (history.length > 1) history.back(); else window.close(); });
  const browserBtn = h('a', { class: 'btn ghost', href: '#/browser' }, icon('globe'), 'Lumen’s browser');
  const play = h('button', { class: 'btn ghost', type: 'button' }, icon('play'), 'Play the video on the TV');
  play.addEventListener('click', async () => {
    const ack = await ctx.cmd('tvscreen.playVideo', {}, { el: play, timeoutMs: 45000 });
    if (ack.ok) toast('Playing on the TV', { level: 'ok' });
  });
  const retry = h('button', { class: 'btn ghost', type: 'button' }, icon('refresh'), 'Try again');
  retry.addEventListener('click', () => send(true));
  const remote = h('a', { class: 'btn ghost', href: '#/remote' }, icon('remote'), 'Remote');

  function line(iconName, text, cls = '') {
    return h('p', { class: `send-line ${cls}` }, icon(iconName), h('span', { text }));
  }

  function paint() {
    if (!link) {
      sub.textContent = 'Send pages from your phone’s browser to the TV';
      fill(status, line('info', 'Nothing to send. Share a page with “Play on TV”, or tap the “▶ TV” bookmark on it.'));
      const setup = h('button', { class: 'btn primary', type: 'button' }, icon('settings'), 'Set it up');
      setup.addEventListener('click', () => showSendSetup());
      fill(actions, setup, remote);
      return;
    }
    sub.textContent = link.kind === 'page' ? `${new URL(link.url).hostname.replace(/^www\./, '')} · in Lumen’s browser on the TV` : link.detail;
    if (phase === 'sending') {
      fill(status, line('cast', 'Sending to the TV…', 'is-busy'));
      fill(actions, back);
      return;
    }
    if (phase === 'failed') {
      fill(status, line('alert', error || 'It could not be sent', 'is-bad'));
      fill(actions, retry, back, remote);
      return;
    }
    if (phase === 'app') {
      fill(status, line('check', `On the TV: ${link.title}`, 'is-good'));
      fill(actions, back, remote);
      return;
    }
    // A page in Lumen's browser on the TV: what the TV shows of it now.
    const on = ctx.state.value('tvscreen.on', false) === true;
    const video = ctx.state.value('tvscreen.video', null);
    const notice = ctx.state.value('tvscreen.notice', null);
    const recent = notice && Date.now() - (notice.at ?? 0) < 60000 ? notice : null;
    const lines = [];
    if (video === 'playing') lines.push(line('check', 'Playing on the TV', 'is-good'));
    else if (video === 'loading' || video === 'buffering') lines.push(line('play', 'Starting the video on the TV…', 'is-busy'));
    else if (on) lines.push(line('check', 'The page is on the TV. Its video goes to the TV’s player once it starts.', 'is-good'));
    else lines.push(line('cast', 'Opening the page on the TV…', 'is-busy'));
    if (recent) lines.push(line(recent.level === 'warn' ? 'alert' : 'info', recent.text, recent.level === 'warn' ? 'is-bad' : ''));
    fill(status, ...lines);
    fill(actions, back, video === 'playing' ? null : play, browserBtn);
  }

  // Opened from the share sheet or a bookmark, this page has only just started: its link to Lumen
  // (and Lumen's first hello) comes a moment later. → whether it came within the wait.
  function linkUp(timeoutMs = 10000) {
    if (ctx.live.status === 'open' && document.documentElement.dataset.ready === '1') return Promise.resolve(true);
    return new Promise((resolve) => {
      let off = null;
      const timer = setTimeout(() => { off?.(); resolve(false); }, timeoutMs);
      off = ctx.on('hello', () => { clearTimeout(timer); off?.(); resolve(true); });
    });
  }

  async function send(again = false) {
    if (!link || link.kind === 'invalid') return;
    try { if (!again && sessionStorage.getItem(SENT_KEY) === link.url) { phase = link.kind === 'page' ? 'page' : 'app'; paint(); return; } } catch { /* private mode */ }
    phase = 'sending';
    error = null;
    paint();
    if (!(await linkUp())) {
      phase = 'failed';
      error = 'Lumen does not answer. Is this phone on the home network, and Lumen running on the PC?';
      paint();
      return;
    }
    const ack = link.kind === 'page'
      ? await ctx.cmd('browser.openOnTv', { url: link.url }, { timeoutMs: 45000, silent: true })
      : await ctx.cmd('cast.url', { url: link.url }, { timeoutMs: 30000, silent: true });
    if (!ack.ok) {
      phase = 'failed';
      error = ack.error?.code === 'TV_OFF' ? 'The TV is off. Turn it on, then try again.' : ack.error?.message;
    } else {
      phase = link.kind === 'page' ? 'page' : 'app';
      try { sessionStorage.setItem(SENT_KEY, link.url); } catch { /* private mode */ }
    }
    paint();
  }

  ctx.on('view', (name) => {
    unwatch?.();
    unwatch = null;
    if (name !== 'send') return;
    const raw = ctx.route?.params?.get('url') ?? '';
    const next = raw ? classifyLink(raw) : null;
    if (next?.kind === 'invalid') {
      link = null;
      sub.textContent = 'This link cannot be sent';
      fill(status, line('alert', `${next.title}. ${next.detail}`, 'is-bad'));
      fill(actions, remote);
      return;
    }
    if (!next || next.url !== link?.url) phase = 'idle';
    link = next;
    unwatch = ctx.state.watch(['tvscreen.on', 'tvscreen.video', 'tvscreen.notice'], () => { if (phase === 'page') paint(); });
    paint();
    if (link && phase === 'idle') send();
  });
}

/* ---------- set-up: the share sheet shortcut and the bookmarklet ---------- */

// This PC's address as the phone reaches it (the page was opened through it).
const sendBase = () => `${location.origin}/#/send?url=`;
export const bookmarklet = () => `javascript:location.href='${sendBase()}'+encodeURIComponent(location.href)`;

export function showSendSetup() {
  openSheet({
    title: 'Send pages to the TV',
    className: 'send-sheet',
    build(body, sheet) {
      const copy = (text, what) => async () => {
        try { await navigator.clipboard.writeText(text); toast(`${what} copied`, { level: 'ok' }); } catch { toast('Copy it by hand: select the text and copy', { level: 'warn' }); }
      };
      const code = bookmarklet();
      const copyCode = h('button', { class: 'btn ghost sm', type: 'button' }, icon('clipboard'), 'Copy');
      copyCode.addEventListener('click', copy(code, 'Bookmarklet'));
      const base = sendBase();
      const copyBase = h('button', { class: 'btn ghost sm', type: 'button' }, icon('clipboard'), 'Copy');
      copyBase.addEventListener('click', copy(base, 'Address'));
      const done = h('button', { class: 'btn ghost', type: 'button', text: 'Got it' });
      done.addEventListener('click', () => sheet.close());
      body.append(
        h('p', { text: 'Browse in Brave or Safari on this phone, and send the page you are on to the TV in one tap. It opens in Lumen’s browser on the TV, which plays its video on the TV’s player (YouTube, Netflix and Prime Video links open in their TV apps). Lumen’s browser has its own sign-ins.' }),
        h('h3', { text: 'From the Share button (works in Brave, Safari and other apps)' }),
        h('ol', { class: 'install-steps' },
          h('li', {}, 'Open the ', h('b', { text: 'Shortcuts' }), ' app, tap ', h('b', { text: '+' }), ' and name the shortcut ', h('b', { text: 'Play on TV' }), '.'),
          h('li', {}, 'Tap ', h('b', { text: 'ⓘ' }), ' and turn on ', h('b', { text: 'Show in Share Sheet' }), ' (it takes URLs and Safari web pages).'),
          h('li', {}, 'Add the action ', h('b', { text: 'URL Encode' }), ' (it encodes the Shortcut Input).'),
          h('li', {}, 'Add ', h('b', { text: 'Open URLs' }), ' and type this address, then add the ', h('b', { text: 'URL Encoded Text' }), ' variable right after it:'),
          h('li', { class: 'send-code-row' }, h('code', { class: 'send-code', text: base }), copyBase),
          h('li', {}, 'In Brave, tap ', h('b', { text: 'Share' }), ' → ', h('b', { text: 'Play on TV' }), '.')),
        h('h3', { text: 'Or a “▶ TV” bookmark' }),
        h('ol', { class: 'install-steps' },
          h('li', {}, 'Bookmark any page in Brave, then edit the bookmark: name it ', h('b', { text: '▶ TV' }), ' and replace its address with:'),
          h('li', { class: 'send-code-row' }, h('code', { class: 'send-code', text: code }), copyCode),
          h('li', {}, 'On a page you want on the TV, open your bookmarks and tap ', h('b', { text: '▶ TV' }), '.')),
        h('p', { class: 'muted', text: 'Both work on your home network, while Lumen runs on this PC.' }),
        h('div', { class: 'sheet-actions' }, done),
      );
    },
  });
}
