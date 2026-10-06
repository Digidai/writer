// Accounts: email sign-in codes, sessions, and who owns which document.
//
// Anyone can write without an account; their drafts belong to an anonymous
// browser id (an HttpOnly cookie). Signing in with an email code creates
// the account on first use and claims every draft that browser wrote.
import { json, readJson, readCookie, serializeCookie, randomToken, sha256Hex, safeEqual, nowIso } from './http.js';
import { enforceRateLimit } from './rate-limit.js';
import { sendLoginCode, EmailUnavailableError } from './email.js';
import { registrationStatus, REGISTRATION_CLOSED, bumpCounter, hourBucket } from './site-config.js';
import { track } from './analytics.js';
import { semanticFeatureEnabled } from './semantic.js';
import { resolveLang } from '../public/i18n.js';

// __Host- cookies: Secure, Path=/, no Domain, so no other subdomain can
// plant or read them.
export const SESSION_COOKIE = '__Host-writer_session';
export const ANON_COOKIE = '__Host-writer_anon';

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 90 * DAY_MS;
// Renew once a session has under 60 days left: at most one write a month.
const SESSION_RENEW_BELOW_MS = 60 * DAY_MS;
const SEEN_EVERY_MS = 60 * 60 * 1000;
const ANON_TTL_S = 365 * 24 * 60 * 60;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_RESEND_MS = 30 * 1000;
export const CODE_MAX_ATTEMPTS = 5;
// Guesses per address per hour, across every code sent in that hour.
export const EMAIL_GUESS_LIMIT = 10;
const GUESS_WINDOW_MS = 60 * 60 * 1000;
// Codes sent per hour across the whole instance (protects the mail quota).
const SEND_LIMIT_PER_HOUR = 300;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@.]{2,63}$/;
const ANON_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function normalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

// Six digits, uniform: reject draws from the incomplete top of the range.
export function generateCode() {
  const limit = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  let n;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= limit);
  return String(n % 1_000_000).padStart(6, '0');
}

export function codeHash(email, code) {
  return sha256Hex(`${email}:${code}`);
}

// ------------------------------------------------------------- viewer

// Who is making this request. `cookies` collects Set-Cookie values that
// the router appends to whatever response it returns.
export async function getViewer(request, env, now = Date.now()) {
  const viewer = { user: null, anonId: null, sessionHash: null, cookies: [] };

  const anon = readCookie(request, ANON_COOKIE);
  if (anon && ANON_RE.test(anon)) viewer.anonId = anon;

  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return viewer;

  try {
    const hash = await sha256Hex(token);
    const row = await env.DB.prepare(
      `SELECT u.id, u.email, u.status, u.settings, u.created_at, s.expires_at, s.last_seen_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`
    )
      .bind(hash, nowIso(now))
      .first();

    if (!row || row.status !== 'active') {
      viewer.cookies.push(serializeCookie(SESSION_COOKIE, '', { maxAge: 0 }));
      return viewer;
    }

    viewer.user = { id: row.id, email: row.email, settings: row.settings, created_at: row.created_at };
    viewer.sessionHash = hash;

    if (Date.parse(row.expires_at) - now < SESSION_RENEW_BELOW_MS) {
      await env.DB.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?')
        .bind(nowIso(now + SESSION_TTL_MS), nowIso(now), hash)
        .run();
      viewer.cookies.push(sessionCookie(token));
    } else if (!row.last_seen_at || now - Date.parse(row.last_seen_at) > SEEN_EVERY_MS) {
      await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
        .bind(nowIso(now), hash)
        .run();
    }
  } catch (err) {
    // A broken session lookup must not take the editor down: carry on anonymous.
    console.warn('session lookup failed', err && err.message);
  }
  return viewer;
}

// Anonymous writers get an id the first time they save something.
export function ensureAnonId(viewer) {
  if (viewer.user) return null;
  if (!viewer.anonId) {
    viewer.anonId = randomToken(18);
    viewer.cookies.push(serializeCookie(ANON_COOKIE, viewer.anonId, { maxAge: ANON_TTL_S }));
  }
  return viewer.anonId;
}

// SQL limiting a documents query to what the viewer owns. A viewer with
// neither a session nor an anonymous id owns nothing.
export function ownerScope(viewer, alias = '') {
  const p = alias ? `${alias}.` : '';
  if (viewer && viewer.user) return { sql: `${p}user_id = ?`, binds: [viewer.user.id] };
  if (viewer && viewer.anonId) return { sql: `(${p}user_id IS NULL AND ${p}anon_id = ?)`, binds: [viewer.anonId] };
  return { sql: '0', binds: [] };
}

export function authRequired() {
  return json({ error: 'auth_required' }, 401);
}

