# 正文修订与用户最高权限设计

> 三种修改入口（本轮推演、直接编辑、Agent 对话）如何共享上下文又不混合草稿，见 [章节修改入口协调设计](chapter-modification-coordination.md)。本文只规定修订权限、审核、提交和图同步细节。

## 1. 目标与结论

本设计为已经提交的 `章节正文/*.md` 增加用户可编辑、可审阅、可强制提交的修订流程。

核心结论：

1. 用户拥有作品的最高创作权限。用户最终提交的正文不能被 AI 审核拒绝、回滚或覆盖。
2. AI 审核只产生连续性和数据同步建议，不拥有提交否决权。
3. 任何编辑都创建新的不可变正文版本，不直接覆盖旧版本。
4. “直接提交”和“审核后提交”是两条不同入口，但最终提交后的正文持久化与图同步使用同一套收尾流程。
5. 正文正式提交与图同步必须解耦。正文提交成功后，即使图同步失败，正文和用户决定也不能丢失；图同步进入可恢复任务。
6. 旧正文、旧原文单元、旧图修订、审核结果和历史快照均保留，不物理删除。

这套设计与当前系统的 `document_versions`、`source_units`、`artifact_scopes`、`graph_revisions`、`turn_finalizations` 和 Git 历史快照兼容，但不能直接复用 `workspace.save`，也不能把章节修订强行塞入只服务于新章节生成的 `turn_finalizations`。

## 2. 当前代码评估

### 2.1 已有能力

当前代码已经提供以下基础能力：

- `DocumentVersion` 保存 `chapterId`、`sourceId`、`predecessorSourceId`、正文摘要、内部内容引用和发布路径。
- `SourceUnit` 按顺序保存不可变正文片段，支持精确检索和图结算映射。
- `artifact_scope` 将待提交正文、图修订、结算记录和检索投影隔离在同一 pending 作用域。
- `SqliteScopeCommitRepository` 能将 pending 作用域提升为 committed，并更新章节 head、图 head 和检索投影。
- `turn_finalizations` 能恢复“数据库作用域提交、Markdown 发布、正式章节登记、任务完成”的中断流程。
- Git 历史快照保存章节 head、工作区 Markdown、图 head、上下文链和任务检查点，支持返回旧历史并分叉。
- 工作区策略已经禁止用户通过普通写入接口修改 `章节正文`；章节只能通过章节发布者写入。
- Prompt Contract 已有 `workflow: revision` 的工作流枚举，任务类型也已有 `revision`。

### 2.2 当前缺口

当前章节修订的后端基础闭环已经实现：

- `chapter.list`、`chapter.read`、`chapter.readRevision`、`chapter.findActiveRevision`、`chapter.startRevision`、`chapter.updateRevision`、`chapter.reviewRevision`、`chapter.submitRevision`、`chapter.retireRevision` 已有 payload、dispatch 和 SQLite 仓储。
- 直接提交和审核后提交都创建不可变 proposed source；审核结果绑定 `proposedSourceId + contentDigest`，正文再次更新后自动失效。
- `revision_review` 作为独立只读 AI 阶段接入，AI只能提供问题和建议，不能拒绝提交。
- 正文 scope 提交、章节 Markdown 发布、外部文件摘要校验和重复提交恢复已经有后端测试覆盖。
- 图同步使用独立 `revision` 工作流，复用既有图治理阶段，并将已提交正文的 source units 绑定到 settlement。
- 修订正文以 `chapter_revision` 消息幂等追加到同一模型上下文链；旧 `canonical_chapter` 消息保持不变。
- 图同步任务 ID 持久化在修订任务中，失败后正文不回滚，重复提交从同一 phase checkpoint 恢复。
- Renderer 已改为调用真实章节修订 API，不再使用本地计时器或伪造审核问题。

已实现独立的 `chapter_revision_finalizations` 表和可恢复收尾状态。正文提交与图同步解耦：正文提交成功后立即返回，图治理在后台沿同一 `graphSyncTaskId` 执行；图同步失败不会回滚正文，用户可从章节状态面板重试。Renderer 通过 `chapter.readRevision` 轮询并在重新打开项目时恢复活动修订。

此外，当前编辑器将已提交章节作为只读阅读器展示。这个 UI 保护是必要的，但不能作为唯一安全边界；后端仍需要拒绝 `workspace.save` 对章节目录的写入，并只允许修订流程调用章节发布接口。

