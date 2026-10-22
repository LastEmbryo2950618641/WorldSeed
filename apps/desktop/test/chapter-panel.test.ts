import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { DeductionGoal } from "@worldseed/contracts"

import {
  ChapterPanel,
  extractSynopsisPreview,
  nextCardSize,
  resolveChapterCupState,
  resolveChapterPanelStage,
} from "../src/renderer/src/features/editor/ChapterPanel.js"
import { isHookScheduleIncomplete, listChapterHooks } from "../src/renderer/src/features/editor/ChapterBrowseDetailRail.js"
import { validateHookScheduleTaxonomy } from "../src/renderer/src/features/editor/CreationDeskGoalsPopover.js"
import { EditorArea } from "../src/renderer/src/features/editor/EditorArea.js"
import {
  BATCH_VOLUME_DRAFT_USER_MESSAGE,
  BATCH_VOLUME_PLAN_USER_MESSAGE,
  batchDeductionStatusLabel,
  batchPhaseTargetStage,
  createIdleBatchStatus,
  volumeChaptersHavePlans,
} from "../src/renderer/src/features/editor/batch-chapter-deduction.js"
import {
  buildVolumeHookDensityReport,
  detectHookDensityWarning,
} from "../src/renderer/src/features/editor/volume-hook-density.js"

vi.mock("../src/renderer/src/api/client.js", () => ({
  invokeBackend: vi.fn(async () => ({ content: "" })),
}))

vi.mock("@monaco-editor/react", () => ({
  Editor: () => null,
  loader: { config: () => {} },
}))

vi.mock("../src/renderer/src/monaco.js", () => ({
  WORLDSEED_EDITOR_THEME: "worldseed-dark",
  ensureWorldseedEditorTheme: () => {},
}))

describe("extractSynopsisPreview", () => {
  it("strips headings and truncates plain text", () => {
    const preview = extractSynopsisPreview("# 第一章\n\n主角在雨夜抵达驿站，发现信使已经离开。", 16)
    expect(preview).toBe("主角在雨夜抵达驿站，发现信使已经…")
  })
})

describe("nextCardSize", () => {
  it("cycles large → medium → small → tile → large", () => {
    expect(nextCardSize("large")).toBe("medium")
    expect(nextCardSize("medium")).toBe("small")
    expect(nextCardSize("small")).toBe("tile")
    expect(nextCardSize("tile")).toBe("large")
  })
})

describe("isHookScheduleIncomplete", () => {
  it("flags foreshadow missing payoff", () => {
    expect(isHookScheduleIncomplete({
      goalId: "g1",
      content: "雨夜信使",
      narrativeKind: "foreshadow",
      scale: "long",
      lifecycle: "active",
      source: "user",
      createdAtMs: 1,
      plantChapterSequence: 1,
    } as unknown as DeductionGoal)).toBe(true)
    expect(isHookScheduleIncomplete({
      goalId: "g2",
      content: "雨夜信使",
      narrativeKind: "foreshadow",
      scale: "long",
      lifecycle: "active",
      source: "user",
      createdAtMs: 1,
      plantChapterSequence: 1,
      payoffChapterSequence: 3,
    } as unknown as DeductionGoal)).toBe(false)
  })
})

describe("validateHookScheduleTaxonomy", () => {
  it("requires plant and payoff for foreshadow when the flag is on", () => {
    expect(validateHookScheduleTaxonomy({
      narrativeKind: "foreshadow",
      scale: "long",
      plantChapterSequence: 1,
    }, true)).toContain("兑现章")
    expect(validateHookScheduleTaxonomy({
      narrativeKind: "foreshadow",
      scale: "long",
      plantChapterSequence: 1,
      payoffChapterSequence: 3,
    }, true)).toBeUndefined()
    expect(validateHookScheduleTaxonomy({
      narrativeKind: "foreshadow",
      scale: "long",
      plantChapterSequence: 1,
    }, false)).toBeUndefined()
  })
})

