import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { sql } from "kysely"
import { defaultProjectSettings } from "@worldseed/config"
import {
  graphCapacityRewriteArtifactSchema,
  graphStructurePlanArtifactSchema,
} from "@worldseed/prompt-contracts"

import {
  NodeInternalStoreAdapter,
  NodePromptResourceAdapter,
  NodeWorkspaceAdapter,
  NodeWorkspaceCatalogAdapter,
  NodeWorkspaceSnapshotAdapter,
  HistoryCheckoutService,
  HistoryManifestBuilder,
  HistoryService,
  IsomorphicGitHistoryAdapter,
  ProjectLifecycleService,
  SqliteDocumentRepository,
  SqliteEvidenceStore,
  SqliteGraphRepository,
  SqliteHistoryRepository,
  SqliteProjectRegistryRepository,
  SqliteProjectIdAllocator,
  SqliteProjectRepositoryFactory,
  SqliteRetrievalRepository,
  SqliteScopeCommitRepository,
  SqliteTaskScopeRepository,
  SqliteTurnPersistence,
  SqliteWorkspaceCatalogSnapshotRepository,
  TurnOrchestrator,
  FakeAiModelAdapter,
  createRetrievalGaps,
  digest,
  estimateModelMessageTokens,
  openProjectDatabase,
  openRegistryDatabase,
  type AIModelPort,
  type ScopeCommitRepository,
  type TurnPhaseInput,
  type WorkspacePort,
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
        if (request.phase === "graph_spacetime_settlement") {
          const settlement = execution.result.artifact as {
            proposalSettlements?: readonly { proposalRefs: readonly string[] }[]
          }
          return {
            ...execution,
            result: {
              ...execution.result,
              artifact: {
                ...settlement,
                proposalSettlements: settlement.proposalSettlements?.map((entry, index) => (
                  index === 0 ? { ...entry, proposalRefs: [...entry.proposalRefs, "proposal:unread-edit"] } : entry
                )),
              },
            },
          }
        }
        if (request.phase !== "graph_structure_plan") return execution
        const structure = graphStructurePlanArtifactSchema.parse(execution.result.artifact)
        const proposalRef = "proposal:unread-edit"
        return {
          ...execution,
          result: {
            ...execution.result,
            artifact: {
              ...structure,
              proposals: [
                ...structure.proposals,
                {
                  proposalRef,
                  mutation: { operation: "edit_node", nodeRef: unreadNodeId, next: { content: { changed: true } } },
                  reason: "Attempt to edit an unread existing node",
                  selfReview: "The application must reject the unread reference",
                },
              ],
              decisionRecords: structure.decisionRecords.map((record, index) => (
                index === 0
                  ? { ...record, proposalRefs: [...record.proposalRefs, proposalRef] }
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

  it("rewinds an invalid persisted retrieval design before resuming commit", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let retrievalDesignCalls = 0
    const observedPhases: string[] = []
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        observedPhases.push(request.phase)
        const execution = await fake.execute(request, options)
        if (request.phase !== "graph_retrieval_design") return execution
        retrievalDesignCalls += 1
        if (retrievalDesignCalls > 1) return execution
        const artifact = execution.result.artifact as {
          sourceSettlements: readonly Readonly<{
            graphRefs: readonly Readonly<{ targetKind: "node" | "link"; targetRef: string; proposalRef?: string }>[]
          }>[]
        }
        return {
          ...execution,
          result: {
            ...execution.result,
            artifact: {
              ...artifact,
              sourceSettlements: artifact.sourceSettlements.map((settlement, index) => index === 0
                ? { ...settlement, graphRefs: [{ targetKind: "node", targetRef: "local:stale_handle" }] }
                : settlement),
            },
          },
        }
      },
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit)
    const input = {
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "验证陈旧局部句柄恢复。",
      chapterSequence: 1,
    }

    await expect(orchestrator.execute(input)).rejects.toThrow("local:stale_handle")
    const task = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    const callsBeforeResume = observedPhases.length

    await orchestrator.resume({ ...input, taskId: task.id }, "continue")

    expect(observedPhases[callsBeforeResume]).toBe("graph_retrieval_design")
    expect(retrievalDesignCalls).toBe(2)
    expect((await fixture.taskScopes.findTask(task.id))?.status).toBe("completed")
    const retrievalRuns = (await fixture.persistence.listPhaseRuns(task.id))
      .filter((run) => run.phase === "graph_retrieval_design")
    expect(retrievalRuns.some((run) => run.status === "superseded")).toBe(true)
    expect(retrievalRuns.at(-1)?.status).toBe("completed")
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

  it("continues graph review when a verification probe reaches the retrieval-round limit", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const events: Array<{ event: string; fields?: Readonly<Record<string, unknown>> }> = []
    let commitReviewInput: TurnPhaseInput | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        if (request.phase === "commit_review") commitReviewInput = request.input as TurnPhaseInput
        return fake.execute(request, options)
      },
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit, {
      log: (_level, event, fields) => events.push({ event, fields }),
    })

    const result = await orchestrator.execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "验证图审核探针达到检索轮次上限后仍能提交。",
      chapterSequence: 1,
      maxRetrievalRounds: 1,
    })

    const task = await fixture.taskScopes.findTask(result.taskId)
    const checkpoints = await fixture.persistence.listVerificationProbeCheckpoints(result.taskId)
    const governanceRuns = (await fixture.persistence.listPhaseRuns(result.taskId))
      .filter((run) => run.phase === "graph_governance_review")
    const finalReview = governanceRuns.at(-1)?.result as {
      requestedReads?: readonly unknown[]
      artifact?: { verificationProbeAssessments?: readonly unknown[] }
    } | undefined

    expect(task?.status).toBe("completed")
    expect(result.chapterPath).toBe("章节正文/第一章 世界种子.md")
    expect(checkpoints).toHaveLength(0)
    expect(finalReview?.requestedReads?.length).toBeGreaterThan(0)
    expect(finalReview?.artifact?.verificationProbeAssessments).toEqual([])
    expect(commitReviewInput?.retrievalGaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ typeId: "system:retrieval-gap" }),
    ]))
    expect(events).toContainEqual(expect.objectContaining({
      event: "verification_probe.read_gap_recorded",
      fields: expect.objectContaining({
        phase: "graph_governance_review",
        message: expect.stringContaining("no execution or pass assessment was fabricated"),
      }),
    }))
  })

  it("pauses instead of committing a narrative turn with an empty graph structure", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const events: Array<{ event: string; fields?: Readonly<Record<string, unknown>> }> = []
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        const execution = await fake.execute(request, options)
        if (request.phase !== "graph_structure_plan") return execution
        return {
          ...execution,
          result: {
            ...execution.result,
            outcome: "request_read",
            artifact: {
              proposals: [],
              decisionRecords: [],
              affectedFrontierRefs: [],
              archiveOutletRefs: [],
            },
            requestedReads: [queryGraphFact("正式候选正文")],
          },
        }
      },
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit, {
      log: (_level, event, fields) => events.push({ event, fields }),
    })

    await expect(orchestrator.execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "让新的事务进入正文并持续存在。",
      chapterSequence: 1,
      maxRetrievalRounds: 1,
    })).rejects.toThrow("Graph structure plan cannot be empty when the turn has persisted narrative source units")

    const task = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    const finalizations = await fixture.database.selectFrom("turn_finalizations").select("id").execute()
    expect(task.status).toBe("awaiting_user_decision")
    expect(finalizations).toEqual([])
    expect(readdirSync(join(fixture.workspaceRoot, "章节正文"))).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({
      event: "graph.structure.empty_rejected",
      fields: expect.objectContaining({ sourceUnitCount: expect.any(Number) }),
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
        if (request.phase === "graph_structure_plan") {
          const structure = graphStructurePlanArtifactSchema.parse(execution.result.artifact)
          const replaceOccurrence = (reference: string): string => reference === "local:occurrence" ? ownerId : reference
          const proposals = structure.proposals.map((proposal, index) => {
            const mutation = proposal.mutation
            if (index === 0 && mutation.operation === "create_node") {
              return {
                ...proposal,
                mutation: {
                  operation: "edit_node" as const,
                  nodeRef: ownerId,
                  next: {
                    ...mutation.data,
                    content: { ...asRecordForTest(mutation.data.content), updatedThisTurn: true },
                  },
                },
              }
            }
            if (mutation.operation === "create_link") {
              return {
                ...proposal,
                mutation: {
                  ...mutation,
                  fromRef: replaceOccurrence(mutation.fromRef),
                  toRef: replaceOccurrence(mutation.toRef),
                },
              }
            }
            return proposal
          })
          const artifact = {
            ...structure,
            proposals,
            affectedFrontierRefs: structure.affectedFrontierRefs.map(replaceOccurrence),
          }
          return {
            ...execution,
            result: { ...execution.result, artifact },
          }
        }
        if (request.phase === "graph_retrieval_design") {
          const artifact = replaceTestGraphReferences(execution.result.artifact, ownerId) as Record<string, unknown>
          return { ...execution, result: { ...execution.result, artifact: { ...artifact, projections: [] } } }
        }
        if (request.phase === "graph_spacetime_settlement" || request.phase === "graph_governance_review" || request.phase === "frontier_settlement") {
          const artifact = replaceTestGraphReferences(execution.result.artifact, ownerId)
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

    let requestedCurrentOwner = false
    let refreshedInput: TurnPhaseInput | undefined
    const refreshModel: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        const execution = await fake.execute(request)
        if (request.phase === "interpret" && !requestedCurrentOwner) {
          requestedCurrentOwner = true
          return {
            ...execution,
            result: {
              ...execution.result,
              outcome: "request_read",
              requestedReads: [{
                requestId: randomUUID(),
                reason: "校验本轮依赖节点是否仍为当前修订",
                expectedEvidence: "旧铜钥匙节点的当前图投影",
                query: {
                  anchorIds: [ownerId],
                  directions: ["both"],
                  exactKeys: [],
                  maxCandidates: 10,
                  maxDepth: 0,
                  semanticTexts: [],
                  sourceKinds: ["graph"],
                },
              }],
            },
          }
        }
        if (request.phase === "rule_assembly") refreshedInput = request.input as TurnPhaseInput
        return execution
      },
    }

    await fixture.createOrchestrator(refreshModel, fixture.commit).execute({
      workflow: "query",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "现在这枚旧铜钥匙是什么状态？",
      chapterSequence: 3,
      allowWorkspaceChapterReads: false,
    })

    const ownerEvidence = refreshedInput?.readEvidence.filter((evidence) => (
      evidence.ownerKind === "node" && evidence.ownerId === ownerId
    )) ?? []
    expect(ownerEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ revisionId: latestRevisionId, stateRole: "current" }),
      expect.objectContaining({ stateRole: "historical" }),
    ]))
    expect(ownerEvidence.filter((evidence) => evidence.stateRole === "current")).toHaveLength(1)
  })

  it("binds a current-turn projection proposal to the staged graph revision", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        const execution = await fake.execute(request, options)
        if (request.phase !== "graph_retrieval_design") return execution
        const retrieval = execution.result.artifact as {
          projections?: readonly { ownerProposalRef?: string; exactKeys: readonly string[]; semanticText: string }[]
        }
        const projection = retrieval.projections?.[0]
        if (projection === undefined) {
          throw new Error("The graph fixture did not create the expected node projection")
        }
        return {
          ...execution,
          result: {
            ...execution.result,
            artifact: {
              ...retrieval,
              projections: [{
                ownerProposalRef: "proposal:mutation:1",
                exactKeys: projection.exactKeys,
                semanticText: projection.semanticText,
              }],
            },
          },
        }
      },
    }

    const result = await fixture.createOrchestrator(model, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "雨夜旅人推开旧车站的门。",
      chapterSequence: 1,
    })
    const ownerId = result.graphAnchorIds[0]
    if (ownerId === undefined) throw new Error("The turn did not create a graph anchor")
    const revision = (await fixture.graphRepository.listRevisions(fixture.projectId, "node", ownerId)).at(-1)
    expect(revision).toBeDefined()
    expect(await fixture.retrievalRepository.findForOwnerRevision(
      fixture.projectId,
      "node",
      ownerId,
      String(revision?.revisionId),
    )).toMatchObject({ ownerId, ownerRevisionId: revision?.revisionId })
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
      expect.objectContaining({ ownerId, stateRole: "current", committedSequence: 1 }),
    ]))
    expect(ruleAssemblyInput?.readEvidence.some((evidence) => evidence.ownerKind === "link")).toBe(true)
    expect(ruleAssemblyInput?.readEvidence.some((evidence) => (
      evidence.ownerKind === "node" && evidence.ownerId !== ownerId
    ))).toBe(true)
  })

  it("reuses a visible graph evidence when its anchored head revision is unchanged", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const first = await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "旧桥下留着一枚铜钥匙。",
      chapterSequence: 1,
    })
    const ownerId = first.graphAnchorIds[0]
    if (ownerId === undefined) throw new Error("The first turn did not create a graph anchor")
    const warmModel: AIModelPort = {
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
              reason: "先建立当前图 Evidence",
              expectedEvidence: "铜钥匙当前图投影",
              query: {
                anchorIds: [ownerId], directions: ["both"], exactKeys: [],
                maxCandidates: 10, maxDepth: 0, semanticTexts: [], sourceKinds: ["graph"],
              },
            }],
          },
        }
      },
    }
    await fixture.createOrchestrator(warmModel, fixture.commit).execute({
      workflow: "query",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "先读取这枚铜钥匙。",
      chapterSequence: 2,
      allowWorkspaceChapterReads: false,
    })
    const ownerEvidenceBefore = await fixture.database.selectFrom("evidence_objects").selectAll()
      .where("owner_id", "=", ownerId).execute()
    let ruleAssemblyInput: TurnPhaseInput | undefined
    let freshnessRequested = false
    const interpretInputs: TurnPhaseInput[] = []
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        const execution = await fake.execute(request)
        if (request.phase === "interpret") interpretInputs.push(request.input as TurnPhaseInput)
        if (request.phase === "interpret" && !freshnessRequested) {
          freshnessRequested = true
          return {
            ...execution,
            result: {
              ...execution.result,
              outcome: "request_read",
              requestedReads: [{
                requestId: randomUUID(),
                reason: "确认旧桥下铜钥匙仍使用同一图修订",
                expectedEvidence: "铜钥匙当前图投影",
                query: {
                  anchorIds: [ownerId],
                  directions: ["both"],
                  exactKeys: [],
                  maxCandidates: 10,
                  maxDepth: 0,
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
      userInput: "现在查看这枚铜钥匙。",
      chapterSequence: 3,
      allowWorkspaceChapterReads: false,
    })
    const ownerEvidenceAfter = await fixture.database.selectFrom("evidence_objects").selectAll()
      .where("owner_id", "=", ownerId).execute()
    expect(ownerEvidenceAfter).toHaveLength(ownerEvidenceBefore.length)
    expect(interpretInputs).toHaveLength(2)
    expect(interpretInputs[1]?.resurfacedReadIds).toEqual(expect.arrayContaining([
      expect.any(String),
    ]))
    expect(interpretInputs[1]?.readEvidence.some((evidence) => (
      evidence.ownerId === ownerId && evidence.stateRole === "current"
    ))).toBe(true)
    expect(ruleAssemblyInput?.readEvidence.filter((evidence) => evidence.ownerId === ownerId)).toEqual([
      expect.objectContaining({ stateRole: "current" }),
    ])
    expect(ruleAssemblyInput?.retrievalGaps).toEqual([])
  })

  it("publishes when AI phases return advisory blocked, revise, reject, and retire outcomes", async () => {
    const fixture = await createFixture()
    let modelCalls = 0
    let semanticReviewCalls = 0
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
        if (request.phase === "graph_structure_plan") {
          return { ...execution, result: { ...execution.result, outcome: "retire" } }
        }
        if (request.phase === "graph_governance_review") {
          semanticReviewCalls += 1
          return semanticReviewCalls === 1
            ? execution
            : { ...execution, result: { ...execution.result, outcome: "reject", requestedReads: [] } }
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
              continuityAdvice: ((execution.result.artifact as { continuityAdvice?: readonly Record<string, unknown>[] }).continuityAdvice ?? [])
                .map((advice) => ({
                  ...advice,
                  verdict: "conflict",
                  summary: "正文相对时间存在冲突，但建议不得阻断提交",
                  suggestedDirection: "用户可在提交后自行修改正文",
                })),
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

    expect(modelCalls).toBe(17)
    expect(result.modelCalls).toBe(17)
    expect(result.modelProvider).toBe("fake")
    expect(result.modelName).toBe("deterministic-contract-fixture")
    expect(result.kvCacheHitRate).toBeCloseTo(0.5, 2)
    const semanticRuns = (await fixture.persistence.listPhaseRuns(result.taskId))
      .filter((run) => run.phase === "graph_governance_review")
    expect(semanticRuns).toHaveLength(2)
    const finalSemanticRequest = semanticRuns.at(-1)?.request as { input?: { verificationProbeExecutions?: readonly unknown[] } } | undefined
    expect(finalSemanticRequest?.input?.verificationProbeExecutions).toHaveLength(4)
    expect(observedPending).toBe(true)
    expect(result.graphAnchorIds).toEqual(expect.arrayContaining([
      expect.stringMatching(/^node_[1-9][0-9]*$/u),
    ]))
    const storedGraphIds = [
      ...(await fixture.database.selectFrom("nodes").select("id").execute()).map((row) => row.id),
      ...(await fixture.database.selectFrom("links").select("id").execute()).map((row) => row.id),
    ]
    expect(storedGraphIds.some((id) => id.startsWith("local:"))).toBe(false)
    expect((await fixture.database.selectFrom("nodes").select("id").execute())
      .every((row) => /^node_[1-9][0-9]*$/u.test(row.id))).toBe(true)
    expect((await fixture.database.selectFrom("links").select("id").execute())
      .every((row) => /^link_[1-9][0-9]*$/u.test(row.id))).toBe(true)
    expect((await fixture.database.selectFrom("graph_revisions").select("id").execute())
      .every((row) => /^revision_[1-9][0-9]*$/u.test(row.id))).toBe(true)
    expect((await fixture.database.selectFrom("evidence_objects").select("id").execute())
      .every((row) => /^evidence_[1-9][0-9]*$/u.test(row.id))).toBe(true)
    expect((await fixture.database.selectFrom("turn_finalizations").select("source_id").executeTakeFirstOrThrow()).source_id)
      .toMatch(/^source_[1-9][0-9]*$/u)
    const counters = await fixture.database.selectFrom("id_counters").select(["prefix", "current_value"]).execute()
    const currentValueByPrefix = new Map(counters.map((counter) => [counter.prefix, counter.current_value]))
    for (const prefix of ["node", "link", "evidence", "source", "revision"] as const) {
      const persistedIds = prefix === "source"
        ? [(await fixture.database.selectFrom("turn_finalizations").select("source_id").executeTakeFirstOrThrow()).source_id]
        : prefix === "evidence"
          ? (await fixture.database.selectFrom("evidence_objects").select("id").execute()).map((row) => row.id)
          : prefix === "revision"
            ? (await fixture.database.selectFrom("graph_revisions").select("id").execute()).map((row) => row.id)
            : prefix === "node"
              ? (await fixture.database.selectFrom("nodes").select("id").execute()).map((row) => row.id)
              : (await fixture.database.selectFrom("links").select("id").execute()).map((row) => row.id)
      const highestPersisted = Math.max(...persistedIds.map((id) => Number(id.slice(prefix.length + 1))))
      expect(currentValueByPrefix.get(prefix)).toBeGreaterThanOrEqual(highestPersisted)
    }
    const storedGraphPayloads = await fixture.database.selectFrom("nodes")
      .select(["id", "content_json", "metadata_json"]).execute()
    expect(JSON.stringify(storedGraphPayloads)).not.toContain("local:")
    const occurrence = storedGraphPayloads.find((row) => row.id === result.graphAnchorIds[0])
    const occurrenceContent = JSON.parse(occurrence?.content_json ?? "{}") as Record<string, unknown>
    expect(result.graphAnchorIds).toContain(occurrenceContent.timeRef)
    expect(result.graphAnchorIds).toContain(occurrenceContent.locationRef)
    expect(readdirSync(join(fixture.workspaceRoot, "章节正文"))).toEqual(["第一章 世界种子.md"])
    const chapter = readFileSync(join(fixture.workspaceRoot, result.chapterPath), "utf8")
    expect(chapter.split("\n", 1)[0]).toBe(`# ${result.chapterHeading}`)

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
    expect(phaseRuns).toHaveLength(17)
    expect(retrievalRequest.remainingBudget?.retrievalExecutionDeadlineAtMs).toBeTypeOf("number")
    expect(retrievalRequest.remainingBudget?.retrievalPhaseDeadlineAtMs).toBeTypeOf("number")
    expect(context?.segments).toHaveLength(21)
    expect(context?.budget.maxTokens).toBe(62_080)
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
    expect(await fixture.database.selectFrom("kv_usage").selectAll().execute()).toHaveLength(17)
    const commitReview = phaseRuns.find((run) => run.phase === "commit_review")?.result as {
      artifact?: { continuityAdvice?: readonly { verdict?: string }[] }
    } | undefined
    expect(commitReview?.artifact?.continuityAdvice).toEqual([
      expect.objectContaining({ verdict: "conflict" }),
    ])
    expect((await fixture.taskScopes.findTask(result.taskId))?.status).toBe("completed")
    expect((await fixture.taskScopes.findScope(result.scopeId))?.visibility).toBe("committed")
  })

  it("keeps aggregate governance internal and sends self-contained projections to review stages", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const captured = new Map<string, TurnPhaseInput>()
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        if (["graph_governance_review", "settlement_review", "frontier_settlement", "commit_review"].includes(request.phase)) {
          captured.set(request.phase, request.input as TurnPhaseInput)
        }
        return fake.execute(request, options)
      },
    }

    await fixture.createOrchestrator(model, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "旧桥下出现一枚会记录潮汐时间的铜钥匙。",
      chapterSequence: 1,
    })

    for (const phase of ["graph_governance_review", "settlement_review", "frontier_settlement", "commit_review"] as const) {
      const input = captured.get(phase)
      expect(input?.artifacts.graph_governance, phase).toBeUndefined()
      expect(input?.stageProjection, phase).toMatchObject({ kind: phase })
      expect(input?.validationArtifacts?.graph_governance, phase).toBeDefined()
    }
  })

  it("canonicalizes duplicate model projections before staging graph settlement", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        const execution = await fake.execute(request, options)
        if (request.phase !== "graph_retrieval_design") return execution
        const artifact = execution.result.artifact as {
          projections: readonly {
            ownerProposalRef?: string
            ownerRef?: string
            exactKeys: readonly string[]
            semanticText: string
          }[]
          sourceSettlements: readonly unknown[]
        }
        const first = artifact.projections[0]
        if (first === undefined) throw new Error("Fake retrieval design must include a projection")
        return {
          ...execution,
          result: {
            ...execution.result,
            artifact: {
              ...artifact,
              projections: [
                ...artifact.projections,
                {
                  ...first,
                  exactKeys: ["canonical duplicate key"],
                  semanticText: "Canonical duplicate semantic entry.",
                },
              ],
            },
          },
        }
      },
    }

    const result = await fixture.createOrchestrator(model, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "旧桥下出现一枚会记录潮汐时间的铜钥匙。",
      chapterSequence: 1,
    })
    const projections = await fixture.database.selectFrom("retrieval_projections").selectAll()
      .where("scope_id", "=", result.scopeId)
      .where("owner_kind", "=", "node")
      .execute()

    expect(projections).toHaveLength(1)
    expect(JSON.parse(projections[0]?.exact_keys_json ?? "[]")).toContain("canonical duplicate key")
    expect(projections[0]?.semantic_text).toContain("Canonical duplicate semantic entry.")
    expect((await fixture.taskScopes.findTask(result.taskId))?.status).toBe("completed")
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
      info: fake.info,
      execute: (request) => {
        calls += 1
        if (request.phase === "graph_structure_plan") {
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

    expect(calls).toBe(10)
    expect(readdirSync(join(fixture.workspaceRoot, "章节正文"))).toEqual([])
    const interruptedTask = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    expect(interruptedTask.status).toBe("awaiting_user_decision")
    expect((await fixture.persistence.listPhaseRuns(interruptedTask.id)).at(-1)?.status).toBe("failed")
    expect((await fixture.database.selectFrom("artifact_scopes").selectAll().executeTakeFirstOrThrow()).visibility).toBe("pending")
    expect(await fixture.documentRepository.listCommittedChapters(fixture.projectId)).toEqual([])
  })

  it("feeds a capacity violation back to graph governance and commits the AI revision", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let structureCalls = 0
    let capacityRewriteCalls = 0
    let governanceReviewCalls = 0
    const phaseOrder: string[] = []
    let feedback: TurnPhaseInput["graphCapacity"]
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        phaseOrder.push(request.phase)
        const execution = await fake.execute(request, options)
        if (request.phase === "graph_structure_plan") structureCalls += 1
        if (request.phase === "graph_governance_review") governanceReviewCalls += 1
        if (request.phase !== "graph_capacity_rewrite") return execution
        capacityRewriteCalls += 1
        const phaseInput = request.input as TurnPhaseInput
        feedback = phaseInput.graphCapacity
        const rewrite = graphCapacityRewriteArtifactSchema.parse(execution.result.artifact)
        return {
          ...execution,
          result: {
            ...execution.result,
            artifact: {
              ...rewrite,
              affectedProposalRefs: ["proposal:mutation:5"],
              upsertProposals: [{
                proposalRef: "proposal:mutation:5",
                mutation: {
                  operation: "create_link",
                  ref: "local:location-link",
                  fromRef: "local:time",
                  toRef: "local:location",
                  content: { note: "space entry" },
                },
                reason: "Move the location outlet away from the hotspot",
                selfReview: "Only the hotspot-local proposal changed",
              }],
            },
          },
        }
      },
    }
    const settings = {
      ...defaultProjectSettings,
      graph: {
        ...defaultProjectSettings.graph,
        maxDirectInDegree: 1,
        maxDirectOutDegree: 1,
        mergeWarningThreshold: 1,
      },
    }

    const result = await fixture.createOrchestrator(model, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "用任意内容建立一个需要治理的局部图。",
      chapterSequence: 1,
      projectSettings: settings,
    })

    expect(structureCalls).toBe(1)
    expect(capacityRewriteCalls).toBe(1)
    expect(governanceReviewCalls).toBeGreaterThan(0)
    expect(phaseOrder.indexOf("graph_governance_review")).toBeGreaterThan(phaseOrder.lastIndexOf("graph_capacity_rewrite"))
    expect(feedback?.candidateAssessment).toMatchObject({
      round: 1,
      violations: [{ nodeId: "local:occurrence", exceeded: ["out"] }],
    })
    expect((await fixture.taskScopes.findTask(result.taskId))?.status).toBe("completed")
    expect((await fixture.graphRepository.getDegreeProfile({ projectId: fixture.projectId })).entries)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ inDegree: 0, outDegree: 1 }),
        expect.objectContaining({ inDegree: 1, outDegree: 1 }),
      ]))
  })

  it("loads persisted hotspot neighborhoods before retrying graph capacity governance", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "建立一个可在后续治理的既有局部图。",
      chapterSequence: 1,
    })
    const profile = await fixture.graphRepository.getDegreeProfile({ projectId: fixture.projectId })
    const persistedHotspot = profile.entries.find((entry) => entry.inDegree > 1 || entry.outDegree > 1)
    if (persistedHotspot === undefined) throw new Error("The first turn did not create a persisted capacity hotspot")
    const neighborhood = await fixture.graphRepository.getNeighborhood({
      scope: { projectId: fixture.projectId },
      anchorIds: [persistedHotspot.nodeId],
      direction: "both",
      maxDepth: 1,
      maxNodes: 100,
      maxLinks: 100,
    })
    await fixture.database.updateTable("model_context_messages")
      .set({ hidden_at: Date.now() })
      .where("hidden_at", "is", null)
      .execute()
    writeFileSync(
      join(fixture.workspaceRoot, "世界推演规则", "用户规则", "容量证据预算.md"),
      `# 容量证据预算\n\n${"必须继承的用户规则。".repeat(2_000)}\n`,
      "utf8",
    )
    let capacityRewriteCalls = 0
    let retryInput: TurnPhaseInput | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        if (request.phase === "graph_capacity_rewrite") {
          capacityRewriteCalls += 1
          retryInput = request.input as TurnPhaseInput
          throw new Error("capacity neighborhood captured")
        }
        return fake.execute(request, options)
      },
    }
    const settings = {
      ...defaultProjectSettings,
      retrieval: {
        ...defaultProjectSettings.retrieval,
        maxEvidenceTokens: 1_000,
      },
      graph: {
        ...defaultProjectSettings.graph,
        maxDirectInDegree: 1,
        maxDirectOutDegree: 1,
        mergeWarningThreshold: 1,
      },
    }

    await expect(fixture.createOrchestrator(model, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "继续发展，并在容量超限时重构既有局部图。",
      chapterSequence: 2,
      projectSettings: settings,
    })).rejects.toThrow("capacity neighborhood captured")

    expect(capacityRewriteCalls).toBe(1)
    expect(retryInput?.graphCapacity?.candidateAssessment?.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: persistedHotspot.nodeId }),
    ]))
    expect(retryInput?.readEvidence.find((evidence) => evidence.ownerId.endsWith("容量证据预算.md"))?.semanticText.length)
      .toBeGreaterThan(4_000)
    expect(retryInput?.readEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerKind: "node", ownerId: persistedHotspot.nodeId, stateRole: "current" }),
    ]))
    expect(retryInput?.readEvidence.some((evidence) => (
      evidence.ownerKind === "link" && neighborhood.links.some((link) => link.id === evidence.ownerId)
    ))).toBe(true)
  })

  it("pauses with all graph-governance attempts preserved after the capacity retry limit", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let structureCalls = 0
    let capacityRewriteCalls = 0
    let governanceReviewCalls = 0
    let repairAfterPause = false
    let resumedFeedback: TurnPhaseInput["graphCapacity"]
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        if (request.phase === "graph_structure_plan") structureCalls += 1
        if (request.phase === "graph_capacity_rewrite") capacityRewriteCalls += 1
        if (request.phase === "graph_governance_review") governanceReviewCalls += 1
        const execution = await fake.execute(request, options)
        if (request.phase !== "graph_capacity_rewrite" || !repairAfterPause) return execution
        resumedFeedback = (request.input as TurnPhaseInput).graphCapacity
        const rewrite = graphCapacityRewriteArtifactSchema.parse(execution.result.artifact)
        return {
          ...execution,
          result: {
            ...execution.result,
            artifact: {
              ...rewrite,
              affectedProposalRefs: ["proposal:mutation:5"],
              upsertProposals: [{
                proposalRef: "proposal:mutation:5",
                mutation: {
                  operation: "create_link",
                  ref: "local:location-link",
                  fromRef: "local:time",
                  toRef: "local:location",
                  content: { note: "space entry" },
                },
                reason: "Resolve the persisted capacity hotspot",
                selfReview: "The resumed rewrite remains hotspot-local",
              }],
            },
          },
        }
      },
    }
    const settings = {
      ...defaultProjectSettings,
      graph: {
        ...defaultProjectSettings.graph,
        maxDirectInDegree: 1,
        maxDirectOutDegree: 1,
        mergeWarningThreshold: 1,
      },
    }

    await expect(fixture.createOrchestrator(model, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "保持同一份超限候选以验证可恢复暂停。",
      chapterSequence: 1,
      projectSettings: settings,
    })).rejects.toThrow("Graph governance exceeded configured degree limits")

    const task = await fixture.taskScopes.findTask(
      (await fixture.database.selectFrom("tasks").select("id").executeTakeFirstOrThrow()).id,
    )
    const capacityRuns = (await fixture.persistence.listPhaseRuns(task?.taskId ?? ""))
      .filter((run) => run.phase === "graph_capacity_rewrite")
    expect(structureCalls).toBe(1)
    expect(capacityRewriteCalls).toBe(3)
    expect(governanceReviewCalls).toBe(0)
    expect(capacityRuns).toHaveLength(3)
    expect(capacityRuns.every((run) => run.status === "completed")).toBe(true)
    expect(task).toMatchObject({
      status: "awaiting_user_decision",
      lastPhase: "graph_capacity_rewrite",
      error: {
        kind: "graph_governance_limit_exhausted",
        recoverable: true,
      },
    })
    expect(readdirSync(join(fixture.workspaceRoot, "章节正文"))).toEqual([])
    expect(await fixture.documentRepository.listCommittedChapters(fixture.projectId)).toEqual([])

    repairAfterPause = true
    const resumed = await fixture.createOrchestrator(model, fixture.commit).resume({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "保持同一份超限候选以验证可恢复暂停。",
      chapterSequence: 1,
      taskId: task?.taskId,
      projectSettings: settings,
    })
    expect(resumedFeedback?.candidateAssessment).toMatchObject({
      violations: [{ nodeId: "local:occurrence", exceeded: ["out"] }],
    })
    expect(structureCalls).toBe(1)
    expect(capacityRewriteCalls).toBe(4)
    expect((await fixture.taskScopes.findTask(resumed.taskId))?.status).toBe("completed")
  })

  it("rewinds a stored governance artifact when stricter capacity limits apply on resume", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let failGovernanceReview = true
    let structureCalls = 0
    let capacityRewriteCalls = 0
    let rewoundFeedback: TurnPhaseInput["graphCapacity"]
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        if (request.phase === "graph_governance_review" && failGovernanceReview) {
          failGovernanceReview = false
          throw new Error("pause after the stored governance artifact")
        }
        const execution = await fake.execute(request, options)
        if (request.phase === "graph_structure_plan") structureCalls += 1
        if (request.phase !== "graph_capacity_rewrite") return execution
        capacityRewriteCalls += 1
        const input = request.input as TurnPhaseInput
        rewoundFeedback = input.graphCapacity
        const rewrite = graphCapacityRewriteArtifactSchema.parse(execution.result.artifact)
        return {
          ...execution,
          result: {
            ...execution.result,
            artifact: {
              ...rewrite,
              affectedProposalRefs: ["proposal:mutation:5"],
              upsertProposals: [{
                proposalRef: "proposal:mutation:5",
                mutation: {
                  operation: "create_link",
                  ref: "local:location-link",
                  fromRef: "local:time",
                  toRef: "local:location",
                  content: { note: "space entry" },
                },
                reason: "Adapt the stored structure to stricter limits",
                selfReview: "No unrelated proposal is changed",
              }],
            },
          },
        }
      },
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit)
    await expect(orchestrator.execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "先保存宽限额下的治理结果。",
      chapterSequence: 1,
      projectSettings: defaultProjectSettings,
    })).rejects.toThrow("pause after the stored governance artifact")
    const task = await fixture.taskScopes.findTask(
      (await fixture.database.selectFrom("tasks").select("id").executeTakeFirstOrThrow()).id,
    )
    const strictSettings = {
      ...defaultProjectSettings,
      graph: {
        ...defaultProjectSettings.graph,
        maxDirectInDegree: 1,
        maxDirectOutDegree: 1,
        mergeWarningThreshold: 1,
      },
    }

    const result = await orchestrator.resume({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "先保存宽限额下的治理结果。",
      chapterSequence: 1,
      taskId: task?.taskId,
      projectSettings: strictSettings,
    })

    expect(structureCalls).toBe(1)
    expect(capacityRewriteCalls).toBe(1)
    expect(rewoundFeedback?.candidateAssessment).toMatchObject({
      violations: [{ nodeId: "local:occurrence", exceeded: ["out"] }],
    })
    expect((await fixture.taskScopes.findTask(result.taskId))?.status).toBe("completed")
    const runs = await fixture.persistence.listPhaseRuns(result.taskId)
    expect(runs.filter((run) => run.phase === "graph_structure_plan" && run.status === "completed")).toHaveLength(1)
    expect(runs.filter((run) => run.phase === "graph_capacity_rewrite" && run.status === "completed")).toHaveLength(1)
  })

  it("rewinds an empty narrative dependency audit before resuming graph governance", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let returnInvalidAudit = true
    let interruptInvalidGovernance = true
    const dependencyRuns: string[] = []
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        const execution = await fake.execute(request, options)
        if (request.phase === "dependency_audit") {
          dependencyRuns.push(request.envelopeId)
          if (returnInvalidAudit) {
            returnInvalidAudit = false
            return {
              ...execution,
              result: {
                ...execution.result,
                artifact: {
                  ...execution.result.artifact,
                  sceneContinuity: [],
                },
              },
            }
          }
        }
        if (request.phase === "graph_structure_plan" && interruptInvalidGovernance) {
          interruptInvalidGovernance = false
          throw new Error("pause after invalid dependency audit")
        }
        return execution
      },
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit)
    const input = {
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "让第一章从雨夜车站开始。",
      chapterSequence: 1,
    }

    await expect(orchestrator.execute(input)).rejects.toThrow("pause after invalid dependency audit")
    const task = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    expect(task.status).toBe("awaiting_user_decision")
    expect(dependencyRuns).toHaveLength(1)

    const completed = await orchestrator.resume({ ...input, taskId: task.id })

    expect(completed.kind).toBe("turn")
    expect(dependencyRuns).toHaveLength(2)
    expect((await fixture.taskScopes.findTask(task.id))?.status).toBe("completed")
    const runs = await fixture.persistence.listPhaseRuns(task.id)
    expect(runs.filter((run) => run.phase === "dependency_audit" && run.status === "superseded")).toHaveLength(1)
    expect(runs.filter((run) => run.phase === "dependency_audit" && run.status === "completed")).toHaveLength(1)
  })

  it("rewinds a stored world effect without an effective scene without repeating structure governance", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let interruptCommitReview = true
    let structureCalls = 0
    let spacetimeCalls = 0
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        if (request.phase === "graph_structure_plan") structureCalls += 1
        if (request.phase === "graph_spacetime_settlement") spacetimeCalls += 1
        if (request.phase === "commit_review" && interruptCommitReview) {
          interruptCommitReview = false
          throw new Error("pause after staged graph governance")
        }
        return fake.execute(request, options)
      },
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit)
    const input = {
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "从上一场景继续前往老渡口。",
      chapterSequence: 21,
    }

    await expect(orchestrator.execute(input)).rejects.toThrow("pause after staged graph governance")
    const task = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    const spacetimeRun = await fixture.database.selectFrom("phase_runs").selectAll()
      .where("task_id", "=", task.id)
      .where("phase", "=", "graph_spacetime_settlement")
      .where("status", "=", "completed")
      .executeTakeFirstOrThrow()
    const result = JSON.parse(spacetimeRun.result_json as string) as {
      artifact: { proposalSettlements: Array<Record<string, unknown>> }
    }
    const storedRequest = JSON.parse(spacetimeRun.request_json as string) as { input: TurnPhaseInput }
    const chapterContent = [
      "# 第21章 世界种子",
      "最初没有宏大的宣告，只有一处尚未被命名的所在，在某个能够继续向前的时刻安静地显现。",
      input.userInput,
      "变化留下了可以再次返回的痕迹。此后发生的一切，都将从这些已经写下的依据继续生长。",
    ].join("\n\n")
    await fixture.documentRepository.stageVersion({
      id: "stale-document-id",
      projectId: fixture.projectId,
      scopeId: task.scope_id,
      sourceId: storedRequest.input.sourceId as string,
      chapterId: "stale-document-id",
      contentRef: join(fixture.store.documentsRef, `${String(storedRequest.input.sourceId)}.md`),
      heading: "第21章 世界种子",
      publishPath: "章节正文/第21章 世界种子.md",
      digest: digest(chapterContent),
      createdAtMs: task.created_at,
    })
    result.artifact.proposalSettlements[0] = {
      ...result.artifact.proposalSettlements[0],
      effectDisposition: "world_effect",
      effectiveSceneBindingIndexes: [],
      effectiveExistingSceneAnchorRefs: [],
    }
    await fixture.database.updateTable("phase_runs").set({ result_json: JSON.stringify(result) })
      .where("id", "=", spacetimeRun.id).executeTakeFirstOrThrow()

    const completed = await orchestrator.resume({ ...input, taskId: task.id })

    expect(completed.kind).toBe("turn")
    expect(structureCalls).toBe(1)
    expect(spacetimeCalls).toBe(2)
    expect((await fixture.taskScopes.findTask(task.id))?.status).toBe("completed")
    const runs = await fixture.persistence.listPhaseRuns(task.id)
    expect(runs.filter((run) => run.phase === "graph_structure_plan" && run.status === "completed")).toHaveLength(1)
    expect(runs.filter((run) => run.phase === "graph_spacetime_settlement" && run.status === "superseded")).toHaveLength(1)
    expect(runs.filter((run) => run.phase === "graph_spacetime_settlement" && run.status === "completed")).toHaveLength(1)
    expect(await fixture.database.selectFrom("document_versions").selectAll().execute()).toEqual([
      expect.objectContaining({ visibility: "committed", source_id: storedRequest.input.sourceId }),
    ])
  })

  it("rewinds a stored spacetime settlement that uses read evidence as a graph reference", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let interruptCommitReview = true
    let structureCalls = 0
    let spacetimeCalls = 0
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        if (request.phase === "graph_structure_plan") structureCalls += 1
        if (request.phase === "graph_spacetime_settlement") spacetimeCalls += 1
        if (request.phase === "commit_review" && interruptCommitReview) {
          interruptCommitReview = false
          throw new Error("pause after stored spacetime reference")
        }
        return fake.execute(request, options)
      },
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit)
    const input = {
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "继续当前场景并保存时空引用。",
      chapterSequence: 1,
    }

    await expect(orchestrator.execute(input)).rejects.toThrow("pause after stored spacetime reference")
    const task = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    const spacetimeRun = await fixture.database.selectFrom("phase_runs").selectAll()
      .where("task_id", "=", task.id)
      .where("phase", "=", "graph_spacetime_settlement")
      .where("status", "=", "completed")
      .executeTakeFirstOrThrow()
    const request = JSON.parse(spacetimeRun.request_json as string) as { input: TurnPhaseInput }
    const evidenceId = request.input.readEvidence[0]?.readId
    if (evidenceId === undefined) throw new Error("The test turn has no readable evidence")
    const result = JSON.parse(spacetimeRun.result_json as string) as {
      artifact: { sceneSpacetimeBindings: Array<Record<string, unknown>> }
    }
    result.artifact.sceneSpacetimeBindings[0] = {
      ...result.artifact.sceneSpacetimeBindings[0],
      temporalReferenceRefs: [evidenceId],
    }
    await fixture.database.updateTable("phase_runs").set({ result_json: JSON.stringify(result) })
      .where("id", "=", spacetimeRun.id).executeTakeFirstOrThrow()

    const completed = await orchestrator.resume({ ...input, taskId: task.id })

    expect(completed.kind).toBe("turn")
    expect(structureCalls).toBe(1)
    expect(spacetimeCalls).toBe(2)
    const runs = await fixture.persistence.listPhaseRuns(task.id)
    expect(runs.filter((run) => run.phase === "graph_spacetime_settlement" && run.status === "superseded")).toHaveLength(1)
    expect(runs.filter((run) => run.phase === "graph_spacetime_settlement" && run.status === "completed")).toHaveLength(1)
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

  it("rewrites a query draft when response review finds the answer is not evidence closed", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const observedPhases: string[] = []
    let draftCalls = 0
    let reviewCalls = 0
    let revisionFeedback: TurnPhaseInput["revisionFeedback"]
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        observedPhases.push(request.phase)
        const execution = await fake.execute(request)
        if (request.phase === "draft") {
          draftCalls += 1
          if (draftCalls === 2) revisionFeedback = (request.input as TurnPhaseInput).revisionFeedback
          return {
            ...execution,
            result: {
              ...execution.result,
              artifact: {
                ...(execution.result.artifact as Record<string, unknown>),
                contentMarkdown: draftCalls === 1 ? "未使用已读原文的旧答案" : "根据已读 Source 修订后的答案",
              },
            },
          }
        }
        if (request.phase === "response_review") {
          reviewCalls += 1
          if (reviewCalls === 1) {
            return {
              ...execution,
              result: {
                ...execution.result,
                outcome: "revise",
                reason: "旧答案遗漏了已经读取的 Source 原文",
                artifact: {
                  evidenceClosed: false,
                  leaksUnobservedInformation: false,
                  requiresWorkflowUpgrade: false,
                },
              },
            }
          }
        }
        return execution
      },
    }

    const result = await fixture.createOrchestrator(model, fixture.commit).execute({
      workflow: "query",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "返回已经读取的精确原文。",
      chapterSequence: 1,
      allowWorkspaceChapterReads: false,
    })

    expect(result.kind).toBe("query")
    if (result.kind !== "query") throw new Error("Expected a query result")
    expect(result.answerMarkdown).toBe("根据已读 Source 修订后的答案")
    expect(observedPhases).toEqual([
      "interpret",
      "rule_assembly",
      "source_retrieval",
      "draft",
      "response_review",
      "draft",
      "response_review",
    ])
    expect(revisionFeedback).toMatchObject({
      phase: "response_review",
      outcome: "revise",
      artifact: { evidenceClosed: false },
      reason: "旧答案遗漏了已经读取的 Source 原文",
    })
    const queryAttempts = await fixture.database.selectFrom("phase_runs").select(["phase", "status"])
      .where("phase", "in", ["draft", "response_review"]).orderBy("started_at").execute()
    expect(queryAttempts).toEqual([
      { phase: "draft", status: "completed" },
      { phase: "response_review", status: "completed" },
      { phase: "draft", status: "completed" },
      { phase: "response_review", status: "completed" },
    ])
  })

  it("rewrites a query when the review artifact fails even if its outcome says continue", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let draftCalls = 0
    let reviewCalls = 0
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        const execution = await fake.execute(request)
        if (request.phase === "draft") draftCalls += 1
        if (request.phase !== "response_review") return execution
        reviewCalls += 1
        if (reviewCalls > 1) return execution
        return {
          ...execution,
          result: {
            ...execution.result,
            outcome: "continue",
            reason: "回答没有闭合到已读证据",
            artifact: {
              evidenceClosed: false,
              leaksUnobservedInformation: false,
              requiresWorkflowUpgrade: false,
            },
          },
        }
      },
    }

    await fixture.createOrchestrator(model, fixture.commit).execute({
      workflow: "query",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "复核旧事实。",
      chapterSequence: 1,
      allowWorkspaceChapterReads: false,
    })

    expect(draftCalls).toBe(2)
    expect(reviewCalls).toBe(2)
  })

  it("pauses after query review exhaustion and resumes from a revised draft", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const observedPhases: string[] = []
    let reviewCalls = 0
    let repairAfterPause = false
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        observedPhases.push(request.phase)
        const execution = await fake.execute(request)
        if (request.phase !== "response_review") return execution
        reviewCalls += 1
        if (repairAfterPause) return execution
        return {
          ...execution,
          result: {
            ...execution.result,
            outcome: "revise",
            reason: "仍未使用已经读取的证据",
            artifact: {
              evidenceClosed: false,
              leaksUnobservedInformation: false,
              requiresWorkflowUpgrade: false,
            },
          },
        }
      },
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit)
    const input = {
      workflow: "query" as const,
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "返回早期原文。",
      chapterSequence: 1,
      allowWorkspaceChapterReads: false,
    }

    await expect(orchestrator.execute(input)).rejects.toThrow("Query draft still fails response review after 3 revision round(s)")
    const task = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    const phasesBeforeResume = observedPhases.length
    expect(task.status).toBe("awaiting_user_decision")
    expect(reviewCalls).toBe(3)

    repairAfterPause = true
    const result = await orchestrator.resume({ ...input, taskId: task.id })

    expect(result.kind).toBe("query")
    expect(observedPhases.slice(phasesBeforeResume)).toEqual(["draft", "response_review"])
    expect((await fixture.taskScopes.findTask(task.id))?.status).toBe("completed")
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
        if (request.phase === "draft") {
          draftInput = request.input as TurnPhaseInput
        }
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
      info: { ...fake.info, contextWindowTokens: 1_000_000 },
      execute: async (request, options) => {
        const execution = await fake.execute(request, options)
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
        if (request.phase === "draft") {
          draftInput = request.input as TurnPhaseInput
        }
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

  it("reads the ending window of an identified source before continuing", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const opening = "天亮时，林序从旧桥边醒来。"
    const middle = "午后，他乘车离开旧桥。"
    const ending = "夜里，林序抵达柳渡客栈，并在二楼住下。"
    await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: [opening, middle, ending].join("\n\n"),
      chapterSequence: 1,
    })
    let sourceReadRound = 0
    let draftInput: TurnPhaseInput | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        const execution = await fake.execute(request, options)
        if (request.phase === "interpret") {
          return {
            ...execution,
            result: {
              ...execution.result,
              outcome: "request_read",
              requestedReads: [{
                requestId: randomUUID(),
                reason: "先查找上一来源的入口",
                expectedEvidence: "上一来源的开篇入口",
                query: {
                  exactKeys: [opening], semanticTexts: [], anchorIds: [], directions: ["both"],
                  maxCandidates: 1, maxDepth: 1, sourceKinds: ["source"],
                },
              }],
            },
          }
        }
        if (request.phase === "source_retrieval" && sourceReadRound++ === 0) {
          const input = request.input as TurnPhaseInput
          const sourcePosition = input.readEvidence.find((evidence) => evidence.semanticText === opening)?.sourcePosition
          expect(sourcePosition?.isEnd).toBe(false)
          return {
            ...execution,
            result: {
              ...execution.result,
              outcome: "request_read",
              requestedReads: [{
                requestId: randomUUID(),
                reason: "开篇入口不能代表来源末端",
                expectedEvidence: "同一来源的末端连续窗口",
                query: {
                  exactKeys: [], semanticTexts: [], anchorIds: [], directions: ["both"],
                  maxCandidates: 2, maxDepth: 0, sourceKinds: ["source"],
                  sourceIds: sourcePosition === undefined ? [] : [sourcePosition.sourceRef],
                  sourceBoundary: "end",
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
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "从上一章实际结束的位置继续。",
      chapterSequence: 2,
      allowWorkspaceChapterReads: false,
    })

    expect(draftInput?.readEvidence.some((evidence) => evidence.semanticText === ending)).toBe(true)
    expect(draftInput?.readEvidence.some((evidence) => (
      evidence.ownerKind === "source" && evidence.sourcePosition?.isEnd === true
    ))).toBe(true)
    expect(draftInput?.readEvidence.some((evidence) => evidence.ownerKind === "workspace:chapters")).toBe(false)
  })

  it("does not expand a source window for a mixed graph and source request", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const sceneEntry = "林序抬头，看见旧桥右岸老槐树下站着一个人。"
    const retrievalEvents: Array<Readonly<Record<string, unknown>>> = []
    const phaseProfiles: Array<Readonly<Record<string, unknown>>> = []
    let draftInput: TurnPhaseInput | undefined

    await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: [
        sceneEntry,
        "旧桥边，她沿着河岸向前走了一步。",
        "旧桥下，苏禾说：“那张纸不是我撕走的。”",
        "旧桥另一侧，晨雾正在散开。",
      ].join("\n\n"),
      chapterSequence: 1,
    })

    const model: AIModelPort = {
      info: { ...fake.info, contextWindowTokens: 1_000_000 },
      execute: async (request, options) => {
        const execution = await fake.execute(request, options)
        if (request.phase === "draft") draftInput = request.input as TurnPhaseInput
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
                semanticTexts: ["旧桥"],
                anchorIds: [],
                directions: ["both"],
                maxCandidates: 2,
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
        if (event === "phase.model_request.started" && fields !== undefined) phaseProfiles.push(fields)
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
    expect(mixedRequests.some((event) => Number(event.sourceSemanticMatches) >= 2)).toBe(true)
    expect(mixedRequests.some((event) => Number(event.semanticMatches) >= 1)).toBe(true)
    expect(mixedRequests.every((event) => event.sourceNeighborhoodMatches === 0)).toBe(true)
    expect(mixedRequests.every((event) => Array.isArray(event.selectedCandidateProfile))).toBe(true)
    expect(mixedRequests.every((event) => typeof event.selectedEvidenceProfile === "object")).toBe(true)
    expect(mixedRequests.every((event) => typeof event.elapsedMs === "number")).toBe(true)
    expect(draftInput?.readEvidence.some((evidence) => evidence.ownerKind === "source")).toBe(true)
    expect(draftInput?.readEvidence.some((evidence) => (
      evidence.ownerKind === "node" || evidence.ownerKind === "link"
    ))).toBe(true)
    expect(phaseProfiles.length).toBeGreaterThan(0)
    expect(phaseProfiles.every((event) => typeof event.visibleEvidenceProfile === "object")).toBe(true)
    expect(phaseProfiles.every((event) => typeof event.phaseInputCharacters === "number")).toBe(true)
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
    const interpretInputs: TurnPhaseInput[] = []
    let ruleAssemblyInput: TurnPhaseInput | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request) => {
        const execution = await fake.execute(request)
        if (request.phase === "interpret") {
          interpretCalls += 1
          interpretInputs.push(request.input as TurnPhaseInput)
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
    expect(interpretCalls).toBe(3)
    expect(interpretInputs[2]?.resurfacedReadIds).toEqual(expect.arrayContaining([
      expect.any(String),
    ]))
    expect(graphEvidence.length).toBeGreaterThan(0)
    expect(new Set(stableEvidenceKeys).size).toBe(stableEvidenceKeys.length)
  })

  it("keeps dynamically read evidence visible for the rest of the turn even when interpret omits its citation", async () => {
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
    expect(ruleAssemblyInput?.readEvidence.some((evidence) => evidence.ownerKind === "node" && evidence.semanticText.includes("甲事件"))).toBe(true)
    expect(graphEvidence.length).toBeGreaterThan(0)
    expect(graphEvidence.some((evidence) => evidence.semanticText.includes("乙事件"))).toBe(true)
    expect(graphEvidence.some((evidence) => evidence.semanticText.includes("甲事件"))).toBe(true)
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
    expect(Object.keys(observed.get("graph_structure_plan")?.artifacts ?? {})).toEqual([
      "source_retrieval",
      "emergence_planning",
      "emergence_review",
      "draft",
      "dependency_audit",
      "settings_extraction",
    ])
    expect(observed.get("graph_structure_plan")?.artifacts.chapter_naming).toBeUndefined()
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
      "graph_structure_plan",
      "graph_spacetime_settlement",
      "graph_retrieval_design",
      "graph_governance_review",
      "graph_governance_review",
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
    const checkpoint = await sql<{ phase: string }>`
      SELECT checkpoints.phase
      FROM task_checkpoint_heads heads
      JOIN task_checkpoints checkpoints ON checkpoints.id = heads.checkpoint_id
      WHERE heads.task_id = ${task.id}
    `.execute(fixture.database)
    expect(checkpoint.rows).toEqual([{ phase: "interpret" }])
    const callsBeforeResume = observedPhases.length

    await expect(orchestrator.resume({ ...input, taskId: task.id, maxModelCalls: 63 }))
      .rejects.toThrow("Explicit budget reset required")
    const result = await orchestrator.resume({ ...input, taskId: task.id, maxModelCalls: 63, resetMetricIds: ["model_calls"] })

    expect(observedPhases.slice(0, callsBeforeResume)).toEqual(["interpret"])
    expect(observedPhases[callsBeforeResume]).toBe("rule_assembly")
    expect(result.modelCalls).toBe(17)
    expect((await fixture.taskScopes.findTask(task.id))?.status).toBe("completed")
    expect(readdirSync(join(fixture.workspaceRoot, "章节正文"))).toEqual(["第一章 世界种子.md"])
  })

  it("supersedes an orphaned running phase before resuming from its stable input", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const orchestrator = fixture.createOrchestrator(fake, fixture.commit)
    const input = {
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "从稳定检查点恢复，不保留失联中的模型请求。",
      chapterSequence: 1,
    }

    await expect(orchestrator.execute({ ...input, maxModelCalls: 1 })).rejects.toThrow("Model call budget exhausted")
    const task = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    const completed = await fixture.database.selectFrom("phase_runs").selectAll()
      .where("task_id", "=", task.id).where("phase", "=", "interpret").executeTakeFirstOrThrow()
    const orphanedPhaseRunId = randomUUID()
    await fixture.database.insertInto("phase_runs").values({
      ...completed,
      id: orphanedPhaseRunId,
      attempt: completed.attempt + 1,
      status: "running",
      result_json: null,
      finished_at: null,
    }).executeTakeFirstOrThrow()

    await orchestrator.resume({
      ...input,
      taskId: task.id,
      maxModelCalls: 63,
      resetMetricIds: ["model_calls"],
    })

    const runs = await fixture.persistence.listPhaseRuns(task.id)
    expect(runs.find((run) => run.phaseRunId === orphanedPhaseRunId)?.status).toBe("superseded")
    expect(runs.filter((run) => run.status === "running")).toEqual([])
  })

  it("resumes a failed read from the phase that still owns the request", async () => {
    const fixture = await createFixture()
    await fixture.workspace.saveUserMarkdown(
      fixture.workspaceRoot,
      "参考文件/探针中断.md",
      "# 探针中断\n\n这份资料用于验证读取失败后的阶段恢复。\n",
    )
    const fake = new FakeAiModelAdapter(randomUUID)
    const workspace = new FailOnceMarkdownReadWorkspace("参考文件/探针中断.md")
    let requestedReadId: string | undefined
    const observedPhases: string[] = []
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        observedPhases.push(request.phase)
        const input = request.input as TurnPhaseInput
        const hasProbeSource = input.readEvidence.some((evidence) => evidence.ownerId === "参考文件/探针中断.md")
        if (request.phase === "interpret" && !hasProbeSource) {
          const result = await fake.execute(request, options)
          requestedReadId ??= randomUUID()
          return {
            ...result,
            result: {
              ...result.result,
              outcome: "request_read",
              requestedReads: [{
                requestId: requestedReadId,
                reason: "Load the probe recovery source",
                expectedEvidence: "The probe recovery source",
                query: {
                  exactKeys: ["探针中断.md"],
                  semanticTexts: ["探针中断"],
                  anchorIds: [],
                  directions: ["both"],
                  maxCandidates: 4,
                  maxDepth: 0,
                  sourceKinds: ["reference"],
                },
              }],
              reason: "The interpretation requires one reference document",
              selfReview: "The request is limited to the relevant reference document",
            },
          }
        }
        if (request.phase === "interpret" && hasProbeSource) {
          return fake.execute(request, options)
        }
        return fake.execute(request, options)
      },
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit, undefined, workspace)
    const input = {
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "验证读取失败后的恢复。",
      chapterSequence: 1,
    }

    await expect(orchestrator.execute(input)).rejects.toThrow("Injected probe read failure")
    const task = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    expect(task.status).toBe("awaiting_user_decision")

    const callsBeforeResume = observedPhases.length
    await orchestrator.resume({ ...input, taskId: task.id }, "continue")

    expect(observedPhases[callsBeforeResume]).toBe("interpret")
    expect(observedPhases.slice(callsBeforeResume).filter((phase) => phase === "interpret")).toHaveLength(2)
    expect((await fixture.taskScopes.findTask(task.id))?.status).toBe("completed")
  })

  it("resumes semantic verification from the first unfinished persisted probe", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let probePlan: Awaited<ReturnType<AIModelPort["execute"]>>["result"]["requestedReads"] = []
    const observedProbeExecutionCounts: number[] = []
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        const execution = await fake.execute(request, options)
        if (request.phase !== "graph_governance_review") return execution
        const input = request.input as TurnPhaseInput
        const completedCount = input.verificationProbeExecutions?.length ?? 0
        observedProbeExecutionCounts.push(completedCount)
        if (probePlan.length === 0) probePlan = execution.result.requestedReads
        if (completedCount >= 4) return execution
        return {
          ...execution,
          result: {
            ...execution.result,
            outcome: "request_read",
            requestedReads: probePlan,
          },
        }
      },
    }
    const originalSearchText = fixture.retrievalRepository.searchText.bind(fixture.retrievalRepository)
    let semanticProbeQueries = 0
    fixture.retrievalRepository.searchText = async (...args) => {
      semanticProbeQueries += 1
      if (semanticProbeQueries === 3) throw new Error("Injected semantic verification interruption")
      return originalSearchText(...args)
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit)
    const input = {
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "验证治理探针能够从中断位置恢复。",
      chapterSequence: 1,
    }

    await expect(orchestrator.execute(input)).rejects.toThrow("Injected semantic verification interruption")
    const task = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    const interruptedCheckpoints = await fixture.persistence.listVerificationProbeCheckpoints(task.id)

    expect(interruptedCheckpoints.map((checkpoint) => checkpoint.probeIndex)).toEqual([0, 1])
    expect(task.status).toBe("awaiting_user_decision")

    await orchestrator.resume({ ...input, taskId: task.id })

    const completedCheckpoints = await fixture.persistence.listVerificationProbeCheckpoints(task.id)
    const finalSemanticRun = (await fixture.persistence.listPhaseRuns(task.id))
      .filter((run) => run.phase === "graph_governance_review")
      .at(-1)
    const finalSemanticInput = (finalSemanticRun?.request as { input?: TurnPhaseInput } | undefined)?.input

    expect(semanticProbeQueries).toBe(5)
    expect(observedProbeExecutionCounts).toEqual([0, 2, 4])
    expect(completedCheckpoints.map((checkpoint) => checkpoint.probeIndex)).toEqual([0, 1, 2, 3])
    expect(new Set(completedCheckpoints.map((checkpoint) => checkpoint.planDigest)).size).toBe(4)
    expect(finalSemanticInput?.verificationProbeExecutions).toHaveLength(4)
    expect((await fixture.taskScopes.findTask(task.id))?.status).toBe("completed")
  })

  it("marks a final graph review with missing probe assessments as failed", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let governanceReviewCalls = 0
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        const execution = await fake.execute(request, options)
        if (request.phase !== "graph_governance_review") return execution
        governanceReviewCalls += 1
        if (governanceReviewCalls === 1) return execution
        return {
          ...execution,
          result: {
            ...execution.result,
            requestedReads: [],
            artifact: {
              ...(execution.result.artifact as Record<string, unknown>),
              verificationProbeAssessments: [],
            },
          },
        }
      },
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit)

    await expect(orchestrator.execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "验证图审核失败状态。",
      chapterSequence: 1,
    })).rejects.toThrow("Graph review must assess every application-executed verification probe exactly once")

    const task = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    const governanceRuns = (await fixture.persistence.listPhaseRuns(task.id))
      .filter((run) => run.phase === "graph_governance_review")
    expect(governanceRuns.at(-1)?.status).toBe("failed")
  })

  it("retries semantic review from its phase entry while preserving superseded attempts", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let probePlan: Awaited<ReturnType<AIModelPort["execute"]>>["result"]["requestedReads"] = []
    const observedProbeExecutionCounts: number[] = []
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        const execution = await fake.execute(request, options)
        if (request.phase !== "graph_governance_review") return execution
        const input = request.input as TurnPhaseInput
        const completedCount = input.verificationProbeExecutions?.length ?? 0
        observedProbeExecutionCounts.push(completedCount)
        if (probePlan.length === 0) probePlan = execution.result.requestedReads
        if (completedCount >= 4) return execution
        return {
          ...execution,
          result: { ...execution.result, outcome: "request_read", requestedReads: probePlan },
        }
      },
    }
    const originalSearchText = fixture.retrievalRepository.searchText.bind(fixture.retrievalRepository)
    let semanticProbeQueries = 0
    fixture.retrievalRepository.searchText = async (...args) => {
      semanticProbeQueries += 1
      if (semanticProbeQueries === 3) throw new Error("Injected retry-phase verification interruption")
      return originalSearchText(...args)
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit)
    const input = {
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "验证重试当前阶段会从阶段入口重新开始。",
      chapterSequence: 1,
    }

    await expect(orchestrator.execute(input)).rejects.toThrow("Injected retry-phase verification interruption")
    const task = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    const interruptedSemanticRuns = (await fixture.persistence.listPhaseRuns(task.id))
      .filter((run) => run.phase === "graph_governance_review")
    expect(await fixture.persistence.listVerificationProbeCheckpoints(task.id)).toHaveLength(2)

    await orchestrator.resume({ ...input, taskId: task.id }, "retry_phase")

    const allSemanticRuns = (await fixture.persistence.listPhaseRuns(task.id))
      .filter((run) => run.phase === "graph_governance_review")
    const activeCheckpoints = await fixture.persistence.listVerificationProbeCheckpoints(task.id)
    const allCheckpointRows = await fixture.database.selectFrom("verification_probe_executions").selectAll()
      .where("task_id", "=", task.id).execute()
    const supersededMessages = await fixture.database.selectFrom("model_context_messages").selectAll()
      .where("origin_phase_run_id", "in", interruptedSemanticRuns.map((run) => run.phaseRunId)).execute()

    expect(semanticProbeQueries).toBe(7)
    expect(observedProbeExecutionCounts).toEqual([0, 0, 4])
    expect(activeCheckpoints.map((checkpoint) => checkpoint.probeIndex)).toEqual([0, 1, 2, 3])
    expect(allCheckpointRows).toHaveLength(6)
    expect(allSemanticRuns.filter((run) => run.status === "superseded")).toHaveLength(interruptedSemanticRuns.length)
    expect(supersededMessages.every((message) => message.hidden_at !== null)).toBe(true)
    expect((await fixture.taskScopes.findTask(task.id))?.status).toBe("completed")
  })

  it("resumes chapter finalization without rerunning AI or duplicating the committed scope", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let modelCalls = 0
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        modelCalls += 1
        return fake.execute(request, options)
      },
    }
    const workspace = new FailOnceChapterPublishWorkspace()
    const orchestrator = fixture.createOrchestrator(model, fixture.commit, undefined, workspace)
    const input = {
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "世界从一盏雨夜中的灯开始。",
      chapterSequence: 1,
    }

    await expect(orchestrator.execute(input)).rejects.toThrow("Injected chapter publish failure")
    const task = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    const interruptedFinalization = await fixture.database.selectFrom("turn_finalizations").selectAll()
      .where("task_id", "=", task.id).executeTakeFirstOrThrow()
    const callsBeforeResume = modelCalls

    expect(task.status).toBe("awaiting_user_decision")
    expect(interruptedFinalization.status).toBe("scope_committed")
    expect((await fixture.taskScopes.findScope(task.scope_id))?.visibility).toBe("committed")

    const result = await orchestrator.resume({ ...input, taskId: task.id })
    const completedFinalization = await fixture.database.selectFrom("turn_finalizations").selectAll()
      .where("task_id", "=", task.id).executeTakeFirstOrThrow()
    const canonicalMessages = await fixture.database.selectFrom("canonical_chapter_messages").selectAll().execute()
    const repeatedCommit = await fixture.commit.commit(result.scopeId)
    const project = await fixture.database.selectFrom("projects").select("committed_sequence")
      .where("id", "=", fixture.projectId).executeTakeFirstOrThrow()

    expect(modelCalls).toBe(callsBeforeResume)
    expect(workspace.publishAttempts).toBe(2)
    expect(completedFinalization.status).toBe("completed")
    expect(canonicalMessages).toHaveLength(1)
    expect(canonicalMessages[0]?.content_digest).toBe(completedFinalization.content_digest)
    expect(repeatedCommit.committedSequence).toBe(1)
    expect(project.committed_sequence).toBe(1)
    expect(readdirSync(join(fixture.workspaceRoot, "章节正文"))).toEqual(["第一章 世界种子.md"])
  })

  it("resumes finalization from a prepared record after scope commit fails", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let modelCalls = 0
    let commitAttempts = 0
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        modelCalls += 1
        return fake.execute(request, options)
      },
    }
    const commit: ScopeCommitRepository = {
      resetPending: (scopeId) => fixture.commit.resetPending(scopeId),
      commit: async (scopeId) => {
        commitAttempts += 1
        if (commitAttempts === 1) throw new Error("Injected scope commit failure")
        return fixture.commit.commit(scopeId)
      },
      retire: (scopeId, retiredAtMs) => fixture.commit.retire(scopeId, retiredAtMs),
    }
    const orchestrator = fixture.createOrchestrator(model, commit)
    const input = {
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "验证作用域提交失败后的最终化恢复。",
      chapterSequence: 1,
    }

    await expect(orchestrator.execute(input)).rejects.toThrow("Injected scope commit failure")
    const task = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    const callsBeforeResume = modelCalls
    expect((await fixture.persistence.findFinalizationByTask(task.id))?.status).toBe("prepared")

    await orchestrator.resume({ ...input, taskId: task.id })

    expect(modelCalls).toBe(callsBeforeResume)
    expect(commitAttempts).toBe(2)
    expect((await fixture.persistence.findFinalizationByTask(task.id))?.status).toBe("completed")
    expect(await fixture.database.selectFrom("canonical_chapter_messages").selectAll().execute()).toHaveLength(1)
  })

  it("resumes registered chapter finalization without duplicating its canonical message", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let modelCalls = 0
    let registerAttempts = 0
    let completionAttempts = 0
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        modelCalls += 1
        return fake.execute(request, options)
      },
    }
    const originalRegister = fixture.persistence.registerCanonicalChapter.bind(fixture.persistence)
    fixture.persistence.registerCanonicalChapter = async (...args) => {
      registerAttempts += 1
      if (registerAttempts === 1) throw new Error("Injected chapter registration failure")
      return originalRegister(...args)
    }
    const originalComplete = fixture.persistence.completeFinalization.bind(fixture.persistence)
    fixture.persistence.completeFinalization = async (...args) => {
      completionAttempts += 1
      if (completionAttempts === 1) throw new Error("Injected finalization completion failure")
      return originalComplete(...args)
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit)
    const input = {
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "验证章节登记与完成标记的逐步恢复。",
      chapterSequence: 1,
    }

    await expect(orchestrator.execute(input)).rejects.toThrow("Injected chapter registration failure")
    const task = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    const callsBeforeResume = modelCalls
    expect((await fixture.persistence.findFinalizationByTask(task.id))?.status).toBe("chapter_published")

    await expect(orchestrator.resume({ ...input, taskId: task.id }))
      .rejects.toThrow("Injected finalization completion failure")
    expect((await fixture.persistence.findFinalizationByTask(task.id))?.status).toBe("chapter_registered")

    await orchestrator.resume({ ...input, taskId: task.id })

    expect(modelCalls).toBe(callsBeforeResume)
    expect(registerAttempts).toBe(2)
    expect(completionAttempts).toBe(2)
    expect(await fixture.database.selectFrom("canonical_chapter_messages").selectAll().execute()).toHaveLength(1)
    expect((await fixture.database.selectFrom("model_context_messages").selectAll()
      .where("kind", "=", "canonical_chapter").execute())).toHaveLength(1)
  })

  it("reuses one persistent model context chain across consecutive turns", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const observedRequests: Array<{
      taskId: string
      phase: string
      chainId?: string
      messages: readonly { kind: string; content: string }[]
    }> = []
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        expect(options?.phasePrompt?.text.length).toBeGreaterThan(0)
        observedRequests.push({
          taskId: request.taskId,
          phase: request.phase,
          chainId: options?.contextChainId,
          messages: options?.contextMessages ?? [],
        })
        return fake.execute(request, options)
      },
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit)
    const baseInput = {
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
    }

    const first = await orchestrator.execute({
      ...baseInput,
      userInput: "世界从一盏雨夜中的灯开始。",
      chapterSequence: 1,
    })
    const second = await orchestrator.execute({
      ...baseInput,
      userInput: "第二天清晨，灯下的人推开了门。",
      chapterSequence: 2,
    })

    const chains = await fixture.database.selectFrom("model_context_chains").selectAll().execute()
    const storedMessages = await fixture.database.selectFrom("model_context_messages").selectAll()
      .orderBy("sequence_no").execute()
    const firstRequest = observedRequests.find((request) => request.taskId === first.taskId)
    const secondRequest = observedRequests.find((request) => request.taskId === second.taskId)

    expect(chains).toHaveLength(1)
    expect(new Set(observedRequests.map((request) => request.chainId))).toEqual(new Set([chains[0]?.id]))
    expect(firstRequest?.messages.map((message) => message.kind)).toEqual(["system_rules"])
    expect(secondRequest?.messages.filter((message) => message.kind === "system_rules")).toHaveLength(1)
    expect(secondRequest?.messages.find((message) => message.kind === "canonical_chapter")?.content)
      .toContain("第一章 世界种子")
    expect(storedMessages.filter((message) => message.kind === "system_rules")).toHaveLength(1)
    expect(storedMessages.filter((message) => message.kind === "canonical_chapter")).toHaveLength(2)
    expect(storedMessages.map((message) => message.sequence_no)).toEqual(
      storedMessages.map((_, index) => index),
    )
  })

  it("restores a manual checkpoint as an isolated paused task that can complete", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let interruptDependencyAudit = true
    const interruptingModel: AIModelPort = {
      info: fake.info,
      execute: (request, options) => {
        if (request.phase === "dependency_audit" && interruptDependencyAudit) {
          interruptDependencyAudit = false
          throw new Error("Injected checkpoint history interruption")
        }
        return fake.execute(request, options)
      },
    }
    const input = {
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "雨夜里，一盏灯在无人知晓的旧站台亮起。",
      chapterSequence: 1,
    }
    const originalOrchestrator = fixture.createOrchestrator(interruptingModel, fixture.commit)
    await expect(originalOrchestrator.execute(input)).rejects.toThrow("Injected checkpoint history interruption")
    const originalTask = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    const originalCheckpoint = await fixture.persistence.findTaskCheckpointByTask(originalTask.id)
    expect(originalCheckpoint?.phase).toBe("chapter_naming")

    const historyRepository = new SqliteHistoryRepository(fixture.database, randomUUID)
    const historyVcs = new IsomorphicGitHistoryAdapter(fixture.store.historyGitRef)
    const historyService = new HistoryService(
      historyRepository,
      new HistoryManifestBuilder(historyRepository, new NodeWorkspaceSnapshotAdapter(fixture.workspace)),
      historyVcs,
      Date.now,
    )
    const saved = await historyService.saveManual({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId: randomUUID(),
      name: "章节命名后的稳定检查点",
      taskId: originalTask.id,
      checkpointId: originalCheckpoint?.phaseRunId,
      createdAtMs: Date.now(),
    }, true)

    await originalOrchestrator.resume({ ...input, taskId: originalTask.id })
    const originalScope = await fixture.database.selectFrom("artifact_scopes").select("visibility")
      .where("id", "=", originalTask.scope_id).executeTakeFirstOrThrow()
    expect(originalScope.visibility).toBe("committed")

    const checkout = new HistoryCheckoutService(
      historyRepository,
      historyVcs,
      new NodeWorkspaceSnapshotAdapter(fixture.workspace),
      Date.now,
    )
    const restored = await checkout.checkout({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      operationId: randomUUID(),
      entryId: saved.entryId,
      mode: "continue_from",
      startedAtMs: Date.now(),
    })
    expect(restored.restoredTaskId).toBeDefined()
    expect(restored.restoredTaskId).not.toBe(originalTask.id)
    expect(await fixture.database.selectFrom("tasks").select("status")
      .where("id", "=", originalTask.id).executeTakeFirstOrThrow()).toEqual({ status: "completed" })
    const restoredTask = await fixture.database.selectFrom("tasks").selectAll()
      .where("id", "=", restored.restoredTaskId as string).executeTakeFirstOrThrow()
    expect(restoredTask.status).toBe("paused")
    expect(await fixture.database.selectFrom("artifact_scopes").select("visibility")
      .where("id", "=", restoredTask.scope_id).executeTakeFirstOrThrow()).toEqual({ visibility: "pending" })

    const completed = await fixture.createOrchestrator(fake, fixture.commit).resume({
      ...input,
      taskId: restored.restoredTaskId as string,
    })
    expect(completed.kind).toBe("turn")
    expect(await fixture.database.selectFrom("tasks").select("status")
      .where("id", "=", restored.restoredTaskId as string).executeTakeFirstOrThrow()).toEqual({ status: "completed" })
    expect(await fixture.database.selectFrom("artifact_scopes").select("visibility")
      .where("id", "=", restoredTask.scope_id).executeTakeFirstOrThrow()).toEqual({ visibility: "committed" })
    expect(await fixture.database.selectFrom("document_versions").selectAll().execute()).toHaveLength(2)
  })

  it("rejects a stale history-generation task before resuming model execution", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let modelCalls = 0
    let interruptDependencyAudit = true
    const model: AIModelPort = {
      info: fake.info,
      execute: (request, options) => {
        modelCalls += 1
        if (request.phase === "dependency_audit" && interruptDependencyAudit) {
          interruptDependencyAudit = false
          throw new Error("Injected interruption before history switch")
        }
        return fake.execute(request, options)
      },
    }
    const input = {
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "雨夜里，旧站台的灯再次亮起。",
      chapterSequence: 1,
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit)
    await expect(orchestrator.execute(input)).rejects.toThrow("Injected interruption before history switch")
    const task = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    await fixture.database.updateTable("projects").set({ active_generation: 1 })
      .where("id", "=", fixture.projectId).execute()
    const callsBeforeResume = modelCalls

    await expect(orchestrator.resume({ ...input, taskId: task.id }))
      .rejects.toThrow("inactive history generation")
    expect(modelCalls).toBe(callsBeforeResume)
  })

  it("inherits still-visible evidence into the next turn without issuing a synthetic read", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "第一轮建立可继续引用的图证据。",
      chapterSequence: 1,
    })
    const oldEvidenceId = (await fixture.database.selectFrom("evidence_objects").select("id")
      .orderBy("created_at").executeTakeFirstOrThrow()).id
    let interpretInput: TurnPhaseInput | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        const execution = await fake.execute(request, options)
        if (request.phase !== "interpret") return execution
        interpretInput = request.input as TurnPhaseInput
        return {
          ...execution,
          result: { ...execution.result, citedReadIds: [oldEvidenceId] },
        }
      },
    }

    const second = await fixture.createOrchestrator(model, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "第二轮继续使用仍在活动链中的旧证据。",
      chapterSequence: 2,
    })
    const context = await fixture.persistence.findContextByTask(second.taskId)

    expect(interpretInput?.readEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ readId: oldEvidenceId, visibility: "committed" }),
    ]))
    expect(context?.readLedger.committedReadIds).toContain(oldEvidenceId)
    expect(context?.readLedger.requestedReadIds).not.toContain(oldEvidenceId)
  })

  it("does not inherit visible chapter workspace evidence when chapter reads are disabled", async () => {
    const fixture = await createFixture()
    await fixture.workspace.publishChapter(
      fixture.workspaceRoot,
      "章节正文/旧章节.md",
      "# 旧章节\n\n这一句只用于验证活动链中的章节证据不会泄漏到严格查询。\n",
    )
    const fake = new FakeAiModelAdapter(randomUUID)
    let requestedChapter = false
    const firstModel: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        const execution = await fake.execute(request, options)
        if (request.phase !== "source_retrieval" || requestedChapter) return execution
        requestedChapter = true
        return {
          ...execution,
          result: {
            ...execution.result,
            outcome: "request_read",
            requestedReads: [{
              requestId: randomUUID(),
              reason: "建立可继承的章节工作区证据",
              expectedEvidence: "旧章节原文",
              query: {
                exactKeys: ["旧章节.md"],
                semanticTexts: ["活动链中的章节证据"],
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
    await fixture.createOrchestrator(firstModel, fixture.commit).execute({
      workflow: "query",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "读取旧章节。",
      chapterSequence: 1,
      allowWorkspaceChapterReads: true,
    })

    let interpretInput: TurnPhaseInput | undefined
    const secondModel: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        if (request.phase === "interpret") interpretInput = request.input as TurnPhaseInput
        return fake.execute(request, options)
      },
    }
    await fixture.createOrchestrator(secondModel, fixture.commit).execute({
      workflow: "query",
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "只通过图与 Source 查询。",
      chapterSequence: 1,
      allowWorkspaceChapterReads: false,
    })

    expect(interpretInput?.readEvidence.some((evidence) => evidence.ownerKind === "workspace:chapters")).toBe(false)
  })

  it("uses the selected model capacity to mechanically hide old work and old chapters", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const firstModel: AIModelPort = {
      info: { ...fake.info, model: "large-context", contextWindowTokens: 1_000_000 },
      execute: (request, options) => fake.execute(request, options),
    }
    const first = await fixture.createOrchestrator(firstModel, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: `建立一段很长但完整提交的旧正文：${"旧世界内容".repeat(2_000)}`,
      chapterSequence: 1,
    })
    const firstMessages = await fixture.database.selectFrom("model_context_messages").selectAll()
      .where("task_id", "=", first.taskId).execute()
    const actualFirstTurnTokens = firstMessages.reduce((total, message) => (
      total + estimateModelMessageTokens(message.content_text ?? "")
    ), 0)
    const smallContextWindow = Math.max(100_000, Math.floor(actualFirstTurnTokens * 0.75))
    await fixture.database.updateTable("model_context_messages").set({ token_estimate: 1 }).execute()
    const underestimatedMessageCount = (await fixture.database.selectFrom("model_context_messages")
      .select(sql<number>`count(*)`.as("count")).executeTakeFirstOrThrow()).count
    await fixture.database.updateTable("model_context_chains")
      .set({ token_estimate: underestimatedMessageCount }).execute()
    const secondModel: AIModelPort = {
      info: { ...fake.info, model: "small-context", contextWindowTokens: smallContextWindow },
      execute: (request, options) => fake.execute(request, options),
    }
    const compactingSettings = {
      ...defaultProjectSettings,
      execution: {
        ...defaultProjectSettings.execution,
        contextCompactionThresholdRatio: 0.97,
        contextCompressionTargetRatio: 0.1,
      },
    }
    const chainBeforeCompaction = await fixture.database.selectFrom("model_context_chains")
      .selectAll().executeTakeFirstOrThrow()
    const inheritedBeforeCompaction = await fixture.persistence.listVisibleModelContextEvidence(
      chainBeforeCompaction.id,
    )
    let secondInterpretInput: TurnPhaseInput | undefined
    const compactingModel: AIModelPort = {
      info: secondModel.info,
      execute: (request, options) => {
        if (request.phase === "interpret") secondInterpretInput = request.input as TurnPhaseInput
        return secondModel.execute(request, options)
      },
    }

    await expect(fixture.createOrchestrator(compactingModel, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "在压缩后的活动链上继续。",
      chapterSequence: 2,
      maxModelCalls: 1,
      projectSettings: compactingSettings,
    })).rejects.toThrow("Model call budget exhausted")

    const oldMessages = await fixture.database.selectFrom("model_context_messages").selectAll()
      .where("task_id", "=", first.taskId).execute()
    const chain = await fixture.database.selectFrom("model_context_chains").selectAll().executeTakeFirstOrThrow()
    const visibleTokens = (await fixture.database.selectFrom("model_context_messages").select("token_estimate")
      .where("chain_id", "=", chain.id).where("hidden_at", "is", null).execute())
      .reduce((total, message) => total + message.token_estimate, 0)

    expect(oldMessages.length).toBeGreaterThan(1)
    expect(oldMessages.filter((message) => message.kind !== "canonical_chapter")
      .every((message) => message.hidden_at !== null)).toBe(true)
    expect(secondInterpretInput?.readEvidence.some((evidence) => (
      inheritedBeforeCompaction.some((inherited) => inherited.readId === evidence.readId)
    ))).toBe(false)
    expect(chain.token_estimate).toBe(visibleTokens)
    expect(await fixture.database.selectFrom("model_context_chains").selectAll().execute()).toHaveLength(1)
  })

  it("recovers a stale committing task after the backend restarts", async () => {
    const fixture = await createFixture()
    const taskId = randomUUID()
    const turnId = randomUUID()
    const scopeId = randomUUID()
    await fixture.taskScopes.create({
      projectId: fixture.projectId,
      taskId,
      turnId,
      scopeId,
      kind: "turn",
      status: "committing",
      reason: "Test a process interruption during finalization",
      configSnapshot: {},
      promptSnapshot: {},
      createdAtMs: 10,
    })

    const recovered = await fixture.taskScopes.recoverStaleRunningTasks({
      projectId: fixture.projectId,
      activeTaskIds: [],
      updatedAtMs: 20,
      interruption: { kind: "process_interruption", recoverable: true },
    })

    expect(recovered).toEqual([expect.objectContaining({
      taskId,
      status: "awaiting_user_decision",
    })])
  })

  it("uses the adaptive route for a revision with no graph change", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const first = await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "先建立一章可供修订的正文。",
      chapterSequence: 1,
      allowWorkspaceChapterReads: false,
    })
    if (first.kind !== "turn") throw new Error("Expected a committed turn")
    const chapter = (await fixture.documentRepository.listCommittedChapters(fixture.projectId))[0]
    if (chapter === undefined) throw new Error("Expected a committed chapter")
    const sourceUnits = await fixture.documentRepository.listSourceUnits(fixture.projectId, chapter.sourceId)
    const observedPhases: string[] = []
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        observedPhases.push(request.phase)
        return fake.execute(request, options)
      },
    }

    const result = await fixture.createOrchestrator(model, fixture.commit).execute({
      workflow: "revision",
      adaptiveGraphGovernance: true,
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "# 第一章 修订版\n\n[no-change] 用户只修改排版。",
      chapterSequence: 1,
      existingSourceUnitIds: sourceUnits.map((unit) => unit.id),
      allowWorkspaceChapterReads: false,
    })

    expect(result).toMatchObject({ kind: "evolution", graphMutationCount: 0 })
    expect(observedPhases).toEqual(["graph_governance"])
    expect(await fixture.database.selectFrom("tasks").select("status").where("id", "=", result.taskId).executeTakeFirstOrThrow())
      .toEqual({ status: "completed" })
  })

  it("commits a self-contained local revision without the full governance chain", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    const first = await fixture.createOrchestrator(fake, fixture.commit).execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "先建立一章可供修订的正文。",
      chapterSequence: 1,
      allowWorkspaceChapterReads: false,
    })
    if (first.kind !== "turn") throw new Error("Expected a committed turn")
    const chapter = (await fixture.documentRepository.listCommittedChapters(fixture.projectId))[0]
    if (chapter === undefined) throw new Error("Expected a committed chapter")
    const sourceUnits = await fixture.documentRepository.listSourceUnits(fixture.projectId, chapter.sourceId)
    const observedPhases: string[] = []
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        observedPhases.push(request.phase)
        return fake.execute(request, options)
      },
    }

    const result = await fixture.createOrchestrator(model, fixture.commit).execute({
      workflow: "revision",
      adaptiveGraphGovernance: true,
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "# 第一章 修订版\n\n用户新增了一个局部事实。",
      chapterSequence: 1,
      existingSourceUnitIds: sourceUnits.map((unit) => unit.id),
      allowWorkspaceChapterReads: false,
    })

    expect(result).toMatchObject({ kind: "evolution", graphMutationCount: 5 })
    expect(observedPhases).toEqual(["graph_governance"])
    expect(await fixture.database.selectFrom("graph_revisions").selectAll().execute()).toHaveLength(10)
    expect(await fixture.database.selectFrom("tasks").select("status").where("id", "=", result.taskId).executeTakeFirstOrThrow())
      .toEqual({ status: "completed" })
  })
})

