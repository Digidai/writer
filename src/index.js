// Writer — a quiet, input-focused writing surface on the Cloudflare stack.
// Routing: static assets serve the editor (/) and archive (/archive);
// this Worker handles the API, the reading view (/d/:id) and the cron
// janitor. Archiving itself runs in the WriterPipeline workflow.
import { launchPipeline, sweepIdleDrafts, deriveTitle, markdownFile } from './agent.js';
import { complete } from './ai.js';
import { renderDocumentPage, renderNotFoundPage, renderUnlockPage } from './html.js';

export { WriterPipeline } from './pipeline.js';

const MAX_CONTENT = 200_000;
const MAX_CONTEXT = 4_000;
// A 'processing' row this stale means its workflow died; relaunch it.
const STALE_PROCESSING_MS = 5 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/unlock') return handleUnlock(request, env, url);

    const denied = requireAccess(request, env);
    if (denied) return denied;

    try {
      if (pathname.startsWith('/api/')) return await handleApi(request, env, ctx, url);
      if (pathname.startsWith('/d/')) return await handleReader(env, pathname);
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

  if (path === '/api/documents' && method === 'POST') return createDocument(request, env);
  if (path === '/api/documents' && method === 'GET') return listDocuments(env, url);
  if (path === '/api/search' && method === 'GET') return searchDocuments(env, url);
  if (path === '/api/complete' && method === 'POST') return handleComplete(request, env);

  const m = path.match(/^\/api\/documents\/([0-9a-fA-F-]{36})(?:\/(finalize|file))?$/);
  if (m) {
    const [, id, sub] = m;
    if (!sub && method === 'GET') return getDocument(env, id);
    if (!sub && method === 'PUT') return updateDocument(request, env, id);
    if (sub === 'finalize' && method === 'POST') return finalizeDocument(env, id);
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

async function updateDocument(request, env, id) {
  const body = await readJson(request);
  if (typeof (body && body.content) !== 'string') return json({ error: 'content required' }, 400);
  if (body.content.length > MAX_CONTENT) return json({ error: 'content too large' }, 413);

  // Optional optimistic-concurrency guard: the client sends back the
  // updated_at it last saw; a mismatch means another tab wrote first.
  const rev = typeof body.rev === 'string' && body.rev ? body.rev : null;
  const now = new Date().toISOString();
  const sql = rev
    ? `UPDATE documents SET content = ?, title = ?, updated_at = ? WHERE id = ? AND status = 'draft' AND updated_at = ?`
    : `UPDATE documents SET content = ?, title = ?, updated_at = ? WHERE id = ? AND status = 'draft'`;
  const binds = rev
    ? [body.content, deriveTitle(body.content), now, id, rev]
    : [body.content, deriveTitle(body.content), now, id];
  const result = await env.DB.prepare(sql).bind(...binds).run();

  if (result.meta.changes === 0) {
    const row = await env.DB.prepare('SELECT status FROM documents WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'not found' }, 404);
    if (row.status !== 'draft') return json({ error: 'not a draft', status: row.status }, 409);
    return json({ error: 'conflict', status: 'draft' }, 409);
  }
  return json({ id, status: 'draft', updated_at: now });
}

async function getDocument(env, id) {
  const row = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);
  return json(publicDoc(row, { content: true }));
}

async function listDocuments(env, url) {
  const allowed = new Set(['draft', 'processing', 'archived']);
  const statuses = (url.searchParams.get('status') || 'archived,processing')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => allowed.has(s));
  if (statuses.length === 0) return json({ documents: [] });

  const placeholders = statuses.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, title, status, category, tags, summary, created_at, updated_at, archived_at
       FROM documents
      WHERE status IN (${placeholders})
      ORDER BY COALESCE(archived_at, updated_at) DESC
      LIMIT 200`
  )
    .bind(...statuses)
    .all();

  return json({ documents: (results || []).map((r) => publicDoc(r)) });
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

async function handleReader(env, pathname) {
  const m = pathname.match(/^\/d\/([0-9a-fA-F-]{36})$/);
  if (!m) return htmlResponse(renderNotFoundPage(), 404);

  const row = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(m[1]).first();
  if (!row) return htmlResponse(renderNotFoundPage(), 404);
  return htmlResponse(renderDocumentPage(row));
}

// ------------------------------------------------------ Access control

// Optional single-key lock: `wrangler secret put WRITER_ACCESS_KEY`.
// Unlock once per browser at /unlock. Unset = open instance.
function requireAccess(request, env) {
  const key = env.WRITER_ACCESS_KEY;
  if (!key) return null;

  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)writer_key=([^;]+)/);
  if (m) {
    let given = null;
    try {
      given = decodeURIComponent(m[1]);
    } catch {
      given = null; // undecodable cookie = no cookie
    }
    if (given !== null && safeEqual(given, key)) return null;
  }

  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7), key)) return null;

  return json({ error: 'locked', hint: 'visit /unlock' }, 401);
}

async function handleUnlock(request, env, url) {
  const key = env.WRITER_ACCESS_KEY;
  if (!key) return redirect(url, '/');

  let given = url.searchParams.get('key') || '';
  if (!given && request.method === 'POST') {
    try {
      const form = await request.formData();
      given = String(form.get('key') || '');
    } catch {
      given = '';
    }
  }

  if (!given) {
    return new Response(renderUnlockPage(false), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  if (!safeEqual(given, key)) {
    return new Response(renderUnlockPage(true), {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const headers = new Headers({ Location: '/', 'Cache-Control': 'no-store' });
  headers.append(
    'Set-Cookie',
    `writer_key=${encodeURIComponent(key)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=15552000`
  );
  return new Response(null, { status: 302, headers });
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a));
  const bb = enc.encode(String(b));
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
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

function redirect(base, to) {
  return Response.redirect(new URL(to, base).toString(), 302);
}
