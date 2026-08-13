# Writer

一个安静的、专注于输入的网页写作工具。落笔即存，其余交给 AI。

**Live: [writer.genedai.md](https://writer.genedai.md)**

Writer 只关心一件事：让你专注地把字写下来。分类、解析、排版、归档，全部由 Agent 在后台自动完成，你不需要管理任何东西。

## 它如何工作

**书写。** 页面主体是一张 A4 纸样式的画布。打开即写，内容随输入自动保存，关掉页面也不会丢。

**联想。** 输入停顿时，AI 会在光标后给出一段浅灰色的续写建议（交互与 Cursor / VS Code 的代码补全一致）：`Tab` 采纳，`Esc` 忽略，继续打字则自动消失。它只做轻量的输入辅助，不会改写你的内容。

**归档。** 一篇内容「完成」后（点击「完成」、按 `⌘⏎`，或静置数分钟自动触发），归档 Agent 会接手它：查看档案库现有的分类体系、检索相似的旧文，然后决定分类、标签、摘要与排版，存储为 Markdown 文件。整理好的内容在 [/archive](https://writer.genedai.md/archive) 中按分类陈列，可检索、可阅读、可下载原文件。每篇文档的阅读页都保留了 Agent 的决策轨迹。

## Agent 架构

归档不是一次 LLM 调用，而是一个跑在 [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) 里的多轮工具使用 Agent：

```
finalize / cron 认领文档
        │
        ▼
WriterPipeline（Workflow 实例，每篇文档一个）
  step: load-document
  step: agent-turn-1..6     ← Kimi K2.6 自主循环：
        ├ list_categories      查看现有分类体系，保持归类一致
        ├ search_archive       检索相似旧文作参考
        └ finish               提交 title/category/tags/summary/formatted
  step: persist              校验 + 兜底 + 写入 D1（含决策轨迹）
  step: store-file           镜像为 R2 中的 Markdown 文件
```

每个 Agent 回合都是一个可重试、断点续跑的 Workflow step：模型超时、进程被驱逐或 D1 抖动都会从上一个完成的回合恢复，不会把文档卡在「整理中」。Agent 失败时退回启发式规则归档，用户内容永远不丢。分类体系由 Agent 自己维护：它优先复用已有分类，仅在必要时创建新分类。

## 技术栈

全部构建在 Cloudflare 上，无外部 API：

| 组件 | 用途 |
| --- | --- |
| [Workers](https://developers.cloudflare.com/workers/) | API、阅读页渲染 |
| [Workflows](https://developers.cloudflare.com/workflows/) | 归档 Agent 的持久化执行 |
| [Workers AI](https://developers.cloudflare.com/workers-ai/) | Kimi K2.6（Agent 大脑）+ Qwen3-30B（输入联想 / 兜底） |
| [AI Gateway](https://developers.cloudflare.com/ai-gateway/) | 每次模型调用的日志与成本分析（`gateway: {id:"default"}`） |
| [Workers Assets](https://developers.cloudflare.com/workers/static-assets/) | 编辑器与归档页（纯静态，无构建步骤） |
| [D1](https://developers.cloudflare.com/d1/) | 文档目录与检索 |
| [R2](https://developers.cloudflare.com/r2/) | 归档后的 Markdown 文件 |
| Cron Triggers | 认领被遗忘的草稿、复活死掉的流水线 |

没有前端框架，没有打包器，没有 npm 运行时依赖。`src/` 与 `public/` 里的代码就是部署的代码。

## 部署自己的 Writer

```bash
git clone https://github.com/Digidai/writer.git
cd writer
npm install

# 创建资源（首次）
npx wrangler d1 create writer-db     # 把返回的 database_id 填入 wrangler.jsonc
npx wrangler r2 bucket create writer-files
npm run db:remote                    # 初始化表结构

npm run deploy
```

本地开发：

```bash
npm run db:local
npm run dev
```

默认部署到 `<name>.workers.dev`。要绑定自己的域名，修改 `wrangler.jsonc` 中的 `routes`（域名所在 zone 需在同一 Cloudflare 账户下）。

### 可选：访问密钥

公开部署的实例任何人都能写入。如果想上锁：

```bash
npx wrangler secret put WRITER_ACCESS_KEY
```

之后在浏览器访问一次 `/unlock?key=你的密钥` 即可（Cookie 有效期 180 天）。不设置该 secret 则为开放实例。

### 模型与费用

模型在 [src/ai.js](src/ai.js) 顶部声明：

```js
export const AGENT_MODEL = '@cf/moonshotai/kimi-k2.6';        // Agent 大脑：262k 上下文，多轮工具调用
export const FALLBACK_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';   // Kimi 不可用时自动降级
export const COMPLETION_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8'; // 输入联想：低延迟（/no_think）
```

注意：Kimi K2.6 属于 Workers AI 的前沿模型，需要 Workers Paid（$5/月）或预付 AI Gateway 额度，免费计划会返回 403（此时自动降级到 Qwen，功能不受影响）。Kimi 定价 $0.95/M 输入、$4.00/M 输出，归档一篇普通长度的文章约几美分；Qwen3-30B 在免费额度内可用。

## English

Writer is a quiet, input-focused writing surface built entirely on the Cloudflare stack. You just write on an A4-like canvas: everything autosaves, an inline AI (Qwen3) suggests light continuations as you pause (accept with `Tab`, like code completion in Cursor / VS Code). When a piece is done, an archiving agent takes over inside a durable Cloudflare Workflow: Kimi K2.6 runs a multi-turn tool-use loop (inspect the existing taxonomy, search similar past pieces, then file the document with category/tags/summary/typesetting), persists the decision trace, and mirrors a Markdown file to R2. Browse and search everything at `/archive`. No framework, no bundler, no runtime dependencies. See the deploy steps above.

## License

[MIT](LICENSE)
