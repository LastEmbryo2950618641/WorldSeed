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
  type ProjectSettings,
  type TurnContext,
  type WorkspaceCatalogEntry,
  type WorkspaceCatalogSnapshot,
} from "@worldseed/contracts"
import { defaultProjectSettings, defaultTurnExecutionProfile } from "@worldseed/config"
import {
  assertGraphGovernanceReferenceContract,
  assertSpacetimeGovernanceCoverage,
  assertSemanticReviewCoversGovernance,
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
  GraphRevisionSpacetimeRecord,
  SceneSpacetimeBindingRecord,
  SettlementRecord,
  TaskScopeRepository,
  TurnPersistencePort,
  TurnPhaseInput,
  TurnRetrievalGap,
  TurnReadEvidence,
} from "./ports/index.js"
import type { InternalProjectStore, InternalStorePort, WorkspacePort } from "../workspace/index.js"
import type {
  EvidenceStore,
  WorkspaceCatalogPort,
  WorkspaceCatalogSnapshotRepository,
} from "../retrieval/index.js"
import { createRetrievalGaps } from "./retrieval-gap.js"

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
  presentation?: Readonly<{
    descriptionRulePath?: string | undefined
    proseStyleRulePath?: string | undefined
    minimumWordCount: number
    maximumWordCount: number
  }>
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
  retrievalExecutionDeadlineMs?: number
  retrievalPhaseDeadlineMs?: number
  maxRetrievalRounds?: number
  projectSettings?: ProjectSettings
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
  catalog: WorkspaceCatalogPort
  catalogSnapshots: WorkspaceCatalogSnapshotRepository
  evidence: EvidenceStore
  commit: ScopeCommitRepository
  internalStore: InternalStorePort
  workspace: WorkspacePort
  createId: () => string
  now: () => number
  diagnostics?: Readonly<{
    log(level: "debug" | "info" | "warn" | "error", event: string, fields?: Readonly<Record<string, unknown>>): void
  }>
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
    this.log("debug", "turn.started", {
      taskId,
      turnId,
      projectId: input.projectId,
      chapterSequence: input.chapterSequence,
      modelProvider: this.dependencies.model.info?.provider ?? "unknown",
      modelName: this.dependencies.model.info?.model ?? "unknown",
      maxCalls: budget.maxCalls,
      maxInputTokens: budget.maxInputTokens,
      maxOutputTokens: budget.maxOutputTokens,
      deadlineAtMs: budget.deadlineAtMs,
    })
    const catalogSnapshot = await this.dependencies.catalog.createSnapshot({
      snapshotId: this.dependencies.createId(),
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
      generatedAtMs: createdAtMs,
    })
    await this.dependencies.catalogSnapshots.save(catalogSnapshot)

    const scope = await this.dependencies.taskScopes.create({
      projectId: input.projectId,
      taskId,
      turnId,
      scopeId,
      kind: "turn",
      status: "created",
      reason: "AI turn starts from user input and creates a pending isolated scope",
      configSnapshot: {
        budget,
        ...(input.projectSettings === undefined ? {} : { projectSettings: input.projectSettings }),
      },
      promptSnapshot: {
        baseRulesRef: baseRules.ref,
        baseRulesDigest: baseRules.digest,
        workspaceCatalogSnapshotId: catalogSnapshot.snapshotId,
        workspaceCatalogDigest: catalogSnapshot.digest,
      },
      createdAtMs,
    })
    await this.dependencies.catalogSnapshots.attachToTask(taskId, catalogSnapshot.snapshotId)
    let context = createTurnContext({
      contextId,
      projectId: input.projectId,
      taskId,
      turnId,
      taskKind: "turn",
      baseCommittedSequence: scope.baseCommittedSequence,
      maxTokens: resolveContextTokenLimit(
        input.maxContextTokens,
        input.projectSettings?.execution.contextWindowTokens ?? this.dependencies.model.info?.contextWindowTokens,
        input.projectSettings?.execution.contextCompactionThresholdRatio
          ?? defaultProjectSettings.execution.contextCompactionThresholdRatio,
      ),
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
    const mandatoryWorkspaceReads = await this.readMandatoryWorkspaceEvidence(
      context,
      input,
      catalogSnapshot,
    )
    context = mandatoryWorkspaceReads.context
    await this.dependencies.persistence.saveContext(context, this.dependencies.now())
    await this.dependencies.persistence.updateTask(taskId, "running", undefined, createdAtMs)

    const artifacts: Partial<Record<AIPhase, unknown>> = {}
    const phaseRunIds: string[] = []
    const phaseRuns = new Map<AIPhase, string>()
    let sourceUnitIds: string[] = []
    let readEvidence: TurnReadEvidence[] = [...mandatoryWorkspaceReads.evidence]
    let retrievalGaps: TurnRetrievalGap[] = []
    let usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0, cacheMisses: 0 }

    try {
      for (const phase of [...modelPhases.slice(0, 2), "source_retrieval" as const, ...modelPhases.slice(2)]) {
        const phaseStartedAtMs = this.dependencies.now()
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
          retrievalGaps,
          catalogSnapshot,
          budget,
          usage,
        })
        context = result.context
        readEvidence = [...result.readEvidence]
        retrievalGaps = [...result.retrievalGaps]
        phaseRuns.set(phase, result.phaseRunId)
        artifacts[phase] = result.artifact
        usage = {
          modelCalls: usage.modelCalls + result.usage.modelCalls,
          inputTokens: usage.inputTokens + result.usage.inputTokens,
          outputTokens: usage.outputTokens + result.usage.outputTokens,
          cacheHits: usage.cacheHits + result.usage.cacheHits,
          cacheMisses: usage.cacheMisses + result.usage.cacheMisses,
        }
        this.log("debug", "phase.completed", {
          taskId,
          phase,
          phaseRunId: result.phaseRunId,
          elapsedMs: this.dependencies.now() - phaseStartedAtMs,
          phaseModelCalls: result.usage.modelCalls,
          phaseInputTokens: result.usage.inputTokens,
          phaseOutputTokens: result.usage.outputTokens,
          totalModelCalls: usage.modelCalls,
          totalInputTokens: usage.inputTokens,
          totalOutputTokens: usage.outputTokens,
          deadlineRemainingMs: budget.deadlineAtMs - this.dependencies.now(),
          contextSegments: context.segments.length,
          evidenceCount: readEvidence.length,
          retrievalGapCount: retrievalGaps.length,
        })
        assertUsageWithinBudget(budget, usage, this.dependencies.now())
        await this.dependencies.persistence.updateTask(taskId, phase === "commit_review" ? "committing" : "running", phase, this.dependencies.now())
        if (phase === "rule_assembly") {
          const rules = ruleAssemblyArtifactSchema.parse(result.artifact)
          const ruleSnapshotId = this.dependencies.createId()
          const sourceVersions = resolveRuleSourceVersions(rules.selectedWorkspacePaths, readEvidence)
          const ruleSnapshot = {
            id: ruleSnapshotId,
            projectId: input.projectId,
            taskId,
            baseRuleVersion: baseRules.version,
            sourceVersions,
            selectionReasons: rules.selectionReasons,
            createdAtMs: this.dependencies.now(),
          }
          await this.dependencies.persistence.stageRuleSnapshot({
            ...ruleSnapshot,
            digest: digest(ruleSnapshot),
          })
          context = { ...context, ruleSnapshotId }
          await this.dependencies.persistence.saveContext(context, this.dependencies.now())
        }
        if (phase === "chapter_naming") {
          sourceUnitIds = await this.persistDraftUnits(input, sourceId, artifacts)
        }
      }

      const naming = chapterNamingArtifactSchema.parse(artifacts.chapter_naming)
      const draft = internalDraftArtifactSchema.parse(artifacts.draft)
      const commitReview = parsePhaseArtifact("commit_review", artifacts.commit_review) as { recommendation: string }
      this.log("debug", "turn.commit_review.advisory", {
        taskId,
        recommendation: commitReview.recommendation,
        message: "AI commit review is advisory; structural and settlement gates decide whether the turn can be persisted",
      })
      const chapterContent = ensureHeading(naming.heading, draft.contentMarkdown)
      const contentRef = await this.dependencies.internalStore.writeImmutableDocument(input.internalStore, sourceId, chapterContent)
      await this.stageDocument(input, sourceId, scopeId, naming, contentRef, chapterContent, createdAtMs)
      const graphAnchorIds = await this.stageGraphAndSettlement(
        input,
        taskId,
        sourceId,
        scopeId,
        phaseRuns.get("graph_governance"),
        artifacts,
        sourceUnitIds,
        readEvidence,
        createdAtMs,
      )

      await this.dependencies.commit.commit(scopeId)
      const chapterPath = `章节正文/${sanitizeFilename(naming.filename)}`
      await this.dependencies.workspace.publishChapter(input.workspaceRootRef, chapterPath, chapterContent)
      await this.dependencies.persistence.updateTask(taskId, "completed", "commit_review", this.dependencies.now())
      const totalCacheTokens = usage.cacheHits + usage.cacheMisses
      const governance = graphGovernanceArtifactSchema.parse(artifacts.graph_governance)
      this.log("info", "turn.committed", {
        taskId,
        turnId,
        scopeId,
        chapterPath,
        elapsedMs: this.dependencies.now() - createdAtMs,
        modelCalls: usage.modelCalls,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        graphMutationCount: governance.mutations.length,
      })
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
        graphAnchorIds,
        ...(totalCacheTokens === 0 ? {} : { kvCacheHitRate: usage.cacheHits / totalCacheTokens }),
      }
    } catch (error) {
      const failedPhase = phaseRuns.size === 0 ? undefined : [...phaseRuns.keys()].at(-1)
      this.log("error", "turn.failed", {
        taskId,
        turnId,
        failedPhase,
        elapsedMs: this.dependencies.now() - createdAtMs,
        deadlineAtMs: budget.deadlineAtMs,
        nowMs: this.dependencies.now(),
        usage,
        error,
      })
      await this.dependencies.persistence.updateTask(taskId, "failed", failedPhase, this.dependencies.now(), {
        message: error instanceof Error ? error.message : String(error),
        failedAtMs: this.dependencies.now(),
      })
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
    let currentRetrievalGaps = [...input.retrievalGaps]

    for (;;) {
      const phaseInput: TurnPhaseInput = {
        userInput: input.input.userInput,
        chapterSequence: input.input.chapterSequence,
        ...(input.input.presentation === undefined ? {} : { presentation: input.input.presentation }),
        sourceId: input.sourceId,
        sourceUnitIds: input.sourceUnitIds,
        phaseRunIds: input.phaseRunIds,
        readEvidence: currentEvidence,
        retrievalGaps: currentRetrievalGaps,
        workspaceCatalog: input.catalogSnapshot,
        ...(input.input.projectSettings === undefined ? {} : { projectSettings: input.input.projectSettings }),
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

      this.log("debug", "phase.model_request.started", {
        taskId: currentContext.taskId,
        phase: input.phase,
        phaseRunId: currentPhaseRunId,
        attempt,
        contextSegments: currentContext.segments.length,
        committedReadCount: request.committedReadIds.length,
        visiblePendingCount: request.visiblePendingIds.length,
        evidenceCount: currentEvidence.length,
        retrievalGapCount: currentRetrievalGaps.length,
        priorArtifactCount: Object.keys(input.artifacts).length,
        remainingCalls: request.remainingBudget.remainingCalls,
        remainingInputTokens: request.remainingBudget.remainingInputTokens,
        remainingOutputTokens: request.remainingBudget.remainingOutputTokens,
        deadlineRemainingMs: request.remainingBudget.deadlineAtMs - this.dependencies.now(),
      })

      await this.dependencies.persistence.updateTask(
        currentContext.taskId,
        input.phase === "commit_review" ? "committing" : "running",
        input.phase,
        this.dependencies.now(),
      )

      if (input.usage.modelCalls + phaseUsage.modelCalls >= input.budget.maxCalls) {
        throw new Error("Model call budget exhausted before the next phase")
      }
      let execution: PhaseModelExecution
      try {
        execution = await this.dependencies.model.execute(request)
      } catch (error) {
        this.log("error", "phase.model_request.failed", {
          taskId: currentContext.taskId,
          phase: input.phase,
          phaseRunId: currentPhaseRunId,
          attempt,
          elapsedMs: this.dependencies.now() - startedAtMs,
          error,
        })
        await this.dependencies.persistence.finishPhaseRun({
          phaseRunId: currentPhaseRunId,
          status: "failed",
          result: {
            error: error instanceof Error ? error.message : String(error),
            ...(isRecordWithRawResponse(error) ? { rawModelOutput: error.rawResponse } : {}),
          },
          usage: {},
          finishedAtMs: this.dependencies.now(),
        })
        throw error
      }
      const parsedResult = phaseResultEnvelopeSchema.parse(execution.result)
      this.log("debug", "phase.model_response.received", {
        taskId: currentContext.taskId,
        phase: input.phase,
        phaseRunId: currentPhaseRunId,
        attempt,
        elapsedMs: this.dependencies.now() - startedAtMs,
        outcome: parsedResult.outcome,
        requestedReadCount: parsedResult.requestedReads.length,
        citedReadCount: parsedResult.citedReadIds.length,
        citedReadIds: parsedResult.citedReadIds,
        readableReadIds: [
          ...currentContext.readLedger.committedReadIds,
          ...currentContext.readLedger.visiblePendingIds,
        ],
        invalidCitedReadIds: parsedResult.citedReadIds.filter((readId) => !(
          currentContext.readLedger.committedReadIds.includes(readId)
          || currentContext.readLedger.visiblePendingIds.includes(readId)
        )),
        retrievalGapRequestIds: currentRetrievalGaps.map((gap) => gap.requestId),
        citedRetrievalGapIds: parsedResult.citedReadIds.filter((readId) => (
          currentRetrievalGaps.some((gap) => gap.requestId === readId)
        )),
        unresolvedDependencyCount: parsedResult.unresolvedDependencies.length,
        inputTokens: execution.usage.inputTokens,
        outputTokens: execution.usage.outputTokens,
        cacheHitInputTokens: execution.usage.cacheHitInputTokens,
        cacheMissInputTokens: execution.usage.cacheMissInputTokens,
      })
      assertCitationsWereRead(currentContext, parsedResult.citedReadIds)
      const attemptUsage = phaseUsageFromExecution(execution)
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
        result: {
          ...parsedResult,
          ...(execution.usage.reasoningContent === undefined ? {} : { modelReasoning: execution.usage.reasoningContent }),
        },
        usage: execution.usage,
        finishedAtMs: this.dependencies.now(),
      })
      await this.dependencies.persistence.saveContext(currentContext, this.dependencies.now())
      if (input.phase !== "commit_review" && parsedResult.outcome === "blocked") {
        throw new Error(`Phase ${input.phase} is blocked: ${parsedResult.reason}`)
      }
      if (input.phase !== "commit_review" && (parsedResult.outcome === "revise"
        || parsedResult.outcome === "reject"
        || parsedResult.outcome === "retire")) {
        throw new Error(`Phase ${input.phase} requires workflow decision ${parsedResult.outcome}: ${parsedResult.reason}`)
      }
      if (parsedResult.requestedReads.length === 0) {
        const artifact = parsePhaseArtifact(input.phase, parsedResult.artifact)
        this.assertDraftCanBePublished(input.phase, artifact, currentContext.taskId, currentPhaseRunId)
        return {
          phaseRunId: currentPhaseRunId,
          context: currentContext,
          readEvidence: currentEvidence,
          retrievalGaps: currentRetrievalGaps,
          artifact,
          usage: phaseUsage,
        }
      }

      this.log("debug", "phase.reads.started", {
        taskId: currentContext.taskId,
        phase: input.phase,
        phaseRunId: currentPhaseRunId,
        attempt,
        requestCount: parsedResult.requestedReads.length,
      })

      if (attempt >= (input.input.maxRetrievalRounds ?? input.input.projectSettings?.execution.maxRetrievalRounds ?? defaultProjectSettings.execution.maxRetrievalRounds)) {
        this.log("warn", "phase.reads.exhausted", {
          taskId: currentContext.taskId,
          phase: input.phase,
          phaseRunId: currentPhaseRunId,
          attempt,
          requestedReadIds: parsedResult.requestedReads.map((read) => read.requestId),
          ledgerReturnedReadIds: currentContext.readLedger.returnedReadIds,
          ledgerCommittedReadIds: currentContext.readLedger.committedReadIds,
          ledgerVisiblePendingIds: currentContext.readLedger.visiblePendingIds,
        })
        currentRetrievalGaps = [
          ...currentRetrievalGaps,
          ...createRetrievalGaps(parsedResult.requestedReads),
        ]
        this.log("debug", "retrieval.gaps.recorded", {
          taskId: currentContext.taskId,
          phase: input.phase,
          phaseRunId: currentPhaseRunId,
          gapCount: parsedResult.requestedReads.length,
          requestIds: parsedResult.requestedReads.map((request) => request.requestId),
          typeId: "system:retrieval-gap",
        })
        return {
          phaseRunId: currentPhaseRunId,
          context: currentContext,
          readEvidence: currentEvidence,
          retrievalGaps: currentRetrievalGaps,
          artifact: this.parseAndValidatePhaseArtifact(
            input.phase,
            parsedResult.artifact,
            currentContext.taskId,
            currentPhaseRunId,
          ),
          usage: phaseUsage,
        }
      }
      const readResult = await this.executeReads(
        currentContext,
        parsedResult.requestedReads,
        input.input.projectId,
        input.inputScopeId,
        input.input.projectSettings?.retrieval,
        input.input.workspaceRootRef,
        input.catalogSnapshot,
        currentEvidence,
      )
      currentContext = readResult.context
      currentEvidence = [...currentEvidence, ...readResult.evidence]
      this.log("debug", "phase.reads.completed", {
        taskId: currentContext.taskId,
        phase: input.phase,
        phaseRunId: currentPhaseRunId,
        attempt,
        evidenceAdded: readResult.evidence.length,
        evidenceReadIds: readResult.evidence.map((evidence) => evidence.readId),
        totalEvidence: currentEvidence.length,
        retrievalGapCount: currentRetrievalGaps.length,
        committedReadCount: currentContext.readLedger.committedReadIds.length,
        visiblePendingCount: currentContext.readLedger.visiblePendingIds.length,
        ledgerReturnedReadIds: currentContext.readLedger.returnedReadIds,
      })
      if (readResult.evidence.length === 0) {
        currentRetrievalGaps = [
          ...currentRetrievalGaps,
          ...createRetrievalGaps(parsedResult.requestedReads),
        ]
        this.log("debug", "retrieval.gaps.recorded", {
          taskId: currentContext.taskId,
          phase: input.phase,
          phaseRunId: currentPhaseRunId,
          gapCount: parsedResult.requestedReads.length,
          requestIds: parsedResult.requestedReads.map((request) => request.requestId),
          typeId: "system:retrieval-gap",
          reason: "no_new_evidence",
        })
        await this.dependencies.persistence.saveContext(currentContext, this.dependencies.now())
        return {
          phaseRunId: currentPhaseRunId,
          context: currentContext,
          readEvidence: currentEvidence,
          retrievalGaps: currentRetrievalGaps,
          artifact: parsePhaseArtifact(input.phase, parsedResult.artifact),
          usage: phaseUsage,
        }
      }
      await this.dependencies.persistence.saveContext(currentContext, this.dependencies.now())
      currentPhaseRunId = this.dependencies.createId()
      input.phaseRunIds.push(currentPhaseRunId)
      attempt += 1
    }
  }

  private async readMandatoryWorkspaceEvidence(
    context: TurnContext,
    input: TurnOrchestratorInput,
    catalogSnapshot: WorkspaceCatalogSnapshot,
  ): Promise<{ context: TurnContext; evidence: readonly TurnReadEvidence[] }> {
    const selectedPresentationPaths = resolveSelectedPresentationPaths(input.presentation)
    const requiredEntries = catalogSnapshot.entries.filter((entry) => (
      isMandatoryWorkspaceEntry(entry)
      || selectedPresentationPaths.includes(entry.relativePath)
    ))
    const requiredPaths = new Set(requiredEntries.map((entry) => entry.relativePath))
    for (const requiredPath of ["设定集/readme.md", "参考文件/readme.md"]) {
      if (!requiredPaths.has(requiredPath)) {
        throw new Error(`Required workspace index is missing: ${requiredPath}`)
      }
    }
    for (const selectedPath of selectedPresentationPaths) {
      const selectedEntry = catalogSnapshot.entries.find((entry) => entry.relativePath === selectedPath)
      if (selectedEntry?.entryKind !== "file") {
        throw new Error(`Selected presentation rule is missing: ${selectedPath}`)
      }
    }
    const returned: Array<{ readId: string; reason: string; segment: TurnContext["segments"][number] }> = []
    const evidence: TurnReadEvidence[] = []
    for (const entry of requiredEntries) {
      const content = await this.dependencies.workspace.readMarkdown(input.workspaceRootRef, entry.relativePath)
      const evidenceId = this.dependencies.createId()
      const storedEvidence = await this.dependencies.evidence.writeImmutable({
        evidenceId,
        projectId: input.projectId,
        contextId: context.contextId,
        sourceKind: "workspace",
        ownerId: entry.relativePath,
        version: entry.version,
        digest: entry.digest,
        locator: `workspace://${entry.relativePath}`,
        content,
        readReason: "Mandatory turn workspace context",
        createdAtMs: this.dependencies.now(),
      })
      const tokenEstimate = estimateTokens(content)
      returned.push({
        readId: storedEvidence.evidenceId,
        reason: "Mandatory turn workspace context",
        segment: {
          segmentId: this.dependencies.createId(),
          kind: "committed_read",
          ownerIds: [storedEvidence.evidenceId],
          visibility: "committed",
          canonicalDigest: storedEvidence.digest,
          tokenEstimate,
          sequence: context.segments.length + returned.length,
        },
      })
      evidence.push(workspaceTurnEvidence(storedEvidence.evidenceId, entry, content))
    }
    const requestId = this.dependencies.createId()
    this.log("debug", "workspace.required_evidence.loaded", {
      taskId: context.taskId,
      requestId,
      evidenceCount: evidence.length,
      paths: evidence.map((item) => item.ownerId),
    })
    let nextContext = recordContextRead(context, { requestId, returned, rejectedReadIds: [] })
    const presentationEvidence = evidence.filter((item) => item.ownerKind === "workspace:presentation")
    if (presentationEvidence.length > 0) {
      nextContext = appendContextSegments(nextContext, [{
        segmentId: this.dependencies.createId(),
        kind: "presentation_rules",
        ownerIds: presentationEvidence.map((item) => item.readId),
        visibility: "committed",
        canonicalDigest: digest(presentationEvidence.map((item) => item.digest)),
        tokenEstimate: presentationEvidence.reduce((total, item) => total + estimateTokens(item.semanticText), 0),
        sequence: nextContext.segments.length,
      }])
    }
    return { context: nextContext, evidence }
  }

  private async executeReads(
    context: TurnContext,
    requests: PhaseResultEnvelope["requestedReads"],
    projectId: ProjectId,
    scopeId: string,
    settings: ProjectSettings["retrieval"] | undefined,
    workspaceRootRef: string,
    catalogSnapshot: WorkspaceCatalogSnapshot,
    existingEvidence: readonly TurnReadEvidence[],
  ): Promise<{ context: TurnContext; evidence: readonly TurnReadEvidence[] }> {
    const returned = [] as Array<{ readId: string; reason: string; segment: TurnContext["segments"][number] }>
    const evidence: TurnReadEvidence[] = []
    const seenReadIds = new Set<string>()
    const seenEvidenceKeys = new Set(existingEvidence.map((item) => `${item.ownerId}:${item.digest}`))
    const selectedRequests = requests.slice(0, settings?.maxRequestsPerRound ?? requests.length)
    const evidenceTokenLimit = settings?.maxEvidenceTokens ?? Number.POSITIVE_INFINITY
    let evidenceTokens = 0
    let evidenceBudgetTruncated = false
    if (selectedRequests.length < requests.length) {
      this.log("debug", "retrieval.requests.truncated", {
        taskId: context.taskId,
        requestedCount: requests.length,
        selectedCount: selectedRequests.length,
        maxRequestsPerRound: settings?.maxRequestsPerRound,
      })
    }
    for (const request of selectedRequests) {
      const maxCandidates = Math.min(request.query.maxCandidates, settings?.maxCandidates ?? request.query.maxCandidates)
      const maxDepth = Math.min(request.query.maxDepth, settings?.maxDepth ?? request.query.maxDepth)
      const workspaceEntries = selectWorkspaceEntries(catalogSnapshot, request, maxCandidates)
      for (const entry of workspaceEntries) {
        const evidenceKey = `${entry.relativePath}:${entry.digest}`
        if (seenEvidenceKeys.has(evidenceKey)) continue
        const content = await this.dependencies.workspace.readMarkdown(workspaceRootRef, entry.relativePath)
        const tokenEstimate = estimateTokens(content)
        if (evidenceTokens + tokenEstimate > evidenceTokenLimit) {
          evidenceBudgetTruncated = true
          continue
        }
        seenEvidenceKeys.add(evidenceKey)
        evidenceTokens += tokenEstimate
        const evidenceId = this.dependencies.createId()
        const storedEvidence = await this.dependencies.evidence.writeImmutable({
          evidenceId,
          projectId,
          contextId: context.contextId,
          sourceKind: "workspace",
          ownerId: entry.relativePath,
          version: entry.version,
          digest: entry.digest,
          locator: `workspace://${entry.relativePath}`,
          content,
          readReason: request.reason,
          createdAtMs: this.dependencies.now(),
        })
        returned.push({
          readId: storedEvidence.evidenceId,
          reason: request.reason,
          segment: {
            segmentId: this.dependencies.createId(),
            kind: "committed_read",
            ownerIds: [storedEvidence.evidenceId],
            visibility: "committed",
            canonicalDigest: storedEvidence.digest,
            tokenEstimate,
            sequence: context.segments.length + returned.length,
          },
        })
        evidence.push(workspaceTurnEvidence(storedEvidence.evidenceId, entry, content))
      }
      const searchesGraph = request.query.sourceKinds.some((kind) => (
        kind === "graph" || kind === "revision" || kind === "source"
      ))
      const anchored = searchesGraph ? await this.dependencies.retrieval.searchExact(
        { projectId, pendingScopeId: scopeId }, request.query.anchorIds, maxCandidates,
      ) : []
      const exact = searchesGraph ? await this.dependencies.retrieval.searchExact(
        { projectId, pendingScopeId: scopeId }, request.query.exactKeys, maxCandidates,
      ) : []
      const semantic = searchesGraph ? await Promise.all(request.query.semanticTexts.map((text) => this.dependencies.retrieval.searchText(
        { projectId, pendingScopeId: scopeId }, text, maxCandidates,
      ))) : []
      const projections = uniqueRetrievalProjections(
        [...anchored, ...exact, ...semantic.flat()],
        maxCandidates,
      )
      this.log("debug", "retrieval.request.completed", {
        taskId: context.taskId,
        requestId: request.requestId,
        requestedCandidates: request.query.maxCandidates,
        maxCandidates,
        requestedDepth: request.query.maxDepth,
        maxDepth,
        anchorMatches: anchored.length,
        exactMatches: exact.length,
        semanticMatches: semantic.flat().length,
        workspaceMatches: workspaceEntries.length,
        selectedCandidates: projections.length,
      })
      for (const projection of projections) {
        if (projection.visibility === "retired") continue
        if (seenReadIds.has(projection.projectionId)) continue
        const tokenEstimate = estimateTokens(projection.semanticText)
        if (evidenceTokens + tokenEstimate > evidenceTokenLimit) {
          evidenceBudgetTruncated = true
          continue
        }
        seenReadIds.add(projection.projectionId)
        evidenceTokens += tokenEstimate
        const storedEvidence = await this.dependencies.evidence.writeImmutable({
          evidenceId: this.dependencies.createId(),
          projectId,
          contextId: context.contextId,
          sourceKind: "graph",
          ownerId: projection.ownerId,
          version: projection.ownerRevisionId,
          digest: digest(projection.semanticText),
          locator: projection.projectionId,
          content: projection.semanticText,
          readReason: request.reason,
          createdAtMs: this.dependencies.now(),
        })
        returned.push({
          readId: storedEvidence.evidenceId,
          reason: request.reason,
          segment: {
            segmentId: this.dependencies.createId(),
            kind: projection.visibility === "pending" ? "pending_artifact" : "committed_read",
            ownerIds: [storedEvidence.evidenceId],
            visibility: projection.visibility,
            canonicalDigest: storedEvidence.digest,
            tokenEstimate,
            sequence: context.segments.length + returned.length,
          },
        })
        evidence.push({
          readId: storedEvidence.evidenceId,
          visibility: projection.visibility,
          ownerKind: projection.ownerKind,
          ownerId: projection.ownerId,
          revisionId: projection.ownerRevisionId,
          exactKeys: projection.exactKeys,
          semanticText: projection.semanticText,
          sourceRefs: projection.sourceRefs,
          digest: projection.digest,
        })
      }
    }
    if (evidenceBudgetTruncated) {
      this.log("debug", "retrieval.evidence_budget.reached", {
        taskId: context.taskId,
        evidenceTokens,
        maxEvidenceTokens: evidenceTokenLimit,
        selectedEvidenceCount: evidence.length,
      })
    }
    return {
      context: recordContextRead(context, {
        requestId: selectedRequests[0]?.requestId ?? this.dependencies.createId(),
        returned,
        rejectedReadIds: [],
      }),
      evidence,
    }
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): void {
    this.dependencies.diagnostics?.log(level, event, fields)
  }

  private parseAndValidatePhaseArtifact(
    phase: AIPhase,
    artifact: unknown,
    taskId: string,
    phaseRunId: string,
  ): unknown {
    const parsedArtifact = parsePhaseArtifact(phase, artifact)
    this.assertDraftCanBePublished(phase, parsedArtifact, taskId, phaseRunId)
    return parsedArtifact
  }

  private assertDraftCanBePublished(
    phase: AIPhase,
    artifact: unknown,
    taskId: string,
    phaseRunId: string,
  ): void {
    if (phase !== "draft") return
    const draft = internalDraftArtifactSchema.parse(artifact)
    const content = draft.contentMarkdown.trim()
    const placeholderPattern = /等待读取|尚未开始(?:撰写|生成)|无法(?:撰写|生成)(?:正文)?|不能(?:撰写|生成)(?:正文)?|待补充(?:资料|设定)/u
    if (!placeholderPattern.test(content)) return
    this.log("error", "draft.placeholder_rejected", {
      taskId,
      phase,
      phaseRunId,
      contentLength: content.length,
      reason: "Draft contains a waiting or refusal placeholder instead of substantive prose",
    })
    throw new Error("Draft content is a waiting/refusal placeholder; the model must write substantive prose even when old evidence is missing")
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
    const chapterId = this.dependencies.createId()
    await this.dependencies.documents.stageVersion({
      id: chapterId,
      projectId: input.projectId,
      scopeId,
      sourceId,
      chapterId,
      contentRef,
      heading: naming.heading,
      publishPath: `章节正文/${sanitizeFilename(naming.filename)}`,
      digest: digest(content),
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
    readEvidence: readonly TurnReadEvidence[],
    createdAtMs: number,
  ): Promise<string[]> {
    const governance = graphGovernanceArtifactSchema.parse(artifacts.graph_governance)
    emergencePlanningArtifactSchema.parse(artifacts.emergence_planning)
    emergenceReviewArtifactSchema.parse(artifacts.emergence_review)
    const dependencyAudit = dependencyAuditArtifactSchema.parse(artifacts.dependency_audit)
    assertSpacetimeGovernanceCoverage(dependencyAudit, governance, sourceUnitIds.length)
    const semantic = semanticReviewArtifactSchema.parse(artifacts.semantic_review)
    assertSemanticReviewCoversGovernance(governance, semantic)
    this.log("debug", "turn.semantic_review.advisory", {
      taskId,
      graphStillDiscoverable: semantic.graphStillDiscoverable,
      graphStillConcise: semantic.graphStillConcise,
      continuityPreserved: semantic.continuityPreserved,
      spacetimeContinuityPreserved: semantic.spacetimeContinuityPreserved,
      sceneInventoryComplete: semantic.sceneInventoryComplete,
      rejectedMutationIndexes: semantic.rejectedMutationIndexes,
      rejectedSpacetimeBindingIndexes: semantic.rejectedSpacetimeBindingIndexes,
      rejectedMutationSpacetimeSettlementIndexes: semantic.rejectedMutationSpacetimeSettlementIndexes,
      rejectedAffectedFrontierRefs: semantic.rejectedAffectedFrontierRefs,
      verificationProbeCount: semantic.verificationProbes.length,
    })
    const readableGraphIds = new Set(readEvidence
      .filter((evidence) => evidence.ownerKind === "node" || evidence.ownerKind === "link")
      .map((evidence) => evidence.ownerId))
    assertGraphGovernanceReferenceContract(
      governance,
      readableGraphIds,
      new Set(readEvidence.map((evidence) => evidence.readId)),
    )
    const localReferences = new Map<string, string>()
    for (const mutation of governance.mutations) {
      if (mutation.operation === "create_node" || mutation.operation === "create_link") {
        if (localReferences.has(mutation.ref)) throw new Error(`Duplicate local graph reference: ${mutation.ref}`)
        localReferences.set(mutation.ref, this.dependencies.createId())
      }
    }
    const resolveReference = (reference: string): string => {
      const local = localReferences.get(reference)
      if (local !== undefined) return local
      if (!readableGraphIds.has(reference)) {
        throw new Error(`Graph reference was not read in this turn: ${reference}`)
      }
      return reference
    }
    const sourceRefs = [{ sourceId }]
    const mutations: GraphMutation[] = governance.mutations.map((mutation) => {
      switch (mutation.operation) {
        case "create_node":
          return {
            operation: "create_node",
            node: {
              id: resolveReference(mutation.ref),
              content: resolveEmbeddedGraphReferences(mutation.data.content, resolveReference),
              ...(mutation.data.metadata === undefined ? {} : {
                metadata: resolveEmbeddedGraphReferences(mutation.data.metadata, resolveReference) as Record<string, unknown>,
              }),
              sourceRefs,
            },
          }
        case "edit_node":
          return {
            operation: "edit_node",
            nodeId: resolveReference(mutation.nodeRef),
            next: {
              content: resolveEmbeddedGraphReferences(mutation.next.content, resolveReference),
              ...(mutation.next.metadata === undefined ? {} : {
                metadata: resolveEmbeddedGraphReferences(mutation.next.metadata, resolveReference) as Record<string, unknown>,
              }),
              sourceRefs,
            },
          }
        case "retire_node":
          return { operation: "retire_node", nodeId: resolveReference(mutation.nodeRef), archiveOutletIds: mutation.archiveOutletRefs.map(resolveReference) }
        case "create_link":
          return {
            operation: "create_link",
            link: {
              id: resolveReference(mutation.ref),
              fromNodeId: resolveReference(mutation.fromRef),
              toNodeId: resolveReference(mutation.toRef),
              ...(mutation.content === undefined ? {} : { content: resolveEmbeddedGraphReferences(mutation.content, resolveReference) }),
              ...(mutation.metadata === undefined ? {} : { metadata: resolveEmbeddedGraphReferences(mutation.metadata, resolveReference) as Record<string, unknown> }),
              sourceRefs,
            },
          }
        case "edit_link":
          return {
            operation: "edit_link",
            linkId: resolveReference(mutation.linkRef),
            next: {
              fromNodeId: resolveReference(mutation.fromRef),
              toNodeId: resolveReference(mutation.toRef),
              ...(mutation.content === undefined ? {} : { content: resolveEmbeddedGraphReferences(mutation.content, resolveReference) }),
              ...(mutation.metadata === undefined ? {} : { metadata: resolveEmbeddedGraphReferences(mutation.metadata, resolveReference) as Record<string, unknown> }),
              sourceRefs,
            },
          }
        case "retire_link":
          return { operation: "retire_link", linkId: resolveReference(mutation.linkRef), archiveOutletIds: mutation.archiveOutletRefs.map(resolveReference) }
      }
    })
    const revisions: GraphRevision[] = []
    const revisionByMutation = new Map<number, string>()
    for (const [index, mutation] of mutations.entries()) {
      const revision = await this.materializeMutation(input.projectId, scopeId, mutation, governance, index, sourceUnitIds, createdAtMs)
      revisions.push(revision)
      revisionByMutation.set(index, revision.revisionId)
    }
    await this.dependencies.graph.stageRevisions(input.projectId, scopeId, revisions)
    const sceneBindingIds = new Map<number, string>()
    const sceneBindings: SceneSpacetimeBindingRecord[] = governance.sceneSpacetimeBindings.map((binding) => {
      const id = this.dependencies.createId()
      sceneBindingIds.set(binding.sceneIndex, id)
      return {
        id,
        projectId: input.projectId,
        scopeId,
        sourceId,
        sceneIndex: binding.sceneIndex,
        sceneAnchorId: resolveReference(binding.sceneAnchorRef),
        sourceUnitIndexes: binding.sourceUnitIndexes,
        temporalReferenceRefs: binding.temporalReferenceRefs.map(resolveReference),
        timeAnchorRefs: binding.timeAnchorRefs.map(resolveReference),
        spatialReferenceRefs: binding.spatialReferenceRefs.map(resolveReference),
        locationAnchorRefs: binding.locationAnchorRefs.map(resolveReference),
        predecessorSceneIndexes: binding.predecessorSceneIndexes,
        predecessorSceneRefs: binding.predecessorSceneAnchorRefs.map(resolveReference),
        transitionPathRefs: binding.transitionPathRefs.map(resolveReference),
        correspondenceRefs: binding.correspondenceRefs.map(resolveReference),
        reason: binding.explanation,
        selfReview: binding.selfReview,
        visibility: "pending",
        digest: digest(binding),
        createdAtMs,
      }
    })
    await this.dependencies.persistence.stageSceneSpacetimeBindings(sceneBindings)
    const revisionSpacetime: GraphRevisionSpacetimeRecord[] = governance.mutationSpacetimeSettlements.flatMap((settlement) => (
      settlement.mutationIndexes
        .filter((mutationIndex) => revisionByMutation.has(mutationIndex))
        .map((mutationIndex) => {
          const graphRevisionId = revisionByMutation.get(mutationIndex)
          if (graphRevisionId === undefined) throw new Error(`Missing graph revision for mutation ${String(mutationIndex)}`)
          return {
            id: this.dependencies.createId(),
            projectId: input.projectId,
            scopeId,
            graphRevisionId,
            effectDisposition: settlement.effectDisposition,
            effectiveSceneBindingIds: settlement.effectiveSceneBindingIndexes.map((index) => {
              const bindingId = sceneBindingIds.get(index)
              if (bindingId === undefined) throw new Error(`Missing scene binding for scene ${String(index)}`)
              return bindingId
            }),
            effectiveExistingSceneRefs: settlement.effectiveExistingSceneAnchorRefs.map(resolveReference),
            currentEntryRefs: settlement.currentEntryRefs.map(resolveReference),
            predecessorRevisionRequired: settlement.predecessorRevisionRequired,
            predecessorRevisionIds: settlement.predecessorRevisionReadRefs.map((readId) => resolveReadRevisionId(readId, readEvidence)),
            historicalReturnRefs: settlement.historicalReturnRefs.map(resolveReference),
            reason: settlement.reason,
            selfReview: settlement.selfReview,
            visibility: "pending" as const,
            digest: digest({ settlement, mutationIndex, graphRevisionId }),
            createdAtMs,
          }
        })
    ))
    await this.dependencies.persistence.stageGraphRevisionSpacetime(revisionSpacetime)
    await Promise.all(governance.retrievalProjections.map(async (projection) => {
      const ownerId = projection.ownerMutationIndex === undefined
        ? "ownerRef" in projection && projection.ownerRef !== undefined
          ? resolveReference(projection.ownerRef)
          : undefined
        : mutationTargetId(mutations[projection.ownerMutationIndex])
      if (ownerId === undefined) throw new Error("Projection has no resolvable owner")
      const ownerRevisionId = projection.ownerMutationIndex === undefined
        ? (await this.dependencies.graph.listRevisions(input.projectId, projection.ownerKind, ownerId)).at(-1)?.revisionId
        : revisionByMutation.get(projection.ownerMutationIndex)
      if (ownerRevisionId === undefined) throw new Error("Projection has no approved owner revision")
      await this.dependencies.retrieval.stageProjection({
        projectionId: this.dependencies.createId(),
        projectId: input.projectId,
        scopeId,
        ownerKind: projection.ownerKind,
        ownerId,
        ownerRevisionId,
        exactKeys: projection.exactKeys,
        semanticText: projection.semanticText,
        sourceRefs,
        digest: digest(projection),
      })
    }))
    const records: SettlementRecord[] = governance.settlementRecords.map((record) => ({
      id: this.dependencies.createId(),
      projectId: input.projectId,
      scopeId,
      sourceUnitId: requireSourceUnit(sourceUnitIds, record.sourceUnitIndex),
      graphRefs: record.graphRefs.map((reference) => ({
        targetKind: reference.targetKind,
        targetId: resolveReference(reference.targetRef),
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
        id: this.dependencies.createId(),
        projectId: input.projectId,
        taskId,
        scopeId,
        phaseRunId: graphPhaseRunId,
        decisionKind: record.decisionKind,
        reason: record.reason,
        evidenceIds: readEvidence.map((evidence) => evidence.readId),
        payload: {
          ...record.payload as object,
          mutationIndexes: record.mutationIndexes,
          mutationSpacetimeSettlementIndexes: record.mutationSpacetimeSettlementIndexes,
          selfReview: record.selfReview,
        },
        digest: digest(record),
        createdAtMs,
      }))
      await this.dependencies.persistence.stageDecisionRecords(decisionRecords)
    }
    const frontier = frontierSettlementArtifactSchema.parse(artifacts.frontier_settlement)
    await this.dependencies.persistence.stageFrontiers(frontier.frontiers
      .map((item) => ({
        id: this.dependencies.createId(),
        projectId: input.projectId,
        scopeId,
        frontierAnchorRef: resolveReference(item.frontierAnchorRef),
        disposition: item.disposition,
        lastSceneAnchorRefs: item.lastSceneAnchorRefs.map(resolveReference),
        lastTimeAnchorRefs: item.lastTimeAnchorRefs.map(resolveReference),
        lastLocationAnchorRefs: item.lastLocationAnchorRefs.map(resolveReference),
        correspondenceRefs: item.correspondenceRefs.map(resolveReference),
        lastProcessedAt: createdAtMs,
        reason: item.reason,
        ...(item.revisitCondition === undefined ? {} : { revisitCondition: item.revisitCondition }),
      })))
    const settlementReview = settlementReviewArtifactSchema.parse(artifacts.settlement_review)
    this.log("debug", "turn.settlement_review.advisory", {
      taskId,
      sourceReturnComplete: settlementReview.sourceReturnComplete,
      retrievalProjectionComplete: settlementReview.retrievalProjectionComplete,
      semanticCoverageComplete: settlementReview.semanticCoverageComplete,
      spacetimeBindingsComplete: settlementReview.spacetimeBindingsComplete,
      mutationSpacetimeSettlementsComplete: settlementReview.mutationSpacetimeSettlementsComplete,
      uncoveredSourceUnitIndexes: settlementReview.uncoveredSourceUnitIndexes,
    })
    settlementReview.settledSourceUnitIndexes.forEach((index) => { requireSourceUnit(sourceUnitIds, index) })
    return [...new Set(mutations.flatMap((mutation) => {
      switch (mutation.operation) {
        case "create_node": return [mutation.node.id]
        case "edit_node": return [mutation.nodeId]
        case "retire_node": return [mutation.nodeId]
        case "create_link": return [mutation.link.fromNodeId, mutation.link.toNodeId]
        case "edit_link": return [mutation.next.fromNodeId, mutation.next.toNodeId]
        case "retire_link": return []
      }
    }))]
  }

  private async materializeMutation(
    projectId: ProjectId,
    scopeId: string,
    mutation: GraphMutation,
    governance: GraphGovernanceArtifact,
    mutationIndex: number,
    evidenceIds: readonly string[],
    createdAtMs: number,
  ): Promise<GraphRevision> {
    const decision = governance.decisionRecords.find((candidate) => candidate.mutationIndexes.includes(mutationIndex))
    if (decision === undefined) {
      throw new Error(`Approved graph mutation ${String(mutationIndex)} has no AI decision record`)
    }
    const { reason, selfReview } = decision
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
  retrievalGaps: readonly TurnRetrievalGap[]
  catalogSnapshot: WorkspaceCatalogSnapshot
  budget: ModelCallBudget
  usage: { modelCalls: number; inputTokens: number; outputTokens: number; cacheHits: number; cacheMisses: number }
}>

function isMandatoryWorkspaceEntry(entry: WorkspaceCatalogEntry): boolean {
  if (entry.entryKind !== "file") return false
  return entry.relativePath === "设定集/readme.md"
    || entry.relativePath === "参考文件/readme.md"
    || entry.relativePath.startsWith("世界推演规则/用户规则/")
}

function resolveSelectedPresentationPaths(
  presentation: TurnOrchestratorInput["presentation"],
): readonly string[] {
  if (presentation === undefined) return []
  if (presentation.descriptionRulePath !== undefined
    && !presentation.descriptionRulePath.startsWith("表现输出/描写规则/")) {
    throw new Error(`Description rule must be inside 表现输出/描写规则: ${presentation.descriptionRulePath}`)
  }
  if (presentation.proseStyleRulePath !== undefined
    && !presentation.proseStyleRulePath.startsWith("表现输出/笔风规则/")) {
    throw new Error(`Prose style rule must be inside 表现输出/笔风规则: ${presentation.proseStyleRulePath}`)
  }
  return [
    presentation.descriptionRulePath ?? "表现输出/描写规则/默认描写规则.md",
    presentation.proseStyleRulePath ?? "表现输出/笔风规则/默认笔风规则.md",
  ]
}

function workspaceTurnEvidence(
  readId: string,
  entry: WorkspaceCatalogEntry,
  content: string,
): TurnReadEvidence {
  return {
    readId,
    visibility: "committed",
    ownerKind: `workspace:${entry.role}`,
    ownerId: entry.relativePath,
    exactKeys: [entry.relativePath, entry.relativePath.split("/").at(-1) ?? entry.relativePath],
    semanticText: content,
    sourceRefs: [{ sourceKind: "workspace", relativePath: entry.relativePath, version: entry.version }],
    digest: entry.digest,
  }
}

function resolveRuleSourceVersions(
  selectedWorkspacePaths: readonly string[],
  evidence: readonly TurnReadEvidence[],
): Readonly<Record<"userRules" | "settingSkills" | "references" | "presentationRules", readonly string[]>> {
  const evidenceByPath = new Map(evidence.map((item) => [item.ownerId, item]))
  const mandatoryPaths = evidence
    .filter((item) => item.ownerKind === "workspace:world_rules"
      || item.ownerId === "设定集/readme.md"
      || item.ownerId === "参考文件/readme.md"
      || item.ownerKind === "workspace:presentation")
    .map((item) => item.ownerId)
  const selected = new Set([...mandatoryPaths, ...selectedWorkspacePaths])
  for (const path of selected) {
    if (!evidenceByPath.has(path)) throw new Error(`Selected workspace path was not read in this turn: ${path}`)
  }
  const idsFor = (ownerKind: string): string[] => [...selected]
    .map((path) => evidenceByPath.get(path))
    .filter((item): item is TurnReadEvidence => item?.ownerKind === ownerKind)
    .map((item) => item.readId)
  return {
    userRules: idsFor("workspace:world_rules"),
    settingSkills: idsFor("workspace:settings"),
    references: idsFor("workspace:references"),
    presentationRules: idsFor("workspace:presentation"),
  }
}

function selectWorkspaceEntries(
  catalogSnapshot: WorkspaceCatalogSnapshot,
  request: PhaseResultEnvelope["requestedReads"][number],
  limit: number,
): WorkspaceCatalogEntry[] {
  const roles = new Set<WorkspaceCatalogEntry["role"]>()
  if (request.query.sourceKinds.includes("rule")) roles.add("world_rules")
  if (request.query.sourceKinds.includes("reference")) {
    roles.add("settings")
    roles.add("references")
  }
  if (request.query.sourceKinds.includes("source")) roles.add("chapters")
  if (roles.size === 0) return []
  const terms = [...request.query.exactKeys, ...request.query.semanticTexts]
    .map((term) => term.trim().toLocaleLowerCase())
    .filter((term) => term.length > 0)
  return catalogSnapshot.entries
    .filter((entry) => entry.entryKind === "file" && roles.has(entry.role))
    .map((entry) => {
      const path = entry.relativePath.toLocaleLowerCase()
      const filename = path.split("/").at(-1) ?? path
      const score = terms.length === 0 ? 1 : Math.max(0, ...terms.map((term) => (
        path === term ? 100 : filename === term ? 80 : path.includes(term) ? 20 : 0
      )))
      return { entry, score }
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score
      || left.entry.relativePath.localeCompare(right.entry.relativePath, "zh-CN"))
    .slice(0, limit)
    .map((candidate) => candidate.entry)
}

function requireSourceUnit(sourceUnitIds: readonly string[], index: number): string {
  const sourceUnitId = sourceUnitIds[index]
  if (sourceUnitId === undefined) throw new Error(`Source unit index is outside the current chapter: ${String(index)}`)
  return sourceUnitId
}

function mutationTargetId(mutation: GraphMutation | undefined): string | undefined {
  if (mutation === undefined) return undefined
  if ("node" in mutation) return mutation.node.id
  if ("link" in mutation) return mutation.link.id
  if ("nodeId" in mutation) return mutation.nodeId
  return mutation.linkId
}

function resolveReadRevisionId(readId: string, readEvidence: readonly TurnReadEvidence[]): string {
  const evidence = readEvidence.find((item) => item.readId === readId)
  if (evidence?.revisionId === undefined) {
    throw new Error(`Predecessor revision read evidence has no fixed revision: ${readId}`)
  }
  return evidence.revisionId
}

type ExecutePhaseResult = Readonly<{
  phaseRunId: string
  context: TurnContext
  readEvidence: readonly TurnReadEvidence[]
  retrievalGaps: readonly TurnRetrievalGap[]
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

function phaseUsageFromExecution(execution: PhaseModelExecution): PhaseUsage {
  return {
    modelCalls: execution.usage.modelCalls ?? 1,
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

function isRecordWithRawResponse(error: unknown): error is { rawResponse: string } {
  return typeof error === "object"
    && error !== null
    && "rawResponse" in error
    && typeof error.rawResponse === "string"
}

function createBudget(input: TurnOrchestratorInput, nowMs: number): ModelCallBudget {
  const requestedCalls = input.maxModelCalls ?? defaultTurnExecutionProfile.maxTurnModelCalls
  const maxCalls = requestedCalls
  const maxInputTokens = input.maxInputTokens ?? Number.MAX_SAFE_INTEGER
  const maxOutputTokens = input.maxOutputTokens ?? Number.MAX_SAFE_INTEGER
  return {
    maxCalls,
    remainingCalls: maxCalls,
    maxInputTokens,
    remainingInputTokens: maxInputTokens,
    maxOutputTokens,
    remainingOutputTokens: maxOutputTokens,
    deadlineAtMs: nowMs + (input.deadlineMs ?? defaultTurnExecutionProfile.maxTurnWallTimeMs),
    retrievalExecutionDeadlineAtMs: nowMs + (input.retrievalExecutionDeadlineMs ?? 15_000),
    retrievalPhaseDeadlineAtMs: nowMs + (input.retrievalPhaseDeadlineMs ?? 60_000),
  }
}

function resolveContextTokenLimit(
  requestedTokens: number | undefined,
  modelContextWindowTokens: number | undefined,
  compactionThresholdRatio: number,
): number {
  const contextWindowTokens = modelContextWindowTokens ?? defaultProjectSettings.execution.contextWindowTokens
  const compactionThreshold = Math.max(1, Math.floor(contextWindowTokens * compactionThresholdRatio))
  return requestedTokens === undefined ? compactionThreshold : Math.min(requestedTokens, compactionThreshold)
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

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil((typeof value === "string" ? value : JSON.stringify(value)).length / 4))
}

function uniqueRetrievalProjections<T extends { projectionId: string }>(
  projections: readonly T[],
  limit: number,
): readonly T[] {
  return [...new Map(projections.map((projection) => [projection.projectionId, projection])).values()].slice(0, limit)
}

function resolveEmbeddedGraphReferences(
  value: unknown,
  resolveReference: (reference: string) => string,
): unknown {
  if (typeof value === "string") {
    return /^local:[a-zA-Z0-9_.-]+$/u.test(value) ? resolveReference(value) : value
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveEmbeddedGraphReferences(item, resolveReference))
  }
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    resolveEmbeddedGraphReferences(item, resolveReference),
  ]))
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
