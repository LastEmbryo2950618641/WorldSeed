# 章节修改入口协调设计

> 本文定义三种正文修改入口（本轮推演、直接编辑、Agent 对话）如何共享同一套事实状态，又不让草稿和对话污染全局模型上下文。它是 [正文修订与用户最高权限设计](chapter-revision-and-user-authority.md) 和 [上下文与 KV 缓存设计](context-and-kv-cache.md) 的补充，不替代这两份文档中的用户权限、最终化和图同步规则。
>
> 当前状态：设计已冻结，**P0 已实施**（`ChapterContextResolver`、hydration supersession、压缩保护、revision 提交时机）。权威实现差距见 §12；实施计划见 [2026-08-26 实施计划](superpowers/plans/2026-08-26-chapter-modification-coordination-impl.md)。

## 1. 问题

Worldseed 存在三种会读写上下文、并可能改变章节正文的入口：

| 入口 | 主要用途 | 当前 workflow |
| --- | --- | --- |
| **本轮推演** | 初次撰写新章节 | `turn` |
| **直接编辑章节** | 用户手动改已提交章节 | `revision`（`submissionMode: direct`） |
| **Agent 对话修订** | 用户与 Agent 协作改已提交章节 | `revision`（`submissionMode: agent`，待实现） |

当项目已经推演多轮、链上存在多个 `canonical_chapter` 后，用户仍可能回头修改早期章节。此时系统必须同时满足：

1. **不混合草稿** — 未提交的编辑、Agent 多轮对话、进行中的 turn 草稿不能进入全局 `ModelContextChain`；
2. **不丢失连续性** — 任意 AI 请求都能知道「当前每章正式版本是什么」「哪章可能因他人修订而过时」；
3. **不自动改写后续章节** — 修订第 1 章不会静默重写第 2、3 章正文；
4. **不教错模型** — 模型可见的章节正文必须来自当前 head，而不是链上已被替代的 `canonical_chapter`。

## 2. 核心原则

### 2.1 时间线 vs 当前有效状态

```text
时间线（ModelContextChain，只追加、不改写）
├── canonical_chapter  ch1@v1
├── canonical_chapter  ch2@v1
├── canonical_chapter  ch3@v1
└── chapter_revision   ch1: v1→v2   ← 修订提交后追加

当前有效状态（active_document_heads + ChapterIndex，可随时更新）
├── ch1 → source_v2
├── ch2 → source_v1   ← 仍基于旧 ch1 写出，标记 stale
└── ch3 → source_v1
```

- **链上消息**记录「当时发生了什么」，供审计、KV 前缀和历史恢复；
- **章节 head**记录「现在是什么」，供检索、UI 和所有 AI 读取当前正文；
- **禁止**通过修改历史 `canonical_chapter` 消息来回填修订结果。

### 2.2 一个上下文账本 per 任务，一个事实链 per 分支

沿用 [动态上下文架构](dynamic-context-architecture.md) §2.1：

- 每个 **turn** 或 **ChapterRevision** 任务各自维护 `TurnContext`（读取账本、预算、Evidence）；
- 同一历史分支只有一条活动 `ModelContextChain`；
- 只有 **提交** 才把正式结果追加到链上；草稿和对话留在任务局部。

### 2.3 读章节永远走 resolveChapter，不走链消息正文

**硬规则：** 任何需要「当前章节正文」的调用方，必须通过 `resolveChapter(projectId, chapterId)` 读取，禁止直接把 `model_context_messages` 中 `canonical_chapter` 的 `contentRef` 当作当前正文。

适用调用方包括但不限于：

- `TurnOrchestrator` 模型请求前的上下文 hydration；
- `ContextWindowManager` 压缩时的章节叙事保留；
- `chapter_naming` 读取上一章；
- `revision_review` / `revision_assist` bootstrap；
- 检索层章节 exact/semantic 读取（已通过 `active_document_heads` 部分满足）。

### 2.4 后续章节不自动改写，但必须标记可能过时

修订旧章节后：

- 后续章节正文、链上 `canonical_chapter`、图结算 **均不自动修改**；
- 系统通过 `ChapterLineage` 计算 `staleMarkers`，提示用户和 AI；
- 只有用户再次发起修订或新 turn，才产生新的正文版本。

## 3. 领域对象

### 3.1 ChapterIndex

稳定的章节序号与身份索引，不随标题或文件名变化。

