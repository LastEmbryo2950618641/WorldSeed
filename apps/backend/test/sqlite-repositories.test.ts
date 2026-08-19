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
  node4: "00000000-0000-4000-8000-000000000024",
  link1: "00000000-0000-4000-8000-000000000031",
  revision1: "00000000-0000-4000-8000-000000000041",
  revision2: "00000000-0000-4000-8000-000000000042",
  revision3: "00000000-0000-4000-8000-000000000043",
  revision4: "00000000-0000-4000-8000-000000000044",
  revision5: "00000000-0000-4000-8000-000000000045",
  evidence: "00000000-0000-4000-8000-000000000051",
  document: "00000000-0000-4000-8000-000000000061",
  source: "00000000-0000-4000-8000-000000000062",
  chapter: "00000000-0000-4000-8000-000000000063",
  projection: "00000000-0000-4000-8000-000000000071",
  projection2: "00000000-0000-4000-8000-000000000073",
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

function testId(index: number): string {
  return `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`
}

async function createPendingRetrievalFixture() {
  const directory = temporaryDirectory()
  const database = await openProjectDatabase(join(directory, "pending-retrieval.sqlite"))
  const projectId = testId(900)
  const scopeId = testId(901)
  const projectRepository = new SqliteProjectRepository(
    database,
    join(directory, "workspace"),
    join(directory, "internal"),
  )
  const manifest: ProjectManifest = {
    id: projectId,
    protocolVersion: "worldseed.v1",
    manifestVersion: 1,
    displayName: "Pending Retrieval",
    workspaceRootRef: join(directory, "workspace"),
    fixedEntries: fixedWorkspaceEntries,
    internalStoreRef: join(directory, "internal"),
    manifestDigest: digest(fixedWorkspaceEntries),
  }
  await projectRepository.create({
    projectId,
    name: manifest.displayName,
    manifestVersion: 1,
    committedSequence: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  }, manifest)
  await new SqliteTaskScopeRepository(database).create({
    projectId,
    taskId: testId(902),
    turnId: testId(903),
    scopeId,
    kind: "turn",
    status: "created",
    reason: "Exercise pending retrieval idempotency",
    configSnapshot: {},
    promptSnapshot: {},
    createdAtMs: 2,
  })
  return {
    database,
    projectId,
    scopeId,
    repository: new SqliteRetrievalRepository(database),
  }
}

