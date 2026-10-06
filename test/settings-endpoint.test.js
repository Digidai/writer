import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSettings, updateSettings } from '../src/settings-endpoint.js';
import { DEFAULTS } from '../src/settings.js';
import { createEnv } from './helpers/env.js';

function put(body) {
  return new Request('https://writer.example/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('PUT /api/settings needs an account', async () => {
  const { env } = createEnv();
  const res = await updateSettings(put({ theme: 'dark' }), env, { user: null });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'auth_required' });
});

test('PUT /api/settings rejects a non-object body', async () => {
  const res = await updateSettings(put('nope'), { DB: {} }, { user: { id: 'u' } });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'invalid body' });
});

test("a writer's choices overlay the site defaults and survive default changes", async () => {
  const { env, DB } = createEnv();
  DB.raw.prepare(`INSERT INTO users (id, email, created_at) VALUES ('u1', 'u1@example.com', '2026-10-01T00:00:00.000Z')`).run();
  const viewer = { user: { id: 'u1', settings: '{}' } };

  const saved = await (await updateSettings(put({ theme: 'dark' }), env, viewer)).json();
  assert.equal(saved.theme, 'dark');
  assert.equal(saved.language, DEFAULTS.language);

  DB.raw.prepare(`INSERT INTO settings (id, data) VALUES (1, ?)`).run(JSON.stringify({ fontSize: 'large', theme: 'light' }));
  const stored = DB.get('SELECT settings FROM users').settings;
  const seen = await (await getSettings(env, { user: { id: 'u1', settings: stored } })).json();
  assert.equal(seen.theme, 'dark');
  assert.equal(seen.fontSize, 'large');

  const anonymous = await (await getSettings(env, { user: null })).json();
  assert.equal(anonymous.theme, 'light');
});
