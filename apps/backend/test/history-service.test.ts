import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

import { afterEach, describe, expect, it } from "vitest"

import {
  digest,
  fixedWorkspaceEntries,
  HistoryManifestBuilder,
  HistoryCheckoutService,
  HistoryRetentionService,
  HistoryService,
  IsomorphicGitHistoryAdapter,
  NodeWorkspaceAdapter,
  NodeWorkspaceSnapshotAdapter,
  openProjectDatabase,
  SqliteDocumentRepository,
  SqliteHistoryRepository,
  SqliteGraphRepository,
  SqliteProjectRepository,
  SqliteScopeCommitRepository,
  SqliteTaskScopeRepository,
  SqliteTurnPersistence,
  type HistoryVcsPort,
  type GraphRevision,
  type ProjectManifest,
} from "../src/index.js"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("HistoryService", () => {
  it("saves one committed world snapshot idempotently in the internal Git repository", async () => {
    const fixture = await createFixture()
    const operationId = randomUUID()
    const first = await fixture.service.saveAutomatic({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId,
      name: "第一章 自动保存",
      taskId: fixture.taskId,
      createdAtMs: 100,
    })
    const repeated = await fixture.service.saveAutomatic({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId,
      name: "重复点击不创建新保存点",
      taskId: fixture.taskId,
      createdAtMs: 200,
    })

    expect(first.status).toBe("ready")
    expect(repeated.entryId).toBe(first.entryId)
    expect(await fixture.repository.listEntries(fixture.projectId)).toHaveLength(1)
    const row = await fixture.database.selectFrom("history_entries").selectAll().executeTakeFirstOrThrow()
    const snapshot = await fixture.vcs.readSnapshot(row.git_commit_oid as string)
    expect(snapshot.manifest.activeScopeIds).toEqual([fixture.scopeId])
    expect(snapshot.manifest.documentHeads).toEqual([expect.objectContaining({ chapterId: fixture.chapterId })])
    expect(snapshot.files.some((file) => file.gitPath.includes("章节正文/第一卷 测试/第一章 开始.md"))).toBe(true)
    expect(snapshot.files.some((file) => file.gitPath.includes("base-rules.md"))).toBe(false)
    expect((await fixture.repository.listBranches(fixture.projectId))[0]).toMatchObject({
      worldHeadEntryId: first.entryId,
      historyHeadEntryId: first.entryId,
    })
    await fixture.database.destroy()
  })

  it("restores the next context sequence after compressed snapshots leave sequence gaps", async () => {
    const fixture = await createFixture()
    await fixture.database.insertInto("model_context_messages").values({
      id: randomUUID(),
      project_id: fixture.projectId,
      chain_id: fixture.chainId,
      sequence_no: 5,
      role: "assistant",
      kind: "canonical_chapter",
      task_id: fixture.taskId,
      turn_id: null,
      phase: null,
      content_text: "压缩后仍可见的旧章节",
      content_ref: null,
      content_digest: digest("压缩后仍可见的旧章节"),
      token_estimate: 8,
      origin_phase_run_id: null,
      origin_index: null,
      hidden_at: null,
      created_at: 100,
    }).executeTakeFirstOrThrow()
    await fixture.database.updateTable("model_context_chains").set({
      message_count: 6,
      token_estimate: 16,
      updated_at: 100,
    }).where("id", "=", fixture.chainId).executeTakeFirstOrThrow()
    const saved = await fixture.service.saveAutomatic({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId: randomUUID(),
      name: "压缩后保存",
      taskId: fixture.taskId,
      createdAtMs: 200,
    })
    await fixture.database.deleteFrom("model_context_messages").where("sequence_no", "=", 5).execute()
    await fixture.database.updateTable("model_context_chains").set({ message_count: 1, token_estimate: 8 })
      .where("id", "=", fixture.chainId).executeTakeFirstOrThrow()
    const checkout = new HistoryCheckoutService(
      fixture.repository,
      fixture.vcs,
      new NodeWorkspaceSnapshotAdapter(fixture.workspace),
      () => 300,
    )

    await checkout.checkout({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId: randomUUID(),
      entryId: saved.entryId,
      mode: "restore",
      startedAtMs: 300,
    })

    const restored = await fixture.database.selectFrom("model_context_chains").selectAll().executeTakeFirstOrThrow()
    expect(restored.message_count).toBe(6)
    const restoredSequences = await fixture.database.selectFrom("model_context_messages")
      .select("sequence_no").orderBy("sequence_no").execute()
    expect(restoredSequences).toEqual([{ sequence_no: 0 }, { sequence_no: 5 }])
    await fixture.database.destroy()
  })

  it("restores the complete context log while preserving hidden message visibility", async () => {
    const fixture = await createFixture()
    const hiddenMessageId = randomUUID()
    const visibleMessageId = randomUUID()
    await fixture.database.insertInto("model_context_messages").values([
      {
        id: hiddenMessageId,
        project_id: fixture.projectId,
        chain_id: fixture.chainId,
        sequence_no: 1,
        role: "assistant",
        kind: "phase_response",
        task_id: fixture.taskId,
        turn_id: null,
        phase: "interpret",
        content_text: "已经移出活动上下文但仍属于完整历史",
        content_ref: null,
        content_digest: digest("已经移出活动上下文但仍属于完整历史"),
        token_estimate: 7,
        origin_phase_run_id: null,
        origin_index: null,
        hidden_at: 150,
        created_at: 100,
      },
      {
        id: visibleMessageId,
        project_id: fixture.projectId,
        chain_id: fixture.chainId,
        sequence_no: 2,
        role: "assistant",
        kind: "canonical_chapter",
        task_id: fixture.taskId,
        turn_id: null,
        phase: null,
        content_text: "当前仍可见的正式章节",
        content_ref: null,
        content_digest: digest("当前仍可见的正式章节"),
        token_estimate: 9,
        origin_phase_run_id: null,
        origin_index: null,
        hidden_at: null,
        created_at: 160,
      },
    ]).executeTakeFirstOrThrow()
    const initialChain = await fixture.database.selectFrom("model_context_chains").selectAll()
      .where("id", "=", fixture.chainId).executeTakeFirstOrThrow()
    await fixture.database.updateTable("model_context_chains").set({
      message_count: 3,
      token_estimate: initialChain.token_estimate + 9,
      updated_at: 160,
    }).where("id", "=", fixture.chainId).executeTakeFirstOrThrow()
    const saved = await fixture.service.saveAutomatic({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId: randomUUID(),
      name: "完整上下文历史保存",
      taskId: fixture.taskId,
      createdAtMs: 200,
    })
    await fixture.database.deleteFrom("model_context_messages").where("sequence_no", ">", 0).execute()
    await fixture.database.updateTable("model_context_chains").set({
      message_count: 1,
      token_estimate: initialChain.token_estimate,
    }).where("id", "=", fixture.chainId).executeTakeFirstOrThrow()
    const checkout = new HistoryCheckoutService(
      fixture.repository,
      fixture.vcs,
      new NodeWorkspaceSnapshotAdapter(fixture.workspace),
      () => 300,
    )

    await checkout.checkout({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId: randomUUID(),
      entryId: saved.entryId,
      mode: "restore",
      startedAtMs: 300,
    })

    const restoredMessages = await fixture.database.selectFrom("model_context_messages")
      .select(["id", "sequence_no", "hidden_at", "token_estimate"])
      .where("chain_id", "=", fixture.chainId).orderBy("sequence_no").execute()
    const restoredChain = await fixture.database.selectFrom("model_context_chains").selectAll()
      .where("id", "=", fixture.chainId).executeTakeFirstOrThrow()
    expect(restoredMessages).toEqual([
      expect.objectContaining({ sequence_no: 0, hidden_at: null }),
      { id: hiddenMessageId, sequence_no: 1, hidden_at: 150, token_estimate: 7 },
      { id: visibleMessageId, sequence_no: 2, hidden_at: null, token_estimate: 9 },
    ])
    expect(restoredChain.message_count).toBe(3)
    expect(restoredChain.token_estimate).toBe(initialChain.token_estimate + 9)
    await fixture.database.destroy()
  })

  it("restores a context log larger than one SQLite statement can bind", async () => {
    const fixture = await createFixture()
    const messageCount = 2_100
    const messages = Array.from({ length: messageCount }, (_, index) => {
      const content = `历史上下文消息 ${String(index + 1)}`
      return {
        id: randomUUID(),
        project_id: fixture.projectId,
        chain_id: fixture.chainId,
        sequence_no: index + 1,
        role: "assistant" as const,
        kind: "phase_response" as const,
        task_id: fixture.taskId,
        turn_id: null,
        phase: "interpret" as const,
        content_text: content,
        content_ref: null,
        content_digest: digest(content),
        token_estimate: 4,
        origin_phase_run_id: null,
        origin_index: null,
        hidden_at: index % 3 === 0 ? 100 + index : null,
        created_at: 100 + index,
      }
    })
    for (let offset = 0; offset < messages.length; offset += 50) {
      await fixture.database.insertInto("model_context_messages")
        .values(messages.slice(offset, offset + 50)).execute()
    }
    await fixture.database.updateTable("model_context_chains").set({
      message_count: messageCount + 1,
      token_estimate: 8 + messages.filter((message) => message.hidden_at === null).length * 4,
      updated_at: 3_000,
    }).where("id", "=", fixture.chainId).executeTakeFirstOrThrow()
    const saved = await fixture.service.saveAutomatic({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId: randomUUID(),
      name: "大上下文历史保存",
      taskId: fixture.taskId,
      createdAtMs: 4_000,
    })
    await fixture.database.deleteFrom("model_context_messages").where("sequence_no", ">", 0).execute()
    const checkout = new HistoryCheckoutService(
      fixture.repository,
      fixture.vcs,
      new NodeWorkspaceSnapshotAdapter(fixture.workspace),
      () => 5_000,
    )

    await checkout.checkout({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId: randomUUID(),
      entryId: saved.entryId,
      mode: "restore",
      startedAtMs: 5_000,
    })

    const restoredMessages = await fixture.database.selectFrom("model_context_messages")
      .select(["sequence_no", "hidden_at"]).orderBy("sequence_no").execute()
    expect(restoredMessages).toHaveLength(messageCount + 1)
    expect(restoredMessages.at(-1)).toEqual({
      sequence_no: messageCount,
      hidden_at: messages.at(-1)?.hidden_at ?? null,
    })
    await fixture.database.destroy()
  })

  it("records a failed history finalization without changing the committed world", async () => {
    const fixture = await createFixture()
    const failingVcs: HistoryVcsPort = {
      writeSnapshot: () => Promise.reject(new Error("injected Git failure")),
      readSnapshot: () => Promise.reject(new Error("not used")),
    }
    const service = new HistoryService(
      fixture.repository,
      new HistoryManifestBuilder(fixture.repository, new NodeWorkspaceSnapshotAdapter(fixture.workspace)),
      failingVcs,
      () => 500,
    )

    await expect(service.saveAutomatic({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId: randomUUID(),
      name: "失败保存",
      taskId: fixture.taskId,
      createdAtMs: 400,
    })).rejects.toThrow("injected Git failure")

    expect((await fixture.repository.listEntries(fixture.projectId))[0]?.status).toBe("failed")
    expect(await fixture.database.selectFrom("active_scope_refs").select("scope_id").execute())
      .toEqual([{ scope_id: fixture.scopeId }])
    expect((await fixture.database.selectFrom("projects").select("committed_sequence").executeTakeFirst())?.committed_sequence)
      .toBe(1)
    await fixture.database.destroy()
  })

  it("restores the workspace and active world projection from an earlier history entry", async () => {
    const fixture = await createFixture()
    const persistence = new SqliteTurnPersistence(fixture.database, randomUUID)
    const firstTask = await fixture.database.selectFrom("artifact_scopes").select("turn_id")
      .where("id", "=", fixture.scopeId).executeTakeFirstOrThrow()
    const firstContextId = randomUUID()
    await persistence.createContext({
      context: createHistoryTestContext(fixture.projectId, fixture.taskId, firstTask.turn_id, firstContextId),
      createdAtMs: 20,
      updatedAtMs: 20,
    })
    await fixture.database.insertInto("canonical_chapter_messages").values({
      id: randomUUID(),
      project_id: fixture.projectId,
      task_id: fixture.taskId,
      turn_id: firstTask.turn_id,
      context_id: firstContextId,
      source_id: fixture.sourceId,
      chapter_sequence: 1,
      chapter_path: "章节正文/第一卷 测试/第一章 开始.md",
      chapter_heading: "第一章 开始",
      content_ref: join(fixture.workspaceRoot, "chapter.md"),
      content_digest: "chapter-digest",
      created_at: 20,
    }).executeTakeFirstOrThrow()
    const first = await fixture.service.saveAutomatic({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId: randomUUID(),
      name: "第一轮",
      taskId: fixture.taskId,
      createdAtMs: 100,
    })

    const secondTaskId = randomUUID()
    const secondScopeId = randomUUID()
    const secondNodeId = randomUUID()
    const secondChapterId = randomUUID()
    const secondSourceId = randomUUID()
    await new SqliteTaskScopeRepository(fixture.database).create({
      projectId: fixture.projectId,
      taskId: secondTaskId,
      turnId: randomUUID(),
      scopeId: secondScopeId,
      kind: "turn",
      status: "created",
      reason: "Second history fixture",
      configSnapshot: {},
      promptSnapshot: {},
      createdAtMs: 400,
    })
    await new SqliteGraphRepository(fixture.database).stageRevisions(fixture.projectId, secondScopeId, [
      createNodeRevision(randomUUID(), secondScopeId, secondNodeId, "第二轮节点"),
    ])
    await new SqliteDocumentRepository(fixture.database).stageVersion({
      id: randomUUID(),
      projectId: fixture.projectId,
      scopeId: secondScopeId,
      sourceId: secondSourceId,
      chapterId: secondChapterId,
      contentRef: join(fixture.workspaceRoot, "second.md"),
      heading: "第二章 继续",
      publishPath: "章节正文/第一卷 测试/第二章 继续.md",
      digest: "second-chapter-digest",
      createdAtMs: 410,
    })
    await new SqliteScopeCommitRepository(fixture.database).commit(secondScopeId)
    const secondTask = await fixture.database.selectFrom("artifact_scopes").select("turn_id")
      .where("id", "=", secondScopeId).executeTakeFirstOrThrow()
    const secondContextId = randomUUID()
    await persistence.createContext({
      context: createHistoryTestContext(fixture.projectId, secondTaskId, secondTask.turn_id, secondContextId),
      createdAtMs: 410,
      updatedAtMs: 410,
    })
    await fixture.database.insertInto("canonical_chapter_messages").values({
      id: randomUUID(),
      project_id: fixture.projectId,
      task_id: secondTaskId,
      turn_id: secondTask.turn_id,
      context_id: secondContextId,
      source_id: secondSourceId,
      chapter_sequence: 2,
      chapter_path: "章节正文/第一卷 测试/第二章 继续.md",
      chapter_heading: "第二章 继续",
      content_ref: join(fixture.workspaceRoot, "second.md"),
      content_digest: "second-chapter-digest",
      created_at: 410,
    }).executeTakeFirstOrThrow()
    await fixture.workspace.publishChapter(fixture.workspaceRoot, "章节正文/第一卷 测试/第二章 继续.md", "# 第二章 继续\n\n第二轮正文。\n")
    await fixture.workspace.saveUserMarkdown(fixture.workspaceRoot, "设定集/readme.md", "# 第二轮设定索引\n")
    await fixture.database.insertInto("model_context_messages").values({
      id: randomUUID(),
      project_id: fixture.projectId,
      chain_id: fixture.chainId,
      sequence_no: 1,
      role: "user",
      kind: "phase_instruction",
      task_id: secondTaskId,
      turn_id: null,
      phase: null,
      content_text: "第二轮追加内容",
      content_ref: null,
      content_digest: digest("第二轮追加内容"),
      token_estimate: 8,
      origin_phase_run_id: null,
      origin_index: null,
      hidden_at: null,
      created_at: 450,
    }).executeTakeFirstOrThrow()
    await fixture.database.updateTable("model_context_chains").set({ message_count: 2, token_estimate: 16, updated_at: 450 })
      .where("id", "=", fixture.chainId).executeTakeFirstOrThrow()
    const second = await fixture.service.saveAutomatic({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId: randomUUID(),
      name: "第二轮",
      taskId: secondTaskId,
      createdAtMs: 500,
    })

    const checkout = new HistoryCheckoutService(
      fixture.repository,
      fixture.vcs,
      new NodeWorkspaceSnapshotAdapter(fixture.workspace),
      () => 700,
    )
    const previous = await checkout.findPreviousAutomaticEntry(fixture.projectId)
    expect(previous.entryId).toBe(first.entryId)
    const restored = await checkout.checkout({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId: randomUUID(),
      entryId: previous.entryId,
      mode: "return_previous_round",
      startedAtMs: 600,
    })

    expect(restored.entry.entryId).toBe(first.entryId)
    expect(restored.activeGeneration).toBe(1)
    expect((await fixture.repository.readOverview(fixture.projectId)).graphAnchorIds).toEqual([fixture.nodeId])
    expect(await fixture.workspace.readMarkdown(fixture.workspaceRoot, "设定集/readme.md")).toBe("# 设定集索引\n")
    await expect(fixture.workspace.readMarkdown(fixture.workspaceRoot, "章节正文/第一卷 测试/第二章 继续.md")).rejects.toThrow()
    expect(await fixture.database.selectFrom("active_scope_refs").select("scope_id").orderBy("scope_id").execute())
      .toEqual([{ scope_id: fixture.scopeId }])
    expect((await new SqliteDocumentRepository(fixture.database).listCommittedChapters(fixture.projectId)).map((chapter) => chapter.chapterId))
      .toEqual([fixture.chapterId])
    expect(await fixture.database.selectFrom("canonical_chapter_messages").select("chapter_sequence")
      .where("project_id", "=", fixture.projectId).orderBy("chapter_sequence").execute())
      .toEqual([{ chapter_sequence: 1 }])
    expect(await new SqliteGraphRepository(fixture.database).getNode({ projectId: fixture.projectId }, secondNodeId)).toBeUndefined()
    expect(await new SqliteGraphRepository(fixture.database).getNode({ projectId: fixture.projectId }, fixture.nodeId)).toBeDefined()
    const restoredChains = await fixture.database.selectFrom("model_context_chains").selectAll().execute()
    expect(restoredChains).toHaveLength(1)
    expect(restoredChains[0]?.id).toBe(fixture.chainId)
    expect((await new SqliteTurnPersistence(fixture.database).listModelContextMessages(fixture.chainId)).map((message) => message.content))
      .toEqual(["锁定系统规则"])
    const writableBranch = await fixture.repository.ensureWritableBranch(fixture.projectId, 800)
    const repeatedWritableBranch = await fixture.repository.ensureWritableBranch(fixture.projectId, 900)
    expect(writableBranch).toMatchObject({
      parentBranchId: restored.branch.branchId,
      forkEntryId: first.entryId,
      name: "世界线 2",
    })
    expect(repeatedWritableBranch?.branchId).toBe(writableBranch?.branchId)
    expect(await fixture.repository.listBranches(fixture.projectId)).toHaveLength(2)

    await fixture.database.insertInto("model_context_messages").values({
      id: randomUUID(),
      project_id: fixture.projectId,
      chain_id: fixture.chainId,
      sequence_no: 1,
      role: "user",
      kind: "phase_instruction",
      task_id: fixture.taskId,
      turn_id: null,
      phase: null,
      content_text: "分支世界线内容",
      content_ref: null,
      content_digest: digest("分支世界线内容"),
      token_estimate: 8,
      origin_phase_run_id: null,
      origin_index: null,
      hidden_at: null,
      created_at: 910,
    }).executeTakeFirstOrThrow()
    await fixture.database.updateTable("model_context_chains").set({ message_count: 2, token_estimate: 16, updated_at: 910 })
      .where("id", "=", fixture.chainId).executeTakeFirstOrThrow()
    const branchEntry = await fixture.service.saveAutomatic({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId: randomUUID(),
      name: "分支轮",
      taskId: fixture.taskId,
      createdAtMs: 920,
    })

    await checkout.checkout({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId: randomUUID(),
      entryId: second.entryId,
      mode: "restore",
      startedAtMs: 930,
    })
    expect((await new SqliteTurnPersistence(fixture.database).listModelContextMessages(fixture.chainId)).map((message) => message.content))
      .toEqual(["锁定系统规则", "第二轮追加内容"])

    await checkout.checkout({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId: randomUUID(),
      entryId: branchEntry.entryId,
      mode: "restore",
      startedAtMs: 940,
    })
    expect((await new SqliteTurnPersistence(fixture.database).listModelContextMessages(fixture.chainId)).map((message) => message.content))
      .toEqual(["锁定系统规则", "分支世界线内容"])
    await fixture.database.destroy()
  })

  it("previews and removes the oldest ready entries when retention is finite", async () => {
    const fixture = await createFixture()
    const entries = []
    for (let index = 1; index <= 4; index += 1) {
      entries.push(await fixture.service.saveManual({
        projectId: fixture.projectId,
        workspaceRootRef: fixture.workspaceRoot,
        operationId: randomUUID(),
        name: `手动保存 ${String(index)}`,
        taskId: fixture.taskId,
        createdAtMs: 100 * index,
      }, false))
    }

    const preview = await fixture.repository.previewRetention(fixture.projectId, 2)
    expect(preview).toMatchObject({ currentCount: 4, deleteCount: 2, retentionLimit: 2 })
    await new HistoryRetentionService(fixture.repository, fixture.vcs, () => 600).apply(fixture.projectId, 2)
    expect((await fixture.repository.listEntries(fixture.projectId)).map((entry) => entry.entryId))
      .toEqual([entries[3]?.entryId, entries[2]?.entryId])
    expect(await fixture.database.selectFrom("history_retention_events").selectAll().execute()).toHaveLength(2)
    const retainedRows = await fixture.database.selectFrom("history_entries").selectAll()
      .where("project_id", "=", fixture.projectId).orderBy("created_at", "asc").execute()
    const baseline = await fixture.vcs.readSnapshot(retainedRows[0]?.git_commit_oid as string)
    const latest = await fixture.vcs.readSnapshot(retainedRows[1]?.git_commit_oid as string)
    expect(baseline.parentCommitOids).toEqual([])
    expect(baseline.manifest.parentEntryId).toBeUndefined()
    expect(latest.parentCommitOids).toEqual([baseline.commitOid])
    expect(await fixture.repository.previewRetention(fixture.projectId, 2)).toMatchObject({ currentCount: 2, deleteCount: 0 })
    await expect(fixture.repository.beginCheckout({
      projectId: fixture.projectId,
      operationId: randomUUID(),
      entryId: entries[0]?.entryId as string,
      mode: "restore",
      startedAtMs: 700,
    })).rejects.toThrow("not ready or was not found")
    await fixture.database.destroy()
  })

  it("freezes a manual checkpoint model chain at the selected stable phase", async () => {
    const fixture = await createFixture()
    const contextId = randomUUID()
    const firstPhaseRunId = randomUUID()
    const laterPhaseRunId = randomUUID()
    const scope = await fixture.database.selectFrom("artifact_scopes").select("turn_id")
      .where("id", "=", fixture.scopeId).executeTakeFirstOrThrow()
    const context = {
      contextId,
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      turnId: scope.turn_id,
      taskKind: "turn" as const,
      protocolVersion: "worldseed.v1" as const,
      baseCommittedSequence: 0,
      segments: [],
      readLedger: { committedReadIds: [], visiblePendingIds: [], requestedReadIds: [], returnedReadIds: [], rejectedReadIds: [], readReasons: {} },
      budget: { maxTokens: 1_000, usedTokens: 0 },
    }
    const persistence = new SqliteTurnPersistence(fixture.database, randomUUID)
    await persistence.createContext({ context, createdAtMs: 30, updatedAtMs: 30 })
    await persistence.initializeRuntimeBudgetWindows({
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      limits: { model_calls: 10, input_tokens: null, output_tokens: null, wall_time: 10_000 },
      createdAtMs: 30,
    })
    for (const [phaseRunId, phase, startedAtMs] of [
      [firstPhaseRunId, "interpret", 40],
      [laterPhaseRunId, "rule_assembly", 60],
    ] as const) {
      const envelopeId = randomUUID()
      await fixture.database.insertInto("phase_runs").values({
        id: phaseRunId,
        project_id: fixture.projectId,
        task_id: fixture.taskId,
        context_id: contextId,
        phase,
        attempt: 1,
        status: "completed",
        request_json: JSON.stringify({
          schemaVersion: 1,
          envelopeId,
          projectId: fixture.projectId,
          taskId: fixture.taskId,
          turnId: scope.turn_id,
          contextId,
          scopeId: fixture.scopeId,
          phase,
          protocolVersion: "worldseed.v1",
          promptRef: `phase:${phase}`,
          promptDigest: `digest:${phase}`,
          contextViewRef: `context:${contextId}`,
          committedReadIds: [],
          visiblePendingIds: [],
          remainingBudget: {
            maxCalls: 10,
            remainingCalls: 9,
            maxInputTokens: 1_000,
            remainingInputTokens: 900,
            maxOutputTokens: 1_000,
            remainingOutputTokens: 900,
            deadlineAtMs: 10_000,
          },
          input: {
            workflow: "turn",
            userInput: "恢复检查点测试",
            chapterSequence: 1,
            allowWorkspaceChapterReads: true,
            sourceId: fixture.sourceId,
            sourceUnitIds: [],
            phaseRunIds: phase === "interpret" ? [] : [firstPhaseRunId],
            readEvidence: [],
            retrievalGaps: [],
            artifacts: {},
          },
        }),
        result_json: JSON.stringify({
          schemaVersion: 1,
          envelopeId,
          contextId,
          phase,
          outcome: "continue",
          artifact: {},
          requestedReads: [],
          citedReadIds: [],
          producedArtifactIds: [],
          decisionRecordIds: [],
          unresolvedDependencies: [],
          reason: "测试阶段已完成",
          selfReview: "测试信封合法",
        }),
        usage_json: JSON.stringify({ modelCalls: 1 }),
        started_at: startedAtMs,
        finished_at: startedAtMs + 10,
      }).executeTakeFirstOrThrow()
    }
    await fixture.database.insertInto("model_context_messages").values([
      {
        id: randomUUID(), project_id: fixture.projectId, chain_id: fixture.chainId, sequence_no: 1,
        role: "assistant", kind: "phase_response", task_id: fixture.taskId, turn_id: scope.turn_id, phase: "interpret",
        content_text: "稳定阶段输出", content_ref: null, content_digest: digest("稳定阶段输出"), token_estimate: 4,
        origin_phase_run_id: firstPhaseRunId, origin_index: 0, hidden_at: null, created_at: 50,
      },
      {
        id: randomUUID(), project_id: fixture.projectId, chain_id: fixture.chainId, sequence_no: 2,
        role: "assistant", kind: "phase_response", task_id: fixture.taskId, turn_id: scope.turn_id, phase: "rule_assembly",
        content_text: "检查点之后的输出", content_ref: null, content_digest: digest("检查点之后的输出"), token_estimate: 4,
        origin_phase_run_id: laterPhaseRunId, origin_index: 0, hidden_at: null, created_at: 70,
      },
    ]).executeTakeFirstOrThrow()
    await fixture.database.updateTable("model_context_chains").set({ message_count: 3, token_estimate: 12, updated_at: 70 })
      .where("id", "=", fixture.chainId).executeTakeFirstOrThrow()
    await fixture.database.insertInto("task_checkpoints").values({
      id: firstPhaseRunId,
      project_id: fixture.projectId,
      task_id: fixture.taskId,
      phase_run_id: firstPhaseRunId,
      context_id: contextId,
      phase: "interpret",
      model_context_chain_id: fixture.chainId,
      model_context_sequence: 1,
      context_json: JSON.stringify(context),
      budget_windows_json: JSON.stringify([
        { metricId: "model_calls", current: 1, limit: 10, generation: 0, startedAtMs: 30, lastResetAt: null },
        { metricId: "input_tokens", current: 0, limit: null, generation: 0, startedAtMs: 30, lastResetAt: null },
        { metricId: "output_tokens", current: 0, limit: null, generation: 0, startedAtMs: 30, lastResetAt: null },
        { metricId: "wall_time", current: 10, limit: 10_000, generation: 0, startedAtMs: 30, lastResetAt: null },
      ]),
      created_at: 50,
      updated_at: 50,
    }).executeTakeFirstOrThrow()
    await fixture.database.insertInto("task_checkpoint_heads").values({
      task_id: fixture.taskId,
      project_id: fixture.projectId,
      checkpoint_id: firstPhaseRunId,
      updated_at: 50,
    }).executeTakeFirstOrThrow()
    const laterContext = { ...context, budget: { ...context.budget, usedTokens: 500 } }
    await fixture.database.updateTable("turn_contexts").set({
      context_json: JSON.stringify(laterContext),
      token_usage_json: JSON.stringify(laterContext.budget),
      updated_at: 70,
    }).where("id", "=", contextId).executeTakeFirstOrThrow()

    const entry = await fixture.service.saveManual({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId: randomUUID(),
      name: "稳定阶段保存",
      taskId: fixture.taskId,
      checkpointId: firstPhaseRunId,
      createdAtMs: 80,
    }, true)
    const row = await fixture.database.selectFrom("history_entries").select("git_commit_oid")
      .where("id", "=", entry.entryId).executeTakeFirstOrThrow()
    const snapshot = await fixture.vcs.readSnapshot(row.git_commit_oid as string)

    expect(snapshot.manifest.modelContext?.messages.map((message) => message.content)).toEqual([
      "锁定系统规则",
      "稳定阶段输出",
    ])
    const checkout = new HistoryCheckoutService(
      fixture.repository,
      fixture.vcs,
      new NodeWorkspaceSnapshotAdapter(fixture.workspace),
      () => 100,
    )
    const restored = await checkout.checkout({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId: randomUUID(),
      entryId: entry.entryId,
      mode: "restore",
      startedAtMs: 90,
    })
    expect(restored.restoredTaskId).toBeDefined()
    expect(restored.restoredTaskId).not.toBe(fixture.taskId)
    expect(await fixture.database.selectFrom("phase_runs").select("status")
      .where("id", "=", laterPhaseRunId).executeTakeFirstOrThrow()).toEqual({ status: "completed" })
    expect(await fixture.database.selectFrom("tasks").select(["status", "last_phase"])
      .where("id", "=", fixture.taskId).executeTakeFirstOrThrow()).toEqual({ status: "created", last_phase: null })
    expect(await fixture.database.selectFrom("tasks").select(["status", "last_phase"])
      .where("id", "=", restored.restoredTaskId as string).executeTakeFirstOrThrow())
      .toEqual({ status: "paused", last_phase: "interpret" })
    const restoredContext = await new SqliteTurnPersistence(fixture.database)
      .findContextByTask(restored.restoredTaskId as string)
    expect(restoredContext?.budget.usedTokens).toBe(0)
    expect(await fixture.database.selectFrom("model_context_messages").select("origin_phase_run_id")
      .where("content_text", "=", "稳定阶段输出").executeTakeFirstOrThrow())
      .toEqual({ origin_phase_run_id: firstPhaseRunId })
    const restoredMetrics = await persistence.listRuntimeMetrics(restored.restoredTaskId as string, 100)
    expect(restoredMetrics.metrics.find((metric) => metric.metricId === "model_calls")).toMatchObject({
      current: 1,
      cumulative: 1,
      limit: 10,
    })
    await fixture.database.destroy()
  })
})

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "worldseed-history-service-"))
  temporaryDirectories.push(root)
  const workspaceRoot = join(root, "workspace")
  const internalRoot = join(root, "app-data")
  const workspace = new NodeWorkspaceAdapter()
  await workspace.createLayout(workspaceRoot, {
    baseRules: "# 基础规则\n",
    plotSynopsisGuide: "# 剧情梗概讨论引导\n",
    settingsQueryGuide: "# 设定集默认查询规则\n",
    settingsRevisionGuide: "# 设定集修订规则\n",
    settingsReadme: "# 设定集索引\n",
    referencesReadme: "# 参考文件索引\n",
    descriptionRules: "# 描写规则\n",
    proseStyleRules: "# 笔风规则\n",
    stagingReadme: "# 暂存区\n",
    stagingNotes: "# 本章讨论笔记\n",
    stagingCharacters: "# 人物草稿\n",
    stagingWorld: "# 世界与规则草稿\n",
    stagingPromoteIndex: "# 待落盘清单\n",
  })
  const database = await openProjectDatabase(join(internalRoot, "project.sqlite"))
  const projectId = randomUUID()
  const taskId = randomUUID()
  const turnId = randomUUID()
  const scopeId = randomUUID()
  const sourceId = randomUUID()
  const chapterId = randomUUID()
  const documentId = randomUUID()
  const nodeId = randomUUID()
  const manifest: ProjectManifest = {
    id: projectId,
    protocolVersion: "worldseed.v1",
    manifestVersion: 1,
    displayName: "History Test",
    workspaceRootRef: workspaceRoot,
    fixedEntries: fixedWorkspaceEntries,
    internalStoreRef: internalRoot,
    manifestDigest: digest(fixedWorkspaceEntries),
  }
  await new SqliteProjectRepository(database, workspaceRoot, internalRoot).create({
    projectId,
    name: "History Test",
    manifestVersion: 1,
    committedSequence: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  }, manifest)
  await new SqliteTaskScopeRepository(database).create({
    projectId,
    taskId,
    turnId,
    scopeId,
    kind: "turn",
    status: "created",
    reason: "History fixture",
    configSnapshot: {},
    promptSnapshot: {},
    createdAtMs: 10,
  })
  const chain = await new SqliteTurnPersistence(database, randomUUID).ensureModelContextChain({
    projectId,
    protocolVersion: "worldseed.v1",
    systemRulesContent: "锁定系统规则",
    systemRulesDigest: digest("锁定系统规则"),
    createdAtMs: 10,
  })
  await new SqliteDocumentRepository(database).stageVersion({
    id: documentId,
    projectId,
    scopeId,
    sourceId,
    chapterId,
    contentRef: join(internalRoot, "chapter.md"),
    heading: "第一章 开始",
    publishPath: "章节正文/第一卷 测试/第一章 开始.md",
    digest: "chapter-digest",
    createdAtMs: 20,
  })
  await new SqliteGraphRepository(database).stageRevisions(projectId, scopeId, [
    createNodeRevision(randomUUID(), scopeId, nodeId, "第一轮节点"),
  ])
  await new SqliteScopeCommitRepository(database).commit(scopeId)
  await workspace.publishChapter(workspaceRoot, "章节正文/第一卷 测试/第一章 开始.md", "# 第一章 开始\n\n正文。\n")
  const repository = new SqliteHistoryRepository(database, randomUUID)
  const vcs = new IsomorphicGitHistoryAdapter(join(internalRoot, "history.git"))
  const service = new HistoryService(
    repository,
    new HistoryManifestBuilder(repository, new NodeWorkspaceSnapshotAdapter(workspace)),
    vcs,
    () => 300,
  )
  return {
    database,
    workspace,
    workspaceRoot,
    projectId,
    taskId,
    scopeId,
    sourceId,
    chapterId,
    nodeId,
    chainId: chain.chainId,
    repository,
    vcs,
    service,
  }
}

function createNodeRevision(revisionId: string, scopeId: string, nodeId: string, label: string): GraphRevision {
  return {
    revisionId,
    scopeId,
    targetKind: "node",
    targetId: nodeId,
    operation: "create",
    before: null,
    after: { id: nodeId, content: { label } },
    archiveOutletIds: [],
    reason: "History checkout fixture",
    selfReview: "The node remains generic and recoverable",
    evidenceIds: [],
    createdAtMs: 20,
  }
}

function createHistoryTestContext(projectId: string, taskId: string, turnId: string, contextId: string) {
  return {
    contextId,
    projectId,
    taskId,
    turnId,
    taskKind: "turn" as const,
    protocolVersion: "worldseed.v1" as const,
    baseCommittedSequence: 0,
    segments: [],
    readLedger: {
      committedReadIds: [],
      visiblePendingIds: [],
      requestedReadIds: [],
      returnedReadIds: [],
      rejectedReadIds: [],
      readReasons: {},
    },
    budget: { maxTokens: 1_000, usedTokens: 0 },
  }
}
