import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { defaultProjectSettings } from "@worldseed/config"
import { graphGovernanceArtifactSchema } from "@worldseed/prompt-contracts"

import {
  NodeInternalStoreAdapter,
  NodePromptResourceAdapter,
  NodeWorkspaceAdapter,
  NodeWorkspaceCatalogAdapter,
  ProjectLifecycleService,
  SqliteDocumentRepository,
  SqliteEvidenceStore,
  SqliteGraphRepository,
  SqliteProjectRegistryRepository,
  SqliteProjectRepositoryFactory,
  SqliteRetrievalRepository,
  SqliteScopeCommitRepository,
  SqliteTaskScopeRepository,
  SqliteTurnPersistence,
  SqliteWorkspaceCatalogSnapshotRepository,
  TurnOrchestrator,
  FakeAiModelAdapter,
  createRetrievalGaps,
  openProjectDatabase,
  openRegistryDatabase,
  type AIModelPort,
  type ScopeCommitRepository,
  type TurnPhaseInput,
} from "../src/index.js"

const temporaryDirectories: string[] = []
const openDatabases: Array<{ destroy(): Promise<void> }> = []

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    await database.destroy()
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

describe("TurnOrchestrator", () => {
  it("loads mandatory workspace documents before the first model call", async () => {
    const fixture = await createFixture()
    await fixture.workspace.saveUserMarkdown(
      fixture.workspaceRoot,
      "世界推演规则/用户规则/角色出场.md",
      "# 角色出场\n\n用户指定的角色出场规则。\n",
    )
    await fixture.workspace.saveUserMarkdown(
      fixture.workspaceRoot,
      "表现输出/描写规则/近景跟随.md",
      "# 近景跟随\n\n保持贴近当前行动主体的观察距离。\n",
    )
    const fake = new FakeAiModelAdapter(randomUUID)
    let interpretInput: TurnPhaseInput | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: (request) => {
        if (request.phase === "interpret") interpretInput = request.input as TurnPhaseInput
        return fake.execute(request)
      },
    }

    await fixture.createOrchestrator(model, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "开始第一章。",
      chapterSequence: 1,
      presentation: {
        descriptionRulePath: "表现输出/描写规则/近景跟随.md",
        minimumWordCount: 2000,
        maximumWordCount: 3000,
      },
      projectSettings: defaultProjectSettings,
    })

    expect(interpretInput?.readEvidence.map((evidence) => evidence.ownerId)).toEqual(expect.arrayContaining([
      "世界推演规则/用户规则/角色出场.md",
      "设定集/readme.md",
      "参考文件/readme.md",
      "表现输出/描写规则/近景跟随.md",
    ]))
    expect(interpretInput?.readEvidence.find((evidence) => evidence.ownerId.endsWith("角色出场.md"))?.semanticText)
      .toContain("用户指定的角色出场规则")
    expect(interpretInput?.presentation).toMatchObject({ minimumWordCount: 2000, maximumWordCount: 3000 })
    expect(interpretInput?.readEvidence.find((evidence) => evidence.ownerId === "表现输出/描写规则/近景跟随.md")?.semanticText)
      .toContain("保持贴近当前行动主体")
    const context = await fixture.persistence.findContext((await fixture.database.selectFrom("turn_contexts").select("id").executeTakeFirstOrThrow()).id)
    expect(context?.segments.some((segment) => segment.kind === "presentation_rules")).toBe(true)
  })

  it("loads default presentation rules when automatic presentation is selected", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let interpretInput: TurnPhaseInput | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        if (request.phase === "interpret") interpretInput = request.input as TurnPhaseInput
        return fake.execute(request)
      },
    }

    await fixture.createOrchestrator(model, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "开始第一章。",
      chapterSequence: 1,
      presentation: {
        minimumWordCount: 2000,
        maximumWordCount: 3000,
      },
    })

    expect(interpretInput?.readEvidence.map((evidence) => evidence.ownerId)).toEqual(expect.arrayContaining([
      "表现输出/描写规则/默认描写规则.md",
      "表现输出/笔风规则/默认笔风规则.md",
    ]))
    expect(interpretInput?.readEvidence.find((evidence) => evidence.ownerId === "表现输出/描写规则/默认描写规则.md")?.ownerKind)
      .toBe("workspace:presentation")
  })

  it("rejects an existing graph reference that was not read in the current turn", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const unreadNodeId = randomUUID()
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        const execution = await fake.execute(request)
        if (request.phase !== "graph_governance") return execution
        const governance = graphGovernanceArtifactSchema.parse(execution.result.artifact)
        const mutationIndex = governance.mutations.length
        return {
          ...execution,
          result: {
            ...execution.result,
            artifact: {
              ...governance,
              mutations: [
                ...governance.mutations,
                { operation: "edit_node", nodeRef: unreadNodeId, next: { content: { changed: true } } },
              ],
              mutationSpacetimeSettlements: governance.mutationSpacetimeSettlements.map((settlement, index) => (
                index === 0
                  ? { ...settlement, mutationIndexes: [...settlement.mutationIndexes, mutationIndex] }
                  : settlement
              )),
              decisionRecords: governance.decisionRecords.map((record, index) => (
                index === 0
                  ? { ...record, mutationIndexes: [...record.mutationIndexes, mutationIndex] }
                  : record
              )),
            },
          },
        }
      },
    }

    await expect(fixture.createOrchestrator(model, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "修改一个从未读取的对象。",
      chapterSequence: 1,
    })).rejects.toThrow(`Graph governance references must be readable graph owners or declared local handles: ${unreadNodeId}`)
  })

  it("represents exhausted retrieval as a non-citable gap instead of read evidence", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let interpretAttempts = 0
    let exhaustedRequestId = ""
    let ruleAssemblyInput: TurnPhaseInput | undefined
    const events: Array<{ event: string; fields?: Readonly<Record<string, unknown>> }> = []
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        const execution = await fake.execute(request)
        if (request.phase === "interpret") {
          interpretAttempts += 1
          exhaustedRequestId = randomUUID()
          return {
            ...execution,
            result: {
              ...execution.result,
              outcome: "request_read",
              requestedReads: [{
                requestId: exhaustedRequestId,
                reason: "Resolve the current scene anchor",
                expectedEvidence: "A persisted current scene anchor",
                query: {
                  exactKeys: ["current scene"],
                  semanticTexts: ["current scene anchor"],
                  anchorIds: [],
                  directions: ["both"],
                  maxCandidates: 10,
                  maxDepth: 2,
                  sourceKinds: ["graph"],
                },
              }],
            },
          }
        }
        if (request.phase === "rule_assembly") ruleAssemblyInput = request.input as TurnPhaseInput
        return execution
      },
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit, {
      log: (_level, event, fields) => events.push({ event, fields }),
    })

    await orchestrator.execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "我观察周围。",
      chapterSequence: 1,
    })

    expect(interpretAttempts).toBe(1)
    expect(ruleAssemblyInput?.readEvidence.map((evidence) => evidence.ownerId)).toEqual([
      "参考文件/readme.md",
      "设定集/readme.md",
    ])
    expect(ruleAssemblyInput?.retrievalGaps).toEqual([{
      typeId: "system:retrieval-gap",
      requestId: exhaustedRequestId,
      expectedEvidence: "A persisted current scene anchor",
      reason: "Resolve the current scene anchor",
      query: {
        exactKeys: ["current scene"],
        semanticTexts: ["current scene anchor"],
        anchorIds: [],
        directions: ["both"],
        maxCandidates: 10,
        maxDepth: 2,
        sourceKinds: ["graph"],
      },
    }])
    expect(events).toContainEqual(expect.objectContaining({
      event: "retrieval.gaps.recorded",
      fields: expect.objectContaining({
        typeId: "system:retrieval-gap",
        requestIds: [exhaustedRequestId],
      }),
    }))
  })

  it("creates traceable retrieval gaps without source identifiers", () => {
    const requestId = randomUUID()
    const [gap] = createRetrievalGaps([{
      requestId,
      reason: "No matching history was found",
      expectedEvidence: "The named historical event",
      query: {
        exactKeys: ["historical event"],
        semanticTexts: [],
        anchorIds: [],
        directions: ["both"],
        maxCandidates: 10,
        maxDepth: 2,
        sourceKinds: ["graph", "source"],
      },
    }])

    expect(gap).toMatchObject({
      typeId: "system:retrieval-gap",
      requestId,
      expectedEvidence: "The named historical event",
    })
    expect(gap).not.toHaveProperty("readId")
  })

  it("publishes when commit review recommends revision", async () => {
    const fixture = await createFixture()
    let modelCalls = 0
    const fake = new FakeAiModelAdapter(randomUUID)
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        modelCalls += 1
        const execution = await fake.execute(request)
        if (request.phase !== "commit_review") return execution
        return {
          ...execution,
          result: {
            ...execution.result,
            outcome: "reject",
            artifact: {
              ...(execution.result.artifact as Record<string, unknown>),
              recommendation: "revise",
              finalSelfReview: "建议后续补充连续性说明，但不阻断本轮提交",
            },
          },
        }
      },
    }
    let observedPending = false
    const commit: ScopeCommitRepository = {
      commit: async (scopeId) => {
        const pendingNodes = await fixture.database.selectFrom("nodes").selectAll()
          .where("scope_id", "=", scopeId).where("visibility", "=", "pending").execute()
        const pendingDocuments = await fixture.database.selectFrom("document_versions").selectAll()
          .where("scope_id", "=", scopeId).where("visibility", "=", "pending").execute()
        const pendingProjections = await fixture.database.selectFrom("retrieval_projections").selectAll()
          .where("scope_id", "=", scopeId).where("visibility", "=", "pending").execute()
        observedPending = pendingNodes.length > 0 && pendingDocuments.length > 0 && pendingProjections.length > 0
        return fixture.commit.commit(scopeId)
      },
      retire: (scopeId, retiredAtMs) => fixture.commit.retire(scopeId, retiredAtMs),
    }
    const orchestrator = fixture.createOrchestrator(model, commit)

    const result = await orchestrator.execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "林序在旧桥下发现一枚旧铜钥匙。",
      chapterSequence: 1,
      projectSettings: defaultProjectSettings,
    })

    expect(modelCalls).toBe(13)
    expect(result.modelCalls).toBe(13)
    expect(result.modelProvider).toBe("fake")
    expect(result.modelName).toBe("deterministic-contract-fixture")
    expect(result.kvCacheHitRate).toBeCloseTo(0.5, 2)
    expect(observedPending).toBe(true)
    expect(result.graphAnchorIds.every((id) => /^[0-9a-f-]{36}$/u.test(id))).toBe(true)
    const storedGraphIds = [
      ...(await fixture.database.selectFrom("nodes").select("id").execute()).map((row) => row.id),
      ...(await fixture.database.selectFrom("links").select("id").execute()).map((row) => row.id),
    ]
    expect(storedGraphIds.some((id) => id.startsWith("local:"))).toBe(false)
    const storedGraphPayloads = await fixture.database.selectFrom("nodes")
      .select(["id", "content_json", "metadata_json"]).execute()
    expect(JSON.stringify(storedGraphPayloads)).not.toContain("local:")
    const occurrence = storedGraphPayloads.find((row) => row.id === result.graphAnchorIds[0])
    const occurrenceContent = JSON.parse(occurrence?.content_json ?? "{}") as Record<string, unknown>
    expect(result.graphAnchorIds).toContain(occurrenceContent.timeRef)
    expect(result.graphAnchorIds).toContain(occurrenceContent.locationRef)
    expect(readdirSync(join(fixture.workspaceRoot, "章节正文"))).toEqual(["第一章 世界种子.md"])
    const chapter = readFileSync(join(fixture.workspaceRoot, result.chapterPath), "utf8")
    expect(chapter.split("\n", 1)[0]).toBe(result.chapterHeading)

    expect(await fixture.documentRepository.listCommittedChapters(fixture.projectId)).toHaveLength(1)
    expect(await fixture.retrievalRepository.searchExact({ projectId: fixture.projectId }, [result.chapterHeading], 10)).toHaveLength(1)
    const phaseRuns = await fixture.persistence.listPhaseRuns(result.taskId)
    const context = await fixture.persistence.findContext(result.contextId)
    const retrievalRequest = phaseRuns.find((run) => run.phase === "source_retrieval")?.request as {
      remainingBudget?: { retrievalExecutionDeadlineAtMs?: number; retrievalPhaseDeadlineAtMs?: number }
    }
    expect(phaseRuns).toHaveLength(13)
    expect(retrievalRequest.remainingBudget?.retrievalExecutionDeadlineAtMs).toBeTypeOf("number")
    expect(retrievalRequest.remainingBudget?.retrievalPhaseDeadlineAtMs).toBeTypeOf("number")
    expect(context?.segments).toHaveLength(16)
    expect(context?.budget.maxTokens).toBe(950_000)
    expect(context?.ruleSnapshotId).toBeDefined()
    expect(await fixture.database.selectFrom("ai_decision_records").selectAll().execute()).toHaveLength(1)
    expect(await fixture.database.selectFrom("settlement_records").selectAll().execute()).toHaveLength(4)
    expect(await fixture.database.selectFrom("scene_spacetime_bindings").selectAll().execute()).toEqual([
      expect.objectContaining({ scene_index: 0, visibility: "committed" }),
    ])
    expect(await fixture.database.selectFrom("graph_revision_spacetime").selectAll().execute()).toHaveLength(5)
    expect(await fixture.database.selectFrom("frontier_refs").selectAll().execute()).toEqual([
      expect.objectContaining({ disposition: "active" }),
    ])
    expect(await fixture.database.selectFrom("kv_usage").selectAll().execute()).toHaveLength(13)
    expect((await fixture.taskScopes.findTask(result.taskId))?.status).toBe("completed")
    expect((await fixture.taskScopes.findScope(result.scopeId))?.visibility).toBe("committed")
  })

  it("rejects a draft placeholder at the draft phase instead of publishing it", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const events: Array<{ event: string; fields?: Readonly<Record<string, unknown>> }> = []
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        const execution = await fake.execute(request)
        if (request.phase !== "draft") return execution
        return {
          ...execution,
          result: {
            ...execution.result,
            artifact: {
              ...(execution.result.artifact as Record<string, unknown>),
              contentMarkdown: "（等待读取型月世界设定与间桐慎二相关背景资料，尚未开始撰写正文。）",
            },
          },
        }
      },
    }

    await expect(fixture.createOrchestrator(model, fixture.commit, {
      log: (_level, event, fields) => events.push({ event, fields }),
    }).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "观察周围环境。",
      chapterSequence: 1,
    })).rejects.toThrow("Draft content is a waiting/refusal placeholder")

    expect(events).toContainEqual(expect.objectContaining({
      event: "draft.placeholder_rejected",
      fields: expect.objectContaining({ phase: "draft" }),
    }))
    expect(readdirSync(join(fixture.workspaceRoot, "章节正文"))).toEqual([])
    const failedTaskId = events.find((event) => event.event === "turn.failed")?.fields?.taskId
    expect(typeof failedTaskId).toBe("string")
    expect((await fixture.taskScopes.findTask(String(failedTaskId)))?.status).toBe("failed")
  })

  it("keeps the pending scope and does not publish when the model fails", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let calls = 0
    const model: AIModelPort = {
      execute: (request) => {
        calls += 1
        if (request.phase === "graph_governance") {
          return Promise.reject(new Error("simulated model failure"))
        }
        return fake.execute(request)
      },
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit)

    await expect(orchestrator.execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "用户要求改变尚未成为事实的走向。",
      chapterSequence: 1,
    })).rejects.toThrow("simulated model failure")

    expect(calls).toBe(9)
    expect(readdirSync(join(fixture.workspaceRoot, "章节正文"))).toEqual([])
    const failedTask = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    expect(failedTask.status).toBe("failed")
    expect((await fixture.persistence.listPhaseRuns(failedTask.id)).at(-1)?.status).toBe("failed")
    expect((await fixture.database.selectFrom("artifact_scopes").selectAll().executeTakeFirstOrThrow()).visibility).toBe("pending")
    expect(await fixture.documentRepository.listCommittedChapters(fixture.projectId)).toEqual([])
  })
})

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "worldseed-turn-"))
  temporaryDirectories.push(root)
  const workspaceRoot = join(root, "workspace")
  const applicationDataRoot = join(root, "application-data")
  const projectId = randomUUID()
  const registryDatabase = await openRegistryDatabase(join(root, "registry.sqlite"))
  openDatabases.push(registryDatabase)
  const lifecycle = new ProjectLifecycleService(
    new SqliteProjectRegistryRepository(registryDatabase),
    new NodeWorkspaceAdapter(),
    new NodeInternalStoreAdapter(applicationDataRoot),
    new SqliteProjectRepositoryFactory(),
  )
  const created = await lifecycle.create({
    projectId,
    displayName: "Turn test",
    workspaceRootRef: workspaceRoot,
    defaults: {
      baseRules: "# base\n",
      settingsReadme: "# settings\n",
      referencesReadme: "# references\n",
      descriptionRules: "# description\n",
      proseStyleRules: "# prose\n",
    },
    nowMs: 1,
  })
  const database = await openProjectDatabase(created.internalStore.projectDatabaseRef)
  openDatabases.push(database)
  const taskScopes = new SqliteTaskScopeRepository(database)
  const persistence = new SqliteTurnPersistence(database, randomUUID)
  const documentRepository = new SqliteDocumentRepository(database)
  const graphRepository = new SqliteGraphRepository(database)
  const retrievalRepository = new SqliteRetrievalRepository(database)
  const commit = new SqliteScopeCommitRepository(database)
  const promptRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
  const fixture = {
    root,
    projectId,
    workspaceRoot,
    store: created.internalStore,
    database,
    taskScopes,
    persistence,
    documentRepository,
    graphRepository,
    retrievalRepository,
    commit,
    workspace: new NodeWorkspaceAdapter(),
    createOrchestrator(
      model: AIModelPort,
      commitRepository: ScopeCommitRepository,
      diagnostics?: { log(level: "debug" | "info" | "warn" | "error", event: string, fields?: Readonly<Record<string, unknown>>): void },
    ) {
      return new TurnOrchestrator({
        taskScopes,
        persistence,
        model,
        prompts: new NodePromptResourceAdapter(promptRoot),
        documents: documentRepository,
        graph: graphRepository,
        retrieval: retrievalRepository,
        catalog: new NodeWorkspaceCatalogAdapter(new NodeWorkspaceAdapter()),
        catalogSnapshots: new SqliteWorkspaceCatalogSnapshotRepository(database),
        evidence: new SqliteEvidenceStore(
          database,
          new NodeInternalStoreAdapter(applicationDataRoot),
          created.internalStore,
        ),
        commit: commitRepository,
        internalStore: new NodeInternalStoreAdapter(applicationDataRoot),
        workspace: new NodeWorkspaceAdapter(),
        createId: randomUUID,
        now: () => Date.now(),
        diagnostics,
      })
    },
  }
  return fixture
}
