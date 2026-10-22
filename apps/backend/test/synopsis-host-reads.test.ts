import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  executeSynopsisHostReads,
  foldPathPunctuation,
  isAbsoluteHostPath,
} from "../src/application/chapters/synopsis-host-reads.js"
import type { PhaseResultEnvelope } from "@worldseed/contracts"

function hostRequest(partial: {
  exactKeys: string[]
  semanticTexts?: string[]
  readMode?: "read_full" | "list" | "grep"
}): PhaseResultEnvelope["requestedReads"][number] {
  return {
    requestId: "22222222-2222-4222-8222-222222222222",
    reason: "host test",
    expectedEvidence: "evidence",
    query: {
      exactKeys: partial.exactKeys,
      semanticTexts: partial.semanticTexts ?? [],
      anchorIds: [],
      directions: ["both"],
      maxCandidates: 24,
      maxDepth: 2,
      sourceKinds: ["reference"],
      ...(partial.readMode === undefined ? {} : { readMode: partial.readMode }),
    },
  }
}

describe("synopsis host reads", () => {
  it("detects absolute host paths on Windows and POSIX forms", () => {
    expect(isAbsoluteHostPath("C:/Users/demo/notes.md")).toBe(true)
    expect(isAbsoluteHostPath("C:\\Users\\demo\\notes.md")).toBe(true)
    expect(isAbsoluteHostPath("/home/demo/notes.md")).toBe(true)
    expect(isAbsoluteHostPath("设定集/readme.md")).toBe(false)
    expect(isAbsoluteHostPath("章节正文/第一卷/第一章.md")).toBe(false)
  })

  it("lists and reads absolute host directories/files", async () => {
    const root = await mkdtemp(join(tmpdir(), "worldseed-host-read-"))
    const nested = join(root, "refs")
    await mkdir(nested)
    const notePath = join(nested, "note.md")
    await writeFile(notePath, "\uFEFF# host note\nalpha beta\n", "utf8")

    let id = 0
    const createId = () => {
      id += 1
      return `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`
    }

    const listed = await executeSynopsisHostReads({
      requests: [hostRequest({ exactKeys: [root], readMode: "list" })],
      existingEvidence: [],
      createId,
    })
    expect(listed).toHaveLength(1)
    expect(listed[0]?.ownerKind).toBe("host:fs:list")
    expect(listed[0]?.semanticText).toContain("refs/")

    const full = await executeSynopsisHostReads({
      requests: [hostRequest({ exactKeys: [notePath] })],
      existingEvidence: [],
      createId,
    })
    expect(full).toHaveLength(1)
    expect(full[0]?.ownerKind).toBe("host:fs")
    expect(full[0]?.semanticText).toContain("alpha beta")
    expect(full[0]?.semanticText).not.toContain("\uFEFF")

    const grepped = await executeSynopsisHostReads({
      requests: [hostRequest({
        exactKeys: [notePath],
        semanticTexts: ["alpha"],
        readMode: "grep",
      })],
      existingEvidence: [],
      createId,
    })
    expect(grepped.some((item) => item.ownerKind === "host:fs:grep")).toBe(true)
    expect(grepped[0]?.semanticText).toContain("alpha")
  })

  it("returns diagnostic evidence for missing absolute paths", async () => {
    let id = 0
    const createId = () => {
      id += 1
      return `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`
    }
    const missing = join(tmpdir(), `worldseed-missing-${String(Date.now())}.md`)
    const evidence = await executeSynopsisHostReads({
      requests: [hostRequest({ exactKeys: [missing] })],
      existingEvidence: [],
      createId,
    })
    expect(evidence).toHaveLength(1)
    expect(evidence[0]?.ownerKind).toBe("host:fs:diagnostic")
  })

  it("resolves ASCII ? when the real folder uses fullwidth ？", async () => {
    const root = await mkdtemp(join(tmpdir(), "worldseed-host-punct-"))
    const realDir = join(root, "完蛋了？无数女修追杀我!")
    await mkdir(realDir)
    await writeFile(join(realDir, "第一章.md"), "# one\n", "utf8")

    let id = 0
    const createId = () => {
      id += 1
      return `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`
    }

    expect(foldPathPunctuation("完蛋了？x!")).toBe("完蛋了?x!")

    const mistyped = join(root, "完蛋了?无数女修追杀我!")
    const listed = await executeSynopsisHostReads({
      requests: [hostRequest({ exactKeys: [mistyped], readMode: "list" })],
      existingEvidence: [],
      createId,
    })
    expect(listed).toHaveLength(1)
    expect(listed[0]?.ownerKind).toBe("host:fs:list")
    expect(listed[0]?.semanticText).toContain("第一章.md")
    expect(listed[0]?.ownerId).toContain("？")
  })
})
