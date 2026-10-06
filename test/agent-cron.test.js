import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepIdleDrafts, launchPipeline } from '../src/agent.js';
import { createEnv } from './helpers/env.js';

const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const minutesAgo = (m) => new Date(NOW - m * 60 * 1000).toISOString();
const daysAgo = (d) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();

function addUser(DB, id, settings = {}) {
  DB.raw.prepare(`INSERT INTO users (id, email, status, settings, created_at) VALUES (?, ?, 'active', ?, ?)`)
    .run(id, `${id}@example.com`, JSON.stringify(settings), daysAgo(10));
}

function addDoc(DB, id, { status = 'draft', updated = minutesAgo(60), user = null, anon = null, content = 'Some real words here.' } = {}) {
  DB.raw.prepare(
    `INSERT INTO documents (id, title, content, status, created_at, updated_at, user_id, anon_id)
     VALUES (?, '', ?, ?, ?, ?, ?, ?)`
  ).run(id, content, status, updated, updated, user, anon);
}

test('signed-in drafts past their own idle window are filed; anonymous ones never are', async () => {
  const { env, DB, workflows } = createEnv();
  addUser(DB, 'u-fast', { idleArchiveMinutes: 3 });
  addUser(DB, 'u-manual', { idleArchiveMinutes: 0 });
  addUser(DB, 'u-slow', { idleArchiveMinutes: 30 });
  addDoc(DB, 'doc-fast', { user: 'u-fast', updated: minutesAgo(10) });     // 10 > 3 x 3
  addDoc(DB, 'doc-manual', { user: 'u-manual', updated: minutesAgo(600) }); // never automatic
  addDoc(DB, 'doc-slow', { user: 'u-slow', updated: minutesAgo(60) });     // 60 < 30 x 3
  addDoc(DB, 'doc-anon', { anon: 'anon-browser-id-123456', updated: minutesAgo(600) });
  addDoc(DB, 'doc-empty', { user: 'u-fast', updated: minutesAgo(600), content: ' ' });

  const result = await sweepIdleDrafts(env, { now: NOW });
  assert.equal(result.launched, 1);
  assert.deepEqual(workflows.map((w) => w.params.docId), ['doc-fast']);
  assert.equal(DB.get(`SELECT status FROM documents WHERE id = 'doc-fast'`).status, 'processing');
  assert.equal(DB.get(`SELECT status FROM documents WHERE id = 'doc-anon'`).status, 'draft');
});

test('site defaults apply to writers who never changed the setting', async () => {
  const { env, DB, workflows } = createEnv();
  DB.raw.prepare(`INSERT INTO settings (id, data) VALUES (1, ?)`).run(JSON.stringify({ idleArchiveMinutes: 0 }));
  addUser(DB, 'u-default');
  addDoc(DB, 'doc-default', { user: 'u-default', updated: minutesAgo(600) });
  await sweepIdleDrafts(env, { now: NOW });
  assert.equal(workflows.length, 0);
});

test('stuck runs are relaunched whoever owns them', async () => {
  const { env, DB, workflows } = createEnv();
  addDoc(DB, 'doc-stuck', { status: 'processing', updated: minutesAgo(30) });
  addDoc(DB, 'doc-busy', { status: 'processing', updated: minutesAgo(2) });
  await sweepIdleDrafts(env, { now: NOW });
  assert.deepEqual(workflows.map((w) => w.params.docId), ['doc-stuck']);
});

test('housekeeping clears expired codes and sessions and old unclaimed drafts, keeps everything else', async () => {
  const { env, DB } = createEnv();
  DB.raw.prepare(`INSERT INTO login_codes (email, code_hash, created_at, expires_at) VALUES ('a@x.co', 'h', ?, ?)`)
    .run(minutesAgo(30), minutesAgo(20));
  DB.raw.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('t', 'u', ?, ?)`)
    .run(daysAgo(100), daysAgo(1));
  addDoc(DB, 'doc-old-anon', { anon: 'anon-browser-id-abcdef', updated: daysAgo(40) });
  addDoc(DB, 'doc-new-anon', { anon: 'anon-browser-id-abcdef', updated: daysAgo(2) });
  addDoc(DB, 'doc-legacy', { status: 'archived', updated: daysAgo(400) });

  await sweepIdleDrafts(env, { now: NOW });
  assert.equal(DB.get('SELECT COUNT(*) AS n FROM login_codes').n, 0);
  assert.equal(DB.get('SELECT COUNT(*) AS n FROM sessions').n, 0);
  const left = DB.all('SELECT id FROM documents ORDER BY id').map((r) => r.id);
  assert.deepEqual(left, ['doc-legacy', 'doc-new-anon']);
});

test('launchPipeline claims a draft once', async () => {
  const { env, DB, workflows } = createEnv();
  addDoc(DB, 'doc-once');
  assert.equal(await launchPipeline(env, 'doc-once'), true);
  assert.equal(await launchPipeline(env, 'doc-once'), false);
  assert.equal(workflows.length, 1);
});
