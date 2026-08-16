// Shared handling for expired or missing unlock cookies.
export async function redirectIfLocked(res) {
  if (!res || res.status !== 401) return false;
  try {
    const body = await res.clone().json();
    if (body && body.error === 'locked') {
      location.href = '/unlock';
      return true;
    }
  } catch {
    // Not a JSON lock response: let the caller handle it.
  }
  return false;
}
