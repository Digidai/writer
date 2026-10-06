// The admin console. Hash routes: #overview, #traffic, #product, #ai,
// #users[/id], #documents[/id], #events, #config. Filters live in the hash
// query (#traffic?country=CN&device=mobile), so every view is a link and
// the back button undoes a filter. Every value from the server is
// untrusted text: it goes into the page with textContent, never innerHTML.
import { makeAdminT } from '/admin-i18n.js';
import { makeT, resolveLang, locale } from '/i18n.js';
import { toast } from '/toast.js';

function storedLang() {
  try {
    return JSON.parse(localStorage.getItem('writer.settings') || '{}').language;
  } catch {
    return 'auto';
  }
}

const lang = resolveLang(storedLang(), navigator.language);
const t = makeAdminT(lang);
const tApp = makeT(lang);
const loc = locale(lang);
const nf = new Intl.NumberFormat(loc);
const nf1 = new Intl.NumberFormat(loc, { maximumFractionDigits: 1 });
const compactFmt = new Intl.NumberFormat(loc, { notation: 'compact', maximumFractionDigits: 1 });
const pct = new Intl.NumberFormat(loc, { style: 'percent', maximumFractionDigits: 0 });
const pct1 = new Intl.NumberFormat(loc, { style: 'percent', maximumFractionDigits: 1 });
const dayFmt = new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const timeFmt = new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const regionName = (() => {
  try {
    return new Intl.DisplayNames([loc], { type: 'region' });
  } catch {
    return null;
  }
})();
const languageName = (() => {
  try {
    return new Intl.DisplayNames([loc], { type: 'language' });
  } catch {
    return null;
  }
})();

const $ = (id) => document.getElementById(id);
const loginView = $('login-view');
const appView = $('app-view');
const loginForm = $('login-form');
const passwordEl = $('password');
const loginError = $('login-error');
const loginSubmit = $('login-submit');
const logoutBtn = $('logout');
const tabsEl = $('tabs');
const filtersEl = $('filters');
const contentEl = $('content');
const tooltipEl = $('tooltip');

const TABS = ['overview', 'traffic', 'product', 'ai', 'users', 'documents', 'events', 'config'];
const RANGE_TABS = new Set(['overview', 'traffic', 'product', 'ai', 'events']);
const PRESETS = [1, 7, 30, 90];
// The filters each view understands, in the order their chips appear.
const FILTER_KEYS = {
  traffic: ['path', 'entry', 'channel', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'country', 'device',
    'browser', 'os', 'lang', 'viewport'],
  ai: ['model', 'feature', 'status', 'fallback', 'user', 'doc'],
  events: ['type', 'user', 'doc', 'q', 'path', 'country', 'device'],
};
let range = readRange();
const listState = {
  users: { q: '', offset: 0 },
  documents: { q: '', status: '', owner: '', offset: 0 },
};
// Cursor stacks for the newest-first logs, reset whenever their filters change.
const cursors = { key: '', events: [], ai: [], pageviews: [] };
// Names for ids that appear in filter chips (emails, titles).
const names = new Map();

for (const node of document.querySelectorAll('[data-t]')) node.textContent = t(node.dataset.t);
passwordEl.placeholder = t('login.password');
passwordEl.setAttribute('aria-label', t('login.password'));
document.title = `${t('title')} · Writer`;

// ---------------------------------------------------------------- api

class AdminRequired extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    showLogin();
    throw new AdminRequired();
  }
  return res;
}

async function getJson(path) {
  const res = await api(path);
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

async function act(path, { method = 'POST', body, confirmText } = {}) {
  if (confirmText && !confirm(confirmText)) return null;
  try {
    const res = await api(path, { method, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(t('action.failed'));
      return null;
    }
    toast(t('action.done'));
    return data;
  } catch (err) {
    if (!(err instanceof AdminRequired)) toast(t('action.failed'));
    return null;
  }
}

// -------------------------------------------------------------- login

function showLogin() {
  appView.hidden = true;
  logoutBtn.hidden = true;
  loginView.hidden = false;
  passwordEl.focus();
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
  logoutBtn.hidden = false;
  route();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  loginSubmit.disabled = true;
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password: passwordEl.value }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      passwordEl.value = '';
      showApp();
      return;
    }
    loginError.textContent = res.status === 401
      ? t('login.wrong')
      : body.error === 'locked' ? t('login.locked', { n: body.retryAfter || 900 }) : t('login.rate');
    loginError.hidden = false;
    passwordEl.select();
  } catch {
    loginError.textContent = t('login.network');
    loginError.hidden = false;
  } finally {
    loginSubmit.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/admin/logout', { method: 'POST' });
  } finally {
    showLogin();
  }
});

// ------------------------------------------------------------ routing

function currentRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const q = raw.indexOf('?');
  const head = q === -1 ? raw : raw.slice(0, q);
  const [tab, id] = head.split('/');
  return {
    tab: TABS.includes(tab) ? tab : 'overview',
    id: id || null,
    params: new URLSearchParams(q === -1 ? '' : raw.slice(q + 1)),
  };
}

function go(tab, params = new URLSearchParams(), id = null) {
  const query = params.toString();
  location.hash = `#${tab}${id ? `/${id}` : ''}${query ? `?${query}` : ''}`;
}

// Add, replace or drop one filter of the current view.
function setFilter(key, value) {
  const { tab, params } = currentRoute();
  if (value === null) params.delete(key);
  else params.set(key, value);
  go(tab, params);
}

function renderTabs(active) {
  tabsEl.replaceChildren(...TABS.map((tab) => {
    const a = el('a', '', t(`tab.${tab}`));
    a.href = `#${tab}`;
    if (tab === active) a.setAttribute('aria-current', 'page');
    return a;
  }));
}

function readRange() {
  try {
    const raw = JSON.parse(localStorage.getItem('writer.admin.range') || 'null');
    if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw.from) && /^\d{4}-\d{2}-\d{2}$/.test(raw.to)) return { from: raw.from, to: raw.to };
    const days = Number(raw && typeof raw === 'object' ? raw.days : raw);
    return PRESETS.includes(days) ? { days } : { days: 30 };
  } catch {
    return { days: 30 };
  }
}

function saveRange(next) {
  range = next;
  try {
    localStorage.setItem('writer.admin.range', JSON.stringify(next));
  } catch {
    /* fine */
  }
  route();
}

function rangeQuery() {
  return range.from ? `from=${range.from}&to=${range.to}` : `days=${range.days}`;
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// One row above everything: the time range, then the active filters as
// removable chips.
function renderFilters(tab, params) {
  const bar = el('div', 'filter-row');
  const presets = el('div', 'segmented admin-range');
  presets.setAttribute('role', 'group');
  presets.setAttribute('aria-label', t('range.label'));
  for (const n of PRESETS) {
    const b = el('button', 'segment', t(`range.${n}`));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(!range.from && range.days === n));
    b.addEventListener('click', () => saveRange({ days: n }));
    presets.append(b);
  }
  const custom = el('button', 'segment', t('range.custom'));
  custom.type = 'button';
  custom.setAttribute('aria-pressed', String(Boolean(range.from)));
  custom.addEventListener('click', () => {
    if (range.from) return;
    const today = Date.now();
    saveRange({ from: isoDay(today - 29 * 86400000), to: isoDay(today) });
  });
  presets.append(custom);
  bar.append(presets);

  if (range.from) {
    const dates = el('div', 'range-dates');
    const from = dateInput(range.from, t('range.from'));
    const to = dateInput(range.to, t('range.to'));
    const apply = () => {
      if (from.value && to.value) saveRange({ from: from.value <= to.value ? from.value : to.value, to: from.value <= to.value ? to.value : from.value });
    };
    from.addEventListener('change', apply);
    to.addEventListener('change', apply);
    dates.append(from, el('span', 'range-sep', t('range.through')), to);
    bar.append(dates);
  }

  const chips = el('div', 'chips');
  for (const key of FILTER_KEYS[tab] || []) {
    if (!params.has(key)) continue;
    const value = params.get(key);
    const chip = el('button', 'chip');
    chip.type = 'button';
    chip.append(el('span', 'chip-key', t(`filter.${key}`)), el('span', 'chip-value', filterValueLabel(key, value)), el('span', 'chip-x', '×'));
    chip.setAttribute('aria-label', t('filter.remove', { name: `${t(`filter.${key}`)} ${filterValueLabel(key, value)}` }));
    chip.addEventListener('click', () => setFilter(key, null));
    chips.append(chip);
  }
  if (chips.childElementCount > 1) {
    const clear = el('button', 'link-button chip-clear', t('filter.clear'));
    clear.type = 'button';
    clear.addEventListener('click', () => go(tab));
    chips.append(clear);
  }
  filtersEl.replaceChildren(bar, ...(chips.childElementCount ? [chips] : []));
}

function dateInput(value, label) {
  const input = el('input', 'date-input');
  input.type = 'date';
  input.value = value;
  input.max = isoDay(Date.now());
  input.setAttribute('aria-label', label);
  return input;
}

