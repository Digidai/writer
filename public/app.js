// Writer editor: autosave, ghost-text completion, quiet archiving.

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
  if (state.composing || state.finalizing) return;
  if (document.activeElement !== input) return;
  const value = input.value;
  if (value.trim().length < 10 || !caretAtEnd()) return;
  if (/\s$/.test(value) && /\n\s*$/.test(value)) return; // fresh empty line: let the user lead

  const seq = ++state.completeSeq;
  state.abort?.abort();
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
    if (input.value !== value || !caretAtEnd() || state.composing) return;
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
      store.docId = (await res.json()).id;
    } else {
      const res = await fetch(`/api/documents/${store.docId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (res.status === 401) return setStatus('locked', '需要密钥');
      if (res.status === 404 || res.status === 409) {
        // Archived (or gone) underneath us — carry the text into a fresh draft.
        store.docId = null;
        return doSave();
      }
      if (!res.ok) throw new Error(`save ${res.status}`);
    }
    if (input.value === content) state.dirty = false;
    markSaved();
  } catch {
    setStatus('offline', '离线 · 已本地备份');
  }
}

// ------------------------------------------------------------- archive

async function finalize(auto = false) {
  if (state.finalizing) return;
  state.finalizing = true;
  clearGhost();
  try {
    await saveNow();
    if (!store.docId) {
      if (!auto) toast('还没有内容');
      return;
    }
    const res = await fetch(`/api/documents/${store.docId}/finalize`, { method: 'POST' });
    if (res.status === 401) return setStatus('locked', '需要密钥');
    if (!res.ok && res.status !== 202) throw new Error(`finalize ${res.status}`);
    const data = await res.json().catch(() => ({}));

    store.docId = null;
    store.backup = '';
    state.dirty = false;
    input.value = '';
    syncMirror();
    resize();
    setStatus('', '就绪');
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
  state.abort?.abort();
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

// Flush pending changes when the page goes away.
window.addEventListener('pagehide', () => {
  if (!state.dirty || !store.docId) return;
  fetch(`/api/documents/${store.docId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: input.value }),
    keepalive: true,
  }).catch(() => {});
});

// Quietly archive after a long pause, so finished thoughts file themselves.
setInterval(() => {
  if (state.finalizing || state.composing) return;
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
      if (res.status === 401) return setStatus('locked', '需要密钥');
      if (res.ok) {
        const doc = await res.json();
        if (doc.status === 'draft') {
          input.value = doc.content || '';
        } else {
          store.docId = null;
          store.backup = '';
        }
      } else {
        store.docId = null;
      }
    } catch {
      // Offline: fall back to the local backup.
      input.value = store.backup;
      setStatus('offline', '离线 · 已本地备份');
    }
  } else if (store.backup) {
    input.value = store.backup;
    state.dirty = true;
    scheduleSave();
  }
  syncMirror();
  resize();
  const end = input.value.length;
  input.setSelectionRange(end, end);
  input.focus();
}

init();