```ts
ChapterIndex {
  chapterId: string          // 稳定身份，首次提交后不变
  sequence: number           // 正整数，首次 content_committed 时分配，之后不变
  currentSourceId: string    // 与 active_document_heads 同步
  currentPublishPath: string
  assignedAtMs: number
}
```

规则：

- `sequence` 在章节**首次正式提交**时分配，不由 `turn.start` 时的 `chapterCount + 1` 推断；
- 标题、文件名、`publishPath` 变化不改变 `sequence`；
- 历史恢复时从快照中的 `ChapterIndex` 还原，不从文件树计数回填。

**与现有存储的关系：** 今天 `canonical_chapter_messages.chapter_sequence` 只在 turn 时写入且修订后不更新；`listCommittedChapters` 按 `created_at` 排序。`ChapterIndex` 是二者的统一权威来源。

### 3.2 ChapterLineage

记录每章「写出时依赖什么」以及「现在是否可能过时」。

```ts
ChapterLineage {
  chapterId: string
  sourceId: string                    // 本 lineage 描述的正文版本
  writtenAgainst: {
    priorChapterSourceIds?: string[]  // 写出时各前序章节的 sourceId
    graphRevisionIds?: string[]       // 写出时读到的图修订
    ruleSnapshotId?: string
    modelContextSequence?: number
  }
  staleMarkers: StaleMarker[]         // 只读时计算，不作为权威持久状态
}

StaleMarker {
  kind:
    | "prior_chapter_superseded"      // 前序章节已被用户修订
    | "graph_head_changed"            // 图 head 已变化
    | "graph_sync_incomplete"       // 存在未完成图同步
    | "base_source_superseded"        // 修订任务的 base 已过期
    | "review_digest_mismatch"        // 审核结果与当前 proposed 不一致
  ref: string
  reason: string
  staleSinceMs: number
}
```

`writtenAgainst` 在每次 **content_committed**（turn 或 revision submit）时快照写入；`staleMarkers` 在 `resolveChapter` 时根据当前全局 head 重新计算。

示例：修订 ch1 后

```text
ch1: { sourceId: v2, staleMarkers: [] }
ch2: { sourceId: v1, writtenAgainst: { priorChapterSourceIds: [ch1:v1] },
       staleMarkers: [{ kind: "prior_chapter_superseded", ref: "ch1", reason: "ch1 revised to v2" }] }
ch3: 同上
```

### 3.3 resolveChapter

统一章节读取入口，返回 UI 和 AI bootstrap 所需的全部状态。

```ts
ResolvedChapter {
  index: ChapterIndex
  committed: ChapterReadResult       // 当前正式正文（来自 head）
  lineage: ChapterLineage
  activeRevision?: ChapterRevisionReadResult
  revisionStale: boolean
  graphSyncBlocking: boolean
  suggestedUiMode: EditorSurfaceMode
}

EditorSurfaceMode =
  | "home_turn"              // 创作台：显示本轮推演输入
  | "chapter_read"           // 已提交章节只读
  | "chapter_revision_direct"// 直接编辑修订
  | "chapter_revision_agent" // Agent 对话修订
  | "graph_sync_recovery"    // 正文已提交、图同步待恢复
```

`graphSyncBlocking`：当项目内存在 `graphSyncStatus ∈ {pending, running, failed}` 的修订任务时，默认阻止新的依赖当前图的 turn（与 [正文修订设计](chapter-revision-and-user-authority.md) §10.4 一致）。

## 4. 三种修改入口

### 4.1 本轮推演（新建章节）

**容器：** `Turn task`（`workflow: turn`）

```text
startTurn():
  1. 若 graphSyncBlocking → 默认拒绝，提示先完成图同步
  2. 创建 TurnContext + pending scope
  3. 完整阶段链 → draft → chapter_naming → … → commit
  4. scope.commit → 更新 active_document_heads + ChapterIndex
  5. registerCanonicalChapter → 追加 canonical_chapter 到链
  6. 快照 writtenAgainst 到 ChapterLineage
```

读章节时一律 `resolveChapter`；新 turn 的 `dependency_audit` 基于各章 **当前 head**，不会误用链上被压缩的旧 ch1 正文。

### 4.2 直接编辑章节

**容器：** `ChapterRevision`（`workflow: revision`，`submissionMode: direct | reviewed`）

