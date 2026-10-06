import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WriterPipeline, docOwnerScope, archiveMeta } from '../src/pipeline.js';
import { createEnv } from './helpers/env.js';

function seed(DB) {
  const insert = DB.raw.prepare(
    `INSERT INTO documents (id, title, content, status, category, created_at, updated_at, archived_at, user_id, anon_id)
     VALUES (?, ?, ?, 'archived', ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?, NULL)`
  );
  insert.run('a1', 'Alice on rivers', 'river water', 'Nature', 'alice');
  insert.run('a2', 'Alice on rain', 'rain and river', 'Nature', 'alice');
  insert.run('b1', 'Bob secret plans', 'river heist', 'Crime', 'bob');
  insert.run('l1', 'Legacy note', 'river legacy', 'Old', null);
}

test("the agent's tools only see the document owner's archive", async () => {
  const { env, DB } = createEnv();
  seed(DB);
  const pipeline = new WriterPipeline({}, env);
  const aliceDoc = { id: 'new', user_id: 'alice', anon_id: null };

  const cats = await pipeline.runTool({ name: 'list_categories', args: {} }, aliceDoc);
  assert.deepEqual(cats.categories.map((c) => c.category), ['Nature']);
  assert.ok(cats.recent.every((r) => r.title.startsWith('Alice')));

  const found = await pipeline.runTool({ name: 'search_archive', args: { query: 'river' } }, aliceDoc);
  assert.deepEqual(found.results.map((r) => r.id).sort(), ['a1', 'a2']);

  const legacy = await pipeline.runTool({ name: 'search_archive', args: { query: 'river' } }, { id: 'x', user_id: null, anon_id: null });
  assert.deepEqual(legacy.results.map((r) => r.id), ['l1']);
});

test('owner scopes', () => {
  assert.deepEqual(docOwnerScope({ user_id: 'u' }), { sql: 'user_id = ?', binds: ['u'] });
  assert.deepEqual(docOwnerScope({ anon_id: 'a' }), { sql: '(user_id IS NULL AND anon_id = ?)', binds: ['a'] });
  assert.deepEqual(docOwnerScope({}), { sql: '(user_id IS NULL AND anon_id IS NULL)', binds: [] });
});

test('archive metadata records model, fallback and heuristic use', () => {
  const meta = archiveMeta([
    { turn: 1, model: '@cf/moonshotai/kimi-k2.6' },
    { turn: 2, model: '@cf/qwen/qwen3-30b-a3b-fp8' },
    { turn: 'persist', skipped: true },
  ], { title: 'x' }, 'Nature');
  assert.deepEqual(meta, { turns: 2, model: 'qwen3-30b-a3b-fp8', fallback: true, heuristic: false, category: 'Nature' });
  assert.equal(archiveMeta([], null, '').heuristic, true);
});