let routeSeq = 0;
async function route() {
  if (appView.hidden) return;
  const seq = ++routeSeq;
  const { tab, id, params } = currentRoute();
  renderTabs(tab);
  const showFilters = RANGE_TABS.has(tab) && !id;
  filtersEl.hidden = !showFilters;
  if (showFilters) renderFilters(tab, params);
  hideTooltip();
  const key = `${tab}?${[...params].filter(([k]) => k !== 'before').map((p) => p.join('=')).join('&')}&${rangeQuery()}`;
  if (key !== cursors.key) {
    cursors.key = key;
    cursors.events = [];
    cursors.ai = [];
    cursors.pageviews = [];
  }
  // Refetch keeps the frame: dim the old render instead of blanking it.
  contentEl.classList.add('refreshing');
  try {
    let view;
    if (tab === 'overview') view = await overview();
    else if (tab === 'traffic') view = await traffic(params);
    else if (tab === 'product') view = await product();
    else if (tab === 'ai') view = await models(params);
    else if (tab === 'users') view = id ? await userDetail(id) : await users();
    else if (tab === 'documents') view = id ? await documentDetail(id) : await documents();
    else if (tab === 'events') view = await events(params);
    else view = await config();
    if (seq === routeSeq) contentEl.replaceChildren(...[view].flat(4).filter(Boolean));
  } catch (err) {
    if (!(err instanceof AdminRequired) && seq === routeSeq) {
      contentEl.replaceChildren(note(t('action.failed')));
    }
  } finally {
    if (seq === routeSeq) contentEl.classList.remove('refreshing');
  }
}

window.addEventListener('hashchange', route);

// ---------------------------------------------------------- formatting

function num(n) {
  const v = Number(n) || 0;
  return v >= 100000 ? compactFmt.format(v) : nf.format(v);
}

function tokens(n) {
  const v = Number(n) || 0;
  return v >= 10000 ? compactFmt.format(v) : nf.format(v);
}

