# Worldseed V1 编码前冻结基线

## 1. 文档状态

本文是进入 V1 编码前的冻结基线，冻结前面六项实现前置决策：

1. V1 最小闭环和范围；
2. 可执行的跨进程与 AI 阶段契约；
3. SQLite 持久化和迁移边界；
4. DeepSeek 运行配置、代理和错误策略；
5. 图、推演、检索和上下文默认参数；
6. 基础规则与阶段 Prompt 资源。

本文不重新定义世界语义。世界节点、连接、信息、历史、状态和局部重构仍遵守 [底层动态图设计](system-design.md)；多时间流、动态空间和场景锚点遵守 [通用时空锚点设计](spacetime-anchor-design.md)；阶段详细产物仍遵守 [AI 阶段契约](ai-phase-contracts.md)。若实现文档与本文冲突，以本文的 V1 冻结值为准，并必须同时修订相关文档，不能在代码中隐藏另一套默认值。

## 2. V1 最小闭环

### 2.1 首个可运行里程碑

首个里程碑只要求一个本地项目完整跑通以下链路：

```text
创建/打开项目
  -> 创建并校验固定 Markdown 工作目录
  -> 用户输入本轮发展与表现要求
  -> 使用 Fake AI 执行一轮阶段契约
  -> 只读取实际返回的局部图和原文片段
  -> 生成 pending 正文、图提案和结算映射
  -> 完成依赖、时空、语义和提交复核
  -> 提升 pending scope
  -> 发布 committed 章节 Markdown
  -> 保存 TurnContext、阶段记录、检索投影和运行指标
```

Fake AI 必须先于真实 DeepSeek 接入，用于验证应用层、数据库、作用域、上下文账本和文件发布边界。Fake AI 不模拟隐藏思维，只返回符合 Zod Schema 的固定阶段结果。

### 2.2 V1 必须包含

- 项目注册表、项目内部 SQLite 和应用内部对象存储；
- 五个固定顶级 Markdown 目录及固定子目录校验；
- 单文件和递归 Markdown 文件夹导入；
- `pending`、`committed`、`retired` 作用域隔离；
- 图节点、连接、不可变修订、当前 head 和归档出口；
- 小说原文、章节版本、原文单元和图结算映射；
- 精确键、FTS5 和双向邻接检索；
- 单轮 `TurnContext`、选择性读取、上下文压缩和 KV 用量记录；
- DeepSeek 普通文本 JSON 契约适配器；
- 阶段状态、任务恢复、错误和进度事件；
- committed 章节发布以及发布失败后的可恢复操作。

### 2.3 V1 不作为首个里程碑的门槛

- 全量世界后台持续演化的性能优化；
- `sqlite-vec` 向量召回的默认启用；
- 完整桌面 UI 的所有视觉细节；
- 跨数据库、对象存储和用户文件系统的全局原子提交；
- 远程服务、多用户协作和微服务拆分。

上述能力仍保留在架构中，但不能阻塞 Fake AI 最小闭环。V1 不做全局原子提交，只保存明确的提交阶段、失败位置、pending scope 和恢复操作。

## 3. 可执行契约冻结

### 3.1 版本和标识

```ts
const protocolVersion = "worldseed.v1"
const schemaVersion = 1

type Id = string
type ProjectId = Id
type TaskId = Id
type TurnId = Id
type ScopeId = Id
type RevisionId = Id
type SourceId = Id
```

所有跨进程 DTO、AI 阶段输入输出、事件、错误和数据库 JSON 载荷都带版本。外部 DTO 不直接复用数据库行类型，数据库载荷统一保存 `schema_version`。

### 3.2 IPC 公共契约

```ts
type ClientRequest = {
  protocolVersion: "worldseed.v1"
  requestId: Id
  method: BackendMethod
  payload: unknown
}

type ClientResponse =
  | { protocolVersion: "worldseed.v1"; requestId: Id; ok: true; data: unknown }
  | { protocolVersion: "worldseed.v1"; requestId: Id; ok: false; error: BackendError }

type TaskHandle = {
  taskId: TaskId
  projectId: ProjectId
  kind: "turn" | "query" | "evolution" | "revision" | "workspace"
  status: "created" | "running" | "waiting_for_read" | "waiting_for_model"
    | "waiting_for_review" | "committing" | "needs_revision" | "paused"
    | "completed" | "retired" | "failed" | "cancelled"
}
```

