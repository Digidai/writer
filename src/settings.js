// Instance settings: one JSON row in D1, read by the editor, the cron
// janitor and the archiving agent. Unknown or malformed values always
// fall back to the default, so a bad write can never brick the app.

export const DEFAULTS = {
  fontSize: 'standard',      // small | standard | large
  theme: 'system',           // system | light | dark
  completion: true,          // inline AI suggestions on/off
  completionDelay: 700,      // ms of stillness before suggesting
  idleArchiveMinutes: 5,     // 0 disables idle archiving (manual only)
  agentFormatting: true,     // let the agent re-typeset the text
};

const SCHEMA = {
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

export async function readSettings(env) {
  try {
    const row = await env.DB.prepare('SELECT data FROM settings WHERE id = 1').first();
    return normalize(row ? JSON.parse(row.data) : null);
  } catch {
    return { ...DEFAULTS };
  }
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
