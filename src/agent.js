// Archive plumbing: pipeline launch, the cron janitor, heuristic
// fallbacks and Markdown file storage. The agent itself lives in
// pipeline.js as a Cloudflare Workflow.
import { readSettings, mergeUserSettings } from './settings.js';
import { pruneCounters } from './site-config.js';

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

// Cron janitor. Three jobs, each independent of the others:
// 1. 'processing' rows whose workflow died get relaunched, so no document
//    stays stuck in 整理中 forever (any owner).
// 2. Signed-in writers' drafts left alone past their own idle window are
//    filed (x3, so the editor's own idle timer gets the first chance).
//    Anonymous drafts are never filed: archiving needs an account.
// 3. Housekeeping: expired codes, sessions and counters, unclaimed
//    anonymous documents after 14 days, analytics events after 180 days.
const MAX_LAUNCHES = 5;
const STUCK_MS = 15 * 60 * 1000;
const MIN_IDLE_MS = 3 * 3 * 60 * 1000;
const ANON_DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const GUESS_TTL_MS = 24 * 60 * 60 * 1000;
const EVENT_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export async function sweepIdleDrafts(env, { now = Date.now() } = {}) {
  const launch = [];

  const stuck = await env.DB.prepare(
    `SELECT id FROM documents WHERE status = 'processing' AND updated_at < ?
      ORDER BY updated_at LIMIT ?`
  )
    .bind(new Date(now - STUCK_MS).toISOString(), MAX_LAUNCHES)
    .all();
  for (const row of stuck.results || []) launch.push(row.id);

  if (launch.length < MAX_LAUNCHES) {
    const site = await readSettings(env);
    const { results } = await env.DB.prepare(
      `SELECT d.id, d.updated_at, u.settings
         FROM documents d JOIN users u ON u.id = d.user_id
        WHERE d.status = 'draft' AND u.status = 'active'
          AND d.updated_at < ? AND length(trim(d.content)) >= 2
        ORDER BY d.updated_at
        LIMIT 25`
    )
      .bind(new Date(now - MIN_IDLE_MS).toISOString())
      .all();
    for (const row of results || []) {
      if (launch.length >= MAX_LAUNCHES) break;
      const minutes = mergeUserSettings(site, row).idleArchiveMinutes;
      if (!minutes) continue; // this writer archives by hand only
      if (Date.parse(row.updated_at) < now - minutes * 3 * 60 * 1000) launch.push(row.id);
    }
  }

  for (const id of launch) {
    try {
      await launchPipeline(env, id, { reclaim: true });
    } catch (err) {
      console.error(`sweep: failed for ${id}`, err);
    }
  }

  await housekeeping(env, now);
  return { launched: launch.length };
}

export async function housekeeping(env, now = Date.now()) {
  const iso = new Date(now).toISOString();
  const jobs = [
    ['DELETE FROM login_codes WHERE expires_at < ?', iso],
    ['DELETE FROM sessions WHERE expires_at < ?', iso],
    ['DELETE FROM admin_sessions WHERE expires_at < ?', iso],
    ['DELETE FROM login_guesses WHERE window_start < ?', new Date(now - GUESS_TTL_MS).toISOString()],
    [
      `DELETE FROM documents
        WHERE user_id IS NULL AND anon_id IS NOT NULL AND status IN ('draft', 'deleted') AND updated_at < ?`,
      new Date(now - ANON_DRAFT_TTL_MS).toISOString(),
    ],
    ['DELETE FROM events WHERE ts < ?', new Date(now - EVENT_TTL_MS).toISOString()],
  ];
  for (const [sql, cutoff] of jobs) {
    try {
      await env.DB.prepare(sql).bind(cutoff).run();
    } catch (err) {
      console.warn('housekeeping step failed', err && err.message);
    }
  }
  try {
    await pruneCounters(env, now);
  } catch (err) {
    console.warn('counter pruning failed', err && err.message);
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

export function fileKey(doc) {
  const year = (doc.archived_at || '').slice(0, 4) || 'undated';
  return `documents/${year}/${doc.id}.md`;
}

export async function storeFile(env, doc) {
  if (!env.FILES) return;
  await env.FILES.put(fileKey(doc), markdownFile(doc), {
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
