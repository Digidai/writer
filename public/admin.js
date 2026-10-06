// The admin console. Hash routes: #overview, #traffic, #users[/id],
// #documents[/id], #events, #config. Every value from the server is
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
const pct = new Intl.NumberFormat(loc, { style: 'percent', maximumFractionDigits: 0 });
const dayFmt = new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const timeFmt = new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const regionName = (() => {
  try {
    return new Intl.DisplayNames([loc], { type: 'region' });
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
const rangeEl = $('range');
const contentEl = $('content');
const tooltipEl = $('tooltip');

const TABS = ['overview', 'traffic', 'users', 'documents', 'events', 'config'];
const RANGES = [7, 30, 90];
let range = readRange();
const listState = {
  users: { q: '', offset: 0 },
  documents: { q: '', status: '', owner: '', offset: 0 },
  events: { type: '', before: [] },
};

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
  const [tab, id] = location.hash.replace(/^#\/?/, '').split('/');
  return { tab: TABS.includes(tab) ? tab : 'overview', id: id || null };
}

function renderTabs(active) {
  tabsEl.replaceChildren(...TABS.map((tab) => {
    const a = el('a');
    a.href = `#${tab}`;
    a.textContent = t(`tab.${tab}`);
    if (tab === active) a.setAttribute('aria-current', 'page');
    return a;
  }));
}

function renderRange() {
  rangeEl.setAttribute('aria-label', t('range.label'));
  rangeEl.replaceChildren(...RANGES.map((n) => {
    const b = el('button', 'segment');
    b.type = 'button';
    b.textContent = t(`range.${n}`);
    b.setAttribute('aria-pressed', String(n === range));
    b.addEventListener('click', () => {
      if (n === range) return;
      range = n;
      try {
        localStorage.setItem('writer.admin.range', String(n));
      } catch {
        /* fine */
      }
      route();
    });
    return b;
  }));
}

function readRange() {
  try {
    const n = Number(localStorage.getItem('writer.admin.range'));
    return RANGES.includes(n) ? n : 30;
  } catch {
    return 30;
  }
}

let routeSeq = 0;
async function route() {
  if (appView.hidden) return;
  const seq = ++routeSeq;
  const { tab, id } = currentRoute();
  renderTabs(tab);
  filtersEl.hidden = !((tab === 'overview' || tab === 'traffic') && !id);
  renderRange();
  hideTooltip();
  // Refetch keeps the frame: dim the old render instead of blanking it.
  contentEl.classList.add('refreshing');
  try {
    let view;
    if (tab === 'overview') view = await overview();
    else if (tab === 'traffic') view = await traffic();
    else if (tab === 'users') view = id ? await userDetail(id) : await users();
    else if (tab === 'documents') view = id ? await documentDetail(id) : await documents();
    else if (tab === 'events') view = await events();
    else view = await config();
    if (seq === routeSeq) contentEl.replaceChildren(...[].concat(view));
  } catch (err) {
    if (!(err instanceof AdminRequired) && seq === routeSeq) {
      contentEl.replaceChildren(note(t('action.failed')));
    }
  } finally {
    if (seq === routeSeq) contentEl.classList.remove('refreshing');
  }
}

window.addEventListener('hashchange', route);

// ----------------------------------------------------------- overview

async function overview() {
  const d = await getJson(`/api/admin/overview?days=${range}`);
  const kpis = el('div', 'kpis');
  kpis.append(
    kpi(t('kpi.pageviews'), num(d.traffic.pageviews)),
    kpi(t('kpi.visitors'), num(d.traffic.visitors), t('kpi.visitorsNote')),
    kpi(t('kpi.signups'), num(d.accounts.signups)),
    kpi(t('kpi.activeWriters'), num(d.accounts.activeWriters)),
    kpi(t('kpi.docsCreated'), num(d.writing.docsCreated)),
    kpi(t('kpi.archived'), num(d.writing.archived)),
    kpi(t('kpi.completions'), num(d.ai.completions)),
    kpi(t('kpi.acceptRate'), pct.format(d.ai.acceptRate || 0),
      t('kpi.acceptRateNote', { accepts: nf.format(d.ai.accepts), suggested: nf.format(d.ai.suggested) })),
    kpi(t('kpi.users'), num(d.accounts.users), d.accounts.disabled ? t('kpi.usersNote', { n: d.accounts.disabled }) : ''),
    kpi(t('kpi.fallback'), num(d.ai.fallback), d.ai.heuristic ? t('kpi.fallbackNote', { heuristic: d.ai.heuristic }) : ''),
  );

  const charts = el('div', 'charts');
  charts.append(
    columnChart(t('chart.pageviews'), d.daily, 'pageviews'),
    columnChart(t('chart.visitors'), d.daily, 'visitors'),
    columnChart(t('chart.signups'), d.daily, 'signups'),
    columnChart(t('chart.archived'), d.daily, 'archived'),
  );

  const docs = el('div', 'kpis');
  const w = d.writing;
  docs.append(
    kpi(t('docs.draft'), num(w.documents.draft)),
    kpi(t('docs.processing'), num(w.documents.processing)),
    kpi(t('docs.archived'), num(w.documents.archived)),
    kpi(t('docs.deleted'), num(w.documents.deleted)),
    kpi(t('docs.anonDrafts'), num(w.anonDrafts)),
    kpi(t('docs.legacy'), num(w.legacy)),
    kpi(t('docs.stuck'), num(w.stuck)),
  );

  const s = d.system;
  const system = kv([
    [t('system.version'), s.version],
    [t('system.email'), s.email ? t('system.ok') : t('system.missing')],
    [t('system.registration'), s.registration === 'closed' ? t('system.closed') : t('system.open')],
    [t('system.semantic'), s.semantic ? t('system.on') : t('system.off')],
    [t('system.siteLock'), s.siteLock ? t('system.on') : t('system.off')],
  ]);
  const systemCard = el('div', 'detail');
  systemCard.append(system);

  return [
    kpis,
    sectionTitle(t('tab.traffic')), charts,
    sectionTitle(t('docs.title')), docs,
    sectionTitle(t('system.title')), systemCard,
  ];
}

function kpi(label, value, noteText = '') {
  const box = el('div', 'kpi');
  const l = el('p', 'kpi-label');
  l.textContent = label;
  const v = el('p', 'kpi-value');
  v.textContent = value;
  box.append(l, v);
  if (noteText) {
    const n = el('p', 'kpi-note');
    n.textContent = noteText;
    box.append(n);
  }
  return box;
}

function num(n) {
  const v = Number(n) || 0;
  return v >= 100000 ? new Intl.NumberFormat(loc, { notation: 'compact' }).format(v) : nf.format(v);
}

// One series per chart (small multiples), so there is never a legend to
// decode: the title names the series. Muted bars, today in the accent.
function columnChart(title, series, key) {
  const card = el('section', 'chart');
  const head = el('div', 'chart-head');
  const h = el('h3', 'chart-title');
  h.textContent = title;
  const values = series.map((row) => Number(row[key]) || 0);
  const last = values[values.length - 1] || 0;
  const callout = el('span', 'chart-callout');
  callout.textContent = t('chart.today', { n: nf.format(last) });
  head.append(h, callout);

  const max = niceMax(Math.max(0, ...values));
  const plot = el('div', 'plot');
  for (const tick of ticks(max)) {
    const line = el('div', 'plot-grid');
    line.style.bottom = `${(tick / max) * 100}%`;
    const label = el('span');
    label.textContent = nf.format(tick);
    line.append(label);
    plot.append(line);
  }
  const cols = el('div', 'plot-cols');
  series.forEach((row, i) => {
    const value = values[i];
    const col = el('div', `plot-col${value === 0 ? ' zero' : ''}${i === series.length - 1 ? ' emphasis' : ''}`);
    col.tabIndex = 0;
    const date = dayFmt.format(new Date(`${row.day}T00:00:00Z`));
    col.setAttribute('aria-label', `${date}: ${nf.format(value)}`);
    const bar = el('span', 'plot-bar');
    bar.style.setProperty('--h', `${max ? (value / max) * 100 : 0}%`);
    col.append(bar);
    const show = (x, y) => showTooltip(nf.format(value), date, x, y);
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
  const first = series[0];
  const end = series[series.length - 1];
  for (const row of [first, end]) {
    const span = el('span');
    span.textContent = row ? dayFmt.format(new Date(`${row.day}T00:00:00Z`)) : '';
    x.append(span);
  }

  // The table twin: every value reachable without hovering.
  const details = el('details');
  const summary = el('summary');
  summary.textContent = t('chart.table');
  const table = dataTable([t('chart.day'), t('chart.value')], series.map((row, i) => [
    dayFmt.format(new Date(`${row.day}T00:00:00Z`)), { num: nf.format(values[i]) },
  ]).reverse());
  details.append(summary, table);

  card.append(head, plot, x, details);
  return card;
}

// Round up to 1, 2 or 5 times a power of ten, so ticks are clean numbers.
export function niceMax(v) {
  if (v <= 0) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) {
    if (v <= m * pow) return Math.max(m * pow, 4);
  }
  return 10 * pow;
}

function ticks(max) {
  const mid = max / 2;
  return Number.isInteger(mid) ? [0, mid, max] : [0, max];
}

function showTooltip(value, label, x, y) {
  tooltipEl.replaceChildren();
  const strong = el('strong');
  strong.textContent = value;
  tooltipEl.append(strong, document.createTextNode(label));
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

// ------------------------------------------------------------ traffic

async function traffic() {
  const d = await getJson(`/api/admin/traffic?days=${range}`);
  const total = d.paths.reduce((sum, row) => sum + row.views, 0);
  if (total === 0) return note(t('traffic.empty'));
  const grid = el('div', 'ranks');
  grid.append(
    rankList(t('traffic.paths'), d.paths, (k) => k || '/'),
    rankList(t('traffic.referrers'), d.referrers, (k) => k || t('traffic.direct')),
    rankList(t('traffic.countries'), d.countries, (k) => (k ? countryName(k) : t('traffic.unknown'))),
    rankList(t('traffic.devices'), d.devices, (k) => (k ? t(`device.${k}`) : t('traffic.unknown'))),
  );
  return grid;
}

function rankList(title, rows, label) {
  const box = el('section', 'rank');
  const h = el('h3');
  h.textContent = title;
  box.append(h);
  const max = Math.max(1, ...rows.map((r) => r.views));
  for (const row of rows) {
    const item = el('div', 'rank-row');
    const key = el('span', 'rank-key');
    key.textContent = label(row.key);
    key.title = key.textContent;
    const val = el('span', 'rank-val');
    val.textContent = `${nf.format(row.views)} · ${nf.format(row.visitors)}`;
    val.title = `${t('traffic.views')} · ${t('traffic.visitors')}`;
    const bar = el('span', 'rank-bar');
    bar.style.setProperty('--w', `${(row.views / max) * 100}%`);
    item.append(key, val, bar);
    box.append(item);
  }
  if (rows.length === 0) box.append(note(t('traffic.empty')));
  return box;
}

function countryName(code) {
  try {
    return (regionName && regionName.of(code)) || code;
  } catch {
    return code;
  }
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
  const box = el('div', 'detail');
  const head = el('div', 'detail-head');
  const title = el('h2', 'detail-title');
  title.textContent = u.email;
  head.append(title, pill(u.status === 'disabled' ? t('users.disabled') : t('users.active'), u.status === 'disabled'));
  box.append(head, kv([
    [t('users.created'), when(u.created_at)],
    [t('users.lastLogin'), when(u.last_login_at)],
    [t('users.sessions'), nf.format(d.sessions.length)],
    [t('users.documents'), nf.format(d.documents.length)],
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

  const settingsCard = el('div', 'detail');
  const pre = el('pre', 'meta-json');
  pre.textContent = JSON.stringify(u.settings || {}, null, 2);
  settingsCard.append(pre);

  return [
    backLink('#users'), box,
    sectionTitle(t('users.documents')), docTable,
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
  const box = el('div', 'detail');
  const head = el('div', 'detail-head');
  const title = el('h2', 'detail-title');
  title.textContent = doc.title || t('docs.untitled');
  head.append(title, pill(statusLabel(doc.status)));
  const meta = el('p', 'detail-meta');
  meta.textContent = [ownerLabel(doc), doc.category, (doc.tags || []).map((tag) => `#${tag}`).join(' '), when(doc.updated_at)]
    .filter(Boolean).join(' · ');
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
  actions.append(button(t('docs.erase'), async () => {
    if (await act(base, { method: 'DELETE', confirmText: t('docs.confirmErase') })) location.hash = '#documents';
  }, 'danger'));
  box.append(actions);

  const out = [backLink('#documents'), box];
  if (doc.formatted) out.push(sectionTitle(t('docs.formatted')), textBlock(doc.formatted));
  out.push(sectionTitle(t('docs.content')), textBlock(doc.content || ''));
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

const EVENT_TYPES = ['signup', 'login', 'doc_create', 'finalize', 'archived', 'completion', 'completion_accept',
  'reopen', 'trash', 'erase', 'export', 'auth_code_sent', 'auth_email_failed', 'admin', 'admin_login',
  'admin_login_failed', 'pageview'];

async function events() {
  const s = listState.events;
  const params = new URLSearchParams({ limit: '100' });
  if (s.type) params.set('type', s.type);
  const before = s.before[s.before.length - 1];
  if (before) params.set('before', String(before));
  const d = await getJson(`/api/admin/events?${params}`);

  const toolbar = el('div', 'toolbar');
  toolbar.append(select([['', t('events.all')], ...EVENT_TYPES.map((type) => [type, eventLabel(type)])], s.type, (v) => {
    s.type = v;
    s.before = [];
    route();
  }));
  const out = [toolbar, eventsTable(d.events)];
  const nav = el('div', 'pager');
  if (s.before.length) nav.append(button(t('common.prev'), () => { s.before.pop(); route(); }));
  if (d.next) nav.append(button(t('events.more'), () => { s.before.push(d.next); route(); }));
  if (nav.childElementCount) out.push(nav);
  return out;
}

function eventsTable(list) {
  if (!list || list.length === 0) return note(t('events.empty'));
  return dataTable(
    [t('events.time'), t('events.type'), t('events.user'), t('events.detail')],
    list.map((e) => [
      { muted: when(e.ts) },
      eventLabel(e.type),
      { clip: e.email || '' },
      { clip: describe(e) },
    ]),
  );
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
  if (e.device) parts.push(e.device);
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
  ]));
  const help = el('p', 'config-help');
  help.textContent = t('config.emailHelp');
  email.append(help);

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
  );
  ops.append(opsActions, kv([
    [t('system.version'), c.version],
    [t('system.semantic'), c.semantic ? t('system.on') : t('system.off')],
    [t('system.siteLock'), c.siteLock ? t('system.on') : t('system.off')],
  ]));

  const subtitle = el('p', 'config-help');
  subtitle.textContent = t('config.defaultsDesc');
  return [
    sectionTitle(t('config.accounts')), reg,
    sectionTitle(t('config.defaults')), subtitle, defaults,
    sectionTitle(t('config.email')), email,
    sectionTitle(t('config.ops')), ops,
  ];
}

function configRow(name, desc, control) {
  const row = el('div', 'config-row');
  const label = el('div', 'setting-label');
  const n = el('p', 'setting-name');
  n.textContent = name;
  label.append(n);
  if (desc) {
    const d = el('p', 'setting-desc');
    d.textContent = desc;
    label.append(d);
  }
  row.append(label, control);
  return row;
}

function segmented(options, current, onPick) {
  const box = el('div', 'segmented');
  for (const [value, label] of options) {
    const b = el('button', 'segment');
    b.type = 'button';
    b.textContent = label;
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
    const th = el('th');
    if (h && typeof h === 'object') {
      th.className = 'num';
      th.textContent = h.num;
    } else {
      th.textContent = h;
    }
    hr.append(th);
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

function pager(d, go) {
  const box = el('div', 'pager');
  const from = d.total ? d.offset + 1 : 0;
  const to = Math.min(d.offset + d.limit, d.total);
  const label = el('span');
  label.textContent = t('common.page', { from: nf.format(from), to: nf.format(to), total: nf.format(d.total) });
  box.append(label);
  if (d.offset > 0) box.append(button(t('common.prev'), () => go(Math.max(0, d.offset - d.limit))));
  if (to < d.total) box.append(button(t('common.next'), () => go(d.offset + d.limit)));
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
    timer = setTimeout(() => onSearch(input.value.trim()), 300);
  });
  // Keep focus across the re-render the search triggers.
  queueMicrotask(() => { if (value) { input.focus(); input.setSelectionRange(value.length, value.length); } });
  return input;
}

function select(options, value, onChange) {
  const s = el('select');
  for (const [v, label] of options) {
    const o = el('option');
    o.value = v;
    o.textContent = label;
    if (v === value) o.selected = true;
    s.append(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function downloadLink(href, label) {
  const a = el('a', 'link-button');
  a.href = href;
  a.textContent = label;
  a.setAttribute('download', '');
  return a;
}

function button(label, onClick, extra = '') {
  const b = el('button', `link-button${extra ? ` ${extra}` : ''}`);
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function pill(label, warn = false) {
  const span = el('span', `pill${warn ? ' warn' : ''}`);
  span.textContent = label;
  return span;
}

function kv(pairs) {
  const dl = el('dl', 'kv');
  for (const [k, v] of pairs) {
    const dt = el('dt');
    dt.textContent = k;
    const dd = el('dd');
    dd.textContent = v ?? '';
    dl.append(dt, dd);
  }
  return dl;
}

function textBlock(text, className = '') {
  const pre = el('pre', className);
  pre.textContent = text;
  const box = el('div', 'detail');
  box.append(pre);
  return box;
}

function backLink(href) {
  const a = el('a', 'back-link');
  a.href = href;
  a.textContent = `← ${t('common.back')}`;
  return a;
}

function sectionTitle(text) {
  const h = el('h2', 'admin-section-title');
  h.textContent = text;
  return h;
}

function note(text) {
  const p = el('p', 'empty-note');
  p.textContent = text;
  return p;
}

function when(iso) {
  if (!iso) return t('common.never');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : timeFmt.format(d);
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
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
