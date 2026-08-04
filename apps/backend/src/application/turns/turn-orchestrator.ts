import {
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  phaseResultEnvelopeSchema,
  type AIPhase,
  type GraphMutation,
  type ModelCallBudget,
  type PhaseRequestEnvelope,
  type PhaseResultEnvelope,
  type ProjectId,
  type TurnContext,
} from "@worldseed/contracts"
import {
  chapterNamingArtifactSchema,
  dependencyAuditArtifactSchema,
  emergencePlanningArtifactSchema,
  emergenceReviewArtifactSchema,
  frontierSettlementArtifactSchema,
  graphGovernanceArtifactSchema,
  internalDraftArtifactSchema,
  parsePhaseArtifact,
  ruleAssemblyArtifactSchema,
  semanticReviewArtifactSchema,
  settlementReviewArtifactSchema,
  type GraphGovernanceArtifact,
} from "@worldseed/prompt-contracts"

import {
  appendContextSegments,
  assertCitationsWereRead,
  createTurnContext,
  digest,
  recordContextRead,
  type GraphRevision,
} from "../../core/index.js"
import type {
  AIModelPort,
  DecisionRecord,
  DocumentRepository,
  GraphRepository,
  PhaseModelExecution,
  PromptResourcePort,
  RetrievalRepository,
  ScopeCommitRepository,
  SettlementRecord,
  TaskScopeRepository,
  TurnPersistencePort,
  TurnPhaseInput,
  TurnReadEvidence,
} from "./ports/index.js"
import type { InternalProjectStore, InternalStorePort, WorkspacePort } from "../workspace/index.js"

const modelPhases: readonly AIPhase[] = [
  "interpret",
  "rule_assembly",
  "emergence_planning",
  "emergence_review",
  "draft",
  "chapter_naming",
  "dependency_audit",
  "graph_governance",
  "semantic_review",
  "settlement_review",
  "frontier_settlement",
  "commit_review",
]

export type TurnOrchestratorInput = Readonly<{
  projectId: ProjectId
  workspaceRootRef: string
  internalStore: InternalProjectStore
  userInput: string
  chapterSequence: number
  taskId?: string
  turnId?: string
  scopeId?: string
  contextId?: string
  sourceId?: string
  maxModelCalls?: number
  maxContextTokens?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  deadlineMs?: number
  nowMs?: number
}>

export type TurnExecutionResult = Readonly<{
  taskId: string
  turnId: string
  scopeId: string
  contextId: string
  chapterPath: string
  chapterHeading: string
  modelCalls: number
  inputTokens: number
  outputTokens: number
  modelProvider: string
  modelName: string
  graphAnchorIds: readonly string[]
  kvCacheHitRate?: number
}>

export type TurnOrchestratorDependencies = Readonly<{
  taskScopes: TaskScopeRepository
  persistence: TurnPersistencePort
  model: AIModelPort
  prompts: PromptResourcePort
  documents: DocumentRepository
  graph: GraphRepository
  retrieval: RetrievalRepository
  commit: ScopeCommitRepository
  internalStore: InternalStorePort
  workspace: WorkspacePort
  createId: () => string
  now: () => number
}>

export class TurnOrchestrator {
  public constructor(private readonly dependencies: TurnOrchestratorDependencies) {}

