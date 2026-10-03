# @zakura/oauth-bridge

独立于 Zakura 产品运行的 OAuth 中间件，用于 **Google 等不支持 DCR 的上游**：

- 对 MCP 客户端 / Zakura 呈现 **OAuth 2.1 + DCR** 授权服务器门面
- 对上游使用 **预注册的 client_id / secret**（BYO 或自托管配置）
- **不建议**做成完全公开、匿名可用的「共享 Google App」服务（合规与信任模型见下文）

## 推荐部署模式

| 模式 | 适用 | Google App 归属 |
|------|------|-----------------|
| **自托管 BYO** | OSS / 企业 | 用户自己的 Google Cloud 项目 |
| **SaaS 托管** | 付费租户 | Zakura 已验证的窄 scope App |
| **公开匿名** | ❌ 不推荐 | — |

## API

```
GET  /.well-known/oauth-authorization-server
POST /register                          # DCR 门面：返回固定/会话 client
GET  /authorize                         # 重定向到上游（Google）授权
GET  /callback                          # 上游回调 → 转发到 MCP 客户端 redirect_uri
POST /token                             # code → 上游 token（或桥接 token）
GET  /health
```

环境变量：

```
BRIDGE_PUBLIC_URL=https://oauth-bridge.example.com
# BYO / 单租户部署使用预注册凭证
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_SCOPES=openid email https://www.googleapis.com/auth/drive.readonly
```

## 与 Zakura 的集成点

精选 MCP 契约 `tier: C` + `strategies: ["bridge", "byo"]` 时：

1. Zakura 上游 OAuth 的 `authorization_servers` 指向本服务（或安装流直接跳转 bridge）
2. Bridge 完成 Google 授权后，把 access_token 写回 Zakura 实例（callback 到 Zakura）或作为代理持有 token

适配器实现了上游 PKCE、下游 PKCE S256、一次性授权码、state 过期清理和安全回调地址校验。自动测试使用本地请求，不调用 Google。真实 Google 授权仍需部署者配置自己的 OAuth App，并完成 Google 所需的验证；仓库测试不代表真实凭证或生产部署已验证。

当前 state 与授权码存储在进程内，适合单实例 BYO 部署。多实例部署前应接入共享的加密短期存储。

## 本地启动

```bash
pnpm --filter @zakura/oauth-bridge dev
```

默认监听 `8788`。