V1 的 `BackendMethod` 固定为：

```text
project.create / project.open / project.validate
workspace.list / workspace.read / workspace.save
workspace.importFiles / workspace.importFolder
workspace.archive / workspace.restore
turn.start / turn.resume / turn.recoverable.list / turn.pause / turn.cancel / turn.status
world.query / world.evolve
chapter.list / chapter.read / chapter.startRevision / chapter.submitRevision / chapter.retireRevision
graph.search / graph.neighborhood / graph.revisions
operation.get / operation.listActive / events.subscribe
```

图写入不暴露给 Renderer。只有推演执行器在阶段契约通过后调用应用层图治理端口。

### 3.3 事件和错误

```ts
type BackendEvent =
  | { type: "task.phase.changed"; taskId: TaskId; phase: AIPhase; status: string }
  | { type: "task.budget.updated"; taskId: TaskId; usage: BudgetUsage }
  | { type: "task.cache.updated"; taskId: TaskId; usage: KVCacheUsage }
  | { type: "operation.progress"; operation: WorkspaceOperation }
  | { type: "chapter.visibility.changed"; chapterId: Id; visibility: Visibility }
  | { type: "graph.scope.changed"; scopeId: ScopeId; visibility: Visibility }
  | { type: "retrieval.completed"; taskId: TaskId; candidateCount: number }
  | { type: "task.failed"; taskId: TaskId; error: BackendError }

type BackendErrorCode =
  | "validation_error" | "scope_violation" | "budget_exhausted"
  | "stale_base" | "index_unavailable" | "model_failure"
  | "workspace_failure" | "storage_failure" | "protocol_mismatch"
```

事件只用于实时展示；UI 重连后必须通过查询接口恢复状态。错误必须包含稳定错误码、用户可见摘要、可恢复标记和内部诊断 ID，不能把 SQLite、Electron 或 DeepSeek 私有错误类型直接穿透到 Renderer。

### 3.4 AI 阶段契约

V1 固定使用 [AI 阶段契约](ai-phase-contracts.md) 定义的 14 个阶段和回流表。每次调用必须携带：

```ts
type PhaseRequestEnvelope = {
  schemaVersion: 1
  envelopeId: Id
  projectId: ProjectId
  taskId: TaskId
  turnId: TurnId
  contextId: Id
  scopeId: ScopeId
  phase: AIPhase
  protocolVersion: string
  promptRef: string
  promptDigest: string
  contextViewRef: string
  committedReadIds: Id[]
  visiblePendingIds: Id[]
  remainingBudget: ModelCallBudget
  input: unknown
}
```

阶段结果必须通过对应 Zod Schema；`request_read` 不增加事实权限，只有检索真实返回后才能追加到 `TurnContext`。修复 JSON 结构最多两次，超过后任务进入 `model_failure` 并保留 pending 状态。

模型引用只允许本次请求映射出的 `read-*`、`node-*`、`link-*` 和当前 artifact声明的 `local:*`。实现不得提供 `owner-*`、`id-*`等兜底别名，也不得把出现规划中的数量或动作解释为图治理的代码级上限；图的创建、复用、编辑、重构和归档方案由 AI自审阶段决定。

Zod Schema 的唯一来源为 `packages/contracts` 和 `packages/prompt-contracts`，禁止在 Renderer、应用用例或 DeepSeek 适配器中重复声明。

## 4. SQLite Schema 与迁移冻结

### 4.1 通用约定

- `registry.sqlite` 只保存项目注册信息；每个项目的 `project.sqlite` 保存该项目全部世界、任务、上下文和索引元数据；
- 所有 ID 使用 `TEXT`，时间使用 UTC Unix milliseconds 的 `INTEGER`；
- 布尔值使用 `INTEGER NOT NULL CHECK (value IN (0, 1))`；
- JSON 使用 `TEXT`，写入前按固定字段顺序规范序列化；
- 可跨版本恢复的领域 JSON 载荷保存 `schema_version` 和 `digest`，纯进度与错误载荷跟随所在事件/操作记录版本；
- 除 `schema_migrations` 外的可审计项目记录包含 `project_id`；pending 数据额外包含 `scope_id`；
- 删除只产生归档/修订记录，不物理删除已提交节点、连接、正文和来源；
- SQLite 开启 WAL、外键和 busy timeout。

