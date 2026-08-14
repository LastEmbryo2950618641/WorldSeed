import type { HistoryManifest } from "@worldseed/contracts"

export type HistorySnapshotFile = Readonly<{
  gitPath: string
  content: string
}>

export type WriteHistorySnapshotInput = Readonly<{
  manifest: HistoryManifest
  files: readonly HistorySnapshotFile[]
  parentCommitOid?: string
}>

export type HistorySnapshot = Readonly<{
  commitOid: string
  parentCommitOids: readonly string[]
  manifest: HistoryManifest
  files: readonly HistorySnapshotFile[]
}>

export interface HistoryVcsPort {
  writeSnapshot(input: WriteHistorySnapshotInput): Promise<string>
  readSnapshot(commitOid: string): Promise<HistorySnapshot>
}
