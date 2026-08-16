import { deleteDocumentVector, upsertDocumentVector } from './semantic.js';

// Editing an archive entry: it becomes a draft again and comes back to
// the editor. Finishing it re-runs the agent, so the archive stays the
// agent's to organize.
export async function reopenDocument(env, id) {
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
  if (row.status === 'archived') await deleteDocumentVector(env, id);

  return json({ id, status: 'draft', content, updated_at: now });
}

export async function restoreDocument(env, id) {
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
  if (row && row.status === 'archived') {
    try {
      const archived = await env.DB.prepare(
        `SELECT id, title, summary, content, formatted, category, archived_at
           FROM documents
          WHERE id = ? AND status = 'archived'`
      )
        .bind(id)
        .first();
      if (archived) await upsertDocumentVector(env, archived);
    } catch (err) {
      console.error(`restore: vector upsert failed for ${id}`, err);
    }
  }
  return json({ id, status: row ? row.status : 'archived' });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
