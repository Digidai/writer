import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeLike, hydrateArchivedRowsByIds, parseSearchMode } from '../src/search.js';
import { searchDocumentsData } from '../src/search-endpoint.js';

test('escapeLike escapes %, _ and backslash for LIKE queries', () => {
  assert.equal(escapeLike('100%_done\\ok'), '100\\%\\_done\\\\ok');
});

test('hydrateArchivedRowsByIds preserves id order and drops duplicates/unknown ids', async () => {
  const input = ['id-2', 'id-1', 'id-2', 'missing', 'id-3'];
  const env = {
    DB: {
      prepare(sql) {
        assert.match(sql, /WHERE status = 'archived' AND id IN/);
        return {
          bind(...ids) {
            assert.deepEqual(ids, ['id-2', 'id-1', 'missing', 'id-3']);
            return {
              async all() {
                return {
                  results: [
                    { id: 'id-3', title: 'third' },
                    { id: 'id-1', title: 'first' },
                    { id: 'id-2', title: 'second' },
                  ],
                };
              },
            };
          },
        };
      },
    },
  };

  const out = await hydrateArchivedRowsByIds(env, input, { limit: 10 });
  assert.deepEqual(out.map((row) => row.id), ['id-2', 'id-1', 'id-3']);
});

test('parseSearchMode only treats exact "semantic" as semantic', () => {
  assert.equal(parseSearchMode('semantic'), 'semantic');
  for (const mode of ['Semantic', ' semantic', 'semantic ', 'SEMANTIC', '', 'keyword', null, undefined]) {
    assert.equal(parseSearchMode(mode), 'keyword');
  }
});

test('mode=semantic without access key still returns keyword mode with fallback false', async () => {
  let semanticCalls = 0;
  const env = {
    WRITER_ACCESS_KEY: '',
    AI: { async run() { throw new Error('AI should not run without access key'); } },
    ARCHIVE_INDEX: {
      async query() {
        semanticCalls += 1;
        throw new Error('Vector query should not run without access key');
      },
    },
    DB: {
      prepare(sql) {
        assert.match(sql, /FROM documents/);
        return {
          bind(...args) {
            assert.equal(args.length >= 4, true);
            return {
              async all() {
                return {
                  results: [{
                    id: '7f2f3c8f-562f-4b7f-8f4e-f2fa2af99e2e',
                    title: 'Keyword result',
                    status: 'archived',
                    category: 'Notes',
                    tags: '[]',
                    summary: 'match',
                    created_at: '2026-08-16T00:00:00.000Z',
                    updated_at: '2026-08-16T00:00:00.000Z',
                    archived_at: '2026-08-16T00:00:00.000Z',
                  }],
                };
              },
            };
          },
        };
      },
    },
  };

  const out = await searchDocumentsData(env, new URL('https://writer.example/api/search?q=demo&mode=semantic'));
  assert.equal(out.mode, 'keyword');
  assert.equal(out.fallback, false);
  assert.equal(out.documents.length, 1);
  assert.equal(semanticCalls, 0);
});
