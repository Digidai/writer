// A tiny, dependency-free Markdown renderer for archived documents.
// All source text is HTML-escaped before any transform, so document
// content can never inject markup.

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Ordered list markers. Chinese writing (and the agent, when it formats
// Chinese) uses "1、" with no space after the delimiter, so that form is
// matched too, bounded to two digits to keep prose like "2026、2027" out.
const ORDERED = /^\s*(?:\d+[.)]\s+|\d{1,2}、\s*)/;

export function renderMarkdown(src, depth = 0) {
  // NUL is used internally as a code-span sentinel; never allow it in input.
  const lines = String(src || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      html.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      html.push('<hr>');
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      // Depth cap: a wall of '>' must not recurse the stack away.
      html.push(
        depth < 8
          ? `<blockquote>${renderMarkdown(buf.join('\n'), depth + 1)}</blockquote>`
          : `<blockquote><p>${inline(buf.join(' '))}</p></blockquote>`
      );
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      html.push(`<ul>${items.map(listItem).join('')}</ul>`);
      continue;
    }

    if (ORDERED.test(line)) {
      const items = [];
      while (i < lines.length && ORDERED.test(lines[i])) {
        items.push(lines[i].replace(ORDERED, ''));
        i++;
      }
      html.push(`<ol>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ol>`);
      continue;
    }

    // Paragraph: consecutive plain lines join with <br>.
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,4}\s|```|\s*>|\s*[-*+]\s+|\s*(-{3,}|\*{3,})\s*$)/.test(lines[i]) &&
      !ORDERED.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    html.push(`<p>${buf.map(inline).join('<br>')}</p>`);
  }

  return html.join('\n');
}

function listItem(item) {
  const task = item.match(/^\[([ xX])\]\s+(.*)$/);
  if (task) {
    const checked = task[1] !== ' ';
    return `<li class="task${checked ? ' done' : ''}">${inline(task[2])}</li>`;
  }
  return `<li>${inline(item)}</li>`;
}

function inline(text) {
  let s = escapeHtml(text);

  // Protect code spans from further transforms.
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // Images degrade to links; only http(s) targets are allowed.
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener" target="_blank">$1</a>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener" target="_blank">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[Number(n)]}</code>`);
  return s;
}
