// Formatting helpers for ages, times, sizes and durations.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function ago(at, now = Date.now()) {
  if (!at) return 'unknown';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

const pad2 = (n) => String(n).padStart(2, '0');

export function clock(at) {
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function stamp(at) {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock(at)}`;
}

export function bytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

export function countdown(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function prettySource(source) {
  return String(source || '').replace(/^HDMI(\d)$/, 'HDMI $1').replace(/^AV(\d)$/, 'AV $1').replace(/^COMPONENT(\d)$/, 'Component $1');
}

export function titleCase(s) {
  return String(s ?? '').replace(/(^|[\s_-])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}
