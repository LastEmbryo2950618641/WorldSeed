import OpenAI from "openai"
import { createHash } from "node:crypto"
import { ProxyAgent } from "undici"

import {
  PROTOCOL_VERSION,
  type ModelContextMessageDraft,
  type PhaseRequestEnvelope,
} from "@worldseed/contracts"
import type { DeepSeekRuntimeConfig } from "@worldseed/config"

import type {
  AIModelPort,
  ModelExecutionOptions,
  PhaseModelExecution,
  PromptResourcePort,
} from "../../../application/index.js"
import { ModelContextAppender } from "../../../application/index.js"
import {
  assembleModelPhaseResult,
  phaseModelResultJsonSchema,
  parseModelPhaseResult,
} from "./model-phase-result-assembler.js"
import { createModelReferenceView, type ModelReferenceView } from "./model-reference-view.js"
import { errorDetails, runtimeLog } from "../../diagnostics/index.js"

export type SecretProvider = Readonly<{
  getSecret(reference: string): Promise<string>
}>

export type DeepSeekCompletionClient = Readonly<{
  complete(input: DeepSeekCompletionInput): Promise<DeepSeekCompletionResponse>
}>

export type DeepSeekCompletionInput = Readonly<{
  model: string
  messages: readonly DeepSeekMessage[]
  responseFormat?: { type: "json_object" }
  maxTokens?: number
  signal?: AbortSignal
  thinking?: { type: "enabled" | "disabled" }
  reasoningEffort?: "low" | "high" | "max"
}>

export type DeepSeekMessage = Readonly<{
  role: "system" | "user" | "assistant"
  content: string
}>

type PromptSnapshot = Readonly<{
  phase: string
  serialized: string
  messageDigests: readonly string[]
}>

export type DeepSeekCompletionResponse = Readonly<{
  content: string | null
  reasoningContent?: string | null
  finishReason?: string | null
  responseId?: string
  messageFieldNames?: readonly string[]
  usage?: unknown
}>

export class DeepSeekModelError extends Error {
  public constructor(
    public readonly kind: "configuration" | "network" | "response" | "schema",
    message: string,
    public readonly rawResponse?: string,
  ) {
    super(message)
  }
}

export class DeepSeekAiModelAdapter implements AIModelPort {
  private readonly clientPromise: Promise<DeepSeekCompletionClient>
  private readonly previousPromptByChain = new Map<string, PromptSnapshot>()
  private readonly contextAppender = new ModelContextAppender()
  public readonly info

  public constructor(
    private readonly config: DeepSeekRuntimeConfig,
    private readonly secrets: SecretProvider,
    private readonly prompts: PromptResourcePort,
    client?: DeepSeekCompletionClient,
  ) {
    this.info = {
      provider: config.provider,
      model: config.model,
      available: true,
      contextWindowTokens: config.contextWindowTokens,
    } as const
    this.clientPromise = client === undefined ? this.createClient() : Promise.resolve(client)
  }