当前新章节流程的 `completeTurn` 先把正文和图一起放入 pending scope，再执行 `scope.commit`，之后发布 Markdown。这适合“生成一轮正文”，不适合“用户编辑后正文立即正式、图随后同步”的直接提交语义。因此章节修订需要独立的最终化状态和服务。

## 3. 领域对象与职责边界

### 3.1 ChapterRevision

章节修订表示一次从旧正文版本产生新正文版本的业务操作，不等同于 Git commit，也不等同于图 revision。

逻辑字段：

```text
revisionTaskId       修订任务 ID，关联 task(kind = revision)
projectId
chapterId            稳定章节身份
baseSourceId         用户开始编辑时的正式正文版本
proposedSourceId     用户当前编辑版本，内容不可变
predecessorSourceId  proposedSourceId 的直接前版本
contentDigest        当前编辑内容摘要
submissionMode       direct | reviewed
decision             pending | submit | abandon
aiReviewId           最近一次审核建议，可为空
graphSyncStatus      not_started | pending | running | completed | failed
status               editing | reviewing | ready_to_submit | committing |
                     graph_sync_pending | completed | retired | failed
createdAtMs
updatedAtMs
```

同一个章节可以有多个修订任务，但同一时间只允许一个任务以当前正式版本为 base 进行提交。若 base 已经变化，旧修订不能静默覆盖新版本，必须提示用户重新基于当前版本编辑或明确创建分支。

### 3.2 RevisionReview

审核结果必须绑定 `proposedSourceId` 和 `contentDigest`，不能只绑定 `chapterId`。正文再次修改后，旧审核自动失效。

审核结果只保存建议：

```text
reviewId
revisionTaskId
proposedSourceId
contentDigest
issues[]
  location
  category
  severity
  evidenceRefs[]
  description
  impact
  suggestion
  requiresGraphSync
  affectsLaterChapters
recommendation: no_issue | review_suggested | material_conflict
createdAtMs
```

`recommendation` 是给用户看的结论，不是状态门禁。即使是 `material_conflict`，用户仍可提交。

### 3.3 UserRevisionDecision

用户的最终决定单独记录，不能从按钮名称或当前任务状态推断：

```text
decisionId
revisionTaskId
proposedSourceId
contentDigest
mode: direct | reviewed
action: submit | abandon
forced: boolean
reason: user_forced_edit | user_reviewed_edit
reviewId?: string
note?: string
createdAtMs
```

规则：

- 直接提交：`mode = direct`、`forced = true`、`reason = user_forced_edit`。
- 审核后用户忽略建议提交：`mode = reviewed`、`forced = true`、`reason = user_forced_edit`。
- 审核后用户采纳建议或确认没有需要处理的问题再提交：`mode = reviewed`、`forced = false`、`reason = user_reviewed_edit`。
- AI 不产生 `action`，只有用户产生 `action`。

`mode` 用于区分是否经过审核，`reason` 用于描述事实为什么发生变化。所有绕过或忽略审核的提交统一记录为“用户强制修改”，不再增加含义重叠的直接提交原因。

## 4. 两种提交路径

### 4.1 直接提交

用户打开已提交章节并编辑后点击“直接提交”：

```text
读取当前章节版本
  -> 创建 revision task
  -> 保存用户正文 immutable content
  -> 建立新的 pending document version 和 source units
  -> 记录 user_forced_edit
  -> 提交正文 scope
  -> 发布章节 Markdown
  -> 登记新的 canonical chapter
  -> 启动 graph sync task
```

直接提交不调用 AI 审核，不等待连续性建议。它不是绕过数据一致性，而是绕过“AI 建议等待”：

- 正文版本仍然经过 digest、source unit、检索投影和历史记录处理；
- 用户正文成为后续图治理的最高优先级事实来源；
- 图同步任务必须重新读取最终正文，不能使用用户编辑前的草稿或旧审核结果；
- 图同步不能以“正文不合理”为理由拒绝或撤销正文。

### 4.2 审核后提交

用户点击“审核后提交”：

```text
读取当前章节版本
  -> 创建或更新 revision task
  -> 保存用户正文 immutable content
  -> AI revision_review
  -> 保存建议和证据
  -> 用户查看差异与建议
      -> 修改正文：生成新的 proposedSourceId，旧 review 失效
      -> 重新审核：执行新的 revision_review
      -> 提交：进入统一正文提交流程
      -> 放弃：修订任务 retired，正式正文不变
```

