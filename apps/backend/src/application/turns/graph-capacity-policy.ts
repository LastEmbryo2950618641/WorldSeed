import type { GraphLink, ProjectId } from "@worldseed/contracts"
import type { GraphGovernanceArtifact, GraphStructurePlanArtifact } from "@worldseed/prompt-contracts"

import type { GraphDegreeEntry, GraphDegreeProfile, GraphRepository } from "./ports/index.js"

export type GraphCapacityLimits = Readonly<{
  maxDirectInDegree: number
  maxDirectOutDegree: number
}>

export type GraphCapacityViolation = Readonly<{
  nodeId: string
  inDegree: number
  outDegree: number
  exceeded: readonly ("in" | "out")[]
}>

export type GraphCapacityAssessment = Readonly<{
  nodeCount: number
  linkCount: number
  entries: readonly GraphDegreeEntry[]
  violations: readonly GraphCapacityViolation[]
}>

export async function assessGraphGovernanceCapacity(input: Readonly<{
  projectId: ProjectId
  profile: GraphDegreeProfile
  governance: GraphGovernanceArtifact
  limits: GraphCapacityLimits
  graph: Pick<GraphRepository, "getLink">
}>): Promise<GraphCapacityAssessment> {
  return assessGraphMutationsCapacity({ ...input, mutations: input.governance.mutations })
}

export async function assessGraphStructureCapacity(input: Readonly<{
  projectId: ProjectId
  profile: GraphDegreeProfile
  structure: GraphStructurePlanArtifact
  limits: GraphCapacityLimits
  graph: Pick<GraphRepository, "getLink">
}>): Promise<GraphCapacityAssessment> {
  return assessGraphMutationsCapacity({ ...input, mutations: input.structure.proposals.map((proposal) => proposal.mutation) })
}

async function assessGraphMutationsCapacity(input: Readonly<{
  projectId: ProjectId
  profile: GraphDegreeProfile
  mutations: GraphGovernanceArtifact["mutations"]
  limits: GraphCapacityLimits
  graph: Pick<GraphRepository, "getLink">
}>): Promise<GraphCapacityAssessment> {
  const degrees = new Map(input.profile.entries.map((entry) => [entry.nodeId, {
    inDegree: entry.inDegree,
    outDegree: entry.outDegree,
  }]))
  const localLinks = new Map<string, Pick<GraphLink, "fromNodeId" | "toNodeId"> | undefined>()
  const retiredNodeRefs = new Set<string>()
  let nodeCount = input.profile.nodeCount
  let linkCount = input.profile.linkCount

  const adjustLink = (link: Pick<GraphLink, "fromNodeId" | "toNodeId">, change: 1 | -1): void => {
    const from = degrees.get(link.fromNodeId) ?? { inDegree: 0, outDegree: 0 }
    from.outDegree = Math.max(0, from.outDegree + change)
    degrees.set(link.fromNodeId, from)
    const to = degrees.get(link.toNodeId) ?? { inDegree: 0, outDegree: 0 }
    to.inDegree = Math.max(0, to.inDegree + change)
    degrees.set(link.toNodeId, to)
  }
  const readLink = async (linkRef: string): Promise<Pick<GraphLink, "fromNodeId" | "toNodeId">> => {
    if (localLinks.has(linkRef)) {
      const local = localLinks.get(linkRef)
      if (local === undefined) throw new Error(`Candidate graph link is already retired: ${linkRef}`)
      return local
    }
    const existing = await input.graph.getLink({ projectId: input.projectId }, linkRef)
    if (existing === undefined) throw new Error(`Candidate graph mutation references a missing link: ${linkRef}`)
    return existing
  }

  for (const mutation of input.mutations) {
    switch (mutation.operation) {
      case "create_node":
        retiredNodeRefs.delete(mutation.ref)
        if (!degrees.has(mutation.ref)) {
          degrees.set(mutation.ref, { inDegree: 0, outDegree: 0 })
          nodeCount += 1
        }
        break
      case "retire_node":
        retiredNodeRefs.add(mutation.nodeRef)
        nodeCount = Math.max(0, nodeCount - 1)
        break
      case "edit_node":
        break
      case "create_link": {
        const link = { fromNodeId: mutation.fromRef, toNodeId: mutation.toRef }
        localLinks.set(mutation.ref, link)
        adjustLink(link, 1)
        linkCount += 1
        break
      }
      case "edit_link": {
        const previous = await readLink(mutation.linkRef)
        adjustLink(previous, -1)
        const next = { fromNodeId: mutation.fromRef, toNodeId: mutation.toRef }
        adjustLink(next, 1)
        localLinks.set(mutation.linkRef, next)
        break
      }
      case "retire_link": {
        const previous = await readLink(mutation.linkRef)
        adjustLink(previous, -1)
        localLinks.set(mutation.linkRef, undefined)
        linkCount = Math.max(0, linkCount - 1)
        break
      }
    }
  }

  const entries = [...degrees.entries()]
    .filter(([nodeId, degree]) => !retiredNodeRefs.has(nodeId) || degree.inDegree > 0 || degree.outDegree > 0)
    .map(([nodeId, degree]) => ({ nodeId, ...degree }))
    .sort(compareDegreeEntries)
  const violations = entries.flatMap((entry) => {
    const exceeded = [
      ...(entry.inDegree > input.limits.maxDirectInDegree ? ["in" as const] : []),
      ...(entry.outDegree > input.limits.maxDirectOutDegree ? ["out" as const] : []),
    ]
    return exceeded.length === 0 ? [] : [{ ...entry, exceeded }]
  })
  return { nodeCount, linkCount, entries, violations }
}

export function findGraphCapacityViolations(
  profile: GraphDegreeProfile,
  limits: GraphCapacityLimits,
): readonly GraphCapacityViolation[] {
  return profile.entries.flatMap((entry) => {
    const exceeded = [
      ...(entry.inDegree > limits.maxDirectInDegree ? ["in" as const] : []),
      ...(entry.outDegree > limits.maxDirectOutDegree ? ["out" as const] : []),
    ]
    return exceeded.length === 0 ? [] : [{ ...entry, exceeded }]
  })
}

function compareDegreeEntries(left: GraphDegreeEntry, right: GraphDegreeEntry): number {
  return Math.max(right.inDegree, right.outDegree) - Math.max(left.inDegree, left.outDegree)
    || left.nodeId.localeCompare(right.nodeId)
}
