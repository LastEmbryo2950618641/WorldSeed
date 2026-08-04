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
