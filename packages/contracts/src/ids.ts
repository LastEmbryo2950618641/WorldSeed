import { z } from "zod"

export const idSchema = z.uuid()

export type Id = z.infer<typeof idSchema>
export type ProjectId = Id
export type TaskId = Id
export type TurnId = Id
export type ScopeId = Id
export type RevisionId = Id
export type SourceId = Id
