# World History Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变现有 AI 阶段顺序、scope 提交语义和章节发布结果的前提下，实现推演历史、自动与手动保存、返回上一轮、世界线分叉、历史恢复和保留上限。

**Architecture:** 历史能力作为独立应用模块接在完整轮提交之后，不进入 `TurnOrchestrator` 的 AI 阶段循环。SQLite 保存历史元数据、活动世界投影和可恢复 finalization；隔离的 `isomorphic-git` 保存不可变 manifest 与 Markdown 快照；现有图、文档、检索和上下文对象继续保存在 SQLite 与内部对象库。恢复时通过 active-scope 投影切换当前世界，不把 `branchId` 传入现有所有业务接口。

**Tech Stack:** TypeScript、Node.js、Kysely、SQLite、isomorphic-git、Electron IPC、Vitest、现有内容寻址对象库。

---

## 1. 当前代码结论

### 1.1 可以直接复用

- `artifact_scopes` 已隔离 `pending`、`committed`、`retired`；
- 图节点、连接、图修订和文档版本已经不可变；
- `node_heads`、`link_heads` 已能表达当前图头；
- `turn_contexts`、`phase_runs`、`rule_snapshots`、Evidence 已持久化；
- scope 提交由 `SqliteScopeCommitRepository` 在 SQLite 事务中完成；
- 用户 Markdown 工作目录与内部存储已经物理隔离；
- `NodeInternalStoreAdapter` 已提供项目内部目录约束；
- `ProjectSettings.history.retentionLimit` 已进入现有项目设置数据库。

### 1.2 不能直接复用

- `projects.committed_sequence` 只表达一条线性当前世界；
- 所有普通查询把全项目 `visibility = committed` 当作当前事实，会跨世界线串读；
- `document_versions` 没有当前章节版本 head；
- `GraphRepository.listRevisions` 会返回其他未来世界线的修订；
- workspace catalog 只保存路径、摘要和大小，不保存 Markdown 内容；
- `BackendFacade.tasks` 是内存任务表，进程重启后没有完整任务恢复；
- 当前没有 `turn_checkpoints`、执行游标或可重入阶段执行器；
- `turn.resume`、`turn.pause`、`turn.cancel` 虽在方法枚举中，但 Facade 尚未实现；
- `TurnOrchestrator` 每轮创建新 `TurnContext`，没有跨轮 context lineage head；
- 后端尚未依赖 `isomorphic-git`。

### 1.3 关键风险结论

1. 不能只增加 Git 提交，否则恢复后检索仍会读到未来事实；
2. 不能把 Git 写入 scope 提交事务，否则 Git 或文件系统失败会让已完成正文回滚或整轮报错；
3. 不能现在宣称“模型请求中手动保存可恢复”，因为现有阶段结果不足以恢复 `TurnOrchestrator` 的内存状态；
4. 不能通过修改所有查询接口增加 `branchId`，这会扩大对当前流程的影响；
5. 不能提交 `project.sqlite` 到 Git；
6. 恢复期间必须阻止新推演写入，避免工作区、图投影和章节版本混合。

---

## 2. 最小干扰总体方案

### 2.1 保持现有正式推演主链

以下顺序保持不变：

```text
AI 阶段循环
  -> stage 文档、图、检索与结算
  -> SqliteScopeCommitRepository.commit(scopeId)
  -> WorkspacePort.publishChapter(...)
  -> tasks.status = completed
  -> TurnExecutionResult
```

历史自动保存从 `TurnExecutionResult` 之后开始：

```text
TurnExecutionResult
  -> HistoryService.enqueueAutomaticSave(...)
  -> SQLite 写 history_finalization 意图
  -> 后台生成 manifest 与 Git commit
  -> history_entry = ready
  -> 执行 retention settlement
```

自动保存失败只让历史 finalization 进入 `failed` 或 `paused`，不能把已经完成的正文任务改回失败。

### 2.2 使用 active-scope 作为当前世界过滤层

