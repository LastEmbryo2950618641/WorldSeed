# Worldseed AI 阶段契约

## 1. 目标

本文冻结第一阶段可以直接编码的 AI JSON 协议。它只规定阶段、结构、证据、上下文边界和回流，不规定人物、势力、地点、事件或其他世界领域类型。

所有阶段：

- 使用同一个 `TurnContext`；
- 只读取当前 `ContextView`；
- 默认不启用供应商 JSON Mode，通过提示词要求 JSON 文本并由后端解析校验；供应商兼容性验证通过后可由统一模型配置开启；
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

应用层内部请求中的 ID 必须能够从同一项目、同一任务和允许的作用域解析。发送给模型时，适配器移除模型不需要的技术字段，并将仍需引用的真实 ID 替换为本次请求专属别名；模型消息不直接暴露持久化 UUID，也不直接嵌入整个持久化图。

每个阶段只有一套 artifact schema。模型直接返回该语义 artifact，应用层不再维护第二套“模型 artifact”并做字段翻译。模型不生成章节、原文、提案、修订、投影、结算或决定记录 UUID；这些技术身份由应用层在物化时创建。模型使用本次请求的 `read-*`、`node-*`、`link-*` 等临时别名引用已有证据；适配器先验证别名结果，再恢复真实 ID。只有 `graph_governance` 可以声明新的 `local:*`；后续阶段可以复用本请求中 graph governance 已声明的局部句柄，但不能新增或伪造新的局部句柄，其他阶段仍只能引用本轮可读的已有图身份。

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
- `citedReadIds` 必须是请求中的 `committedReadIds` 或 `visiblePendingIds`；
- `outcome = request_read` 时 `requestedReads` 不能为空；
- `outcome = revise` 时必须指出修订目标和允许回流阶段；
- `outcome = approve` 时该阶段必需产物必须存在；
- `outcome = retire` 只表示放弃当前 pending 任务或产物，不表示归档已提交世界历史。

以上 `PhaseResult` 是应用层恢复后的内部结果。模型实际返回的引用字段使用请求中展示的临时别名；模型不得输出 UUID、阶段运行 ID、请求 ID或数据库记录 ID。

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

AI只提出搜索表达和原因。应用层执行检索并把真实返回内容追加到同一个 `TurnContext`；请求本身不能成为事实依据。`directions`、`maxCandidates` 和 `maxDepth` 只是机械查询参数，不定义出口语义。AI读取返回局部后，必须理解该局部自身形成的组织方式，并自主决定下一步路径和停止位置。

`sourceKinds = source` 指向应用内部已经提交且不可变的原文单元投影，不等同于读取用户工作目录中的 `章节正文/*.md`。`allowWorkspaceChapterReads = false` 只禁止后者，不得屏蔽内部原文投影。模型查询精确原话、标题或其他逐字内容时必须使用非空 `exactKeys`；若同一查询包含 `graph` 或 `revision`，应用层会机械去重并补入 `source`，保证精确索引候选不会因模型混淆两类来源而被过滤。仅查询 `rule` 或 `reference` 时不会补入 `source`，普通语义查询也不会因此扩大召回范围。

source 语义候选命中后，应用层可围绕当前请求的首个高相关原文单元，按同一来源的相邻顺序返回有界连续窗口。窗口只由来源身份、序号、`maxCandidates` 和累计证据 Token 预算决定，不根据正文中的人物、对白、地点或事件类型特化。窗口内每个单元仍是独立 `read-*` 证据，模型只能引用实际返回的单元，不能把未返回的前后文当作已读事实。

`requestedReads` 与 `outcome` 必须保持单一语义：只有 `outcome = request_read` 可以携带非空读取请求；`continue` 以及其他结果必须返回空数组。后端不再执行“已经决定继续、却又附带读取”的矛盾结果，避免阶段在已有充分证据后继续扩张。

