import { describe, expect, it } from "vitest"

import { formatSynopsisToolRunCall } from "../src/renderer/src/features/editor/tool-run-label.js"

describe("formatSynopsisToolRunCall", () => {
  it("formats bash like Claude Code run(command)", () => {
    expect(formatSynopsisToolRunCall({
      name: "bash",
      action: "invoke",
      arguments: JSON.stringify({ command: "dir /b", cwd: "暂存区" }),
    })).toBe('run("dir /b", cwd="暂存区")')
  })

  it("formats named tools with key=value args", () => {
    expect(formatSynopsisToolRunCall({
      name: "restage_chapter",
      action: "invoke",
      arguments: JSON.stringify({ targetStage: "synopsis", reason: "rewrite" }),
    })).toBe("run(restage_chapter, targetStage=synopsis, reason=rewrite)")
  })

  it("marks describe actions explicitly", () => {
    expect(formatSynopsisToolRunCall({
      name: "bash",
      action: "describe",
    })).toBe("run(bash, action=describe)")
  })
})
