# 部署说明（无银行卡版）

后端是一份核心逻辑 + 两套平台适配层，换平台不用改业务代码：

```
core/relay-core.js   与平台无关的核心（校验 / 限流 / 去重 / 转发 / GitHub 写入）
server.cjs           Node.js 适配层（Render、任意长驻 Node 主机）
worker.js            Cloudflare Workers 适配层（完全不需要信用卡）
```

已用真实运行时验证：Node 端实跑 + `workerd`（Workers 真实运行时）实跑，两端状态码逐条一致。

---

## 路径 A：Render（推荐，无需绑卡）

Render 官方文档明确写明免费服务**不需要信用卡**（`render.com/docs/free`）。
用 Render API 创建服务会被账号级支付校验拦下（`402 Payment information is required`），
但 **Dashboard 手动创建走的是另一条流程，不做支付校验**。

### 操作步骤（Dashboard，约 2 分钟）

1. 打开 **https://dashboard.render.com**
2. 左侧 **New → Web Service**
3. 连接 GitHub：选账号 `XMTDSHIGAY` → 选仓库 **`roblox-relay`** → Continue
   （仓库是 public，不需要额外授权；如果先建了 private 仓库，Render 会要求 Connect GitHub 授权）
4. 填写：
   | 项 | 值 |
   |---|---|
   | Name | `roblox-relay` |
   | Region | Oregon |
   | Branch | `main` |
   | Language / Runtime | Node |
   | Build Command | `npm install --omit=dev --no-audit --no-fund` |
   | Start Command | `node server.cjs` |
   | Health Check Path | `/health` |
   | Instance Type | **Free** |
5. 点 **Create Web Service**
6. 进入 **Environment**，逐个添加（Secret 类型的加 `SECRET` 标记）：

   | Key | 值 |
   |---|---|
   | `RELAY_TOKEN` | 自己生成的随机串（见下方生成命令） |
   | `DISCORD_WEBHOOKS` | 4 个 Discord webhook URL，**用英文逗号分隔** |
   | `DISCORD_PROXY` | **可选**。Discord 直连不通时填代理基址（如 `https://webhook.lewisakura.moe`），会把每个 webhook 的 `https://discord.com` 前缀替换掉。**后端在 Render 美区，通常直连即可，先留空试一次** |
   | `GITHUB_TOKEN` | 上报用的 GitHub token |
   | `GITHUB_OWNER` | `liushumei11110-boop` |
   | `GITHUB_REPO` | `game-data` |
   | `GITHUB_FILE` | `game.json` |
   | `GITHUB_BRANCH` | `main` |

7. 保存后自动重新部署，等状态变 **Live**
8. 记下服务地址，形如 `https://roblox-relay-xxxx.onrender.com`

### 生成 RELAY_TOKEN

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

> 这个值必须和 Roblox 侧 `RelayConfig.Token` 完全一致。

---

## 路径 B：Cloudflare Workers（同样无需绑卡）

免费额度：每天 **10 万次请求**，单次 10ms CPU。本服务只是转发 + 校验，额度绰绰有余。

### 操作步骤

1. 注册 **https://dash.cloudflare.com/sign-up**（邮箱即可，不用卡）
2. 登录后进入 **Workers & Pages → Create → Worker**，名字填 `roblox-relay`，Deploy
3. 安装 CLI 并登录：
   ```bash
   npm install -g wrangler
   wrangler login
   ```
4. 在项目目录设置密钥（每条一个命令，逐条输入）：
   ```bash
   wrangler secret put RELAY_TOKEN
   wrangler secret put DISCORD_WEBHOOKS
   wrangler secret put GITHUB_TOKEN
   wrangler secret put GITHUB_OWNER
   wrangler secret put GITHUB_REPO
   ```
   非敏感的可以写进 `wrangler.toml` 的 `[vars]`：
   ```toml
   [vars]
   GITHUB_FILE = "game.json"
   GITHUB_BRANCH = "main"
   ```
5. 部署：
   ```bash
   wrangler deploy
   ```
6. 得到地址形如 `https://roblox-relay.<你的子域>.workers.dev`

### Workers 上的额外建议

Workers 是分布式实例，内存计数只对单个 isolate 有效。建议在 Dashboard 里给
`/v1/webhook` 配一条 **Rate Limiting** 规则（免费版可用），作为跨实例的跨域防线；
代码里已预留 `RATE_LIMITER` binding 接口，绑定后自动优先使用平台级限流。

---

## Roblox 侧配置（两个平台通用）

在 `ServerStorage` 建一个 Folder，命名 `RelayConfig`，里面放两个 `StringValue`：

| 名称 | 值 |
|---|---|
| `Url` | 你的后端地址（Render 或 Workers 的地址） |
| `Token` | 与后端环境变量 `RELAY_TOKEN` 完全一致 |

然后把两份脚本放进 **`ServerScriptService`**：

```
ServerScriptService/
  WebhookReporter.lua
  GameDataReporter.lua
```

> ⚠️ 必须放服务端。放 `ReplicatedStorage` 或被 `LocalScript` require 会把源码下发到客户端，
> 那样反混淆才有意义 —— 这是整套防护的根本。

---

## 本地自测

```bash
# Node 端
RELAY_TOKEN=test-token DISCORD_WEBHOOKS=http://127.0.0.1:9/hook \
GITHUB_TOKEN=x GITHUB_OWNER=x GITHUB_REPO=x PORT=18081 node server.cjs

# Workers 端（真实 workerd 运行时）
npm install --no-save wrangler
wrangler dev
```

---

## 安全要点

- 代码中**零硬编码密钥**，全部来自环境变量
- 后端只做「收数据 → 鉴权 → 校验 → 转发」，黑名单 / DataStore 封禁 / 踢人逻辑全在 Roblox 侧
- 日志只输出状态码、耗时、计数，不含请求体、令牌、webhook 地址
- 强制 `allowed_mentions: {parse: []}`，杜绝 @everyone 轰炸
- 限流：播报 20 次/分、上报 10 次/分、单 IP 90 次/分
- 去重：相同内容 60 秒只发一次；同一 PlaceId 60 秒只写一次 GitHub
- 请求体上限 64KB，`game.json` 上限 100KB
