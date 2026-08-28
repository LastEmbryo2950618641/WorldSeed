import type { ProjectId } from "@worldseed/contracts"

import type {
  ProjectManifest,
  WorkspaceInventoryEntry,
  WorkspaceValidationIssue,
} from "../../../core/index.js"
import type { ProjectRepository } from "../../projects/index.js"

export type WorkspaceDefaultDocuments = Readonly<{
  baseRules: string
  plotSynopsisGuide: string
  settingsQueryGuide: string
  settingsRevisionGuide: string
  settingsReadme: string
  referencesReadme: string
  descriptionRules: string
  proseStyleRules: string
}>

export type WorkspaceValidationReport = Readonly<{
  workspaceRootRef: string
  inventory: readonly WorkspaceInventoryEntry[]
  issues: readonly WorkspaceValidationIssue[]
  baseRulesDigest: string
}>

export interface WorkspacePort {
  createLayout(workspaceRootRef: string, defaults: WorkspaceDefaultDocuments): Promise<WorkspaceValidationReport>
  /**
   * Idempotently materialize platform-owned fixed Markdown that may be missing on
   * older workspaces after a product upgrade (e.g. new base-rules guides).
   * Never overwrites existing files.
   */
  ensurePlatformDocuments(workspaceRootRef: string, defaults: WorkspaceDefaultDocuments): Promise<void>
  validate(workspaceRootRef: string): Promise<WorkspaceValidationReport>
  readMarkdown(workspaceRootRef: string, relativePath: string): Promise<string>
  saveUserMarkdown(workspaceRootRef: string, relativePath: string, content: string): Promise<void>
  saveSynopsisMarkdown(workspaceRootRef: string, relativePath: string, content: string): Promise<void>
  removeSynopsisMarkdown(workspaceRootRef: string, relativePath: string): Promise<void>
  publishChapter(workspaceRootRef: string, relativePath: string, content: string): Promise<void>
  replacePublishedChapter(
    workspaceRootRef: string,
    currentRelativePath: string,
    nextRelativePath: string,
    expectedDigest: string,
    content: string,
  ): Promise<void>
  importMarkdownFiles(workspaceRootRef: string, destination: string, sourcePaths: readonly string[]): Promise<number>
  importMarkdownFolder(workspaceRootRef: string, destination: string, sourceFolder: string): Promise<number>
}

export type InternalProjectStore = Readonly<{
  projectId: ProjectId
  internalStoreRef: string
  projectDatabaseRef: string
  documentsRef: string
  promptsRef: string
  externalContentRef: string
  indexesRef: string
  modelCacheRef: string
  recoveryRef: string
  historyGitRef: string
  historyCheckoutRef: string
  historyRecoveryRef: string
}>

export interface InternalStorePort {
  prepareProject(projectId: ProjectId, workspaceRootRef: string): Promise<InternalProjectStore>
  inspectProject(projectId: ProjectId, workspaceRootRef: string, internalStoreRef: string): Promise<InternalProjectStore>
  writeImmutableDocument(store: InternalProjectStore, sourceId: string, content: string): Promise<string>
  readDocument(contentRef: string): Promise<string>
}

export type ProjectRepositorySession = Readonly<{
  repository: ProjectRepository
  close: () => Promise<void>
}>

export interface ProjectRepositoryFactory {
  open(store: InternalProjectStore, workspaceRootRef: string): Promise<ProjectRepositorySession>
}

export type CreatedProject = Readonly<{
  manifest: ProjectManifest
  internalStore: InternalProjectStore
}>
