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