  public async execute(request: PhaseRequestEnvelope, options?: ModelExecutionOptions): Promise<PhaseModelExecution> {
    const referenceView = createModelReferenceView(request)
    runtimeLog("debug", "deepseek-model", "execution.started", {
      taskId: request.taskId,
      phase: request.phase,
      envelopeId: request.envelopeId,
      model: this.config.model,
      baseUrl: this.config.baseUrl,
      modelReferenceAliasCount: referenceView.aliasCount,
      deadlineRemainingMs: request.remainingBudget.deadlineAtMs - Date.now(),
    })
    const [baseRules, phasePrompt, client] = await Promise.all([
      options?.contextMessages === undefined ? this.prompts.loadBaseRules() : Promise.resolve(undefined),
      options?.phasePrompt === undefined
        ? this.prompts.loadPhase(request.phase)
        : Promise.resolve(options.phasePrompt),
      this.clientPromise,
    ])
    const protocolMessage = [
      `Worldseed protocol ${PROTOCOL_VERSION}.`,
      `Current phase: ${request.phase}.`,
      "Return exactly one JSON object and no Markdown fences or commentary.",
      "The final user message contains the complete mandatory output contract.",
    ].join("\n")
    const modelRequest = this.contextAppender.createDelta(
      request,
      referenceView.request,
      options?.contextMessages ?? [],
    )
    const modelRequestText = this.contextAppender.formatDelta(modelRequest)
    const outputReminder = buildOutputReminder(request, referenceView)
    const requestMessages: ModelContextMessageDraft[] = [
      {
        role: "user",
        kind: "phase_request",
        taskId: request.taskId,
        turnId: request.turnId,
        phase: request.phase,
        content: modelRequestText,
      },
      {
        role: "user",
        kind: "phase_instruction",
        taskId: request.taskId,
        turnId: request.turnId,
        phase: request.phase,
        content: phasePrompt.text,
      },
      {
        role: "user",
        kind: "phase_protocol",
        taskId: request.taskId,
        turnId: request.turnId,
        phase: request.phase,
        content: protocolMessage,
      },
      {
        role: "user",
        kind: "phase_request",
        taskId: request.taskId,
        turnId: request.turnId,
        phase: request.phase,
        content: outputReminder,
      },
    ]
    const inheritedMessages = options?.contextMessages === undefined
      ? [{ role: "system" as const, content: baseRules?.text ?? "" }]
      : normalizeContextMessages(options.contextMessages)
    const messages: DeepSeekMessage[] = [
      ...inheritedMessages,
      ...requestMessages.map((message) => ({
        role: message.role,
        content: message.content ?? "",
      })),
    ]
    const promptSnapshot = createPromptSnapshot(request.phase, messages)
    const continuityKey = options?.contextChainId ?? request.taskId
    const previousPrompt = this.previousPromptByChain.get(continuityKey)
    const promptContinuity = comparePromptSnapshots(previousPrompt, promptSnapshot)
    this.previousPromptByChain.set(continuityKey, promptSnapshot)
    runtimeLog("debug", "deepseek-model", "completion.prompt_profiled", {
      taskId: request.taskId,
      phase: request.phase,
      envelopeId: request.envelopeId,
      totalCharacters: promptSnapshot.serialized.length,
      messages: profileMessages(messages),
      modelRequestSections: profileModelRequestSections(modelRequest),
      outputReminderCharacters: outputReminder.length,
      ...promptContinuity,
    })
    let lastError: unknown
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let cacheHitInputTokens = 0
    let cacheMissInputTokens = 0
    let hasCacheHit = false
    let hasCacheMiss = false
    let lastRawResponse: string | undefined
    const startedAt = Date.now()

    for (let repairAttempt = 0; repairAttempt <= this.config.maxSchemaRepairAttempts; repairAttempt += 1) {
      const requestStartedAtMs = Date.now()
      const timeoutMs = Math.min(
        this.config.timeoutMs,
        request.remainingBudget.modelRequestDeadlineAtMs === undefined
          ? Number.MAX_SAFE_INTEGER
          : Math.max(1, request.remainingBudget.modelRequestDeadlineAtMs - Date.now()),
        Math.max(1, request.remainingBudget.deadlineAtMs - Date.now()),
      )
      const completionInput: DeepSeekCompletionInput = {
        model: this.config.model,
        messages,
        ...(this.config.jsonModeEnabled ? { responseFormat: { type: "json_object" as const } } : {}),
        signal: mergeExecutionSignals(options?.signal, AbortSignal.timeout(timeoutMs)),
        thinking: { type: this.config.thinkingModeEnabled ? "enabled" : "disabled" },
        ...(this.config.thinkingModeEnabled ? { reasoningEffort: this.config.reasoningEffort } : {}),
      }
      runtimeLog("debug", "deepseek-model", "completion.requested", {
        taskId: request.taskId,
        phase: request.phase,
        envelopeId: request.envelopeId,
        repairAttempt: repairAttempt + 1,
        messageCount: messages.length,
        messageCharacters: messages.reduce((total, message) => total + message.content.length, 0),
        timeoutMs,
        thinkingEnabled: this.config.thinkingModeEnabled,
        reasoningEffort: this.config.thinkingModeEnabled ? this.config.reasoningEffort : undefined,
        jsonModeEnabled: this.config.jsonModeEnabled,
        maxTokens: completionInput.maxTokens,
      })
      const response = await this.completeWithRetry(client, completionInput)
      const usage = readUsage(response.usage)
      runtimeLog("debug", "deepseek-model", "completion.received", {
        taskId: request.taskId,
        phase: request.phase,
        envelopeId: request.envelopeId,
        repairAttempt: repairAttempt + 1,
        elapsedMs: Date.now() - requestStartedAtMs,
        contentCharacters: response.content?.length ?? 0,
        reasoningCharacters: response.reasoningContent?.length ?? 0,
        contentState: response.content === null ? "null" : response.content.trim().length === 0 ? "empty" : "present",
        finishReason: response.finishReason,
        responseId: response.responseId,
        messageFieldNames: response.messageFieldNames,
        ...((response.content === null || response.content.trim().length === 0) && response.reasoningContent
          ? { emptyContentReasoningTail: response.reasoningContent.slice(-2_000) }
          : {}),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        estimatedContentTokens: Math.max(0, usage.outputTokens - (usage.reasoningTokens ?? 0)),
        completionTokenDetailKeys: usage.completionTokenDetailKeys,
        cacheHitInputTokens: usage.cacheHitInputTokens,
        cacheMissInputTokens: usage.cacheMissInputTokens,
        cacheHitRate: ratio(usage.cacheHitInputTokens, usage.inputTokens),
        reasoningTokenRate: ratio(usage.reasoningTokens, usage.outputTokens),
        inputCharacterRatio: usage.inputTokens === 0
          ? undefined
          : promptSnapshot.serialized.length / usage.inputTokens,
      })
      if (response.finishReason === "length") {
        runtimeLog("warn", "deepseek-model", "completion.output_truncated", {
          taskId: request.taskId,
          phase: request.phase,
          envelopeId: request.envelopeId,
          repairAttempt: repairAttempt + 1,
          maxTokens: completionInput.maxTokens,
          contentCharacters: response.content?.length ?? 0,
          reasoningCharacters: response.reasoningContent?.length ?? 0,
          estimatedContentTokens: Math.max(0, usage.outputTokens - (usage.reasoningTokens ?? 0)),
          contentPrefix: response.content?.slice(0, 1_000) ?? "",
          contentSuffix: response.content?.slice(-1_000) ?? "",
        })
      }
      totalInputTokens += usage.inputTokens
      totalOutputTokens += usage.outputTokens
      if (usage.cacheHitInputTokens !== undefined) {
        cacheHitInputTokens += usage.cacheHitInputTokens
        hasCacheHit = true
      }
      if (usage.cacheMissInputTokens !== undefined) {
        cacheMissInputTokens += usage.cacheMissInputTokens
        hasCacheMiss = true
      }
      try {
        if (response.finishReason === "length") {
          throw new SyntaxError("Provider stopped at the output token limit before completing a bounded phase result")
        }
        const selectedOutput = selectModelOutput(response)
        lastRawResponse = selectedOutput.raw
        if (selectedOutput.source === "reasoning") {
          runtimeLog("warn", "deepseek-model", "completion.reasoning_fallback_accepted", {
            taskId: request.taskId,
            phase: request.phase,
            envelopeId: request.envelopeId,
            repairAttempt: repairAttempt + 1,
            jsonCharacters: selectedOutput.raw.length,
          })
        }
        const modelResult = selectedOutput.modelResult
        const result = assembleModelPhaseResult(referenceView.restore(modelResult), request)
        runtimeLog("debug", "deepseek-model", "execution.completed", {
          taskId: request.taskId,
          phase: request.phase,
          envelopeId: request.envelopeId,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          repairAttempts: repairAttempt,
          outcome: result.outcome,
          requestedReadCount: result.requestedReads.length,
          citedReadCount: result.citedReadIds.length,
        })
        return {
          result,
          contextExchange: {
            requestMessages,
            responseMessage: {
              role: "assistant",
              kind: "phase_response",
              taskId: request.taskId,
              turnId: request.turnId,
              phase: request.phase,
              content: selectedOutput.raw,
            },
          },
          usage: {
            modelCalls: repairAttempt + 1,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            latencyMs: Math.max(0, Date.now() - startedAt),
            ...(hasCacheHit ? { cacheHitInputTokens } : {}),
            ...(hasCacheMiss ? { cacheMissInputTokens } : {}),
            provider: "deepseek",
            model: this.config.model,
            ...(response.reasoningContent === undefined || response.reasoningContent === null
              ? {}
              : { reasoningContent: response.reasoningContent }),
          },
        }
      } catch (error) {
        lastError = error
        runtimeLog(repairAttempt >= this.config.maxSchemaRepairAttempts ? "error" : "warn", "deepseek-model", "response.validation_failed", {
          taskId: request.taskId,
          phase: request.phase,
          envelopeId: request.envelopeId,
          repairAttempt: repairAttempt + 1,
          maxSchemaRepairAttempts: this.config.maxSchemaRepairAttempts,
          error: errorDetails(error),
        })
        if (repairAttempt >= this.config.maxSchemaRepairAttempts) break
        const repairMessage = {
          role: "user" as const,
          content: [
            error instanceof SyntaxError
              ? "The previous response was truncated or syntactically incomplete. Regenerate the complete object from the original request; do not continue or echo the partial response."
              : "The previous response failed validation. Regenerate the complete object from the original request; do not echo the invalid response.",
            `Validation error: ${referenceView.toModelText(formatValidationError(error))}`,
            ...(error instanceof SyntaxError
              ? ["Use compact JSON. Keep prose fields to one short sentence, avoid repeated evidence summaries, and finish below the provider's configured output limit."]
              : []),
            buildOutputReminder(request, referenceView),
          ].join("\n"),
        }
        messages.push(repairMessage)
      }
    }
    runtimeLog("error", "deepseek-model", "execution.failed", {
      taskId: request.taskId,
      phase: request.phase,
      envelopeId: request.envelopeId,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      error: errorDetails(lastError),
    })
    throw new DeepSeekModelError(
      "schema",
      `DeepSeek response could not satisfy the phase contract: ${formatError(lastError)}`,
      lastRawResponse,
    )
  }

