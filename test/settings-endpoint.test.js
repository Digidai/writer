import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateSettings } from '../src/settings-endpoint.js';
import { DEFAULTS } from '../src/settings.js';

function mockSettingsDb(initial = null) {
  let stored = initial;
  return {
    prepare() {
      return {
        async first() {
          return stored ? { data: JSON.stringify(stored) } : null;
        },
        bind(data) {
          return {
            async run() {
              stored = JSON.parse(data);
              return { success: true };
            },
          };
        },
      };
    },
    get stored() {
      return stored;
    },
  };
}

test('PUT /api/settings writes in demo mode', async () => {
  const db = mockSettingsDb();
  const req = new Request('https://writer.example/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: 'dark' }),
  });

  const res = await updateSettings(req, { WRITER_ACCESS_KEY: '', DB: db });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.theme, 'dark');
  assert.equal(body.language, 'auto');
  assert.equal(DEFAULTS.language, 'auto');
  assert.equal(db.stored.theme, 'dark');
});

test('PUT /api/settings rejects a non-object body', async () => {
  const req = new Request('https://writer.example/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify('nope'),
  });

  const res = await updateSettings(req, { WRITER_ACCESS_KEY: '', DB: mockSettingsDb() });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'invalid body' });
});