function sessionCookie(token) {
  return serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_MS / 1000 });
}

// ------------------------------------------------------------ routes

export async function handleAuthApi(request, env, ctx, path, viewer) {
  const method = request.method;
  if (path === '/api/auth/me' && method === 'GET') return me(env, viewer);
  if (path === '/api/auth/start' && method === 'POST') return startSignIn(request, env, ctx, viewer);
  if (path === '/api/auth/verify' && method === 'POST') return verifySignIn(request, env, ctx, viewer);
  if (path === '/api/auth/logout' && method === 'POST') return logout(env, ctx, viewer);
  return null;
}

async function me(env, viewer) {
  return json({
    user: viewer.user ? publicUser(viewer.user) : null,
    registration: await registrationStatus(env),
    features: {
      export: Boolean(viewer.user),
      semantic: Boolean(viewer.user) && semanticFeatureEnabled(env),
    },
  });
}

export async function startSignIn(request, env, ctx, viewer, now = Date.now()) {
  const body = await readJson(request);
  const email = normalizeEmail(body && body.email);
  if (!email) return json({ error: 'invalid_email' }, 400);
  const lang = resolveLang(body && body.lang, request.headers.get('Accept-Language'));

  const limited = await enforceRateLimit(request, { bucket: 'auth-start', limit: 10, windowMs: 60 * 60 * 1000 });
  if (limited) return limited;

  // Per-address throttle lives in D1 so it holds across every edge location.
  const pending = await env.DB.prepare('SELECT created_at FROM login_codes WHERE email = ?').bind(email).first();
  if (pending) {
    const wait = CODE_RESEND_MS - (now - Date.parse(pending.created_at));
    if (wait > 0) return json({ error: 'too_soon', retryAfter: Math.ceil(wait / 1000) }, 429);
  }

  const user = await env.DB.prepare('SELECT id, status FROM users WHERE email = ?').bind(email).first();
  if (!user && (await registrationStatus(env)) === REGISTRATION_CLOSED) {
    return json({ error: 'registration_closed' }, 403);
  }
  if (user && user.status !== 'active') return json({ error: 'account_disabled' }, 403);
  if (await guessesSpent(env, email, now)) return json({ error: 'too_many_attempts' }, 429);
  if ((await bumpCounter(env, `auth_send:${hourBucket(now)}`)) > SEND_LIMIT_PER_HOUR) {
    return json({ error: 'busy' }, 429);
  }

  const code = generateCode();
  await env.DB.prepare(
    `INSERT INTO login_codes (email, code_hash, created_at, expires_at, attempts)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at,
       expires_at = excluded.expires_at, attempts = 0`
  )
    .bind(email, await codeHash(email, code), nowIso(now), nowIso(now + CODE_TTL_MS))
    .run();

  try {
    await sendLoginCode(env, { to: email, code, lang });
  } catch (err) {
    await env.DB.prepare('DELETE FROM login_codes WHERE email = ?').bind(email).run();
    const reason = err instanceof EmailUnavailableError ? err.reason : 'unknown';
    console.error('sign-in email failed', reason);
    track(env, ctx, { type: 'auth_email_failed', meta: { reason: String(reason).slice(0, 60) } });
    return json({ error: 'email_unavailable' }, 503);
  }

  track(env, ctx, { type: 'auth_code_sent', userId: user ? user.id : null, meta: { newAccount: !user } });
  return json({ ok: true, email, expiresIn: CODE_TTL_MS / 1000, resendIn: CODE_RESEND_MS / 1000 });
}