// Single calls cost fractions of a cent: below a cent, keep two significant digits.
const usdSmall = new Intl.NumberFormat(loc, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', maximumSignificantDigits: 2 });
const usdCents = new Intl.NumberFormat(loc, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 3, maximumFractionDigits: 3 });
const usdWhole = new Intl.NumberFormat(loc, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function money(v) {
  const x = Number(v) || 0;
  if (x > 0 && x < 0.01) return usdSmall.format(x);
  return (x > 0 && x < 1 ? usdCents : usdWhole).format(x);
}

function latency(v) {
  if (v === null || v === undefined) return t('common.na');
  const x = Number(v) || 0;
  return x >= 1000 ? `${nf1.format(x / 1000)} s` : `${nf.format(Math.round(x))} ms`;
}

function clock(v) {
  if (v === null || v === undefined) return t('common.na');
  const s = Math.round((Number(v) || 0) / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}:${String(s % 60).padStart(2, '0')}` : t('unit.seconds', { n: s });
}

function share(part, whole) {
  return whole ? pct.format(part / whole) : t('common.na');
}

function dayLabel(day) {
  return dayFmt.format(new Date(`${day}T00:00:00Z`));
}

function when(iso) {
  if (!iso) return t('common.never');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : timeFmt.format(d);
}

function shortModel(model) {
  return String(model || '').replace(/^@cf\/[^/]+\//, '');
}

function countryName(code) {
  if (!code) return t('traffic.unknown');
  try {
    return (regionName && regionName.of(code)) || code;
  } catch {
    return code;
  }
}

function langName(code) {
  if (!code) return t('traffic.unknown');
  try {
    return (languageName && languageName.of(code)) || code;
  } catch {
    return code;
  }
}

function labelFrom(prefix, key) {
  if (!key) return t('traffic.unknown');
  const k = `${prefix}.${key}`;
  const label = t(k);
  return label === k ? key : label;
}

function filterValueLabel(key, value) {
  if (value === '') return key === 'referrer' ? t('traffic.direct') : t('traffic.unknown');
  if (key === 'country') return countryName(value);
  if (key === 'lang') return langName(value);
  if (['channel', 'device', 'browser', 'os', 'viewport', 'feature', 'status'].includes(key)) {
    const prefix = { status: 'callStatus' }[key] || key;
    return labelFrom(prefix, value);
  }
  if (key === 'model') return shortModel(value);
  if (key === 'fallback') return value === '1' ? t('ai.fallbackOnly') : t('ai.noFallback');
  if (key === 'type') return value.split(',').map(eventLabel).join(', ');
  if (key === 'user') return value === 'anonymous' ? t('docs.anonymous') : names.get(value) || value.slice(0, 8);
  if (key === 'doc') return names.get(value) || value.slice(0, 8);
  return value;
}

// ----------------------------------------------------------- overview

async function overview() {
  const d = await getJson(`/api/admin/overview?${rangeQuery()}`);
  const kpis = el('div', 'kpis');
  kpis.append(
    kpi(t('kpi.visitors'), num(d.traffic.visitors), t('kpi.visitorsNote'), '#traffic'),
    kpi(t('kpi.pageviews'), num(d.traffic.pageviews), t('kpi.sessionsNote', { n: num(d.traffic.sessions) }), '#traffic'),
    kpi(t('kpi.bounce'), d.traffic.sessions ? pct.format(d.traffic.bounceRate) : t('common.na'), t('kpi.bounceNote'), '#traffic'),
    kpi(t('kpi.signups'), num(d.accounts.signups), t('kpi.usersNote', { n: num(d.accounts.users) }), '#product'),
    kpi(t('kpi.activeWriters'), num(d.accounts.activeWriters), t('kpi.activeWritersNote'), '#product'),
    kpi(t('kpi.archived'), num(d.writing.archived), t('kpi.docsCreatedNote', { n: num(d.writing.docsCreated) }), '#product'),
    kpi(t('kpi.aiCost'), money(d.ai.usd), t('kpi.aiCostNote', { n: num(d.ai.calls) }), '#ai'),
    kpi(t('kpi.aiErrors'), share(d.ai.errors, d.ai.calls), t('kpi.aiErrorsNote', { n: num(d.ai.errors) }), '#ai?status=error'),
    kpi(t('kpi.acceptRate'), share(d.ai.accepts, d.ai.shown),
      t('kpi.acceptRateNote', { accepts: nf.format(d.ai.accepts), shown: nf.format(d.ai.shown) }), '#product'),
  );

  const charts = el('div', 'charts');
  charts.append(
    columnChart(t('chart.visitors'), d.daily, 'visitors'),
    columnChart(t('chart.pageviews'), d.daily, 'pageviews'),
    columnChart(t('chart.signups'), d.daily, 'signups'),
    columnChart(t('chart.archived'), d.daily, 'archived'),
    columnChart(t('chart.aiCost'), d.daily, 'usd', { format: money }),
    columnChart(t('chart.docsCreated'), d.daily, 'docsCreated'),
  );

  const h = d.health;
  const health = el('div', 'kpis');
  health.append(
    kpi(t('health.serverErrors'), num(h.serverErrors), '', '#events?type=server_error'),
    kpi(t('health.clientErrors'), num(h.clientErrors), '', '#events?type=client_error'),
    kpi(t('health.notFound'), num(h.notFound), '', '#events?type=not_found'),
    kpi(t('health.rateLimited'), num(h.rateLimited), '', '#events?type=rate_limited'),
    kpi(t('kpi.fallback'), num(d.ai.fallbackRuns), d.ai.heuristicRuns ? t('kpi.fallbackNote', { heuristic: d.ai.heuristicRuns }) : '', '#ai?fallback=1'),
  );

  const docs = el('div', 'kpis');
  const w = d.writing;
  docs.append(
    kpi(t('docs.draft'), num(w.documents.draft), '', '#documents'),
    kpi(t('docs.processing'), num(w.documents.processing)),
    kpi(t('docs.archived'), num(w.documents.archived)),
    kpi(t('docs.deleted'), num(w.documents.deleted)),
    kpi(t('docs.anonDrafts'), num(w.anonDrafts)),
    kpi(t('docs.legacy'), num(w.legacy)),
    kpi(t('docs.stuck'), num(w.stuck)),
  );

  return [
    kpis,
    sectionTitle(t('overview.trends')), charts,
    sectionTitle(t('health.title')), health,
    sectionTitle(t('docs.title')), docs,
    sectionTitle(t('system.title')), systemCard(d.system),
  ];
}

function systemCard(s) {
  const card = el('div', 'detail');
  card.append(kv([
    [t('system.version'), s.version],
    [t('system.email'), s.email ? t('system.ok') : t('system.missing')],
    [t('system.registration'), s.registration === 'closed' ? t('system.closed') : t('system.open')],
    [t('system.analyticsSecret'), s.analyticsSecret ? t('system.ok') : t('system.missingSecret')],
    [t('system.cloudflare'), s.cloudflareAnalytics ? t('system.on') : t('system.off')],
    [t('system.semantic'), s.semantic ? t('system.on') : t('system.off')],
    [t('system.siteLock'), s.siteLock ? t('system.on') : t('system.off')],
  ]));
  return card;
}

function kpi(label, value, noteText = '', href = '') {
  const box = el(href ? 'a' : 'div', `kpi${href ? ' kpi-link' : ''}`);
  if (href) box.href = href;
  box.append(el('p', 'kpi-label', label), el('p', 'kpi-value', value));
  if (noteText) box.append(el('p', 'kpi-note', noteText));
  return box;
}

// One series per chart (small multiples), so there is never a legend to
// decode: the title names the series. Muted bars, the latest in the accent.
function columnChart(title, series, key, { format = (v) => nf.format(v), label = (row) => dayLabel(row.day), emphasize = true, callout } = {}) {
  const card = el('section', 'chart');
  const head = el('div', 'chart-head');
  const values = series.map((row) => Number(row[key]) || 0);
  const last = values[values.length - 1] || 0;
  head.append(el('h3', 'chart-title', title));
  const calloutText = callout !== undefined ? callout : emphasize ? t('chart.today', { n: format(last) }) : '';
  if (calloutText) head.append(el('span', 'chart-callout', calloutText));

  const max = niceMax(Math.max(0, ...values));
  const plot = el('div', 'plot');
  for (const tick of ticks(max)) {
    const line = el('div', 'plot-grid');
    line.style.bottom = `${(tick / max) * 100}%`;
    line.append(el('span', '', format(tick)));
    plot.append(line);
  }
  const cols = el('div', 'plot-cols');
  series.forEach((row, i) => {
    const value = values[i];
    const col = el('div', `plot-col${value === 0 ? ' zero' : ''}${emphasize && i === series.length - 1 ? ' emphasis' : ''}`);
    col.tabIndex = 0;
    const name = label(row);
    col.setAttribute('aria-label', `${name}: ${format(value)}`);
    const bar = el('span', 'plot-bar');
    bar.style.setProperty('--h', `${max ? (value / max) * 100 : 0}%`);
    col.append(bar);
    const show = (x, y) => showTooltip(format(value), name, x, y);
    col.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
    col.addEventListener('pointerleave', hideTooltip);
    col.addEventListener('focus', () => {
      const r = col.getBoundingClientRect();
      show(r.left + r.width / 2, r.top);
    });
    col.addEventListener('blur', hideTooltip);
    cols.append(col);
  });
  plot.append(cols);

  const x = el('div', 'plot-x');
  for (const row of [series[0], series[series.length - 1]]) x.append(el('span', '', row ? label(row) : ''));

  // The table twin: every value reachable without hovering.
  const details = el('details');
  details.append(el('summary', '', t('chart.table')), dataTable([t('chart.when'), { num: t('chart.value') }],
    series.map((row, i) => [label(row), { num: format(values[i]) }]).reverse()));

  card.append(head, plot, x, details);
  return card;
}

// Round up to 1, 2 or 5 times a power of ten, so ticks are clean numbers.
export function niceMax(v) {
  if (v <= 0) return 4;
  if (v < 1) {
    const pow = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 5, 10]) if (v <= m * pow) return m * pow;
  }
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) {
    if (v <= m * pow) return Math.max(m * pow, 4);
  }
  return 10 * pow;
}

function ticks(max) {
  const mid = max / 2;
  return max < 1 || Number.isInteger(mid) ? [0, mid, max] : [0, max];
}

function showTooltip(value, label, x, y) {
  tooltipEl.replaceChildren(el('strong', '', value), document.createTextNode(label));
  tooltipEl.hidden = false;
  const r = tooltipEl.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 12));
  const top = Math.max(8, y - r.height - 12);
  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
}

function hideTooltip() {
  tooltipEl.hidden = true;
}

// A ranked list. With `onPick`, every row filters the view to itself.
function rankList(title, rows, { label = (k) => k || t('traffic.unknown'), value, metric = 'views', onPick, empty, hint } = {}) {
  const box = el('section', 'rank');
  box.append(el('h3', '', title));
  if (hint) box.append(el('p', 'rank-hint', hint));
  const max = Math.max(1, ...rows.map((r) => Number(r[metric]) || 0));
  for (const row of rows) {
    const item = el(onPick ? 'button' : 'div', `rank-row${onPick ? ' pickable' : ''}`);
    if (onPick) {
      item.type = 'button';
      item.addEventListener('click', () => onPick(row.key));
      item.title = t('filter.by', { name: label(row.key) });
    }
    const key = el('span', 'rank-key', label(row.key));
    if (!onPick) key.title = key.textContent;
    const val = el('span', 'rank-val', value ? value(row) : nf.format(Number(row[metric]) || 0));
    const bar = el('span', 'rank-bar');
    bar.style.setProperty('--w', `${((Number(row[metric]) || 0) / max) * 100}%`);
    item.append(key, val, bar);
    box.append(item);
  }
  if (rows.length === 0) box.append(note(empty || t('traffic.empty')));
  return box;
}

// ------------------------------------------------------------ traffic

const TRAFFIC_PARAMS = FILTER_KEYS.traffic;

function filterQuery(params, keys) {
  const out = new URLSearchParams();
  for (const k of keys) if (params.has(k)) out.set(k, params.get(k));
  return out.toString();
}

async function traffic(params) {
  const fq = filterQuery(params, TRAFFIC_PARAMS);
  const before = cursors.pageviews[cursors.pageviews.length - 1];
  const [d, log] = await Promise.all([
    getJson(`/api/admin/traffic?${rangeQuery()}${fq ? `&${fq}` : ''}`),
    getJson(`/api/admin/pageviews?${rangeQuery()}${fq ? `&${fq}` : ''}&limit=30${before ? `&before=${before}` : ''}`),
  ]);
  const tt = d.totals;
  if (tt.pageviews === 0) return note(t('traffic.empty'));

  const kpis = el('div', 'kpis');
  kpis.append(
    kpi(t('kpi.visitors'), num(tt.visitors), t('kpi.visitorsNote')),
    kpi(t('kpi.sessions'), num(tt.sessions), t('kpi.viewsPerSession', { n: nf1.format(tt.viewsPerSession) })),
    kpi(t('kpi.pageviews'), num(tt.pageviews)),
    kpi(t('kpi.bounce'), pct.format(tt.bounceRate), t('kpi.bounceNote')),
    kpi(t('kpi.engaged'), clock(tt.engagedPerSession), t('kpi.engagedNote', { n: clock(tt.engagedPerView) })),
    kpi(t('kpi.scroll'), tt.scroll === null ? t('common.na') : pct.format(tt.scroll / 100), t('kpi.scrollNote')),
  );

  const charts = el('div', 'charts');
  charts.append(
    columnChart(t('chart.visitors'), d.daily, 'visitors'),
    columnChart(t('chart.sessions'), d.daily, 'sessions'),
    columnChart(t('chart.pageviews'), d.daily, 'pageviews'),
    hoursChart(d.hours),
  );

  const pick = (key) => (value) => setFilter(key, value);
  const sessionsOf = (r) => `${nf.format(r.sessions)} · ${nf.format(r.visitors)}`;
  const sources = el('div', 'ranks');
  sources.append(
    rankList(t('traffic.channels'), d.channels, { label: (k) => labelFrom('channel', k), metric: 'sessions', value: sessionsOf, onPick: pick('channel'), hint: t('traffic.sessionsVisitors') }),
    rankList(t('traffic.referrers'), d.referrers, { label: (k) => k || t('traffic.direct'), metric: 'sessions', value: sessionsOf, onPick: pick('referrer'), hint: t('traffic.sessionsVisitors') }),
  );
  const utmLists = [
    ['utm_source', d.utm.source], ['utm_medium', d.utm.medium], ['utm_campaign', d.utm.campaign],
  ].filter(([, rows]) => rows.some((r) => r.key));
  for (const [key, rows] of utmLists) {
    sources.append(rankList(t(`filter.${key}`), rows.filter((r) => r.key), { metric: 'sessions', value: sessionsOf, onPick: pick(key) }));
  }

  const pages = el('div', 'ranks');
  pages.append(
    rankList(t('traffic.paths'), d.paths, {
      label: (k) => k || '/', onPick: pick('path'), hint: t('traffic.viewsVisitorsTime'),
      value: (r) => `${nf.format(r.views)} · ${nf.format(r.visitors)} · ${clock(r.engaged)}`,
    }),
    rankList(t('traffic.entries'), d.entries, {
      label: (k) => k || '/', metric: 'sessions', onPick: pick('entry'), hint: t('traffic.sessionsBounce'),
      value: (r) => `${nf.format(r.sessions)} · ${pct.format(r.bounceRate)}`,
    }),
    rankList(t('traffic.exits'), d.exits, { label: (k) => k || '/', metric: 'exits' }),
  );

  const who = el('div', 'ranks');
  const visitorsOf = (r) => `${nf.format(r.visitors)} · ${nf.format(r.views)}`;
  who.append(
    rankList(t('traffic.countries'), d.countries, { label: countryName, metric: 'visitors', value: visitorsOf, onPick: pick('country'), hint: t('traffic.visitorsViews') }),
    rankList(t('traffic.devices'), d.devices, { label: (k) => labelFrom('device', k), metric: 'visitors', value: visitorsOf, onPick: pick('device') }),
    rankList(t('traffic.browsers'), d.browsers, { label: (k) => labelFrom('browser', k), metric: 'visitors', value: visitorsOf, onPick: pick('browser') }),
    rankList(t('traffic.os'), d.os, { label: (k) => labelFrom('os', k), metric: 'visitors', value: visitorsOf, onPick: pick('os') }),
    rankList(t('traffic.langs'), d.langs, { label: langName, metric: 'visitors', value: visitorsOf, onPick: pick('lang') }),
    rankList(t('traffic.viewports'), d.viewports, { label: (k) => labelFrom('viewport', k), metric: 'visitors', value: visitorsOf, onPick: pick('viewport') }),
  );

  const toolbar = el('div', 'toolbar');
  toolbar.append(downloadLink(`/api/admin/export/pageviews.csv?${rangeQuery()}${fq ? `&${fq}` : ''}`, t('traffic.export')));

  return [
    kpis,
    sectionTitle(t('traffic.trends')), charts,
    sectionTitle(t('traffic.sources')), sources,
    sectionTitle(t('traffic.pagesTitle')), pages,
    sectionTitle(t('traffic.audience')), who,
    sectionTitle(t('vitals.title')), vitalsView(d.vitals),
    sectionTitle(t('traffic.log')), toolbar, pageviewTable(log),
  ];
}

// Local hours: the server counts in UTC.
function hoursChart(hours) {
  const offset = -new Date().getTimezoneOffset() / 60;
  const local = Array.from({ length: 24 }, (_, h) => ({ hour: h, views: 0 }));
  for (const row of hours) {
    const h = (((row.hour + Math.round(offset)) % 24) + 24) % 24;
    local[h].views += row.views;
  }
  return columnChart(t('chart.hours'), local, 'views', {
    label: (row) => t('chart.hour', { n: row.hour }),
    emphasize: false,
  });
}

const VITAL_KEYS = ['lcp', 'inp', 'cls', 'fcp', 'ttfb'];

function vitalValue(key, v) {
  if (v === null || v === undefined) return t('common.na');
  return key === 'cls' ? nf.format(Math.round(v) / 1000) : latency(v);
}

function rating(r) {
  const box = el('span', `rating ${r || 'none'}`);
  box.append(el('span', 'rating-mark'), el('span', '', r ? t(`vitals.${r}`) : t('common.na')));
  return box;
}

function vitalsView(v) {
  const cards = el('div', 'kpis');
  for (const key of VITAL_KEYS) {
    const m = v.overall[key];
    const box = el('div', 'kpi');
    box.append(el('p', 'kpi-label', t(`vitals.${key}`)), el('p', 'kpi-value', vitalValue(key, m.p75)));
    const foot = el('p', 'kpi-note');
    foot.append(rating(m.rating), document.createTextNode(` ${t('vitals.samples', { n: nf.format(m.samples) })}`));
    box.append(foot);
    cards.append(box);
  }
  const out = [cards];
  if (v.pages.length) {
    const table = dataTable(
      [t('traffic.path'), { num: t('vitals.samplesCol') }, ...VITAL_KEYS.map((k) => ({ num: t(`vitals.${k}Short`) }))],
      v.pages.map((p) => [
        { clip: p.path },
        { num: nf.format(p.samples) },
        ...VITAL_KEYS.map((k) => ({ node: vitalCell(k, p[k]) })),
      ]),
    );
    out.push(table);
  }
  const help = el('p', 'config-help', t('vitals.help'));
  out.push(help);
  const wrap = el('div', 'stack');
  wrap.append(...out);
  return wrap;
}

function vitalCell(key, m) {
  const cell = el('span', 'vital-cell');
  cell.append(el('span', '', vitalValue(key, m.p75)), rating(m.rating));
  return cell;
}

function pageviewTable(log) {
  if (!log.pageviews.length) return note(t('traffic.empty'));
  const table = dataTable(
    [t('events.time'), t('traffic.path'), t('traffic.channel'), t('traffic.place'), t('traffic.client'),
      { num: t('traffic.engagedCol') }, { num: t('vitals.lcpShort') }],
    log.pageviews.map((p) => [
      { muted: when(p.ts) },
      { clip: `${p.path}${p.entry ? ` ${t('traffic.entryMark')}` : ''}` },
      { clip: [labelFrom('channel', p.channel), p.referrer, p.utm_source].filter(Boolean).join(' · ') },
      { clip: [countryName(p.country), langName(p.lang)].join(' · ') },
      { clip: [labelFrom('device', p.device), labelFrom('browser', p.browser), labelFrom('os', p.os)].join(' · ') },
      { num: clock(p.engaged_ms) },
      { num: vitalValue('lcp', p.lcp) },
    ]),
  );
  return [table, cursorPager('pageviews', log.next)];
}

// Newest first, one page at a time.
function cursorPager(kind, next) {
  const nav = el('div', 'pager');
  const stack = cursors[kind];
  if (stack.length) nav.append(button(t('common.newer'), () => { stack.pop(); route(); }));
  if (next) nav.append(button(t('events.more'), () => { stack.push(next); route(); }));
  return nav;
}

// ------------------------------------------------------------ product

async function product() {
  const d = await getJson(`/api/admin/product?${rangeQuery()}`);

  const funnel = el('section', 'rank funnel');
  funnel.append(el('h3', '', t('product.funnel')), el('p', 'rank-hint', t('product.funnelHint')));
  const first = Math.max(1, d.funnel[0] ? d.funnel[0].value : 1);
  for (const step of d.funnel) {
    const row = el('div', 'rank-row');
    row.append(
      el('span', 'rank-key', t(`funnel.${step.step}`)),
      el('span', 'rank-val', step.step === 'visitors' ? nf.format(step.value) : `${nf.format(step.value)} · ${pct1.format(step.ofPrevious)}`),
    );
    const bar = el('span', 'rank-bar');
    bar.style.setProperty('--w', `${(step.value / first) * 100}%`);
    row.append(bar);
    funnel.append(row);
  }

  const w = d.writers;
  const writers = el('div', 'kpis');
  writers.append(
    kpi(t('product.writers'), num(w.total), t('product.writersNote', { n: num(w.members) })),
    kpi(t('product.newMembers'), num(w.newMembers), t('product.returningNote', { n: num(w.returningMembers) })),
    kpi('DAU', num(w.dau), t('product.dauNote')),
    kpi('WAU', num(w.wau), t('product.wauNote')),
    kpi('MAU', num(w.mau), t('product.mauNote')),
    kpi(t('product.saves'), num(w.saves), t('product.docsNote', { n: num(w.docs) })),
    kpi(t('product.chars'), num(w.chars), t('product.charsNote')),
  );

  const charts = el('div', 'charts');
  charts.append(
    columnChart(t('chart.writers'), d.daily, 'writers'),
    columnChart(t('chart.saves'), d.daily, 'saves'),
    columnChart(t('chart.emails'), d.daily, 'emails'),
  );

  const c = d.completion;
  const completion = el('div', 'kpis');
  completion.append(
    kpi(t('completion.requests'), num(c.requests), t('completion.requestsNote', { n: num(c.suggestions) }), '#ai?feature=completion'),
    kpi(t('completion.shown'), num(c.shown)),
    kpi(t('completion.accepted'), num(c.accepted), t('completion.acceptRate', { n: pct.format(c.acceptRate) })),
    kpi(t('completion.dismissed'), num(c.dismissed)),
    kpi(t('completion.errors'), num(c.errors), '', '#ai?feature=completion&status=error'),
  );

  const a = d.agent;
  const agent = el('div', 'kpis');
  agent.append(
    kpi(t('agent.runs'), num(a.runs), '', '#events?type=archived'),
    kpi(t('agent.turns'), nf1.format(a.turns)),
    kpi(t('agent.duration'), latency(a.duration)),
    kpi(t('agent.fallback'), pct.format(a.fallbackRate)),
    kpi(t('agent.heuristic'), pct.format(a.heuristicRate)),
    kpi(t('agent.formatted'), pct.format(a.formattedRate)),
  );
  const agentRanks = el('div', 'ranks');
  agentRanks.append(
    rankList(t('agent.categories'), a.categories, { metric: 'n' }),
    rankList(t('agent.triggers'), a.triggers, { metric: 'n', label: (k) => labelFrom('trigger', k) }),
  );

  const s = d.search;
  const search = el('div', 'kpis');
  search.append(
    kpi(t('search.count'), num(s.count), s.semantic ? t('search.semantic', { n: num(s.semantic) }) : '', '#events?type=search'),
    kpi(t('search.results'), nf1.format(s.results)),
    kpi(t('search.empty'), pct.format(s.emptyRate)),
    kpi(t('search.ms'), latency(s.ms)),
  );

  const features = dataTable(
    [t('product.event'), { num: t('product.events') }, { num: t('product.people') }],
    d.features.map((f) => [eventLabel(f.type), { num: nf.format(f.events) }, { num: nf.format(f.people) }]),
    (i) => go('events', new URLSearchParams({ type: d.features[i].type })),
  );

  const h = d.health;
  const health = el('div', 'ranks');
  health.append(
    rankList(t('health.serverErrors'), h.serverErrors, { metric: 'n', label: (k) => k || '/', empty: t('health.none') }),
    rankList(t('health.clientErrors'), h.clientErrors, {
      metric: 'n', label: (k) => k || t('traffic.unknown'), empty: t('health.none'),
      value: (r) => `${nf.format(r.n)}${r.source ? ` · ${r.source}` : ''}`,
    }),
    rankList(t('health.notFound'), h.notFound, { metric: 'n', label: (k) => k || '/', empty: t('health.none') }),
    rankList(t('health.rateLimited'), h.rateLimited, { metric: 'n', label: (k) => labelFrom('bucket', k), empty: t('health.none') }),
  );
  if (h.emailFailures || h.lockouts) {
    health.append(rankList(t('health.auth'), [
      { key: 'emailFailures', n: h.emailFailures },
      { key: 'lockouts', n: h.lockouts },
    ], { metric: 'n', label: (k) => t(`health.${k}`) }));
  }

  const settings = d.settings.length
    ? rankList(t('product.settings'), d.settings, { metric: 'n', label: settingLabel })
    : null;

  return [
    funnel,
    sectionTitle(t('product.writersTitle')), writers, charts,
    sectionTitle(t('product.retention')), cohortTable(d.cohorts),
    sectionTitle(t('completion.title')), completion,
    sectionTitle(t('agent.title')), agent, agentRanks,
    sectionTitle(t('search.title')), search,
    sectionTitle(t('product.features')), features,
    ...(settings ? [sectionTitle(t('product.settings')), settings] : []),
    sectionTitle(t('health.title')), health,
  ];
}

function settingLabel(key) {
  const map = {
    language: 'settings.language', fontSize: 'settings.fontSize', theme: 'settings.theme', completion: 'settings.completion',
    completionDelay: 'settings.completionDelay', agentFormatting: 'settings.agentFormatting', idleArchiveMinutes: 'settings.idleArchive',
  };
  return map[key] ? tApp(map[key]) : key;
}

// Weekly cohorts by sign-up week: who wrote again in each later week.
function cohortTable(cohorts) {
  if (!cohorts.some((c) => c.size)) return note(t('product.noCohorts'));
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'cohorts');
  const head = el('tr');
  head.append(el('th', '', t('product.cohort')), el('th', 'num', t('product.cohortSize')));
  for (let k = 0; k < 8; k++) head.append(el('th', 'num', t('product.week', { n: k })));
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  for (const c of cohorts) {
    const tr = el('tr');
    tr.append(el('td', 'muted', dayLabel(c.week)), el('td', 'num', nf.format(c.size)));
    for (let k = 0; k < 8; k++) {
      const td = el('td', 'num');
      if (k < c.rates.length && c.size) {
        td.textContent = pct.format(c.rates[k]);
        td.style.setProperty('--fill', `${Math.round(c.rates[k] * 60)}%`);
        td.classList.add('heat');
        td.title = `${nf.format(c.retained[k])} / ${nf.format(c.size)}`;
      }
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

// ------------------------------------------------------------- models

const AI_PARAMS = FILTER_KEYS.ai;

async function models(params) {
  const fq = filterQuery(params, AI_PARAMS);
  const before = cursors.ai[cursors.ai.length - 1];
  const base = `${rangeQuery()}${fq ? `&${fq}` : ''}`;
  const [d, log] = await Promise.all([
    getJson(`/api/admin/ai?${base}`),
    getJson(`/api/admin/ai/calls?${base}&limit=30${before ? `&before=${before}` : ''}`),
  ]);
  for (const u of d.byUser) if (u.key && u.email) names.set(u.key, u.email);
  for (const doc of d.byDoc) if (doc.key) names.set(doc.key, doc.title || t('docs.untitled'));
  if (fq && currentRoute().tab === 'ai') renderFilters('ai', params);

  const toolbar = el('div', 'toolbar');
  toolbar.append(
    select([['', t('ai.allModels')], ...d.options.models.map((m) => [m, shortModel(m)])], params.get('model') || '', (v) => setFilter('model', v || null)),
    select([['', t('ai.allFeatures')], ...d.options.features.map((f) => [f, labelFrom('feature', f)])], params.get('feature') || '', (v) => setFilter('feature', v || null)),
    select([['', t('ai.allStatus')], ['ok', t('callStatus.ok')], ['empty', t('callStatus.empty')], ['error', t('callStatus.error')]],
      params.get('status') || '', (v) => setFilter('status', v || null)),
    downloadLink(`/api/admin/export/ai_calls.csv?${base}`, t('ai.export')),
  );

  const tt = d.totals;
  if (tt.calls === 0) return [toolbar, note(t('ai.empty'))];

  const kpis = el('div', 'kpis');
  kpis.append(
    kpi(t('ai.cost'), money(tt.usd), t('ai.neurons', { n: num(Math.round(tt.neurons)) })),
    kpi(t('ai.calls'), num(tt.calls), t('ai.users', { n: num(tt.users) })),
    kpi(t('ai.errorRate'), pct1.format(tt.errorRate), t('ai.errorsNote', { n: num(tt.errors), fallback: num(tt.fallback) })),
    kpi(t('ai.input'), tokens(tt.input), t('ai.cachedNote', { n: share(tt.cached, tt.input) })),
    kpi(t('ai.output'), tokens(tt.output), tt.reasoning ? t('ai.reasoningNote', { n: share(tt.reasoning, tt.output) }) : ''),
    kpi(t('ai.latency'), latency(tt.p50), t('ai.p95', { n: latency(tt.p95) })),
    kpi(t('ai.perArchive'), money(tt.perArchive)),
    kpi(t('ai.perCompletion'), money(tt.perCompletion)),
  );

  const today = el('div', 'detail allowance');
  const pctUsed = Math.min(1, d.today.share);
  const meter = el('div', 'meter');
  const fill = el('span', 'meter-fill');
  fill.style.setProperty('--w', `${pctUsed * 100}%`);
  meter.append(fill);
  meter.setAttribute('role', 'img');
  meter.setAttribute('aria-label', t('ai.todayLabel', { used: nf1.format(d.today.neurons), free: nf.format(d.today.free) }));
  today.append(
    el('p', 'allowance-title', t('ai.today', { used: nf1.format(d.today.neurons), free: nf.format(d.today.free), n: pct1.format(d.today.share) })),
    meter,
    el('p', 'config-help', t('ai.todayHelp')),
  );

  const charts = el('div', 'charts');
  charts.append(
    columnChart(t('chart.aiCost'), d.daily, 'usd', { format: money }),
    columnChart(t('chart.aiCalls'), d.daily, 'calls'),
    columnChart(t('chart.aiTokens'), d.daily, 'output', { format: tokens }),
    columnChart(t('chart.aiErrors'), d.daily, 'errors'),
  );

  const usageHeaders = (first) => [first, { num: t('ai.calls') }, { num: t('ai.errorRate') }, { num: t('ai.inputShort') },
    { num: t('ai.cachedShort') }, { num: t('ai.outputShort') }, { num: t('ai.cost') }, { num: 'p50' }, { num: 'p95' }];
  const usageRow = (label, r) => [label, { num: nf.format(r.calls) }, { num: pct.format(r.errorRate) }, { num: tokens(r.input) },
    { num: share(r.cached, r.input) }, { num: tokens(r.output) }, { num: money(r.usd) }, { num: latency(r.p50) }, { num: latency(r.p95) }];
  const byModel = dataTable(usageHeaders(t('ai.model')), d.byModel.map((m) => usageRow({ clip: shortModel(m.key) }, m)),
    (i) => setFilter('model', d.byModel[i].key));
  const byFeature = dataTable(usageHeaders(t('ai.feature')), d.byFeature.map((f) => usageRow(labelFrom('feature', f.key), f)),
    (i) => setFilter('feature', d.byFeature[i].key));

  const byUser = d.byUser.length
    ? dataTable([t('events.user'), { num: t('ai.calls') }, { num: t('ai.inputShort') }, { num: t('ai.outputShort') }, { num: t('ai.cost') }],
      d.byUser.map((u) => [{ clip: u.key ? u.email || u.key.slice(0, 8) : t('docs.anonymous') }, { num: nf.format(u.calls) },
        { num: tokens(u.input) }, { num: tokens(u.output) }, { num: money(u.usd) }]),
      (i) => setFilter('user', d.byUser[i].key || 'anonymous'))
    : note(t('ai.empty'));
  const byDoc = d.byDoc.length
    ? dataTable([t('docs.titleCol'), { num: t('ai.calls') }, { num: t('ai.turns') }, { num: t('ai.outputShort') }, { num: t('ai.cost') }],
      d.byDoc.map((doc) => [{ clip: doc.title || t('docs.untitled') }, { num: nf.format(doc.calls) },
        { num: doc.turns === null ? t('common.na') : nf.format(doc.turns) }, { num: tokens(doc.output) }, { num: money(doc.usd) }]),
      (i) => setFilter('doc', d.byDoc[i].key))
    : note(t('ai.noDocs'));

  const errors = d.errors.length
    ? dataTable([t('ai.model'), t('ai.code'), t('ai.error'), { num: t('ai.count') }, t('ai.lastSeen')],
      d.errors.map((e) => [{ clip: shortModel(e.model) }, errorCodeLabel(e.code), { clip: e.error || '' }, { num: nf.format(e.n) }, { muted: when(e.last) }]))
    : note(t('ai.noErrors'));

  const calls = callTable(log);
  const cloudflare = el('div', 'stack');
  cloudflare.append(note(t('common.loading')));
  loadCloudflare(cloudflare, d);

  return [
    toolbar, kpis, today,
    sectionTitle(t('ai.trends')), charts,
    sectionTitle(t('ai.byModel')), byModel,
    sectionTitle(t('ai.byFeature')), byFeature,
    sectionTitle(t('ai.byUser')), byUser,
    sectionTitle(t('ai.byDoc')), byDoc,
    sectionTitle(t('ai.errors')), errors,
    sectionTitle(t('ai.log')), calls,
    sectionTitle(t('ai.cloudflare')), cloudflare,
    sectionTitle(t('ai.prices')), priceTable(d.prices),
  ];
}

function errorCodeLabel(code) {
  if (!code) return t('common.na');
  const k = `aiError.${code}`;
  const label = t(k);
  return label === k ? code : `${code} ${label}`;
}

function callTable(log) {
  if (!log.calls.length) return note(t('ai.empty'));
  for (const c of log.calls) {
    if (c.user_id && c.email) names.set(c.user_id, c.email);
    if (c.doc_id && c.title) names.set(c.doc_id, c.title);
  }
  const table = dataTable(
    [t('events.time'), t('ai.feature'), t('ai.model'), t('ai.status'), { num: t('ai.latency') }, { num: t('ai.inputShort') },
      { num: t('ai.outputShort') }, { num: t('ai.cost') }, t('events.user'), t('docs.titleCol')],
    log.calls.map((c) => [
      { muted: when(c.ts) },
      `${labelFrom('feature', c.feature)}${c.turn ? ` ${t('ai.turnMark', { n: c.turn })}` : ''}`,
      { clip: `${shortModel(c.model)}${c.fallback ? ` ${t('ai.fallbackMark')}` : ''}` },
      { pill: c.status === 'error' ? errorCodeLabel(c.code) : labelFrom('callStatus', c.status), warn: c.status === 'error' },
      { num: latency(c.latency_ms) },
      { num: `${tokens(c.input_tokens)}${c.estimated ? '*' : ''}` },
      { num: tokens(c.output_tokens) },
      { num: c.usd === null ? t('common.na') : money(c.usd) },
      { clip: c.user_id ? c.email || c.user_id.slice(0, 8) : t('docs.anonymous') },
      { clip: c.doc_id ? c.title || t('docs.untitled') : '' },
    ]),
    (i) => {
      const c = log.calls[i];
      if (c.doc_id) go('documents', new URLSearchParams(), c.doc_id);
    },
  );
  const foot = el('p', 'config-help', t('ai.estimatedNote'));
  return [table, foot, cursorPager('ai', log.next)];
}

async function loadCloudflare(box, local) {
  try {
    const cf = await getJson(`/api/admin/ai/cloudflare?${rangeQuery()}`);
    if (!cf.configured) {
      box.replaceChildren(el('p', 'config-help', t('ai.cloudflareOff')));
      return;
    }
    if (cf.error) {
      box.replaceChildren(el('p', 'config-help', t('ai.cloudflareError', { error: cf.error })));
      return;
    }
    const mine = new Map(local.byModel.map((m) => [m.key, m]));
    const table = dataTable(
      [t('ai.model'), { num: t('ai.cfRequests') }, { num: t('ai.cfNeurons') }, { num: t('ai.cfCost') }, { num: t('ai.mineNeurons') }],
      cf.models.map((m) => [{ clip: shortModel(m.model) }, { num: nf.format(m.requests) }, { num: nf1.format(m.neurons) },
        { num: money(m.usd) }, { num: mine.has(m.model) ? nf1.format(mine.get(m.model).neurons) : t('common.na') }]),
    );
    box.replaceChildren(
      columnChart(t('ai.cfDaily'), cf.daily, 'neurons', { format: (v) => nf1.format(v) }),
      table,
      el('p', 'config-help', t('ai.cloudflareHelp', { since: cf.since })),
    );
  } catch (err) {
    if (!(err instanceof AdminRequired)) box.replaceChildren(note(t('action.failed')));
  }
}

function priceTable(p) {
  const table = dataTable(
    [t('ai.model'), { num: t('ai.priceInput') }, { num: t('ai.priceCached') }, { num: t('ai.priceOutput') }],
    p.models.map((m) => [{ clip: shortModel(m.model) }, { num: money(m.input) }, { num: money(m.cached) }, { num: money(m.output) }]),
  );
  return [table, el('p', 'config-help', t('ai.pricesHelp', { date: p.asOf, free: nf.format(p.freeNeuronsPerDay) }))];
}

// -------------------------------------------------------------- users

async function users() {
  const s = listState.users;
  const params = new URLSearchParams({ limit: '50', offset: String(s.offset) });
  if (s.q) params.set('q', s.q);
  const d = await getJson(`/api/admin/users?${params}`);

  const toolbar = el('div', 'toolbar');
  const search = searchBox(t('users.search'), s.q, (q) => {
    s.q = q;
    s.offset = 0;
    route();
  });
  toolbar.append(search, downloadLink('/api/admin/export/users.csv', t('users.export')));

  if (d.users.length === 0) return [toolbar, note(t('users.empty'))];
  const table = dataTable(
    [t('users.email'), t('users.status'), { num: t('users.archived') }, { num: t('users.drafts') },
      t('users.created'), t('users.lastLogin'), t('users.lastWrite')],
    d.users.map((u) => [
      { clip: u.email },
      { pill: u.status === 'disabled' ? t('users.disabled') : t('users.active'), warn: u.status === 'disabled' },
      { num: nf.format(u.archived) }, { num: nf.format(u.drafts) },
      { muted: when(u.created_at) }, { muted: when(u.last_login_at) }, { muted: when(u.last_write) },
    ]),
    (i) => { location.hash = `#users/${d.users[i].id}`; },
  );
  return [toolbar, table, pager(d, (offset) => { s.offset = offset; route(); })];
}

