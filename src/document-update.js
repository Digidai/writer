import { deriveTitle } from './agent.js';
import { ownerScope } from './auth.js';

// PUT /api/documents/:id with optimistic concurrency. `rev` is mandatory:
// it prevents silent last-write-wins when multiple tabs race. Only the
// document's owner (account or anonymous browser) can write it.
export async function updateDocument(request, env, id, { maxContent = 200_000, anonMaxContent = maxContent, viewer, onSaved } = {}) {
  const body = await readJson(request);
  if (typeof (body && body.content) !== 'string') return json({ error: 'content required' }, 400);
  const signedIn = Boolean(viewer && viewer.user);
  const limit = signedIn ? maxContent : Math.min(maxContent, anonMaxContent);
  if (body.content.length > limit) return json({ error: 'content too large', signIn: !signedIn }, 413);

  const rev = typeof body.rev === 'string' ? body.rev.trim() : '';
  if (!rev) return json({ error: 'rev required' }, 400);

  const scope = ownerScope(viewer);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE documents SET content = ?, title = ?, updated_at = ?
      WHERE id = ? AND status = 'draft' AND updated_at = ? AND ${scope.sql}`
  )
    .bind(body.content, deriveTitle(body.content), now, id, rev, ...scope.binds)
    .run();

  if (result.meta.changes === 0) {
    const row = await env.DB.prepare(`SELECT status FROM documents WHERE id = ? AND ${scope.sql}`)
      .bind(id, ...scope.binds)
      .first();
    if (!row) return json({ error: 'not found' }, 404);
    if (row.status !== 'draft') return json({ error: 'not a draft', status: row.status }, 409);
    return json({ error: 'conflict', status: 'draft' }, 409);
  }
  if (onSaved) onSaved({ id, chars: body.content.length });
  return json({ id, status: 'draft', updated_at: now });
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
