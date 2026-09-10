import { describe, expect, it } from "vitest"

import {
  formatDiscussReceivedChars,
  inspectDiscussStreamPayload,
} from "../src/renderer/src/features/editor/discuss-stream-progress.js"

describe("inspectDiscussStreamPayload", () => {
  it("counts raw stream bytes and lights up artifact keys as they appear", () => {
    const early = inspectDiscussStreamPayload('{"outcome":"continue","artifact":{"assistantMessage":"先说明"')
    expect(early.receivedChars).toBeGreaterThan(20)
    expect(early.presentCount).toBe(0)

    const later = inspectDiscussStreamPayload([
      '{"artifact":{',
      '"assistantMessage":"先说明",',
      '"synopsisBody":"# 梗概\\n",',
      '"presentationWrites":[{"relativePath":"表现输出/本作品描写/基调.md","markdown":"# x","mode":"create"}]',
      "}}",
    ].join(""))
    expect(later.fields.find((field) => field.id === "synopsisBody")?.present).toBe(true)
    expect(later.fields.find((field) => field.id === "presentationWrites")?.present).toBe(true)
    expect(later.fields.find((field) => field.id === "outlineBody")?.present).toBe(false)
    expect(later.presentCount).toBe(2)
  })

  it("formats received size for the live counter", () => {
    expect(formatDiscussReceivedChars(80)).toBe("80 字")
    expect(formatDiscussReceivedChars(1500)).toBe("1.5k 字")
    expect(formatDiscussReceivedChars(12_000)).toBe("1.2 万字")
  })
})
