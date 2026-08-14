import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { aiPhaseValues } from "@worldseed/contracts"
import { describe, expect, it } from "vitest"

import {
  BASE_RULES_RESOURCE,
  assertFrontierSettlementCoversReview,
  assertGraphGovernanceReferenceContract,
  assertPhaseReferenceContract,
  assertSpacetimeGovernanceCoverage,
  graphStructurePlanArtifactSchema,
  graphSpacetimeSettlementArtifactSchema,
  isAllowedPhaseTransition,
  parsePhaseResult,
  phaseArtifactJsonSchema,
  promptDefinitions,
} from "../src/index.js"

const envelopeId = "00000000-0000-4000-8000-000000000001"
const contextId = "00000000-0000-4000-8000-000000000002"

describe("prompt contracts", () => {
  it("rejects graph structure plans whose AI decisions do not cover every proposal", () => {
    expect(() => graphStructurePlanArtifactSchema.parse({
      proposals: [
        {
          proposalRef: "proposal:first",
          mutation: { operation: "create_node", ref: "local:first", data: { content: "first" } },
          reason: "Create the first node",
          selfReview: "The first node is needed",
        },
        {
          proposalRef: "proposal:second",
          mutation: { operation: "create_node", ref: "local:second", data: { content: "second" } },
          reason: "Create the second node",
          selfReview: "The second node is needed",
        },
      ],
      affectedFrontierRefs: [],
      archiveOutletRefs: [],
      decisionRecords: [{
        decisionKind: "create",
        proposalRefs: ["proposal:first"],
        reason: "Only the first proposal has an AI decision",
        payload: {},
        selfReview: "The second proposal is intentionally left uncovered for this regression test",
      }],
    })).toThrow(/decision records must cover every proposal/u)
  })

  it("ships one immutable resource for every phase", () => {
    const packageRoot = resolve(process.cwd(), "packages/prompt-contracts")
    const resources = [BASE_RULES_RESOURCE, ...aiPhaseValues.map((phase) => promptDefinitions[phase].resourcePath)]

    expect(new Set(resources).size).toBe(aiPhaseValues.length + 1)
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
    const graphStructurePlan = readResource(promptDefinitions.graph_structure_plan.resourcePath)
    const graphSpacetimeSettlement = readResource(promptDefinitions.graph_spacetime_settlement.resourcePath)
    const graphRetrievalDesign = readResource(promptDefinitions.graph_retrieval_design.resourcePath)
    const graphGovernanceReview = readResource(promptDefinitions.graph_governance_review.resourcePath)
    const frontierSettlement = readResource(promptDefinitions.frontier_settlement.resourcePath)
    const semanticReview = readResource(promptDefinitions.semantic_review.resourcePath)
    const settlementReview = readResource(promptDefinitions.settlement_review.resourcePath)
    const commitReview = readResource(promptDefinitions.commit_review.resourcePath)
    const draft = readResource(promptDefinitions.draft.resourcePath)
    const ruleAssembly = readResource(promptDefinitions.rule_assembly.resourcePath)

    expect(baseRules).toContain("图的局部组织与查询路径由你自主定义和演化")
    expect(baseRules).toContain("演化过程与当前有效状态")
    expect(baseRules).toContain("可被用户精确复述、追问或作为后续指代的原文片段")
    expect(baseRules).toContain("本轮实际读取的图信息是过去万事万物的演化和当前有效状态的首要依据")
    expect(baseRules).toContain("一句话可以是世界生成的起点")
    expect(sourceRetrieval).toContain("已有局部图自身形成的组织方式")
    expect(sourceRetrieval).toContain("检索未命中不等于本轮不能推演")
    expect(sourceRetrieval).toContain("`missingEvidence` 和 `nextExpansionHints` 都必须是数组")
    expect(sourceRetrieval).toContain("应用内部已提交、不可变的原文单元投影")
    expect(sourceRetrieval).toContain("禁止读取工作区章节文件时")
    expect(sourceRetrieval).toContain("查询精确原话、标题或其他逐字内容时必须提供 `exactKeys`")
    expect(sourceRetrieval).toContain("`relatedOwnerRefs`")
    expect(readResource(promptDefinitions.emergence_planning.resourcePath)).toContain("本阶段不能声明 `local:*`")
    expect(graphGovernance).toContain("自主定义和重构局部图的组织与查询语义")
    expect(graphGovernance).toContain("retrievalProjections[].exactKeys")
    expect(graphGovernance).toContain("不是 `mutations` 数组、节点或连接的逐项清单")
    expect(graphStructurePlan).toContain("自包含的最新当前投影")
    expect(graphSpacetimeSettlement).toContain("仅仅可读、相关或出现在场景中不构成锚点用途")
    expect(graphRetrievalDesign).toContain("每个 Source 单元必须具有非空图返回路径")
    expect(graphGovernanceReview).toContain("自包含的最新当前投影")
    expect(graphGovernanceReview).toContain("仅因节点可读、相关或在场景中出现而充当锚点")
    expect(frontierSettlement).toContain("不能因为某个节点可读")
    expect(semanticReview).toContain("不是修改项、节点或连接的逐项清单")
    expect(draft).toContain("不得输出“等待读取资料")
    expect(semanticReview).toContain("有限预算内")
    expect(semanticReview).toContain("可精确复述或再次指代的正文片段")
    expect(settlementReview).toContain("演化过程与当前有效状态")
    expect(commitReview).toContain("准确恢复相关当前状态、历史过程和原文")
    expect(ruleAssembly).toContain("这些内容只作为判断输入，绝不能复制到输出")
    expect(ruleAssembly).toContain("本阶段没有正文或长文本字段")
    expect(ruleAssembly).toContain("不要为了表示“已完整阅读”而重复路径")
    expect(ruleAssembly).toContain("每个路径和冲突各只出现一次")
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
    expect(aiPhaseValues).not.toContain("context_compaction")
    expect(aiPhaseValues).not.toContain("context_compaction_review")
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

  it("rejects undeclared local handles in graph retrieval design", () => {
    expect(() => assertPhaseReferenceContract(
      "graph_retrieval_design",
      {
        projections: [],
        sourceSettlements: [{
          sourceUnitIndex: 0,
          graphRefs: [{ targetKind: "node", targetRef: "local:stale_handle" }],
          reason: "Return through the referenced graph owner",
          status: "bound",
        }],
      },
      {
        readableGraphIds: new Set(["node_1"]),
        readableEvidenceIds: new Set(),
        readableWorkspacePaths: new Set(),
        declaredLocalGraphRefs: new Set(["local:current_handle"]),
      },
    )).toThrow("readable graph owners or declared local handles")
  })

  it("accepts readable owners and current local handles in graph retrieval design", () => {
    expect(() => assertPhaseReferenceContract(
      "graph_retrieval_design",
      {
        projections: [
          { ownerRef: "node_1", exactKeys: ["existing"], semanticText: "Existing owner" },
          { ownerRef: "local:current_handle", exactKeys: ["current"], semanticText: "Current owner" },
        ],
        sourceSettlements: [{
          sourceUnitIndex: 0,
          graphRefs: [
            { targetKind: "node", targetRef: "node_1" },
            { targetKind: "node", targetRef: "local:current_handle", proposalRef: "proposal:current" },
          ],
          reason: "Return through both graph owners",
          status: "bound",
        }],
      },
      {
        readableGraphIds: new Set(["node_1"]),
        readableEvidenceIds: new Set(),
        readableWorkspacePaths: new Set(),
        declaredLocalGraphRefs: new Set(["local:current_handle"]),
      },
    )).not.toThrow()
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

  it("requires frontier settlement to preserve the AI-approved frontier set", () => {
    const review = {
      approvedMutationIndexes: [],
      rejectedMutationIndexes: [],
      approvedSpacetimeBindingIndexes: [],
      rejectedSpacetimeBindingIndexes: [],
      approvedMutationSpacetimeSettlementIndexes: [],
      rejectedMutationSpacetimeSettlementIndexes: [],
      approvedAffectedFrontierRefs: ["local:frontier"],
      rejectedAffectedFrontierRefs: [],
      verificationProbeAssessments: [],
      sceneInventoryComplete: true,
      graphStillDiscoverable: true,
      graphStillConcise: true,
      continuityPreserved: true,
      spacetimeContinuityPreserved: true,
    }
    const settlement = {
      frontiers: [{
        frontierAnchorRef: "local:not-approved",
        disposition: "active",
        lastSceneAnchorRefs: ["local:scene"],
        lastTimeAnchorRefs: ["local:time"],
        lastLocationAnchorRefs: ["local:place"],
        correspondenceRefs: [],
        reason: "continue later",
        revisitCondition: "when local pressure changes",
      }],
    }

    expect(() => assertFrontierSettlementCoversReview(review, settlement))
      .toThrow("must contain every approved reference exactly once")
  })

  it("rejects a frontier time anchor that was not established by spacetime governance", () => {
    const review = {
      approvedMutationIndexes: [],
      rejectedMutationIndexes: [],
      approvedSpacetimeBindingIndexes: [0],
      rejectedSpacetimeBindingIndexes: [],
      approvedMutationSpacetimeSettlementIndexes: [],
      rejectedMutationSpacetimeSettlementIndexes: [],
      approvedAffectedFrontierRefs: ["local:frontier"],
      rejectedAffectedFrontierRefs: [],
      verificationProbeAssessments: [],
      sceneInventoryComplete: true,
      graphStillDiscoverable: true,
      graphStillConcise: true,
      continuityPreserved: true,
      spacetimeContinuityPreserved: true,
    }
    const governance = {
      mutations: [],
      retrievalProjections: [],
      settlementRecords: [],
      mutationSpacetimeSettlements: [],
      sceneSpacetimeBindings: [{
        sceneIndex: 0,
        sceneAnchorRef: "local:scene",
        sourceUnitIndexes: [],
        temporalReferenceRefs: ["local:time"],
        timeAnchorRefs: ["local:time"],
        spatialReferenceRefs: ["local:place"],
        locationAnchorRefs: ["local:place"],
        predecessorSceneIndexes: [],
        predecessorSceneAnchorRefs: [],
        transitionPathRefs: [],
        correspondenceRefs: [],
        explanation: "Established scene anchors",
        selfReview: "Each anchor has one governed role",
      }],
      affectedFrontierRefs: ["local:frontier"],
      archiveOutletRefs: [],
      decisionRecords: [],
    }
    const settlement = {
      frontiers: [{
        frontierAnchorRef: "local:frontier",
        disposition: "active",
        lastSceneAnchorRefs: ["local:scene"],
        lastTimeAnchorRefs: ["local:object"],
        lastLocationAnchorRefs: ["local:place"],
        correspondenceRefs: [],
        reason: "continue later",
        revisitCondition: "when local pressure changes",
      }],
    }

    expect(() => assertFrontierSettlementCoversReview(review, settlement, governance))
      .toThrow("time anchors must come from approved spacetime bindings")
  })

  it("rejects duplicate narrative source coverage across scene bindings", () => {
    const dependency = {
      missingDependencies: [],
      unplannedContent: [],
      sceneContinuity: [{
        sceneIndex: 0,
        sceneDescription: "one scene",
        predecessorSceneIndexes: [],
        predecessorSceneRefs: [],
        predecessorRequired: false,
        predecessorReason: "none",
        correspondenceRequired: false,
        correspondenceReason: "none",
        timeContinuity: "pass",
        locationContinuity: "pass",
        crossReferenceContinuity: "pass",
        reason: "continuous",
      }],
      informationBoundary: "pass",
    }
    const governance = {
      mutations: [],
      retrievalProjections: [],
      settlementRecords: [
        { sourceUnitIndex: 0, graphRefs: [], reason: "settled", status: "settled" },
        { sourceUnitIndex: 1, graphRefs: [], reason: "settled", status: "settled" },
      ],
      mutationSpacetimeSettlements: [],
      sceneSpacetimeBindings: [{
        sceneIndex: 0,
        sceneAnchorRef: "scene",
        sourceUnitIndexes: [0, 0, 1],
        temporalReferenceRefs: ["time"],
        timeAnchorRefs: ["time"],
        spatialReferenceRefs: ["space"],
        locationAnchorRefs: ["space"],
        predecessorSceneIndexes: [],
        predecessorSceneAnchorRefs: [],
        transitionPathRefs: [],
        correspondenceRefs: [],
        explanation: "covers the scene",
        selfReview: "duplicate source unit is invalid",
      }],
      affectedFrontierRefs: [],
      archiveOutletRefs: [],
      decisionRecords: [],
    }

    expect(() => assertSpacetimeGovernanceCoverage(dependency, governance, 2))
      .toThrow("Scene source coverage must contain every index exactly once")
  })

  it("rejects staged world effects without an effective scene", () => {
    expect(() => graphSpacetimeSettlementArtifactSchema.parse({
      sceneSpacetimeBindings: [],
      proposalSettlements: [{
        proposalRefs: ["proposal:world-effect"],
        effectDisposition: "world_effect",
        effectiveSceneBindingIndexes: [],
        effectiveExistingSceneAnchorRefs: [],
        currentEntryRefs: ["local:world-effect"],
        predecessorRevisionRequired: false,
        predecessorRevisionReadRefs: [],
        historicalReturnRefs: ["local:world-effect"],
        reason: "The proposal changes the persistent world",
        selfReview: "No effective scene was established",
      }],
    })).toThrow("world_effect requires an effective scene")
  })
})
