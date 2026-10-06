import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createEnv, browser, signIn, lastCode } from './helpers/env.js';
import { generateCode, normalizeEmail, CODE_MAX_ATTEMPTS, EMAIL_GUESS_LIMIT } from '../src/auth.js';

const wrongFor = (code) => (code === '000000' ? '111111' : '000000');

async function draft(client, content = 'A first paragraph, written before any account existed.') {
  const created = await client.json('/api/documents', { method: 'POST', body: { content } });
  assert.equal(created.status, 201);
  return created.body;
}

test('codes are six uniform digits and emails normalize', () => {
  for (let i = 0; i < 200; i++) assert.match(generateCode(), /^\d{6}$/);
  assert.equal(normalizeEmail('  Writer@Example.COM '), 'writer@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail('a@b'), null);
  assert.equal(normalizeEmail(''), null);
});

test('anyone can write; finishing asks for an account; signing in claims the draft and files it', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);

  const doc = await draft(visitor);
  assert.ok(visitor.jar.has('__Host-writer_anon'), 'anonymous writers get an HttpOnly browser id');

  const saved = await visitor.json(`/api/documents/${doc.id}`, {
    method: 'PUT', body: { content: 'Edited while still anonymous.', rev: doc.updated_at },
  });
  assert.equal(saved.status, 200);

  // The archive is private and filing needs an account.
  assert.equal((await visitor.json('/api/documents')).status, 401);
  const blocked = await visitor.json(`/api/documents/${doc.id}/finalize`, { method: 'POST' });
  assert.equal(blocked.status, 401);
  assert.equal(blocked.body.error, 'auth_required');
  assert.equal(world.workflows.length, 0);

  const verified = await signIn(visitor, world.outbox, 'Writer@Example.com');
  assert.equal(verified.status, 200);
  assert.equal(verified.body.user.email, 'writer@example.com');
  assert.equal(verified.body.created, true);
  assert.equal(verified.body.claimed, 1);
  assert.ok(visitor.jar.has('__Host-writer_session'));

  const row = world.DB.get('SELECT user_id, anon_id FROM documents WHERE id = ?', doc.id);
  assert.equal(row.user_id, verified.body.user.id);
  assert.equal(row.anon_id, null);

  const filed = await visitor.json(`/api/documents/${doc.id}/finalize`, { method: 'POST' });
  assert.equal(filed.status, 202);
  assert.equal(filed.body.status, 'processing');
  assert.equal(world.workflows.length, 1);

  const me = await visitor.json('/api/auth/me');
  assert.equal(me.body.user.email, 'writer@example.com');
  assert.equal(me.body.features.export, true);
});

test('the sign-in email carries the code and stores only its hash', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);
  const start = await visitor.json('/api/auth/start', { method: 'POST', body: { email: 'hash@example.com', lang: 'zh' } });
  assert.equal(start.status, 200);
  const message = world.outbox[0];
  assert.equal(message.to, 'hash@example.com');
  assert.match(message.subject, /Writer 登录验证码/);
  const code = lastCode(world.outbox, 'hash@example.com');
  const stored = world.DB.get('SELECT code_hash FROM login_codes WHERE email = ?', 'hash@example.com');
  assert.ok(stored.code_hash);
  assert.ok(!stored.code_hash.includes(code));
  assert.match(stored.code_hash, /^[0-9a-f]{64}$/);
});

test('wrong codes spend attempts, then the code stops working', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);
  await visitor.json('/api/auth/start', { method: 'POST', body: { email: 'guess@example.com' } });
  const real = lastCode(world.outbox, 'guess@example.com');
  const wrong = wrongFor(real);

  for (let i = 1; i <= CODE_MAX_ATTEMPTS; i++) {
    const r = await visitor.json('/api/auth/verify', { method: 'POST', body: { email: 'guess@example.com', code: wrong } });
    assert.equal(r.status, 400);
    assert.equal(r.body.attemptsLeft, CODE_MAX_ATTEMPTS - i);
  }
  const locked = await visitor.json('/api/auth/verify', { method: 'POST', body: { email: 'guess@example.com', code: real } });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error, 'too_many_attempts');
  // The exhausted code stays (so the resend throttle still holds) until it expires.
  assert.equal(world.DB.get('SELECT COUNT(*) AS n FROM login_codes').n, 1);
  assert.equal(visitor.jar.has('__Host-writer_session'), false);
  const again = await visitor.json('/api/auth/start', { method: 'POST', body: { email: 'guess@example.com' } });
  assert.equal(again.status, 429);
});

