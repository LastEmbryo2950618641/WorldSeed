# 运行监控 vs 讨论用量：独立持久化

> **状态：** 已实施（2026-09-04）  
> **目标：** 右侧「运行监控」与创作台「KV / Token / 上下文」彼此独立，且重启后各自可回填。

## 决策

| 表面 | 数据源 | 持久化 | 重启后 |
| --- | --- | --- | --- |
| 运行监控 | 正式推演 `task.runtimeMetrics` / `phaseRuns` | 已有 SQLite turn 表 | 可恢复任务优先；否则 `turn.latest.get` 加载**最近一轮**只读展示 |
| 讨论用量条 | 梗概讨论累计 usage | 表 `synopsis_discuss_usage` | `list` / `start` / `send` / `refreshChoices` 回填 hub + UI |
| 世界摘要栏 Token 行 | **仅正式推演**（文案「推演 KV / Token / 上下文」） | 同 task | 不与讨论用量 merge |

禁止：用讨论用量填空运行监控圆环；讨论条不随推演结束清空；重启不清讨论累计。

## 已落地

- migration 042 + database-types
- `sqlite-synopsis-conversation-repository` `loadDiscussUsage` / `saveDiscussUsage`
- hub `hydrateCumulativeUsage` / `resetCumulativeUsage`
- service list/start/send/refreshChoices hydrate + persist + return `usage`
- contracts list/start/send 含 `usage`；`turn.latest.get`
- App：list/start/send/refresh 回填 `synopsisUsage`；无可恢复任务时拉 latest
- RightRail 世界摘要仅推演；RuntimeMonitor 仅 `task.runtimeMetrics`
- 测试：`discuss-usage-persistence.test.ts`