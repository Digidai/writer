// Archive plumbing: pipeline launch, the cron janitor, heuristic
// fallbacks and Markdown file storage. The agent itself lives in
// pipeline.js as a Cloudflare Workflow.

// Claim a document and launch its archiving workflow. The status guard
// makes this race-safe: whoever flips draft -> processing launches.
export async function launchPipeline(env, id, { reclaim = false } = {}) {
  const statuses = reclaim ? "('draft', 'processing')" : "('draft')";
  const claimed = await env.DB.prepare(
    `UPDATE documents SET status = 'processing', updated_at = ?
      WHERE id = ? AND status IN ${statuses}`
  )
    .bind(new Date().toISOString(), id)
    .run();
  if (claimed.meta.changes === 0) return false;

  await env.PIPELINE.create({ id: `${id}-${Date.now()}`, params: { docId: id } });
  return true;
}

// Cron janitor: drafts untouched for 15 minutes are considered finished,
// and 'processing' rows whose workflow died get relaunched — no document
// can stay stuck in 整理中 forever.
export async function sweepIdleDrafts(env) {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id FROM documents
      WHERE (status = 'draft' AND updated_at < ? AND length(trim(content)) >= 2)
         OR (status = 'processing' AND updated_at < ?)
      ORDER BY updated_at
      LIMIT 5`
  )
    .bind(cutoff, cutoff)
    .all();

  for (const row of results || []) {
    try {
      await launchPipeline(env, row.id, { reclaim: true });
    } catch (err) {
      console.error(`sweep: failed for ${row.id}`, err);
    }
  }
}

// ------------------------------------------------------- file storage

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

export async function storeFile(env, doc) {
  if (!env.FILES) return;
  const year = (doc.archived_at || '').slice(0, 4) || 'undated';
  await env.FILES.put(`documents/${year}/${doc.id}.md`, markdownFile(doc), {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
  });
}

// --------------------------------------------------------- heuristics

// Used when the agent fails outright — archiving degrades gracefully
// instead of losing or blocking user content.
export function heuristicMeta(content, existingTitle) {
  return {
    title: existingTitle || deriveTitle(content) || '未命名',
    category: '其他',
    tags: [],
    summary: content.trim().replace(/\s+/g, ' ').slice(0, 60),
  };
}

export function deriveTitle(content) {
  const line = String(content || '')
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s*/, '').trim())
    .find((l) => l.length > 0);
  return line ? clip(line, 48) : '';
}

export function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => clip(typeof t === 'string' ? t.trim() : '', 24))
    .filter(Boolean)
    .slice(0, 4);
}

export function clip(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n) : str;
}