  public async execute(input: TurnOrchestratorInput): Promise<TurnExecutionResult> {
    const taskId = input.taskId ?? this.dependencies.createId()
    const turnId = input.turnId ?? this.dependencies.createId()
    const scopeId = input.scopeId ?? this.dependencies.createId()
    const contextId = input.contextId ?? this.dependencies.createId()
    const sourceId = input.sourceId ?? this.dependencies.createId()
    const createdAtMs = input.nowMs ?? this.dependencies.now()
    const baseRules = await this.dependencies.prompts.loadBaseRules()
    const budget = createBudget(input, createdAtMs)

    const scope = await this.dependencies.taskScopes.create({
      projectId: input.projectId,
      taskId,
      turnId,
      scopeId,
      kind: "turn",
      status: "created",
      reason: "AI turn starts from user input and creates a pending isolated scope",
      configSnapshot: budget,
      promptSnapshot: { baseRulesRef: baseRules.ref, baseRulesDigest: baseRules.digest },
      createdAtMs,
    })
    let context = createTurnContext({
      contextId,
      projectId: input.projectId,
      taskId,
      turnId,
      taskKind: "turn",
      baseCommittedSequence: scope.baseCommittedSequence,
      maxTokens: input.maxContextTokens ?? 120_000,
    })
    context = appendContextSegments(context, [{
      segmentId: this.dependencies.createId(),
      kind: "user_input",
      ownerIds: [sourceId],
      visibility: "pending",
      canonicalDigest: digest(input.userInput),
      tokenEstimate: estimateTokens(input.userInput),
      sequence: 0,
    }])
    await this.dependencies.persistence.createContext({ context, createdAtMs, updatedAtMs: createdAtMs })
    await this.dependencies.persistence.updateTask(taskId, "running", undefined, createdAtMs)

    const artifacts: Partial<Record<AIPhase, unknown>> = {}
    const phaseRunIds: string[] = []
    const phaseRuns = new Map<AIPhase, string>()
    let sourceUnitIds: string[] = []
    let readEvidence: TurnReadEvidence[] = []
    let usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0, cacheMisses: 0 }

