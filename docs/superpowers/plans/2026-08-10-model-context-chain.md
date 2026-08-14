# Worldseed 追加式模型上下文链实施计划

> **历史实施计划快照：** 本文用于记录实施顺序和当时状态，不是当前完成证明。当前功能状态只以 [设计与实施状态](../../implementation-status.md) 为准。

## 1. 实施目标

本计划把 `docs/context-and-kv-cache.md` 已冻结的设计落实到现有代码，但不改变世界图的通用语义、AI 自主治理原则、现有阶段顺序和正文提交门禁。

本次改造的核心结果是：

- 一个活动世界线只有一条跨阶段、跨轮次延续的模型可见消息链；
- `TurnContext` 继续作为本轮事实权限和预算账本，不再承担模型 Prompt 重组；
- 阶段只向链尾追加 Evidence、阶段指令、输出契约和校验成功的正式输出；
- 已有对象在活动链、数据库和历史快照中使用同一个项目级永久 ID；
- 请求发送前按模型配置的上下文容量执行确定性机械压缩；
- 草稿不进入长期正文保留区，正文、图、原文单元和结算全部提交后才追加唯一正式章节消息；
- 阶段失败停留在本阶段，失败输出仅保存到尝试记录；
- 当前任务检查点、模型切换和后续历史快照都能恢复同一条活动链。

## 2. 当前代码结论

### 2.1 可以直接复用

- `TurnContext`、读取账本和 `context_segments`：继续负责本轮可用事实、Evidence 可见性和预算记录。
- `phase_runs`：继续保存每次模型尝试、结果、reasoning、用量和错误。
- `source_units`、FTS、精确键和 source 邻域查询：已经具备精确原文返回基础，不重做检索引擎。
- pending/committed scope、图修订、结算记录和章节发布：继续作为正式提交门禁。
- `turn.pause`、`turn.resume`、`turn.recoverable.list`：继续作为任务检查点入口，在其上补充模型链恢复。
- DeepSeek JSON 提取、Zod 校验、reasoning 展示和有限 Schema 修复：保留行为，但调整职责位置和消息来源。

### 2.2 必须重构

- `DeepSeekAiModelAdapter.execute()` 当前每阶段重建四条消息，必须改为接收已经组装完成的模型消息。
- `createModelReferenceView()` 当前每次创建别名注册表，必须改为直接筛选模型可见的项目级永久 ID。
- `AIModelPort.execute()` 当前只接收 `PhaseRequestEnvelope`，必须拆分业务请求和供应商可见请求。
- `TurnOrchestrator.executePhase()` 当前每轮循环重建完整 `TurnPhaseInput`，必须改为调用独立的链服务追加增量消息。
- `TurnOrchestrator.resume()` 当前从最后一条 `phase_runs.request_json` 反推运行状态，必须优先恢复持久化的活动链和稳定检查点。
- `contextWindowTokens` 当前同时存在于项目设置和模型运行配置，必须统一由模型 Profile 提供容量，项目只保留压缩比例。
- `HistoryPanel` 当前全部是前端模拟数据，不能被误认为已实现真实历史切换。

### 2.3 本批不改

- 不修改图节点、连接和出口的通用语义 Schema。
- 不改变现有阶段列表、AI 自主出现规则和世界演化协议。
- 不引入 AI 摘要、压缩提案、压缩检查点或章节移出清单。
- 不把 reasoning 加入后续模型上下文。
- 不把内部 Git、世界线和历史 finalization 塞入 `TurnOrchestrator`；历史能力继续作为提交后的独立应用模块。

## 3. 建议模块边界

新增的上下文能力放入独立应用服务，避免继续扩大 `TurnOrchestrator`：

```text
TurnOrchestrator
  -> ModelContextCoordinator
       -> ContextChainStorePort
       -> ContextAppender
       -> ProjectIdAllocatorPort
       -> ContextWindowManager
       -> ModelInputTokenCounter
  -> AIModelPort
       -> DeepSeekAiModelAdapter
```

职责如下：

