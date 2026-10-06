// Sign in with an email code. Two quiet steps on one small sheet: the
// address, then the six digits. Used as a dialog (finishing a piece, the
// menu) and inline (the /login page, the archive when signed out).
import { refreshSession } from '/session.js';

export function openAuthDialog({ t, reason = 'signin', lang = 'en', onSuccess } = {}) {
  document.getElementById('auth-dialog')?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'auth-dialog';
  dialog.className = 'auth-dialog';
  const form = renderAuthForm({
    t,
    reason,
    lang,
    onSuccess(data) {
      onSuccess?.(data);
      dialog.close();
    },
    onCancel: () => dialog.close(),
  });
  dialog.append(form);
  dialog.addEventListener('close', () => setTimeout(() => dialog.remove(), 0));
  // A click on the backdrop (outside the sheet) dismisses it.
  dialog.addEventListener('mousedown', (e) => {
    if (e.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  dialog.showModal();
  form.querySelector('input')?.focus();
  return dialog;
}

export function renderAuthForm({ t, reason = 'signin', lang = 'en', onSuccess, onCancel } = {}) {
  const root = el('div', 'auth');
  const title = el('h2', 'auth-title');
  title.textContent = t(reason === 'finish' ? 'auth.titleFinish' : 'auth.titleSignIn');
  const sub = el('p', 'auth-sub');
  sub.textContent = t(reason === 'finish' ? 'auth.subFinish' : reason === 'archive' ? 'auth.subArchive' : 'auth.subSignIn');

  const form = el('form', 'auth-form');
  form.noValidate = true;

  const emailInput = el('input', 'auth-input');
  Object.assign(emailInput, {
    type: 'email', name: 'email', autocomplete: 'email', placeholder: t('auth.emailPlaceholder'), required: true,
  });
  emailInput.setAttribute('aria-label', t('auth.email'));
  emailInput.spellcheck = false;

  const codeInput = el('input', 'auth-input auth-code');
  Object.assign(codeInput, {
    type: 'text', name: 'code', autocomplete: 'one-time-code', placeholder: t('auth.codePlaceholder'), maxLength: 6,
  });
  codeInput.inputMode = 'numeric';
  codeInput.setAttribute('aria-label', t('auth.code'));
  codeInput.hidden = true;

  const note = el('p', 'auth-note');
  note.setAttribute('aria-live', 'polite');
  const error = el('p', 'auth-error');
  error.setAttribute('role', 'alert');

  const submit = el('button', 'auth-submit');
  submit.type = 'submit';
  submit.textContent = t('auth.sendCode');

  const links = el('p', 'auth-links');
  const resend = linkButton(t('auth.resend'));
  const change = linkButton(t('auth.changeEmail'));
  resend.hidden = true;
  change.hidden = true;
  links.append(resend, change);
  if (onCancel) {
    const cancel = linkButton(t('auth.cancel'));
    cancel.classList.add('auth-cancel');
    cancel.addEventListener('click', () => onCancel());
    links.append(cancel);
  }

  form.append(emailInput, codeInput, error, submit);
  root.append(title, sub, form, note, links);

  let step = 'email';
  let email = '';
  let busy = false;
  let cooldown = null;

  function setError(message) {
    error.textContent = message || '';
    error.hidden = !message;
  }
  setError('');

  function showCodeStep() {
    step = 'code';
    emailInput.hidden = true;
    codeInput.hidden = false;
    codeInput.value = '';
    submit.textContent = t('auth.verify');
    note.textContent = t('auth.codeSent', { email });
    change.hidden = false;
    startCooldown(30);
    codeInput.focus();
  }

  function showEmailStep() {
    step = 'email';
    emailInput.hidden = false;
    codeInput.hidden = true;
    submit.textContent = t('auth.sendCode');
    note.textContent = '';
    resend.hidden = true;
    change.hidden = true;
    clearInterval(cooldown);
    setError('');
    emailInput.focus();
  }

  function startCooldown(seconds) {
    clearInterval(cooldown);
    let left = seconds;
    resend.hidden = false;
    resend.disabled = true;
    resend.textContent = t('auth.resendIn', { n: left });
    cooldown = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(cooldown);
        resend.disabled = false;
        resend.textContent = t('auth.resend');
      } else {
        resend.textContent = t('auth.resendIn', { n: left });
      }
    }, 1000);
  }

  async function sendCode() {
    const value = emailInput.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError(t('auth.errInvalidEmail'));
      emailInput.focus();
      return;
    }
    busy = true;
    submit.disabled = true;
    submit.textContent = t('auth.sending');
    setError('');
    try {
      const res = await post('/api/auth/start', { email: value, lang });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(errorMessage(t, res.status, body));
        if (body && body.error === 'too_soon' && step === 'code') startCooldown(body.retryAfter || 30);
        return;
      }
      email = body.email || value.toLowerCase();
      showCodeStep();
    } catch {
      setError(t('auth.errNetwork'));
    } finally {
      busy = false;
      submit.disabled = false;
      if (step === 'email') submit.textContent = t('auth.sendCode');
    }
  }

  async function verify() {
    const code = codeInput.value.replace(/\D/g, '');
    if (code.length !== 6) {
      setError(t('auth.errInvalidCode'));
      codeInput.focus();
      return;
    }
    busy = true;
    submit.disabled = true;
    submit.textContent = t('auth.verifying');
    setError('');
    try {
      const res = await post('/api/auth/verify', { email, code });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(errorMessage(t, res.status, body));
        codeInput.select();
        return;
      }
      clearInterval(cooldown);
      const session = await refreshSession();
      onSuccess?.({ ...body, session });
    } catch {
      setError(t('auth.errNetwork'));
    } finally {
      busy = false;
      submit.disabled = false;
      submit.textContent = t('auth.verify');
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) return;
    if (step === 'email') sendCode();
    else verify();
  });

  // Six digits typed or pasted: no need to press the button.
  codeInput.addEventListener('input', () => {
    const digits = codeInput.value.replace(/\D/g, '').slice(0, 6);
    if (digits !== codeInput.value) codeInput.value = digits;
    if (digits.length === 6 && !busy) verify();
  });

  resend.addEventListener('click', () => {
    if (busy) return;
    emailInput.value = email;
    sendCode();
  });
  change.addEventListener('click', () => {
    if (!busy) showEmailStep();
  });

  return root;
}

function errorMessage(t, status, body) {
  const code = body && body.error;
  if (code === 'invalid_email') return t('auth.errInvalidEmail');
  if (code === 'invalid_code') {
    if (body.attemptsLeft === 0) return t('auth.errTooMany');
    if (typeof body.attemptsLeft === 'number') return t('auth.errInvalidCodeLeft', { n: body.attemptsLeft });
    return t('auth.errInvalidCode');
  }
  if (code === 'code_expired') return t('auth.errExpired');
  if (code === 'too_many_attempts') return t('auth.errTooMany');
  if (code === 'too_soon') return t('auth.errTooSoon');
  if (code === 'email_unavailable') return t('auth.errEmailUnavailable');
  if (code === 'registration_closed') return t('auth.errClosed');
  if (code === 'account_disabled') return t('auth.errDisabled');
  if (status === 429) return t('auth.errRateLimited');
  return t('auth.errNetwork');
}

function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
}

function linkButton(label) {
  const b = el('button', 'link-button');
  b.type = 'button';
  b.textContent = label;
  return b;
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
