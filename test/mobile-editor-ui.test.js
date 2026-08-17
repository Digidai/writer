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
  assert.match(
    indexHtml,
    /<main class="desk">[\s\S]*<div class="completion-bar" id="completion-bar" hidden>[\s\S]*<div class="hint" id="hint"/
  );
  assert.match(indexHtml, new RegExp(`<link rel="stylesheet" href="/style\\.css\\?v=${versionTag}">`));
  assert.match(indexHtml, new RegExp(`<script type="module" src="/app\\.js\\?v=${versionTag}"></script>`));
  assert.match(
    indexHtml,
    /<script>try\{var r=document\.documentElement,v=window\.visualViewport;r\.style\.setProperty\('--app-height',Math\.round\(v\?v\.height:window\.innerHeight\)\+'px'\);\}catch\(e\)\{\}<\/script>/
  );
  assert.doesNotMatch(indexHtml, /--app-offset-top/);

  assert.match(archiveHtml, new RegExp(`<link rel="stylesheet" href="/style\\.css\\?v=${versionTag}">`));
  assert.match(archiveHtml, new RegExp(`<script type="module" src="/archive\\.js\\?v=${versionTag}"></script>`));

  assert.match(settingsHtml, new RegExp(`<link rel="stylesheet" href="/style\\.css\\?v=${versionTag}">`));
  assert.match(settingsHtml, new RegExp(`<script type="module" src="/settings\\.js\\?v=${versionTag}"></script>`));

  assert.match(serverHtml, /href="\/style\.css\?v=\$\{WRITER_VERSION\}"/);
  assert.match(serverHtml, /src="\/menu\.js\?v=\$\{WRITER_VERSION\}"/);
  assert.match(serverHtml, /src="\/doc\.js\?v=\$\{WRITER_VERSION\}"/);
});

