// Browser view geometry, kept free of the DOM so node --test can check it (test/browser-fit.test.js).

// The page sizes the server accepts (server/features/browser.js VIEWPORT).
export const VIEWPORT_MIN = 320;
export const VIEWPORT_MAX = Object.freeze({ w: 1280, h: 800 });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The page size to ask for, for a stage of `width`×`height` CSS px. The page is laid out at the
 * stage's CSS size so text appears at its normal size (laying it out in device pixels made a phone
 * show 16 px text at about 11 px). The stage is scaled uniformly into the server's box, up when a
 * side is under its minimum and down when one is over its maximum, so the frame keeps the stage's
 * shape: a 343×252 stage asks for 436×320, not 343×320 (which the phone then showed letterboxed).
 * Only a stage too long for both limits at once (812×180) ends up slightly letterboxed (1280×320).
 * → { w, h } or null for an empty stage.
 */
export function viewportFor(width, height) {
  if (!(width > 0) || !(height > 0)) return null;
  const fitMax = Math.min(VIEWPORT_MAX.w / width, VIEWPORT_MAX.h / height);
  let s = Math.max(Math.min(1, fitMax), VIEWPORT_MIN / width, VIEWPORT_MIN / height);
  s = Math.min(s, fitMax);
  return {
    w: clamp(Math.round(width * s), VIEWPORT_MIN, VIEWPORT_MAX.w),
    h: clamp(Math.round(height * s), VIEWPORT_MIN, VIEWPORT_MAX.h),
  };
}

/**
 * The canvas's CSS size: a `frameW`×`frameH` frame at its own aspect, as large as fits inside the
 * stage's content box (`stageW`×`stageH`, without its border). → { w, h } or null.
 */
export function fitFrame(stageW, stageH, frameW, frameH) {
  if (!(stageW > 0) || !(stageH > 0) || !(frameW > 0) || !(frameH > 0)) return null;
  const s = Math.min(stageW / frameW, stageH / frameH);
  return { w: Math.floor(frameW * s), h: Math.floor(frameH * s) };
}

/** Whether a frame of `frame` CSS px differs from the size this client asked for by more than `slop` px. */
export function sizeDiffers(frame, sent, slop = 2) {
  if (!frame || !sent || !frame.w || !frame.h) return false;
  return Math.abs(frame.w - sent.w) > slop || Math.abs(frame.h - sent.h) > slop;
}

// ---------- pinch zoom: the phone's own magnifier over the page (the page and the TV are untouched) ----------

export const ZOOM_MAX = 4;

/**
 * A zoom `view` { z, tx, ty } (scale, then a translation in stage px, applied to the canvas from its
 * top-left corner) kept sensible: at 1× nothing moves; zoomed, a canvas larger than the stage on an
 * axis may not leave an empty band on that side, and one smaller stays centred on it. `box` is the
 * canvas's unzoomed { left, top, w, h } in the stage, `stage` its content { w, h }.
 */
export function clampZoom({ z, tx, ty }, box, stage) {
  if (!(z > 1)) return { z: 1, tx: 0, ty: 0 };
  const zoom = Math.min(z, ZOOM_MAX);
  const axis = (t, start, size, room) => {
    const scaled = size * zoom;
    if (scaled <= room) return (room - scaled) / 2 - start;
    return Math.min(-start, Math.max(room - start - scaled, t));
  };
  return { z: zoom, tx: axis(tx, box.left, box.w, stage.w), ty: axis(ty, box.top, box.h, stage.h) };
}

/**
 * Two fingers moving: the view from `start` scaled by `ratio` (finger distance now / at the start),
 * with the point of the page that was between the fingers (`from`, stage px) kept between them (`to`).
 */
export function pinchZoom(start, from, to, ratio, box, stage) {
  const z = Math.min(ZOOM_MAX, Math.max(1, start.z * ratio));
  const px = (from.x - box.left - start.tx) / start.z;
  const py = (from.y - box.top - start.ty) / start.z;
  return clampZoom({ z, tx: to.x - box.left - px * z, ty: to.y - box.top - py * z }, box, stage);
}

/**
 * One finger dragging a zoomed view by dx/dy stage px: it pans first, and what the edge stops (the
 * rest) scrolls the page. → { view, rest: { dx, dy } }.
 */
export function panZoom(view, dx, dy, box, stage) {
  const next = clampZoom({ z: view.z, tx: view.tx + dx, ty: view.ty + dy }, box, stage);
  return { view: next, rest: { dx: dx - (next.tx - view.tx), dy: dy - (next.ty - view.ty) } };
}
