export type WorkspaceSnapshotFile = Readonly<{
  relativePath: string
  gitPath: string
  content: string
  digest: string
  size: number
}>

export type WorkspaceSnapshot = Readonly<{
  baseRulesDigest: string
  files: readonly WorkspaceSnapshotFile[]
}>

export interface WorkspaceSnapshotPort {
  capture(workspaceRootRef: string): Promise<WorkspaceSnapshot>
  restore(workspaceRootRef: string, snapshot: WorkspaceSnapshot): Promise<void>
}
