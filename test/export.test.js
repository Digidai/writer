import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleExportRequest } from '../src/export.js';

test('GET /api/export is denied when no access key is configured', async () => {
  const req = new Request('https://writer.example/api/export');
  const res = await handleExportRequest(req, { WRITER_ACCESS_KEY: '' });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'export unavailable in demo' });
});

test('HEAD /api/export reports availability for locked instances', async () => {
  const req = new Request('https://writer.example/api/export', { method: 'HEAD' });
  const res = await handleExportRequest(req, { WRITER_ACCESS_KEY: 'secret' });
  assert.equal(res.status, 204);
});

test('GET /api/export returns 413 when archived rows exceed 200', async () => {
  const docs = Array.from({ length: 201 }, (_, i) => ({
    id: `doc-${i}`,
    title: `Doc ${i}`,
    content: 'x',
    formatted: 'x',
    category: 'Notes',
    tags: '[]',
    created_at: '2026-08-16T00:00:00.000Z',
    archived_at: '2026-08-16T00:00:00.000Z',
    updated_at: '2026-08-16T00:00:00.000Z',
  }));
  const env = {
    WRITER_ACCESS_KEY: 'secret',
    DB: {
      prepare(sql) {
        assert.match(sql, /FROM documents/);
        return {
          bind(limit) {
            assert.equal(limit, 201);
            return {
              async all() {
                return { results: docs };
              },
            };
          },
        };
      },
    },
  };

  const req = new Request('https://writer.example/api/export');
  const res = await handleExportRequest(req, env);
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: 'export too large' });
});
