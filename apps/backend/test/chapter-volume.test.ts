import { describe, expect, it } from "vitest"

import {
  assertUniqueVolumeSequence,
  listVolumeFoldersFromInventory,
  remapPathVolumeFolder,
  validateVolumeFolderName,
} from "../src/index.js"

describe("volume sequence uniqueness", () => {
  it("accepts canonical volume folder names", () => {
    expect(validateVolumeFolderName("第一卷 潮水退去时")).toMatchObject({
      ok: true,
      sequence: 1,
      title: "潮水退去时",
    })
    expect(validateVolumeFolderName("第二卷 远行")).toMatchObject({
      ok: true,
      sequence: 2,
    })
  })

  it("rejects a second folder with the same volume sequence", () => {
    const conflict = assertUniqueVolumeSequence("第一卷 新标题", ["第一卷 待命名"])
    expect(conflict.ok).toBe(false)
    if (conflict.ok) return
    expect(conflict.sequence).toBe(1)
    expect(conflict.conflictFolderName).toBe("第一卷 待命名")
    expect(conflict.reason).toContain("已存在")
  })

  it("allows renaming the same volume title in place", () => {
    expect(assertUniqueVolumeSequence("第一卷 潮水退去时", ["第一卷 待命名"], {
      excludeFolderName: "第一卷 待命名",
    })).toEqual({ ok: true })
  })

  it("allows a different sequence alongside an existing volume", () => {
    expect(assertUniqueVolumeSequence("第二卷 远行", ["第一卷 潮水退去时"])).toEqual({ ok: true })
  })

  it("lists volume folders from inventory and remaps paths", () => {
    const volumes = listVolumeFoldersFromInventory([
      { path: "章节正文", kind: "directory" },
      { path: "章节正文/第一卷 潮水退去时", kind: "directory" },
      { path: "章节正文/第一卷 潮水退去时/第一章 开端.md", kind: "file" },
      { path: "章节正文/坏卷名", kind: "directory" },
    ])
    expect(volumes).toEqual([
      {
        path: "章节正文/第一卷 潮水退去时",
        folderName: "第一卷 潮水退去时",
        sequence: 1,
        title: "潮水退去时",
      },
    ])
    expect(remapPathVolumeFolder(
      "章节正文/第一卷 待命名/第一章 开端 [剧情梗概].md",
      "第一卷 待命名",
      "第一卷 潮水退去时",
    )).toBe("章节正文/第一卷 潮水退去时/第一章 开端 [剧情梗概].md")
  })
})
