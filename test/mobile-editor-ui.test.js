import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MESSAGES } from '../public/i18n.js';

test('mobile empty hint copy avoids completion-control verbs', () => {
  assert.doesNotMatch(MESSAGES.en['editor.hintMobile'], /\b(Accept|Dismiss|Tab)\b/i);
  assert.match(MESSAGES.en['editor.hintMobileGhost'], /\bAccept\b/i);

  assert.doesNotMatch(MESSAGES.zh['editor.hintMobile'], /采纳|忽略|Tab|tab/);
  assert.match(MESSAGES.zh['editor.hintMobileGhost'], /采纳/);
});

test('mobile completion visibility still depends on ghost presence', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(
    appJs,
    /const visible = useTouchCompletionUi\(\) && Boolean\(state\.ghost\);/
  );
  assert.match(
    appJs,
    /const key = touchUi && state\.ghost[\s\S]*editor\.hintMobileGhost[\s\S]*editor\.hintMobile[\s\S]*editor\.hint/
  );
});

test('mobile editor CSS fills viewport and keeps completion spacing conditional', async () => {
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');

  assert.doesNotMatch(css, /min-height:\s*clamp\(320px,\s*56dvh,\s*520px\);/);
  assert.match(css, /min-height:\s*1123px;\s*\/\* A4 at 96dpi \*\//);
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
    /\.sheet\s*\{[\s\S]*min-height:\s*calc\(100dvh - \(var\(--bar-height\) \+ 12px \+ var\(--safe-top\)\) - var\(--mobile-editor-bottom-gap\)\);/
  );
});
