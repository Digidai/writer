import { keywordSearchRows, hydrateArchivedRowsByIds, parseSearchMode } from './search.js';
import { searchSemanticIds } from './semantic.js';
import { ownerScope } from './auth.js';

// Search the viewer's own archive. Semantic results are re-checked against
// ownership in D1, so the vector index can never surface someone else's piece.
export async function searchDocumentsData(env, url, { mapDoc = (row) => row, limit = 50, viewer } = {}) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  if (!q) return { documents: [], query: '', mode: 'keyword', fallback: false };

  const scope = ownerScope(viewer);
  const requestedMode = parseSearchMode(url.searchParams.get('mode'));
  const safeLimit = Math.max(1, Math.min(limit, 100));
  if (requestedMode === 'semantic' && env.WRITER_ACCESS_KEY) {
    const userId = viewer && viewer.user ? viewer.user.id : null;
    const semantic = await searchSemanticIds(env, q, { limit: safeLimit, userId });
    if (semantic) {
      const rows = await hydrateArchivedRowsByIds(env, semantic.ids, { limit: safeLimit, scope });
      return { documents: rows.map((r) => mapDoc(r)), query: q, mode: 'semantic', fallback: false };
    }
    const fallbackRows = await keywordSearchRows(env, q, { limit: safeLimit, scope });
    return { documents: fallbackRows.map((r) => mapDoc(r)), query: q, mode: 'keyword', fallback: true };
  }

  const rows = await keywordSearchRows(env, q, { limit: safeLimit, scope });
  return { documents: rows.map((r) => mapDoc(r)), query: q, mode: 'keyword', fallback: false };
}
