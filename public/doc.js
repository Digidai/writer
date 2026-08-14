// Reading-page actions: reopen a document for editing, or move it to the
// trash. Deletion is reversible, so it asks once and then offers undo.
import { toast } from '/toast.js';
import { makeT, resolveLang } from '/i18n.js';

const t = makeT(resolveLang(storedLang(), navigator.language));

function storedLang() {
  try {
    return JSON.parse(localStorage.getItem('writer.settings') || '{}').language;
  } catch {
    return 'auto';
  }
}

const id = document.currentScript?.dataset.doc
  || document.querySelector('script[data-doc]')?.dataset.doc;

document.querySelector('[data-action="edit"]')?.addEventListener('click', async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  try {
    const res = await fetch(`/api/documents/${id}/reopen`, { method: 'POST' });
    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      toast(t(data.status === 'processing' ? 'reader.editBusy' : 'reader.editUnavailable'));
      button.disabled = false;
      return;
    }
    if (!res.ok) throw new Error(`reopen ${res.status}`);
    // Hand the draft to the editor: it reads the id on load.
    localStorage.setItem('writer.docId', id);
    localStorage.removeItem('writer.backup');
    location.href = '/';
  } catch {
    toast(t('reader.editFailed'));
    button.disabled = false;
  }
});

document.querySelector('[data-action="delete"]')?.addEventListener('click', async (e) => {
  if (!confirm(t('reader.confirmDelete'))) return;
  const button = e.currentTarget;
  button.disabled = true;
  try {
    const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`delete ${res.status}`);
    sessionStorage.setItem('writer.justDeleted', id);
    location.href = '/archive';
  } catch {
    toast(t('reader.deleteFailed'));
    button.disabled = false;
  }
});
