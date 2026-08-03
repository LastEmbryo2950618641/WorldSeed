# Worldseed 单轮上下文与 KV 缓存设计

## 1. 核心原则

Worldseed 对每一轮前台推演维护一个、且仅维护一个逻辑上下文：`TurnContext`。

这里的“一个上下文”不是把整个世界图一次性装入模型，而是指：

- 本轮所有 AI 阶段共享同一个上下文账本；
- 本轮用户输入、表现规则、实际召回资料和本轮新产物按顺序进入账本；
- 阶段之间不创建互相失联的独立事实上下文；
- 任何阶段只能使用账本中已经存在的内容；
- 持久化图和小说原文仍是事实来源，上下文和 KV 缓存都不是事实来源。

查询、后台演化和另一轮正文各自拥有独立的 `TurnContext`，不能共享可变上下文内容。不同任务可以因为稳定提示前缀相同而获得供应商缓存命中，但不能因此共享任务事实。

## 2. TurnContext

```ts
type TurnContext = {
  contextId: string
  projectId: string
  taskId: string
  turnId: string
  taskKind: "turn" | "query" | "evolution" | "revision"
  protocolVersion: string
  ruleSnapshotId?: string
  baseCommittedSequence: number
  segments: ContextSegmentRef[]
  readLedger: ContextReadLedger
  checkpoint?: ContextCheckpointRef
  budget: ContextBudgetSnapshot
}
```

`TurnContext` 是本轮上下文的持久化账本，不保存模型隐藏思维链。它只保存阶段输入、阶段输出摘要、实际读取 ID、引用关系、摘要、token 估算和缓存统计。

### 2.1 上下文片段

```ts
type ContextSegmentRef = {
  segmentId: string
  kind:
    | "system_principles"
    | "protocol"
    | "rule_snapshot"
    | "user_input"
    | "presentation_rules"
    | "committed_read"
    | "pending_artifact"
    | "phase_result"
    | "checkpoint"
  ownerIds: string[]
  visibility: "committed" | "pending"
  canonicalDigest: string
  tokenEstimate: number
  sequence: number
}
```

片段只描述来源和顺序，具体内容存放在内部对象存储或项目数据库中。`ownerIds` 是持久化入口，保证上下文压缩后仍能重新定位原始资料。

### 2.2 读取账本

```ts
type ContextReadLedger = {
  committedReadIds: string[]
  visiblePendingIds: string[]
  requestedReadIds: string[]
  returnedReadIds: string[]
  rejectedReadIds: string[]
  readReasons: Record<string, string>
}
```

只有 `returnedReadIds` 中的持久化资料才算本轮已经读取。AI提出 `requestedReadIds` 不代表它已经拥有这些事实；检索层返回后才可以追加到上下文。

## 3. 上下文构造顺序

每轮上下文按以下顺序构造，并尽量保持前缀稳定：

```text
固定基础原则
→ Prompt Contract
→ 项目机械参数快照
→ RuleSnapshot
→ 用户输入
→ 本轮表现规则 Markdown
→ 当前时间与地点锚点
→ 实际召回的 committed 局部图/原文片段
→ 本轮新产生的阶段结果
→ 本轮 pending 正文或图提案
```

规则如下：

1. 固定基础原则、协议版本、项目参数和 `RuleSnapshot` 必须位于稳定前缀；
2. 不把随机 ID、当前耗时、token 统计或动态 UI 状态放入稳定前缀；
3. 用户输入和表现规则位于任务相关区，不能被其他项目或其他任务复用；
4. 旧图或原文只有在检索层实际返回后才能追加；
5. 阶段结果以追加方式写入，不能修改之前已经发送给模型的消息；
6. 修订通过追加“修订结果”表达，不能在上下文中静默覆盖旧阶段结果。

这保证了“本轮只能依赖实际读取的旧图和本轮新产生内容”，同时使阶段间的共同前缀可以稳定缓存。

## 4. 阶段视图

每个阶段读取同一个 `TurnContext`，但得到受阶段权限限制的 `ContextView`：

```ts
type ContextView = {
  contextId: string
  phase: AIPhase
  orderedSegments: ContextSegmentRef[]
  committedReadIds: string[]
  visiblePendingIds: string[]
  allowedProducedIds: string[]
  remainingBudget: ContextBudgetSnapshot
}
```

`ContextView` 不是第二份事实，也不是新的上下文。它只是同一个上下文账本在当前阶段的投影。

- `interpret` 可以读取用户输入和表现控制；
- `rule_assembly` 追加规则快照；
- `source_retrieval` 追加实际返回的资料；
- `emergence_review` 可以读取规划结果和实际依据；
- `draft` 只能读取当前账本，生成内部临时正文；
- `dependency_audit` 可以要求补充读取，但不能把未返回的 ID 当事实；
- `graph_governance` 追加正文实际出现内容和图提案；
- `commit_review` 只能使用本轮完整账本和阶段证据。