### 4.2 核心表

`registry.sqlite` 固定包含：

| 表 | 必需字段 | 关键约束/索引 |
| --- | --- | --- |
| `registered_projects` | `project_id`, `workspace_root_ref`, `internal_store_ref`, `last_opened_at`, `created_at` | `project_id` 主键，`workspace_root_ref` 唯一 |
| `schema_migrations` | `version`, `name`, `digest`, `applied_at` | `version` 主键 |

每个 `project.sqlite` 固定包含：

| 表 | 必需字段 | 关键约束/索引 |
| --- | --- | --- |
| `projects` | `id`, `name`, `manifest_version`, `committed_sequence`, `created_at`, `updated_at` | `id` 主键 |
| `project_manifests` | `project_id`, `schema_version`, `fixed_entries_json`, `digest`, `updated_at` | `project_id` 主键 |
| `workspace_operations` | `id`, `project_id`, `kind`, `path_json`, `status`, `progress_json`, `error_json`, `created_at`, `updated_at` | `(project_id, status)` |
| `artifact_scopes` | `id`, `project_id`, `task_id`, `turn_id`, `visibility`, `base_committed_sequence`, `reason`, `created_at`, `retired_at` | `(project_id, visibility)`, `(task_id, id)` |
| `tasks` | `id`, `project_id`, `kind`, `status`, `scope_id`, `config_snapshot_json`, `prompt_snapshot_json`, `last_phase`, `error_json`, `created_at`, `updated_at` | `(project_id, status)`, `scope_id` 唯一 |
| `turn_contexts` | `id`, `project_id`, `task_id`, `turn_id`, `schema_version`, `ledger_digest`, `token_usage_json`, `kv_usage_json`, `created_at`, `updated_at` | `(task_id, turn_id)` 唯一 |
| `context_segments` | `id`, `project_id`, `context_id`, `sequence_no`, `kind`, `owner_ids_json`, `content_ref`, `digest`, `token_estimate`, `created_at` | `(context_id, sequence_no)` 唯一 |
| `phase_runs` | `id`, `project_id`, `task_id`, `context_id`, `phase`, `attempt`, `status`, `request_json`, `result_json`, `usage_json`, `started_at`, `finished_at` | `(task_id, phase, attempt)` 唯一 |
| `ai_decision_records` | `id`, `project_id`, `task_id`, `scope_id`, `phase_run_id`, `decision_kind`, `reason`, `evidence_ids_json`, `payload_json`, `digest`, `created_at` | `(scope_id, decision_kind)` |
| `rule_snapshots` | `id`, `project_id`, `task_id`, `base_rule_version`, `source_versions_json`, `selection_reasons_json`, `digest`, `created_at` | `(project_id, digest)` 唯一 |
| `nodes` | `id`, `project_id`, `scope_id`, `visibility`, `content_json`, `metadata_json`, `source_refs_json`, `revision_id`, `created_at` | `(project_id, id, revision_id)` 唯一，`(project_id, scope_id, visibility)` |
| `links` | `id`, `project_id`, `scope_id`, `visibility`, `from_node_id`, `to_node_id`, `content_json`, `metadata_json`, `source_refs_json`, `revision_id`, `created_at` | `(project_id, id, revision_id)` 唯一，双向邻接分别索引 `from_node_id`、`to_node_id` |
| `node_heads` | `project_id`, `scope_key`, `source_scope_id`, `node_id`, `revision_id`, `visibility`, `effective_at`, `digest` | `(project_id, scope_key, node_id)` 唯一 |
| `link_heads` | `project_id`, `scope_key`, `source_scope_id`, `link_id`, `revision_id`, `visibility`, `effective_at`, `digest` | `(project_id, scope_key, link_id)` 唯一 |
| `graph_revisions` | `id`, `project_id`, `scope_id`, `target_kind`, `target_id`, `operation`, `before_json`, `after_json`, `reason`, `evidence_ids_json`, `created_at` | `(project_id, target_kind, target_id, created_at)` |
| `document_versions` | `id`, `project_id`, `scope_id`, `source_id`, `chapter_id`, `visibility`, `content_ref`, `heading`, `publish_path`, `digest`, `predecessor_source_id`, `created_at` | `(project_id, source_id)` 唯一，`(project_id, chapter_id, visibility)` |
| `source_units` | `id`, `project_id`, `source_id`, `sequence_no`, `content_ref`, `digest`, `settlement_status`, `created_at` | `(source_id, sequence_no)` 唯一 |
| `settlement_records` | `id`, `project_id`, `scope_id`, `source_unit_id`, `graph_refs_json`, `reason`, `status`, `digest`, `created_at` | `(scope_id, source_unit_id)` |
| `scene_spacetime_bindings` | `id`, `project_id`, `scope_id`, `source_id`, `scene_index`, `scene_anchor_id`, `source_unit_indexes_json`, `temporal_reference_refs_json`, `time_anchor_refs_json`, `spatial_reference_refs_json`, `location_anchor_refs_json`, `predecessor_scene_indexes_json`, `predecessor_scene_refs_json`, `transition_path_refs_json`, `correspondence_refs_json`, `reason`, `self_review`, `visibility`, `digest`, `created_at` | `(scope_id, scene_index)` 唯一，`(scope_id, scene_anchor_id)`，`(project_id, visibility)` |
| `graph_revision_spacetime` | `id`, `project_id`, `scope_id`, `graph_revision_id`, `effect_disposition`, `effective_scene_binding_ids_json`, `effective_existing_scene_refs_json`, `current_entry_refs_json`, `predecessor_revision_required`, `predecessor_revision_ids_json`, `historical_return_refs_json`, `reason`, `self_review`, `visibility`, `digest`, `created_at` | `(scope_id, graph_revision_id)` 唯一，`(project_id, visibility)` |
| `retrieval_projections` | `id`, `project_id`, `scope_id`, `owner_kind`, `owner_id`, `owner_revision_id`, `visibility`, `exact_keys_json`, `semantic_text`, `source_refs_json`, `digest` | `(project_id, scope_id, owner_kind, owner_id, owner_revision_id, visibility)` 唯一 |
| `retrieval_exact_keys` | `project_id`, `projection_id`, `exact_key`, `owner_id` | `(project_id, exact_key)` |
| `retrieval_fts` | `projection_id`, `project_id`, `scope_id`, `visibility`, `semantic_text` | SQLite FTS5，按项目、scope 和可见性过滤 |
| `frontier_refs` | `id`, `project_id`, `scope_id`, `frontier_anchor_ref`, `disposition`, `last_scene_anchor_refs_json`, `last_time_anchor_refs_json`, `last_location_anchor_refs_json`, `correspondence_refs_json`, `last_processed_at`, `reason`, `revisit_condition` | `(project_id, disposition, last_processed_at)` |
| `kv_usage` | `id`, `project_id`, `task_id`, `turn_id`, `phase_run_id`, `total_input_tokens`, `cache_hit_input_tokens`, `cache_miss_input_tokens`, `output_tokens`, `latency_ms`, `provider`, `model`, `created_at` | `(task_id, phase_run_id)` 唯一 |
| `operation_events` | `id`, `project_id`, `task_id`, `sequence_no`, `event_type`, `payload_json`, `created_at` | `(task_id, sequence_no)` 唯一 |

