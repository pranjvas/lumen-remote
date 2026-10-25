// The Browser view's geometry (web/js/views/browser-fit.js): the page size a stage asks for keeps the
// stage's shape inside the server's 320..1280 × 320..800 box, and the canvas fits the stage's content box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VIEWPORT_MAX, VIEWPORT_MIN, ZOOM_MAX, clampZoom, fitFrame, panZoom, pinchZoom, sizeDiffers, viewportFor } from '../web/js/views/browser-fit.js';
import { clampViewport } from '../server/features/browser.js';

test('a stage inside the box asks for its own CSS size', () => {
  assert.deepEqual(viewportFor(356, 523), { w: 356, h: 523 });
  assert.deepEqual(viewportFor(862, 583), { w: 862, h: 583 });
});

test('a short stage is scaled up as a whole, not stretched on one side', () => {
  // A 375×548 phone with the short-screen layout: 343×252 used to become 343×320 (shown letterboxed).
  assert.deepEqual(viewportFor(343, 252), { w: 436, h: 320 });
  // Landscape 844×390: long and low, so it meets both limits; nearly its shape, not 812×320.
  assert.deepEqual(viewportFor(812, 180), { w: 1280, h: 320 });
  assert.deepEqual(viewportFor(810, 177), { w: 1280, h: 320 });
});

test('a large stage is scaled down as a whole', () => {
  assert.deepEqual(viewportFor(2560, 1600), { w: 1280, h: 800 });
  const r = viewportFor(1700, 900);
  assert.equal(r.w, 1280);
  assert.ok(Math.abs(r.w / r.h - 1700 / 900) < 0.01, `keeps the shape: ${JSON.stringify(r)}`);
});

test('whatever the stage, the size is one the server takes unchanged', () => {
  for (let w = 40; w <= 3000; w += 37) {
    for (let h = 40; h <= 2000; h += 41) {
      const r = viewportFor(w, h);
      assert.ok(r.w >= VIEWPORT_MIN && r.w <= VIEWPORT_MAX.w && r.h >= VIEWPORT_MIN && r.h <= VIEWPORT_MAX.h, `${w}×${h} → ${JSON.stringify(r)}`);
      assert.deepEqual(clampViewport(r.w, r.h), r, `${w}×${h}: the server would clamp ${JSON.stringify(r)}`);
      // Within the box's reach, the shape is kept to a pixel.
      const ratio = w / h;
      if (ratio >= VIEWPORT_MIN / VIEWPORT_MAX.h && ratio <= VIEWPORT_MAX.w / VIEWPORT_MIN) {
        assert.ok(Math.abs(r.w / r.h - ratio) / ratio < 0.01, `${w}×${h} keeps its shape: ${JSON.stringify(r)}`);
      }
    }
  }
});

test('an empty stage asks for nothing', () => {
  assert.equal(viewportFor(0, 300), null);
  assert.equal(viewportFor(300, 0), null);
});

test('the canvas fits the content box at the frame\'s aspect', () => {
  assert.deepEqual(fitFrame(356, 523, 356, 523), { w: 356, h: 523 });
  assert.deepEqual(fitFrame(356, 523, 1280, 720), { w: 356, h: 200 });
  assert.deepEqual(fitFrame(810, 177, 1280, 320), { w: 708, h: 177 });
  assert.equal(fitFrame(0, 10, 10, 10), null);
  assert.equal(fitFrame(10, 10, 0, 10), null);
});

test('a frame laid out for another device is told apart from rounding', () => {
  assert.equal(sizeDiffers({ w: 436, h: 320 }, { w: 436, h: 320 }), false);
  assert.equal(sizeDiffers({ w: 437, h: 318 }, { w: 436, h: 320 }), false);
  assert.equal(sizeDiffers({ w: 1280, h: 800 }, { w: 436, h: 320 }), true);
  assert.equal(sizeDiffers({ w: 436, h: 330 }, { w: 436, h: 320 }), true);
  assert.equal(sizeDiffers(null, { w: 436, h: 320 }), false);
  assert.equal(sizeDiffers({ w: 436, h: 320 }, null), false);
});

// Pinch zoom on the phone: a 1280×720 TV page shown 368×207 in a 370×460 stage (centred: top 126).
const BOX = { left: 1, top: 126, w: 368, h: 207 };
const STAGE = { w: 370, h: 460 };

test('pinch zoom keeps the point between the fingers under them, between 1× and 4×', () => {
  const start = { z: 1, tx: 0, ty: 0 };
  const from = { x: 100, y: 200 };
  const view = pinchZoom(start, from, from, 2, BOX, STAGE);
  assert.equal(view.z, 2);
  // The page point under the fingers: (100 - 1) / 1 = 99 across the canvas, still at x 100 on screen.
  assert.ok(Math.abs(BOX.left + view.tx + 99 * view.z - 100) < 1e-9);
  assert.equal(pinchZoom(start, from, from, 10, BOX, STAGE).z, ZOOM_MAX);
  assert.deepEqual(pinchZoom({ z: 2, tx: -50, ty: -100 }, from, from, 0.3, BOX, STAGE), { z: 1, tx: 0, ty: 0 }, 'pinched below 1×: the whole page');
});

test('a zoomed canvas never leaves an empty band; a side smaller than the stage stays centred', () => {
  // 2×: 736 wide (wider than the stage), 414 high (lower than the stage's 460).
  const far = clampZoom({ z: 2, tx: 500, ty: 900 }, BOX, STAGE);
  assert.equal(far.tx, -BOX.left, 'its left edge stays at the stage edge');
  assert.equal(far.ty, (STAGE.h - BOX.h * 2) / 2 - BOX.top, 'centred top to bottom');
  const other = clampZoom({ z: 2, tx: -5000, ty: 0 }, BOX, STAGE);
  assert.equal(BOX.left + other.tx + BOX.w * 2, STAGE.w, 'its right edge stays at the stage edge');
});

test('one finger on a zoomed view pans it first; what its edge stops scrolls the page', () => {
  const view = clampZoom({ z: 2, tx: -100, ty: -150 }, BOX, STAGE);
  const inside = panZoom(view, -30, 0, BOX, STAGE);
  assert.deepEqual([inside.view.tx, inside.rest.dx], [view.tx - 30, 0], 'all of it moves the view');
  const edge = panZoom({ ...view, tx: -BOX.left }, 40, 0, BOX, STAGE);
  assert.deepEqual([edge.view.tx, edge.rest.dx], [-BOX.left, 40], 'at the edge: all of it scrolls the page');
  const tall = panZoom(view, 0, 25, BOX, STAGE);
  assert.equal(tall.rest.dy, 25, 'a side that fits the stage does not move: the page scrolls');
});