```text
startRevision(chapterId):
  1. resolveChapter → 检查 baseSourceId == committed.sourceId
  2. 若已有活跃修订 → 恢复；若 base 过期 → RevisionConflictError
  3. 创建 revision task，proposed = committed 副本

updateRevision(heading, body):
  → 新 proposedSourceId，旧 review 失效

submitRevision():
  1. content scope 提交 → head 更新
  2. 追加 chapter_revision 到链（见 §5）
  3. 更新 ChapterLineage；为后续章节计算 staleMarkers
  4. 启动 graphSyncTask（异步）
```

详见 [正文修订与用户最高权限设计](chapter-revision-and-user-authority.md)。

### 4.3 Agent 对话修订

**容器：** 同一个 `ChapterRevision`（`submissionMode: agent`）

Agent 对话是修订的**输入方式**，不是第四种 workflow。

> **演进草案：** 取消强制「写入草稿」、引入修订任务内 **草稿版本 / diff / 回退** 的设计见 [章节草稿版本设计](superpowers/specs/2026-08-26-chapter-draft-versions-design.md)。下列流程描述的是当前已实现行为；草案采纳后以该文档为准修订本节。

```text
startRevision(chapterId, mode: agent):
  → 同 4.2，额外创建空 revision_conversation

conversation.send(revisionTaskId, userMessage):
  1. bootstrap: resolveChapter + 后续章节当前假设（选择性读取）
  2. 多轮 Agent 回复写入 revision_conversation_messages（任务局部）
  3. Agent 产出 proposedHeading/proposedBody 草稿，不自动 commit

conversation.apply(revisionTaskId, messageId):
  → 用户显式确认后，调用 updateRevision

submitRevision():
  → 与 4.2 完全相同
```

**边界：**

| 存储 | 写入时机 | 是否进入 ModelContextChain |
| --- | --- | --- |
| `revision_conversation_messages` | 每轮对话 | 否 |
| `proposed` buffer | `updateRevision` / `apply` | 否 |
| `chapter_revision` 消息 | `submitRevision` 正文提交后 | 是 |
| head / source_units | content scope commit | 是（权威事实） |

## 5. ModelContextChain 上的章节消息

### 5.1 消息种类与职责

| kind | 何时追加 | 是否修改 | 模型可见正文来源 |
| --- | --- | --- | --- |
| `canonical_chapter` | turn finalization | 永不修改 | **不直接读**；由 resolveChapter 替代 |
| `chapter_revision` | revision content committed | 永不修改 | **不直接读**；由 resolveChapter 替代 |

### 5.2 chapter_revision 结构化载荷

设计要求的载荷（今天代码仅写 `contentRef`，需补齐）：

```text
kind: chapter_revision
chapterId
replacedSourceId
sourceId
contentDigest
decisionId
contentRef
```

`appendChapterRevisionMessage` 应在 **正文提交完成时**（`chapter_registered`）调用，**不等待**图同步完成。图同步只更新图 head 和 lineage 中的 `graph_head_changed` 标记。

### 5.3 压缩与 supersession

[上下文与 KV 缓存设计](context-and-kv-cache.md) 的机械压缩规则需补充：

1. 对每个 `chapterId`，模型可见叙事正文 = `resolveChapter(head).committed.body`；
2. 链上同 `chapterId` 的旧 `canonical_chapter` 在 hydration 时被 **supersede**（隐藏或替换为 head 解析结果），避免模型同时看到 v1 和 v2；
3. `chapter_revision` 与 `canonical_chapter` 同等对待为**叙事类消息**，不得在第一阶段压缩中被当作普通非叙事消息删除；
4. 压缩只影响**可见性**，不删除持久消息；历史恢复仍可还原完整时间线。

**hydration 伪代码：**

```text
for each visible message in chain:
  if message.kind in (canonical_chapter, chapter_revision):
    chapterId = message.metadata.chapterId
    resolved = resolveChapter(chapterId)
    if message.sourceId != resolved.committed.sourceId:
      skip or replace with resolved body  // superseded
    else:
      use resolved body  // always from head
```

## 6. 多轮推演后修订旧章节

### 6.1 典型时间线

```text
Turn 1 → ch1@v1 committed, canonical_chapter 入链
Turn 2 → ch2@v1 committed（writtenAgainst: ch1@v1）
Turn 3 → ch3@v1 committed
用户修订 ch1 → ch1@v2, chapter_revision 入链, ch2/ch3 标记 stale
用户继续 Turn 4 → 读 ch1@v2 + ch2@v1 + ch3@v1, dependency_audit 检查连续性
```