describe("buildVolumeHookDensityReport", () => {
  it("counts plants/payoffs per chapter and lists concrete hooks", () => {
    const report = buildVolumeHookDensityReport(
      [
        { sequence: 1, label: "第一章 A", volumeFolderName: "第一卷 测试" },
        { sequence: 2, label: "第二章 B", volumeFolderName: "第一卷 测试" },
        { sequence: 3, label: "第三章 C", volumeFolderName: "第一卷 测试" },
      ],
      [
        {
          goalId: "g1",
          content: "雨夜信使",
          narrativeKind: "foreshadow",
          scale: "long",
          lifecycle: "active",
          source: "user",
          createdAtMs: 1,
          plantChapterSequence: 1,
        },
        {
          goalId: "g2",
          content: "天道崩裂",
          narrativeKind: "climax",
          scale: "long",
          lifecycle: "active",
          source: "agent",
          createdAtMs: 2,
          plantChapterSequence: 1,
          payoffChapterSequence: 3,
        },
        {
          goalId: "g3",
          content: "第二章埋伏",
          narrativeKind: "foreshadow",
          scale: "medium",
          lifecycle: "active",
          source: "user",
          createdAtMs: 3,
          plantChapterSequence: 2,
        },
      ] as unknown as readonly DeductionGoal[],
    )
    expect(report.totals.hookCount).toBe(3)
    expect(report.totals.plantCount).toBe(3)
    expect(report.totals.payoffCount).toBe(1)
    expect(report.totals.incompleteSchedule).toBe(2)
    expect(report.chapterRows[0]?.plantCount).toBe(2)
    expect(report.chapterRows[0]?.hooks.map((item) => item.goalId)).toEqual(["g1", "g2"])
    expect(report.chapterRows[2]?.payoffCount).toBe(1)
    expect(report.chapterRows[2]?.hooks.some((item) => item.roles.includes("payoff"))).toBe(true)
    expect(detectHookDensityWarning(report.chapterRows, report.totals)).toContain("时限不完整")
  })

  it("warns when several chapters plant without payoff", () => {
    const rows = [
      {
        chapterSequence: 1,
        chapterLabel: "第一章",
        plantCount: 1,
        payoffCount: 0,
        hookCount: 1,
        statusCounts: {
          incompleteSchedule: 1,
          completeSchedule: 0,
          planned: 0,
          partial: 0,
          achieved: 0,
          missed: 0,
          noProgress: 1,
        },
        hooks: [],
      },
      {
        chapterSequence: 2,
        chapterLabel: "第二章",
        plantCount: 1,
        payoffCount: 0,
        hookCount: 1,
        statusCounts: {
          incompleteSchedule: 1,
          completeSchedule: 0,
          planned: 0,
          partial: 0,
          achieved: 0,
          missed: 0,
          noProgress: 1,
        },
        hooks: [],
      },
      {
        chapterSequence: 3,
        chapterLabel: "第三章",
        plantCount: 1,
        payoffCount: 0,
        hookCount: 1,
        statusCounts: {
          incompleteSchedule: 1,
          completeSchedule: 0,
          planned: 0,
          partial: 0,
          achieved: 0,
          missed: 0,
          noProgress: 1,
        },
        hooks: [],
      },
    ]
    expect(detectHookDensityWarning(rows, {
      hookCount: 3,
      plantCount: 3,
      payoffCount: 0,
      incompleteSchedule: 3,
      completeSchedule: 0,
    })).toContain("只埋未收")
  })
})

describe("listChapterHooks", () => {
  it("keeps foreshadow and climax goals for the chapter", () => {
    const goals = [
      {
        goalId: "g1",
        content: "雨夜信使未归",
        narrativeKind: "foreshadow",
        scale: "short",
        lifecycle: "active",
        source: "user",
        createdAtMs: 1,
        plantChapterSequence: 1,
        payoffChapterSequence: 3,
      },
      {
        goalId: "g2",
        content: "日常目标",
        narrativeKind: "general",
        scale: "short",
        lifecycle: "active",
        source: "user",
        createdAtMs: 2,
      },
      {
        goalId: "g3",
        content: "对峙爆发",
        narrativeKind: "climax",
        scale: "medium",
        lifecycle: "active",
        source: "agent",
        createdAtMs: 3,
        plantChapterSequence: 2,
        payoffChapterSequence: 2,
      },
    ] as unknown as readonly DeductionGoal[]
    const hooks = listChapterHooks(goals, 2)
    expect(hooks.map((item) => item.goalId)).toEqual(["g1", "g3"])
    expect(hooks.every((item) => item.narrativeKind !== "general")).toBe(true)
  })
})

