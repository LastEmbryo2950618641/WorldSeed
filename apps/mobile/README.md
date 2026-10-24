# WorldSeed Mobile（Expo / Android）

手机端走**同一套后端** `ClientRequest` / `ClientResponse`：`POST /rpc` + `WS /events`。  
**不要**把服务器 SSH 密码填进 App；只用部署时配置的 `WORLDSEED_API_TOKEN`。

## 安装

本目录**不在**根 workspace 的默认 `pnpm -r` 里（避免 Expo 拖垮桌面依赖）。先构建 contracts，再在本目录装依赖：

```bash
# 仓库根
pnpm --filter @worldseed/contracts build

cd apps/mobile
npm install
# 或: pnpm install
```

## 运行

```bash
cd apps/mobile
npx expo start
```

用 Expo Go 扫码，或 `npx expo run:android` 打调试包。

登录页填写：

- **API Base URL**：例如 `https://your.domain`（经 Nginx），或局域网 `http://192.168.x.x:8787`
- **API Token**：与服务端 `WORLDSEED_API_TOKEN` 一致

## 第一版能力

- 连接健康检查 `/health`
- 书库 `project.list` / `project.open`
- 创作台讨论 `synopsis.conversation.*`
- 章节列表与阅读 `chapter.list` / `chapter.read`

不做：世界图、Monaco、本机选目录、批量推演全屏运维。

## 相关文档

- 服务端部署：[docs/deploy-server-android.md](../../docs/deploy-server-android.md)