`scene_spacetime_bindings.source_id` 仅对无正文后台演化允许为空；此时任务和作用域来源仍必填。`frontier_refs.revisit_condition` 仅对 `archived` 允许为空，`active` 与 `deferred` 必须非空。

`scope_key` 是非空机械键：committed 当前 head 固定为 `committed`，pending head 使用具体 `scope_id`。提升作用域时更新 committed head 指针并保留原 `graph_revisions`；更新或删除物化 head 指针不等于删除世界历史。

### 4.3 迁移顺序

Migration 按以下顺序执行且每个版本只追加一次：

```text
registry r001 registered_projects / schema_migrations

project 001 schema_migrations / projects / project_manifests / workspace_operations
002 artifact_scopes / tasks / operation_events
003 turn_contexts / context_segments / phase_runs / kv_usage
004 nodes / links / node_heads / link_heads / graph_revisions
005 document_versions / source_units / settlement_records
006 retrieval_projections / retrieval_exact_keys / retrieval_fts
007 rule_snapshots / ai_decision_records / frontier_refs
008-012 上下文快照、图修订审计、检索、证据和项目设置
013 scene_spacetime_bindings / graph_revision_spacetime / frontier spacetime protocol
```

迁移记录进入 SQLite `schema_migrations`。启动时若数据库版本高于当前程序，拒绝打开；若低于当前程序，只执行已登记的向前迁移，不自动重建或覆盖用户数据。向量表属于后续迁移，V1 首个闭环不依赖它。

