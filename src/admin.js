// The admin console at /admin: one password (the ADMIN_PASSWORD secret),
// every management action, and the numbers behind the site and product.
//
// Hidden (404) until ADMIN_PASSWORD is set. Logins are throttled per IP
// at the edge and globally in D1, and a session is bound to the current
// password: rotating the secret signs every console session out.
import { json, readJson, readCookie, serializeCookie, randomToken, sha256Hex, safeEqual, nowIso } from './http.js';
import { enforceRateLimit } from './rate-limit.js';
import {
  setConfig, registrationStatus, REGISTRATION_OPEN, REGISTRATION_CLOSED, bumpCounter, hourBucket, secondsToNextHour,
} from './site-config.js';
import { readSettings, writeSettings } from './settings.js';
import { launchPipeline, sweepIdleDrafts, fileKey } from './agent.js';
import { deleteDocumentVector, upsertDocumentVector, semanticFeatureEnabled } from './semantic.js';
import { emailConfigured } from './email.js';
import { normalizeEmail } from './auth.js';
import { track, normalizePath } from './analytics.js';
import { escapeLike } from './search.js';
import { WRITER_VERSION } from './version.js';
import { errorText, USD_PER_NEURON } from './ai-usage.js';
import {
  parseRange, overviewReport, trafficReport, pageviewLog, productReport, aiReport, aiCallLog, cloudflareUsage,
  eventLog, eventsForCsv, aiCallsForCsv, pageviewsForCsv,
} from './admin-analytics.js';

export const ADMIN_COOKIE = '__Host-writer_admin';
const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;
const STUCK_MS = 15 * 60 * 1000;
// Global brute-force brake: this many sign-in attempts per hour, from
// anywhere. The counter is keyed by a hash of the current password, so
// rotating ADMIN_PASSWORD also lifts a lockout someone else caused.
const GLOBAL_ATTEMPTS_PER_HOUR = 30;
const UUID = '[0-9a-fA-F-]{36}';

export async function handleAdmin(request, env, ctx, url, now = Date.now()) {
  if (!env.ADMIN_PASSWORD) return new Response('Not found', { status: 404 });
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (path === '/admin') {
    if (method !== 'GET' && method !== 'HEAD') return json({ error: 'method not allowed' }, 405);
    const page = await env.ASSETS.fetch(request);
    const out = new Response(page.body, page);
    out.headers.set('X-Robots-Tag', 'noindex, nofollow');
    out.headers.set('Cache-Control', 'no-store');
    out.headers.set('Referrer-Policy', 'no-referrer');
    out.headers.set('X-Frame-Options', 'DENY');
    return out;
  }
  if (!path.startsWith('/api/admin')) return new Response('Not found', { status: 404 });

  if (path === '/api/admin/login' && method === 'POST') return login(request, env, ctx, now);

  const session = await adminSession(request, env, now);
  if (path === '/api/admin/session' && method === 'GET') return json({ ok: Boolean(session) });
  if (!session) return json({ error: 'admin_required' }, 401);

  try {
    return await route(request, env, ctx, url, path, method, session, now);
  } catch (err) {
    console.error('admin error', err);
    track(env, ctx, { type: 'server_error', request, path: normalizePath(path), meta: { method, message: errorText(err) } });
    return json({ error: 'internal error' }, 500);
  }
}

