# Changelog

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
