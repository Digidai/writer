import { writeSettings } from './settings.js';

// Public demo mode leaves writing open but keeps instance settings read-only.
// A configured access key switches this back to writable private mode.
export async function updateSettings(request, env) {
  if (!env.WRITER_ACCESS_KEY) return json({ error: 'settings read-only in demo' }, 403);

  const body = await readJson(request);
  if (!body || typeof body !== 'object') return json({ error: 'invalid body' }, 400);
  return json(await writeSettings(env, body));
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
