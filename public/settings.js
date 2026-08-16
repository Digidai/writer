// Settings live on the server (one row in D1) and are mirrored into
// localStorage so the editor and the reading pages can apply them before
// their first paint.
import { toast } from '/toast.js';
import { makeT, applyDom, resolveLang, locale } from '/i18n.js';
import { mountMenu } from '/menu.js';
import { redirectIfLocked } from '/locked.js';

const FIELDS = [
  {
    group: 'settings.groupWriting',
    key: 'language',
    label: 'settings.language',
    desc: 'settings.languageDesc',
    options: [['auto', 'opt.auto'], ['zh', '中文'], ['en', 'English']],
  },
  {
    group: 'settings.groupWriting',
    key: 'fontSize',
    label: 'settings.fontSize',
    desc: 'settings.fontSizeDesc',
    options: [['small', 'opt.small'], ['standard', 'opt.standard'], ['large', 'opt.large']],
  },
  {
    group: 'settings.groupWriting',
    key: 'theme',
    label: 'settings.theme',
    desc: 'settings.themeDesc',
    options: [['system', 'opt.system'], ['light', 'opt.light'], ['dark', 'opt.dark']],
  },
  {
    group: 'settings.groupAI',
    key: 'completion',
    label: 'settings.completion',
    desc: 'settings.completionDesc',
    options: [[true, 'opt.on'], [false, 'opt.off']],
  },
  {
    group: 'settings.groupAI',
    key: 'completionDelay',
    label: 'settings.completionDelay',
    desc: 'settings.completionDelayDesc',
    options: [[300, 'opt.eager'], [700, 'opt.standard'], [1500, 'opt.relaxed']],
  },
  {
    group: 'settings.groupAI',
    key: 'agentFormatting',
    label: 'settings.agentFormatting',
    desc: 'settings.agentFormattingDesc',
    options: [[true, 'opt.on'], [false, 'opt.off']],
  },
  {
    group: 'settings.groupArchive',
    key: 'idleArchiveMinutes',
    label: 'settings.idleArchive',
    desc: 'settings.idleArchiveDesc',
    options: [[0, 'opt.never'], [3, 3], [5, 5], [15, 15], [30, 30]],
  },
];

const fieldsEl = document.getElementById('fields');
const trashEl = document.getElementById('trash-list');
const trashCountEl = document.getElementById('trash-count');
const trashEmptyEl = document.getElementById('trash-empty');
const lockedEl = document.getElementById('locked');

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

// --------------------------------------------------------------- render

function optionLabel(value) {
  return typeof value === 'number' ? t('opt.minutes', { n: value }) : t(value);
}

function render() {
  fieldsEl.replaceChildren();
  let group = null;

  for (const field of FIELDS) {
    if (field.group !== group) {
      group = field.group;
      const head = el('h2', 'cat-head');
      head.append(text(t(group)), el('span', 'rule'));
      fieldsEl.append(head);
    }

    const row = el('div', 'setting');
    const label = el('div', 'setting-label');
    const name = el('p', 'setting-name');
    name.textContent = t(field.label);
    const desc = el('p', 'setting-desc');
    desc.textContent = t(field.desc);
    label.append(name, desc);

    const choices = el('div', 'segmented');
    for (const [value, labelKey] of field.options) {
      const button = el('button', 'segment');
      button.type = 'button';
      button.textContent = optionLabel(labelKey);
      button.setAttribute('aria-pressed', String(settings[field.key] === value));
      button.addEventListener('click', () => save(field.key, value));
      choices.append(button);
    }

    row.append(label, choices);
    fieldsEl.append(row);
  }
}

async function save(key, value) {
  const previous = settings[key];
  if (previous === value) return;
  settings = { ...settings, [key]: value };
  applyAll();

  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    });
    if (await redirectIfLocked(res)) return;
    if (res.status === 403) throw new Error('demo-read-only');
    if (!res.ok) throw new Error(`settings ${res.status}`);
    settings = await res.json();
    applyAll();
  } catch (err) {
    settings = { ...settings, [key]: previous };
    applyAll();
    toast(t(err && err.message === 'demo-read-only' ? 'settings.toastReadOnlyDemo' : 'settings.toastSaveFailed'));
  }
}

