// Writer editor: autosave, ghost-text completion, quiet archiving.
//
// Safety invariants, in order: user text is never lost (localStorage backup
// always current), never archived stale (finalize aborts if saving failed),
// and never fought over (one tab owns a draft at a time).

import { toast } from '/toast.js';
import { makeT, applyDom, resolveLang, locale } from '/i18n.js';
import { mountMenu } from '/menu.js';
import { redirectIfLocked } from '/locked.js';

const input = document.getElementById('input');
const mirrorText = document.getElementById('mirror-text');
const ghostEl = document.getElementById('ghost');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');
const finishBtn = document.getElementById('finish');
const hintEl = document.getElementById('hint');
const barEl = document.querySelector('.bar');
const deskEl = document.querySelector('.desk');
const completionBarEl = document.getElementById('completion-bar');
const completionAcceptEl = document.getElementById('completion-accept');
const completionDismissEl = document.getElementById('completion-dismiss');

const SAVE_DELAY = 800;
const MIN_ARCHIVE_CHARS = 30;
const KEEPALIVE_LIMIT = 60_000; // keepalive request body quota is 64 KiB

function readStoredSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem('writer.settings') || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Instance settings, mirrored from the server (see /settings). The cached
// copy applies immediately; the fetched copy wins once it lands.
const prefs = {
  language: 'auto',
  completion: true,
  completionDelay: 700,
  idleArchiveMinutes: 5,
  fontSize: 'standard',
  theme: 'system',
};
Object.assign(prefs, readStoredSettings());

let lang = resolveLang(prefs.language, navigator.language);
let t = makeT(lang);

const store = {
  get docId() { return localStorage.getItem('writer.docId'); },
  set docId(v) { v ? localStorage.setItem('writer.docId', v) : localStorage.removeItem('writer.docId'); },
  get backup() { return localStorage.getItem('writer.backup') || ''; },
  set backup(v) { v ? localStorage.setItem('writer.backup', v) : localStorage.removeItem('writer.backup'); },
};

const state = {
  ghost: '',
  composing: false,
  dirty: false,
  finalizing: false,
  yielded: false,   // another tab took this draft over
  ready: false,     // init finished; saves are allowed
  rev: null,        // last server updated_at we saw (optimistic concurrency)
  lastInput: Date.now(),
  saveTimer: null,
  completeTimer: null,
  completeSeq: 0,
  abort: null,
  saveChain: Promise.resolve(),
};

const coarsePointer = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;
const noHover = window.matchMedia ? window.matchMedia('(hover: none)') : null;
const mobileLayout = window.matchMedia ? window.matchMedia('(max-width: 640px)') : null;
const hasVisualViewport = Boolean(window.visualViewport);
let viewportFrame = null;

// ------------------------------------------------------------- status

function setStatus(kind, text) {
  statusEl.className = `status ${kind}`;
  statusText.textContent = text;
}

function markSaved() {
  const time = new Intl.DateTimeFormat(locale(lang), {
    hour: '2-digit', minute: '2-digit', hour12: lang === 'en',
  }).format(new Date());
  setStatus('saved', t('editor.saved', { time }));
}

// ------------------------------------------------------------- layout

function resize() {
  const sheet = input.parentElement;
  const sheetStyle = sheet ? getComputedStyle(sheet) : null;
  const sheetPaddingTop = sheetStyle ? parseFloat(sheetStyle.paddingTop) || 0 : 0;
  const sheetPaddingBottom = sheetStyle ? parseFloat(sheetStyle.paddingBottom) || 0 : 0;
  const paperFloor = mobileLayout?.matches && sheet
    ? Math.max(Math.floor(sheet.clientHeight - sheetPaddingTop - sheetPaddingBottom), 1)
    : 1;

  input.style.height = 'auto';
  const mirrorHeight = mirrorText.parentElement ? mirrorText.parentElement.scrollHeight : 0;
  const nextHeight = Math.max(input.scrollHeight, mirrorHeight, paperFloor, 1);
  input.style.height = `${nextHeight}px`;
  syncViewportMetrics();
}

function syncMirror() {
  mirrorText.textContent = input.value;
}

function useTouchCompletionUi() {
  return Boolean(
    (coarsePointer && coarsePointer.matches)
    || (noHover && noHover.matches)
  );
}

function updateCompletionBar() {
  if (!completionBarEl) return;
  const visible = useTouchCompletionUi() && Boolean(state.ghost);
  completionBarEl.hidden = !visible;
  document.body.classList.toggle('completion-visible', visible);
}

function updateHintCopy() {
  if (!hintEl) return;
  const touchUi = useTouchCompletionUi();
  const key = touchUi && state.ghost
    ? 'editor.hintMobileGhost'
    : touchUi
      ? 'editor.hintMobile'
      : 'editor.hint';
  hintEl.textContent = t(key);
}

