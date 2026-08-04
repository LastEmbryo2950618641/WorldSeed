import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { aiPhaseValues } from "@worldseed/contracts"
import { describe, expect, it } from "vitest"

import {
  BASE_RULES_RESOURCE,
  isAllowedPhaseTransition,
  parsePhaseResult,
  promptDefinitions,
} from "../src/index.js"

const envelopeId = "00000000-0000-4000-8000-000000000001"
const contextId = "00000000-0000-4000-8000-000000000002"

describe("prompt contracts", () => {
  it("ships one immutable resource for every phase", () => {
    const packageRoot = resolve(process.cwd(), "packages/prompt-contracts")
    const resources = [BASE_RULES_RESOURCE, ...aiPhaseValues.map((phase) => promptDefinitions[phase].resourcePath)]

    expect(new Set(resources).size).toBe(15)
    for (const resource of resources) {
      const path = resolve(packageRoot, resource)
      expect(existsSync(path), resource).toBe(true)
      expect(readFileSync(path, "utf8").trim().length, resource).toBeGreaterThan(80)
    }
  })

  it("rejects a result from the wrong phase", () => {
    expect(() => parsePhaseResult("draft", {
      schemaVersion: 1,
      envelopeId,
      contextId,
      phase: "source_retrieval",
      outcome: "continue",
      artifact: {
        executedRequestIds: [],
        returnedReadIds: [],
        rejectedCandidateIds: [],
        missingEvidence: [],
        nextExpansionHints: [],
      },
      requestedReads: [],
      citedReadIds: [],
      producedArtifactIds: [],
      decisionRecordIds: [],
      unresolvedDependencies: [],
      reason: "Retrieval completed",
      selfReview: "Only returned reads were cited",
    })).toThrow("Phase mismatch")
  })

  it("permits only declared forward and revision transitions", () => {
    expect(isAllowedPhaseTransition("draft", "chapter_naming")).toBe(true)
    expect(isAllowedPhaseTransition("dependency_audit", "source_retrieval")).toBe(true)
    expect(isAllowedPhaseTransition("interpret", "commit_review")).toBe(false)
  })
})
