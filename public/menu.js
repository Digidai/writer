// The only navigation in the product: one quiet mark in the top bar that
// opens the pages you are not on. Self-mounts on import so the
// server-rendered pages get it too; call mountMenu(t) again to relabel
// after a language switch.
import { makeT, resolveLang } from '/i18n.js';

const PAGES = [
  { href: '/', key: 'nav.write' },
  { href: '/archive', key: 'nav.archive' },
  { href: '/settings', key: 'nav.settings' },
];

function currentPath() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (path.startsWith('/d/')) return '/d';
  return path;
}

function storedLang() {
  try {
    return JSON.parse(localStorage.getItem('writer.settings') || '{}').language;
  } catch {
    return 'auto';
  }
}

export function mountMenu(t = makeT(resolveLang(storedLang(), navigator.language))) {
  const bar = document.querySelector('.bar');
  if (!bar) return;
  bar.querySelector('.menu')?.remove();

  const here = currentPath();
  const items = PAGES.filter((page) => page.href !== here);
  if (items.length === 0) return;

  const menu = document.createElement('div');
  menu.className = 'menu';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'menu-button';
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', t('nav.menu'));
  button.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">'
    + '<circle cx="4" cy="10" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="16" cy="10" r="1.6"/></svg>';

  const panel = document.createElement('nav');
  panel.className = 'menu-panel';
  panel.hidden = true;
  for (const page of items) {
    const link = document.createElement('a');
    link.href = page.href;
    link.textContent = t(page.key);
    panel.append(link);
  }

  const close = () => {
    menu.classList.remove('open');
    button.setAttribute('aria-expanded', 'false');
    // Wait out the fade before removing it from the tab order.
    setTimeout(() => {
      if (!menu.classList.contains('open')) panel.hidden = true;
    }, 180);
  };
  const open = () => {
    panel.hidden = false;
    requestAnimationFrame(() => menu.classList.add('open'));
    button.setAttribute('aria-expanded', 'true');
  };

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.contains('open') ? close() : open();
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !menu.classList.contains('open')) return;
    close();
    button.focus();
  });

  menu.append(button, panel);
  (bar.querySelector('.bar-right') || bar).append(menu);
}

mountMenu();
