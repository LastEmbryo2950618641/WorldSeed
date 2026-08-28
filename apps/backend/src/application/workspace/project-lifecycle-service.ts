import { PROTOCOL_VERSION, type ProjectId } from "@worldseed/contracts"

import {
  PROJECT_MANIFEST_VERSION,
  digest,
  fixedWorkspaceEntries,
  type ProjectManifest,
} from "../../core/index.js"
import type { ProjectRegistryRepository, StoredProject } from "../projects/index.js"
import type {
  CreatedProject,
  InternalStorePort,
  ProjectRepositoryFactory,
  WorkspaceDefaultDocuments,
  WorkspacePort,
} from "./ports/index.js"

export type CreateProjectInput = Readonly<{
  projectId: ProjectId
  displayName: string
  workspaceRootRef: string
  defaults: WorkspaceDefaultDocuments
  nowMs: number
}>

export class ProjectLifecycleError extends Error {
  public constructor(
    public readonly code: "workspace_invalid" | "manifest_mismatch" | "project_not_registered",
    message: string,
  ) {
    super(message)
  }
}

export class ProjectLifecycleService {
  public constructor(
    private readonly registry: ProjectRegistryRepository,
    private readonly workspace: WorkspacePort,
    private readonly internalStore: InternalStorePort,
    private readonly projectRepositories: ProjectRepositoryFactory,
  ) {}

  public async create(input: CreateProjectInput): Promise<CreatedProject> {
    const workspaceReport = await this.workspace.createLayout(input.workspaceRootRef, input.defaults)
    assertWorkspaceReport(workspaceReport.issues)
    const store = await this.internalStore.prepareProject(input.projectId, workspaceReport.workspaceRootRef)
    const manifest = createManifest(input, workspaceReport.workspaceRootRef, store.internalStoreRef, workspaceReport.baseRulesDigest)
    const project: StoredProject = {
      projectId: input.projectId,
      name: input.displayName,
      manifestVersion: PROJECT_MANIFEST_VERSION,
      committedSequence: 0,
      createdAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
    }
    const session = await this.projectRepositories.open(store, workspaceReport.workspaceRootRef)
    try {
      await session.repository.create(project, manifest)
    } finally {
      await session.close()
    }
    await this.registry.register({
      projectId: input.projectId,
      workspaceRootRef: workspaceReport.workspaceRootRef,
      internalStoreRef: store.internalStoreRef,
      lastOpenedAtMs: input.nowMs,
      createdAtMs: input.nowMs,
    })
    return { manifest, internalStore: store }
  }

  public async openByWorkspace(
    workspaceRootRef: string,
    nowMs: number,
    defaults: WorkspaceDefaultDocuments,
  ): Promise<CreatedProject> {
    await this.workspace.ensurePlatformDocuments(workspaceRootRef, defaults)
    const workspaceReport = await this.workspace.validate(workspaceRootRef)
    assertWorkspaceReport(workspaceReport.issues)
    const registered = await this.registry.findByWorkspaceRoot(workspaceReport.workspaceRootRef)
    if (registered === undefined) {
      throw new ProjectLifecycleError("project_not_registered", "The workspace is not registered on this device")
    }
    const store = await this.internalStore.inspectProject(
      registered.projectId,
      workspaceReport.workspaceRootRef,
      registered.internalStoreRef,
    )
    const session = await this.projectRepositories.open(store, workspaceReport.workspaceRootRef)
    try {
      const manifest = await session.repository.readManifest(registered.projectId)
      if (manifest === undefined) {
        throw new ProjectLifecycleError("manifest_mismatch", "The internal project manifest is missing")
      }
      const digestInput = {
        projectId: registered.projectId,
        displayName: manifest.displayName,
        workspaceRootRef: workspaceReport.workspaceRootRef,
        internalStoreRef: store.internalStoreRef,
        baseRulesDigest: workspaceReport.baseRulesDigest,
      }
      const expectedDigest = calculateManifestDigest(digestInput)
      let resolvedManifest = manifest
      if (manifest.manifestDigest !== expectedDigest) {
        const legacyDigest = calculateManifestDigest(digestInput, manifest.fixedEntries)
        if (legacyDigest !== manifest.manifestDigest) {
          throw new ProjectLifecycleError("manifest_mismatch", "The workspace or platform base rules no longer match the project manifest")
        }
        resolvedManifest = {
          ...manifest,
          fixedEntries: fixedWorkspaceEntries,
          manifestDigest: expectedDigest,
        }
        await session.repository.reconcileManifest(resolvedManifest, nowMs)
      }
      await this.registry.touch(registered.projectId, nowMs)
      return { manifest: resolvedManifest, internalStore: store }
    } finally {
      await session.close()
    }
  }
}

function createManifest(
  input: CreateProjectInput,
  workspaceRootRef: string,
  internalStoreRef: string,
  baseRulesDigest: string,
): ProjectManifest {
  return {
    id: input.projectId,
    protocolVersion: PROTOCOL_VERSION,
    manifestVersion: PROJECT_MANIFEST_VERSION,
    displayName: input.displayName,
    workspaceRootRef,
    fixedEntries: fixedWorkspaceEntries,
    internalStoreRef,
    manifestDigest: calculateManifestDigest({
      projectId: input.projectId,
      displayName: input.displayName,
      workspaceRootRef,
      internalStoreRef,
      baseRulesDigest,
    }),
  }
}

type ManifestDigestInput = Readonly<{
  projectId: ProjectId
  displayName: string
  workspaceRootRef: string
  internalStoreRef: string
  baseRulesDigest: string
}>

function calculateManifestDigest(
  input: ManifestDigestInput,
  fixedEntries: ProjectManifest["fixedEntries"] = fixedWorkspaceEntries,
): string {
  return digest({
    protocolVersion: PROTOCOL_VERSION,
    manifestVersion: PROJECT_MANIFEST_VERSION,
    fixedEntries,
    ...input,
  })
}

function assertWorkspaceReport(issues: readonly { path?: string; message: string }[]): void {
  if (issues.length > 0) {
    throw new ProjectLifecycleError(
      "workspace_invalid",
      issues.map((issue) => (issue.path === undefined || issue.path.length === 0
        ? issue.message
        : `${issue.message}: ${issue.path}`)).join("; "),
    )
  }
}