test('mobile editor CSS uses one body-locked stage', async () => {
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  const stageRule = css.match(/html\.editor-stage\s*\{[^}]+\}/)?.[0] || '';
  const bodyRule = css.match(/body\.editor-body\s*\{[^}]+\}/)?.[0] || '';
  const barRule = css.match(/\.editor-body \.bar\s*\{[^}]+\}/)?.[0] || '';
  const deskRule = css.match(/\.editor-body \.desk\s*\{[^}]+\}/)?.[0] || '';

  assert.match(
    css,
    /@media \(max-width:\s*640px\),\s*\(\(hover:\s*none\) and \(pointer:\s*coarse\) and \(max-height:\s*500px\)\)/
  );
  assert.match(
    css,
    /html\.editor-stage\s*\{[\s\S]*overflow:\s*hidden;[\s\S]*height:\s*100%;/
  );
  assert.doesNotMatch(stageRule, /position:\s*fixed/);
  assert.doesNotMatch(stageRule, /--app-offset-top/);
  assert.doesNotMatch(stageRule, /top\s*:/);
  assert.match(
    css,
    /body\.editor-body\s*\{[\s\S]*position:\s*fixed;[\s\S]*top:\s*0;[\s\S]*left:\s*0;[\s\S]*width:\s*100%;[\s\S]*height:\s*var\(--app-height,\s*100dvh\);[\s\S]*overflow:\s*hidden;[\s\S]*overscroll-behavior:\s*none;[\s\S]*touch-action:\s*none;/
  );
  assert.doesNotMatch(bodyRule, /--app-offset-top/);
  assert.doesNotMatch(css, /html\.editor-stage,\s*body\.editor-body\s*\{/);
  assert.doesNotMatch(css, /--app-offset-top/);
  assert.match(
    css,
    /\.editor-body \.bar\s*\{[\s\S]*position:\s*absolute;[\s\S]*top:\s*0;[\s\S]*left:\s*0;[\s\S]*right:\s*0;/
  );
  assert.doesNotMatch(barRule, /position:\s*fixed/);
  assert.match(
    css,
    /\.editor-body \.desk\s*\{[\s\S]*position:\s*absolute;[\s\S]*top:\s*var\(--bar-height\);[\s\S]*left:\s*0;[\s\S]*right:\s*0;[\s\S]*bottom:\s*0;[\s\S]*overflow:\s*hidden;[\s\S]*overscroll-behavior:\s*none;[\s\S]*touch-action:\s*none;[\s\S]*display:\s*flex;[\s\S]*flex-direction:\s*column;[\s\S]*padding:\s*8px/
  );
  assert.doesNotMatch(deskRule, /padding-top:\s*var\(--bar-height\)/);
  assert.doesNotMatch(deskRule, /padding:\s*calc\(var\(--bar-height\)/);
  assert.doesNotMatch(deskRule, /--safe-top/);
  assert.doesNotMatch(css, /\.editor-body \.desk\s*\{[\s\S]*min-height:\s*100dvh;/);
  assert.doesNotMatch(css, /--mobile-editor-bottom-gap/);
  assert.doesNotMatch(css, /--keyboard-offset/);
  assert.match(
    css,
    /\.editor-body \.sheet\s*\{[\s\S]*flex:\s*1 1 0;[\s\S]*min-height:\s*0;[\s\S]*overflow:\s*hidden;[\s\S]*overscroll-behavior:\s*none;[\s\S]*touch-action:\s*none;/
  );
  assert.match(
    css,
    /\.editor-body \.well\s*\{[\s\S]*flex:\s*1 1 0;[\s\S]*min-height:\s*0;[\s\S]*margin:\s*clamp\(28px,\s*8vw,\s*36px\)\s+clamp\(20px,\s*6vw,\s*24px\);[\s\S]*overflow:\s*hidden;/
  );
  assert.match(
    css,
    /\.editor-body \.input,\s*\.editor-body \.mirror\s*\{[\s\S]*padding:\s*0;[\s\S]*line-height:\s*1\.72;/
  );
  assert.match(
    css,
    /\.editor-body \.input\s*\{[\s\S]*position:\s*absolute;[\s\S]*inset:\s*0;[\s\S]*width:\s*100%;[\s\S]*height:\s*100%;[\s\S]*overflow-y:\s*auto;[\s\S]*-webkit-overflow-scrolling:\s*touch;[\s\S]*touch-action:\s*pan-y;[\s\S]*overscroll-behavior:\s*contain;/
  );
  assert.doesNotMatch(bodyRule, /touch-action:\s*pan-y;/);
  assert.match(css, /\.editor-body \.mirror\s*\{[\s\S]*position:\s*absolute;[\s\S]*inset:\s*0;/);
  assert.match(css, /\.editor-body \.completion-bar\s*\{[\s\S]*position:\s*static;/);
  assert.match(
    css,
    /\.editor-body \.hint\s*\{[\s\S]*position:\s*absolute;[\s\S]*bottom:\s*8px;[\s\S]*pointer-events:\s*none;/
  );
  assert.doesNotMatch(css, /\.editor-body \.hint\s*\{[\s\S]*position:\s*static;/);
  assert.doesNotMatch(css, /\.editor-body \.hint\s*\{[\s\S]*min-height:\s*16px;/);
  assert.match(css, /\.editor-body \.toast\s*\{[\s\S]*position:\s*absolute;[\s\S]*bottom:\s*12px;/);
});

test('mobile stage changes preserve desktop A4 and scrolling pages', async () => {
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');

  assert.match(css, /min-height:\s*1123px;\s*\/\* A4 at 96dpi \*\//);
  assert.match(
    css,
    /\.archive,\s*\.settings,\s*\.reader\s*\{[\s\S]*calc\(44px \+ var\(--safe-bottom\)\)/
  );
});

test('visual viewport drives app height and mobile resize stays CSS-owned', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(
    appJs,
    /window\.matchMedia\('\(max-width: 640px\), \(\(hover: none\) and \(pointer: coarse\) and \(max-height: 500px\)\)'\)/
  );
  assert.match(
    appJs,
    /const viewportHeight = hasVisualViewport && window\.visualViewport[\s\S]*Math\.round\(window\.visualViewport\.height\)[\s\S]*Math\.round\(window\.innerHeight\);/
  );
  assert.match(
    appJs,
    /root\.style\.setProperty\('--app-height', `\$\{Math\.max\(viewportHeight, 1\)\}px`\);/
  );
  assert.match(
    appJs,
    /root\.style\.setProperty\('--bar-height', `\$\{barHeight\}px`\);/
  );
  assert.doesNotMatch(appJs, /--app-offset-top/);
  assert.doesNotMatch(appJs, /offsetTop/);
  assert.match(
    appJs,
    /if \(mobileLayout\?\.matches\) \{[\s\S]*syncViewportMetrics\(\);[\s\S]*return;\s*\}/
  );
  assert.doesNotMatch(
    appJs,
    /if \(mobileLayout\?\.matches\) \{[\s\S]*input\.style\.height = `\$\{contentHeight\}px`;/
  );
  assert.doesNotMatch(appJs, /paperFloor|contentHeight > paperFloor/);
  assert.match(appJs, /input\.style\.height = 'auto';[\s\S]*const nextHeight = Math\.max\(input\.scrollHeight, mirrorHeight, 1\);/);
  assert.match(
    appJs,
    /document\.addEventListener\('touchmove',[\s\S]*target\.closest\('textarea, button, a'\)[\s\S]*event\.preventDefault\(\);[\s\S]*passive:\s*false/
  );
});

test('keepInputVisible scrolls textarea on mobile and not window', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(
    appJs,
    /if \(mobileLayout\?\.matches\) \{[\s\S]*input\.scrollTop = targetBottom - input\.clientHeight;[\s\S]*return;\s*\}[\s\S]*window\.scrollBy\(0, rect\.top - top\);/
  );
});

test('desk tap-to-focus behavior remains intact', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(
    appJs,
    /deskEl\?\.addEventListener\('click',[\s\S]*input\.focus\(\);/
  );
});
