// App tile: the agent-provided icon when present, else a brand-colour monogram.

import { h, icon } from './dom.js';
import { isLightColor } from './tint.js';

function glyphFor(app) {
  if (app?.short) return app.short;
  const name = String(app?.name || '?').replace(/^(the|samsung)\s+/i, '');
  return name.slice(0, 1).toUpperCase();
}

// size (px) is optional: without it the surrounding CSS decides through --size. iconName replaces
// the monogram (e.g. 'power' while the TV sleeps, 'hdmi' for an input).
export function appTile(app, { size, iconName } = {}) {
  const color = app?.color || null;
  const glyph = glyphFor(app);
  const tile = h('span', {
    class: `app-tile${app ? '' : ' none'}${color && isLightColor(color) ? ' is-light' : ''}`,
    dataset: { len: String(Math.min(3, [...glyph].length)) },
    style: { '--size': size ? `${size}px` : null, '--c': color },
    'aria-hidden': 'true',
  }, iconName ? icon(iconName) : glyph);
  if (app?.icon) {
    const img = h('img', { src: app.icon, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    img.addEventListener('error', () => img.remove(), { once: true });
    tile.append(img);
  }
  return tile;
}
