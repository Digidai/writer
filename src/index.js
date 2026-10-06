// Writer — a quiet, input-focused writing surface on the Cloudflare stack.
// Routing: static assets serve the editor (/), archive (/archive),
// settings and sign-in pages; this Worker handles the API, the reading
// view (/d/:id), the admin console (/admin) and the cron janitor.
// Archiving itself runs in the WriterPipeline workflow.
import { launchPipeline, sweepIdleDrafts, deriveTitle, markdownFile, fileKey } from './agent.js';
import { complete } from './ai.js';
import { renderDocumentPage, renderNotFoundPage } from './html.js';
import { readSettings, mergeUserSettings } from './settings.js';
import { handleUnlock, requireAccess } from './access.js';
import { enforceRateLimit } from './rate-limit.js';
import { getSettings, updateSettings } from './settings-endpoint.js';
import { updateDocument } from './document-update.js';
import { resolveLang } from '../public/i18n.js';
import { handleExportRequest } from './export.js';
import { backfillArchiveVectors, deleteDocumentVector } from './semantic.js';
import { handleMcpRequest } from './mcp.js';
import { searchDocumentsData } from './search-endpoint.js';
import { reopenDocument, restoreDocument } from './archive-actions.js';
import { handleReindexRequest } from './reindex.js';
import { getViewer, ensureAnonId, ownerScope, authRequired, handleAuthApi } from './auth.js';
import { handleSignal, track, recordWriting, normalizePath, isBot } from './analytics.js';
import { errorText } from './ai-usage.js';
import { handleAdmin } from './admin.js';
import { json, readJson, withCookies } from './http.js';
import { bumpCounter, hourBucket } from './site-config.js';

export { WriterPipeline } from './pipeline.js';

const MAX_CONTENT = 200_000;
// Anonymous drafts are capped in size and in how many can start per hour
// across the instance, so nobody can fill the database without an account.
const ANON_MAX_CONTENT = 50_000;
const ANON_CREATES_PER_HOUR = 100;
const MAX_CONTEXT = 4_000;
// A 'processing' row this stale means its workflow died; relaunch it.
const STALE_PROCESSING_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (/^\/mcp\/?$/.test(pathname)) {
      return handleMcpRequest(request, env, ctx);
    }

    // The admin console has its own password and sits outside the
    // optional site lock.
    if (pathname === '/admin' || pathname.startsWith('/admin/') || pathname.startsWith('/api/admin/')) {
      if (isCrossSiteWrite(request, url)) return json({ error: 'forbidden' }, 403);
      return handleAdmin(request, env, ctx, url);
    }

    if (pathname === '/unlock') {
      return handleUnlock(request, env, url, {
        consumeUnlockAttempt: (req) => throttle(req, env, ctx, {
          bucket: 'unlock',
          limit: 10,
          windowMs: FIFTEEN_MINUTES_MS,
        }),
      });
    }

    const denied = requireAccess(request, env);
    if (denied) return denied;

    // Cookies are SameSite=Lax, and on top of that no other site may make
    // this browser write here (this is what stops login CSRF).
    if (pathname.startsWith('/api/') && isCrossSiteWrite(request, url)) {
      return json({ error: 'forbidden' }, 403);
    }

    const viewer = await getViewer(request, env);
    let response;
    try {
      if (pathname.startsWith('/api/')) response = await handleApi(request, env, ctx, url, viewer);
      else if (pathname.startsWith('/d/')) response = await handleReader(request, env, ctx, url, viewer);
      else {
        response = await env.ASSETS.fetch(request);
        if (response.status === 404 && request.method === 'GET') noteNotFound(env, ctx, request, pathname);
      }
    } catch (err) {
      console.error('unhandled error', err);
      track(env, ctx, {
        type: 'server_error', request, path: normalizePath(pathname), meta: { method: request.method, message: errorText(err) },
      });
      response = json({ error: 'internal error' }, 500);
    }
    return withCookies(response, viewer.cookies);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sweepIdleDrafts(env));
    ctx.waitUntil(backfillArchiveVectors(env).catch((err) => {
      console.error('semantic backfill failed', err);
    }));
  },
};

