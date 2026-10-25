// The phone's controls for the video on the TV (web/js/views/tvplayback.js): what they drive, and the
// seek bar's clock between the TV player's reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlsMode, playbackNow } from '../web/js/views/tvplayback.js';

test('the controls drive the TV\'s player while it has the video, else the page\'s own video, else nothing', () => {
  const pb = { state: 'playing', position: 1000, duration: 60000, at: 1 };
  assert.equal(controlsMode({ on: true, playback: pb, video: 'playing', media: 0 }), 'player');
  assert.equal(controlsMode({ on: false, playback: pb, video: 'playing', media: 1 }), null, 'not on the TV');
  // Live video (no TV player): only when the page has a video.
  assert.equal(controlsMode({ on: true, playback: null, video: null, media: 2 }), 'page');
  assert.equal(controlsMode({ on: true, playback: null, video: null, media: 0 }), null);
  // Lumen converting the video, or the player starting without a clock yet: nothing to drive.
  assert.equal(controlsMode({ on: true, playback: null, video: 'fallback', media: 2 }), null);
  assert.equal(controlsMode({ on: true, playback: null, video: 'loading', media: 2 }), null);
});

test('the seek bar runs on from the last report by this phone\'s own clock, and stops at the end', () => {
  const pb = { state: 'playing', position: 10000, duration: 60000, at: 999999999 };
  assert.equal(playbackNow(pb, 5000, 5000), 10);
  assert.equal(playbackNow(pb, 5000, 7500), 12.5, 'the PC\'s `at` is not compared with this phone\'s clock');
  assert.equal(playbackNow(pb, 5000, 500000), 60, 'never past the end');
  assert.equal(playbackNow({ ...pb, state: 'paused' }, 5000, 9000), 10, 'paused: it stays');
  assert.equal(playbackNow({ ...pb, duration: null }, 0, 100000), 110, 'unknown length: no limit');
  assert.equal(playbackNow({ state: 'playing', position: null }, 0, 1), null);
  assert.equal(playbackNow(null, 0, 1), null);
});
