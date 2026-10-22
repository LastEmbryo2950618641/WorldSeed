import { describe, expect, it } from "vitest"

import { SynopsisConversationStreamHub } from "../src/application/chapters/synopsis-conversation-stream-hub.js"

describe("synopsis stream hub todo carry-over", () => {
  it("carries unfinished todos into the next send of the same session", () => {
    const hub = new SynopsisConversationStreamHub()
    hub.begin("p1", "s1", 1)
    hub.setTodos("p1", [
      { id: "a", content: "第四章发布", status: "completed" },
      { id: "b", content: "第五章补草稿并发布", status: "in_progress" },
      { id: "c", content: "第六章到第九章", status: "pending" },
    ], 2)
    hub.complete("p1", 3)

    hub.begin("p1", "s1", 4)
    expect(hub.peek("p1", "s1").todos.map((item) => item.id)).toEqual(["b", "c"])
    expect(hub.carriedTodos("p1").map((item) => item.id)).toEqual(["b", "c"])
  })

  it("does not carry todos across sessions", () => {
    const hub = new SynopsisConversationStreamHub()
    hub.begin("p1", "s1", 1)
    hub.setTodos("p1", [{ id: "b", content: "x", status: "pending" }], 2)
    hub.begin("p1", "s2", 3)
    expect(hub.peek("p1", "s2").todos).toEqual([])
  })

  it("a full replace cannot silently drop carried open items", () => {
    const hub = new SynopsisConversationStreamHub()
    hub.begin("p1", "s1", 1)
    hub.setTodos("p1", [{ id: "c", content: "第六章到第九章", status: "pending" }], 2)
    hub.begin("p1", "s1", 3)
    hub.setTodos("p1", [
      { id: "t1", content: "统一第五章标题", status: "completed" },
    ], 4)
    expect(hub.peek("p1", "s1").todos.map((item) => item.id)).toEqual(["t1", "c"])

    hub.setTodos("p1", [
      { id: "t1", content: "统一第五章标题", status: "completed" },
      { id: "c", content: "第六章到第九章", status: "cancelled" },
    ], 5)
    expect(hub.peek("p1", "s1").todos.find((item) => item.id === "c")?.status).toBe("cancelled")
  })
})