    try {
      for (const phase of [...modelPhases.slice(0, 2), "source_retrieval" as const, ...modelPhases.slice(2)]) {
        const phaseRunId = this.dependencies.createId()
        phaseRunIds.push(phaseRunId)
        phaseRuns.set(phase, phaseRunId)
        const result = await this.executePhase({
          input,
          inputScopeId: scopeId,
          sourceId,
          sourceUnitIds,
          phase,
          phaseRunId,
          phaseRunIds,
          context,
          artifacts,
          readEvidence,
          budget,
          usage,
        })
        context = result.context
        readEvidence = [...result.readEvidence]
        phaseRuns.set(phase, result.phaseRunId)
        artifacts[phase] = result.artifact
        usage = {
          modelCalls: usage.modelCalls + result.usage.modelCalls,
          inputTokens: usage.inputTokens + result.usage.inputTokens,
          outputTokens: usage.outputTokens + result.usage.outputTokens,
          cacheHits: usage.cacheHits + result.usage.cacheHits,
          cacheMisses: usage.cacheMisses + result.usage.cacheMisses,
        }
        assertUsageWithinBudget(budget, usage, this.dependencies.now())
        if (phase === "rule_assembly") {
          const rules = ruleAssemblyArtifactSchema.parse(result.artifact)
          await this.dependencies.persistence.stageRuleSnapshot({
            id: rules.ruleSnapshotId,
            projectId: input.projectId,
            taskId,
            baseRuleVersion: rules.baseRuleVersion,
            sourceVersions: {
              userRules: rules.userRuleVersionIds,
              settingSkills: rules.settingSkillVersionIds,
              references: rules.referenceSkillVersionIds,
              presentationRules: rules.presentationRuleVersionIds,
            },
            selectionReasons: rules.selectionReasons,
            digest: digest(rules),
            createdAtMs: this.dependencies.now(),
          })
          context = { ...context, ruleSnapshotId: rules.ruleSnapshotId }
          await this.dependencies.persistence.saveContext(context, this.dependencies.now())
        }
        await this.dependencies.persistence.updateTask(taskId, phase === "commit_review" ? "committing" : "running", phase, this.dependencies.now())
        if (phase === "chapter_naming") {
          sourceUnitIds = await this.persistDraftUnits(input, sourceId, artifacts)
        }
      }

      const naming = chapterNamingArtifactSchema.parse(artifacts.chapter_naming)
      const draft = internalDraftArtifactSchema.parse(artifacts.draft)
      const chapterContent = ensureHeading(naming.heading, draft.contentMarkdown)
      const contentRef = await this.dependencies.internalStore.writeImmutableDocument(input.internalStore, sourceId, chapterContent)
      await this.stageDocument(input, sourceId, scopeId, naming, contentRef, chapterContent, createdAtMs)
      await this.stageGraphAndSettlement(
        input,
        taskId,
        sourceId,
        scopeId,
        phaseRuns.get("graph_governance"),
        artifacts,
        sourceUnitIds,
        createdAtMs,
      )

      const commitReview = parsePhaseArtifact("commit_review", artifacts.commit_review) as { decision: string }
      if (commitReview.decision !== "commit") {
        throw new Error(`AI commit review did not approve the turn: ${commitReview.decision}`)
      }
      await this.dependencies.commit.commit(scopeId)
      const chapterPath = `章节正文/${sanitizeFilename(naming.filename)}`
      await this.dependencies.workspace.publishChapter(input.workspaceRootRef, chapterPath, chapterContent)
      await this.dependencies.persistence.updateTask(taskId, "completed", "commit_review", this.dependencies.now())
      const totalCacheTokens = usage.cacheHits + usage.cacheMisses
      const governance = graphGovernanceArtifactSchema.parse(artifacts.graph_governance)
      return {
        taskId,
        turnId,
        scopeId,
        contextId,
        chapterPath,
        chapterHeading: naming.heading,
        modelCalls: usage.modelCalls,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        modelProvider: this.dependencies.model.info?.provider ?? "unknown",
        modelName: this.dependencies.model.info?.model ?? "unknown",
        graphAnchorIds: governance.mutations.flatMap((mutation) => mutation.operation === "create_node" ? [mutation.node.id] : []),
        ...(totalCacheTokens === 0 ? {} : { kvCacheHitRate: usage.cacheHits / totalCacheTokens }),
      }
    } catch (error) {
      await this.dependencies.persistence.updateTask(taskId, "failed", undefined, this.dependencies.now())
      throw error
    }
  }

  private async executePhase(input: ExecutePhaseInput): Promise<ExecutePhaseResult> {
    const prompt = await this.dependencies.prompts.loadPhase(input.phase)
    let currentContext = input.context
    let currentPhaseRunId = input.phaseRunId
    let attempt = 1
    let phaseUsage = emptyPhaseUsage()
    let currentEvidence = [...input.readEvidence]

    for (;;) {
      const phaseInput: TurnPhaseInput = {
        userInput: input.input.userInput,
        chapterSequence: input.input.chapterSequence,
        sourceId: input.sourceId,
        sourceUnitIds: input.sourceUnitIds,
        phaseRunIds: input.phaseRunIds,
        readEvidence: currentEvidence,
        artifacts: input.artifacts,
      }
      const request: PhaseRequestEnvelope = {
        schemaVersion: SCHEMA_VERSION,
        envelopeId: this.dependencies.createId(),
        projectId: input.input.projectId,
        taskId: currentContext.taskId,
        turnId: currentContext.turnId,
        contextId: currentContext.contextId,
        scopeId: input.inputScopeId,
        phase: input.phase,
        protocolVersion: PROTOCOL_VERSION,
        promptRef: prompt.ref,
        promptDigest: prompt.digest,
        contextViewRef: digest({ contextId: currentContext.contextId, segments: currentContext.segments }),
        committedReadIds: [...currentContext.readLedger.committedReadIds],
        visiblePendingIds: [...currentContext.readLedger.visiblePendingIds],
        remainingBudget: remainingBudget(input.budget, {
          modelCalls: input.usage.modelCalls + phaseUsage.modelCalls,
          inputTokens: input.usage.inputTokens + phaseUsage.inputTokens,
          outputTokens: input.usage.outputTokens + phaseUsage.outputTokens,
        }),
        input: phaseInput,
      }
      const startedAtMs = this.dependencies.now()
      await this.dependencies.persistence.startPhaseRun({
        phaseRunId: currentPhaseRunId,
        projectId: input.input.projectId,
        taskId: currentContext.taskId,
        contextId: currentContext.contextId,
        phase: input.phase,
        attempt,
        request,
        startedAtMs,
      })

      if (input.phase !== "source_retrieval" && input.usage.modelCalls + phaseUsage.modelCalls >= input.budget.maxCalls) {
        throw new Error("Model call budget exhausted before the next phase")
      }
      let execution: PhaseModelExecution
      try {
        execution = input.phase === "source_retrieval"
          ? mechanicalRetrieval(request)
          : await this.dependencies.model.execute(request)
      } catch (error) {
        await this.dependencies.persistence.finishPhaseRun({
          phaseRunId: currentPhaseRunId,
          status: "failed",
          result: { error: error instanceof Error ? error.message : String(error) },
          usage: {},
          finishedAtMs: this.dependencies.now(),
        })
        throw error
      }
      const parsedResult = phaseResultEnvelopeSchema.parse(execution.result)
      assertCitationsWereRead(currentContext, parsedResult.citedReadIds)
      const attemptUsage = phaseUsageFromExecution(input.phase, execution)
      phaseUsage = addPhaseUsage(phaseUsage, attemptUsage)
      const resultSegment = {
        segmentId: this.dependencies.createId(),
        kind: "phase_result" as const,
        ownerIds: [currentPhaseRunId, ...parsedResult.producedArtifactIds],
        visibility: "pending" as const,
        canonicalDigest: digest(parsedResult),
        tokenEstimate: estimateTokens(parsedResult),
        sequence: currentContext.segments.length,
      }
      currentContext = appendContextSegments(currentContext, [resultSegment])
      await this.dependencies.persistence.finishPhaseRun({
        phaseRunId: currentPhaseRunId,
        status: "completed",
        result: parsedResult,
        usage: execution.usage,
        finishedAtMs: this.dependencies.now(),
      })
      await this.dependencies.persistence.saveContext(currentContext, this.dependencies.now())
      if (parsedResult.requestedReads.length === 0) {
        return {
          phaseRunId: currentPhaseRunId,
          context: currentContext,
          readEvidence: currentEvidence,
          artifact: parsePhaseArtifact(input.phase, parsedResult.artifact),
          usage: phaseUsage,
        }
      }

      if (attempt >= 3) {
        throw new Error(`Phase ${input.phase} exceeded the read expansion limit`)
      }
      const readResult = await this.executeReads(
        currentContext,
        parsedResult.requestedReads,
        input.input.projectId,
        input.inputScopeId,
      )
      currentContext = readResult.context
      currentEvidence = [...currentEvidence, ...readResult.evidence]
      await this.dependencies.persistence.saveContext(currentContext, this.dependencies.now())
      currentPhaseRunId = this.dependencies.createId()
      input.phaseRunIds.push(currentPhaseRunId)
      attempt += 1
    }
  }

  private async executeReads(
    context: TurnContext,
    requests: PhaseResultEnvelope["requestedReads"],
    projectId: ProjectId,
    scopeId: string,
  ): Promise<{ context: TurnContext; evidence: readonly TurnReadEvidence[] }> {
    const returned = [] as Array<{ readId: string; reason: string; segment: TurnContext["segments"][number] }>
    const evidence: TurnReadEvidence[] = []
    const seenReadIds = new Set<string>()
    for (const request of requests) {
      const exact = await this.dependencies.retrieval.searchExact(
        { projectId, pendingScopeId: scopeId }, request.query.exactKeys, request.query.maxCandidates,
      )
      const semantic = await Promise.all(request.query.semanticTexts.map((text) => this.dependencies.retrieval.searchText(
        { projectId, pendingScopeId: scopeId }, text, request.query.maxCandidates,
      )))
      const projections = [...exact, ...semantic.flat()].slice(0, request.query.maxCandidates)
      for (const projection of projections) {
        if (projection.visibility === "retired") continue
        if (seenReadIds.has(projection.projectionId)) continue
        seenReadIds.add(projection.projectionId)
        returned.push({
          readId: projection.projectionId,
          reason: request.reason,
          segment: {
            segmentId: this.dependencies.createId(),
            kind: projection.visibility === "pending" ? "pending_artifact" : "committed_read",
            ownerIds: [projection.projectionId],
            visibility: projection.visibility,
            canonicalDigest: projection.digest,
            tokenEstimate: estimateTokens(projection.semanticText),
            sequence: context.segments.length + returned.length,
          },
        })
        evidence.push({
          readId: projection.projectionId,
          visibility: projection.visibility,
          ownerKind: projection.ownerKind,
          ownerId: projection.ownerId,
          exactKeys: projection.exactKeys,
          semanticText: projection.semanticText,
          sourceRefs: projection.sourceRefs,
          digest: projection.digest,
        })
      }
    }
    return {
      context: recordContextRead(context, {
        requestId: requests[0]?.requestId ?? this.dependencies.createId(),
        returned,
        rejectedReadIds: [],
      }),
      evidence,
    }
  }

  private async persistDraftUnits(
    input: TurnOrchestratorInput,
    sourceId: string,
    artifacts: Partial<Record<AIPhase, unknown>>,
  ): Promise<string[]> {
    const draft = internalDraftArtifactSchema.parse(artifacts.draft)
    const naming = artifacts.chapter_naming === undefined ? undefined : chapterNamingArtifactSchema.parse(artifacts.chapter_naming)
    const content = naming === undefined ? draft.contentMarkdown : ensureHeading(naming.heading, draft.contentMarkdown)
    const units = splitSourceUnits(content)
    const sourceUnits = await Promise.all(units.map(async (contentMarkdown, sequence) => {
      const id = this.dependencies.createId()
      const contentRef = await this.dependencies.internalStore.writeImmutableDocument(input.internalStore, id, contentMarkdown)
      return {
        id,
        projectId: input.projectId,
        sourceId,
        sequence,
        contentRef,
        digest: digest(contentMarkdown),
        settlementStatus: "pending",
        createdAtMs: this.dependencies.now(),
      }
    }))
    await this.dependencies.documents.stageSourceUnits(sourceUnits)
    return sourceUnits.map((unit) => unit.id)
  }

  private async stageDocument(
    input: TurnOrchestratorInput,
    sourceId: string,
    scopeId: string,
    naming: ReturnType<typeof chapterNamingArtifactSchema.parse>,
    contentRef: string,
    content: string,
    createdAtMs: number,
  ): Promise<void> {
    await this.dependencies.documents.stageVersion({
      id: naming.chapterId,
      projectId: input.projectId,
      scopeId,
      sourceId,
      chapterId: naming.chapterId,
      contentRef,
      heading: naming.heading,
      publishPath: `章节正文/${sanitizeFilename(naming.filename)}`,
      digest: digest(content),
      ...(naming.predecessorSourceId === undefined ? {} : { predecessorSourceId: naming.predecessorSourceId }),
      createdAtMs,
    })
  }

  private async stageGraphAndSettlement(
    input: TurnOrchestratorInput,
    taskId: string,
    sourceId: string,
    scopeId: string,
    graphPhaseRunId: string | undefined,
    artifacts: Partial<Record<AIPhase, unknown>>,
    sourceUnitIds: readonly string[],
    createdAtMs: number,
  ): Promise<void> {
    const governance = graphGovernanceArtifactSchema.parse(artifacts.graph_governance)
    const emergence = emergencePlanningArtifactSchema.parse(artifacts.emergence_planning)
    const emergenceReview = emergenceReviewArtifactSchema.parse(artifacts.emergence_review)
    if (emergence.decisions.some((decision) => !emergenceReview.approvedDecisionIds.includes(decision.decisionId))) {
      throw new Error("Emergence review did not approve every adopted decision")
    }
    const dependencyAudit = dependencyAuditArtifactSchema.parse(artifacts.dependency_audit)
    if (dependencyAudit.timeContinuity !== "pass" || dependencyAudit.locationContinuity !== "pass") {
      throw new Error("Draft did not pass time and location continuity review")
    }
    const semantic = semanticReviewArtifactSchema.parse(artifacts.semantic_review)
    if (semantic.proposalId !== governance.proposalId || !semantic.graphStillDiscoverable || !semantic.continuityPreserved) {
      throw new Error("Semantic review did not approve a discoverable continuous graph")
    }
    const approved = new Set(semantic.approvedMutationIndexes)
    const revisions: GraphRevision[] = []
    const revisionByMutation = new Map<number, string>()
    for (const [index, mutation] of governance.mutations.entries()) {
      if (!approved.has(index)) continue
      const revision = await this.materializeMutation(input.projectId, scopeId, mutation, governance, index, createdAtMs)
      revisions.push(revision)
      revisionByMutation.set(index, revision.revisionId)
    }
    await this.dependencies.graph.stageRevisions(input.projectId, scopeId, revisions)
    await Promise.all(governance.retrievalProjections.map(async (projection) => {
      const ownerRevisionId = projection.ownerRevisionId
        ?? (projection.ownerMutationIndex === undefined ? undefined : revisionByMutation.get(projection.ownerMutationIndex))
      if (ownerRevisionId === undefined) throw new Error(`Projection has no approved owner revision: ${projection.projectionId}`)
      await this.dependencies.retrieval.stageProjection({
        projectionId: projection.projectionId,
        projectId: input.projectId,
        scopeId,
        ownerKind: projection.ownerKind,
        ownerId: projection.ownerId,
        ownerRevisionId,
        exactKeys: projection.exactKeys,
        semanticText: projection.semanticText,
        sourceRefs: projection.sourceRefs,
        digest: digest(projection),
      })
    }))
    const records: SettlementRecord[] = governance.settlementRecords.map((record) => ({
      id: record.settlementRecordId,
      projectId: input.projectId,
      scopeId,
      sourceUnitId: record.sourceUnitId,
      graphRefs: record.graphRefs.map((reference) => ({
        ...reference,
        ...(reference.mutationIndex === undefined ? {} : { revisionId: revisionByMutation.get(reference.mutationIndex) }),
      })),
      reason: record.reason,
      status: record.status,
      digest: digest(record),
      createdAtMs,
    }))
    if (records.some((record) => !sourceUnitIds.includes(record.sourceUnitId))) {
      throw new Error("Settlement record references a source unit outside the current chapter")
    }
    await this.dependencies.persistence.stageSettlementRecords(records)
    if (graphPhaseRunId !== undefined) {
      const decisionRecords: DecisionRecord[] = governance.decisionRecords.map((record) => ({
        id: record.decisionRecordId,
        projectId: input.projectId,
        taskId,
        scopeId,
        phaseRunId: graphPhaseRunId,
        decisionKind: record.decisionKind,
        reason: record.reason,
        evidenceIds: record.evidenceIds,
        payload: { ...record.payload as object, mutationIndexes: record.mutationIndexes, selfReview: record.selfReview },
        digest: digest(record),
        createdAtMs,
      }))
      decisionRecords.push(...governance.continuityProofs.map((proof) => ({
        id: proof.continuityProofId,
        projectId: input.projectId,
        taskId,
        scopeId,
        phaseRunId: graphPhaseRunId,
        decisionKind: "continuity_proof",
        reason: "The AI supplied a continuity proof for the approved graph proposal",
        evidenceIds: sourceUnitIds,
        payload: proof.payload,
        digest: digest(proof),
        createdAtMs,
      })))
      await this.dependencies.persistence.stageDecisionRecords(decisionRecords)
    }
    const frontier = frontierSettlementArtifactSchema.parse(artifacts.frontier_settlement)
    await this.dependencies.persistence.stageFrontiers(frontier.activeFrontierIds.map((anchorId) => ({
      id: this.dependencies.createId(),
      projectId: input.projectId,
      scopeId,
      anchorId,
      lastEffectiveTime: createdAtMs,
      deferralCount: 0,
      nextAttemptAt: createdAtMs,
      status: "active",
      payload: { sourceId, deferred: frontier.deferredFrontierIds.includes(anchorId) },
    })))
    const settlementReview = settlementReviewArtifactSchema.parse(artifacts.settlement_review)
    if (!settlementReview.sourceReturnComplete || settlementReview.uncoveredSourceUnitIds.length > 0) {
      throw new Error("Settlement review left source units uncovered")
    }
  }

  private async materializeMutation(
    projectId: ProjectId,
    scopeId: string,
    mutation: GraphMutation,
    governance: GraphGovernanceArtifact,
    mutationIndex: number,
    createdAtMs: number,
  ): Promise<GraphRevision> {
    const decision = governance.decisionRecords.find((candidate) => candidate.mutationIndexes.includes(mutationIndex))
    const reason = decision?.reason ?? "The AI approved this graph mutation for the current turn"
    const selfReview = decision?.selfReview ?? "The mutation remains discoverable and preserves prior history"
    const evidenceIds = decision?.evidenceIds ?? []
    const targetKind = mutation.operation.endsWith("_node") ? "node" : "link"
    const targetId = "node" in mutation ? mutation.node.id
      : "link" in mutation ? mutation.link.id
      : "nodeId" in mutation ? mutation.nodeId
      : mutation.linkId
    const predecessorRevisionId = (await this.dependencies.graph.listRevisions(projectId, targetKind, targetId)).at(-1)?.revisionId
    const base = {
      revisionId: this.dependencies.createId(),
      scopeId,
      ...(predecessorRevisionId === undefined ? {} : { predecessorRevisionId }),
      reason,
      selfReview,
      evidenceIds,
      createdAtMs,
    }
    switch (mutation.operation) {
      case "create_node":
        return { ...base, targetKind: "node", targetId: mutation.node.id, operation: "create", before: null, after: mutation.node, archiveOutletIds: [] }
      case "create_link":
        return { ...base, targetKind: "link", targetId: mutation.link.id, operation: "create", before: null, after: mutation.link, archiveOutletIds: [] }
      case "edit_node": {
        const before = await this.dependencies.graph.getNode({ projectId, pendingScopeId: scopeId }, mutation.nodeId)
        if (before === undefined) throw new Error(`Cannot edit missing node: ${mutation.nodeId}`)
        return { ...base, targetKind: "node", targetId: mutation.nodeId, operation: "edit", before, after: { id: mutation.nodeId, ...mutation.next }, archiveOutletIds: [] }
      }
      case "edit_link": {
        const before = await this.dependencies.graph.getLink({ projectId, pendingScopeId: scopeId }, mutation.linkId)
        if (before === undefined) throw new Error(`Cannot edit missing link: ${mutation.linkId}`)
        return { ...base, targetKind: "link", targetId: mutation.linkId, operation: "edit", before, after: { id: mutation.linkId, ...mutation.next }, archiveOutletIds: [] }
      }
      case "retire_node": {
        const before = await this.dependencies.graph.getNode({ projectId, pendingScopeId: scopeId }, mutation.nodeId)
        if (before === undefined) throw new Error(`Cannot retire missing node: ${mutation.nodeId}`)
        return { ...base, targetKind: "node", targetId: mutation.nodeId, operation: "retire", before, after: null, archiveOutletIds: mutation.archiveOutletIds }
      }
      case "retire_link": {
        const before = await this.dependencies.graph.getLink({ projectId, pendingScopeId: scopeId }, mutation.linkId)
        if (before === undefined) throw new Error(`Cannot retire missing link: ${mutation.linkId}`)
        return { ...base, targetKind: "link", targetId: mutation.linkId, operation: "retire", before, after: null, archiveOutletIds: mutation.archiveOutletIds }
      }
    }
  }
}