function updateFinishHintCopy() {
  if (!finishBtn) return;
  const key = useTouchCompletionUi() ? 'editor.finishHintTouch' : 'editor.finishHint';
  finishBtn.title = t(key);
}

function syncViewportMetrics() {
  const root = document.documentElement;
  const barHeight = barEl ? Math.ceil(barEl.getBoundingClientRect().height) : 56;
  root.style.setProperty('--bar-height', `${barHeight}px`);

  if (!hasVisualViewport) {
    root.style.setProperty('--keyboard-offset', '0px');
    return;
  }
  const vv = window.visualViewport;
  const overlap = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  root.style.setProperty('--keyboard-offset', `${overlap}px`);
}

function keepInputVisible() {
  if (document.activeElement !== input) return;
  const top = barEl ? barEl.getBoundingClientRect().height + 8 : 62;
  const rect = input.getBoundingClientRect();
  if (rect.top < top) window.scrollBy(0, rect.top - top);
}

function scheduleViewportSync() {
  if (viewportFrame !== null) return;
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = null;
    syncViewportMetrics();
    keepInputVisible();
  });
}

// -------------------------------------------------------------- ghost

function showGhost(text) {
  state.ghost = text;
  ghostEl.textContent = text;
  updateCompletionBar();
  updateHintCopy();
  syncMirror();
  resize();
}

function clearGhost() {
  if (!state.ghost) return;
  state.ghost = '';
  ghostEl.textContent = '';
  updateCompletionBar();
  updateHintCopy();
  resize();
}

function cancelCompletion() {
  clearTimeout(state.completeTimer);
  state.completeSeq++;
  if (state.abort) state.abort.abort();
  clearGhost();
}

function caretAtEnd() {
  return input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
}

function acceptGhost() {
  const text = state.ghost;
  if (!text) return;
  clearGhost();
  const end = input.value.length;
  input.setRangeText(text, end, end, 'end');
  onInput();
}

function scheduleComplete() {
  clearTimeout(state.completeTimer);
  if (!prefs.completion) return;
  state.completeTimer = setTimeout(requestCompletion, prefs.completionDelay);
}

async function requestCompletion() {
  if (!prefs.completion) return;
  if (state.composing || state.finalizing || state.yielded) return;
  if (document.activeElement !== input) return;
  const value = input.value;
  if (value.trim().length < 10 || !caretAtEnd()) return;

  const seq = ++state.completeSeq;
  if (state.abort) state.abort.abort();
  const ac = new AbortController();
  state.abort = ac;

  try {
    const res = await fetch('/api/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: value.slice(-2000) }),
      signal: ac.signal,
    });
    if (await redirectIfLocked(res)) return;
    if (!res.ok) return;
    const { text } = await res.json();
    if (!text || seq !== state.completeSeq) return;
    if (state.finalizing || state.composing || state.yielded) return;
    if (input.value !== value || !caretAtEnd()) return;
    showGhost(text);
  } catch {
    /* aborted or offline: stay quiet */
  }
}

// ------------------------------------------------------------ autosave

function scheduleSave() {
  state.dirty = true;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, SAVE_DELAY);
}

function saveNow() {
  clearTimeout(state.saveTimer);
  state.saveChain = state.saveChain.then(doSave).catch(() => {});
  return state.saveChain;
}

async function doSave() {
  if (!state.ready || state.finalizing || state.yielded) return;
  const content = input.value;
  store.backup = content;
  if (!state.dirty) return;
  if (!content.trim() && !store.docId) { state.dirty = false; return; }

  setStatus('saving', t('editor.saving'));
  try {
    if (!store.docId) {
      const res = await fetch('/api/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (await redirectIfLocked(res)) return;
      if (!res.ok) throw new Error(`save ${res.status}`);
      const data = await res.json();
      store.docId = data.id;
      state.rev = data.updated_at;
    } else {
      const res = await fetch(`/api/documents/${store.docId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, rev: state.rev }),
      });
      if (await redirectIfLocked(res)) return;
      if (res.status === 404 || res.status === 409) {
        // Archived, gone, or written by another tab — carry the local
        // text into a fresh draft rather than overwrite anyone.
        store.docId = null;
        state.rev = null;
        return doSave();
      }
      if (!res.ok) throw new Error(`save ${res.status}`);
      state.rev = (await res.json()).updated_at;
    }
    if (input.value === content) state.dirty = false;
    markSaved();
  } catch {
    setStatus('offline', t('editor.offline'));
  }
}

// ------------------------------------------------------------- archive

// Save exactly `content` (the finalize snapshot), bypassing the dirty
// flag. Returns false when the server didn't take it — the caller must
// then keep everything local instead of archiving stale content.
async function flushExact(content) {
  store.backup = content;
  if (!content.trim() && !store.docId) return true;
  try {
    if (!store.docId) {
      const res = await fetch('/api/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (await redirectIfLocked(res)) return false;
      if (!res.ok) return false;
      const data = await res.json();
      store.docId = data.id;
      state.rev = data.updated_at;
      return true;
    }
    const res = await fetch(`/api/documents/${store.docId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, rev: state.rev }),
    });
    if (await redirectIfLocked(res)) return false;
    if (res.status === 404 || res.status === 409) {
      store.docId = null;
      state.rev = null;
      return flushExact(content);
    }
    if (!res.ok) return false;
    state.rev = (await res.json()).updated_at;
    return true;
  } catch {
    return false;
  }
}

