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
