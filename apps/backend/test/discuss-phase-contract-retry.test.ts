import { describe, expect, it } from "vitest"

import {
  discussPhaseContractRepairHint,
  isRecoverableDiscussPhaseContractError,
} from "../src/application/chapters/synopsis-conversation-service.js"

describe("discuss phase contract retry", () => {
  it("treats toolRequest exclusivity failures as recoverable", () => {
    const error = Object.assign(
      new Error('DeepSeek response could not satisfy the phase contract: [{"message":"toolRequest 不可与章节写入、草稿提案或其他动作同回；先等待工具结果再继续","path":["toolRequest"]}]'),
      { kind: "schema" as const },
    )
    expect(isRecoverableDiscussPhaseContractError(error)).toBe(true)
    expect(discussPhaseContractRepairHint(error)).toContain("toolRequest 不可与")
    expect(discussPhaseContractRepairHint(error)).toContain("只做一件事")
  })

  it("does not recover network failures", () => {
    const error = Object.assign(new Error("phase contract network boom"), { kind: "network" as const })
    expect(isRecoverableDiscussPhaseContractError(error)).toBe(false)
  })
})
