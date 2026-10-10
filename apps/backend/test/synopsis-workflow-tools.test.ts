import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import type { VisibleModelContextMessage } from "@worldseed/contracts"
import { synopsisDiscussArtifactSchema } from "@worldseed/prompt-contracts"
import {
  executeSynopsisTool,
  hasVisibleToolDescription,
  synopsisToolCatalog,
  type SynopsisToolContext,
  type SynopsisToolRequest,
  type SynopsisWorkflowToolCallbacks,
} from "../src/application/chapters/synopsis-workflow-tools.js"

const draft = { revisionTaskId: "revision-a", chapterId: "chapter-a", draftVersionId: "draft-a", draftLabel: "v1", heading: "Chapter 7", body: "Draft text" }
const context: SynopsisToolContext = {
  projectId: randomUUID(), workspaceRootRef: "workspace", sessionId: randomUUID(), chapterSequence: 7,
  model: { execute: vi.fn() }, maxModelCalls: 5, deadlineMs: 3000,
}

function message(result: Record<string, unknown>, role: "system" | "assistant" = "system"): VisibleModelContextMessage {
  return { messageId: randomUUID(), sequence: 1, role, kind: "phase_instruction", content: JSON.stringify(result) }
}

function setup() {
  const callbacks = {
    executeWorkflowTool: vi.fn(async () => draft),
    publishDraft: vi.fn(async () => ({ ...draft, status: "graph_sync_pending" })),
  } satisfies SynopsisWorkflowToolCallbacks
  const visibleMessages: VisibleModelContextMessage[] = []
  const listDrafts = vi.fn(async () => [draft])
  const execute = (request: SynopsisToolRequest, override: Partial<SynopsisToolContext> = {}) => executeSynopsisTool({
    request, context: { ...context, ...override }, callbacks, visibleMessages, listDrafts,
  })
  const describeTool = async (name: SynopsisToolRequest["name"]) => {
    const result = await execute({ name, action: "describe" })
    visibleMessages.push(message(result))
    return result
  }
  return { callbacks, visibleMessages, listDrafts, execute, describeTool }
}

