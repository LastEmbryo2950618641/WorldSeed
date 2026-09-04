import { describe, expect, it } from "vitest"

import {
  discussBusyPhaseLabel,
  discussFinalOutputHeader,
  resolveDiscussBusyPhase,
} from "../src/renderer/src/features/editor/discuss-busy-phase.js"

describe("resolveDiscussBusyPhase", () => {
  it("is idle when not busy", () => {
    expect(resolveDiscussBusyPhase({
      busy: false,
      streamStatus: "running",
      hasPreviewContent: true,
    })).toBe("idle")
  })

  it("is generating while running without preview", () => {
    expect(resolveDiscussBusyPhase({
      busy: true,
      streamStatus: "running",
      hasPreviewContent: false,
    })).toBe("generating")
  })

  it("is previewing when assistantMessage preview appears before complete", () => {
    expect(resolveDiscussBusyPhase({
      busy: true,
      streamStatus: "running",
      hasPreviewContent: true,
    })).toBe("previewing")
  })

  it("is finalizing after stream completed while send still persists", () => {
    expect(resolveDiscussBusyPhase({
      busy: true,
      streamStatus: "completed",
      hasPreviewContent: true,
    })).toBe("finalizing")
  })
})

describe("discuss labels", () => {
  it("keeps Stop-era preview from looking finished", () => {
    expect(discussFinalOutputHeader("previewing", true)).toBe("正式输出（生成中）")
    expect(discussBusyPhaseLabel("previewing")).toContain("仍可停止")
  })

  it("names the post-complete persist window", () => {
    expect(discussFinalOutputHeader("finalizing", true)).toBe("正式输出（写入中）")
    expect(discussBusyPhaseLabel("finalizing")).toContain("写入文件")
  })
})
