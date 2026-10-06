// Page views and product events for /admin, stored in D1.
//
// Nothing identifying is kept: no IP addresses, no tracking cookie, and
// page views are not tied to accounts. The visitor column is
// SHA-256(daily key, IP, user agent), where the daily key is
// HMAC(ANALYTICS_SECRET, day): it rotates every day and the secret never
// lives in D1, so a database export alone cannot reverse or link visits
// across days. Sessions are derived from that hash on the server (30 quiet
// minutes end one), so they end at midnight UTC as well. Referrers keep
// only their host; document ids are dropped from paths.
import { nowIso, sha256Hex, clientIp, readJson, randomToken } from './http.js';
import { analyticsSalt } from './site-config.js';
import { enforceRateLimit } from './rate-limit.js';

const SESSION_GAP_MS = 30 * 60 * 1000;
// A view can report back (engaged time, Web Vitals) for this long.
const VIEW_REPORT_MS = 12 * 60 * 60 * 1000;
// Events a browser may report. Everything else is recorded server-side.
const CLIENT_EVENTS = new Set([
  'pageview', 'engage', 'completion_shown', 'completion_accept', 'completion_dismiss', 'auth_prompt', 'client_error',
]);
const PROMPT_REASONS = new Set(['finish', 'signin', 'archive', 'settings', 'limit']);
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

