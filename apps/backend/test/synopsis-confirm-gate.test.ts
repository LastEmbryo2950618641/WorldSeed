import { describe, expect, it } from "vitest"

import { isConfirmSynopsisUserMessage } from "../src/application/chapters/synopsis-conversation-service.js"

describe("isConfirmSynopsisUserMessage", () => {
  it("accepts the result-oriented confirm_synopsis label", () => {
    expect(isConfirmSynopsisUserMessage("用这份梗概写细纲")).toBe(true)
  })

  it("accepts legacy confirm_synopsis labels", () => {
    expect(isConfirmSynopsisUserMessage("确认本章梗概，开始写细纲")).toBe(true)
  })

  it("accepts short confirmation phrases", () => {
    expect(isConfirmSynopsisUserMessage("确认梗概")).toBe(true)
    expect(isConfirmSynopsisUserMessage("开始写细纲")).toBe(true)
  })

  it("rejects unrelated discuss messages", () => {
    expect(isConfirmSynopsisUserMessage("再改一改基调")).toBe(false)
    expect(isConfirmSynopsisUserMessage("确认落盘到设定集与目标")).toBe(false)
    expect(isConfirmSynopsisUserMessage("跳过细纲，按梗概开推")).toBe(false)
    expect(isConfirmSynopsisUserMessage("")).toBe(false)
  })
})