## 5. DeepSeek 运行配置冻结

### 5.1 配置来源

生产环境优先使用 Electron `safeStorage` 保存 API Key 和代理认证信息；开发环境允许使用环境变量，但不能写入项目文件、SQLite、日志或 Renderer：

```text
DEEPSEEK_API_KEY                 # 仅开发环境回退读取
WORLDSEED_DEEPSEEK_BASE_URL      # 默认 https://api.deepseek.com
WORLDSEED_DEEPSEEK_MODEL         # 默认 deepseek-chat
WORLDSEED_DEEPSEEK_PROXY_URL     # 可选 HTTP/HTTPS 代理
WORLDSEED_DEEPSEEK_TIMEOUT_MS    # 默认 7200000，与默认整轮墙钟窗口一致
WORLDSEED_DEEPSEEK_JSON_MODE_ENABLED      # 默认 false
WORLDSEED_DEEPSEEK_THINKING_MODE_ENABLED  # 默认 true
WORLDSEED_DEEPSEEK_REASONING_EFFORT       # low | high | max，默认 high
```

代理密码不进入普通配置 JSON；通过 `safeStorage` 保存的 secret reference 读取。没有代理配置时使用系统网络。代理、模型和超时快照进入任务，不允许任务中途静默变化。

生产环境由 Electron Main 的凭据适配器读取并解密 `safeStorage`，再通过 Backend 启动握手把 API Key 和代理认证注入 Backend Utility Process 的内存型 `CredentialProviderPort`。Renderer、项目数据库、任务快照和普通日志永远不能获得明文密钥；任务快照只记录不含认证信息的代理地址、模型、超时和凭据引用摘要。开发环境由同一个端口适配环境变量，应用层和 DeepSeek 调度器不直接读取 `process.env`。

### 5.2 模型调用

```ts
type DeepSeekRuntimeConfig = {
  provider: "deepseek"
  baseUrl: string
  model: "deepseek-chat" | "deepseek-reasoner"
  apiKeyRef: string
  proxyUrl?: string
  timeoutMs: number
  maxAttempts: number
  maxSchemaRepairAttempts: number
  jsonModeEnabled: boolean
  thinkingModeEnabled: boolean
  reasoningEffort: "low" | "high" | "max"
}

const defaultDeepSeekRuntimeConfig = {
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  timeoutMs: 7200000,
  maxAttempts: 2,
  maxSchemaRepairAttempts: 2,
  jsonModeEnabled: false,
  thinkingModeEnabled: true,
  reasoningEffort: "high",
}
```

调用使用 OpenAI 兼容 `chat/completions` 接口。`thinkingModeEnabled` 决定是否发送 DeepSeek `thinking.enabled/disabled`；开启时同时发送 `reasoning_effort`，强度只能是 `low`、`high` 或 `max`。`jsonModeEnabled` 默认 `false`；关闭时不发送 `response_format`，开启时附加 `response_format: { type: "json_object" }`。三项设置均随模型配置持久化并在每轮开始时冻结。模型按末尾契约返回 Worldseed JSON 文本，适配器提取第一个完整 JSON 对象并执行 Schema 校验。V1 不使用 Tool Calling；模型需要读取或修改时返回 Worldseed JSON，应用层执行读取或暂存提案，再将实际结果追加到同一 `TurnContext`。发送给模型的请求移除不需要的后端技术字段，并使用本次请求专属的临时引用别名；返回结果先校验别名契约，再恢复真实技术 ID。模型不生成 UUID，适配器不执行阶段专用字段移动或身份猜测。