- `ModelContextCoordinator`：协调链加载、增量追加、请求组装、压缩、成功输出提交和失败尝试记录。
- `ContextChainStorePort`：保存和读取当前活动链，不解释消息语义。
- `ContextAppender`：按固定模板追加轮次、Evidence、阶段和正式输出消息。
- `ProjectIdAllocatorPort`：定义按前缀原子分配项目级永久 ID，并物化当前治理事务 `local:*` 的接口。
- `ContextWindowManager`：只执行确定性的两阶段可见消息筛选。
- `ModelInputTokenCounter`：对最终请求消息计算 Token；无精确 tokenizer 时提供有标记的保守估算。
- `AIModelPort`：只调用供应商，不读取文件、不重建 Prompt、不分配永久 ID。

## 4. 修改范围总览

### 4.1 Contracts 与配置

修改：

- `packages/contracts/src/context.ts`
- `packages/contracts/src/backend-payloads.ts`
- `packages/contracts/src/project-settings.ts`
- `packages/contracts/test/contracts.test.ts`
- `packages/config/src/deepseek.ts`
- `packages/config/src/profiles.ts`
- `packages/config/test/config.test.ts`
- `packages/config/test/deepseek.test.ts`

新增：

- `packages/contracts/src/model-context.ts`

内容：定义 `ModelContextChain`、消息、轮次归属、正式章节标记、压缩策略、项目级永久 ID、前缀计数器、Token 计算结果和模型 Profile 的 `contextWindowTokens`。从项目设置移除重复容量，只保留 `contextCompactionThresholdRatio` 与目标比例，默认分别为 `0.97` 和 `0.50`。

### 4.2 应用层上下文服务

新增：

- `apps/backend/src/application/context/model-context-coordinator.ts`
- `apps/backend/src/application/context/context-appender.ts`
- `apps/backend/src/application/context/context-window-manager.ts`
- `apps/backend/src/application/context/ports/project-id-allocator-port.ts`
- `apps/backend/src/application/context/ports/context-chain-store-port.ts`
- `apps/backend/src/application/context/ports/model-input-token-counter.ts`
- `apps/backend/src/infrastructure/sqlite/repositories/sqlite-project-id-allocator.ts`
- `apps/backend/test/model-context-coordinator.test.ts`
- `apps/backend/test/context-appender.test.ts`
- `apps/backend/test/context-window-manager.test.ts`
- `apps/backend/test/project-id-allocator.test.ts`

修改：

- `apps/backend/src/application/index.ts`
- `apps/backend/src/application/turns/ports/ai-model-port.ts`

内容：实现与供应商无关的消息链增量、永久 ID 可见性、当前治理事务的局部引用物化、失败临时尾部和机械压缩。应用服务接收现有业务对象，序列化后才形成供应商消息；核心层不依赖 DeepSeek。

### 4.3 SQLite 持久化

修改：

- `apps/backend/src/infrastructure/sqlite/database-types.ts`
- `apps/backend/src/infrastructure/sqlite/migrations/project-migrations.ts`
- `apps/backend/src/infrastructure/sqlite/repositories/sqlite-turn-persistence.ts`
- `apps/backend/src/bootstrap/project-runtime.ts`
- `apps/backend/test/sqlite-turn-persistence.test.ts`

建议新增表：

- `model_context_chains`：每条世界线当前活动链头、模型 Profile、规则版本、压缩代次和当前 Token 统计。
- `model_context_messages`：有序消息正文、角色、消息种类、轮次、阶段、可移出属性、正式章节引用和摘要。
- `id_counters`：按项目和前缀保存独立的单调计数值；不属于历史快照，不随世界线恢复回退。

限制：SQLite 只保存一份当前活动链。`context_segments` 继续保存事实账本引用，不能复制一份完整模型消息正文。历史保存时通过 `ContextChainStorePort.exportSnapshot()` 把该时刻的完整逻辑链和已经出现的永久 ID 写入不可变历史快照；`id_counters` 不随快照回退。

### 4.4 Turn 编排接入

修改：

- `apps/backend/src/application/turns/turn-orchestrator.ts`
- `apps/backend/src/application/turns/ports/turn-persistence.ts`
- `apps/backend/src/bootstrap/container.ts`
- `apps/backend/src/bootstrap/backend-facade.ts`
- `apps/backend/test/turn-orchestrator.test.ts`
- `apps/backend/test/backend-facade.test.ts`