// Language, theme and text size all come from the same object, so one
// pass keeps the page, the cache and the markup in sync.
function applyAll() {
  try {
    localStorage.setItem('writer.settings', JSON.stringify(settings));
  } catch {
    /* private mode: the server copy is the source of truth anyway */
  }

  lang = resolveLang(settings.language, navigator.language);
  t = makeT(lang);

  const root = document.documentElement;
  if (settings.theme === 'light' || settings.theme === 'dark') root.dataset.theme = settings.theme;
  else delete root.dataset.theme;
  root.dataset.size = settings.fontSize || 'standard';
  root.lang = lang === 'en' ? 'en' : 'zh-CN';
  root.dataset.i18nReady = 'true';
  document.title = `${t('settings.title')} · Writer`;

  applyDom(document, t);
  mountMenu(t);
  render();
  renderTrash();
}

function settingsChanged(next) {
  if (!next || typeof next !== 'object') return false;
  const tracked = [
    'language',
    'fontSize',
    'theme',
    'completion',
    'completionDelay',
    'agentFormatting',
    'idleArchiveMinutes',
  ];
  return tracked.some(
    (key) => Object.prototype.hasOwnProperty.call(next, key) && next[key] !== settings[key]
  );
}

// ---------------------------------------------------------------- trash

let trashDocs = [];

async function loadTrash() {
  try {
    const res = await fetch('/api/documents?status=deleted');
    if (await redirectIfLocked(res)) return;
    if (res.status === 401) {
      lockedEl.hidden = false;
      return;
    }
    if (!res.ok) throw new Error(`trash ${res.status}`);
    trashDocs = (await res.json()).documents || [];
  } catch {
    return;
  }
  renderTrash();
}

function renderTrash() {
  trashEl.replaceChildren();
  trashCountEl.textContent = String(trashDocs.length);
  trashEmptyEl.hidden = trashDocs.length > 0;

  for (const doc of trashDocs) {
    const card = el('div', 'card trash-card');
    const title = el('p', 'card-title');
    title.textContent = doc.title || t('common.untitled');
    const foot = el('p', 'card-foot');
    foot.append(textSpan('date', t('settings.deletedAt', { date: formatDate(doc.deleted_at) })));

    const actions = el('span', 'card-actions');
    const restore = el('button', 'link-button');
    restore.type = 'button';
    restore.textContent = t('settings.restore');
    restore.addEventListener('click', () => act(doc, 'restore'));
    const erase = el('button', 'link-button danger');
    erase.type = 'button';
    erase.textContent = t('settings.erase');
    erase.addEventListener('click', () => act(doc, 'erase'));
    actions.append(restore, erase);
    foot.append(actions);

    card.append(title, foot);
    trashEl.append(card);
  }
}

async function act(doc, kind) {
  const title = doc.title || t('common.untitled');
  if (kind === 'erase' && !confirm(t('settings.confirmErase', { title }))) return;
  try {
    const res = kind === 'restore'
      ? await fetch(`/api/documents/${doc.id}/restore`, { method: 'POST' })
      : await fetch(`/api/documents/${doc.id}?permanent=1`, { method: 'DELETE' });
    if (await redirectIfLocked(res)) return;
    if (!res.ok) throw new Error(`${kind} ${res.status}`);
    toast(t(kind === 'restore' ? 'settings.toastRestored' : 'settings.toastErased'));
    loadTrash();
  } catch {
    toast(t('settings.toastActionFailed'));
  }
}

// ----------------------------------------------------------- helpers

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale(lang), { month: 'long', day: 'numeric' }).format(d);
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
  applyAll();

  try {
    const res = await fetch('/api/settings');
    if (await redirectIfLocked(res)) return;
    if (res.status === 401) {
      lockedEl.hidden = false;
      return;
    }
    const server = await res.json();
    const changed = settingsChanged(server);
    settings = { ...settings, ...server };
    if (changed) applyAll();
    else {
      try {
        localStorage.setItem('writer.settings', JSON.stringify(settings));
      } catch {
        /* private mode: keep running from memory */
      }
    }
  } catch {
    toast(t('settings.toastCached'));
  }
  loadTrash();
}

init();
