import { describe, expect, it } from "vitest"

import { discussAgentModePromptAppendix } from "../src/application/chapters/discuss-agent-mode.js"

describe("discuss agent mode appendix", () => {
  it("Auto overrides ask-the-user rules with self-decision", () => {
    const auto = discussAgentModePromptAppendix("auto")
    expect(auto).toContain("Auto 自决")
    expect(auto).toContain("titleAlignTarget")
    expect(auto).not.toContain("才停并给 choices")
  })

  it("Accept edits still allows stopping on a real content conflict", () => {
    const acceptEdits = discussAgentModePromptAppendix("accept_edits")
    expect(acceptEdits).toContain("才停并给 choices")
    expect(acceptEdits).not.toContain("Auto 自决")
  })
})
