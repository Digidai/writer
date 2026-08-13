// The archiving agent: classify, parse, and lay out a finished document,
// then mirror it to R2 as a Markdown file. Failures degrade to sensible
// heuristics — user content is never lost or blocked on the model.
import { organize, CATEGORIES } from './ai.js';

export async function processDocument(env, id) {
  const row = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
  if (!row || row.status === 'archived') return;

  const content = String(row.content || '');
  let meta = null;
  try {
    meta = await organize(env, content);
  } catch (err) {
    console.error(`agent: organize failed for ${id}`, err);
  }

  const doc = {
    title: clip(asString(meta?.title) || row.title || deriveTitle(content) || '未命名', 60),
    category: CATEGORIES.includes(meta?.category) ? meta.category : '其他',
    tags: sanitizeTags(meta?.tags),
    summary: clip(asString(meta?.summary) || firstChars(content, 60), 200),
    formatted: asString(meta?.formatted) || content,
  };

  // The agent must lay text out, not shorten it. If the formatted version
  // lost a chunk of the original, keep the original.
  if (doc.formatted.length < content.trim().length * 0.6) doc.formatted = content;

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE documents
       SET title = ?, category = ?, tags = ?, summary = ?, formatted = ?,
           status = 'archived', archived_at = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(doc.title, doc.category, JSON.stringify(doc.tags), doc.summary, doc.formatted, now, now, id)
    .run();

  try {
    await storeFile(env, { id, ...doc, created_at: row.created_at, archived_at: now });
  } catch (err) {
    console.error(`agent: R2 store failed for ${id}`, err);
  }
}

// Cron sweep: drafts untouched for 15 minutes are considered finished.
export async function sweepIdleDrafts(env) {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, content FROM documents WHERE status = 'draft' AND updated_at < ? LIMIT 5`
  )
    .bind(cutoff)
    .all();

  for (const row of results || []) {
    if (!row.content || row.content.trim().length < 2) continue;
    const claimed = await env.DB.prepare(
      `UPDATE documents SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'draft'`
    )
      .bind(new Date().toISOString(), row.id)
      .run();
    if (claimed.meta.changes > 0) await processDocument(env, row.id);
  }
}

export function markdownFile(doc) {
  const tags = (doc.tags || []).map((t) => JSON.stringify(t)).join(', ');
  return [
    '---',
    `title: ${JSON.stringify(doc.title || '')}`,
    `category: ${JSON.stringify(doc.category || '其他')}`,
    `tags: [${tags}]`,
    `created: ${doc.created_at || ''}`,
    `archived: ${doc.archived_at || ''}`,
    '---',
    '',
    doc.formatted || '',
    '',
  ].join('\n');
}

async function storeFile(env, doc) {
  if (!env.FILES) return;
  const year = (doc.archived_at || '').slice(0, 4) || 'undated';
  await env.FILES.put(`documents/${year}/${doc.id}.md`, markdownFile(doc), {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
  });
}

export function deriveTitle(content) {
  const line = String(content || '')
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s*/, '').trim())
    .find((l) => l.length > 0);
  return line ? clip(line, 48) : '';
}

function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => clip(asString(t).trim(), 24))
    .filter(Boolean)
    .slice(0, 4);
}

function asString(v) {
  return typeof v === 'string' ? v : '';
}

function clip(s, n) {
  return s.length > n ? s.slice(0, n) : s;
}

function firstChars(content, n) {
  return content.trim().replace(/\s+/g, ' ').slice(0, n);
}