async function userDetail(id) {
  const d = await getJson(`/api/admin/users/${encodeURIComponent(id)}`);
  const u = d.user;
  names.set(id, u.email);
  const box = el('div', 'detail');
  const head = el('div', 'detail-head');
  head.append(el('h2', 'detail-title', u.email), pill(u.status === 'disabled' ? t('users.disabled') : t('users.active'), u.status === 'disabled'));
  const aiTotal = (d.ai || []).reduce((sum, r) => ({ calls: sum.calls + (Number(r.calls) || 0), usd: sum.usd + (Number(r.usd) || 0) }), { calls: 0, usd: 0 });
  const wr = d.writing || {};
  box.append(head, kv([
    [t('users.created'), when(u.created_at)],
    [t('users.lastLogin'), when(u.last_login_at)],
    [t('users.sessions'), nf.format(d.sessions.length)],
    [t('users.documents'), nf.format(d.documents.length)],
    [t('users.writingDays'), wr.days ? t('users.writingDaysValue', { n: nf.format(wr.days), saves: nf.format(wr.saves || 0) }) : t('common.never')],
    [t('users.aiUsage'), t('users.aiUsageValue', { n: nf.format(aiTotal.calls), cost: money(aiTotal.usd) })],
  ]));

  const actions = el('div', 'detail-actions');
  const base = `/api/admin/users/${encodeURIComponent(id)}`;
  if (u.status === 'disabled') {
    actions.append(button(t('users.enable'), async () => { if (await act(`${base}/enable`)) route(); }));
  } else {
    actions.append(button(t('users.disable'), async () => {
      if (await act(`${base}/disable`, { confirmText: t('users.confirmDisable', { email: u.email }) })) route();
    }));
  }
  actions.append(button(t('users.signout'), async () => { if (await act(`${base}/signout`)) route(); }));
  actions.append(button(t('users.viewAi'), () => go('ai', new URLSearchParams({ user: id }))));
  actions.append(button(t('users.viewEvents'), () => go('events', new URLSearchParams({ user: id }))));
  actions.append(button(t('users.delete'), async () => {
    const ok = await act(base, { method: 'DELETE', confirmText: t('users.confirmDelete', { email: u.email, n: d.documents.length }) });
    if (ok) location.hash = '#users';
  }, 'danger'));
  box.append(actions);

  const docTable = d.documents.length
    ? dataTable(
      [t('docs.titleCol'), t('docs.status'), { num: t('docs.chars') }, t('docs.updated')],
      d.documents.map((doc) => [
        { clip: doc.title || t('docs.untitled') }, { pill: statusLabel(doc.status) },
        { num: nf.format(doc.chars || 0) }, { muted: when(doc.updated_at) },
      ]),
      (i) => { location.hash = `#documents/${d.documents[i].id}`; },
    )
    : note(t('docs.empty'));

  const aiTable = (d.ai || []).length
    ? dataTable([t('ai.feature'), { num: t('ai.calls') }, { num: t('ai.inputShort') }, { num: t('ai.outputShort') }, { num: t('ai.cost') }],
      d.ai.map((r) => [labelFrom('feature', r.feature), { num: nf.format(r.calls) }, { num: tokens(r.input) }, { num: tokens(r.output) }, { num: money(r.usd) }]))
    : note(t('ai.empty'));

  const settingsCard = el('div', 'detail');
  const pre = el('pre', 'meta-json', JSON.stringify(u.settings || {}, null, 2));
  settingsCard.append(pre);

  return [
    backLink('#users'), box,
    sectionTitle(t('users.documents')), docTable,
    sectionTitle(t('users.aiUsage')), aiTable,
    sectionTitle(t('users.events')), eventsTable(d.events),
    sectionTitle(t('users.settings')), settingsCard,
  ];
}

