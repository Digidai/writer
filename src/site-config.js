// Instance configuration owned by the admin, stored as key/value rows.
import { randomToken } from './http.js';

export const REGISTRATION_OPEN = 'open';
export const REGISTRATION_CLOSED = 'closed';

export async function getConfig(env, key, fallback = null) {
  try {
    const row = await env.DB.prepare('SELECT value FROM site_config WHERE key = ?').bind(key).first();
    return row ? row.value : fallback;
  } catch {
    return fallback;
  }
}

export async function setConfig(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO site_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(key, String(value))
    .run();
}

export async function registrationStatus(env) {
  const value = await getConfig(env, 'registration', REGISTRATION_OPEN);
  return value === REGISTRATION_CLOSED ? REGISTRATION_CLOSED : REGISTRATION_OPEN;
}

// A random per-instance salt for visitor hashes, created on first use.
let cachedSalt = null;
export async function analyticsSalt(env) {
  if (cachedSalt) return cachedSalt;
  let salt = await getConfig(env, 'analytics_salt');
  if (!salt) {
    salt = randomToken(24);
    try {
      await env.DB.prepare(
        `INSERT INTO site_config (key, value) VALUES ('analytics_salt', ?)
         ON CONFLICT(key) DO NOTHING`
      )
        .bind(salt)
        .run();
      salt = (await getConfig(env, 'analytics_salt')) || salt;
    } catch {
      /* fall back to the in-memory salt for this isolate */
    }
  }
  cachedSalt = salt;
  return salt;
}

// Tests reset module state between cases.
export function resetSiteConfigCache() {
  cachedSalt = null;
}

// Hourly counters that are bumped and read back in one statement, so
// concurrent requests can never both act on a stale value.
export function hourBucket(now = Date.now()) {
  return String(Math.floor(now / 3_600_000));
}

export function secondsToNextHour(now = Date.now()) {
  return Math.max(1, Math.ceil((3_600_000 - (now % 3_600_000)) / 1000));
}

export async function bumpCounter(env, key) {
  const row = await env.DB.prepare(
    `INSERT INTO site_config (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(site_config.value AS INTEGER) + 1
     RETURNING value`
  )
    .bind(key)
    .first();
  return Number(row && row.value) || 0;
}

// Counter keys are `<prefix><hour>[...]`; anything before this hour is done.
export async function pruneCounters(env, now = Date.now()) {
  const hour = hourBucket(now);
  for (const prefix of ['admin_try:', 'auth_send:', 'anon_create:']) {
    await env.DB.prepare('DELETE FROM site_config WHERE key LIKE ? AND key < ?')
      .bind(`${prefix}%`, `${prefix}${hour}`)
      .run();
  }
}
