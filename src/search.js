export function parseSearchMode(raw) {
  return raw === 'semantic' ? 'semantic' : 'keyword';
}

export function escapeLike(q) {
  return String(q || '').replace(/[%_\\]/g, (c) => `\\${c}`);
}

// Every search is scoped: `scope` is an ownerScope() fragment. Without one
// nothing matches, so a forgotten argument fails closed.
const NOTHING = { sql: '0', binds: [] };
export const EVERYTHING = { sql: '1', binds: [] };

export async function keywordSearchRows(env, q, { limit = 50, scope = NOTHING } = {}) {
  const like = `%${escapeLike(q)}%`;
  const { results } = await env.DB.prepare(
    `SELECT id, title, status, category, tags, summary, created_at, updated_at, archived_at
       FROM documents
      WHERE status = 'archived' AND ${scope.sql}
        AND (title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'
             OR tags LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
      ORDER BY archived_at DESC
      LIMIT ?`
  )
    .bind(...scope.binds, like, like, like, like, Math.max(1, Math.min(limit, 100)))
    .all();

  return results || [];
}

export async function hydrateArchivedRowsByIds(env, ids, { limit = 50, scope = NOTHING } = {}) {
  const orderedIds = uniqueIds(ids).slice(0, 100);
  if (orderedIds.length === 0) return [];

  const placeholders = orderedIds.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, title, status, category, tags, summary, created_at, updated_at, archived_at
       FROM documents
      WHERE status = 'archived' AND id IN (${placeholders}) AND ${scope.sql}`
  )
    .bind(...orderedIds, ...scope.binds)
    .all();

  const byId = new Map((results || []).map((row) => [row.id, row]));
  const out = [];
  for (const id of orderedIds) {
    if (byId.has(id)) out.push(byId.get(id));
  }
  return out.slice(0, Math.max(1, Math.min(limit, 100)));
}

function uniqueIds(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids || []) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
