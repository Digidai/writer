import { heuristicMeta, clip, sanitizeTags } from './agent.js';

// Merge the agent's verdict with heuristic fallbacks — user content is
// never lost or blocked on the model.
export async function persistArchive(env, doc, finish, trace, settings = {}) {
  const fallback = heuristicMeta(doc.content, doc.title);
  const category = clip(str(finish && finish.category) || fallback.category, 12) || '其他';
  const keepOriginal = settings.agentFormatting === false;
  const final = {
    id: doc.id,
    title: clip(str(finish && finish.title) || fallback.title, 60),
    category,
    tags: sanitizeTags(finish && finish.tags),
    summary: clip(str(finish && finish.summary) || fallback.summary, 200),
    formatted: keepOriginal ? doc.content : (str(finish && finish.formatted) || doc.content),
    created_at: doc.created_at,
  };

  // The agent must lay text out, not shorten it. Compare with whitespace
  // collapsed: if real characters went missing, keep the original.
  const weight = (s) => s.replace(/\s+/g, '').length;
  if (weight(final.formatted) < weight(doc.content) * 0.9) final.formatted = doc.content;

  const now = new Date().toISOString();
  final.archived_at = now;

  // Guard against stale workflows: only the active processing row may
  // transition to archived. Reopened/deleted/erased documents must win.
  const updated = await env.DB.prepare(
    `UPDATE documents
       SET title = ?, category = ?, tags = ?, summary = ?, formatted = ?,
           agent_trace = ?, status = 'archived', archived_at = ?, updated_at = ?
     WHERE id = ? AND status = 'processing'`
  )
    .bind(
      final.title, final.category, JSON.stringify(final.tags), final.summary,
      final.formatted, JSON.stringify(trace), now, now, doc.id
    )
    .run();

  if ((updated.meta && updated.meta.changes) === 0) {
    trace.push({ turn: 'persist', skipped: true, reason: 'document not processing' });
    return { skipped: true, reason: 'not-processing' };
  }
  return { skipped: false, final };
}

function str(v) {
  return typeof v === 'string' ? v : '';
}
