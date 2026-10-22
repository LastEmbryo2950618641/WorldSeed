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
    restageChapter: vi.fn(async () => ({
      chapterSequence: 7,
      targetStage: "synopsis" as const,
      reason: "rewrite",
      synopsisConfirmedCleared: true,
      focusKind: "plot_synopsis" as const,
      clearedOutlinePath: "章节正文/第一卷 示例/第七章 标题 [剧情细纲].md",
      archivedBodyPath: "章节正文/第一卷 示例/第七章 标题.md",
      retiredBodyPath: "章节正文/第一卷 示例/第七章 标题 [已回退].md",
    })),
    runBash: vi.fn(async () => ({
      cwd: "workspace",
      command: "echo ok",
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "ok\n",
      stderr: "",
      truncated: false,
    })),
    writeTodos: vi.fn(async (input) => ({
      todos: input.todos,
      merge: input.merge === true,
    })),
    writeMemory: vi.fn(async (input) => ({
      relativePath: input.target === "index"
        ? "世界推演规则/Agent记忆/MEMORY.md"
        : `世界推演规则/Agent记忆/${input.filename ?? "topic.md"}`,
      target: input.target,
      truncated: false,
      byteLength: input.markdown.length,
    })),
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
    expect(catalog).toContain("restage_chapter")
    expect(catalog).toContain("bash")
    expect(catalog).toContain("todo_write")
    expect(catalog).toContain("memory_write")
    expect(catalog).toContain("正文推演工具")
    expect(catalog).toContain("图治理工具")
    expect(catalog).toContain("工作区 Bash")
    expect(catalog).toContain("Todo 清单")
    expect(catalog).toContain("Agent 记忆")
    expect(catalog).not.toContain("userInput")
    expect(catalog).not.toContain("revisionTaskId")
    expect(catalog).not.toContain("writingGuide")
    expect(JSON.parse(synopsisToolCatalog({})).tools).toEqual([])
  })

  it("describes and invokes memory_write", async () => {
    const { execute, callbacks, describeTool } = setup()
    await describeTool("memory_write")
    expect(await execute({
      name: "memory_write",
      action: "invoke",
      arguments: JSON.stringify({
        target: "index",
        markdown: "# Agent 记忆索引\n\n- 偏好短句\n",
      }),
    })).toMatchObject({
      status: "memory_written",
      result: {
        relativePath: "世界推演规则/Agent记忆/MEMORY.md",
        target: "index",
      },
    })
    expect(callbacks.writeMemory).toHaveBeenCalledWith({
      ...context,
      target: "index",
      markdown: "# Agent 记忆索引\n\n- 偏好短句\n",
    })
    expect(await execute({
      name: "memory_write",
      action: "invoke",
      arguments: JSON.stringify({
        target: "topic",
        filename: "preferences.md",
        markdown: "# 偏好\n\n短句。\n",
      }),
    })).toMatchObject({
      status: "memory_written",
      result: {
        relativePath: "世界推演规则/Agent记忆/preferences.md",
        target: "topic",
      },
    })
  })

  it("describes and invokes todo_write", async () => {
    const { execute, callbacks, describeTool } = setup()
    await describeTool("todo_write")
    const todos = [{ id: "1", content: "读设定", status: "in_progress" as const }]
    expect(await execute({
      name: "todo_write",
      action: "invoke",
      arguments: JSON.stringify({ todos, merge: false }),
    })).toMatchObject({
      status: "todos_updated",
      result: { todos, merge: false },
    })
    expect(callbacks.writeTodos).toHaveBeenCalledWith({
      ...context,
      todos,
      merge: false,
    })
  })

  it("describes and invokes bash inside the workspace", async () => {
    const { execute, callbacks, describeTool } = setup()
    expect(await execute({
      name: "bash",
      action: "invoke",
      arguments: JSON.stringify({ command: "echo ok" }),
    })).toMatchObject({ code: "describe_required" })
    await describeTool("bash")
    expect(await execute({
      name: "bash",
      action: "invoke",
      arguments: JSON.stringify({ command: "echo ok", cwd: ".", timeoutMs: 5000 }),
    })).toMatchObject({
      status: "bash_completed",
      result: { exitCode: 0, stdout: "ok\n" },
    })
    expect(callbacks.runBash).toHaveBeenCalledWith({
      ...context,
      command: "echo ok",
      cwd: ".",
      timeoutMs: 5000,
    })
  })

  it("describes and invokes restage_chapter for synopsis demotion", async () => {
    const { execute, callbacks, describeTool } = setup()
    expect(await execute({
      name: "restage_chapter",
      action: "invoke",
      arguments: JSON.stringify({ targetStage: "synopsis", reason: "rewrite ch1" }),
    })).toMatchObject({ code: "describe_required" })
    await describeTool("restage_chapter")
    expect(await execute({
      name: "restage_chapter",
      action: "invoke",
      arguments: JSON.stringify({ targetStage: "synopsis", reason: "rewrite ch1" }),
    })).toMatchObject({
      status: "restaged",
      result: { targetStage: "synopsis", synopsisConfirmedCleared: true },
    })
    expect(callbacks.restageChapter).toHaveBeenCalledWith({
      ...context,
      targetStage: "synopsis",
      reason: "rewrite ch1",
    })
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

  it("passes chapterSequences for multi-chapter draft invokes", async () => {
    const { execute, callbacks, describeTool } = setup()
    await describeTool("chapter_workflow")
    callbacks.executeWorkflowTool.mockResolvedValueOnce({
      ...draft,
      drafts: [
        { ...draft, chapterSequence: 1 },
        { ...draft, revisionTaskId: "r2", draftVersionId: "d2", chapterSequence: 2 },
      ],
    })
    expect(await execute({
      name: "chapter_workflow",
      action: "invoke",
      arguments: JSON.stringify({ userInput: "Write volume drafts", chapterSequences: [1, 2] }),
    })).toMatchObject({ status: "drafts_created", chapterCount: 2 })
    expect(callbacks.executeWorkflowTool).toHaveBeenCalledWith({
      ...context,
      userInput: "Write volume drafts",
      chapterSequences: [1, 2],
    })
  })

  it("omits chapter_workflow from catalog and returns clear error when callback is disabled", async () => {
    const callbacks: SynopsisWorkflowToolCallbacks = {
      publishDraft: vi.fn(),
      restageChapter: vi.fn(),
      runBash: vi.fn(),
      writeTodos: vi.fn(),
    }
    const catalog = JSON.parse(synopsisToolCatalog(callbacks)) as { tools: readonly { name: string }[] }
    expect(catalog.tools.some((tool) => tool.name === "chapter_workflow")).toBe(false)
    const result = await executeSynopsisTool({
      request: { name: "chapter_workflow", action: "describe" },
      context,
      callbacks,
      visibleMessages: [],
      listDrafts: async () => [],
    })
    expect(result).toMatchObject({
      code: "tool_unavailable",
      message: expect.stringContaining("正文推演工具未启用"),
    })
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
