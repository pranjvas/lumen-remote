// Cast: paste a link (type detected as you type), or drop / pick a local file (uploaded raw to
// POST /api/cast/upload with X-Lumen-CSRF + X-File-Name), and the now-casting card.

import { h, icon, fill } from '../ui/dom.js';
import { createSlider } from '../ui/slider.js';
import { badge } from '../ui/badge.js';
import { toast } from '../ui/toast.js';
import { bytes, duration } from '../ui/format.js';

const MEDIA_EXT = /\.(mp4|m4v|mkv|webm|mov|avi|ts|m2ts|mts|mpg|mpeg|wmv|3gp|mp3|m4a|aac|flac|wav|ogg|oga|opus|wma|jpe?g|png|gif|bmp|webp|m3u8)(?:$|[?#])/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|wma)(?:$|[?#])/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|bmp|webp)(?:$|[?#])/i;

function classifyLink(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return { kind: 'invalid', title: 'That does not look like a link', detail: 'Paste a full address, e.g. https://youtu.be/…' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'invalid', title: 'Only web links can be cast', detail: `${url.protocol} links are not supported` };
  }
  const host = url.hostname.replace(/^(www|m)\./, '');
  const path = url.pathname;
  let m;
  if (host === 'youtu.be' && (m = /^\/([\w-]{11})/.exec(path))) return yt(m[1], url);
  if (/(^|\.)youtube\.com$/.test(host)) {
    const id = url.searchParams.get('v') || /^\/(?:shorts|live|embed)\/([\w-]{11})/.exec(path)?.[1];
    if (id) return yt(id, url);
  }
  if (/(^|\.)netflix\.com$/.test(host) && (m = /\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(title|watch)\/(\d+)/i.exec(path))) {
    return { kind: 'netflix', url: url.href, icon: 'film', title: 'Netflix title', detail: `Opens title ${m[2]} in the Netflix app`, id: m[2], color: '#E50914' };
  }
  if (/(^|\.)primevideo\.com$/.test(host) || (/(^|\.)amazon\.[a-z.]+$/.test(host) && /\/gp\/video\//.test(path))) {
    return { kind: 'prime', url: url.href, icon: 'film', title: 'Prime Video', detail: 'Opens in the Prime Video app', color: '#00A8E1' };
  }
  if (MEDIA_EXT.test(path)) {
    const name = decodeURIComponent(path.split('/').pop() || 'media');
    const sort = AUDIO_EXT.test(path) ? 'Audio file' : IMAGE_EXT.test(path) ? 'Image' : /\.m3u8/i.test(path) ? 'Live stream (HLS)' : 'Video file';
    return { kind: 'media', url: url.href, icon: AUDIO_EXT.test(path) ? 'music' : IMAGE_EXT.test(path) ? 'photo' : 'film', title: sort, detail: `${name} · plays on the TV's media player (DLNA)` };
  }
  return { kind: 'page', url: url.href, icon: 'globe', title: 'Web page', detail: `${host} · opens in the TV browser` };
}

function yt(id, url) {
  return { kind: 'youtube', url: url.href, icon: 'play', title: 'YouTube video', detail: `Opens video ${id} in the YouTube app`, id, color: '#FF0000' };
}

const ROUTES = [
  ['apps', 'In its own app', 'YouTube, Netflix and Prime Video links'],
  ['film', 'On the media player', 'Video, music and photo files, HLS streams'],
  ['globe', 'In the TV browser', 'Any other web page'],
];

const STATE_LABEL = {
  PLAYING: 'Playing',
  PAUSED_PLAYBACK: 'Paused',
  STOPPED: 'Stopped',
  TRANSITIONING: 'Loading…',
  NO_MEDIA_PRESENT: 'Nothing loaded',
};

export function mountCast(root, ctx) {
  // ---- link ----
  const field = h('input', { class: 'field cast-field', type: 'url', inputmode: 'url', placeholder: 'Paste a YouTube, Netflix, Prime or media link', 'aria-label': 'Link to cast', autocomplete: 'off', spellcheck: 'false' });
  const paste = navigator.clipboard?.readText
    ? h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Paste from clipboard' }, icon('clipboard'), 'Paste')
    : null;
  const go = h('button', { class: 'btn primary', type: 'button', disabled: true }, icon('cast'), 'Cast');
  const preview = h('div', { class: 'cast-preview', 'aria-live': 'polite' });

  function paintPreview() {
    const c = classifyLink(field.value);
    go.disabled = !c || c.kind === 'invalid';
    if (!c) {
      fill(preview, h('div', { class: 'cast-routes' }, ROUTES.map(([iconName, title, text]) =>
        h('div', { class: 'cast-route' }, h('span', { class: 'cast-kind-icon' }, icon(iconName)), h('span', null, h('b', { text: title }), h('span', { class: 'muted', text }))))));
      return;
    }
    fill(preview, h('div', { class: `cast-kind kind-${c.kind}`, style: c.color ? { '--c': c.color } : null },
      h('span', { class: 'cast-kind-icon' }, icon(c.icon || 'alert')),
      h('span', null, h('b', { text: c.title }), h('span', { class: 'muted', text: c.detail }))));
  }

  async function castLink() {
    const c = classifyLink(field.value);
    if (!c || c.kind === 'invalid') return;
    go.classList.add('is-busy');
    const ack = await ctx.cmd('cast.url', { url: c.url }, { el: go, timeoutMs: 30000 });
    go.classList.remove('is-busy');
    if (ack.ok) toast(`Casting ${c.title.toLowerCase()} to the TV`, { level: 'ok' });
  }

  field.addEventListener('input', paintPreview);
  field.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') castLink();
  });
  go.addEventListener('click', castLink);
  paste?.addEventListener('click', async () => {
    try {
      field.value = (await navigator.clipboard.readText()).trim();
      paintPreview();
      field.focus();
    } catch {
      toast('The browser blocked clipboard access — paste with Ctrl+V', { level: 'warn' });
    }
  });

  // ---- file ----
  const picker = h('input', { type: 'file', accept: 'video/*,audio/*,image/*,.mkv,.m3u8', hidden: true });
  const choose = h('button', { class: 'btn', type: 'button' }, icon('upload'), 'Choose a file');
  const progressFill = h('i');
  const progressText = h('span', { class: 'mono muted' });
  const fileInfo = h('div', { class: 'upload-info', hidden: true },
    h('div', { class: 'upload-name' }), h('div', { class: 'meter upload-meter' }, progressFill), progressText);
  const drop = h('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': 'Drop a file here or choose one to cast' },
    h('span', { class: 'dropzone-icon' }, icon('upload', 'lg')),
    h('div', { class: 'dropzone-text' }, h('b', { text: 'Drop a video, song or photo' }), h('span', { class: 'muted', text: 'It streams from this PC to the TV · up to 4 GB' })),
    choose, picker, fileInfo);

  choose.addEventListener('click', (e) => { e.stopPropagation(); picker.click(); });
  drop.addEventListener('click', (e) => { if (e.target === drop) picker.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } });
  picker.addEventListener('change', () => { if (picker.files?.[0]) upload(picker.files[0]); picker.value = ''; });
  for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  for (const type of ['dragleave', 'drop']) drop.addEventListener(type, () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) upload(file);
  });

  let uploading = false;
  function upload(file) {
    if (uploading) return;
    if (!ctx.csrf) { toast('Not connected to Lumen yet', { level: 'warn' }); return; }
    uploading = true;
    drop.classList.add('is-uploading');
    fileInfo.hidden = false;
    fileInfo.querySelector('.upload-name').textContent = file.name;
    progressFill.style.setProperty('--pct', '0%');
    progressText.textContent = `0% of ${bytes(file.size)}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/cast/upload');
    xhr.setRequestHeader('X-Lumen-CSRF', ctx.csrf);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      progressFill.style.setProperty('--pct', `${pct}%`);
      progressText.textContent = `${pct}% of ${bytes(e.total)}`;
    };
    const finish = () => { uploading = false; drop.classList.remove('is-uploading'); };
    xhr.onerror = () => { finish(); progressText.textContent = 'Upload failed'; toast('Upload failed — is Lumen still running?', { level: 'error' }); };
    xhr.onload = async () => {
      finish();
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status !== 201 || !body?.fileId) {
        progressText.textContent = 'Upload refused';
        toast(body?.error?.message || `Upload refused (${xhr.status})`, { level: 'error' });
        return;
      }
      progressText.textContent = `Uploaded · ${bytes(body.size)} · casting…`;
      const ack = await ctx.cmd('cast.file', { fileId: body.fileId, name: body.name || file.name }, { el: drop, timeoutMs: 30000 });
      progressText.textContent = ack.ok ? `Sent to the TV · ${bytes(body.size)}` : 'Upload done, casting failed';
    };
    xhr.send(file);
  }

  // ---- now casting ----
  const nowHost = h('div');

  root.append(
    h('header', { class: 'view-head' }, h('div', null, h('h1', { class: 'view-title', text: 'Cast' }), h('p', { class: 'view-sub', text: 'Send a link or a file from this PC to the TV' }))),
    nowHost,
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'Link' })),
      h('div', { class: 'card card-pad cast-link' }, h('div', { class: 'cast-row' }, h('span', { class: 'cast-field-icon' }, icon('link')), field, paste, go), preview)),
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'File from this PC' })), drop),
  );
  paintPreview();
  mountNowCasting(nowHost, ctx);
}

function mountNowCasting(host, ctx) {
  const card = h('section', { class: 'card now-casting', 'aria-label': 'Now casting', hidden: true });
  host.append(card);
  let ticker = null;
  let shape = '';
  let live = { s: null, rec: null };
  let seek = null;
  let posText = null;

  const hasTimeline = (s) => s.kind === 'dlna' && Number.isFinite(s.duration) && s.duration > 0;
  const livePos = () => {
    const { s, rec } = live;
    const base = Number.isFinite(s.position) ? s.position : 0;
    const extra = s.state === 'PLAYING' && rec.at ? (Date.now() - rec.at) / 1000 : 0;
    return Math.min(hasTimeline(s) ? s.duration : Infinity, base + extra);
  };
  const tick = () => {
    if (!posText) return;
    const p = livePos();
    if (!seek?.busy) posText.textContent = duration(p);
    seek?.set(Math.round(p));
  };

  function build(s) {
    const controllable = s.kind === 'dlna';
    const playing = s.state === 'PLAYING';
    posText = h('span', { class: 'mono' });
    seek = hasTimeline(s)
      ? createSlider({
        min: 0, max: Math.round(s.duration), step: 1, value: Math.round(livePos()), label: 'Position', format: (v) => duration(v), ticks: false,
        onInput: (v) => { posText.textContent = duration(v); },
        onCommit: (v) => ctx.cmd('cast.control', { action: 'seek', position: v }),
      })
      : null;
    const ctl = (action, iconName, label, cls = 'key round') => {
      const b = h('button', { class: cls, type: 'button', 'aria-label': label, title: label }, icon(iconName));
      b.addEventListener('click', () => ctx.cmd('cast.control', { action }, { el: b }));
      return b;
    };
    const kindLabel = { dlna: 'Media player', dial: 'App', browser: 'TV browser' }[s.kind] || s.kind;
    fill(card, 
      h('div', { class: 'now-casting-head' },
        h('span', { class: `cast-state${playing ? ' is-playing' : ''}`, 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        h('div', { class: 'now-casting-text' },
          h('span', { class: 'silk', text: `Now casting · ${kindLabel}` }),
          h('div', { class: 'now-casting-title', text: s.title || s.uri || 'Untitled' }),
          h('span', { class: 'muted', text: controllable ? STATE_LABEL[s.state] || s.state : `${STATE_LABEL[s.state] || 'Sent'} · control it with the remote` })),
        badge('cast.session', { compact: true })),
      seek ? h('div', { class: 'scrubber' }, posText, seek.el, h('span', { class: 'mono muted', text: duration(s.duration) })) : null,
      controllable ? h('div', { class: 'transport' },
        playing ? ctl('pause', 'pause', 'Pause', 'key round hero') : ctl('play', 'play', 'Play', 'key round hero'),
        ctl('stop', 'stop', 'Stop')) : null,
    );
  }

  ctx.state.watch('cast.session', () => {
    const rec = ctx.state.get('cast.session');
    const s = rec?.v;
    clearInterval(ticker);
    if (!s || s.state === 'NO_MEDIA_PRESENT') {
      card.hidden = true;
      shape = '';
      return;
    }
    card.hidden = false;
    live = { s, rec };
    const next = [s.kind, s.title, s.uri, s.state, s.duration].join('|');
    if (next !== shape) {
      shape = next;
      build(s);
    }
    tick();
    if (s.state === 'PLAYING' && hasTimeline(s)) ticker = setInterval(tick, 1000);
  });
}
