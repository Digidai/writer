export const SEMANTIC_EMBED_MODEL = '@cf/baai/bge-m3';

export function semanticFeatureEnabled(env) {
  return Boolean(env && env.WRITER_ACCESS_KEY);
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
  if (!semanticFeatureEnabled(env) || !env.ARCHIVE_INDEX || !env.AI) return null;
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
  if (!semanticFeatureEnabled(env) || !env.ARCHIVE_INDEX || !env.AI) return false;
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
  if (!semanticFeatureEnabled(env) || !env.ARCHIVE_INDEX || typeof id !== 'string') return false;
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
