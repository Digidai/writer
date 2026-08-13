// Writer — a quiet, input-focused writing surface on the Cloudflare stack.
// Routing: static assets serve the editor (/) and archive (/archive);
// this Worker handles the API, the reading view (/d/:id) and the cron sweep.
import { processDocument, sweepIdleDrafts, deriveTitle, markdownFile } from './agent.js';
import { complete } from './ai.js';
import { renderDocumentPage, renderNotFoundPage } from './html.js';

const MAX_CONTENT = 200_000;
const MAX_CONTEXT = 4_000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/unlock') return handleUnlock(env, url);

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
  if (path === '/api/complete' && method === 'POST') return handleComplete(request, env);

  const m = path.match(/^\/api\/documents\/([0-9a-fA-F-]{36})(?:\/(finalize|file))?$/);
  if (m) {
    const [, id, sub] = m;
    if (!sub && method === 'GET') return getDocument(env, id);
    if (!sub && method === 'PUT') return updateDocument(request, env, id);
    if (sub === 'finalize' && method === 'POST') return finalizeDocument(env, ctx, id);
    if (sub === 'file' && method === 'GET') return downloadFile(env, id);
  }

  return json({ error: 'not found' }, 404);
}

async function createDocument(request, env) {
  const body = await readJson(request);
  const content = typeof body?.content === 'string' ? body.content : '';
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
  if (typeof body?.content !== 'string') return json({ error: 'content required' }, 400);
  if (body.content.length > MAX_CONTENT) return json({ error: 'content too large' }, 413);

  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE documents SET content = ?, title = ?, updated_at = ? WHERE id = ? AND status = 'draft'`
  )
    .bind(body.content, deriveTitle(body.content), now, id)
    .run();

  if (result.meta.changes === 0) {
    const row = await env.DB.prepare('SELECT status FROM documents WHERE id = ?').bind(id).first();
    return row ? json({ error: 'not a draft', status: row.status }, 409) : json({ error: 'not found' }, 404);
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

async function finalizeDocument(env, ctx, id) {
  const row = await env.DB.prepare('SELECT id, status, content FROM documents WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);
  if (row.status === 'processing') return json({ id, status: 'processing' }, 202);
  if (row.status === 'archived') return json({ id, status: 'archived' });

  if (!row.content || row.content.trim().length < 2) {
    await env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(id).run();
    return json({ id, status: 'discarded' });
  }

  await env.DB.prepare(`UPDATE documents SET status = 'processing', updated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), id)
    .run();
  ctx.waitUntil(processDocument(env, id));
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
  const context = typeof body?.context === 'string' ? body.context.slice(-MAX_CONTEXT) : '';
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
// Visit /unlock?key=... once per browser. Unset = open instance.
function requireAccess(request, env) {
  const key = env.WRITER_ACCESS_KEY;
  if (!key) return null;

  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)writer_key=([^;]+)/);
  if (m && safeEqual(decodeURIComponent(m[1]), key)) return null;

  const auth = request.headers.get('Authorization') || '';
  if (auth === `Bearer ${key}`) return null;

  return json({ error: 'locked', hint: 'visit /unlock?key=...' }, 401);
}

function handleUnlock(env, url) {
  const key = env.WRITER_ACCESS_KEY;
  if (!key) return redirect(url, '/');
  const given = url.searchParams.get('key') || '';
  if (!safeEqual(given, key)) return json({ error: 'invalid key' }, 403);

  const headers = new Headers({ Location: '/' });
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
