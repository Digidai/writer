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
<link rel="stylesheet" href="/fonts/lxgw-wenkai-screen.css">
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
    ${renderTrace(doc.agent_trace)}
  </article>
</main>`,
  });
}

// The agent's decision trail: which model ran, which tools it consulted.
function renderTrace(raw) {
  let trace;
  try {
    trace = JSON.parse(raw || 'null');
  } catch {
    return '';
  }
  if (!Array.isArray(trace) || trace.length === 0) return '';

  const rows = trace
    .map((t) => {
      const model = String(t.model || '').replace(/^@cf\/[^/]+\//, '');
      const tools = (t.tools || [])
        .map((c) => {
          const arg = c.args && c.args.query ? `("${c.args.query}")` : '';
          return `<code>${escapeHtml(`${c.name}${arg}`)}</code>`;
        })
        .join(' ');
      if (t.error) return `<li>第 ${Number(t.turn) || '?'} 轮 · 出错，已用兜底规则归档</li>`;
      return `<li>第 ${Number(t.turn) || '?'} 轮 · ${escapeHtml(model)} ${tools || '思考'}</li>`;
    })
    .join('');

  return `<details class="trace">
  <summary>Agent 处理轨迹（${trace.length} 轮）</summary>
  <ul>${rows}</ul>
</details>`;
}

export function renderUnlockPage(failed) {
  return shell({
    title: '解锁',
    body: `<main class="reader">
  <form class="unlock" method="POST" action="/unlock">
    <p>这台 Writer 已上锁。</p>
    ${failed ? '<p class="unlock-error">密钥不正确。</p>' : ''}
    <input type="password" name="key" placeholder="访问密钥" autofocus autocomplete="current-password">
    <button type="submit">解锁</button>
  </form>
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