审核至少检查：

- 正文内部和前后章节的时间连续性；
- 场景、地点和移动路径的空间连续性；
- 人物、地点、物件、关系、事件及其他已入图事物的当前状态；
- 正文是否改变已提交图含义；
- 是否需要创建新的图 revision 或历史返回路径；
- 是否影响后续章节的当前状态；
- 哪些差异只是表达调整，不需要改变世界图。

审核结果应显示修改位置和证据，不要求用户理解内部 ID。内部证据引用仅用于审计和后续图同步。

## 5. 正文提交与图同步

### 5.1 两个作用域

为满足“正文立即正式”和“图随后同步”，一次章节修订拆成两个作用域：

1. **Content scope**：只包含新的 `document_version`、`source_units`、正文检索投影和修订决定关联。提交后新的正文 head 成为 committed。
2. **Graph sync scope**：以已提交的 `proposedSourceId` 为输入，包含图 revision、`NarrativeSettlementRecord`、时空绑定、前沿结算和图检索投影。提交后新的图 head 成为 committed。

Content scope 不得包含会改变世界图 head 的 pending graph records；Graph sync scope 不得修改已提交正文内容。

### 5.2 用户正文的优先级

图同步时，优先级固定为：

```text
用户最终提交正文
  > 本次修订审核建议
  > 当前已提交图状态
  > 更早正文和历史图修订
```

这不是把旧资料删除，而是说明当前有效状态如何更新：

- 旧状态通过旧 `sourceId`、旧 `source_units` 和旧 `graph_revisions` 返回；
- 新正文中明确改变的内容形成新的图 revision；
- 新正文没有涉及的旧内容继续有效；
- 仅凭一次没有发现变化不能把旧内容标记为删除；
- 用户没有表达变化的图对象不应被图同步任务批量重写。

### 5.3 图同步失败

正文提交成功后，图同步可能因模型、网络、预算、结构校验或数据库错误失败。失败处理如下：

- 正式 Markdown 不回滚；
- 新 `sourceId` 和用户决定不回滚；
- `ChapterRevision.graphSyncStatus = failed`；
- 任务进入 `awaiting_user_decision` 或 `paused`，并保存最近稳定检查点；
- 用户可以继续执行、重试当前图同步阶段或暂停；
- UI 明确显示“正文已提交，世界图尚未同步”，不能显示“正文失败”；
- 图同步完成前，新的普通推演默认提示存在待同步修订；是否允许继续由项目策略决定，默认暂停新的依赖当前图的推演，避免在图状态不完整时产生下一轮事实。

图同步失败不是 AI 判定正文错误，而是基础设施或同步任务尚未完成。

### 5.4 上下文链与后续章节

章节修订不能通过修改历史 `canonical_chapter` 消息来回填上下文，也不能把修订正文伪装成新章节追加到章节序列末尾。正文提交完成后，系统追加一条带替代关系的正式上下文消息：

```text
kind: chapter_revision
chapterId
replacedSourceId
sourceId
contentDigest
decisionId
```

这条消息只表达“当前章节版本已由用户修订为新版本”，正文内容仍通过 `contentRef` 读取。旧的 canonical 消息和旧正文版本继续保留在历史链中；活动上下文使用当前章节 head，旧消息可以按既有上下文压缩策略移出可见链，但不能物理删除。

修订旧章节不会自动重写后续章节正文。图同步完成后，系统可以根据图影响和正文来源生成“后续章节可能受影响”的建议任务；只有用户再次编辑或明确发起修订，后续章节才会产生新的正文版本。这样既保留用户修改的最高权限，又避免系统未经用户授权批量改写作品。

## 6. 最终化状态机

章节修订采用独立的可恢复最终化记录，不能复用只包含新章节字段的 `turn_finalizations`：

```text
editing
  -> reviewing
  -> ready_to_submit
  -> committing_content
  -> content_committed
  -> chapter_published
  -> chapter_registered
  -> graph_sync_pending
  -> graph_sync_running
  -> completed
```

可恢复分支：

```text
reviewing              -> editing      用户修改正文
ready_to_submit        -> editing      用户继续修改
committing_content     -> awaiting_user_decision 发生可恢复错误
content_committed      -> graph_sync_pending      正文已提交，图尚未开始
graph_sync_running     -> graph_sync_pending      图同步失败或被暂停
graph_sync_pending     -> graph_sync_running      用户选择继续或重试
任何未提交状态         -> retired      用户放弃修订
```

