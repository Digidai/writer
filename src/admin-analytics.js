// The numbers behind /admin: traffic, product, model usage and the event
// log, each filterable by date range and by whatever the view offers.
// Every filter is a whitelisted column bound as a parameter.
import { nowIso } from './http.js';
import { escapeLike } from './search.js';
import { PRICES, PRICES_AS_OF, USD_PER_NEURON, FREE_NEURONS_PER_DAY, FEATURES, errorCode } from './ai-usage.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-fA-F-]{36}$/;
const MAX_SPAN_DAYS = 366;

export function dayString(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Strict: "2026-02-31" would otherwise roll over into March.
function validDay(s) {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(ms) && dayString(ms) === s;
}

// ?days=N (ending today) or ?from=YYYY-MM-DD&to=YYYY-MM-DD, at most a year.
export function parseRange(q, now = Date.now()) {
  const today = dayString(now);
  let until = validDay(q.get('to')) ? q.get('to') : today;
  let since;
  if (validDay(q.get('from'))) {
    since = q.get('from');
  } else {
    const n = Number(q.get('days'));
    const days = Number.isFinite(n) && n > 0 ? Math.min(MAX_SPAN_DAYS, Math.floor(n)) : 30;
    since = dayString(Date.parse(`${until}T00:00:00Z`) - (days - 1) * DAY_MS);
  }
  if (since > until) [since, until] = [until, since];
  const start = Date.parse(`${since}T00:00:00Z`);
  const end = Date.parse(`${until}T00:00:00Z`);
  let days = Math.round((end - start) / DAY_MS) + 1;
  if (days > MAX_SPAN_DAYS) {
    since = dayString(end - (MAX_SPAN_DAYS - 1) * DAY_MS);
    days = MAX_SPAN_DAYS;
  }
  return { since, until, days };
}

export function dayList({ since, days }) {
  const start = Date.parse(`${since}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => dayString(start + i * DAY_MS));
}

async function all(env, sql, binds = []) {
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results || [];
}

async function one(env, sql, binds = []) {
  return (await env.DB.prepare(sql).bind(...binds).first()) || {};
}

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

function rate(part, whole) {
  return whole ? part / whole : 0;
}

function usd(neurons) {
  return n(neurons) * USD_PER_NEURON;
}

function safeJson(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Builds `col = ?` clauses from whitelisted query parameters. An empty
// value means "not set" (unknown country, no referrer, ...).
function filterClauses(q, columns, alias = '') {
  const clauses = [];
  const binds = [];
  const applied = {};
  for (const [param, column] of Object.entries(columns)) {
    const raw = q.get(param);
    if (raw === null) continue;
    const value = raw.slice(0, 120);
    if (value === '') clauses.push(`${alias}${column} IS NULL`);
    else {
      clauses.push(`${alias}${column} = ?`);
      binds.push(value);
    }
    applied[param] = value;
  }
  return { clauses, binds, applied };
}

// --------------------------------------------------------------- traffic

const TRAFFIC_FILTERS = {
  path: 'path', channel: 'channel', referrer: 'referrer', country: 'country', device: 'device', browser: 'browser',
  os: 'os', lang: 'lang', viewport: 'viewport', utm_source: 'utm_source', utm_medium: 'utm_medium', utm_campaign: 'utm_campaign',
};

export function trafficWhere(range, q, alias = '') {
  const f = filterClauses(q, TRAFFIC_FILTERS, alias);
  const clauses = [`${alias}day >= ?`, `${alias}day <= ?`, ...f.clauses];
  const binds = [range.since, range.until, ...f.binds];
  const entry = q.get('entry');
  if (entry !== null) {
    clauses.push(`${alias}session IN (SELECT session FROM pageviews WHERE entry = 1 AND path = ? AND day >= ? AND day <= ?)`);
    binds.push(entry.slice(0, 120), range.since, range.until);
    f.applied.entry = entry.slice(0, 120);
  }
  return { sql: clauses.join(' AND '), binds, applied: f.applied };
}

// Web Vitals thresholds (good up to the first number, poor past the second).
export const VITALS = {
  lcp: [2500, 4000], inp: [200, 500], cls: [100, 250], fcp: [1800, 3000], ttfb: [800, 1800],
};

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

function vitalsSummary(rows) {
  const out = {};
  for (const key of Object.keys(VITALS)) {
    const values = rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined).map(Number).sort((a, b) => a - b);
    const p75 = percentile(values, 0.75);
    const [good, poor] = VITALS[key];
    out[key] = {
      p75,
      samples: values.length,
      rating: p75 === null ? null : p75 <= good ? 'good' : p75 <= poor ? 'needs' : 'poor',
      good: rate(values.filter((v) => v <= good).length, values.length),
      poor: rate(values.filter((v) => v > poor).length, values.length),
    };
  }
  return out;
}

export async function trafficReport(env, range, q) {
  const w = trafficWhere(range, q);
  const wp = trafficWhere(range, q, 'p.');
  const top = (column, { entryOnly = false, limit = 20 } = {}) => all(env,
    `SELECT COALESCE(${column}, '') AS key, COUNT(*) AS views, COUNT(DISTINCT day || ':' || visitor) AS visitors,
            COUNT(DISTINCT session) AS sessions, AVG(engaged_ms) AS engaged, AVG(scroll) AS scroll
       FROM pageviews WHERE ${w.sql}${entryOnly ? ' AND entry = 1' : ''}
      GROUP BY COALESCE(${column}, '') ORDER BY ${entryOnly ? 'sessions' : 'views'} DESC LIMIT ${limit}`,
    w.binds);

  const [
    totals, sessionStats, daily, paths, channels, referrers, sources, mediums, campaigns, countries, devices, browsers,
    oses, langs, viewports, entries, exits, hours, vitalRows,
  ] = await Promise.all([
    one(env, `SELECT COUNT(*) AS pageviews, COUNT(DISTINCT day || ':' || visitor) AS visitors,
                     COUNT(DISTINCT session) AS sessions, AVG(engaged_ms) AS engaged, AVG(scroll) AS scroll
                FROM pageviews WHERE ${w.sql}`, w.binds),
    one(env, `WITH s AS (
                SELECT session, COUNT(*) AS views, SUM(COALESCE(engaged_ms, 0)) AS engaged
                  FROM pageviews
                 WHERE day >= ? AND day <= ? AND session IN (SELECT DISTINCT session FROM pageviews WHERE ${w.sql})
                 GROUP BY session)
              SELECT COUNT(*) AS sessions, SUM(CASE WHEN views = 1 THEN 1 ELSE 0 END) AS bounces,
                     AVG(views) AS viewsPerSession, AVG(engaged) AS engagedPerSession FROM s`,
    [range.since, range.until, ...w.binds]),
    all(env, `SELECT day, COUNT(*) AS pageviews, COUNT(DISTINCT visitor) AS visitors, COUNT(DISTINCT session) AS sessions
                FROM pageviews WHERE ${w.sql} GROUP BY day`, w.binds),
    top('path'),
    top('channel'),
    top('referrer'),
    top('utm_source'),
    top('utm_medium'),
    top('utm_campaign'),
    top('country'),
    top('device'),
    top('browser'),
    top('os'),
    top('lang'),
    top('viewport'),
    all(env, `WITH s AS (SELECT session, COUNT(*) AS views FROM pageviews WHERE day >= ? AND day <= ? GROUP BY session)
              SELECT p.path AS key, COUNT(*) AS sessions, SUM(CASE WHEN s.views = 1 THEN 1 ELSE 0 END) AS bounces
                FROM pageviews p JOIN s ON s.session = p.session
               WHERE p.entry = 1 AND ${wp.sql}
               GROUP BY p.path ORDER BY sessions DESC LIMIT 20`, [range.since, range.until, ...wp.binds]),
    all(env, `SELECT p.path AS key, COUNT(*) AS exits FROM pageviews p
               WHERE ${wp.sql} AND p.id = (SELECT MAX(id) FROM pageviews p2 WHERE p2.session = p.session)
               GROUP BY p.path ORDER BY exits DESC LIMIT 20`, wp.binds),
    all(env, `SELECT CAST(substr(ts, 12, 2) AS INTEGER) AS hour, COUNT(*) AS views FROM pageviews WHERE ${w.sql} GROUP BY hour`, w.binds),
    all(env, `SELECT path, lcp, inp, cls, fcp, ttfb FROM pageviews
               WHERE ${w.sql} AND (lcp IS NOT NULL OR inp IS NOT NULL OR cls IS NOT NULL OR fcp IS NOT NULL OR ttfb IS NOT NULL)
               ORDER BY id DESC LIMIT 5000`, w.binds),
  ]);

  const rows = (list) => list.map((r) => ({
    key: r.key,
    views: n(r.views),
    visitors: n(r.visitors),
    sessions: n(r.sessions),
    engaged: r.engaged === null ? null : Math.round(n(r.engaged)),
    scroll: r.scroll === null ? null : Math.round(n(r.scroll)),
  }));

  const byDay = new Map(daily.map((r) => [r.day, r]));
  const byPath = new Map();
  for (const r of vitalRows) {
    if (!byPath.has(r.path)) byPath.set(r.path, []);
    byPath.get(r.path).push(r);
  }
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, views: 0 }));
  for (const r of hours) if (hourly[r.hour]) hourly[r.hour].views = n(r.views);

  const sessions = n(sessionStats.sessions);
  return {
    range,
    filters: w.applied,
    totals: {
      pageviews: n(totals.pageviews),
      visitors: n(totals.visitors),
      sessions,
      bounceRate: rate(n(sessionStats.bounces), sessions),
      viewsPerSession: n(sessionStats.viewsPerSession),
      engagedPerSession: Math.round(n(sessionStats.engagedPerSession)),
      engagedPerView: Math.round(n(totals.engaged)),
      scroll: totals.scroll === null ? null : Math.round(n(totals.scroll)),
    },
    daily: dayList(range).map((day) => ({
      day,
      pageviews: n(byDay.get(day) && byDay.get(day).pageviews),
      visitors: n(byDay.get(day) && byDay.get(day).visitors),
      sessions: n(byDay.get(day) && byDay.get(day).sessions),
    })),
    paths: rows(paths),
    channels: rows(channels),
    referrers: rows(referrers),
    utm: { source: rows(sources), medium: rows(mediums), campaign: rows(campaigns) },
    countries: rows(countries),
    devices: rows(devices),
    browsers: rows(browsers),
    os: rows(oses),
    langs: rows(langs),
    viewports: rows(viewports),
    entries: entries.map((r) => ({ key: r.key, sessions: n(r.sessions), bounceRate: rate(n(r.bounces), n(r.sessions)) })),
    exits: exits.map((r) => ({ key: r.key, exits: n(r.exits) })),
    hours: hourly,
    vitals: {
      overall: vitalsSummary(vitalRows),
      pages: [...byPath.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 10)
        .map(([path, list]) => ({ path, samples: list.length, ...vitalsSummary(list) })),
    },
  };
}

export async function pageviewLog(env, range, q) {
  const w = trafficWhere(range, q);
  const limit = Math.max(1, Math.min(200, Number(q.get('limit')) || 50));
  const before = Number(q.get('before')) || 0;
  const list = await all(env,
    `SELECT id, ts, path, entry, session, channel, referrer, utm_source, utm_medium, utm_campaign, country, device,
            browser, os, lang, viewport, engaged_ms, scroll, lcp, inp, cls, fcp, ttfb
       FROM pageviews WHERE ${w.sql}${before > 0 ? ' AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
    [...w.binds, ...(before > 0 ? [before] : []), limit]);
  return { pageviews: list, next: list.length === limit ? list[list.length - 1].id : null };
}

// --------------------------------------------------------------- product

// One person per step: an account when there is one, otherwise the daily
// visitor hash. Steps of the anonymous-first funnel, in order.
const PERSON = `COALESCE(user_id, day || ':' || visitor)`;

async function weeklyCohorts(env, until) {
  // Eight weeks ending with `until`'s week (weeks start on Monday, UTC).
  const end = Date.parse(`${until}T00:00:00Z`);
  const weekday = (new Date(end).getUTCDay() + 6) % 7;
  const lastMonday = end - weekday * DAY_MS;
  const firstMonday = lastMonday - 7 * 7 * DAY_MS;
  const weekOf = (ms) => Math.floor((ms - firstMonday) / (7 * DAY_MS));
  const [users, activity] = await Promise.all([
    all(env, 'SELECT id, created_at FROM users WHERE created_at >= ?', [nowIso(firstMonday)]),
    all(env, `SELECT DISTINCT user_id, day FROM writing_days WHERE user_id IS NOT NULL AND day >= ? AND day <= ?`,
      [dayString(firstMonday), until]),
  ]);
  const active = new Map();
  for (const row of activity) {
    const wk = weekOf(Date.parse(`${row.day}T00:00:00Z`));
    if (!active.has(row.user_id)) active.set(row.user_id, new Set());
    active.get(row.user_id).add(wk);
  }
  const cohorts = Array.from({ length: 8 }, (_, i) => ({
    week: dayString(firstMonday + i * 7 * DAY_MS),
    size: 0,
    retained: Array(8 - i).fill(0),
  }));
  for (const u of users) {
    const wk = weekOf(Date.parse(u.created_at));
    if (wk < 0 || wk > 7) continue;
    const c = cohorts[wk];
    c.size += 1;
    const weeks = active.get(u.id) || new Set();
    for (let k = 0; k < c.retained.length; k++) if (weeks.has(wk + k)) c.retained[k] += 1;
  }
  return cohorts.map((c) => ({ ...c, rates: c.retained.map((x) => rate(x, c.size)) }));
}

export async function productReport(env, range) {
  const r = [range.since, range.until];
  const inRange = 'day >= ? AND day <= ?';
  const distinct = (type, extra = '') => one(env,
    `SELECT COUNT(*) AS events, COUNT(DISTINCT ${PERSON}) AS people FROM events WHERE type = ? AND ${inRange}${extra}`,
    [type, ...r]);
  const untilMs = Date.parse(`${range.until}T00:00:00Z`);
  const activeSince = (days) => one(env,
    `SELECT COUNT(DISTINCT user_id) AS n FROM writing_days WHERE user_id IS NOT NULL AND day > ? AND day <= ?`,
    [dayString(untilMs - days * DAY_MS), range.until]);

  const [
    visitors, anonWriters, blocked, codesNew, signups, firstArchives, writers, writingTotals, dau, wau, mau, newWriters,
    usage, completionCalls, agent, categories, triggers, search, settingsKeys, health, clientErrors, notFound, limits,
    emailDaily, cohorts,
  ] = await Promise.all([
    one(env, `SELECT COUNT(DISTINCT day || ':' || visitor) AS people FROM pageviews WHERE ${inRange}`, r),
    distinct('doc_create', ` AND user_id IS NULL`),
    distinct('finalize_blocked'),
    distinct('auth_code_sent', ` AND json_extract(meta, '$.newAccount') = 1`),
    distinct('signup'),
    one(env, `SELECT COUNT(DISTINCT e.user_id) AS people FROM events e JOIN users u ON u.id = e.user_id
               WHERE e.type = 'archived' AND e.day >= ? AND e.day <= ? AND u.created_at >= ?`,
    [...r, `${range.since}T00:00:00.000Z`]),
    all(env, `SELECT day, COUNT(DISTINCT COALESCE(user_id, 'v:' || visitor)) AS writers,
                     COUNT(DISTINCT user_id) AS members, SUM(saves) AS saves, COUNT(*) AS docs
                FROM writing_days WHERE ${inRange} GROUP BY day`, r),
    one(env, `SELECT COUNT(DISTINCT COALESCE(user_id, 'v:' || day || visitor)) AS writers, COUNT(DISTINCT user_id) AS members,
                     SUM(saves) AS saves, COUNT(DISTINCT doc_id) AS docs, SUM(chars) AS chars
                FROM writing_days WHERE ${inRange}`, r),
    activeSince(1),
    activeSince(7),
    activeSince(30),
    one(env, `SELECT COUNT(DISTINCT w.user_id) AS n FROM writing_days w JOIN users u ON u.id = w.user_id
               WHERE w.day >= ? AND w.day <= ? AND u.created_at >= ?`, [...r, `${range.since}T00:00:00.000Z`]),
    all(env, `SELECT type, COUNT(*) AS events, COUNT(DISTINCT ${PERSON}) AS people FROM events
               WHERE ${inRange} AND type != 'admin' GROUP BY type ORDER BY events DESC`, r),
    one(env, `SELECT COUNT(*) AS calls, SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
                     SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
                FROM ai_calls WHERE feature = 'completion' AND ${inRange}`, r),
    one(env, `SELECT COUNT(*) AS runs, AVG(json_extract(meta, '$.turns')) AS turns, AVG(value) AS duration,
                     SUM(CASE WHEN json_extract(meta, '$.fallback') = 1 THEN 1 ELSE 0 END) AS fallback,
                     SUM(CASE WHEN json_extract(meta, '$.heuristic') = 1 THEN 1 ELSE 0 END) AS heuristic,
                     SUM(CASE WHEN json_extract(meta, '$.formatted') = 1 THEN 1 ELSE 0 END) AS formatted
                FROM events WHERE type = 'archived' AND ${inRange}`, r),
    all(env, `SELECT json_extract(meta, '$.category') AS key, COUNT(*) AS n FROM events
               WHERE type = 'archived' AND ${inRange} GROUP BY key ORDER BY n DESC LIMIT 12`, r),
    all(env, `SELECT COALESCE(json_extract(meta, '$.trigger'), 'manual') AS key, COUNT(*) AS n FROM events
               WHERE type = 'archived' AND ${inRange} GROUP BY key ORDER BY n DESC`, r),
    one(env, `SELECT COUNT(*) AS n, AVG(value) AS results, SUM(CASE WHEN value = 0 THEN 1 ELSE 0 END) AS empty,
                     AVG(json_extract(meta, '$.ms')) AS ms,
                     SUM(CASE WHEN json_extract(meta, '$.mode') = 'semantic' THEN 1 ELSE 0 END) AS semantic
                FROM events WHERE type = 'search' AND ${inRange}`, r),
    all(env, `SELECT j.value AS key, COUNT(*) AS n FROM events, json_each(events.meta, '$.keys') AS j
               WHERE events.type = 'settings_change' AND events.day >= ? AND events.day <= ?
               GROUP BY j.value ORDER BY n DESC`, r),
    all(env, `SELECT type, COALESCE(path, '') AS key, COUNT(*) AS n, MAX(ts) AS last FROM events
               WHERE type = 'server_error' AND ${inRange} GROUP BY type, key ORDER BY n DESC LIMIT 12`, r),
    all(env, `SELECT json_extract(meta, '$.message') AS key, json_extract(meta, '$.source') AS source, COUNT(*) AS n,
                     MAX(ts) AS last
                FROM events WHERE type = 'client_error' AND ${inRange} GROUP BY key, source ORDER BY n DESC LIMIT 12`, r),
    all(env, `SELECT COALESCE(path, '') AS key, COUNT(*) AS n FROM events
               WHERE type = 'not_found' AND ${inRange} GROUP BY key ORDER BY n DESC LIMIT 12`, r),
    all(env, `SELECT json_extract(meta, '$.bucket') AS key, COUNT(*) AS n FROM events
               WHERE type = 'rate_limited' AND ${inRange} GROUP BY key ORDER BY n DESC`, r),
    all(env, `SELECT day, SUM(CASE WHEN type = 'auth_code_sent' THEN 1 ELSE 0 END) AS sent,
                     SUM(CASE WHEN type = 'auth_email_failed' THEN 1 ELSE 0 END) AS failed
                FROM events WHERE type IN ('auth_code_sent', 'auth_email_failed') AND ${inRange} GROUP BY day`, r),
    weeklyCohorts(env, range.until),
  ]);

  const count = new Map(usage.map((u) => [u.type, { events: n(u.events), people: n(u.people) }]));
  const ev = (type) => count.get(type) || { events: 0, people: 0 };
  const funnel = [
    ['visitors', n(visitors.people)],
    ['anonWriters', n(anonWriters.people)],
    ['signInWall', n(blocked.people)],
    ['codeSent', n(codesNew.people)],
    ['signups', n(signups.events)],
    ['firstArchive', n(firstArchives.people)],
  ].map(([step, value], i, list) => ({
    step,
    value,
    ofPrevious: i === 0 ? 1 : rate(value, list[i - 1][1]),
    ofFirst: i === 0 ? 1 : rate(value, list[0][1]),
  }));

  const byDay = new Map(writers.map((w) => [w.day, w]));
  const mailByDay = new Map(emailDaily.map((m) => [m.day, m]));
  const shown = ev('completion_shown').events;
  const accepted = ev('completion_accept').events;
  const runs = n(agent.runs);
  return {
    range,
    funnel,
    writers: {
      total: n(writingTotals.writers),
      members: n(writingTotals.members),
      newMembers: n(newWriters.n),
      returningMembers: Math.max(0, n(writingTotals.members) - n(newWriters.n)),
      saves: n(writingTotals.saves),
      docs: n(writingTotals.docs),
      chars: n(writingTotals.chars),
      dau: n(dau.n),
      wau: n(wau.n),
      mau: n(mau.n),
    },
    daily: dayList(range).map((day) => {
      const w = byDay.get(day) || {};
      const m = mailByDay.get(day) || {};
      return {
        day,
        writers: n(w.writers),
        members: n(w.members),
        saves: n(w.saves),
        docs: n(w.docs),
        emails: n(m.sent),
        emailFailures: n(m.failed),
      };
    }),
    cohorts,
    features: usage.map((u) => ({ type: u.type, events: n(u.events), people: n(u.people) })),
    completion: {
      requests: n(completionCalls.calls),
      suggestions: n(completionCalls.ok),
      errors: n(completionCalls.errors),
      shown,
      accepted,
      dismissed: ev('completion_dismiss').events,
      acceptRate: rate(accepted, shown),
    },
    agent: {
      runs,
      turns: n(agent.turns),
      duration: Math.round(n(agent.duration)),
      fallbackRate: rate(n(agent.fallback), runs),
      heuristicRate: rate(n(agent.heuristic), runs),
      formattedRate: rate(n(agent.formatted), runs),
      categories: categories.map((c) => ({ key: c.key || '', n: n(c.n) })),
      triggers: triggers.map((t) => ({ key: t.key, n: n(t.n) })),
    },
    search: {
      count: n(search.n),
      results: n(search.results),
      emptyRate: rate(n(search.empty), n(search.n)),
      ms: Math.round(n(search.ms)),
      semantic: n(search.semantic),
    },
    settings: settingsKeys.map((s) => ({ key: s.key, n: n(s.n) })),
    health: {
      serverErrors: health.map((h) => ({ key: h.key, n: n(h.n), last: h.last })),
      clientErrors: clientErrors.map((c) => ({ key: c.key || '', source: c.source || '', n: n(c.n), last: c.last })),
      notFound: notFound.map((x) => ({ key: x.key, n: n(x.n) })),
      rateLimited: limits.map((x) => ({ key: x.key || '', n: n(x.n) })),
      emailFailures: ev('auth_email_failed').events,
      lockouts: ev('auth_locked').events,
    },
  };
}

// ------------------------------------------------------------ model usage

const AI_FILTERS = { model: 'model', feature: 'feature', status: 'status' };

export function aiWhere(range, q, alias = '') {
  const f = filterClauses(q, AI_FILTERS, alias);
  const clauses = [`${alias}day >= ?`, `${alias}day <= ?`, ...f.clauses];
  const binds = [range.since, range.until, ...f.binds];
  const user = q.get('user');
  if (user === 'anonymous') {
    clauses.push(`${alias}user_id IS NULL`);
    f.applied.user = user;
  } else if (user && UUID_RE.test(user)) {
    clauses.push(`${alias}user_id = ?`);
    binds.push(user);
    f.applied.user = user;
  }
  const doc = q.get('doc');
  if (doc && UUID_RE.test(doc)) {
    clauses.push(`${alias}doc_id = ?`);
    binds.push(doc);
    f.applied.doc = doc;
  }
  const fallback = q.get('fallback');
  if (fallback === '1' || fallback === '0') {
    clauses.push(`${alias}fallback = ?`);
    binds.push(Number(fallback));
    f.applied.fallback = fallback;
  }
  return { sql: clauses.join(' AND '), binds, applied: f.applied };
}

const SUMS = `COUNT(*) AS calls,
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
  SUM(CASE WHEN status = 'empty' THEN 1 ELSE 0 END) AS empty,
  SUM(fallback) AS fallback,
  SUM(input_tokens) AS input, SUM(cached_tokens) AS cached, SUM(output_tokens) AS output,
  SUM(reasoning_tokens) AS reasoning, SUM(COALESCE(neurons, 0)) AS neurons, SUM(estimated) AS estimated,
  AVG(CASE WHEN status != 'error' THEN latency_ms END) AS latency`;

function sums(row) {
  const neurons = n(row.neurons);
  return {
    calls: n(row.calls),
    errors: n(row.errors),
    empty: n(row.empty),
    errorRate: rate(n(row.errors), n(row.calls)),
    fallback: n(row.fallback),
    input: n(row.input),
    cached: n(row.cached),
    output: n(row.output),
    reasoning: n(row.reasoning),
    neurons,
    usd: usd(neurons),
    estimated: n(row.estimated),
    latency: row.latency === null || row.latency === undefined ? null : Math.round(n(row.latency)),
  };
}

// Nearest-rank latency percentiles per group, in SQL.
async function latencyPercentiles(env, w, groupExpr) {
  const list = await all(env,
    `SELECT grp,
            MIN(CASE WHEN rn * 100 >= cnt * 50 THEN latency_ms END) AS p50,
            MIN(CASE WHEN rn * 100 >= cnt * 95 THEN latency_ms END) AS p95
       FROM (SELECT ${groupExpr} AS grp, latency_ms,
                    ROW_NUMBER() OVER (PARTITION BY ${groupExpr} ORDER BY latency_ms) AS rn,
                    COUNT(*) OVER (PARTITION BY ${groupExpr}) AS cnt
               FROM ai_calls WHERE ${w.sql} AND status != 'error')
      GROUP BY grp`, w.binds);
  return new Map(list.map((r) => [r.grp, { p50: r.p50 === null ? null : n(r.p50), p95: r.p95 === null ? null : n(r.p95) }]));
}

export async function aiReport(env, range, q, now = Date.now()) {
  const w = aiWhere(range, q);
  const wa = aiWhere(range, q, 'a.');
  const today = dayString(now);
  const [totals, daily, byModel, byFeature, byUser, byDoc, errors, overall, modelP, featureP, todayRow, agentDocs, models] = await Promise.all([
    one(env, `SELECT ${SUMS}, COUNT(DISTINCT user_id) AS users FROM ai_calls WHERE ${w.sql}`, w.binds),
    all(env, `SELECT day, ${SUMS} FROM ai_calls WHERE ${w.sql} GROUP BY day`, w.binds),
    all(env, `SELECT model AS key, ${SUMS} FROM ai_calls WHERE ${w.sql} GROUP BY model ORDER BY neurons DESC`, w.binds),
    all(env, `SELECT feature AS key, ${SUMS} FROM ai_calls WHERE ${w.sql} GROUP BY feature ORDER BY neurons DESC`, w.binds),
    all(env, `SELECT a.user_id AS key, u.email, COUNT(*) AS calls, SUM(COALESCE(a.neurons, 0)) AS neurons,
                     SUM(a.input_tokens) AS input, SUM(a.output_tokens) AS output
                FROM ai_calls a LEFT JOIN users u ON u.id = a.user_id
               WHERE ${wa.sql} GROUP BY a.user_id ORDER BY neurons DESC LIMIT 20`, wa.binds),
    all(env, `SELECT a.doc_id AS key, d.title, COUNT(*) AS calls, SUM(COALESCE(a.neurons, 0)) AS neurons,
                     SUM(a.input_tokens) AS input, SUM(a.output_tokens) AS output, MAX(a.turn) AS turns
                FROM ai_calls a LEFT JOIN documents d ON d.id = a.doc_id
               WHERE ${wa.sql} AND a.doc_id IS NOT NULL GROUP BY a.doc_id ORDER BY neurons DESC LIMIT 20`, wa.binds),
    all(env, `SELECT model, error, COUNT(*) AS n, MAX(ts) AS last FROM ai_calls
               WHERE ${w.sql} AND status = 'error' GROUP BY model, error ORDER BY n DESC LIMIT 20`, w.binds),
    latencyPercentiles(env, w, `'all'`),
    latencyPercentiles(env, w, 'model'),
    latencyPercentiles(env, w, 'feature'),
    one(env, `SELECT SUM(COALESCE(neurons, 0)) AS neurons, COUNT(*) AS calls FROM ai_calls WHERE day = ?`, [today]),
    one(env, `SELECT COUNT(DISTINCT doc_id) AS docs, SUM(COALESCE(neurons, 0)) AS neurons FROM ai_calls
               WHERE ${w.sql} AND feature = 'agent' AND doc_id IS NOT NULL`, w.binds),
    all(env, `SELECT DISTINCT model FROM ai_calls WHERE day >= ? ORDER BY model`, [range.since]),
  ]);

  const byDay = new Map(daily.map((d) => [d.day, sums(d)]));
  const completions = byFeature.find((f) => f.key === 'completion');
  const allLatency = overall.get('all') || { p50: null, p95: null };
  return {
    range,
    filters: w.applied,
    totals: {
      ...sums(totals),
      users: n(totals.users),
      p50: allLatency.p50,
      p95: allLatency.p95,
      perArchive: n(agentDocs.docs) ? usd(n(agentDocs.neurons) / n(agentDocs.docs)) : 0,
      perCompletion: completions && n(completions.calls) ? usd(n(completions.neurons) / n(completions.calls)) : 0,
    },
    today: {
      day: today,
      neurons: n(todayRow.neurons),
      calls: n(todayRow.calls),
      free: FREE_NEURONS_PER_DAY,
      share: rate(n(todayRow.neurons), FREE_NEURONS_PER_DAY),
    },
    daily: dayList(range).map((day) => ({ day, ...(byDay.get(day) || sums({})) })),
    byModel: byModel.map((m) => ({ key: m.key, ...sums(m), ...(modelP.get(m.key) || {}) })),
    byFeature: byFeature.map((f) => ({ key: f.key, ...sums(f), ...(featureP.get(f.key) || {}) })),
    byUser: byUser.map((u) => ({
      key: u.key, email: u.email || null, calls: n(u.calls), neurons: n(u.neurons), usd: usd(u.neurons), input: n(u.input), output: n(u.output),
    })),
    byDoc: byDoc.map((d) => ({
      key: d.key, title: d.title || null, calls: n(d.calls), neurons: n(d.neurons), usd: usd(d.neurons),
      input: n(d.input), output: n(d.output), turns: d.turns === null ? null : n(d.turns),
    })),
    errors: errors.map((e) => ({ model: e.model, error: e.error, code: errorCode(e.error), n: n(e.n), last: e.last })),
    options: { models: models.map((m) => m.model), features: FEATURES },
    prices: {
      asOf: PRICES_AS_OF,
      usdPerNeuron: USD_PER_NEURON,
      freeNeuronsPerDay: FREE_NEURONS_PER_DAY,
      models: Object.entries(PRICES).map(([model, p]) => ({
        model,
        input: (p.input * USD_PER_NEURON),
        cached: (p.cached * USD_PER_NEURON),
        output: (p.output * USD_PER_NEURON),
      })),
    },
  };
}

export async function aiCallLog(env, range, q) {
  const w = aiWhere(range, q, 'a.');
  const limit = Math.max(1, Math.min(200, Number(q.get('limit')) || 50));
  const before = Number(q.get('before')) || 0;
  const list = await all(env,
    `SELECT a.*, u.email, d.title FROM ai_calls a
       LEFT JOIN users u ON u.id = a.user_id LEFT JOIN documents d ON d.id = a.doc_id
      WHERE ${w.sql}${before > 0 ? ' AND a.id < ?' : ''} ORDER BY a.id DESC LIMIT ?`,
    [...w.binds, ...(before > 0 ? [before] : []), limit]);
  return {
    calls: list.map((c) => ({ ...c, usd: c.neurons === null ? null : usd(c.neurons), code: errorCode(c.error) })),
    next: list.length === limit ? list[list.length - 1].id : null,
  };
}

// Cloudflare's own count of the account's Workers AI usage, when a token
// with Account Analytics: Read is configured. Account-wide: other Workers
// on the same account show up here too.
export async function cloudflareUsage(env, range, fetchImpl = fetch) {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return { configured: false };
  // Adaptive datasets keep about a month.
  const floor = dayString(Date.now() - 30 * DAY_MS);
  const since = range.since < floor ? floor : range.since;
  const query = `query ($account: string!, $start: Time!, $end: Time!) {
    viewer { accounts(filter: { accountTag: $account }) {
      aiInferenceAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end }, orderBy: [date_ASC]) {
        count
        sum { totalNeurons totalInputTokens totalOutputTokens }
        dimensions { date modelId }
      }
    } }
  }`;
  const end = dayString(Date.parse(`${range.until}T00:00:00Z`) + DAY_MS);
  try {
    const res = await fetchImpl('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { account: env.CF_ACCOUNT_ID, start: `${since}T00:00:00Z`, end: `${end}T00:00:00Z` },
      }),
    });
    const body = await res.json().catch(() => null);
    const errors = (body && body.errors) || (res.ok ? null : [{ message: `HTTP ${res.status}` }]);
    if (errors && errors.length) {
      return { configured: true, error: String(errors[0].message || 'error').slice(0, 200), since, until: range.until };
    }
    const groups = (((body.data || {}).viewer || {}).accounts || [])[0];
    const rows = ((groups && groups.aiInferenceAdaptiveGroups) || []).map((g) => ({
      day: g.dimensions.date,
      model: g.dimensions.modelId,
      requests: n(g.count),
      neurons: n(g.sum.totalNeurons),
      input: n(g.sum.totalInputTokens),
      output: n(g.sum.totalOutputTokens),
    }));
    const byModel = new Map();
    for (const r of rows) {
      const m = byModel.get(r.model) || { model: r.model, requests: 0, neurons: 0, input: 0, output: 0 };
      m.requests += r.requests;
      m.neurons += r.neurons;
      m.input += r.input;
      m.output += r.output;
      byModel.set(r.model, m);
    }
    const byDay = new Map();
    for (const r of rows) byDay.set(r.day, n(byDay.get(r.day)) + r.neurons);
    return {
      configured: true,
      since,
      until: range.until,
      models: [...byModel.values()].map((m) => ({ ...m, usd: usd(m.neurons) })).sort((a, b) => b.neurons - a.neurons),
      daily: dayList({ since, days: Math.round((Date.parse(`${range.until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY_MS) + 1 })
        .map((day) => ({ day, neurons: n(byDay.get(day)) })),
    };
  } catch (err) {
    return { configured: true, error: String(err && err.message ? err.message : err).slice(0, 200) };
  }
}

// ---------------------------------------------------------------- events

const EVENT_TYPE_RE = /^[a-z_]{2,40}$/;

export function eventsWhere(range, q) {
  const clauses = ['e.day >= ?', 'e.day <= ?'];
  const binds = [range.since, range.until];
  const applied = {};
  const types = String(q.get('type') || '').split(',').map((s) => s.trim()).filter((s) => EVENT_TYPE_RE.test(s)).slice(0, 20);
  if (types.length) {
    clauses.push(`e.type IN (${types.map(() => '?').join(',')})`);
    binds.push(...types);
    applied.type = types.join(',');
  }
  const user = (q.get('user') || '').trim();
  if (user === 'anonymous') {
    clauses.push('e.user_id IS NULL');
    applied.user = user;
  } else if (UUID_RE.test(user)) {
    clauses.push('e.user_id = ?');
    binds.push(user);
    applied.user = user;
  } else if (user.includes('@')) {
    clauses.push(`u.email LIKE ? ESCAPE '\\'`);
    binds.push(`%${escapeLike(user.toLowerCase().slice(0, 100))}%`);
    applied.user = user.slice(0, 100);
  }
  const doc = (q.get('doc') || '').trim();
  if (UUID_RE.test(doc)) {
    clauses.push('e.doc_id = ?');
    binds.push(doc);
    applied.doc = doc;
  }
  for (const key of ['path', 'country', 'device']) {
    const v = q.get(key);
    if (v) {
      clauses.push(`e.${key} = ?`);
      binds.push(v.slice(0, 120));
      applied[key] = v.slice(0, 120);
    }
  }
  const text = (q.get('q') || '').trim().slice(0, 100);
  if (text) {
    clauses.push(`(e.meta LIKE ? ESCAPE '\\' OR e.type LIKE ? ESCAPE '\\' OR e.path LIKE ? ESCAPE '\\')`);
    const like = `%${escapeLike(text)}%`;
    binds.push(like, like, like);
    applied.q = text;
  }
  return { sql: clauses.join(' AND '), binds, applied };
}

export async function eventLog(env, range, q) {
  const w = eventsWhere(range, q);
  const limit = Math.max(1, Math.min(200, Number(q.get('limit')) || 100));
  const before = Number(q.get('before')) || 0;
  const [list, types] = await Promise.all([
    all(env,
      `SELECT e.id, e.ts, e.type, e.path, e.referrer, e.country, e.device, e.user_id, e.doc_id, e.value, e.meta, u.email, d.title
         FROM events e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN documents d ON d.id = e.doc_id
        WHERE ${w.sql}${before > 0 ? ' AND e.id < ?' : ''}
        ORDER BY e.id DESC LIMIT ?`,
      [...w.binds, ...(before > 0 ? [before] : []), limit]),
    all(env, `SELECT type, COUNT(*) AS n FROM events WHERE day >= ? AND day <= ? GROUP BY type ORDER BY n DESC`,
      [range.since, range.until]),
  ]);
  const events = list.map((e) => ({ ...e, meta: safeJson(e.meta) }));
  return {
    events,
    filters: w.applied,
    types: types.map((t) => ({ type: t.type, n: n(t.n) })),
    next: events.length === limit ? events[events.length - 1].id : null,
  };
}

// --------------------------------------------------------------- exports

export async function eventsForCsv(env, range, q) {
  const w = eventsWhere(range, q);
  return all(env,
    `SELECT e.ts, e.type, u.email, e.user_id, e.doc_id, e.path, e.referrer, e.country, e.device, e.value, e.meta
       FROM events e LEFT JOIN users u ON u.id = e.user_id
      WHERE ${w.sql} ORDER BY e.id DESC LIMIT 50000`, w.binds);
}

export async function aiCallsForCsv(env, range, q) {
  const w = aiWhere(range, q, 'a.');
  const list = await all(env,
    `SELECT a.ts, a.feature, a.model, a.status, a.error, a.fallback, a.latency_ms, a.input_tokens, a.cached_tokens,
            a.output_tokens, a.reasoning_tokens, a.neurons, a.estimated, u.email, a.user_id, a.doc_id, a.turn,
            a.tool_calls, a.finish_reason, a.log_id
       FROM ai_calls a LEFT JOIN users u ON u.id = a.user_id
      WHERE ${w.sql} ORDER BY a.id DESC LIMIT 50000`, w.binds);
  return list.map((c) => ({ ...c, usd: c.neurons === null ? '' : usd(c.neurons).toFixed(6) }));
}

export async function pageviewsForCsv(env, range, q) {
  const w = trafficWhere(range, q);
  return all(env,
    `SELECT ts, path, entry, session, channel, referrer, utm_source, utm_medium, utm_campaign, country, device, browser,
            os, lang, viewport, engaged_ms, scroll, ttfb, fcp, lcp, inp, cls
       FROM pageviews WHERE ${w.sql} ORDER BY id DESC LIMIT 50000`, w.binds);
}

// ------------------------------------------------------------- overview

export async function overviewReport(env, range, now = Date.now()) {
  const r = [range.since, range.until];
  const inRange = 'day >= ? AND day <= ?';
  const [traffic, sessionStats, events, ai, runs, users, activeWriters, daily, dailyEvents, dailyAi] = await Promise.all([
    one(env, `SELECT COUNT(*) AS pageviews, COUNT(DISTINCT day || ':' || visitor) AS visitors, COUNT(DISTINCT session) AS sessions
                FROM pageviews WHERE ${inRange}`, r),
    one(env, `SELECT COUNT(*) AS sessions, SUM(CASE WHEN views = 1 THEN 1 ELSE 0 END) AS bounces
                FROM (SELECT session, COUNT(*) AS views FROM pageviews WHERE ${inRange} GROUP BY session)`, r),
    all(env, `SELECT type, COUNT(*) AS n FROM events WHERE ${inRange} GROUP BY type`, r),
    one(env, `SELECT ${SUMS} FROM ai_calls WHERE ${inRange}`, r),
    one(env, `SELECT SUM(CASE WHEN json_extract(meta, '$.fallback') = 1 THEN 1 ELSE 0 END) AS fallback,
                     SUM(CASE WHEN json_extract(meta, '$.heuristic') = 1 THEN 1 ELSE 0 END) AS heuristic
                FROM events WHERE type = 'archived' AND ${inRange}`, r),
    one(env, `SELECT COUNT(*) AS users, SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled FROM users`),
    one(env, `SELECT COUNT(DISTINCT user_id) AS n FROM writing_days WHERE user_id IS NOT NULL AND ${inRange}`, r),
    all(env, `SELECT day, COUNT(*) AS pageviews, COUNT(DISTINCT visitor) AS visitors FROM pageviews WHERE ${inRange} GROUP BY day`, r),
    all(env, `SELECT day, type, COUNT(*) AS n FROM events
               WHERE ${inRange} AND type IN ('signup', 'doc_create', 'archived') GROUP BY day, type`, r),
    all(env, `SELECT day, COUNT(*) AS calls, SUM(COALESCE(neurons, 0)) AS neurons FROM ai_calls WHERE ${inRange} GROUP BY day`, r),
  ]);
  const ev = new Map(events.map((e) => [e.type, n(e.n)]));
  const get = (t) => ev.get(t) || 0;
  const pv = new Map(daily.map((d) => [d.day, d]));
  const evDaily = new Map();
  for (const row of dailyEvents) evDaily.set(`${row.day}:${row.type}`, n(row.n));
  const aiDaily = new Map(dailyAi.map((d) => [d.day, d]));
  const aiSums = sums(ai);
  const sessions = n(sessionStats.sessions);
  return {
    range,
    since: range.since,
    traffic: {
      pageviews: n(traffic.pageviews),
      visitors: n(traffic.visitors),
      sessions,
      bounceRate: rate(n(sessionStats.bounces), sessions),
    },
    accounts: {
      users: n(users.users),
      disabled: n(users.disabled),
      signups: get('signup'),
      logins: get('login'),
      activeWriters: n(activeWriters.n),
    },
    writing: { docsCreated: get('doc_create'), finalized: get('finalize'), blocked: get('finalize_blocked'), archived: get('archived') },
    ai: {
      ...aiSums,
      shown: get('completion_shown'),
      accepts: get('completion_accept'),
      acceptRate: rate(get('completion_accept'), get('completion_shown')),
      fallbackRuns: n(runs.fallback),
      heuristicRuns: n(runs.heuristic),
    },
    health: {
      serverErrors: get('server_error'),
      clientErrors: get('client_error'),
      notFound: get('not_found'),
      rateLimited: get('rate_limited'),
    },
    daily: dayList(range).map((day) => ({
      day,
      pageviews: n(pv.get(day) && pv.get(day).pageviews),
      visitors: n(pv.get(day) && pv.get(day).visitors),
      signups: evDaily.get(`${day}:signup`) || 0,
      docsCreated: evDaily.get(`${day}:doc_create`) || 0,
      archived: evDaily.get(`${day}:archived`) || 0,
      aiCalls: n(aiDaily.get(day) && aiDaily.get(day).calls),
      usd: usd(aiDaily.get(day) && aiDaily.get(day).neurons),
    })),
  };
}
