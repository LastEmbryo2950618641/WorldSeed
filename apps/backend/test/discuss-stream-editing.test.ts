import { describe, expect, it } from "vitest"

import { synopsisConversationStreamHub } from "../src/application/chapters/synopsis-conversation-stream-hub.js"

describe("synopsis conversation stream hub editing", () => {
  it("upserts edits by path and allows updates after complete", () => {
    const projectId = "project-edit-stream"
    synopsisConversationStreamHub.clear(projectId)
    synopsisConversationStreamHub.resetCumulativeUsage(projectId)
    synopsisConversationStreamHub.begin(projectId, "session-1", 1)
    synopsisConversationStreamHub.complete(projectId, 2, { content: "回复就绪" })

    synopsisConversationStreamHub.upsertEdit(projectId, {
      path: "章节正文/第一卷/第一章 [剧情细纲].md",
      kind: "outline",
      status: "running",
      summary: "正在写入剧情细纲",
    }, 3)
    synopsisConversationStreamHub.upsertEdit(projectId, {
      path: "章节正文/第一卷/第一章 [剧情细纲].md",
      kind: "outline",
      status: "completed",
      summary: "已写入剧情细纲",
    }, 4)

    const peek = synopsisConversationStreamHub.peek(projectId)
    expect(peek.status).toBe("completed")
    expect(peek.editing).toHaveLength(1)
    expect(peek.editing[0]).toMatchObject({
      path: "章节正文/第一卷/第一章 [剧情细纲].md",
      kind: "outline",
      status: "completed",
      summary: "已写入剧情细纲",
    })
  })

  it("refuses edits after fail", () => {
    const projectId = "project-edit-fail"
    synopsisConversationStreamHub.clear(projectId)
    synopsisConversationStreamHub.resetCumulativeUsage(projectId)
    synopsisConversationStreamHub.begin(projectId, "session-1", 1)
    synopsisConversationStreamHub.fail(projectId, "boom", 2)
    synopsisConversationStreamHub.upsertEdit(projectId, {
      path: "x.md",
      kind: "synopsis",
      status: "completed",
    }, 3)
    expect(synopsisConversationStreamHub.peek(projectId).editing).toEqual([])
  })
})
