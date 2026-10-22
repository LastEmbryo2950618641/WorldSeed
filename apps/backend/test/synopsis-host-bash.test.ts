import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  assertBashCommandRespectsWorkspaceWrites,
  buildWindowsUtf8CmdScript,
  decodeShellOutputBuffer,
  executeSynopsisHostBash,
  resolveBashCwdInsideWorkspace,
} from "../src/application/chapters/synopsis-host-bash.js"
import {
  stripUtf8Bom,
  writeTextFileUtf8,
} from "../src/application/chapters/text-utf8.js"

describe("synopsis host bash", () => {
  it("keeps cwd inside the workspace and rejects outside cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "worldseed-bash-cwd-"))
    const nested = join(root, "子目录")
    await mkdir(nested)

    const defaultCwd = await resolveBashCwdInsideWorkspace(root, undefined)
    expect(defaultCwd.replaceAll("\\", "/").toLocaleLowerCase())
      .toBe(root.replaceAll("\\", "/").toLocaleLowerCase())

    const relative = await resolveBashCwdInsideWorkspace(root, "子目录")
    expect(relative.replaceAll("\\", "/").toLocaleLowerCase())
      .toBe(nested.replaceAll("\\", "/").toLocaleLowerCase())

    await expect(resolveBashCwdInsideWorkspace(root, join(tmpdir(), "outside")))
      .rejects.toThrow(/必须位于项目工作区内/)
  })

  it("rejects redirects to absolute paths outside the workspace", () => {
    const root = join(tmpdir(), "worldseed-bash-redirect-root")
    expect(() => assertBashCommandRespectsWorkspaceWrites(root, "echo hi > note.md")).not.toThrow()
    expect(() => assertBashCommandRespectsWorkspaceWrites(root, `echo hi > ${join(root, "ok.txt")}`)).not.toThrow()
    expect(() => assertBashCommandRespectsWorkspaceWrites(
      root,
      `echo hi > ${join(tmpdir(), "leak.txt")}`,
    )).toThrow(/禁止把 bash 输出重定向到工作区外/)
  })

  it("decodes GBK shell bytes instead of leaving UTF-8 mojibake", () => {
    // GBK/CP936 for 「完蛋」: CD EA B5 B0
    const gbk = Buffer.from([0xcd, 0xea, 0xb5, 0xb0])
    const decoded = decodeShellOutputBuffer(gbk)
    expect(decoded).toBe("完蛋")
    expect(decoded).not.toContain("\uFFFD")
  })

  it("runs commands with workspace cwd and can write inside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "worldseed-bash-ws-"))
    const isWindows = process.platform === "win32"
    const written = await executeSynopsisHostBash({
      workspaceRootRef: workspace,
      command: isWindows ? "echo from-bash> imported.txt" : "printf 'from-bash\\n' > imported.txt",
    })
    expect(written, `${written.stderr}\n${written.stdout}`).toMatchObject({ exitCode: 0, timedOut: false })
    expect((await readFile(join(workspace, "imported.txt"), "utf8")).trim()).toBe("from-bash")

    const listed = await executeSynopsisHostBash({
      workspaceRootRef: workspace,
      command: isWindows ? "dir /b" : "ls",
    })
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain("imported.txt")
  })

  it("lists host dirs whose names contain fullwidth punctuation and !", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "worldseed-bash-ws-"))
    const hostParent = await mkdtemp(join(tmpdir(), "worldseed-bash-host-"))
    const hostDir = join(hostParent, "完蛋了？无数女修追杀我!")
    await mkdir(hostDir)
    await writeFile(join(hostDir, "第二章 我又死了？.md"), "# ch2\n", "utf8")

    const isWindows = process.platform === "win32"
    const listed = await executeSynopsisHostBash({
      workspaceRootRef: workspace,
      command: isWindows
        ? `dir /b "${hostDir}"`
        : `ls "${hostDir}"`,
    })
    expect(listed, `${listed.stderr}\n${listed.stdout}`).toMatchObject({ exitCode: 0, timedOut: false })
    expect(listed.stdout).toContain("第二章 我又死了？.md")
  })

  it("builds a UTF-8 cmd script that forces chcp 65001", () => {
    const script = buildWindowsUtf8CmdScript('dir /b "C:\\tmp\\完蛋了？x!"')
    expect(script).toContain("chcp 65001>nul")
    expect(script).toContain('dir /b "C:\\tmp\\完蛋了？x!"')
    expect(script.startsWith("@echo off")).toBe(true)
  })

  it("strips UTF-8 BOM so command/path strings stay unified", async () => {
    expect(stripUtf8Bom("\uFEFF完蛋了？")).toBe("完蛋了？")
    const workspace = await mkdtemp(join(tmpdir(), "worldseed-bash-bom-"))
    const path = join(workspace, "note.txt")
    await writeTextFileUtf8(path, "\uFEFFhello-中文")
    const raw = await readFile(path)
    expect(raw[0]).not.toBe(0xef)
    expect(raw.toString("utf8")).toBe("hello-中文")
  })
})
