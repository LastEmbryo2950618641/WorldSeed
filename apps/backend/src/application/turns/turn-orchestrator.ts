import {
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  phaseRequestEnvelopeSchema,
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
  RelatedOwnerRef,
} from "./ports/index.js"
import type { InternalProjectStore, InternalStorePort, WorkspacePort } from "../workspace/index.js"
import type {
  EvidenceStore,
  WorkspaceCatalogPort,
  WorkspaceCatalogSnapshotRepository,
} from "../retrieval/index.js"
import { buildSourceUnitExactKeys } from "../retrieval/index.js"
import { createRetrievalGaps } from "./retrieval-gap.js"

const turnModelPhases: readonly AIPhase[] = [
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

const turnExecutionPhases: readonly AIPhase[] = [
  ...turnModelPhases.slice(0, 2),
  "source_retrieval",
  ...turnModelPhases.slice(2),
]

const queryExecutionPhases: readonly AIPhase[] = [
  "interpret",
  "rule_assembly",
  "source_retrieval",
  "draft",
  "response_review",
]

const evolutionExecutionPhases: readonly AIPhase[] = [
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
]

const phaseArtifactDependencies = {
  interpret: [],
  rule_assembly: ["interpret"],
  source_retrieval: ["interpret", "rule_assembly"],
  emergence_planning: ["interpret", "rule_assembly", "source_retrieval"],
  emergence_review: ["source_retrieval", "emergence_planning"],
  draft: ["interpret", "rule_assembly", "source_retrieval", "emergence_planning", "emergence_review"],
  chapter_naming: ["draft"],
  dependency_audit: ["source_retrieval", "emergence_planning", "emergence_review", "draft"],
  response_review: ["source_retrieval", "draft", "dependency_audit"],
  graph_governance: ["source_retrieval", "emergence_planning", "emergence_review", "draft", "dependency_audit"],
  semantic_review: ["draft", "dependency_audit", "graph_governance"],
  settlement_review: ["dependency_audit", "graph_governance", "semantic_review"],
  frontier_settlement: ["graph_governance", "semantic_review", "settlement_review"],
  commit_review: ["draft", "dependency_audit", "graph_governance", "semantic_review", "settlement_review", "frontier_settlement"],
  context_compaction: [
    "interpret",
    "rule_assembly",
    "source_retrieval",
    "emergence_planning",
    "emergence_review",
    "draft",
    "chapter_naming",
    "dependency_audit",
    "response_review",
    "graph_governance",
    "semantic_review",
    "settlement_review",
    "frontier_settlement",
    "commit_review",
  ],
  context_compaction_review: ["context_compaction"],
} as const satisfies Record<AIPhase, readonly AIPhase[]>

const workspaceCatalogPhases = new Set<AIPhase>(["interpret", "rule_assembly", "source_retrieval"])

export type WorldWorkflow = "turn" | "query" | "evolution"

function executionPhasesFor(workflow: WorldWorkflow): readonly AIPhase[] {
  switch (workflow) {
    case "turn": return turnExecutionPhases
    case "query": return queryExecutionPhases
    case "evolution": return evolutionExecutionPhases
  }
}

export type TurnOrchestratorInput = Readonly<{
  workflow?: WorldWorkflow
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
  allowWorkspaceChapterReads?: boolean
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
  kind: "turn"
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

export type WorldQueryExecutionResult = Readonly<{
  kind: "query"
  taskId: string
  turnId: string
  scopeId: string
  contextId: string
  answerMarkdown: string
  evidence: readonly Readonly<{
    readId: string
    ownerKind: string
    ownerId: string
    revisionId?: string
    sourceRefs: readonly unknown[]
  }>[]
  modelCalls: number
  inputTokens: number
  outputTokens: number
  modelProvider: string
  modelName: string
  kvCacheHitRate?: number
}>

export type WorldEvolutionExecutionResult = Readonly<{
  kind: "evolution"
  taskId: string
  turnId: string
  scopeId: string
  contextId: string
  graphAnchorIds: readonly string[]
  graphMutationCount: number
  modelCalls: number
  inputTokens: number
  outputTokens: number
  modelProvider: string
  modelName: string
  kvCacheHitRate?: number
}>

export type WorkflowExecutionResult = TurnExecutionResult | WorldQueryExecutionResult | WorldEvolutionExecutionResult

export type TurnExecutionHooks = Readonly<{
  onPrepared?(): void
  signal?: AbortSignal
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

type TurnBudgetMetric = "model_calls" | "input_tokens" | "output_tokens" | "wall_time"

class TurnBudgetExceededError extends Error {
  public constructor(public readonly metric: TurnBudgetMetric, message: string) {
    super(message)
    this.name = "TurnBudgetExceededError"
  }
}

export class TurnOrchestrator {
  public constructor(private readonly dependencies: TurnOrchestratorDependencies) {}

  public async execute(input: TurnOrchestratorInput, hooks?: TurnExecutionHooks): Promise<WorkflowExecutionResult> {
    throwIfExecutionCancelled(hooks?.signal)
    const workflow = input.workflow ?? "turn"
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
      workflow,
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
      kind: workflow,
      status: "created",
      reason: `AI ${workflow} starts from user input and creates a pending isolated scope`,
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
      taskKind: workflow,
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
    const evolutionFrontierReads = workflow === "evolution"
      ? await this.readEvolutionFrontierEvidence(context, input)
      : { context, evidence: [] as TurnReadEvidence[] }
    context = evolutionFrontierReads.context
    await this.dependencies.persistence.saveContext(context, this.dependencies.now())
    await this.dependencies.persistence.updateTask(taskId, "running", undefined, createdAtMs)
    hooks?.onPrepared?.()

    const artifacts: Partial<Record<AIPhase, unknown>> = {}
    const phaseRunIds: string[] = []
    const phaseRuns = new Map<AIPhase, string>()
    let sourceUnitIds: string[] = []
    let readEvidence: TurnReadEvidence[] = [
      ...mandatoryWorkspaceReads.evidence,
      ...evolutionFrontierReads.evidence,
    ]
    let retrievalGaps: TurnRetrievalGap[] = []
    return this.continueExecution(input, {
      taskId,
      turnId,
      scopeId,
      contextId,
      sourceId,
      createdAtMs,
      baseRuleVersion: baseRules.version,
      catalogSnapshot,
      context,
      artifacts,
      phaseRunIds,
      phaseRuns,
      phaseAttempts: new Map(),
      sourceUnitIds,
      readEvidence,
      visibleEvidence: [...readEvidence],
      retrievalGaps,
      totalUsage: emptyPhaseUsage(),
      budget,
      startPhaseIndex: 0,
      ...(hooks?.signal === undefined ? {} : { signal: hooks.signal }),
    })
  }

  public async resume(input: TurnOrchestratorInput, mode: "continue" | "retry_phase" = "continue", hooks?: TurnExecutionHooks): Promise<WorkflowExecutionResult> {
    throwIfExecutionCancelled(hooks?.signal)
    const workflow = input.workflow ?? "turn"
    const executionPhases = executionPhasesFor(workflow)
    if (input.taskId === undefined) throw new Error("A taskId is required to resume a turn")
    const task = await this.dependencies.taskScopes.findTask(input.taskId)
    if (task === undefined) throw new Error(`Cannot resume missing task: ${input.taskId}`)
    if (task.status !== "awaiting_user_decision" && task.status !== "paused") {
      throw new Error(`Task cannot resume from status: ${task.status}`)
    }
    const scope = await this.dependencies.taskScopes.findScope(task.scopeId)
    const context = await this.dependencies.persistence.findContextByTask(input.taskId)
    const storedRuns = await this.dependencies.persistence.listPhaseRuns(input.taskId)
    if (scope === undefined || context === undefined || storedRuns.length === 0) {
      throw new Error("The task has no recoverable phase checkpoint")
    }
    const latestRun = storedRuns.at(-1)
    if (latestRun === undefined) throw new Error("The task has no recoverable phase checkpoint")
    const storedInputs = storedRuns.map((run) => {
      const storedRequest = phaseRequestEnvelopeSchema.parse(run.request)
      return readStoredTurnPhaseInput(storedRequest.input)
    })
    const latestInput = storedInputs.at(-1)
    if (latestInput === undefined) throw new Error("The task has no recoverable phase checkpoint")
    const sourceId = [...storedInputs].reverse().find((storedInput) => storedInput.sourceId !== undefined)?.sourceId
    const catalogSnapshot = [...storedInputs].reverse().find((storedInput) => storedInput.workspaceCatalog !== undefined)?.workspaceCatalog
    if (sourceId === undefined || catalogSnapshot === undefined) {
      throw new Error("The task checkpoint is missing source or workspace catalog state")
    }
    const artifacts: Partial<Record<AIPhase, unknown>> = {}
    const phaseRuns = new Map<AIPhase, string>()
    const phaseAttempts = new Map<AIPhase, number>()
    for (const run of storedRuns) {
      phaseRuns.set(run.phase, run.phaseRunId)
      phaseAttempts.set(run.phase, Math.max(phaseAttempts.get(run.phase) ?? 0, run.attempt))
      if (run.status !== "completed" || run.result === undefined) continue
      const result = phaseResultEnvelopeSchema.parse(run.result)
      artifacts[run.phase] = parsePhaseArtifact(run.phase, result.artifact)
    }
    const latestPhaseIndex = executionPhases.indexOf(latestRun.phase)
    if (latestPhaseIndex < 0) throw new Error(`Cannot resume unknown phase: ${latestRun.phase}`)
    const startPhaseIndex = latestRun.status === "completed" ? latestPhaseIndex + 1 : latestPhaseIndex
    const commitReviewIndex = executionPhases.indexOf("commit_review")
    if (commitReviewIndex >= 0 && startPhaseIndex >= commitReviewIndex) {
      await this.dependencies.commit.resetPending(task.scopeId)
    }
    const nowMs = input.nowMs ?? this.dependencies.now()
    const totalUsage = storedRuns.reduce((total, run) => addPhaseUsage(total, phaseUsageFromStored(run.usage)), emptyPhaseUsage())
    const restoredReadEvidence = uniqueTurnReadEvidence(storedInputs.flatMap((storedInput) => storedInput.readEvidence))
    this.log("info", "turn.resumed", {
      taskId: task.taskId,
      resumePhase: executionPhases[startPhaseIndex],
      completedPhaseRuns: storedRuns.filter((run) => run.status === "completed").length,
      previousModelCalls: totalUsage.modelCalls,
      mode,
    })
    await this.dependencies.persistence.updateTask(task.taskId, "running", executionPhases[startPhaseIndex], nowMs)
    return this.continueExecution(input, {
      taskId: task.taskId,
      turnId: scope.turnId,
      scopeId: task.scopeId,
      contextId: context.contextId,
      sourceId,
      createdAtMs: task.createdAtMs,
      baseRuleVersion: (await this.dependencies.prompts.loadBaseRules()).version,
      catalogSnapshot,
      context,
      artifacts,
      phaseRunIds: storedRuns.map((run) => run.phaseRunId),
      phaseRuns,
      phaseAttempts,
      sourceUnitIds: [...latestInput.sourceUnitIds],
      readEvidence: restoredReadEvidence,
      visibleEvidence: [...latestInput.readEvidence],
      retrievalGaps: [...latestInput.retrievalGaps],
      totalUsage,
      budget: createBudget(input, nowMs),
      startPhaseIndex,
      ...(hooks?.signal === undefined ? {} : { signal: hooks.signal }),
    })
  }

  private async continueExecution(input: TurnOrchestratorInput, state: TurnExecutionState): Promise<WorkflowExecutionResult> {
    const workflow = input.workflow ?? "turn"
    const executionPhases = executionPhasesFor(workflow)
    let {
      context,
      sourceUnitIds,
      readEvidence,
      visibleEvidence,
      retrievalGaps,
      totalUsage,
    } = state
    const artifacts = state.artifacts
    const phaseRunIds = state.phaseRunIds
    const phaseRuns = state.phaseRuns
    let windowUsage = emptyPhaseUsage()

    try {
      for (const phase of executionPhases.slice(state.startPhaseIndex)) {
        throwIfExecutionCancelled(state.signal)
        const phaseStartedAtMs = this.dependencies.now()
        const phaseRunId = this.dependencies.createId()
        const attempt = (state.phaseAttempts.get(phase) ?? 0) + 1
        state.phaseAttempts.set(phase, attempt)
        phaseRunIds.push(phaseRunId)
        phaseRuns.set(phase, phaseRunId)
        const result = await this.executePhase({
          input,
          inputScopeId: state.scopeId,
          sourceId: state.sourceId,
          sourceUnitIds,
          phase,
          phaseRunId,
          attempt,
          phaseRunIds,
          context,
          artifacts,
          readEvidence,
          visibleEvidence,
          retrievalGaps,
          catalogSnapshot: state.catalogSnapshot,
          budget: state.budget,
          usage: windowUsage,
          ...(state.signal === undefined ? {} : { signal: state.signal }),
        })
        context = result.context
        readEvidence = [...result.readEvidence]
        visibleEvidence = [...result.visibleEvidence]
        retrievalGaps = [...result.retrievalGaps]
        phaseRuns.set(phase, result.phaseRunId)
        artifacts[phase] = result.artifact
        windowUsage = addPhaseUsage(windowUsage, result.usage)
        totalUsage = addPhaseUsage(totalUsage, result.usage)
        this.log("debug", "phase.completed", {
          taskId: state.taskId,
          phase,
          phaseRunId: result.phaseRunId,
          elapsedMs: this.dependencies.now() - phaseStartedAtMs,
          phaseModelCalls: result.usage.modelCalls,
          phaseInputTokens: result.usage.inputTokens,
          phaseOutputTokens: result.usage.outputTokens,
          totalModelCalls: totalUsage.modelCalls,
          totalInputTokens: totalUsage.inputTokens,
          totalOutputTokens: totalUsage.outputTokens,
          deadlineRemainingMs: state.budget.deadlineAtMs - this.dependencies.now(),
          contextSegments: context.segments.length,
          evidenceCount: readEvidence.length,
          visibleEvidenceCount: visibleEvidence.length,
          retrievalGapCount: retrievalGaps.length,
        })
        assertUsageWithinBudget(state.budget, windowUsage, this.dependencies.now())
        await this.dependencies.persistence.updateTask(state.taskId, phase === "commit_review" ? "committing" : "running", phase, this.dependencies.now())
        if (phase === "rule_assembly") {
          const rules = ruleAssemblyArtifactSchema.parse(result.artifact)
          const ruleSnapshotId = this.dependencies.createId()
          const sourceVersions = resolveRuleSourceVersions(rules.selectedWorkspacePaths, readEvidence)
          const ruleSnapshot = {
            id: ruleSnapshotId,
            projectId: input.projectId,
            taskId: state.taskId,
            baseRuleVersion: state.baseRuleVersion,
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
          sourceUnitIds = await this.persistDraftUnits(input, state.scopeId, state.sourceId, artifacts)
        }
      }

      throwIfExecutionCancelled(state.signal)
      if (workflow === "query") {
        return await this.completeQuery(state, artifacts, readEvidence, totalUsage)
      }
      if (workflow === "evolution") {
        return await this.completeEvolution(input, state, artifacts, phaseRuns, readEvidence, totalUsage)
      }
      return await this.completeTurn(input, state, artifacts, phaseRuns, sourceUnitIds, readEvidence, totalUsage)
    } catch (error) {
      if (state.signal?.aborted) {
        const cancelledPhase = phaseRuns.size === 0 ? undefined : [...phaseRuns.keys()].at(-1)
        const cancelledAtMs = this.dependencies.now()
        this.log("info", "turn.cancelled", {
          taskId: state.taskId,
          turnId: state.turnId,
          phase: cancelledPhase,
          phaseRunId: phaseRuns.get(cancelledPhase as AIPhase),
          elapsedMs: cancelledAtMs - state.createdAtMs,
        })
        await this.dependencies.persistence.updateTask(
          state.taskId,
          "cancelled",
          cancelledPhase,
          cancelledAtMs,
        )
        throw executionCancellationReason(state.signal)
      }
      const failedPhase = phaseRuns.size === 0 ? undefined : [...phaseRuns.keys()].at(-1)
      const interruptedAtMs = this.dependencies.now()
      const normalizedError = normalizeDeadlineInterruption(error, state.budget, interruptedAtMs)
      const interruption = createInterruptionRecord(normalizedError, failedPhase, phaseRuns.get(failedPhase as AIPhase), interruptedAtMs)
      this.log("warn", "turn.interrupted", {
        taskId: state.taskId,
        turnId: state.turnId,
        failedPhase,
        elapsedMs: interruptedAtMs - state.createdAtMs,
        deadlineAtMs: state.budget.deadlineAtMs,
        nowMs: interruptedAtMs,
        usage: totalUsage,
        interruption,
      })
      await this.dependencies.persistence.updateTask(
        state.taskId,
        "awaiting_user_decision",
        failedPhase,
        interruptedAtMs,
        interruption,
      )
      throw normalizedError
    }
  }

  private async completeTurn(
    input: TurnOrchestratorInput,
    state: TurnExecutionState,
    artifacts: Partial<Record<AIPhase, unknown>>,
    phaseRuns: ReadonlyMap<AIPhase, string>,
    sourceUnitIds: readonly string[],
    readEvidence: readonly TurnReadEvidence[],
    totalUsage: PhaseUsage,
  ): Promise<TurnExecutionResult> {
    const naming = chapterNamingArtifactSchema.parse(artifacts.chapter_naming)
    const draft = internalDraftArtifactSchema.parse(artifacts.draft)
    const commitReview = parsePhaseArtifact("commit_review", artifacts.commit_review) as { recommendation: string }
    this.log("debug", "turn.commit_review.advisory", {
      taskId: state.taskId,
      recommendation: commitReview.recommendation,
      message: "AI commit review is advisory; structural and settlement gates decide whether the turn can be persisted",
    })
    const chapterContent = ensureHeading(naming.heading, draft.contentMarkdown)
    const contentRef = await this.dependencies.internalStore.writeImmutableDocument(input.internalStore, state.sourceId, chapterContent)
    await this.stageDocument(input, state.sourceId, state.scopeId, naming, contentRef, chapterContent, state.createdAtMs)
    const graphAnchorIds = await this.stageGraphAndSettlement(
      input,
      state.taskId,
      state.sourceId,
      state.scopeId,
      phaseRuns.get("graph_governance"),
      artifacts,
      sourceUnitIds,
      readEvidence,
      state.createdAtMs,
    )

    await this.dependencies.commit.commit(state.scopeId)
    const chapterPath = `章节正文/${sanitizeFilename(naming.filename)}`
    await this.dependencies.workspace.publishChapter(input.workspaceRootRef, chapterPath, chapterContent)
    await this.dependencies.persistence.updateTask(state.taskId, "completed", "commit_review", this.dependencies.now())
    const governance = graphGovernanceArtifactSchema.parse(artifacts.graph_governance)
    this.log("info", "turn.committed", {
      taskId: state.taskId,
      turnId: state.turnId,
      scopeId: state.scopeId,
      chapterPath,
      elapsedMs: this.dependencies.now() - state.createdAtMs,
      modelCalls: totalUsage.modelCalls,
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      graphMutationCount: governance.mutations.length,
    })
    return {
      kind: "turn",
      taskId: state.taskId,
      turnId: state.turnId,
      scopeId: state.scopeId,
      contextId: state.contextId,
      chapterPath,
      chapterHeading: naming.heading,
      modelCalls: totalUsage.modelCalls,
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      modelProvider: this.dependencies.model.info?.provider ?? "unknown",
      modelName: this.dependencies.model.info?.model ?? "unknown",
      graphAnchorIds,
      ...cacheRateResult(totalUsage),
    }
  }

  private async completeQuery(
    state: TurnExecutionState,
    artifacts: Partial<Record<AIPhase, unknown>>,
    readEvidence: readonly TurnReadEvidence[],
    totalUsage: PhaseUsage,
  ): Promise<WorldQueryExecutionResult> {
    const draft = internalDraftArtifactSchema.parse(artifacts.draft)
    const review = parsePhaseArtifact("response_review", artifacts.response_review) as {
      evidenceClosed: boolean
      leaksUnobservedInformation: boolean
      requiresWorkflowUpgrade: boolean
    }
    this.log("info", "world.query.reviewed", {
      taskId: state.taskId,
      evidenceClosed: review.evidenceClosed,
      leaksUnobservedInformation: review.leaksUnobservedInformation,
      requiresWorkflowUpgrade: review.requiresWorkflowUpgrade,
      evidenceCount: readEvidence.length,
    })
    await this.dependencies.commit.retire(state.scopeId, this.dependencies.now())
    await this.dependencies.persistence.updateTask(state.taskId, "completed", "response_review", this.dependencies.now())
    return {
      kind: "query",
      taskId: state.taskId,
      turnId: state.turnId,
      scopeId: state.scopeId,
      contextId: state.contextId,
      answerMarkdown: draft.contentMarkdown,
      evidence: readEvidence.map((evidence) => ({
        readId: evidence.readId,
        ownerKind: evidence.ownerKind,
        ownerId: evidence.ownerId,
        ...(evidence.revisionId === undefined ? {} : { revisionId: evidence.revisionId }),
        ...(evidence.relatedOwnerRefs === undefined ? {} : { relatedOwnerRefs: evidence.relatedOwnerRefs }),
        sourceRefs: evidence.sourceRefs,
      })),
      modelCalls: totalUsage.modelCalls,
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      modelProvider: this.dependencies.model.info?.provider ?? "unknown",
      modelName: this.dependencies.model.info?.model ?? "unknown",
      ...cacheRateResult(totalUsage),
    }
  }

  private async completeEvolution(
    input: TurnOrchestratorInput,
    state: TurnExecutionState,
    artifacts: Partial<Record<AIPhase, unknown>>,
    phaseRuns: ReadonlyMap<AIPhase, string>,
    readEvidence: readonly TurnReadEvidence[],
    totalUsage: PhaseUsage,
  ): Promise<WorldEvolutionExecutionResult> {
    assertEvolutionFrontierContinuity(readEvidence)
    const commitReview = parsePhaseArtifact("commit_review", artifacts.commit_review) as { recommendation: string }
    this.log("debug", "world.evolve.commit_review.advisory", {
      taskId: state.taskId,
      recommendation: commitReview.recommendation,
    })
    const graphAnchorIds = await this.stageGraphAndSettlement(
      input,
      state.taskId,
      state.sourceId,
      state.scopeId,
      phaseRuns.get("graph_governance"),
      artifacts,
      [],
      readEvidence,
      state.createdAtMs,
    )
    await this.dependencies.commit.commit(state.scopeId)
    await this.dependencies.persistence.updateTask(state.taskId, "completed", "commit_review", this.dependencies.now())
    const governance = graphGovernanceArtifactSchema.parse(artifacts.graph_governance)
    this.log("info", "world.evolve.committed", {
      taskId: state.taskId,
      turnId: state.turnId,
      scopeId: state.scopeId,
      graphMutationCount: governance.mutations.length,
      elapsedMs: this.dependencies.now() - state.createdAtMs,
      modelCalls: totalUsage.modelCalls,
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
    })
    return {
      kind: "evolution",
      taskId: state.taskId,
      turnId: state.turnId,
      scopeId: state.scopeId,
      contextId: state.contextId,
      graphAnchorIds,
      graphMutationCount: governance.mutations.length,
      modelCalls: totalUsage.modelCalls,
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      modelProvider: this.dependencies.model.info?.provider ?? "unknown",
      modelName: this.dependencies.model.info?.model ?? "unknown",
      ...cacheRateResult(totalUsage),
    }
  }

  private async executePhase(input: ExecutePhaseInput): Promise<ExecutePhaseResult> {
    throwIfExecutionCancelled(input.signal)
    const prompt = await this.dependencies.prompts.loadPhase(input.phase)
    let currentContext = input.context
    let currentPhaseRunId = input.phaseRunId
    let attempt = input.attempt
    let phaseUsage = emptyPhaseUsage()
    let currentEvidence = [...input.readEvidence]
    let currentVisibleEvidence = [...input.visibleEvidence]
    let currentRetrievalGaps = [...input.retrievalGaps]
    const inheritedRetrievalGapCount = currentRetrievalGaps.length
    const inheritedVisibleEvidence = uniqueTurnReadEvidence(input.visibleEvidence)
    const phaseCitedReadIds = new Set<string>()
    const carryForwardEvidence = (): TurnReadEvidence[] => {
      const selected = selectCarryForwardEvidence(
        input.phase,
        inheritedVisibleEvidence,
        currentVisibleEvidence,
        [...phaseCitedReadIds],
      )
      this.log("debug", "phase.evidence_window.selected", {
        taskId: currentContext.taskId,
        phase: input.phase,
        inheritedEvidenceCount: inheritedVisibleEvidence.length,
        availableEvidenceCount: currentVisibleEvidence.length,
        citedEvidenceCount: phaseCitedReadIds.size,
        selectedEvidenceCount: selected.length,
      })
      return selected
    }

    for (;;) {
      const phaseInput: TurnPhaseInput = {
        workflow: input.input.workflow ?? "turn",
        userInput: input.input.userInput,
        chapterSequence: input.input.chapterSequence,
        allowWorkspaceChapterReads: input.input.allowWorkspaceChapterReads ?? true,
        ...(input.input.presentation === undefined ? {} : { presentation: input.input.presentation }),
        sourceId: input.sourceId,
        sourceUnitIds: input.sourceUnitIds,
        phaseRunIds: input.phaseRunIds,
        readEvidence: currentVisibleEvidence,
        retrievalGaps: currentRetrievalGaps,
        ...(phaseUsesWorkspaceCatalog(input.phase) ? { workspaceCatalog: input.catalogSnapshot } : {}),
        ...(input.input.projectSettings === undefined ? {} : { projectSettings: input.input.projectSettings }),
        artifacts: selectPhaseArtifacts(input.phase, input.artifacts),
      }
      const phaseBudget = remainingBudget(input.budget, {
        modelCalls: input.usage.modelCalls + phaseUsage.modelCalls,
        inputTokens: input.usage.inputTokens + phaseUsage.inputTokens,
        outputTokens: input.usage.outputTokens + phaseUsage.outputTokens,
      })
      const modelRequestTimeoutMs = input.input.projectSettings?.execution.maxModelRequestTimeMs
        ?? defaultProjectSettings.execution.maxModelRequestTimeMs
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
        committedReadIds: currentVisibleEvidence
          .filter((evidence) => evidence.visibility === "committed")
          .map((evidence) => evidence.readId),
        visiblePendingIds: currentVisibleEvidence
          .filter((evidence) => evidence.visibility === "pending")
          .map((evidence) => evidence.readId),
        remainingBudget: {
          ...phaseBudget,
          modelRequestDeadlineAtMs: Math.min(
            phaseBudget.deadlineAtMs,
            this.dependencies.now() + modelRequestTimeoutMs,
          ),
        },
        input: phaseInput,
      }
      const startedAtMs = this.dependencies.now()
      await this.dependencies.persistence.updateTask(
        currentContext.taskId,
        input.phase === "commit_review" ? "committing" : "running",
        input.phase,
        this.dependencies.now(),
      )

      if (input.usage.modelCalls + phaseUsage.modelCalls >= input.budget.maxCalls) {
        throw new TurnBudgetExceededError("model_calls", "Model call budget exhausted before the next phase")
      }

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
        visibleEvidenceCount: currentVisibleEvidence.length,
        retrievalGapCount: currentRetrievalGaps.length,
        priorArtifactCount: Object.keys(input.artifacts).length,
        remainingCalls: request.remainingBudget.remainingCalls,
        remainingInputTokens: request.remainingBudget.remainingInputTokens,
        remainingOutputTokens: request.remainingBudget.remainingOutputTokens,
        deadlineRemainingMs: request.remainingBudget.deadlineAtMs - this.dependencies.now(),
        modelRequestDeadlineRemainingMs: (request.remainingBudget.modelRequestDeadlineAtMs ?? request.remainingBudget.deadlineAtMs) - this.dependencies.now(),
      })

      let execution: PhaseModelExecution
      try {
        execution = await this.dependencies.model.execute(
          request,
          input.signal === undefined ? undefined : { signal: input.signal },
        )
        throwIfExecutionCancelled(input.signal)
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
          status: input.signal?.aborted ? "cancelled" : "failed",
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
        readableReadIds: [...request.committedReadIds, ...request.visiblePendingIds],
        invalidCitedReadIds: parsedResult.citedReadIds.filter((readId) => !(
          request.committedReadIds.includes(readId)
          || request.visiblePendingIds.includes(readId)
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
      assertCitationsAreVisible(request, parsedResult.citedReadIds)
      for (const readId of parsedResult.citedReadIds) phaseCitedReadIds.add(readId)
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
      if (parsedResult.outcome === "blocked"
        || parsedResult.outcome === "revise"
        || parsedResult.outcome === "reject"
        || parsedResult.outcome === "retire") {
        this.log("warn", "phase.model_advisory", {
          taskId: currentContext.taskId,
          phase: input.phase,
          phaseRunId: currentPhaseRunId,
          outcome: parsedResult.outcome,
          reason: parsedResult.reason,
          selfReview: parsedResult.selfReview,
          message: "AI workflow decisions are advisory; structural persistence gates determine whether execution can continue",
        })
      }
      if (parsedResult.requestedReads.length === 0) {
        const artifact = parsePhaseArtifact(input.phase, parsedResult.artifact)
        this.assertDraftCanBePublished(input.phase, artifact, currentContext.taskId, currentPhaseRunId)
        return {
          phaseRunId: currentPhaseRunId,
          context: currentContext,
          readEvidence: currentEvidence,
          visibleEvidence: carryForwardEvidence(),
          retrievalGaps: currentRetrievalGaps.slice(inheritedRetrievalGapCount),
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
          visibleEvidence: carryForwardEvidence(),
          retrievalGaps: currentRetrievalGaps.slice(inheritedRetrievalGapCount),
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
        currentVisibleEvidence,
        input.input.allowWorkspaceChapterReads ?? true,
      )
      currentContext = readResult.context
      currentEvidence = [...currentEvidence, ...readResult.evidence]
      currentVisibleEvidence = [...currentVisibleEvidence, ...readResult.evidence]
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
          visibleEvidence: carryForwardEvidence(),
          retrievalGaps: currentRetrievalGaps.slice(inheritedRetrievalGapCount),
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

  private async readEvolutionFrontierEvidence(
    context: TurnContext,
    input: TurnOrchestratorInput,
  ): Promise<Readonly<{ context: TurnContext; evidence: TurnReadEvidence[] }>> {
    const limit = input.projectSettings?.retrieval.maxCandidates
      ?? defaultProjectSettings.retrieval.maxCandidates
    const frontiers = await this.dependencies.persistence.listSchedulableFrontiers(input.projectId, limit)
    if (frontiers.length === 0) return { context, evidence: [] }
    const anchorIds = [...new Set(frontiers.flatMap((frontier) => [
      frontier.frontierAnchorRef,
      ...frontier.lastSceneAnchorRefs,
      ...frontier.lastTimeAnchorRefs,
      ...frontier.lastLocationAnchorRefs,
      ...frontier.correspondenceRefs,
    ]))]
    const currentProjections = await this.dependencies.retrieval.findCurrentForOwners(
      { projectId: input.projectId },
      anchorIds,
      Math.max(limit, anchorIds.length),
    )
    const projectionsByOwnerId = new Map(currentProjections.map((projection) => [projection.ownerId, projection]))
    const evidence: TurnReadEvidence[] = []
    const returned: Array<Readonly<{
      readId: string
      reason: string
      segment: TurnContext["segments"][number]
    }>> = []

    for (const frontier of frontiers) {
      const relatedOwnerRefs = [...new Set([
        frontier.frontierAnchorRef,
        ...frontier.lastSceneAnchorRefs,
        ...frontier.lastTimeAnchorRefs,
        ...frontier.lastLocationAnchorRefs,
        ...frontier.correspondenceRefs,
      ])].flatMap((ownerId) => {
        const projection = projectionsByOwnerId.get(ownerId)
        return projection === undefined ? [] : [{
          ownerKind: projection.ownerKind,
          ownerId: projection.ownerId,
          revisionId: projection.ownerRevisionId,
          exactKeys: projection.exactKeys,
          semanticText: projection.semanticText,
        }]
      })
      const semanticText = JSON.stringify({
        disposition: frontier.disposition,
        reason: frontier.reason,
        revisitCondition: frontier.revisitCondition ?? null,
        lastSceneAnchorCount: frontier.lastSceneAnchorRefs.length,
        lastTimeAnchorCount: frontier.lastTimeAnchorRefs.length,
        lastLocationAnchorCount: frontier.lastLocationAnchorRefs.length,
        correspondenceCount: frontier.correspondenceRefs.length,
      })
      const readId = this.dependencies.createId()
      const storedEvidence = await this.dependencies.evidence.writeImmutable({
        evidenceId: readId,
        projectId: input.projectId,
        contextId: context.contextId,
        sourceKind: "graph",
        ownerId: frontier.frontierAnchorRef,
        version: String(frontier.lastProcessedAt),
        digest: digest(semanticText),
        locator: frontier.id,
        content: semanticText,
        readReason: "Load a bounded committed world-evolution frontier before autonomous evolution",
        createdAtMs: this.dependencies.now(),
      })
      const tokenEstimate = estimateRetrievalEvidenceTokens({
        ownerKind: "frontier",
        ownerId: frontier.frontierAnchorRef,
        exactKeys: [],
        semanticText,
        relatedOwnerRefs,
      })
      returned.push({
        readId,
        reason: storedEvidence.readReason,
        segment: {
          segmentId: this.dependencies.createId(),
          kind: "committed_read",
          ownerIds: [readId],
          visibility: "committed",
          canonicalDigest: storedEvidence.digest,
          tokenEstimate,
          sequence: context.segments.length + returned.length,
        },
      })
      evidence.push({
        readId,
        visibility: "committed",
        ownerKind: "frontier",
        ownerId: frontier.frontierAnchorRef,
        exactKeys: [],
        semanticText,
        sourceRefs: [{
          frontierRecordId: frontier.id,
          frontierAnchorRef: frontier.frontierAnchorRef,
          lastSceneAnchorRefs: frontier.lastSceneAnchorRefs,
          lastTimeAnchorRefs: frontier.lastTimeAnchorRefs,
          lastLocationAnchorRefs: frontier.lastLocationAnchorRefs,
          correspondenceRefs: frontier.correspondenceRefs,
        }],
        relatedOwnerRefs,
        digest: storedEvidence.digest,
      })
    }

    for (const projection of currentProjections) {
      const storedEvidence = await this.dependencies.evidence.writeImmutable({
        evidenceId: this.dependencies.createId(),
        projectId: input.projectId,
        contextId: context.contextId,
        sourceKind: "graph",
        ownerId: projection.ownerId,
        version: projection.ownerRevisionId,
        digest: digest(projection.semanticText),
        locator: projection.projectionId,
        content: projection.semanticText,
        readReason: "Resolve current graph anchors for a scheduled world-evolution frontier",
        createdAtMs: this.dependencies.now(),
      })
      const tokenEstimate = estimateRetrievalEvidenceTokens(projection)
      returned.push({
        readId: storedEvidence.evidenceId,
        reason: storedEvidence.readReason,
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
      evidence.push({
        readId: storedEvidence.evidenceId,
        visibility: "committed",
        ownerKind: projection.ownerKind,
        ownerId: projection.ownerId,
        revisionId: projection.ownerRevisionId,
        exactKeys: projection.exactKeys,
        semanticText: projection.semanticText,
        sourceRefs: projection.sourceRefs,
        digest: projection.digest,
        stateRole: "current",
      })
    }
    this.log("debug", "world.evolve.frontiers.loaded", {
      taskId: context.taskId,
      frontierCount: frontiers.length,
      anchorCount: anchorIds.length,
      resolvedAnchorCount: currentProjections.length,
    })
    return {
      context: recordContextRead(context, {
        requestId: this.dependencies.createId(),
        returned,
        rejectedReadIds: [],
      }),
      evidence,
    }
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
    budgetEvidence: readonly TurnReadEvidence[],
    allowWorkspaceChapterReads: boolean,
  ): Promise<{ context: TurnContext; evidence: readonly TurnReadEvidence[] }> {
    const returned = [] as Array<{ readId: string; reason: string; segment: TurnContext["segments"][number] }>
    const evidence: TurnReadEvidence[] = []
    const seenReadIds = new Set<string>()
    const seenEvidenceKeys = new Set(existingEvidence.map((item) => `${item.ownerId}:${item.digest}`))
    const selectedRequests = requests.slice(0, settings?.maxRequestsPerRound ?? requests.length)
    const evidenceTokenLimit = settings?.maxEvidenceTokens ?? Number.POSITIVE_INFINITY
    let evidenceTokens = budgetEvidence
      .filter(countsAgainstRetrievalEvidenceBudget)
      .reduce((total, item) => total + estimateRetrievalEvidenceTokens(item), 0)
    let evidenceBudgetTruncated = false
    let includedRelatedOwnerRefs = 0
    let omittedRelatedOwnerRefs = 0
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
      const workspaceEntries = selectWorkspaceEntries(
        catalogSnapshot,
        request,
        maxCandidates,
        allowWorkspaceChapterReads,
      )
      for (const entry of workspaceEntries) {
        const evidenceKey = `${entry.relativePath}:${entry.digest}`
        if (seenEvidenceKeys.has(evidenceKey)) continue
        const content = await this.dependencies.workspace.readMarkdown(workspaceRootRef, entry.relativePath)
        const workspaceEvidence = workspaceTurnEvidence("budget-preview", entry, content)
        const tokenEstimate = estimateRetrievalEvidenceTokens(workspaceEvidence)
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
      const searchesGraphOwners = request.query.sourceKinds.some((kind) => (
        kind === "graph" || kind === "revision"
      ))
      const anchored = searchesGraph ? await this.dependencies.retrieval.findCurrentForOwners(
        { projectId, pendingScopeId: scopeId }, request.query.anchorIds, maxCandidates,
      ) : []
      const exact = searchesGraph ? await this.dependencies.retrieval.searchExact(
        { projectId, pendingScopeId: scopeId }, request.query.exactKeys, maxCandidates,
      ) : []
      const semantic = searchesGraphOwners ? await Promise.all(request.query.semanticTexts.map((text) => this.dependencies.retrieval.searchText(
        { projectId, pendingScopeId: scopeId }, text, maxCandidates,
      ))) : []
      const sourceIds = [...new Set([...anchored, ...exact]
        .filter((projection) => projection.ownerKind === "source")
        .flatMap((projection) => sourceIdsFromRefs(projection.sourceRefs)))]
      const sourceSemantic = searchesGraph && request.query.sourceKinds.includes("source")
        ? await Promise.all(request.query.semanticTexts.map((text) => this.dependencies.retrieval.searchSourceText(
          { projectId, pendingScopeId: scopeId },
          text,
          maxCandidates,
          sourceIds.length === 0 ? undefined : sourceIds,
        )))
        : []
      const sourceOnly = request.query.sourceKinds.every((kind) => kind === "source")
      const primarySourceMatch = sourceSemantic.find((matches) => matches.length > 0)?.[0]
      const sourceNeighborhoodRadius = Math.max(0, Math.floor((maxCandidates - 1) / 2))
      const sourceNeighborhood = !sourceOnly || primarySourceMatch === undefined
        ? []
        : await this.dependencies.retrieval.expandSourceNeighborhood(
          { projectId, pendingScopeId: scopeId },
          sourceSequenceAnchorsFromRefs(primarySourceMatch.sourceRefs),
          sourceNeighborhoodRadius,
          maxCandidates,
        )
      const orderedCandidates = sourceOnly
        ? [...sourceNeighborhood, ...exact, ...anchored, ...sourceSemantic.flat()]
        : [...anchored, ...exact, ...sourceNeighborhood, ...sourceSemantic.flat(), ...semantic.flat()]
      const projections = uniqueRetrievalProjections(
        orderedCandidates.filter((projection) => (
          projectionMatchesRequestedSourceKinds(projection, request.query.sourceKinds)
        )),
        maxCandidates,
      )
      const sourceUnitIds = [...new Set(projections
        .filter((projection) => projection.ownerKind === "source")
        .flatMap((projection) => sourceUnitIdsFromRefs(projection.sourceRefs)))]
      const settlements = await this.dependencies.persistence.listSettlementsForSourceUnits(projectId, sourceUnitIds)
      const sourceProjectionCount = projections.filter((projection) => projection.ownerKind === "source").length
      const maxRelatedOwnersPerSourceUnit = sourceProjectionCount === 0
        ? 0
        : Math.max(1, Math.ceil(maxCandidates / sourceProjectionCount))
      const relatedOwnersBySourceUnitId = await enrichRelatedOwners(
        this.dependencies.retrieval,
        projectId,
        indexRelatedOwnersBySourceUnitId(settlements),
        maxRelatedOwnersPerSourceUnit,
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
        sourceSemanticMatches: sourceSemantic.flat().length,
        sourceNeighborhoodMatches: sourceNeighborhood.length,
        sourceNeighborhoodRadius,
        workspaceMatches: workspaceEntries.length,
        selectedCandidates: projections.length,
        requestedSourceKinds: request.query.sourceKinds,
      })
      for (const projection of projections) {
        if (projection.visibility === "retired") continue
        if (seenReadIds.has(projection.projectionId)) continue
        const evidenceKey = `${projection.ownerId}:${projection.digest}`
        if (seenEvidenceKeys.has(evidenceKey)) continue
        const availableRelatedOwnerRefs = projection.ownerKind === "source"
          ? relatedOwnersForProjection(projection.sourceRefs, relatedOwnersBySourceUnitId)
          : []
        const evidenceBudgetView = {
          ownerKind: projection.ownerKind,
          ownerId: projection.ownerId,
          exactKeys: projection.exactKeys,
          semanticText: projection.semanticText,
        }
        let selectedRelatedOwnerRefs: RelatedOwnerRef[] = []
        let tokenEstimate = estimateRetrievalEvidenceTokens(evidenceBudgetView)
        for (const relatedOwnerRef of availableRelatedOwnerRefs) {
          const nextRelatedOwnerRefs = [...selectedRelatedOwnerRefs, relatedOwnerRef]
          const nextEstimate = estimateRetrievalEvidenceTokens({
            ...evidenceBudgetView,
            relatedOwnerRefs: nextRelatedOwnerRefs,
          })
          if (evidenceTokens + nextEstimate > evidenceTokenLimit) {
            omittedRelatedOwnerRefs += 1
            evidenceBudgetTruncated = true
            continue
          }
          selectedRelatedOwnerRefs = nextRelatedOwnerRefs
          tokenEstimate = nextEstimate
          includedRelatedOwnerRefs += 1
        }
        if (evidenceTokens + tokenEstimate > evidenceTokenLimit) {
          evidenceBudgetTruncated = true
          continue
        }
        seenReadIds.add(projection.projectionId)
        seenEvidenceKeys.add(evidenceKey)
        evidenceTokens += tokenEstimate
        const storedEvidence = await this.dependencies.evidence.writeImmutable({
          evidenceId: this.dependencies.createId(),
          projectId,
          contextId: context.contextId,
          sourceKind: evidenceSourceKindForProjection(projection),
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
          ...(selectedRelatedOwnerRefs.length === 0 ? {} : { relatedOwnerRefs: selectedRelatedOwnerRefs }),
          digest: projection.digest,
          ...(projection.stateRole === undefined ? {} : { stateRole: projection.stateRole }),
        })
      }
    }
    if (omittedRelatedOwnerRefs > 0) {
      this.log("debug", "retrieval.related_owner_budget.truncated", {
        taskId: context.taskId,
        includedRelatedOwnerRefs,
        omittedRelatedOwnerRefs,
        evidenceTokens,
        maxEvidenceTokens: evidenceTokenLimit,
      })
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
    scopeId: string,
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
    for (const [index, unit] of sourceUnits.entries()) {
      const contentMarkdown = units[index]
      if (contentMarkdown === undefined) throw new Error(`Missing staged source unit content: ${String(index)}`)
      await this.dependencies.retrieval.stageProjection({
        projectionId: this.dependencies.createId(),
        projectId: input.projectId,
        scopeId,
        ownerKind: "source",
        ownerId: unit.id,
        ownerRevisionId: unit.id,
        exactKeys: buildSourceUnitExactKeys(contentMarkdown),
        semanticText: contentMarkdown,
        sourceRefs: [{ sourceId, sourceUnitId: unit.id, sequence: unit.sequence }],
        digest: unit.digest,
      })
    }
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
    const sourceRefs = [{
      sourceId,
      taskId,
      taskKind: input.workflow ?? "turn",
    }]
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
      const revision = await this.materializeMutation(
        input.projectId,
        scopeId,
        mutation,
        governance,
        index,
        readEvidence.map((evidence) => evidence.readId),
        createdAtMs,
      )
      revisions.push(revision)
      revisionByMutation.set(index, revision.revisionId)
    }
    await this.dependencies.graph.stageRevisions(input.projectId, scopeId, revisions)
    await this.stageInheritedMutationProjections(
      input.projectId,
      scopeId,
      mutations,
      governance.retrievalProjections,
      revisionByMutation,
      sourceRefs,
    )
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
          const predecessorRevisionIds = settlement.predecessorRevisionReadRefs.flatMap((readId) => {
            const revisionId = resolveReadRevisionId(readId, readEvidence)
            if (revisionId !== undefined) return [revisionId]
            this.log("warn", "turn.predecessor_revision_reference.advisory", {
              taskId,
              readId,
              message: "Ignored a non-revision read evidence reference; the graph revision chain remains authoritative",
            })
            return []
          })
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
            predecessorRevisionRequired: settlement.predecessorRevisionRequired && predecessorRevisionIds.length > 0,
            predecessorRevisionIds,
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

  private async stageInheritedMutationProjections(
    projectId: string,
    scopeId: string,
    mutations: readonly GraphMutation[],
    projections: GraphGovernanceArtifact["retrievalProjections"],
    revisionByMutation: ReadonlyMap<number, string>,
    sourceRefs: readonly { sourceId: string }[],
  ): Promise<void> {
    for (const [mutationIndex, mutation] of mutations.entries()) {
      if (mutation.operation !== "edit_node" && mutation.operation !== "edit_link") continue
      const ownerId = mutation.operation === "edit_node" ? mutation.nodeId : mutation.linkId
      if (projections.some((projection) => (
        projection.ownerMutationIndex === mutationIndex
        || projection.ownerRef === ownerId
      ))) continue

      const ownerKind = mutation.operation === "edit_node" ? "node" as const : "link" as const
      const revisionId = revisionByMutation.get(mutationIndex)
      if (revisionId === undefined) throw new Error(`Missing revision for mutation ${String(mutationIndex)}`)

      const revisions = await this.dependencies.graph.listRevisions(projectId, ownerKind, ownerId)
      let inherited: Awaited<ReturnType<RetrievalRepository["findForOwnerRevision"]>>
      for (const previousRevision of revisions
        .filter((revision) => revision.revisionId !== revisionId)
        .reverse()) {
        inherited = await this.dependencies.retrieval.findForOwnerRevision(
          projectId,
          ownerKind,
          ownerId,
          previousRevision.revisionId,
        )
        if (inherited !== undefined) break
      }
      if (inherited === undefined) continue

      const currentValue = mutation.operation === "edit_node"
        ? await this.dependencies.graph.getNode({ projectId, pendingScopeId: scopeId }, ownerId)
        : await this.dependencies.graph.getLink({ projectId, pendingScopeId: scopeId }, ownerId)
      if (currentValue === undefined) throw new Error(`Missing staged graph owner for mutation ${ownerId}`)

      await this.dependencies.retrieval.stageProjection({
        projectionId: this.dependencies.createId(),
        projectId,
        scopeId,
        ownerKind,
        ownerId,
        ownerRevisionId: revisionId,
        exactKeys: inherited.exactKeys,
        semanticText: describeInheritedGraphValue(currentValue, inherited.semanticText),
        sourceRefs: [...inherited.sourceRefs, ...sourceRefs],
        digest: digest({ ownerKind, ownerId, revisionId, inherited: inherited.projectionId, currentValue }),
      })
      this.log("debug", "graph.retrieval_projection.inherited", {
        projectId,
        scopeId,
        ownerKind,
        ownerId,
        revisionId,
        inheritedProjectionId: inherited.projectionId,
      })
    }
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
  attempt: number
  phaseRunIds: string[]
  context: TurnContext
  artifacts: Partial<Record<AIPhase, unknown>>
  readEvidence: readonly TurnReadEvidence[]
  visibleEvidence: readonly TurnReadEvidence[]
  retrievalGaps: readonly TurnRetrievalGap[]
  catalogSnapshot: WorkspaceCatalogSnapshot
  budget: ModelCallBudget
  usage: { modelCalls: number; inputTokens: number; outputTokens: number; cacheHits: number; cacheMisses: number }
  signal?: AbortSignal
}>

type TurnExecutionState = {
  taskId: string
  turnId: string
  scopeId: string
  contextId: string
  sourceId: string
  createdAtMs: number
  baseRuleVersion: string
  catalogSnapshot: WorkspaceCatalogSnapshot
  context: TurnContext
  artifacts: Partial<Record<AIPhase, unknown>>
  phaseRunIds: string[]
  phaseRuns: Map<AIPhase, string>
  phaseAttempts: Map<AIPhase, number>
  sourceUnitIds: string[]
  readEvidence: TurnReadEvidence[]
  visibleEvidence: TurnReadEvidence[]
  retrievalGaps: TurnRetrievalGap[]
  totalUsage: PhaseUsage
  budget: ModelCallBudget
  startPhaseIndex: number
  signal?: AbortSignal
}

function throwIfExecutionCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw executionCancellationReason(signal)
}

function executionCancellationReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  const error = new Error(
    typeof reason === "string" && reason.length > 0 ? reason : "Turn execution cancelled",
  )
  error.name = "AbortError"
  return error
}

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
  allowWorkspaceChapterReads: boolean,
): WorkspaceCatalogEntry[] {
  const roles = new Set<WorkspaceCatalogEntry["role"]>()
  if (request.query.sourceKinds.includes("rule")) roles.add("world_rules")
  if (request.query.sourceKinds.includes("reference")) {
    roles.add("settings")
    roles.add("references")
  }
  if (allowWorkspaceChapterReads && request.query.sourceKinds.includes("source")) roles.add("chapters")
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

function describeInheritedGraphValue(value: { content?: unknown }, fallback: string): string {
  const content = value.content
  if (typeof content === "string" && content.trim().length > 0) return content
  if (typeof content === "object" && content !== null) {
    const record = content as Record<string, unknown>
    const preferred = ["semanticText", "text", "summary", "name", "description"]
      .flatMap((key) => typeof record[key] === "string" ? [record[key] as string] : [])
    if (preferred.length > 0) return preferred.join("；")
  }
  return fallback
}

function resolveReadRevisionId(readId: string, readEvidence: readonly TurnReadEvidence[]): string | undefined {
  const evidence = readEvidence.find((item) => item.readId === readId)
  return evidence?.revisionId
}

type ExecutePhaseResult = Readonly<{
  phaseRunId: string
  context: TurnContext
  readEvidence: readonly TurnReadEvidence[]
  visibleEvidence: readonly TurnReadEvidence[]
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

function cacheRateResult(usage: PhaseUsage): Readonly<{ kvCacheHitRate?: number }> {
  const totalCacheTokens = usage.cacheHits + usage.cacheMisses
  return totalCacheTokens === 0 ? {} : { kvCacheHitRate: usage.cacheHits / totalCacheTokens }
}

function assertEvolutionFrontierContinuity(readEvidence: readonly TurnReadEvidence[]): void {
  const frontiers = readEvidence.filter((evidence) => evidence.ownerKind === "frontier")
  if (frontiers.length === 0) return
  const currentGraphOwners = new Set(readEvidence
    .filter((evidence) => (evidence.ownerKind === "node" || evidence.ownerKind === "link")
      && evidence.stateRole === "current")
    .map((evidence) => `${evidence.ownerKind}:${evidence.ownerId}`))
  const hasResolvedFrontier = frontiers.some((frontier) => frontier.relatedOwnerRefs?.some((owner) => (
    currentGraphOwners.has(`${owner.ownerKind}:${owner.ownerId}`)
  )) === true)
  if (!hasResolvedFrontier) {
    throw new Error("committed frontier has no resolvable current graph anchor")
  }
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

function phaseUsageFromStored(value: unknown): PhaseUsage {
  if (typeof value !== "object" || value === null) return emptyPhaseUsage()
  const record = value as Record<string, unknown>
  const number = (key: string): number => typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] as number : 0
  return {
    modelCalls: number("modelCalls") || (number("inputTokens") > 0 || number("outputTokens") > 0 ? 1 : 0),
    inputTokens: number("inputTokens"),
    outputTokens: number("outputTokens"),
    cacheHits: number("cacheHitInputTokens"),
    cacheMisses: number("cacheMissInputTokens"),
  }
}

function readStoredTurnPhaseInput(value: unknown): TurnPhaseInput {
  if (typeof value !== "object" || value === null) throw new Error("The task checkpoint has invalid phase input")
  const record = value as Record<string, unknown>
  if (typeof record.userInput !== "string" || typeof record.chapterSequence !== "number") {
    throw new Error("The task checkpoint is missing turn input")
  }
  if (!Array.isArray(record.sourceUnitIds)
    || !Array.isArray(record.readEvidence)
    || !Array.isArray(record.retrievalGaps)
    || typeof record.artifacts !== "object"
    || record.artifacts === null) {
    throw new Error("The task checkpoint is missing dynamic turn state")
  }
  return record as unknown as TurnPhaseInput
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
    modelRequestDeadlineAtMs: nowMs + (
      input.projectSettings?.execution.maxModelRequestTimeMs
      ?? defaultProjectSettings.execution.maxModelRequestTimeMs
    ),
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
  if (usage.modelCalls > budget.maxCalls) throw new TurnBudgetExceededError("model_calls", "Model call budget exceeded")
  if (usage.inputTokens > budget.maxInputTokens) throw new TurnBudgetExceededError("input_tokens", "Model input token budget exceeded")
  if (usage.outputTokens > budget.maxOutputTokens) throw new TurnBudgetExceededError("output_tokens", "Model output token budget exceeded")
  if (nowMs > budget.deadlineAtMs) throw new TurnBudgetExceededError("wall_time", "Turn deadline exceeded")
}

function normalizeDeadlineInterruption(
  error: unknown,
  budget: ModelCallBudget,
  nowMs: number,
): unknown {
  if (error instanceof TurnBudgetExceededError || nowMs <= budget.deadlineAtMs) return error
  return new TurnBudgetExceededError("wall_time", "Turn deadline exceeded while the model request was in flight")
}

function createInterruptionRecord(
  error: unknown,
  phase: AIPhase | undefined,
  phaseRunId: string | undefined,
  interruptedAtMs: number,
): Readonly<Record<string, unknown>> {
  const message = error instanceof Error ? error.message : String(error)
  const blockedMetrics = error instanceof TurnBudgetExceededError ? [error.metric] : []
  return {
    kind: blockedMetrics.length === 0 ? "execution_error" : "limit_exhausted",
    message,
    recoverable: true,
    blockedMetrics,
    ...(phase === undefined ? {} : { phase }),
    ...(phaseRunId === undefined ? {} : { phaseRunId }),
    interruptedAtMs,
  }
}

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil((typeof value === "string" ? value : JSON.stringify(value)).length / 4))
}

function estimateRetrievalEvidenceTokens(evidence: Readonly<{
  ownerKind: string
  ownerId: string
  exactKeys: readonly string[]
  semanticText: string
  relatedOwnerRefs?: readonly RelatedOwnerRef[]
}>): number {
  return estimateTokens({
    ownerKind: evidence.ownerKind,
    ownerId: evidence.ownerId,
    exactKeys: evidence.exactKeys,
    semanticText: evidence.semanticText,
    ...(evidence.relatedOwnerRefs === undefined ? {} : {
      relatedOwnerRefs: evidence.relatedOwnerRefs.map((relatedOwner) => ({
        ownerKind: relatedOwner.ownerKind,
        ownerId: relatedOwner.ownerId,
        ...(relatedOwner.exactKeys === undefined ? {} : { exactKeys: relatedOwner.exactKeys }),
        ...(relatedOwner.semanticText === undefined ? {} : { semanticText: relatedOwner.semanticText }),
      })),
    }),
  })
}

function sourceUnitIdsFromRefs(sourceRefs: readonly unknown[]): string[] {
  return [...new Set(sourceRefs.flatMap((sourceRef) => {
    if (!isRecord(sourceRef) || typeof sourceRef.sourceUnitId !== "string") return []
    return [sourceRef.sourceUnitId]
  }))]
}

function sourceIdsFromRefs(sourceRefs: readonly unknown[]): string[] {
  return [...new Set(sourceRefs.flatMap((sourceRef) => {
    if (!isRecord(sourceRef) || typeof sourceRef.sourceId !== "string") return []
    return [sourceRef.sourceId]
  }))]
}

function sourceSequenceAnchorsFromRefs(sourceRefs: readonly unknown[]): Array<{
  sourceId: string
  sequence: number
}> {
  return [...new Map(sourceRefs.flatMap((sourceRef) => {
    if (!isRecord(sourceRef)
      || typeof sourceRef.sourceId !== "string"
      || typeof sourceRef.sequence !== "number"
      || !Number.isSafeInteger(sourceRef.sequence)
      || sourceRef.sequence < 0) return []
    return [[`${sourceRef.sourceId}:${String(sourceRef.sequence)}`, {
      sourceId: sourceRef.sourceId,
      sequence: sourceRef.sequence,
    }] as const]
  })).values()]
}

function indexRelatedOwnersBySourceUnitId(
  settlements: readonly SettlementRecord[],
): ReadonlyMap<string, readonly { ownerKind: string; ownerId: string; revisionId?: string }[]> {
  const indexed = new Map<string, Array<{ ownerKind: string; ownerId: string; revisionId?: string }>>()
  for (const settlement of settlements) {
    const owners = indexed.get(settlement.sourceUnitId) ?? []
    if (Array.isArray(settlement.graphRefs)) {
      for (const graphRef of settlement.graphRefs) {
        if (!isRecord(graphRef)) continue
        const ownerKind = typeof graphRef.targetKind === "string"
          ? graphRef.targetKind
          : typeof graphRef.ownerKind === "string" ? graphRef.ownerKind : undefined
        const ownerId = typeof graphRef.targetId === "string"
          ? graphRef.targetId
          : typeof graphRef.ownerId === "string" ? graphRef.ownerId : undefined
        if (ownerKind === undefined || ownerId === undefined) continue
        owners.push({
          ownerKind,
          ownerId,
          ...(typeof graphRef.revisionId === "string" ? { revisionId: graphRef.revisionId } : {}),
        })
      }
    }
    indexed.set(settlement.sourceUnitId, owners)
  }
  return new Map(Array.from(indexed.entries()).map(([sourceUnitId, owners]) => [
    sourceUnitId,
    deduplicateRelatedOwners(owners),
  ]))
}

function relatedOwnersForProjection(
  sourceRefs: readonly unknown[],
  relatedOwnersBySourceUnitId: ReadonlyMap<string, readonly {
    ownerKind: string
    ownerId: string
    revisionId?: string
    exactKeys?: readonly string[]
    semanticText?: string
  }[]>,
): readonly {
  ownerKind: string
  ownerId: string
  revisionId?: string
  exactKeys?: readonly string[]
  semanticText?: string
}[] {
  return deduplicateRelatedOwners(sourceUnitIdsFromRefs(sourceRefs).flatMap((sourceUnitId) => (
    relatedOwnersBySourceUnitId.get(sourceUnitId) ?? []
  )))
}

async function enrichRelatedOwners(
  retrieval: RetrievalRepository,
  projectId: ProjectId,
  relatedOwnersBySourceUnitId: ReadonlyMap<string, readonly {
    ownerKind: string
    ownerId: string
    revisionId?: string
  }[]>,
  maxOwnersPerSourceUnit: number,
): Promise<ReadonlyMap<string, readonly {
  ownerKind: string
  ownerId: string
  revisionId?: string
  exactKeys?: readonly string[]
  semanticText?: string
}[]>> {
  const enriched = new Map<string, readonly {
    ownerKind: string
    ownerId: string
    revisionId?: string
    exactKeys?: readonly string[]
    semanticText?: string
  }[]>()
  for (const [sourceUnitId, owners] of relatedOwnersBySourceUnitId) {
    const selectedOwners = owners.slice(0, maxOwnersPerSourceUnit)
    const withProjections = await Promise.all(selectedOwners.map(async (owner) => {
      if ((owner.ownerKind !== "node" && owner.ownerKind !== "link") || owner.revisionId === undefined) return owner
      const projection = await retrieval.findForOwnerRevision(
        projectId,
        owner.ownerKind,
        owner.ownerId,
        owner.revisionId,
      )
      return projection === undefined
        ? owner
        : {
            ...owner,
            exactKeys: projection.exactKeys,
            semanticText: projection.semanticText,
          }
    }))
    enriched.set(sourceUnitId, withProjections)
  }
  return enriched
}

function deduplicateRelatedOwners(
  owners: readonly {
    ownerKind: string
    ownerId: string
    revisionId?: string
    exactKeys?: readonly string[]
    semanticText?: string
  }[],
): readonly {
  ownerKind: string
  ownerId: string
  revisionId?: string
  exactKeys?: readonly string[]
  semanticText?: string
}[] {
  return Array.from(new Map(owners.map((owner) => [
    `${owner.ownerKind}:${owner.ownerId}:${owner.revisionId ?? ""}`,
    owner,
  ])).values())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function countsAgainstRetrievalEvidenceBudget(evidence: TurnReadEvidence): boolean {
  return !isProtectedContextEvidence(evidence)
}

function isProtectedContextEvidence(evidence: TurnReadEvidence): boolean {
  return evidence.ownerKind === "workspace:world_rules"
    || evidence.ownerKind === "workspace:presentation"
    || evidence.ownerId === "设定集/readme.md"
    || evidence.ownerId === "参考文件/readme.md"
}

function selectCarryForwardEvidence(
  phase: AIPhase,
  inheritedEvidence: readonly TurnReadEvidence[],
  evidence: readonly TurnReadEvidence[],
  citedReadIds: readonly string[],
): TurnReadEvidence[] {
  const selectedReadIds = new Set(citedReadIds)
  if (phase !== "interpret") {
    for (const item of inheritedEvidence) selectedReadIds.add(item.readId)
  }
  return uniqueTurnReadEvidence(evidence.filter((item) => (
    isProtectedContextEvidence(item) || selectedReadIds.has(item.readId)
  )))
}

function uniqueTurnReadEvidence(evidence: readonly TurnReadEvidence[]): TurnReadEvidence[] {
  return [...new Map(evidence.map((item) => [item.readId, item])).values()]
}

function selectPhaseArtifacts(
  phase: AIPhase,
  artifacts: Partial<Record<AIPhase, unknown>>,
): Partial<Record<AIPhase, unknown>> {
  return Object.fromEntries(phaseArtifactDependencies[phase].flatMap((dependency) => (
    artifacts[dependency] === undefined ? [] : [[dependency, artifacts[dependency]]]
  )))
}

function phaseUsesWorkspaceCatalog(phase: AIPhase): boolean {
  return workspaceCatalogPhases.has(phase)
}

function assertCitationsAreVisible(
  request: PhaseRequestEnvelope,
  citedReadIds: readonly string[],
): void {
  const visibleReadIds = new Set([...request.committedReadIds, ...request.visiblePendingIds])
  const invisibleReadIds = citedReadIds.filter((readId) => !visibleReadIds.has(readId))
  if (invisibleReadIds.length > 0) {
    throw new Error(`citedReadIds contains evidence outside the current model view: ${invisibleReadIds.join(", ")}`)
  }
}

function projectionMatchesRequestedSourceKinds(
  projection: { ownerKind: string },
  sourceKinds: readonly string[],
): boolean {
  if (projection.ownerKind === "source") return sourceKinds.includes("source")
  if (projection.ownerKind === "node" || projection.ownerKind === "link") {
    return sourceKinds.includes("graph") || sourceKinds.includes("revision")
  }
  return false
}

function evidenceSourceKindForProjection(
  projection: { ownerKind: string },
): "chapter" | "graph" | "revision" {
  if (projection.ownerKind === "source") return "chapter"
  if (projection.ownerKind === "revision") return "revision"
  return "graph"
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