内部原文投影返回的 `relatedOwnerRefs` 是该原文单元经结算关联到的局部图摘要。它与原文证据共同计入 `retrieval.maxEvidenceTokens`，候选越多时每个原文候选获得的关联摘要份额越小；后端可裁剪关联摘要，但不能裁剪后把摘要冒充原文。这个限制只约束本轮模型可见证据体积，不限制持久图本身的节点、出口或 AI 自主演化结构。

返回的 source 证据还可以带有 `relatedOwnerRefs` 及受限图投影摘要，这是应用根据原文单元结算记录提供的通用图入口，不是人物、地点或事件专用字段。模型应优先沿这些摘要恢复该原文单元对应的局部时空、状态与演化；摘要足够时不应重复展开全部入口，也不得用另一个仅语义相似的图候选替换已关联局部。

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
  selectedWorkspacePaths: string[]
  selectionReasons: Record<string, string>
  unresolvedRuleConflicts: string[]
}
```

基础规则不可被用户规则覆盖；用户规则在明确适用范围内优先。`selectedWorkspacePaths` 只能引用本轮 `readEvidence` 已实际返回的工作区文件。平台基础规则使用独立 `baseRuleVersion` 固定，不把用户目录中的只读镜像文件伪装成动态读取证据。

`rule_assembly` 只返回规则选择控制结果，不返回规则正文、资料摘要或完整 `RuleSnapshot`。该阶段没有长文本字段；路径选择理由和冲突说明必须是短句，未选择新文件时三个 artifact 字段分别返回空数组、空对象和空数组。所有非正文阶段都使用独立的单次结构化输出护栏，防止控制 JSON 无限膨胀；正文阶段根据用户字数范围为正文和模型思考保留空间。护栏不改变整轮累计输出 Token 策略，也不是用户可见正文的字数上限。

### 5.3 source_retrieval

```ts
type RetrievalArtifact = {
  missingEvidence: string[]
  nextExpansionHints: string[]
}
```

该阶段只登记真实返回结果，不把未命中解释为不存在。

### 5.4 emergence_planning

```ts
type EmergenceDecision = {
  pressureEvidenceRefs: string[]
  action: "reuse" | "extend" | "reveal" | "create_new" | "defer" | "reject"
  existingAnchorRefs: string[]
  timeAnchorRefs: string[]
  locationAnchorRefs: string[]
  informationBoundaryRefs: string[]
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
  approvedDecisionIndexes: number[]
  revisionRequests: Array<{
    decisionIndex: number
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
  contentMarkdown: string
  adoptedDecisionIndexes: number[]
  currentTimeAnchorRefs: string[]
  currentLocationAnchorRefs: string[]
  detectedUnplannedContent: string[]
}
```

`draft` 通过普通文本响应返回包含 `contentMarkdown` 的 JSON 对象；应用层把它写入内部不可变对象存储并自行生成 `contentRef`，该字段不属于模型 artifact。模型不能自行伪造文件引用。该产物不进入用户文件树，不直接成为世界事实，也不要求用户审批。

### 5.7 chapter_naming

```ts
type ChapterNamingArtifact = {
  chapterNumberText: string
  heading: string
  filename: string
  continuityEvidenceRefs: string[]
}
```

`heading` 必须与 Markdown 第一行一致；`filename` 必须等于合法化后的同一标题加 `.md`。

### 5.8 dependency_audit

```ts
type DependencyAuditArtifact = {
  missingDependencies: UnresolvedDependency[]
  unplannedContent: Array<{
    description: string
    returnTo: "source_retrieval" | "emergence_planning" | "draft"
  }>
  sceneContinuity: Array<{
    sceneIndex: number
    sceneDescription: string
    predecessorSceneIndexes: number[]
    predecessorSceneRefs: string[]
    predecessorRequired: boolean
    predecessorReason: string
    correspondenceRequired: boolean
    correspondenceReason: string
    timeContinuity: "pass" | "revise" | "unknown"
    locationContinuity: "pass" | "revise" | "unknown"
    crossReferenceContinuity: "pass" | "revise" | "unknown"
    reason: string
  }>
  informationBoundary: "pass" | "revise" | "unknown"
}
```

`sceneContinuity` 只审计草稿实际形成的场景及其前置依赖。`sceneIndex` 必须从 `0` 开始连续且唯一；`predecessorSceneIndexes` 引用本清单中的场景，`predecessorSceneRefs` 只引用本轮已读的旧图入口。独立审查负责确认清单覆盖全部实际场景，代码只验证索引结构。`predecessorRequired` 和 `correspondenceRequired` 是 AI 对后续机械门禁的明确声明，不能根据“本轮第一个场景”或引用数组是否为空反向猜测。该阶段不能为本轮新场景发明 `local:*`；正式场景锚点和新时空结构在 `graph_governance` 中建立。无正文后台演化仍要枚举独立生效时空局部，只是不产生章节来源。多时间流、动态空间和跨参照连续性遵守 [通用时空锚点设计](spacetime-anchor-design.md)。

### 5.9 response_review

```ts
type ResponseReviewArtifact = {
  evidenceClosed: boolean
  leaksUnobservedInformation: boolean
  requiresWorkflowUpgrade: boolean
  upgradeReason?: string
}
```

只读回答需要写世界事实时，升级到图治理工作流，不能从查询接口暗写。

### 5.10 graph_governance

```ts
type SemanticGraphMutation =
  | { operation: "create_node"; ref: `local:${string}`; data: GraphData }
  | { operation: "edit_node"; nodeRef: string; next: GraphData }
  | { operation: "retire_node"; nodeRef: string; archiveOutletRefs: string[] }
  | { operation: "create_link"; ref: `local:${string}`; fromRef: string; toRef: string; content?: unknown; metadata?: Record<string, unknown> }
  | { operation: "edit_link"; linkRef: string; fromRef: string; toRef: string; content?: unknown; metadata?: Record<string, unknown> }
  | { operation: "retire_link"; linkRef: string; archiveOutletRefs: string[] }

type SceneSpacetimeBinding = {
  sceneIndex: number
  sceneAnchorRef: string
  sourceUnitIndexes: number[]
  temporalReferenceRefs: string[]
  timeAnchorRefs: string[]
  spatialReferenceRefs: string[]
  locationAnchorRefs: string[]
  predecessorSceneIndexes: number[]
  predecessorSceneAnchorRefs: string[]
  transitionPathRefs: string[]
  correspondenceRefs: string[]
  explanation: string
  selfReview: string
}

type MutationSpacetimeSettlement = {
  mutationIndexes: number[]
  effectDisposition: "world_effect" | "representation_only"
  effectiveSceneBindingIndexes: number[]
  effectiveExistingSceneAnchorRefs: string[]
  currentEntryRefs: string[]
  predecessorRevisionRequired: boolean
  predecessorRevisionReadRefs: string[]
  historicalReturnRefs: string[]
  reason: string
  selfReview: string
}

type GraphGovernanceArtifact = {
  mutations: SemanticGraphMutation[]
  retrievalProjections: Array<{
    ownerKind: "node" | "link"
    ownerMutationIndex?: number
    ownerRef?: string
    exactKeys: string[]
    semanticText: string
  }>
  settlementRecords: Array<{
    sourceUnitIndex: number
    graphRefs: Array<{
      targetKind: "node" | "link"
      targetRef: string
      mutationIndex?: number
    }>
    reason: string
    status: string
  }>
  mutationSpacetimeSettlements: MutationSpacetimeSettlement[]
  sceneSpacetimeBindings: SceneSpacetimeBinding[]
  affectedFrontierRefs: string[]
  archiveOutletRefs: string[]
  decisionRecords: Array<{
    decisionKind: string
    mutationIndexes: number[]
    mutationSpacetimeSettlementIndexes: number[]
    reason: string
    payload: unknown
    selfReview: string
  }>
}
```

新图对象必须使用 `local:*` 引用；同一 artifact 内重复引用同一对象时必须复用该引用。已有图对象只能使用本轮图证据中实际返回的 `ownerId`，不能使用 read ID、章节 evidence ID 或仅凭章节正文声称已经完成身份复用。`ownerMutationIndex`、`mutationIndex` 和 `sourceUnitIndex` 只引用当前 artifact 或当前章节中的数组位置。应用层在批准后一次性把 `local:*`、数组索引和技术记录转换为 UUID；任意 content、metadata 或时空绑定内精确匹配局部句柄的值也递归物化，持久层不得残留 `local:*`。归档通过普通 committed 节点与连接实现，不使用 `retired` 代替世界历史。

`sceneSpacetimeBindings` 声明普通图结构在本轮承担的时空角色，不创建第二套世界 schema。它必须按 `dependency_audit.sceneContinuity.sceneIndex` 恰好覆盖一次，并保持相同的 `predecessorSceneIndexes`；本轮前置通过索引解析到对应新场景锚点，旧图前置继续使用本轮已读引用。正式正文场景的 `sourceUnitIndexes` 必须非空，全部原文单元至少被一个场景覆盖；无正文后台演化必须为空。只有对应场景声明 `predecessorRequired = false` 时两类前置和过渡路径才可以同时为空；声明 `correspondenceRequired = true` 时 `correspondenceRefs` 必须非空。无法精确换算时应引用 AI建立的明确不确定性结构，而不是伪造数值。

`mutationSpacetimeSettlements` 必须恰好覆盖 `mutations` 的全部索引，并始终提供 `historicalReturnRefs`。`world_effect` 修改还必须绑定一个本轮场景或本轮已读既有场景，并提供 `currentEntryRefs`。声明 `predecessorRevisionRequired = true` 时 `predecessorRevisionReadRefs` 不能为空；这些引用只能指向本轮实际读取证据，由应用层解析成具体 revision/version，不能使用 owner 引用冒充修订引用。`representation_only` 只允许改变组织、查询、抽象或归档表达，不能改变被表达的当前世界含义。代码只检查索引、声明和引用，语义审查负责判断声明是否诚实以及历史返回路径是否充分。

`decisionRecords.mutationSpacetimeSettlementIndexes` 只引用本 artifact 中的修改时空结算。决定记录说明治理原因并引用权威连续性映射，不得在 `payload` 中再复制另一套生效时间、地点或前置修订事实。

出现规划只表达当时证据下的方向，不是图治理的数量许可证。是否复用、创建多少节点或连接、怎样组织出口、是否重构局部，都由 AI 根据后续实际读取和正式正文自主决定；偏离早期规划时由 AI 在决定记录和自审中解释。

图治理可以自主形成、修改或替换局部图的组织与查询语义，不要求固定出口定义字段。治理产物必须完整表达正文事务的演化过程和当前有效状态，并使相关当前查询、历史查询和原文追溯能够在有限预算内准确、选择性地完成。语义变化时由 AI决定如何同步重构入口、投影、历史返回路径和归档结构。

### 5.11 semantic_review

```ts
type SemanticReviewArtifact = {
  approvedMutationIndexes: number[]
  rejectedMutationIndexes: number[]
  approvedSpacetimeBindingIndexes: number[]
  rejectedSpacetimeBindingIndexes: number[]
  approvedMutationSpacetimeSettlementIndexes: number[]
  rejectedMutationSpacetimeSettlementIndexes: number[]
  approvedAffectedFrontierRefs: string[]
  rejectedAffectedFrontierRefs: string[]
  verificationProbes: Array<{
    purpose: "scene_restore" | "current_state" | "history_return" | "source_return"
    sceneBindingIndexes: number[]
    mutationSpacetimeSettlementIndexes: number[]
    query: string
    observedReadRefs: string[]
    observedGraphRefs: string[]
    verdict: "pass" | "uncertain" | "fail"
    reason: string
  }>
  sceneInventoryComplete: boolean
  revisionReason?: string
  returnTo?: "source_retrieval" | "graph_governance"
  graphStillDiscoverable: boolean
  graphStillConcise: boolean
  continuityPreserved: boolean
  spacetimeContinuityPreserved: boolean
}
```

`graphStillDiscoverable` 不能只表示理论可达。AI必须按效果判断修改后的局部是否能在受限候选、深度和上下文预算内恢复相关当前状态、历史过程和原文；如何组织和解释出口仍由 AI决定。

语义审批必须对 `graph_governance.mutations`、`sceneSpacetimeBindings`、`mutationSpacetimeSettlements` 和 `affectedFrontierRefs` 中的每个索引或引用分别恰好作出一次决定：每项只能出现在对应批准或拒绝集合之一，不能遗漏、重复或越界。存在任何拒绝项时必须返回 `graph_governance`，修订后原审批与前沿集合失效，不能部分沿用。`sceneInventoryComplete` 由 AI 复核场景清单是否覆盖草稿全部实际场景；代码不能从正文自行切场景。

`verificationProbes` 必须引用本轮实际读取证据和图 owner。每个场景绑定至少由 `scene_restore` 覆盖；正式正文场景还由 `source_return` 覆盖；每个 `world_effect` 修改时空结算至少由 `current_state` 和 `history_return` 覆盖；每个 `representation_only` 至少由 `history_return` 覆盖。失败探针必须返回治理，`uncertain` 只能用于图中已经明确保存不确定性的跨参照结果，不能替代当前入口、历史路径或原文返回失败。

### 5.12 settlement_review

```ts
type SettlementReviewArtifact = {
  settledSourceUnitIndexes: number[]
  uncoveredSourceUnitIndexes: number[]
  sourceReturnComplete: boolean
  retrievalProjectionComplete: boolean
  semanticCoverageComplete: boolean
  spacetimeBindingsComplete: boolean
  mutationSpacetimeSettlementsComplete: boolean
}
```

正式正文要求 `uncoveredSourceUnitIndexes` 为空，并且全部场景绑定能够返回相关图表达、原文单元和检索投影；所有修改时空结算还必须能够返回生效场景、前置修订和历史资料。无正文后台演化不检查原文单元，但仍检查场景清单、修改时空结算和检索投影。

### 5.13 frontier_settlement

```ts
type FrontierSpacetimeSettlement = {
  frontierAnchorRef: string
  disposition: "active" | "deferred" | "archived"
  lastSceneAnchorRefs: string[]
  lastTimeAnchorRefs: string[]
  lastLocationAnchorRefs: string[]
  correspondenceRefs: string[]
  reason: string
  revisitCondition?: string
}

type FrontierSettlementArtifact = {
  frontiers: FrontierSpacetimeSettlement[]
}
```

`semantic_review.approvedAffectedFrontierRefs` 中每个引用必须恰好出现一次，不能增加、遗漏或重复；存在任何 rejected 前沿时不能进入本阶段。活跃或推迟前沿必须具有自己的最后场景、时间与地点锚点以及非空 `revisitCondition`；归档前沿继续保留返回路径，但可以省略重访条件。`disposition` 只用于调度，所有世界时空含义仍存在于普通图中。系统处理时间只能用于调度字段，不能写入 `lastTimeAnchorRefs`。

`affectedFrontierRefs` 只表示能够独立继续、暂停或归档并可被重新发现的局部演化入口，不是 `mutations`、节点或连接的逐项清单；一个前沿可以承载多项修改。语义复核应先检查这一点，发现过度展开时退回图治理收敛集合。前沿结算的 `frontierAnchorRef` 集合必须与已批准集合完全相同；`correspondenceRefs` 只能补充前沿内部的可达结构，不能替代或偷换前沿锚点。

### 5.14 commit_review

```ts
type CommitReviewArtifact = {
  recommendation: "commit" | "revise" | "retire"
  revisionTargetPhase?: AIPhase
  finalSelfReview: string
}
```

`commit_review` 是 AI自动执行的最终建议阶段，不是人工确认按钮，也不拥有拒绝提交的权限。`recommendation`、`finalSelfReview` 和修订目标只作为连续性与一致性建议持久化并展示，不属于阶段 `outcome`，也不能触发通用 `revise/reject/retire` 停止语义。只要结构、图修订、原文结算、检索投影和时空连续性门禁完整，代码就直接提升作用域并发布章节；用户后续是否编辑正文不改变本轮已提交事实。

一句话可以是世界生成的起点，而不是资料完整性检查。正文中首次出现的新事物可以没有旧图证据。资料不存在、设定未定义或需要补全时，AI必须依据已读上下文、规则和用户输入进行最小一致推演，降低确定性、缩小范围或保留不确定性，但不能直接拒绝正文。正文出现的万事万物都必须由本轮图治理建立或复用图表达。审查应检查它是否具有本轮建立的时间和地点连续锚点，以及是否与已提交世界的演化链和当前状态矛盾；不能把“未在旧资料中找到”本身当作拒绝提交理由。只有正文把内容当作过去已经存在、正在延续或被再次指代时，才要求旧身份召回；新内容应由本轮图治理建立局部身份、原文来源和查询入口。

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

## 7. JSON 文本与校验

每次请求必须：

- 在提示词中明确要求只输出 JSON；
- `jsonModeEnabled` 默认 `false`；关闭时不发送供应商 `response_format`，避免 Thinking Mode 与 DeepSeek JSON Output 组合高频返回空 `content`；
- `thinkingModeEnabled` 与 `reasoningEffort` 由模型配置统一控制；强度只允许 `low`、`high`、`max`，关闭思考时不发送强度；
- `reasoning_content` 只作为思考观察数据，最终 `content` 为空时进入有限响应修复，不能直接当作阶段 JSON；
- 从普通文本响应中提取第一个完整 JSON 对象；
- 使用当前阶段固定的 Zod Schema；
- 拒绝 Markdown 代码块、额外前后缀和无法规范解析的 JSON；
- 保存原始响应摘要、schema 版本和校验结果；
- 结构失败最多执行 `maxSchemaRepairAttempts` 次，默认 `2`；
- 修复调用继续使用同一个 `TurnContext`，追加校验错误，不重建任务上下文；
- 请求尾部必须再次强调：请求资料是只读输入，完整性不是复述输入；每个数组项必须对应唯一语义项，单个 JSON 对象闭合后立即停止；`draft.artifact.contentMarkdown` 之外的文本字段保持简短，不重复正文或证据；
- 发给模型的 Schema 只包含业务字段，去除 `$schema` 等自描述元数据；运行时仍以同一套 Zod Schema 作为唯一校验来源，不能让模型复制校验器元数据。
- 达到上限后产生 `model_failure`，保留 pending 作用域，不猜测缺失字段。

## 8. 验收标准

- 每个阶段都有独立 Zod Schema；
- 每个阶段只能引用当前上下文允许的 ID；
- `request_read` 不会直接增加读取权限；
- `draft` 不进入用户文件树；
- `commit_review` 无人工门禁且不能跳过必要阶段；
- `retired` 不会被误用为已提交世界归档；
- 场景清单索引连续唯一并由 AI确认覆盖全部实际场景，每个索引恰好具有一条时间、地点均非空的绑定；
- AI 声明需要前置或跨参照时，相应的本轮场景索引、已读旧场景、过渡路径或对应结构满足门禁；
- 每个图修改恰好具有一条修改时空结算，世界内容变化能够返回生效场景、前置修订和历史资料；
- 多时间或空间参照之间没有对应结构时只能保留明确不确定性，不能伪造统一时间或坐标；
- 图治理声明的每个受影响前沿恰好结算一次，活跃或推迟前沿分别保存自己的最后场景、时间、地点锚点和重访条件；
- 系统处理时间不会进入世界时间引用；
- 阶段回流次数受项目预算限制；
- DeepSeek 缓存命中与否不改变阶段结果校验。
