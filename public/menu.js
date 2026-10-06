// The only navigation in the product: one quiet mark in the top bar that
// opens the pages you are not on, plus the account (sign in, or who you
// are and sign out). Self-mounts on import so the server-rendered pages
// get it too; call mountMenu(t) again to relabel after a language switch.
import { makeT, resolveLang } from '/i18n.js';
import { getSession, currentSession, onSession, signOut } from '/session.js';
import { openAuthDialog } from '/auth.js';

const PAGES = [
  { href: '/', key: 'nav.write' },
  { href: '/archive', key: 'nav.archive' },
  { href: '/settings', key: 'nav.settings' },
];

let labels = null;
let openMenu = null;

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
  labels = t;
  const bar = document.querySelector('.bar');
  if (!bar) return;
  bar.querySelector('.menu')?.remove();

  const here = currentPath();
  const items = PAGES.filter((page) => page.href !== here);

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
  appendAccount(panel, t, here);

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
  openMenu = { menu, button, close };

  menu.append(button, panel);
  (bar.querySelector('.bar-right') || bar).append(menu);
}

function appendAccount(panel, t, here) {
  const session = currentSession();
  if (!session || here === '/login') return;

  const rule = document.createElement('div');
  rule.className = 'menu-rule';
  panel.append(rule);

  if (session.user) {
    const who = document.createElement('p');
    who.className = 'menu-who';
    who.textContent = session.user.email;
    who.title = session.user.email;
    const out = document.createElement('button');
    out.type = 'button';
    out.textContent = t('nav.signOut');
    out.addEventListener('click', () => signOut());
    panel.append(who, out);
    return;
  }

  const signIn = document.createElement('button');
  signIn.type = 'button';
  signIn.textContent = t('nav.signIn');
  signIn.addEventListener('click', () => {
    openMenu?.close();
    openAuthDialog({ t, reason: 'signin', lang: document.documentElement.lang.startsWith('zh') ? 'zh' : 'en' });
  });
  panel.append(signIn);
}

// One set of document listeners for whichever menu is mounted.
document.addEventListener('click', () => openMenu?.close());
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !openMenu || !openMenu.menu.classList.contains('open')) return;
  openMenu.close();
  openMenu.button.focus();
});

// The account part arrives with the session; rebuild with the last labels.
getSession().then(() => mountMenu(labels || undefined));
onSession(() => mountMenu(labels || undefined));

mountMenu();
