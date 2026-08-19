import { createRequire } from "node:module"
import { resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  auditAutomaticEvolution,
  auditCompletedTurn,
  auditPhaseCompletion,
  auditPromptPrefix,
  auditStageProjectionProfiles,
  collectTrackedIncompleteTasks,
} from "../lib/full-chain-audit.mjs"

const require = createRequire(import.meta.url)
const Database = require(resolve(import.meta.dirname, "../../../apps/backend/node_modules/better-sqlite3"))

const databases = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe("full-chain acceptance audit", () => {
  it("keeps an earlier completed turn valid after later chapters are committed", () => {
    const database = createDatabase()
    insertCompletedTurn(database, { taskId: "turn-6", chapterSequence: 6 })
    insertCompletedTurn(database, { taskId: "turn-20", chapterSequence: 20 })

    const result = auditCompletedTurn(database, "turn-6", 6, passingKv)

    expect(result.passed).toBe(true)
    expect(result.chapterSequence).toBe(6)
    expect(result.totalChapters).toBe(2)
  })

  it("accepts a completed governed background evolution with no graph mutations", () => {
    const database = createDatabase()
    insertTask(database, { id: "evolution-1", kind: "evolution", status: "completed" })
    database.prepare("insert into phase_runs(task_id, phase, status) values (?, 'graph_governance_review', 'completed')").run("evolution-1")
    database.prepare("insert into phase_runs(task_id, phase, status) values (?, 'commit_review', 'completed')").run("evolution-1")

    const result = auditAutomaticEvolution(database, {
      taskId: "evolution-1",
      triggerTaskId: "turn-1",
    }, passingKv)

    expect(result.passed).toBe(true)
    expect(result.graphRevisionCount).toBe(0)
    expect(result.graphGovernanceCompleted).toBe(true)
    expect(result.graphGovernancePhase).toBe("graph_governance_review")
  })

  it("accepts the staged graph workflow without requiring a capacity rewrite", () => {
    const rows = turnPhases.map((phase) => ({ phase, attempt: 1, status: "completed" }))

    const result = auditPhaseCompletion("turn", rows)

    expect(result.status).toBe("pass")
    expect(result.evidence.missing).toEqual([])
  })

  it("rejects a legacy-only graph workflow for a newly audited turn", () => {
    const rows = [
      ...turnPhases.filter((phase) => !stagedGraphPhases.includes(phase)),
      "graph_governance",
      "semantic_review",
    ].map((phase) => ({ phase, attempt: 1, status: "completed" }))

    const result = auditPhaseCompletion("turn", rows)

    expect(result.status).toBe("fail")
    expect(result.evidence.missing).toEqual(stagedGraphPhases)
  })

  it("ignores paused historical tasks outside the recorded acceptance run", () => {
    const database = createDatabase()
    insertTask(database, { id: "old-paused", kind: "turn", status: "paused" })
    insertTask(database, { id: "recorded-turn", kind: "turn", status: "completed" })
    insertTask(database, { id: "recorded-query", kind: "query", status: "completed" })

    expect(collectTrackedIncompleteTasks(database, ["recorded-turn", "recorded-query"])).toEqual([])
  })

  it("reports an incomplete task when it belongs to the recorded acceptance run", () => {
    const database = createDatabase()
    insertTask(database, { id: "recorded-turn", kind: "turn", status: "paused" })

    expect(collectTrackedIncompleteTasks(database, ["recorded-turn"])).toEqual([
      { id: "recorded-turn", kind: "turn", status: "paused" },
    ])
  })

  it("excludes prompt rollback after a failed phase attempt from append-chain checks", () => {
    const events = [
      promptProfile("envelope-1", "graph_governance", 10, 1000, 1000),
      promptProfile("envelope-2", "graph_governance", 7, 700, 1000),
      promptProfile("envelope-3", "semantic_review", 12, 1300, 1300),
    ]
    const result = auditPromptPrefix(events, "task-1", new Map([
      ["envelope-1", "failed"],
      ["envelope-2", "completed"],
      ["envelope-3", "completed"],
    ]))

    expect(result.status).toBe("pass")
    expect(result.evidence.comparisons).toHaveLength(1)
    expect(result.evidence.excludedRecoveryTransitions).toBe(1)
  })

  it("treats a running attempt shadowed by a later completed attempt as recovered", () => {
    const result = auditPhaseCompletion("turn", [
      { phase: "graph_governance_review", attempt: 5, status: "running" },
      { phase: "graph_governance_review", attempt: 6, status: "completed" },
      ...turnPhases.filter((phase) => phase !== "graph_governance_review").map((phase) => ({ phase, attempt: 1, status: "completed" })),
    ])

    expect(result.status).toBe("pass")
    expect(result.evidence.unfinished).toEqual([])
    expect(result.evidence.recoveredRunningAttempts).toEqual([
      { phase: "graph_governance_review", attempt: 5, status: "running" },
    ])
  })

  it("accepts self-contained stage projection profiles for every review phase", () => {
    const phases = ["graph_governance_review", "settlement_review", "frontier_settlement", "commit_review"]
    const result = auditStageProjectionProfiles(phases.map((phase, index) => ({
      component: "deepseek-model",
      event: "completion.prompt_profiled",
      taskId: "task-1",
      phase,
      modelRequestSections: {
        stageProjectionKind: phase,
        stageProjectionDigest: String(index).repeat(64),
        stageProjectionCharacters: 120 + index,
        deduplicatedEvidenceCharacters: 40 + index,
      },
    })), "task-1")

    expect(result.status).toBe("pass")
    expect(result.evidence.coveredPhases).toEqual(phases)
    expect(result.evidence.deduplicatedEvidenceCharacters).toBe(166)
  })

  it("rejects a review phase whose stage projection is missing", () => {
    const result = auditStageProjectionProfiles([], "task-1")

    expect(result.status).toBe("fail")
    expect(result.evidence.missingPhases).toContain("commit_review")
  })
})

