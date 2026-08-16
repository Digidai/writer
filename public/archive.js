// Archive: everything the agent has filed away, grouped by the taxonomy
// the agent itself maintains. Plus keyword search over the file space.
import { toast, hideToast } from '/toast.js';
import { makeT, applyDom, resolveLang, locale } from '/i18n.js';
import { mountMenu } from '/menu.js';
import { redirectIfLocked } from '/locked.js';

function storedSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem('writer.settings') || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

let settings = storedSettings();
let lang = resolveLang(settings.language, navigator.language);
let t = makeT(lang);

const processingEl = document.getElementById('processing');
const groupsEl = document.getElementById('groups');
const emptyEl = document.getElementById('empty');
const lockedEl = document.getElementById('locked');
const searchEl = document.getElementById('search');
const exportBtn = document.getElementById('export-all');
const searchModeEl = document.getElementById('search-mode');
const searchModeButtons = Array.from(document.querySelectorAll('.search-mode-button'));

let pollTimer = null;
let searchTimer = null;
let searchSeq = 0;
let searchMode = 'keyword';
let lockedFeatures = false;

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
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&mode=${encodeURIComponent(searchMode)}`);
    if (await redirectIfLocked(res)) return;
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  if (seq !== searchSeq) return;
  if (searchMode === 'semantic' && data && data.mode === 'keyword' && data.fallback) {
    toast(t('archive.semanticFallback'));
    setSearchMode('keyword');
  }

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

function setSearchMode(mode) {
  searchMode = mode === 'semantic' ? 'semantic' : 'keyword';
  for (const button of searchModeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === searchMode));
  }
}

for (const button of searchModeButtons) {
  button.addEventListener('click', () => {
    setSearchMode(button.dataset.mode);
    const q = searchEl.value.trim();
    if (q) search(q);
  });
}

async function detectLockedFeatures() {
  if (!exportBtn || !searchModeEl) return;
  try {
    const res = await fetch('/api/export', { method: 'HEAD' });
    if (await redirectIfLocked(res)) return;
    lockedFeatures = res.status === 204;
  } catch {
    lockedFeatures = false;
  }
  exportBtn.hidden = !lockedFeatures;
  searchModeEl.hidden = !lockedFeatures;
  if (!lockedFeatures) setSearchMode('keyword');
}

function parseFilename(contentDisposition) {
  const raw = String(contentDisposition || '');
  const utf8 = raw.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8 && utf8[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      /* ignore malformed filename */
    }
  }
  const plain = raw.match(/filename="([^"]+)"/i) || raw.match(/filename=([^;]+)/i);
  return plain && plain[1] ? plain[1].trim() : 'writer-archive.zip';
}

async function exportArchive() {
  if (!exportBtn) return;
  exportBtn.disabled = true;
  try {
    const res = await fetch('/api/export');
    if (await redirectIfLocked(res)) return;
    if (res.status === 403 || res.status === 404) {
      exportBtn.hidden = true;
      toast(t('archive.exportUnavailable'));
      return;
    }
    if (res.status === 413) {
      toast(t('archive.exportTooLarge'));
      return;
    }
    if (!res.ok) {
      toast(t('archive.exportFailed'));
      return;
    }
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = parseFilename(res.headers.get('Content-Disposition'));
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  } catch {
    toast(t('archive.exportFailed'));
  } finally {
    exportBtn.disabled = false;
  }
}
exportBtn?.addEventListener('click', exportArchive);

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

function prefsChanged(next) {
  if (!next || typeof next !== 'object') return false;
  return ['language', 'theme', 'fontSize'].some(
    (key) => Object.prototype.hasOwnProperty.call(next, key) && next[key] !== settings[key]
  );
}

function applyPrefs(next = {}) {
  settings = { ...settings, ...next };
  const root = document.documentElement;
  if (settings.theme === 'light' || settings.theme === 'dark') root.dataset.theme = settings.theme;
  else delete root.dataset.theme;
  root.dataset.size = settings.fontSize || 'standard';

  lang = resolveLang(settings.language, navigator.language);
  t = makeT(lang);
  root.lang = lang === 'en' ? 'en' : 'zh-CN';
  applyDom(document, t);
  root.dataset.i18nReady = 'true';
  mountMenu(t);
  document.title = `${t('archive.title')} · Writer`;
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
async function syncPrefs() {
  try {
    const res = await fetch('/api/settings');
    if (await redirectIfLocked(res)) return;
    if (!res.ok) return;
    const server = await res.json();
    if (prefsChanged(server)) {
      applyPrefs(server);
      load();
    }
    try {
      localStorage.setItem('writer.settings', JSON.stringify(server));
    } catch {
      /* private mode: keep running from memory */
    }
  } catch {
    /* offline: the cached language stands */
  }
}

applyPrefs();
setSearchMode('keyword');
load();
offerUndo();
syncPrefs();
detectLockedFeatures();
