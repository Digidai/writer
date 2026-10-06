import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createEnv, browser, signIn } from './helpers/env.js';
import { csvCell } from '../src/admin.js';

const PASSWORD = 'test-admin-password';

async function adminClient(world, ip = '198.51.100.1') {
  const admin = browser(worker, world, { ip });
  const r = await admin.json('/api/admin/login', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(r.status, 200);
  return admin;
}

test('the console does not exist until a password is configured', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);
  assert.equal((await visitor.request('/admin')).status, 404);
  assert.equal((await visitor.request('/api/admin/overview')).status, 404);
});

test('admin sign-in: wrong password refused, right one sets a strict cookie', async () => {
  const world = createEnv({ ADMIN_PASSWORD: PASSWORD });
  const admin = browser(worker, world);
  assert.equal((await admin.json('/api/admin/overview')).status, 401);
  assert.equal((await admin.json('/api/admin/login', { method: 'POST', body: { password: 'nope' } })).status, 401);

  const ok = await admin.request('/api/admin/login', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.getSetCookie().find((c) => c.startsWith('__Host-writer_admin='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Domain=/);

  const page = await admin.request('/admin');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('X-Robots-Tag'), 'noindex, nofollow');

  const overview = await admin.json('/api/admin/overview?days=7');
  assert.equal(overview.status, 200);
  assert.equal(overview.body.daily.length, 7);
  assert.equal(overview.body.system.email, true);
});

test('rotating the password signs every console session out', async () => {
  const world = createEnv({ ADMIN_PASSWORD: PASSWORD });
  const admin = await adminClient(world);
  assert.equal((await admin.json('/api/admin/session')).body.ok, true);
  world.env.ADMIN_PASSWORD = 'a-new-password';
  assert.equal((await admin.json('/api/admin/session')).body.ok, false);
  assert.equal((await admin.json('/api/admin/users')).status, 401);
});

test('admin logins are throttled per address and globally', async () => {
  const world = createEnv({ ADMIN_PASSWORD: PASSWORD });
  const guesser = browser(worker, world, { ip: '203.0.113.50' });
  for (let i = 0; i < 5; i++) {
    assert.equal((await guesser.json('/api/admin/login', { method: 'POST', body: { password: `x${i}` } })).status, 401);
  }
  assert.equal((await guesser.json('/api/admin/login', { method: 'POST', body: { password: PASSWORD } })).status, 429);

  // Spread across many addresses, the hourly budget of 30 still holds.
  for (let i = 0; i < 25; i++) {
    const client = browser(worker, world, { ip: `198.18.0.${i}` });
    assert.equal((await client.json('/api/admin/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  }
  const fresh = browser(worker, world, { ip: '198.18.1.1' });
  const locked = await fresh.json('/api/admin/login', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error, 'locked');
  assert.ok(locked.body.retryAfter > 0);

  // Rotating the password is the way out of a lock.
  world.env.ADMIN_PASSWORD = 'rotated-password';
  const rotated = await browser(worker, world, { ip: '198.18.1.2' }).json('/api/admin/login', {
    method: 'POST', body: { password: 'rotated-password' },
  });
  assert.equal(rotated.status, 200);
});

test('concurrent admin guesses cannot slip past the budget', async () => {
  const world = createEnv({ ADMIN_PASSWORD: PASSWORD });
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      browser(worker, world, { ip: `198.18.2.${i}` }).json('/api/admin/login', { method: 'POST', body: { password: `g${i}` } })
    )
  );
  assert.equal(results.filter((r) => r.status === 401).length, 30);
  assert.equal(results.filter((r) => r.status === 429).length, 10);
});

test('admin sees every account and can disable, sign out and delete them', async () => {
  const world = createEnv({ ADMIN_PASSWORD: PASSWORD });
  const writer = browser(worker, world, { ip: '192.0.2.60' });
  const verified = await signIn(writer, world.outbox, 'managed@example.com');
  const id = verified.body.user.id;
  await writer.json('/api/documents', { method: 'POST', body: { content: 'Something to manage.' } });

  const admin = await adminClient(world);
  const list = await admin.json('/api/admin/users?q=managed');
  assert.equal(list.body.total, 1);
  assert.equal(list.body.users[0].drafts, 1);

  const detail = await admin.json(`/api/admin/users/${id}`);
  assert.equal(detail.body.user.email, 'managed@example.com');
  assert.equal(detail.body.documents.length, 1);

  assert.equal((await admin.json(`/api/admin/users/${id}/disable`, { method: 'POST' })).status, 200);
  assert.equal((await writer.json('/api/auth/me')).body.user, null);
  assert.equal(world.DB.get('SELECT status FROM users WHERE id = ?', id).status, 'disabled');

  assert.equal((await admin.json(`/api/admin/users/${id}/enable`, { method: 'POST' })).status, 200);
  const removed = await admin.json(`/api/admin/users/${id}`, { method: 'DELETE' });
  assert.equal(removed.body.documents, 1);
  assert.equal(world.DB.get('SELECT COUNT(*) AS n FROM users').n, 0);
  assert.equal(world.DB.get('SELECT COUNT(*) AS n FROM documents').n, 0);
});

test('unowned documents from before accounts can be given to a user', async () => {
  const world = createEnv({ ADMIN_PASSWORD: PASSWORD });
  world.DB.raw.prepare(
    `INSERT INTO documents (id, title, content, status, created_at, updated_at, archived_at)
     VALUES ('11111111-2222-3333-4444-555555555555', 'Legacy', 'Old words', 'archived', '2026-08-01T00:00:00.000Z',
             '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`
  ).run();
  const writer = browser(worker, world, { ip: '192.0.2.70' });
  await signIn(writer, world.outbox, 'heir@example.com');
  assert.deepEqual((await writer.json('/api/documents')).body.documents, []);

  const admin = await adminClient(world);
  const legacy = await admin.json('/api/admin/documents?owner=legacy');
  assert.equal(legacy.body.total, 1);
  const given = await admin.json('/api/admin/documents/11111111-2222-3333-4444-555555555555/assign', {
    method: 'POST', body: { email: 'heir@example.com' },
  });
  assert.equal(given.status, 200);
  assert.equal((await writer.json('/api/documents')).body.documents.length, 1);
});

test('registration can be closed from the console', async () => {
  const world = createEnv({ ADMIN_PASSWORD: PASSWORD });
  const admin = await adminClient(world);
  const r = await admin.json('/api/admin/config', { method: 'PUT', body: { registration: 'closed' } });
  assert.equal(r.body.registration, 'closed');
  const start = await browser(worker, world, { ip: '192.0.2.80' }).json('/api/auth/start', {
    method: 'POST', body: { email: 'late@example.com' },
  });
  assert.equal(start.status, 403);
});

test('admin actions are recorded in the activity log', async () => {
  const world = createEnv({ ADMIN_PASSWORD: PASSWORD });
  const admin = await adminClient(world);
  await admin.json('/api/admin/config', { method: 'PUT', body: { registration: 'closed' } });
  await world.settle();
  const log = await admin.json('/api/admin/events?type=admin');
  assert.equal(log.body.events.length, 1);
  assert.equal(log.body.events[0].meta.action, 'config');
});

test('CSV cells cannot smuggle spreadsheet formulas', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('+1'), `"'+1"`);
  assert.equal(csvCell('-2'), `"'-2"`);
  assert.equal(csvCell('@SUM(A1)'), `"'@SUM(A1)"`);
  assert.equal(csvCell('plain'), '"plain"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell('a,b\nc'), '"a,b\nc"');
});
