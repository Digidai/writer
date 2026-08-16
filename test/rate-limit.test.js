import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceRateLimit } from '../src/rate-limit.js';

test('enforceRateLimit returns 429 with Retry-After once exhausted', async () => {
  let nowMs = 0;
  const cache = new FakeCache(() => nowMs);
  const req = new Request('https://writer.example/api/complete', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '203.0.113.7' },
  });

  const first = await enforceRateLimit(req, {
    bucket: 'complete',
    limit: 2,
    windowMs: 60_000,
    cache,
    now: () => nowMs,
  });
  const second = await enforceRateLimit(req, {
    bucket: 'complete',
    limit: 2,
    windowMs: 60_000,
    cache,
    now: () => nowMs,
  });
  const third = await enforceRateLimit(req, {
    bucket: 'complete',
    limit: 2,
    windowMs: 60_000,
    cache,
    now: () => nowMs,
  });

  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(third && third.status, 429);
  assert.equal(third && third.headers.get('Retry-After'), '60');
  assert.match([...cache.keys()][0], /rl:203\.0\.113\.7:complete$/);
});

class FakeCache {
  constructor(now) {
    this.now = now;
    this.store = new Map();
  }

  async match(request) {
    const key = request.url;
    const row = this.store.get(key);
    if (!row) return undefined;
    if (row.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return new Response(row.body, { headers: row.headers });
  }

  async put(request, response) {
    const key = request.url;
    const body = await response.text();
    const headers = Object.fromEntries(response.headers.entries());
    const cacheControl = response.headers.get('Cache-Control') || '';
    const m = cacheControl.match(/max-age=(\d+)/);
    const ttlMs = m ? Number(m[1]) * 1000 : 0;
    this.store.set(key, { body, headers, expiresAt: this.now() + ttlMs });
  }

  keys() {
    return this.store.keys();
  }
}
