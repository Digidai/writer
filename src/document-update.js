import { deriveTitle } from './agent.js';

// PUT /api/documents/:id with optimistic concurrency. `rev` is mandatory:
// it prevents silent last-write-wins when multiple tabs race.
export async function updateDocument(request, env, id, { maxContent = 200_000 } = {}) {
  const body = await readJson(request);
  if (typeof (body && body.content) !== 'string') return json({ error: 'content required' }, 400);
  if (body.content.length > maxContent) return json({ error: 'content too large' }, 413);

  const rev = typeof body.rev === 'string' ? body.rev.trim() : '';
  if (!rev) return json({ error: 'rev required' }, 400);

  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE documents SET content = ?, title = ?, updated_at = ? WHERE id = ? AND status = 'draft' AND updated_at = ?`
  )
    .bind(body.content, deriveTitle(body.content), now, id, rev)
    .run();

  if (result.meta.changes === 0) {
    const row = await env.DB.prepare('SELECT status FROM documents WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'not found' }, 404);
    if (row.status !== 'draft') return json({ error: 'not a draft', status: row.status }, 409);
    return json({ error: 'conflict', status: 'draft' }, 409);
  }
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
