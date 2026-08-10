import { describe, expect, it } from "vitest"

import { buildSourceUnitExactKeys } from "../src/index.js"

describe("source-unit retrieval indexing", () => {
  it("keeps the raw unit and extracts lines, sentences, and quoted speech as exact keys", () => {
    const content = "# 旧事\n\n林序看着巷口，说：“接得上，不等于就是真的。”随后转身离开。"

    const keys = buildSourceUnitExactKeys(content)

    expect(keys).toContain(content)
    expect(keys).toContain("旧事")
    expect(keys).toContain("接得上，不等于就是真的。")
    expect(keys).toContain("接得上，不等于就是真的")
  })
})
