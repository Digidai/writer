import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGES, LANGS, makeT, resolveLang, locale } from '../public/i18n.js';

test('every language carries exactly the same keys', () => {
  const base = Object.keys(MESSAGES.zh).sort();
  for (const lang of LANGS) {
    const keys = Object.keys(MESSAGES[lang]).sort();
    assert.deepEqual(keys, base, `${lang} keys drifted from zh`);
  }
});

test('no translation is left empty', () => {
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(MESSAGES[lang])) {
      assert.ok(value && value.trim().length > 0, `${lang}.${key} is empty`);
    }
  }
});

test('placeholders match across languages', () => {
  const vars = (s) => (s.match(/\{\w+\}/g) || []).sort();
  for (const key of Object.keys(MESSAGES.zh)) {
    for (const lang of LANGS) {
      assert.deepEqual(vars(MESSAGES[lang][key]), vars(MESSAGES.zh[key]), `${lang}.${key}`);
    }
  }
});

test('resolveLang honours an explicit choice over the hint', () => {
  assert.equal(resolveLang('en', 'zh-CN'), 'en');
  assert.equal(resolveLang('zh', 'en-US'), 'zh');
});

test('resolveLang follows the hint when set to auto', () => {
  assert.equal(resolveLang('auto', 'en-US,en;q=0.9'), 'en');
  assert.equal(resolveLang('auto', 'zh-CN,zh;q=0.9'), 'zh');
  assert.equal(resolveLang('auto', 'fr-FR'), 'en');
  assert.equal(resolveLang('auto', ''), 'zh');
  assert.equal(resolveLang(undefined, undefined), 'zh');
  assert.equal(resolveLang('klingon', 'en'), 'en');
});

test('t interpolates and falls back gracefully', () => {
  const t = makeT('en');
  assert.equal(t('reader.traceTurn', { n: 3 }), 'Turn 3');
  assert.equal(t('opt.minutes', { n: 15 }), '15 min');
  assert.equal(t('does.not.exist'), 'does.not.exist');
});

test('an unknown language falls back to Chinese', () => {
  const t = makeT('klingon');
  assert.equal(t('nav.archive'), '归档');
});

test('locale maps to a real Intl locale', () => {
  assert.equal(locale('en'), 'en-US');
  assert.equal(locale('zh'), 'zh-CN');
  assert.doesNotThrow(() => new Intl.DateTimeFormat(locale('en')).format(new Date(0)));
});