正文提交阶段需要保证幂等：

- 相同 `revisionTaskId + proposedSourceId` 重试不能生成第二份正文 head；
- Markdown 已经写入且内容 digest 相同视为已完成；内容不同必须报冲突；
- canonical chapter 登记重复调用必须返回原记录；
- 图同步重试不得重复创建同一正文版本的图结算记录。

## 7. 后端修改范围

### 7.1 Contracts

在 `packages/contracts` 增加：

- `chapter.list`、`chapter.read`、`chapter.readRevision`、`chapter.findActiveRevision` 的真实 payload 和返回 schema；
- `chapter.startRevision`：章节 ID、base source ID、独立 `heading` 和正文 `body`；
- `chapter.updateRevision`：修订任务 ID、独立 `heading` 和正文 `body`；
- `chapter.reviewRevision`：修订任务 ID、模型选择和预算参数；
- `chapter.submitRevision`：修订任务 ID、提交模式、用户决定和可选备注；
- `chapter.retireRevision`：修订任务 ID；
- 修订状态、审核问题、用户决定、图同步状态的 schema；
- 章节修订相关事件，例如 `chapter.revision.changed` 和 `chapter.graph-sync.changed`。

现有 `chapter.submitRevision` 可以保留，但必须明确它只接受用户决定，不接受 AI 的“通过/拒绝”字段。

修订任务持久化 `heading` 与正文内容分离。`body` 不包含 Markdown 标题行；正式 Markdown 内容只在提交边界由代码使用 `heading` 装配，文件名和发布路径也由同一字段派生。标题字段是纯文本单行输入，不从正文推断或兼容解析 Markdown 标题。

### 7.2 Application

新增独立模块，建议位于：

```text
apps/backend/src/application/chapters/
  chapter-revision-service.ts
  chapter-revision-finalization-service.ts
  chapter-revision-review-service.ts
  ports/chapter-revision-repository.ts
  ports/chapter-revision-finalization-repository.ts
```

职责分离：

- `ChapterRevisionService`：创建修订、保存新正文、校验 base 版本、失效旧审核；
- `ChapterRevisionReviewService`：装配审核上下文、调用模型、保存建议；不提交正文、不修改图；
- `ChapterRevisionFinalizationService`：执行正文 scope 提交、Markdown 发布、canonical 登记和用户决定记录；
- `GraphSyncService`：从最终 committed source 读取正文，执行现有图治理和图 scope 提交；
- Repository：只负责 SQLite 持久化，不包含 AI 语义判断和 UI 决策。

现有 `TurnOrchestrator` 不直接处理编辑器提交。新章节生成仍走原有流程；修订服务只复用底层的文档、检索、scope commit、内部存储、图治理和历史端口。

### 7.3 Persistence

建议新增以下表，避免把章节修订状态塞入 `document_versions` 或 `turn_finalizations`：

- `chapter_revision_tasks`：修订任务和当前状态；
- `chapter_revision_reviews`：绑定正文 digest 的 AI 建议；
- `chapter_revision_decisions`：用户最终决定和变化原因；
- `chapter_revision_finalizations`：正文提交及图同步的可恢复状态；失败时回到 `graph_sync_pending`，由修订任务的 `graphSyncStatus=failed` 保存失败原因。

修订最终化记录需要保存 `replacedSourceId`、`contentScopeId`、`graphSyncScopeId`、正文提交状态、Markdown 发布状态、上下文消息 ID 和图同步检查点。若实现直接复用通用 finalization 表，必须增加明确的 `workflow` 和修订字段，并保证新章节 finalization 的约束不被放宽；优先使用独立表，避免两套工作流互相污染。

正文当前性通过 `active_document_heads` 和修订后的 `document_versions` 表达。旧 `source_units` 和旧 source 检索投影不得删除；普通检索只返回当前章节 head 的 source，历史查询和显式修订审计才返回被替代 source。

不新增正文副本字段。正文内容仍使用内部不可变文档存储，`document_versions.content_ref` 作为唯一内容入口。

### 7.4 Workspace

保留现有策略：

