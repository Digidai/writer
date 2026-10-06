import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { parseRange, cloudflareUsage, percentile } from '../src/admin-analytics.js';
import { createEnv, browser } from './helpers/env.js';

const PASSWORD = 'test-admin-password';
const now = Date.now();
const today = new Date(now).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(now - n * 86400000).toISOString().slice(0, 10);
const tsOn = (day, hhmm = '10:00') => `${day}T${hhmm}:00.000Z`;

async function admin(world) {
  const client = browser(worker, world, { ip: '198.51.100.9' });
  const r = await client.json('/api/admin/login', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(r.status, 200);
  return client;
}

function pageview(DB, row) {
  const r = {
    day: today, ts: tsOn(today), view_id: Math.random().toString(16).slice(2, 18).padEnd(16, '0'), visitor: 'v1', session: 's1',
    entry: 0, path: '/', referrer: null, channel: 'direct', utm_source: null, utm_medium: null, utm_campaign: null, country: 'CN',
    device: 'desktop', browser: 'chrome', os: 'macos', lang: 'zh', viewport: 'l', engaged_ms: null, scroll: null,
    lcp: null, inp: null, cls: null, fcp: null, ttfb: null, ...row,
  };
  DB.raw.prepare(
    `INSERT INTO pageviews (ts, day, view_id, visitor, session, entry, path, referrer, channel, utm_source, utm_medium, utm_campaign,
                            country, device, browser, os, lang, viewport, engaged_ms, scroll, lcp, inp, cls, fcp, ttfb)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(r.ts, r.day, r.view_id, r.visitor, r.session, r.entry, r.path, r.referrer, r.channel, r.utm_source, r.utm_medium,
    r.utm_campaign, r.country, r.device, r.browser, r.os, r.lang, r.viewport, r.engaged_ms, r.scroll, r.lcp, r.inp, r.cls, r.fcp, r.ttfb);
}

function aiCall(DB, row) {
  const r = {
    day: today, ts: tsOn(today), feature: 'completion', model: '@cf/qwen/qwen3-30b-a3b-fp8', status: 'ok', error: null, fallback: 0,
    latency_ms: 500, input_tokens: 100, cached_tokens: 0, output_tokens: 10, reasoning_tokens: 0, neurons: 1, estimated: 0,
    user_id: null, doc_id: null, turn: null, ...row,
  };
  DB.raw.prepare(
    `INSERT INTO ai_calls (ts, day, feature, model, status, error, fallback, latency_ms, input_tokens, cached_tokens, output_tokens,
                           reasoning_tokens, neurons, estimated, user_id, doc_id, turn)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(r.ts, r.day, r.feature, r.model, r.status, r.error, r.fallback, r.latency_ms, r.input_tokens, r.cached_tokens, r.output_tokens,
    r.reasoning_tokens, r.neurons, r.estimated, r.user_id, r.doc_id, r.turn);
}

function event(DB, row) {
  const r = { day: today, ts: tsOn(today), path: null, country: null, device: null, visitor: null, user_id: null, doc_id: null, value: null, meta: null, ...row };
  DB.raw.prepare(
    `INSERT INTO events (ts, day, type, path, country, device, visitor, user_id, doc_id, value, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(r.ts, r.day, r.type, r.path, r.country, r.device, r.visitor, r.user_id, r.doc_id, r.value, r.meta ? JSON.stringify(r.meta) : null);
}

function user(DB, id, email, created = tsOn(today, '08:00')) {
  DB.raw.prepare(`INSERT INTO users (id, email, status, settings, created_at) VALUES (?, ?, 'active', '{}', ?)`).run(id, email, created);
}

const U1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const U2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const D1 = 'dddddddd-0000-4000-8000-000000000001';

test('date ranges: presets, explicit spans, swapped and oversized ones', () => {
  const q = (s) => new URLSearchParams(s);
  const at = Date.parse('2026-10-06T12:00:00Z');
  assert.deepEqual(parseRange(q('days=7'), at), { since: '2026-09-30', until: '2026-10-06', days: 7 });
  assert.deepEqual(parseRange(q('from=2026-09-01&to=2026-09-03'), at), { since: '2026-09-01', until: '2026-09-03', days: 3 });
  assert.deepEqual(parseRange(q('from=2026-09-03&to=2026-09-01'), at), { since: '2026-09-01', until: '2026-09-03', days: 3 });
  assert.equal(parseRange(q('from=2020-01-01&to=2026-10-06'), at).days, 366);
  assert.equal(parseRange(q('days=nonsense'), at).days, 30);
  assert.equal(parseRange(q('from=2026-02-31'), at).days, 30);
  assert.equal(percentile([1, 2, 3, 4], 0.75), 3);
  assert.equal(percentile([], 0.75), null);
});

test('traffic: sessions, bounces, channels, entry pages, vitals, and every row can filter', async () => {
  const world = createEnv({ ADMIN_PASSWORD: PASSWORD });
  const { DB } = world;
  // Session A from Google on mobile: two pages. Session B direct: one page (a bounce).
  pageview(DB, { session: 'A', visitor: 'va', entry: 1, path: '/', referrer: 'google.com', channel: 'search', device: 'mobile', engaged_ms: 30000, lcp: 1200, inp: 100, cls: 20 });
  pageview(DB, { session: 'A', visitor: 'va', path: '/archive', referrer: 'google.com', channel: 'search', device: 'mobile', engaged_ms: 10000, lcp: 3000, inp: 300, cls: 300, ts: tsOn(today, '10:05') });
  pageview(DB, { session: 'B', visitor: 'vb', entry: 1, path: '/', country: 'US', engaged_ms: 2000, lcp: 5000, ts: tsOn(today, '11:00') });
  const client = await admin(world);

  const all = (await client.json('/api/admin/traffic?days=7')).body;
  assert.equal(all.totals.pageviews, 3);
  assert.equal(all.totals.visitors, 2);
  assert.equal(all.totals.sessions, 2);
  assert.equal(all.totals.bounceRate, 0.5);
  assert.equal(all.totals.viewsPerSession, 1.5);
  assert.equal(all.totals.engagedPerSession, 21000);
  assert.deepEqual(all.channels.map((c) => [c.key, c.sessions]), [['search', 1], ['direct', 1]]);
  assert.deepEqual(all.entries.map((e) => [e.key, e.sessions, e.bounceRate]), [['/', 2, 0.5]]);
  assert.deepEqual(all.exits.map((e) => [e.key, e.exits]).sort(), [['/', 1], ['/archive', 1]]);
  assert.equal(all.daily.length, 7);
  assert.equal(all.daily[6].pageviews, 3);
  assert.equal(all.hours.find((h) => h.hour === 10).views, 2);
  assert.equal(all.vitals.overall.lcp.p75, 5000);
  assert.equal(all.vitals.overall.lcp.rating, 'poor');
  assert.equal(all.vitals.overall.inp.p75, 300);
  assert.equal(all.vitals.overall.inp.rating, 'needs');

  const cn = (await client.json('/api/admin/traffic?days=7&country=CN&device=mobile')).body;
  assert.deepEqual(cn.filters, { country: 'CN', device: 'mobile' });
  assert.equal(cn.totals.pageviews, 2);
  assert.equal(cn.totals.bounceRate, 0);
  const direct = (await client.json('/api/admin/traffic?days=7&referrer=')).body;
  assert.equal(direct.totals.pageviews, 1);
  const entered = (await client.json('/api/admin/traffic?days=7&entry=%2F&channel=search')).body;
  assert.equal(entered.totals.sessions, 1);

  const log = (await client.json('/api/admin/pageviews?days=7&limit=2')).body;
  assert.equal(log.pageviews.length, 2);
  const older = (await client.json(`/api/admin/pageviews?days=7&limit=2&before=${log.next}`)).body;
  assert.equal(older.pageviews.length, 1);

  const csv = await client.request('/api/admin/export/pageviews.csv?days=7&country=US');
  const text = await csv.text();
  assert.match(csv.headers.get('Content-Type'), /text\/csv/);
  assert.equal(text.trim().split('\r\n').length, 2);
  assert.ok(!text.includes('"va"'), 'visitor hashes are not exported');
});

test('models: spend from reported neurons, latency percentiles, filters and the call log', async () => {
  const world = createEnv({ ADMIN_PASSWORD: PASSWORD });
  const { DB } = world;
  user(DB, U1, 'heavy@example.com');
  DB.raw.prepare(`INSERT INTO documents (id, title, content, status, created_at, updated_at, user_id) VALUES (?, 'River notes', 'x', 'archived', ?, ?, ?)`)
    .run(D1, tsOn(today), tsOn(today), U1);
  for (const latency of [100, 200, 300, 400]) aiCall(DB, { latency_ms: latency, user_id: U1 });
  aiCall(DB, { feature: 'agent', model: '@cf/moonshotai/kimi-k2.6', input_tokens: 2000, cached_tokens: 1500, output_tokens: 300, neurons: 150, latency_ms: 4000, user_id: U1, doc_id: D1, turn: 1 });
  aiCall(DB, { feature: 'agent', model: '@cf/moonshotai/kimi-k2.6', status: 'error', error: '3040: Capacity temporarily exceeded', neurons: null, input_tokens: 0, output_tokens: 0, doc_id: D1, turn: 2 });
  aiCall(DB, { feature: 'agent', fallback: 1, input_tokens: 2100, output_tokens: 200, neurons: 10, doc_id: D1, turn: 2, user_id: U1 });
  aiCall(DB, { day: daysAgo(40), ts: tsOn(daysAgo(40)), neurons: 999 });
  const client = await admin(world);

  const d = (await client.json('/api/admin/ai?days=7')).body;
  assert.equal(d.totals.calls, 7);
  assert.equal(d.totals.errors, 1);
  assert.equal(d.totals.fallback, 1);
  assert.equal(d.totals.neurons, 164);
  assert.ok(Math.abs(d.totals.usd - 164 * 0.000011) < 1e-12);
  assert.equal(d.totals.cached, 1500);
  assert.deepEqual(d.byModel.map((m) => m.key), ['@cf/moonshotai/kimi-k2.6', '@cf/qwen/qwen3-30b-a3b-fp8']);
  const qwen = d.byModel.find((m) => m.key.includes('qwen'));
  assert.deepEqual([qwen.p50, qwen.p95], [300, 500]);
  assert.equal(d.byFeature.find((f) => f.key === 'agent').calls, 3);
  assert.equal(d.byUser[0].email, 'heavy@example.com');
  assert.equal(d.byDoc[0].title, 'River notes');
  assert.equal(d.byDoc[0].turns, 2);
  assert.deepEqual(d.errors.map((e) => [e.code, e.n]), [['3040', 1]]);
  assert.equal(d.today.neurons, 164);
  assert.equal(d.today.free, 10000);
  assert.ok(d.totals.perArchive > 0);
  assert.ok(d.prices.models.length >= 3);

  const agentOnly = (await client.json('/api/admin/ai?days=7&feature=agent&status=error')).body;
  assert.equal(agentOnly.totals.calls, 1);
  const forDoc = (await client.json(`/api/admin/ai?days=7&doc=${D1}`)).body;
  assert.equal(forDoc.totals.calls, 3);
  const forUser = (await client.json(`/api/admin/ai?days=7&user=${U1}`)).body;
  assert.equal(forUser.totals.calls, 6);
  const anonymous = (await client.json('/api/admin/ai?days=7&user=anonymous')).body;
  assert.equal(anonymous.totals.calls, 1);
  const fallbacks = (await client.json('/api/admin/ai?days=7&fallback=1')).body;
  assert.equal(fallbacks.totals.calls, 1);

  const log = (await client.json('/api/admin/ai/calls?days=7&limit=3')).body;
  assert.equal(log.calls.length, 3);
  assert.equal(log.calls[0].title, 'River notes');
  assert.equal(log.calls.find((c) => c.status === 'error').usd, null);
  const rest = (await client.json(`/api/admin/ai/calls?days=7&limit=3&before=${log.next}`)).body;
  assert.equal(rest.calls.length, 3);

  const csv = await (await client.request('/api/admin/export/ai_calls.csv?days=7&feature=agent')).text();
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^ts,feature,model,status/);
  assert.match(csv, /"heavy@example.com"/);
});

test('product: the funnel, writers, cohorts, suggestions, the agent, search and health', async () => {
  const world = createEnv({ ADMIN_PASSWORD: PASSWORD });
  const { DB } = world;
  for (const v of ['v1', 'v2', 'v3', 'v4']) pageview(DB, { visitor: v, session: v, entry: 1 });
  event(DB, { type: 'doc_create', visitor: 'v1', doc_id: D1 });
  event(DB, { type: 'doc_create', visitor: 'v2' });
  event(DB, { type: 'doc_create', visitor: 'v2' });
  event(DB, { type: 'finalize_blocked', visitor: 'v1', doc_id: D1 });
  event(DB, { type: 'auth_code_sent', visitor: 'v1', meta: { newAccount: true } });
  event(DB, { type: 'auth_code_sent', visitor: 'v3', meta: { newAccount: false } });
  user(DB, U1, 'new@example.com');
  user(DB, U2, 'old@example.com', tsOn(daysAgo(20)));
  event(DB, { type: 'signup', user_id: U1, visitor: 'v1' });
  event(DB, { type: 'archived', user_id: U1, doc_id: D1, value: 9000, meta: { turns: 2, fallback: false, heuristic: false, formatted: true, category: 'Notes', trigger: 'manual' } });
  event(DB, { type: 'archived', user_id: U2, value: 3000, meta: { turns: 1, fallback: true, heuristic: false, formatted: false, category: 'Notes', trigger: 'idle' } });
  event(DB, { type: 'completion_shown', user_id: U1 });
  event(DB, { type: 'completion_shown', user_id: U1 });
  event(DB, { type: 'completion_accept', user_id: U1 });
  event(DB, { type: 'search', user_id: U2, value: 0, meta: { mode: 'keyword', ms: 40 } });
  event(DB, { type: 'search', user_id: U2, value: 4, meta: { mode: 'keyword', ms: 60 } });
  event(DB, { type: 'settings_change', user_id: U2, meta: { keys: ['theme', 'fontSize'] } });
  event(DB, { type: 'settings_change', user_id: U1, meta: { keys: ['theme'] } });
  event(DB, { type: 'server_error', path: '/api/documents' });
  event(DB, { type: 'client_error', meta: { message: 'x is undefined', source: '/app.js' } });
  event(DB, { type: 'rate_limited', meta: { bucket: 'complete' } });
  aiCall(DB, { feature: 'completion' });
  aiCall(DB, { feature: 'completion', status: 'empty' });
  DB.raw.prepare(`INSERT INTO writing_days (day, doc_id, user_id, anon, saves, chars) VALUES (?, ?, ?, 1, 5, 300)`).run(today, D1, U1);
  DB.raw.prepare(`INSERT INTO writing_days (day, doc_id, user_id, anon, saves, chars) VALUES (?, 'doc-old', ?, 0, 2, 100)`).run(daysAgo(14), U2);
  DB.raw.prepare(`INSERT INTO writing_days (day, doc_id, user_id, anon, saves, chars) VALUES (?, 'doc-anon', NULL, 1, 3, 50)`).run(today);
  const client = await admin(world);

  const d = (await client.json('/api/admin/product?days=7')).body;
  // Anonymous drafts written in the range (D1 before it was claimed, and
  // doc-anon), then drafts that hit the sign-in wall.
  assert.deepEqual(d.funnel.map((s) => [s.step, s.value]), [
    ['visitors', 4], ['anonWriters', 2], ['signInWall', 1], ['codeSent', 1], ['signups', 1], ['firstArchive', 1],
  ]);
  assert.equal(d.funnel[1].ofPrevious, 0.5);
  assert.equal(d.funnel[2].ofPrevious, 0.5);
  assert.equal(d.writers.total, 2);
  assert.equal(d.writers.members, 1);
  assert.equal(d.writers.newMembers, 1);
  assert.equal(d.writers.saves, 8);
  assert.equal(d.writers.dau, 1);
  assert.equal(d.writers.mau, 2);
  assert.equal(d.completion.requests, 2);
  assert.equal(d.completion.suggestions, 1);
  assert.equal(d.completion.shown, 2);
  assert.equal(d.completion.acceptRate, 0.5);
  assert.equal(d.agent.runs, 2);
  assert.equal(d.agent.turns, 1.5);
  assert.equal(d.agent.duration, 6000);
  assert.equal(d.agent.fallbackRate, 0.5);
  assert.equal(d.agent.formattedRate, 0.5);
  assert.deepEqual(d.agent.categories, [{ key: 'Notes', n: 2 }]);
  assert.equal(d.search.count, 2);
  assert.equal(d.search.emptyRate, 0.5);
  assert.deepEqual(d.settings, [{ key: 'theme', n: 2 }, { key: 'fontSize', n: 1 }]);
  assert.equal(d.health.serverErrors[0].key, '/api/documents');
  assert.equal(d.health.clientErrors[0].key, 'x is undefined');
  assert.deepEqual(d.health.rateLimited, [{ key: 'complete', n: 1 }]);
  const cohort = d.cohorts[d.cohorts.length - 1];
  assert.equal(cohort.size, 1);
  assert.deepEqual(cohort.rates, [1]);
});

test('activity: filter by several types, a user, a document or text; export what is shown', async () => {
  const world = createEnv({ ADMIN_PASSWORD: PASSWORD });
  const { DB } = world;
  user(DB, U1, 'finder@example.com');
  event(DB, { type: 'doc_create', user_id: U1, doc_id: D1 });
  event(DB, { type: 'finalize', user_id: U1, doc_id: D1 });
  event(DB, { type: 'search', user_id: U1, meta: { mode: 'semantic' } });
  event(DB, { type: 'login', user_id: U2 });
  event(DB, { type: 'not_found', path: '/old-link', day: daysAgo(30), ts: tsOn(daysAgo(30)) });
  const client = await admin(world);

  const both = (await client.json('/api/admin/events?days=7&type=doc_create,finalize')).body;
  assert.deepEqual(both.events.map((e) => e.type), ['finalize', 'doc_create']);
  assert.equal(both.filters.type, 'doc_create,finalize');
  // Signing in to the console is itself an event (admin_login).
  assert.equal((await client.json('/api/admin/events?days=7&user=finder')).body.events.length, 5, 'not an email: no filter');
  assert.equal((await client.json('/api/admin/events?days=7&user=finder%40example')).body.events.length, 3);
  assert.equal((await client.json(`/api/admin/events?days=7&user=${U1}`)).body.events.length, 3);
  assert.equal((await client.json(`/api/admin/events?days=7&doc=${D1}`)).body.events.length, 2);
  assert.equal((await client.json('/api/admin/events?days=7&q=semantic')).body.events.length, 1);
  assert.equal((await client.json('/api/admin/events?days=7')).body.events.length, 5);
  assert.equal((await client.json('/api/admin/events?days=90')).body.events.length, 6);
  const types = (await client.json('/api/admin/events?days=7')).body.types;
  assert.equal(types.length, 5);
  const page = (await client.json('/api/admin/events?days=7&limit=2')).body;
  assert.equal(page.events.length, 2);
  assert.equal((await client.json(`/api/admin/events?days=7&limit=2&before=${page.next}`)).body.events.length, 2);

  const csv = await (await client.request(`/api/admin/export/events.csv?days=7&user=${U1}`)).text();
  assert.equal(csv.trim().split('\r\n').length, 4);
  assert.match(csv, /"finder@example.com"/);
});

test('a user and a document show their model use; deleting the user keeps the numbers, not the person', async () => {
  const world = createEnv({ ADMIN_PASSWORD: PASSWORD });
  const { DB } = world;
  user(DB, U1, 'someone@example.com');
  DB.raw.prepare(`INSERT INTO documents (id, title, content, status, created_at, updated_at, user_id) VALUES (?, 'T', 'x', 'archived', ?, ?, ?)`)
    .run(D1, tsOn(today), tsOn(today), U1);
  aiCall(DB, { feature: 'agent', user_id: U1, doc_id: D1, neurons: 40, turn: 1 });
  aiCall(DB, { feature: 'completion', user_id: U1, neurons: 2 });
  event(DB, { type: 'archived', user_id: U1, doc_id: D1 });
  DB.raw.prepare(`INSERT INTO writing_days (day, doc_id, user_id, saves, chars) VALUES (?, ?, ?, 7, 10)`).run(today, D1, U1);
  const client = await admin(world);

  const u = (await client.json(`/api/admin/users/${U1}`)).body;
  assert.equal(u.ai.reduce((s, r) => s + r.calls, 0), 2);
  assert.equal(u.writing.days, 1);
  assert.equal(u.writing.saves, 7);
  const doc = (await client.json(`/api/admin/documents/${D1}`)).body;
  assert.equal(doc.ai.length, 1);
  assert.ok(Math.abs(doc.ai[0].usd - 40 * 0.000011) < 1e-12);
  assert.equal(doc.events[0].type, 'archived');

  await client.json(`/api/admin/users/${U1}`, { method: 'DELETE' });
  assert.equal(DB.get('SELECT COUNT(*) AS n FROM ai_calls').n, 2);
  assert.equal(DB.get('SELECT COUNT(*) AS n FROM ai_calls WHERE user_id IS NOT NULL').n, 0);
  assert.equal(DB.get('SELECT COUNT(*) AS n FROM writing_days WHERE user_id IS NOT NULL').n, 0);
});

test('the overview adds traffic, accounts, writing, models and health together', async () => {
  const world = createEnv({ ADMIN_PASSWORD: PASSWORD });
  const { DB } = world;
  pageview(DB, { visitor: 'x', session: 'x', entry: 1 });
  event(DB, { type: 'server_error', path: '/api/x' });
  aiCall(DB, { neurons: 500 });
  const client = await admin(world);
  // Moved over from 0.13: counted as a view, left out of the session numbers.
  pageview(DB, { visitor: 'old', session: 'legacy-7', entry: 1 });
  // One page, used for a minute: a visit, not a bounce.
  pageview(DB, { visitor: 'y', session: 'y', entry: 1, engaged_ms: 60_000 });
  const o = (await client.json('/api/admin/overview?days=7')).body;
  assert.equal(o.traffic.pageviews, 3);
  assert.equal(o.traffic.sessions, 2);
  assert.equal(o.traffic.bounceRate, 0.5);
  assert.equal(o.ai.calls, 1);
  assert.ok(Math.abs(o.daily[6].usd - 500 * 0.000011) < 1e-12);
  assert.equal(o.health.serverErrors, 1);
  assert.equal(o.system.analyticsSecret, false);
  assert.equal(o.system.rows, undefined, 'row counts live on the settings page');
  const config = (await client.json('/api/admin/config')).body;
  assert.equal(config.rows.pageviews, 3);
  assert.equal(config.rows.ai_calls, 1);
});

test("Cloudflare's own usage numbers, when a token is configured", async () => {
  const range = { since: today, until: today, days: 1 };
  assert.deepEqual(await cloudflareUsage({}, range), { configured: false });
  const env = { CF_ANALYTICS_TOKEN: 'token', CF_ACCOUNT_ID: 'acct' };
  let sent = null;
  const ok = await cloudflareUsage(env, range, async (url, init) => {
    sent = { url, init };
    return new Response(JSON.stringify({
      data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [
        { count: 3, sum: { totalNeurons: 12.5, totalInputTokens: 900, totalOutputTokens: 40 }, dimensions: { date: today, modelId: '@cf/qwen/qwen3-30b-a3b-fp8' } },
      ] }] } },
    }));
  });
  assert.equal(sent.url, 'https://api.cloudflare.com/client/v4/graphql');
  assert.equal(sent.init.headers.Authorization, 'Bearer token');
  assert.equal(JSON.parse(sent.init.body).variables.account, 'acct');
  assert.equal(ok.models[0].neurons, 12.5);
  assert.equal(ok.daily[0].neurons, 12.5);
  const bad = await cloudflareUsage(env, range, async () => new Response(JSON.stringify({ errors: [{ message: 'not authorized' }] })));
  assert.equal(bad.error, 'not authorized');
});
