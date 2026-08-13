// Archive: everything the agent has filed away, grouped by category.

const CATEGORY_ORDER = ['随笔', '笔记', '工作', '灵感', '清单', '日记', '信件', '其他'];

const processingEl = document.getElementById('processing');
const groupsEl = document.getElementById('groups');
const emptyEl = document.getElementById('empty');
const lockedEl = document.getElementById('locked');

let pollTimer = null;

async function load() {
  let data;
  try {
    const res = await fetch('/api/documents?status=archived,processing');
    if (res.status === 401) {
      lockedEl.hidden = false;
      return;
    }
    if (!res.ok) throw new Error(`list ${res.status}`);
    data = await res.json();
  } catch {
    emptyEl.textContent = '暂时无法连接，稍后刷新试试。';
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

function renderProcessing(items) {
  processingEl.replaceChildren();
  processingEl.hidden = items.length === 0;
  for (const doc of items) {
    const card = el('div', 'card');
    const title = el('p', 'card-title');
    title.append(el('span', 'pending-dot'), text(doc.title || '未命名'));
    const summary = el('p', 'card-summary');
    summary.textContent = 'AI 正在整理这篇内容…';
    card.append(title, summary);
    processingEl.append(card);
  }
}

function renderGroups(docs) {
  groupsEl.replaceChildren();

  const groups = new Map();
  for (const doc of docs) {
    const cat = CATEGORY_ORDER.includes(doc.category) ? doc.category : '其他';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(doc);
  }

  for (const cat of CATEGORY_ORDER) {
    const items = groups.get(cat);
    if (!items || items.length === 0) continue;

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
  title.textContent = doc.title || '未命名';
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
  return new Intl.DateTimeFormat('zh-CN', {
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

load();