async function finalize(auto = false) {
  if (state.finalizing || state.yielded || !state.ready) return;
  state.finalizing = true; // blocks scheduled saves and re-entry
  cancelCompletion();
  clearTimeout(state.saveTimer);
  const snapshot = input.value;

  try {
    await state.saveChain; // drain any in-flight save first
    if (!snapshot.trim()) {
      if (!auto) toast(t('editor.toastEmpty'));
      return;
    }
    if (!(await flushExact(snapshot))) {
      setStatus('offline', t('editor.offline'));
      if (!auto) toast(t('editor.toastSaveFailed'));
      return;
    }

    const res = await fetch(`/api/documents/${store.docId}/finalize`, { method: 'POST' });
    if (await redirectIfLocked(res)) return;
    if (!res.ok && res.status !== 202) throw new Error(`finalize ${res.status}`);
    const data = await res.json().catch(() => ({}));

    store.docId = null;
    state.rev = null;

    // Keep anything typed during the round trip as the start of a new
    // draft; if the middle of the text was edited meanwhile, keep it all
    // (duplication beats deletion).
    const remainder = input.value.startsWith(snapshot) ? input.value.slice(snapshot.length) : input.value;
    input.value = remainder;
    store.backup = remainder;
    state.dirty = Boolean(remainder.trim());
    syncMirror();
    resize();
    setStatus('', t('editor.ready'));
    if (state.dirty) scheduleSave();

    if (data.status !== 'discarded') {
      toast(t('editor.toastArchiving'));
    }
    if (!auto) input.focus();
  } catch {
    toast(t('editor.toastFailed'));
  } finally {
    state.finalizing = false;
  }
}

// ------------------------------------------------------------ settings

function prefsChanged(next) {
  if (!next || typeof next !== 'object') return false;
  for (const key of Object.keys(prefs)) {
    if (Object.prototype.hasOwnProperty.call(next, key) && next[key] !== prefs[key]) return true;
  }
  return false;
}

function applyPrefs(next = {}) {
  Object.assign(prefs, next);
  const root = document.documentElement;
  if (prefs.theme === 'light' || prefs.theme === 'dark') root.dataset.theme = prefs.theme;
  else delete root.dataset.theme;
  root.dataset.size = prefs.fontSize || 'standard';

  lang = resolveLang(prefs.language, navigator.language);
  t = makeT(lang);
  root.lang = lang === 'en' ? 'en' : 'zh-CN';
  applyDom(document, t);
  root.dataset.i18nReady = 'true';
  mountMenu(t);
  if (statusEl.className === 'status ') setStatus('', t('editor.ready'));

  if (!prefs.completion) {
    clearTimeout(state.completeTimer);
    cancelCompletion();
  }
  updateCompletionBar();
  updateHintCopy();
  updateFinishHintCopy();
  resize();
}

async function loadPrefs() {
  try {
    const res = await fetch('/api/settings');
    if (await redirectIfLocked(res)) return;
    if (!res.ok) return;
    const server = await res.json();
    if (prefsChanged(server)) applyPrefs(server);
    try {
      localStorage.setItem('writer.settings', JSON.stringify(server));
    } catch {
      /* private mode: keep running from memory */
    }
  } catch {
    /* offline: the cached copy stands */
  }
}

// ----------------------------------------------------------- multi-tab

// One tab owns the draft at a time: the most recently visible tab claims
// it, others yield (read-only) until clicked, which reloads fresh state.
const TAB_ID = Math.random().toString(36).slice(2);
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('writer') : null;

function claimOwnership() {
  if (channel && !state.yielded) channel.postMessage({ type: 'own', tab: TAB_ID });
}

if (channel) {
  channel.onmessage = (e) => {
    if (!e.data || e.data.type !== 'own' || e.data.tab === TAB_ID) return;
    if (state.yielded) return;
    state.yielded = true;
    cancelCompletion();
    clearTimeout(state.saveTimer);
    input.readOnly = true;
    setStatus('yielded', t('editor.yielded'));
    toast(t('editor.toastOtherTab'));
  };
}

input.addEventListener('click', () => {
  if (state.yielded) location.reload();
});

