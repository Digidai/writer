// Server-rendered pages: the reading view and the unlock form. Both are
// translated on the server so they arrive in the right language.
import { renderMarkdown, escapeHtml } from './markdown.js';
import { makeT, locale } from '../public/i18n.js';

// Applied before first paint so a chosen theme and text size never flash.
const BOOT = `<script>try{var s=JSON.parse(localStorage.getItem('writer.settings')||'{}');
if(s.theme==='light'||s.theme==='dark')document.documentElement.dataset.theme=s.theme;
if(s.fontSize)document.documentElement.dataset.size=s.fontSize;}catch(e){}</script>`;

function shell({ title, body, lang, t, refresh = 0, script = '' }) {
  return `<!doctype html>
<html lang="${lang === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>${escapeHtml(title)} · Writer</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/fonts/lxgw-wenkai-screen.css">
<link rel="stylesheet" href="/style.css">
${BOOT}
</head>
<body class="reader-body">
<header class="bar">
  <a class="wordmark" href="/">writer<span class="seal">.</span></a>
  <nav class="bar-nav"><a href="/archive">${escapeHtml(t('nav.archive'))}</a><a href="/settings">${escapeHtml(t('nav.settings'))}</a></nav>
</header>
${body}
<div class="toast" id="toast" hidden></div>
${script}
</body>
</html>`;
}

export function renderDocumentPage(doc, lang = 'zh') {
  const t = makeT(lang);
  const tags = parseTags(doc.tags);
  const date = formatDate(doc.archived_at || doc.updated_at, lang);

  if (doc.status !== 'archived') {
    return shell({
      lang,
      t,
      title: t('reader.filingTitle'),
      refresh: 4,
      body: `<main class="reader">
  <div class="pending">
    <span class="pending-dot"></span>
    <p>${escapeHtml(t('reader.filing'))}</p>
  </div>
</main>`,
    });
  }

  const id = encodeURIComponent(doc.id);
  return shell({
    lang,
    t,
    title: doc.title || t('common.untitled'),
    script: `<script type="module" src="/doc.js" data-doc="${escapeHtml(doc.id)}"></script>`,
    body: `<main class="reader">
  <article class="doc">
    <header class="doc-head">
      <h1 class="doc-title">${escapeHtml(doc.title || t('common.untitled'))}</h1>
      <p class="doc-meta">
        <span class="chip">${escapeHtml(doc.category || '')}</span>
        ${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
        <span class="date">${escapeHtml(date)}</span>
      </p>
      ${doc.summary ? `<p class="doc-summary">${escapeHtml(doc.summary)}</p>` : ''}
    </header>
    <div class="prose">${renderMarkdown(dedupeTitle(doc.formatted || doc.content || '', doc.title))}</div>
    ${renderTrace(doc.agent_trace, t)}
    <p class="doc-actions">
      <button type="button" data-action="edit">${escapeHtml(t('reader.edit'))}</button>
      <a href="/api/documents/${id}/file">${escapeHtml(t('reader.download'))}</a>
      <button type="button" class="danger" data-action="delete">${escapeHtml(t('reader.delete'))}</button>
    </p>
  </article>
</main>`,
  });
}

// The agent's decision trail: which model ran, which tools it consulted.
function renderTrace(raw, t) {
  let trace;
  try {
    trace = JSON.parse(raw || 'null');
  } catch {
    return '';
  }
  if (!Array.isArray(trace) || trace.length === 0) return '';

  const rows = trace
    .map((turn) => {
      const n = Number(turn.turn) || '?';
      const label = escapeHtml(t('reader.traceTurn', { n }));
      if (turn.error) return `<li>${label} · ${escapeHtml(t('reader.traceError'))}</li>`;
      const model = String(turn.model || '').replace(/^@cf\/[^/]+\//, '');
      const tools = (turn.tools || [])
        .map((call) => {
          const arg = call.args && call.args.query ? `("${call.args.query}")` : '';
          return `<code>${escapeHtml(`${call.name}${arg}`)}</code>`;
        })
        .join(' ');
      return `<li>${label} · ${escapeHtml(model)} ${tools || escapeHtml(t('reader.traceThinking'))}</li>`;
    })
    .join('');

  return `<details class="trace">
  <summary>${escapeHtml(t('reader.trace', { n: trace.length }))}</summary>
  <ul>${rows}</ul>
</details>`;
}

export function renderUnlockPage(failed, lang = 'zh') {
  const t = makeT(lang);
  return shell({
    lang,
    t,
    title: t('unlock.title'),
    body: `<main class="reader">
  <form class="unlock" method="POST" action="/unlock">
    <p>${escapeHtml(t('unlock.locked'))}</p>
    ${failed ? `<p class="unlock-error">${escapeHtml(t('unlock.error'))}</p>` : ''}
    <input type="password" name="key" placeholder="${escapeHtml(t('unlock.placeholder'))}" autofocus autocomplete="current-password">
    <button type="submit">${escapeHtml(t('unlock.submit'))}</button>
  </form>
</main>`,
  });
}

export function renderNotFoundPage(lang = 'zh') {
  const t = makeT(lang);
  return shell({
    lang,
    t,
    title: t('reader.notFoundTitle'),
    body: `<main class="reader">
  <div class="pending"><p>${escapeHtml(t('reader.notFound'))}</p><p><a href="/archive">${escapeHtml(t('reader.backToArchive'))}</a></p></div>
</main>`,
  });
}

// The agent often opens the formatted text with the same title again;
// the page header already shows it, so drop that first heading.
function dedupeTitle(markdown, title) {
  const m = String(markdown).match(/^\s*#{1,4}\s+(.+)\s*\n+/);
  if (m && title && m[1].trim() === String(title).trim()) {
    return markdown.slice(m[0].length);
  }
  return markdown;
}

function formatDate(iso, lang) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale(lang), {
    year: 'numeric', month: 'long', day: 'numeric',
  }).format(d);
}

function parseTags(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter((tag) => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}
