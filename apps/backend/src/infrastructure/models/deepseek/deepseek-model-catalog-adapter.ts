import { modelListResultSchema, type ModelListPayload, type ModelListResult } from "@worldseed/contracts"

import type { ModelCatalogPort } from "../../../application/index.js"
import { DeepSeekModelError } from "./deepseek-model-adapter.js"

export type ModelCatalogRequest = typeof fetch

export class DeepSeekModelCatalogAdapter implements ModelCatalogPort {
  public constructor(
    private readonly request: ModelCatalogRequest = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  public async list(input: ModelListPayload): Promise<ModelListResult> {
    const endpoint = createModelsEndpoint(input.baseUrl)
    let response: Response
    try {
      response = await this.request(endpoint, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.apiKey}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new DeepSeekModelError("network", `DeepSeek model list request failed: ${formatError(error)}`)
    }
    if (!response.ok) {
      throw new DeepSeekModelError(
        "response",
        `DeepSeek model list request failed (${String(response.status)} ${response.statusText || "HTTP error"})`,
      )
    }
    let raw: unknown
    try {
      raw = await response.json()
    } catch (error) {
      throw new DeepSeekModelError("response", `DeepSeek returned an invalid model list: ${formatError(error)}`)
    }
    const models = readModels(raw)
    return modelListResultSchema.parse({ models })
  }
}

function createModelsEndpoint(baseUrl: string): URL {
  const endpoint = new URL(baseUrl)
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
    throw new DeepSeekModelError("configuration", "Remote model addresses must use HTTPS")
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    throw new DeepSeekModelError("configuration", "Model addresses must not contain credentials")
  }
  endpoint.search = ""
  endpoint.hash = ""
  const path = endpoint.pathname.replace(/\/+$/, "")
  endpoint.pathname = path.endsWith("/models") ? path : `${path}/models`
  return endpoint
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readModels(value: unknown): ModelListResult["models"] {
  const response = asRecord(value)
  if (!Array.isArray(response.data)) {
    throw new DeepSeekModelError("response", "DeepSeek returned an invalid model list")
  }
  const models = response.data.map((item: unknown) => readModel(item))
  return [...new Map(models.map((model) => [model.id, model])).values()]
    .sort((left, right) => left.id.localeCompare(right.id))
}

function readModel(value: unknown): ModelListResult["models"][number] {
  const model = asRecord(value)
  if (typeof model.id !== "string" || model.id.trim().length === 0) {
    throw new DeepSeekModelError("response", "DeepSeek returned an invalid model list")
  }
  const ownedBy = typeof model.owned_by === "string" && model.owned_by.trim().length > 0
    ? model.owned_by.trim()
    : undefined
  return {
    id: model.id.trim(),
    ...(ownedBy === undefined ? {} : { ownedBy }),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}