### 6.2 后续章节处理

| 对象 | 修订 ch1 后的行为 |
| --- | --- |
| ch2/ch3 正文 | 保留，不自动改写 |
| ch2/ch3 链消息 | 保留 |
| ch2/ch3 staleMarkers | 增加 `prior_chapter_superseded` |
| 图 | ch1 graphSync 产生新修订；ch2/ch3 图结算仍指向旧 source，直到用户修订 |
| UI | 显示「受 ch1 修订影响」建议列表，不强制操作 |

### 6.3 连续修订与图同步串行

- 同一章节同一时间只允许一个活跃 `ChapterRevision`；
- 多个章节的图同步任务应**串行**或按依赖排序，避免并发写 graph head；
- 用户可在 ch1 graphSync 运行中开始编辑 ch2，但 ch2 的 `submit` 应等待或明确提示 ch1 图状态。

## 7. UI 路由规则

修正 [UI 设计](ui-design.md) §6.3 的歧义：**本轮推演输入仅在创作台（未打开章节 Tab）显示**；打开已提交章节时显示章节专用面板。

| 上下文 | 主工作区 | 底部面板 |
| --- | --- | --- |
| 创作台 / 无章节 Tab | 空白或材料编辑 | **本轮推演输入** |
| 已提交章节（只读） | 章节阅读器 | **章节对话** + 「编辑章节」 |
| 章节直接修订中 | Monaco 编辑器 + 审核侧栏 | 提交/放弃（现有） |
| 章节 Agent 修订中 | 正文预览 + 对话面板 | 对话输入 + 「应用到修订稿」 |
| 图同步待恢复 | 章节阅读器 + 状态横幅 | 重试图同步 |
| 推演运行中 | 右栏流程 | 全局禁用修改入口 |

打开章节时调用 `chapter.resolve`（或等价的 `resolveChapter`），一次返回 `committed`、`activeRevision`、`lineage`、`suggestedUiMode`，替代今天 `list` + `read` + `findActiveRevision` 的三次往返。

## 8. 契约与 API

### 8.1 新增

| 方法 | 用途 |
| --- | --- |
| `chapter.resolve` | 统一读取 ResolvedChapter |
| `chapter.resolveByPath` | 按 publishPath 解析 |
| `chapter.revision.conversation.list` | 列出对话消息 |
| `chapter.revision.conversation.send` | 用户发消息，Agent 回复 |
| `chapter.revision.conversation.apply` | 将 Agent 草稿写入 proposed |

### 8.2 扩展类型

- `packages/contracts/src/chapter.ts` — `ChapterIndex`、`ChapterLineage`、`ResolvedChapter`、`EditorSurfaceMode`
- `packages/contracts/src/model-context.ts` — `chapter_revision` 结构化 metadata；可选 `revision_conversation` kind（仅内部组装）
- `packages/contracts/src/events.ts` — `chapter.resolved.changed`、`chapter.lineage.stale`

### 8.3 持久化

| 表 | 用途 |
| --- | --- |
| `chapter_index` | 稳定 sequence 与 chapterId 映射 |
| `chapter_lineage_snapshots` | 每次 content_committed 的 writtenAgainst |
| `revision_conversation_messages` | Agent 多轮对话（任务局部） |
| `model_context_messages.metadata_json` | chapter_revision 的 chapterId / replacedSourceId 等 |

## 9. 实施顺序

交叉审核一致建议的实现顺序：

| 阶段 | 内容 | 理由 |
| --- | --- | --- |
| **P0** | `resolveChapter` + hydration supersession | 修复修订后模型仍看到旧 `canonical_chapter` 的阻断问题 |
| **P0** | `ContextWindowManager` 将 `chapter_revision` 纳入叙事保护 | 避免压缩后只剩 stale 正文 |
| **P1** | `chapter_index` 表 + 回填 | 稳定序号，消除 fileCount/findIndex |
| **P1** | 补齐 `chapter_revision` 消息 metadata | 支撑 supersession 与审计 |
| **P1** | `appendChapterRevisionMessage` 移到正文提交时 | 与图同步解耦 |
| **P2** | `ChapterLineage` 快照 + stale 计算 | 支持多轮后修订旧章的连续性提示 |
| **P2** | `graphSyncBlocking` 门禁 | turn.start / 二次修订前检查 |
| **P3** | UI 路由：隐藏章节 Tab 下的 TurnComposer | 避免误开新 turn |
| **P3** | `chapter.resolve` API + Renderer 接入 | 减少往返、统一模式 |
| **P4** | `revision_conversation_messages` + `revision_assist` 阶段 | Agent 对话修订 |
| **P4** | 受影响章节建议列表 UI | stale 可视化 |

