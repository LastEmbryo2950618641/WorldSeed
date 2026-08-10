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

  it("inherits the latest graph projection when an edited owner omits a new projection", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const first = await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "林序在旧桥下发现一枚旧铜钥匙。",
      chapterSequence: 1,
    })
    const ownerId = first.graphAnchorIds[0]
    if (ownerId === undefined) throw new Error("The first turn did not create a graph anchor")

    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        const execution = await fake.execute(request)
        if (request.phase === "interpret") {
          return {
            ...execution,
            result: {
              ...execution.result,
              outcome: "request_read",
              requestedReads: [{
                requestId: randomUUID(),
                reason: "读取旧铜钥匙对应的既有图节点",
                expectedEvidence: "第一轮已经建立的旧铜钥匙节点",
                query: {
                  anchorIds: [],
                  directions: ["both"],
                  exactKeys: ["林序在旧桥下发现一枚旧铜钥匙。"],
                  maxCandidates: 10,
                  maxDepth: 2,
                  semanticTexts: ["旧铜钥匙"],
                  sourceKinds: ["graph"],
                },
              }],
            },
          }
        }
        if (request.phase === "graph_governance") {
          const governance = graphGovernanceArtifactSchema.parse(execution.result.artifact)
          const replaceOccurrence = (reference: string): string => reference === "local:occurrence" ? ownerId : reference
          const mutations = governance.mutations.map((mutation, index) => {
            if (index === 0 && mutation.operation === "create_node") {
              return {
                operation: "edit_node" as const,
                nodeRef: ownerId,
                next: {
                  ...mutation.data,
                  content: { ...asRecordForTest(mutation.data.content), updatedThisTurn: true },
                },
              }
            }
            if (mutation.operation === "create_link") {
              return {
                ...mutation,
                fromRef: replaceOccurrence(mutation.fromRef),
                toRef: replaceOccurrence(mutation.toRef),
              }
            }
            return mutation
          })
          const artifact = {
            ...governance,
            mutations,
            retrievalProjections: [],
            settlementRecords: governance.settlementRecords.map((record) => ({
              ...record,
              graphRefs: record.graphRefs.map((reference) => ({
                ...reference,
                targetRef: replaceOccurrence(reference.targetRef),
              })),
            })),
            mutationSpacetimeSettlements: governance.mutationSpacetimeSettlements.map((settlement) => ({
              ...settlement,
              currentEntryRefs: settlement.currentEntryRefs.map(replaceOccurrence),
              historicalReturnRefs: settlement.historicalReturnRefs.map(replaceOccurrence),
            })),
            sceneSpacetimeBindings: governance.sceneSpacetimeBindings.map((binding) => ({
              ...binding,
              sceneAnchorRef: replaceOccurrence(binding.sceneAnchorRef),
            })),
            affectedFrontierRefs: governance.affectedFrontierRefs.map(replaceOccurrence),
          }
          return {
            ...execution,
            result: { ...execution.result, artifact },
          }
        }
        if (request.phase === "semantic_review" || request.phase === "frontier_settlement") {
          const artifact = request.phase === "semantic_review"
            ? replaceTestGraphReferences(execution.result.artifact, ownerId)
            : replaceTestGraphReferences(execution.result.artifact, ownerId)
          return { ...execution, result: { ...execution.result, artifact } }
        }
        return execution
      },
    }

    const second = await fixture.createOrchestrator(model, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "继续查看这枚旧铜钥匙。",
      chapterSequence: 2,
    })

    const revisions = await fixture.graphRepository.listRevisions(fixture.projectId, "node", ownerId)
    expect(revisions).toHaveLength(2)
    const latestRevisionId = revisions.at(-1)?.revisionId
    expect(latestRevisionId).toBeDefined()
    expect(await fixture.retrievalRepository.findForOwnerRevision(
      fixture.projectId,
      "node",
      ownerId,
      String(latestRevisionId),
    )).toMatchObject({
      ownerId,
      ownerRevisionId: latestRevisionId,
      exactKeys: ["林序在旧桥下发现一枚旧铜钥匙。", "第一章 世界种子"],
    })
    expect(second.graphAnchorIds).toContain(ownerId)
  })

  it("resolves graph anchor IDs as owner identities instead of exact text keys", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const first = await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "林序在旧桥下发现一枚旧铜钥匙。",
      chapterSequence: 1,
    })
    const ownerId = first.graphAnchorIds[0]
    if (ownerId === undefined) throw new Error("The first turn did not create a graph anchor")

    let requestedAnchor = false
    let ruleAssemblyInput: TurnPhaseInput | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        const execution = await fake.execute(request)
        if (request.phase === "interpret" && !requestedAnchor) {
          requestedAnchor = true
          return {
            ...execution,
            result: {
              ...execution.result,
              outcome: "request_read",
              requestedReads: [{
                requestId: randomUUID(),
                reason: "按已知图身份读取当前状态",
                expectedEvidence: "该 owner 的当前图投影",
                query: {
                  anchorIds: [ownerId],
                  directions: ["both"],
                  exactKeys: [],
                  maxCandidates: 10,
                  maxDepth: 1,
                  semanticTexts: [],
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

    await fixture.createOrchestrator(model, fixture.commit).execute({
      workflow: "query",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "读取这个既有身份。",
      chapterSequence: 2,
      allowWorkspaceChapterReads: false,
    })

    expect(ruleAssemblyInput?.readEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId, stateRole: "current" }),
    ]))
  })

  it("publishes when AI phases return advisory blocked, revise, reject, and retire outcomes", async () => {
    const fixture = await createFixture()
    let modelCalls = 0
    const fake = new FakeAiModelAdapter(randomUUID)
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        modelCalls += 1
        const execution = await fake.execute(request)
        if (request.phase === "emergence_review") {
          return { ...execution, result: { ...execution.result, outcome: "blocked" } }
        }
        if (request.phase === "dependency_audit") {
          return { ...execution, result: { ...execution.result, outcome: "revise" } }
        }
        if (request.phase === "graph_governance") {
          return { ...execution, result: { ...execution.result, outcome: "retire" } }
        }
        if (request.phase === "semantic_review") {
          return { ...execution, result: { ...execution.result, outcome: "reject" } }
        }
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
      resetPending: async () => {},
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
    const headingHits = await fixture.retrievalRepository.searchExact(
      { projectId: fixture.projectId },
      [result.chapterHeading],
      10,
    )
    expect(headingHits.some((projection) => projection.ownerKind === "node")).toBe(true)
    expect(headingHits.some((projection) => projection.ownerKind === "source")).toBe(true)
    const sourceExactHits = await fixture.retrievalRepository.searchExact(
      { projectId: fixture.projectId },
      ["林序在旧桥下发现一枚旧铜钥匙。"],
      20,
    )
    expect(sourceExactHits.some((projection) => projection.ownerKind === "source"
      && projection.semanticText === "林序在旧桥下发现一枚旧铜钥匙。")).toBe(true)
    const sourceTextHits = await fixture.retrievalRepository.searchText(
      { projectId: fixture.projectId },
      "林序在旧桥下发现一枚旧铜钥匙",
      20,
    )
    expect(sourceTextHits.some((projection) => projection.ownerKind === "source")).toBe(true)
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
    const interruptedTaskId = events.find((event) => event.event === "turn.interrupted")?.fields?.taskId
    expect(typeof interruptedTaskId).toBe("string")
    expect((await fixture.taskScopes.findTask(String(interruptedTaskId)))?.status).toBe("awaiting_user_decision")
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
    const interruptedTask = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    expect(interruptedTask.status).toBe("awaiting_user_decision")
    expect((await fixture.persistence.listPhaseRuns(interruptedTask.id)).at(-1)?.status).toBe("failed")
    expect((await fixture.database.selectFrom("artifact_scopes").selectAll().executeTakeFirstOrThrow()).visibility).toBe("pending")
    expect(await fixture.documentRepository.listCommittedChapters(fixture.projectId)).toEqual([])
  })

  it("pauses at a recoverable checkpoint when the model-call window is exhausted", async () => {
    const fixture = await createFixture()
    const orchestrator = fixture.createOrchestrator(new FakeAiModelAdapter(randomUUID), fixture.commit)

    await expect(orchestrator.execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "世界从一盏雨夜中的灯开始。",
      chapterSequence: 1,
      maxModelCalls: 1,
    })).rejects.toThrow("Model call budget exhausted before the next phase")

    const task = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    expect(task.status).toBe("awaiting_user_decision")
    expect(task.last_phase).toBe("rule_assembly")
    expect((await fixture.taskScopes.findScope(task.scope_id))?.visibility).toBe("pending")
    expect(readdirSync(join(fixture.workspaceRoot, "章节正文"))).toEqual([])
  })

  it("records deadline exhaustion as a wall-time limit", async () => {
    const fixture = await createFixture()
    const orchestrator = fixture.createOrchestrator(new FakeAiModelAdapter(randomUUID), fixture.commit)

    await expect(orchestrator.execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "在截止时间内开始推演。",
      chapterSequence: 1,
      deadlineMs: 1,
    })).rejects.toThrow("Turn deadline exceeded")

    const task = await fixture.taskScopes.findTask(
      (await fixture.database.selectFrom("tasks").select("id").executeTakeFirstOrThrow()).id,
    )
    expect(task?.status).toBe("awaiting_user_decision")
    expect(task?.error).toMatchObject({
      kind: "limit_exhausted",
      blockedMetrics: ["wall_time"],
    })
  })

  it("classifies an in-flight model abort after the deadline as wall-time exhaustion", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        if (request.phase === "interpret") throw new Error("This operation was aborted")
        return fake.execute(request)
      },
    }

    await expect(fixture.createOrchestrator(model, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "模型请求在截止点中断。",
      chapterSequence: 1,
      deadlineMs: 1,
    })).rejects.toThrow("Turn deadline exceeded while the model request was in flight")

    const taskRow = await fixture.database.selectFrom("tasks").select("id").executeTakeFirstOrThrow()
    const task = await fixture.taskScopes.findTask(taskRow.id)
    expect(task?.error).toMatchObject({
      kind: "limit_exhausted",
      blockedMetrics: ["wall_time"],
    })
  })

  it("answers a world query without reading chapter Markdown or committing graph changes", async () => {
    const fixture = await createFixture()
    await fixture.workspace.publishChapter(
      fixture.workspaceRoot,
      "章节正文/禁止直读.md",
      "# 禁止直读\n\n这段内容只能通过选择性持久投影返回。\n",
    )
    const fake = new FakeAiModelAdapter(randomUUID)
    const observedPhases: string[] = []
    let queryInput: TurnPhaseInput | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        observedPhases.push(request.phase)
        const execution = await fake.execute(request)
        if (request.phase !== "source_retrieval") return execution
        queryInput = request.input as TurnPhaseInput
        return {
          ...execution,
          result: {
            ...execution.result,
            outcome: "request_read",
            requestedReads: [{
              requestId: randomUUID(),
              reason: "验证查询禁止直接读取章节工作区文件",
              expectedEvidence: "禁止直读章节内容",
              query: {
                exactKeys: ["禁止直读.md"],
                semanticTexts: ["这段内容只能通过选择性持久投影返回"],
                anchorIds: [],
                directions: ["both"],
                maxCandidates: 10,
                maxDepth: 1,
                sourceKinds: ["source"],
              },
            }],
          },
        }
      },
    }

    const result = await fixture.createOrchestrator(model, fixture.commit).execute({
      workflow: "query",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "查询早期事实。",
      chapterSequence: 1,
      allowWorkspaceChapterReads: false,
    })

    expect(result.kind).toBe("query")
    expect(observedPhases).toEqual(["interpret", "rule_assembly", "source_retrieval", "draft", "response_review"])
    expect(queryInput?.workflow).toBe("query")
    expect(queryInput?.allowWorkspaceChapterReads).toBe(false)
    expect(queryInput?.readEvidence.some((evidence) => evidence.ownerKind === "workspace:chapters")).toBe(false)
    expect(await fixture.database.selectFrom("nodes").select("id").execute()).toEqual([])
    expect((await fixture.database.selectFrom("artifact_scopes").select("visibility").executeTakeFirstOrThrow()).visibility).toBe("retired")
    expect((await fixture.database.selectFrom("tasks").select(["kind", "status"]).executeTakeFirstOrThrow())).toMatchObject({
      kind: "query",
      status: "completed",
    })
  })

  it("returns committed source projections while workspace chapter reads are disabled", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "林序在旧桥下发现一枚旧铜钥匙。",
      chapterSequence: 1,
    })
    let draftInput: TurnPhaseInput | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        const execution = await fake.execute(request)
        if (request.phase === "source_retrieval") {
          return {
            ...execution,
            result: {
              ...execution.result,
              outcome: "request_read",
              requestedReads: [{
                requestId: randomUUID(),
                reason: "选择性返回已持久化的精确原文单元",
                expectedEvidence: "旧铜钥匙原话",
                query: {
                  exactKeys: ["林序在旧桥下发现一枚旧铜钥匙。"],
                  semanticTexts: [],
                  anchorIds: [],
                  directions: ["both"],
                  maxCandidates: 10,
                  maxDepth: 1,
                  sourceKinds: ["source"],
                },
              }],
            },
          }
        }
        if (request.phase === "draft") draftInput = request.input as TurnPhaseInput
        return execution
      },
    }

    const result = await fixture.createOrchestrator(model, fixture.commit).execute({
      workflow: "query",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "林序当时关于旧铜钥匙的原话是什么？",
      chapterSequence: 2,
      allowWorkspaceChapterReads: false,
    })

    expect(result.kind).toBe("query")
    expect(draftInput?.readEvidence.some((evidence) => (
      evidence.ownerKind === "source" && evidence.semanticText === "林序在旧桥下发现一枚旧铜钥匙。"
    ))).toBe(true)
    const sourceEvidence = draftInput?.readEvidence.find((evidence) => evidence.ownerKind === "source")
    expect(sourceEvidence?.relatedOwnerRefs?.length).toBeGreaterThan(0)
    expect(sourceEvidence?.relatedOwnerRefs?.some((owner) => owner.semanticText !== undefined)).toBe(true)
    expect(draftInput?.readEvidence.some((evidence) => evidence.ownerKind === "workspace:chapters")).toBe(false)
    const persistedSourceEvidence = await fixture.database.selectFrom("evidence_objects")
      .innerJoin("source_units", "source_units.id", "evidence_objects.owner_id")
      .select("evidence_objects.source_kind")
      .execute()
    expect(persistedSourceEvidence.length).toBeGreaterThan(0)
    expect(persistedSourceEvidence.every((evidence) => evidence.source_kind === "chapter")).toBe(true)
    expect(await fixture.documentRepository.listCommittedChapters(fixture.projectId)).toHaveLength(1)
  })

  it("uses a matched chapter source to retrieve later source units before graph summaries", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: [
        "桥头的人群散去。",
        "苏禾对林序说：“油毡纸不是我撕走的。”",
        "河水继续从旧桥下流过。",
      ].join("\n\n"),
      chapterSequence: 1,
    })
    let draftInput: TurnPhaseInput | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        const execution = await fake.execute(request)
        if (request.phase === "source_retrieval") {
          return {
            ...execution,
            result: {
              ...execution.result,
              outcome: "request_read",
              requestedReads: [{
                requestId: randomUUID(),
                reason: "从已识别章节中定位后续原文单元",
                expectedEvidence: "苏禾当时的逐字原话",
                query: {
                  exactKeys: ["第一章 世界种子"],
                  semanticTexts: ["苏禾 林序 油毡纸 不是我撕走"],
                  anchorIds: [],
                  directions: ["both"],
                  maxCandidates: 3,
                  maxDepth: 1,
                  sourceKinds: ["source"],
                },
              }],
            },
          }
        }
        if (request.phase === "draft") draftInput = request.input as TurnPhaseInput
        return execution
      },
    }

    await fixture.createOrchestrator(model, fixture.commit).execute({
      workflow: "query",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "苏禾当时说了什么？",
      chapterSequence: 2,
      allowWorkspaceChapterReads: false,
    })

    expect(draftInput?.readEvidence.some((evidence) => (
      evidence.ownerKind === "source" && evidence.semanticText.includes("油毡纸不是我撕走的")
    ))).toBe(true)
    expect(draftInput?.readEvidence.some((evidence) => (
      evidence.ownerKind === "node" || evidence.ownerKind === "link"
    ))).toBe(false)
  })

  it("expands a bounded source window after a matched narrative entry", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const sceneEntry = "林序抬头，看见旧桥右岸老槐树下站着一个人。"
    const exactDialogue = "苏禾说：“那张纸不是我撕走的，是第三个人在天亮前动过现场。”"
    await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: [
        sceneEntry,
        "她沿着河岸向前走了一步。",
        "林序仍旧站在桥面中央。",
        "晨雾从两个人之间缓慢散开。",
        "她先确认周围没有其他人。",
        "林序没有催促她开口。",
        "河水撞在桥墩上发出闷响。",
        "她从布包里取出一片残纸。",
        "林序看见残纸边缘有新鲜折痕。",
        exactDialogue,
      ].join("\n\n"),
      chapterSequence: 1,
    })
    let draftInput: TurnPhaseInput | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        const execution = await fake.execute(request)
        if (request.phase === "source_retrieval") {
          return {
            ...execution,
            result: {
              ...execution.result,
              outcome: "request_read",
              requestedReads: [{
                requestId: randomUUID(),
                reason: "从场景入口读取同一原文来源的连续后续",
                expectedEvidence: "该场景后续出现的逐字原话",
                query: {
                  exactKeys: ["第一章 世界种子"],
                  semanticTexts: ["旧桥右岸老槐树下站着一个人"],
                  anchorIds: [],
                  directions: ["both"],
                  maxCandidates: 20,
                  maxDepth: 1,
                  sourceKinds: ["source"],
                },
              }],
            },
          }
        }
        if (request.phase === "draft") draftInput = request.input as TurnPhaseInput
        return execution
      },
    }

    await fixture.createOrchestrator(model, fixture.commit).execute({
      workflow: "query",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "旧桥见面后，苏禾当时说了什么？",
      chapterSequence: 2,
      allowWorkspaceChapterReads: false,
    })

    expect(draftInput?.readEvidence.some((evidence) => (
      evidence.ownerKind === "source" && evidence.semanticText === sceneEntry
    ))).toBe(true)
    expect(draftInput?.readEvidence.some((evidence) => (
      evidence.ownerKind === "source" && evidence.semanticText === exactDialogue
    ))).toBe(true)
    expect(draftInput?.readEvidence.some((evidence) => evidence.ownerKind === "workspace:chapters")).toBe(false)
  })

  it("does not expand a source window for a mixed graph and source request", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const sceneEntry = "林序抬头，看见旧桥右岸老槐树下站着一个人。"
    const retrievalEvents: Array<Readonly<Record<string, unknown>>> = []

    await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: [
        sceneEntry,
        "她沿着河岸向前走了一步。",
        "苏禾说：“那张纸不是我撕走的。”",
      ].join("\n\n"),
      chapterSequence: 1,
    })

    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        const execution = await fake.execute(request)
        if (request.phase !== "interpret") return execution
        return {
          ...execution,
          result: {
            ...execution.result,
            outcome: "request_read",
            requestedReads: [{
              requestId: randomUUID(),
              reason: "混合查询只验证直接候选，不展开同源窗口",
              expectedEvidence: "旧桥场景的图与原文入口",
              query: {
                exactKeys: [],
                semanticTexts: [sceneEntry],
                anchorIds: [],
                directions: ["both"],
                maxCandidates: 20,
                maxDepth: 1,
                sourceKinds: ["graph", "source"],
              },
            }],
          },
        }
      },
    }

    await fixture.createOrchestrator(model, fixture.commit, {
      log: (_level, event, fields) => {
        if (event === "retrieval.request.completed" && fields !== undefined) retrievalEvents.push(fields)
      },
    }).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "查询旧桥附近已经发生过的事情。",
      chapterSequence: 2,
      allowWorkspaceChapterReads: false,
    })

    const mixedRequests = retrievalEvents.filter((event) => (
      Array.isArray(event.requestedSourceKinds)
      && event.requestedSourceKinds.includes("graph")
      && event.requestedSourceKinds.includes("source")
    ))
    expect(mixedRequests.length).toBeGreaterThan(0)
    expect(mixedRequests.every((event) => event.sourceNeighborhoodMatches === 0)).toBe(true)
  })

  it("counts related graph summaries against the retrieval evidence budget", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "林序在旧桥下发现一枚旧铜钥匙。",
      chapterSequence: 1,
    })
    let draftInput: TurnPhaseInput | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        const execution = await fake.execute(request)
        if (request.phase === "source_retrieval") {
          return {
            ...execution,
            result: {
              ...execution.result,
              outcome: "request_read",
              requestedReads: [{
                requestId: randomUUID(),
                reason: "返回精确原文，但关联摘要必须服从同一证据预算",
                expectedEvidence: "旧铜钥匙原话",
                query: {
                  exactKeys: ["林序在旧桥下发现一枚旧铜钥匙。"],
                  semanticTexts: [],
                  anchorIds: [],
                  directions: ["both"],
                  maxCandidates: 10,
                  maxDepth: 1,
                  sourceKinds: ["source"],
                },
              }],
            },
          }
        }
        if (request.phase === "draft") draftInput = request.input as TurnPhaseInput
        return execution
      },
    }
    const projectSettings = {
      ...defaultProjectSettings,
      retrieval: {
        ...defaultProjectSettings.retrieval,
        maxEvidenceTokens: 80,
      },
    }

    await fixture.createOrchestrator(model, fixture.commit).execute({
      workflow: "query",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "林序当时关于旧铜钥匙的原话是什么？",
      chapterSequence: 2,
      allowWorkspaceChapterReads: false,
      projectSettings,
    })

    const sourceEvidence = draftInput?.readEvidence.find((evidence) => evidence.ownerKind === "source")
    expect(sourceEvidence?.semanticText).toBe("林序在旧桥下发现一枚旧铜钥匙。")
    expect(sourceEvidence?.relatedOwnerRefs ?? []).toEqual([])
  })

  it("does not add the same graph evidence twice when a phase repeats a read", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "甲事件",
      chapterSequence: 1,
    })

    let interpretCalls = 0
    let ruleAssemblyInput: TurnPhaseInput | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        const execution = await fake.execute(request)
        if (request.phase === "interpret") {
          interpretCalls += 1
          if (interpretCalls <= 2) {
            return {
              ...execution,
              result: {
                ...execution.result,
                outcome: "request_read",
                requestedReads: [queryGraphFact("甲事件")],
              },
            }
          }
        }
        if (request.phase === "rule_assembly") ruleAssemblyInput = request.input as TurnPhaseInput
        return execution
      },
    }

    await fixture.createOrchestrator(model, fixture.commit).execute({
      workflow: "query",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "查询甲事件。",
      chapterSequence: 2,
      allowWorkspaceChapterReads: false,
    })

    const graphEvidence = ruleAssemblyInput?.readEvidence.filter((evidence) => (
      evidence.ownerKind === "node" || evidence.ownerKind === "link"
    )) ?? []
    const stableEvidenceKeys = graphEvidence.map((evidence) => `${evidence.ownerId}:${evidence.digest}`)
    expect(interpretCalls).toBe(2)
    expect(graphEvidence.length).toBeGreaterThan(0)
    expect(new Set(stableEvidenceKeys).size).toBe(stableEvidenceKeys.length)
  })

  it("carries only cited dynamic evidence across query phases", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "甲事件",
      chapterSequence: 1,
    })
    await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "乙事件",
      chapterSequence: 2,
    })

    let requestedSecondRead = false
    let interpretCalls = 0
    let sourceRetrievalCalls = 0
    let ruleAssemblyInput: TurnPhaseInput | undefined
    let draftInput: TurnPhaseInput | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        const execution = await fake.execute(request)
        if (request.phase === "interpret") {
          interpretCalls += 1
          if (interpretCalls > 1) {
            const phaseInput = request.input as TurnPhaseInput
            return {
              ...execution,
              result: {
                ...execution.result,
                citedReadIds: phaseInput.readEvidence
                  .filter((evidence) => evidence.ownerKind.startsWith("workspace:"))
                  .map((evidence) => evidence.readId),
              },
            }
          }
          return {
            ...execution,
            result: {
              ...execution.result,
              outcome: "request_read",
              requestedReads: [queryGraphFact("甲事件")],
            },
          }
        }
        if (request.phase === "rule_assembly") ruleAssemblyInput = request.input as TurnPhaseInput
        if (request.phase === "source_retrieval") {
          sourceRetrievalCalls += 1
          if (!requestedSecondRead) {
            requestedSecondRead = true
            return {
              ...execution,
              result: {
                ...execution.result,
                outcome: "request_read",
                requestedReads: [queryGraphFact("乙事件")],
              },
            }
          }
        }
        if (request.phase === "draft") draftInput = request.input as TurnPhaseInput
        return execution
      },
    }
    const projectSettings = {
      ...defaultProjectSettings,
      retrieval: {
        ...defaultProjectSettings.retrieval,
        maxEvidenceTokens: 1_000,
      },
    }

    await fixture.createOrchestrator(model, fixture.commit).execute({
      workflow: "query",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "分别查询甲事件与乙事件。",
      chapterSequence: 3,
      allowWorkspaceChapterReads: false,
      projectSettings,
    })

    const graphEvidence = draftInput?.readEvidence.filter((evidence) => evidence.ownerKind === "node") ?? []
    expect(ruleAssemblyInput?.readEvidence.some((evidence) => evidence.semanticText.includes("甲事件"))).toBe(false)
    expect(graphEvidence.length).toBeGreaterThan(0)
    expect(graphEvidence.some((evidence) => evidence.semanticText.includes("乙事件"))).toBe(true)
    expect(graphEvidence.some((evidence) => evidence.semanticText.includes("甲事件"))).toBe(false)
    expect(sourceRetrievalCalls).toBe(2)
  })

  it("preserves accepted world evidence across phases that do not own evidence selection", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "甲事件",
      chapterSequence: 1,
    })
    await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "乙事件",
      chapterSequence: 2,
    })

    let interpretCalls = 0
    let sourceRetrievalCalls = 0
    let sourceRetrievalInput: TurnPhaseInput | undefined
    let draftInput: TurnPhaseInput | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        const execution = await fake.execute(request)
        const phaseInput = request.input as TurnPhaseInput
        if (request.phase === "interpret") {
          interpretCalls += 1
          if (interpretCalls === 1) {
            return {
              ...execution,
              result: {
                ...execution.result,
                outcome: "request_read",
                requestedReads: [queryGraphFact("甲事件")],
              },
            }
          }
          return {
            ...execution,
            result: {
              ...execution.result,
              citedReadIds: phaseInput.readEvidence
                .filter((evidence) => evidence.semanticText.includes("甲事件"))
                .map((evidence) => evidence.readId),
            },
          }
        }
        if (request.phase === "rule_assembly") {
          return {
            ...execution,
            result: {
              ...execution.result,
              citedReadIds: phaseInput.readEvidence
                .filter((evidence) => evidence.ownerKind.startsWith("workspace:"))
                .map((evidence) => evidence.readId),
            },
          }
        }
        if (request.phase === "source_retrieval") {
          sourceRetrievalCalls += 1
          sourceRetrievalInput = phaseInput
          if (sourceRetrievalCalls === 1) {
            return {
              ...execution,
              result: {
                ...execution.result,
                outcome: "request_read",
                requestedReads: [queryGraphFact("乙事件")],
              },
            }
          }
          return {
            ...execution,
            result: {
              ...execution.result,
              citedReadIds: phaseInput.readEvidence
                .filter((evidence) => evidence.ownerKind.startsWith("workspace:")
                  || evidence.semanticText.includes("乙事件"))
                .map((evidence) => evidence.readId),
            },
          }
        }
        if (request.phase === "draft") draftInput = phaseInput
        return execution
      },
    }

    await fixture.createOrchestrator(model, fixture.commit).execute({
      workflow: "query",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "查询甲事件。",
      chapterSequence: 3,
      allowWorkspaceChapterReads: false,
    })

    expect(sourceRetrievalInput?.readEvidence.some((evidence) => evidence.semanticText.includes("甲事件"))).toBe(true)
    expect(draftInput?.readEvidence.some((evidence) => evidence.semanticText.includes("甲事件"))).toBe(true)
    expect(draftInput?.readEvidence.some((evidence) => evidence.semanticText.includes("乙事件"))).toBe(true)
  })

  it("sends only direct artifact dependencies and catalog-bearing phases to the model", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const observed = new Map<string, TurnPhaseInput>()
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        observed.set(request.phase, request.input as TurnPhaseInput)
        return fake.execute(request)
      },
    }

    await fixture.createOrchestrator(model, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "建立一个能够继续演化的局部。",
      chapterSequence: 1,
    })

    expect(observed.get("source_retrieval")?.workspaceCatalog).toBeDefined()
    expect(observed.get("draft")?.workspaceCatalog).toBeUndefined()
    expect(Object.keys(observed.get("rule_assembly")?.artifacts ?? {})).toEqual(["interpret"])
    expect(Object.keys(observed.get("chapter_naming")?.artifacts ?? {})).toEqual(["draft"])
    expect(Object.keys(observed.get("graph_governance")?.artifacts ?? {})).toEqual([
      "source_retrieval",
      "emergence_planning",
      "emergence_review",
      "draft",
      "dependency_audit",
    ])
    expect(observed.get("graph_governance")?.artifacts.chapter_naming).toBeUndefined()
  })

  it("commits independent world evolution without publishing a chapter", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const observedPhases: string[] = []
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        observedPhases.push(request.phase)
        return fake.execute(request)
      },
    }

    const result = await fixture.createOrchestrator(model, fixture.commit).execute({
      workflow: "evolution",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "扫描并推进一个可达世界前沿。",
      chapterSequence: 1,
      allowWorkspaceChapterReads: false,
    })

    expect(result.kind).toBe("evolution")
    expect(observedPhases).toEqual([
      "interpret",
      "rule_assembly",
      "source_retrieval",
      "emergence_planning",
      "emergence_review",
      "dependency_audit",
      "graph_governance",
      "semantic_review",
      "settlement_review",
      "frontier_settlement",
      "commit_review",
    ])
    expect(readdirSync(join(fixture.workspaceRoot, "章节正文"))).toEqual([])
    expect((await fixture.database.selectFrom("nodes").select("id").execute()).length).toBeGreaterThan(0)
    expect((await fixture.database.selectFrom("artifact_scopes").select("visibility").executeTakeFirstOrThrow()).visibility).toBe("committed")
    expect((await fixture.database.selectFrom("tasks").select(["kind", "status"]).executeTakeFirstOrThrow())).toMatchObject({
      kind: "evolution",
      status: "completed",
    })
  })

  it("injects bounded committed frontier evidence before independent evolution starts", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "建立一个能够继续演化的局部。",
      chapterSequence: 1,
    })

    let interpretInput: TurnPhaseInput | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        if (request.phase === "interpret" && interpretInput === undefined) {
          interpretInput = request.input as TurnPhaseInput
        }
        return fake.execute(request)
      },
    }

    await fixture.createOrchestrator(model, fixture.commit).execute({
      workflow: "evolution",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "扫描并推进一个可达世界前沿。",
      chapterSequence: 2,
      allowWorkspaceChapterReads: false,
    })

    expect(interpretInput?.readEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerKind: "frontier" }),
      expect.objectContaining({ ownerKind: "node", stateRole: "current" }),
    ]))
  })

  it("pauses independent evolution when a committed frontier has no resolvable current anchor", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "建立一个能够继续演化的局部。",
      chapterSequence: 1,
    })
    const missingAnchor = randomUUID()
    await fixture.database.updateTable("frontier_refs").set({
      frontier_anchor_ref: missingAnchor,
      last_scene_anchor_refs_json: JSON.stringify([missingAnchor]),
      last_time_anchor_refs_json: JSON.stringify([missingAnchor]),
      last_location_anchor_refs_json: JSON.stringify([missingAnchor]),
      correspondence_refs_json: JSON.stringify([]),
    }).execute()

    await expect(fixture.createOrchestrator(fake, fixture.commit).execute({
      workflow: "evolution",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "扫描并推进一个可达世界前沿。",
      chapterSequence: 2,
      allowWorkspaceChapterReads: false,
    })).rejects.toThrow("committed frontier has no resolvable current graph anchor")

    const latestTask = await fixture.database.selectFrom("tasks").select(["kind", "status"])
      .where("kind", "=", "evolution").orderBy("created_at", "desc").executeTakeFirstOrThrow()
    expect(latestTask.status).toBe("awaiting_user_decision")
  })

  it("resumes from the interrupted phase without rerunning completed phases", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const observedPhases: string[] = []
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        observedPhases.push(request.phase)
        return fake.execute(request)
      },
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit)
    const input = {
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "世界从一盏雨夜中的灯开始。",
      chapterSequence: 1,
    }

    await expect(orchestrator.execute({ ...input, maxModelCalls: 1 })).rejects.toThrow("Model call budget exhausted")
    const task = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    const callsBeforeResume = observedPhases.length

    const result = await orchestrator.resume({ ...input, taskId: task.id, maxModelCalls: 63 })

    expect(observedPhases.slice(0, callsBeforeResume)).toEqual(["interpret"])
    expect(observedPhases[callsBeforeResume]).toBe("rule_assembly")
    expect(result.modelCalls).toBe(13)
    expect((await fixture.taskScopes.findTask(task.id))?.status).toBe("completed")
    expect(readdirSync(join(fixture.workspaceRoot, "章节正文"))).toEqual(["第一章 世界种子.md"])
  })
})

function asRecordForTest(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function replaceTestGraphReferences(value: unknown, ownerId: string): unknown {
  if (typeof value === "string") return value === "local:occurrence" ? ownerId : value
  if (Array.isArray(value)) return value.map((item) => replaceTestGraphReferences(item, ownerId))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    replaceTestGraphReferences(nested, ownerId),
  ]))
}

function queryGraphFact(exactKey: string) {
  return {
    requestId: randomUUID(),
    reason: `Read graph fact ${exactKey}`,
    expectedEvidence: `Graph fact ${exactKey}`,
    query: {
      exactKeys: [exactKey],
      semanticTexts: [],
      anchorIds: [],
      directions: ["both" as const],
      maxCandidates: 10,
      maxDepth: 1,
      sourceKinds: ["graph" as const],
    },
  }
}

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