新增 `active_scope_refs(project_id, scope_id)`：

- scope 提交成功时追加当前 scope；
- 历史 manifest 保存当时全部 active scope ID；
- 恢复时原子替换当前项目的 active scope 集合；
- 文档、检索、图修订历史和以后新增的时空/演化查询只读取 active scope；
- pending 查询继续读取 `active scopes + 当前 pending scope`；
- `artifact_scopes.visibility = committed` 只表示该 scope 曾完整提交，不再表示它当前属于哪条世界线。

图的当前节点和连接仍复用 `node_heads/link_heads` 中 `scope_key = committed` 的投影。历史 manifest 额外保存精确的 node/link head revision；恢复事务替换这些 head，不修改不可变图修订。

### 2.3 当前章节增加独立 head

新增 `active_document_heads(project_id, chapter_id, document_version_id, scope_id)`：

- 新章节提交时插入；
- 同一章节修订提交时按 `chapter_id` 更新；
- `listCommittedChapters` 改为 join active heads；
- history manifest 保存 head 集合；
- 恢复时原子替换。

这避免旧章节修订与当前章节修订同时出现在目录中。

### 2.4 context lineage 只加旁路关系

新增 `context_lineage(context_id, parent_context_id)` 和 `project_history_state.continuation_context_id`：

- 新轮开始时读取当前 continuation context ID 并记录 parent；
- 不把整条旧上下文重新灌入当前模型；
- 自动保存完成后把当前 `contextId` 设为 continuation head；
- 历史 manifest 保存该 head；
- 恢复时切换 head。

该改动只建立可恢复链，不改变现有提示词装配和 KV 前缀逻辑。

### 2.5 恢复使用可恢复 finalization

恢复分为：

1. 校验历史 entry、Git manifest 和所有 SQLite 对象；
2. 在内部 checkout 目录生成目标 Markdown；
3. 备份当前用户 Markdown；
4. 写入恢复 finalization 的 `prepared` 状态；
5. 发布目标 Markdown；
6. 在单个 SQLite 事务中替换 active scope、文档 heads、图 heads、continuation head、active branch 和 committed sequence；
7. finalization 标记 `completed`；
8. 删除临时备份。

进程在第 5、6 步间退出时，项目下次打开先恢复或回滚 finalization，完成前不允许开始推演。

---

## 3. 新增数据库结构

Migration `014_world_history_foundation`：

```sql
ALTER TABLE projects ADD COLUMN active_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE artifact_scopes ADD COLUMN base_generation INTEGER NOT NULL DEFAULT 0;

CREATE TABLE active_scope_refs (
  project_id TEXT NOT NULL REFERENCES projects(id),
  scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
  PRIMARY KEY (project_id, scope_id)
);

CREATE TABLE active_document_heads (
  project_id TEXT NOT NULL REFERENCES projects(id),
  chapter_id TEXT NOT NULL,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id),
  scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
  PRIMARY KEY (project_id, chapter_id)
);

CREATE TABLE context_lineage (
  context_id TEXT PRIMARY KEY REFERENCES turn_contexts(id),
  parent_context_id TEXT REFERENCES turn_contexts(id)
);

CREATE TABLE world_branches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_branch_id TEXT REFERENCES world_branches(id),
  fork_entry_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  world_head_entry_id TEXT,
  history_head_entry_id TEXT,
  continuation_context_id TEXT REFERENCES turn_contexts(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE history_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  branch_id TEXT NOT NULL REFERENCES world_branches(id),
  parent_entry_id TEXT REFERENCES history_entries(id),
  kind TEXT NOT NULL CHECK (kind IN ('automatic', 'manual')),
  state TEXT NOT NULL CHECK (state IN ('complete_world', 'paused_checkpoint')),
  status TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'failed')),
  name TEXT NOT NULL,
  note TEXT,
  git_commit_oid TEXT,
  manifest_digest TEXT,
  committed_sequence INTEGER NOT NULL,
  context_head_id TEXT,
  checkpoint_id TEXT,
  task_id TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE project_history_state (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  active_branch_id TEXT NOT NULL REFERENCES world_branches(id),
  selected_entry_id TEXT REFERENCES history_entries(id),
  continuation_context_id TEXT REFERENCES turn_contexts(id),
  working_checkpoint_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE history_finalizations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  entry_id TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('save', 'restore', 'retention')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed')),
  step TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE history_retention_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  entry_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  deleted_at INTEGER NOT NULL
);
```

