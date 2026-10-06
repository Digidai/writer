// Who is signed in, fetched once per page and shared by every module.
let current = null;
let pending = null;
const listeners = new Set();
const beforeSignOut = new Set();

const SIGNED_OUT = { user: null, features: {}, registration: 'open' };

export function getSession({ refresh = false } = {}) {
  if (refresh || !pending) {
    pending = fetch('/api/auth/me', { headers: { Accept: 'application/json' } })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((data) => {
        current = data && typeof data === 'object' ? { ...SIGNED_OUT, ...data } : { ...SIGNED_OUT };
        return current;
      });
  }
  return pending;
}

export function currentSession() {
  return current;
}

export function onSession(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// After a sign-in: refetch and tell every listener on the page.
export async function refreshSession() {
  const next = await getSession({ refresh: true });
  for (const fn of listeners) {
    try {
      fn(next);
    } catch (err) {
      console.error(err);
    }
  }
  return next;
}

// The editor registers a final save here, so signing out never drops a sentence.
export function onBeforeSignOut(fn) {
  beforeSignOut.add(fn);
  return () => beforeSignOut.delete(fn);
}

export async function signOut() {
  const hooks = [...beforeSignOut].map((fn) => Promise.resolve().then(fn).catch(() => {}));
  await Promise.race([Promise.all(hooks), new Promise((r) => setTimeout(r, 2500))]);
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    /* the cookie expires anyway */
  }
  // Nothing from this account stays behind in the browser.
  try {
    localStorage.removeItem('writer.docId');
    localStorage.removeItem('writer.backup');
  } catch {
    /* private mode */
  }
  location.href = '/';
}
