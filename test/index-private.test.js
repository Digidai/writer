import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { WRITER_VERSION } from '../src/version.js';

const DOC_ID = '123e4567-e89b-12d3-a456-426614174000';

test('demo mode: /api/reindex is forbidden and /mcp is hidden', async () => {
  let aiCalls = 0;
  let upsertCalls = 0;
  const env = {
    WRITER_ACCESS_KEY: '',
    AI: { async run() { aiCalls += 1; return { data: [[0.1, 0.2]] }; } },
    ARCHIVE_INDEX: { async upsert() { upsertCalls += 1; } },
    ASSETS: { fetch: () => new Response('ok') },
  };

  const reindex = await worker.fetch(new Request('https://writer.example/api/reindex', { method: 'POST' }), env, {});
  assert.equal(reindex.status, 403);
  assert.deepEqual(await reindex.json(), { error: 'reindex unavailable in demo' });
  assert.equal(aiCalls, 0);
  assert.equal(upsertCalls, 0);

  const mcp = await worker.fetch(new Request('https://writer.example/mcp'), env, {});
  assert.equal(mcp.status, 404);
});

test('locked mode: /api/reindex runs one semantic backfill batch', async () => {
  let aiCalls = 0;
  let upsertCalls = 0;
  let markCalls = 0;
  let countCalls = 0;
  const env = {
    WRITER_ACCESS_KEY: 'secret',
    AI: {
      async run(model, payload) {
        aiCalls += 1;
        assert.equal(typeof model, 'string');
        assert.deepEqual(payload, { text: ['Archived title\n\nSummary\n\nBody'] });
        return { data: [[0.1, 0.2, 0.3]] };
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
              assert.equal(limit, 10);
              return {
                async all() {
                  return {
                    results: [{
                      id: DOC_ID,
                      title: 'Archived title',
                      summary: 'Summary',
                      content: 'Body',
                      formatted: '',
                      category: 'Notes',
                      archived_at: '2026-08-15T00:00:00.000Z',
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
              return {
                async run() {
                  markCalls += 1;
                  return { meta: { changes: 1 } };
                },
              };
            },
          };
        }
        if (sql.includes('SELECT COUNT(*) AS remaining')) {
          return {
            async first() {
              countCalls += 1;
              return { remaining: 0 };
            },
          };
        }
        throw new Error(`Unexpected SQL in test: ${sql}`);
      },
    },
    ASSETS: { fetch: () => new Response('ok') },
  };

  const req = new Request('https://writer.example/api/reindex', {
    method: 'POST',
    headers: { Authorization: 'Bearer secret' },
  });
  const res = await worker.fetch(req, env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { indexed: 1, skipped: 0, remaining: 0 });
  assert.equal(aiCalls, 1);
  assert.equal(upsertCalls, 1);
  assert.equal(markCalls, 1);
  assert.equal(countCalls, 1);
});

test('mcp endpoint: key/auth/method semantics and initialize/tools', async () => {
  const noKey = await worker.fetch(new Request('https://writer.example/mcp'), {
    WRITER_ACCESS_KEY: '',
    ASSETS: { fetch: () => new Response('ok') },
  }, {});
  assert.equal(noKey.status, 404);

  const lockedEnv = {
    WRITER_ACCESS_KEY: 'secret',
    DB: {},
    ASSETS: { fetch: () => new Response('ok') },
  };

  const missingAuth = await worker.fetch(new Request('https://writer.example/mcp', { method: 'POST' }), lockedEnv, {});
  assert.equal(missingAuth.status, 401);

  const getReq = await worker.fetch(new Request('https://writer.example/mcp', {
    headers: {
      Authorization: 'Bearer secret',
      Accept: 'text/event-stream',
    },
  }), lockedEnv, {});
  assert.equal(getReq.status, 405);
  assert.equal(getReq.headers.get('Content-Type'), null);

  const initReq = new Request('https://writer.example/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    }),
  });
  const initRes = await worker.fetch(initReq, lockedEnv, {});
  assert.equal(initRes.status, 200);
  const initBody = await initRes.json();
  assert.equal(initBody.result.protocolVersion, '2025-03-26');
  assert.equal(initBody.result.serverInfo.version, WRITER_VERSION);

  const toolsReq = new Request('https://writer.example/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const toolsRes = await worker.fetch(toolsReq, lockedEnv, {});
  assert.equal(toolsRes.status, 200);
  const toolsBody = await toolsRes.json();
  assert.deepEqual(toolsBody.result.tools.map((tool) => tool.name), ['list', 'search', 'get']);
});

test('reopen archived document deletes its vector', async () => {
  let deleteCalls = 0;
  const env = {
    WRITER_ACCESS_KEY: 'secret',
    AI: { async run() { return { data: [[0.1, 0.2]] }; } },
    ARCHIVE_INDEX: {
      async deleteByIds(ids) {
        deleteCalls += 1;
        assert.deepEqual(ids, [DOC_ID]);
      },
    },
    DB: {
      prepare(sql) {
        if (sql === 'SELECT * FROM documents WHERE id = ?') {
          return {
            bind() {
              return {
                async first() {
                  return {
                    id: DOC_ID,
                    status: 'archived',
                    content: 'raw content',
                    formatted: '# formatted',
                  };
                },
              };
            },
          };
        }
        if (sql.includes("UPDATE documents SET status = 'draft'")) {
          return {
            bind(content, now, id) {
              assert.equal(content, '# formatted');
              assert.equal(typeof now, 'string');
              assert.equal(id, DOC_ID);
              return {
                async run() {
                  return { meta: { changes: 1 } };
                },
              };
            },
          };
        }
        throw new Error(`Unexpected SQL in reopen test: ${sql}`);
      },
    },
    ASSETS: { fetch: () => new Response('ok') },
  };

  const res = await worker.fetch(new Request(`https://writer.example/api/documents/${DOC_ID}/reopen`, {
    method: 'POST',
    headers: { Authorization: 'Bearer secret' },
  }), env, {});
  assert.equal(res.status, 200);
  assert.equal(deleteCalls, 1);
});
