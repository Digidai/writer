// The one transient message surface, shared by every page.
let timer = null;

export function toast(html, { duration = 5000 } = {}) {
  const el = document.getElementById('toast');
  if (!el) return null;
  el.innerHTML = html;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(timer);
  timer = setTimeout(() => hideToast(), duration);
  return el;
}

export function hideToast() {
  const el = document.getElementById('toast');
  if (!el) return;
  clearTimeout(timer);
  el.classList.remove('show');
  setTimeout(() => { el.hidden = true; }, 300);
}
