import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readPlanningFile } from "../src/renderer/src/features/editor/read-planning-file.js"

describe("opening renamed planning files", () => {
  it("reads the renamed file and returns its real path for subsequent saves", async () => {
    const root = await mkdtemp(join(tmpdir(), "worldseed-planning-read-"))
    const dir = "章节正文/第一卷 开局即仇敌"
    const oldPath = `${dir}/第二章 [剧情细纲].md`
    const path = `${dir}/第二章 清河会 [剧情细纲].md`
    try {
      await mkdir(join(root, dir), { recursive: true })
      await writeFile(join(root, path), "细纲正文", "utf8")
      const result = await readPlanningFile(oldPath, {
        read: (relativePath) => readFile(join(root, relativePath), "utf8"),
        listPaths: async () => (await readdir(join(root, dir))).map((name) => `${dir}/${name}`),
      })
      expect(result).toEqual({ path, content: "细纲正文" })
      await writeFile(join(root, result.path), "编辑后的细纲", "utf8")
      expect(await readFile(join(root, path), "utf8")).toBe("编辑后的细纲")
      expect(await readdir(join(root, dir))).toEqual(["第二章 清河会 [剧情细纲].md"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not refresh or redirect on permission and transport errors", async () => {
    for (const error of [new Error("EACCES: permission denied"), new Error("backend disconnected")]) {
      await expect(readPlanningFile("章节正文/第一卷 测试/第二章 [剧情细纲].md", {
        read: () => Promise.reject(error),
        listPaths: () => Promise.reject(new Error("must not refresh")),
      })).rejects.toBe(error)
    }
  })

  it("reports missing or ambiguous files without creating a placeholder", async () => {
    const oldPath = "章节正文/第一卷 测试/第二章 [剧情细纲].md"
    for (const paths of [[], [oldPath.replace("第二章", "第二章 甲"), oldPath.replace("第二章", "第二章 乙")]]) {
      await expect(readPlanningFile(oldPath, {
        read: () => Promise.reject(new Error("ENOENT: no such file or directory, realpath")),
        listPaths: () => Promise.resolve(paths),
      })).rejects.toThrow("请刷新工作目录")
    }
  })
})