async function route(request, env, ctx, url, path, method, session, now) {
  const q = url.searchParams;
  if (path === '/api/admin/logout' && method === 'POST') return logout(env, session);
  const range = () => parseRange(q, now);
  if (path === '/api/admin/overview' && method === 'GET') return json(await overview(env, range(), now));
  if (path === '/api/admin/traffic' && method === 'GET') return json(await trafficReport(env, range(), q));
  if (path === '/api/admin/pageviews' && method === 'GET') return json(await pageviewLog(env, range(), q));
  if (path === '/api/admin/product' && method === 'GET') return json(await productReport(env, range()));
  if (path === '/api/admin/ai' && method === 'GET') return json(await aiReport(env, range(), q, now));
  if (path === '/api/admin/ai/calls' && method === 'GET') return json(await aiCallLog(env, range(), q));
  if (path === '/api/admin/ai/cloudflare' && method === 'GET') return json(await cloudflareUsage(env, range()));
  if (path === '/api/admin/users' && method === 'GET') return json(await listUsers(env, q));
  if (path === '/api/admin/documents' && method === 'GET') return json(await listDocuments(env, q));
  if (path === '/api/admin/events' && method === 'GET') return json(await eventLog(env, range(), q));
  if (path === '/api/admin/config' && method === 'GET') return json(await readConfig(env));
  if (path === '/api/admin/config' && method === 'PUT') return updateConfig(request, env, ctx);
  if (path === '/api/admin/sweep' && method === 'POST') {
    const result = await sweepIdleDrafts(env, { now });
    audit(env, ctx, 'sweep', null, result);
    return json(result);
  }
  if (path === '/api/admin/export/users.csv' && method === 'GET') return exportUsersCsv(env);
  if (path === '/api/admin/export/documents.csv' && method === 'GET') return exportDocumentsCsv(env);
  if (path === '/api/admin/export/events.csv' && method === 'GET') {
    return csv('writer-events', EVENT_COLUMNS, await eventsForCsv(env, range(), q));
  }
  if (path === '/api/admin/export/ai_calls.csv' && method === 'GET') {
    return csv('writer-model-calls', AI_COLUMNS, await aiCallsForCsv(env, range(), q));
  }
  if (path === '/api/admin/export/pageviews.csv' && method === 'GET') {
    return csv('writer-pageviews', PAGEVIEW_COLUMNS, await pageviewsForCsv(env, range(), q));
  }

  let m = path.match(new RegExp(`^/api/admin/users/(${UUID})(?:/(disable|enable|signout))?$`));
  if (m) {
    const [, id, action] = m;
    if (!action && method === 'GET') return userDetail(env, id);
    if (!action && method === 'DELETE') return deleteUser(env, ctx, id);
    if (action && method === 'POST') return userAction(env, ctx, id, action);
  }

  m = path.match(new RegExp(`^/api/admin/documents/(${UUID})(?:/(rerun|trash|restore|assign))?$`));
  if (m) {
    const [, id, action] = m;
    if (!action && method === 'GET') return documentDetail(env, id);
    if (!action && method === 'DELETE') return eraseDocument(env, ctx, id);
    if (action && method === 'POST') return documentAction(request, env, ctx, id, action, now);
  }

  return json({ error: 'not found' }, 404);
}

// ------------------------------------------------------------- session

async function passwordTag(env) {
  return (await sha256Hex(`admin:${env.ADMIN_PASSWORD}`)).slice(0, 16);
}

async function sessionHash(env, token) {
  return sha256Hex(`${token}:${await passwordTag(env)}`);
}

async function adminSession(request, env, now) {
  const token = readCookie(request, ADMIN_COOKIE);
  if (!token) return null;
  try {
    const hash = await sessionHash(env, token);
    const row = await env.DB.prepare('SELECT token_hash FROM admin_sessions WHERE token_hash = ? AND expires_at > ?')
      .bind(hash, nowIso(now))
      .first();
    return row ? { hash } : null;
  } catch {
    return null;
  }
}

