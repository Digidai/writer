<div align="center">

# Writer

**一个安静的、专注于输入的写作工具。落笔即存，其余交给 Agent。**

[![MIT License](https://img.shields.io/badge/License-MIT-b3432b?style=flat-square)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%C2%B7%20D1%20%C2%B7%20R2%20%C2%B7%20Workflows-f38020?style=flat-square)](https://developers.cloudflare.com/workers/)
[![Workers AI](https://img.shields.io/badge/AI-Kimi%20K2.6%20%2B%20Qwen3-5b54ef?style=flat-square)](https://developers.cloudflare.com/workers-ai/)
[![No dependencies](https://img.shields.io/badge/runtime%20deps-0-6f6a60?style=flat-square)](package.json)

[**在线体验 writer.genedai.md**](https://writer.genedai.md) · [架构](#架构) · [部署](#快速开始) · [English](#english)

<img src="docs/screenshot-editor-light.png#gh-light-mode-only" alt="Writer 编辑器：A4 画布与灰色的 AI 续写建议" width="100%">
<img src="docs/screenshot-editor-dark.png#gh-dark-mode-only" alt="Writer 编辑器：A4 画布与灰色的 AI 续写建议" width="100%">

</div>

## 为什么

市面上的笔记工具都在做加法：双链、看板、数据库视图、插件市场。但写作真正的瓶颈从来不是组织能力不够，而是「开始写」这件事太难。每次打开笔记软件，你要先决定放进哪个文件夹、套用哪个模板、打上什么标签，而这些决策消耗掉的，恰恰是准备落笔的那点动力。

Writer 反过来做减法。它只提供一张随时摊开的纸：你负责写，写完之后的分类、解析、排版、归档，全部交给一个自动运行的 Agent。你不需要管理任何东西，也不需要关心它是怎么整理的。

## 它如何工作

**书写。** 页面主体是一张 A4 纸样式的画布。打开即写，内容随输入自动保存到云端与本地，关掉页面、断网、切换标签页都不会丢。正文使用[霞鹜文楷](https://github.com/lxgw/LxgwWenKai)排版，中英文混排时字重与基线保持一致。

**联想。** 输入停顿时，AI 会在光标后给出一段浅灰色的续写建议，交互与 Cursor / VS Code 的代码补全一致：`Tab` 采纳，`Esc` 忽略，继续打字则自动消失。它只做轻量的输入辅助，不会改写你已经写下的内容。

**归档。** 一篇内容完成后（点击「完成」、按 `⌘⏎`，或静置数分钟自动触发），归档 Agent 接手：它先查看档案库现有的分类体系、检索相似的旧文，再决定这篇的标题、分类、标签、摘要与排版，最后存为 Markdown 文件。

**回头修改。** 归档后的内容不是只读的。在阅读页点「修改」，它会变回草稿回到编辑器，改完重新交给 Agent 归档；点「删除」则移入回收站，可以立刻撤销，也可以之后在设置里恢复。彻底删除会同时移除 R2 中的 Markdown 文件。

<table>
<tr>
<td width="50%"><img src="docs/screenshot-archive-light.png#gh-light-mode-only" alt="归档页"><img src="docs/screenshot-archive-dark.png#gh-dark-mode-only" alt="归档页"></td>
<td width="50%"><img src="docs/screenshot-reader-light.png#gh-light-mode-only" alt="阅读页"><img src="docs/screenshot-reader-dark.png#gh-dark-mode-only" alt="阅读页"></td>
</tr>
<tr>
<td align="center"><b>/archive</b> 按 Agent 维护的分类陈列，支持检索</td>
<td align="center"><b>/d/:id</b> 排版后的正文、决策轨迹与原文件下载</td>
</tr>
</table>

## 架构

三层：浏览器只管输入与浏览，Worker 在边缘处理请求，重活交给平台。

<img src="docs/architecture-light.svg#gh-light-mode-only" alt="Writer 系统架构图" width="100%">
<img src="docs/architecture-dark.svg#gh-dark-mode-only" alt="Writer 系统架构图" width="100%">

### 归档 Agent

归档不是一次 LLM 调用，而是一个跑在 [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) 里的多轮工具使用 Agent。每篇完成的文档启动一个独立的 Workflow 实例，Kimi K2.6 在其中自主决定调用哪些工具、调用几轮，直到提交归档结果。

<img src="docs/agent-light.svg#gh-light-mode-only" alt="Writer 归档 Agent 流程图" width="100%">
<img src="docs/agent-dark.svg#gh-dark-mode-only" alt="Writer 归档 Agent 流程图" width="100%">

这样设计带来三件事：

1. **分类体系会生长。** Agent 每次归档前都会先看现有分类和最近的归档，优先复用，必要时才新建。分类不是写死在代码里的枚举，而是随着你写的内容自然演化。
2. **中断可以恢复。** 每个 Agent 回合都是一个独立重试、可断点续跑的 Workflow step。模型超时、进程被驱逐、D1 抖动，都会从上一个完成的回合继续，而不是把文档卡在「整理中」。Cron 每 10 分钟巡检一次，认领任何掉队的文档。
3. **过程是透明的。** 每次归档的决策轨迹（哪个模型、调用了哪些工具、检索了什么）都会保存下来，在阅读页可以展开查看。

降级路径也是明确的：Kimi 不可用时自动切到 Qwen3；Agent 整体失败时退回启发式规则归档（首行做标题、原文保留）。任何情况下用户写的内容都不会丢失或被截断。

## 技术栈

全部构建在 Cloudflare 上，没有外部 API，没有前端框架，没有打包器，没有运行时依赖。`src/` 与 `public/` 里的代码就是部署上去的代码。

| 组件 | 用途 |
| --- | --- |
| [Workers](https://developers.cloudflare.com/workers/) | API、阅读页服务端渲染、Cron 巡检 |
| [Workflows](https://developers.cloudflare.com/workflows/) | 归档 Agent 的持久化执行 |
| [Workers AI](https://developers.cloudflare.com/workers-ai/) | Kimi K2.6（Agent 大脑）、Qwen3-30B（输入联想与降级） |
| [AI Gateway](https://developers.cloudflare.com/ai-gateway/) | 每次模型调用的日志、成本与延迟分析 |
| [Workers Assets](https://developers.cloudflare.com/workers/static-assets/) | 编辑器与归档页的静态资源 |
| [D1](https://developers.cloudflare.com/d1/) | 文档目录、状态机与关键词检索 |
| [R2](https://developers.cloudflare.com/r2/) | 归档后的 Markdown 文件空间 |

## 快速开始

需要一个 Cloudflare 账户和 Node.js 18+。

```bash
git clone https://github.com/Digidai/writer.git
cd writer
npm install
```

创建资源（首次部署前执行一次）：

```bash
npx wrangler d1 create writer-db
npx wrangler r2 bucket create writer-files
```

把上一步返回的 `database_id` 填进 `wrangler.jsonc`，并把 `account_id` 换成你自己的（`npx wrangler whoami` 可以查到），然后应用迁移并部署：

```bash
npm run db:remote
npm run deploy
```

默认部署到 `<name>.workers.dev`。要绑定自己的域名，修改 `wrangler.jsonc` 里的 `routes`（域名所在的 zone 需要在同一个 Cloudflare 账户下）。

本地开发：

```bash
npm run db:local
npm run dev
npm test
```

本地开发时 D1 与 R2 是本地模拟的，Workers AI 始终走远程（会产生真实用量）。

## 配置

### 模型

模型在 [src/ai.js](src/ai.js) 顶部声明，可以换成 [Workers AI 目录](https://developers.cloudflare.com/workers-ai/models/)里任意支持工具调用的文本模型：

```js
export const AGENT_MODEL = '@cf/moonshotai/kimi-k2.6';        // Agent 大脑：262k 上下文，原生工具调用
export const FALLBACK_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';   // Kimi 不可用时自动降级
export const COMPLETION_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8'; // 输入联想：低延迟，/no_think
```

Kimi K2.6 属于 Workers AI 的前沿模型，需要 Workers Paid（$5/月）或预付 AI Gateway 额度，免费计划调用会返回 403。此时 Writer 会自动降级到 Qwen3，功能不受影响。参考价格：Kimi $0.95/M 输入、$4.00/M 输出，归档一篇普通长度的文章约几美分；Qwen3-30B 在免费额度内即可运行。

### 偏好设置

`/settings` 页面的偏好保存在 D1 里（不是浏览器本地），所以换设备打开也一致，服务端的 Cron 与 Agent 读的是同一份：

| 设置 | 作用 |
| --- | --- |
| 界面语言 | 中文 / English，默认跟随浏览器 |
| 正文字号 / 主题 | 纸面与阅读页的排版和明暗，浅色深色可以强制指定 |
| 输入联想 / 灵敏度 | 关闭后不再请求模型；灵敏度决定停顿多久给建议 |
| Agent 排版 | 关闭后 Agent 只做分类、标签与摘要，正文一字不动 |
| 静置自动归档 | 停笔多久后自动归档，可以关掉只保留手动「完成」 |

同一页底部是回收站，可以恢复或彻底删除。

### 访问密钥

公开部署的实例任何人都能写入。如果想上锁：

```bash
npx wrangler secret put WRITER_ACCESS_KEY
```

之后访问一次 `/unlock` 输入密钥即可（Cookie 有效期 180 天）。不设置该 secret 则为开放实例。

## 项目结构

```
src/
  index.js      路由、API、访问控制、Cron 入口
  pipeline.js   WriterPipeline：归档 Agent 的 Workflow 定义
  agent.js      流水线启动、Cron 巡检、启发式兜底、R2 文件写入
  ai.js         模型声明、工具调用协议、降级逻辑、输入联想
  settings.js   实例设置的读写与校验
  markdown.js   零依赖 Markdown 渲染器（先转义再解析）
  html.js       阅读页与解锁页的服务端渲染
public/
  index.html    编辑器
  app.js        自动保存、幽灵补全、多标签页协调、归档触发
  archive.html  归档页
  archive.js    分类陈列、检索、删除撤销
  settings.html 设置页
  settings.js   偏好开关与回收站
  doc.js        阅读页的修改与删除
  toast.js      共用的提示条
  i18n.js       中英词典，浏览器与 Worker 共用同一份
  style.css     全部样式（含深色模式与打印样式）
  fonts/        霞鹜文楷屏幕阅读版切片（OFL）
migrations/     D1 迁移，npm run db:remote 应用
docs/           架构图与截图（scripts/make-diagrams.py 生成）
test/           node:test 单元测试
```

## 路线图

- [ ] 用 [AI Search](https://developers.cloudflare.com/ai-search/) 索引 R2 中的 Markdown，把关键词检索升级为语义检索
- [ ] 把档案库暴露为 MCP server，让其他 AI 客户端可以读取自己的写作
- [ ] 移动端输入体验打磨
- [ ] 导出全部档案为 zip

## 贡献

欢迎 issue 和 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。这个项目刻意保持简单：任何增加依赖、引入构建步骤，或者要求用户在写作之外做决策的改动，都需要先在 issue 里讨论清楚。

## 致谢

- [霞鹜文楷](https://github.com/lxgw/LxgwWenKai) by 落霞孤鹜，SIL OFL 1.1 授权，本项目使用其屏幕阅读版切片
- [Cloudflare Workers 平台](https://developers.cloudflare.com/)与 Workers AI 上开源的 Kimi、Qwen 模型

## License

[MIT](LICENSE)

---

## English

**Writer is a quiet, input-focused writing surface built entirely on the Cloudflare stack.**

You write on an A4-like canvas; everything else is handled for you. Text autosaves continuously (cloud plus local backup), and an inline AI suggests light continuations as you pause, accepted with `Tab` exactly like code completion in Cursor or VS Code.

When a piece is finished, an archiving agent takes over inside a durable [Cloudflare Workflow](https://developers.cloudflare.com/workflows/). Kimi K2.6 runs a multi-turn tool-use loop: it inspects the archive's existing taxonomy, searches similar past pieces, then files the document with a title, category, tags, summary and clean typesetting, and mirrors a Markdown file to R2. Every agent turn is an independently retried, resumable step, so a model timeout or an evicted isolate never strands a document. The decision trace is saved and visible on each document's page. If Kimi is unavailable the agent falls back to Qwen3; if the agent fails entirely, heuristics take over. User content is never lost or truncated.

The interface speaks Chinese and English, following your browser by default and switchable in settings; the agent writes each document's title, tags and summary in that document's own language. Archived pieces are not read-only: "Modify" turns one back into a draft and re-runs the pipeline when you finish, while "Delete" moves it to a trash you can undo immediately or restore later.

Browse and search everything at `/archive`. No framework, no bundler, no runtime dependencies: what is in `src/` and `public/` is what gets deployed. See [快速开始](#快速开始) for deploy steps (the commands are language-neutral), and [src/ai.js](src/ai.js) to swap models. Note that Kimi K2.6 requires a Workers Paid plan; on the free plan Writer automatically runs on Qwen3 instead.
