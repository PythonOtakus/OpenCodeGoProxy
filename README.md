# OpenCode Go Proxy (Vercel)

把 OpenCode Go 网关中转出来，让 **Cursor** 这类受 SSRF 限制的客户端能用上。

## 为什么需要它

两件事同时挡住你：

**1. Cursor 拒绝私有地址。**
Cursor 的 `Override OpenAI Base URL` 由 **Cursor 服务器代发请求**，SSRF 防护按设计拒绝 `127.0.0.1` / `localhost` / 私有网段：

```text
Access to private networks is forbidden
```

所以必须有一个**公网 HTTPS 地址**。

**2. OpenCode Go 强制要求 session 头。**
Go 网关要求每个请求带 `x-opencode-session: ses_...`，缺了直接 `400 MissingSessionID`。而 Cursor 没有加自定义请求头的入口。

这个中转做三件事：补 session 头、归一化路径、缺省时把推理强度设为 `max`。

## 设计：服务器不持有任何密钥

这是和"访问口令"方案的关键区别：

```
Cursor  ──[Authorization: Bearer oc_sk_你的真实key]──▶  Vercel 中转
                                                         │ 补 x-opencode-session
                                                         │ 路径归一化
                                                         │ 缺省注入 reasoning_effort=max
                                                         ▼
                                              opencode.ai/inference/go
```

- 你在 **Cursor 里填真实 `oc_sk_`**，中转**原样透传**给上游
- 服务器上**没有任何环境变量存密钥**，部署者（包括你自己）也无法从服务端盗取使用者额度
- 不需要访问口令、不需要额外的 `ogp_` 令牌、没有第二套凭据要管

测试里专门钉死了这条行为：

```ts
assert.equal(captured[0].authorization, 'Bearer oc_sk_user_owned_key',
  '服务器必须原样转发调用方的密钥');
```

## 部署

```bash
npm install
npx vercel --prod
```

首次会问项目名等，默认即可。不需要配置任何环境变量。

部署完你会拿到 `https://<project>.vercel.app`。

也可以在 Vercel 控制台直接 **Import Git Repository** 连这个仓库，每次 push 自动重新部署。

### 验证

```bash
curl https://<project>.vercel.app/health
# => {"healthy":true,"upstream":"https://opencode.ai/inference/go","keyMode":"passthrough",...}

curl https://<project>.vercel.app/v1/models
# => 31 个模型的 JSON 列表（模型列表不需要密钥）
```

## Cursor 里填什么

| 项 | 值 |
| --- | --- |
| Use OpenAI API Key | 开 |
| **API Key** | 你的真实 `oc_sk_...`（**不是** `ogp_`） |
| Override OpenAI Base URL | 开 |
| **Base URL** | `https://<project>.vercel.app/v1` |

Base URL 是**固定值**，部署一次就永远不变，不会像 Cloudflare Quick Tunnel 那样每次重启换域名。

模型选 Go 里的 ID：`kimi-k3`、`glm-5.3`、`deepseek-v4.1-flash`、`minimax-m3`…

## 支持的路径

中转会自动归一化，以下写法都能用：

| 你请求的 | 转发到上游 |
| --- | --- |
| `/v1/chat/completions` | `/openai/v1/chat/completions` |
| `/v1/responses` | `/openai/v1/responses` |
| `/v1/messages` | `/anthropic/v1/messages` |
| `/v1/models` | `/v1/models` |
| `/openai/…` `/anthropic/…` `/google/…` | 原样放行 |

`vercel.json` 里配了 rewrite，所以 `/v1/*` 能直接到达函数，不用写 `/api/v1/*`。

## 本地开发

```bash
npm install
npm run dev        # http://127.0.0.1:3000
npm test           # 28 项，含真实上游穿透
npm run typecheck
npm run verify     # 编译到 dist/ 并对**编译产物**跑 8 项验证
```

`npm run dev` 起的是纯 Node 服务器，行为和 Vercel 上一致。

`npm run verify` 这条别跳过：本地用 tsx 跑源码能通，不等于 Vercel 构建后能通。`verify` 编译成 CommonJS 再验证，形态与线上一致。

> 注意脚本名是 `build:dist` 而不是 `build`。Vercel 一旦发现有 `build` 脚本，
> 就会把项目当成静态站点构建，然后因为找不到 `public/` 目录而失败
> （`STATIC_BUILD_NO_OUT_DIR`）。`vercel.json` 里也显式写了 `"framework": null`。

## 踩过的坑

**1. `type: "module"` + `.ts` 扩展名导入在 Vercel 上会崩。**
首次部署 `500 FUNCTION_INVOCATION_FAILED`。本地 `--experimental-strip-types` 能跑，Vercel 构建器走不同打包路径，加载阶段就失败。
现在：CommonJS + 导入不写扩展名 + `tsx` 跑开发/测试。

**2. 有 `build` 脚本会让 Vercel 误判为静态站点。**
第二次部署报 `STATIC_BUILD_NO_OUT_DIR: No Output Directory named "public"`——即使项目里只有 serverless functions，Vercel 也会尝试静态构建。
现在：脚本改名 `build:dist`，并在 `vercel.json` 设 `"framework": null` 彻底关掉框架检测。

**3. Hobby 套餐函数超时上限是 60 秒。**
`maxDuration: 300` 会直接报配置错误，已改为 60。

## 项目结构

```
OpenCodeGoProxy/
├── api/
│   ├── health.ts                  健康检查
│   ├── v1/models.ts               模型列表
│   ├── v1/chat/completions.ts     Chat Completions
│   ├── v1/responses.ts            Responses API
│   └── v1/messages.ts             Anthropic Messages
├── lib/
│   ├── proxy.ts                   核心转发逻辑（平台无关，可单测）
│   ├── handler.ts                 路由共用的请求/响应适配
│   ├── path.ts                    路径归一化
│   └── session.ts                 x-opencode-session 生成
├── test/                          Node 内置 test runner，28 项
├── scripts/
│   ├── dev-server.ts              本地开发服务器
│   └── verify.ts                  编译产物验证，9 项
└── vercel.json                    rewrite + 函数配置
```

`lib/` 不 import 任何 Vercel API，所以测试可以脱离平台直接跑，也能移植到其他平台（Cloudflare Workers、Deno Deploy、Netlify）。

## 注意事项

- **免费模型用不了**。`longcat-2.5-free`、`beam-free`、`hy4-flash-free` 这类只允许 OpenCode 官方客户端调用，从任何第三方客户端走都会 `403`。
- **Vercel 函数超时**。`vercel.json` 里设了 `maxDuration: 300`（Hobby 套餐上限较低，长任务可能被截断）。Agent 模式的长对话建议留意。
- **流式响应**。SSE 头已设 `no-cache, no-transform` 和 `x-accel-buffering: no`，但 Vercel 的边缘节点仍可能影响首字节延迟。
- **日志**。Vercel 会记录请求元数据（含 URL、状态码），但**不记录 Authorization 头**，密钥不会进日志。
- **这是公开端点**。任何人知道 URL 都能发请求，但他们必须自带有效 `oc_sk_` 才能用，消耗的是他们自己的额度。
- **Cursor 不在官方验证名单**（官方只验证了 Claude Code / Codex / Hermes / Pi / Raycast / ZCode / jcode）。能跑通但属非官方路径。

## License

MIT
