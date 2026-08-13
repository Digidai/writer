# 安全策略

## 报告漏洞

请不要通过公开 issue 报告安全问题。使用 GitHub 的 [Private vulnerability reporting](https://github.com/Digidai/writer/security/advisories/new) 提交，我会尽快回应。

## 你应该知道的

**默认是开放实例。** 部署后如果没有设置 `WRITER_ACCESS_KEY`，任何知道地址的人都能读写你的档案库。这是刻意的默认值（个人自部署工具，多数场景在自己的域名下使用），但如果你的实例可被公网访问，请务必上锁：

```bash
npx wrangler secret put WRITER_ACCESS_KEY
```

**密钥模型是单一共享密钥**，不是多用户认证系统。它防的是路人，不是定向攻击者。Cookie 为 `HttpOnly; Secure; SameSite=Lax`，有效期 180 天，服务端比较使用常量时间实现。

**用户内容会发送给 Workers AI。** 输入联想会把光标前最多 2000 字发给模型，归档时会把整篇内容发给模型。数据在 Cloudflare 网络内处理，不经过第三方 API。如果你的写作内容敏感，请评估这一点。

**Markdown 渲染先转义再解析。** 文档内容在任何变换之前都会经过 HTML 转义，链接只允许 `http(s)`，渲染器不执行也不内联任何脚本。相关测试在 `test/markdown.test.js`。