// ---------------------------------------------------------- documents

async function documents() {
  const s = listState.documents;
  const params = new URLSearchParams({ limit: '50', offset: String(s.offset) });
  if (s.q) params.set('q', s.q);
  if (s.status) params.set('status', s.status);
  if (s.owner) params.set('owner', s.owner);
  const d = await getJson(`/api/admin/documents?${params}`);

  const toolbar = el('div', 'toolbar');
  toolbar.append(
    searchBox(t('docs.search'), s.q, (q) => { s.q = q; s.offset = 0; route(); }),
    select([['', t('docs.allStatus')], ['draft', t('docs.draft')], ['processing', t('docs.processing')],
      ['archived', t('docs.archived')], ['deleted', t('docs.deleted')]], s.status, (v) => { s.status = v; s.offset = 0; route(); }),
    select([['', t('docs.allOwners')], ['anonymous', t('docs.ownerAnonymous')], ['legacy', t('docs.ownerLegacy')]],
      s.owner, (v) => { s.owner = v; s.offset = 0; route(); }),
    downloadLink('/api/admin/export/documents.csv', t('docs.export')),
  );

  if (d.documents.length === 0) return [toolbar, note(t('docs.empty'))];
  const table = dataTable(
    [t('docs.titleCol'), t('docs.owner'), t('docs.status'), { num: t('docs.chars') }, t('docs.updated')],
    d.documents.map((doc) => [
      { clip: doc.title || t('docs.untitled') },
      { clip: ownerLabel(doc) },
      { pill: statusLabel(doc.status) },
      { num: nf.format(doc.chars || 0) },
      { muted: when(doc.updated_at) },
    ]),
    (i) => { location.hash = `#documents/${d.documents[i].id}`; },
  );
  return [toolbar, table, pager(d, (offset) => { s.offset = offset; route(); })];
}