class FailOnceChapterPublishWorkspace extends NodeWorkspaceAdapter implements WorkspacePort {
  public publishAttempts = 0

  public override async publishChapter(workspaceRootRef: string, relativePath: string, content: string): Promise<void> {
    this.publishAttempts += 1
    if (this.publishAttempts === 1) throw new Error("Injected chapter publish failure")
    await super.publishChapter(workspaceRootRef, relativePath, content)
  }
}

class FailOnceMarkdownReadWorkspace extends NodeWorkspaceAdapter implements WorkspacePort {
  private failed = false
  private readCount = 0

  public constructor(private readonly failingPath: string) {
    super()
  }

  public override async readMarkdown(workspaceRootRef: string, relativePath: string): Promise<string> {
    if (relativePath === this.failingPath) this.readCount += 1
    if (!this.failed && relativePath === this.failingPath && this.readCount > 1) {
      this.failed = true
      throw new Error("Injected probe read failure")
    }
    return super.readMarkdown(workspaceRootRef, relativePath)
  }
}

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
      plotSynopsisGuide: "# synopsis guide\n",
      settingsQueryGuide: "# settings query guide\n",
      settingsRevisionGuide: "# settings revision guide\n",
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
      workspace: WorkspacePort = new NodeWorkspaceAdapter(),
    ) {
      return new TurnOrchestrator({
        taskScopes,
        persistence,
        model,
        prompts: new NodePromptResourceAdapter(promptRoot),
        documents: documentRepository,
        graph: graphRepository,
        retrieval: retrievalRepository,
        catalog: new NodeWorkspaceCatalogAdapter(workspace),
        catalogSnapshots: new SqliteWorkspaceCatalogSnapshotRepository(database),
        evidence: new SqliteEvidenceStore(
          database,
          new NodeInternalStoreAdapter(applicationDataRoot),
          created.internalStore,
        ),
        commit: commitRepository,
        internalStore: new NodeInternalStoreAdapter(applicationDataRoot),
        workspace,
        createId: randomUUID,
        idAllocator: new SqliteProjectIdAllocator(database),
        now: () => Date.now(),
        diagnostics,
      })
    },
  }
  return fixture
}