Migration 完成后：

- 把已有 `visibility = committed` scope 写入 `active_scope_refs`；
- 把每个 chapter 最新 `document_versions` 写入 `active_document_heads`；
- 新项目创建默认“主世界线”和 `project_history_state`；
- 旧开发项目首次打开时以当前 active projection 创建一次“现有世界基线”，不迁移旧版自定义历史格式。

---

## 4. History Manifest

`HistoryManifest` 使用 canonical JSON，至少包含：

```ts
type HistoryManifest = Readonly<{
  schemaVersion: 1
  projectId: string
  entryId: string
  branchId: string
  parentEntryId?: string
  createdAtMs: number
  committedSequence: number
  activeGeneration: number
  activeScopeIds: readonly string[]
  nodeHeads: readonly { nodeId: string; revisionId: string; visibility: string }[]
  linkHeads: readonly { linkId: string; revisionId: string; visibility: string }[]
  documentHeads: readonly { chapterId: string; documentVersionId: string }[]
  continuationContextId?: string
  taskCheckpointId?: string
  workspace: readonly {
    relativePath: string
    digest: string
    size: number
    gitPath: string
  }[]
  baseRulesDigest: string
  digest: string
}>
```

约束：

- `世界推演规则/基础规则` 只记录摘要和版本，不从历史覆盖；
- Git tree 保存所有其他用户可见 Markdown 的实际内容；
- API Key、模型凭据、系统 Git 配置和 `project.sqlite` 不进入 manifest；
- project execution settings 不随世界线恢复，尤其历史保留上限不能被旧保存点反向修改；
- 数组按稳定 ID 或路径排序后计算摘要。

---

## 5. 文件结构

### 5.1 新建

```text
packages/contracts/src/history.ts
apps/backend/src/application/history/
  history-service.ts
  history-checkout-service.ts
  history-retention-service.ts
  history-manifest-builder.ts
  history-errors.ts
  index.ts
  ports/
    history-repository.ts
    history-vcs-port.ts
    workspace-snapshot-port.ts
    history-finalization-repository.ts
    index.ts
apps/backend/src/infrastructure/history-git/
  isomorphic-git-history-adapter.ts
  index.ts
apps/backend/src/infrastructure/filesystem/
  node-workspace-snapshot-adapter.ts
apps/backend/src/infrastructure/sqlite/repositories/
  sqlite-history-repository.ts
  sqlite-history-finalization-repository.ts
  sqlite-active-projection-repository.ts
apps/backend/test/
  history-git-adapter.test.ts
  history-service.test.ts
  history-checkout.test.ts
  history-retention.test.ts
```

### 5.2 修改

```text
packages/contracts/src/backend-methods.ts
packages/contracts/src/backend-payloads.ts
packages/contracts/src/errors.ts
packages/contracts/src/index.ts
apps/backend/package.json
apps/backend/src/application/index.ts
apps/backend/src/application/workspace/ports/workspace-port.ts
apps/backend/src/bootstrap/backend-facade.ts
apps/backend/src/bootstrap/project-runtime.ts
apps/backend/src/infrastructure/index.ts
apps/backend/src/infrastructure/filesystem/index.ts
apps/backend/src/infrastructure/filesystem/node-internal-store-adapter.ts
apps/backend/src/infrastructure/sqlite/database-types.ts
apps/backend/src/infrastructure/sqlite/migrations/project-migrations.ts
apps/backend/src/infrastructure/sqlite/repositories/index.ts
apps/backend/src/infrastructure/sqlite/repositories/sqlite-scope-commit-repository.ts
apps/backend/src/infrastructure/sqlite/repositories/sqlite-task-scope-repository.ts
apps/backend/src/infrastructure/sqlite/repositories/sqlite-document-repository.ts
apps/backend/src/infrastructure/sqlite/repositories/sqlite-graph-repository.ts
apps/backend/src/infrastructure/sqlite/repositories/sqlite-retrieval-repository.ts
apps/backend/test/sqlite-migrations.test.ts
apps/backend/test/sqlite-repositories.test.ts
apps/backend/test/turn-orchestrator.test.ts
apps/backend/test/filesystem-project-lifecycle.test.ts
apps/backend/test/architecture.test.ts
```