async function documentDetail(id) {
  const doc = await getJson(`/api/admin/documents/${encodeURIComponent(id)}`);
  names.set(id, doc.title || t('docs.untitled'));
  const box = el('div', 'detail');
  const head = el('div', 'detail-head');
  head.append(el('h2', 'detail-title', doc.title || t('docs.untitled')), pill(statusLabel(doc.status)));
  const aiCost = (doc.ai || []).reduce((sum, c) => sum + (Number(c.usd) || 0), 0);
  const meta = el('p', 'detail-meta', [ownerLabel(doc), doc.category, (doc.tags || []).map((tag) => `#${tag}`).join(' '), when(doc.updated_at),
    (doc.ai || []).length ? t('docs.aiCost', { n: nf.format(doc.ai.length), cost: money(aiCost) }) : '']
    .filter(Boolean).join(' · '));
  box.append(head, meta);

  const base = `/api/admin/documents/${encodeURIComponent(id)}`;
  const actions = el('div', 'detail-actions');
  if (doc.status !== 'deleted') {
    actions.append(button(t('docs.rerun'), async () => { if (await act(`${base}/rerun`)) route(); }));
    actions.append(button(t('docs.trash'), async () => { if (await act(`${base}/trash`)) route(); }));
  } else {
    actions.append(button(t('docs.restore'), async () => { if (await act(`${base}/restore`)) route(); }));
  }
  actions.append(button(t('docs.assign'), async () => {
    const email = prompt(t('docs.assignPrompt'));
    if (email && await act(`${base}/assign`, { body: { email } })) route();
  }));
  actions.append(button(t('docs.viewAi'), () => go('ai', new URLSearchParams({ doc: id }))));
  actions.append(button(t('docs.erase'), async () => {
    if (await act(base, { method: 'DELETE', confirmText: t('docs.confirmErase') })) location.hash = '#documents';
  }, 'danger'));
  box.append(actions);

  const out = [backLink('#documents'), box];
  if ((doc.ai || []).length) {
    out.push(sectionTitle(t('docs.aiCalls')), dataTable(
      [t('events.time'), t('ai.turn'), t('ai.model'), t('ai.status'), { num: t('ai.latency') }, { num: t('ai.inputShort') },
        { num: t('ai.cachedShort') }, { num: t('ai.outputShort') }, { num: t('ai.cost') }],
      doc.ai.map((c) => [
        { muted: when(c.ts) },
        c.turn ? nf.format(c.turn) : labelFrom('feature', c.feature),
        { clip: `${shortModel(c.model)}${c.fallback ? ` ${t('ai.fallbackMark')}` : ''}` },
        { pill: c.status === 'error' ? errorCodeLabel((String(c.error || '').match(/^(\d{4})/) || [])[1]) : labelFrom('callStatus', c.status), warn: c.status === 'error' },
        { num: latency(c.latency_ms) },
        { num: tokens(c.input_tokens) },
        { num: share(c.cached_tokens, c.input_tokens) },
        { num: tokens(c.output_tokens) },
        { num: c.usd === null ? t('common.na') : money(c.usd) },
      ]),
    ));
  }
  if (doc.formatted) out.push(sectionTitle(t('docs.formatted')), textBlock(doc.formatted));
  out.push(sectionTitle(t('docs.content')), textBlock(doc.content || ''));
  if ((doc.events || []).length) out.push(sectionTitle(t('docs.events')), eventsTable(doc.events));
  if (Array.isArray(doc.agent_trace) && doc.agent_trace.length) {
    out.push(sectionTitle(t('docs.trace')), textBlock(JSON.stringify(doc.agent_trace, null, 2), 'meta-json'));
  }
  return out;
}