可选代理只在 DeepSeek 基础设施适配器内通过注入的 HTTP dispatcher 生效，不修改进程级全局代理，也不影响 SQLite、文件系统或其他网络适配器。

DeepSeek 返回的 `usage.prompt_cache_hit_tokens` 映射为 `cacheHitInputTokens`，`usage.prompt_cache_miss_tokens` 映射为 `cacheMissInputTokens`。供应商没有返回其中任一缓存明细时，本轮 `hitRate` 为 `undefined`，UI 显示“不可用”，不能推测为 `0%`。

### 5.3 错误和重试

- 网络超时、连接失败和 HTTP `5xx` 最多按同一 `envelopeId` 重试一次；
- HTTP `4xx`、认证失败和 JSON 结构错误不做供应商盲目重试；
- JSON 结构错误由阶段契约执行最多两次修复调用；
- 每次重试累计到同一任务的调用、token 和耗时预算；
- 达到任一预算后任务进入 `budget_exhausted`，保留 pending scope；
- DeepSeek 适配器只转换错误和用量，不决定世界语义或阶段流转。

## 6. V1 默认参数冻结

参数分为应用配置、项目配置和任务快照。任务启动后只读使用任务快照。

### 6.1 图和检索

```ts
const defaultGraphCapacityProfile = {
  maxDirectOutDegree: 12,
  maxDirectInDegree: 12,
  mergeWarningThreshold: 10,
  preferredExpansionDepth: 2,
  maxExpansionDepth: 4,
  maxVisitedNodes: 96,
  maxVisitedLinks: 192,
  maxNodeContentTokens: 512,
  contextTokenBudget: 12000,
  recallTopKPerExpression: 20,
  maxRecallCandidates: 80,
  maxRecallRounds: 3,
  maxSearchExpressionsPerRound: 6,
  targetMechanicalRecallP95Ms: 500,
  targetContextAssemblyP95Ms: 3000,
}
```

出度和入度统一默认 `12`；达到 `10` 时进入合并预警，不由代码自动合并，AI根据已有出口和本轮依据决定抽象、复用、迁移或继续保留。显示布局默认“分层避碰”，只影响图投影，不修改事实图。

### 6.2 主推演、出现和后台演化

V1 沿用以下已经写入底层设计的默认值：

```ts
const defaultTurnExecutionProfile = {
  maxTurnModelCalls: 400,
  maxTurnWallTimeMs: 7200000,
  maxDraftAuditRounds: 3,
  maxGraphGovernanceRounds: 3,
  maxSettlementReviewRounds: 2,
  maxForegroundAutonomyCandidates: 6,
  foregroundAutonomyContextTokenBudget: 6000,
}

const defaultWorldEmergenceProfile = {
  worldNovelty: 0.5,
  maxEmergenceCandidatesPerTurn: 12,
  maxCurrentDraftEmergencesPerTurn: 3,
  maxBackgroundEmergencesPerTurn: 4,
  maxNewGraphAnchorsPerDecision: 6,
  emergenceContextTokenBudget: 6000,
  maxEmergenceReviewRounds: 2,
  maxRetrospectiveSupportAnchors: 4,
  maxEmergenceNarrativeShare: 0.2,
}

const defaultWorldEvolutionProfile = {
  enabled: true,
  worldAutonomy: 0.6,
  maxFrontierCandidates: 24,
  maxActiveFrontiersPerTurn: 4,
  maxConsecutiveFrontierDeferrals: 6,
  maxBackgroundStepsPerFrontier: 3,
  backgroundContextTokenBudget: 8000,
  maxBackgroundModelCalls: 8,
  maxBackgroundWallTimeMs: 15000,
  maxBackgroundTotalTokens: 24000,
  lazyCatchUpTokenBudget: 12000,
  maxJointFrontiersPerTurn: 2,
  maxJointParticipants: 8,
  maxCrossImpactRounds: 2,
}
```

完整字段和 `worldAutonomy` 缩放公式仍以 [底层动态图设计](system-design.md) 为准。V1 不要求 AI 使用满任何上限；超出预算时优先保留历史依赖、时空连续、当前状态、正文结算和图治理，延后可选自治候选。

### 6.3 缓存和上下文

