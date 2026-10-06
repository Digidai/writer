import { deleteDocumentVector, upsertDocumentVector } from './semantic.js';
import { ownerScope } from './auth.js';
import { fileKey } from './agent.js';

// Editing an archive entry: it becomes a draft again and comes back to
// the editor. Finishing it re-runs the agent, so the archive stays the
// agent's to organize.
export async function reopenDocument(env, id, viewer) {
  const scope = ownerScope(viewer);
  const row = await env.DB.prepare(`SELECT * FROM documents WHERE id = ? AND ${scope.sql}`)
    .bind(id, ...scope.binds)
    .first();
  if (!row) return json({ error: 'not found' }, 404);
  if (row.status === 'processing') return json({ error: 'processing', status: 'processing' }, 409);
  if (row.status === 'deleted') return json({ error: 'deleted', status: 'deleted' }, 409);

  // Edit what the reader saw: the agent's typeset version when there is one.
  const content = row.formatted || row.content || '';
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE documents SET status = 'draft', content = ?, updated_at = ?, archived_at = NULL
      WHERE id = ? AND status IN ('archived', 'draft') AND ${scope.sql}`
  )
    .bind(content, now, id, ...scope.binds)
    .run();
  if (result.meta.changes === 0) return json({ error: 'conflict' }, 409);
  if (row.status === 'archived') {
    await deleteDocumentVector(env, id);
    // No longer archived: its Markdown file would otherwise linger in R2
    // (and survive an erase, which only knows the current archived_at).
    if (env.FILES && row.archived_at) {
      try {
        await env.FILES.delete(fileKey(row));
      } catch (err) {
        console.error(`reopen: R2 removal failed for ${id}`, err);
      }
    }
  }

  return json({ id, status: 'draft', content, updated_at: now });
}

export async function restoreDocument(env, id, viewer) {
  const scope = ownerScope(viewer);
  const result = await env.DB.prepare(
    `UPDATE documents
        SET status = CASE WHEN archived_at IS NULL THEN 'draft' ELSE 'archived' END,
            deleted_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'deleted' AND ${scope.sql}`
  )
    .bind(new Date().toISOString(), id, ...scope.binds)
    .run();
  if (result.meta.changes === 0) return json({ error: 'not in trash' }, 404);

  const row = await env.DB.prepare('SELECT status FROM documents WHERE id = ?').bind(id).first();
  if (row && row.status === 'archived') {
    try {
      const archived = await env.DB.prepare(
        `SELECT id, title, summary, content, formatted, category, archived_at, user_id
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
