# Changelog

## [0.9.0] - 2026-08-16

补齐测试覆盖：restore/vector 生命周期、search helpers、reader 转义与 cron janitor。

## [0.8.0] - 2026-08-16

私有实例补齐：语义索引回填 + MCP 传输修正，并合并 0.5.2 hygiene。

### Added
- **语义向量回填（私有模式）**
  - 新增 `backfillArchiveVectors`：按小批次为历史 `archived` 文档补齐向量索引（默认约 10 条）
  - cron 现在在巡检草稿/卡住流程之外，也会异步触发语义向量回填
  - 新增 `POST /api/reindex`（私有模式）：手动执行一轮回填，返回 `indexed/skipped/remaining`
  - `reopen`（archived -> draft）时删除该文档向量；从回收站恢复为 archived 时重新 upsert 向量
- 新增迁移 `0002_vector_backfill_tracking.sql`（可选回填元数据列）

### Changed
- **MCP 端点改为可被标准客户端使用的无会话 Streamable HTTP**
  - `/mcp` 在 `WRITER_ACCESS_KEY` 缺失时继续返回 404
  - Bearer 鉴权保持必需（常数时间比较）
  - `POST /mcp` 支持 JSON-RPC：`initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`
  - 新增 `resources/list` 与 `prompts/list`（空列表）
  - 协议版本协商支持：`2024-11-05`、`2025-03-26`、`2025-06-18`
  - `GET /mcp` 和 `DELETE /mcp` 统一为 405（不再返回 discovery JSON，不提供独立 SSE）
  - 端点保持 stateless：忽略 `Mcp-Session-Id`，不创建会话
  - 增加 MCP 预检所需 CORS 头（Authorization/Accept/Content-Type/Mcp-Session-Id）
- MCP `serverInfo.version` 不再硬编码旧版本，改为共享版本常量

### Fixed
- 移除失效开发依赖 `lxgw-wenkai-screen-webfont`（字体早已切换到 Noto Sans SC）

### Tests
- 新增覆盖：demo/locked 下的 `/api/reindex`、`/mcp` 鉴权与方法行为、MCP initialize/tools/list、`reopen` 删除向量

## [0.5.1] - 2026-08-16

修复：桌面端不再因误判触控能力而显示补全「采纳 / 忽略」操作条。

## [0.5.0] - 2026-08-16

移动端体验重做 + 私有模式功能扩展（zip 导出、语义检索、只读 MCP）。

### Changed
- **移动端排版与布局（0.5）**
  - 所有页面启用 `viewport-fit=cover`，并为顶栏、正文区域、提示条和底部交互加入安全区 inset
  - 编辑器在窄屏改为“手机纸面”比例：降低最小纸高、缩小内边距与行宽，保留纸面质感但不再出现巨幅空白
  - 顶栏与关键操作统一达到触控尺寸（≥44px），归档卡片与阅读页操作区在手机上可稳定点击
  - 移动端不再隐藏保存状态与提示文案；设置页改为窄屏纵向布局，分段选项可换行，不再横向溢出
  - 阅读页、归档页和设置页消除横向滚动风险，长标题/标签自动换行
- **触屏补全交互（0.5）**
  - Ghost suggestion 在触屏设备上新增底部「采纳 / 忽略」操作条；桌面仍保留 `Tab` / `Esc`
  - 编辑器接入 `visualViewport`：键盘弹出时动态调整底部交互区域，避免建议条被软键盘遮挡
- **公开演示站设置保存反馈（0.5）**
  - demo 模式保存设置返回 403 时，前端提示改为明确文案（“公开演示站的设置为只读”），不再显示泛化失败提示
- **整库 zip 导出（0.5）**
  - 新增 `GET /api/export`（私有模式）：导出全部 archived Markdown 为 zip（STORE，无压缩）
  - demo 模式拒绝整库导出（403），避免公共实例被批量下载
  - 导出文件名按 `archived_at-title.md` 生成，冲突时追加短 id 后缀
  - 软上限：最多 200 篇或约 20MB，超限返回 413
- **语义检索（0.6，私有模式）**
  - `GET /api/search` 新增 `mode=semantic|keyword`；默认 `keyword`
  - 私有模式下，归档成功后会把 `title + summary + content` 嵌入并 upsert 到 Vectorize；永久删除时移除向量
  - 语义检索在 Vectorize/绑定不可用时自动回落关键词检索，不会 500
