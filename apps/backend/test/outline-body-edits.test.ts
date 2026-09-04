import { createHash, randomUUID } from "node:crypto"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { PROTOCOL_VERSION } from "@worldseed/contracts"
import { synopsisDiscussArtifactSchema } from "@worldseed/prompt-contracts"

import { applySearchReplace } from "../src/application/chapters/markdown-search-replace.js"
import { openChapterHarness, type ChapterHarness } from "./helpers/chapter-coordination-harness.js"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function withHarness(run: (harness: ChapterHarness) => Promise<void>): Promise<void> {
  const harness = await openChapterHarness("Outline Body Edits Test")
  temporaryRoots.push(harness.root)
  try {
    await run(harness)
  } finally {
    await harness.container.close()
  }
}

async function invoke<T>(harness: ChapterHarness, method: string, payload: Record<string, unknown>): Promise<T> {
  const response = await harness.facade.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    method,
    payload,
  })
  if (!response.ok) expect.fail(JSON.stringify(response.error))
  return response.data as T
}

function outlinePathFromSynopsis(synopsisPath: string): string {
  return synopsisPath.replace("[剧情梗概].md", "[剧情细纲].md")
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

describe("synopsisDiscussArtifactSchema bodyEdits", () => {
  it("rejects outlineBody and bodyEdits in the same artifact", () => {
    const parsed = synopsisDiscussArtifactSchema.safeParse({
      assistantMessage: "同时交两通道",
      outlineBody: "# 细纲\n\n内容",
      bodyEdits: {
        target: "outline",
        ops: [{ oldText: "内容", newText: "改" }],
      },
      finalSelfReview: "mutex",
    })
    expect(parsed.success).toBe(false)
  })

  it("accepts bodyEdits alone", () => {
    const parsed = synopsisDiscussArtifactSchema.safeParse({
      assistantMessage: "局部改",
      bodyEdits: {
        target: "outline",
        ops: [{ oldText: "旧", newText: "新" }],
      },
      finalSelfReview: "ok",
    })
    expect(parsed.success).toBe(true)
  })
})

describe("outline bodyEdits integration", () => {
  it("writes full outline on confirm, then applies bodyEdits without wiping other sections", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      await invoke(harness, "synopsis.conversation.start", base)
      await invoke(harness, "synopsis.conversation.send", {
        ...base,
        message: "雨夜站台，林序追查名单",
      })
      const confirmed = await invoke<{
        session: { synopsisPath: string }
        messages: Array<{ role: string; content: string }>
      }>(harness, "synopsis.conversation.send", {
        ...base,
        message: "用这份梗概写细纲",
      })
      const outlineRel = outlinePathFromSynopsis(confirmed.session.synopsisPath)
      const outlineAbs = join(harness.workspaceRootRef, outlineRel)
      const firstOutline = readFileSync(outlineAbs, "utf8")
      expect(firstOutline).toContain("### 场 1 开场")
      expect(firstOutline).toContain("### 场 2 推进")
      expect(firstOutline).toContain("### 场 3 落点")

      const patched = await invoke<{
        messages: Array<{ role: string; content: string }>
      }>(harness, "synopsis.conversation.send", {
        ...base,
        message: "再修改细纲：收紧场2张力",
      })
      const assistant = [...patched.messages].reverse().find((message) => message.role === "assistant")
      expect(assistant?.content).toMatch(/已局部更新细纲/)
      const nextOutline = readFileSync(outlineAbs, "utf8")
      expect(nextOutline).toContain("### 场 1 开场")
      expect(nextOutline).toContain("### 场 3 落点")
      expect(nextOutline).toContain("按用户要求收紧")
      expect(nextOutline).not.toBe(firstOutline)
    })
  })

  it("skips bodyEdits when the user hand-edited the outline file", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      await invoke(harness, "synopsis.conversation.start", base)
      await invoke(harness, "synopsis.conversation.send", {
        ...base,
        message: "雨夜站台，林序追查名单",
      })
      const confirmed = await invoke<{
        session: { synopsisPath: string }
      }>(harness, "synopsis.conversation.send", {
        ...base,
        message: "用这份梗概写细纲",
      })
      const outlineRel = outlinePathFromSynopsis(confirmed.session.synopsisPath)
      const outlineAbs = join(harness.workspaceRootRef, outlineRel)
      const handEdited = `${readFileSync(outlineAbs, "utf8").trim()}\n\n> 作者手改标记\n`
      writeFileSync(outlineAbs, handEdited, "utf8")

      const sent = await invoke<{
        messages: Array<{ role: string; content: string }>
      }>(harness, "synopsis.conversation.send", {
        ...base,
        message: "再修改细纲：收紧场2张力",
      })
      const assistant = [...sent.messages].reverse().find((message) => message.role === "assistant")
      expect(assistant?.content).toMatch(/你刚改过细纲文件/)
      expect(readFileSync(outlineAbs, "utf8")).toBe(handEdited)
    })
  })

  it("fails loud without writing when oldText is missing", () => {
    const source = "## 分场节拍\n场1：旧冲突\n## 信息边界\n可写：A\n"
    const beforeDigest = digestText(source)
    const result = applySearchReplace(source, [{ oldText: "不存在的锚点", newText: "新" }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("找不到要替换的原文")
    expect(digestText(source)).toBe(beforeDigest)
  })
})
