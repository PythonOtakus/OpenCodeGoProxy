# OpenCode Go Proxy

在编辑器内启动一个本地中转，让 **Cursor / VS Code** 的 OpenAI 兼容端点用上 [OpenCode Go](https://opencode.ai/console/go) 订阅。

## 它解决什么问题

有两道关卡，必须都过：

**关卡一：Cursor 拒绝访问私有网络。**
Cursor 的 `Override OpenAI Base URL` 不是从你的机器发请求，而是把地址上报给 **Cursor 服务器**代发，中间有 SSRF 防护，按设计拒绝 `127.0.0.1`、`localhost` 和私有网段：

```text
Response: Access to private networks is forbidden
```

所以本地中转必须通过**公网 HTTPS** 暴露出去。本扩展内置 Cloudflare Quick Tunnel 支持（`opencodeGo.tunnel`），自动搞定这件事。

**关卡二：OpenCode Go 强制要求 session 头。**
Go 网关要求每个请求带 `x-opencode-session: ses_...`，缺了就 `HTTP 400 MissingSessionID`。而 Cursor 没有加自定义请求头的入口。本扩展的中转替你补上，并把路径归一化到 Console 的真实路径。

## 用法

1. 安装 cloudflared：

   ```powershell
   winget install Cloudflare.cloudflared
   ```

2. 装扩展，在设置里打开：

   ```jsonc
   "opencodeGo.tunnel": true,      // 走隧道（Cursor 必需）
   "opencodeGo.requireToken": true // 公网暴露务必保持开启
   ```

3. 保存 `oc_sk_...`：命令面板 → `OpenCode Go: 设置 OpenCode API Key`
   （存进编辑器密钥库，不是明文设置）

4. 命令面板 → `OpenCode Go: 复制完整配置`，会拿到：

   ```text
   Base URL: https://xxxx-yyyy-zzzz.trycloudflare.com/v1
   API Key : ogp_...
   ```

   注意 `ogp_` 是**本地中转的访问口令**，不是上游密钥。上游 `oc_sk_` 只留在本机。

5. Cursor → Settings → Models → 填入上面两项。
6. 模型选 Go 里的 ID：`kimi-k3`、`glm-5.3`、`deepseek-v4.1-flash`、`minimax-m3` …

> Quick Tunnel 每次启动域名都会变，重启后需要重新复制一次 Base URL。

## 不用隧道的情况

如果你在**别的客户端**里用（Cline、Roo Code、Kilo Code 等扩展，或任何直接发请求的工具），这些客户端从本机发请求，`http://127.0.0.1:8787/v1` 直接可用，把 `opencodeGo.tunnel` 关掉即可。

只有 Cursor 原生 Chat / Agent 受 SSRF 限制。

## 命令

| 命令 | 说明 |
| --- | --- |
| `OpenCode Go: 启动中转` | 手动启动 |
| `OpenCode Go: 停止中转` | 停止（含隧道） |
| `OpenCode Go: 重启中转` | 重启，隧道会换新域名 |
| `OpenCode Go: 复制完整配置` | 复制 Base URL + 访问口令 |
| `OpenCode Go: 复制 Base URL` | 只复制 Base URL |
| `OpenCode Go: 设置 OpenCode API Key` | 存入编辑器密钥库 |
| `OpenCode Go: 重置访问口令` | 轮换口令（隧道疑似泄漏时用） |
| `OpenCode Go: 自检连接` | 打 `/v1/models` 验证链路 |
| `OpenCode Go: 查看日志` | 每个请求的状态码 / 耗时 / session |

## 设置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `opencodeGo.autoStart` | `true` | 编辑器启动后自动开启 |
| `opencodeGo.port` | `8787` | 监听端口，改动后自动重启 |
| `opencodeGo.host` | `127.0.0.1` | 监听地址，默认仅本机 |
| `opencodeGo.plan` | `go` | `go` 走订阅端点，`payg` 走按量付费端点 |
| `opencodeGo.apiKey` | 空 | 可选。填了由扩展代设 `Authorization`，编辑器里可随便填。留空则透传 |
| `opencodeGo.sessionMode` | `conversation` | session 生成方式，`conversation` 缓存命中率最好 |
| `opencodeGo.modelMap` | `{}` | 模型名映射 |
| `opencodeGo.tunnel` | `false` | 自动启动 Cloudflare Quick Tunnel，暴露成公网 HTTPS |
| `opencodeGo.tunnelBinary` | 空 | cloudflared 路径，空则走 PATH |
| `opencodeGo.requireToken` | `true` | 要求访问口令。**隧道开启时不要关** |

## 路径改写

编辑器可能把 base 拼成 `{base}/chat/completions` 或 `{base}/v1/chat/completions`，扩展自动归一化：

| 收到 | 转发到 |
| --- | --- |
| `/v1/chat/completions` | `/openai/v1/chat/completions` |
| `/v1/responses` | `/openai/v1/responses` |
| `/v1/messages` | `/anthropic/v1/messages` |
| `/v1/models` | `/v1/models` |
| `/openai/…` `/anthropic/…` `/google/…` | 原样放行 |

SSE 流式响应直接 pipe，不做缓冲。

## 项目结构

```
opencode-go-proxy/
├── src/
│   ├── extension.ts          入口：命令注册、控制器装配
│   ├── config.ts             读取设置
│   ├── logger.ts             输出通道
│   ├── status.ts             状态栏指示器
│   ├── secrets.ts            密钥库：上游密钥 + 访问口令
│   ├── tunnel.ts             Cloudflare Quick Tunnel 管理
│   ├── proxy/
│   │   ├── server.ts         中转主体，createProxyServer()
│   │   ├── path.ts           路径归一化
│   │   ├── session.ts        x-opencode-session 生成
│   │   └── upstream.ts       上游端点与头过滤
│   └── test/suite/           Node 内置 test runner 测试
├── out/                      tsc 编译产物
└── .vscode/                  launch / tasks
```

`src/proxy/**` 不依赖 `vscode` 模块，所以能脱离扩展宿主直接跑测试。

## 开发

```bash
npm install
npm run compile     # tsc
npm test            # 32 项：路径、session、上游、鉴权、隧道、真实端到端
npm run package     # 出 vsix
```

调试：`F5` 打开扩展开发宿主。

## 注意

- **免费模型用不了**。`longcat-2.5-free`、`beam-free`、`hy4-flash-free` 这类只允许 OpenCode 官方客户端调用，从 Cursor 走必定 `403`。
- **Cursor 不在官方验证名单里**（官方验证的是 Claude Code / Codex / Hermes / Pi / Raycast / ZCode / jcode）。本扩展能跑通，但属于非官方路径，接口变更时可能需要跟进。
- **隧道会改变隐私边界**。开启后提示词路径是「你的机器 → Cloudflare → Cursor 服务器 → opencode.ai」，Cursor 的 Zero Data Retention 不适用于自定义 key 场景。私有代码请谨慎。
- **模型名冲突**。Cursor 会把模型名发给自己的网关，若与内置模型同名（如 `gpt-5`）会提示 "this model is already available as" 并**根本不走你的 override**。用不冲突的名字，配合 `opencodeGo.modelMap` 映射。
- **`Verify` 按钮不作数**。它只验证 key 被接受，不代表能对话，必须实际发一条消息测。
- **隧道地址即凭据**。Quick Tunnel 域名可被扫描，务必保持 `requireToken: true`；怀疑泄漏就执行「重置访问口令」。

## License

MIT
