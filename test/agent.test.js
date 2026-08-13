import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTitle, sanitizeTags, clip, markdownFile, heuristicMeta } from '../src/agent.js';
import { polishCompletion } from '../src/ai.js';

test('deriveTitle takes the first meaningful line without its heading marks', () => {
  assert.equal(deriveTitle('## 河边的傍晚\n正文'), '河边的傍晚');
  assert.equal(deriveTitle('\n\n  第一行  \n第二行'), '第一行');
  assert.equal(deriveTitle(''), '');
  assert.equal(deriveTitle('  \n \n'), '');
});

test('deriveTitle clips runaway first lines', () => {
  assert.equal(deriveTitle('字'.repeat(200)).length, 48);
});

test('sanitizeTags rejects junk and caps at four', () => {
  assert.deepEqual(sanitizeTags(['a', ' b ', '', null, 3, 'c', 'd', 'e']), ['a', 'b', 'c', 'd']);
  assert.deepEqual(sanitizeTags('not an array'), []);
  assert.deepEqual(sanitizeTags(undefined), []);
  assert.equal(sanitizeTags(['字'.repeat(50)])[0].length, 24);
});

test('clip is total over non-strings', () => {
  assert.equal(clip(null, 5), '');
  assert.equal(clip(undefined, 5), '');
  assert.equal(clip('abcdef', 3), 'abc');
});

test('heuristicMeta always yields a filable document', () => {
  const meta = heuristicMeta('随手写的一段话，没有标题。', '');
  assert.equal(meta.title, '随手写的一段话，没有标题。');
  assert.equal(meta.category, '其他');
  assert.deepEqual(meta.tags, []);
  assert.ok(meta.summary.length > 0);
  assert.equal(heuristicMeta('', '').title, '未命名');
});

test('markdownFile writes valid, escaped front matter', () => {
  const md = markdownFile({
    title: '带"引号"的标题',
    category: '随笔',
    tags: ['a', 'b'],
    created_at: '2026-08-14T00:00:00.000Z',
    archived_at: '2026-08-14T01:00:00.000Z',
    formatted: '正文',
  });
  assert.ok(md.startsWith('---\n'));
  assert.ok(md.includes('title: "带\\"引号\\"的标题"'));
  assert.ok(md.includes('tags: ["a", "b"]'));
  assert.ok(md.trimEnd().endsWith('正文'));
});

test('markdownFile tolerates a document with nothing filled in', () => {
  const md = markdownFile({});
  assert.ok(md.includes('title: ""'));
  assert.ok(md.includes('category: "其他"'));
  assert.ok(md.includes('tags: []'));
});

test('polishCompletion strips the model echoing the context back', () => {
  assert.equal(polishCompletion('今天天气', '今天天气很好'), '很好');
  assert.equal(polishCompletion('hello', '"hello world"'), 'world');
});

test('polishCompletion keeps a suggestion to one paragraph', () => {
  assert.equal(polishCompletion('开头', '第一句。\n\n第二段'), '第一句。');
});

test('polishCompletion caps length at a sentence boundary', () => {
  const long = '这是一个很长的句子用来测试截断行为。' + '后面还有很多内容'.repeat(20);
  const out = polishCompletion('起点', long);
  assert.ok(out.length <= 80);
  assert.ok(out.endsWith('。'));
});

test('polishCompletion is total over empty and junk input', () => {
  assert.equal(polishCompletion('x', ''), '');
  assert.equal(polishCompletion('x', null), '');
  assert.equal(polishCompletion('x', '   '), '');
});
