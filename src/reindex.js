import { backfillArchiveVectors } from './semantic.js';

export async function handleReindexRequest(env) {
  if (!env.WRITER_ACCESS_KEY) return json({ error: 'reindex unavailable in demo' }, 403);
  return json(await backfillArchiveVectors(env, { limit: 10 }));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
