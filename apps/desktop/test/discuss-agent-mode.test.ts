import { describe, expect, it } from "vitest"

import {
  DISCUSS_AGENT_MODE_OPTIONS,
  isDiscussAgentMode,
} from "../src/renderer/src/features/editor/discuss-agent-mode.js"

describe("discuss agent mode", () => {
  it("defaults option set includes auto/plan/accept_edits with auto first", () => {
    expect(DISCUSS_AGENT_MODE_OPTIONS.map((item) => item.value)).toEqual([
      "auto",
      "plan",
      "accept_edits",
    ])
    expect(isDiscussAgentMode("auto")).toBe(true)
    expect(isDiscussAgentMode("plan")).toBe(true)
    expect(isDiscussAgentMode("accept_edits")).toBe(true)
    expect(isDiscussAgentMode("debug")).toBe(false)
  })
})
