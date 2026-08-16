import { markdownFile, fileKey } from './agent.js';
import { createZip, buildArchiveEntryName } from './zip.js';

const MAX_EXPORT_FILES = 200;
const MAX_EXPORT_BYTES = 20 * 1024 * 1024;

export async function handleExportRequest(request, env) {
  if (!env.WRITER_ACCESS_KEY) return json({ error: 'export unavailable in demo' }, 403);
  if (request.method === 'HEAD') return new Response(null, { status: 204 });
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  const { results } = await env.DB.prepare(
    `SELECT id, title, content, formatted, category, tags, created_at, archived_at, updated_at
       FROM documents
      WHERE status = 'archived'
      ORDER BY archived_at DESC
      LIMIT ?`
  )
    .bind(MAX_EXPORT_FILES + 1)
    .all();

  const docs = results || [];
  if (docs.length > MAX_EXPORT_FILES) return json({ error: 'export too large' }, 413);

  const usedNames = new Set();
  const entries = [];
  let bytes = 0;
  for (const row of docs) {
    const data = await loadMarkdownBytes(env, row);
    bytes += data.length;
    if (bytes > MAX_EXPORT_BYTES) return json({ error: 'export too large' }, 413);
    entries.push({
      name: buildArchiveEntryName(row, usedNames),
      data,
      lastModified: row.archived_at || row.updated_at,
    });
  }

  const zip = createZip(entries);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `writer-archive-${stamp}.zip`;
  const body = zip.byteOffset === 0 && zip.byteLength === zip.buffer.byteLength
    ? zip.buffer
    : zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

async function loadMarkdownBytes(env, row) {
  if (env.FILES && row.archived_at) {
    try {
      const file = await env.FILES.get(fileKey(row));
      if (file) return new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      console.warn(`export: r2 read failed for ${row.id}`, err);
    }
  }
  const fallback = markdownFile({
    ...row,
    tags: safeTags(row.tags),
    formatted: row.formatted || row.content || '',
  });
  return new TextEncoder().encode(fallback);
}

function safeTags(raw) {
  try {
    const tags = JSON.parse(raw || '[]');
    return Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
