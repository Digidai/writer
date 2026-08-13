# 贡献指南

感谢你愿意为 Writer 出一份力。

## 这个项目的取舍

Writer 刻意保持简单，请先理解这几条边界，它们会决定一个改动能否被接受：

- **零运行时依赖。** `src/` 与 `public/` 里的代码就是部署上去的代码，没有打包器、没有前端框架、没有 npm 运行时依赖。新增依赖需要先在 issue 里说明为什么无法用平台原生能力实现。
- **用户只负责输入。** 任何要求用户在写作之外做决策的功能（选择文件夹、挑选模板、手动打标签、配置工作流）都与产品定位冲突。这类能力应该由 Agent 在后台完成。
- **内容永不丢失。** 涉及保存、归档、删除的改动，必须保证在模型失败、网络断开、进程被驱逐、多标签页并发的情况下用户内容仍然完整。这是硬约束，不是最佳实践。
- **纯 Cloudflare 栈。** 不引入外部 API 服务。

## 开发

```bash
npm install
npm run db:local   # 初始化本地 D1
npm run dev        # http://localhost:8787
```

本地开发时 D1 与 R2 是本地模拟的，**Workers AI 始终走远程**，会产生真实用量与费用。调试补全或 Agent 时请留意。

提交前跑一遍：

```bash
npm test     # node:test 单元测试
npm run check   # 全部源文件语法检查
```

## 提交 PR

1. 一个 PR 只做一件事，标题写清楚做了什么。
2. 改了 `src/markdown.js`、`src/agent.js`、`src/ai.js` 里的纯函数，请补对应测试。
3. 改了界面，请附上改动前后的截图（浅色与深色都要）。
4. 改了架构图，编辑 `scripts/make-diagrams.py` 后运行 `npm run diagrams` 重新生成，并把 `docs/` 里的产物一并提交。
5. 提交信息用祈使句，例如 `Fix stale ghost text after finalize`。

## 报告问题

开 issue 时请说明：你做了什么、期望什么、实际发生了什么。如果与 Agent 归档结果有关，请附上该文档阅读页里展开的「Agent 处理轨迹」，那是定位问题最有效的信息。

涉及安全的问题请不要开公开 issue，见 [SECURITY.md](SECURITY.md)。