- 每轮只有一个 `TurnContext`；
- 稳定前缀只包含基础规则、协议、项目机械参数、`RuleSnapshot` 和 JSON Schema；
- 用户输入、实际召回、阶段结果、token 和缓存统计位于动态后缀；
- `hitRate = cacheHitInputTokens / totalInputTokens`；
- 缓存命中不改变事实权限、读取集合、图写权限或提交结果；
- 上下文压缩只替换默认可见文字，不能删除原始资料、来源 ID 或返回路径。

## 7. 基础规则与 Prompt 资源冻结

### 7.1 资源布局

平台资源只读且随协议版本发布：

```text
packages/prompt-contracts/
├── src/
│   ├── phase-schemas/
│   ├── prompt-registry.ts
│   └── prompt-types.ts
└── resources/
    └── v1/
        ├── base-rules.md
        └── phases/
            ├── interpret.md
            ├── rule-assembly.md
            ├── source-retrieval.md
            ├── emergence-planning.md
            ├── emergence-review.md
            ├── draft.md
            ├── chapter-naming.md
            ├── dependency-audit.md
            ├── response-review.md
            ├── graph-governance.md
            ├── semantic-review.md
            ├── settlement-review.md
            ├── frontier-settlement.md
            └── commit-review.md
```

项目创建时，`base-rules.md` 以只读 Markdown 投影到用户工作目录的 `世界推演规则/基础规则/`，供用户查看。运行时真正的权威来源是版本化应用资源；用户目录中的基础规则文件不能反向修改平台资源。

### 7.2 基础规则内容

`base-rules.md` 必须包含且只描述底层通用原则：

- 万事万物都可以是节点，连接可以携带任意信息；
- 优先复用已有节点和局部结构，不以新名称代替身份判断；
- 正文出现的内容必须获得持久表达并完成图结算；
- 每轮只能使用实际读取的旧资料和本轮新产物；
- 正式场景必须形成场景时空绑定，能够返回局部时间、地点、实际前置场景和过渡路径；
- AI先形成连续唯一的场景索引，再由图治理逐项绑定；本轮第一个场景不自动免除前置连续性；
- 每个图修改都必须具有唯一的修改时空结算，改变当前世界内容时连接完整生效场景、前置修订和历史返回路径；
- 不假设唯一全局世界时间或绝对空间；跨参照比较必须读取 AI建立的对应或不确定性结构；
- 每个活跃或推迟前沿分别保存自己的最后场景、时间和地点锚点，系统时间不冒充世界时间；
- 当前有效状态不能无依据回退；
- 用户输入是提案、意图或表现要求，不自动成为过去真相；
- AI拥有图治理权限，但每次修改必须给出依据、原因和自审；
- 归档保留历史和返回路径，不物理删除已提交事实；
- 直接连接达到上限时递归抽象，不能丢弃细节；
- 上下文压缩不能删除持久资料和召回路径；
- 预算不足时保留未知，不编造确定事实；
- 用户规则只在明确适用范围内优先，不能修改基础规则。

### 7.3 Prompt 组装和版本

每个阶段请求按固定顺序组装：

```text
base-rules.md
-> phase prompt
-> protocol and schema digest
-> project parameter snapshot
-> RuleSnapshot
-> user input and presentation rules
-> actual committed reads
-> same-turn produced artifacts
```

每个资源保存 `promptRef`、`promptVersion`、`digest` 和规范化文本。阶段执行记录必须保存实际使用的资源摘要。用户规则、设定集和参考资料不能修改基础 Prompt，也不能绕过实际读取集合。

## 8. 编码守门

本文冻结后即可开始编码。编码过程中必须满足以下守门条件：

1. `packages/contracts` 和 `packages/prompt-contracts` 按本文路径创建；
2. Migration `001` 至 `007` 的字段、索引和 JSON 版本不能由业务代码临时决定；
3. DeepSeek 配置只从安全存储/开发环境读取，代理和缓存 token 映射必须有测试；
4. Fake AI 必须先按本文契约跑通一轮，并在失败时保留 pending；
5. 后续新增能力必须通过版本化 ADR 或修订本文，不得悄悄改变 V1 默认值。

本文完成后，编码顺序遵守 [项目代码架构](project-code-architecture.md) 第 13 节和 [后端架构](backend-architecture.md) 第 24 节。
