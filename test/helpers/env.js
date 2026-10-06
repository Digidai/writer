// A Worker environment for tests: real migrations in node:sqlite, an
// email outbox, a workflow recorder, and a browser with a cookie jar.
import { createTestDb } from './d1.js';
import { resetSiteConfigCache } from '../../src/site-config.js';

export function installCaches() {
  const store = new Map();
  const keyOf = (req) => (typeof req === 'string' ? req : req.url);
  globalThis.caches = {
    default: {
      async match(req) {
        const hit = store.get(keyOf(req));
        return hit === undefined ? undefined : new Response(hit);
      },
      async put(req, res) {
        store.set(keyOf(req), await res.text());
      },
    },
  };
  return store;
}

function memoryBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, value) { objects.set(key, String(value)); },
    async get(key) {
      if (!objects.has(key)) return null;
      const text = objects.get(key);
      return { text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
    },
    async delete(key) { objects.delete(key); },
  };
}

export function createEnv(overrides = {}) {
  resetSiteConfigCache();
  const cache = installCaches();
  const DB = createTestDb();
  const outbox = [];
  const workflows = [];
  const pending = [];
  const env = {
    DB,
    EMAIL: {
      async send(message) {
        outbox.push(message);
        return { messageId: `msg-${outbox.length}` };
      },
    },
    PIPELINE: {
      async create(options) {
        workflows.push(options);
        return { id: options.id };
      },
    },
    ASSETS: {
      async fetch(request) {
        return new Response(`asset:${new URL(request.url).pathname}`, { headers: { 'Content-Type': 'text/html' } });
      },
    },
    FILES: memoryBucket(),
    ...overrides,
  };
  const ctx = { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})) };
  const settle = async () => {
    while (pending.length) await pending.shift();
  };
  return { env, DB, outbox, workflows, ctx, settle, cache };
}

// A browser: keeps cookies between requests, sends same-origin writes.
export function browser(worker, { env, ctx }, { origin = 'https://writer.example', ip = '203.0.113.7', ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Test' } = {}) {
  const jar = new Map();

  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const h = new Headers(headers);
    if (!h.has('CF-Connecting-IP')) h.set('CF-Connecting-IP', ip);
    if (!h.has('User-Agent')) h.set('User-Agent', ua);
    if (jar.size) h.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    let payload;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!h.has('Content-Type')) h.set('Content-Type', 'application/json');
    }
    if (method !== 'GET' && method !== 'HEAD' && !h.has('Origin')) h.set('Origin', origin);
    const res = await worker.fetch(new Request(origin + path, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
    for (const cookie of res.headers.getSetCookie()) {
      const [pair, ...attrs] = cookie.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const maxAge = attrs.map((a) => a.trim().toLowerCase()).find((a) => a.startsWith('max-age='));
      if (maxAge && Number(maxAge.split('=')[1]) === 0) jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  }

  async function json(path, options) {
    const res = await request(path, options);
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, res };
  }

  return { request, json, jar };
}

export function lastCode(outbox, email) {
  const to = String(email).trim().toLowerCase();
  const message = [...outbox].reverse().find((m) => m.to === to);
  if (!message) throw new Error(`no email to ${email}`);
  return message.text.match(/\b(\d{6})\b/)[1];
}

export async function signIn(client, outbox, email) {
  const start = await client.json('/api/auth/start', { method: 'POST', body: { email } });
  if (start.status !== 200) throw new Error(`start failed ${start.status} ${JSON.stringify(start.body)}`);
  return client.json('/api/auth/verify', { method: 'POST', body: { email, code: lastCode(outbox, email) } });
}
