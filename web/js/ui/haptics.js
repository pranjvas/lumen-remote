// Haptics: navigator.vibrate patterns where the browser has it (Android), and on iPhones (Safari 18+,
// where navigator.vibrate does not exist) the system tick that toggling an <input type="checkbox" switch>
// plays. Both only fire inside a user gesture, so nothing runs before the first tap.

const PATTERNS = {
  key: 8,
  detent: 4,
  armed: 15,
  power: [10, 40, 10],
  error: [20, 60, 20],
};

let lastDetent = 0;
let lastTick = 0;
let tickLabel = null;

const vibrateApi = () => typeof navigator.vibrate === 'function';
// iOS/iPadOS WebKit: Safari, and Chrome on iOS (which is WebKit too).
const appleTouch = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const hapticsSupported = () => vibrateApi() || appleTouch();

export function hapticsEnabled() {
  return localStorage.getItem('lumen.haptics') !== 'off';
}

export function setHaptics(on) {
  localStorage.setItem('lumen.haptics', on ? 'on' : 'off');
}

const userActive = () => navigator.userActivation?.isActive ?? navigator.userActivation?.hasBeenActive ?? true;

// The switch must stay in the document; clicking its label inside a gesture plays the tick.
function iosTick() {
  if (!tickLabel) {
    const id = 'lumen-haptic-switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    tickLabel = document.createElement('label');
    tickLabel.htmlFor = id;
    tickLabel.setAttribute('aria-hidden', 'true');
    tickLabel.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
    tickLabel.append(input);
    document.body.append(tickLabel);
  }
  // Clicking a label moves focus to its input on some engines; never steal focus from a field.
  const focused = document.activeElement;
  if (focused && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName) && focused.type !== 'checkbox') return;
  tickLabel.click();
}

export function haptic(kind) {
  if (!hapticsEnabled() || !userActive()) return;
  if (kind === 'detent') {
    const now = performance.now();
    if (now - lastDetent < 40) return;
    lastDetent = now;
  }
  if (vibrateApi()) {
    try { navigator.vibrate(PATTERNS[kind] ?? 8); } catch { /* not allowed before a gesture */ }
    return;
  }
  if (!appleTouch()) return;
  // One tick per press is plenty: holds and detents would buzz continuously.
  const now = performance.now();
  if (now - lastTick < 60) return;
  lastTick = now;
  try { iosTick(); } catch { /* no switch support: silently nothing */ }
}
