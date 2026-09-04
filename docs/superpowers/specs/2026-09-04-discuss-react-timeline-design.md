# 创作台讨论流：ReAct 时间线（searching / editing）

> **状态：** P0 + P1 已实施（2026-09-04）  
> **包名：** `discuss-react-timeline`  
> **范围：** 创作台 Agent 气泡的可观测结构——把「扁平三块」升级为可按时序展开的 thinking / searching / editing，并让文件写入可见。  
> **关联：** [细纲 bodyEdits](./2026-09-03-outline-body-edits-design.md) · [运行监控 vs 讨论用量](./2026-09-03-monitor-discuss-usage-persistence-design.md) · Codex / Claude Code 工具块观感（概念借鉴，不移植方言）  
> **非目标：** 重写 Agent 循环、通用 `tools[]`/MCP、SSE 推送、行级 diff 预览、把字数预算做成硬门槛、把运行监控与讨论用量再耦合。

---

## 1. 问题

后端 `runSynopsisDiscuss` **已经是**多轮 ReAct：

```
thinking → request_read 批量检索 → thinking → … → continue + artifact → 落盘
```

前端却是**固定三块汇总板**：

1. 一段 `thinking`（多轮思考被覆盖成最后一轮）  
2. 一个 `searching[]` 袋子（所有轮次挤在一起；暂存/笔风还伪装成 search）  
3. `正式输出`

真正的梗概 / 细纲 / `bodyEdits` 写盘**没有** editing 事件，用户只看到「正式输出（写入中）」，不知道改了哪个文件。

用户期望（对照 Codex）：

- 有 **editing**，可展开看文档与进度；完成后 → **edited**  
- **searching** 展示结果；完成后 → **searched**  
- 不要永远钉死三个总模块；应按 ReAct **时序**交错  
- 同轮并行检索/写入归一组；跨轮串行挨着排  
- 搜/编之后可以再 thinking

---

## 2. 多 Agent 共识

| 议题 | 共识 |
| --- | --- |
| Agent 循环 | **不重建**；只做观测与 UI 投影 |
| 优先序 | **P0：editing 可见** → **P1：时间线交错** |
| 线缆形状 | 保留 `searching[]`，新增并列 `editing[]`；**不**上通用 `tools[]` / 事件日志 |
| 并行定义 | **一次模型 outcome 的工具集合** = 一组（同轮 `requestedReads[]`；同次 artifact 的多文件写入） |
| 串行定义 | 下一轮模型调用之后的下一组 |
| 文案 | 块标题保留英文名词；状态用中文；工具块 present→past |
| thinking 过去时 | **不**改成 `thought`（保持 `thinking`） |
| `hub.complete` | **仍可提前**（回复就绪、Stop 可消失）；写入在 finalizing 窗口发 `editing` |
| 假 search | 新轮次停止把 staging/presentation 塞进 `searching` |

---

## 3. 分阶段交付

### P0 — Editing 可见（薄交付，先做）

保持现有「thinking / searching / 正式输出」观感，在 searching 与正式输出之间插入 **editing / edited**：

- 落盘路径发 `editing[]`：`synopsisBody`、`outlineBody`、`bodyEdits`、`stagingDelta` 各文件、`arcPlan`、`presentationWrites`
- 跳过/失败也占一行（`未落盘` + 原因），与 `writeNotices` 对齐
- 删除新轮次里对 staging/presentation 的假 `upsertSearch`
- 标签：live `editing` +「写入中」；完成后 `edited` +「已写入」
- **edited 默认展开**（信任信号）；searching 默认折叠
- searching 完成时块标题可用 `searched`

### P1 — ReAct 时间线

- `searching` 增加可选 `round`（0=bootstrap，1..=各 `request_read` 批）
- hub **追加** thinking 切片（或 `thinkingRounds[]`），禁止再「只保留最后一轮」糊弄时间线
- UI 经统一 adapter 渲染有序 `segments[]`：`thinking → tools组 → thinking → … → editing → 正式输出`
- 同 `round` 的检索 = 一组；跨 round = 串行多组

