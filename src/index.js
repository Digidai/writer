// Writer — a quiet, input-focused writing surface on the Cloudflare stack.
// Routing: static assets serve the editor (/) and archive (/archive);
// this Worker handles the API, the reading view (/d/:id) and the cron
// janitor. Archiving itself runs in the WriterPipeline workflow.
import { launchPipeline, sweepIdleDrafts, deriveTitle, markdownFile, fileKey } from './agent.js';
import { complete } from './ai.js';
import { renderDocumentPage, renderNotFoundPage } from './html.js';
import { readSettings } from './settings.js';
import { handleUnlock, requireAccess } from './access.js';
import { enforceRateLimit } from './rate-limit.js';
import { updateSettings } from './settings-endpoint.js';
import { updateDocument } from './document-update.js';
import { resolveLang } from '../public/i18n.js';

export { WriterPipeline } from './pipeline.js';

const MAX_CONTENT = 200_000;
const MAX_CONTEXT = 4_000;
// A 'processing' row this stale means its workflow died; relaunch it.
const STALE_PROCESSING_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/unlock') {
      return handleUnlock(request, env, url, {
        consumeUnlockAttempt: (req) => enforceRateLimit(req, {
          bucket: 'unlock',
          limit: 10,
          windowMs: FIFTEEN_MINUTES_MS,
        }),
      });
    }

    const denied = requireAccess(request, env);
    if (denied) return denied;

    try {
      if (pathname.startsWith('/api/')) return await handleApi(request, env, ctx, url);
      if (pathname.startsWith('/d/')) return await handleReader(request, env, pathname);
    } catch (err) {
      console.error('unhandled error', err);
      return json({ error: 'internal error' }, 500);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sweepIdleDrafts(env));
  },
};

// ---------------------------------------------------------------- API

async function handleApi(request, env, ctx, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if (path === '/api/documents' && method === 'POST') {
    const limited = await limitDocumentWrites(request, env);
    if (limited) return limited;
    return createDocument(request, env);
  }
  if (path === '/api/documents' && method === 'GET') return listDocuments(env, url);
  if (path === '/api/search' && method === 'GET') return searchDocuments(env, url);
  if (path === '/api/complete' && method === 'POST') {
    const limited = await enforceRateLimit(request, {
      bucket: 'complete',
      limit: env.WRITER_ACCESS_KEY ? 60 : 20,
      windowMs: HOUR_MS,
    });
    if (limited) return limited;
    return handleComplete(request, env);
  }
  if (path === '/api/settings' && method === 'GET') return json(await readSettings(env));
  if (path === '/api/settings' && method === 'PUT') return updateSettings(request, env);

  const m = path.match(/^\/api\/documents\/([0-9a-fA-F-]{36})(?:\/(finalize|file|reopen|restore))?$/);
  if (m) {
    const [, id, sub] = m;
    if (!sub && method === 'GET') return getDocument(env, id);
    if (!sub && method === 'PUT') {
      const limited = await limitDocumentWrites(request, env);
      if (limited) return limited;
      return updateDocument(request, env, id, { maxContent: MAX_CONTENT });
    }
    if (!sub && method === 'DELETE') {
      const limited = await limitDocumentWrites(request, env);
      if (limited) return limited;
      return deleteDocument(env, id, url);
    }
    if (sub === 'finalize' && method === 'POST') {
      const limited = await limitDocumentWrites(request, env);
      if (limited) return limited;
      return finalizeDocument(env, id);
    }
    if (sub === 'reopen' && method === 'POST') {
      const limited = await limitDocumentWrites(request, env);
      if (limited) return limited;
      return reopenDocument(env, id);
    }
    if (sub === 'restore' && method === 'POST') {
      const limited = await limitDocumentWrites(request, env);
      if (limited) return limited;
      return restoreDocument(env, id);
    }
    if (sub === 'file' && method === 'GET') return downloadFile(env, id);
  }

  return json({ error: 'not found' }, 404);
}

async function createDocument(request, env) {
  const body = await readJson(request);
  const content = typeof (body && body.content) === 'string' ? body.content : '';
  if (content.length > MAX_CONTENT) return json({ error: 'content too large' }, 413);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO documents (id, title, content, status, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, ?)`
  )
    .bind(id, deriveTitle(content), content, now, now)
    .run();

  return json({ id, status: 'draft', created_at: now, updated_at: now }, 201);
}


async function getDocument(env, id) {
  const row = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);
  return json(publicDoc(row, { content: true }));
}

async function listDocuments(env, url) {
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
      WHERE status IN (${placeholders})
      ORDER BY COALESCE(deleted_at, archived_at, updated_at) DESC
      LIMIT 200`
  )
    .bind(...statuses)
    .all();

  return json({ documents: (results || []).map((r) => publicDoc(r)) });
}