type ExecutePhaseInput = Readonly<{
  input: TurnOrchestratorInput
  inputScopeId: string
  sourceId: string
  sourceUnitIds: readonly string[]
  phase: AIPhase
  phaseRunId: string
  phaseRunIds: string[]
  context: TurnContext
  artifacts: Partial<Record<AIPhase, unknown>>
  readEvidence: readonly TurnReadEvidence[]
  budget: ModelCallBudget
  usage: { modelCalls: number; inputTokens: number; outputTokens: number; cacheHits: number; cacheMisses: number }
}>

type ExecutePhaseResult = Readonly<{
  phaseRunId: string
  context: TurnContext
  readEvidence: readonly TurnReadEvidence[]
  artifact: unknown
  usage: { modelCalls: number; inputTokens: number; outputTokens: number; cacheHits: number; cacheMisses: number }
}>

type PhaseUsage = Readonly<{
  modelCalls: number
  inputTokens: number
  outputTokens: number
  cacheHits: number
  cacheMisses: number
}>

function emptyPhaseUsage(): PhaseUsage {
  return { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0, cacheMisses: 0 }
}

function phaseUsageFromExecution(phase: AIPhase, execution: PhaseModelExecution): PhaseUsage {
  return {
    modelCalls: phase === "source_retrieval" ? 0 : execution.usage.modelCalls ?? 1,
    inputTokens: execution.usage.inputTokens,
    outputTokens: execution.usage.outputTokens,
    cacheHits: execution.usage.cacheHitInputTokens ?? 0,
    cacheMisses: execution.usage.cacheMissInputTokens ?? 0,
  }
}

