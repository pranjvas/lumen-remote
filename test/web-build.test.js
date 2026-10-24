// A page from an older Lumen web build (web/js/core/build.js): it notices a redeployed Lumen from
// hello.webBuild and reloads itself once, unless that would interrupt the owner or loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStale, staleAction } from '../web/js/core/build.js';

test('only a later hello naming another build makes the page stale', () => {
  assert.equal(isStale(undefined, 'abc'), false, 'the first hello is the page\'s own build');
  assert.equal(isStale('abc', 'abc'), false);
  assert.equal(isStale('abc', 'def'), true);
  assert.equal(isStale('abc', undefined), false, 'a Lumen that names no build says nothing');
  assert.equal(isStale('abc', ''), false);
  // The page came from a Lumen that named no build; one that does is a newer one.
  assert.equal(isStale('', 'def'), true);
  assert.equal(isStale('', undefined), false);
});

test('a stale page reloads, waits for its tab, or asks', () => {
  assert.equal(staleAction({ build: 'def' }), 'reload');
  assert.equal(staleAction({ build: 'def', hidden: true }), 'wait');
  assert.equal(staleAction({ build: 'def', busy: true }), 'banner', 'typing, a sheet, an upload or a held key');
  assert.equal(staleAction({ build: 'def', busy: true, hidden: true }), 'banner');
  assert.equal(staleAction({ build: 'def', reloadedFor: 'def' }), 'banner', 'it already reloaded for this build once');
  assert.equal(staleAction({ build: 'def', reloadedFor: 'abc' }), 'reload');
});