  private async createClient(): Promise<DeepSeekCompletionClient> {
    const apiKey = await this.secrets.getSecret(this.config.apiKeyRef)
    if (apiKey.trim().length === 0) {
      throw new DeepSeekModelError("configuration", "DeepSeek API key is empty")
    }
    const dispatcher = this.config.proxyUrl === undefined ? undefined : new ProxyAgent(this.config.proxyUrl)
    const clientOptions = {
      apiKey,
      baseURL: this.config.baseUrl,
      timeout: this.config.timeoutMs,
      maxRetries: 0,
      ...(dispatcher === undefined ? {} : { fetchOptions: { dispatcher } }),
    } as unknown as ConstructorParameters<typeof OpenAI>[0]
    const client = new OpenAI(clientOptions)
    return {
      complete: async (input) => {
        const requestBody = {
          model: input.model,
          messages: [...input.messages],
          ...(input.responseFormat === undefined ? {} : { response_format: input.responseFormat }),
          ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
          ...(input.thinking === undefined ? {} : { extra_body: { thinking: input.thinking } }),
          ...(input.reasoningEffort === undefined ? {} : { reasoning_effort: input.reasoningEffort }),
        }
        const response = await client.chat.completions.create(
          requestBody as Parameters<typeof client.chat.completions.create>[0],
          input.signal === undefined ? undefined : { signal: input.signal },
        ) as OpenAI.Chat.Completions.ChatCompletion
        const message = asRecord(response.choices[0]?.message)
        const reasoningContent = readString(message.reasoning_content)
        return {
          content: response.choices[0]?.message.content ?? null,
          finishReason: response.choices[0]?.finish_reason ?? null,
          responseId: response.id,
          messageFieldNames: Object.keys(message),
          ...(reasoningContent === undefined ? {} : { reasoningContent }),
          usage: response.usage,
        }
      },
    }
  }

