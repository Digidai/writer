// Model usage: one ai_calls row per Workers AI call.
//
// Workers AI reports what each call cost: chat models put token counts and
// `neurons` in `usage`, embeddings put them in `meta`. Those reported
// neurons are stored as they come; dollars are derived from them when
// /admin reads them. The list prices below only price calls whose response
// said nothing (and are shown in the console for reference).
import { nowIso } from './http.js';

// Neurons per million tokens, from the Workers AI pricing page.
export const PRICES_AS_OF = '2026-10-01';
export const PRICES = {
  '@cf/moonshotai/kimi-k2.6': { input: 86_364, cached: 14_545, output: 363_636 },
  '@cf/qwen/qwen3-30b-a3b-fp8': { input: 4_625, cached: 4_625, output: 30_475 },
  '@cf/baai/bge-m3': { input: 1_075, cached: 1_075, output: 0 },
};
// $0.011 per 1,000 neurons; 10,000 neurons a day are free, per account,
// resetting at 00:00 UTC.
export const USD_PER_NEURON = 0.011 / 1000;
export const FREE_NEURONS_PER_DAY = 10_000;

export const FEATURES = ['completion', 'agent', 'embed'];

// For responses that carry no usage at all: CJK characters are close to
// one token each, other text about four characters a token.
const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿가-힯]/g;
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(CJK_RE) || []).length;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

// Chat models: OpenAI-style `usage` plus `neurons`; cached tokens are part
// of prompt_tokens. Embeddings: `meta` with cost_metric_name_N/value_N
// pairs and `neurons`.
export function usageFrom(res) {
  if (!res || typeof res !== 'object') return null;
  const u = res.usage;
  if (u && typeof u === 'object' && Number.isFinite(Number(u.prompt_tokens ?? u.input_tokens))) {
    const input = count(u.prompt_tokens ?? u.input_tokens);
    const details = u.prompt_tokens_details || {};
    const outDetails = u.completion_tokens_details || {};
    const output = count(u.completion_tokens ?? u.output_tokens);
    return {
      input,
      cached: Math.min(count(details.cached_tokens), input),
      output,
      reasoning: Math.min(count(outDetails.reasoning_tokens), output),
      neurons: Number.isFinite(Number(u.neurons)) ? Number(u.neurons) : null,
      estimated: false,
    };
  }
  const meta = res.meta;
  if (meta && typeof meta === 'object') {
    const metrics = {};
    for (let i = 1; i <= 5; i++) {
      const name = meta[`cost_metric_name_${i}`];
      if (name) metrics[name] = count(meta[`cost_metric_value_${i}`]);
    }
    const neurons = Number.isFinite(Number(meta.neurons)) ? Number(meta.neurons) : null;
    if (neurons === null && metrics.input_tokens === undefined) return null;
    return {
      input: metrics.input_tokens || 0,
      cached: 0,
      output: metrics.output_tokens || 0,
      reasoning: 0,
      neurons,
      estimated: false,
    };
  }
  return null;
}

// List-price neurons for a bundle of tokens (cached input at the cached rate).
export function listNeurons(model, { input = 0, cached = 0, output = 0 } = {}) {
  const p = PRICES[model];
  if (!p) return 0;
  return (Math.max(0, input - cached) * p.input + cached * p.cached + output * p.output) / 1e6;
}

export function errorText(err) {
  const s = String(err && err.message ? err.message : err || 'error').replace(/\s+/g, ' ').trim();
  return s.slice(0, 160) || 'error';
}

// Workers AI errors start with a four-digit code ("3040: Capacity ...").
export function errorCode(text) {
  const m = String(text || '').match(/^(?:\w*Error:\s*)?(\d{4})\b/);
  return m ? m[1] : null;
}

// `meter` says who asked: { feature, userId, docId, turn, fallback, ctx }.
// With a request context the write happens after the response; inside a
// workflow step it is awaited (and never throws).
export function meterCall(env, meter, call) {
  const m = meter || {};
  const pending = recordAiCall(env, {
    feature: m.feature || 'other',
    userId: m.userId || null,
    docId: m.docId || null,
    turn: Number.isInteger(m.turn) ? m.turn : null,
    fallback: Boolean(m.fallback),
    ...call,
  });
  if (m.ctx && typeof m.ctx.waitUntil === 'function') {
    m.ctx.waitUntil(pending);
    return Promise.resolve();
  }
  return pending;
}

export async function recordAiCall(env, {
  feature, model, status, error = null, fallback = false, latency = 0, usage = null,
  userId = null, docId = null, turn = null, toolCalls = 0, finishReason = null, logId = null, now = Date.now(),
}) {
  if (!env || !env.DB) return;
  try {
    const ts = nowIso(now);
    const u = usage || {};
    const neurons = u.neurons === null || u.neurons === undefined
      ? (status === 'error' ? null : listNeurons(model, u))
      : u.neurons;
    await env.DB.prepare(
      `INSERT INTO ai_calls (ts, day, feature, model, status, error, fallback, latency_ms, input_tokens, cached_tokens,
                             output_tokens, reasoning_tokens, neurons, estimated, user_id, doc_id, turn, tool_calls,
                             finish_reason, log_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        ts, ts.slice(0, 10), String(feature).slice(0, 20), String(model).slice(0, 80), status,
        error ? String(error).slice(0, 160) : null, fallback ? 1 : 0, Math.max(0, Math.round(latency) || 0),
        u.input || 0, u.cached || 0, u.output || 0, u.reasoning || 0, neurons, u.estimated ? 1 : 0,
        userId, docId, turn, toolCalls || 0, finishReason ? String(finishReason).slice(0, 30) : null,
        logId ? String(logId).slice(0, 80) : null,
      )
      .run();
  } catch (err) {
    console.warn('model call not recorded', err && err.message);
  }
}