- **只读 MCP（0.7，私有模式）**
  - 新增 `/mcp` 端点（Bearer `WRITER_ACCESS_KEY`）
  - 提供只读工具：`list`、`search`、`get`
  - 未配置 `WRITER_ACCESS_KEY` 时 `/mcp` 返回 404（不挂载）

### Added
- 新增 `src/export.js`、`src/zip.js`、`src/semantic.js`、`src/search.js`、`src/mcp.js`
- 新增中英文 i18n 文案：触屏补全按钮、导出/检索模式提示、demo 只读提示

### Tests
- 新增测试：demo 导出拒绝、语义检索回落关键词、zip 打包与命名冲突处理
- 保留并通过已有持久化守卫测试（`persistArchive` 仅允许 `processing -> archived`）

## [0.4.2] - 2026-08-16

首屏语言不再闪烁，默认语言改为英文。

### Changed
- **默认语言切换为英文**：当偏好缺失、`auto` 且浏览器提示为空、或语言值未知时，统一回落到 English
- **设置文案更新**：语言项明确为“默认英文；Auto 仍跟随浏览器”
- 静态页面（编辑器、归档、设置）首屏文案改为英文默认值，`#status-text` 纳入统一 i18n

### Fixed
- 修复首屏语言闪烁（先中文后英文 / 先英文后中文）：首个 `applyDom` 改为优先使用同步读取的本地缓存设置
- 统一首屏预判与运行时语言解析规则，避免 head 脚本与 `resolveLang` 判定不一致
- 在 i18n 首次应用前隐藏可翻译 chrome（`data-i18n*`、状态文本、提示条），首次应用后再显示

## [0.4.1] - 2026-08-16

公开演示模式（writer.genedai.md）安全收口：保持可写，但不再无门槛放开。

### Changed
- **公开演示模式明确化**：当 `WRITER_ACCESS_KEY` 未设置时，实例保持开放写入，但 `PUT /api/settings` 返回 403（访客只读站点设置）
- **解锁流程收紧**：`GET /unlock` 仅渲染表单，解锁密钥只接受 `POST` 的 `formData.key`；`?key=` 不再参与解锁或写 Cookie（与 0.2.0 “密钥不再进入 URL” 对齐）
- **速率限制改为 Cache API**（按 `CF-Connecting-IP`）：  
  - `POST /unlock`: 10 / 15 分钟  
  - `POST /api/complete`: 私有模式 60/小时，演示模式 20/小时  
  - 文档写入相关（POST/PUT/DELETE documents、finalize/reopen/restore 合并）：私有模式 300/小时，演示模式 30/小时  
  - 超限返回 `429` + `Retry-After`
- **客户端锁态跳转**：任意 API 返回 `401 { error: "locked" }` 时，编辑器/归档/设置/阅读页动作统一跳转 `/unlock`
- `finalize` 里对 stale `processing` 的重启阈值与 cron 兜底统一为 **15 分钟**

### Fixed
- `PUT /api/documents/:id` 现在强制要求 `rev`，缺失或空值返回 `400 { "error": "rev required" }`，避免省略 `rev` 时的 last-write-wins
- Workflow 持久化阶段增加状态守卫：仅当文档仍为 `processing` 才能归档；若命中 0 行则跳过归档写入与文件写入，并在 trace 记录 skip

### Tests
- 新增覆盖：解锁查询参数不写 Cookie、persist guard、`rev required`、demo settings 403、rate-limit 429（含 fake cache）

## [0.4.0] - 2026-08-15

界面收敛。