// Editing an archive entry: it becomes a draft again and comes back to
// the editor. Finishing it re-runs the agent, so the archive stays the
// agent's to organize.
async function reopenDocument(env, id) {
  const row = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);
  if (row.status === 'processing') return json({ error: 'processing', status: 'processing' }, 409);
  if (row.status === 'deleted') return json({ error: 'deleted', status: 'deleted' }, 409);

  // Edit what the reader saw: the agent's typeset version when there is one.
  const content = row.formatted || row.content || '';
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE documents SET status = 'draft', content = ?, updated_at = ?, archived_at = NULL
      WHERE id = ? AND status IN ('archived', 'draft')`
  )
    .bind(content, now, id)
    .run();
  if (result.meta.changes === 0) return json({ error: 'conflict' }, 409);

  return json({ id, status: 'draft', content, updated_at: now });
}

// Deleting is reversible by default: the row moves to the trash and the
// R2 file stays put. `?permanent=1` erases a trashed document for good.
async function deleteDocument(env, id, url) {
  const permanent = url.searchParams.get('permanent') === '1';
  const row = await env.DB.prepare('SELECT id, status, archived_at FROM documents WHERE id = ?')
    .bind(id)
    .first();
  if (!row) return json({ error: 'not found' }, 404);

  if (!permanent) {
    if (row.status === 'processing') return json({ error: 'processing' }, 409);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE documents SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?`
    )
      .bind(now, now, id)
      .run();
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
  await env.DB.prepare('DELETE FROM documents WHERE id = ? AND status = ?').bind(id, 'deleted').run();
  return json({ id, status: 'erased' });
}

async function restoreDocument(env, id) {
  const result = await env.DB.prepare(
    `UPDATE documents
        SET status = CASE WHEN archived_at IS NULL THEN 'draft' ELSE 'archived' END,
            deleted_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'deleted'`
  )
    .bind(new Date().toISOString(), id)
    .run();
  if (result.meta.changes === 0) return json({ error: 'not in trash' }, 404);

  const row = await env.DB.prepare('SELECT status FROM documents WHERE id = ?').bind(id).first();
  return json({ id, status: row ? row.status : 'archived' });
}

async function searchDocuments(env, url) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  if (!q) return json({ documents: [] });

  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const { results } = await env.DB.prepare(
    `SELECT id, title, status, category, tags, summary, created_at, updated_at, archived_at
       FROM documents
      WHERE status = 'archived'
        AND (title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'
             OR tags LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
      ORDER BY archived_at DESC
      LIMIT 50`
  )
    .bind(like, like, like, like)
    .all();

  return json({ documents: (results || []).map((r) => publicDoc(r)), query: q });
}

async function finalizeDocument(env, id) {
  const row = await env.DB.prepare('SELECT id, status, content, updated_at FROM documents WHERE id = ?')
    .bind(id)
    .first();
  if (!row) return json({ error: 'not found' }, 404);
  if (row.status === 'deleted') return json({ id, status: 'deleted' }, 409);
  if (row.status === 'archived') return json({ id, status: 'archived' });

  if (row.status === 'processing') {
    // A workflow should have this in hand; if the row is stale, it died — relaunch.
    if (Date.parse(row.updated_at) < Date.now() - STALE_PROCESSING_MS) {
      try {
        await launchPipeline(env, id, { reclaim: true });
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
      `DELETE FROM documents WHERE id = ? AND status = 'draft' AND length(trim(content)) < 2`
    )
      .bind(id)
      .run();
    if (del.meta.changes > 0) return json({ id, status: 'discarded' });
  }

  const launched = await launchPipeline(env, id);
  if (!launched) {
    const cur = await env.DB.prepare('SELECT status FROM documents WHERE id = ?').bind(id).first();
    if (!cur) return json({ error: 'not found' }, 404);
    return json({ id, status: cur.status }, 202);
  }
  return json({ id, status: 'processing' }, 202);
}

async function downloadFile(env, id) {
  const row = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);

  let body = null;
  if (env.FILES && row.archived_at) {
    const obj = await env.FILES.get(`documents/${row.archived_at.slice(0, 4)}/${row.id}.md`);
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

async function handleComplete(request, env) {
  const body = await readJson(request);
  const context = typeof (body && body.context) === 'string' ? body.context.slice(-MAX_CONTEXT) : '';
  if (context.trim().length < 5) return json({ text: '' });

  try {
    return json({ text: await complete(env, context) });
  } catch (err) {
    console.error('completion failed', err);
    return json({ text: '' });
  }
}

// ------------------------------------------------------------- Reader

async function handleReader(request, env, pathname) {
  const lang = await pageLang(request, env);
  const m = pathname.match(/^\/d\/([0-9a-fA-F-]{36})$/);
  if (!m) return htmlResponse(renderNotFoundPage(lang), 404);

  const row = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(m[1]).first();
  if (!row || row.status === 'deleted') return htmlResponse(renderNotFoundPage(lang), 404);
  return htmlResponse(renderDocumentPage(row, lang));
}

// The stored preference wins; 'auto' falls back to the browser's own
// Accept-Language header.
async function pageLang(request, env) {
  let pref = 'auto';
  try {
    pref = (await readSettings(env)).language;
  } catch {
    /* settings unavailable: fall through to the header */
  }
  return resolveLang(pref, request.headers.get('Accept-Language'));
}

async function limitDocumentWrites(request, env) {
  return enforceRateLimit(request, {
    bucket: 'documents-write',
    limit: env.WRITER_ACCESS_KEY ? 300 : 30,
    windowMs: HOUR_MS,
  });
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

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
