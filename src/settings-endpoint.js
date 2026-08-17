import { writeSettings } from './settings.js';

// Instance settings are writable in both public demo and private mode.
export async function updateSettings(request, env) {
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
