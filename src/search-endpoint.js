import { keywordSearchRows, hydrateArchivedRowsByIds, parseSearchMode } from './search.js';
import { searchSemanticIds } from './semantic.js';

export async function searchDocumentsData(env, url, { mapDoc = (row) => row, limit = 50 } = {}) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  if (!q) return { documents: [], query: '', mode: 'keyword', fallback: false };

  const requestedMode = parseSearchMode(url.searchParams.get('mode'));
  const safeLimit = Math.max(1, Math.min(limit, 100));
  if (requestedMode === 'semantic' && env.WRITER_ACCESS_KEY) {
    const semantic = await searchSemanticIds(env, q, { limit: safeLimit });
    if (semantic) {
      const rows = await hydrateArchivedRowsByIds(env, semantic.ids, { limit: safeLimit });
      return { documents: rows.map((r) => mapDoc(r)), query: q, mode: 'semantic', fallback: false };
    }
    const fallbackRows = await keywordSearchRows(env, q, { limit: safeLimit });
    return { documents: fallbackRows.map((r) => mapDoc(r)), query: q, mode: 'keyword', fallback: true };
  }

  const rows = await keywordSearchRows(env, q, { limit: safeLimit });
  return { documents: rows.map((r) => mapDoc(r)), query: q, mode: 'keyword', fallback: false };
}
