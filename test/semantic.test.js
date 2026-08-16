import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  semanticFeatureEnabled,
  firstEmbeddingVector,
  deleteDocumentVector,
  backfillArchiveVectors,
} from '../src/semantic.js';

const DOC_ID = '123e4567-e89b-12d3-a456-426614174000';

test('semanticFeatureEnabled requires key + ARCHIVE_INDEX + AI', () => {
  assert.equal(semanticFeatureEnabled(null), false);
  assert.equal(semanticFeatureEnabled({ WRITER_ACCESS_KEY: '', ARCHIVE_INDEX: {}, AI: {} }), false);
  assert.equal(semanticFeatureEnabled({ WRITER_ACCESS_KEY: 'secret', ARCHIVE_INDEX: null, AI: {} }), false);
  assert.equal(semanticFeatureEnabled({ WRITER_ACCESS_KEY: 'secret', ARCHIVE_INDEX: {}, AI: null }), false);
  assert.equal(semanticFeatureEnabled({ WRITER_ACCESS_KEY: 'secret', ARCHIVE_INDEX: {}, AI: {} }), true);
});

test('firstEmbeddingVector accepts all supported payload shapes', () => {
  assert.deepEqual(firstEmbeddingVector({ data: [[1, '2', 3]] }), [1, 2, 3]);
  assert.deepEqual(firstEmbeddingVector({ result: { data: [[4, 5]] } }), [4, 5]);
  assert.deepEqual(firstEmbeddingVector({ embeddings: [[6, 7]] }), [6, 7]);
  assert.deepEqual(firstEmbeddingVector({ data: [{ embedding: [8, 9] }] }), [8, 9]);
});

test('deleteDocumentVector prefers deleteByIds when available', async () => {
  let byIdsCalls = 0;
  let deleteCalls = 0;
  const env = {
    WRITER_ACCESS_KEY: 'secret',
    AI: {},
    ARCHIVE_INDEX: {
      async deleteByIds(ids) {
        byIdsCalls += 1;
        assert.deepEqual(ids, [DOC_ID]);
      },
      async delete() {
        deleteCalls += 1;
      },
    },
  };

  const ok = await deleteDocumentVector(env, DOC_ID);
  assert.equal(ok, true);
  assert.equal(byIdsCalls, 1);
  assert.equal(deleteCalls, 0);
});

test('deleteDocumentVector falls back to delete when deleteByIds is absent', async () => {
  let deleteCalls = 0;
  const env = {
    WRITER_ACCESS_KEY: 'secret',
    AI: {},
    ARCHIVE_INDEX: {
      async delete(ids) {
        deleteCalls += 1;
        assert.deepEqual(ids, [DOC_ID]);
      },
    },
  };

  const ok = await deleteDocumentVector(env, DOC_ID);
  assert.equal(ok, true);
  assert.equal(deleteCalls, 1);
});

test('backfillArchiveVectors no-ops when instance is unlocked', async () => {
  let aiCalls = 0;
  let upsertCalls = 0;
  const env = {
    WRITER_ACCESS_KEY: '',
    AI: { async run() { aiCalls += 1; return { data: [[0.1]] }; } },
    ARCHIVE_INDEX: { async upsert() { upsertCalls += 1; } },
    DB: {
      prepare() {
        throw new Error('DB should not be queried when semantic features are disabled');
      },
    },
  };

  const out = await backfillArchiveVectors(env, { limit: 5 });
  assert.deepEqual(out, { indexed: 0, skipped: 0, remaining: 0 });
  assert.equal(aiCalls, 0);
  assert.equal(upsertCalls, 0);
});

test('backfillArchiveVectors falls back to legacy SQL when tracking columns are missing', async () => {
  let primaryQueryTried = false;
  let fallbackQueryUsed = false;
  let aiCalls = 0;
  let upsertCalls = 0;
  const env = {
    WRITER_ACCESS_KEY: 'secret',
    AI: {
      async run() {
        aiCalls += 1;
        return { result: { data: [[0.2, 0.4, 0.6]] } };
      },
    },
    ARCHIVE_INDEX: {
      async upsert(entries) {
        upsertCalls += 1;
        assert.equal(entries.length, 1);
        assert.equal(entries[0].id, DOC_ID);
      },
    },
    DB: {
      prepare(sql) {
        if (sql.includes('SELECT id, title, summary, content, formatted, category, archived_at')
          && sql.includes('vector_indexed_at')) {
          return {
            bind(limit) {
              assert.equal(limit, 5);
              return {
                async all() {
                  primaryQueryTried = true;
                  throw new Error('no such column: vector_indexed_at');
                },
              };
            },
          };
        }
        if (sql.includes('SELECT id, title, summary, content, formatted, category, archived_at')
          && sql.includes('ORDER BY COALESCE(archived_at, updated_at, created_at) ASC')) {
          return {
            bind(limit) {
              assert.equal(limit, 5);
              return {
                async all() {
                  fallbackQueryUsed = true;
                  return {
                    results: [{
                      id: DOC_ID,
                      title: 'Legacy',
                      summary: 'Old record',
                      content: 'Body',
                      formatted: '',
                      category: 'Notes',
                      archived_at: '2026-08-16T00:00:00.000Z',
                    }],
                  };
                },
              };
            },
          };
        }
        if (sql.includes('SET vector_indexed_at = ?, vector_index_attempted_at = ?')) {
          return {
            bind(indexedAt, attemptedAt, id) {
              assert.equal(typeof indexedAt, 'string');
              assert.equal(typeof attemptedAt, 'string');
              assert.equal(id, DOC_ID);
              return { async run() { return { meta: { changes: 1 } }; } };
            },
          };
        }
        if (sql.includes('SELECT COUNT(*) AS remaining')) {
          return {
            async first() {
              return { remaining: 0 };
            },
          };
        }
        throw new Error(`Unexpected SQL in legacy fallback test: ${sql}`);
      },
    },
  };

  const out = await backfillArchiveVectors(env, { limit: 5 });
  assert.equal(primaryQueryTried, true);
  assert.equal(fallbackQueryUsed, true);
  assert.equal(aiCalls, 1);
  assert.equal(upsertCalls, 1);
  assert.deepEqual(out, { indexed: 1, skipped: 0, remaining: 0 });
});
