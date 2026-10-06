// Where to go after signing in. Only same-origin paths: a crafted ?next=
// must never bounce anyone to another site. Resolved with URL, exactly as
// the browser will, so tricks like "/\t/evil.example" or "/\evil" fail.
// Dot segments can collapse to "//evil.example" (a host, not a path), so
// the result itself is resolved once more before it is trusted.
export function safeNext(raw, origin) {
  const fallback = '/archive';
  try {
    const url = new URL(String(raw || fallback), origin);
    if (url.origin !== origin) return fallback;
    if (url.pathname.startsWith('/login')) return fallback;
    const path = url.pathname + url.search + url.hash;
    if (path.startsWith('//') || new URL(path, origin).origin !== origin) return fallback;
    return path;
  } catch {
    return fallback;
  }
}
