// Server-rendered pages: the reading view for archived documents.
import { renderMarkdown, escapeHtml } from './markdown.js';

function shell({ title, body, refresh = 0 }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>${escapeHtml(title)} · Writer</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
</head>
<body class="reader-body">
<header class="bar">
  <a class="wordmark" href="/">writer<span class="seal">.</span></a>
  <nav class="bar-nav"><a href="/archive">归档</a></nav>
</header>
${body}
</body>
</html>`;
}

export function renderDocumentPage(doc) {
  const tags = parseTags(doc.tags);
  const date = (doc.archived_at || doc.updated_at || '').slice(0, 10);

  if (doc.status !== 'archived') {
    return shell({
      title: '整理中',
      refresh: 4,
      body: `<main class="reader">
  <div class="pending">
    <span class="pending-dot"></span>
    <p>AI 正在整理这篇内容，稍候片刻。</p>
  </div>
</main>`,
    });
  }

  return shell({
    title: doc.title || '未命名',
    body: `<main class="reader">
  <article class="doc">
    <header class="doc-head">
      <h1 class="doc-title">${escapeHtml(doc.title || '未命名')}</h1>
      <p class="doc-meta">
        <span class="chip">${escapeHtml(doc.category || '其他')}</span>
        ${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
        <span class="date">${escapeHtml(date)}</span>
        <a class="download" href="/api/documents/${encodeURIComponent(doc.id)}/file">下载 .md</a>
      </p>
      ${doc.summary ? `<p class="doc-summary">${escapeHtml(doc.summary)}</p>` : ''}
    </header>
    <div class="prose">${renderMarkdown(dedupeTitle(doc.formatted || doc.content || '', doc.title))}</div>
  </article>
</main>`,
  });
}

export function renderNotFoundPage() {
  return shell({
    title: '未找到',
    body: `<main class="reader">
  <div class="pending"><p>没有找到这篇内容。</p><p><a href="/archive">回到归档</a></p></div>
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

function parseTags(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}