export async function verifySignIn(request, env, ctx, viewer, now = Date.now()) {
  const body = await readJson(request);
  const email = normalizeEmail(body && body.email);
  const code = String((body && body.code) || '').replace(/\D/g, '');
  if (!email || code.length !== 6) return json({ error: 'invalid_code' }, 400);

  const limited = await enforceRateLimit(request, { bucket: 'auth-verify', limit: 30, windowMs: 15 * 60 * 1000 });
  if (limited) return limited;

  // Every attempt spends from the address's hourly budget first, in one
  // atomic statement, so fresh codes never buy fresh guesses.
  const spentOnAddress = await spendGuess(env, email, now);
  if (spentOnAddress > EMAIL_GUESS_LIMIT) return json({ error: 'too_many_attempts' }, 429);

  const row = await env.DB.prepare('SELECT * FROM login_codes WHERE email = ?').bind(email).first();
  if (!row) return json({ error: 'invalid_code' }, 400);
  if (Date.parse(row.expires_at) <= now) {
    await env.DB.prepare('DELETE FROM login_codes WHERE email = ?').bind(email).run();
    return json({ error: 'code_expired' }, 400);
  }

  // Spend an attempt before comparing, atomically, so parallel guesses
  // cannot exceed the budget.
  const spent = await env.DB.prepare(
    'UPDATE login_codes SET attempts = attempts + 1 WHERE email = ? AND attempts < ?'
  )
    .bind(email, CODE_MAX_ATTEMPTS)
    .run();
  // An exhausted code stays put (housekeeping expires it): deleting it
  // would also drop the resend throttle.
  if (spent.meta.changes === 0) return json({ error: 'too_many_attempts' }, 429);

  if (!safeEqual(await codeHash(email, code), row.code_hash)) {
    const left = Math.max(0, Math.min(
      CODE_MAX_ATTEMPTS - (Number(row.attempts) + 1),
      EMAIL_GUESS_LIMIT - spentOnAddress,
    ));
    return json({ error: 'invalid_code', attemptsLeft: left }, 400);
  }

  // Single use: whoever deletes the row owns the sign-in.
  const used = await env.DB.prepare('DELETE FROM login_codes WHERE email = ? AND code_hash = ?')
    .bind(email, row.code_hash)
    .run();
  if (used.meta.changes === 0) return json({ error: 'invalid_code' }, 400);
  await env.DB.prepare('DELETE FROM login_guesses WHERE email = ?').bind(email).run();

  let user = await env.DB.prepare('SELECT id, email, status, settings, created_at FROM users WHERE email = ?')
    .bind(email)
    .first();
  let created = false;
  if (!user) {
    if ((await registrationStatus(env)) === REGISTRATION_CLOSED) return json({ error: 'registration_closed' }, 403);
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(
        `INSERT INTO users (id, email, status, settings, created_at, last_login_at)
         VALUES (?, ?, 'active', '{}', ?, ?)`
      )
        .bind(id, email, nowIso(now), nowIso(now))
        .run();
      created = true;
    } catch {
      // Lost a race with another sign-in for the same address: use theirs.
    }
    user = await env.DB.prepare('SELECT id, email, status, settings, created_at FROM users WHERE email = ?')
      .bind(email)
      .first();
  } else {
    await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(nowIso(now), user.id).run();
  }
  if (!user || user.status !== 'active') return json({ error: 'account_disabled' }, 403);

  const token = randomToken(32);
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      await sha256Hex(token), user.id, nowIso(now), nowIso(now + SESSION_TTL_MS), nowIso(now),
      String(request.headers.get('User-Agent') || '').slice(0, 200)
    )
    .run();
  viewer.cookies.push(sessionCookie(token));

  // Everything this browser wrote before signing in now belongs to the account.
  let claimed = 0;
  if (viewer.anonId) {
    const result = await env.DB.prepare(
      'UPDATE documents SET user_id = ?, anon_id = NULL WHERE anon_id = ? AND user_id IS NULL'
    )
      .bind(user.id, viewer.anonId)
      .run();
    claimed = result.meta.changes;
  }

  viewer.user = { id: user.id, email: user.email, settings: user.settings, created_at: user.created_at };
  track(env, ctx, { type: created ? 'signup' : 'login', userId: user.id, meta: { claimed } });
  return json({ user: publicUser(user), created, claimed });
}

async function logout(env, ctx, viewer) {
  if (viewer.sessionHash) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(viewer.sessionHash).run();
  }
  if (viewer.user) track(env, ctx, { type: 'logout', userId: viewer.user.id });
  viewer.cookies.push(serializeCookie(SESSION_COOKIE, '', { maxAge: 0 }));
  // A fresh anonymous id, so the next person at this browser starts clean.
  viewer.cookies.push(serializeCookie(ANON_COOKIE, randomToken(18), { maxAge: ANON_TTL_S }));
  viewer.user = null;
  return json({ ok: true });
}

async function spendGuess(env, email, now) {
  const cutoff = nowIso(now - GUESS_WINDOW_MS);
  const row = await env.DB.prepare(
    `INSERT INTO login_guesses (email, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(email) DO UPDATE SET
       count = CASE WHEN login_guesses.window_start <= ? THEN 1 ELSE login_guesses.count + 1 END,
       window_start = CASE WHEN login_guesses.window_start <= ? THEN excluded.window_start ELSE login_guesses.window_start END
     RETURNING count`
  )
    .bind(email, nowIso(now), cutoff, cutoff)
    .first();
  return Number(row && row.count) || 0;
}

async function guessesSpent(env, email, now) {
  const row = await env.DB.prepare('SELECT count, window_start FROM login_guesses WHERE email = ?').bind(email).first();
  return Boolean(row && row.window_start > nowIso(now - GUESS_WINDOW_MS) && Number(row.count) >= EMAIL_GUESS_LIMIT);
}

function publicUser(user) {
  return { id: user.id, email: user.email, created_at: user.created_at || null };
}
