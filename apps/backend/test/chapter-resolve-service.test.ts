import { describe, expect, it, vi } from "vitest"

import { ChapterResolveService } from "../src/application/chapters/chapter-resolve-service.js"

describe("ChapterResolveService.resolveByPath", () => {
  it("matches chapters by sequence when filesystem path drifted from publish path", async () => {
    const resolve = vi.fn(async () => ({
      index: {
        chapterId: "chapter-1",
        sequence: 1,
        currentSourceId: "source-v2",
        currentPublishPath: "章节正文/第一章 醒来时，我成了间桐慎二.md",
        assignedAtMs: 1,
      },
      committed: {
        chapterId: "chapter-1",
        sourceId: "source-v2",
        heading: "第一章 醒来时，我成了间桐慎二",
        publishPath: "章节正文/第一章 醒来时，我成了间桐慎二.md",
        digest: "digest-v2",
        createdAtMs: 1,
        content: "# 第一章 醒来时，我成了间桐慎二\n\n正文。",
        body: "正文。",
      },
      lineage: { chapterId: "chapter-1", sourceId: "source-v2", priorChapterSourceIds: [], staleMarkers: [] },
      revisionStale: false,
      graphSyncBlocking: false,
      suggestedUiMode: "chapter_read" as const,
    }))
    const service = new ChapterResolveService({
      chapters: {
        list: vi.fn(async () => [{
          chapterId: "chapter-1",
          sourceId: "source-v2",
          heading: "第一章 醒来时，我成了间桐慎二",
          publishPath: "章节正文/第一章 醒来时，我成了间桐慎二.md",
          digest: "digest-v2",
          sequence: 1,
          createdAtMs: 1,
        }]),
        read: vi.fn(),
        findActiveRevision: vi.fn(),
      },
      revisions: {
        hasIncompleteGraphSync: vi.fn(async () => false),
      },
      chapterIndex: {
        list: vi.fn(async () => [{
          chapterId: "chapter-1",
          sequence: 1,
          currentSourceId: "source-v2",
          currentPublishPath: "章节正文/第一章 醒来时，我成了间桐慎二.md",
          assignedAtMs: 1,
        }]),
      },
      database: {
        selectFrom: vi.fn(() => ({
          selectAll: () => ({
            where: () => ({
              where: () => ({
                where: () => ({
                  orderBy: () => ({
                    executeTakeFirst: async () => undefined,
                  }),
                }),
              }),
            }),
          }),
        })),
        insertInto: vi.fn(),
      },
      createId: () => "id",
      now: () => 1,
    })
    service.resolve = resolve

    await expect(service.resolveByPath("project-1", "章节正文/第一章 世界种子.md")).resolves.toMatchObject({
      committed: { chapterId: "chapter-1" },
    })
    expect(resolve).toHaveBeenCalledWith("project-1", "chapter-1")
  })
})
