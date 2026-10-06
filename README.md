<div align="center">

# Writer

**一个安静的、专注于输入的写作工具。落笔即存，其余交给 Agent。**

[![MIT License](https://img.shields.io/badge/License-MIT-b3432b?style=flat-square)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%C2%B7%20D1%20%C2%B7%20R2%20%C2%B7%20Workflows-f38020?style=flat-square)](https://developers.cloudflare.com/workers/)
[![Workers AI](https://img.shields.io/badge/AI-Kimi%20K2.6%20%2B%20Qwen3-5b54ef?style=flat-square)](https://developers.cloudflare.com/workers-ai/)
[![No dependencies](https://img.shields.io/badge/runtime%20deps-0-6f6a60?style=flat-square)](package.json)

[**在线体验 writer.genedai.md**](https://writer.genedai.md) · [架构](#架构) · [部署](#快速开始) · [English](#english)

> [!NOTE]
> **writer.genedai.md 是公开实例**：打开就能写，不需要账户；想把写完的内容存进档案时，用邮箱验证码登录即可，之前写下的草稿会一起归入你的账户。每个账户的档案只有自己能看到；实例运营者可以在 `/admin` 后台看到全部内容与使用数据。

<img src="docs/screenshot-editor-light.png#gh-light-mode-only" alt="Writer 编辑器：A4 画布与灰色的 AI 续写建议" width="100%">
<img src="docs/screenshot-editor-dark.png#gh-dark-mode-only" alt="Writer 编辑器：A4 画布与灰色的 AI 续写建议" width="100%">

</div>

## 为什么

市面上的笔记工具都在做加法：双链、看板、数据库视图、插件市场。但写作真正的瓶颈从来不是组织能力不够，而是「开始写」这件事太难。每次打开笔记软件，你要先决定放进哪个文件夹、套用哪个模板、打上什么标签，而这些决策消耗掉的，恰恰是准备落笔的那点动力。

Writer 反过来做减法。它只提供一张随时摊开的纸：你负责写，写完之后的分类、解析、排版、归档，全部交给一个自动运行的 Agent。你不需要管理任何东西，也不需要关心它是怎么整理的。

## 它如何工作

**书写。** 页面主体是一张 A4 纸样式的画布。打开即写，内容随输入自动保存到云端与本地，关掉页面、断网、切换标签页都不会丢。正文使用[思源黑体](https://github.com/notofonts/noto-cjk)（Noto Sans SC）排版，拉丁字形取自 Source Sans，中英文混排时字重与基线保持一致。

**联想。** 输入停顿时，AI 会在光标后给出一段浅灰色的续写建议，交互与 Cursor / VS Code 的代码补全一致：`Tab` 采纳，`Esc` 忽略，继续打字则自动消失。触屏设备会在建议出现时显示「采纳 / 忽略」底栏，不依赖实体键盘。

**归档。** 一篇内容完成后（点击「完成」、按 `⌘⏎`，或静置数分钟自动触发），归档 Agent 接手：它先查看档案库现有的分类体系、检索相似的旧文，再决定这篇的标题、分类、标签、摘要与排版，最后存为 Markdown 文件。

**账户。** 打开就能写，不需要先注册。第一次点「完成」时，Writer 会请你留一个邮箱：收到 6 位验证码、输入，账户就建好了，这台浏览器上之前写的草稿会一起归入账户，然后照常交给 Agent。没有密码要记，下次换设备登录也是同一个邮箱。

**回头修改。** 归档后的内容不是只读的。在阅读页点「修改」，它会变回草稿回到编辑器，改完重新交给 Agent 归档；点「删除」则移入回收站，可以立刻撤销，也可以之后在设置里恢复。彻底删除会同时移除 R2 中的 Markdown 文件。

<table>
<tr>
<td width="50%"><img src="docs/screenshot-archive-light.png#gh-light-mode-only" alt="归档页"><img src="docs/screenshot-archive-dark.png#gh-dark-mode-only" alt="归档页"></td>
<td width="50%"><img src="docs/screenshot-reader-light.png#gh-light-mode-only" alt="阅读页"><img src="docs/screenshot-reader-dark.png#gh-dark-mode-only" alt="阅读页"></td>
</tr>
<tr>
<td align="center"><b>/archive</b> 按 Agent 维护的分类陈列，支持关键词检索与整库 zip 导出</td>
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
2. **中断可以恢复。** 每个 Agent 回合都是一个独立重试、可断点续跑的 Workflow step。模型超时、进程被驱逐、D1 抖动，都会从上一个完成的回合继续，而不是把文档卡在「整理中」。Cron 每 10 分钟巡检一次：草稿按 `idleArchiveMinutes × 3`（且至少 2 字）兜底归档；`processing` 超过 15 分钟会重启流水线。私有模式下它还会顺带补齐历史归档的语义向量（每轮小批次）。编辑器前台静置自动归档仍是 `idleArchiveMinutes × 1`（且至少 30 字）。
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
| [Email Service](https://developers.cloudflare.com/email-service/) | 登录验证码邮件 |

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

### 登录与邮件

登录用邮箱验证码，通过 [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) 发送（`wrangler.jsonc` 里的 `send_email` 绑定，发件地址是 `MAIL_FROM` 变量）。部署前需要在 Cloudflare 后台为发件域名完成一次接入：**Compute > Email Service > Email Sending > Onboard Domain**，它会在 `cf-bounce` 子域上添加 SPF、DKIM 和 DMARC 记录，不影响域名已有的邮件配置。

接入之前验证码发不出去，登录接口会返回 `503 email_unavailable`，后台「设置」页会显示「邮件发送：未配置」。本地 `npm run dev` 不会真的发信，邮件内容会打印在终端里。

验证码 10 分钟有效、只能用一次、最多试 5 次，数据库只存它的哈希；同一邮箱一小时内最多猜错 10 次，重新发码不会重置。会话 Cookie 是 `__Host-writer_session`（`HttpOnly; Secure; SameSite=Lax`），有效期 90 天，使用中自动续期。所有写操作都拒绝跨站来源，防止登录 CSRF。

不登录也能写：匿名草稿属于这台浏览器，单篇上限 5 万字（登录后 20 万字），整个实例每小时最多新建 100 篇，14 天未被认领会被清理。

### 管理后台

后台在 `/admin`，用一个独立密码登录，密码存为加密 Secret，不进仓库：

```bash
npx wrangler secret put ADMIN_PASSWORD
```

没有设置这个 Secret 时 `/admin` 返回 404。登录按 IP 限流（15 分钟 5 次），另有全局预算：一小时最多 30 次尝试，用完锁到下一个整点。预算和后台会话都与当前密码绑定，更换密码会解除锁定，并让所有后台会话立即失效。后台包含：

| 分区 | 内容 |
| --- | --- |
| 概览 | 页面浏览、访客、注册、活跃写作者、草稿与归档数、补全请求与采纳率、Agent 降级次数，以及每日趋势 |
| 访问 | 热门页面、来源、国家或地区、设备 |
| 用户 | 搜索、查看每个账户的文档与会话；停用、恢复、退出所有设备、连同文档一起删除；导出 CSV |
| 文档 | 按状态、归属和关键词筛选全部文档；查看正文与 Agent 轨迹；重新整理、移到回收站、恢复、转给用户、彻底删除 |
| 活动 | 注册、登录、归档、管理操作等事件流 |
| 设置 | 开放或关闭注册、新用户的默认偏好、邮件状态、立即巡检 |

访问统计不存 IP，也不用追踪 Cookie，页面浏览不关联账户：访客标识是「当天密钥 + IP + UA」的哈希，当天密钥由 `ANALYTICS_SECRET` 按日期派生，只能用来统计当天去重，无法跨天关联同一个人；来源只保留域名，文档链接里的 id 会被去掉。事件保留 180 天。部署时生成一个随机密钥：

```bash
openssl rand -hex 32 | npx wrangler secret put ANALYTICS_SECRET
```

没有设置时会退回到存在 D1 里的实例盐，同样按天轮换，但数据库导出就能复算访客标识。

### 偏好设置

`/settings` 页面的偏好跟着账户走（存在 D1 里），换设备打开也一致，服务端的 Cron 与 Agent 读的是同一份。未登录时改动只保存在当前浏览器；新用户的默认值在 `/admin` 里设置：

| 设置 | 作用 |
| --- | --- |
| 界面语言 | 中文 / English，默认跟随浏览器 |
| 正文字号 / 主题 | 纸面与阅读页的排版和明暗，浅色深色可以强制指定 |
| 输入联想 / 灵敏度 | 关闭后不再请求模型；灵敏度决定停顿多久给建议（桌面 Tab，触屏底栏「采纳」） |
| Agent 排版 | 关闭后 Agent 只做分类、标签与摘要，正文一字不动 |
| 静置自动归档 | 停笔多久后自动归档，可以关掉只保留手动「完成」 |

同一页底部是回收站，可以恢复或彻底删除。

### 访问密钥（可选的整站锁）

账户系统已经让每个人的档案彼此隔离。如果你还想让整个实例只对知道密钥的人可见（例如自用的私有部署），可以在所有页面前面再加一道锁：

```bash
npx wrangler secret put WRITER_ACCESS_KEY
```

之后访问 `/unlock` 输入密钥即可（Cookie 有效期 180 天）。解锁密钥只接受表单提交，不进入 URL。设置后还会启用语义检索、MCP 与向量补齐，并放宽速率限制。

### 语义检索（私有模式）

`GET /api/search` 默认 `mode=keyword`（D1 LIKE）。当配置了 `WRITER_ACCESS_KEY` 时，可使用 `mode=semantic`，由 Workers AI 嵌入 + Vectorize 检索；若 Vectorize 或绑定缺失，会自动回落到关键词检索，不会报 500。

归档成功时，WriterPipeline 会在 `index-vector` 步骤里 upsert 该文档的向量。私有模式的 cron 还会对历史 `archived` 文档做小批量补齐（每轮约 10 篇），用于覆盖 0.5.0 之前的归档或偶发的索引失败。

如需手动触发一轮补齐，可调用：

```bash
curl -X POST "https://<你的域名>/api/reindex" \
  -H "Authorization: Bearer <WRITER_ACCESS_KEY>"
```

返回示例：`{ "indexed": 7, "skipped": 3, "remaining": 42 }`。公开演示模式会返回 `403 { "error": "reindex unavailable in demo" }`。

首次启用时创建索引（一次即可）：

```bash
npx wrangler vectorize create writer-archive --dimensions=1024 --metric=cosine
```

随后确保 `wrangler.jsonc` 的 `vectorize` 绑定指向 `writer-archive`。公开演示模式不启用语义检索。

### 整库导出

每个登录用户都可以在归档页一键导出自己的全部归档（`GET /api/export`，Markdown 打包为 zip，最多 200 篇或约 20MB）。只会包含你自己的文档。

### MCP（私有模式，只读）

Writer 的 MCP 端点是**Streamable HTTP（无会话）**，可直接被 Cursor / Claude Code 作为 HTTP MCP server 使用：

- URL: `https://<你的域名>/mcp`
- Auth: `Authorization: Bearer <WRITER_ACCESS_KEY>`
- 传输：`POST` JSON-RPC 2.0（`Content-Type: application/json`）
- 行为：`GET /mcp` 返回 405（不提供 SSE，不返回 discovery blob，不发 session id）
- 只读工具：`list` / `search` / `get`

Cursor 示例（`mcp.json`）：

```json
{
  "mcpServers": {
    "writer": {
      "url": "https://<你的域名>/mcp",
      "headers": {
        "Authorization": "Bearer <WRITER_ACCESS_KEY>"
      }
    }
  }
}
```

Claude Code HTTP MCP 示例：

```json
{
  "mcpServers": {
    "writer": {
      "transport": {
        "type": "streamable-http",
        "url": "https://<你的域名>/mcp",
        "headers": {
          "Authorization": "Bearer <WRITER_ACCESS_KEY>"
        }
      }
    }
  }
}
```

当 `WRITER_ACCESS_KEY` 未设置时，`/mcp` 返回 404（不挂载）。

## 项目结构

```
src/
  index.js      路由、文档 API（按访问者鉴权）、阅读页、Cron 入口
  auth.js       邮箱验证码、会话、匿名身份与文档归属
  admin.js      /admin 后台：登录、统计、用户与文档管理、导出
  analytics.js  访问与使用事件（不存 IP）
  email.js      验证码邮件（Cloudflare Email Service）
  pipeline.js   WriterPipeline：归档 Agent 的 Workflow 定义
  agent.js      流水线启动、Cron 巡检与清理、启发式兜底、R2 文件写入
  export.js     每个账户的整库 zip 导出
  ai.js         模型声明、工具调用协议、降级逻辑、输入联想
  semantic.js   向量嵌入、Vectorize 检索与归档索引更新
  search.js     关键词检索与语义检索结果回填
  search-endpoint.js /api/search 的模式与回退编排
  zip.js        零依赖 zip 打包（STORE）
  mcp.js        只读 MCP 端点（list/search/get，实例级）
  settings.js   站点默认值与每个账户的偏好
  site-config.js 注册开关等实例配置
  http.js       Cookie、哈希、JSON 等共用工具
  markdown.js   零依赖 Markdown 渲染器（先转义再解析）
  html.js       阅读页与解锁页的服务端渲染
public/
  index.html    编辑器
  app.js        自动保存、幽灵补全、多标签页协调、归档与登录衔接
  auth.js       邮箱验证码登录表单（弹窗与页内两种用法）
  session.js    当前登录状态
  login.html    独立登录页
  archive.html  归档页
  archive.js    分类陈列、检索、删除撤销
  settings.html 设置页
  settings.js   偏好开关、账户与回收站
  doc.js        阅读页的修改与删除
  admin.html    管理后台（admin.js / admin.css / admin-i18n.js）
  track.js      页面访问上报
  toast.js      共用的提示条
  i18n.js       中英词典，浏览器与 Worker 共用同一份
  menu.js       收起式导航（右上角菜单与账户入口）
  style.css     全部样式（含深色模式与打印样式）
  fonts/        思源黑体切片（Noto Sans SC，OFL）
migrations/     D1 迁移，npm run db:remote 应用
docs/           架构图与截图（scripts/make-diagrams.py 生成）
test/           node:test 测试（真实迁移跑在 node:sqlite 上）
```

## 路线图

- [x] 用 Workers AI + Vectorize 建立语义检索，把关键词检索升级为语义检索
- [x] 把档案库暴露为 MCP server，让其他 AI 客户端可以读取自己的写作
- [x] 移动端输入体验打磨
- [x] 导出全部档案为 zip

## 贡献

欢迎 issue 和 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。这个项目刻意保持简单：任何增加依赖、引入构建步骤，或者要求用户在写作之外做决策的改动，都需要先在 issue 里讨论清楚。

## 致谢

- [思源黑体 / Noto Sans SC](https://github.com/notofonts/noto-cjk)，SIL OFL 1.1 授权，切片由 [Fontsource](https://fontsource.org/fonts/noto-sans-sc) 提供
- [Cloudflare Workers 平台](https://developers.cloudflare.com/)与 Workers AI 上开源的 Kimi、Qwen 模型

## License

[MIT](LICENSE)

---

## English

**Writer is a quiet, input-focused writing surface built entirely on the Cloudflare stack.**

You write on a paper-like canvas; everything else is handled for you. Text autosaves continuously (cloud plus local backup), and an inline AI suggests light continuations as you pause, accepted with `Tab` on desktop or with an `Accept` touch bar on mobile.

When a piece is finished, an archiving agent takes over inside a durable [Cloudflare Workflow](https://developers.cloudflare.com/workflows/). Kimi K2.6 runs a multi-turn tool-use loop: it inspects the archive's existing taxonomy, searches similar past pieces, then files the document with a title, category, tags, summary and clean typesetting, and mirrors a Markdown file to R2. Every agent turn is an independently retried, resumable step, so a model timeout or an evicted isolate never strands a document. The decision trace is saved and visible on each document's page. If Kimi is unavailable the agent falls back to Qwen3; if the agent fails entirely, heuristics take over. User content is never lost or truncated.

The interface speaks Chinese and English, following your browser by default and switchable in settings; the agent writes each document's title, tags and summary in that document's own language. Archived pieces are not read-only: "Modify" turns one back into a draft and re-runs the pipeline when you finish, while "Delete" moves it to a trash you can undo immediately or restore later.

Anyone can start writing without an account. The first time you finish a piece, Writer asks for an email and sends a six-digit code; entering it creates the account and claims every draft this browser wrote, then filing proceeds as usual. Each account's archive is private to it, and every signed-in writer can export theirs as a zip. Unclaimed anonymous drafts are removed after 14 days. Operators get an admin console at `/admin` (one password, stored as the `ADMIN_PASSWORD` secret) with traffic and usage numbers, user and document management, and an activity log; page views are counted without storing IP addresses or tying them to accounts (set an `ANALYTICS_SECRET` so visitor hashes cannot be recomputed from a database export). Sign-in mail goes out through Cloudflare Email Service, so onboard your sending domain in the dashboard before going live.

Browse and search everything at `/archive`. Instances with the optional site lock (`WRITER_ACCESS_KEY`) also get semantic search (`mode=semantic`) and a read-only MCP endpoint (`/mcp`, Bearer auth). No framework, no bundler, no runtime dependencies: what is in `src/` and `public/` is what gets deployed. See [快速开始](#快速开始) for deploy steps (the commands are language-neutral), and [src/ai.js](src/ai.js) to swap models. Note that Kimi K2.6 requires a Workers Paid plan; on the free plan Writer automatically runs on Qwen3 instead.
