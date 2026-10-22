// Keys: number pad, colour keys, media transport and the extra keys from the catalogue.

import { h, icon, fill } from '../ui/dom.js';
import { bindKey } from '../ui/press.js';

const ICONS = {
  KEY_INFO: 'info', KEY_GUIDE: 'guide', KEY_TOOLS: 'tools', KEY_EXIT: 'exit', KEY_SOURCE: 'source',
  KEY_CAPTION: 'caption', KEY_SUB_TITLE: 'caption', KEY_PICTURE_SIZE: 'aspect', KEY_ASPECT: 'aspect',
  KEY_AMBIENT: 'ambient', KEY_PMODE: 'pmode', KEY_SOUND_MODE: 'smode', KEY_SLEEP: 'sleep', KEY_MENU: 'tvmenu',
  KEY_HOME: 'home', KEY_RETURN: 'back', KEY_CH_LIST: 'list', KEY_MULTI_VIEW: 'multiview', KEY_AD: 'ad',
  KEY_TV: 'tv', KEY_HDMI: 'hdmi', KEY_MORE: 'more', KEY_BT_VOICE: 'mic', KEY_ESAVING: 'leaf', KEY_MTS: 'smode',
  KEY_INTERNET: 'globe', KEY_CONTENTS: 'apps', KEY_APP_LIST: 'apps', KEY_PRECH: 'back', KEY_FAVCH: 'star',
};

const EXTRA_DEFAULTS = [
  ['KEY_INFO', 'Info'], ['KEY_GUIDE', 'Guide'], ['KEY_TOOLS', 'Tools'], ['KEY_EXIT', 'Exit'],
  ['KEY_SOURCE', 'Source'], ['KEY_CAPTION', 'Caption'], ['KEY_PICTURE_SIZE', 'Picture size'], ['KEY_AMBIENT', 'Ambient'],
  ['KEY_PMODE', 'Picture mode'], ['KEY_SOUND_MODE', 'Sound mode'], ['KEY_SLEEP', 'Sleep'], ['KEY_AD', 'Audio description'],
  ['KEY_MULTI_VIEW', 'Multi View'], ['KEY_TV', 'Live TV'], ['KEY_HDMI', 'HDMI'], ['KEY_MORE', '123 / More'],
];

const ON_REMOTE = new Set([
  'KEY_UP', 'KEY_DOWN', 'KEY_LEFT', 'KEY_RIGHT', 'KEY_ENTER', 'KEY_RETURN', 'KEY_HOME', 'KEY_MENU', 'KEY_POWER',
  'KEY_VOLUP', 'KEY_VOLDOWN', 'KEY_MUTE', 'KEY_CHUP', 'KEY_CHDOWN', 'KEY_CH_LIST', 'KEY_PRECH',
  'KEY_PLAY', 'KEY_PAUSE', 'KEY_STOP', 'KEY_FF', 'KEY_REWIND', 'KEY_REC', 'KEY_PLAY_BACK',
  'KEY_RED', 'KEY_GREEN', 'KEY_YELLOW', 'KEY_BLUE', 'KEY_CYAN',
]);

export function mountKeys(root, ctx) {
  const body = h('div');
  root.append(body);

  function key(code, label, { cls = 'key', iconName = ICONS[code], text } = {}) {
    const info = ctx.keyInfo(code);
    const name = info?.label || label;
    const b = h('button', { class: cls, type: 'button', 'aria-label': name, title: name },
      iconName ? icon(iconName) : null,
      text ?? (iconName ? h('span', { class: 'silk', text: name }) : h('span', { class: 'key-text', text: name })));
    bindKey(b, ctx, code);
    if (ctx.catalog.keys.length && !info) b.disabled = true;
    return b;
  }

  function build() {
    const pad = h('div', { class: 'numpad', role: 'group', 'aria-label': 'Number pad' },
      ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => key(`KEY_${d}`, d, { iconName: null, text: h('span', { class: 'digit num', text: d }) })),
      key('KEY_PRECH', 'Pre-Ch', { iconName: null, text: h('span', { class: 'silk', text: 'Pre-Ch' }) }),
      key('KEY_0', '0', { iconName: null, text: h('span', { class: 'digit num', text: '0' }) }),
      key('KEY_CH_LIST', 'Ch list', { iconName: null, text: h('span', { class: 'silk', text: 'Ch List' }) }));

    const blue = ctx.hasKey('KEY_BLUE') ? 'KEY_BLUE' : 'KEY_CYAN';
    const colours = h('div', { class: 'colour-keys', role: 'group', 'aria-label': 'Colour keys' },
      [['KEY_RED', 'Red', 'red'], ['KEY_GREEN', 'Green', 'green'], ['KEY_YELLOW', 'Yellow', 'yellow'], [blue, 'Blue', 'blue']].map(([code, label, c]) =>
        key(code, label, { cls: `key colour ${c}`, iconName: null, text: h('span', { class: 'sr-only', text: label }) })));

    const playKey = ctx.hasKey('KEY_PLAY_BACK') ? 'KEY_PLAY_BACK' : 'KEY_PLAY';
    const media = h('div', { class: 'media-keys', role: 'group', 'aria-label': 'Media transport' },
      key('KEY_REWIND', 'Rewind', { iconName: 'rew' }),
      key(playKey, 'Play / Pause', { cls: 'key hero', iconName: 'playpause' }),
      key('KEY_FF', 'Fast forward', { iconName: 'ff' }),
      key('KEY_PLAY', 'Play', { iconName: 'play' }),
      key('KEY_PAUSE', 'Pause', { iconName: 'pause' }),
      key('KEY_STOP', 'Stop', { iconName: 'stop' }),
      key('KEY_REC', 'Record', { iconName: 'rec', cls: 'key rec' }));

    const fromCatalog = ctx.catalog.keys.filter((k) => ['extra', 'menu', 'picture', 'sound', 'smart', 'input'].includes(k.group) && !ON_REMOTE.has(k.key) && !/^KEY_\d$/.test(k.key));
    const extras = (fromCatalog.length ? fromCatalog.map((k) => [k.key, k.label]) : EXTRA_DEFAULTS)
      .map(([code, label]) => key(code, label, { cls: 'key extra' }));

    fill(body, 
      h('header', { class: 'view-head' }, h('div', null, h('h1', { class: 'view-title', text: 'Keys' }), h('p', { class: 'view-sub', text: 'Everything on the physical remote, and a few keys it hides' }))),
      h('div', { class: 'keys-layout' },
        h('section', { class: 'section keys-numbers' }, h('div', { class: 'section-head' }, h('h2', { text: 'Numbers' })), pad),
        h('div', { class: 'keys-side' },
          h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'Colour keys' })), colours),
          h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'Media' })), media))),
      h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { text: 'More keys' })), h('div', { class: 'extra-keys' }, extras)),
    );
  }

  ctx.on('hello', build);
  build();
}