重构原则：

- `TurnOrchestrator` 只决定阶段、读取和提交，不直接构造完整模型消息。
- 首次创建项目链时追加一次锁定系统规则；新一轮复用活动链。
- 每轮开始完整追加目录、用户规则、两个强制 readme、用户输入和表现约束。
- 每阶段只追加新增 Evidence、阶段指令和 Schema。
- 合法 `request_read`/`revise` 作为正式输出追加后执行业务回流。
- Schema 失败只创建失败尝试；未达到修复上限时由协调器使用正式链加临时修复尾部重试。
- 达到上限或其他不可继续错误时保留当前稳定链并暂停。
- resume 读取持久化链和检查点，不从最后一次完整请求 JSON 重建 Prompt。

为控制风险，先保留 `PhaseRequestEnvelope` 作为内部业务协议和阶段审计载荷，但不再直接作为模型消息全文。待所有测试迁移后，再评估是否缩减其持久化字段。

### 4.5 DeepSeek 适配器

修改：

- `apps/backend/src/infrastructure/models/deepseek/deepseek-model-adapter.ts`
- `apps/backend/src/infrastructure/models/deepseek/model-reference-view.ts`
- `apps/backend/src/infrastructure/models/deepseek/model-phase-result-assembler.ts`
- `apps/backend/src/infrastructure/models/fake-ai-model-adapter.ts`
- `apps/backend/src/infrastructure/models/unavailable-ai-model-adapter.ts`
- `apps/backend/test/deepseek-model-adapter.test.ts`

内容：

- `execute()` 接收最终有序消息与当前阶段结果契约。
- 删除适配器内 `loadBaseRules()`、`loadPhase()` 和四消息 Prompt 重建。
- 删除 `previousPromptByTask`；真实链连续性由协调器和持久化保证。
- `model-reference-view.ts` 只负责裁剪不应发送的运行字段并保留模型可见的永久 ID，不再建立请求级别名表或恢复 UUID。
- 保留 DeepSeek thinking、JSON Mode、网络重试、响应提取、reasoning 保存和 usage 解析。
- Schema 修复循环改为返回结构化失败信息给协调器，或由协调器注入临时修复尾部后再次调用；适配器不得把失败尾部写入正式链。

### 4.6 正式章节提交

修改：

- `apps/backend/src/application/turns/turn-orchestrator.ts`
- `apps/backend/src/application/context/context-appender.ts`
- `apps/backend/test/turn-orchestrator.test.ts`

内容：把唯一正式章节消息的追加点放到以下操作全部成功之后：

1. 不可变正文写入成功；
2. document version staged；
3. source units 和 settlement 完整；
4. 图修订与检索投影完整；
5. scope commit 成功；
6. 章节 Markdown 发布成功。

当前 `chapter_naming` 后可继续建立 pending source unit 供本轮治理，但这批内容必须标记为当前轮 pending，不能成为未来压缩时保留的“正式正文”。提交失败时不追加 canonical chapter message。

### 4.7 历史快照集成

复用并修订：

- `docs/superpowers/plans/2026-08-07-world-history-backend.md`
- `docs/world-history-versioning.md`

新增或修改：

- `packages/contracts/src/history.ts`
- `packages/contracts/src/backend-methods.ts`
- `packages/contracts/src/backend-payloads.ts`
- `apps/backend/src/application/history/history-service.ts`
- `apps/backend/src/application/history/history-manifest-builder.ts`
- `apps/backend/src/application/history/history-checkout-service.ts`
- `apps/backend/src/application/history/ports/history-vcs-port.ts`
- `apps/backend/src/infrastructure/history-git/isomorphic-git-history-adapter.ts`
- `apps/backend/src/infrastructure/sqlite/repositories/sqlite-history-repository.ts`
- `apps/backend/src/bootstrap/backend-facade.ts`
- `apps/backend/package.json`
- `apps/backend/test/history-service.test.ts`
- `apps/backend/test/history-checkout.test.ts`
- `apps/backend/test/history-git-adapter.test.ts`

内容：

