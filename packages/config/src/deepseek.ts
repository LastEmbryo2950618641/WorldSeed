import { z } from "zod"

export const deepSeekRuntimeConfigSchema = z.object({
  provider: z.literal("deepseek"),
  baseUrl: z.url().refine((url) => url.startsWith("https://") || url.startsWith("http://localhost"), {
    message: "baseUrl must use HTTPS unless it targets localhost",
  }),
  model: z.enum(["deepseek-chat", "deepseek-reasoner"]),
  apiKeyRef: z.string().min(1),
  proxyUrl: z.url().refine((url) => url.startsWith("http://") || url.startsWith("https://"), {
    message: "proxyUrl must use HTTP or HTTPS",
  }).optional(),
  timeoutMs: z.number().int().positive(),
  maxAttempts: z.number().int().min(1).max(2),
  maxSchemaRepairAttempts: z.number().int().min(0).max(2),
  responseFormat: z.literal("json_object"),
})
export type DeepSeekRuntimeConfig = z.infer<typeof deepSeekRuntimeConfigSchema>

export const defaultDeepSeekRuntimeConfig = Object.freeze({
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  apiKeyRef: "deepseek-api-key",
  timeoutMs: 120000,
  maxAttempts: 2,
  maxSchemaRepairAttempts: 2,
  responseFormat: "json_object",
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
