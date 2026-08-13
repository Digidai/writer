import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, escapeHtml } from '../src/markdown.js';

test('escapes HTML in every position', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  const html = renderMarkdown('# <img src=x onerror=alert(1)>\n\n<b>hi</b>');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<b>hi'));
  assert.ok(html.includes('&lt;img'));
});

test('renders headings, lists and tasks', () => {
  assert.equal(renderMarkdown('## 标题'), '<h2>标题</h2>');
  assert.equal(renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(renderMarkdown('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  const tasks = renderMarkdown('- [ ] todo\n- [x] done');
  assert.ok(tasks.includes('<li class="task">todo</li>'));
  assert.ok(tasks.includes('<li class="task done">done</li>'));
});

test('renders Chinese ordered lists written with 、and )', () => {
  assert.equal(renderMarkdown('1、甲\n2、乙'), '<ol><li>甲</li><li>乙</li></ol>');
});

test('keeps code spans literal and unstyled', () => {
  const html = renderMarkdown('use `**not bold**` here');
  assert.ok(html.includes('<code>**not bold**</code>'));
  assert.ok(!html.includes('<strong>'));
});

test('code fences are escaped, not parsed', () => {
  const html = renderMarkdown('```\n<b>&\n```');
  assert.equal(html, '<pre><code>&lt;b&gt;&amp;</code></pre>');
});

test('only http(s) links survive', () => {
  assert.ok(renderMarkdown('[x](https://a.com)').includes('href="https://a.com"'));
  const bad = renderMarkdown('[x](javascript:alert(1))');
  assert.ok(!bad.includes('href'));
});

test('inline emphasis works', () => {
  assert.equal(renderMarkdown('**粗** 与 *斜*'), '<p><strong>粗</strong> 与 <em>斜</em></p>');
});

test('paragraph lines join with <br>, blank lines split paragraphs', () => {
  assert.equal(renderMarkdown('a\nb\n\nc'), '<p>a<br>b</p>\n<p>c</p>');
});

test('the NUL code-span sentinel cannot be injected from content', () => {
  const html = renderMarkdown('\u00000\u0000 plain `code`');
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(!html.includes('\u0000'));
});

test('deeply nested blockquotes do not blow the stack', () => {
  const html = renderMarkdown('>'.repeat(5000) + ' deep');
  assert.ok(html.startsWith('<blockquote>'));
  assert.ok(html.includes('deep'));
});

test('very long documents render in reasonable time', () => {
  const src = Array.from({ length: 4000 }, (_, i) => `段落 ${i} with *emphasis* and \`code\`.`).join('\n\n');
  const started = Date.now();
  const html = renderMarkdown(src);
  assert.ok(html.length > 0);
  assert.ok(Date.now() - started < 3000, 'renderer should not backtrack catastrophically');
});
