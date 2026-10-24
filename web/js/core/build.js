// Which web build this page runs, against the one Lumen now serves (hello.webBuild). A phone left
// open for days, or a home-screen tab, reconnects to a redeployed Lumen with its old modules still
// loaded; it reloads itself once, unless that would interrupt something (then a banner offers it).
// DOM-free so node --test can check it (test/web-build.test.js).

export const RELOADED_KEY = 'lumen.reloadedFor';

/**
 * `known` is the first hello's webBuild ('' when that hello had none, undefined before any hello).
 * A later hello naming another build means the page's files are out of date.
 */
export function isStale(known, incoming) {
  return known !== undefined && known !== null && typeof incoming === 'string' && incoming !== '' && incoming !== known;
}

/**
 * What to do about a stale page: 'banner' (ask: it already reloaded for this build once, which a
 * reload that brought back the same files would otherwise repeat forever, or the owner is in the
 * middle of something), 'wait' (reload when the tab is visible again) or 'reload'.
 */
export function staleAction({ build, reloadedFor = null, busy = false, hidden = false }) {
  if (reloadedFor === build || busy) return 'banner';
  return hidden ? 'wait' : 'reload';
}
