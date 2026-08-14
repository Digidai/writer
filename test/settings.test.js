import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, DEFAULTS } from '../src/settings.js';

test('normalize fills in every default', () => {
  assert.deepEqual(normalize(undefined), DEFAULTS);
  assert.deepEqual(normalize(null), DEFAULTS);
  assert.deepEqual(normalize('nonsense'), DEFAULTS);
  assert.deepEqual(normalize({}), DEFAULTS);
});

test('normalize keeps valid values', () => {
  const out = normalize({
    fontSize: 'large',
    theme: 'dark',
    completion: false,
    completionDelay: 1500,
    idleArchiveMinutes: 0,
    agentFormatting: false,
  });
  assert.equal(out.fontSize, 'large');
  assert.equal(out.theme, 'dark');
  assert.equal(out.completion, false);
  assert.equal(out.completionDelay, 1500);
  assert.equal(out.idleArchiveMinutes, 0);
  assert.equal(out.agentFormatting, false);
});

test('normalize drops values outside the allowed set', () => {
  const out = normalize({
    fontSize: 'huge',
    theme: 'solarized',
    completion: 'yes',
    completionDelay: 5,
    idleArchiveMinutes: 999,
  });
  assert.deepEqual(out, DEFAULTS);
});

test('normalize ignores unknown keys', () => {
  const out = normalize({ fontSize: 'small', evil: '<script>', __proto__: { polluted: true } });
  assert.equal(out.fontSize, 'small');
  assert.equal('evil' in out, false);
  assert.equal({}.polluted, undefined);
});

test('normalize does not mutate the defaults', () => {
  const out = normalize({ theme: 'dark' });
  out.theme = 'light';
  assert.equal(DEFAULTS.theme, 'system');
});

test('idleArchiveMinutes of 0 survives (it means manual only)', () => {
  assert.equal(normalize({ idleArchiveMinutes: 0 }).idleArchiveMinutes, 0);
});