function ownerLabel(doc) {
  if (doc.email) return doc.email;
  return doc.anonymous ? t('docs.anonymous') : t('docs.none');
}

function statusLabel(status) {
  const key = `status.${status}`;
  const label = t(key);
  return label === key ? status : label;
}

// ------------------------------------------------------------- events

// Grouped for the type picker; anything else the server reports is listed too.
const EVENT_GROUPS = [
  ['group.writing', ['doc_create', 'finalize', 'finalize_blocked', 'auto_archive', 'archived', 'archive_skipped', 'pipeline_reclaim',
    'reopen', 'trash', 'restore', 'erase', 'download', 'export', 'search', 'settings_change']],
  ['group.completion', ['completion_shown', 'completion_accept', 'completion_dismiss']],
  ['group.accounts', ['auth_prompt', 'auth_code_sent', 'auth_code_wrong', 'auth_locked', 'auth_refused', 'auth_email_failed', 'signup', 'login', 'logout']],
  ['group.health', ['server_error', 'client_error', 'not_found', 'rate_limited']],
  ['group.admin', ['admin', 'admin_login', 'admin_login_failed']],
];

async function events(params) {
  const fq = filterQuery(params, FILTER_KEYS.events);
  const before = cursors.events[cursors.events.length - 1];
  const d = await getJson(`/api/admin/events?${rangeQuery()}${fq ? `&${fq}` : ''}&limit=100${before ? `&before=${before}` : ''}`);
  for (const e of d.events) {
    if (e.user_id && e.email) names.set(e.user_id, e.email);
    if (e.doc_id && e.title) names.set(e.doc_id, e.title);
  }
  if (fq && currentRoute().tab === 'events') renderFilters('events', params);

  const counts = new Map(d.types.map((x) => [x.type, x.n]));
  const typeSelect = el('select');
  typeSelect.setAttribute('aria-label', t('events.type'));
  typeSelect.append(option('', t('events.all')));
  const known = new Set();
  for (const [group, types] of EVENT_GROUPS) {
    const og = el('optgroup');
    og.label = t(group);
    for (const type of types) {
      known.add(type);
      og.append(option(type, `${eventLabel(type)}${counts.has(type) ? ` (${nf.format(counts.get(type))})` : ''}`));
    }
    typeSelect.append(og);
  }
  const others = d.types.filter((x) => !known.has(x.type));
  if (others.length) {
    const og = el('optgroup');
    og.label = t('group.other');
    for (const x of others) og.append(option(x.type, `${eventLabel(x.type)} (${nf.format(x.n)})`));
    typeSelect.append(og);
  }
  typeSelect.value = params.get('type') || '';
  typeSelect.addEventListener('change', () => setFilter('type', typeSelect.value || null));

  const toolbar = el('div', 'toolbar');
  toolbar.append(
    searchBox(t('events.search'), params.get('q') || '', (q) => setFilter('q', q || null)),
    typeSelect,
    textFilter(t('events.userFilter'), params.get('user') && !/^[0-9a-f-]{36}$/i.test(params.get('user')) ? params.get('user') : '',
      (v) => setFilter('user', v || null)),
    downloadLink(`/api/admin/export/events.csv?${rangeQuery()}${fq ? `&${fq}` : ''}`, t('events.export')),
  );
  return [toolbar, eventsTable(d.events, { expandable: true }), cursorPager('events', d.next)];
}

function option(value, label) {
  const o = el('option', '', label);
  o.value = value;
  return o;
}

// A filter applied on Enter (or when the field is cleared).
function textFilter(placeholder, value, onApply) {
  const input = el('input', 'search narrow');
  input.type = 'search';
  input.placeholder = placeholder;
  input.value = value;
  input.autocomplete = 'off';
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') onApply(input.value.trim()); });
  input.addEventListener('search', () => { if (!input.value) onApply(''); });
  return input;
}

function eventsTable(list, { expandable = false } = {}) {
  if (!list || list.length === 0) return note(t('events.empty'));
  const wrap = el('div', 'table-wrap');
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of [t('events.time'), t('events.type'), t('events.user'), t('events.doc'), t('events.detail')]) hr.append(el('th', '', h));
  thead.append(hr);
  const tbody = el('tbody');
  for (const e of list) {
    const tr = el('tr', expandable ? 'clickable' : '');
    tr.append(
      el('td', 'muted', when(e.ts)),
      el('td', '', eventLabel(e.type)),
      clipCell(e.user_id ? e.email || e.user_id.slice(0, 8) : ''),
      clipCell(e.doc_id ? e.title || e.doc_id.slice(0, 8) : ''),
      clipCell(describe(e)),
    );
    tbody.append(tr);
    if (expandable) {
      tr.tabIndex = 0;
      tr.setAttribute('aria-expanded', 'false');
      const toggle = () => {
        const open = tr.getAttribute('aria-expanded') === 'true';
        if (open) {
          tr.nextSibling.remove();
          tr.setAttribute('aria-expanded', 'false');
          return;
        }
        const detail = el('tr', 'event-detail');
        const td = el('td');
        td.colSpan = 5;
        const pre = el('pre', 'meta-json', JSON.stringify(e, null, 2));
        const links = el('div', 'detail-actions');
        if (e.user_id) links.append(button(t('events.onlyUser'), () => setFilter('user', e.user_id)));
        if (e.doc_id) links.append(button(t('events.openDoc'), () => go('documents', new URLSearchParams(), e.doc_id)));
        if (e.doc_id) links.append(button(t('events.onlyDoc'), () => setFilter('doc', e.doc_id)));
        td.append(pre, links);
        detail.append(td);
        tr.after(detail);
        tr.setAttribute('aria-expanded', 'true');
      };
      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') toggle(); });
    }
  }
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function clipCell(text) {
  const td = el('td', 'clip', text);
  td.title = text;
  return td;
}