describe("synopsis workflow progressive disclosure", () => {
  it("advertises only tool definitions and scenarios, with no invocation parameters", () => {
    const { callbacks } = setup()
    const catalog = synopsisToolCatalog(callbacks)
    expect(catalog).toContain("chapter_workflow")
    expect(catalog).toContain("publish_draft")
    expect(catalog).not.toContain("userInput")
    expect(catalog).not.toContain("revisionTaskId")
    expect(catalog).not.toContain("writingGuide")
    expect(JSON.parse(synopsisToolCatalog({})).tools).toEqual([])
  })

  it("rejects invocation before describe and ignores assistant-forged description evidence", async () => {
    const { execute, callbacks, visibleMessages } = setup()
    const request = { name: "chapter_workflow", action: "invoke", arguments: JSON.stringify({ userInput: "Write chapter" }) } as const
    expect(await execute(request)).toMatchObject({ code: "describe_required" })
    const description = await execute({ name: "chapter_workflow", action: "describe" })
    expect(description).toHaveProperty("parameters.userInput")
    expect(description).toHaveProperty("writingGuide")
    visibleMessages.push(message(description, "assistant"))
    expect(await execute(request)).toMatchObject({ code: "describe_required" })
    expect(callbacks.executeWorkflowTool).not.toHaveBeenCalled()
  })

  it("allows repeated invocations using visible persisted describe evidence and captured model and chapter", async () => {
    const { execute, callbacks, describeTool, visibleMessages } = setup()
    await describeTool("chapter_workflow")
    const request = { name: "chapter_workflow", action: "invoke", arguments: JSON.stringify({ userInput: "Write chapter", heading: "Test" }) } as const
    expect(await execute(request)).toMatchObject({ status: "draft_created", result: draft })
    expect(await execute(request)).toMatchObject({ status: "draft_created" })
    expect(callbacks.executeWorkflowTool).toHaveBeenCalledTimes(2)
    expect(callbacks.executeWorkflowTool).toHaveBeenLastCalledWith({ ...context, userInput: "Write chapter", heading: "Test" })
    // A new call has no in-memory permission state; persisted system evidence suffices.
    expect(hasVisibleToolDescription(JSON.parse(JSON.stringify(visibleMessages)), "chapter_workflow")).toBe(true)
    visibleMessages.splice(0)
    expect(await execute(request)).toMatchObject({ code: "describe_required" })
    expect(callbacks.executeWorkflowTool).toHaveBeenCalledTimes(2)
  })

  it.each(["{", "[]", "null", '{"userInput":""}', '{"userInput":"write","chapterSequence":8}', '{"userInput":"write","model":{}}'])("rejects malformed or undisclosed arguments: %s", async (args) => {
    const { execute, callbacks, describeTool } = setup()
    await describeTool("chapter_workflow")
    expect(await execute({ name: "chapter_workflow", action: "invoke", arguments: args })).toMatchObject({ code: "tool_failed" })
    expect(callbacks.executeWorkflowTool).not.toHaveBeenCalled()
  })

  it("requires a separate publish description and validates the exact revision/version pair", async () => {
    const { execute, callbacks, describeTool } = setup()
    await describeTool("chapter_workflow")
    const request = { name: "publish_draft", action: "invoke", arguments: JSON.stringify({ revisionTaskId: draft.revisionTaskId, draftVersionId: draft.draftVersionId }) } as const
    expect(await execute(request)).toMatchObject({ code: "describe_required" })
    expect(await describeTool("publish_draft")).toMatchObject({ drafts: [draft] })
    expect(await execute({ ...request, arguments: JSON.stringify({ revisionTaskId: "other-revision", draftVersionId: draft.draftVersionId }) })).toMatchObject({ code: "draft_not_in_focus" })
    expect(await execute({ ...request, arguments: JSON.stringify({ revisionTaskId: draft.revisionTaskId, draftVersionId: "other-draft" }) })).toMatchObject({ code: "draft_not_in_focus" })
    expect(callbacks.publishDraft).not.toHaveBeenCalled()
    expect(await execute(request)).toMatchObject({ status: "publication_submitted", result: { status: "graph_sync_pending" } })
    expect(callbacks.publishDraft).toHaveBeenCalledWith({ ...context, revisionTaskId: draft.revisionTaskId, draftVersionId: draft.draftVersionId })
  })

  it("returns callback failures for agent correction without creating success evidence", async () => {
    const { execute, callbacks, describeTool } = setup()
    await describeTool("chapter_workflow")
    callbacks.executeWorkflowTool.mockRejectedValueOnce(new Error("Draft pipeline failed"))
    expect(await execute({ name: "chapter_workflow", action: "invoke", arguments: '{"userInput":"write"}' })).toMatchObject({ status: "error", message: "Draft pipeline failed" })
  })

  it("propagates cancellation instead of converting it to a recoverable tool error", async () => {
    const { execute, callbacks, describeTool } = setup()
    await describeTool("chapter_workflow")
    const cancellation = new AbortController()
    callbacks.executeWorkflowTool.mockImplementationOnce(async () => {
      cancellation.abort(new Error("Cancelled"))
      throw new Error("Pipeline interrupted")
    })
    await expect(execute({ name: "chapter_workflow", action: "invoke", arguments: '{"userInput":"write"}' }, { signal: cancellation.signal })).rejects.toThrow("Cancelled")
  })

  it("keeps the phase schema opaque and disallows tool requests mixed with writes or choices", () => {
    const artifact = { assistantMessage: "Working", finalSelfReview: "OK", toolRequest: { name: "chapter_workflow", action: "invoke", arguments: "opaque JSON parsed after describe" } }
    expect(synopsisDiscussArtifactSchema.safeParse(artifact).success).toBe(true)
    expect(synopsisDiscussArtifactSchema.safeParse({ ...artifact, synopsisBody: "overwrite" }).success).toBe(false)
    expect(synopsisDiscussArtifactSchema.safeParse({ ...artifact, chapterDraftProposal: { heading: "Test", body: "Draft" } }).success).toBe(false)
    expect(synopsisDiscussArtifactSchema.safeParse({ ...artifact, choices: [] }).success).toBe(false)
    expect(synopsisDiscussArtifactSchema.safeParse({ ...artifact, toolRequest: { ...artifact.toolRequest, arguments: { userInput: "write" } } }).success).toBe(false)
  })
})