function createDatabase() {
  const database = new Database(":memory:")
  databases.push(database)
  database.exec(`
    create table tasks (id text primary key, kind text not null, status text not null, scope_id text, last_phase text, created_at integer not null default 0);
    create table turn_finalizations (task_id text primary key, status text not null, chapter_path text, graph_anchor_ids_json text);
    create table canonical_chapter_messages (task_id text primary key, chapter_sequence integer not null);
    create table history_entries (task_id text, kind text not null, status text not null);
    create table graph_revisions (scope_id text);
    create table phase_runs (task_id text not null, phase text not null, status text not null);
  `)
  return database
}

function insertCompletedTurn(database, input) {
  insertTask(database, { id: input.taskId, kind: "turn", status: "completed", scopeId: `scope-${input.taskId}` })
  database.prepare("insert into turn_finalizations(task_id, status, chapter_path, graph_anchor_ids_json) values (?, 'completed', ?, '[]')")
    .run(input.taskId, `章节正文/第${String(input.chapterSequence)}章.md`)
  database.prepare("insert into canonical_chapter_messages(task_id, chapter_sequence) values (?, ?)")
    .run(input.taskId, input.chapterSequence)
  database.prepare("insert into history_entries(task_id, kind, status) values (?, 'automatic', 'ready')")
    .run(input.taskId)
}

function insertTask(database, input) {
  database.prepare("insert into tasks(id, kind, status, scope_id) values (?, ?, ?, ?)")
    .run(input.id, input.kind, input.status, input.scopeId ?? `scope-${input.id}`)
}

function passingKv() {
  return { passed: true, calls: 2, average: 1, recentAverage: 1 }
}

function promptProfile(envelopeId, phase, exactMessagePrefixCount, commonPrefixCharacters, previousPromptCharacters) {
  return {
    component: "deepseek-model",
    event: "completion.prompt_profiled",
    taskId: "task-1",
    envelopeId,
    phase,
    previousPhase: phase,
    messages: Array.from({ length: 12 }, (_, index) => ({ index })),
    exactMessagePrefixCount,
    commonPrefixCharacters,
    previousPromptCharacters,
  }
}

const stagedGraphPhases = [
  "graph_structure_plan",
  "graph_spacetime_settlement",
  "graph_retrieval_design",
  "graph_governance_review",
]

const turnPhases = [
  "interpret", "rule_assembly", "source_retrieval", "emergence_planning", "emergence_review", "draft",
  "chapter_naming", "dependency_audit", ...stagedGraphPhases, "settlement_review",
  "frontier_settlement", "commit_review",
]