function addPhaseUsage(left: PhaseUsage, right: PhaseUsage): PhaseUsage {
  return {
    modelCalls: left.modelCalls + right.modelCalls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheHits: left.cacheHits + right.cacheHits,
    cacheMisses: left.cacheMisses + right.cacheMisses,
  }
}

function createBudget(input: TurnOrchestratorInput, nowMs: number): ModelCallBudget {
  const maxCalls = input.maxModelCalls ?? 12
  const maxInputTokens = input.maxInputTokens ?? 240_000
  const maxOutputTokens = input.maxOutputTokens ?? 80_000
  return {
    maxCalls,
    remainingCalls: maxCalls,
    maxInputTokens,
    remainingInputTokens: maxInputTokens,
    maxOutputTokens,
    remainingOutputTokens: maxOutputTokens,
    deadlineAtMs: nowMs + (input.deadlineMs ?? 300_000),
  }
}

function remainingBudget(
  budget: ModelCallBudget,
  usage: { modelCalls: number; inputTokens: number; outputTokens: number },
): ModelCallBudget {
  return {
    ...budget,
    remainingCalls: Math.max(0, budget.maxCalls - usage.modelCalls),
    remainingInputTokens: Math.max(0, budget.maxInputTokens - usage.inputTokens),
    remainingOutputTokens: Math.max(0, budget.maxOutputTokens - usage.outputTokens),
  }
}