deskEl?.addEventListener('click', (event) => {
  if (state.yielded) return;
  if (!(event.target instanceof HTMLElement)) return;
  if (event.target === input) return;
  if (event.target.closest('button, a, input, textarea, select, [role="button"]')) return;
  input.focus();
});

// -------------------------------------------------------------- events

function onInput() {
  state.lastInput = Date.now();
  clearGhost();
  syncMirror();
  resize();
  scheduleSave();
  if (!state.composing) scheduleComplete();
}

input.addEventListener('input', onInput);

input.addEventListener('compositionstart', () => {
  state.composing = true;
  clearTimeout(state.completeTimer);
  if (state.abort) state.abort.abort();
  clearGhost();
});

input.addEventListener('compositionend', () => {
  state.composing = false;
  scheduleComplete();
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && state.ghost && !state.composing) {
    e.preventDefault();
    acceptGhost();
    return;
  }
  if (e.key === 'Escape' && state.ghost) {
    e.preventDefault();
    clearGhost();
    return;
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    finalize(false);
  }
});

document.addEventListener('selectionchange', () => {
  if (document.activeElement === input && !caretAtEnd()) clearGhost();
});

finishBtn.addEventListener('click', () => finalize(false));

completionAcceptEl?.addEventListener('click', () => {
  acceptGhost();
  input.focus();
});
completionDismissEl?.addEventListener('click', () => {
  clearGhost();
  input.focus();
});
coarsePointer?.addEventListener('change', () => {
  updateCompletionBar();
  updateHintCopy();
  updateFinishHintCopy();
});
noHover?.addEventListener('change', () => {
  updateCompletionBar();
  updateHintCopy();
  updateFinishHintCopy();
});

window.visualViewport?.addEventListener('resize', scheduleViewportSync);
window.visualViewport?.addEventListener('scroll', scheduleViewportSync);
window.addEventListener('resize', scheduleViewportSync);
input.addEventListener('focus', () => {
  syncViewportMetrics();
  setTimeout(scheduleViewportSync, 80);
});

// Flush pending changes when the page goes away. The backup write is the
// guarantee; the keepalive PUT is best-effort (and skipped over its quota).
window.addEventListener('pagehide', () => {
  store.backup = input.value;
  if (!state.dirty || !store.docId || state.yielded) return;
  if (input.value.length > KEEPALIVE_LIMIT) return;
  fetch(`/api/documents/${store.docId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: input.value, rev: state.rev }),
    keepalive: true,
  }).catch(() => {});
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') claimOwnership();
  else if (state.dirty) saveNow();
});
window.addEventListener('focus', claimOwnership);

// Quietly archive after a long pause, so finished thoughts file themselves.
setInterval(() => {
  if (!prefs.idleArchiveMinutes) return; // 0 means manual archiving only
  if (state.finalizing || state.composing || state.yielded || !state.ready) return;
  if (document.visibilityState !== 'visible') return;
  if (!store.docId) return;
  if (input.value.trim().length < MIN_ARCHIVE_CHARS) return;
  if (Date.now() - state.lastInput < prefs.idleArchiveMinutes * 60 * 1000) return;
  finalize(true);
}, 30 * 1000);

// ---------------------------------------------------------------- init

async function init() {
  applyPrefs();
  setStatus('', t('editor.ready'));
  loadPrefs();
  const id = store.docId;
  if (id) {
    try {
      const res = await fetch(`/api/documents/${id}`);
      if (await redirectIfLocked(res)) { state.ready = true; return; }
      if (res.ok) {
        const doc = await res.json();
        if (doc.status === 'draft') {
          // Don't clobber anything typed while this fetch was in flight.
          if (!state.dirty && input.value === '') {
            input.value = doc.content || '';
            state.rev = doc.updated_at;
          }
        } else {
          store.docId = null;
          store.backup = '';
        }
      } else if (res.status === 404) {
        store.docId = null;
        if (store.backup && !state.dirty && input.value === '') {
          input.value = store.backup;
          state.dirty = true;
        }
      } else {
        // Server trouble: keep the docId, work from the local backup.
        if (!state.dirty && input.value === '') input.value = store.backup;
        setStatus('offline', t('editor.offline'));
      }
    } catch {
      if (!state.dirty && input.value === '') input.value = store.backup;
      setStatus('offline', t('editor.offline'));
    }
  } else if (store.backup && !state.dirty && input.value === '') {
    input.value = store.backup;
    state.dirty = true;
  }

  state.ready = true;
  if (state.dirty) scheduleSave();
  syncMirror();
  updateCompletionBar();
  updateHintCopy();
  resize();
  syncViewportMetrics();
  const end = input.value.length;
  input.setSelectionRange(end, end);
  input.focus();
  claimOwnership();
}

init();
