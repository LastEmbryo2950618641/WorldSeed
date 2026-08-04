import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  NodeInternalStoreAdapter,
  NodePromptResourceAdapter,
  NodeWorkspaceAdapter,
  ProjectLifecycleService,
  SqliteDocumentRepository,
  SqliteGraphRepository,
  SqliteProjectRegistryRepository,
  SqliteProjectRepositoryFactory,
  SqliteRetrievalRepository,
  SqliteScopeCommitRepository,
  SqliteTaskScopeRepository,
  SqliteTurnPersistence,
  TurnOrchestrator,
  FakeAiModelAdapter,
  openProjectDatabase,
  openRegistryDatabase,
  type AIModelPort,
  type ScopeCommitRepository,
} from "../src/index.js"

const temporaryDirectories: string[] = []
const openDatabases: Array<{ destroy(): Promise<void> }> = []

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    await database.destroy()
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

describe("TurnOrchestrator", () => {
  it("persists one closed turn through fake AI and publishes after commit", async () => {
    const fixture = await createFixture()
    let modelCalls = 0
    const fake = new FakeAiModelAdapter(randomUUID)
    const model: AIModelPort = {
      info: fake.info,
      execute: (request) => {
        modelCalls += 1
        return fake.execute(request)
      },
    }
    let observedPending = false
    const commit: ScopeCommitRepository = {
      commit: async (scopeId) => {
        const pendingNodes = await fixture.database.selectFrom("nodes").selectAll()
          .where("scope_id", "=", scopeId).where("visibility", "=", "pending").execute()
        const pendingDocuments = await fixture.database.selectFrom("document_versions").selectAll()
          .where("scope_id", "=", scopeId).where("visibility", "=", "pending").execute()
        const pendingProjections = await fixture.database.selectFrom("retrieval_projections").selectAll()
          .where("scope_id", "=", scopeId).where("visibility", "=", "pending").execute()
        observedPending = pendingNodes.length > 0 && pendingDocuments.length > 0 && pendingProjections.length > 0
        return fixture.commit.commit(scopeId)
      },
      retire: (scopeId, retiredAtMs) => fixture.commit.retire(scopeId, retiredAtMs),
    }
    const orchestrator = fixture.createOrchestrator(model, commit)

    const result = await orchestrator.execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "林序在旧桥下发现一枚旧铜钥匙。",
      chapterSequence: 1,
    })

    expect(modelCalls).toBe(12)
    expect(result.modelCalls).toBe(12)
    expect(result.modelProvider).toBe("fake")
    expect(result.modelName).toBe("deterministic-contract-fixture")
    expect(result.kvCacheHitRate).toBeCloseTo(0.5, 2)
    expect(observedPending).toBe(true)
    expect(readdirSync(join(fixture.workspaceRoot, "章节正文"))).toEqual(["第一章 世界种子.md"])
    const chapter = readFileSync(join(fixture.workspaceRoot, result.chapterPath), "utf8")
    expect(chapter.split("\n", 1)[0]).toBe(result.chapterHeading)

    expect(await fixture.documentRepository.listCommittedChapters(fixture.projectId)).toHaveLength(1)
    expect(await fixture.retrievalRepository.searchExact({ projectId: fixture.projectId }, [result.chapterHeading], 10)).toHaveLength(1)
    expect(await fixture.persistence.listPhaseRuns(result.taskId)).toHaveLength(13)
    expect((await fixture.persistence.findContext(result.contextId))?.segments).toHaveLength(14)
    expect((await fixture.persistence.findContext(result.contextId))?.ruleSnapshotId).toBeDefined()
    expect(await fixture.database.selectFrom("ai_decision_records").selectAll().execute()).toHaveLength(2)
    expect(await fixture.database.selectFrom("settlement_records").selectAll().execute()).toHaveLength(4)
    expect(await fixture.database.selectFrom("kv_usage").selectAll().execute()).toHaveLength(12)
    expect((await fixture.taskScopes.findTask(result.taskId))?.status).toBe("completed")
    expect((await fixture.taskScopes.findScope(result.scopeId))?.visibility).toBe("committed")
  })

  it("keeps the pending scope and does not publish when the model fails", async () => {
    const fixture = await createFixture()
    const fake = new FakeAiModelAdapter(randomUUID)
    let calls = 0
    const model: AIModelPort = {
      execute: (request) => {
        calls += 1
        if (request.phase === "graph_governance") {
          return Promise.reject(new Error("simulated model failure"))
        }
        return fake.execute(request)
      },
    }
    const orchestrator = fixture.createOrchestrator(model, fixture.commit)

    await expect(orchestrator.execute({
      projectId: fixture.projectId,
      workspaceRootRef: fixture.workspaceRoot,
      internalStore: fixture.store,
      userInput: "用户要求改变尚未成为事实的走向。",
      chapterSequence: 1,
    })).rejects.toThrow("simulated model failure")

    expect(calls).toBe(8)
    expect(readdirSync(join(fixture.workspaceRoot, "章节正文"))).toEqual([])
    const failedTask = await fixture.database.selectFrom("tasks").selectAll().executeTakeFirstOrThrow()
    expect(failedTask.status).toBe("failed")
    expect((await fixture.persistence.listPhaseRuns(failedTask.id)).at(-1)?.status).toBe("failed")
    expect((await fixture.database.selectFrom("artifact_scopes").selectAll().executeTakeFirstOrThrow()).visibility).toBe("pending")
    expect(await fixture.documentRepository.listCommittedChapters(fixture.projectId)).toEqual([])
  })
})

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "worldseed-turn-"))
  temporaryDirectories.push(root)
  const workspaceRoot = join(root, "workspace")
  const applicationDataRoot = join(root, "application-data")
  const projectId = randomUUID()
  const registryDatabase = await openRegistryDatabase(join(root, "registry.sqlite"))
  openDatabases.push(registryDatabase)
  const lifecycle = new ProjectLifecycleService(
    new SqliteProjectRegistryRepository(registryDatabase),
    new NodeWorkspaceAdapter(),
    new NodeInternalStoreAdapter(applicationDataRoot),
    new SqliteProjectRepositoryFactory(),
  )
  const created = await lifecycle.create({
    projectId,
    displayName: "Turn test",
    workspaceRootRef: workspaceRoot,
    defaults: {
      baseRules: "# base\n",
      descriptionRules: "# description\n",
      proseStyleRules: "# prose\n",
    },
    nowMs: 1,
  })
  const database = await openProjectDatabase(created.internalStore.projectDatabaseRef)
  openDatabases.push(database)
  const taskScopes = new SqliteTaskScopeRepository(database)
  const persistence = new SqliteTurnPersistence(database, randomUUID)
  const documentRepository = new SqliteDocumentRepository(database)
  const graphRepository = new SqliteGraphRepository(database)
  const retrievalRepository = new SqliteRetrievalRepository(database)
  const commit = new SqliteScopeCommitRepository(database)
  const promptRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
  const fixture = {
    root,
    projectId,
    workspaceRoot,
    store: created.internalStore,
    database,
    taskScopes,
    persistence,
    documentRepository,
    graphRepository,
    retrievalRepository,
    commit,
    createOrchestrator(model: AIModelPort, commitRepository: ScopeCommitRepository) {
      return new TurnOrchestrator({
        taskScopes,
        persistence,
        model,
        prompts: new NodePromptResourceAdapter(promptRoot),
        documents: documentRepository,
        graph: graphRepository,
        retrieval: retrievalRepository,
        commit: commitRepository,
        internalStore: new NodeInternalStoreAdapter(applicationDataRoot),
        workspace: new NodeWorkspaceAdapter(),
        createId: randomUUID,
        now: () => Date.now(),
      })
    },
  }
  return fixture
}
