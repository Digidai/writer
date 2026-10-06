import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNext } from '../public/safe-next.js';

const ORIGIN = 'https://writer.example';

test('after sign-in, only same-origin paths are followed', () => {
  assert.equal(safeNext('/d/abc?x=1#top', ORIGIN), '/d/abc?x=1#top');
  assert.equal(safeNext('/', ORIGIN), '/');
  assert.equal(safeNext('', ORIGIN), '/archive');
  assert.equal(safeNext(null, ORIGIN), '/archive');
  for (const evil of [
    'https://evil.example/', '//evil.example/x', '/\\evil.example', '\\\\evil.example',
    'javascript:alert(1)', ' //evil.example', '/login?next=/login',
    '/.//evil.example', '/%2e//evil.example', '/a/..//evil.example', '/./\\evil.example',
  ]) {
    assert.equal(safeNext(evil, ORIGIN), '/archive', evil);
  }
  // A scheme-relative path with our own scheme stays on our site.
  assert.equal(safeNext('https:elsewhere', ORIGIN), '/elsewhere');
});