function isCrossSiteWrite(request, url) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return false;
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return true;
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== url.host;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------- API

async function handleApi(request, env, ctx, url, viewer) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if (path.startsWith('/api/auth/')) {
    const handled = await handleAuthApi(request, env, ctx, path, viewer);
    if (handled) return handled;
  }
  if (path === '/api/signal' && method === 'POST') return handleSignal(request, env, ctx, viewer);

  if (path === '/api/documents' && method === 'POST') {
    const limited = await limitDocumentCreates(request, env, ctx, viewer);
    if (limited) return limited;
    return createDocument(request, env, ctx, viewer);
  }
  if (path === '/api/documents' && method === 'GET') return listDocuments(env, url, viewer);
  if (path === '/api/search' && method === 'GET') return searchDocuments(request, env, ctx, url, viewer);
  if (path === '/api/export' && (method === 'GET' || method === 'HEAD')) {
    const res = await handleExportRequest(request, env, viewer);
    if (method === 'GET' && res.status === 200) track(env, ctx, { type: 'export', request, userId: viewer.user.id });
    return res;
  }
  if (path === '/api/reindex' && method === 'POST') return handleReindexRequest(env);
  if (path === '/api/complete' && method === 'POST') {
    const limited = await throttle(request, env, ctx, {
      bucket: 'complete',
      limit: env.WRITER_ACCESS_KEY || viewer.user ? 60 : 20,
      windowMs: HOUR_MS,
    });
    if (limited) return limited;
    return handleComplete(request, env, ctx, viewer);
  }
  if (path === '/api/settings' && method === 'GET') return getSettings(env, viewer);
  if (path === '/api/settings' && method === 'PUT') {
    return updateSettings(request, env, viewer, {
      onSaved: (keys) => {
        if (keys.length) track(env, ctx, { type: 'settings_change', request, userId: viewer.user.id, meta: { keys } });
      },
    });
  }

  const m = path.match(/^\/api\/documents\/([0-9a-fA-F-]{36})(?:\/(finalize|file|reopen|restore))?$/);
  if (m) {
    const [, id, sub] = m;
    if (method === 'GET') {
      if (!sub) return getDocument(env, id, viewer);
      if (sub === 'file') {
        const res = await downloadFile(env, id, viewer);
        if (res.status === 200) track(env, ctx, { type: 'download', request, userId: viewer.user.id, docId: id });
        return res;
      }
      return json({ error: 'not found' }, 404);
    }
    // Only real writes spend the write budget: a cross-site HEAD flood
    // must not be able to throttle someone's autosave.
    const isWrite = sub ? method === 'POST' && sub !== 'file' : method === 'PUT' || method === 'DELETE';
    if (!isWrite) return json({ error: 'method not allowed' }, 405);

    const limited = await limitDocumentWrites(request, env, ctx);
    if (limited) return limited;
    if (!sub && method === 'PUT') {
      return updateDocument(request, env, id, {
        maxContent: MAX_CONTENT,
        anonMaxContent: ANON_MAX_CONTENT,
        viewer,
        onSaved: ({ chars }) => noteWriting(env, ctx, request, viewer, id, chars),
      });
    }
    if (!sub && method === 'DELETE') return deleteDocument(request, env, ctx, id, url, viewer);
    if (sub === 'finalize' && method === 'POST') return finalizeDocument(request, env, ctx, id, viewer);
    if (sub === 'reopen' && method === 'POST') {
      if (!viewer.user) return authRequired();
      const res = await reopenDocument(env, id, viewer);
      if (res.ok) track(env, ctx, { type: 'reopen', request, userId: viewer.user.id, docId: id });
      return res;
    }
    if (sub === 'restore' && method === 'POST') {
      if (!viewer.user) return authRequired();
      const res = await restoreDocument(env, id, viewer, ctx);
      if (res.ok) track(env, ctx, { type: 'restore', request, userId: viewer.user.id, docId: id });
      return res;
    }
  }

  return json({ error: 'not found' }, 404);
}

