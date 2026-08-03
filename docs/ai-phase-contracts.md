# Worldseed AI 阶段契约

## 1. 目标

本文冻结第一阶段可以直接编码的 AI JSON 协议。它只规定阶段、结构、证据、上下文边界和回流，不规定人物、势力、地点、事件或其他世界领域类型。

所有阶段：

- 使用同一个 `TurnContext`；
- 只读取当前 `ContextView`；
- 使用 DeepSeek JSON Mode；
- 通过 Zod 校验；
- 不依赖 Tool Calling；
- 不输出隐藏思维链；
- `reason` 和 `selfReview` 只保存结论、依据引用和可审计理由。

## 2. 公共请求

```ts
type AIPhase =
  | "interpret"
  | "rule_assembly"
  | "source_retrieval"
  | "emergence_planning"
  | "emergence_review"
  | "draft"
  | "chapter_naming"
  | "dependency_audit"
  | "response_review"
  | "graph_governance"
  | "semantic_review"
  | "settlement_review"
  | "frontier_settlement"
  | "commit_review"

type PhaseRequest<TInput> = {
  schemaVersion: "1"
  envelopeId: string
  contextId: string
  phase: AIPhase
  protocolVersion: string
  contextViewRef: string
  committedReadIds: string[]
  visiblePendingIds: string[]
  remainingBudget: ModelCallBudget
  input: TInput
}
```

请求中的 ID 必须能够从同一项目、同一任务和允许的作用域解析。请求不直接嵌入整个持久化图。

## 3. 公共结果

```ts
type PhaseOutcome =
  | "continue"
  | "request_read"
  | "approve"
  | "revise"
  | "reject"
  | "retire"

type PhaseResult<TArtifact> = {
  schemaVersion: "1"
  envelopeId: string
  contextId: string
  phase: AIPhase
  outcome: PhaseOutcome
  artifact?: TArtifact
  requestedReads: ReadRequest[]
  citedReadIds: string[]
  producedArtifactIds: string[]
  decisionRecordIds: string[]
  unresolvedDependencies: UnresolvedDependency[]
  reason: string
  selfReview: string
}
```

结构规则：

- `contextId` 必须与请求一致；
- `citedReadIds` 必须是请求中的 `committedReadIds`、`visiblePendingIds` 或本阶段新产物；
- `outcome = request_read` 时 `requestedReads` 不能为空；
- `outcome = revise` 时必须指出修订目标和允许回流阶段；
- `outcome = approve` 时该阶段必需产物必须存在；
- `outcome = retire` 只表示放弃当前 pending 任务或产物，不表示归档已提交世界历史。

## 4. 读取请求

```ts
type ReadRequest = {
  requestId: string
  reason: string
  expectedEvidence: string
  query: {
    exactKeys: string[]
    semanticTexts: string[]
    anchorIds: string[]
    directions: Array<"out" | "in" | "both">
    maxCandidates: number
    maxDepth: number
    sourceKinds: Array<"graph" | "revision" | "source" | "rule" | "reference">
  }
}

type UnresolvedDependency = {
  dependencyId: string
  description: string
  requiredFor: string
  disposition: "read" | "narrow" | "defer" | "retain_uncertainty"
}
```

AI只提出搜索表达和原因。应用层执行检索并把真实返回内容追加到同一个 `TurnContext`；请求本身不能成为事实依据。

## 5. 各阶段产物

### 5.1 interpret

```ts
type InterpretArtifact = {
  workflow: "turn" | "query" | "evolution" | "revision"
  userIntent: string
  worldIntent: string
  presentationIntent: string
  userClaims: Array<{
    text: string
    treatment: "instruction" | "proposal" | "claim" | "question" | "presentation"
    truthStatus: "not_assumed" | "requires_read" | "current_turn_new"
  }>
  requiredTimeAnchor: boolean
  requiredLocationAnchor: boolean
  initialReadHypotheses: string[]
}
```

用户说法默认 `not_assumed`，不能因为用户使用肯定句就自动成为过去真相。

### 5.2 rule_assembly