---

## 4. 用户可见模型

### 4.1 块种类

| 块 | 含义 | 默认展开 |
| --- | --- | --- |
| `thinking` | 单次模型调用的推理展示 | Live：开；历史：关 |
| `searching` → `searched` | 一轮读工具（并行查询为行） | 关（摘要 + 条数） |
| `editing` → `edited` | 本轮 artifact 落盘（并行文件为行） | **开** |
| `正式输出` | `assistantMessage` + choices | 始终可见 |

### 4.2 并行 / 串行

- **一组 searching** = 某次模型返回的整个 `requestedReads[]`（workspace / temporal / web 都算 searching）  
- **下一组 searching** = 又一次 `request_read` 之后（中间必有 thinking，P1）  
- **一组 editing** = 本 send 最终 `continue` 后实际/尝试写入的文件集合（多路径 = 一组多行）  
- 今日写入发生在 artifact 之后；**禁止**在同 send 里伪造「edit 后再 think」除非循环真支持中途写盘

### 4.3 文案

| Live 名词 | Past 名词 | 中文状态 |
| --- | --- | --- |
| `thinking` | `thinking` | 流式 / 深度思考中… |
| `searching` | `searched` | 查询中 / 完成 / 失败 |
| `editing` | `edited` | 写入中 / 已写入 / 未落盘 / 失败 |
| — | — | `正式输出`（制品头，非工具） |

行文案：可读路径或章标题 + 短进度（如「已局部更新细纲（3 处）」）。不暴露 `exactKeys`、digest、JSON envelope。

### 4.4 不要展示

- 协议字段、`outcome`、repair 重试轮次  
- 检索全文（保留短 `resultSummary`）  
- bootstrap 平台预读可作为 `round:0` 数据存在，**默认不对用户强调**（P1 可折叠隐藏）  
- `stagingPromote` / `goalProposals` / choices（已有独立 UI）  
- Token/KV（已有用量条）  
- 与 editing 块重复的长串 writeNotice（可缩短为「详见上方 edited」或保留一句总述）

---

## 5. 契约与 hub

### 5.1 `editing` 条目

```ts
kind: "synopsis" | "outline" | "body_edits" | "staging" | "arc_plan" | "presentation"
path: string
status: "running" | "completed" | "failed"
summary?: string          // ≤500
opsAttempted?: number     // body_edits
opsApplied?: number
```

Upsert 键：`path`（与 search 的 `query` 对称）。

### 5.2 Snapshot / Message

```ts
// StreamSnapshot
searching: Search[]
editing: Edit[]           // NEW, default []

// Search（P1）
round?: number            // optional；缺省=旧消息扁平列表

// Assistant message
searching?: Search[]
editing?: Edit[]          // NEW；空则省略
```

SQLite：`synopsis_conversation_messages.editing_json`（可空），**不**塞进 `searching_json`。

### 5.3 Hub

- `upsertEdit(projectId, edit, nowMs)`：按 path merge；**允许在 `complete` 之后**，拒绝在 `fail` 之后  
- `begin` 清空 `editing`  
- `peek` 带上 `editing`  
- 无新 RPC；继续 `streamPeek` 轮询

### 5.4 发射时序（`send`）

1. ReAct 循环内：照旧 `upsertSearch`（P1 带 `round`）  
2. artifact 就绪 → `complete(thinking, content)`（提前，保留 Stop 语义）  
3. 对每个拟写路径 `upsertEdit(running)`  
4. 实际 `save*`；成功/跳过/失败 → `upsertEdit(completed|failed)` + summary  
5. **删除** `staging:` / `presentation:` 假 search  
6. `appendMessage` 拷贝终态 `searching` + `editing`  
7. 如需把 writeNotice 并入 content，再 `complete` 一次内容后 `clear`

