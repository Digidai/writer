import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reopenDocument, restoreDocument } from '../src/archive-actions.js';

const DOC_ID = '123e4567-e89b-12d3-a456-426614174000';

test('restore trash -> archived re-upserts the document vector', async () => {
  let aiCalls = 0;
  let upsertCalls = 0;
  const env = {
    WRITER_ACCESS_KEY: 'secret',
    AI: {
      async run(model, payload) {
        aiCalls += 1;
        assert.equal(model, '@cf/baai/bge-m3');
        assert.deepEqual(payload, { text: ['Title\n\nSummary\n\nBody'] });
        return { data: [[0.1, 0.2, 0.3]] };
      },
    },
    ARCHIVE_INDEX: {
      async upsert(entries) {
        upsertCalls += 1;
        assert.equal(entries.length, 1);
        assert.equal(entries[0].id, DOC_ID);
        assert.deepEqual(entries[0].values, [0.1, 0.2, 0.3]);
      },
    },
    DB: {
      prepare(sql) {
        if (sql.includes("WHERE id = ? AND status = 'deleted'")) {
          return {
            bind(updatedAt, id) {
              assert.equal(typeof updatedAt, 'string');
              assert.equal(id, DOC_ID);
              return { async run() { return { meta: { changes: 1 } }; } };
            },
          };
        }
        if (sql === 'SELECT status FROM documents WHERE id = ?') {
          return {
            bind(id) {
              assert.equal(id, DOC_ID);
              return { async first() { return { status: 'archived' }; } };
            },
          };
        }
        if (sql.includes("WHERE id = ? AND status = 'archived'")) {
          return {
            bind(id) {
              assert.equal(id, DOC_ID);
              return {
                async first() {
                  return {
                    id: DOC_ID,
                    title: 'Title',
                    summary: 'Summary',
                    content: 'Body',
                    formatted: '',
                    category: 'Notes',
                    archived_at: '2026-08-16T00:00:00.000Z',
                  };
                },
              };
            },
          };
        }
        throw new Error(`Unexpected SQL in restore archived test: ${sql}`);
      },
    },
  };

  const res = await restoreDocument(env, DOC_ID);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: DOC_ID, status: 'archived' });
  assert.equal(aiCalls, 1);
  assert.equal(upsertCalls, 1);
});

test('restore trash -> draft does not upsert a vector', async () => {
  let aiCalls = 0;
  let upsertCalls = 0;
  const env = {
    WRITER_ACCESS_KEY: 'secret',
    AI: { async run() { aiCalls += 1; return { data: [[0.1, 0.2]] }; } },
    ARCHIVE_INDEX: { async upsert() { upsertCalls += 1; } },
    DB: {
      prepare(sql) {
        if (sql.includes("WHERE id = ? AND status = 'deleted'")) {
          return {
            bind(_updatedAt, id) {
              assert.equal(id, DOC_ID);
              return { async run() { return { meta: { changes: 1 } }; } };
            },
          };
        }
        if (sql === 'SELECT status FROM documents WHERE id = ?') {
          return {
            bind(id) {
              assert.equal(id, DOC_ID);
              return { async first() { return { status: 'draft' }; } };
            },
          };
        }
        if (sql.includes("WHERE id = ? AND status = 'archived'")) {
          throw new Error('archived fetch should not run when restored status is draft');
        }
        throw new Error(`Unexpected SQL in restore draft test: ${sql}`);
      },
    },
  };

  const res = await restoreDocument(env, DOC_ID);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: DOC_ID, status: 'draft' });
  assert.equal(aiCalls, 0);
  assert.equal(upsertCalls, 0);
});

test('restore when not in trash returns 404', async () => {
  const env = {
    DB: {
      prepare(sql) {
        assert.match(sql, /WHERE id = \? AND status = 'deleted'/);
        return {
          bind() {
            return { async run() { return { meta: { changes: 0 } }; } };
          },
        };
      },
    },
  };

  const res = await restoreDocument(env, DOC_ID);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not in trash' });
});

test('reopen returns 409 for processing and deleted rows', async () => {
  for (const status of ['processing', 'deleted']) {
    const env = {
      DB: {
        prepare(sql) {
          assert.equal(sql, 'SELECT * FROM documents WHERE id = ?');
          return {
            bind(id) {
              assert.equal(id, DOC_ID);
              return { async first() { return { id, status, content: 'text' }; } };
            },
          };
        },
      },
    };
    const res = await reopenDocument(env, DOC_ID);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: status, status });
  }
});
