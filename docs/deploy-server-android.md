# 服务端 + 安卓：部署与联调

后端与桌面共用 `BackendFacade` / `@worldseed/contracts`；服务器多一个 HTTP/WS 入口。安卓客户端见 [`apps/mobile/README.md`](../apps/mobile/README.md)。

## 安全

- **禁止**把系统 SSH 密码当作 App 登录或写进仓库 / APK。
- 使用独立 `WORLDSEED_API_TOKEN`（随机长串）。
- 对外只暴露 `443`（Nginx + TLS）；Node 只听 `127.0.0.1`。
- 若曾在聊天里泄露过 SSH 密码，请先改密并改用密钥登录。

## 环境变量

| 变量 | 说明 |
|------|------|
| `WORLDSEED_APP_DATA_ROOT` | 服务端数据根（SQLite / 登记项目） |
| `WORLDSEED_PROMPT_ROOT` | `packages/prompt-contracts` 绝对路径 |
| `WORLDSEED_HTTP_HOST` | 默认 `127.0.0.1` |
| `WORLDSEED_HTTP_PORT` | 默认 `8787` |
| `WORLDSEED_API_TOKEN` 或 `WORLDSEED_API_TOKENS` | Bearer 鉴权（逗号分隔多 token） |
| `WORLDSEED_HTTP_AUTH_OPTIONAL` | 仅本地调试可设 `true`（生产勿开） |
| `WORLDSEED_HTTP_CORS_ORIGIN` | 默认 `*` |
| `DEEPSEEK_API_KEY` 等 | 模型密钥只放服务端环境 |

示例（**勿提交真实 token**）`/etc/worldseed/worldseed.env`：

```bash
WORLDSEED_APP_DATA_ROOT=/var/lib/worldseed/data
WORLDSEED_PROMPT_ROOT=/opt/worldseed/packages/prompt-contracts
WORLDSEED_HTTP_HOST=127.0.0.1
WORLDSEED_HTTP_PORT=8787
WORLDSEED_API_TOKEN=replace-with-long-random-token
DEEPSEEK_API_KEY=sk-...
```

## 构建与启动

在仓库根（Node 20+）：

```bash
corepack enable
pnpm install
pnpm --filter @worldseed/contracts build
pnpm --filter @worldseed/config build
pnpm --filter @worldseed/prompt-contracts build
pnpm --filter @worldseed/backend build
```

前台试跑：

```bash
set -a && source /etc/worldseed/worldseed.env && set +a
pnpm --filter @worldseed/backend start:http
```

### systemd 单元示例

`/etc/systemd/system/worldseed-backend.service`：

```ini
[Unit]
Description=WorldSeed HTTP backend
After=network.target

[Service]
Type=simple
User=worldseed
WorkingDirectory=/opt/worldseed
EnvironmentFile=/etc/worldseed/worldseed.env
ExecStart=/usr/bin/node /opt/worldseed/apps/backend/dist/bootstrap/http-entry.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now worldseed-backend
```

## Nginx + TLS

反代本机端口；WebSocket 需 Upgrade：

```nginx
server {
  listen 443 ssl http2;
  server_name your.domain;

  # ssl_certificate ...;
  # ssl_certificate_key ...;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
  }
}
```

防火墙：仅 `22`（密钥）/`80`/`443`。

## 联调检查

1. 健康检查（无需 Token）：

```bash
curl -sS https://your.domain/health
# {"ok":true,"protocolVersion":"worldseed.v1",...}
```

2. RPC（需 Token）：

```bash
curl -sS https://your.domain/rpc \
  -H "Authorization: Bearer $WORLDSEED_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"protocolVersion\":\"worldseed.v1\",\"requestId\":\"$(uuidgen)\",\"method\":\"project.list\",\"payload\":{}}"
```

3. 手机：Expo 登录页填 `https://your.domain` + 同一 Token → 书库 → 讨论一句。

## 工作区说明

服务器上的书登记在 `WORLDSEED_APP_DATA_ROOT`；工作区路径是服务器本机目录。  
第一版手机以**已在服务器登记的书**为主；从桌面同步书库需自行 rsync/挂载，或后续加上传接口。