async function login(request, env, ctx, now) {
  const limited = await enforceRateLimit(request, {
    bucket: 'admin-login',
    limit: 5,
    windowMs: 15 * 60 * 1000,
    onLimit: () => track(env, ctx, { type: 'rate_limited', request, meta: { bucket: 'admin-login' } }),
  });
  if (limited) return limited;

  // Spend the attempt before comparing, atomically: concurrent guesses
  // can never slip past the budget.
  const used = await bumpCounter(env, `admin_try:${hourBucket(now)}:${await passwordTag(env)}`);
  if (used > GLOBAL_ATTEMPTS_PER_HOUR) {
    return json({ error: 'locked', retryAfter: secondsToNextHour(now) }, 429);
  }

  const body = await readJson(request);
  const password = body && typeof body.password === 'string' ? body.password : '';
  if (!password || !safeEqual(password, env.ADMIN_PASSWORD)) {
    track(env, ctx, { type: 'admin_login_failed', request });
    return json({ error: 'invalid_password' }, 401);
  }

  const token = randomToken(32);
  await env.DB.prepare('INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
    .bind(await sessionHash(env, token), nowIso(now), nowIso(now + ADMIN_TTL_MS))
    .run();
  track(env, ctx, { type: 'admin_login', request });
  return json({ ok: true }, 200, {
    'Set-Cookie': serializeCookie(ADMIN_COOKIE, token, { maxAge: ADMIN_TTL_MS / 1000, sameSite: 'Strict' }),
  });
}

async function logout(env, session) {
  await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(session.hash).run();
  return json({ ok: true }, 200, { 'Set-Cookie': serializeCookie(ADMIN_COOKIE, '', { maxAge: 0, sameSite: 'Strict' }) });
}

// ----------------------------------------------------------- numbers

async function count(env, sql, ...binds) {
  const row = await env.DB.prepare(sql).bind(...binds).first();
  const v = row ? Number(Object.values(row)[0]) : 0;
  return Number.isFinite(v) ? v : 0;
}

// The analytics (src/admin-analytics.js) plus what only management needs:
// documents by state, unclaimed drafts, stuck runs and the system.
export async function overview(env, range, now = Date.now()) {
  const [report, byStatus, anonDrafts, legacy, stuck, system] = await Promise.all([
    overviewReport(env, range, now),
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM documents GROUP BY status').all(),
    count(env, 'SELECT COUNT(*) AS n FROM documents WHERE user_id IS NULL AND anon_id IS NOT NULL'),
    count(env, 'SELECT COUNT(*) AS n FROM documents WHERE user_id IS NULL AND anon_id IS NULL'),
    count(env, `SELECT COUNT(*) AS n FROM documents WHERE status = 'processing' AND updated_at < ?`, nowIso(now - STUCK_MS)),
    systemInfo(env),
  ]);
  const documents = { draft: 0, processing: 0, archived: 0, deleted: 0 };
  for (const row of byStatus.results || []) documents[row.status] = Number(row.n) || 0;
  return { ...report, writing: { ...report.writing, anonDrafts, legacy, stuck, documents }, system };
}

const STORAGE_TABLES = ['documents', 'users', 'sessions', 'events', 'pageviews', 'ai_calls', 'writing_days'];

async function systemInfo(env) {
  const rows = await Promise.all(STORAGE_TABLES.map((t) => count(env, `SELECT COUNT(*) AS n FROM ${t}`).catch(() => 0)));
  return {
    version: WRITER_VERSION,
    email: emailConfigured(env),
    registration: await registrationStatus(env),
    semantic: semanticFeatureEnabled(env),
    siteLock: Boolean(env.WRITER_ACCESS_KEY),
    analyticsSecret: Boolean(env.ANALYTICS_SECRET),
    cloudflareAnalytics: Boolean(env.CF_ANALYTICS_TOKEN && env.CF_ACCOUNT_ID),
    rows: Object.fromEntries(STORAGE_TABLES.map((t, i) => [t, rows[i]])),
  };
}

// ------------------------------------------------------------- users

function page(q, fallback = 50) {
  const limit = Math.max(1, Math.min(200, Number(q.get('limit')) || fallback));
  const offset = Math.max(0, Number(q.get('offset')) || 0);
  return { limit, offset };
}

async function listUsers(env, q) {
  const { limit, offset } = page(q);
  const term = (q.get('q') || '').trim().toLowerCase().slice(0, 100);
  const like = `%${escapeLike(term)}%`;
  const where = term ? `WHERE u.email LIKE ? ESCAPE '\\'` : '';
  const binds = term ? [like] : [];
  const [rows, total] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.email, u.status, u.created_at, u.last_login_at,
              (SELECT COUNT(*) FROM documents d WHERE d.user_id = u.id AND d.status = 'archived') AS archived,
              (SELECT COUNT(*) FROM documents d WHERE d.user_id = u.id AND d.status IN ('draft', 'processing')) AS drafts,
              (SELECT COUNT(*) FROM documents d WHERE d.user_id = u.id AND d.status = 'deleted') AS trashed,
              (SELECT MAX(d.updated_at) FROM documents d WHERE d.user_id = u.id) AS last_write
         FROM users u ${where}
        ORDER BY u.created_at DESC LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset).all(),
    count(env, `SELECT COUNT(*) AS n FROM users u ${where}`, ...binds),
  ]);
  return { users: rows.results || [], total, limit, offset };
}

