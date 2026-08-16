import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchDocumentsData } from '../src/search-endpoint.js';

test('semantic search falls back to keyword mode when semantic bindings are unavailable', async () => {
  const env = {
    WRITER_ACCESS_KEY: 'secret',
    DB: {
      prepare(sql) {
        assert.match(sql, /FROM documents/);
        return {
          bind(...args) {
            assert.equal(args.length >= 4, true);
            return {
              async all() {
                return {
                  results: [
                    {
                      id: '7f2f3c8f-562f-4b7f-8f4e-f2fa2af99e2e',
                      title: 'Result',
                      status: 'archived',
                      category: 'Notes',
                      tags: '["demo"]',
                      summary: 'match',
                      created_at: '2026-08-16T00:00:00.000Z',
                      updated_at: '2026-08-16T00:00:00.000Z',
                      archived_at: '2026-08-16T00:00:00.000Z',
                    },
                  ],
                };
              },
            };
          },
        };
      },
    },
  };

  const body = await searchDocumentsData(env, new URL('https://writer.example/api/search?q=demo&mode=semantic'));
  assert.equal(body.mode, 'keyword');
  assert.equal(body.fallback, true);
  assert.equal(body.documents.length, 1);
});
