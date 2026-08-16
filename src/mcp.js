import { hydrateArchivedRowsByIds, keywordSearchRows, parseSearchMode } from './search.js';
import { searchSemanticIds } from './semantic.js';

const TOOLS = [
  {
    name: 'list',
    description: 'List recently archived documents.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        cursor: { type: 'string', description: 'Use the previous nextCursor value to continue.' },
      },
    },
  },
  {
    name: 'search',
    description: 'Search archived documents by keyword or semantic mode.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        mode: { type: 'string', enum: ['keyword', 'semantic'], default: 'keyword' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get',
    description: 'Get one archived document by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
    },
  },
];

export async function handleMcpRequest(request, env) {
  if (!env.WRITER_ACCESS_KEY) return notFound();
  if (!isAuthorized(request, env.WRITER_ACCESS_KEY)) return unauthorized();
  if (request.method === 'GET') {
    return json({
      name: 'writer-mcp',
      endpoint: '/mcp',
      transport: 'streamable-http',
      auth: 'Bearer WRITER_ACCESS_KEY',
    });
  }
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(rpcError(null, -32700, 'Parse error'));
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return json(rpcError(null, -32600, 'Invalid Request'));
  }

  const response = await handleRpc(payload, env);
  if (response === null) return new Response(null, { status: 202 });
  return json(response);
}

async function handleRpc(payload, env) {
  const id = Object.prototype.hasOwnProperty.call(payload, 'id') ? payload.id : null;
  const method = payload.method;
  const params = payload.params || {};

  if (method === 'notifications/initialized') return null;
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'writer', version: '0.5.0' },
      instructions: 'Read-only archive access. Use list, search, and get tools.',
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = String(params.name || '');
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    try {
      const data = await callTool(env, name, args);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
    } catch (err) {
      return rpcResult(id, {
        isError: true,
        content: [{ type: 'text', text: String(err && err.message ? err.message : err) }],
      });
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

async function callTool(env, name, args) {
  if (name === 'list') return listTool(env, args);
  if (name === 'search') return searchTool(env, args);
  if (name === 'get') return getTool(env, args);
  throw new Error(`Unknown tool: ${name}`);
}

async function listTool(env, args) {
  const limit = clampInt(args.limit, 20, 1, 100);
  const cursor = typeof args.cursor === 'string' ? args.cursor : '';
  let sql = `SELECT id, title, category, tags, summary, archived_at, updated_at
               FROM documents
              WHERE status = 'archived'`;
  const bind = [];
  if (cursor) {
    sql += ' AND archived_at < ?';
    bind.push(cursor);
  }
  sql += ' ORDER BY archived_at DESC LIMIT ?';
  bind.push(limit + 1);
  const { results } = await env.DB.prepare(sql).bind(...bind).all();
  const rows = results || [];
  const next = rows.length > limit ? rows[limit].archived_at : null;
  return {
    items: rows.slice(0, limit).map(publicMcpDoc),
    nextCursor: next,
  };
}

async function searchTool(env, args) {
  const query = String(args.query || '').trim().slice(0, 100);
  if (!query) return { mode: 'keyword', fallback: false, matches: [] };
  const mode = parseSearchMode(args.mode);
  const limit = clampInt(args.limit, 20, 1, 50);

  if (mode === 'semantic') {
    const semantic = await searchSemanticIds(env, query, { limit });
    if (semantic) {
      const rows = await hydrateArchivedRowsByIds(env, semantic.ids, { limit });
      return { mode: 'semantic', fallback: false, matches: rows.map(publicMcpDoc) };
    }
    const fallbackRows = await keywordSearchRows(env, query, { limit });
    return { mode: 'keyword', fallback: true, matches: fallbackRows.map(publicMcpDoc) };
  }

  const rows = await keywordSearchRows(env, query, { limit });
  return { mode: 'keyword', fallback: false, matches: rows.map(publicMcpDoc) };
}

async function getTool(env, args) {
  const id = String(args.id || '').trim();
  if (!id) throw new Error('id is required');
  const row = await env.DB.prepare(
    `SELECT id, title, content, formatted, category, tags, summary, archived_at, updated_at
       FROM documents
      WHERE id = ? AND status = 'archived'`
  )
    .bind(id)
    .first();
  if (!row) return { found: false };
  return {
    found: true,
    document: {
      ...publicMcpDoc(row),
      content: row.formatted || row.content || '',
    },
  };
}

function publicMcpDoc(row) {
  return {
    id: row.id,
    title: row.title || '',
    category: row.category || '',
    tags: parseTags(row.tags),
    summary: row.summary || '',
    archived_at: row.archived_at || row.updated_at || '',
  };
}

function parseTags(raw) {
  try {
    const tags = JSON.parse(raw || '[]');
    return Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isAuthorized(request, expectedKey) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const provided = auth.slice(7);
  return safeEqual(provided, expectedKey);
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const aa = enc.encode(String(a));
  const bb = enc.encode(String(b));
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function unauthorized() {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Bearer realm="writer-mcp"' },
  });
}

function notFound() {
  return new Response('Not found', { status: 404 });
}