```ts
type RuleAssemblyArtifact = {
  ruleSnapshotId: string
  baseRuleVersion: string
  userRuleVersionIds: string[]
  settingSkillVersionIds: string[]
  referenceSkillVersionIds: string[]
  presentationRuleVersionIds: string[]
  selectionReasons: Record<string, string>
  unresolvedRuleConflicts: string[]
}
```

基础规则不可被用户规则覆盖；用户规则在明确适用范围内优先。

### 5.3 source_retrieval

```ts
type RetrievalArtifact = {
  executedRequestIds: string[]
  returnedReadIds: string[]
  rejectedCandidateIds: string[]
  missingEvidence: string[]
  nextExpansionHints: string[]
}
```

该阶段只登记真实返回结果，不把未命中解释为不存在。

### 5.4 emergence_planning

```ts
type EmergenceDecision = {
  decisionId: string
  pressureEvidenceIds: string[]
  action: "reuse" | "extend" | "reveal" | "create_new" | "defer" | "reject"
  existingAnchorIds: string[]
  proposedAnchorCount: number
  timeAnchorIds: string[]
  locationAnchorIds: string[]
  informationBoundaryIds: string[]
  reason: string
}

type EmergencePlanningArtifact = {
  decisions: EmergenceDecision[]
  noCreationReason?: string
}
```

### 5.5 emergence_review

```ts
type EmergenceReviewArtifact = {
  reviewedDecisionIds: string[]
  approvedDecisionIds: string[]
  revisionRequests: Array<{
    decisionId: string
    reason: string
    returnTo: "source_retrieval" | "emergence_planning"
  }>
  identityRecallComplete: boolean
  temporalEntryComplete: boolean
  spatialEntryComplete: boolean
  informationBoundaryComplete: boolean
}
```

### 5.6 draft

```ts
type InternalDraftArtifact = {
  draftId: string
  contentRef: string
  adoptedEmergenceDecisionIds: string[]
  citedReadIds: string[]
  currentTimeAnchorIds: string[]
  currentLocationAnchorIds: string[]
  detectedUnplannedContent: string[]
}
```

`draft` 是应用内部产物，不进入用户文件树，不直接成为世界事实，也不要求用户审批。

### 5.7 chapter_naming

```ts
type ChapterNamingArtifact = {
  chapterId: string
  chapterNumberText: string
  heading: string
  filename: string
  predecessorSourceId?: string
  continuityEvidenceIds: string[]
}
```

`heading` 必须与 Markdown 第一行一致；`filename` 必须等于合法化后的同一标题加 `.md`。

### 5.8 dependency_audit

```ts
type DependencyAuditArtifact = {
  auditedDraftId: string
  resolvedDependencyIds: string[]
  missingDependencies: UnresolvedDependency[]
  unplannedContent: Array<{
    description: string
    returnTo: "source_retrieval" | "emergence_planning" | "draft"
  }>
  timeContinuity: "pass" | "revise" | "unknown"
  locationContinuity: "pass" | "revise" | "unknown"
  informationBoundary: "pass" | "revise" | "unknown"
}
```

### 5.9 response_review

```ts
type ResponseReviewArtifact = {
  responseArtifactId: string
  evidenceClosed: boolean
  leaksUnobservedInformation: boolean
  requiresWorkflowUpgrade: boolean
  upgradeReason?: string
}
```

只读回答需要写世界事实时，升级到图治理工作流，不能从查询接口暗写。

### 5.10 graph_governance

```ts
type GraphGovernanceArtifact = {
  proposalId: string
  sourceUnitIds: string[]
  mutations: GraphMutation[]
  retrievalProjectionIds: string[]
  settlementRecordIds: string[]
  continuityProofIds: string[]
  archiveOutletIds: string[]
  decisionRecordIds: string[]
}
```

归档通过普通 committed 节点与连接实现，不使用 `retired` 代替世界历史。

### 5.11 semantic_review