describe("SQLite repository contract", () => {
  it("reuses an identical pending projection during resumed finalization", async () => {
    const fixture = await createPendingRetrievalFixture()
    const input = {
      projectionId: testId(904),
      projectId: fixture.projectId,
      scopeId: fixture.scopeId,
      ownerKind: "node",
      ownerId: "node_26",
      ownerRevisionId: "revision_1091",
      exactKeys: ["旅人", "七点整"],
      semanticText: "旅人七点整后接近雾港。",
      sourceRefs: [{ sourceId: "source_98" }],
      digest: "canonical-projection-digest",
    }

    const first = await fixture.repository.stageProjection(input)
    const resumed = await fixture.repository.stageProjection({
      ...input,
      projectionId: testId(905),
    })
    const rows = await fixture.database.selectFrom("retrieval_projections").selectAll().execute()
    const exactKeys = await fixture.database.selectFrom("retrieval_exact_keys").selectAll().execute()
    await fixture.database.destroy()

    expect(resumed.projectionId).toBe(first.projectionId)
    expect(rows).toHaveLength(1)
    expect(exactKeys).toHaveLength(2)
  })

  it("rejects different pending projection content for one canonical owner revision", async () => {
    const fixture = await createPendingRetrievalFixture()
    const input = {
      projectionId: testId(906),
      projectId: fixture.projectId,
      scopeId: fixture.scopeId,
      ownerKind: "node",
      ownerId: "node_26",
      ownerRevisionId: "revision_1091",
      exactKeys: ["旅人"],
      semanticText: "旅人仍在柳渡。",
      sourceRefs: [{ sourceId: "source_98" }],
      digest: "first-projection-digest",
    }
    await fixture.repository.stageProjection(input)

    await expect(fixture.repository.stageProjection({
      ...input,
      projectionId: testId(907),
      semanticText: "旅人已经抵达雾港。",
      digest: "conflicting-projection-digest",
    })).rejects.toThrow("Pending retrieval projection conflicts with canonical owner revision")
    await fixture.database.destroy()
  })

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
    const sourceUnitIds = [
      "00000000-0000-4000-8000-000000000081",
      "00000000-0000-4000-8000-000000000082",
      "00000000-0000-4000-8000-000000000083",
    ]
    await documentRepository.stageSourceUnits(sourceUnitIds.map((sourceUnitId, sequence) => ({
      id: sourceUnitId,
      projectId: ids.project,
      sourceId: ids.source,
      sequence,
      contentRef: `objects/documents/${sourceUnitId}.md`,
      digest: `source-unit-${String(sequence)}`,
      createdAtMs: 20,
    })))
    await retrievalRepository.stageProjection({
      projectionId: "00000000-0000-4000-8000-000000000084",
      projectId: ids.project,
      scopeId: ids.scope1,
      ownerKind: "source",
      ownerId: sourceUnitIds[0],
      ownerRevisionId: sourceUnitIds[0],
      exactKeys: ["第二章 晨雾里的旧桥"],
      semanticText: "第二章 晨雾里的旧桥",
      sourceRefs: [{ sourceId: ids.source, sourceUnitId: sourceUnitIds[0], sequence: 0 }],
      digest: "source-heading-digest",
    })
    await retrievalRepository.stageProjection({
      projectionId: "00000000-0000-4000-8000-000000000085",
      projectId: ids.project,
      scopeId: ids.scope1,
      ownerKind: "source",
      ownerId: sourceUnitIds[1],
      ownerRevisionId: sourceUnitIds[1],
      exactKeys: ["林序和苏禾在桥头交谈。"],
      semanticText: "林序和苏禾在桥头交谈，雨水沿着破损的落水管倾泻而下，砸在石阶上溅起水花。",
      sourceRefs: [{ sourceId: ids.source, sourceUnitId: sourceUnitIds[1], sequence: 1 }],
      digest: "source-dialogue-digest",
    })
    await retrievalRepository.stageProjection({
      projectionId: "00000000-0000-4000-8000-000000000086",
      projectId: ids.project,
      scopeId: ids.scope1,
      ownerKind: "source",
      ownerId: sourceUnitIds[2],
      ownerRevisionId: sourceUnitIds[2],
      exactKeys: ["其他内容。"],
      semanticText: "其他内容。",
      sourceRefs: [{ sourceId: ids.source, sourceUnitId: sourceUnitIds[2], sequence: 2 }],
      digest: "source-other-digest",
    })
    await retrievalRepository.stageProjection({
      projectionId: ids.projection,
      projectId: ids.project,
      scopeId: ids.scope1,
      ownerKind: "node",
      ownerId: ids.node1,
      ownerRevisionId: ids.revision1,
      exactKeys: ["anchor-key", "historical-only-key"],
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
      exactKeys: ["旧桥", "跨节点当前状态"],
      semanticText: "北港商会与旧桥钥匙",
      sourceRefs: [],
      digest: "chinese-projection-digest",
    })

    expect(await retrievalRepository.findForOwnerRevision(
      ids.project,
      "node",
      ids.node1,
      ids.revision1,
    )).toMatchObject({
      ownerId: ids.node1,
      ownerRevisionId: ids.revision1,
      exactKeys: ["anchor-key", "historical-only-key"],
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
    expect(await graphRepository.getDegreeProfile({
      projectId: ids.project,
      pendingScopeId: ids.scope1,
    })).toEqual({
      nodeCount: 2,
      linkCount: 1,
      entries: [
        { nodeId: ids.node1, inDegree: 0, outDegree: 1 },
        { nodeId: ids.node2, inDegree: 1, outDegree: 0 },
      ],
    })

    expect(await commitRepository.commit(ids.scope1)).toEqual({
      projectId: ids.project,
      scopeId: ids.scope1,
      committedSequence: 1,
    })
    expect(await database.selectFrom("active_scope_refs").selectAll().execute()).toEqual([{
      project_id: ids.project,
      scope_id: ids.scope1,
    }])
    expect(await database.selectFrom("active_document_heads").selectAll().execute()).toEqual([{
      project_id: ids.project,
      chapter_id: ids.chapter,
      document_version_id: ids.document,
      scope_id: ids.scope1,
    }])
    expect((await graphRepository.getNode({ projectId: ids.project }, ids.node1))?.content).toEqual({ label: "anchor" })
    expect(await documentRepository.listCommittedChapters(ids.project)).toHaveLength(1)
    expect(await retrievalRepository.searchExact({ projectId: ids.project }, ["anchor-key"], 10)).toHaveLength(1)
    const exactSourceHeading = await retrievalRepository.searchExact(
      { projectId: ids.project },
      ["第二章 晨雾里的旧桥"],
      10,
    )
    expect(exactSourceHeading[0]?.sourcePosition).toMatchObject({
      sourceRef: ids.source,
      sequence: 0,
      isStart: true,
      isEnd: false,
    })
    expect(await retrievalRepository.searchText({ projectId: ids.project }, "bridge", 10)).toHaveLength(1)
    expect(await retrievalRepository.searchText({ projectId: ids.project }, "旧桥", 10)).toHaveLength(2)
    expect(await retrievalRepository.searchText({ projectId: ids.project }, "旧桥钥匙现在位于哪里", 10)).toHaveLength(1)
    expect((await retrievalRepository.searchText({ projectId: ids.project }, "苏禾 林序 关系", 10))
      .some((projection) => projection.ownerId === sourceUnitIds[1])).toBe(true)
    const sourceMatches = await retrievalRepository.searchSourceText(
      { projectId: ids.project },
      "林序和苏禾在桥头交谈",
      10,
      [ids.source],
    )
    expect(sourceMatches.map((projection) => projection.ownerId)).toContain(sourceUnitIds[1])
    expect(sourceMatches.every((projection) => projection.ownerKind === "source")).toBe(true)
    expect(sourceMatches.find((projection) => projection.ownerId === sourceUnitIds[1])?.sourcePosition).toEqual({
      sourceRef: ids.source,
      sequence: 1,
      firstSequence: 0,
      lastSequence: 2,
      unitCount: 3,
      isStart: false,
      isEnd: false,
    })
    expect((await retrievalRepository.searchSourceText(
      { projectId: ids.project },
      "苏禾 林序 关系",
      10,
      [ids.source],
    )).map((projection) => projection.ownerId)).toContain(sourceUnitIds[1])
    expect((await retrievalRepository.searchSourceText(
      { projectId: ids.project },
      "水沿着破损的落水管倾泻而下，砸在石阶上",
      10,
      [ids.source],
    )).map((projection) => projection.ownerId)).toContain(sourceUnitIds[1])
    const sourceNeighborhood = await retrievalRepository.expandSourceNeighborhood(
      { projectId: ids.project },
      [{ sourceId: ids.source, sequence: 1 }],
      1,
      10,
    )
    expect(sourceNeighborhood.map((projection) => projection.ownerId)).toEqual(sourceUnitIds)
    expect(sourceNeighborhood.map((projection) => projection.sourcePosition?.isEnd)).toEqual([false, false, true])
    const sourceEnding = await retrievalRepository.readSourceBoundary(
      { projectId: ids.project },
      [ids.source],
      "end",
      2,
    )
    expect(sourceEnding.map((projection) => projection.ownerId)).toEqual(sourceUnitIds.slice(1))
    expect(sourceEnding.at(-1)?.sourcePosition?.isEnd).toBe(true)
    expect(await graphRepository.listRevisions(ids.project, "node", ids.node1)).toHaveLength(1)

    await database.deleteFrom("active_document_heads").where("project_id", "=", ids.project).execute()
    await database.deleteFrom("active_scope_refs").where("project_id", "=", ids.project).execute()
    expect(await documentRepository.listCommittedChapters(ids.project)).toEqual([])
    expect(await retrievalRepository.searchExact({ projectId: ids.project }, ["anchor-key"], 10)).toEqual([])
    expect(await retrievalRepository.searchText({ projectId: ids.project }, "bridge", 10)).toEqual([])
    expect(await graphRepository.listRevisions(ids.project, "node", ids.node1)).toEqual([])
    await database.insertInto("active_scope_refs").values({ project_id: ids.project, scope_id: ids.scope1 }).execute()
    await database.insertInto("active_document_heads").values({
      project_id: ids.project,
      chapter_id: ids.chapter,
      document_version_id: ids.document,
      scope_id: ids.scope1,
    }).execute()

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
    await graphRepository.stageRevisions(ids.project, ids.scope2, [
      graphRevision(ids.revision5, ids.scope2, "node", ids.node1, { id: ids.node1, content: { label: "updated anchor" } }),
      graphRevision("00000000-0000-4000-8000-000000000047", ids.scope2, "node", ids.node4, { id: ids.node4, content: { label: "new endpoint" } }),
      {
        revisionId: "00000000-0000-4000-8000-000000000046",
        scopeId: ids.scope2,
        targetKind: "link",
        targetId: ids.link1,
        operation: "edit",
        before: { id: ids.link1, fromNodeId: ids.node1, toNodeId: ids.node2 },
        after: { id: ids.link1, fromNodeId: ids.node1, toNodeId: ids.node4 },
        archiveOutletIds: [],
        reason: "Move the generic link to the new endpoint",
        selfReview: "The pending overlay contains one current link head",
        evidenceIds: [ids.evidence],
        createdAtMs: 100,
      },
    ])
    expect(await graphRepository.getDegreeProfile({
      projectId: ids.project,
      pendingScopeId: ids.scope2,
    })).toEqual({
      nodeCount: 3,
      linkCount: 1,
      entries: [
        { nodeId: ids.node1, inDegree: 0, outDegree: 1 },
        { nodeId: ids.node4, inDegree: 1, outDegree: 0 },
        { nodeId: ids.node2, inDegree: 0, outDegree: 0 },
      ],
    })
    await retrievalRepository.stageProjection({
      projectionId: ids.projection2,
      projectId: ids.project,
      scopeId: ids.scope2,
      ownerKind: "node",
      ownerId: ids.node1,
      ownerRevisionId: ids.revision5,
      exactKeys: ["anchor-key"],
      semanticText: "new bridge anchor",
      sourceRefs: [],
      digest: "new-projection-digest",
    })
    await retrievalRepository.stageProjection({
      projectionId: "00000000-0000-4000-8000-000000000074",
      projectId: ids.project,
      scopeId: ids.scope2,
      ownerKind: "node",
      ownerId: ids.node4,
      ownerRevisionId: "00000000-0000-4000-8000-000000000047",
      exactKeys: ["跨节点当前状态"],
      semanticText: "later current state on another owner",
      sourceRefs: [],
      digest: "later-cross-owner-projection-digest",
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
    const crossOwnerCurrent = await retrievalRepository.searchExact(
      { projectId: ids.project },
      ["跨节点当前状态"],
      10,
    )
    expect(crossOwnerCurrent.map((projection) => ({
      ownerId: projection.ownerId,
      stateRole: projection.stateRole,
      committedSequence: projection.committedSequence,
    }))).toEqual([
      { ownerId: ids.node4, stateRole: "current", committedSequence: 2 },
      { ownerId: ids.node2, stateRole: "current", committedSequence: 1 },
    ])
    const currentFirst = await retrievalRepository.searchExact({ projectId: ids.project }, ["anchor-key"], 1)
    expect(currentFirst).toHaveLength(1)
    expect(currentFirst[0]).toMatchObject({
      projectionId: ids.projection2,
      ownerRevisionId: ids.revision5,
    })
    const history = await retrievalRepository.searchExact({ projectId: ids.project }, ["anchor-key"], 10)
    expect(history.map((projection) => projection.projectionId)).toEqual([ids.projection2, ids.projection])
    const historicalClosure = await retrievalRepository.searchExact(
      { projectId: ids.project },
      ["historical-only-key"],
      10,
    )
    expect(historicalClosure.map((projection) => ({
      projectionId: projection.projectionId,
      stateRole: projection.stateRole,
    }))).toEqual([
      { projectionId: ids.projection2, stateRole: "current" },
      { projectionId: ids.projection, stateRole: "historical" },
    ])
    expect((await retrievalRepository.searchText({ projectId: ids.project }, "bridge", 1))[0]).toMatchObject({
      projectionId: ids.projection2,
      ownerRevisionId: ids.revision5,
    })
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
    await database.updateTable("projects").set({ active_generation: 1 }).where("id", "=", ids.project).execute()
    await expect(scopeRepository.assertCurrentGeneration(ids.scope4)).rejects.toThrow("inactive history generation")
    await expect(commitRepository.commit(ids.scope4)).rejects.toThrow("stale active generation")
    await commitRepository.retire(ids.scope4, 50)
    expect(await graphRepository.getNode({ projectId: ids.project, pendingScopeId: ids.scope4 }, ids.node3)).toBeUndefined()
    expect(await graphRepository.getNode({ projectId: ids.project }, ids.node3)).toBeUndefined()
    expect((await scopeRepository.findScope(ids.scope4))?.visibility).toBe("retired")
    await database.destroy()
  })

  it("keeps a strong historical fact beside its current owner when short current matches fill the limit", async () => {
    const directory = temporaryDirectory()
    const database = await openProjectDatabase(join(directory, "historical-fact-retrieval.sqlite"))
    const projectId = testId(100)
    const firstScopeId = testId(101)
    const secondScopeId = testId(102)
    const targetNodeId = testId(103)
    const projectRepository = new SqliteProjectRepository(
      database,
      join(directory, "workspace"),
      join(directory, "internal"),
    )
    const scopeRepository = new SqliteTaskScopeRepository(database)
    const graphRepository = new SqliteGraphRepository(database)
    const retrievalRepository = new SqliteRetrievalRepository(database)
    const commitRepository = new SqliteScopeCommitRepository(database)
    const manifest: ProjectManifest = {
      id: projectId,
      protocolVersion: "worldseed.v1",
      manifestVersion: 1,
      displayName: "Historical Fact Retrieval",
      workspaceRootRef: join(directory, "workspace"),
      fixedEntries: fixedWorkspaceEntries,
      internalStoreRef: join(directory, "internal"),
      manifestDigest: digest(fixedWorkspaceEntries),
    }
    await projectRepository.create({
      projectId,
      name: manifest.displayName,
      manifestVersion: 1,
      committedSequence: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
    }, manifest)
    await scopeRepository.create({
      projectId,
      taskId: testId(104),
      turnId: testId(105),
      scopeId: firstScopeId,
      kind: "turn",
      status: "created",
      reason: "Create historical fact retrieval fixture",
      configSnapshot: {},
      promptSnapshot: {},
      createdAtMs: 10,
    })

    const distractorNodeIds = Array.from({ length: 8 }, (_, index) => testId(120 + index))
    await graphRepository.stageRevisions(projectId, firstScopeId, [
      graphRevision(testId(140), firstScopeId, "node", targetNodeId, {
        id: targetNodeId,
        content: { state: "旅人清晨持有三张车票" },
      }),
      ...distractorNodeIds.map((nodeId, index) => graphRevision(testId(150 + index), firstScopeId, "node", nodeId, {
        id: nodeId,
        content: { state: `旅人清晨持有普通物件${String(index)}` },
      })),
    ])
    await retrievalRepository.stageProjection({
      projectionId: testId(160),
      projectId,
      scopeId: firstScopeId,
      ownerKind: "node",
      ownerId: targetNodeId,
      ownerRevisionId: testId(140),
      exactKeys: [],
      semanticText: "旅人清晨持有三张车票",
      sourceRefs: [],
      digest: "historical-target",
    })
    for (const [index, nodeId] of distractorNodeIds.entries()) {
      await retrievalRepository.stageProjection({
        projectionId: testId(170 + index),
        projectId,
        scopeId: firstScopeId,
        ownerKind: "node",
        ownerId: nodeId,
        ownerRevisionId: testId(150 + index),
        exactKeys: [],
        semanticText: `旅人清晨持有普通物件${String(index)}`,
        sourceRefs: [],
        digest: `distractor-${String(index)}`,
      })
    }
    await commitRepository.commit(firstScopeId)

    await scopeRepository.create({
      projectId,
      taskId: testId(106),
      turnId: testId(107),
      scopeId: secondScopeId,
      kind: "turn",
      status: "created",
      reason: "Move the target without restating unchanged possessions",
      configSnapshot: {},
      promptSnapshot: {},
      createdAtMs: 20,
    })
    await graphRepository.stageRevisions(projectId, secondScopeId, [
      graphRevision(testId(141), secondScopeId, "node", targetNodeId, {
        id: targetNodeId,
        content: { state: "旅人当前到达柳渡" },
      }),
    ])
    await retrievalRepository.stageProjection({
      projectionId: testId(161),
      projectId,
      scopeId: secondScopeId,
      ownerKind: "node",
      ownerId: targetNodeId,
      ownerRevisionId: testId(141),
      exactKeys: [],
      semanticText: "旅人当前到达柳渡",
      sourceRefs: [],
      digest: "current-target",
    })
    await commitRepository.commit(secondScopeId)

    const matches = await retrievalRepository.searchText(
      { projectId },
      "旅人 清晨 持有 三张车票",
      4,
    )
    await database.destroy()
    expect(matches.filter((projection) => projection.ownerId === targetNodeId).map((projection) => ({
      projectionId: projection.projectionId,
      stateRole: projection.stateRole,
    }))).toEqual([
      { projectionId: testId(161), stateRole: "current" },
      { projectionId: testId(160), stateRole: "historical" },
    ])
  })

  it("does not let the first Chinese query term consume every semantic candidate", async () => {
    const directory = temporaryDirectory()
    const database = await openProjectDatabase(join(directory, "balanced-chinese-retrieval.sqlite"))
    const projectId = testId(200)
    const firstScopeId = testId(201)
    const secondScopeId = testId(202)
    const targetNodeId = testId(203)
    const projectRepository = new SqliteProjectRepository(
      database,
      join(directory, "workspace"),
      join(directory, "internal"),
    )
    const scopeRepository = new SqliteTaskScopeRepository(database)
    const graphRepository = new SqliteGraphRepository(database)
    const retrievalRepository = new SqliteRetrievalRepository(database)
    const commitRepository = new SqliteScopeCommitRepository(database)
    const manifest: ProjectManifest = {
      id: projectId,
      protocolVersion: "worldseed.v1",
      manifestVersion: 1,
      displayName: "Balanced Chinese Retrieval",
      workspaceRootRef: join(directory, "workspace"),
      fixedEntries: fixedWorkspaceEntries,
      internalStoreRef: join(directory, "internal"),
      manifestDigest: digest(fixedWorkspaceEntries),
    }
    await projectRepository.create({
      projectId,
      name: manifest.displayName,
      manifestVersion: 1,
      committedSequence: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
    }, manifest)
    await scopeRepository.create({
      projectId,
      taskId: testId(204),
      turnId: testId(205),
      scopeId: firstScopeId,
      kind: "turn",
      status: "created",
      reason: "Create balanced semantic retrieval fixture",
      configSnapshot: {},
      promptSnapshot: {},
      createdAtMs: 10,
    })

    const distractorNodeIds = Array.from({ length: 8 }, (_, index) => testId(220 + index))
    await graphRepository.stageRevisions(projectId, firstScopeId, [
      graphRevision(testId(240), firstScopeId, "node", targetNodeId, {
        id: targetNodeId,
        content: { state: "旅人持有三张车票与空信封" },
      }),
      ...distractorNodeIds.map((nodeId, index) => graphRevision(testId(250 + index), firstScopeId, "node", nodeId, {
        id: nodeId,
        content: { state: `主角当前持有事物清单中的钥匙${String(index)}` },
      })),
    ])
    await retrievalRepository.stageProjection({
      projectionId: testId(260),
      projectId,
      scopeId: firstScopeId,
      ownerKind: "node",
      ownerId: targetNodeId,
      ownerRevisionId: testId(240),
      exactKeys: [],
      semanticText: "旅人持有三张车票与空信封",
      sourceRefs: [],
      digest: "balanced-target-history",
    })
    for (const [index, nodeId] of distractorNodeIds.entries()) {
      await retrievalRepository.stageProjection({
        projectionId: testId(270 + index),
        projectId,
        scopeId: firstScopeId,
        ownerKind: "node",
        ownerId: nodeId,
        ownerRevisionId: testId(250 + index),
        exactKeys: [],
        semanticText: `主角当前持有事物清单中的钥匙${String(index)}`,
        sourceRefs: [],
        digest: `balanced-distractor-${String(index)}`,
      })
    }
    await commitRepository.commit(firstScopeId)

    await scopeRepository.create({
      projectId,
      taskId: testId(206),
      turnId: testId(207),
      scopeId: secondScopeId,
      kind: "turn",
      status: "created",
      reason: "Move the target without restating stable inventory",
      configSnapshot: {},
      promptSnapshot: {},
      createdAtMs: 20,
    })
    await graphRepository.stageRevisions(projectId, secondScopeId, [
      graphRevision(testId(241), secondScopeId, "node", targetNodeId, {
        id: targetNodeId,
        content: { state: "旅人到达柳渡镇口候车亭" },
      }),
    ])
    await retrievalRepository.stageProjection({
      projectionId: testId(261),
      projectId,
      scopeId: secondScopeId,
      ownerKind: "node",
      ownerId: targetNodeId,
      ownerRevisionId: testId(241),
      exactKeys: [],
      semanticText: "旅人到达柳渡镇口候车亭",
      sourceRefs: [],
      digest: "balanced-target-current",
    })
    await commitRepository.commit(secondScopeId)

    const matches = await retrievalRepository.searchText(
      { projectId },
      "主角目前持有的事物清单：钥匙、车票、信封及其来处",
      6,
    )
    await database.destroy()
    expect(matches.filter((projection) => projection.ownerId === targetNodeId).map((projection) => ({
      projectionId: projection.projectionId,
      stateRole: projection.stateRole,
    }))).toEqual([
      { projectionId: testId(261), stateRole: "current" },
      { projectionId: testId(260), stateRole: "historical" },
    ])
  })
})
