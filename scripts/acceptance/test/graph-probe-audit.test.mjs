import { createRequire } from "node:module"
import { resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { auditTemporalContinuityCoverage, auditVerificationProbeCoverage } from "../../../apps/backend/acceptance/lib/graph-audit.mjs"

const require = createRequire(import.meta.url)
const Database = require(resolve(import.meta.dirname, "../../../apps/backend/node_modules/better-sqlite3"))
const databases = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe("graph verification probe acceptance audit", () => {
  it("rejects probes that exist only on superseded phase runs", () => {
    const database = createDatabase()
    insertPhaseRun(database, { id: "review-1", attempt: 1, status: "superseded", assessments: [{ probeIndex: 0 }] })
    insertProbe(database, { phaseRunId: "review-1", probeIndex: 0 })

    const result = auditVerificationProbeCoverage(database, "turn-1")

    expect(result.passed).toBe(false)
    expect(result.probeIndexes).toEqual([])
    expect(result.assessmentIndexes).toEqual([])
  })

  it("accepts the latest completed review when assessments exactly cover effective probes", () => {
    const database = createDatabase()
    insertPhaseRun(database, { id: "review-1", attempt: 1, status: "completed", assessments: [] })
    insertProbe(database, { phaseRunId: "review-1", probeIndex: 0 })
    insertPhaseRun(database, { id: "review-2", attempt: 2, status: "completed", assessments: [{ probeIndex: 0 }] })

    const result = auditVerificationProbeCoverage(database, "turn-1")

    expect(result.passed).toBe(true)
    expect(result.reviewPhaseRunId).toBe("review-2")
    expect(result.probeIndexes).toEqual([0])
    expect(result.assessmentIndexes).toEqual([0])
  })

  it("rejects missing, duplicate, or unexpected assessment indexes", () => {
    const database = createDatabase()
    insertPhaseRun(database, {
      id: "review-1",
      attempt: 1,
      status: "completed",
      assessments: [{ probeIndex: 0 }, { probeIndex: 0 }, { probeIndex: 2 }],
    })
    insertProbe(database, { phaseRunId: "review-1", probeIndex: 0 })
    insertProbe(database, { phaseRunId: "review-1", probeIndex: 1 })

    const result = auditVerificationProbeCoverage(database, "turn-1")

    expect(result.passed).toBe(false)
    expect(result.probeIndexes).toEqual([0, 1])
    expect(result.assessmentIndexes).toEqual([0, 0, 2])
  })

  it("accepts exact temporal claim coverage and advisory conflicts", () => {
    const database = createDatabase()
    insertArtifactRun(database, "dependency_audit", { temporalClaims: [{ claimRef: "claim:one" }] })
    insertArtifactRun(database, "graph_spacetime_settlement", { temporalClaimSettlements: [{ claimRef: "claim:one" }] })
    insertArtifactRun(database, "graph_governance_review", { temporalClaimAssessments: [{ claimRef: "claim:one", verdict: "conflict" }] })
    insertArtifactRun(database, "commit_review", {
      recommendation: "commit",
      continuityAdvice: [{ claimRef: "claim:one", verdict: "conflict" }],
    })

    const result = auditTemporalContinuityCoverage(database, "turn-1")

    expect(result.passed).toBe(true)
    expect(result.advisoryConflictCount).toBe(1)
    expect(result.commitRecommendation).toBe("commit")
  })

  it("rejects missing temporal settlements and advice", () => {
    const database = createDatabase()
    insertArtifactRun(database, "dependency_audit", { temporalClaims: [{ claimRef: "claim:one" }] })
    insertArtifactRun(database, "graph_spacetime_settlement", { temporalClaimSettlements: [] })
    insertArtifactRun(database, "graph_governance_review", { temporalClaimAssessments: [{ claimRef: "claim:one" }] })
    insertArtifactRun(database, "commit_review", { recommendation: "commit", continuityAdvice: [] })

    const result = auditTemporalContinuityCoverage(database, "turn-1")

    expect(result.passed).toBe(false)
    expect(result.settlementClaimRefs).toEqual([])
    expect(result.adviceClaimRefs).toEqual([])
  })
})

function createDatabase() {
  const database = new Database(":memory:")
  databases.push(database)
  database.exec(`
    create table phase_runs (
      id text primary key,
      task_id text not null,
      phase text not null,
      attempt integer not null,
      status text not null,
      result_json text,
      started_at integer not null default 0
    );
    create table verification_probe_executions (
      task_id text not null,
      phase_run_id text not null,
      probe_index integer not null
    );
  `)
  return database
}

function insertPhaseRun(database, input) {
  database.prepare(`
    insert into phase_runs(id, task_id, phase, attempt, status, result_json, started_at)
    values (?, 'turn-1', 'graph_governance_review', ?, ?, ?, ?)
  `).run(input.id, input.attempt, input.status, JSON.stringify({
    artifact: { verificationProbeAssessments: input.assessments },
  }), input.attempt)
}

function insertProbe(database, input) {
  database.prepare(`
    insert into verification_probe_executions(task_id, phase_run_id, probe_index)
    values ('turn-1', ?, ?)
  `).run(input.phaseRunId, input.probeIndex)
}

function insertArtifactRun(database, phase, artifact) {
  database.prepare(`
    insert into phase_runs(id, task_id, phase, attempt, status, result_json, started_at)
    values (?, 'turn-1', ?, 1, 'completed', ?, 1)
  `).run(`run-${phase}`, phase, JSON.stringify({ artifact }))
}