- `workspace.save` 继续拒绝 `章节正文`；
- `publishChapter` 只由章节最终化服务调用；
- 用户编辑内容先写内部不可变存储，不直接写用户目录；
- 正文提交成功后才发布到 `章节正文`；
- 发布操作通过现有 WorkspaceOperation/历史快照机制记录进度。

现有 `publishChapter` 的“目标不存在才创建、存在且内容不同则报冲突”语义不能直接用于同一路径的章节修订。需要新增带期望旧摘要的原子替换接口，例如 `replacePublishedChapter(workspaceRootRef, path, expectedDigest, content)`：只有当前文件摘要等于期望旧摘要时才替换；重复调用若新摘要相同则幂等成功；摘要不匹配则返回外部文件冲突。该接口仍只允许章节最终化服务使用。

## 8. 前端修改范围

### 8.1 编辑器状态

打开 `章节正文/*.md` 后，中央区域从只读 `ChapterReader` 变为“正文阅读/编辑模式”：

- 默认仍为阅读模式；
- 点击编辑后加载修订草稿；
- 编辑中显示 `基于：第一章 ... · sourceId 隐藏在详情中`；
- 自动保存只保存修订草稿，不改变正式章节；
- 正式章节文件在用户提交前保持不变；
- 正文再次修改后，旧审核建议标记为已过期。

### 8.2 操作按钮

编辑模式底部或顶部固定显示：

```text
[直接提交] [审核后提交]
```

审核结果出现后仍保留两条明确路径：

```text
[继续修改] [重新审核] [直接提交] [按审核结果提交] [放弃修改]
```

“直接提交”需要一次明确确认，提示正文会立即成为正式版本、审核建议不会阻止提交，系统随后仍会执行图同步。“按审核结果提交”只表示用户已查看并接受当前审核结果，不表示 AI批准了正文。

### 8.3 审核面板

右侧使用紧凑列表展示：

- 严重程度；
- 正文位置；
- 问题描述；
- 相关历史或图证据；
- 对时间、空间、状态和后续章节的影响；
- 建议处理方式；
- 是否需要图同步。

审核面板的主按钮不能叫“通过审核”，应叫“提交当前版本”，避免暗示 AI 具有审批权。

### 8.4 提交后状态

正文和图同步状态分开显示：

```text
正文       已正式提交
审核       建议已保存 / 未执行 / 已忽略
世界图     同步中 / 已同步 / 待重试
历史版本   已保留
```

图同步失败时，提供：

```text
[继续执行] [重试图同步] [暂停]
```

不提供“撤销用户提交”按钮。用户如需回到旧版本，使用历史恢复或基于旧版本创建新分支。

## 9. 历史与分支

每次正文直接提交或审核后提交都属于一次可追溯持久化变化：

- 当前章节 head 指向新的 `document_version`；
- 旧章节版本仍可通过 predecessor 链和历史快照读取；
- 新图修订引用新的 `sourceId` 和用户决定；
- 手动保存和完整轮自动保存包含修订任务状态及最近稳定检查点；
- 从旧历史继续时，修订任务、正文 head、图 head 和上下文链一起恢复；
- 在旧历史上继续提交时，首次写入创建新世界线，不影响原未来；
- 历史恢复不会物理删除任何正文或图 revision。

如果用户在修订提交后、图同步完成前保存历史，保存点必须记录：

- 正文已经提交的 source head；
- 图同步任务 ID 和当前状态；
- 最近图同步检查点；
- 审核结果和用户决定。

恢复后统一置为暂停，不自动继续模型请求。

## 10. 错误与并发规则

### 10.1 版本冲突

若用户编辑期间当前章节已经被其他任务提交新版本：

- 不自动覆盖；
- 返回 base source 已过期；
- UI 提供查看当前版本、保留本地草稿、基于当前版本重新编辑三个选择；
- 用户明确选择后才生成新的 proposed source。

### 10.2 AI 审核错误

审核请求失败不影响正文草稿，也不影响旧正式正文。任务进入可恢复状态，用户可以重试审核、直接提交或放弃修订。直接提交明确绕过审核请求，不得因为审核服务不可用而阻塞用户创作。

### 10.3 正文提交错误

正文 scope 未提交成功时，正式章节 head 和用户 Markdown 不变，修订保持 pending，可恢复重试。

正文 scope 已提交但 Markdown 发布失败时，数据库中的正文版本已经正式存在，最终化记录必须停在 `content_committed`，恢复时只重试发布和登记，不能重新提交 scope。