阶段不通过函数参数接收任意全局图对象，不允许为了方便直接调用全局查询。

## 5. 上下文窗口与压缩

“一个上下文”不等于“无限上下文”。每次请求仍然受模型上下文窗口和本轮 token 预算限制。

### 5.1 选择优先级

接近预算时按以下顺序保留内容：

1. 当前场景的时间和地点锚点；
2. 当前人物或行动主体实际可用的信息；
3. 形成当前行动所必需的已读取事实；
4. 用户本轮输入和表现规则；
5. 尚未完成的依赖闭包；
6. 本轮阶段结果和图提案；
7. 可选的自治候选和非必要背景。

因果必需、时空连续和当前状态依据不能因为可选背景占满预算而被删除。预算不足时先缩小可选内容，再延后自治候选。

### 5.2 压缩检查点

上下文达到压缩阈值时，创建 `ContextCheckpoint`：

```ts
type ContextCheckpoint = {
  checkpointId: string
  contextId: string
  coveredSegmentIds: string[]
  retainedFactDigests: string[]
  retainedAnchorIds: string[]
  unresolvedDependencyIds: string[]
  summaryDigest: string
  createdAt: string
}
```

压缩只替换模型请求中的默认可见文字，不删除原始片段、读取账本、来源引用或返回路径。需要早期原话、精确数值或完整过程时，AI必须沿 `ownerIds` 重新读取原始资料。

压缩后的摘要不是新的世界事实，不能覆盖持久化图中已经确认的后续状态。

## 6. KV 缓存复用

DeepSeek API 的请求在传输层是无状态的，应用不直接保存或传输 KV 张量。KV 复用依赖供应商对相同前缀的自动缓存。

### 6.1 可缓存前缀

以下内容保持固定顺序和规范序列化，以最大化前缀命中：

- 基础原则摘要；
- Prompt Contract 版本和阶段协议公共部分；
- 项目机械参数快照；
- 当前 `RuleSnapshot` 的不可变版本；
- 稳定的输出 JSON Schema。

以下内容放在动态后缀，不能放到稳定前缀之前：

- 用户本轮输入；
- 当前动态时间和任务状态；
- 实际召回片段；
- 阶段结果和修订结果；
- token、耗时和缓存统计。

### 6.2 保持命中所需的编码规则

- 固定 JSON 字段顺序；
- 固定 Markdown 片段拼接顺序；
- 不在前缀中插入随机 ID、当前时间和运行统计；
- 规则和协议改变时允许缓存自然失效；
- 追加新片段，不重写旧片段；
- 每个阶段使用相同的模型、tokenizer、系统前缀和 JSON Schema 版本；
- 缓存命中不是正确性的依据，命中率为零时仍必须正常运行。

### 6.3 指标

每次模型调用记录：

```ts
type KVCacheUsage = {
  totalInputTokens: number
  cacheHitInputTokens: number
  cacheMissInputTokens: number
  outputTokens: number
  hitRate?: number
}
```

`hitRate` 的计算方式为：

```text
cacheHitInputTokens / totalInputTokens
```

供应商未返回缓存 token 明细时，`hitRate` 为 `undefined`，UI 显示“不可用”，不能显示 `0%`。本轮聚合指标显示在右侧流程消耗栏，并写入任务观测记录。

## 7. 上下文与检索边界

KV 缓存只复用相同的提示前缀，不扩大本轮事实权限：

- 命中缓存不等于重新读取世界图；
- 上一轮缓存不能成为本轮事实依据；
- 其他项目相同的基础规则前缀不能带入项目内容；
- 未进入 `returnedReadIds` 的资料不能被阶段引用；
- 缓存失效只增加模型输入成本，不改变推演语义。

## 8. 失败和恢复

如果模型调用中断：

1. 保存本轮上下文账本和最后一个完整阶段结果；
2. 保存缓存统计，但不把缓存状态当作恢复依据；
3. 恢复时从最后完整的追加序列重新组装请求；
4. 如果供应商缓存未命中，重新计算并继续，不修改读取账本；
5. 如果 `RuleSnapshot`、Prompt Contract 或模型版本变化，建立新任务或明确进入修订，不静默混用。

## 9. 验收标准

- 同一 `turnId` 只有一个 `TurnContext`；
- 每个阶段都能列出它读取的片段和新增片段；
- 未返回的检索 ID 不会进入阶段输入；
- 上下文压缩后可以通过来源 ID找回原始资料；
- 压缩前后当前状态、时间锚点和地点锚点不发生无依据回退；
- 相同稳定前缀的连续请求能够获得供应商缓存命中或明确记录未命中原因；
- KV 命中率不会改变检索结果、图修改权限或提交结果；
- 清空模型上下文后，显式恢复任务仍能从 `TurnContext` 和持久化图继续。
