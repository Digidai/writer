const RL_ORIGIN = 'https://writer-rate-limit.local';

// `identity` overrides the client IP, e.g. to throttle per email address.
// `onLimit` runs once per window, on the first refusal (for analytics).
export async function enforceRateLimit(request, { bucket, limit, windowMs, identity, onLimit, cache = caches.default, now = Date.now }) {
  if (!bucket || !Number.isFinite(limit) || limit <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('invalid rate limit config');
  }

  const nowMs = Number(now());
  const who = identity ? encodeURIComponent(String(identity)) : clientIp(request);
  const key = makeCacheKey(who, bucket);
  const cacheKey = new Request(key);
  const state = (await readState(cache, cacheKey)) || freshState(nowMs, windowMs);

  if (state.resetAt <= nowMs) {
    state.count = 0;
    state.noted = false;
    state.resetAt = nowMs + windowMs;
  }

  if (state.count >= limit) {
    if (onLimit && !state.noted) {
      state.noted = true;
      await writeState(cache, cacheKey, state, nowMs);
      try {
        onLimit();
      } catch {
        /* reporting never changes the answer */
      }
    }
    return tooMany(state.resetAt, nowMs);
  }

  state.count += 1;
  await writeState(cache, cacheKey, state, nowMs);
  return null;
}

function clientIp(request) {
  const ip = request.headers.get('CF-Connecting-IP');
  return ip && ip.trim() ? limitKeyForIp(ip.trim()) : 'unknown';
}

// One IPv6 subscriber usually owns a whole /64, so throttle by that, not
// by the full address (otherwise one /64 is an unlimited supply of keys).
// IPv4, including IPv4-mapped IPv6, is used as is.
export function limitKeyForIp(ip) {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - left.length - right.length);
  const groups = [...left, ...Array(missing).fill('0'), ...right].slice(0, 4);
  return `${groups.map((g) => g.replace(/^0+(?=.)/, '') || '0').join(':')}::/64`;
}

function makeCacheKey(ip, bucket) {
  // Required key shape: rl:{ip}:{bucket}
  return `${RL_ORIGIN}/rl:${ip}:${bucket}`;
}

function freshState(nowMs, windowMs) {
  return { count: 0, noted: false, resetAt: nowMs + windowMs };
}

async function readState(cache, key) {
  const hit = await cache.match(key);
  if (!hit) return null;
  try {
    const state = await hit.json();
    return {
      count: Number(state && state.count) || 0,
      noted: Boolean(state && state.noted),
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
    new Response(JSON.stringify({ count: state.count, noted: state.noted, resetAt: state.resetAt }), {
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
