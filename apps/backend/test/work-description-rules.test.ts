import { describe, expect, it } from "vitest"

import {
  AUTO_DESCRIPTION_RULE_PATH,
  assertWorkDescriptionCharLimit,
  assertWorkDescriptionWriteBatch,
  DEAI_DESCRIPTION_RULE_PATH,
  formatDescriptionRuleEvidence,
  formatWorkDescriptionRuleEvidence,
  isAutoDescriptionSelection,
  isDescriptionRuleMarkdownPath,
  isUserPresetPresentationRulePath,
  isWorkDescriptionRulePath,
  listDescriptionRuleFiles,
  listWorkDescriptionRuleFiles,
  resolveDescriptionRulePaths,
  SENSORY_DESCRIPTION_RULE_PATH,
  WORK_DESCRIPTION_MAX_CHARS,
  WORK_DESCRIPTION_MAX_FILES,
  WORK_DESCRIPTION_RULES_DIR,
} from "../src/core/workspace/work-description-rules.js"

describe("work description overlay rules", () => {
  it("accepts direct-child overlay markdown and rejects user presets", () => {
    expect(isWorkDescriptionRulePath(`${WORK_DESCRIPTION_RULES_DIR}/压抑氛围.md`)).toBe(true)
    expect(isWorkDescriptionRulePath("表现输出/描写规则/近景跟随.md")).toBe(false)
    expect(isWorkDescriptionRulePath(`${WORK_DESCRIPTION_RULES_DIR}/nested/x.md`)).toBe(false)
    expect(isUserPresetPresentationRulePath("表现输出/描写规则/近景跟随.md")).toBe(true)
    expect(isUserPresetPresentationRulePath("表现输出/笔风规则/克制叙述.md")).toBe(true)
    expect(isUserPresetPresentationRulePath(`${WORK_DESCRIPTION_RULES_DIR}/压抑氛围.md`)).toBe(false)
  })

  it("lists overlay files and fails visibly on nested paths or overflow", () => {
    expect(listWorkDescriptionRuleFiles([
      { relativePath: `${WORK_DESCRIPTION_RULES_DIR}/b.md`, entryKind: "file" },
      { relativePath: `${WORK_DESCRIPTION_RULES_DIR}/a.md`, entryKind: "file" },
      { relativePath: "表现输出/描写规则/近景跟随.md", entryKind: "file" },
    ]).map((entry) => entry.relativePath)).toEqual([
      `${WORK_DESCRIPTION_RULES_DIR}/a.md`,
      `${WORK_DESCRIPTION_RULES_DIR}/b.md`,
    ])
    expect(() => listWorkDescriptionRuleFiles([
      { relativePath: `${WORK_DESCRIPTION_RULES_DIR}/子目录`, entryKind: "directory" },
    ])).toThrow(/子文件夹/)
    const overflow = Array.from({ length: WORK_DESCRIPTION_MAX_FILES + 1 }, (_, index) => ({
      relativePath: `${WORK_DESCRIPTION_RULES_DIR}/f${String(index)}.md`,
      entryKind: "file" as const,
    }))
    expect(() => listWorkDescriptionRuleFiles(overflow)).toThrow(/最多 8 个文件/)
  })

  it("wraps overlay evidence and rejects oversized files and write batches", () => {
    const wrapped = formatWorkDescriptionRuleEvidence(`${WORK_DESCRIPTION_RULES_DIR}/压抑氛围.md`, "# 压抑\n")
    expect(wrapped).toContain("【本作品描写·附加层】")
    expect(wrapped).toContain("以选中文件为准")
    expect(wrapped).toContain("# 压抑")
    expect(() => assertWorkDescriptionCharLimit(
      `${WORK_DESCRIPTION_RULES_DIR}/过长.md`,
      "字".repeat(WORK_DESCRIPTION_MAX_CHARS + 1),
    )).toThrow(/4000 字/)
    expect(() => assertWorkDescriptionWriteBatch({
      existingPaths: [],
      writes: [{ relativePath: "表现输出/描写规则/近景跟随.md", markdown: "# no\n" }],
    })).toThrow(/本作品描写/)
    const existing = Array.from({ length: WORK_DESCRIPTION_MAX_FILES }, (_, index) => (
      `${WORK_DESCRIPTION_RULES_DIR}/existing-${String(index)}.md`
    ))
    expect(() => assertWorkDescriptionWriteBatch({
      existingPaths: existing,
      writes: [{ relativePath: `${WORK_DESCRIPTION_RULES_DIR}/extra.md`, markdown: "# extra\n" }],
    })).toThrow(/写入后将达到/)
  })

  it("injects every description rule in auto mode and always keeps sensory and de-AI baselines when locked", () => {
    const catalog = [
      { relativePath: "表现输出/描写规则/近景跟随.md", entryKind: "file" },
      { relativePath: AUTO_DESCRIPTION_RULE_PATH, entryKind: "file" },
      { relativePath: SENSORY_DESCRIPTION_RULE_PATH, entryKind: "file" },
      { relativePath: DEAI_DESCRIPTION_RULE_PATH, entryKind: "file" },
      { relativePath: "表现输出/描写规则/过场白描.md", entryKind: "file" },
      { relativePath: "表现输出/笔风规则/默认笔风规则.md", entryKind: "file" },
    ]
    expect(isAutoDescriptionSelection(undefined)).toBe(true)
    expect(isAutoDescriptionSelection("")).toBe(true)
    expect(isAutoDescriptionSelection(AUTO_DESCRIPTION_RULE_PATH)).toBe(true)
    expect(isAutoDescriptionSelection("表现输出/描写规则/近景跟随.md")).toBe(false)
    expect(isDescriptionRuleMarkdownPath(AUTO_DESCRIPTION_RULE_PATH)).toBe(true)
    expect(listDescriptionRuleFiles(catalog).map((entry) => entry.relativePath)).toEqual([
      AUTO_DESCRIPTION_RULE_PATH,
      SENSORY_DESCRIPTION_RULE_PATH,
      DEAI_DESCRIPTION_RULE_PATH,
      "表现输出/描写规则/过场白描.md",
      "表现输出/描写规则/近景跟随.md",
    ])
    expect(resolveDescriptionRulePaths(undefined, catalog)).toEqual([
      AUTO_DESCRIPTION_RULE_PATH,
      SENSORY_DESCRIPTION_RULE_PATH,
      DEAI_DESCRIPTION_RULE_PATH,
      "表现输出/描写规则/过场白描.md",
      "表现输出/描写规则/近景跟随.md",
    ])
    expect(resolveDescriptionRulePaths("表现输出/描写规则/近景跟随.md", catalog)).toEqual([
      SENSORY_DESCRIPTION_RULE_PATH,
      DEAI_DESCRIPTION_RULE_PATH,
      "表现输出/描写规则/近景跟随.md",
    ])
    expect(resolveDescriptionRulePaths(SENSORY_DESCRIPTION_RULE_PATH, catalog)).toEqual([
      SENSORY_DESCRIPTION_RULE_PATH,
      DEAI_DESCRIPTION_RULE_PATH,
    ])
    expect(formatDescriptionRuleEvidence(AUTO_DESCRIPTION_RULE_PATH, "# 自动\n", true))
      .toContain("【描写·自动调度】")
    expect(formatDescriptionRuleEvidence(SENSORY_DESCRIPTION_RULE_PATH, "# 感官\n", true))
      .toContain("【描写·感官基线·本轮始终生效】")
    expect(formatDescriptionRuleEvidence(DEAI_DESCRIPTION_RULE_PATH, "# 去AI味\n", false))
      .toContain("【描写·去AI味基线·本轮始终生效】")
    expect(formatDescriptionRuleEvidence("表现输出/描写规则/近景跟随.md", "# 近景\n", true))
      .toContain("【描写场面卡】")
    expect(formatDescriptionRuleEvidence("表现输出/描写规则/近景跟随.md", "# 近景\n", false))
      .toContain("【描写·本轮锁定】")
  })
})