  private async completeWithRetry(
    client: DeepSeekCompletionClient,
    input: DeepSeekCompletionInput,
  ): Promise<DeepSeekCompletionResponse> {
    let attempt = 0
    for (;;) {
      attempt += 1
      try {
        return await client.complete(input)
      } catch (error) {
        runtimeLog(input.signal?.aborted || attempt >= this.config.maxAttempts || !isRetryable(error) ? "error" : "warn", "deepseek-model", "completion.attempt_failed", {
          model: input.model,
          attempt,
          maxAttempts: this.config.maxAttempts,
          aborted: input.signal?.aborted ?? false,
          retryable: isRetryable(error),
          error: errorDetails(error),
        })
        if (input.signal?.aborted || attempt >= this.config.maxAttempts || !isRetryable(error)) {
          throw new DeepSeekModelError("network", `DeepSeek request failed: ${formatError(error)}`)
        }
      }
    }
  }
}

function normalizeContextMessages(
  contextMessages: readonly { role: "system" | "user" | "assistant"; content: string }[],
): DeepSeekMessage[] {
  return contextMessages.map((message, index) => {
    const role = index === 0 && message.role === "system"
      ? "system" as const
      : message.role === "system" ? "user" as const : message.role
    return { role, content: message.content }
  })
}

function mergeExecutionSignals(executionSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): AbortSignal {
  return executionSignal === undefined ? timeoutSignal : AbortSignal.any([executionSignal, timeoutSignal])
}

function buildModelResultRules(request: PhaseRequestEnvelope, referenceView: ModelReferenceView): string {
  const declaredLocalReferences = collectDeclaredLocalReferences(request)
  const mayDeclareLocalReferences = request.phase === "graph_governance"
    || request.phase === "graph_structure_plan"
    || request.phase === "graph_capacity_rewrite"
  const localReferenceRule = mayDeclareLocalReferences
    ? "- For a new graph identity, use a local:* reference and reuse that same reference throughout this artifact; the backend resolves it once."
    : declaredLocalReferences.length > 0
      ? `- This phase may reuse only local:* handles already declared by the staged graph structure (${declaredLocalReferences.join(", ")}); it must not declare or invent another local:* handle.`
      : "- Do not use local:* references in this phase. New graph identities may be declared only by graph_structure_plan or graph_capacity_rewrite."
  const graphGovernanceReferenceRule = request.phase === "graph_governance"
    || request.phase === "graph_structure_plan"
    || request.phase === "graph_capacity_rewrite"
    || request.phase === "graph_spacetime_settlement"
    || request.phase === "graph_retrieval_design"
    || request.phase === "graph_governance_review"
    ? [
        "- The complete graph_governance JSON must finish below the provider's configured output limit. Keep every reason, explanation, selfReview, semanticText, content, and metadata value concise; do not repeat source prose across fields.",
        "- In graph_governance, graph reference fields accept only node_*/link_* permanent IDs, legacy node-*/link-* aliases, or a local:* handle declared by a create mutation. Never put evidence_*/read-* in a graph reference field.",
        "- predecessorRevisionReadRefs is the exception: it accepts only revision-bearing evidence_*/read-* references, never node or link identities.",
        `- Revision-bearing evidence aliases available here: ${referenceView.revisionReadTokens.join(", ") || "none"}.`,
      ].join("\n")
    : "- evidence_*/read-* references identify evidence; node_*/link_* or legacy node-*/link-* references identify existing graph objects. Do not substitute one role for the other."
  const crossPhaseChecklist = buildCrossPhaseChecklist(request)
  return [
    "Model result rules:",
    "- Treat the model-facing request as read-only input. Do not copy, restate, summarize, or serialize the request, read evidence, catalog, prior artifacts, or schemas into the result unless the phase schema explicitly requires that value.",
    "- Completeness means one valid result for this phase, not a complete transcript of the input or a complete listing of the world. Each array item must represent one distinct required item; never repeat items to signal completeness.",
    "- Keep all prose fields concise and specific. The only field intended for long-form narrative is draft.artifact.contentMarkdown; do not echo it into reason, selfReview, metadata, or other fields.",
    "- Once the single top-level JSON object is complete and syntactically closed, stop generating immediately. Do not append a second object, explanation, or repeated continuation.",
    `- This is phase ${request.phase}; do not return protocol, envelope, task, context, scope, request, dependency, or artifact-list IDs.`,
    "- Return outcome, artifact, requestedReads, citedReadIds, unresolvedDependencies, reason, and selfReview.",
    "- Use outcome=request_read if and only if requestedReads is non-empty. Every other outcome requires requestedReads=[].",
    localReferenceRule,
    graphGovernanceReferenceRule,
    crossPhaseChecklist,
    "- Do not emit technical UUID fields. The backend creates technical IDs for chapters, sources, revisions, projections, settlements, decisions, and other records.",
    "- For an existing graph identity, copy only the exact reference present in this request's readable evidence. Never invent an existing graph reference.",
    `- Read-evidence to graph-owner alias map: ${referenceView.graphReferencePairs.join(", ") || "none"}.`,
    "- Read requests contain semantic query intent only. Omit query fields that are not useful; infrastructure supplies bounded defaults.",
    "- sourceKinds source means the internal committed immutable source-unit projection. It is not a request to read Markdown from the workspace chapter directory, so a workspace chapter-read prohibition does not exclude source projections.",
    "- For an exact quotation, title, or other exact persisted wording, provide exactKeys. When the same request searches graph or revision evidence, include source as well; summaries and semanticTexts must not impersonate exact source wording.",
    "- Source evidence may expose relatedOwnerRefs with bounded graph projection summaries: these are the graph owners mechanically linked to that exact immutable source unit by settlement. Use those summaries first when reconstructing the source unit's time, place, state, or causal context; do not replace them with an unrelated graph candidate that merely has similar wording, and do not request every related owner again unless the summary is insufficient.",
    "- Source evidence exposes sourcePosition from immutable source order. isEnd=true identifies the last persisted unit of that source; isEnd=false means the unit must not be described as that source's ending. sequence and source boundaries are storage order, not story time.",
    "- When continuation requires the end of an identified source and visible evidence is not isEnd=true, request sourceKinds=[source], copy its sourcePosition.sourceRef into sourceIds, and set sourceBoundary=end. Use sourceBoundary=start only when the beginning is required. Do not guess a source boundary from semantic similarity.",
    "- For conflicting current graph evidence owned by different nodes or links, a larger committedSequence means a later committed world state and should be preferred over an older plan or local state. committedSequence is not story time; explicit story-time anchors and evolution relations still determine in-world chronology.",
    `- citedReadIds may contain only model aliases in committedReadIds (${referenceView.committedReadTokens.join(", ") || "none"}) or visiblePendingIds (${referenceView.visiblePendingTokens.join(", ") || "none"}).`,
    "- citedReadIds must include every visible evidence item that materially supports the returned artifact, reason, or selfReview. citedReadIds is an audit record only: omitting an already visible Evidence does not erase it from this turn or require it to be read again.",
    "- input.retrievalGaps are notices that a bounded retrieval attempt found no readable evidence; they are not sources and must never be copied into citedReadIds.",
    "- Unresolved dependencies contain description, requiredFor, and disposition only.",
  ].join("\n")
}