---

## 6. 分阶段实施任务

### Task 1: 冻结历史契约与错误类型

**Files:**
- Create: `packages/contracts/src/history.ts`
- Modify: `packages/contracts/src/backend-methods.ts`
- Modify: `packages/contracts/src/backend-payloads.ts`
- Modify: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/contracts.test.ts`

- [ ] 定义 `HistoryEntrySummary`、`HistoryBranchSummary`、`HistoryManifest`、`HistoryRetentionPreview` 和状态枚举。
- [ ] 增加方法：`history.list`、`history.branches`、`history.saveManual`、`history.returnPreviousRound`、`history.continueFrom`、`history.restore`、`history.retention.preview`。
- [ ] 所有改变状态的方法要求 `operationId`，保证前端重复点击幂等。
- [ ] 增加类型化错误码：`history_busy`、`history_corrupt`、`history_not_found`、`checkpoint_unavailable`。
- [ ] 运行 `pnpm vitest run packages/contracts/test/contracts.test.ts`，确认非法上限、非法 entry ID 和缺失 operation ID 被拒绝。

### Task 2: 增加内部 Git 目录和依赖隔离

**Files:**
- Modify: `apps/backend/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/backend/src/application/workspace/ports/workspace-port.ts`
- Modify: `apps/backend/src/infrastructure/filesystem/node-internal-store-adapter.ts`
- Test: `apps/backend/test/filesystem-project-lifecycle.test.ts`

- [ ] 添加 `isomorphic-git` 依赖，不调用系统 Git CLI。
- [ ] 为 `InternalProjectStore` 增加 `historyGitRef`、`historyCheckoutRef` 和 `historyRecoveryRef`。
- [ ] `prepareProject` 创建这些目录；`inspectProject` 校验真实路径都位于项目内部目录。
- [ ] 测试用户工作目录内不存在 `.git`，系统环境没有设置 `GIT_DIR/GIT_WORK_TREE`，源码仓库状态不变。

### Task 3: 增加历史与活动投影 Migration

**Files:**
- Modify: `apps/backend/src/infrastructure/sqlite/database-types.ts`
- Modify: `apps/backend/src/infrastructure/sqlite/migrations/project-migrations.ts`
- Test: `apps/backend/test/sqlite-migrations.test.ts`

- [ ] 创建第 14 个 Migration 和第 3 节全部表、索引与 generation 字段。
- [ ] 从现有 committed scope 初始化 `active_scope_refs`。
- [ ] 从现有章节初始化 `active_document_heads`。
- [ ] 测试 Migration 版本、外键、唯一约束和重新打开数据库。
- [ ] 测试 `active_scope_refs` 不接受其他项目的 scope。

### Task 4: 保持 scope 提交流程并写 active projection

**Files:**
- Modify: `apps/backend/src/infrastructure/sqlite/repositories/sqlite-task-scope-repository.ts`
- Modify: `apps/backend/src/infrastructure/sqlite/repositories/sqlite-scope-commit-repository.ts`
- Modify: `apps/backend/src/application/turns/ports/task-scope-repository.ts`
- Test: `apps/backend/test/sqlite-repositories.test.ts`
- Test: `apps/backend/test/turn-orchestrator.test.ts`

- [ ] scope 创建时冻结 `base_generation`。
- [ ] commit 同时检查 `committed_sequence` 和 `active_generation`。
- [ ] commit 事务末尾把 scope 加入 `active_scope_refs`。
- [ ] commit 把本 scope 的文档版本 upsert 到 `active_document_heads`。
- [ ] 不改变原有 node/link head promotion、可见性更新和 sequence 增量顺序。
- [ ] 运行原有 orchestrator 测试，模型调用次数、章节发布、图提交和失败 pending 隔离必须保持原结果。

### Task 5: 让现有查询只读取当前世界投影

**Files:**
- Modify: `apps/backend/src/infrastructure/sqlite/repositories/sqlite-document-repository.ts`
- Modify: `apps/backend/src/infrastructure/sqlite/repositories/sqlite-retrieval-repository.ts`
- Modify: `apps/backend/src/infrastructure/sqlite/repositories/sqlite-graph-repository.ts`
- Test: `apps/backend/test/sqlite-repositories.test.ts`

- [ ] `listCommittedChapters` join `active_document_heads`。
- [ ] committed retrieval exact、短文本和 FTS 查询限定 `scope_id IN active_scope_refs`。
- [ ] pending retrieval 保持 `active scopes OR current pending scope`。
- [ ] `listRevisions` 只返回 active scopes 的图历史。
- [ ] graph 当前节点和连接继续读取 `scope_key = committed`，不修改调用方签名。
- [ ] 新增双世界线 fixture，证明非 active scope 的章节、检索结果和图修订不可见。

### Task 6: 实现隔离的 isomorphic-git 适配器

**Files:**
- Create: `apps/backend/src/application/history/ports/history-vcs-port.ts`
- Create: `apps/backend/src/infrastructure/history-git/isomorphic-git-history-adapter.ts`
- Create: `apps/backend/src/infrastructure/history-git/index.ts`
- Modify: `apps/backend/src/infrastructure/index.ts`
- Test: `apps/backend/test/history-git-adapter.test.ts`

- [ ] 使用 `writeBlob`、`writeTree`、`writeCommit`、`writeRef` 等 plumbing API 创建 bare 内部历史，不使用用户工作树。
- [ ] 固定应用 author，不读取 Git config、credential helper、hooks 或 remotes。
- [ ] 同一 manifest 和父提交生成稳定、可验证的 tree；commit OID 保存到 SQLite。
- [ ] 读取 commit 时校验 `manifest.json` 摘要和所有 Markdown blob 摘要。
- [ ] 测试外部 Git 仓库、系统 config 和用户 `.git` 在操作前后不变。

### Task 7: 实现 workspace 与数据库 manifest 构建

**Files:**
- Create: `apps/backend/src/application/history/history-manifest-builder.ts`
- Create: `apps/backend/src/application/history/ports/workspace-snapshot-port.ts`
- Create: `apps/backend/src/infrastructure/filesystem/node-workspace-snapshot-adapter.ts`
- Modify: `apps/backend/src/infrastructure/filesystem/index.ts`
- Test: `apps/backend/test/history-service.test.ts`

- [ ] 从 `WorkspacePort.validate` 的 inventory 读取全部允许的 Markdown 内容。
- [ ] 基础规则只记录摘要，不写入可恢复 blob。
- [ ] 从 SQLite 读取 active scopes、node/link heads、document heads、continuation context 和 committed sequence。
- [ ] 使用 canonical serialization 计算 manifest digest。
- [ ] manifest 构建在固定 SQLite 读视图中完成；若提交 sequence 在构建期间变化，放弃本次尝试并重新排队，不生成混合快照。

### Task 8: 实现自动保存和历史列表

**Files:**
- Create: `apps/backend/src/application/history/history-service.ts`
- Create: `apps/backend/src/application/history/ports/history-repository.ts`
- Create: `apps/backend/src/application/history/ports/history-finalization-repository.ts`
- Create: `apps/backend/src/infrastructure/sqlite/repositories/sqlite-history-repository.ts`
- Create: `apps/backend/src/infrastructure/sqlite/repositories/sqlite-history-finalization-repository.ts`
- Modify: `apps/backend/src/bootstrap/project-runtime.ts`
- Modify: `apps/backend/src/bootstrap/backend-facade.ts`
- Test: `apps/backend/test/history-service.test.ts`
- Test: `apps/backend/test/turn-orchestrator.test.ts`

- [ ] `ProjectRuntime` 暴露 `enqueueAutomaticHistory(result)` 和只读 history 查询。
- [ ] `BackendFacade` 只在 orchestrator 成功回调中排队自动保存；不修改 `TurnOrchestrator`。
- [ ] 先写 SQLite finalization，再写 Git，最后把 history entry 标记 ready。
- [ ] 自动保存失败时 turn.status 仍为 completed，history entry 显示失败并可重试。
- [ ] 项目打开时扫描未完成 save finalization 并幂等恢复。
- [ ] 测试原有完整轮输出和自动保存分别成功、Git 故障不影响正文完成、重试不产生重复 entry。

### Task 9: 建立 context lineage

**Files:**
- Modify: `apps/backend/src/bootstrap/backend-facade.ts`
- Modify: `apps/backend/src/application/turns/turn-orchestrator.ts`
- Modify: `apps/backend/src/application/turns/ports/turn-persistence.ts`
- Modify: `apps/backend/src/infrastructure/sqlite/repositories/sqlite-turn-persistence.ts`
- Test: `apps/backend/test/turn-orchestrator.test.ts`

- [ ] `turn.start` 从 `project_history_state` 读取 continuation context ID。
- [ ] 新 context 创建后写一条旁路 `context_lineage` 记录。
- [ ] 不把父 context 全文追加到本轮模型请求。
- [ ] 自动保存完成后更新 branch 和 project continuation head。
- [ ] 测试连续三轮形成稳定父链，返回旧 entry 后新轮从旧 context head 分叉。

### Task 10: 实现完整世界恢复与返回上一轮

**Files:**
- Create: `apps/backend/src/application/history/history-checkout-service.ts`
- Create: `apps/backend/src/infrastructure/sqlite/repositories/sqlite-active-projection-repository.ts`
- Modify: `apps/backend/src/bootstrap/project-runtime.ts`
- Modify: `apps/backend/src/bootstrap/backend-facade.ts`
- Test: `apps/backend/test/history-checkout.test.ts`

- [ ] 恢复前查询项目是否存在 running、waiting、committing 或未决 finalization；存在时返回 `history_busy`。
- [ ] 从 Git 校验并展开目标 Markdown 到内部 checkout 目录。
- [ ] 备份当前 Markdown，并校验目标基础规则摘要与当前平台版本兼容。
- [ ] 发布目标 Markdown 后，在一个 SQLite 事务中替换 active scopes、document heads、node/link heads、continuation context、branch、selected entry 和 committed sequence。
- [ ] 每次 checkout 增加 `active_generation`；旧 generation 创建的 pending scope 不能提交。
- [ ] `returnPreviousRound` 只选择前一个 automatic entry，不创建世界线。
- [ ] 从非 head entry 第一次写入时，先创建新世界线再允许 `turn.start` 或 `workspace.save`。
- [ ] 故障注入测试覆盖文件发布前、发布后、SQLite 切换前和切换后进程退出。

### Task 11: 实现世界线与延迟分叉

**Files:**
- Modify: `apps/backend/src/application/history/history-service.ts`
- Modify: `apps/backend/src/application/history/history-checkout-service.ts`
- Modify: `apps/backend/src/bootstrap/backend-facade.ts`
- Test: `apps/backend/test/history-checkout.test.ts`

- [ ] `continueFrom` 显式创建分支并切换；普通“恢复到这里”只移动活动历史状态。
- [ ] `turn.start`、`workspace.save` 和未来章节修订调用统一的 `ensureWritableBranch()`。
- [ ] 如果 selected entry 不是当前 branch head，`ensureWritableBranch()` 在首次写入前创建新 branch。
- [ ] 原 branch 和后续 entry 不修改、不删除。
- [ ] 测试两个分支对同一节点产生不同修订后，图、检索、章节和 context 均不串读。

### Task 12: 实现历史保留上限与 Git 保留边界

**Files:**
- Create: `apps/backend/src/application/history/history-retention-service.ts`
- Modify: `apps/backend/src/application/history/history-service.ts`
- Modify: `apps/backend/src/infrastructure/history-git/isomorphic-git-history-adapter.ts`
- Modify: `apps/backend/src/bootstrap/backend-facade.ts`
- Test: `apps/backend/test/history-retention.test.ts`

- [ ] 每次 history entry ready 后读取 `ProjectSettings.history.retentionLimit`。
- [ ] `null` 不执行删除；有限值按 `createdAt, entryId` 删除全项目最旧 entry。
- [ ] 降低设置前通过 `history.retention.preview` 返回数量、时间范围、空世界线和游标迁移目标。
- [ ] 删除父链前把最早保留 entry 重建为无已删除祖先的新基线，再原子移动 refs。
- [ ] 删除 SQLite entry 后记录 `history_retention_events`，对不可达对象执行延迟 GC。
- [ ] 任务检查点不计数；增大上限不恢复已删除 entry。
- [ ] 测试上限 `3`、跨分支淘汰、当前选中最旧 entry、空世界线和进程中断恢复。

### Task 13: 实现空闲状态手动保存

**Files:**
- Modify: `apps/backend/src/application/history/history-service.ts`
- Modify: `apps/backend/src/bootstrap/backend-facade.ts`
- Test: `apps/backend/test/history-service.test.ts`

- [ ] 无活动任务时，`history.saveManual` 复用自动保存 manifest 管线并接受名称、备注。
- [ ] 手动保存不移动 `world_head_entry_id`，只移动 `history_head_entry_id`。
- [ ] 手动保存失败不影响当前世界；重复 operation ID 返回同一 entry。

### Task 14: 单独实现稳定任务检查点，再开放请求中手动保存

**Files:**
- Create: `apps/backend/src/core/execution/turn-checkpoint.ts`
- Create: `apps/backend/src/application/turns/turn-resume-service.ts`
- Create: `apps/backend/src/infrastructure/sqlite/repositories/sqlite-turn-checkpoint-repository.ts`
- Modify: `apps/backend/src/application/turns/turn-orchestrator.ts`
- Modify: `apps/backend/src/bootstrap/backend-facade.ts`
- Modify: `apps/backend/src/infrastructure/sqlite/database-types.ts`
- Add: Migration `015_turn_checkpoints`
- Test: `apps/backend/test/turn-checkpoint.test.ts`
- Test: `apps/backend/test/turn-orchestrator.test.ts`

- [ ] checkpoint 保存 next phase、phase artifacts 引用、context ID、read evidence、retrieval gaps、usage、budget window、scope、source IDs 和 generation。
- [ ] 每个阶段成功后先持久化 checkpoint，再进入下一阶段。
- [ ] 把当前 `for` 循环拆为读取 `TurnExecutionState` 的可重入步骤，但保持阶段顺序和 prompt 不变。
- [ ] 实现 `turn.pause`、`turn.resume`、`turn.cancel`，并移除只依赖内存 `tasks` map 的恢复假设。
- [ ] 模型请求期间手动保存只引用请求前最近 checkpoint，不取消当前请求。
- [ ] 恢复该保存点后任务强制 `paused`，不自动模型调用、不自动重置额度。
- [ ] 无 checkpoint 时返回 `checkpoint_unavailable`，不能伪造可恢复保存点。

### Task 15: Electron 接入真实历史 API

**Files:**
- Modify: `apps/desktop/src/renderer/src/api/client.ts`
- Modify: `apps/desktop/src/renderer/src/features/status/HistoryPanel.tsx`
- Modify: `apps/desktop/src/renderer/src/app/App.tsx`
- Test: `apps/desktop/test/renderer-ui.test.ts`

- [ ] 删除 HistoryPanel 内部原型数组，改为后端 list/branches/status 数据。
- [ ] 保存、返回上一轮、比较、从这里继续和设置预览都调用真实 IPC。
- [ ] finalization 进行中显示进度；恢复后刷新 workspace、章节、图和任务状态。
- [ ] 请求中保存明确显示引用的稳定 checkpoint 和“恢复后暂停”。

---

## 7. 回归门禁

每批实现都必须通过：

```powershell
pnpm --filter @worldseed/contracts typecheck
pnpm --filter @worldseed/backend typecheck
pnpm --filter @worldseed/desktop typecheck
pnpm vitest run apps/backend/test/turn-orchestrator.test.ts
pnpm vitest run apps/backend/test/sqlite-repositories.test.ts
pnpm vitest run apps/backend/test/sqlite-migrations.test.ts
pnpm vitest run apps/backend/test/filesystem-project-lifecycle.test.ts
pnpm vitest run apps/desktop/test/renderer-ui.test.ts
```

每完成一个可运行批次再执行：

```powershell
pnpm build
pnpm test
```

当前全仓 `pnpm lint` 存在既有错误。实施时要求所有新增和修改的历史模块通过定向 ESLint；不得顺带修复无关 lint，最终单独列出既有阻塞。

### 必须保持的现有行为

- AI phase 名称、顺序和模型调用协议不变；
- `commit_review` 仍只有建议权；
- scope commit 成功后正文和图即为已提交事实；
- Git 自动保存失败不能把 turn 改成 failed；
- pending scope 普通查询不可见；
- 章节发布失败仍按现有错误路径报告，不能生成完整轮自动保存；
- graph.neighborhood 的分批加载语义不变；
- 项目设置和模型凭据不进入历史 Git；
- 用户工作目录不出现 `.git`、SQLite 或内部索引。

---

## 8. 推荐实施批次

### 批次 A：只增加历史基础和自动保存

Task 1–8。完成后可真实展示自动保存历史列表，但不开放恢复和分叉。

风险最低，因为 `TurnOrchestrator` 不修改，历史失败不影响正文完成。

### 批次 B：增加当前世界投影和完整轮恢复

Task 9–11。完成后开放返回上一轮、恢复完整自动保存和世界线分叉。

这是第一次改变普通查询可见范围，必须完成跨世界线隔离测试后再接 UI。

### 批次 C：增加保留上限和空闲手动保存

Task 12–13。完成后历史上限、Git 祖先裁剪、GC 和空闲手动保存可用。

### 批次 D：实现稳定检查点和请求中手动保存

Task 14–15。该批次会重构 turn 执行状态机，必须最后进行，且单独做真实模型长流程回归。

---

## 9. 自审结论

- 需求覆盖：自动保存、手动保存、请求中保存、恢复后暂停、返回上一轮、历史列表、世界线、分叉、完整世界恢复、Git 隔离、保留上限和不可恢复删除均有对应任务；
- 当前流程保护：批次 A 不修改 orchestrator；批次 B 只在 repository 可见性层增加 active projection；高风险 checkpoint 重构推迟到批次 D；
- 数据一致性：Git 不保存 SQLite 文件；manifest 保存精确 head 与 scope；恢复使用 finalization 和 generation 防止混合状态；
- 通用性：没有新增人物、势力、地点、事件等领域表；历史只保存通用 scope、修订、文档、上下文和 Markdown；
- 已知限制：在 Task 14 完成前，后端不能诚实支持模型请求中的可恢复手动保存，因此 UI 必须保持该操作为原型或禁用。

本计划不包含 Git commit 步骤；除非用户明确要求，否则实施过程中不创建源码提交。