// Anyone can start a draft: signed-in writers own it outright, everyone
// else through an anonymous browser id that signing in later claims.
async function createDocument(request, env, ctx, viewer) {
  const body = await readJson(request);
  const content = typeof (body && body.content) === 'string' ? body.content : '';
  if (content.length > MAX_CONTENT) return json({ error: 'content too large' }, 413);

  const userId = viewer.user ? viewer.user.id : null;
  if (!userId) {
    if (content.length > ANON_MAX_CONTENT) return json({ error: 'content too large', signIn: true }, 413);
    if ((await bumpCounter(env, `anon_create:${hourBucket()}`)) > ANON_CREATES_PER_HOUR) {
      return json({ error: 'busy' }, 429);
    }
  }
  const anonId = userId ? null : ensureAnonId(viewer);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO documents (id, title, content, status, created_at, updated_at, user_id, anon_id)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`
  )
    .bind(id, deriveTitle(content), content, now, now, userId, anonId)
    .run();

  track(env, ctx, { type: 'doc_create', request, userId, docId: id, meta: { anonymous: !userId } });
  if (content) noteWriting(env, ctx, request, viewer, id, content.length);
  return json({ id, status: 'draft', created_at: now, updated_at: now }, 201);
}

async function getDocument(env, id, viewer) {
  const scope = ownerScope(viewer);
  const row = await env.DB.prepare(`SELECT * FROM documents WHERE id = ? AND ${scope.sql}`)
    .bind(id, ...scope.binds)
    .first();
  if (!row) return json({ error: 'not found' }, 404);
  return json(publicDoc(row, { content: true }));
}

async function listDocuments(env, url, viewer) {
  if (!viewer.user) return authRequired();
  const allowed = new Set(['draft', 'processing', 'archived', 'deleted']);
  const statuses = (url.searchParams.get('status') || 'archived,processing')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => allowed.has(s));
  if (statuses.length === 0) return json({ documents: [] });

  const placeholders = statuses.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, title, status, category, tags, summary, created_at, updated_at, archived_at, deleted_at
       FROM documents
      WHERE user_id = ? AND status IN (${placeholders})
      ORDER BY COALESCE(deleted_at, archived_at, updated_at) DESC
      LIMIT 200`
  )
    .bind(viewer.user.id, ...statuses)
    .all();

  return json({ documents: (results || []).map((r) => publicDoc(r)) });
}