function collectDeclaredLocalReferences(request: PhaseRequestEnvelope): string[] {
  const input = asRecord(request.input)
  const artifacts = asRecord(input.artifacts)
  const governance = asRecord(artifacts.graph_governance)
  const structure = asRecord(artifacts.graph_structure_plan)
  const structureProposals = Array.isArray(structure.proposals) ? structure.proposals : []
  const structureMutations = structureProposals.map((proposal) => asRecord(asRecord(proposal).mutation))
  const mutations = [
    ...(Array.isArray(governance.mutations) ? governance.mutations.map(asRecord) : []),
    ...structureMutations,
  ]
  return mutations.flatMap((mutation) => {
    return (mutation.operation === "create_node" || mutation.operation === "create_link")
      && typeof mutation.ref === "string"
      && mutation.ref.startsWith("local:")
      ? [mutation.ref]
      : []
  })
}

function buildCrossPhaseChecklist(request: PhaseRequestEnvelope): string {
  const input = asRecord(request.input)
  const artifacts = asRecord(input.artifacts)
  if (request.phase === "dependency_audit") {
    const workflow = input.workflow === "evolution" ? "evolution" : input.workflow === "query" ? "query" : "turn"
    const sourceUnitIds = Array.isArray(input.sourceUnitIds) ? input.sourceUnitIds : []
    return [
      `- This dependency audit belongs to workflow=${workflow} and currently has ${String(sourceUnitIds.length)} persisted narrative source unit(s). Do not infer another workflow from the prose or prior artifacts.`,
      sourceUnitIds.length > 0
        ? `- The complete draft has narrative source unit indexes exactly: ${indexList(sourceUnitIds.length)}. sceneContinuity must not be empty and must describe every actual spacetime-distinct scene needed to cover that complete draft; graph_governance will bind all listed source units to these scenes.`
        : workflow === "evolution"
          ? "- This background evolution has no narrative source units. sceneContinuity may be empty only when the evolution artifact itself contains no spacetime-distinct scene that requires continuity auditing."
          : "- No narrative source units are present. Do not invent draft scenes; include sceneContinuity entries only for actual phase content that requires spacetime continuity auditing.",
      "- A newly inferred person, place, event, object, or other thing does not make a scene unsupported. Audit whether its time, place, prior evolution, and current state are continuous; do not omit the scene merely because some contents are newly created this turn.",
    ].join("\n")
  }
  if (request.phase === "rule_assembly") {
    const readableWorkspacePathCount = Array.isArray(input.readEvidence)
      ? input.readEvidence.filter((evidence) => {
          const record = asRecord(evidence)
          return typeof record.ownerKind === "string" && record.ownerKind.startsWith("workspace:")
        }).length
      : 0
    return [
      `- rule_assembly currently has ${String(readableWorkspacePathCount)} readable workspace path(s). Select only from those read-evidence paths and never enumerate workspaceCatalog as output.`,
      "- selectedWorkspacePaths must contain unique paths. selectionReasons must have exactly the same path keys, with one short sentence per selected path.",
      "- This phase has no long-text field. Never place file contents, rules, catalog entries, or repeated explanations inside any string field.",
      "- Do not copy file contents, catalog entries, evidence payloads, prior artifacts, schemas, or the request into artifact fields. Return the smallest complete JSON result.",
      '- If no additional workspace file is needed, return this compact artifact shape: {"selectedWorkspacePaths":[],"selectionReasons":{},"unresolvedRuleConflicts":[]}.',
    ].join("\n")
  }
  if (request.phase === "semantic_review") {
    const governance = asRecord(artifacts.graph_governance)
    const frontiers = Array.isArray(governance.affectedFrontierRefs)
      ? governance.affectedFrontierRefs.filter((value): value is string => typeof value === "string")
      : []
    const verificationProbeIndexes = Array.isArray(input.verificationProbeExecutions)
      ? input.verificationProbeExecutions.flatMap((execution) => {
          const probeIndex = asRecord(execution).probeIndex
          return typeof probeIndex === "number" ? [probeIndex] : []
        })
      : []
    return [
      "- semantic_review is advisory. Report only indexes and references for which you have an actual review conclusion; do not enumerate no-opinion items.",
      `- affected frontiers available for review: ${frontiers.join(", ") || "none"}.`,
      verificationProbeIndexes.length === 0
        ? "- No application verification probes are available in this request."
        : `- The application executed verification probes with indexes: ${verificationProbeIndexes.join(", ")}. Return exactly one verificationProbeAssessment for each of these indexes, preserve each executed descriptor unchanged, and do not add any other index.`,
    ].join("\n")
  }
  if (request.phase === "graph_governance_review") {
    const verificationProbeExecutions = Array.isArray(input.verificationProbeExecutions)
      ? input.verificationProbeExecutions.map(asRecord)
      : []
    const verificationProbeIndexes = verificationProbeExecutions.flatMap((execution) => (
      typeof execution.probeIndex === "number" ? [execution.probeIndex] : []
    ))
    return verificationProbeIndexes.length === 0
      ? "- No application verification probe has been executed yet. You must return outcome=request_read with at least one AI-defined requestedReads[].verificationProbe; do not finish the review and do not fabricate an assessment."
      : [
          `- input.verificationProbeExecutions contains application-executed results for probe indexes: ${verificationProbeIndexes.join(", ")}. These are real execution records, not plans or model-generated claims.`,
          ...verificationProbeExecutions.map(formatVerificationProbeExecution),
          "- Assess each execution from verificationProbeExecutions together with the same request's readEvidence, returnedReadRefs, returnedGraphRefs, returnedProposalRefs, and resultDigest. Return exactly one verificationProbeAssessment for each listed probe index and no other index.",
          "- Do not claim that probe execution results were not provided when these fields are present. A probe may still receive verdict=uncertain or verdict=fail when its actual returned evidence is insufficient.",
        ].join("\n")
  }
  if (request.phase === "graph_governance" || request.phase === "graph_structure_plan") {
    const dependency = asRecord(artifacts.dependency_audit)
    const scenes = Array.isArray(dependency.sceneContinuity) ? dependency.sceneContinuity : []
    const sourceUnitIds = Array.isArray(input.sourceUnitIds) ? input.sourceUnitIds : []
    return [
      "- Finalize mutations first, then make mutationSpacetimeSettlements cover every zero-based index in your returned mutations array exactly once. Do not use one-based numbering, omit the final index, or infer a fixed mutation count from the input.",
      "- decisionRecords is advisory detail. Omit repetitive per-mutation decisions; uncovered mutations inherit this phase result's reason and selfReview.",
      `- settlementRecords is an optional mechanical projection. Omit it when it would repeat the scene and mutation settlement data; the backend derives missing source-unit return entries. If you provide it, use zero-based sourceUnitIndex values and do not repeat indexes.`,
      `- Required dependency-audit scene indexes are exactly: ${indexList(scenes.length)}. Return one sceneSpacetimeBinding for each listed index, with no missing, duplicate, or extra scene index.`,
      `- Required narrative source unit indexes are exactly: ${indexList(sourceUnitIds.length)}. Their union across sceneSpacetimeBindings.sourceUnitIndexes must equal this list exactly once, with no missing, duplicate, negative, or extra index.`,
      sourceUnitIds.length === 0
        ? "- This is a background evolution with no narrative source units, so every sourceUnitIndexes array must be empty."
        : "- Every dependency-audit scene in this turn is a narrative scene and must bind at least one source unit index, even when that scene has no new graph mutation. Never return an empty sourceUnitIndexes array for one of these scenes.",
      "- For each sceneSpacetimeBinding, copy predecessorSceneIndexes exactly from dependency_audit. The first scene may therefore have an empty predecessorSceneIndexes array; never invent scene 0 or another current-turn index just to satisfy predecessorRequired.",
      "- When predecessorRequired is true but predecessorSceneIndexes is empty, the predecessor is outside this turn. Bind it through predecessorSceneAnchorRefs using the exact existing graph-owner aliases mapped from the dependency evidence, and provide the actual transitionPathRefs that connect the prior state to this scene.",
      "- dependency_audit predecessorSceneRefs are evidence references, not graph-owner fields. Convert them through the supplied evidence-to-graph-owner map before placing them in predecessorSceneAnchorRefs or transitionPathRefs; do not copy evidence IDs or invent graph IDs.",
      "- historicalReturnRefs are graph paths only: use node_*/link_* permanent IDs, legacy node-*/link-* aliases, or local:*; never use evidence_*/read-*. Raw chapter/source return is already preserved by settlementRecords.",
      "- edit_node.next must contain the complete latest current projection after applying this turn: preserve stable identity, descriptions, and retrieval information that remain true. Do not return only the changed fragment; revision history already preserves the previous projection.",
    ].join("\n")
  }
  if (request.phase === "frontier_settlement") {
    const review = asRecord(artifacts.semantic_review)
    const approvedFrontiers = Array.isArray(review.approvedAffectedFrontierRefs)
      ? review.approvedAffectedFrontierRefs.filter((value): value is string => typeof value === "string")
      : []
    return [
      `- frontier_settlement must settle each approved frontier exactly once. Exact frontier list: ${approvedFrontiers.join(", ") || "none"}.`,
      "- A frontier is an independently resumable and discoverable local continuation boundary. It is not a mutation index and not a list of every node or link touched by graph governance; multiple mutations may belong to one frontier.",
      "- Do not manufacture one frontier per mutation or copy the same spacetime anchors into many frontier records. If the approved list is empty, return an empty frontiers array.",
      "- For every non-archived approved frontier, return that frontier's own last scene, time, and location anchors plus a non-empty revisitCondition. Use graph or local references already established in this request; do not invent technical IDs.",
      "- Choose scene, time, and location anchors only from the corresponding anchors already approved in graph_governance sceneSpacetimeBindings. Do not promote another readable object to an anchor in this final settlement phase.",
    ].join("\n")
  }
  return "- Preserve every exact cross-phase checklist item supplied in the model-facing request."
}

