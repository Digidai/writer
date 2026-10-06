// Page views and product events for /admin, stored in D1.
//
// Nothing identifying is kept: no IP addresses, no tracking cookie, and
// page views are not tied to accounts. The visitor column is
// SHA-256(daily key, IP, user agent), where the daily key is
// HMAC(ANALYTICS_SECRET, day): it rotates every day and the secret never
// lives in D1, so a database export alone cannot reverse or link visits
// across days. Referrers keep only their host; document ids are dropped.
import { nowIso, sha256Hex, clientIp, readJson } from './http.js';
import { analyticsSalt } from './site-config.js';
import { enforceRateLimit } from './rate-limit.js';

// Events a browser may report. Everything else is recorded server-side.
const CLIENT_EVENTS = new Set(['pageview', 'completion_accept']);
const BOT_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python-requests|httpclient|go-http-client/i;
const UUID_RE = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function isBot(ua) {
  return !ua || BOT_RE.test(ua);
}

export function classifyDevice(ua) {
  const s = String(ua || '');
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(s)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|Windows Phone|Opera Mini/i.test(s)) return 'mobile';
  return 'desktop';
}

export function normalizePath(raw) {
  let path = String(raw || '/');
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    path = '/';
  }
  path = path.split(/[?#]/)[0] || '/';
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(UUID_RE, '/:id').replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path.slice(0, 80);
}

export function referrerHost(raw, ownHost) {
  if (!raw) return null;
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const own = String(ownHost || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
    if (!host || host === own) return null;
    return host.slice(0, 100);
  } catch {
    return null;
  }
}

export async function visitorHash(env, request, day) {
  // Without the secret (local dev, self-hosts that skipped it) fall back
  // to the per-instance salt in D1; still rotated per day.
  const secret = env.ANALYTICS_SECRET || (await analyticsSalt(env));
  const dayKey = await hmacHex(secret, day);
  const ua = request.headers.get('User-Agent') || '';
  return (await sha256Hex(`${dayKey}:${clientIp(request)}:${ua}`)).slice(0, 20);
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(message)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function recordEvent(env, {
  type, userId = null, path = null, referrer = null, country = null, device = null,
  visitor = null, meta = null, now = Date.now(),
} = {}) {
  if (!env || !env.DB || !type) return;
  try {
    const ts = nowIso(now);
    await env.DB.prepare(
      `INSERT INTO events (ts, day, type, path, referrer, country, device, visitor, user_id, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        ts, ts.slice(0, 10), String(type).slice(0, 40), path, referrer, country, device, visitor, userId,
        meta ? JSON.stringify(meta).slice(0, 500) : null
      )
      .run();
  } catch (err) {
    console.warn('event not recorded', type, err && err.message);
  }
}

// Fire and forget: analytics must never slow down or break a request.
export function track(env, ctx, event) {
  const pending = recordEvent(env, event);
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(pending);
  return pending;
}

// POST /api/signal: page views and suggestion accepts from the browser.
export async function handleSignal(request, env, ctx, viewer) {
  const limited = await enforceRateLimit(request, { bucket: 'signal', limit: 600, windowMs: 60 * 60 * 1000 });
  if (limited) return new Response(null, { status: 204 });

  const body = await readJson(request);
  const type = body && typeof body.type === 'string' ? body.type : '';
  if (!CLIENT_EVENTS.has(type)) return new Response(null, { status: 204 });

  const ua = request.headers.get('User-Agent') || '';
  if (isBot(ua)) return new Response(null, { status: 204 });

  const path = normalizePath(body.path);
  if (path.startsWith('/admin')) return new Response(null, { status: 204 });

  const url = new URL(request.url);
  const day = nowIso().slice(0, 10);
  track(env, ctx, {
    type,
    // A suggestion accept is a product event and may count toward an
    // account; a page view never is, so browsing builds no history.
    userId: type === 'pageview' || !(viewer && viewer.user) ? null : viewer.user.id,
    path,
    referrer: type === 'pageview' ? referrerHost(body.referrer, url.host) : null,
    country: (request.cf && request.cf.country) || null,
    device: classifyDevice(ua),
    visitor: await visitorHash(env, request, day),
  });
  return new Response(null, { status: 204 });
}
