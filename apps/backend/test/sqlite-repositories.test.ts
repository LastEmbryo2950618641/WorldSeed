import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { defaultProjectSettings } from "@worldseed/config"

import {
  digest,
  fixedWorkspaceEntries,
  openProjectDatabase,
  openRegistryDatabase,
  SqliteDocumentRepository,
  SqliteGraphRepository,
  SqliteProjectRegistryRepository,
  SqliteProjectRepository,
  SqliteProjectSettingsStore,
  SqliteRetrievalRepository,
  SqliteScopeCommitRepository,
  SqliteTaskScopeRepository,
  type GraphRevision,
  type ProjectManifest,
} from "../src/index.js"

const ids = {
  project: "00000000-0000-4000-8000-000000000001",
  task1: "00000000-0000-4000-8000-000000000002",
  turn1: "00000000-0000-4000-8000-000000000003",
  scope1: "00000000-0000-4000-8000-000000000004",
  task2: "00000000-0000-4000-8000-000000000005",
  turn2: "00000000-0000-4000-8000-000000000006",
  scope2: "00000000-0000-4000-8000-000000000007",
  task3: "00000000-0000-4000-8000-000000000008",
  turn3: "00000000-0000-4000-8000-000000000009",
  scope3: "00000000-0000-4000-8000-000000000010",
  task4: "00000000-0000-4000-8000-000000000011",
  turn4: "00000000-0000-4000-8000-000000000012",
  scope4: "00000000-0000-4000-8000-000000000013",
  node1: "00000000-0000-4000-8000-000000000021",
  node2: "00000000-0000-4000-8000-000000000022",
  node3: "00000000-0000-4000-8000-000000000023",
  link1: "00000000-0000-4000-8000-000000000031",
  revision1: "00000000-0000-4000-8000-000000000041",
  revision2: "00000000-0000-4000-8000-000000000042",
  revision3: "00000000-0000-4000-8000-000000000043",
  revision4: "00000000-0000-4000-8000-000000000044",
  evidence: "00000000-0000-4000-8000-000000000051",
  document: "00000000-0000-4000-8000-000000000061",
  source: "00000000-0000-4000-8000-000000000062",
  chapter: "00000000-0000-4000-8000-000000000063",
  projection: "00000000-0000-4000-8000-000000000071",
}

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "worldseed-repository-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function graphRevision(
  revisionId: string,
  scopeId: string,
  targetKind: "node" | "link",
  targetId: string,
  after: GraphRevision["after"],
): GraphRevision {
  return {
    revisionId,
    scopeId,
    targetKind,
    targetId,
    operation: "create",
    before: null,
    after,
    archiveOutletIds: [],
    reason: "The staged artifact is supported by this turn",
    selfReview: "The mutation remains generic and discoverable",
    evidenceIds: [ids.evidence],
    createdAtMs: 100,
  }
}

