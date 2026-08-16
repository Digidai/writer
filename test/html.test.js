import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDocumentPage } from '../src/html.js';

const DOC_ID = '123e4567-e89b-12d3-a456-426614174000';

test('reader page escapes title/category/tags/summary and keeps markdown links http(s)-only', () => {
  const html = renderDocumentPage({
    id: DOC_ID,
    status: 'archived',
    title: '<script>alert(1)</script>',
    category: '<img src=x onerror=alert(1)>',
    tags: JSON.stringify(['safe', '<script>alert(1)</script>']),
    summary: '<script>alert(1)</script>',
    content: '[bad](javascript:alert(1))\n[ok](https://example.com)',
    formatted: '[bad](javascript:alert(1))\n[ok](https://example.com)',
    archived_at: '2026-08-16T00:00:00.000Z',
    updated_at: '2026-08-16T00:00:00.000Z',
  }, 'en');

  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('<h1 class="doc-title">&lt;script&gt;alert(1)&lt;/script&gt;</h1>'));
  assert.ok(html.includes('<span class="chip">&lt;img src=x onerror=alert(1)&gt;</span>'));
  assert.ok(html.includes('<span class="tag">&lt;script&gt;alert(1)&lt;/script&gt;</span>'));
  assert.ok(html.includes('<p class="doc-summary">&lt;script&gt;alert(1)&lt;/script&gt;</p>'));

  assert.ok(!html.includes('href="javascript:alert(1)"'));
  assert.ok(html.includes('href="https://example.com"'));
});