function assertUsageWithinBudget(
  budget: ModelCallBudget,
  usage: { modelCalls: number; inputTokens: number; outputTokens: number },
  nowMs: number,
): void {
  if (usage.modelCalls > budget.maxCalls) throw new Error("Model call budget exceeded")
  if (usage.inputTokens > budget.maxInputTokens) throw new Error("Model input token budget exceeded")
  if (usage.outputTokens > budget.maxOutputTokens) throw new Error("Model output token budget exceeded")
  if (nowMs > budget.deadlineAtMs) throw new Error("Turn deadline exceeded")
}

function mechanicalRetrieval(request: PhaseRequestEnvelope): { result: PhaseResultEnvelope; usage: { inputTokens: number; outputTokens: number; latencyMs: number } } {
  return {
    result: {
      schemaVersion: SCHEMA_VERSION,
      envelopeId: request.envelopeId,
      contextId: request.contextId,
      phase: request.phase,
      outcome: "continue",
      artifact: { executedRequestIds: [], returnedReadIds: [], rejectedCandidateIds: [], missingEvidence: [], nextExpansionHints: [] },
      requestedReads: [],
      citedReadIds: [],
      producedArtifactIds: [],
      decisionRecordIds: [],
      unresolvedDependencies: [],
      reason: "No model read request was present; retrieval completed mechanically",
      selfReview: "No query was treated as evidence",
    },
    usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 },
  }
}

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil((typeof value === "string" ? value : JSON.stringify(value)).length / 4))
}

function splitSourceUnits(content: string): string[] {
  return content.split(/\n\s*\n/u).map((unit) => unit.trim()).filter((unit) => unit.length > 0)
}

function ensureHeading(heading: string, content: string): string {
  const normalized = content.trim()
  return normalized.startsWith(`${heading}\n`) || normalized === heading ? normalized : `${heading}\n\n${normalized}`
}

function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/u).at(-1) ?? filename
  return base.replace(/[<>:"|?*]/gu, "_")
}