test('a fresh code never buys fresh guesses: the address has an hourly budget', async () => {
  const world = createEnv();
  const email = 'budget@example.com';
  let spent = 0;
  for (let round = 0; spent < EMAIL_GUESS_LIMIT; round++) {
    const client = browser(worker, world, { ip: `198.51.100.${round + 1}` });
    world.DB.raw.prepare(`UPDATE login_codes SET created_at = '2000-01-01T00:00:00.000Z'`).run();
    assert.equal((await client.json('/api/auth/start', { method: 'POST', body: { email } })).status, 200);
    const real = lastCode(world.outbox, email);
    const wrong = wrongFor(real);
    for (let i = 0; i < CODE_MAX_ATTEMPTS && spent < EMAIL_GUESS_LIMIT; i++, spent++) {
      const r = await client.json('/api/auth/verify', { method: 'POST', body: { email, code: wrong } });
      assert.equal(r.status, 400);
    }
  }
  // Budget gone: even the right code, from a new address, is refused,
  // and no further code is sent.
  world.DB.raw.prepare(`UPDATE login_codes SET created_at = '2000-01-01T00:00:00.000Z'`).run();
  const fresh = browser(worker, world, { ip: '198.51.100.200' });
  const sent = world.outbox.length;
  assert.equal((await fresh.json('/api/auth/start', { method: 'POST', body: { email } })).status, 429);
  assert.equal(world.outbox.length, sent);
  const right = await fresh.json('/api/auth/verify', { method: 'POST', body: { email, code: lastCode(world.outbox, email) } });
  assert.equal(right.status, 429);
});

test('a successful sign-in resets the address budget', async () => {
  const world = createEnv();
  const client = browser(worker, world);
  await client.json('/api/auth/start', { method: 'POST', body: { email: 'reset@example.com' } });
  const code = lastCode(world.outbox, 'reset@example.com');
  await client.json('/api/auth/verify', { method: 'POST', body: { email: 'reset@example.com', code: wrongFor(code) } });
  assert.equal(world.DB.get('SELECT count FROM login_guesses').count, 1);
  const ok = await client.json('/api/auth/verify', { method: 'POST', body: { email: 'reset@example.com', code } });
  assert.equal(ok.status, 200);
  assert.equal(world.DB.get('SELECT COUNT(*) AS n FROM login_guesses').n, 0);
});

test('codes are single use and expire', async () => {
  const world = createEnv();
  const a = browser(worker, world);
  const verified = await signIn(a, world.outbox, 'once@example.com');
  assert.equal(verified.status, 200);
  const replay = await browser(worker, world).json('/api/auth/verify', {
    method: 'POST', body: { email: 'once@example.com', code: lastCode(world.outbox, 'once@example.com') },
  });
  assert.equal(replay.status, 400);

  const b = browser(worker, world, { ip: '198.51.100.9' });
  await b.json('/api/auth/start', { method: 'POST', body: { email: 'late@example.com' } });
  world.DB.raw.prepare(`UPDATE login_codes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE email = ?`).run('late@example.com');
  const expired = await b.json('/api/auth/verify', {
    method: 'POST', body: { email: 'late@example.com', code: lastCode(world.outbox, 'late@example.com') },
  });
  assert.equal(expired.status, 400);
  assert.equal(expired.body.error, 'code_expired');
});

test('a new code cannot be requested for the same address within 30 seconds', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);
  assert.equal((await visitor.json('/api/auth/start', { method: 'POST', body: { email: 'soon@example.com' } })).status, 200);
  const again = await visitor.json('/api/auth/start', { method: 'POST', body: { email: 'soon@example.com' } });
  assert.equal(again.status, 429);
  assert.equal(again.body.error, 'too_soon');
  assert.equal(world.outbox.length, 1);
});

