import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MESSAGES } from '../public/i18n.js';
import { WRITER_VERSION } from '../src/version.js';

const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
const settingsHtml = await readFile(new URL('../public/settings.html', import.meta.url), 'utf8');
const htmlJs = await readFile(new URL('../src/html.js', import.meta.url), 'utf8');

test('version is 0.12.0', () => {
  assert.equal(WRITER_VERSION, '0.12.0');
});

test('one quiet paper: color, hairline, 3px radius, short sit-on-desk shadow', () => {
  assert.match(css, /--paper:\s*#fffdf9;/);
  assert.match(css, /--paper:\s*#242119;/);
  assert.match(css, /\.sheet\s*\{[\s\S]*background:\s*var\(--paper\);[\s\S]*border:\s*1px solid var\(--hairline\);[\s\S]*border-radius:\s*3px;/);
  assert.match(css, /\.doc\s*\{[\s\S]*background:\s*var\(--paper\);[\s\S]*border:\s*1px solid var\(--hairline\);[\s\S]*border-radius:\s*3px;/);
  assert.match(css, /\.card\s*\{[\s\S]*background:\s*var\(--paper\);[\s\S]*border:\s*1px solid var\(--hairline\);[\s\S]*border-radius:\s*3px;/);
  assert.match(css, /\.settings-sheet\s*\{[\s\S]*background:\s*var\(--paper\);[\s\S]*border:\s*1px solid var\(--hairline\);[\s\S]*border-radius:\s*3px;/);
  assert.match(css, /--sheet-shadow:[\s\S]*0 2px 6px/);
  assert.doesNotMatch(css, /70px/);
  assert.doesNotMatch(css, /border-radius:\s*10px/);
  assert.doesNotMatch(css, /\.card:hover\s*\{[\s\S]*translateY/);
  assert.match(settingsHtml, /<div class="settings-sheet">[\s\S]*<div id="fields">[\s\S]*<section class="trash">/);
});

test('desktop paper measure and type stay quiet', () => {
  assert.match(css, /width:\s*min\(794px,\s*100%\)/);
  assert.match(css, /min-height:\s*1123px;\s*\/\* A4 at 96dpi \*\//);
  assert.match(css, /\.input,\s*\.mirror\s*\{[\s\S]*padding:\s*4em max\(2\.8em,\s*calc\(\(100% - 34em\) \/ 2\)\);[\s\S]*font:\s*400 var\(--doc-size\)\/1\.80 var\(--text\);[\s\S]*letter-spacing:\s*0;/);
  assert.match(css, /\.prose\s*\{[\s\S]*font:\s*400 var\(--doc-size\)\/1\.80 var\(--text\);[\s\S]*letter-spacing:\s*0;/);
  assert.doesNotMatch(css, /var\(--doc-size\)\s*-\s*0\.5px/);
});

test('bar is a solid desk strip with quieter chrome', () => {
  assert.match(css, /--bar-height:\s*calc\(56px \+ var\(--safe-top\)\)/);
  assert.match(css, /\.bar\s*\{[\s\S]*background:\s*var\(--desk\);/);
  assert.doesNotMatch(css, /backdrop-filter/);
  assert.match(css, /\.menu-button\s*\{[\s\S]*color:\s*var\(--ink-soft\);/);
  assert.match(css, /\.finish\s*\{[\s\S]*border:\s*0;/);
  assert.match(css, /@media \(hover:\s*hover\) and \(pointer:\s*fine\)\s*\{[\s\S]*min-height:\s*32px;/);
});

test('no faux-bold in the visual stylesheet', () => {
  assert.doesNotMatch(css, /font-weight:\s*500/);
  assert.doesNotMatch(css, /font:\s*(?:italic\s+)?500\b/);
});

test('ink-faint is raised and selection follows the theme', () => {
  assert.match(css, /--ink-faint:\s*#8a8478;/);
  assert.match(css, /--ink-faint:\s*#8a8274;/);
  assert.match(css, /::selection\s*\{[\s\S]*var\(--seal\)/);
});

test('archive rows are dense and search stays a small radius', () => {
  assert.match(css, /\.search\s*\{[\s\S]*border-radius:\s*3px;/);
  assert.match(css, /\.archive-actions:has\(>\s*:not\(\[hidden\]\)\)\s*\{[\s\S]*margin:\s*0 0 18px;/);
  assert.match(css, /\.card\s*\{[\s\S]*padding:\s*12px 16px;[\s\S]*margin-bottom:\s*8px;/);
});

test('segments stay one capsule and setting copy is one line', () => {
  assert.match(css, /\.segmented\s*\{[\s\S]*border-radius:\s*999px;/);
  assert.doesNotMatch(css, /\.segmented\s*\{[\s\S]*border:\s*0;[\s\S]*border-radius:\s*0;/);
  for (const lang of ['zh', 'en']) {
    for (const key of Object.keys(MESSAGES[lang]).filter((name) => name.endsWith('Desc'))) {
      assert.equal(MESSAGES[lang][key].includes('\n'), false, `${lang}.${key} wraps`);
    }
  }
});

test('focus-visible seal is chrome-only and dead download styles are gone', () => {
  assert.match(css, /:focus-visible\s*\{[\s\S]*outline:\s*2px solid var\(--seal\);/);
  assert.match(css, /\.input:focus-visible\s*\{\s*outline:\s*none;/);
  assert.doesNotMatch(css, /\.doc-meta \.download/);
  assert.doesNotMatch(htmlJs, /class="download"/);
});
