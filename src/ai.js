// Workers AI helpers: inline completion + the archiving agent.
// Swap models here if your account prefers others (`npx wrangler ai models`).
export const COMPLETION_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
export const AGENT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

// Above this size the agent only extracts metadata and keeps the original
// text as-is, so a truncated model response can never eat the document.
const FORMAT_LIMIT = 8000;

const COMPLETION_SYSTEM = [
  '你是一个写作补全引擎，负责无缝续写用户正在输入的文字。',
  '只输出紧接着已有文字的自然延续：不要重复已有内容，不要解释，不要加引号或任何前缀。',
  '延续要简短：中文不超过 30 个字，英文不超过 15 个词，并在自然的停顿处结束。',
  '使用与原文完全相同的语言、语气和文风。若原文以英文书写则续写英文。',
].join('');

export async function complete(env, context) {
  const res = await env.AI.run(COMPLETION_MODEL, {
    messages: [
      { role: 'system', content: COMPLETION_SYSTEM },
      { role: 'user', content: `请直接续写以下文字，从末尾无缝接上：\n\n${context}` },
    ],
    max_tokens: 64,
    temperature: 0.5,
  });
  return polishCompletion(context, textOf(res));
}

function polishCompletion(context, raw) {
  let text = String(raw || '')
    .replace(/^[\s"'“”‘’]+/, '')
    .replace(/["'“”]+\s*$/, '');
  if (!text) return '';

  // The model sometimes repeats the tail of the context; trim the overlap.
  for (let k = Math.min(80, text.length); k > 3; k--) {
    if (context.endsWith(text.slice(0, k))) {
      text = text.slice(k).replace(/^[\s]+/, '');
      break;
    }
  }

  // Keep the suggestion inside the current paragraph.
  const para = text.indexOf('\n\n');
  if (para !== -1) text = text.slice(0, para);
  text = text.replace(/\n{2,}/g, '\n');

  // Cap length, preferring a sentence boundary.
  if (text.length > 80) {
    const head = text.slice(0, 80);
    const stops = ['。', '！', '？', '；', '. ', '! ', '? '];
    let cut = -1;
    for (const s of stops) cut = Math.max(cut, head.lastIndexOf(s));
    text = cut > 20 ? head.slice(0, cut + 1).trimEnd() : head;
  }
  return text;
}

export const CATEGORIES = ['随笔', '笔记', '工作', '灵感', '清单', '日记', '信件', '其他'];

const AGENT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '标题，不超过 20 个字' },
    category: { type: 'string', enum: CATEGORIES },
    tags: { type: 'array', items: { type: 'string' }, description: '1 到 4 个简短标签' },
    summary: { type: 'string', description: '不超过 60 个字的摘要' },
    formatted: { type: 'string', description: '整理排版后的 Markdown 全文' },
  },
  required: ['title', 'category', 'tags', 'summary'],
};

function agentSystem(withFormatting) {
  const base = [
    '你是 Writer 的归档整理 Agent。用户写完一段内容后，你负责对它分类、解析和排版。',
    '严格输出一个 JSON 对象，不要输出 JSON 之外的任何文字。字段：',
    '"title"：标题，不超过 20 个字；若原文已有明显标题则沿用。',
    `"category"：从以下分类中选择一个：${CATEGORIES.map((c) => `"${c}"`).join('、')}。`,
    '"tags"：1 到 4 个简短标签组成的数组。',
    '"summary"：不超过 60 个字的摘要，使用与原文相同的语言。',
  ];
  if (withFormatting) {
    base.push(
      '"formatted"：将原文整理排版后的完整 Markdown：补充合适的标题与分段，把并列内容整理为列表，修正明显的错别字与标点。',
      '排版时保持原文语言、语义与观点，不改写内容，不增删信息，不添加原文没有的评论。'
    );
  }
  return base.join('\n');
}

// Ask the agent to organize a document. Returns a plain object or null.
export async function organize(env, content) {
  const withFormatting = content.length <= FORMAT_LIMIT;
  const messages = [
    { role: 'system', content: agentSystem(withFormatting) },
    { role: 'user', content },
  ];

  const schema = withFormatting
    ? AGENT_SCHEMA
    : { ...AGENT_SCHEMA, properties: { ...AGENT_SCHEMA.properties, formatted: undefined } };

  let res;
  try {
    res = await env.AI.run(AGENT_MODEL, {
      messages,
      max_tokens: 4096,
      temperature: 0.2,
      response_format: { type: 'json_schema', json_schema: pruneSchema(schema) },
    });
  } catch {
    // Some models reject response_format; fall back to plain prompting.
    res = await env.AI.run(AGENT_MODEL, { messages, max_tokens: 4096, temperature: 0.2 });
  }
  return parseJson(res);
}

function pruneSchema(schema) {
  const properties = {};
  for (const [k, v] of Object.entries(schema.properties)) if (v) properties[k] = v;
  return { ...schema, properties };
}

function textOf(res) {
  if (res == null) return '';
  if (typeof res === 'string') return res;
  if (typeof res.response === 'string') return res.response;
  if (res.response && typeof res.response === 'object') return JSON.stringify(res.response);
  if (Array.isArray(res.choices) && res.choices[0]?.message?.content) {
    return res.choices[0].message.content;
  }
  return '';
}

function parseJson(res) {
  if (res && typeof res.response === 'object' && res.response !== null) return res.response;
  const text = textOf(res);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
