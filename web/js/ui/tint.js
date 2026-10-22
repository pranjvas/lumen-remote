// App tint: a brand colour converted to OKLCH and clamped so it reads as calm light,
// never as a large saturated fill (Nocturne L 0.72–0.82, Gallery L 0.42–0.52, C ≤ 0.16).

const DEFAULT = { nocturne: '#ffb454', gallery: '#8f5400' };
let currentHex = null;

const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}

function rgbToOklch([r, g, b]) {
  const [lr, lg, lb] = [toLin(r), toLin(g), toLin(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function oklchToLinear([L, C, H]) {
  const A = C * Math.cos(H);
  const B = C * Math.sin(H);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function clampTint(hex, theme) {
  const rgb = hexToRgb(hex);
  if (!rgb) return DEFAULT[theme];
  let [L, C, H] = rgbToOklch(rgb);
  const [lo, hi] = theme === 'gallery' ? [0.42, 0.52] : [0.72, 0.82];
  L = Math.min(hi, Math.max(lo, L));
  C = Math.min(C, 0.16);
  if (C < 0.03) return DEFAULT[theme];
  for (let i = 0; i < 40; i++) {
    const lin = oklchToLinear([L, C, H]);
    if (lin.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) {
      const out = lin.map((v) => Math.round(Math.min(1, Math.max(0, toSrgb(Math.max(0, v)))) * 255));
      return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    }
    C *= 0.92;
  }
  return DEFAULT[theme];
}

export function activeTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'gallery' : 'nocturne';
}

export function setTint(hex) {
  currentHex = hex || null;
  const theme = activeTheme();
  const value = currentHex ? clampTint(currentHex, theme) : DEFAULT[theme];
  document.documentElement.style.setProperty('--tint', value);
}

export const reapplyTint = () => setTint(currentHex);

// Relative luminance check so monogram tiles pick a readable glyph colour.
export function isLightColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  const [r, g, b] = rgb.map(toLin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45;
}