```ts
type SemanticReviewArtifact = {
  proposalId: string
  approvedMutationIndexes: number[]
  rejectedMutationIndexes: number[]
  revisionReason?: string
  returnTo?: "source_retrieval" | "graph_governance"
  graphStillDiscoverable: boolean
  graphStillConcise: boolean
  continuityPreserved: boolean
}
```

### 5.12 settlement_review

```ts
type SettlementReviewArtifact = {
  sourceUnitIds: string[]
  settledSourceUnitIds: string[]
  uncoveredSourceUnitIds: string[]
  sourceReturnComplete: boolean
  retrievalProjectionComplete: boolean
  semanticCoverageComplete: boolean
}
```

正式正文要求 `uncoveredSourceUnitIds` 为空。

### 5.13 frontier_settlement

```ts
type FrontierSettlementArtifact = {
  affectedAnchorIds: string[]
  activeFrontierIds: string[]
  deferredFrontierIds: string[]
  archivedFrontierIds: string[]
  lastWorldTimeAnchorIds: string[]
  deferralReasons: Record<string, string>
}
```

### 5.14 commit_review

```ts
type CommitReviewArtifact = {
  decision: "commit" | "revise" | "retire"
  scopeId: string
  requiredPhaseRunIds: string[]
  approvedArtifactIds: string[]
  unresolvedDependencyIds: string[]
  revisionTargetPhase?: AIPhase
  finalSelfReview: string
}
```

`commit_review` 是 AI自动执行的最终阶段，不是人工确认按钮。只有 `decision = commit` 且结构门禁完整时，代码才提升作用域并发布章节。

## 6. 阶段流转

| 当前阶段 | 正常下一阶段 | 允许回流 |
| --- | --- | --- |
| `interpret` | `rule_assembly` | 无 |
| `rule_assembly` | `source_retrieval` 或 `emergence_planning` | `interpret` |
| `source_retrieval` | 调用方指定阶段 | `source_retrieval` |
| `emergence_planning` | `emergence_review` | `source_retrieval` |
| `emergence_review` | `draft` | `source_retrieval`、`emergence_planning` |
| `draft` | `chapter_naming` 或 `dependency_audit` | `source_retrieval`、`emergence_planning` |
| `chapter_naming` | `dependency_audit` | `draft` |
| `dependency_audit` | `graph_governance` 或 `response_review` | `source_retrieval`、`emergence_planning`、`draft` |
| `response_review` | 完成或升级工作流 | `source_retrieval`、`draft` |
| `graph_governance` | `semantic_review` | `source_retrieval` |
| `semantic_review` | `settlement_review` 或 `frontier_settlement` | `source_retrieval`、`graph_governance` |
| `settlement_review` | `frontier_settlement` | `graph_governance` |
| `frontier_settlement` | `commit_review` | `graph_governance` |
| `commit_review` | 提交或结束 | `source_retrieval`、`graph_governance`、`settlement_review`、`frontier_settlement` |

状态机只允许表中流转。任何阶段不能直接跳到 `commit_review`。

## 7. JSON Mode 与校验

每次请求必须：

- 在提示词中明确要求只输出 JSON；
- 设置 `response_format: { type: "json_object" }`；
- 使用当前阶段固定的 Zod Schema；
- 拒绝 Markdown 代码块、额外前后缀和无法规范解析的 JSON；
- 保存原始响应摘要、schema 版本和校验结果；
- 结构失败最多执行 `maxSchemaRepairAttempts` 次，默认 `2`；
- 修复调用继续使用同一个 `TurnContext`，追加校验错误，不重建任务上下文；
- 达到上限后产生 `model_failure`，保留 pending 作用域，不猜测缺失字段。

## 8. 验收标准

- 每个阶段都有独立 Zod Schema；
- 每个阶段只能引用当前上下文允许的 ID；
- `request_read` 不会直接增加读取权限；
- `draft` 不进入用户文件树；
- `commit_review` 无人工门禁且不能跳过必要阶段；
- `retired` 不会被误用为已提交世界归档；
- 阶段回流次数受项目预算限制；
- DeepSeek 缓存命中与否不改变阶段结果校验。
