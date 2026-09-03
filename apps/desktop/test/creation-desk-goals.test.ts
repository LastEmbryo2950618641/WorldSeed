import { describe, expect, it } from "vitest"
import type { DeductionGoal, DeductionGoalProgress, DeductionGoalsSnapshot } from "@worldseed/contracts"

import {
  countFilledChapterProgress,
  countPendingReviews,
  formatGoalTaxonomyChip,
  listActiveGoals,
  listChapterRelevantGoals,
  listGoalProgressHistory,
  listReviewableProgress,
  narrativeKindLabel,
  paginateGoals,
  progressStatusLabel,
  resolveGoalRowStatus,
  scaleLabel,
  toolbarBadgeCount,
} from "../src/renderer/src/features/editor/creation-desk-goals.js"

function goal(overrides: Partial<DeductionGoal> & Pick<DeductionGoal, "goalId" | "lifecycle">): DeductionGoal {
  return {
    projectId: "11111111-1111-4111-8111-111111111111",
    content: "测试目标",
    source: "user",
    narrativeKind: "general",
    scale: "short",
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  }
}

function progress(overrides: Partial<DeductionGoalProgress> & Pick<DeductionGoalProgress, "progressId" | "goalId">): DeductionGoalProgress {
  return {
    projectId: "11111111-1111-4111-8111-111111111111",
    chapterSequence: 1,
    summary: "本章推进",
    status: "planned",
    source: "user",
    recordedAtMs: 1,
    ...overrides,
  }
}