function eventLabel(type) {
  const key = `event.${type}`;
  const label = t(key);
  return label === key ? type : label;
}

function describe(e) {
  const parts = [];
  if (e.path) parts.push(e.path);
  if (e.referrer) parts.push(e.referrer);
  if (e.country) parts.push(e.country);
  if (e.device) parts.push(labelFrom('device', e.device));
  if (e.value !== null && e.value !== undefined) parts.push(`${t('events.value')} ${nf.format(e.value)}`);
  if (e.meta && typeof e.meta === 'object') {
    for (const [k, v] of Object.entries(e.meta)) {
      if (v === null || v === undefined || v === '' || v === false) continue;
      parts.push(v === true ? k : `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
  }
  return parts.join(' · ');
}

// ------------------------------------------------------------- config

const DEFAULT_FIELDS = [
  ['language', 'settings.language', [['auto', 'opt.auto'], ['zh', '中文'], ['en', 'English']]],
  ['fontSize', 'settings.fontSize', [['small', 'opt.small'], ['standard', 'opt.standard'], ['large', 'opt.large']]],
  ['theme', 'settings.theme', [['system', 'opt.system'], ['light', 'opt.light'], ['dark', 'opt.dark']]],
  ['completion', 'settings.completion', [[true, 'opt.on'], [false, 'opt.off']]],
  ['completionDelay', 'settings.completionDelay', [[300, 'opt.eager'], [700, 'opt.standard'], [1500, 'opt.relaxed']]],
  ['agentFormatting', 'settings.agentFormatting', [[true, 'opt.on'], [false, 'opt.off']]],
  ['idleArchiveMinutes', 'settings.idleArchive', [[0, 'opt.never'], [3, 3], [5, 5], [15, 15], [30, 30]]],
];

async function config() {
  const c = await getJson('/api/admin/config');

  const reg = el('div', 'detail');
  reg.append(configRow(t('config.registration'), t('config.registrationDesc'),
    segmented([['open', t('system.open')], ['closed', t('system.closed')]], c.registration, async (v) => {
      if (await act('/api/admin/config', { method: 'PUT', body: { registration: v } })) route();
    })));

  const defaults = el('div', 'detail');
  for (const [key, label, options] of DEFAULT_FIELDS) {
    defaults.append(configRow(tApp(label), '', segmented(
      options.map(([value, text]) => [value, typeof text === 'number' ? tApp('opt.minutes', { n: text }) : tApp(text)]),
      c.defaults[key],
      async (v) => { if (await act('/api/admin/config', { method: 'PUT', body: { defaults: { [key]: v } } })) route(); },
    )));
  }

  const email = el('div', 'detail');
  email.append(kv([
    [t('system.email'), c.email.configured ? t('system.ok') : t('system.missing')],
    [t('config.emailFrom'), c.email.from],
  ]), el('p', 'config-help', t('config.emailHelp')));

  const analytics = el('div', 'detail');
  analytics.append(kv([
    [t('system.analyticsSecret'), c.analyticsSecret ? t('system.ok') : t('system.missingSecret')],
    [t('system.cloudflare'), c.cloudflareAnalytics ? t('system.on') : t('system.off')],
    [t('system.rows'), Object.entries(c.rows || {}).map(([k, v]) => `${k} ${nf.format(v)}`).join(' · ')],
  ]), el('p', 'config-help', t('config.analyticsHelp')));

  const ops = el('div', 'detail');
  const opsActions = el('div', 'detail-actions');
  opsActions.style.marginTop = '0';
  opsActions.append(
    button(t('config.sweep'), async () => {
      const r = await act('/api/admin/sweep');
      if (r) toast(t('config.sweepDone', { n: r.launched || 0 }));
    }),
    downloadLink('/api/admin/export/users.csv', t('users.export')),
    downloadLink('/api/admin/export/documents.csv', t('docs.export')),
    downloadLink(`/api/admin/export/events.csv?days=90`, t('events.export')),
    downloadLink(`/api/admin/export/ai_calls.csv?days=90`, t('ai.export')),
  );
  ops.append(opsActions, kv([
    [t('system.version'), c.version],
    [t('system.semantic'), c.semantic ? t('system.on') : t('system.off')],
    [t('system.siteLock'), c.siteLock ? t('system.on') : t('system.off')],
  ]));

  return [
    sectionTitle(t('config.accounts')), reg,
    sectionTitle(t('config.defaults')), el('p', 'config-help', t('config.defaultsDesc')), defaults,
    sectionTitle(t('config.email')), email,
    sectionTitle(t('config.analytics')), analytics,
    sectionTitle(t('config.ops')), ops,
  ];
}

function configRow(name, desc, control) {
  const row = el('div', 'config-row');
  const label = el('div', 'setting-label');
  label.append(el('p', 'setting-name', name));
  if (desc) label.append(el('p', 'setting-desc', desc));
  row.append(label, control);
  return row;
}

function segmented(options, current, onPick) {
  const box = el('div', 'segmented');
  for (const [value, label] of options) {
    const b = el('button', 'segment', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(value === current));
    b.addEventListener('click', () => { if (value !== current) onPick(value); });
    box.append(b);
  }
  return box;
}

// ------------------------------------------------------------- pieces

function dataTable(headers, rows, onRow) {
  const wrap = el('div', 'table-wrap');
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of headers) {
    if (h && typeof h === 'object') hr.append(el('th', 'num', h.num));
    else hr.append(el('th', '', h));
  }
  thead.append(hr);
  const tbody = el('tbody');
  rows.forEach((cells, i) => {
    const tr = el('tr');
    if (onRow) {
      tr.className = 'clickable';
      tr.tabIndex = 0;
      tr.addEventListener('click', () => onRow(i));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') onRow(i); });
    }
    for (const cell of cells) {
      const td = el('td');
      if (cell && typeof cell === 'object') {
        if ('num' in cell) { td.className = 'num'; td.textContent = cell.num; }
        else if ('muted' in cell) { td.className = 'muted'; td.textContent = cell.muted; }
        else if ('clip' in cell) { td.className = 'clip'; td.textContent = cell.clip; td.title = cell.clip; }
        else if ('pill' in cell) td.append(pill(cell.pill, cell.warn));
        else if ('node' in cell) { td.className = 'num'; td.append(cell.node); }
      } else {
        td.textContent = cell ?? '';
      }
      tr.append(td);
    }
    tbody.append(tr);
  });
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function pager(d, goTo) {
  const box = el('div', 'pager');
  const from = d.total ? d.offset + 1 : 0;
  const to = Math.min(d.offset + d.limit, d.total);
  box.append(el('span', '', t('common.page', { from: nf.format(from), to: nf.format(to), total: nf.format(d.total) })));
  if (d.offset > 0) box.append(button(t('common.prev'), () => goTo(Math.max(0, d.offset - d.limit))));
  if (to < d.total) box.append(button(t('common.next'), () => goTo(d.offset + d.limit)));
  return box;
}

function searchBox(placeholder, value, onSearch) {
  const input = el('input', 'search');
  input.type = 'search';
  input.placeholder = placeholder;
  input.value = value;
  input.autocomplete = 'off';
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => onSearch(input.value.trim()), 400);
  });
  // Keep focus across the re-render the search triggers.
  queueMicrotask(() => { if (value) { input.focus(); input.setSelectionRange(value.length, value.length); } });
  return input;
}

function select(options, value, onChange) {
  const s = el('select');
  for (const [v, label] of options) {
    const o = option(v, label);
    if (v === value) o.selected = true;
    s.append(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function downloadLink(href, label) {
  const a = el('a', 'link-button', label);
  a.href = href;
  a.setAttribute('download', '');
  return a;
}

function button(label, onClick, extra = '') {
  const b = el('button', `link-button${extra ? ` ${extra}` : ''}`, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function pill(label, warn = false) {
  return el('span', `pill${warn ? ' warn' : ''}`, label);
}

function kv(pairs) {
  const dl = el('dl', 'kv');
  for (const [k, v] of pairs) dl.append(el('dt', '', k), el('dd', '', v ?? ''));
  return dl;
}

function textBlock(text, className = '') {
  const box = el('div', 'detail');
  box.append(el('pre', className, text));
  return box;
}

function backLink(href) {
  const a = el('a', 'back-link', `← ${t('common.back')}`);
  a.href = href;
  return a;
}

function sectionTitle(text) {
  return el('h2', 'admin-section-title', text);
}

function note(text) {
  return el('p', 'empty-note', text);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

// --------------------------------------------------------------- boot

(async () => {
  try {
    const res = await fetch('/api/admin/session', { headers: { Accept: 'application/json' } });
    const data = res.ok ? await res.json() : { ok: false };
    if (data.ok) showApp();
    else showLogin();
  } catch {
    showLogin();
  }
})();
