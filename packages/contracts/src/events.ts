import { z } from "zod"

import { budgetUsageSchema, kvCacheUsageSchema } from "./budgets.js"
import { aiPhaseSchema, visibilitySchema } from "./common.js"
import { backendErrorSchema } from "./errors.js"
import { idSchema } from "./ids.js"
import { workspaceOperationSchema } from "./workspace.js"

export const backendEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task.phase.changed"), taskId: idSchema, phase: aiPhaseSchema, status: z.string() }),
  z.object({ type: z.literal("task.budget.updated"), taskId: idSchema, usage: budgetUsageSchema }),
  z.object({ type: z.literal("task.cache.updated"), taskId: idSchema, usage: kvCacheUsageSchema }),
  z.object({ type: z.literal("operation.progress"), operation: workspaceOperationSchema }),
  z.object({ type: z.literal("chapter.visibility.changed"), chapterId: idSchema, visibility: visibilitySchema }),
  z.object({ type: z.literal("graph.scope.changed"), scopeId: idSchema, visibility: visibilitySchema }),
  z.object({ type: z.literal("retrieval.completed"), taskId: idSchema, candidateCount: z.number().int().nonnegative() }),
  z.object({ type: z.literal("task.failed"), taskId: idSchema, error: backendErrorSchema }),
])
export type BackendEvent = z.infer<typeof backendEventSchema>
