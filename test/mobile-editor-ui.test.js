import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MESSAGES } from '../public/i18n.js';
import { WRITER_VERSION } from '../src/version.js';

test('mobile empty hint copy avoids completion-control verbs', () => {
  assert.doesNotMatch(MESSAGES.en['editor.hintMobile'], /\b(Accept|Dismiss|Tab)\b/i);
  assert.match(MESSAGES.en['editor.hintMobileGhost'], /\bAccept\b/i);
  assert.doesNotMatch(MESSAGES.en['editor.finishHintTouch'], /⌘|Ctrl|Tab/i);

  assert.doesNotMatch(MESSAGES.zh['editor.hintMobile'], /采纳|忽略|Tab|tab/);
  assert.match(MESSAGES.zh['editor.hintMobileGhost'], /采纳/);
  assert.doesNotMatch(MESSAGES.zh['editor.finishHintTouch'], /⌘|Ctrl|Tab|tab/);
});

test('mobile completion and touch finish hints still depend on touch+ghost state', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(
    appJs,
    /const visible = useTouchCompletionUi\(\) && Boolean\(state\.ghost\);/
  );
  assert.match(
    appJs,
    /const key = touchUi && state\.ghost[\s\S]*editor\.hintMobileGhost[\s\S]*editor\.hintMobile[\s\S]*editor\.hint/
  );
  assert.match(
    appJs,
    /const key = useTouchCompletionUi\(\) \? 'editor\.finishHintTouch' : 'editor\.finishHint';/
  );
});

test('editor markup wraps mirror/input in well and version-busts assets', async () => {
  const indexHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const archiveHtml = await readFile(new URL('../public/archive.html', import.meta.url), 'utf8');
  const settingsHtml = await readFile(new URL('../public/settings.html', import.meta.url), 'utf8');
  const serverHtml = await readFile(new URL('../src/html.js', import.meta.url), 'utf8');
  const versionTag = WRITER_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  assert.match(
    indexHtml,
    /<div class="sheet">\s*<div class="well">\s*<div class="mirror"[\s\S]*<\/div>\s*<textarea class="input"/
  );
  assert.match(indexHtml, new RegExp(`<link rel="stylesheet" href="/style\\.css\\?v=${versionTag}">`));
  assert.match(indexHtml, new RegExp(`<script type="module" src="/app\\.js\\?v=${versionTag}"></script>`));

  assert.match(archiveHtml, new RegExp(`<link rel="stylesheet" href="/style\\.css\\?v=${versionTag}">`));
  assert.match(archiveHtml, new RegExp(`<script type="module" src="/archive\\.js\\?v=${versionTag}"></script>`));

  assert.match(settingsHtml, new RegExp(`<link rel="stylesheet" href="/style\\.css\\?v=${versionTag}">`));
  assert.match(settingsHtml, new RegExp(`<script type="module" src="/settings\\.js\\?v=${versionTag}"></script>`));

  assert.match(serverHtml, /href="\/style\.css\?v=\$\{WRITER_VERSION\}"/);
  assert.match(serverHtml, /src="\/menu\.js\?v=\$\{WRITER_VERSION\}"/);
  assert.match(serverHtml, /src="\/doc\.js\?v=\$\{WRITER_VERSION\}"/);
});