describe("SQLite repository contract", () => {
  it("registers projects and resolves them by stable workspace identity", async () => {
    const directory = temporaryDirectory()
    const database = await openRegistryDatabase(join(directory, "registry.sqlite"))
    const repository = new SqliteProjectRegistryRepository(database)

    await repository.register({
      projectId: ids.project,
      workspaceRootRef: join(directory, "workspace"),
      internalStoreRef: join(directory, "internal"),
      lastOpenedAtMs: 10,
      createdAtMs: 5,
    })
    expect((await repository.findById(ids.project))?.workspaceRootRef).toBe(join(directory, "workspace"))
    expect((await repository.findByWorkspaceRoot(join(directory, "workspace")))?.projectId).toBe(ids.project)
    await repository.touch(ids.project, 20)
    expect((await repository.findById(ids.project))?.lastOpenedAtMs).toBe(20)
    await database.destroy()
  })

  it("persists project settings independently from the Markdown workspace", async () => {
    const directory = temporaryDirectory()
    const database = await openProjectDatabase(join(directory, "project-settings.sqlite"))
    const workspaceRootRef = join(directory, "workspace")
    const internalStoreRef = join(directory, "internal")
    const projectRepository = new SqliteProjectRepository(database, workspaceRootRef, internalStoreRef)
    const settingsStore = new SqliteProjectSettingsStore(database, () => 100)
    const manifest: ProjectManifest = {
      id: ids.project,
      protocolVersion: "worldseed.v1",
      manifestVersion: 1,
      displayName: "Settings Test",
      workspaceRootRef,
      fixedEntries: fixedWorkspaceEntries,
      internalStoreRef,
      manifestDigest: digest(fixedWorkspaceEntries),
    }
    await projectRepository.create({
      projectId: ids.project,
      name: "Settings Test",
      manifestVersion: 1,
      committedSequence: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
    }, manifest)

    expect(await settingsStore.read(ids.project)).toEqual(defaultProjectSettings)
    const saved = await settingsStore.save(ids.project, {
      ...defaultProjectSettings,
      graph: {
        ...defaultProjectSettings.graph,
        maxDirectOutDegree: 20,
        maxDirectInDegree: 18,
        mergeWarningThreshold: 14,
      },
    })

    expect(saved.graph.maxDirectOutDegree).toBe(20)
    expect((await settingsStore.read(ids.project)).graph).toMatchObject({
      maxDirectOutDegree: 20,
      maxDirectInDegree: 18,
      mergeWarningThreshold: 14,
    })
    await database.destroy()
  })

  it("isolates pending artifacts and promotes one complete scope", async () => {
    const directory = temporaryDirectory()
    const database = await openProjectDatabase(join(directory, "project.sqlite"))
    const workspaceRootRef = join(directory, "workspace")
    const internalStoreRef = join(directory, "internal")
    const projectRepository = new SqliteProjectRepository(database, workspaceRootRef, internalStoreRef)
    const scopeRepository = new SqliteTaskScopeRepository(database)
    const graphRepository = new SqliteGraphRepository(database)
    const documentRepository = new SqliteDocumentRepository(database)
    const retrievalRepository = new SqliteRetrievalRepository(database)
    const commitRepository = new SqliteScopeCommitRepository(database)
    const manifest: ProjectManifest = {
      id: ids.project,
      protocolVersion: "worldseed.v1",
      manifestVersion: 1,
      displayName: "Repository Test",
      workspaceRootRef,
      fixedEntries: fixedWorkspaceEntries,
      internalStoreRef,
      manifestDigest: digest(fixedWorkspaceEntries),
    }

    await projectRepository.create({
      projectId: ids.project,
      name: "Repository Test",
      manifestVersion: 1,
      committedSequence: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
    }, manifest)
    expect((await projectRepository.readManifest(ids.project))?.fixedEntries).toEqual(fixedWorkspaceEntries)
    await scopeRepository.create({
      projectId: ids.project,
      taskId: ids.task1,
      turnId: ids.turn1,
      scopeId: ids.scope1,
      kind: "turn",
      status: "created",
      reason: "Test one complete pending scope",
      configSnapshot: { maxCalls: 12 },
      promptSnapshot: { version: "v1" },
      createdAtMs: 10,
    })

    await graphRepository.stageRevisions(ids.project, ids.scope1, [
      graphRevision(ids.revision1, ids.scope1, "node", ids.node1, { id: ids.node1, content: { label: "anchor" } }),
      graphRevision(ids.revision2, ids.scope1, "node", ids.node2, { id: ids.node2, content: { label: "neighbor" } }),
      graphRevision(ids.revision3, ids.scope1, "link", ids.link1, {
        id: ids.link1,
        fromNodeId: ids.node1,
        toNodeId: ids.node2,
        content: { note: "local path" },
      }),
    ])
    await documentRepository.stageVersion({
      id: ids.document,
      projectId: ids.project,
      scopeId: ids.scope1,
      sourceId: ids.source,
      chapterId: ids.chapter,
      contentRef: "objects/documents/chapter.md",
      heading: "第一章 开始",
      publishPath: "章节正文/第一章 开始.md",
      digest: "document-digest",
      createdAtMs: 20,
    })
    await retrievalRepository.stageProjection({
      projectionId: ids.projection,
      projectId: ids.project,
      scopeId: ids.scope1,
      ownerKind: "node",
      ownerId: ids.node1,
      ownerRevisionId: ids.revision1,
      exactKeys: ["anchor-key"],
      semanticText: "old bridge anchor",
      sourceRefs: [],
      digest: "projection-digest",
    })
    await retrievalRepository.stageProjection({
      projectionId: "00000000-0000-4000-8000-000000000072",
      projectId: ids.project,
      scopeId: ids.scope1,
      ownerKind: "node",
      ownerId: ids.node2,
      ownerRevisionId: ids.revision2,
      exactKeys: ["旧桥"],
      semanticText: "北港商会与旧桥钥匙",
      sourceRefs: [],
      digest: "chinese-projection-digest",
    })

    expect(await graphRepository.getNode({ projectId: ids.project }, ids.node1)).toBeUndefined()
    expect((await graphRepository.getNode({ projectId: ids.project, pendingScopeId: ids.scope1 }, ids.node1))?.content)
      .toEqual({ label: "anchor" })
    expect(await documentRepository.listCommittedChapters(ids.project)).toEqual([])
    expect(await retrievalRepository.searchExact({ projectId: ids.project }, ["anchor-key"], 10)).toEqual([])
    expect(await retrievalRepository.searchText({ projectId: ids.project }, "bridge", 10)).toEqual([])
    expect(await retrievalRepository.searchExact(
      { projectId: ids.project, pendingScopeId: ids.scope1 },
      ["anchor-key"],
      10,
    )).toHaveLength(1)
    const pendingNeighborhood = await graphRepository.getNeighborhood({
      scope: { projectId: ids.project, pendingScopeId: ids.scope1 },
      anchorIds: [ids.node1],
      direction: "both",
      maxDepth: 2,
      maxNodes: 10,
      maxLinks: 10,
    })
    expect(pendingNeighborhood.nodes).toHaveLength(2)
    expect(pendingNeighborhood.links).toHaveLength(1)

    expect(await commitRepository.commit(ids.scope1)).toEqual({
      projectId: ids.project,
      scopeId: ids.scope1,
      committedSequence: 1,
    })
    expect((await graphRepository.getNode({ projectId: ids.project }, ids.node1))?.content).toEqual({ label: "anchor" })
    expect(await documentRepository.listCommittedChapters(ids.project)).toHaveLength(1)
    expect(await retrievalRepository.searchExact({ projectId: ids.project }, ["anchor-key"], 10)).toHaveLength(1)
    expect(await retrievalRepository.searchText({ projectId: ids.project }, "bridge", 10)).toHaveLength(1)
    expect(await retrievalRepository.searchText({ projectId: ids.project }, "旧桥", 10)).toHaveLength(1)
    expect(await retrievalRepository.searchText({ projectId: ids.project }, "旧桥钥匙现在位于哪里", 10)).toHaveLength(1)
    expect(await graphRepository.listRevisions(ids.project, "node", ids.node1)).toHaveLength(1)

    await scopeRepository.create({
      projectId: ids.project,
      taskId: ids.task2,
      turnId: ids.turn2,
      scopeId: ids.scope2,
      kind: "turn",
      status: "created",
      reason: "First concurrent scope",
      configSnapshot: {},
      promptSnapshot: {},
      createdAtMs: 30,
    })
    await scopeRepository.create({
      projectId: ids.project,
      taskId: ids.task3,
      turnId: ids.turn3,
      scopeId: ids.scope3,
      kind: "turn",
      status: "created",
      reason: "Second concurrent scope",
      configSnapshot: {},
      promptSnapshot: {},
      createdAtMs: 31,
    })
    await commitRepository.commit(ids.scope2)
    await expect(commitRepository.commit(ids.scope3)).rejects.toThrow("stale committed sequence")

    await scopeRepository.create({
      projectId: ids.project,
      taskId: ids.task4,
      turnId: ids.turn4,
      scopeId: ids.scope4,
      kind: "turn",
      status: "created",
      reason: "Retired scope",
      configSnapshot: {},
      promptSnapshot: {},
      createdAtMs: 40,
    })
    await graphRepository.stageRevisions(ids.project, ids.scope4, [
      graphRevision(ids.revision4, ids.scope4, "node", ids.node3, { id: ids.node3, content: "retired" }),
    ])
    await commitRepository.retire(ids.scope4, 50)
    expect(await graphRepository.getNode({ projectId: ids.project, pendingScopeId: ids.scope4 }, ids.node3)).toBeUndefined()
    expect(await graphRepository.getNode({ projectId: ids.project }, ids.node3)).toBeUndefined()
    expect((await scopeRepository.findScope(ids.scope4))?.visibility).toBe("retired")
    await database.destroy()
  })
})
