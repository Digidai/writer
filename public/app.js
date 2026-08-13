// Writer editor: autosave, ghost-text completion, quiet archiving.
//
// Safety invariants, in order: user text is never lost (localStorage backup
// always current), never archived stale (finalize aborts if saving failed),
// and never fought over (one tab owns a draft at a time).

const input = document.getElementById('input');
const mirrorText = document.getElementById('mirror-text');
const ghostEl = document.getElementById('ghost');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');
const finishBtn = document.getElementById('finish');
const toastEl = document.getElementById('toast');

const SAVE_DELAY = 800;
const COMPLETE_DELAY = 700;
const IDLE_ARCHIVE_MS = 5 * 60 * 1000;
const MIN_ARCHIVE_CHARS = 30;
const KEEPALIVE_LIMIT = 60_000; // keepalive request body quota is 64 KiB

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

// ------------------------------------------------------------- status

function setStatus(kind, text) {
  statusEl.className = `status ${kind}`;
  statusText.textContent = text;
}

function markSaved() {
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  setStatus('saved', `已保存 ${hh}:${mm}`);
}

// ------------------------------------------------------------- layout

function resize() {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

function syncMirror() {
  mirrorText.textContent = input.value;
}

// -------------------------------------------------------------- ghost

function showGhost(text) {
  state.ghost = text;
  ghostEl.textContent = text;
  syncMirror();
  resize();
}

function clearGhost() {
  if (!state.ghost) return;
  state.ghost = '';
  ghostEl.textContent = '';
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
  state.completeTimer = setTimeout(requestCompletion, COMPLETE_DELAY);
}

async function requestCompletion() {
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

  setStatus('saving', '保存中…');
  try {
    if (!store.docId) {
      const res = await fetch('/api/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (res.status === 401) return setStatus('locked', '需要密钥');
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
      if (res.status === 401) return setStatus('locked', '需要密钥');
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
    setStatus('offline', '离线 · 已本地备份');
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
      if (!auto) toast('还没有内容');
      return;
    }
    if (!(await flushExact(snapshot))) {
      setStatus('offline', '离线 · 已本地备份');
      if (!auto) toast('保存未完成，暂不归档');
      return;
    }

    const res = await fetch(`/api/documents/${store.docId}/finalize`, { method: 'POST' });
    if (res.status === 401) return setStatus('locked', '需要密钥');
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
    setStatus('', '就绪');
    if (state.dirty) scheduleSave();

    if (data.status !== 'discarded') {
      toast('已交给 AI 整理 · <a href="/archive">前往归档</a>');
    }
    if (!auto) input.focus();
  } catch {
    toast('归档失败，稍后再试');
  } finally {
    state.finalizing = false;
  }
}

// --------------------------------------------------------------- toast

let toastTimer = null;
function toast(html) {
  toastEl.innerHTML = html;
  toastEl.hidden = false;
  requestAnimationFrame(() => toastEl.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    setTimeout(() => { toastEl.hidden = true; }, 300);
  }, 5000);
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
    setStatus('yielded', '已在另一标签页继续');
    toast('这篇草稿已在另一个标签页打开 · 点击纸面接管');
  };
}

input.addEventListener('click', () => {
  if (state.yielded) location.reload();
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
  if (state.finalizing || state.composing || state.yielded || !state.ready) return;
  if (document.visibilityState !== 'visible') return;
  if (!store.docId) return;
  if (input.value.trim().length < MIN_ARCHIVE_CHARS) return;
  if (Date.now() - state.lastInput < IDLE_ARCHIVE_MS) return;
  finalize(true);
}, 30 * 1000);

// ---------------------------------------------------------------- init

async function init() {
  const id = store.docId;
  if (id) {
    try {
      const res = await fetch(`/api/documents/${id}`);
      if (res.status === 401) { state.ready = true; return setStatus('locked', '需要密钥'); }
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
        setStatus('offline', '离线 · 已本地备份');
      }
    } catch {
      if (!state.dirty && input.value === '') input.value = store.backup;
      setStatus('offline', '离线 · 已本地备份');
    }
  } else if (store.backup && !state.dirty && input.value === '') {
    input.value = store.backup;
    state.dirty = true;
  }

  state.ready = true;
  if (state.dirty) scheduleSave();
  syncMirror();
  resize();
  const end = input.value.length;
  input.setSelectionRange(end, end);
  input.focus();
  claimOwnership();
}

init();
