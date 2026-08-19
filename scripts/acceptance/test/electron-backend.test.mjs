import { describe, expect, it } from "vitest"

import { runTurn } from "../lib/electron-backend.mjs"

describe("Electron acceptance backend", () => {
  it("honors the caller recovery limit", async () => {
    const statuses = [
      "awaiting_user_decision",
      "awaiting_user_decision",
      "awaiting_user_decision",
      "awaiting_user_decision",
      "completed",
    ]
    const calls = []
    const page = {
      evaluate: async (_callback, request) => {
        if (calls.length >= 30) throw new Error(`Unexpected polling loop: ${calls.join(",")}`)
        calls.push(request.requestMethod)
        if (request.requestMethod === "turn.start") {
          return { taskId: "task-1" }
        }
        if (request.requestMethod === "turn.status") {
          return {
            status: statuses.shift(),
            lastPhase: "draft",
            interruption: { message: "retry", blockedMetrics: [] },
          }
        }
        if (request.requestMethod === "turn.resume") {
          return { taskId: "task-1" }
        }
        throw new Error(`Unexpected backend method: ${request.requestMethod}`)
      },
      waitForTimeout: async () => undefined,
    }

    const result = await runTurn(page, {
      model: { provider: "fake" },
    }, {
      autoRecover: true,
      maxRecoveries: 4,
      timeoutMs: 1_000,
    })

    expect(result.snapshot.status).toBe("completed")
    expect(calls.filter((method) => method === "turn.resume")).toHaveLength(4)
  })
})