test('when sending fails nothing is left behind and the client is told', async () => {
  const world = createEnv({
    EMAIL: { async send() { const e = new Error('Sender domain not verified'); e.code = 'E_SENDER_NOT_VERIFIED'; throw e; } },
  });
  const r = await browser(worker, world).json('/api/auth/start', { method: 'POST', body: { email: 'x@example.com' } });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'email_unavailable');
  assert.equal(world.DB.get('SELECT COUNT(*) AS n FROM login_codes').n, 0);
  await world.settle();
  assert.equal(world.DB.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'auth_email_failed'`).n, 1);
});

test("one writer can never see or touch another's documents", async () => {
  const world = createEnv();
  const alice = browser(worker, world, { ip: '192.0.2.1' });
  const bob = browser(worker, world, { ip: '192.0.2.2' });
  await signIn(alice, world.outbox, 'alice@example.com');
  await signIn(bob, world.outbox, 'bob@example.com');

  const doc = await draft(alice, 'Alice writes about a quiet river at dusk.');
  world.DB.raw.prepare(`UPDATE documents SET status = 'archived', archived_at = updated_at WHERE id = ?`).run(doc.id);

  assert.equal((await bob.json(`/api/documents/${doc.id}`)).status, 404);
  assert.equal((await bob.json(`/api/documents/${doc.id}`, { method: 'PUT', body: { content: 'x', rev: doc.updated_at } })).status, 404);
  assert.equal((await bob.json(`/api/documents/${doc.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await bob.json(`/api/documents/${doc.id}/finalize`, { method: 'POST' })).status, 404);
  assert.equal((await bob.json(`/api/documents/${doc.id}/reopen`, { method: 'POST' })).status, 404);
  assert.equal((await bob.json(`/api/documents/${doc.id}/file`)).status, 404);
  assert.equal((await bob.request(`/d/${doc.id}`)).status, 404);

  const bobList = await bob.json('/api/documents');
  assert.deepEqual(bobList.body.documents, []);
  const bobSearch = await bob.json('/api/search?q=river');
  assert.deepEqual(bobSearch.body.documents, []);

  const aliceSearch = await alice.json('/api/search?q=river');
  assert.equal(aliceSearch.body.documents.length, 1);
  assert.equal((await alice.request(`/d/${doc.id}`)).status, 200);

  const stranger = browser(worker, world, { ip: '192.0.2.3' });
  const redirect = await stranger.request(`/d/${doc.id}`);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('Location'), `/login?next=${encodeURIComponent(`/d/${doc.id}`)}`);
});

test("a browser's anonymous drafts are not someone else's", async () => {
  const world = createEnv();
  const first = browser(worker, world, { ip: '192.0.2.10' });
  const second = browser(worker, world, { ip: '192.0.2.11' });
  const doc = await draft(first);
  assert.equal((await second.json(`/api/documents/${doc.id}`)).status, 404);
  // Signing in on another browser claims nothing of this one.
  const verified = await signIn(second, world.outbox, 'other@example.com');
  assert.equal(verified.body.claimed, 0);
  assert.equal(world.DB.get('SELECT user_id FROM documents WHERE id = ?', doc.id).user_id, null);
});

test('cross-site writes are refused before anything runs', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);
  const r = await visitor.json('/api/auth/start', {
    method: 'POST', body: { email: 'csrf@example.com' }, headers: { Origin: 'https://evil.example' },
  });
  assert.equal(r.status, 403);
  assert.equal(world.outbox.length, 0);
  const r2 = await visitor.json('/api/documents', {
    method: 'POST', body: { content: 'x' }, headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(r2.status, 403);
});

test('sign-out ends the session and starts a fresh anonymous id', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);
  await draft(visitor);
  const before = visitor.jar.get('__Host-writer_anon');
  await signIn(visitor, world.outbox, 'leave@example.com');
  const out = await visitor.json('/api/auth/logout', { method: 'POST' });
  assert.equal(out.status, 200);
  assert.equal(visitor.jar.has('__Host-writer_session'), false);
  assert.notEqual(visitor.jar.get('__Host-writer_anon'), before);
  assert.equal(world.DB.get('SELECT COUNT(*) AS n FROM sessions').n, 0);
  assert.equal((await visitor.json('/api/auth/me')).body.user, null);
});

test('closed registration lets existing writers in and keeps new ones out', async () => {
  const world = createEnv();
  await signIn(browser(worker, world, { ip: '192.0.2.20' }), world.outbox, 'early@example.com');
  world.DB.raw.prepare(`INSERT INTO site_config (key, value) VALUES ('registration', 'closed')`).run();

  const newcomer = await browser(worker, world, { ip: '192.0.2.21' }).json('/api/auth/start', {
    method: 'POST', body: { email: 'new@example.com' },
  });
  assert.equal(newcomer.status, 403);
  assert.equal(newcomer.body.error, 'registration_closed');

  world.DB.raw.prepare(`UPDATE login_codes SET created_at = '2000-01-01T00:00:00.000Z'`).run();
  const returning = await signIn(browser(worker, world, { ip: '192.0.2.22' }), world.outbox, 'early@example.com');
  assert.equal(returning.status, 200);
  assert.equal(returning.body.created, false);
});

