// The archiving agent, rebuilt as a Cloudflare Workflow.
//
// One workflow instance per finished document. Inside it, Kimi K2.6 runs a
// real agent loop: it inspects the archive's existing taxonomy and similar
// past pieces through tools, decides how this document should be filed, and
// submits the result through a `finish` tool call. Every agent turn is a
// durable, retried workflow step — a crash or model timeout resumes from
// the last completed turn instead of stranding the document. The full
// decision trace is persisted alongside the document.
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { agentChat } from './ai.js';
import { storeFile, clip } from './agent.js';
import { readSettings } from './settings.js';
import { persistArchive } from './persist.js';

const MAX_TURNS = 6;
// Above this size the agent files metadata only and the original text is
// kept as-is, so a truncated model response can never eat the document.
const FORMAT_LIMIT = 6000;
const STEP_RETRIES = { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '4 minutes' };

export class WriterPipeline extends WorkflowEntrypoint {
  async run(event, step) {
    const { docId } = event.payload;

    const doc = await step.do('load-document', () => this.loadDoc(docId));
    if (!doc) return { skipped: docId };

    const settings = await step.do('load-settings', () => readSettings(this.env));

    const trace = [];
    let finish = null;
    let messages = buildBaseMessages(doc, settings);

    for (let turn = 1; turn <= MAX_TURNS && !finish; turn++) {
      // All side effects and model calls live inside the step; the message
      // history is rebuilt deterministically from memoized step results,
      // so replays after eviction reconstruct the exact same loop state.
      let r;
      try {
        r = await step.do(`agent-turn-${turn}`, STEP_RETRIES, () => this.turn(messages));
      } catch (err) {
        trace.push({ turn, error: String(err && err.message ? err.message : err).slice(0, 300) });
        break;
      }

      trace.push({
        turn,
        model: r.model,
        tools: r.toolCalls.map((c) => ({ name: c.name, args: c.args })),
        note: clip(String(r.content || ''), 300),
      });

      if (r.finish) {
        finish = r.finish;
        break;
      }

      if (r.toolCalls.length === 0) {
        // Prose answer without the finish call — nudge once per turn.
        messages = [
          ...messages,
          { role: 'assistant', content: r.content || '' },
          { role: 'user', content: '请调用 finish 工具提交最终归档结果，不要用普通文本回答。' },
        ];
        continue;
      }

      messages = [
        ...messages,
        {
          role: 'assistant',
          content: r.content || null,
          tool_calls: r.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
        ...r.toolResults.map((t) => ({
          role: 'tool',
          tool_call_id: t.id,
          content: JSON.stringify(t.result),
        })),
      ];
    }

    const persisted = await step.do('persist', () => persistArchive(this.env, doc, finish, trace, settings));
    if (persisted.skipped) return { skipped: doc.id, reason: persisted.reason, turns: trace.length };

    await step.do('store-file', () => storeFile(this.env, persisted.final));
    return { archived: doc.id, category: persisted.final.category, turns: trace.length };
  }

  async loadDoc(docId) {
    const row = await this.env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(docId).first();
    if (!row || row.status === 'archived') return null;
    return { id: row.id, title: row.title, content: String(row.content || ''), created_at: row.created_at };
  }

  // One reasoning turn: call the model, execute any tool calls it makes.
  async turn(messages) {
    const r = await agentChat(this.env, {
      messages,
      tools: TOOL_SPECS,
      max_tokens: 4096,
      temperature: 0.3,
    });

    let finish = null;
    const toolResults = [];
    for (const call of r.toolCalls) {
      if (call.name === 'finish') {
        finish = call.args;
        toolResults.push({ id: call.id, result: { ok: true, message: '已收到归档结果' } });
        continue;
      }
      let result;
      try {
        result = await this.runTool(call);
      } catch (err) {
        result = { error: String(err).slice(0, 200) };
      }
      toolResults.push({ id: call.id, result });
    }

    return { model: r.model, content: r.content, toolCalls: r.toolCalls, toolResults, finish };
  }

  async runTool(call) {
    if (call.name === 'list_categories') {
      const cats = await this.env.DB.prepare(
        `SELECT category, COUNT(*) AS count FROM documents
          WHERE status = 'archived' AND category IS NOT NULL
          GROUP BY category ORDER BY count DESC LIMIT 20`
      ).all();
      const recent = await this.env.DB.prepare(
        `SELECT title, category FROM documents
          WHERE status = 'archived' ORDER BY archived_at DESC LIMIT 12`
      ).all();
      return {
        categories: (cats.results || []),
        recent: (recent.results || []),
      };
    }

    if (call.name === 'search_archive') {
      const q = String(call.args && call.args.query ? call.args.query : '').slice(0, 80);
      if (!q) return { results: [] };
      const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      const { results } = await this.env.DB.prepare(
        `SELECT id, title, category, tags, summary FROM documents
          WHERE status = 'archived'
            AND (title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
          ORDER BY archived_at DESC LIMIT 5`
      ).bind(like, like, like, like).all();
      return { results: results || [] };
    }

    return { error: `未知工具: ${call.name}` };
  }

}

// ------------------------------------------------------------ prompts

function buildBaseMessages(doc, settings = {}) {
  const truncated = doc.content.length > 12000;
  const body = truncated ? `${doc.content.slice(0, 12000)}\n\n（正文过长，已截断）` : doc.content;
  // Long documents are never re-typeset (a truncated response would eat
  // text), and the writer can switch typesetting off entirely.
  const wantFormat = settings.agentFormatting !== false && doc.content.length <= FORMAT_LIMIT;

  const system = [
    '你是 Writer 的归档 Agent。用户写完一篇内容后，由你负责把它归入档案库：分类、打标签、写摘要' +
      (wantFormat ? '、整理排版' : '') + '。',
    '',
    '工作方式：',
    '1. 先调用 list_categories 了解档案库现有的分类体系与最近的归档，保持分类的一致性；',
    '2. 拿不准分类时，用 search_archive 检索相似的旧文作参考；',
    '3. 最后必须调用 finish 提交结果。不要用普通文本作为最终回答。',
    '',
    '归档规则：',
    '- 语言：title、tags、summary 一律使用与原文相同的语言（原文是英文就用英文）。',
    '- category：优先复用现有分类，即使它与原文语言不同；确实没有合适的才新建（简短名词，与原文语言一致）。',
    '- title：不超过 20 个字或 10 个英文词；原文已有明显标题则沿用。',
    '- tags：1 到 4 个简短标签。',
    '- summary：不超过 60 个字或 30 个英文词。',
    wantFormat
      ? '- formatted：整理排版后的完整 Markdown：补充合适的标题与分段，把并列内容整理为列表，修正明显的错别字与标点。保持原文语言、语义与观点，不改写内容，不增删信息。'
      : '- 不要提供 formatted 字段，原文将原样保留。',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: `请归档这篇内容：\n\n${body}` },
  ];
}

const TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'list_categories',
      description: '列出档案库现有的分类（含数量）和最近归档的文章标题，用于保持分类体系一致',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_archive',
      description: '在档案库中按关键词检索相似的旧文（标题/摘要/标签/正文），返回最多 5 条',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '检索关键词' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: '提交最终归档结果（必须调用一次作为结束）',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '标题，不超过 20 个字' },
          category: { type: 'string', description: '分类，优先复用现有分类' },
          tags: { type: 'array', items: { type: 'string' }, description: '1 到 4 个简短标签' },
          summary: { type: 'string', description: '不超过 60 个字的摘要' },
          formatted: { type: 'string', description: '整理排版后的完整 Markdown（长文可省略）' },
        },
        required: ['title', 'category', 'tags', 'summary'],
      },
    },
  },
]