function formatVerificationProbeExecution(execution: Record<string, unknown>): string {
  return [
    `- Executed probe record: probeIndex=${String(execution.probeIndex)}`,
    `status=${String(execution.status)}`,
    `returnedReadRefs=${formatReferenceList(execution.returnedReadRefs)}`,
    `returnedGraphRefs=${formatReferenceList(execution.returnedGraphRefs)}`,
    `returnedProposalRefs=${formatReferenceList(execution.returnedProposalRefs)}`,
    `resultDigest=${String(execution.resultDigest)}`,
  ].join("; ")
}

function formatReferenceList(value: unknown): string {
  return `[${Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join(",") : ""}]`
}

function indexList(length: number): string {
  return length === 0 ? "none" : Array.from({ length }, (_, index) => String(index)).join(", ")
}

function buildOutputReminder(request: PhaseRequestEnvelope, referenceView: ModelReferenceView): string {
  return [
    "MANDATORY OUTPUT CONTRACT - this is the final and highest-priority instruction for this request:",
    buildModelResultRules(request, referenceView),
    "The response must match this complete model-facing result schema:",
    JSON.stringify(phaseModelResultJsonSchema(request.phase)),
    "Only outcome, artifact, requestedReads, citedReadIds, unresolvedDependencies, reason, and selfReview may appear at the top level.",
    "Use outcome=request_read if and only if requestedReads is non-empty; otherwise requestedReads must be an empty array.",
    `All ${request.phase} phase fields defined by the schema must be nested inside artifact.`,
    "Return one JSON object only. Do not add Markdown fences, commentary, or a custom outcome value.",
    "FINAL OUTPUT DISCIPLINE: Treat all request data as read-only input; never echo or enumerate it. Return only the smallest valid phase result, with no duplicate array items or repeated prose. Close the one JSON object and stop immediately.",
    'Required top-level shape: {"outcome":"continue","artifact":{},"requestedReads":[],"citedReadIds":[],"unresolvedDependencies":[],"reason":"...","selfReview":"..."}',
  ].join("\n")
}