## 10. 验收标准

### 10.1 上下文正确性

1. 修订 ch1 后，下一次 turn 的模型请求正文中，ch1 内容为 v2，不包含 v1 原文；
2. 链上仍保留 v1 的 `canonical_chapter` 消息（可压缩隐藏），历史恢复可还原；
3. `chapter_revision` 消息含 `replacedSourceId`、`sourceId`、`chapterId`；
4. 压缩 20 章后，`resolveChapter` 仍返回正确 head 正文。

### 10.2 隔离性

5. Agent 对话未提交前，其他 turn 的 `resolveChapter` 看不到 proposed 草稿；
6. 三个入口的 pending 草稿互不可见，直到各自提交；
7. 同一章节不能有两个活跃 `ChapterRevision`。

### 10.3 连续性

8. 修订 ch1 后，ch2 的 `staleMarkers` 含 `prior_chapter_superseded`；
9. ch2/ch3 正文不自动变化；
10. `revision_review` 能指出后续章节假设与修订后 ch1 的冲突；
11. graphSync 未完成时，新 turn 默认被阻止。

### 10.4 UI

12. 打开已提交章节时不显示「本轮推演输入」；
13. 创作台显示「本轮推演输入」；
14. Agent 草稿必须经「应用到修订稿」才进入 proposed。

## 11. 交叉审核结论摘要

三份子 agent 审核（代码探索、架构批评、契约/测试）的一致结论：

### 11.1 与现有架构对齐的部分

- `active_document_heads` 作为 committed 正文权威来源 — **已存在且正确**；
- 修订与 turn 分离的 finalization、`chapter_revision` 追加式消息 — **方向正确**；
- 正文提交与图同步解耦 — **已实现**；
- 后续章节不自动改写 — **已实现（无相关代码路径）**。

### 11.2 阻断级缺口（必须在 P0 修复）

1. **双真相：** `TurnOrchestrator` hydration 直接读链上 `canonical_chapter` 正文，修订后 head 已更新但模型仍看到旧文（`turn-orchestrator.ts` ~2095–2156）；
2. **压缩误删：** `ContextWindowManager` 不保护 `chapter_revision`，第一阶段当作非叙事删除（`context-window-manager.ts` ~52–54）；
3. **消息元数据缺失：** `appendChapterRevisionMessage` 无 `chapterId` / `replacedSourceId`，无法做 supersession。

### 11.3 设计层需明确的裁决

| 议题 | 裁决 |
| --- | --- |
| 创作台 vs 章节 Tab 下的推演输入 | 推演输入仅在创作台；章节 Tab 用对话/修订面板（修订 ui-design §6.3） |
| `canonical_chapter_messages` 角色 | 降为历史登记；`ChapterIndex` + head 为序号与当前版本权威 |
| `chapter_revision` 追加时机 | 正文提交时，不等待图同步 |
| Agent 对话存储 | 独立 `revision_conversation_messages`，不进链 |
| stale 是否阻断 | 默认不阻断正文/修订，阻断新 turn（可配置） |

### 11.4 测试缺口

现有 `backend-utility.test.ts` 验证了 `chapter_revision` 消息存在，但**未断言**模型请求不包含 stale `canonical_chapter` 正文。P0 必须增加 hydration supersession 回归测试。

## 12. 相关文档

| 文档 | 关系 |
| --- | --- |
| [chapter-revision-and-user-authority.md](chapter-revision-and-user-authority.md) | 修订权限、审核、提交、图同步细节 |
| [context-and-kv-cache.md](context-and-kv-cache.md) | ModelContextChain、压缩；§5.3 需同步更新 |
| [dynamic-context-architecture.md](dynamic-context-architecture.md) | TurnContext、读取账本 |
| [adaptive-graph-governance-design.md](adaptive-graph-governance-design.md) | 修订后图同步降本 |
| [ui-design.md](ui-design.md) | §5.6、§6.3 需按 §7 修订 |
| [ai-phase-contracts.md](ai-phase-contracts.md) | 新增 `revision_assist` 阶段契约 |
| [implementation-status.md](implementation-status.md) | 实施状态登记 |
