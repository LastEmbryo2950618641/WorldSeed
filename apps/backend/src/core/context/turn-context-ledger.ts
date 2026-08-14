import {
  PROTOCOL_VERSION,
  type ContextSegmentRef,
  type Id,
  type ProjectId,
  type TaskId,
  type TaskKind,
  type TurnContext,
  type TurnId,
} from "@worldseed/contracts"

export type CreateTurnContextInput = Readonly<{
  contextId: Id
  projectId: ProjectId
  taskId: TaskId
  turnId: TurnId
  taskKind: Exclude<TaskKind, "workspace">
  baseCommittedSequence: number
  maxTokens: number
  ruleSnapshotId?: Id
}>

export type ReturnedContextRead = Readonly<{
  readId: Id
  reason: string
  segment: ContextSegmentRef
}>

export type RecordContextReadInput = Readonly<{
  requestId: Id
  returned: readonly ReturnedContextRead[]
  rejectedReadIds: readonly Id[]
}>

export type InheritedContextRead = Readonly<{
  readId: Id
  visibility: "committed" | "pending"
  reason: string
}>

export class TurnContextLedgerError extends Error {
  public constructor(
    public readonly code: "duplicate_segment" | "invalid_sequence" | "budget_exhausted" | "unread_citation" | "invalid_read_segment",
    message: string,
  ) {
    super(message)
  }
}

function appendUnique<T>(current: readonly T[], next: readonly T[]): T[] {
  return [...new Set([...current, ...next])]
}

export function createTurnContext(input: CreateTurnContextInput): TurnContext {
  return {
    contextId: input.contextId,
    projectId: input.projectId,
    taskId: input.taskId,
    turnId: input.turnId,
    taskKind: input.taskKind,
    protocolVersion: PROTOCOL_VERSION,
    ...(input.ruleSnapshotId === undefined ? {} : { ruleSnapshotId: input.ruleSnapshotId }),
    baseCommittedSequence: input.baseCommittedSequence,
    segments: [],
    readLedger: {
      committedReadIds: [],
      visiblePendingIds: [],
      requestedReadIds: [],
      returnedReadIds: [],
      rejectedReadIds: [],
      readReasons: {},
    },
    budget: { maxTokens: input.maxTokens, usedTokens: 0 },
  }
}

export function appendContextSegments(
  context: TurnContext,
  segments: readonly ContextSegmentRef[],
): TurnContext {
  const existingIds = new Set(context.segments.map((segment) => segment.segmentId))
  let expectedSequence = context.segments.length
  let addedTokens = 0

  for (const segment of segments) {
    if (existingIds.has(segment.segmentId)) {
      throw new TurnContextLedgerError("duplicate_segment", `Context segment already exists: ${segment.segmentId}`)
    }
    if (segment.sequence !== expectedSequence) {
      throw new TurnContextLedgerError(
        "invalid_sequence",
        `Expected context sequence ${String(expectedSequence)}, received ${String(segment.sequence)}`,
      )
    }
    existingIds.add(segment.segmentId)
    expectedSequence += 1
    addedTokens += segment.tokenEstimate
  }

  const usedTokens = context.budget.usedTokens + addedTokens
  if (usedTokens > context.budget.maxTokens) {
    throw new TurnContextLedgerError("budget_exhausted", "Context token budget would be exceeded")
  }

  return {
    ...context,
    segments: [...context.segments, ...segments],
    budget: { ...context.budget, usedTokens },
  }
}

export function recordContextRead(context: TurnContext, input: RecordContextReadInput): TurnContext {
  for (const read of input.returned) {
    const expectedKind = read.segment.visibility === "committed" ? "committed_read" : "pending_artifact"
    if (read.segment.kind !== expectedKind || !read.segment.ownerIds.includes(read.readId)) {
      throw new TurnContextLedgerError(
        "invalid_read_segment",
        `Read ${read.readId} is not represented by a matching context segment`,
      )
    }
  }

  const withSegments = appendContextSegments(context, input.returned.map((read) => read.segment))
  const committedReadIds = input.returned
    .filter((read) => read.segment.visibility === "committed")
    .map((read) => read.readId)
  const visiblePendingIds = input.returned
    .filter((read) => read.segment.visibility === "pending")
    .map((read) => read.readId)
  const reasons = Object.fromEntries(input.returned.map((read) => [read.readId, read.reason]))

  return {
    ...withSegments,
    readLedger: {
      committedReadIds: appendUnique(withSegments.readLedger.committedReadIds, committedReadIds),
      visiblePendingIds: appendUnique(withSegments.readLedger.visiblePendingIds, visiblePendingIds),
      requestedReadIds: appendUnique(withSegments.readLedger.requestedReadIds, [input.requestId]),
      returnedReadIds: appendUnique(
        withSegments.readLedger.returnedReadIds,
        input.returned.map((read) => read.readId),
      ),
      rejectedReadIds: appendUnique(withSegments.readLedger.rejectedReadIds, input.rejectedReadIds),
      readReasons: { ...withSegments.readLedger.readReasons, ...reasons },
    },
  }
}

export function inheritContextReads(
  context: TurnContext,
  reads: readonly InheritedContextRead[],
): TurnContext {
  const committedReadIds = reads.filter((read) => read.visibility === "committed").map((read) => read.readId)
  const visiblePendingIds = reads.filter((read) => read.visibility === "pending").map((read) => read.readId)
  return {
    ...context,
    readLedger: {
      ...context.readLedger,
      committedReadIds: appendUnique(context.readLedger.committedReadIds, committedReadIds),
      visiblePendingIds: appendUnique(context.readLedger.visiblePendingIds, visiblePendingIds),
      returnedReadIds: appendUnique(context.readLedger.returnedReadIds, reads.map((read) => read.readId)),
      readReasons: {
        ...context.readLedger.readReasons,
        ...Object.fromEntries(reads.map((read) => [read.readId, read.reason])),
      },
    },
  }
}

export function assertCitationsWereRead(context: TurnContext, citedReadIds: readonly Id[]): void {
  const readableIds = new Set([
    ...context.readLedger.committedReadIds,
    ...context.readLedger.visiblePendingIds,
  ])
  const unreadId = citedReadIds.find((readId) => !readableIds.has(readId))
  if (unreadId !== undefined) {
    throw new TurnContextLedgerError("unread_citation", `Phase cited an unread artifact: ${unreadId}`)
  }
}

export function canUseContextFact(context: TurnContext, artifactId: Id): boolean {
  return context.readLedger.committedReadIds.includes(artifactId)
    || context.readLedger.visiblePendingIds.includes(artifactId)
}