describe("creation desk goals helpers", () => {
  it("lists active goals only", () => {
    const goals = [
      goal({ goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", lifecycle: "active" }),
      goal({ goalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", lifecycle: "completed" }),
      goal({ goalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", lifecycle: "removed" }),
    ]
    expect(listActiveGoals(goals).map((item) => item.goalId)).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"])
  })

  it("counts filled chapter progress and badge", () => {
    const goals = [
      goal({ goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", lifecycle: "active" }),
      goal({ goalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", lifecycle: "active" }),
    ]
    const items = [
      progress({ progressId: "11111111-1111-4111-8111-111111111101", goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", summary: "已填" }),
    ]
    expect(countFilledChapterProgress(goals, items, 1)).toEqual({ filled: 1, total: 2, unfilled: 1 })
    const snapshot: DeductionGoalsSnapshot = {
      projectId: "11111111-1111-4111-8111-111111111111",
      goals,
      progress: items,
      pendingProposals: [{
        proposalId: "22222222-2222-4222-8222-222222222222",
        projectId: "11111111-1111-4111-8111-111111111111",
        kind: "create",
        payload: { kind: "create", content: "建议" },
        status: "pending",
        createdAtMs: 1,
      }],
      updatedAtMs: 1,
    }
    expect(toolbarBadgeCount(snapshot, 1)).toBe(2)
  })

  it("scopes reviewable progress by chapter and excludes removed or unlocked rows", () => {
    const goals = [
      goal({ goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", lifecycle: "active", createdAtMs: 1 }),
      goal({ goalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", lifecycle: "removed", createdAtMs: 2 }),
      goal({ goalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", lifecycle: "active", createdAtMs: 3 }),
    ]
    const items = [
      progress({
        progressId: "11111111-1111-4111-8111-111111111101",
        goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        chapterSequence: 1,
        summary: "第1章锁定",
        lockedAtMs: 100,
      }),
      progress({
        progressId: "11111111-1111-4111-8111-111111111102",
        goalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        chapterSequence: 2,
        summary: "第2章锁定",
        lockedAtMs: 200,
      }),
      progress({
        progressId: "11111111-1111-4111-8111-111111111103",
        goalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        chapterSequence: 1,
        summary: "已移除目标",
        lockedAtMs: 300,
      }),
      progress({
        progressId: "11111111-1111-4111-8111-111111111104",
        goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        chapterSequence: 1,
        summary: "未锁定",
      }),
      progress({
        progressId: "11111111-1111-4111-8111-111111111105",
        goalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        chapterSequence: 2,
        summary: "已复盘",
        status: "achieved",
        lockedAtMs: 400,
      }),
    ]
    const snapshot: DeductionGoalsSnapshot = {
      projectId: "11111111-1111-4111-8111-111111111111",
      goals,
      progress: items,
      pendingProposals: [],
      updatedAtMs: 1,
    }

    expect(listReviewableProgress(goals, items).map((item) => item.progress.progressId)).toEqual([
      "11111111-1111-4111-8111-111111111101",
      "11111111-1111-4111-8111-111111111102",
    ])
    expect(listReviewableProgress(goals, items, 1).map((item) => item.progress.progressId)).toEqual([
      "11111111-1111-4111-8111-111111111101",
    ])
    expect(countPendingReviews(undefined)).toBe(0)
    expect(countPendingReviews(snapshot)).toBe(2)
    expect(countPendingReviews(snapshot, 2)).toBe(1)
  })

  it("lists locked planned progress for post-turn review", () => {
    const goals = [
      goal({ goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", lifecycle: "active" }),
      goal({ goalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", lifecycle: "active" }),
    ]
    const items = [
      progress({
        progressId: "11111111-1111-4111-8111-111111111101",
        goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        summary: "拿到名册",
        lockedAtMs: 100,
      }),
      progress({
        progressId: "11111111-1111-4111-8111-111111111102",
        goalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        summary: "未锁定",
      }),
    ]
    const reviewable = listReviewableProgress(goals, items)
    expect(reviewable).toHaveLength(1)
    expect(reviewable[0]?.goal.goalId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    expect(countPendingReviews({
      projectId: "11111111-1111-4111-8111-111111111111",
      goals,
      progress: items,
      pendingProposals: [],
      updatedAtMs: 1,
    })).toBe(1)
    expect(toolbarBadgeCount({
      projectId: "11111111-1111-4111-8111-111111111111",
      goals,
      progress: items,
      pendingProposals: [],
      updatedAtMs: 1,
    }, 1)).toBe(1)
  })

  it("lists goal progress history by chapter", () => {
    const goalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const items = [
      progress({ progressId: "11111111-1111-4111-8111-111111111101", goalId, chapterSequence: 1, status: "achieved" }),
      progress({ progressId: "11111111-1111-4111-8111-111111111102", goalId, chapterSequence: 2, status: "planned" }),
      progress({ progressId: "11111111-1111-4111-8111-111111111103", goalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", chapterSequence: 1 }),
    ]
    expect(listGoalProgressHistory(items, goalId).map((item) => item.chapterSequence)).toEqual([2, 1])
  })

  it("resolves compact row status for overview and chapter scopes", () => {
    const activeGoal = goal({ goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", lifecycle: "active" })
    const completedGoal = goal({ goalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", lifecycle: "completed" })
    const foreshadow = goal({
      goalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      lifecycle: "active",
      narrativeKind: "foreshadow",
    })
    const climax = goal({
      goalId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      lifecycle: "active",
      narrativeKind: "climax",
    })
    const chapterProgress = progress({
      progressId: "11111111-1111-4111-8111-111111111101",
      goalId: activeGoal.goalId,
      summary: "推进线索",
      lockedAtMs: 10,
    })
    expect(resolveGoalRowStatus({
      goal: activeGoal,
      chapterProgress,
      scope: "overview",
      reviewable: false,
    }).kind).toBe("planned")
    expect(resolveGoalRowStatus({
      goal: completedGoal,
      chapterProgress: undefined,
      scope: "overview",
      reviewable: false,
    }).kind).toBe("completed")
    expect(resolveGoalRowStatus({
      goal: activeGoal,
      chapterProgress,
      scope: "chapter",
      reviewable: true,
    })).toEqual({ kind: "review", label: "待复盘" })
    expect(resolveGoalRowStatus({
      goal: foreshadow,
      chapterProgress,
      scope: "chapter",
      reviewable: true,
    })).toEqual({ kind: "review", label: "待核对收束" })
    expect(resolveGoalRowStatus({
      goal: climax,
      chapterProgress,
      scope: "chapter",
      reviewable: true,
    })).toEqual({ kind: "review", label: "待复盘推进" })
    expect(resolveGoalRowStatus({
      goal: activeGoal,
      chapterProgress: { ...chapterProgress, status: "achieved", lockedAtMs: 10 },
      scope: "chapter",
      reviewable: false,
    })).toEqual({ kind: "achieved", label: "已达成" })
    expect(resolveGoalRowStatus({
      goal: foreshadow,
      chapterProgress: { ...chapterProgress, goalId: foreshadow.goalId, status: "achieved", lockedAtMs: 10 },
      scope: "chapter",
      reviewable: false,
    })).toEqual({ kind: "achieved", label: "已收束" })
    expect(resolveGoalRowStatus({
      goal: climax,
      chapterProgress: { ...chapterProgress, goalId: climax.goalId, status: "partial", lockedAtMs: 10 },
      scope: "chapter",
      reviewable: false,
    })).toEqual({ kind: "partial", label: "在升温" })
  })

  it("maps progress status labels by narrative kind", () => {
    expect(progressStatusLabel("achieved", "general")).toBe("已达成")
    expect(progressStatusLabel("achieved", "foreshadow")).toBe("已收束")
    expect(progressStatusLabel("partial", "climax")).toBe("在升温")
    expect(progressStatusLabel("missed", "foreshadow")).toBe("未收/错过窗口")
  })

  it("paginates goals", () => {
    const items = Array.from({ length: 10 }, (_, index) => index)
    const pageOne = paginateGoals(items, 1, 8)
    expect(pageOne.items).toHaveLength(8)
    expect(pageOne.totalPages).toBe(2)
  })

  it("counts chapter progress only for relevant goals", () => {
    const goals = [
      goal({ goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", lifecycle: "active", plantChapterSequence: 5, payoffChapterSequence: 8 }),
      goal({ goalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", lifecycle: "active" }),
    ]
    const progressItems = [
      progress({ progressId: "11111111-1111-4111-8111-111111111101", goalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", chapterSequence: 2, summary: "ok" }),
    ]
    expect(countFilledChapterProgress(goals, progressItems, 2)).toEqual({
      filled: 1,
      total: 1,
      unfilled: 0,
    })
  })

  it("lists chapter-relevant goals and formats taxonomy labels", () => {
    const goals = [
      goal({
        goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        lifecycle: "active",
        narrativeKind: "foreshadow",
        scale: "long",
        plantChapterSequence: 10,
        payoffChapterSequence: 40,
      }),
      goal({
        goalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        lifecycle: "active",
        narrativeKind: "climax",
        scale: "medium",
      }),
    ]
    expect(listChapterRelevantGoals(goals, 5).map((item) => item.goalId))
      .toEqual(["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"])
    expect(listChapterRelevantGoals(goals, 20).map((item) => item.goalId))
      .toEqual([
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ])
    expect(narrativeKindLabel("foreshadow")).toBe("伏笔")
    expect(scaleLabel("long")).toBe("长")
    expect(formatGoalTaxonomyChip("general", "short")).toBeUndefined()
    expect(formatGoalTaxonomyChip("foreshadow", "long")).toBe("伏笔·长")
  })
})
