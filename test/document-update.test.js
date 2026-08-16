import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateDocument } from '../src/document-update.js';

const DOC_ID = '123e4567-e89b-12d3-a456-426614174000';

test('PUT /api/documents/:id requires rev', async () => {
  const req = new Request(`https://writer.example/api/documents/${DOC_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hello world' }),
  });

  const res = await updateDocument(req, { DB: {} }, DOC_ID);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'rev required' });
});

test('PUT /api/documents/:id keeps 409 conflict semantics', async () => {
  const req = new Request(`https://writer.example/api/documents/${DOC_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hello world', rev: '2026-08-16T00:00:00.000Z' }),
  });

  const env = {
    DB: {
      prepare(sql) {
        if (/^UPDATE documents/.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  return { meta: { changes: 0 } };
                },
              };
            },
          };
        }
        assert.equal(sql, 'SELECT status FROM documents WHERE id = ?');
        return {
          bind() {
            return {
              async first() {
                return { status: 'draft' };
              },
            };
          },
        };
      },
    },
  };

  const res = await updateDocument(req, env, DOC_ID);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'conflict', status: 'draft' });
});
