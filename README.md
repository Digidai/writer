# Writer

一个安静的、专注于输入的网页写作工具。落笔即存，其余交给 AI。

**Live: [writer.genedai.md](https://writer.genedai.md)**

Writer 只关心一件事：让你专注地把字写下来。分类、解析、排版、归档，全部由 Agent 在后台自动完成，你不需要管理任何东西。

## 它如何工作

**书写。** 页面主体是一张 A4 纸样式的画布。打开即写，内容随输入自动保存，关掉页面也不会丢。

**联想。** 输入停顿时，AI 会在光标后给出一段浅灰色的续写建议（交互与 Cursor / VS Code 的代码补全一致）：`Tab` 采纳，`Esc` 忽略，继续打字则自动消失。它只做轻量的输入辅助，不会改写你的内容。

**归档。** 一篇内容「完成」后（点击「完成」、按 `⌘⏎`，或静置数分钟自动触发），Agent 会自动为它分类、打标签、写摘要、整理排版，并存储为 Markdown 文件。整理好的内容在 [/archive](https://writer.genedai.md/archive) 中按分类陈列，可阅读、可下载原文件。

## 技术栈

全部构建在 Cloudflare 上，无其他依赖：

| 组件 | 用途 |
| --- | --- |
| [Workers](https://developers.cloudflare.com/workers/) | API、阅读页渲染、归档 Agent |
| [Workers Assets](https://developers.cloudflare.com/workers/static-assets/) | 编辑器与归档页（纯静态，无构建步骤） |
| [D1](https://developers.cloudflare.com/d1/) | 文档存储 |
| [R2](https://developers.cloudflare.com/r2/) | 归档后的 Markdown 文件 |
| [Workers AI](https://developers.cloudflare.com/workers-ai/) | 输入联想与整理 Agent |
| Cron Triggers | 自动归档被遗忘的草稿 |

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

### 更换模型

模型在 [src/ai.js](src/ai.js) 顶部声明，可换成 [Workers AI 目录](https://developers.cloudflare.com/workers-ai/models/)里的任意文本模型：

```js
export const COMPLETION_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast'; // 输入联想：追求低延迟
export const AGENT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'; // 归档整理：追求质量
```

## English

Writer is a quiet, input-focused writing surface built entirely on the Cloudflare stack (Workers, D1, R2, Workers AI). You just write on an A4-like canvas: everything autosaves, an inline AI suggests light continuations as you pause (accept with `Tab`, like code completion in Cursor / VS Code), and when a piece is done an agent automatically classifies, tags, summarizes and typesets it into the archive at `/archive`, storing a Markdown file in R2. No framework, no bundler, no runtime dependencies. See the deploy steps above.

## License

[MIT](LICENSE)