describe("batchDeductionStatusLabel", () => {
  it("formats chapter phase labels", () => {
    expect(batchDeductionStatusLabel("synopsis", 2)).toBe("第 2 章 · 梗概")
    expect(batchDeductionStatusLabel("volume_plan", undefined, "第一卷 测试")).toBe("第一卷 测试 · 卷规划（多章梗概+大纲）")
    expect(batchDeductionStatusLabel("stopped")).toBe("已停止")
    expect(createIdleBatchStatus().running).toBe(false)
  })

  it("uses discuss draft path copy and volume plan readiness helper", () => {
    expect(BATCH_VOLUME_PLAN_USER_MESSAGE).toContain("volumeChapterPlans")
    expect(BATCH_VOLUME_DRAFT_USER_MESSAGE).toContain("chapterDraftProposals")
    expect(BATCH_VOLUME_DRAFT_USER_MESSAGE).toContain("禁止优先 chapter_workflow")
    expect(volumeChaptersHavePlans([
      { synopsisPath: "a.md", outlinePath: "b.md" },
      { synopsisPath: "c.md", outlinePath: "d.md" },
    ])).toBe(true)
    expect(volumeChaptersHavePlans([
      { synopsisPath: "a.md", outlinePath: "b.md" },
      { synopsisPath: "c.md" },
    ])).toBe(false)
    expect(batchPhaseTargetStage("volume_plan")).toBe("outline")
  })
})

describe("resolveChapterPanelStage", () => {
  it("picks the latest artifact stage", () => {
    expect(resolveChapterPanelStage({ sequence: 1, label: "一" }, undefined)).toBe("empty")
    expect(resolveChapterPanelStage({
      sequence: 1,
      label: "一",
      synopsisPath: "a [剧情梗概].md",
    }, undefined)).toBe("synopsis")
    expect(resolveChapterPanelStage({
      sequence: 1,
      label: "一",
      synopsisPath: "a [剧情梗概].md",
      outlinePath: "a [剧情细纲].md",
    }, undefined)).toBe("outline")
    expect(resolveChapterPanelStage({
      sequence: 1,
      label: "一",
      synopsisPath: "a [剧情梗概].md",
      outlinePath: "a [剧情细纲].md",
    }, {
      chapterSequence: 1,
      proposedBody: "正文草稿",
    } as never)).toBe("draft")
    expect(resolveChapterPanelStage({
      sequence: 1,
      label: "一",
      synopsisPath: "a [剧情梗概].md",
      outlinePath: "a [剧情细纲].md",
      bodyPath: "a.md",
    }, {
      chapterSequence: 1,
      proposedBody: "正文草稿",
    } as never)).toBe("body")
  })
})

describe("resolveChapterCupState", () => {
  it("fills upward toward the batch target stage", () => {
    expect(batchPhaseTargetStage("outline")).toBe("outline")
    expect(resolveChapterCupState({
      stage: "synopsis",
      batchRunning: true,
      batchPhase: "outline",
      batchChapterSequence: 3,
      chapterSequence: 3,
    })).toEqual({ from: "synopsis", to: "outline", filling: true })
    expect(resolveChapterCupState({
      stage: "outline",
      batchRunning: true,
      batchPhase: "outline",
      batchChapterSequence: 3,
      chapterSequence: 3,
    })).toEqual({ from: "outline", to: "outline", filling: false })
    expect(resolveChapterCupState({
      stage: "empty",
      batchRunning: true,
      batchPhase: "synopsis",
      batchChapterSequence: 2,
      chapterSequence: 1,
    })).toEqual({ from: "empty", to: "empty", filling: false })
  })
})

