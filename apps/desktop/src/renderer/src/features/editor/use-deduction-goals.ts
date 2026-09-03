import { useCallback, useEffect, useState } from "react"
import type { DeductionGoalsSnapshot } from "@worldseed/contracts"

import { invokeBackend } from "../../api/client.js"
import {
  clearLegacyCreationDeskGoals,
  loadLegacyCreationDeskGoals,
  type GoalTaxonomyInput,
} from "./creation-desk-goals.js"

const emptySnapshot = (projectId: string): DeductionGoalsSnapshot => ({
  projectId,
  goals: [],
  progress: [],
  pendingProposals: [],
  updatedAtMs: 0,
})

function taxonomyPayload(taxonomy: GoalTaxonomyInput | undefined): GoalTaxonomyInput {
  if (taxonomy === undefined) return {}
  return {
    ...(taxonomy.narrativeKind === undefined ? {} : { narrativeKind: taxonomy.narrativeKind }),
    ...(taxonomy.scale === undefined ? {} : { scale: taxonomy.scale }),
    ...(taxonomy.plantChapterSequence === undefined
      ? {}
      : { plantChapterSequence: taxonomy.plantChapterSequence }),
    ...(taxonomy.payoffChapterSequence === undefined
      ? {}
      : { payoffChapterSequence: taxonomy.payoffChapterSequence }),
  }
}

export function useDeductionGoals(input: Readonly<{
  projectId: string | undefined
  workspaceRootRef: string | undefined
}>): Readonly<{
  snapshot: DeductionGoalsSnapshot | undefined
  busy: boolean
  error: string | undefined
  refresh(): Promise<void>
  addGoal(content: string, taxonomy?: GoalTaxonomyInput): Promise<void>
  updateGoal(goalId: string, patch: { content?: string } & GoalTaxonomyInput): Promise<void>
  updateContent(goalId: string, content: string): Promise<void>
  completeGoal(goalId: string): Promise<void>
  removeGoal(goalId: string): Promise<void>
  setProgress(goalId: string, chapterSequence: number, summary: string): Promise<void>
  reviewProgress(
    goalId: string,
    chapterSequence: number,
    status: "achieved" | "partial" | "missed",
    summary: string,
  ): Promise<void>
  approveProposals(proposalIds: readonly string[]): Promise<void>
  rejectProposals(proposalIds: readonly string[]): Promise<void>
}> {
  const [snapshot, setSnapshot] = useState<DeductionGoalsSnapshot | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const refresh = useCallback(async (): Promise<void> => {
    if (input.projectId === undefined || input.workspaceRootRef === undefined) {
      setSnapshot(undefined)
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      let next = await invokeBackend<DeductionGoalsSnapshot>("deduction.goals.list", {
        projectId: input.projectId,
        workspaceRootRef: input.workspaceRootRef,
      })
      if (next.goals.length === 0 && next.pendingProposals.length === 0) {
        const legacy = loadLegacyCreationDeskGoals(input.projectId)
        if (legacy.length > 0) {
          next = await invokeBackend<DeductionGoalsSnapshot>("deduction.goals.importLegacy", {
            projectId: input.projectId,
            workspaceRootRef: input.workspaceRootRef,
            goals: legacy,
          })
          clearLegacyCreationDeskGoals(input.projectId)
        }
      }
      setSnapshot(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSnapshot(emptySnapshot(input.projectId))
    } finally {
      setBusy(false)
    }
  }, [input.projectId, input.workspaceRootRef])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const mutate = useCallback(async (
    run: () => Promise<DeductionGoalsSnapshot>,
  ): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      setSnapshot(await run())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const requireProject = (): Readonly<{ projectId: string; workspaceRootRef: string }> => {
    if (input.projectId === undefined || input.workspaceRootRef === undefined) {
      throw new Error("project is not open")
    }
    return { projectId: input.projectId, workspaceRootRef: input.workspaceRootRef }
  }

  const updateGoal = async (
    goalId: string,
    patch: { content?: string } & GoalTaxonomyInput,
  ): Promise<void> => {
    const content = patch.content?.trim()
    const taxonomy = taxonomyPayload(patch)
    const hasTaxonomy = taxonomy.narrativeKind !== undefined
      || taxonomy.scale !== undefined
      || taxonomy.plantChapterSequence !== undefined
      || taxonomy.payoffChapterSequence !== undefined
    if ((content === undefined || content.length === 0) && !hasTaxonomy) return
    const project = requireProject()
    await mutate(() => invokeBackend("deduction.goals.update", {
      ...project,
      goalId,
      action: "update_content",
      ...(content === undefined || content.length === 0 ? {} : { content }),
      ...taxonomy,
    }))
  }

  return {
    snapshot,
    busy,
    error,
    refresh,
    addGoal: async (content: string, taxonomy?: GoalTaxonomyInput): Promise<void> => {
      const trimmed = content.trim()
      if (trimmed.length === 0) return
      const project = requireProject()
      await mutate(() => invokeBackend("deduction.goals.create", {
        ...project,
        content: trimmed,
        ...taxonomyPayload(taxonomy),
      }))
    },
    updateGoal,
    updateContent: async (goalId: string, content: string): Promise<void> => {
      await updateGoal(goalId, { content })
    },
    completeGoal: async (goalId: string): Promise<void> => {
      const project = requireProject()
      await mutate(() => invokeBackend("deduction.goals.update", {
        ...project,
        goalId,
        action: "complete",
      }))
    },
    removeGoal: async (goalId: string): Promise<void> => {
      const project = requireProject()
      await mutate(() => invokeBackend("deduction.goals.update", {
        ...project,
        goalId,
        action: "remove",
      }))
    },
    setProgress: async (goalId: string, chapterSequence: number, summary: string): Promise<void> => {
      const trimmed = summary.trim()
      if (trimmed.length === 0) return
      const project = requireProject()
      await mutate(() => invokeBackend("deduction.goals.progress.set", {
        ...project,
        goalId,
        chapterSequence,
        summary: trimmed,
        status: "planned",
      }))
    },
    reviewProgress: async (
      goalId: string,
      chapterSequence: number,
      status: "achieved" | "partial" | "missed",
      summary: string,
    ): Promise<void> => {
      const trimmed = summary.trim()
      if (trimmed.length === 0) return
      const project = requireProject()
      await mutate(() => invokeBackend("deduction.goals.progress.set", {
        ...project,
        goalId,
        chapterSequence,
        summary: trimmed,
        status,
      }))
    },
    approveProposals: async (proposalIds: readonly string[]): Promise<void> => {
      if (proposalIds.length === 0) return
      const project = requireProject()
      await mutate(() => invokeBackend("deduction.goals.proposal.approve", {
        ...project,
        proposalIds,
      }))
    },
    rejectProposals: async (proposalIds: readonly string[]): Promise<void> => {
      if (proposalIds.length === 0) return
      const project = requireProject()
      await mutate(() => invokeBackend("deduction.goals.proposal.reject", {
        ...project,
        proposalIds,
      }))
    },
  }
}