test('preferences belong to each account; anonymous changes stay local', async () => {
  const world = createEnv();
  const visitor = browser(worker, world, { ip: '192.0.2.30' });
  const anon = await visitor.json('/api/settings', { method: 'PUT', body: { theme: 'dark' } });
  assert.equal(anon.status, 401);

  await signIn(visitor, world.outbox, 'prefs@example.com');
  const saved = await visitor.json('/api/settings', { method: 'PUT', body: { theme: 'dark', fontSize: 'nope' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.theme, 'dark');
  assert.equal(saved.body.fontSize, 'standard');
  assert.deepEqual(JSON.parse(world.DB.get('SELECT settings FROM users').settings), { theme: 'dark' });

  const other = browser(worker, world, { ip: '192.0.2.31' });
  await signIn(other, world.outbox, 'someone@example.com');
  assert.equal((await other.json('/api/settings')).body.theme, 'system');
});

test('a disabled account loses its sessions and cannot sign back in', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);
  const verified = await signIn(visitor, world.outbox, 'gone@example.com');
  world.DB.raw.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(verified.body.user.id);
  assert.equal((await visitor.json('/api/auth/me')).body.user, null);
  world.DB.raw.prepare(`UPDATE login_codes SET created_at = '2000-01-01T00:00:00.000Z'`).run();
  const again = await visitor.json('/api/auth/start', { method: 'POST', body: { email: 'gone@example.com' } });
  assert.equal(again.status, 403);
  assert.equal(again.body.error, 'account_disabled');
});

test('export is per account', async () => {
  const world = createEnv();
  const alice = browser(worker, world, { ip: '192.0.2.40' });
  const bob = browser(worker, world, { ip: '192.0.2.41' });
  assert.equal((await alice.json('/api/export')).status, 401);
  await signIn(alice, world.outbox, 'a@example.com');
  await signIn(bob, world.outbox, 'b@example.com');
  const doc = await draft(alice, 'Only Alice exports this.');
  world.DB.raw.prepare(`UPDATE documents SET status = 'archived', archived_at = updated_at, formatted = content WHERE id = ?`).run(doc.id);

  const mine = await alice.request('/api/export');
  assert.equal(mine.status, 200);
  assert.ok((await mine.arrayBuffer()).byteLength > 100);
  const theirs = await bob.request('/api/export');
  assert.equal(theirs.status, 200);
  const bytes = new Uint8Array(await theirs.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes).includes('Only Alice'), false);
});

test('anonymous drafts have a size cap; an account lifts it', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);
  const big = 'x'.repeat(50_001);
  const refused = await visitor.json('/api/documents', { method: 'POST', body: { content: big } });
  assert.equal(refused.status, 413);
  assert.equal(refused.body.signIn, true);

  const doc = await draft(visitor);
  const grow = await visitor.json(`/api/documents/${doc.id}`, { method: 'PUT', body: { content: big, rev: doc.updated_at } });
  assert.equal(grow.status, 413);

  await signIn(visitor, world.outbox, 'long@example.com');
  const rev = world.DB.get('SELECT updated_at FROM documents WHERE id = ?', doc.id).updated_at;
  const ok = await visitor.json(`/api/documents/${doc.id}`, { method: 'PUT', body: { content: big, rev } });
  assert.equal(ok.status, 200);
});

test('anonymous drafts are capped per hour across the whole instance', async () => {
  const world = createEnv();
  const hour = String(Math.floor(Date.now() / 3_600_000));
  world.DB.raw.prepare(`INSERT INTO site_config (key, value) VALUES (?, '100')`).run(`anon_create:${hour}`);
  const r = await browser(worker, world).json('/api/documents', { method: 'POST', body: { content: 'one more' } });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'busy');
  const signedIn = browser(worker, world, { ip: '192.0.2.90' });
  await signIn(signedIn, world.outbox, 'member@example.com');
  assert.equal((await signedIn.json('/api/documents', { method: 'POST', body: { content: 'still fine' } })).status, 201);
});

test('only real writes spend the write budget', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);
  const doc = await draft(visitor);
  const spent = () => [...world.cache.keys()].filter((k) => k.endsWith(':documents-write')).length;
  for (const method of ['HEAD', 'OPTIONS', 'PATCH']) {
    const r = await visitor.request(`/api/documents/${doc.id}`, { method });
    assert.equal(r.status, 405);
  }
  assert.equal(spent(), 0);
  await visitor.json(`/api/documents/${doc.id}`, { method: 'PUT', body: { content: 'A real write.', rev: doc.updated_at } });
  assert.equal(spent(), 1);
});

test('reopening an archived piece removes its Markdown file from R2', async () => {
  const world = createEnv();
  const writer = browser(worker, world);
  await signIn(writer, world.outbox, 'files@example.com');
  const doc = await draft(writer, 'A piece that will be filed and reopened.');
  const archivedAt = '2026-10-01T00:00:00.000Z';
  world.DB.raw.prepare(`UPDATE documents SET status = 'archived', archived_at = ?, formatted = content WHERE id = ?`).run(archivedAt, doc.id);
  await world.env.FILES.put(`documents/2026/${doc.id}.md`, 'filed');
  const reopened = await writer.json(`/api/documents/${doc.id}/reopen`, { method: 'POST' });
  assert.equal(reopened.status, 200);
  assert.equal(world.env.FILES.objects.has(`documents/2026/${doc.id}.md`), false);
});
