# 章节修改入口协调 — 实施计划

> 权威设计：[chapter-modification-coordination.md](../../chapter-modification-coordination.md)

## 阶段总览

| 阶段 | 范围 | 预期效果 |
| --- | --- | --- |
| **P0** | `ChapterContextResolver`、hydration supersession、压缩保护、`chapter_revision` 提交时机 | 修订旧章后模型不再看到 stale 正文；`chapter_revision` 不被误压缩 |
| **P1** | `chapter_index` 表、消息元数据、稳定 sequence | 章节序号不依赖文件计数；revision 消息可机械 supersede |
| **P2** | `ChapterLineage`、`graphSyncBlocking` 门禁 | 后续章节 stale 提示；图同步未完成时阻止新 turn |
| **P3** | UI 路由、`chapter.resolve` API | 章节 Tab 显示对话面板；一次 API 返回完整状态 |
| **P4** | Agent 对话、`revision_assist` | 用户可与 Agent 多轮协作修订章节 |

本文只展开 **P0** 的文件级任务；P1–P4 在 P0 验收后按设计文档继续。

---

## P0 任务清单

### P0-1 `ChapterContextResolver`

**新建** `apps/backend/src/application/chapters/chapter-context-resolver.ts`

职责：
- `resolveHeads(projectId)` → 当前 `active_document_heads` 章节映射
- `hydrateNarrativeMessages(projectId, messages)` → 按 head 替换 stale 章节正文

依赖：
- `DocumentRepository.listCommittedChapters` / `findStoredVersion`
- `TurnPersistencePort.listCanonicalChapterMessageSources`
- `TurnPersistencePort.findChapterRevisionSummaryByTaskId`

**预期效果：** 任意 AI 请求在 hydration 后，每章正文与 head 一致。

### P0-2 TurnOrchestrator 接入 supersession

**修改** `apps/backend/src/application/turns/turn-orchestrator.ts`

- `compactInheritedModelContext`（~707）
- `executePhase` 模型请求 hydration（~2095）

两处改为调用 `ChapterContextResolver.hydrateNarrativeMessages`。

**预期效果：** 修订 ch1 后继续 turn，模型请求中 ch1 为 v2 而非链上 v1。

### P0-3 ContextWindowManager 保护 `chapter_revision`

**修改** `apps/backend/src/application/context/context-window-manager.ts`

- `isNarrativeChapterMessage(kind)` = `canonical_chapter` \| `chapter_revision`
- 第一阶段不移除叙事类章节消息
- 第二阶段按最旧章节移出时同时考虑两种 kind

**预期效果：** 压缩不会单独删掉 `chapter_revision` 而留下 stale `canonical_chapter`。

### P0-4 `chapter_revision` 提交时机

**修改** `apps/backend/src/application/chapters/chapter-revision-service.ts`

- `appendChapterRevisionContext` 移到 `commitContent` 完成后（`chapter_registered`）
- 不再绑定图同步 `try` 块；无 model 时仍追加链消息

**预期效果：** 正文提交后链上即有 `chapter_revision`，图同步失败不影响上下文更新。

### P0-5 持久化查询端口

**修改**
- `apps/backend/src/application/turns/ports/turn-persistence.ts`
- `apps/backend/src/infrastructure/sqlite/repositories/sqlite-turn-persistence.ts`

新增：
- `listCanonicalChapterMessageSources(projectId)`
- `findChapterRevisionSummaryByTaskId(taskId)`

### P0-6 测试

**新建** `apps/backend/test/chapter-context-resolver.test.ts`  
**修改** `apps/backend/test/context-window-manager.test.ts`

覆盖：
- stale `canonical_chapter` 被 head 正文替换
- `chapter_revision` 在第一阶段不被当作非叙事删除
- 修订提交后 `appendChapterRevisionContext` 在 graph sync 之前调用

---

## P0 验收标准

1. `pnpm test` 通过（含新测试）
2. `pnpm typecheck` 通过
3. 修订章节后 resume turn，hydrated 消息中该章 `contentDigest` 与 head 一致
4. `chapter_revision` 消息在 `graphSyncStatus=failed` 时仍存在于链上

---

## P1–P4 概要（本次不实施）

| 阶段 | 关键文件 | 预期效果 |
| --- | --- | --- |
| P1 | `project-migrations.ts`、`chapter.ts` contracts | 稳定 `ChapterIndex`；revision 消息含 `replacedSourceId` |
| P2 | `chapter-lineage.ts`、`backend-facade.ts` turn.start 门禁 | stale 标记；图同步阻塞新 turn |
| P3 | `EditorArea.tsx`、`App.tsx`、`backend-payloads.ts` | 章节 Tab 无 TurnComposer；`chapter.resolve` |
| P4 | `revision_assist` phase、`revision_conversation_messages` | Agent 多轮对话修订 |
