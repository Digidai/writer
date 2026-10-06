import { readSettings, mergeUserSettings, writeUserSettings, pickValid } from './settings.js';
import { json, readJson } from './http.js';

// Signed-in writers read and write their own preferences; everyone else
// sees the site defaults (and keeps any changes in their browser).
export async function getSettings(env, viewer) {
  const site = await readSettings(env);
  return json(mergeUserSettings(site, viewer && viewer.user ? viewer.user : null));
}

export async function updateSettings(request, env, viewer, { onSaved } = {}) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid body' }, 400);
  if (!viewer || !viewer.user) return json({ error: 'auth_required' }, 401);
  const next = await writeUserSettings(env, viewer.user.id, body);
  if (!next) return json({ error: 'auth_required' }, 401);
  if (onSaved) onSaved(Object.keys(pickValid(body)));
  return json(next);
}
