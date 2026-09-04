import { describe, expect, it } from "vitest"

import { synopsisConversationStreamHub } from "../src/application/chapters/synopsis-conversation-stream-hub.js"

describe("synopsis conversation stream hub thinking rounds", () => {
  it("appends thinking slices per round without overwriting prior rounds", () => {
    const projectId = "project-thinking-rounds"
    synopsisConversationStreamHub.clear(projectId)
    synopsisConversationStreamHub.resetCumulativeUsage(projectId)
    synopsisConversationStreamHub.begin(projectId, "session-1", 1)

    synopsisConversationStreamHub.beginThinkingRound(projectId, 1, 2)
    synopsisConversationStreamHub.setThinking(projectId, "第一轮思考", 3)
    synopsisConversationStreamHub.upsertSearch(projectId, {
      query: "设定集",
      status: "completed",
      round: 1,
      resultSummary: "命中 1 条",
    }, 4)

    synopsisConversationStreamHub.beginThinkingRound(projectId, 2, 5)
    synopsisConversationStreamHub.setThinking(projectId, "第二轮思考", 6)
    synopsisConversationStreamHub.upsertSearch(projectId, {
      query: "角色卡",
      status: "completed",
      round: 2,
    }, 7)

    const peek = synopsisConversationStreamHub.peek(projectId)
    expect(peek.thinking).toBe("第二轮思考")
    expect(peek.thinkingRounds).toEqual([
      { round: 1, text: "第一轮思考" },
      { round: 2, text: "第二轮思考" },
    ])
    expect(peek.searching.map((item) => item.round)).toEqual([1, 2])
  })

  it("upserts searches by round+query so same query can appear twice", () => {
    const projectId = "project-search-round-key"
    synopsisConversationStreamHub.clear(projectId)
    synopsisConversationStreamHub.resetCumulativeUsage(projectId)
    synopsisConversationStreamHub.begin(projectId, "session-1", 1)
    synopsisConversationStreamHub.upsertSearch(projectId, {
      query: "索引",
      status: "completed",
      round: 1,
      resultSummary: "第一批",
    }, 2)
    synopsisConversationStreamHub.upsertSearch(projectId, {
      query: "索引",
      status: "completed",
      round: 2,
      resultSummary: "第二批",
    }, 3)
    expect(synopsisConversationStreamHub.peek(projectId).searching).toHaveLength(2)
  })
})
