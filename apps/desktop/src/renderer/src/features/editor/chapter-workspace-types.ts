import type { ChapterRevision } from "@worldseed/contracts"

export type RevisionStage = "idle" | "reviewing" | "reviewed" | "submitted"
export type ChapterDocumentPane = "committed" | "draft"

export function isChapterGraphSyncBlocking(
  revision: Pick<ChapterRevision, "decision" | "graphSyncStatus"> | undefined,
): boolean {
  if (revision?.decision !== "submit") return false
  return revision.graphSyncStatus === "pending"
    || revision.graphSyncStatus === "running"
    || revision.graphSyncStatus === "failed"
}

export function shouldAutoEnsureChapterRevision(
  revision: Pick<ChapterRevision, "status"> | undefined,
): boolean {
  return revision === undefined
}

export function isChapterRevisionWritable(
  revision: Pick<ChapterRevision, "status"> | undefined,
): boolean {
  if (revision === undefined) return true
  return revision.status === "editing"
    || revision.status === "ready_to_submit"
    || revision.status === "awaiting_user_decision"
}
