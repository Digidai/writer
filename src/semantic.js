export const SEMANTIC_EMBED_MODEL = '@cf/baai/bge-m3';
const BACKFILL_BATCH_SIZE = 10;

export function semanticFeatureEnabled(env) {
  return Boolean(env && env.WRITER_ACCESS_KEY && env.ARCHIVE_INDEX && env.AI);
}

export function buildSemanticSource(doc) {
  const title = String(doc && doc.title ? doc.title : '').trim();
  const summary = String(doc && doc.summary ? doc.summary : '').trim();
  const body = String(doc && (doc.formatted || doc.content) ? (doc.formatted || doc.content) : '').trim();
  return [title, summary, body].filter(Boolean).join('\n\n').slice(0, 12000);
}

export function firstEmbeddingVector(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload.data,
    payload.result && payload.result.data,
    payload.embeddings,
    payload.result && payload.result.embeddings,
  ];
  for (const list of candidates) {
    const vector = takeVector(list);
    if (vector) return vector;
  }
  return null;
}

export async function searchSemanticIds(env, q, { limit = 50 } = {}) {
  if (!semanticFeatureEnabled(env)) return null;
  const vector = await embedText(env, q);
  if (!vector) return null;

  const topK = Math.max(1, Math.min(limit, 100));
  let result;
  try {
    result = await env.ARCHIVE_INDEX.query(vector, { topK });
  } catch {
    try {
      result = await env.ARCHIVE_INDEX.query({ vector, topK });
    } catch (err) {
      console.warn('semantic query failed', err);
      return null;
    }
  }

  const matches = Array.isArray(result && result.matches)
    ? result.matches
    : Array.isArray(result && result.result && result.result.matches)
      ? result.result.matches
      : [];
  const ids = [];
  for (const match of matches) {
    if (match && typeof match.id === 'string') ids.push(match.id);
  }
  return { ids };
}

export async function upsertDocumentVector(env, doc) {
  if (!semanticFeatureEnabled(env)) return false;
  const source = buildSemanticSource(doc);
  if (!source) return false;
  const vector = await embedText(env, source);
  if (!vector) return false;

  try {
    await env.ARCHIVE_INDEX.upsert([
      {
        id: String(doc.id),
        values: vector,
        metadata: {
          title: String(doc.title || '').slice(0, 120),
          category: String(doc.category || '').slice(0, 60),
          archived_at: String(doc.archived_at || ''),
        },
      },
    ]);
    return true;
  } catch (err) {
    console.warn(`vector upsert failed for ${doc.id}`, err);
    return false;
  }
}

export async function deleteDocumentVector(env, id) {
  if (!semanticFeatureEnabled(env) || typeof id !== 'string') return false;
  try {
    if (typeof env.ARCHIVE_INDEX.deleteByIds === 'function') {
      await env.ARCHIVE_INDEX.deleteByIds([id]);
      return true;
    }
    if (typeof env.ARCHIVE_INDEX.delete === 'function') {
      await env.ARCHIVE_INDEX.delete([id]);
      return true;
    }
    return false;
  } catch (err) {
    console.warn(`vector delete failed for ${id}`, err);
    return false;
  }
}

export async function backfillArchiveVectors(env, { limit = BACKFILL_BATCH_SIZE } = {}) {
  if (!semanticFeatureEnabled(env)) return { indexed: 0, skipped: 0, remaining: 0 };

  const safeLimit = Math.max(1, Math.min(Number(limit) || BACKFILL_BATCH_SIZE, 50));
  const docs = await loadBackfillBatch(env, safeLimit);
  if (docs.length === 0) return { indexed: 0, skipped: 0, remaining: 0 };

  let indexed = 0;
  let skipped = 0;
  for (const doc of docs) {
    const ok = await upsertDocumentVector(env, doc);
    if (ok) indexed += 1;
    else skipped += 1;
    await markBackfillAttempt(env, doc.id, { indexed: ok });
  }

  const remaining = await countBackfillRemaining(env);
  if (remaining === null) return { indexed, skipped };
  return { indexed, skipped, remaining };
}

async function embedText(env, text) {
  const payload = String(text || '').trim();
  if (!payload) return null;
  try {
    const out = await env.AI.run(SEMANTIC_EMBED_MODEL, { text: [payload] });
    return firstEmbeddingVector(out);
  } catch (err) {
    console.warn('embedding failed', err);
    return null;
  }
}

function takeVector(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const first = list[0];
  if (Array.isArray(first)) return normalizeVector(first);
  if (first && Array.isArray(first.embedding)) return normalizeVector(first.embedding);
  return null;
}

function normalizeVector(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  const out = [];
  for (const value of vector) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out.length > 0 ? out : null;
}

async function loadBackfillBatch(env, limit) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, title, summary, content, formatted, category, archived_at
         FROM documents
        WHERE status = 'archived'
          AND (vector_indexed_at IS NULL OR vector_indexed_at < COALESCE(archived_at, ''))
        ORDER BY
          CASE WHEN vector_indexed_at IS NULL THEN 0 ELSE 1 END,
          CASE WHEN vector_index_attempted_at IS NULL THEN 0 ELSE 1 END,
          COALESCE(vector_index_attempted_at, archived_at, updated_at, created_at) ASC
        LIMIT ?`
    )
      .bind(limit)
      .all();
    return results || [];
  } catch {
    const { results } = await env.DB.prepare(
      `SELECT id, title, summary, content, formatted, category, archived_at
         FROM documents
        WHERE status = 'archived'
        ORDER BY COALESCE(archived_at, updated_at, created_at) ASC
        LIMIT ?`
    )
      .bind(limit)
      .all();
    return results || [];
  }
}

async function markBackfillAttempt(env, id, { indexed }) {
  const now = new Date().toISOString();
  try {
    if (indexed) {
      await env.DB.prepare(
        `UPDATE documents
            SET vector_indexed_at = ?, vector_index_attempted_at = ?
          WHERE id = ?`
      )
        .bind(now, now, id)
        .run();
      return;
    }
    await env.DB.prepare(
      `UPDATE documents
          SET vector_index_attempted_at = ?
        WHERE id = ?`
    )
      .bind(now, id)
      .run();
  } catch {
    // Legacy DBs may not have tracking columns yet; skip metadata update.
  }
}

async function countBackfillRemaining(env) {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS remaining
         FROM documents
        WHERE status = 'archived'
          AND (vector_indexed_at IS NULL OR vector_indexed_at < COALESCE(archived_at, ''))`
    ).first();
    return asCount(row && row.remaining);
  } catch {
    return null;
  }
}

function asCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
