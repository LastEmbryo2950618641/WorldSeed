import { describe, expect, it } from "vitest"

import {
  findFirstIncompleteVolume,
  isVolumeOutlineReady,
  volumeOutlinePath,
} from "../src/renderer/src/features/editor/volume-batch-deduction.js"

describe("volumeOutlinePath", () => {
  it("builds flat outline path matching the volume folder name", () => {
    expect(volumeOutlinePath("第一卷 开局即仇敌")).toBe("大纲/第一卷 开局即仇敌.md")
  })
})

describe("isVolumeOutlineReady", () => {
  it("requires chapter markers or enough structure", () => {
    expect(isVolumeOutlineReady("")).toBe(false)
    expect(isVolumeOutlineReady("# 大纲\n短")).toBe(false)
    expect(isVolumeOutlineReady([
      "# 第一卷 开局即仇敌",
      "",
      "主线：女主们觉醒记忆。",
      "",
      "## 第 1 章",
      "天道碎裂，主角逃亡。",
      "",
      "## 第 2 章",
      "顾家势力登场。",
    ].join("\n"))).toBe(true)
  })
})

describe("findFirstIncompleteVolume", () => {
  it("returns the first volume that still lacks a body", () => {
    const found = findFirstIncompleteVolume([
      {
        sequence: 1,
        label: "第一章",
        volumeFolderName: "第一卷 A",
        bodyPath: "章节正文/第一卷 A/第一章.md",
      },
      {
        sequence: 2,
        label: "第二章",
        volumeFolderName: "第一卷 A",
      },
      {
        sequence: 3,
        label: "第三章",
        volumeFolderName: "第二卷 B",
      },
    ])
    expect(found?.volumeFolderName).toBe("第一卷 A")
    expect(found?.chapters).toHaveLength(2)
  })
})
