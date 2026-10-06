// /login: the sign-in form on its own page. Readers who open a document
// link while signed out land here and go straight back afterwards.
import { makeT, applyDom, resolveLang } from '/i18n.js';
import { mountMenu } from '/menu.js';
import { getSession } from '/session.js';
import { renderAuthForm } from '/auth.js';
import { safeNext } from '/safe-next.js';
import '/track.js';

function storedSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem('writer.settings') || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const lang = resolveLang(storedSettings().language, navigator.language);
const t = makeT(lang);
const next = safeNext(new URLSearchParams(location.search).get('next'), location.origin);

document.documentElement.dataset.i18nReady = 'true';
document.title = `${t('nav.signIn')} · Writer`;
applyDom(document, t);
mountMenu(t);

getSession().then((session) => {
  if (session && session.user) {
    location.replace(next);
    return;
  }
  const form = renderAuthForm({ t, reason: next.startsWith('/d/') ? 'archive' : 'signin', lang, onSuccess: () => location.replace(next) });
  document.getElementById('login').append(form);
  form.querySelector('input')?.focus();
});