// Deleting is reversible by default: the row moves to the trash and the
// R2 file stays put. `?permanent=1` erases a trashed document for good.
async function deleteDocument(request, env, ctx, id, url, viewer) {
  const scope = ownerScope(viewer);
  const permanent = url.searchParams.get('permanent') === '1';
  const row = await env.DB.prepare(`SELECT id, status, archived_at FROM documents WHERE id = ? AND ${scope.sql}`)
    .bind(id, ...scope.binds)
    .first();
  if (!row) return json({ error: 'not found' }, 404);
  const userId = viewer.user ? viewer.user.id : null;

  if (!permanent) {
    if (row.status === 'processing') return json({ error: 'processing' }, 409);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE documents SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ? AND ${scope.sql}`
    )
      .bind(now, now, id, ...scope.binds)
      .run();
    track(env, ctx, { type: 'trash', request, userId, docId: id });
    return json({ id, status: 'deleted', deleted_at: now });
  }

  if (row.status !== 'deleted') {
    return json({ error: 'move to trash first', status: row.status }, 409);
  }
  if (env.FILES && row.archived_at) {
    try {
      await env.FILES.delete(fileKey({ id: row.id, archived_at: row.archived_at }));
    } catch (err) {
      console.error(`delete: R2 removal failed for ${id}`, err);
    }
  }
  await env.DB.prepare(`DELETE FROM documents WHERE id = ? AND status = 'deleted' AND ${scope.sql}`)
    .bind(id, ...scope.binds)
    .run();
  await deleteDocumentVector(env, id);
  track(env, ctx, { type: 'erase', request, userId, docId: id });
  return json({ id, status: 'erased' });
}

// What was searched is never stored: only how (mode), how long it was,
// how many results came back and how fast.
async function searchDocuments(request, env, ctx, url, viewer) {
  if (!viewer.user) return authRequired();
  const started = Date.now();
  const data = await searchDocumentsData(env, url, { mapDoc: (row) => publicDoc(row), limit: 50, viewer, ctx });
  if (data.query) {
    track(env, ctx, {
      type: 'search',
      request,
      userId: viewer.user.id,
      value: data.documents.length,
      meta: { mode: data.mode, fallback: data.fallback, chars: data.query.length, ms: Date.now() - started },
    });
  }
  return json(data);
}

// Filing a piece needs an account. Anonymous writers get 401 and the
// editor asks for an email; signing in claims the draft, then this runs again.
async function finalizeDocument(request, env, ctx, id, viewer) {
  const body = await readJson(request);
  // The editor's own idle timer files drafts too; it says so.
  const auto = Boolean(body && body.auto === true);
  const scope = ownerScope(viewer);
  const row = await env.DB.prepare(
    `SELECT id, status, content, updated_at FROM documents WHERE id = ? AND ${scope.sql}`
  )
    .bind(id, ...scope.binds)
    .first();
  if (!row) return json({ error: 'not found' }, 404);
  if (!viewer.user) {
    // The sign-in wall: the funnel's most important step.
    track(env, ctx, { type: 'finalize_blocked', request, docId: id, value: String(row.content || '').length });
    return authRequired();
  }
  if (row.status === 'deleted') return json({ id, status: 'deleted' }, 409);
  if (row.status === 'archived') return json({ id, status: 'archived' });

  if (row.status === 'processing') {
    // A workflow should have this in hand; if the row is stale, it died — relaunch.
    if (Date.parse(row.updated_at) < Date.now() - STALE_PROCESSING_MS) {
      try {
        await launchPipeline(env, id, { reclaim: true, trigger: 'reclaim' });
      } catch (err) {
        console.error(`finalize: relaunch failed for ${id}`, err);
      }
    }
    return json({ id, status: 'processing' }, 202);
  }

  if (!row.content || row.content.trim().length < 2) {
    // Guarded delete: a concurrent autosave may have just landed real
    // content, in which case fall through and archive it instead.
    const del = await env.DB.prepare(
      `DELETE FROM documents WHERE id = ? AND status = 'draft' AND length(trim(content)) < 2 AND user_id = ?`
    )
      .bind(id, viewer.user.id)
      .run();
    if (del.meta.changes > 0) return json({ id, status: 'discarded' });
  }

  const launched = await launchPipeline(env, id, { trigger: auto ? 'idle' : 'manual' });
  if (!launched) {
    const cur = await env.DB.prepare('SELECT status FROM documents WHERE id = ? AND user_id = ?')
      .bind(id, viewer.user.id)
      .first();
    if (!cur) return json({ error: 'not found' }, 404);
    return json({ id, status: cur.status }, 202);
  }
  track(env, ctx, {
    type: 'finalize', request, userId: viewer.user.id, docId: id, value: String(row.content || '').length, meta: { auto },
  });
  return json({ id, status: 'processing' }, 202);
}

async function downloadFile(env, id, viewer) {
  if (!viewer.user) return authRequired();
  const row = await env.DB.prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?')
    .bind(id, viewer.user.id)
    .first();
  if (!row) return json({ error: 'not found' }, 404);

  let body = null;
  if (env.FILES && row.archived_at) {
    const obj = await env.FILES.get(fileKey(row));
    if (obj) body = await obj.text();
  }
  if (body === null) {
    body = markdownFile({ ...row, tags: safeTags(row.tags), formatted: row.formatted || row.content });
  }

  const name = encodeURIComponent(`${row.title || row.id}.md`);
  return new Response(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${row.id}.md"; filename*=UTF-8''${name}`,
    },
  });
}

async function handleComplete(request, env, ctx, viewer) {
  const body = await readJson(request);
  const context = typeof (body && body.context) === 'string' ? body.context.slice(-MAX_CONTEXT) : '';
  if (context.trim().length < 5) return json({ text: '' });

  // Metered in ai_calls (feature 'completion'); whether a suggestion was
  // shown, accepted or dismissed comes from the editor itself.
  const userId = viewer.user ? viewer.user.id : null;
  try {
    const text = await complete(env, context, { feature: 'completion', userId, ctx });
    return json({ text });
  } catch (err) {
    console.error('completion failed', err);
    return json({ text: '' });
  }
}

