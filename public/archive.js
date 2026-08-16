// Archive: everything the agent has filed away, grouped by the taxonomy
// the agent itself maintains. Plus keyword search over the file space.
import { toast, hideToast } from '/toast.js';
import { makeT, applyDom, resolveLang, locale } from '/i18n.js';
import { mountMenu } from '/menu.js';
import { redirectIfLocked } from '/locked.js';

function storedSettings() {
  try {
    return JSON.parse(localStorage.getItem('writer.settings') || '{}');
  } catch {
    return {};
  }
}

let lang = resolveLang(storedSettings().language, navigator.language);
let t = makeT(lang);

const processingEl = document.getElementById('processing');
const groupsEl = document.getElementById('groups');
const emptyEl = document.getElementById('empty');
const lockedEl = document.getElementById('locked');
const searchEl = document.getElementById('search');

let pollTimer = null;
let searchTimer = null;
let searchSeq = 0;

async function load() {
  let data;
  try {
    const res = await fetch('/api/documents?status=archived,processing');
    if (await redirectIfLocked(res)) return;
    if (res.status === 401) { lockedEl.hidden = false; return; }
    if (!res.ok) throw new Error(`list ${res.status}`);
    data = await res.json();
  } catch {
    emptyEl.textContent = t('common.offline');
    emptyEl.hidden = false;
    return;
  }

  const docs = data.documents || [];
  const processing = docs.filter((d) => d.status === 'processing');
  const archived = docs.filter((d) => d.status === 'archived');

  renderProcessing(processing);
  renderGroups(archived);
  emptyEl.hidden = docs.length > 0;

  clearTimeout(pollTimer);
  if (processing.length > 0) pollTimer = setTimeout(load, 4000);
}

async function search(q) {
  const seq = ++searchSeq;
  if (!q) return load();
  let data;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    if (await redirectIfLocked(res)) return;
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  if (seq !== searchSeq) return;

  clearTimeout(pollTimer);
  processingEl.hidden = true;
  groupsEl.replaceChildren();
  const docs = data.documents || [];

  if (docs.length === 0) {
    emptyEl.textContent = t('archive.noResults');
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  const head = el('h2', 'cat-head');
  head.append(text(t('archive.results')), el('span', 'rule'), textSpan('count', String(docs.length)));
  groupsEl.append(head);
  for (const doc of docs) groupsEl.append(card(doc));
}

searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => search(searchEl.value.trim()), 250);
});

function renderProcessing(items) {
  processingEl.replaceChildren();
  processingEl.hidden = items.length === 0;
  for (const doc of items) {
    const cardEl = el('div', 'card');
    const title = el('p', 'card-title');
    title.append(el('span', 'pending-dot'), text(doc.title || t('common.untitled')));
    const summary = el('p', 'card-summary');
    summary.textContent = t('archive.processing');
    cardEl.append(title, summary);
    processingEl.append(cardEl);
  }
}

// Group by the agent's own categories: largest groups first, 其他 last.
function renderGroups(docs) {
  groupsEl.replaceChildren();

  const groups = new Map();
  for (const doc of docs) {
    const cat = doc.category || '其他';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(doc);
  }

  const order = [...groups.keys()].sort((a, b) => {
    if (a === '其他') return 1;
    if (b === '其他') return -1;
    return groups.get(b).length - groups.get(a).length;
  });

  for (const cat of order) {
    const items = groups.get(cat);
    const head = el('h2', 'cat-head');
    head.append(text(cat), el('span', 'rule'), textSpan('count', String(items.length)));
    groupsEl.append(head);
    for (const doc of items) groupsEl.append(card(doc));
  }
}

function card(doc) {
  const a = el('a', 'card');
  a.href = `/d/${encodeURIComponent(doc.id)}`;

  const title = el('p', 'card-title');
  title.textContent = doc.title || t('common.untitled');
  a.append(title);

  if (doc.summary) {
    const summary = el('p', 'card-summary');
    summary.textContent = doc.summary;
    a.append(summary);
  }

  const foot = el('p', 'card-foot');
  for (const tag of doc.tags || []) foot.append(textSpan('tag', tag));
  foot.append(textSpan('date', formatDate(doc.archived_at || doc.updated_at)));
  a.append(foot);

  return a;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale(lang), {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'long',
    day: 'numeric',
  }).format(d);
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function text(s) {
  return document.createTextNode(s);
}

function textSpan(className, s) {
  const span = el('span', className);
  span.textContent = s;
  return span;
}

// Arriving here right after a delete: offer to undo it.
function offerUndo() {
  const id = sessionStorage.getItem('writer.justDeleted');
  if (!id) return;
  sessionStorage.removeItem('writer.justDeleted');

  const el_ = toast(t('archive.toastDeleted'), { duration: 8000 });
  el_?.querySelector('#undo')?.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/documents/${id}/restore`, { method: 'POST' });
      if (await redirectIfLocked(res)) return;
      if (!res.ok) throw new Error(`restore ${res.status}`);
      hideToast();
      load();
    } catch {
      toast(t('archive.toastRestoreFailed'));
    }
  });
}

// The stored copy paints first; the server copy is authoritative.
async function syncLang() {
  try {
    const res = await fetch('/api/settings');
    if (await redirectIfLocked(res)) return;
    if (!res.ok) return;
    const settings = await res.json();
    localStorage.setItem('writer.settings', JSON.stringify(settings));
    const next = resolveLang(settings.language, navigator.language);
    if (next === lang) return;
    lang = next;
    t = makeT(lang);
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    applyDom(document, t);
    mountMenu(t);
    load();
  } catch {
    /* offline: the cached language stands */
  }
}

applyDom(document, t);
mountMenu(t);
document.title = `${t('archive.title')} · Writer`;
load();
offerUndo();
syncLang();
