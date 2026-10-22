// Precise volume control: big readout, detented slider (ignores updates while dragging + 1 s), ±, mute.

import { h, icon } from '../ui/dom.js';
import { openSheet } from '../ui/sheet.js';
import { createSlider } from '../ui/slider.js';
import { badge } from '../ui/badge.js';

export function openVolumeSheet(ctx) {
  let unsubscribe = null;
  openSheet({
    title: 'Volume',
    onClose: () => unsubscribe?.(),
    build(body) {
      const num = h('span', { class: 'num', text: '—' });
      const readout = h('div', { class: 'vol-sheet-readout' }, num, badge('audio.volume'));
      const slider = createSlider({
        min: 0,
        max: 100,
        step: 1,
        value: ctx.volume.shown() ?? 0,
        label: 'Volume',
        big: true,
        detents: true,
        format: (v) => `Volume ${v}`,
        onInput: (v) => {
          num.textContent = String(v);
          ctx.volume.set(v);
        },
      });
      slider.el.setAttribute('autofocus', '');
      const minus = h('button', { class: 'key round', type: 'button', 'aria-label': 'Volume down' }, icon('minus'));
      const plus = h('button', { class: 'key round', type: 'button', 'aria-label': 'Volume up' }, icon('plus'));
      minus.addEventListener('click', () => ctx.volume.step(-1));
      plus.addEventListener('click', () => ctx.volume.step(1));

      const muteSwitch = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': 'Mute' });
      muteSwitch.addEventListener('click', () => ctx.volume.toggleMute({ el: muteSwitch }));

      body.append(
        readout,
        h('div', { class: 'vol-sheet-row' }, minus, slider.el, plus),
        h('div', { class: 'vol-sheet-meta' },
          h('label', null, muteSwitch, 'Mute'),
          h('span', { class: 'muted', style: { fontSize: '12.5px' }, text: 'Setting a level also unmutes the TV' })),
      );

      unsubscribe = ctx.volume.subscribe((s) => {
        if (!slider.busy) {
          num.textContent = s.value === null ? '—' : String(s.value);
          slider.set(s.value);
        }
        slider.setPending(s.pending);
        readout.classList.toggle('is-muted', s.muted);
        muteSwitch.setAttribute('aria-checked', s.muted ? 'true' : 'false');
      });
    },
  });
}
