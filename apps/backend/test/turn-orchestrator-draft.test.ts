import { randomUUID } from "node:crypto"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  FakeAiModelAdapter,
  NodeInternalStoreAdapter,
  NodePromptResourceAdapter,
  NodeWorkspaceAdapter,
  NodeWorkspaceCatalogAdapter,
  SqliteDocumentRepository,
  SqliteEvidenceStore,
  SqliteGraphRepository,
  SqliteProjectIdAllocator,
  SqliteProjectRegistryRepository,
  SqliteProjectRepositoryFactory,
  SqliteRetrievalRepository,
  SqliteScopeCommitRepository,
  SqliteTaskScopeRepository,
  SqliteTurnPersistence,
  SqliteWorkspaceCatalogSnapshotRepository,
  openProjectDatabase,
  openRegistryDatabase,
} from "../src/infrastructure/index.js"
import {
  ProjectLifecycleService,
  TurnOrchestrator,
  TurnPauseRequestedError,
  type AIModelPort,
  type DraftPersistenceReceipt,
  type TurnOrchestratorDependencies,
} from "../src/application/index.js"
import { ProjectRuntime } from "../src/bootstrap/project-runtime.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const phases = ["interpret", "rule_assembly", "source_retrieval", "emergence_planning", "draft", "chapter_naming"]
const anyString: unknown = expect.any(String)
const anyNumber: unknown = expect.any(Number)

