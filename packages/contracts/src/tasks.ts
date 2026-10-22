import { z } from "zod"

import { taskKindSchema, taskStatusSchema } from "./common.js"
import { idSchema } from "./ids.js"

export const taskHandleSchema = z.object({
  taskId: idSchema,
  projectId: idSchema,
  kind: taskKindSchema,
  status: taskStatusSchema,
})
export type TaskHandle = z.infer<typeof taskHandleSchema>

export type DeductionTask = Readonly<{
  taskId: string
  heading: string
  chapterSequence?: number
  status: string
  canCancel: boolean
  canRetry: boolean
  error?: string
  updatedAtMs: number
  progress: Readonly<{
    completed: number
    total: number | null
    phase?: string
    phases: readonly Readonly<{ phase: string; status: string; attempt: number }>[]
  }>
}>
