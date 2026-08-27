import { describe, expect, it, vi } from "vitest"

import { ChapterContextResolver } from "../src/application/chapters/chapter-context-resolver.js"
import type { ModelContextMessage } from "@worldseed/contracts"

function message(input: Partial<ModelContextMessage> & Pick<ModelContextMessage, "messageId" | "sequence" | "kind">): ModelContextMessage {
  return {
    messageId: input.messageId,
    chainId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    sequence: input.sequence,
    role: input.role ?? "assistant",
    kind: input.kind,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    contentRef: input.contentRef ?? "old-ref",
    contentDigest: input.contentDigest ?? "old-digest",
    tokenEstimate: input.tokenEstimate ?? 10,
    createdAtMs: 1,
  }
}

describe("ChapterContextResolver", () => {
  it("replaces stale canonical chapter content with the current head body", async () => {
    const resolver = new ChapterContextResolver({
      documents: {
        listCommittedChapters: vi.fn(async () => [{
          id: "doc-v2",
          projectId: "00000000-0000-4000-8000-000000000002",
          scopeId: "00000000-0000-4000-8000-000000000099",
          sourceId: "source-v2",
          chapterId: "chapter-1",
          visibility: "committed",
          contentRef: "head-ref",
          heading: "第一章 修订后",
          publishPath: "章节正文/第一章 修订后.md",
          digest: "head-digest",
          predecessorSourceId: "source-v1",
          createdAtMs: 2,
        }]),
        findStoredVersion: vi.fn(async (_projectId, sourceId) => ({
          id: sourceId === "source-v2" ? "doc-v2" : "doc-v1",
          projectId: "00000000-0000-4000-8000-000000000002",
          scopeId: "00000000-0000-4000-8000-000000000099",
          sourceId,
          chapterId: "chapter-1",
          visibility: "committed" as const,
          contentRef: sourceId === "source-v2" ? "head-ref" : "old-ref",
          heading: sourceId === "source-v2" ? "第一章 修订后" : "第一章 旧版",
          publishPath: "章节正文/第一章.md",
          digest: sourceId === "source-v2" ? "head-digest" : "old-digest",
          createdAtMs: 1,
        })),
      } as never,
      internalStore: {
        readDocument: vi.fn(async (ref: string) => ref === "head-ref" ? "修订后的正文" : "旧正文"),
      } as never,
      persistence: {
        listCanonicalChapterMessageSources: vi.fn(async () => [{
          messageId: "canonical-message-1",
          sourceId: "source-v1",
          contentDigest: "old-digest",
        }]),
        findChapterRevisionSummaryByTaskId: vi.fn(async () => undefined),
      } as never,
    })

    const hydrated = await resolver.hydrateNarrativeMessages("00000000-0000-4000-8000-000000000002", [
      message({ messageId: "canonical-message-1", sequence: 1, kind: "canonical_chapter", contentRef: "old-ref", contentDigest: "old-digest" }),
    ])

    expect(hydrated[0]?.content).toBe("修订后的正文")
  })

  it("leaves non-narrative messages unchanged", async () => {
    const resolver = new ChapterContextResolver({
      documents: {
        listCommittedChapters: vi.fn(async () => []),
        findStoredVersion: vi.fn(async () => undefined),
      } as never,
      internalStore: {
        readDocument: vi.fn(async () => "phase output"),
      } as never,
      persistence: {
        listCanonicalChapterMessageSources: vi.fn(async () => []),
        findChapterRevisionSummaryByTaskId: vi.fn(async () => undefined),
      } as never,
    })

    const hydrated = await resolver.hydrateNarrativeMessages("00000000-0000-4000-8000-000000000002", [
      message({ messageId: "phase-1", sequence: 1, kind: "phase_response", contentRef: "phase-ref" }),
    ])

    expect(hydrated[0]?.content).toBe("phase output")
  })
})
