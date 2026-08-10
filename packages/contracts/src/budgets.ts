import { z } from "zod"

const tokenCountSchema = z.number().int().nonnegative()

export const modelCallBudgetSchema = z.object({
  maxCalls: tokenCountSchema,
  remainingCalls: tokenCountSchema,
  maxInputTokens: tokenCountSchema,
  remainingInputTokens: tokenCountSchema,
  maxOutputTokens: tokenCountSchema,
  remainingOutputTokens: tokenCountSchema,
  deadlineAtMs: tokenCountSchema,
  modelRequestDeadlineAtMs: tokenCountSchema.optional(),
  retrievalExecutionDeadlineAtMs: tokenCountSchema.optional(),
  retrievalPhaseDeadlineAtMs: tokenCountSchema.optional(),
})
export type ModelCallBudget = z.infer<typeof modelCallBudgetSchema>

export const budgetUsageSchema = z.object({
  modelCalls: tokenCountSchema,
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  wallTimeMs: tokenCountSchema,
})
export type BudgetUsage = z.infer<typeof budgetUsageSchema>

export const kvCacheUsageSchema = z.object({
  totalInputTokens: tokenCountSchema,
  cacheHitInputTokens: tokenCountSchema.optional(),
  cacheMissInputTokens: tokenCountSchema.optional(),
  hitRate: z.number().min(0).max(1).optional(),
})
export type KVCacheUsage = z.infer<typeof kvCacheUsageSchema>

export function calculateKVCacheHitRate(usage: KVCacheUsage): number | undefined {
  if (usage.cacheHitInputTokens === undefined || usage.cacheMissInputTokens === undefined) {
    return undefined
  }

  if (usage.totalInputTokens === 0) {
    return undefined
  }

  return usage.cacheHitInputTokens / usage.totalInputTokens
}