`body_edits` 示例 summary：`已局部更新细纲（3 处）`，填 `opsAttempted` / `opsApplied`。

不计入 editing（v1）：`workDisplayName`、卷目录重命名、`stagingPromote` 提案。

---

## 6. 前端

### 6.1 统一 adapter

```
toAgentTimeline(snapshot | message) → Segment[]
AgentStructuredBody({ segments, mode: "live" | "persisted" })
```

UI **不**直接啃原始 bags 拼时序；也不在客户端用时间戳猜并行。

### 6.2 P0 合成

最多四段：thinking → searched → edited → final（观感仍接近今日三块 + editing）。

### 6.3 P1

按 `rounds` / `segments` 映射；同组可混 search+edit（少见）或分节复用 `.searching` / `.editing` 样式。

### 6.4 旧消息

无 DB 回填。仅有 thinking+searching+content 时合成今日三块。可选：把历史 `staging:` 查询显示成 edit 行（非必须）。

### 6.5 Live vs 持久

| | Live | Persisted |
| --- | --- | --- |
| thinking | 最新开 | 全关 |
| tools | 进行中开 | 全关（**edited 除外：默认开**） |
| 名词 | searching / editing | searched / edited |
| 正式输出 | 可与 trailing edits 并存（finalizing） | 静态 |

**正式输出始终在最后**；finalizing 时 edited 组紧贴其上方，写完后不调换顺序（防布局跳动）。

---

## 7. 验收

### P0

1. 确认写细纲后，气泡出现 `edited`，展开可见 `[剧情细纲].md`（或等价路径）与「已写入」。  
2. `bodyEdits` 成功：一行 outline +「N 处」；失败/手改：`failed`/`未落盘` 且路径仍可见。  
3. 新轮次 `searching` 中**不再**出现 `staging:` / `presentation:` 伪装项。  
4. 刷新后 assistant 消息仍带 `editing[]`，`edited` 默认展开。  
5. Stop 仍在 `complete` 后可消失；写入期 busy=finalizing。

### P1

6. 两轮 `request_read` 显示两组 searched，中间有 thinking。  
7. 同轮多 query 同组并行；不拆成 N 个 searching 块。  
8. 旧消息无 `round` 仍可渲染。

---

## 8. 风险与未决

| 风险 | 处理 |
| --- | --- |
| thinking 覆盖 | P0 可接受；P1 必须追加切片 |
| search upsert 按 query 撞车 | P1 upsert 键改为 `(round, query)` |
| 消息体膨胀 | summary 限长；不存正文/ops 原文 |
| bootstrap 是否对用户可见 | 默认弱化；用户抱怨「没搜设定」再放开 |
| 卷名/作品名是否进 edited | v1 否；写在正式输出即可 |

---

## 9. 文件地图（实施时）

| 层 | 文件 |
| --- | --- |
| 契约 | `packages/contracts/src/synopsis.ts` |
| 迁移 | `project-migrations` + `editing_json` |
| Hub | `synopsis-conversation-stream-hub.ts` |
| 服务 | `synopsis-conversation-service.ts`（发射 + 停假 search） |
| Repo | `sqlite-synopsis-conversation-repository.ts` |
| UI | `SynopsisConversationComposer.tsx`、`discuss-busy-phase.ts`、`global.css` |
| 测试 | hub upsertEdit；send 落盘后 peek.editing；旧消息合成 |

---

## 10. 决策记录（反对意见）

- **Past thinking 用 `thought`：** 否，保持 `thinking`。  
- **Past searched 默认展开：** 否，仅 `edited` 默认展开。  
- **P0 就上完整时间线：** 否，先 editing 信任，再交错。  
- **通用 tools[] / 事件日志：** 否，两袋 + 可选 round 足够；避免 peek 全量重放复杂度。