// ------------------------------------------------------------- Reader

async function handleReader(request, env, ctx, url, viewer) {
  const lang = await pageLang(request, env, viewer);
  const m = url.pathname.match(/^\/d\/([0-9a-fA-F-]{36})$/);
  if (!m) {
    noteNotFound(env, ctx, request, url.pathname);
    return htmlResponse(renderNotFoundPage(lang), 404);
  }

  // Reading is for the owner. Not signed in: go sign in, then come back.
  if (!viewer.user) {
    const next = encodeURIComponent(url.pathname);
    return new Response(null, { status: 302, headers: { Location: `/login?next=${next}`, 'Cache-Control': 'no-store' } });
  }

  const row = await env.DB.prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?')
    .bind(m[1], viewer.user.id)
    .first();
  if (!row || row.status === 'deleted') {
    noteNotFound(env, ctx, request, url.pathname);
    return htmlResponse(renderNotFoundPage(lang), 404);
  }
  return htmlResponse(renderDocumentPage(row, lang));
}

// The stored preference wins; 'auto' falls back to the browser's own
// Accept-Language header.
async function pageLang(request, env, viewer) {
  let pref = 'auto';
  try {
    pref = mergeUserSettings(await readSettings(env), viewer && viewer.user ? viewer.user : null).language;
  } catch {
    /* settings unavailable: fall through to the header */
  }
  return resolveLang(pref, request.headers.get('Accept-Language'));
}

// New drafts are throttled tightly (that is where spam would come from);
// saves are generous, because autosave fires after every pause in typing.
async function limitDocumentCreates(request, env, ctx, viewer) {
  return throttle(request, env, ctx, {
    bucket: 'documents-create',
    limit: env.WRITER_ACCESS_KEY || viewer.user ? 300 : 40,
    windowMs: HOUR_MS,
  });
}

async function limitDocumentWrites(request, env, ctx) {
  return throttle(request, env, ctx, {
    bucket: 'documents-write',
    limit: env.WRITER_ACCESS_KEY ? 3000 : 1500,
    windowMs: HOUR_MS,
  });
}

// A rate limit that also tells /admin, once per window and address, that
// it started refusing someone.
function throttle(request, env, ctx, opts) {
  return enforceRateLimit(request, {
    ...opts,
    onLimit: () => track(env, ctx, { type: 'rate_limited', request, meta: { bucket: opts.bucket } }),
  });
}

function noteWriting(env, ctx, request, viewer, docId, chars) {
  const pending = recordWriting(env, { docId, userId: viewer.user ? viewer.user.id : null, chars });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(pending);
}

// Broken links and probes, from browsers only, at most 20 an hour per
// address. Files browsers ask for on their own are not broken links.
const AUTOMATIC_REQUESTS = /^\/(favicon\.ico|apple-touch-icon[\w-]*\.png|robots\.txt|sitemap\.xml|\.well-known\/.*)$/;

function noteNotFound(env, ctx, request, pathname) {
  if (AUTOMATIC_REQUESTS.test(pathname) || isBot(request.headers.get('User-Agent') || '')) return;
  const work = (async () => {
    const flood = await enforceRateLimit(request, { bucket: 'not-found', limit: 20, windowMs: HOUR_MS });
    if (!flood) await track(env, null, { type: 'not_found', request, path: normalizePath(pathname) });
  })().catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
}

// ------------------------------------------------------------ Helpers

function publicDoc(row, { content = false } = {}) {
  const doc = {
    id: row.id,
    title: row.title,
    status: row.status,
    category: row.category,
    tags: safeTags(row.tags),
    summary: row.summary,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  };
  if (row.deleted_at) doc.deleted_at = row.deleted_at;
  if (content) {
    doc.content = row.content;
    doc.formatted = row.formatted;
  }
  return doc;
}

function safeTags(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
