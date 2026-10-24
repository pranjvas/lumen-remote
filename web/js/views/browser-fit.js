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