test('mobile editor CSS uses well margin inset and keeps desktop A4 paper', async () => {
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');

  assert.doesNotMatch(css, /min-height:\s*clamp\(320px,\s*56dvh,\s*520px\);/);
  assert.match(css, /min-height:\s*1123px;\s*\/\* A4 at 96dpi \*\//);
  assert.doesNotMatch(
    css,
    /\.input,\s*\.mirror\s*\{[\s\S]*padding:\s*clamp\(26px,\s*7vw,\s*44px\)\s+clamp\(16px,\s*6vw,\s*30px\);/
  );
  assert.match(
    css,
    /--mobile-editor-bottom-gap:\s*calc\(48px \+ var\(--safe-bottom\) \+ var\(--keyboard-offset\)\);/
  );
  assert.match(
    css,
    /\.editor-body\.completion-visible\s*\{[\s\S]*--mobile-editor-bottom-gap:\s*calc\(132px \+ var\(--safe-bottom\) \+ var\(--keyboard-offset\)\);/
  );
  assert.match(
    css,
    /\.desk\s*\{[\s\S]*display:\s*flex;[\s\S]*flex-direction:\s*column;/
  );
  assert.match(
    css,
    /\.sheet\s*\{[\s\S]*flex:\s*1 1 0;[\s\S]*min-height:\s*0;[\s\S]*display:\s*flex;[\s\S]*flex-direction:\s*column;/
  );
  assert.doesNotMatch(
    css,
    /\.sheet\s*\{[\s\S]*--paper-pad-block:[\s\S]*padding:\s*var\(--paper-pad-block\) var\(--paper-pad-inline\);/
  );
  assert.match(
    css,
    /\.well\s*\{[\s\S]*flex:\s*1 1 0;[\s\S]*min-height:\s*0;[\s\S]*margin:\s*clamp\(28px,\s*8vw,\s*36px\)\s+clamp\(20px,\s*6vw,\s*24px\);/
  );
  assert.match(
    css,
    /\.input,\s*\.mirror\s*\{[\s\S]*padding:\s*0;[\s\S]*line-height:\s*1\.72;/
  );
  assert.match(
    css,
    /\.mirror\s*\{[\s\S]*inset:\s*0;/
  );
  assert.match(
    css,
    /\.archive,\s*\.settings,\s*\.reader\s*\{[\s\S]*calc\(44px \+ var\(--safe-bottom\)\)/
  );
  assert.doesNotMatch(
    css,
    /\.desk\s*\{[\s\S]*calc\(var\(--bar-height\) \+ 12px \+ var\(--safe-top\)\)/
  );
  assert.doesNotMatch(
    css,
    /\.archive,\s*\.settings,\s*\.reader\s*\{[\s\S]*calc\(var\(--bar-height\) \+ 12px \+ var\(--safe-top\)\)/
  );
  assert.doesNotMatch(
    css,
    /\.archive\s*\{[\s\S]*calc\(var\(--bar-height\) \+ 38px \+ var\(--safe-top\)\)/
  );
  assert.doesNotMatch(
    css,
    /\.settings\s*\{[\s\S]*calc\(var\(--bar-height\) \+ 38px \+ var\(--safe-top\)\)/
  );
  assert.doesNotMatch(
    css,
    /\.reader\s*\{[\s\S]*calc\(var\(--bar-height\) \+ 26px \+ var\(--safe-top\)\)/
  );
});

test('resize keeps mobile paper CSS-owned unless content overflows well', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(
    appJs,
    /const well = input\.parentElement;/
  );
  assert.match(
    appJs,
    /if \(mobileLayout\?\.matches\) \{[\s\S]*const paperFloor = well \? Math\.max\(Math\.floor\(well\.clientHeight\), 1\) : 1;/
  );
  assert.match(
    appJs,
    /if \(contentHeight > paperFloor\) \{[\s\S]*input\.style\.height = `\$\{contentHeight\}px`;/ 
  );
  assert.match(
    appJs,
    /else if \(input\.style\.height\) \{[\s\S]*input\.style\.height = '';\s*\}/
  );
  assert.match(
    appJs,
    /input\.style\.height = 'auto';[\s\S]*const nextHeight = Math\.max\(input\.scrollHeight, mirrorHeight, 1\);/
  );
  assert.doesNotMatch(
    appJs,
    /sheetPaddingTop|sheetPaddingBottom/
  );
});

test('desk tap-to-focus behavior remains intact', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(
    appJs,
    /deskEl\?\.addEventListener\('click',[\s\S]*input\.focus\(\);/
  );
});
