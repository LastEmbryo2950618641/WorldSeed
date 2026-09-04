import { describe, expect, it } from "vitest"

import { toAgentTimeline } from "../src/renderer/src/features/editor/agent-timeline.js"

describe("toAgentTimeline", () => {
  it("interleaves thinking and searching by round", () => {
    const segments = toAgentTimeline({
      thinkingRounds: [
        { round: 1, text: "先查设定" },
        { round: 2, text: "再查角色" },
      ],
      searching: [
        { query: "设定集", status: "completed", round: 1 },
        { query: "角色A", status: "completed", round: 2 },
        { query: "角色B", status: "completed", round: 2 },
      ],
      editing: [{ path: "细纲.md", kind: "outline", status: "completed", summary: "已写入" }],
      content: "正式回复",
    })
    expect(segments.map((item) => item.kind)).toEqual([
      "thinking",
      "searching",
      "thinking",
      "searching",
      "editing",
      "final",
    ])
    const secondSearch = segments[3]
    expect(secondSearch?.kind).toBe("searching")
    if (secondSearch?.kind === "searching") {
      expect(secondSearch.items).toHaveLength(2)
    }
  })

  it("hides bootstrap round 0 searches by default", () => {
    const segments = toAgentTimeline({
      thinkingRounds: [{ round: 1, text: "思考" }],
      searching: [
        { query: "bootstrap", status: "completed", round: 0 },
        { query: "用户检索", status: "completed", round: 1 },
      ],
      content: "ok",
    })
    expect(segments.filter((item) => item.kind === "searching")).toHaveLength(1)
  })

  it("falls back to flat blocks when round metadata is absent", () => {
    const segments = toAgentTimeline({
      thinking: "旧思考",
      searching: [{ query: "旧检索", status: "completed" }],
      content: "旧回复",
    })
    expect(segments.map((item) => item.kind)).toEqual(["thinking", "searching", "final"])
  })
})
