import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleExportRequest } from '../src/export.js';
import { createEnv } from './helpers/env.js';

const writer = { user: { id: 'u1', email: 'u1@example.com' }, anonId: null, cookies: [] };

test('export needs an account', async () => {
  const res = await handleExportRequest(new Request('https://writer.example/api/export'), { DB: {} }, { user: null });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'auth_required' });
});

test('HEAD /api/export reports availability to signed-in writers', async () => {
  const res = await handleExportRequest(new Request('https://writer.example/api/export', { method: 'HEAD' }), { DB: {} }, writer);
  assert.equal(res.status, 204);
});

test('GET /api/export returns 413 past 200 archived pieces', async () => {
  const { env, DB } = createEnv();
  const insert = DB.raw.prepare(
    `INSERT INTO documents (id, title, content, formatted, status, created_at, updated_at, archived_at, user_id)
     VALUES (?, ?, 'x', 'x', 'archived', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'u1')`
  );
  for (let i = 0; i < 201; i++) insert.run(`doc-${i}`, `Doc ${i}`);
  const res = await handleExportRequest(new Request('https://writer.example/api/export'), env, writer);
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: 'export too large' });
});