async function userDetail(env, id) {
  const user = await env.DB.prepare('SELECT id, email, status, settings, created_at, last_login_at FROM users WHERE id = ?')
    .bind(id)
    .first();
  if (!user) return json({ error: 'not found' }, 404);
  const [sessions, documents, events, ai, writing] = await Promise.all([
    env.DB.prepare('SELECT created_at, last_seen_at, expires_at, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 20')
      .bind(id).all(),
    env.DB.prepare(
      `SELECT id, title, status, category, updated_at, archived_at, length(content) AS chars
         FROM documents WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100`
    ).bind(id).all(),
    env.DB.prepare('SELECT id, ts, type, doc_id, value, meta FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 30')
      .bind(id).all(),
    env.DB.prepare(
      `SELECT feature, COUNT(*) AS calls, SUM(COALESCE(neurons, 0)) AS neurons, SUM(input_tokens) AS input,
              SUM(output_tokens) AS output, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
         FROM ai_calls WHERE user_id = ? GROUP BY feature`
    ).bind(id).all(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT day) AS days, SUM(saves) AS saves, MIN(day) AS first, MAX(day) AS last
         FROM writing_days WHERE user_id = ?`
    ).bind(id).first(),
  ]);
  return json({
    user: { ...user, settings: safeJson(user.settings) },
    sessions: sessions.results || [],
    documents: documents.results || [],
    events: (events.results || []).map((e) => ({ ...e, meta: safeJson(e.meta) })),
    ai: (ai.results || []).map((r) => ({ ...r, usd: (Number(r.neurons) || 0) * USD_PER_NEURON })),
    writing: writing || {},
  });
}

async function userAction(env, ctx, id, action) {
  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
  if (!user) return json({ error: 'not found' }, 404);
  if (action === 'disable') {
    await env.DB.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).bind(id).run();
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
  } else if (action === 'enable') {
    await env.DB.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).bind(id).run();
  } else if (action === 'signout') {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
  }
  audit(env, ctx, `user_${action}`, id);
  return json({ ok: true });
}

// Deleting an account deletes what they wrote, everywhere it lives.
async function deleteUser(env, ctx, id) {
  const user = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(id).first();
  if (!user) return json({ error: 'not found' }, 404);
  const { results } = await env.DB.prepare('SELECT id, archived_at FROM documents WHERE user_id = ?').bind(id).all();
  for (const doc of results || []) await removeDocumentFiles(env, doc);
  await env.DB.prepare('DELETE FROM documents WHERE user_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM login_codes WHERE email = ?').bind(user.email).run();
  await env.DB.prepare('UPDATE events SET user_id = NULL WHERE user_id = ?').bind(id).run();
  await env.DB.prepare('UPDATE ai_calls SET user_id = NULL WHERE user_id = ?').bind(id).run();
  await env.DB.prepare('UPDATE writing_days SET user_id = NULL WHERE user_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  audit(env, ctx, 'user_delete', null, { documents: (results || []).length });
  return json({ ok: true, documents: (results || []).length });
}

// --------------------------------------------------------- documents

async function listDocuments(env, q) {
  const { limit, offset } = page(q);
  const clauses = [];
  const binds = [];
  const status = q.get('status');
  if (['draft', 'processing', 'archived', 'deleted'].includes(status)) {
    clauses.push('d.status = ?');
    binds.push(status);
  }
  const owner = q.get('owner') || '';
  if (owner === 'anonymous') clauses.push('d.user_id IS NULL AND d.anon_id IS NOT NULL');
  else if (owner === 'legacy') clauses.push('d.user_id IS NULL AND d.anon_id IS NULL');
  else if (/^[0-9a-fA-F-]{36}$/.test(owner)) {
    clauses.push('d.user_id = ?');
    binds.push(owner);
  }
  const term = (q.get('q') || '').trim().slice(0, 100);
  if (term) {
    const like = `%${escapeLike(term)}%`;
    clauses.push(`(d.title LIKE ? ESCAPE '\\' OR d.summary LIKE ? ESCAPE '\\' OR d.content LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')`);
    binds.push(like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows, total] = await Promise.all([
    env.DB.prepare(
      `SELECT d.id, d.title, d.status, d.category, d.summary, d.created_at, d.updated_at, d.archived_at,
              d.deleted_at, d.user_id, (d.anon_id IS NOT NULL) AS anonymous, u.email, length(d.content) AS chars
         FROM documents d LEFT JOIN users u ON u.id = d.user_id
         ${where}
        ORDER BY d.updated_at DESC LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset).all(),
    count(env, `SELECT COUNT(*) AS n FROM documents d LEFT JOIN users u ON u.id = d.user_id ${where}`, ...binds),
  ]);
  return {
    documents: (rows.results || []).map((d) => ({ ...d, anonymous: Boolean(d.anonymous) })),
    total,
    limit,
    offset,
  };
}

async function documentDetail(env, id) {
  const row = await env.DB.prepare(
    `SELECT d.*, u.email FROM documents d LEFT JOIN users u ON u.id = d.user_id WHERE d.id = ?`
  ).bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);
  const { anon_id: anonId, ...doc } = row;
  const [ai, events] = await Promise.all([
    env.DB.prepare(
      `SELECT id, ts, feature, model, status, error, fallback, latency_ms, input_tokens, cached_tokens, output_tokens,
              reasoning_tokens, neurons, turn, tool_calls, finish_reason
         FROM ai_calls WHERE doc_id = ? ORDER BY id DESC LIMIT 100`
    ).bind(id).all(),
    env.DB.prepare('SELECT id, ts, type, value, meta FROM events WHERE doc_id = ? ORDER BY id DESC LIMIT 50').bind(id).all(),
  ]);
  return json({
    ...doc,
    anonymous: Boolean(anonId),
    tags: safeJson(doc.tags) || [],
    agent_trace: safeJson(doc.agent_trace),
    ai: (ai.results || []).map((c) => ({ ...c, usd: c.neurons === null ? null : c.neurons * USD_PER_NEURON })),
    events: (events.results || []).map((e) => ({ ...e, meta: safeJson(e.meta) })),
  });
}

async function documentAction(request, env, ctx, id, action, now) {
  const row = await env.DB.prepare('SELECT id, status, archived_at, user_id FROM documents WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);
  const stamp = nowIso(now);

  if (action === 'rerun') {
    if (row.status === 'deleted') return json({ error: 'deleted' }, 409);
    // The run writes a fresh file (possibly under a new year); drop the old one.
    if (row.status === 'archived') await removeDocumentFiles(env, row);
    // Back to draft first so the pipeline's claim (draft -> processing) owns the run.
    await env.DB.prepare(`UPDATE documents SET status = 'draft', updated_at = ? WHERE id = ? AND status IN ('archived', 'processing', 'draft')`)
      .bind(stamp, id)
      .run();
    const launched = await launchPipeline(env, id, { trigger: 'admin' });
    audit(env, ctx, 'doc_rerun', id);
    return json({ ok: launched, status: launched ? 'processing' : row.status });
  }
  if (action === 'trash') {
    if (row.status === 'processing') return json({ error: 'processing' }, 409);
    await env.DB.prepare(`UPDATE documents SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?`)
      .bind(stamp, stamp, id)
      .run();
    audit(env, ctx, 'doc_trash', id);
    return json({ ok: true, status: 'deleted' });
  }
  if (action === 'restore') {
    if (row.status !== 'deleted') return json({ error: 'not in trash' }, 409);
    await env.DB.prepare(
      `UPDATE documents SET status = CASE WHEN archived_at IS NULL THEN 'draft' ELSE 'archived' END,
              deleted_at = NULL, updated_at = ? WHERE id = ?`
    ).bind(stamp, id).run();
    audit(env, ctx, 'doc_restore', id);
    return json({ ok: true });
  }
  if (action === 'assign') {
    const body = await readJson(request);
    const email = normalizeEmail(body && body.email);
    if (!email) return json({ error: 'invalid_email' }, 400);
    const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (!user) return json({ error: 'no_such_user' }, 404);
    await env.DB.prepare('UPDATE documents SET user_id = ?, anon_id = NULL WHERE id = ?').bind(user.id, id).run();
    if (row.status === 'archived') {
      const doc = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
      if (doc) await upsertDocumentVector(env, doc);
    }
    audit(env, ctx, 'doc_assign', id, { to: user.id });
    return json({ ok: true, user_id: user.id });
  }
  return json({ error: 'not found' }, 404);
}

async function eraseDocument(env, ctx, id) {
  const row = await env.DB.prepare('SELECT id, status, archived_at FROM documents WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);
  if (row.status === 'processing') return json({ error: 'processing' }, 409);
  await removeDocumentFiles(env, row);
  await env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(id).run();
  audit(env, ctx, 'doc_erase', id);
  return json({ ok: true });
}

async function removeDocumentFiles(env, doc) {
  if (env.FILES && doc.archived_at) {
    try {
      await env.FILES.delete(fileKey(doc));
    } catch (err) {
      console.error(`admin: R2 removal failed for ${doc.id}`, err);
    }
  }
  await deleteDocumentVector(env, doc.id);
}

// ------------------------------------------------------------ config

async function readConfig(env) {
  const system = await systemInfo(env);
  return {
    registration: system.registration,
    defaults: await readSettings(env),
    email: { configured: system.email, from: env.MAIL_FROM || 'Writer <noreply@genedai.md>' },
    semantic: system.semantic,
    siteLock: system.siteLock,
    analyticsSecret: system.analyticsSecret,
    cloudflareAnalytics: system.cloudflareAnalytics,
    rows: system.rows,
    version: WRITER_VERSION,
  };
}

async function updateConfig(request, env, ctx) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid body' }, 400);
  if (body.registration !== undefined) {
    if (![REGISTRATION_OPEN, REGISTRATION_CLOSED].includes(body.registration)) {
      return json({ error: 'invalid registration' }, 400);
    }
    await setConfig(env, 'registration', body.registration);
  }
  if (body.defaults && typeof body.defaults === 'object') await writeSettings(env, body.defaults);
  audit(env, ctx, 'config', null, { registration: body.registration, defaults: Boolean(body.defaults) });
  return json(await readConfig(env));
}

// ----------------------------------------------------------- exports

async function exportUsersCsv(env) {
  const { results } = await env.DB.prepare(
    `SELECT u.email, u.status, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM documents d WHERE d.user_id = u.id AND d.status = 'archived') AS archived,
            (SELECT COUNT(*) FROM documents d WHERE d.user_id = u.id AND d.status IN ('draft', 'processing')) AS drafts
       FROM users u ORDER BY u.created_at`
  ).all();
  return csv('writer-users', ['email', 'status', 'created_at', 'last_login_at', 'archived', 'drafts'], results || []);
}

async function exportDocumentsCsv(env) {
  const { results } = await env.DB.prepare(
    `SELECT d.id, u.email, d.status, d.title, d.category, d.created_at, d.updated_at, d.archived_at, length(d.content) AS chars
       FROM documents d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.created_at`
  ).all();
  return csv('writer-documents', ['id', 'email', 'status', 'title', 'category', 'created_at', 'updated_at', 'archived_at', 'chars'], results || []);
}

const EVENT_COLUMNS = ['ts', 'type', 'email', 'user_id', 'doc_id', 'path', 'referrer', 'country', 'device', 'value', 'meta'];
const AI_COLUMNS = ['ts', 'feature', 'model', 'status', 'error', 'fallback', 'latency_ms', 'input_tokens', 'cached_tokens',
  'output_tokens', 'reasoning_tokens', 'neurons', 'usd', 'estimated', 'email', 'user_id', 'doc_id', 'turn', 'tool_calls',
  'finish_reason', 'log_id'];
const PAGEVIEW_COLUMNS = ['ts', 'path', 'entry', 'session', 'channel', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign',
  'country', 'device', 'browser', 'os', 'lang', 'viewport', 'engaged_ms', 'scroll', 'ttfb', 'fcp', 'lcp', 'inp', 'cls'];

// Every cell is quoted (semicolon locales split on ;), and cells that start
// with = + - @ are prefixed so spreadsheets do not run them as formulas.
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function csv(name, columns, rows) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(`﻿${lines.join('\r\n')}\r\n`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

// ------------------------------------------------------------ helpers

function audit(env, ctx, action, target, extra = null) {
  track(env, ctx, { type: 'admin', meta: { action, target, ...(extra || {}) } });
}

function safeJson(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
