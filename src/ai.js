// Model roster and Workers AI chat plumbing.
//
// Kimi K2.6 (1T, 262k context, native tool calling) is the agent brain.
// Qwen3-30B-A3B is the low-latency path (inline completion) and the
// automatic fallback whenever Kimi is unavailable (plan gate 403,
// rate limit 429, capacity errors). Both are hosted on Workers AI.
export const AGENT_MODEL = '@cf/moonshotai/kimi-k2.6';
export const FALLBACK_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
export const COMPLETION_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';

// Route calls through AI Gateway for per-call logs and cost analytics.
const GATEWAY = { id: 'default' };

export async function chat(env, model, { messages, tools, max_tokens = 1024, temperature = 0.4 }) {
  const inputs = { messages, max_tokens, temperature };
  if (tools && tools.length) inputs.tools = tools;
  let res;
  try {
    res = await env.AI.run(model, inputs, { gateway: GATEWAY });
  } catch (err) {
    // Older runtimes / local dev may reject the gateway option; retry bare.
    if (/gateway/i.test(String(err))) res = await env.AI.run(model, inputs);
    else throw err;
  }
  return normalize(res);
}

// Agent brain with fallback: Kimi first, Qwen when Kimi is unavailable.
// Qwen3 is a thinking model — the /no_think soft switch keeps it from
// spending the whole token budget on reasoning.
export async function agentChat(env, opts) {
  try {
    const r = await chat(env, AGENT_MODEL, opts);
    return { model: AGENT_MODEL, ...r };
  } catch (err) {
    console.warn('agent: kimi unavailable, falling back to qwen:', String(err).slice(0, 200));
    const messages = opts.messages.map((m, i) =>
      i === 0 && m.role === 'system' ? { ...m, content: `${m.content}\n/no_think` } : m
    );
    const r = await chat(env, FALLBACK_MODEL, { ...opts, messages });
    return { model: FALLBACK_MODEL, ...r };
  }
}

// Workers AI answers in two shapes: OpenAI-style `choices` for newer chat
// models (Kimi, Qwen3) and a flat `response` for older ones. Normalize both.
function normalize(res) {
  const msg = res && res.choices && res.choices[0] && res.choices[0].message;
  if (msg) {
    return { content: msg.content || '', toolCalls: (msg.tool_calls || []).map(shapeCall) };
  }
  return {
    content: res && typeof res.response === 'string' ? res.response : '',
    toolCalls: ((res && res.tool_calls) || []).map(shapeCall),
  };
}

function shapeCall(c, i) {
  const fn = c.function || c;
  let args = fn.arguments !== undefined ? fn.arguments : c.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args || '{}'); } catch { args = {}; }
  }
  return { id: c.id || `call:${i}`, name: fn.name || c.name || '', args: args || {} };
}

// ------------------------------------------------- inline completion

const COMPLETION_SYSTEM = [
  '你是一个写作补全引擎，负责无缝续写用户正在输入的文字。',
  '只输出紧接着已有文字的自然延续：不要重复已有内容，不要解释，不要加引号或任何前缀。',
  '延续要简短：中文不超过 30 个字，英文不超过 15 个词，并在自然的停顿处结束。',
  '使用与原文完全相同的语言、语气和文风。若原文以英文书写则续写英文。',
  '/no_think',
].join('');

export async function complete(env, context) {
  const res = await chat(env, COMPLETION_MODEL, {
    messages: [
      { role: 'system', content: COMPLETION_SYSTEM },
      { role: 'user', content: `请直接续写以下文字，从末尾无缝接上：\n\n${context}` },
    ],
    max_tokens: 64,
    temperature: 0.5,
  });
  return polishCompletion(context, res.content);
}

// Exported for tests: trims the model's echo of the context, keeps the
// suggestion inside one paragraph, and caps it at a sentence boundary.
export function polishCompletion(context, raw) {
  let text = String(raw || '')
    .replace(/^[\s"'“”‘’]+/, '')
    .replace(/["'“”]+\s*$/, '');
  if (!text) return '';

  // The model sometimes repeats the tail of the context; trim the overlap.
  for (let k = Math.min(80, text.length); k > 3; k--) {
    if (context.endsWith(text.slice(0, k))) {
      text = text.slice(k).replace(/^\s+/, '');
      break;
    }
  }

  // Keep the suggestion inside the current paragraph.
  const para = text.indexOf('\n\n');
  if (para !== -1) text = text.slice(0, para);
  text = text.replace(/\n{2,}/g, '\n');

  // Cap length. A short complete sentence reads better as a ghost
  // suggestion than a long one cut mid-clause, so any sentence boundary
  // in range wins over the hard cut.
  if (text.length > 80) {
    const head = text.slice(0, 80);
    const stops = ['。', '！', '？', '；', '. ', '! ', '? '];
    let cut = -1;
    for (const s of stops) cut = Math.max(cut, head.lastIndexOf(s));
    text = cut > 2 ? head.slice(0, cut + 1).trimEnd() : head;
  }
  return text;
}
