import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateDocument } from '../src/document-update.js';
import { createEnv } from './helpers/env.js';

const DOC_ID = '123e4567-e89b-12d3-a456-426614174000';
const REV = '2026-10-01T00:00:00.000Z';
const owner = { user: { id: 'u1' }, anonId: null, cookies: [] };

function put(content, rev) {
  return new Request(`https://writer.example/api/documents/${DOC_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rev === undefined ? { content } : { content, rev }),
  });
}

function seed(DB, { status = 'draft', user = 'u1', anon = null } = {}) {
  DB.raw.prepare(
    `INSERT INTO documents (id, title, content, status, created_at, updated_at, user_id, anon_id)
     VALUES (?, '', 'old', ?, ?, ?, ?, ?)`
  ).run(DOC_ID, status, REV, REV, user, anon);
}

test('PUT /api/documents/:id requires rev', async () => {
  const res = await updateDocument(put('hello world'), { DB: {} }, DOC_ID, { viewer: owner });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'rev required' });
});

test('a matching rev saves and moves the rev forward', async () => {
  const { env, DB } = createEnv();
  seed(DB);
  const res = await updateDocument(put('new words', REV), env, DOC_ID, { viewer: owner });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.notEqual(body.updated_at, REV);
  assert.equal(DB.get('SELECT content FROM documents').content, 'new words');
});

test('a stale rev is a 409 conflict, not a silent overwrite', async () => {
  const { env, DB } = createEnv();
  seed(DB);
  const res = await updateDocument(put('new words', '2026-01-01T00:00:00.000Z'), env, DOC_ID, { viewer: owner });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'conflict', status: 'draft' });
  assert.equal(DB.get('SELECT content FROM documents').content, 'old');
});

test('only drafts can be written, and only by their owner', async () => {
  const { env, DB } = createEnv();
  seed(DB, { status: 'archived' });
  const archived = await updateDocument(put('x', REV), env, DOC_ID, { viewer: owner });
  assert.equal(archived.status, 409);
  assert.equal((await archived.json()).status, 'archived');

  const other = { user: { id: 'u2' }, anonId: null, cookies: [] };
  assert.equal((await updateDocument(put('x', REV), env, DOC_ID, { viewer: other })).status, 404);
  assert.equal((await updateDocument(put('x', REV), env, DOC_ID, {})).status, 404);
});

test('an anonymous browser can keep writing its own draft', async () => {
  const { env, DB } = createEnv();
  seed(DB, { user: null, anon: 'anon-browser-id-0001' });
  const anon = { user: null, anonId: 'anon-browser-id-0001', cookies: [] };
  assert.equal((await updateDocument(put('more', REV), env, DOC_ID, { viewer: anon })).status, 200);
  const otherAnon = { user: null, anonId: 'anon-browser-id-0002', cookies: [] };
  assert.equal((await updateDocument(put('more', REV), env, DOC_ID, { viewer: otherAnon })).status, 404);
});
