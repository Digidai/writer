// Settings come in two layers: site defaults (one JSON row, set from
// /admin) and each user's own overrides (users.settings, only the keys
// they changed). Unknown or malformed values always fall back to the
// default, so a bad write can never brick the app.

export const DEFAULTS = {
  language: 'auto',          // auto | zh | en
  fontSize: 'standard',      // small | standard | large
  theme: 'system',           // system | light | dark
  completion: true,          // inline AI suggestions on/off
  completionDelay: 700,      // ms of stillness before suggesting
  idleArchiveMinutes: 5,     // 0 disables idle archiving (manual only)
  agentFormatting: true,     // let the agent re-typeset the text
};

const SCHEMA = {
  language: (v) => (['auto', 'zh', 'en'].includes(v) ? v : null),
  fontSize: (v) => (['small', 'standard', 'large'].includes(v) ? v : null),
  theme: (v) => (['system', 'light', 'dark'].includes(v) ? v : null),
  completion: (v) => (typeof v === 'boolean' ? v : null),
  completionDelay: (v) => ([300, 700, 1500].includes(v) ? v : null),
  idleArchiveMinutes: (v) => ([0, 3, 5, 15, 30].includes(v) ? v : null),
  agentFormatting: (v) => (typeof v === 'boolean' ? v : null),
};

// Merge a candidate object over the defaults, dropping anything invalid.
export function normalize(input) {
  const out = { ...DEFAULTS };
  if (!input || typeof input !== 'object') return out;
  for (const [key, validate] of Object.entries(SCHEMA)) {
    if (!(key in input)) continue;
    const value = validate(input[key]);
    if (value !== null) out[key] = value;
  }
  return out;
}

// Only the valid keys present in `patch`, for storing a user's overrides.
export function pickValid(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const [key, validate] of Object.entries(SCHEMA)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const value = validate(patch[key]);
    if (value !== null) out[key] = value;
  }
  return out;
}

function parseObject(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// Site defaults.
export async function readSettings(env) {
  try {
    const row = await env.DB.prepare('SELECT data FROM settings WHERE id = 1').first();
    return normalize(row ? JSON.parse(row.data) : null);
  } catch {
    return { ...DEFAULTS };
  }
}

// What a given user sees: site defaults overlaid with their own choices.
// `user` may be a users row (with .settings) or null for anonymous.
export function mergeUserSettings(site, user) {
  if (!user) return normalize(site);
  return normalize({ ...site, ...pickValid(parseObject(user.settings)) });
}

export async function readUserSettings(env, userId) {
  const site = await readSettings(env);
  if (!userId) return site;
  try {
    const row = await env.DB.prepare('SELECT settings FROM users WHERE id = ?').bind(userId).first();
    return mergeUserSettings(site, row);
  } catch {
    return site;
  }
}

export async function writeUserSettings(env, userId, patch) {
  const row = await env.DB.prepare('SELECT settings FROM users WHERE id = ?').bind(userId).first();
  if (!row) return null;
  const next = { ...pickValid(parseObject(row.settings)), ...pickValid(patch) };
  await env.DB.prepare('UPDATE users SET settings = ? WHERE id = ?')
    .bind(JSON.stringify(next), userId)
    .run();
  return mergeUserSettings(await readSettings(env), { settings: next });
}

export async function writeSettings(env, patch) {
  const current = await readSettings(env);
  const next = normalize({ ...current, ...patch });
  await env.DB.prepare(
    `INSERT INTO settings (id, data) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data`
  )
    .bind(JSON.stringify(next))
    .run();
  return next;
}