describe("TurnOrchestrator draft output", () => {
  it("returns a focused chapter draft with monitored phases and usage without publishing world state", async () => {
    const fixture = await createFixture()
    const appendDraft = vi.fn<NonNullable<TurnOrchestratorDependencies["appendDraft"]>>()
      .mockResolvedValue({ revisionTaskId: "revision-1", draftVersionId: "version-1" })
    const prepared = vi.fn()
    const result = await fixture.orchestrator({ appendDraft }).execute(fixture.input, { onPrepared: prepared })

    expect(result).toMatchObject({
      kind: "draft", taskId: fixture.input.taskId, chapterSequence: 7,
      heading: anyString, body: anyString, volumeFolderName: anyString,
      turnId: anyString, scopeId: anyString, contextId: anyString,
      modelCalls: 6, inputTokens: anyNumber, outputTokens: anyNumber,
      modelProvider: "fake", modelName: "deterministic-contract-fixture",
      revisionTaskId: "revision-1", draftVersionId: "version-1",
    })
    expect(result).not.toHaveProperty("chapterPath")
    expect(prepared).toHaveBeenCalledOnce()
    expect(appendDraft).toHaveBeenCalledWith({
      projectId: fixture.input.projectId,
      workspaceRootRef: fixture.input.workspaceRootRef,
      idempotencyKey: `turn-draft:${fixture.input.taskId}`,
      result: expect.objectContaining({ kind: "draft", chapterSequence: 7 }) as unknown,
    })
    const runs = await fixture.dependencies.persistence.listPhaseRuns(result.taskId)
    expect(runs.map((run) => run.phase)).toEqual(phases)
    expect(runs.every((run) => run.status === "completed")).toBe(true)
    expect(await fixture.dependencies.taskScopes.findTask(result.taskId)).toMatchObject({
      status: "completed", lastPhase: "chapter_naming",
      configSnapshot: { outputMode: "draft", chapterSequence: 7 },
    })
    expect(await fixture.dependencies.taskScopes.findScope(result.scopeId)).toMatchObject({ visibility: "retired" })
    await fixture.assertNoPublication()
  })

  it("retains durable draft artifacts when no append callback is installed", async () => {
    const fixture = await createFixture()
    const result = await fixture.orchestrator().execute(fixture.input)
    expect(result.kind).toBe("draft")
    const runs = await fixture.dependencies.persistence.listPhaseRuns(result.taskId)
    expect(runs.find((run) => run.phase === "draft")?.result).toMatchObject({
      artifact: { contentMarkdown: anyString },
    })
    expect(runs.find((run) => run.phase === "chapter_naming")?.result).toMatchObject({
      artifact: { heading: anyString, volumeFolderName: anyString },
    })
    await fixture.assertNoPublication()
  })

  it.each(["callback", "completion"] as const)("deduplicates delivery after a %s failure without rerunning the model", async (failure) => {
    const fixture = await createFixture()
    const saved = new Map<string, DraftPersistenceReceipt>()
    let fail = true
    const appendDraft = vi.fn<NonNullable<TurnOrchestratorDependencies["appendDraft"]>>(({ idempotencyKey }) => {
      const existing = saved.get(idempotencyKey)
      if (existing !== undefined) return Promise.resolve(existing)
      const receipt = { revisionTaskId: randomUUID(), draftVersionId: randomUUID() }
      saved.set(idempotencyKey, receipt)
      if (failure === "callback" && fail) {
        fail = false
        return Promise.reject(new Error("lost draft acknowledgement"))
      }
      return Promise.resolve(receipt)
    })
    const originalUpdate = fixture.dependencies.persistence.updateTask.bind(fixture.dependencies.persistence)
    vi.spyOn(fixture.dependencies.persistence, "updateTask").mockImplementation(async (...args) => {
      if (failure === "completion" && args[1] === "completed" && fail) {
        fail = false
        throw new Error("completion write failed")
      }
      await originalUpdate(...args)
    })
    await expect(fixture.orchestrator({ appendDraft }).execute(fixture.input)).rejects.toThrow(
      failure === "callback" ? "lost draft acknowledgement" : "completion write failed",
    )
    expect(await fixture.dependencies.taskScopes.findTask(fixture.input.taskId)).toMatchObject({ status: "awaiting_user_decision" })
    const model = { ...fixture.dependencies.model, execute: vi.fn<AIModelPort["execute"]>() }
    // A new orchestrator must recover the original mode and target even when the caller omits them.
    const result = await fixture.orchestrator({ model, appendDraft }).resume({
      projectId: fixture.input.projectId, workspaceRootRef: fixture.input.workspaceRootRef,
      internalStore: fixture.input.internalStore, taskId: fixture.input.taskId,
      userInput: fixture.input.userInput, chapterSequence: 8,
    })
    expect(result).toMatchObject({ kind: "draft", chapterSequence: 7, ...[...saved.values()][0] })
    expect(model.execute).not.toHaveBeenCalled()
    expect(appendDraft).toHaveBeenCalledTimes(2)
    expect(saved.size).toBe(1)
    expect(appendDraft.mock.calls[1]?.[0].result).toEqual(appendDraft.mock.calls[0]?.[0].result)
    await fixture.assertNoPublication()
  })

  it.each(["continue", "retry_phase"] as const)("can %s after a naming failure without creating source units", async (mode) => {
    const fixture = await createFixture()
    const fake = fixture.dependencies.model
    const failedModel: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        if (request.phase === "chapter_naming") throw new Error("naming unavailable")
        return fake.execute(request, options)
      },
    }
    await expect(fixture.orchestrator({ model: failedModel }).execute(fixture.input)).rejects.toThrow("naming unavailable")
    const execute = vi.fn(fake.execute.bind(fake))
    const result = await fixture.orchestrator({ model: { info: fake.info, execute } }).resume(fixture.input, mode)
    expect(result.kind).toBe("draft")
    expect(execute.mock.calls.map(([request]) => request.phase)).toEqual(["chapter_naming"])
    await fixture.assertNoPublication()
  })

  it.each(["pause", "cancel"] as const)("preserves %s semantics before draft delivery", async (action) => {
    const fixture = await createFixture()
    const controller = new AbortController()
    const reason = action === "pause" ? new TurnPauseRequestedError() : new Error("cancel draft")
    const fake = fixture.dependencies.model
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        if (request.phase === "chapter_naming") controller.abort(reason)
        return fake.execute(request, options)
      },
    }
    const appendDraft = vi.fn<NonNullable<TurnOrchestratorDependencies["appendDraft"]>>()
      .mockResolvedValue({ revisionTaskId: "revision", draftVersionId: "version" })
    await expect(fixture.orchestrator({ model, appendDraft }).execute(fixture.input, { signal: controller.signal })).rejects.toThrow(reason.message)
    expect(appendDraft).not.toHaveBeenCalled()
    expect(await fixture.dependencies.taskScopes.findTask(fixture.input.taskId)).toMatchObject({
      status: action === "pause" ? "paused" : "cancelled",
    })
    if (action === "pause") {
      const result = await fixture.orchestrator({ appendDraft }).resume(fixture.input)
      expect(result.kind).toBe("draft")
      expect(appendDraft).toHaveBeenCalledOnce()
    } else {
      await expect(fixture.orchestrator().resume(fixture.input)).rejects.toThrow("Task cannot resume from status: cancelled")
    }
    await fixture.assertNoPublication()
  })

  it.each(["query", "evolution", "revision"] as const)("rejects draft output for %s before creating a task", async (workflow) => {
    const fixture = await createFixture()
    await expect(fixture.orchestrator().execute({ ...fixture.input, workflow })).rejects.toThrow("Draft output is only supported")
    expect(await fixture.dependencies.taskScopes.findTask(fixture.input.taskId)).toBeUndefined()
  })

  it("connects runtime drafts to a revision chain and reuses the version after a lost completion", async () => {
    const fixture = await createFixture()
    const focusedInput = { ...fixture.input, chapterSequence: 1 }
    const runtime = await ProjectRuntime.open(
      fixture.input.projectId, fixture.input.workspaceRootRef, fixture.input.internalStore,
      fixture.internalStore, fixture.promptRoot,
    )
    cleanups.push(() => runtime.close())
    const originalUpdate = fixture.dependencies.persistence.updateTask.bind(fixture.dependencies.persistence)
    let fail = true
    vi.spyOn(SqliteTurnPersistence.prototype, "updateTask").mockImplementation(async (...args) => {
      if (args[0] === fixture.input.taskId && args[1] === "completed" && fail) {
        fail = false
        throw new Error("lost completion")
      }
      await originalUpdate(...args)
    })
    const createOrchestrator = () => runtime.createTurnOrchestrator(fixture.dependencies.model, randomUUID, Date.now)
    await expect(createOrchestrator().execute(focusedInput)).rejects.toThrow("lost completion")
    const first = await fixture.database.selectFrom("revision_draft_versions").selectAll()
      .where("source", "=", "workflow").executeTakeFirstOrThrow()
    const result = await createOrchestrator().resume(focusedInput)
    expect(result).toMatchObject({ kind: "draft", revisionTaskId: first.revision_task_id, draftVersionId: first.version_id })
    expect(await fixture.database.selectFrom("revision_draft_versions").selectAll()
      .where("source", "=", "workflow").execute()).toHaveLength(1)
    const next = await createOrchestrator().execute({ ...focusedInput, taskId: randomUUID() })
    expect(next).toMatchObject({ kind: "draft", revisionTaskId: first.revision_task_id, chapterSequence: 1 })
    expect(await fixture.database.selectFrom("revision_draft_versions").selectAll()
      .where("source", "=", "workflow").execute()).toHaveLength(2)
    await fixture.assertNoPublication()
  })
})

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "worldseed-draft-"))
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    return Promise.resolve()
  })
  const workspaceRootRef = join(root, "workspace")
  const internalStore = new NodeInternalStoreAdapter(join(root, "application-data"))
  const workspace = new NodeWorkspaceAdapter()
  const registry = await openRegistryDatabase(join(root, "registry.sqlite"))
  cleanups.push(() => registry.destroy())
  const projectId = randomUUID()
  const lifecycle = new ProjectLifecycleService(
    new SqliteProjectRegistryRepository(registry), workspace, internalStore, new SqliteProjectRepositoryFactory(),
  )
  const created = await lifecycle.create({
    projectId, workspaceRootRef, displayName: "Draft output", nowMs: 1,
    defaults: {
      baseRules: "# base\n", contentHandling: "# handling\n", webnovelProseLogic: "# prose logic\n", plotSynopsisGuide: "# synopsis\n",
      settingsQueryGuide: "# query\n", settingsRevisionGuide: "# revision\n", discussCreationDeskWorkflow: "# workflow\n", agentMemoryIndex: "# memory\n", settingsReadme: "# settings\n",
      referencesReadme: "# references\n", descriptionRules: "# description\n", proseStyleRules: "# prose\n",
      stagingReadme: "# staging\n", stagingNotes: "# notes\n", stagingCharacters: "# characters\n",
      stagingWorld: "# world\n", stagingPromoteIndex: "# promote\n",
    },
  })
  const database = await openProjectDatabase(created.internalStore.projectDatabaseRef)
  cleanups.push(() => database.destroy())
  const initialFiles = readdirSync(workspaceRootRef, { recursive: true })
  const promptRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
  const fake = new FakeAiModelAdapter(randomUUID)
  const dependencies: TurnOrchestratorDependencies = {
    taskScopes: new SqliteTaskScopeRepository(database), persistence: new SqliteTurnPersistence(database, randomUUID),
    model: { info: { ...fake.info, contextWindowTokens: 1_000_000 }, execute: fake.execute.bind(fake) },
    prompts: new NodePromptResourceAdapter(promptRoot),
    documents: new SqliteDocumentRepository(database), graph: new SqliteGraphRepository(database),
    retrieval: new SqliteRetrievalRepository(database), catalog: new NodeWorkspaceCatalogAdapter(workspace),
    catalogSnapshots: new SqliteWorkspaceCatalogSnapshotRepository(database),
    evidence: new SqliteEvidenceStore(database, internalStore, created.internalStore),
    commit: new SqliteScopeCommitRepository(database), internalStore, workspace,
    idAllocator: new SqliteProjectIdAllocator(database), createId: randomUUID, now: Date.now,
  }
  return {
    dependencies, database, promptRoot, internalStore,
    input: {
      outputMode: "draft" as const, projectId, workspaceRootRef, internalStore: created.internalStore,
      userInput: "Continue the focused chapter at the station.", chapterSequence: 7, taskId: randomUUID(),
    },
    orchestrator: (overrides: Partial<TurnOrchestratorDependencies> = {}) => new TurnOrchestrator({ ...dependencies, ...overrides }),
    async assertNoPublication() {
      for (const table of [
        "nodes", "links", "graph_revisions", "document_versions", "source_units", "retrieval_projections",
        "canonical_chapter_messages", "settings_extraction_proposals", "turn_finalizations",
      ] as const) {
        expect(await database.selectFrom(table).selectAll().execute(), table).toHaveLength(0)
      }
      expect(await database.selectFrom("projects").select("committed_sequence").where("id", "=", projectId).executeTakeFirstOrThrow())
        .toEqual({ committed_sequence: 0 })
      expect(readdirSync(workspaceRootRef, { recursive: true })).toEqual(initialFiles)
    },
  }
}
