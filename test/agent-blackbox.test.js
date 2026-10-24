// The TV agent's black box in Lumen's log (adapters/agent.js formatBox): what happened on the TV
// before its page was cut off. The newest entries (the ones just before a kill) always stay, the
// line is always valid JSON, and notes the PC already logged as they happened are not logged again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBox } from '../server/adapters/agent.js';

const T0 = Date.UTC(2026, 9, 24, 6, 20, 0);
const note = (i, k = 'error', d = { msg: 'x'.repeat(200), i }) => ({ t: T0 + i * 1000, k, d });

test('40 long error notes: valid JSON of at most 4000 characters, the newest entries kept, the oldest dropped', () => {
  const box = Array.from({ length: 40 }, (_, i) => note(i));
  box.push(note(40, 'live-jump', { why: 'stall' }), note(41, 'script-stall', { ms: 4100 }));
  const out = formatBox(box, new Set());
  const json = JSON.stringify(out.entries);
  assert.ok(json.length <= 4000, `${json.length} characters`);
  assert.deepEqual(JSON.parse(json), out.entries, 'valid JSON');
  assert.deepEqual(out.entries.slice(-2).map((e) => e.k), ['live-jump', 'script-stall'], 'the newest entries are there');
  assert.equal(out.entries.at(-1).t, '06:20:41.000');
  assert.equal(out.count, 42);
  assert.equal(out.fresh, 42);
  assert.equal(out.alreadyLogged, 0);
  assert.equal(out.dropped, 42 - out.entries.length);
  assert.ok(out.dropped > 0);
  // In time order, whole entries only.
  const times = out.entries.map((e) => e.t);
  assert.deepEqual(times, [...times].sort());
  assert.ok(out.entries.every((e) => e.d && typeof e.d === 'object'));
});

test('notes the PC logged as they happened are skipped (but counted), with the last few kept for context', () => {
  const box = Array.from({ length: 10 }, (_, i) => note(i, i < 8 ? 'live-stats' : 'error', { i }));
  const streamed = new Set(box.slice(0, 8).map((e) => `${e.t}|${e.k}`));
  const out = formatBox(box, streamed);
  assert.equal(out.fresh, 2);
  assert.equal(out.alreadyLogged, 8);
  assert.deepEqual(out.entries.map((e) => e.d.i), [5, 6, 7, 8, 9], 'three logged entries for context, then the new ones');
  assert.equal(out.dropped, 0);
});

test('an oversized note is cut to a short text; junk and out-of-order entries are handled', () => {
  const big = { t: T0, k: 'error', d: { stack: 'y'.repeat(5000) } };
  const out = formatBox([note(3, 'later', { a: 1 }), null, 'junk', big], new Set());
  assert.equal(out.count, 2);
  assert.equal(out.entries[0].k, 'error', 'oldest first');
  assert.equal(typeof out.entries[0].d, 'string');
  assert.ok(out.entries[0].d.length <= 301);
  assert.deepEqual(out.entries[1].d, { a: 1 });
  assert.deepEqual(formatBox(undefined), { count: 0, fresh: 0, alreadyLogged: 0, dropped: 0, entries: [] });
});
