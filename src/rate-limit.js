const RL_ORIGIN = 'https://writer-rate-limit.local';

export async function enforceRateLimit(request, { bucket, limit, windowMs, cache = caches.default, now = Date.now }) {
  if (!bucket || !Number.isFinite(limit) || limit <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('invalid rate limit config');
  }

  const nowMs = Number(now());
  const key = makeCacheKey(clientIp(request), bucket);
  const cacheKey = new Request(key);
  const state = (await readState(cache, cacheKey)) || freshState(nowMs, windowMs);

  if (state.resetAt <= nowMs) {
    state.count = 0;
    state.resetAt = nowMs + windowMs;
  }

  if (state.count >= limit) return tooMany(state.resetAt, nowMs);

  state.count += 1;
  await writeState(cache, cacheKey, state, nowMs);
  return null;
}

function clientIp(request) {
  const ip = request.headers.get('CF-Connecting-IP');
  return ip && ip.trim() ? ip.trim() : 'unknown';
}

function makeCacheKey(ip, bucket) {
  // Required key shape: rl:{ip}:{bucket}
  return `${RL_ORIGIN}/rl:${ip}:${bucket}`;
}

function freshState(nowMs, windowMs) {
  return { count: 0, resetAt: nowMs + windowMs };
}

async function readState(cache, key) {
  const hit = await cache.match(key);
  if (!hit) return null;
  try {
    const state = await hit.json();
    return {
      count: Number(state && state.count) || 0,
      resetAt: Number(state && state.resetAt) || 0,
    };
  } catch {
    return null;
  }
}

async function writeState(cache, key, state, nowMs) {
  const ttl = Math.max(1, Math.ceil((state.resetAt - nowMs) / 1000));
  await cache.put(
    key,
    new Response(JSON.stringify({ count: state.count, resetAt: state.resetAt }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `max-age=${ttl}`,
      },
    })
  );
}

function tooMany(resetAt, nowMs) {
  const retryAfter = Math.max(1, Math.ceil((resetAt - nowMs) / 1000));
  return new Response(JSON.stringify({ error: 'rate limited' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': String(retryAfter),
    },
  });
}
