import type { Evidence, ProjectId } from "@worldseed/contracts"

export type EvidenceWriteInput = Readonly<{
  evidenceId: string
  projectId: ProjectId
  contextId?: string
  sourceKind: Evidence["sourceKind"]
  ownerId: string
  version: string
  digest: string
  locator: string
  content: string
  readReason: string
  createdAtMs: number
}>

export interface EvidenceStore {
  writeImmutable(input: EvidenceWriteInput): Promise<Evidence>
  read(evidenceId: string): Promise<Evidence | undefined>
  listByContext(contextId: string): Promise<readonly Evidence[]>
}
