import { describe, expect, it } from "vitest"

import { applySearchReplace } from "../src/application/chapters/markdown-search-replace.js"

describe("applySearchReplace", () => {
  it("replaces a unique fragment", () => {
    const result = applySearchReplace(
      "## 分场节拍\n场1：旧冲突\n## 信息边界\n可写：A\n",
      [{ oldText: "场1：旧冲突", newText: "场1：新冲突" }],
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toContain("场1：新冲突")
    expect(result.content).toContain("## 信息边界")
    expect(result.appliedCount).toBe(1)
  })

  it("fails when oldText is missing", () => {
    const result = applySearchReplace("abc", [{ oldText: "zzz", newText: "y" }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("找不到要替换的原文")
  })

  it("fails when oldText is not unique", () => {
    const result = applySearchReplace("同一句\n同一句\n", [{ oldText: "同一句", newText: "改" }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("不唯一")
  })

  it("applies ops in order atomically on success", () => {
    const result = applySearchReplace("A\nB\nC\n", [
      { oldText: "A", newText: "A1" },
      { oldText: "B", newText: "B1" },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toBe("A1\nB1\nC\n")
  })

  it("does not partially apply when a later op fails", () => {
    const source = "A\nB\n"
    const result = applySearchReplace(source, [
      { oldText: "A", newText: "A1" },
      { oldText: "missing", newText: "X" },
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failedOpIndex).toBe(1)
  })

  it("normalizes CRLF for matching", () => {
    const result = applySearchReplace("行1\r\n行2\r\n", [{ oldText: "行1\n行2", newText: "合并" }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toBe("合并\n")
  })
})