describe("ChapterPanel", () => {
  it("renders chapter cards with size toggle in a grid", () => {
    const html = renderToStaticMarkup(React.createElement(ChapterPanel, {
      chapters: [{
        sequence: 1,
        label: "第一章 天道在我头顶碎了",
        volumeFolderName: "第一卷 开局即仇敌",
        synopsisPath: "章节正文/第一卷 开局即仇敌/第一章 天道在我头顶碎了 [剧情梗概].md",
        bodyPath: "章节正文/第一卷 开局即仇敌/第一章 天道在我头顶碎了.md",
      }],
      chapterSummaries: [],
      unpublishedDrafts: [],
      workspaceRootRef: "demo",
      selectedSequence: 1,
      onSelectChapter: () => undefined,
    }))
    expect(html).toContain("chapter-panel")
    expect(html).toContain("chapter-panel-grid")
    expect(html).toContain("chapter-panel-size-toggle")
    expect(html).not.toContain("chapter-panel-batch-start")
    expect(html).toContain("第一章 天道在我头顶碎了")
    expect(html).toContain("第一卷 开局即仇敌")
    expect(html).toContain("chapter-panel-card-index")
    expect(html).toContain("暂无章节梗概")
    expect(html).toContain("is-active")
    expect(html).toContain('data-stage="body"')
  })

  it("shows stop control and status while batch is running", () => {
    const html = renderToStaticMarkup(React.createElement(ChapterPanel, {
      chapters: [{
        sequence: 1,
        label: "第一章 天道在我头顶碎了",
        volumeFolderName: "第一卷 开局即仇敌",
      }],
      chapterSummaries: [],
      unpublishedDrafts: [],
      workspaceRootRef: "demo",
      selectedSequence: 1,
      onSelectChapter: () => undefined,
      batchRunning: true,
      batchStatusLabel: "第 1 章 · 细纲",
      batchPhase: "outline",
      batchChapterSequence: 1,
      onStopBatch: () => undefined,
    }))
    expect(html).toContain("chapter-panel-batch-stop")
    expect(html).toContain("第 1 章 · 细纲")
    expect(html).not.toContain("chapter-panel-batch-start")
    expect(html).toContain('data-stage="empty"')
    expect(html).toContain("is-filling")
    expect(html).toContain('data-to-stage="outline"')
  })

  it("groups chapters under volume headers", () => {
    const html = renderToStaticMarkup(React.createElement(ChapterPanel, {
      chapters: [
        {
          sequence: 1,
          label: "第一章 天道在我头顶碎了",
          volumeFolderName: "第一卷 开局即仇敌",
        },
        {
          sequence: 2,
          label: "第二章 清河会",
          volumeFolderName: "第二卷 清河夜雨",
        },
      ],
      chapterSummaries: [],
      unpublishedDrafts: [],
      workspaceRootRef: "demo",
      selectedSequence: undefined,
      selectedVolumeFolderName: "第二卷 清河夜雨",
      onSelectChapter: () => undefined,
      onSelectVolume: () => undefined,
    }))
    expect(html).toContain("第一卷 开局即仇敌")
    expect(html).toContain("第二卷 清河夜雨")
    expect(html).toContain('data-testid="chapter-panel-volume-header-第二卷 清河夜雨"')
    expect(html).toContain("chapter-panel-volume-header is-active")
  })
})

describe("EditorArea chapter browse mode", () => {
  it("switches the center workspace to chapter cards", () => {
    const html = renderToStaticMarkup(React.createElement(EditorArea, {
      selectedPath: undefined,
      openedDocumentPath: undefined,
      browseChapters: true,
      onBrowseChapters: () => undefined,
      browseChapterSequence: 2,
      onSelectBrowseChapter: () => undefined,
      chapterSummaries: [],
      unpublishedDrafts: [],
      content: "",
      dirty: false,
      readOnly: false,
      running: false,
      prompt: "",
      descriptionRule: "",
      proseRule: "",
      minimumWordCount: "2000",
      maximumWordCount: "3000",
      wordCountValid: true,
      descriptionRules: [],
      proseRules: [],
      boundaryPace: "steady",
      causalityFocus: "character",
      onContentChange: () => undefined,
      onHome: () => undefined,
      onOpenDocument: () => undefined,
      onPromptChange: () => undefined,
      onDescriptionRuleChange: () => undefined,
      onProseRuleChange: () => undefined,
      onMinimumWordCountChange: () => undefined,
      onMaximumWordCountChange: () => undefined,
      onBoundaryPaceChange: () => undefined,
      onCausalityFocusChange: () => undefined,
      modelProfiles: [],
      activeModelProfileId: "",
      onActiveModelIdChange: () => undefined,
      onReasoningEffortChange: () => undefined,
      onSave: () => undefined,
      onRun: () => undefined,
      chapter: undefined,
      chapterBody: "",
      revision: undefined,
      revisionContent: undefined,
      onEnsureRevision: async () => undefined,
      onUpdateRevision: async () => { throw new Error("unused") },
      onReviewRevision: async () => { throw new Error("unused") },
      onSubmitRevision: async () => { throw new Error("unused") },
      onRetireRevision: async () => { throw new Error("unused") },
      projectId: "p",
      workspaceRootRef: "demo",
      synopsisSession: undefined,
      synopsisMessages: [],
      synopsisBusy: false,
      onSynopsisSend: async () => undefined,
      onSynopsisRefreshChoices: async () => undefined,
      onPromoteStaging: async () => undefined,
      onOpenSynopsisFile: () => undefined,
      focusChapters: [{
        sequence: 2,
        label: "第二章 清河会",
        volumeFolderName: "第二卷 清河夜雨",
        bodyPath: "章节正文/第二卷 清河夜雨/第二章 清河会.md",
      }],
    }))
    expect(html).toContain("editor-tab-chapters")
    expect(html).toContain("chapter-panel")
    expect(html).toContain("第二章 清河会")
    expect(html).toContain("第二卷 清河夜雨")
  })
})