- 手动和自动保存点必须包含保存时唯一活动 `ModelContextChain` 的完整逻辑快照，而不是 context lineage、压缩摘要或压缩检查点。
- 恢复保存点时，用快照替换当前活动链；同一项目运行时仍只有一份活动链。
- 包含任务检查点的保存点恢复后统一为 `paused`，不能自动调用模型。
- 模型请求中手动保存仍选择最近稳定任务检查点及其对应活动链状态。
- 内部 Git 只保存不可变历史快照和清单，不保存运行中的 SQLite 文件，不在用户工作目录创建 `.git`。
- 历史保存、恢复、分叉和 retention 仍按照独立 finalization 执行，不改变正文任务已经完成的结果。

现有 `2026-08-07-world-history-backend.md` 中的 `context_lineage` 旁路方案建立在“每轮独立上下文”前提上，实施前必须替换为 `ModelContextChain` 快照和活动链指针，不能与本计划并行保留两套上下文模型。

### 4.8 模型配置和 UI

修改：

- `apps/backend/src/infrastructure/sqlite/database-types.ts`
- `apps/backend/src/infrastructure/sqlite/migrations/registry-migrations.ts`
- `apps/backend/src/infrastructure/sqlite/repositories/sqlite-model-profile-store.ts`
- `apps/desktop/src/renderer/src/features/settings/ModelConfigurationDialog.tsx`
- `apps/desktop/src/renderer/src/features/settings/ProjectSettingsDialog.tsx`
- `apps/desktop/src/renderer/src/features/status/TaskCheckpointPrototype.tsx`
- `apps/desktop/src/renderer/src/features/status/HistoryPanel.tsx`
- `apps/desktop/src/renderer/src/api/client.ts`
- `apps/desktop/src/renderer/src/app/App.tsx`
- `apps/desktop/test/renderer-ui.test.ts`

内容：

- 每个模型 Profile 增加最大上下文，默认 `1_000_000`。
- 项目设置不再编辑第二份上下文容量，只编辑压缩触发比例和目标比例。
- 任务监控显示“当前活动链 Token / 当前模型上下文”和压缩代次。
- 删除 `HistoryPanel` 的本地模拟保存、恢复和分叉状态，接入真实 `history.list/saveManual/restore/continueFrom/returnPreviousRound` 后端 API。
- 历史切换成功后重新加载工作区、章节、图、任务检查点和活动上下文状态，不重启 Electron。

## 5. 分批实施任务

### Task 1：冻结上下文链与 ID 契约

1. 在 `packages/contracts/src/model-context.ts` 添加最小上下文链、永久 ID 和计数器 Schema。
2. 给模型 Profile 增加 `contextWindowTokens`。
3. 从项目设置移除重复的上下文窗口字段，增加 `contextCompressionTargetRatio`。
4. 固定 `node`、`link`、`evidence`、`source`、`revision` 等代码可用前缀。
5. 更新默认配置与契约测试。
6. 运行：`pnpm --filter @worldseed/contracts test && pnpm --filter @worldseed/config test`。

验收：序列化后能无损恢复消息顺序、轮次、阶段、可移出属性、正式章节身份和永久 ID；每个前缀拥有独立计数器，模型容量只有一个配置来源。

### Task 2：实现纯应用层上下文服务

1. 先写 `ContextAppender`、`ProjectIdAllocatorPort` 契约和 `ContextWindowManager` 失败测试。
2. 实现固定追加顺序、禁止修改旧消息、永久 ID 可见性和两阶段压缩。
3. 实现 `ModelContextCoordinator` 的正式尾部、临时修复尾部和 `local:*` 物化入口。
4. 增加 Token 计数端口及测试假实现。
5. 运行：`pnpm vitest run apps/backend/test/context-appender.test.ts apps/backend/test/project-id-allocator.test.ts apps/backend/test/context-window-manager.test.ts apps/backend/test/model-context-coordinator.test.ts`。

验收：第二次请求严格等于第一次请求消息加尾部；压缩前旧消息字节不变；永久 ID 在跨阶段、跨轮次和历史快照中保持不变；失败输出不进入正式链。

### Task 3：增加 SQLite 活动链存储

