// Apps & Inputs: what is on screen, the installed apps grid (agent icons or brand monograms),
// and the inputs with connected dots and user-given (tracked) names.

import { h, icon, fill } from '../ui/dom.js';
import { appTile } from '../ui/apptile.js';
import { badge } from '../ui/badge.js';
import { toast } from '../ui/toast.js';
import { prettySource } from '../ui/format.js';
import { describeNow, inputList } from './remote.js';

export function mountApps(root, ctx) {
  const heroHost = h('div');
  const filter = h('input', { class: 'field app-filter', type: 'search', placeholder: 'Filter apps', 'aria-label': 'Filter apps', autocomplete: 'off' });
  const featured = h('div', { class: 'app-grid', role: 'list' });
  const others = h('div', { class: 'app-grid', role: 'list' });
  const othersHead = h('div', { class: 'section-head' }, h('h2', { text: 'All apps' }));
  const count = h('span', { class: 'view-sub' });
  const inputs = h('div', { class: 'input-list card' });

  root.append(
    h('header', { class: 'view-head' },
      h('div', null, h('h1', { class: 'view-title', text: 'Apps & Inputs' }), count),
      badge('app.installed')),
    heroHost,
    h('div', { class: 'apps-layout' },
      h('div', { class: 'apps-main' },
        h('section', { class: 'section' },
          h('div', { class: 'section-head apps-head' }, h('h2', { text: 'Your apps' }), h('div', { class: 'aside' }, filter)),
          featured),
        h('section', { class: 'section' }, othersHead, others)),
      h('section', { class: 'section apps-inputs' },
        h('div', { class: 'section-head' }, h('h2', { text: 'Inputs' })),
        inputs)),
  );

  filter.addEventListener('input', () => renderApps());
  filter.addEventListener('keydown', (e) => e.stopPropagation());

  // Each render is skipped when nothing it shows changed: polls re-publish these keys every few
  // seconds, and a rebuilt button would swallow a click (or drop an open rename field).
  let heroShown = '';
  let appsShown = '';
  let inputsShown = '';

  function renderHero() {
    const now = describeNow(ctx);
    const fg = ctx.state.value('app.foreground', null);
    const signature = JSON.stringify([now, Boolean(fg)]);
    if (signature === heroShown) return;
    heroShown = signature;
    fill(heroHost, h('div', { class: 'now-hero card' },
      h('div', { class: 'tv-frame', 'aria-hidden': 'true' }, h('div', { class: 'tv-screen' }, appTile(now.app, { size: 64, iconName: now.iconName }))),
      h('div', { class: 'now-hero-text' },
        h('span', { class: 'silk', text: 'On screen now' }),
        h('div', { class: 'now-hero-title', text: now.title }),
        h('div', { class: 'now-sub' }, now.parts.join(' · ')),
        h('div', { class: 'now-hero-meta' }, badge(now.key, { compact: true }),
          fg ? h('button', { class: 'btn sm ghost', type: 'button', onClick: () => ctx.key('KEY_HOME') }, icon('home'), 'Home') : null))));
  }

  function tile(app, current) {
    const btn = h('button', {
      class: `app-btn${current ? ' is-current' : ''}`,
      type: 'button',
      role: 'listitem',
      'aria-label': `${app.name}${current ? ', on screen' : ''}`,
      title: app.name,
    }, appTile(app), h('span', { class: 'app-name', text: app.name }), current ? h('i', { class: 'app-live', 'aria-hidden': 'true' }) : null);
    btn.addEventListener('click', async () => {
      btn.classList.add('is-launching');
      const ack = await ctx.cmd('app.launch', { appId: app.id }, { el: btn, timeoutMs: 20000 });
      btn.classList.remove('is-launching');
      if (ack.ok) toast(`Opening ${app.name}`, { level: 'ok', timeout: 2000 });
    });
    return btn;
  }

  function renderApps() {
    const q = filter.value.trim().toLowerCase();
    const fg = ctx.state.value('app.foreground', null)?.id;
    const signature = JSON.stringify([q, fg, ctx.apps(), ctx.catalog.apps.length]);
    if (signature === appsShown) return;
    appsShown = signature;
    const curated = new Set(ctx.catalog.apps.map((a) => a.id));
    const all = ctx.apps().filter((a) => a.id && a.name && (!q || a.name.toLowerCase().includes(q)));
    const order = new Map(ctx.catalog.apps.map((a, i) => [a.id, i]));
    const top = all.filter((a) => curated.has(a.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
    const rest = all.filter((a) => !curated.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
    fill(featured, ...(top.length ? top : rest.splice(0, 12)).map((a) => tile(a, a.id === fg)));
    fill(others, ...rest.map((a) => tile(a, a.id === fg)));
    othersHead.parentElement.hidden = !rest.length;
    if (!all.length) fill(featured, h('div', { class: 'empty', text: q ? 'No app matches that filter' : 'No apps reported yet' }));
    const n = ctx.apps().length;
    count.textContent = n ? `${n} app${n === 1 ? '' : 's'} on the TV` : '';
  }

  function renderInputs() {
    const current = ctx.state.value('input.source', null);
    const labels = ctx.state.value('input.labels', {}) || {};
    const signature = JSON.stringify([current, labels, inputList(ctx)]);
    if (signature === inputsShown || inputs.querySelector('.input-edit')) return;
    inputsShown = signature;
    fill(inputs, ...inputList(ctx).map(({ source, connected }) => inputRow(ctx, source, labels[source], connected, source === current)),
      h('div', { class: 'input-foot' },
        h('span', { class: 'muted', text: 'Names are yours — Lumen tracks them, the TV does not report them.' }),
        h('button', { class: 'btn sm ghost', type: 'button', onClick: () => ctx.key('KEY_SOURCE') }, icon('source'), 'Source bar on TV')));
  }

  ctx.state.watch(['app.*', 'channel.current', 'input.source', 'conn.tv'], () => { renderHero(); renderApps(); });
  ctx.state.watch(['input.*'], renderInputs);
  ctx.on('hello', renderApps);
}

function inputRow(ctx, source, label, connected, current) {
  const name = h('span', { class: 'input-name', text: label || prettySource(source) });
  const code = h('span', { class: 'input-code mono', text: label ? prettySource(source) : connected === false ? 'Not connected' : connected ? 'Connected' : '' });
  const select = h('button', { class: `input-main${current ? ' is-current' : ''}`, type: 'button', 'aria-pressed': current ? 'true' : 'false', 'aria-label': `Switch to ${label || prettySource(source)}` },
    h('i', { class: `status-dot ${connected ? 'good' : connected === false ? 'off' : 'warn'}`, 'aria-hidden': 'true' }),
    h('span', { class: 'input-text' }, name, code),
    current ? h('span', { class: 'chip is-active', text: 'Current' }) : null);
  select.addEventListener('click', async () => {
    if (current) return;
    select.classList.add('is-pending');
    await ctx.cmd('input.set', { source }, { el: select });
    select.classList.remove('is-pending');
  });
  const rename = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Rename ${prettySource(source)}`, title: 'Rename' }, icon('edit', 'sm'));
  const row = h('div', { class: 'input-row' }, select, label ? badge('input.labels', { compact: true }) : null, rename);
  rename.addEventListener('click', () => {
    const field = h('input', { class: 'field', value: label || '', placeholder: prettySource(source), maxlength: 24, 'aria-label': `Name for ${prettySource(source)}` });
    const save = h('button', { class: 'btn sm primary', type: 'button', text: 'Save' });
    const cancel = h('button', { class: 'btn sm ghost', type: 'button', text: 'Cancel' });
    const editor = h('div', { class: 'input-edit' }, field, save, cancel);
    fill(row, editor);
    field.focus();
    const commit = async () => {
      const ack = await ctx.cmd('input.label', { source, label: field.value.trim() }, { el: editor });
      if (ack.ok) toast(field.value.trim() ? `${prettySource(source)} is now “${field.value.trim()}”` : 'Name cleared', { level: 'ok', timeout: 2000 });
    };
    const restore = () => row.replaceWith(inputRow(ctx, source, label, connected, current));
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') restore();
    });
    save.addEventListener('click', commit);
    cancel.addEventListener('click', restore);
  });
  return row;
}