// Families only, never versions: enough to see who to test for, too
// coarse to tell people apart. Order matters: most browsers also claim
// to be Chrome and Safari.
export function classifyBrowser(ua) {
  const s = String(ua || '');
  if (/MicroMessenger/i.test(s)) return 'wechat';
  if (/Edg(e|A|iOS)?\//.test(s)) return 'edge';
  if (/OPR\/|Opera/.test(s)) return 'opera';
  if (/SamsungBrowser/.test(s)) return 'samsung';
  if (/UCBrowser/.test(s)) return 'uc';
  if (/Quark\//.test(s)) return 'quark';
  if (/HuaweiBrowser/.test(s)) return 'huawei';
  if (/Firefox\/|FxiOS/.test(s)) return 'firefox';
  if (/Chrome\/|CriOS|Chromium/.test(s)) return 'chrome';
  if (/Safari\//.test(s)) return 'safari';
  return 'other';
}

export function classifyOs(ua) {
  const s = String(ua || '');
  if (/iPhone|iPad|iPod/.test(s)) return 'ios';
  if (/HarmonyOS|OpenHarmony/.test(s)) return 'harmonyos';
  if (/Android/.test(s)) return 'android';
  if (/CrOS/.test(s)) return 'chromeos';
  if (/Windows/.test(s)) return 'windows';
  if (/Mac OS X|Macintosh/.test(s)) return 'macos';
  if (/Linux/.test(s)) return 'linux';
  return 'other';
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

// Where a session came from. Campaign tags win over the referrer, except
// tags that only name a search engine, network or assistant (ChatGPT, for
// one, tags every link it hands out with utm_source=chatgpt.com).
const AI_HOSTS = /(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|bard\.google\.com|copilot\.microsoft\.com|kimi\.com|kimi\.moonshot\.cn|doubao\.com|deepseek\.com|poe\.com|you\.com|phind\.com|mistral\.ai|yuanbao\.tencent\.com|tongyi\.aliyun\.com|qianwen\.com|chatglm\.cn|metaso\.cn|grok\.com|meta\.ai)$/;
const EMAIL_HOSTS = /(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.yahoo\.com|mail\.qq\.com|exmail\.qq\.com|mail\.163\.com|mail\.126\.com|mail\.aliyun\.com|mail\.proton\.me)$/;
const SEARCH_HOSTS = /(^|\.)(google\.[a-z.]+|bing\.com|baidu\.com|duckduckgo\.com|yandex\.[a-z.]+|sogou\.com|so\.com|search\.yahoo\.com|yahoo\.co\.jp|naver\.com|ecosia\.org|search\.brave\.com|startpage\.com|sm\.cn|qwant\.com|seznam\.cz)$/;
const SOCIAL_HOSTS = /(^|\.)(t\.co|twitter\.com|x\.com|facebook\.com|fb\.com|instagram\.com|threads\.net|linkedin\.com|lnkd\.in|reddit\.com|news\.ycombinator\.com|weibo\.com|weibo\.cn|zhihu\.com|xiaohongshu\.com|xhslink\.com|douban\.com|v2ex\.com|bsky\.app|youtube\.com|youtu\.be|bilibili\.com|b23\.tv|t\.me|telegram\.org|discord\.com|okjike\.com|juejin\.cn|sspai\.com|producthunt\.com|mastodon\.social|tiktok\.com|douyin\.com|pinterest\.com|quora\.com)$/;

function hostChannel(host) {
  if (!host) return null;
  if (AI_HOSTS.test(host)) return 'ai';
  if (EMAIL_HOSTS.test(host)) return 'email';
  if (SEARCH_HOSTS.test(host)) return 'search';
  if (SOCIAL_HOSTS.test(host)) return 'social';
  return null;
}

export function channelFor(referrer, utm = {}) {
  if (utm.source || utm.medium || utm.campaign) {
    const medium = String(utm.medium || '');
    if (/^(e-?mail|newsletter)$/.test(medium)) return 'email';
    if (/^(social|social-media|sm)$/.test(medium)) return 'social';
    if (!utm.medium && !utm.campaign) {
      const named = hostChannel(String(utm.source || '').replace(/^www\./, ''));
      if (named) return named;
    }
    return 'campaign';
  }
  if (!referrer) return 'direct';
  return hostChannel(referrer) || 'referral';
}

function cleanTag(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ._:/@+-]/gu, '').slice(0, 60);
  return s || null;
}

export function readUtm(raw) {
  const utm = raw && typeof raw === 'object' ? raw : {};
  return { source: cleanTag(utm.source), medium: cleanTag(utm.medium), campaign: cleanTag(utm.campaign) };
}

export function viewportBucket(width) {
  const w = Number(width);
  if (!Number.isFinite(w) || w <= 0) return null;
  if (w < 480) return 'xs';
  if (w < 768) return 's';
  if (w < 1024) return 'm';
  if (w < 1440) return 'l';
  return 'xl';
}

function primaryLang(raw, header) {
  const pick = (s) => {
    const m = String(s || '').trim().toLowerCase().match(/^([a-z]{2,3})(?:[-_]|$)/);
    return m ? m[1] : null;
  };
  return pick(raw) || pick(String(header || '').split(',')[0]);
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

const VIEW_ID_RE = /^[0-9a-f]{16,32}$/;
function cleanViewId(raw) {
  return typeof raw === 'string' && VIEW_ID_RE.test(raw) ? raw : null;
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
  type, userId = null, docId = null, value = null, path = null, referrer = null, country = null, device = null,
  visitor = null, meta = null, now = Date.now(),
} = {}) {
  if (!env || !env.DB || !type) return;
  try {
    const ts = nowIso(now);
    const num = Number(value);
    await env.DB.prepare(
      `INSERT INTO events (ts, day, type, path, referrer, country, device, visitor, user_id, doc_id, value, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        ts, ts.slice(0, 10), String(type).slice(0, 40), path, referrer, country, device, visitor, userId,
        docId, value === null || value === undefined || !Number.isFinite(num) ? null : num,
        meta ? JSON.stringify(meta).slice(0, 500) : null
      )
      .run();
  } catch (err) {
    console.warn('event not recorded', type, err && err.message);
  }
}

// Fire and forget: analytics must never slow down or break a request.
// Given the request, an event also gets the daily visitor hash (so funnels
// can count people, not clicks), the country and the device class.
export function track(env, ctx, event) {
  const pending = (async () => {
    const { request, ...rest } = event || {};
    if (request) {
      if (rest.visitor === undefined) {
        rest.visitor = await visitorHash(env, request, nowIso(rest.now).slice(0, 10)).catch(() => null);
      }
      if (rest.country === undefined) rest.country = (request.cf && request.cf.country) || null;
      if (rest.device === undefined) rest.device = classifyDevice(request.headers.get('User-Agent'));
    }
    await recordEvent(env, rest);
  })();
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(pending);
  return pending;
}

// One row per document per day; every save bumps it.
export async function recordWriting(env, request, { docId, userId = null, chars = 0, now = Date.now() }) {
  if (!env || !env.DB || !docId) return;
  try {
    const day = nowIso(now).slice(0, 10);
    const visitor = userId ? null : await visitorHash(env, request, day);
    await env.DB.prepare(
      `INSERT INTO writing_days (day, doc_id, user_id, visitor, saves, chars) VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(day, doc_id) DO UPDATE SET
         saves = writing_days.saves + 1,
         chars = excluded.chars,
         user_id = COALESCE(excluded.user_id, writing_days.user_id),
         visitor = COALESCE(writing_days.visitor, excluded.visitor)`
    )
      .bind(day, docId, userId, visitor, Math.max(0, Math.floor(Number(chars) || 0)))
      .run();
  } catch (err) {
    console.warn('writing day not recorded', err && err.message);
  }
}

// POST /api/signal: what only the browser can see. Answers 204 at once;
// the work happens after the response.
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

  const work = (async () => {
    if (type === 'pageview') return recordPageview(env, request, body, path);
    if (type === 'engage') return recordEngagement(env, body);
    if (type === 'client_error') {
      const flood = await enforceRateLimit(request, { bucket: 'client-error', limit: 20, windowMs: 60 * 60 * 1000 });
      if (flood) return null;
    }
    return track(env, null, {
      type,
      request,
      path,
      userId: viewer && viewer.user ? viewer.user.id : null,
      meta: clientMeta(type, body),
    });
  })().catch((err) => console.warn('signal not recorded', type, err && err.message));
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
  else await work;
  return new Response(null, { status: 204 });
}

function clientMeta(type, body) {
  if (type === 'auth_prompt') {
    return { reason: PROMPT_REASONS.has(body.reason) ? body.reason : 'signin' };
  }
  if (type === 'client_error') {
    let source = '';
    try {
      source = body.source ? new URL(String(body.source)).pathname.slice(0, 80) : '';
    } catch {
      source = '';
    }
    return {
      message: String(body.message || '').replace(/https?:\/\/\S+/g, '[url]').slice(0, 160),
      source: normalizePath(source),
      line: clampInt(body.line, 0, 1e7),
      col: clampInt(body.col, 0, 1e7),
    };
  }
  return null;
}

// A page view either continues the visitor's session (seen within the last
// 30 minutes and not a fresh arrival from somewhere else) or starts one. A
// continuing view inherits where the session came from, so every row can
// be filtered by channel and campaign.
export async function recordPageview(env, request, body, path, now = Date.now()) {
  const ua = request.headers.get('User-Agent') || '';
  const day = nowIso(now).slice(0, 10);
  const visitor = await visitorHash(env, request, day);
  const referrer = referrerHost(body.referrer, new URL(request.url).host);
  const utm = readUtm(body.utm);
  const arrival = Boolean(referrer || utm.source || utm.medium || utm.campaign);

  const last = await env.DB.prepare(
    `SELECT session, ts, referrer, channel, utm_source, utm_medium, utm_campaign
       FROM pageviews WHERE visitor = ? ORDER BY id DESC LIMIT 1`
  ).bind(visitor).first();
  const recent = last && now - Date.parse(last.ts) < SESSION_GAP_MS;
  // A reload keeps document.referrer, so the same source again is not a new arrival.
  const sameSource = last && (last.referrer || null) === referrer && (last.utm_source || null) === utm.source
    && (last.utm_medium || null) === utm.medium && (last.utm_campaign || null) === utm.campaign;
  const continues = Boolean(recent && (!arrival || sameSource));

  const source = continues
    ? { referrer: last.referrer, channel: last.channel, utm: { source: last.utm_source, medium: last.utm_medium, campaign: last.utm_campaign } }
    : { referrer, channel: channelFor(referrer, utm), utm };

  await env.DB.prepare(
    `INSERT INTO pageviews (ts, day, view_id, visitor, session, entry, path, referrer, channel, utm_source, utm_medium,
                            utm_campaign, country, device, browser, os, lang, viewport)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      nowIso(now), day, cleanViewId(body.view) || randomToken(8), visitor,
      continues ? last.session : randomToken(8), continues ? 0 : 1, path,
      source.referrer || null, source.channel || 'direct',
      source.utm.source || null, source.utm.medium || null, source.utm.campaign || null,
      (request.cf && request.cf.country) || null, classifyDevice(ua), classifyBrowser(ua), classifyOs(ua),
      primaryLang(body.lang, request.headers.get('Accept-Language')), viewportBucket(body.width),
    )
    .run();
}

// The view's own summary, sent whenever the page is hidden: the most
// engaged time and deepest scroll so far, and the latest Web Vitals.
export async function recordEngagement(env, body, now = Date.now()) {
  const viewId = cleanViewId(body.view);
  if (!viewId) return;
  const v = body.vitals && typeof body.vitals === 'object' ? body.vitals : {};
  await env.DB.prepare(
    `UPDATE pageviews SET
        engaged_ms = MAX(COALESCE(engaged_ms, 0), ?),
        scroll = MAX(COALESCE(scroll, 0), ?),
        ttfb = COALESCE(?, ttfb), fcp = COALESCE(?, fcp), lcp = COALESCE(?, lcp),
        inp = COALESCE(?, inp), cls = COALESCE(?, cls)
      WHERE view_id = ? AND ts > ?`
  )
    .bind(
      clampInt(body.ms, 0, 6 * 60 * 60 * 1000) || 0,
      clampInt(body.scroll, 0, 100) || 0,
      clampInt(v.ttfb, 0, 60_000), clampInt(v.fcp, 0, 120_000), clampInt(v.lcp, 0, 120_000),
      clampInt(v.inp, 0, 60_000), clampInt(v.cls, 0, 10_000),
      viewId, nowIso(now - VIEW_REPORT_MS),
    )
    .run();
}