function parseFirstJsonObject(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    const start = raw.search(/\S/u)
    if (start < 0 || raw[start] !== "{") throw error
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < raw.length; index += 1) {
      const character = raw[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === "\\") escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') {
        inString = true
      } else if (character === "{") {
        depth += 1
      } else if (character === "}") {
        depth -= 1
        if (depth === 0) {
          const firstObjectEnd = index + 1
          const trailing = raw.slice(firstObjectEnd).trim()
          if (trailing.startsWith(",")) {
            try {
              return JSON.parse(raw.slice(start, index) + trailing)
            } catch {
              return JSON.parse(raw.slice(start, firstObjectEnd))
            }
          }
          return JSON.parse(raw.slice(start, firstObjectEnd))
        }
      }
    }
    throw error
  }
}

function selectModelOutput(response: DeepSeekCompletionResponse): {
  raw: string
  modelResult: ReturnType<typeof parseModelPhaseResult>
  source: "content" | "reasoning"
} {
  const content = response.content?.trim()
  if (content !== undefined && content.length > 0) {
    return {
      raw: content,
      modelResult: parseModelPhaseResult(parseFirstJsonObject(content)),
      source: "content",
    }
  }

  const reasoning = response.reasoningContent?.trim()
  if (reasoning !== undefined && reasoning.length > 0) {
    const fallback = parseLastValidModelResult(reasoning)
    if (fallback !== undefined) return { ...fallback, source: "reasoning" }
  }

  throw new DeepSeekModelError(
    "response",
    "DeepSeek returned reasoning without final content",
  )
}

function parseLastValidModelResult(raw: string): {
  raw: string
  modelResult: ReturnType<typeof parseModelPhaseResult>
} | undefined {
  const objectEnd = raw.lastIndexOf("}")
  if (objectEnd < 0) return undefined
  let objectStart = raw.lastIndexOf("{", objectEnd)
  while (objectStart >= 0) {
    const candidate = raw.slice(objectStart, objectEnd + 1)
    try {
      return {
        raw: candidate,
        modelResult: parseModelPhaseResult(JSON.parse(candidate)),
      }
    } catch {
      // Continue toward the enclosing object until the complete phase result is found.
    }
    if (objectStart === 0) break
    objectStart = raw.lastIndexOf("{", objectStart - 1)
  }
  return undefined
}

