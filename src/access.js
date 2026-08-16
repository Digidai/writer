import { renderUnlockPage } from './html.js';
import { resolveLang } from '../public/i18n.js';

// Optional single-key lock: `wrangler secret put WRITER_ACCESS_KEY`.
// Unlock once per browser at /unlock. Unset = open instance.
export function requireAccess(request, env) {
  const key = env.WRITER_ACCESS_KEY;
  if (!key) return null;

  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)writer_key=([^;]+)/);
  if (m) {
    let given = null;
    try {
      given = decodeURIComponent(m[1]);
    } catch {
      given = null; // undecodable cookie = no cookie
    }
    if (given !== null && safeEqual(given, key)) return null;
  }

  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7), key)) return null;

  return json({ error: 'locked', hint: 'visit /unlock' }, 401);
}

// GET /unlock only renders the form. POST accepts formData key.
// Query keys are intentionally ignored so secrets never enter URLs.
export async function handleUnlock(request, env, url, { consumeUnlockAttempt } = {}) {
  const key = env.WRITER_ACCESS_KEY;
  if (!key) return redirect(url, '/');

  // The lock sits in front of everything, so the stored preference is not
  // readable here; go by what the browser asks for.
  const lang = resolveLang('auto', request.headers.get('Accept-Language'));

  if (request.method !== 'POST') return unlockPage(false, lang);

  if (consumeUnlockAttempt) {
    const denied = await consumeUnlockAttempt(request);
    if (denied) return denied;
  }

  let given = '';
  try {
    const form = await request.formData();
    given = String(form.get('key') || '');
  } catch {
    given = '';
  }

  if (!given) return unlockPage(false, lang);
  if (!safeEqual(given, key)) return unlockPage(true, lang, 403);

  const headers = new Headers({ Location: '/', 'Cache-Control': 'no-store' });
  headers.append(
    'Set-Cookie',
    `writer_key=${encodeURIComponent(key)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=15552000`
  );
  return new Response(null, { status: 302, headers });
}

function unlockPage(failed, lang, status = 200) {
  return new Response(renderUnlockPage(failed, lang), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a));
  const bb = enc.encode(String(b));
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function redirect(base, to) {
  return Response.redirect(new URL(to, base).toString(), 302);
}
