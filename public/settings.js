// Settings live on the server (one row in D1) and are mirrored into
// localStorage so the editor and the reading pages can apply them before
// their first paint.
import { toast } from '/toast.js';

const FIELDS = [
  {
    group: '书写',
    key: 'fontSize',
    label: '正文字号',
    desc: '纸面与阅读页的正文大小',
    options: [['small', '小'], ['standard', '标准'], ['large', '大']],
  },
  {
    group: '书写',
    key: 'theme',
    label: '主题',
    desc: '默认跟随系统的浅色或深色',
    options: [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']],
  },
  {
    group: 'AI 辅助',
    key: 'completion',
    label: '输入联想',
    desc: '停顿时给出灰色的续写建议，Tab 采纳',
    options: [[true, '开'], [false, '关']],
  },
  {
    group: 'AI 辅助',
    key: 'completionDelay',
    label: '联想灵敏度',
    desc: '停顿多久之后给出建议',
    options: [[300, '灵敏'], [700, '标准'], [1500, '迟缓']],
  },
  {
    group: 'AI 辅助',
    key: 'agentFormatting',
    label: 'Agent 排版',
    desc: '归档时整理分段与列表。关闭后只做分类与摘要，原文一字不动',
    options: [[true, '开'], [false, '关']],
  },
  {
    group: '归档',
    key: 'idleArchiveMinutes',
    label: '静置自动归档',
    desc: '停笔多久后自动交给 Agent 整理',
    options: [[0, '关闭'], [3, '3 分钟'], [5, '5 分钟'], [15, '15 分钟'], [30, '30 分钟']],
  },
];

const fieldsEl = document.getElementById('fields');
const trashEl = document.getElementById('trash-list');
const trashCountEl = document.getElementById('trash-count');
const trashEmptyEl = document.getElementById('trash-empty');
const lockedEl = document.getElementById('locked');

let settings = {};

// --------------------------------------------------------------- render

function render() {
  fieldsEl.replaceChildren();
  let group = null;

  for (const field of FIELDS) {
    if (field.group !== group) {
      group = field.group;
      const head = el('h2', 'cat-head');
      head.append(text(group), el('span', 'rule'));
      fieldsEl.append(head);
    }

    const row = el('div', 'setting');
    const label = el('div', 'setting-label');
    const name = el('p', 'setting-name');
    name.textContent = field.label;
    const desc = el('p', 'setting-desc');
    desc.textContent = field.desc;
    label.append(name, desc);

    const group_ = el('div', 'segmented');
    for (const [value, text_] of field.options) {
      const button = el('button', 'segment');
      button.type = 'button';
      button.textContent = text_;
      const active = settings[field.key] === value;
      button.setAttribute('aria-pressed', String(active));
      button.addEventListener('click', () => save(field.key, value));
      group_.append(button);
    }

    row.append(label, group_);
    fieldsEl.append(row);
  }
}

async function save(key, value) {
  const previous = settings[key];
  if (previous === value) return;
  settings = { ...settings, [key]: value };
  cache();
  render();
  apply();

  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    });
    if (!res.ok) throw new Error(`settings ${res.status}`);
    settings = await res.json();
    cache();
    render();
    apply();
  } catch {
    settings = { ...settings, [key]: previous };
    cache();
    render();
    apply();
    toast('保存失败，已还原');
  }
}

function cache() {
  try {
    localStorage.setItem('writer.settings', JSON.stringify(settings));
  } catch {
    /* private mode: server copy is the source of truth anyway */
  }
}

function apply() {
  const root = document.documentElement;
  if (settings.theme === 'light' || settings.theme === 'dark') root.dataset.theme = settings.theme;
  else delete root.dataset.theme;
  root.dataset.size = settings.fontSize || 'standard';
}

// ---------------------------------------------------------------- trash

async function loadTrash() {
  let docs = [];
  try {
    const res = await fetch('/api/documents?status=deleted');
    if (res.status === 401) {
      lockedEl.hidden = false;
      return;
    }
    if (!res.ok) throw new Error(`trash ${res.status}`);
    docs = (await res.json()).documents || [];
  } catch {
    return;
  }

  trashEl.replaceChildren();
  trashCountEl.textContent = String(docs.length);
  trashEmptyEl.hidden = docs.length > 0;

  for (const doc of docs) {
    const card = el('div', 'card trash-card');
    const title = el('p', 'card-title');
    title.textContent = doc.title || '未命名';
    const foot = el('p', 'card-foot');
    foot.append(textSpan('date', `删除于 ${formatDate(doc.deleted_at)}`));

    const actions = el('span', 'card-actions');
    const restore = el('button', 'link-button');
    restore.type = 'button';
    restore.textContent = '恢复';
    restore.addEventListener('click', () => act(doc, 'restore'));
    const erase = el('button', 'link-button danger');
    erase.type = 'button';
    erase.textContent = '彻底删除';
    erase.addEventListener('click', () => act(doc, 'erase'));
    actions.append(restore, erase);
    foot.append(actions);

    card.append(title, foot);
    trashEl.append(card);
  }
}

async function act(doc, kind) {
  if (kind === 'erase' && !confirm(`彻底删除「${doc.title || '未命名'}」？无法撤销。`)) return;
  try {
    const res = kind === 'restore'
      ? await fetch(`/api/documents/${doc.id}/restore`, { method: 'POST' })
      : await fetch(`/api/documents/${doc.id}?permanent=1`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`${kind} ${res.status}`);
    toast(kind === 'restore' ? '已恢复到归档' : '已彻底删除');
    loadTrash();
  } catch {
    toast('操作失败，稍后再试');
  }
}

// ----------------------------------------------------------- helpers

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(d);
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

// ------------------------------------------------------------------ init

async function init() {
  try {
    const res = await fetch('/api/settings');
    if (res.status === 401) {
      lockedEl.hidden = false;
      return;
    }
    settings = await res.json();
  } catch {
    try {
      settings = JSON.parse(localStorage.getItem('writer.settings') || '{}');
    } catch {
      settings = {};
    }
    toast('暂时无法连接，显示的是本地缓存');
  }
  cache();
  render();
  apply();
  loadTrash();
}

init();