### 10.4 图同步错误

图同步错误只影响 `graphSyncStatus`，不反向改变正文可见性。图同步重试使用同一个 `proposedSourceId` 和 revision task，必须幂等。

在图同步完成前，不允许基于该章节当前状态创建新的依赖图事实的正文推演或第二个章节修订任务。用户仍可以阅读已提交正文、查看审核建议、恢复历史和重试图同步；如果用户必须继续创作，应先从图同步完成前的历史点创建明确分支，不能让未同步状态悄悄成为下一轮的完整世界基线。

## 11. 代码规范与低耦合要求

- Contracts 只描述数据形状，不包含 AI 判断。
- Application service 通过 ports 依赖文档、图、模型、工作区和历史能力，不直接操作 SQLite 或文件系统。
- Repository 只做持久化和事务，不解释正文语义。
- AI 审核、正文最终化、图同步分别使用独立服务；修改一项业务不会改变其他流程的状态机。
- 复用已有内部不可变存储、文档仓储、检索投影、scope commit、WorkspacePort 和历史服务，不新建第二套正文存储。
- 用户决定必须由后端验证并持久化，不能只依赖 Renderer 传递一个布尔值。
- 所有重试都通过持久化状态恢复，不依赖进程内 Map。
- 旧记录只归档或通过历史可见性隔离，不物理删除。

## 12. 测试验收

### Contracts 与应用层

1. 创建修订生成新 proposed source，正式 source 不变。
2. 修订正文再次修改后，旧审核结果不能用于提交提示。
3. 直接提交不调用审核模型。
4. 审核后提交保存审核建议，但 AI 的 material conflict 不能阻止用户提交。
5. 忽略建议提交记录 `user_forced_edit`。
6. 直接提交记录 `user_forced_edit`，并通过 `mode = direct` 与审核后强制提交区分。
7. 放弃修订不改变正式章节 head、图 head 和工作区文件。
8. base source 过期时拒绝静默覆盖。

### 持久化与最终化

9. 正文 scope 提交成功后，新的章节 head 可读取，旧版本仍可读取。
10. Markdown 发布失败后恢复不会重复创建版本。
11. 图同步失败时正文仍然存在，任务状态为可恢复。
12. 图同步重试不会重复写入相同结算记录。
13. 历史快照包含正文版本、用户决定、审核结果和图同步检查点。
14. 历史恢复后任务保持暂停，不自动继续。
15. 普通 `workspace.save` 仍拒绝章节路径。
16. 修订同一路径 Markdown 时，旧摘要匹配才替换；重复恢复幂等，外部文件变化报告冲突。
17. 修订旧章节不追加错误的章节序号，不改写后续章节，也不修改旧上下文消息内容。

### Electron E2E

18. 打开章节、进入编辑、修改正文、直接提交后可重新读取修改内容。
19. 审核后提交能看到问题位置和建议。
20. 用户修改后能重新审核，旧建议显示为过期。
21. 用户忽略冲突建议仍能提交并看到“用户强制修改”。
22. 模拟图同步错误，界面显示“正文已提交、世界图待同步”，并能重试。
23. 切换历史版本后正文和图状态一致，继续工作会创建新分支。

## 13. 实施顺序

1. 增加 contracts、修订状态和持久化模型，不改变现有 turn 流程。
2. 实现章节读取、创建修订、更新草稿、放弃修订。**已完成后端基础闭环。**
3. 实现正文修订专用 content finalization，并接入 WorkspacePort 发布和历史快照。**已完成。**状态为 `prepared -> content_committed -> chapter_published -> chapter_registered -> graph_sync_pending -> graph_sync_running -> completed`；正文与图同步解耦，图同步失败保留 `awaiting_user_decision` 和可重试检查点。
4. 实现审核服务和 `revision_review` Prompt Contract，先只读输出建议。**已完成后端只读审核入口。**
5. 实现 GraphSyncService，复用现有图治理和 pending scope 能力。
6. 增加后端单元测试和 SQLite 集成测试。
7. 增加 Renderer 编辑、审核面板和图同步状态。
8. 增加 Electron E2E，验证直接提交、审核提交、强制提交、失败恢复和历史恢复。

实施前不得修改现有 `TurnOrchestrator` 的正常新章节闭环；只有在抽取共享的正文发布或最终化基础工具时，才进行保持行为不变的复用重构。
