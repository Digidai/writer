import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MESSAGES } from '../public/i18n.js';

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

test('mobile editor CSS uses flex-fill paper and avoids bar/safe double counts', async () => {
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
    /\.sheet\s*\{[\s\S]*flex:\s*1 1 auto;[\s\S]*min-height:\s*0;[\s\S]*--paper-pad-block:[\s\S]*padding:\s*var\(--paper-pad-block\) var\(--paper-pad-inline\);/
  );
  assert.match(
    css,
    /\.input,\s*\.mirror\s*\{[\s\S]*padding:\s*0;[\s\S]*line-height:\s*1\.72;/
  );
  assert.match(
    css,
    /\.mirror\s*\{[\s\S]*inset:\s*var\(--paper-pad-block\) var\(--paper-pad-inline\);/
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

test('resize keeps a mobile paper floor and desk taps focus input', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(
    appJs,
    /const paperFloor = mobileLayout\?\.matches && sheet[\s\S]*sheet\.clientHeight - sheetPaddingTop - sheetPaddingBottom/
  );
  assert.match(
    appJs,
    /const nextHeight = Math\.max\(input\.scrollHeight, mirrorHeight, paperFloor, 1\);/
  );
  assert.match(
    appJs,
    /deskEl\?\.addEventListener\('click',[\s\S]*input\.focus\(\);/
  );
});
