import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reopenDocument, restoreDocument } from '../src/archive-actions.js';
import { createEnv } from './helpers/env.js';

const DOC_ID = '123e4567-e89b-12d3-a456-426614174000';
const owner = { user: { id: 'u1', email: 'u1@example.com' }, anonId: null, cookies: [] };
const stranger = { user: { id: 'u2', email: 'u2@example.com' }, anonId: null, cookies: [] };

function semanticWorld() {
  const calls = { upserts: [], deletes: [] };
  const world = createEnv({
    WRITER_ACCESS_KEY: 'secret',
    AI: { async run() { return { data: [[0.1, 0.2, 0.3]] }; } },
    ARCHIVE_INDEX: {
      async upsert(entries) { calls.upserts.push(...entries); },
      async deleteByIds(ids) { calls.deletes.push(...ids); },
    },
  });
  return { ...world, calls };
}

function addDoc(DB, { status, archived = true, user = 'u1' }) {
  DB.raw.prepare(
    `INSERT INTO documents (id, title, summary, content, formatted, status, category, created_at, updated_at, archived_at, deleted_at, user_id)
     VALUES (?, 'Title', 'Summary', 'Body', '', ?, 'Notes', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?, ?, ?)`
  ).run(DOC_ID, status, archived ? '2026-10-01T00:00:00.000Z' : null, status === 'deleted' ? '2026-10-02T00:00:00.000Z' : null, user);
}

test('restore trash -> archived re-upserts the vector with its owner', async () => {
  const { env, DB, calls } = semanticWorld();
  addDoc(DB, { status: 'deleted' });
  const res = await restoreDocument(env, DOC_ID, owner);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: DOC_ID, status: 'archived' });
  assert.equal(calls.upserts.length, 1);
  assert.equal(calls.upserts[0].metadata.user_id, 'u1');
});

test('restore trash -> draft does not upsert a vector', async () => {
  const { env, DB, calls } = semanticWorld();
  addDoc(DB, { status: 'deleted', archived: false });
  const res = await restoreDocument(env, DOC_ID, owner);
  assert.deepEqual(await res.json(), { id: DOC_ID, status: 'draft' });
  assert.equal(calls.upserts.length, 0);
});

test('restore when not in trash, or not yours, returns 404', async () => {
  const { env, DB } = createEnv();
  addDoc(DB, { status: 'archived' });
  assert.equal((await restoreDocument(env, DOC_ID, owner)).status, 404);
  DB.raw.prepare(`UPDATE documents SET status = 'deleted'`).run();
  assert.equal((await restoreDocument(env, DOC_ID, stranger)).status, 404);
  assert.equal(DB.get('SELECT status FROM documents').status, 'deleted');
});

test('reopen returns 409 for processing and deleted rows', async () => {
  for (const status of ['processing', 'deleted']) {
    const { env, DB } = createEnv();
    addDoc(DB, { status });
    const res = await reopenDocument(env, DOC_ID, owner);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: status, status });
  }
});

test('reopen an archived document: back to a draft, vector removed; strangers get 404', async () => {
  const { env, DB, calls } = semanticWorld();
  addDoc(DB, { status: 'archived' });
  assert.equal((await reopenDocument(env, DOC_ID, stranger)).status, 404);
  const res = await reopenDocument(env, DOC_ID, owner);
  assert.equal(res.status, 200);
  assert.equal(DB.get('SELECT status FROM documents').status, 'draft');
  assert.deepEqual(calls.deletes, [DOC_ID]);
});