### Changed
- **导航收进右上角的菜单**。「归档」「设置」「继续书写」不再平铺在顶栏，一个三点标记按需展开，只列出当前页之外的入口。点击页面其他位置或按 Esc 关闭；无 JS 时降级为普通链接
- **正文与界面改用[思源黑体](https://github.com/notofonts/noto-cjk)**（Noto Sans SC，SIL OFL）。此前的霞鹜文楷中文风格偏重；思源黑体的拉丁字形取自 Source Sans，中英混排更中性。同样是自托管切片按需加载，仅品牌字标保留 Georgia 斜体
- 随之调整了正文行距与字距、标题字重，以适配无衬线

## [0.3.1] - 2026-08-15

### Added
- **界面支持中英双语**。默认跟随浏览器语言，也可以在设置里固定为中文或 English。一份词典（`public/i18n.js`）同时供浏览器和 Worker 使用，服务端渲染的阅读页与解锁页按 Accept-Language 或设置直接输出对应语言，`<html lang>`、日期格式与时间格式一并跟随
- 归档 Agent 的输出跟随原文语言：英文文档得到英文标题、标签与摘要；分类则优先复用档案库已有的分类，避免同一类目出现中英两份

### Fixed
- 顶栏导航链接之间没有间距，「归档」和「继续书写」挤在一起

## [0.3.0] - 2026-08-14

归档不再是单向的：可以回头修改，也可以删除。

### Added
- **设置页 `/settings`**：正文字号、主题（跟随系统 / 浅色 / 深色）、输入联想开关与灵敏度、Agent 排版开关、静置自动归档时长。偏好存在 D1 里而不是浏览器本地，换设备一致，服务端的 Cron 与 Agent 读同一份
  - 关闭 Agent 排版后，归档仍然分类、打标签、写摘要，但正文一字不动
  - 静置自动归档设为「关闭」后，编辑器与 Cron 都不再自动归档，只保留手动「完成」
  - 主题与字号在首屏渲染前应用，切换不闪烁
- **修改已归档内容**：阅读页的「修改」把文档变回草稿送回编辑器（带上 Agent 排版后的版本），完成后重新走一遍归档流程
- **删除与回收站**：删除是可逆的，文档移入回收站且保留 R2 文件，归档页立即提供「撤销」，设置页可以恢复或彻底删除；彻底删除会一并移除 R2 中的 Markdown，且必须先进回收站
- D1 schema 改用 wrangler 原生 migrations（`migrations/`），`npm run db:remote` 应用

### Changed
- 提示条抽成共用模块，编辑器、归档页、阅读页共用一套

## [0.2.0] - 2026-08-14

归档从一次 LLM 调用重建为真正的 Agent 架构。

### Added
- **归档 Agent 跑在 Cloudflare Workflows 上**：每篇文档一个持久化实例，Kimi K2.6 通过 `list_categories`、`search_archive`、`finish` 三个工具自主完成多轮推理，每个回合都是可重试、可断点续跑的 step
- 分类体系由 Agent 自行维护，不再是代码里写死的枚举
- 每次归档的决策轨迹保存进 `agent_trace`，在阅读页可展开查看
- 档案库关键词检索：`/api/search` 与归档页搜索框
- 正文改用[霞鹜文楷](https://github.com/lxgw/LxgwWenKai)屏幕阅读版，自托管切片按需加载
- 22 项单元测试与 CI，架构图由 `scripts/make-diagrams.py` 生成
- 解锁页改为表单提交，密钥不再进入 URL 与浏览器历史

### Changed
- Agent 大脑换为 `@cf/moonshotai/kimi-k2.6`，输入联想与降级路径换为 `@cf/qwen/qwen3-30b-a3b-fp8`
- 所有模型调用经由 AI Gateway，可查看每次调用的日志与成本

### Fixed
经一轮多代理对抗审查确认并修复的 21 个问题，其中值得单独说明的：
- 文档卡在 `processing` 状态后无人认领，会永远停在「整理中」
- 保存失败时仍会归档旧内容并清空本地备份
- `finalize` 的删除与并发自动保存竞态，可能删掉刚存下的正文
- 多标签页共用同一草稿互相覆盖，后台标签页会把前台正在写的文档归档掉
- 页面卸载时超过 64 KiB 的内容无法提交且不更新本地备份
- 归档后残留的补全建议会被 `Tab` 插入到下一篇文档
- 深层嵌套引用块导致渲染递归爆栈，阅读页 500
- 中文写法 `1、甲` 未被识别为有序列表
- 补全在句子边界靠前时退化为硬截断

## [0.1.0] - 2026-08-13

首个版本：A4 画布编辑器、自动保存、AI 输入联想、自动归档与 `/archive` 列表，构建在 Workers + Assets + D1 + R2 + Workers AI 之上。
