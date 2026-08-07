import { z } from "zod"

import { deepSeekReasoningEffortSchema } from "@worldseed/contracts"

export const deepSeekRuntimeConfigSchema = z.object({
  provider: z.literal("deepseek"),
  baseUrl: z.url().refine((url) => {
    const parsed = new URL(url)
    return parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
  }, {
    message: "baseUrl must use HTTPS unless it targets localhost",
  }),
  model: z.string().trim().min(1),
  apiKeyRef: z.string().min(1),
  contextWindowTokens: z.number().int().positive(),
  proxyUrl: z.url().refine((url) => url.startsWith("http://") || url.startsWith("https://"), {
    message: "proxyUrl must use HTTP or HTTPS",
  }).optional(),
  timeoutMs: z.number().int().positive(),
  maxAttempts: z.number().int().min(1).max(2),
  maxSchemaRepairAttempts: z.number().int().min(0).max(2),
  jsonModeEnabled: z.boolean(),
  thinkingModeEnabled: z.boolean(),
  reasoningEffort: deepSeekReasoningEffortSchema,
})
export type DeepSeekRuntimeConfig = z.infer<typeof deepSeekRuntimeConfigSchema>

export const defaultDeepSeekRuntimeConfig = Object.freeze({
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  apiKeyRef: "deepseek-api-key",
  contextWindowTokens: 1_000_000,
  timeoutMs: 300000,
  maxAttempts: 2,
  maxSchemaRepairAttempts: 2,
  jsonModeEnabled: false,
  thinkingModeEnabled: true,
  reasoningEffort: "high",
} as const satisfies DeepSeekRuntimeConfig)

export type DeepSeekEnvironment = Readonly<Record<string, string | undefined>>

export function deepSeekRuntimeConfigFromEnvironment(
  values: DeepSeekEnvironment = {},
): DeepSeekRuntimeConfig | undefined {
  const apiKey = values.DEEPSEEK_API_KEY?.trim()
  if (apiKey === undefined || apiKey.length === 0) return undefined

  return deepSeekRuntimeConfigSchema.parse({
    ...defaultDeepSeekRuntimeConfig,
    baseUrl: values.WORLDSEED_DEEPSEEK_BASE_URL ?? defaultDeepSeekRuntimeConfig.baseUrl,
    model: values.WORLDSEED_DEEPSEEK_MODEL ?? defaultDeepSeekRuntimeConfig.model,
    proxyUrl: optionalEnvironmentValue(values.WORLDSEED_DEEPSEEK_PROXY_URL),
    timeoutMs: environmentInteger(values.WORLDSEED_DEEPSEEK_TIMEOUT_MS, defaultDeepSeekRuntimeConfig.timeoutMs),
    maxAttempts: environmentInteger(values.WORLDSEED_DEEPSEEK_MAX_ATTEMPTS, defaultDeepSeekRuntimeConfig.maxAttempts),
    maxSchemaRepairAttempts: environmentInteger(
      values.WORLDSEED_DEEPSEEK_MAX_SCHEMA_REPAIR_ATTEMPTS,
      defaultDeepSeekRuntimeConfig.maxSchemaRepairAttempts,
    ),
    jsonModeEnabled: environmentBoolean(
      values.WORLDSEED_DEEPSEEK_JSON_MODE_ENABLED,
      defaultDeepSeekRuntimeConfig.jsonModeEnabled,
    ),
    thinkingModeEnabled: environmentBoolean(
      values.WORLDSEED_DEEPSEEK_THINKING_MODE_ENABLED,
      defaultDeepSeekRuntimeConfig.thinkingModeEnabled,
    ),
    reasoningEffort: values.WORLDSEED_DEEPSEEK_REASONING_EFFORT
      === undefined || values.WORLDSEED_DEEPSEEK_REASONING_EFFORT.trim().length === 0
      ? defaultDeepSeekRuntimeConfig.reasoningEffort
      : values.WORLDSEED_DEEPSEEK_REASONING_EFFORT.trim(),
  })
}

function optionalEnvironmentValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

function environmentInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new Error(`DeepSeek environment value must be an integer: ${value}`)
  return parsed
}

function environmentBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim().length === 0) return fallback
  if (value === "true") return true
  if (value === "false") return false
  throw new Error(`DeepSeek environment value must be true or false: ${value}`)
}
