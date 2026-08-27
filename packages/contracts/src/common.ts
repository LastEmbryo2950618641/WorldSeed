import { z } from "zod"

export const visibilityValues = ["pending", "committed", "retired"] as const
export const visibilitySchema = z.enum(visibilityValues)
export type Visibility = z.infer<typeof visibilitySchema>

export const taskKindValues = ["turn", "query", "evolution", "revision", "workspace"] as const
export const taskKindSchema = z.enum(taskKindValues)
export type TaskKind = z.infer<typeof taskKindSchema>

export const taskStatusValues = [
  "created",
  "running",
  "waiting_for_read",
  "waiting_for_model",
  "waiting_for_review",
  "committing",
  "needs_revision",
  "awaiting_user_decision",
  "paused",
  "completed",
  "retired",
  "failed",
  "cancelled",
] as const
export const taskStatusSchema = z.enum(taskStatusValues)
export type TaskStatus = z.infer<typeof taskStatusSchema>

export const aiPhaseValues = [
  "interpret",
  "rule_assembly",
  "source_retrieval",
  "emergence_planning",
  "emergence_review",
  "draft",
  "chapter_naming",
  "dependency_audit",
  "response_review",
  "graph_governance",
  "graph_structure_plan",
  "graph_capacity_rewrite",
  "graph_spacetime_settlement",
  "graph_retrieval_design",
  "graph_governance_review",
  "semantic_review",
  "settlement_review",
  "frontier_settlement",
  "commit_review",
  "revision_review",
  "revision_assist",
  "synopsis_discuss",
] as const
export const aiPhaseSchema = z.enum(aiPhaseValues)
export type AIPhase = z.infer<typeof aiPhaseSchema>
