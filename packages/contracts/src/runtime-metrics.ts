import { z } from "zod"

export const runtimeMetricIdValues = [
  "model_calls",
  "input_tokens",
  "output_tokens",
  "wall_time",
  "retrieval_rounds",
  "context_tokens",
  "context_limit",
  "kv_cache_hit_rate",
  "total_tokens",
  "compression_generation",
] as const
export const runtimeMetricIdSchema = z.enum(runtimeMetricIdValues)
export type RuntimeMetricId = z.infer<typeof runtimeMetricIdSchema>

export const resettableRuntimeMetricIdValues = ["model_calls", "input_tokens", "output_tokens", "wall_time"] as const
export const resettableRuntimeMetricIdSchema = z.enum(resettableRuntimeMetricIdValues)
export type ResettableRuntimeMetricId = z.infer<typeof resettableRuntimeMetricIdSchema>

export const runtimeMetricSchema = z.object({
  metricId: runtimeMetricIdSchema,
  label: z.string().min(1),
  scope: z.enum(["turn_window", "phase", "request", "context_window", "task_total"]),
  unit: z.enum(["count", "tokens", "milliseconds", "ratio", "generation"]),
  current: z.number().nonnegative().nullable(),
  limit: z.number().positive().nullable(),
  cumulative: z.number().nonnegative().nullable(),
  state: z.enum(["normal", "warning", "exhausted", "resetting", "fixed"]),
  blocking: z.boolean(),
  resettable: z.boolean(),
  resetMode: z.enum(["new_window", "new_phase_window", "new_attempt_window", "provider_fixed"]),
  resetGeneration: z.number().int().nonnegative(),
  lastResetAt: z.number().int().nonnegative().nullable(),
  description: z.string().min(1),
})
export type RuntimeMetric = z.infer<typeof runtimeMetricSchema>

export const runtimeMetricsSnapshotSchema = z.object({
  taskId: z.string().min(1),
  capturedAtMs: z.number().int().nonnegative(),
  metrics: z.array(runtimeMetricSchema),
})
export type RuntimeMetricsSnapshot = z.infer<typeof runtimeMetricsSnapshotSchema>
