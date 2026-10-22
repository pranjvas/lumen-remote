// navigator.vibrate patterns (Android browsers; silently absent elsewhere).

const PATTERNS = {
  key: 8,
  detent: 4,
  armed: 15,
  power: [10, 40, 10],
  error: [20, 60, 20],
};

let lastDetent = 0;

export const hapticsSupported = () => typeof navigator.vibrate === 'function';

export function hapticsEnabled() {
  return localStorage.getItem('lumen.haptics') !== 'off';
}

export function setHaptics(on) {
  localStorage.setItem('lumen.haptics', on ? 'on' : 'off');
}

export function haptic(kind) {
  if (!hapticsSupported() || !hapticsEnabled()) return;
  if (kind === 'detent') {
    const now = performance.now();
    if (now - lastDetent < 40) return;
    lastDetent = now;
  }
  try { navigator.vibrate(PATTERNS[kind] ?? 8); } catch { /* not allowed before a gesture */ }
}
