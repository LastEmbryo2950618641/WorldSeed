import OpenAI from "openai"
import { ProxyAgent } from "undici"

import {
  phaseArtifactJsonSchema,
} from "@worldseed/prompt-contracts"
import {
  PROTOCOL_VERSION,
  phaseResultEnvelopeSchema,
  type PhaseRequestEnvelope,
} from "@worldseed/contracts"
import type { DeepSeekRuntimeConfig } from "@worldseed/config"

import type {
  AIModelPort,
  PhaseModelExecution,
  PromptResourcePort,
} from "../../../application/index.js"

export type SecretProvider = Readonly<{
  getSecret(reference: string): Promise<string>
}>

export type DeepSeekCompletionClient = Readonly<{
  complete(input: DeepSeekCompletionInput): Promise<DeepSeekCompletionResponse>
}>

export type DeepSeekCompletionInput = Readonly<{
  model: string
  messages: readonly DeepSeekMessage[]
  responseFormat: { type: "json_object" }
}>

export type DeepSeekMessage = Readonly<{
  role: "system" | "user" | "assistant"
  content: string
}>

export type DeepSeekCompletionResponse = Readonly<{
  content: string | null
  usage?: unknown
}>

export class DeepSeekModelError extends Error {
  public constructor(
    public readonly kind: "configuration" | "network" | "response" | "schema",
    message: string,
  ) {
    super(message)
  }
}

export class DeepSeekAiModelAdapter implements AIModelPort {
  private readonly clientPromise: Promise<DeepSeekCompletionClient>
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
    } as const
    this.clientPromise = client === undefined ? this.createClient() : Promise.resolve(client)
  }

  public async execute(request: PhaseRequestEnvelope): Promise<PhaseModelExecution> {
    const [baseRules, phasePrompt, client] = await Promise.all([
      this.prompts.loadBaseRules(),
      this.prompts.loadPhase(request.phase),
      this.clientPromise,
    ])
    const messages: DeepSeekMessage[] = [
      { role: "system", content: baseRules.text },
      { role: "system", content: phasePrompt.text },
      {
        role: "system",
        content: [
          `Worldseed protocol ${PROTOCOL_VERSION}.`,
          `Current phase: ${request.phase}.`,
          "Return exactly one JSON object and no Markdown fences or commentary.",
          "The artifact must match this JSON Schema:",
          JSON.stringify(phaseArtifactJsonSchema(request.phase)),
          "The response envelope must contain schemaVersion, envelopeId, contextId, phase, outcome, artifact, requestedReads, citedReadIds, producedArtifactIds, decisionRecordIds, unresolvedDependencies, reason, and selfReview.",
        ].join("\n"),
      },
      { role: "user", content: JSON.stringify(request) },
    ]
    let lastError: unknown
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let cacheHitInputTokens = 0
    let cacheMissInputTokens = 0
    let hasCacheHit = false
    let hasCacheMiss = false
    const startedAt = Date.now()

    for (let repairAttempt = 0; repairAttempt <= this.config.maxSchemaRepairAttempts; repairAttempt += 1) {
      const response = await this.completeWithRetry(client, {
        model: this.config.model,
        messages,
        responseFormat: { type: "json_object" },
      })
      const usage = readUsage(response.usage)
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
        const raw = response.content
        if (raw === null) throw new DeepSeekModelError("response", "DeepSeek returned empty content")
        const result = phaseResultEnvelopeSchema.parse(JSON.parse(raw))
        if (result.envelopeId !== request.envelopeId || result.contextId !== request.contextId || result.phase !== request.phase) {
          throw new DeepSeekModelError("response", "DeepSeek response envelope does not match the request")
        }
        return {
          result,
          usage: {
            modelCalls: repairAttempt + 1,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            latencyMs: Math.max(0, Date.now() - startedAt),
            ...(hasCacheHit ? { cacheHitInputTokens } : {}),
            ...(hasCacheMiss ? { cacheMissInputTokens } : {}),
            provider: "deepseek",
            model: this.config.model,
          },
        }
      } catch (error) {
        lastError = error
        if (repairAttempt >= this.config.maxSchemaRepairAttempts) break
        messages.push(
          { role: "assistant", content: response.content ?? "" },
          {
            role: "user",
            content: `The previous JSON failed validation. Return a corrected JSON object only. Error: ${formatError(error)}`,
          },
        )
      }
    }
    throw new DeepSeekModelError("schema", `DeepSeek response could not satisfy the phase contract: ${formatError(lastError)}`)
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
        const response = await client.chat.completions.create({
          model: input.model,
          messages: [...input.messages],
          response_format: input.responseFormat,
        })
        return {
          content: response.choices[0]?.message.content ?? null,
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
        if (attempt >= this.config.maxAttempts || !isRetryable(error)) {
          throw new DeepSeekModelError("network", `DeepSeek request failed: ${formatError(error)}`)
        }
      }
    }
  }
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
  cacheHitInputTokens?: number
  cacheMissInputTokens?: number
} {
  const usage = asRecord(value)
  const promptTokens = readNumber(usage.prompt_tokens) ?? readNumber(usage.input_tokens) ?? 0
  const completionTokens = readNumber(usage.completion_tokens) ?? readNumber(usage.output_tokens) ?? 0
  const cacheHit = readNumber(usage.prompt_cache_hit_tokens)
  const cacheMiss = readNumber(usage.prompt_cache_miss_tokens)
  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    ...(cacheHit === undefined ? {} : { cacheHitInputTokens: cacheHit }),
    ...(cacheMiss === undefined ? {} : { cacheMissInputTokens: cacheMiss }),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function isRetryable(error: unknown): boolean {
  const record = asRecord(error)
  const status = readNumber(record.status)
  if (status !== undefined) return status >= 500
  const message = formatError(error).toLowerCase()
  return message.includes("timeout") || message.includes("econn") || message.includes("network")
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
