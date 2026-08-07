import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { aiPhaseValues } from "@worldseed/contracts"
import { describe, expect, it } from "vitest"

import {
  BASE_RULES_RESOURCE,
  assertGraphGovernanceReferenceContract,
  assertPhaseReferenceContract,
  isAllowedPhaseTransition,
  parsePhaseResult,
  phaseArtifactJsonSchema,
  promptDefinitions,
} from "../src/index.js"

const envelopeId = "00000000-0000-4000-8000-000000000001"
const contextId = "00000000-0000-4000-8000-000000000002"

describe("prompt contracts", () => {
  it("ships one immutable resource for every phase", () => {
    const packageRoot = resolve(process.cwd(), "packages/prompt-contracts")
    const resources = [BASE_RULES_RESOURCE, ...aiPhaseValues.map((phase) => promptDefinitions[phase].resourcePath)]

    expect(new Set(resources).size).toBe(17)
    for (const resource of resources) {
      const path = resolve(packageRoot, resource)
      expect(existsSync(path), resource).toBe(true)
      expect(readFileSync(path, "utf8").trim().length, resource).toBeGreaterThan(80)
    }
  })

  it("ships autonomous graph evolution and bounded retrieval standards to executable prompts", () => {
    const packageRoot = resolve(process.cwd(), "packages/prompt-contracts")
    const readResource = (resource: string): string => readFileSync(resolve(packageRoot, resource), "utf8")
    const baseRules = readResource(BASE_RULES_RESOURCE)
    const sourceRetrieval = readResource(promptDefinitions.source_retrieval.resourcePath)
    const graphGovernance = readResource(promptDefinitions.graph_governance.resourcePath)
    const semanticReview = readResource(promptDefinitions.semantic_review.resourcePath)
    const settlementReview = readResource(promptDefinitions.settlement_review.resourcePath)
    const commitReview = readResource(promptDefinitions.commit_review.resourcePath)
    const draft = readResource(promptDefinitions.draft.resourcePath)

    expect(baseRules).toContain("图的局部组织与查询路径由你自主定义和演化")
    expect(baseRules).toContain("演化过程与当前有效状态")
    expect(baseRules).toContain("本轮实际读取的图信息是过去万事万物的演化和当前有效状态的首要依据")
    expect(baseRules).toContain("一句话可以是世界生成的起点")
    expect(sourceRetrieval).toContain("已有局部图自身形成的组织方式")
    expect(sourceRetrieval).toContain("检索未命中不等于本轮不能推演")
    expect(sourceRetrieval).toContain("`missingEvidence` 和 `nextExpansionHints` 都必须是数组")
    expect(readResource(promptDefinitions.emergence_planning.resourcePath)).toContain("本阶段不能声明 `local:*`")
    expect(graphGovernance).toContain("自主定义和重构局部图的组织与查询语义")
    expect(draft).toContain("不得输出“等待读取资料")
    expect(semanticReview).toContain("有限预算内")
    expect(settlementReview).toContain("演化过程与当前有效状态")
    expect(commitReview).toContain("准确恢复相关当前状态、历史过程和原文")
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
    expect(isAllowedPhaseTransition("context_compaction", "context_compaction_review")).toBe(true)
    expect(isAllowedPhaseTransition("context_compaction_review", "source_retrieval")).toBe(true)
  })

  it("uses one semantic artifact contract without backend-owned UUID fields", () => {
    for (const phase of aiPhaseValues) {
      const schema = JSON.stringify(phaseArtifactJsonSchema(phase))
      expect(schema, phase).not.toContain('"format":"uuid"')
    }
  })

  it("keeps rule assembly semantic and lets the runtime own its snapshot identity", () => {
    const result = phaseArtifactJsonSchema("rule_assembly")
    expect(JSON.stringify(result)).toContain("selectedWorkspacePaths")
    expect(JSON.stringify(result)).not.toContain("ruleSnapshotId")
    expect(JSON.stringify(result)).not.toContain("presentationRuleVersionIds")
  })

  it("keeps backend document references out of the draft artifact", () => {
    expect(JSON.stringify(phaseArtifactJsonSchema("draft"))).not.toContain("contentRef")
  })

  it("requires existing planning references to point at graph identities read this turn", () => {
    const planning = {
      decisions: [{
        pressureEvidenceRefs: [],
        action: "reuse",
        existingAnchorRefs: ["chapter-evidence-id"],
        timeAnchorRefs: [],
        locationAnchorRefs: [],
        informationBoundaryRefs: [],
        reason: "Continue the same traveler",
      }],
    }

    expect(() => {
      assertPhaseReferenceContract("emergence_planning", planning, {
        readableEvidenceIds: new Set(),
        readableGraphIds: new Set(["traveler-node-id"]),
        readableWorkspacePaths: new Set(),
      })
    })
      .toThrow("owner IDs read in this turn")
  })

  it("rejects undeclared local graph handles without interpreting their semantics", () => {
    const governance = {
      mutations: [{
        operation: "create_node",
        ref: "local:place",
        data: { content: { relatedRef: "local:missing" } },
      }],
      retrievalProjections: [],
      settlementRecords: [],
      mutationSpacetimeSettlements: [],
      sceneSpacetimeBindings: [],
      affectedFrontierRefs: [],
      archiveOutletRefs: [],
      decisionRecords: [],
    }

    expect(() => assertGraphGovernanceReferenceContract(governance, new Set()))
      .toThrow("readable graph owners or declared local handles")
  })

  it("does not impose a code-owned graph creation count", () => {
    const governance = {
      mutations: [
        { operation: "create_node", ref: "local:first", data: { content: {} } },
        { operation: "create_node", ref: "local:second", data: { content: {} } },
      ],
      retrievalProjections: [],
      settlementRecords: [],
      mutationSpacetimeSettlements: [],
      sceneSpacetimeBindings: [],
      affectedFrontierRefs: [],
      archiveOutletRefs: [],
      decisionRecords: [],
    }

    expect(() => assertGraphGovernanceReferenceContract(governance, new Set())).not.toThrow()
  })
})