1. 新增项目数据库迁移和 Kysely row 类型。
2. 实现 `SqliteContextChainStore`，不要继续把职责塞入 `SqliteTurnPersistence`。
3. 提供 append、replace-after-compaction、load-active、export-snapshot 和按前缀原子分配 ID。
4. 用数据库事务保证消息序号与链头同步。
5. 运行 SQLite 端口测试和迁移测试。

验收：进程重启后可以恢复完全相同的消息序列和永久 ID；普通追加不覆盖旧消息；压缩只替换活动可见链；历史恢复不会回退计数器。

### Task 4：接入编排器和 DeepSeek

1. 修改 `AIModelPort`，传入最终消息而不是让适配器重建 Prompt。
2. 让 `TurnOrchestrator` 通过协调器创建/加载链、追加轮次和阶段内容。
3. 迁移 DeepSeek 与 fake adapter。
4. 保留内部 `PhaseRequestEnvelope` 作为审计和业务校验输入。
5. 调整自动 Schema 修复，使无效响应只进入尝试记录。
6. 运行适配器与编排器针对性测试。

验收：连续阶段消息前缀完全相同；缓存指标来自供应商 usage；reasoning 不出现在下一请求；校验失败时下一阶段调用次数为零。

### Task 5：收紧章节提交边界和恢复

1. 在完整 commit 与 publish 成功后追加唯一 canonical chapter message。
2. 为 pending source units 增加明确的本轮生命周期测试。
3. resume 从活动链和稳定检查点恢复，不重组旧 Prompt。
4. 验证切换模型仍使用同一消息链，仅 Profile 和 KV 指标变化。
5. 运行 turn、暂停、恢复和跨模型测试。

验收：失败草稿永不成为压缩保留正文；重启后从当前阶段继续；切换模型不创建剧情分支。

### Task 6：集成推演历史快照

1. 先修订 `2026-08-07-world-history-backend.md`，移除每轮 `context_lineage` 作为上下文恢复主体的旧方案。
2. 实现活动链快照导出、历史 manifest 持久化和快照完整性校验。
3. 把自动保存接到完整正文提交结果之后；失败只暂停历史 finalization。
4. 实现手动保存最近稳定检查点、历史恢复、从历史分叉和 retention。
5. 恢复历史时原子替换活动链并把包含任务的检查点置为 `paused`。
6. 运行历史 service、Git adapter、checkout 和上下文恢复测试。

验收：压缩前保存点可以恢复压缩前链，压缩后保存点恢复压缩后链；A/B 世界线来回切换互不串链；切换不需要重启。

### Task 7：配置与 UI 收口

1. 在模型配置中编辑并持久化最大上下文。
2. 项目设置只显示两个压缩比例。
3. 运行监控展示活动链 Token、阈值、压缩代次和 KV 趋势。
4. 历史 UI 接入真实保存、加载、返回上一轮和从这里继续，移除本地假数据与假成功状态。
5. 更新 UI 测试。

验收：容量来源无歧义；UI 展示值与实际请求前 Token 判断一致；历史操作返回后端真实状态并能恢复对应上下文链。

## 6. 关键测试矩阵

### 6.1 上下文连续性

- 同一轮两个阶段：后一请求是前一请求的严格前缀追加。
- 两轮连续推演：第二轮复用第一轮活动链，不创建新链。
- 模型切换：链 ID 和消息不变，model profile 变化。
- Evidence 回流：只追加新 Evidence，不重排已有 Evidence。
- 永久 ID：同一对象跨阶段、跨轮次和历史快照保持相同 ID；不同前缀拥有独立计数。

### 6.2 失败与恢复

- JSON 语法失败、Schema 失败、网络失败和空 content 都停在当前阶段。
- 未达到修复上限时自动修复，正式链只留下最终有效结果。
- 达到修复上限后任务为 `awaiting_user_decision`。
- 重启后 `turn.recoverable.list` 能恢复同一稳定链。
- reasoning 只存在于 `phase_runs.result_json` 和 UI。

### 6.3 压缩

- 低于 97% 不压缩。
- 达到 97% 后先移出旧轮非正文。
- 仍高于 50% 时按完整章节从旧到新移出。
- 当前轮、系统规则和当前用户规则不可移出。
- 保护项超过模型容量时暂停，不截断。
- 压缩不删除 Markdown、source、图、修订和历史对象。

### 6.4 提交

