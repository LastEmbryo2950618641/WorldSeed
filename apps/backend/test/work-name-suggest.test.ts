import { describe, expect, it } from "vitest"

import {
  PLACEHOLDER_WORK_NAMES,
  sanitizeSuggestedWorkName,
} from "../src/application/projects/work-name-suggest-service.js"

describe("sanitizeSuggestedWorkName", () => {
  it("rejects placeholders and avoided names", () => {
    expect(sanitizeSuggestedWorkName("新建作品", [])).toBeUndefined()
    expect(sanitizeSuggestedWorkName("待命名", [])).toBeUndefined()
    expect(sanitizeSuggestedWorkName("潮声纪", ["潮声纪"])).toBeUndefined()
  })

  it("strips book-title brackets", () => {
    expect(sanitizeSuggestedWorkName("《潮声纪》", ["新建作品"])).toBe("潮声纪")
  })

  it("keeps usable titles", () => {
    expect(sanitizeSuggestedWorkName("王旗未立", [...PLACEHOLDER_WORK_NAMES])).toBe("王旗未立")
  })
})
