// Reading-page actions: reopen a document for editing, or move it to the
// trash. Deletion is reversible, so it asks once and then offers undo.
import { toast } from '/toast.js';

const id = document.currentScript?.dataset.doc
  || document.querySelector('script[data-doc]')?.dataset.doc;

document.querySelector('[data-action="edit"]')?.addEventListener('click', async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  try {
    const res = await fetch(`/api/documents/${id}/reopen`, { method: 'POST' });
    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      toast(data.status === 'processing' ? 'Agent 正在整理这篇，稍后再试' : '这篇无法修改');
      button.disabled = false;
      return;
    }
    if (!res.ok) throw new Error(`reopen ${res.status}`);
    // Hand the draft to the editor: it reads the id on load.
    localStorage.setItem('writer.docId', id);
    localStorage.removeItem('writer.backup');
    location.href = '/';
  } catch {
    toast('打开失败，稍后再试');
    button.disabled = false;
  }
});

document.querySelector('[data-action="delete"]')?.addEventListener('click', async (e) => {
  if (!confirm('把这篇移到回收站？可以在设置里恢复。')) return;
  const button = e.currentTarget;
  button.disabled = true;
  try {
    const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`delete ${res.status}`);
    sessionStorage.setItem('writer.justDeleted', id);
    location.href = '/archive';
  } catch {
    toast('删除失败，稍后再试');
    button.disabled = false;
  }
});