- draft 成功但 graph 失败：没有 canonical chapter message。
- commit 成功但 publish 失败：进入可恢复 finalization，不追加正式章节消息。
- 全部成功：只追加一条与 Markdown 完全一致的正式章节消息。
- 下一轮压缩只把正式章节消息识别为旧正文。

### 6.5 历史

- 手动保存完整链；模型请求进行中时保存最近稳定检查点对应的链。
- 自动保存只在整轮正式提交后创建。
- 恢复压缩前保存点可得到压缩前完整链，当前运行数据不同时保留第二份活动链。
- 从旧保存点继续创建新世界线，原世界线与其上下文快照保持不变。
- A、B 世界线来回切换并各自继续后，消息、图、章节和任务检查点不串线。
- 含任务保存点恢复后状态为 `paused`，不自动请求模型。

## 7. 全量验证命令

每个 Task 先运行针对性测试，整批完成后运行：

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Electron 最终人工验收至少覆盖：

1. 新项目连续完成两轮；
2. 中途触发一次 Schema 修复；
3. 中途暂停并在不重启情况下继续；
4. 重启 Electron 后恢复暂停任务；
5. 切换 DeepSeek Profile 后继续同一任务；
6. 使用测试用低上下文 Profile 触发两阶段压缩；
7. 在压缩前后各保存一次历史并来回恢复；
8. 从旧保存点创建分支并分别继续一轮；
9. 核对 KV 命中趋势、正式章节、图提交和原文精确召回。

## 8. 实施顺序和风险控制

严格按 Task 1 到 Task 7 执行。Task 1 至 Task 3 只增加新契约与新服务，不切换现有运行路径；Task 4 在单个功能开关下切换新链路，测试通过后删除旧四消息组装；Task 5 改变章节正式消息和任务恢复来源；Task 6 再接入完整历史快照；Task 7 最后调整用户可见配置和历史界面。

最大风险是一次性同时改编排、适配器、恢复和提交边界。为降低回归：

- 不在 `TurnOrchestrator` 新增上下文算法；
- 不让 DeepSeek 适配器读文件或数据库；
- 不让历史 finalization 进入阶段循环；
- 不删除 `PhaseRequestEnvelope` 审计数据，直到新恢复测试稳定；
- 每批保留可独立通过的端口测试和集成测试。

完成 Task 5 后，追加式上下文、KV 前缀稳定、机械压缩、失败停留和正式正文边界形成运行闭环；完成 Task 6 后，压缩前后的完整历史恢复才形成持久化闭环；Task 7 负责配置与用户交互收口。

## 9. 正式章节收尾补充

正式章节收尾由独立 Finalization 状态机负责，不把 AI 响应直接写成正式消息，也不复制正文内容。状态顺序为 `prepared -> scope_committed -> chapter_published -> chapter_registered -> completed`。恢复时只执行未完成的提交、发布或登记步骤；章节提交后的恢复不得重新进入任何 AI 阶段。

历史保存 Finalization 与章节 Finalization 分离。历史保存失败只暂停历史保存，不回滚已完成章节；章节 Finalization 未完成时，历史记录不能声明本轮正文已完成。

## 10. 当前实施状态

已完成基础追加链：

- 每个项目在 SQLite 中只有一条活动 `ModelContextChain`；
- 基础系统规则只在链创建时写入一次；
- 阶段请求尾部与最终通过校验的阶段响应，在 `phase_runs` 完成事务中原子追加；
- Schema 修复消息和原生 reasoning 不进入正式链；
- 下一阶段和下一轮请求读取同一条有序链，旧消息不重新构造；
- 正式章节登记时只追加 `contentRef/contentDigest` 引用，发送给模型前读取唯一 Markdown 正文；
- 模型切换继续使用项目活动链，不按模型创建剧情分支；
- 章节 Finalization 恢复只补未完成的章节引用，不重新调用模型。

尚未纳入本批：

- 项目级永久引用 ID；当前模型侧阶段别名仍可能跨阶段重复，下一批必须统一；
- 两阶段机械压缩与发送前精确 Token 计算；
- 历史快照对活动链的完整冻结、切换与恢复；
- 将阶段请求中重复的完整状态进一步收敛为更小的增量消息。
