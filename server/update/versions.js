// Release versions: plain X.Y.Z (no pre-release or build parts), tagged vX.Y.Z.

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** 'X.Y.Z' → [X, Y, Z]; anything else → null. */
export function parseVersion(s) {
  const m = VERSION.exec(String(s ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1 by semantic version order; an unparsable version sorts below any real one. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

export const tagFor = (version) => `v${version}`;

/** 'vX.Y.Z' → 'X.Y.Z'; any other tag → null. */
export function versionOfTag(tag) {
  const m = /^v(\d+\.\d+\.\d+)$/.exec(String(tag ?? ''));
  return m ? m[1] : null;
}
