// The Browser view's geometry (web/js/views/browser-fit.js): the page size a stage asks for keeps the
// stage's shape inside the server's 320..1280 × 320..800 box, and the canvas fits the stage's content box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VIEWPORT_MAX, VIEWPORT_MIN, fitFrame, sizeDiffers, viewportFor } from '../web/js/views/browser-fit.js';
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