function formatValidationError(error: unknown): string {
  return formatError(error)
}

export class EnvironmentSecretProvider implements SecretProvider {
  public constructor(private readonly values: NodeJS.ProcessEnv = process.env) {}

  public getSecret(reference: string): Promise<string> {
    const value = reference === "deepseek-api-key" ? this.values.DEEPSEEK_API_KEY : this.values[reference]
    return Promise.resolve(value ?? "")
  }
}

function readUsage(value: unknown): {
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  completionTokenDetailKeys?: readonly string[]
  cacheHitInputTokens?: number
  cacheMissInputTokens?: number
} {
  const usage = asRecord(value)
  const promptTokens = readNumber(usage.prompt_tokens) ?? readNumber(usage.input_tokens) ?? 0
  const completionTokens = readNumber(usage.completion_tokens) ?? readNumber(usage.output_tokens) ?? 0
  const completionTokenDetails = asRecord(usage.completion_tokens_details)
  const reasoningTokens = readNumber(completionTokenDetails.reasoning_tokens)
  const cacheHit = readNumber(usage.prompt_cache_hit_tokens)
  const cacheMiss = readNumber(usage.prompt_cache_miss_tokens)
  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(Object.keys(completionTokenDetails).length === 0 ? {} : { completionTokenDetailKeys: Object.keys(completionTokenDetails) }),
    ...(cacheHit === undefined ? {} : { cacheHitInputTokens: cacheHit }),
    ...(cacheMiss === undefined ? {} : { cacheMissInputTokens: cacheMiss }),
  }
}

function createPromptSnapshot(phase: string, messages: readonly DeepSeekMessage[]): PromptSnapshot {
  return {
    phase,
    serialized: messages.map((message) => `${message.role}\n${message.content}`).join("\n\u0000\n"),
    messageDigests: messages.map((message) => digestText(`${message.role}\n${message.content}`)),
  }
}

function profileMessages(messages: readonly DeepSeekMessage[]): readonly Record<string, unknown>[] {
  const sections = ["base_rules", "phase_prompt", "protocol", "turn_request"]
  return messages.map((message, index) => ({
    index,
    section: sections[index] ?? `message_${String(index)}`,
    role: message.role,
    characters: message.content.length,
    digest: digestText(`${message.role}\n${message.content}`),
  }))
}

function profileModelRequestSections(value: unknown): Record<string, unknown> {
  const request = asRecord(value)
  const input = asRecord(request.input)
  const {
    readEvidence,
    retrievalGaps,
    workspaceCatalog,
    artifacts,
    projectSettings,
    ...coreInput
  } = input
  const { input: ignoredInput, ...envelope } = request
  void ignoredInput
  return {
    envelopeCharacters: serializedLength(envelope),
    coreInputCharacters: serializedLength(coreInput),
    projectSettingsCharacters: serializedLength(projectSettings),
    workspaceCatalogCharacters: serializedLength(workspaceCatalog),
    readEvidenceCharacters: serializedLength(readEvidence),
    readEvidenceCount: Array.isArray(readEvidence) ? readEvidence.length : 0,
    retrievalGapCharacters: serializedLength(retrievalGaps),
    retrievalGapCount: Array.isArray(retrievalGaps) ? retrievalGaps.length : 0,
    artifactCharacters: serializedLength(artifacts),
    artifactCount: typeof artifacts === "object" && artifacts !== null && !Array.isArray(artifacts)
      ? Object.keys(artifacts).length
      : 0,
  }
}

function comparePromptSnapshots(
  previous: PromptSnapshot | undefined,
  current: PromptSnapshot,
): Record<string, unknown> {
  if (previous === undefined) {
    return {
      previousPhase: undefined,
      commonPrefixCharacters: 0,
      commonPrefixRatio: 0,
      exactMessagePrefixCount: 0,
    }
  }
  const commonPrefixCharacters = countCommonPrefixCharacters(previous.serialized, current.serialized)
  let exactMessagePrefixCount = 0
  while (exactMessagePrefixCount < previous.messageDigests.length
    && exactMessagePrefixCount < current.messageDigests.length
    && previous.messageDigests[exactMessagePrefixCount] === current.messageDigests[exactMessagePrefixCount]) {
    exactMessagePrefixCount += 1
  }
  return {
    previousPhase: previous.phase,
    previousPromptCharacters: previous.serialized.length,
    commonPrefixCharacters,
    commonPrefixRatio: current.serialized.length === 0 ? 0 : commonPrefixCharacters / current.serialized.length,
    exactMessagePrefixCount,
  }
}

function countCommonPrefixCharacters(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  return index
}

function serializedLength(value: unknown): number {
  if (value === undefined) return 0
  return JSON.stringify(value).length
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function ratio(numerator: number | undefined, denominator: number): number | undefined {
  if (numerator === undefined || denominator === 0) return undefined
  return numerator / denominator
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function isRetryable(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError) return true
  if (error instanceof TypeError) return true
  if (!(error instanceof OpenAI.APIError)) return false
  return error.status === 408
    || error.status === 409
    || error.status === 429
    || (error.status !== undefined && error.status >= 500)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
