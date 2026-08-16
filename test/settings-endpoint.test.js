import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateSettings } from '../src/settings-endpoint.js';

test('PUT /api/settings is read-only in demo mode', async () => {
  const req = new Request('https://writer.example/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: 'dark' }),
  });

  const res = await updateSettings(req, { WRITER_ACCESS_KEY: '' });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'settings read-only in demo' });
});
