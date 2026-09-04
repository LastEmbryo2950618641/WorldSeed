import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels"
import { ChevronDown, Cloud, Cpu, FolderOpen, PanelLeftClose, PanelRightClose, Save, Settings2, X } from "lucide-react"
import type {
  ChapterRevision,
  ChapterRevisionConversationListResult,
  ChapterRevisionConversationSendResult,
  ChapterRevisionReadResult,
  ChapterSummary,
  ChapterSynopsis,
  DeductionGoalsSnapshot,
  HistoryCheckoutResult,
  HistoryOverview,
  HistoryRetentionPreview,
  ProjectSettings,
  ResettableRuntimeMetricId,
  ResolvedChapter,
  SynopsisConversationListResult,
  SynopsisConversationMessage,
  SynopsisConversationSendResult,
  SynopsisConversationStartResult,
  SynopsisConversationStreamSnapshot,
  SynopsisConversationBudgetAdvisory,
  SynopsisConversationStreamUsage,
  SynopsisStagingPromoteProposal,
} from "@worldseed/contracts"

import {
  browserDemoProject,
  invokeBackend,
  abandonBackendRequest,
  BackendRequestAbandonedError,
  readModelProfiles,
  saveModelProfiles as persistModelProfiles,
  type BackendWaitTimeoutInfo,
  type GraphSlice,
  type OpenProject,
  type RecoverableTaskList,
  type TaskSnapshot,
  type TurnResult,
  type WorkspaceReport,
} from "../api/client.js"
import { AppChrome } from "../components/AppChrome.js"
import { ProjectLauncher } from "../features/projects/ProjectLauncher.js"
import { ProjectRail } from "../features/projects/ProjectRail.js"
import { WorkNameControl } from "../features/projects/WorkNameControl.js"
import { rememberWorkName } from "../features/projects/work-name-history.js"
import { useAppUpdate } from "../hooks/useAppUpdate.js"
import { WorkspaceTree } from "../features/workspace/WorkspaceTree.js"
import { WorkspaceNameDialog } from "../features/workspace/WorkspaceNameDialog.js"
import { canCreateFolderInDirectory, findDuplicateVolumeSequence, isValidVolumeFolderName, isChapterVolumeContainerPath, isVolumeDirectoryPath, resolveCreateDestination } from "../features/workspace/workspace-locks.js"
import { EditorArea } from "../features/editor/EditorArea.js"
import { useCreationDeskPresentationPreferences } from "../features/editor/creation-desk-presentation-preferences.js"
import { SettingsLineagePanel } from "../features/settings/SettingsLineagePanel.js"
import { ChapterWorkspaceRail } from "../features/editor/ChapterWorkspaceRail.js"
import {
  ChapterArtifactRelatedRail,
  type RelatedChapterArtifact,
} from "../features/editor/ChapterArtifactRelatedRail.js"
import { CreationDeskProgressReviewDialog } from "../features/editor/CreationDeskProgressReviewDialog.js"
import { countPendingReviews } from "../features/editor/creation-desk-goals.js"
import {
  isChapterPlanningMarkdownPath,
  resolveChapterArtifactRelationsWithInventory,
  resolveChapterMarkdownKind,
  resolveChapterSurfacePath,
} from "../features/editor/synopsis-path.js"
import { BackendWaitTimeoutDialog } from "../features/status/BackendWaitTimeoutDialog.js"
import { RightRail, summarizeSynopsisStreamTokenMetrics, summarizeSynopsisUsageTokenMetrics, type TaskTokenMetrics } from "../features/status/RightRail.js"
import { RightPanelViewport } from "../features/status/RightPanelViewport.js"
import { ModelConfigurationDialog, type ModelProfile } from "../features/settings/ModelConfigurationDialog.js"
import { ProjectSettingsDialog } from "../features/settings/ProjectSettingsDialog.js"
import { AppUpdateDialog } from "../features/settings/AppUpdateDialog.js"
import { UiTooltip } from "../components/UiTooltip.js"

type PendingGraphLoad = Readonly<{
  result: TurnResult
  anchorOffset: number
  append: boolean
  reason: "continue" | "retry"
}>

export function App(): React.JSX.Element {
  const [project, setProject] = useState<OpenProject | undefined>(browserDemoProject)
  const [report, setReport] = useState<WorkspaceReport>({ inventory: [], issues: [] })
  const [selectedPath, setSelectedPath] = useState<string>()
  const [lineageMode, setLineageMode] = useState(false)
  const [openedDocumentPath, setOpenedDocumentPath] = useState<string>()
  const [content, setContent] = useState("")
  const [chapterBody, setChapterBody] = useState("")
  const [savedContent, setSavedContent] = useState("")
  const [selectedChapter, setSelectedChapter] = useState<ChapterSummary>()
  const [chapterRevision, setChapterRevision] = useState<ChapterRevision>()
  const [chapterRevisionContent, setChapterRevisionContent] = useState<string>()
  const [chapterConversation, setChapterConversation] = useState<ChapterRevisionConversationListResult>({ messages: [] })
  const [chapterConversationBusy, setChapterConversationBusy] = useState(false)
  const [synopsisConversation, setSynopsisConversation] = useState<SynopsisConversationListResult>({ messages: [] })
  const [synopsisConversationBusy, setSynopsisConversationBusy] = useState(false)
  const [synopsisDraftRestore, setSynopsisDraftRestore] = useState<{ text: string; token: number }>()
  const [backendWaitPrompt, setBackendWaitPrompt] = useState<{
    info: BackendWaitTimeoutInfo
    decide: (choice: "continue" | "abandon") => void
  }>()
  const [pendingStagingPromotes, setPendingStagingPromotes] = useState<readonly SynopsisStagingPromoteProposal[]>([])
  const [synopsisStream, setSynopsisStream] = useState<SynopsisConversationStreamSnapshot>()
  const [synopsisUsage, setSynopsisUsage] = useState<SynopsisConversationStreamUsage>()
  const synopsisActiveRequestRef = useRef<string | null>(null)
  const synopsisStopDraftRef = useRef<string | null>(null)
  const synopsisSendInFlightRef = useRef(false)
  const [chapterSynopsis, setChapterSynopsis] = useState<ChapterSynopsis>()
  const [synopsisPanelOpen, setSynopsisPanelOpen] = useState(false)
  const [relatedChapterArtifacts, setRelatedChapterArtifacts] = useState<readonly RelatedChapterArtifact[]>([])
  const [prompt, setPrompt] = useState("")
  const [presentation, updatePresentation] = useCreationDeskPresentationPreferences(project?.projectId)
  const {
    descriptionRule,
    proseRule,
    minimumWordCount,
    maximumWordCount,
    boundaryPace,
    causalityFocus,
  } = presentation
  const [task, setTask] = useState<TaskSnapshot>()
  const [graphSlice, setGraphSlice] = useState<GraphSlice>()
  const [error, setError] = useState<string>()
  const dismissedWorkspaceIssueKeysRef = useRef(new Set<string>())
  const [synopsisBudgetWarning, setSynopsisBudgetWarning] = useState<SynopsisConversationBudgetAdvisory>()
  const [postCommitNotice, setPostCommitNotice] = useState<string>()
  const [progressReviewOpen, setProgressReviewOpen] = useState(false)
  const [pendingReviewCount, setPendingReviewCount] = useState(0)
  const [pendingGraphLoad, setPendingGraphLoad] = useState<PendingGraphLoad>()
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false)
  const [projectSettingsSection, setProjectSettingsSection] = useState<"execution" | "retrieval" | "graph" | "history" | "model" | "workDirectory" | "about">("execution")
  const appUpdate = useAppUpdate()
  const [workspaceCreatePrompt, setWorkspaceCreatePrompt] = useState<{
    kind: "file" | "directory"
    parentPath: string
  }>()
  const [projectSettings, setProjectSettings] = useState<ProjectSettings>()
  const [history, setHistory] = useState<HistoryOverview>()
  const [historyLoading, setHistoryLoading] = useState(false)
  const [modelProfiles, setModelProfiles] = useState<readonly ModelProfile[]>([])
  const [activeModelProfileId, setActiveModelProfileId] = useState("")
  const monitoredChapterRevisionIds = useRef(new Set<string>())
  const [diffFocusMessageId, setDiffFocusMessageId] = useState<string>()
  const activeModelProfile = modelProfiles.find((profile) => profile.id === activeModelProfileId)
  const parsedMinimumWordCount = parseWordCount(minimumWordCount)
  const parsedMaximumWordCount = parseWordCount(maximumWordCount)
  const wordCountValid = parsedMinimumWordCount !== undefined
    && parsedMaximumWordCount !== undefined
    && parsedMinimumWordCount <= parsedMaximumWordCount

  const refreshSynopsisConversation = useCallback(async (): Promise<void> => {
    if (project === undefined) return
    const result = await invokeBackend<SynopsisConversationListResult>("synopsis.conversation.list", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
    })
    setSynopsisConversation(result)
    setSynopsisUsage(result.usage)
  }, [project])

  const refreshChapterSynopsis = useCallback(async (chapterId: string): Promise<void> => {
    if (project === undefined) return
    const result = await invokeBackend<ChapterSynopsis | undefined>("chapter.synopsis.get", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
      chapterId,
    })
    setChapterSynopsis(result)
  }, [project])

  const loadRelatedChapterArtifacts = useCallback(async (path: string): Promise<void> => {
    if (project === undefined) {
      setRelatedChapterArtifacts([])
      return
    }
    const inventoryPaths = report.inventory.map((entry) => entry.path)
    const relations = resolveChapterArtifactRelationsWithInventory(path, inventoryPaths)
    if (relations === undefined) {
      setRelatedChapterArtifacts([])
      return
    }
    const candidates: Array<{ kind: RelatedChapterArtifact["kind"]; path: string }> = [
      { kind: "plot_synopsis", path: relations.synopsisPath },
      { kind: "plot_outline", path: relations.outlinePath },
      { kind: "chapter_body", path: relations.bodyPath },
    ]
    const visible = relations.kind === "chapter_body"
      ? candidates.filter((item) => item.kind !== "chapter_body")
      : candidates.filter((item) => item.path !== relations.currentPath)

    const loaded = await Promise.all(visible.map(async (item) => {
      try {
        const result = await invokeBackend<{ content: string }>("workspace.read", {
          projectId: project.projectId,
          workspaceRootRef: project.workspaceRootRef,
          relativePath: item.path,
        })
        return {
          kind: item.kind,
          path: item.path,
          present: true,
          content: result.content,
        } satisfies RelatedChapterArtifact
      } catch {
        return {
          kind: item.kind,
          path: item.path,
          present: false,
        } satisfies RelatedChapterArtifact
      }
    }))
    setRelatedChapterArtifacts(loaded)
  }, [project, report.inventory])

  const refreshChapterConversation = useCallback(async (chapterId: string): Promise<void> => {
    if (project === undefined) return
    const result = await invokeBackend<ChapterRevisionConversationListResult>("chapter.revision.conversation.list", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
      chapterId,
    })
    setChapterConversation(result)
  }, [project])

  const refreshWorkspace = useCallback(async (): Promise<void> => {
    if (project === undefined) return
    const [next, chapters] = await Promise.all([
      invokeBackend<WorkspaceReport>("workspace.list", { workspaceRootRef: project.workspaceRootRef }),
      invokeBackend<readonly ChapterSummary[]>("chapter.list", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
      }),
    ])
    const chapterFiles = [
      ...next.inventory.filter((entry) => (
        entry.path.startsWith("章节正文/")
        && entry.kind === "file"
        && isChapterPlanningMarkdownPath(entry.path)
      )),
      ...chapters.map((chapter) => ({ path: chapter.publishPath, kind: "file" as const })),
    ]
    const surfaceByDir = new Map<string, string>()
    const byDir = new Map<string, string[]>()
    for (const entry of chapterFiles) {
      const dir = entry.path.includes("/")
        ? entry.path.slice(0, entry.path.lastIndexOf("/"))
        : "章节正文"
      const list = byDir.get(dir) ?? []
      list.push(entry.path)
      byDir.set(dir, list)
    }
    for (const [, paths] of byDir) {
      // Group by chapter sequence when parseable so divergent titles still fold;
      // fall back to basename stem for unlabeled files.
      const groups = new Map<string, string[]>()
      for (const path of paths) {
        const name = path.slice(path.lastIndexOf("/") + 1)
        const stem = name
          .replace(/\s*\[剧情梗概\]\.md$/u, "")
          .replace(/\[剧情梗概\]\.md$/u, "")
          .replace(/\s*\[剧情细纲\]\.md$/u, "")
          .replace(/\[剧情细纲\]\.md$/u, "")
          .replace(/\.md$/u, "")
        const sequenceMatch = stem.match(/^第(\d+|[零一二三四五六七八九十百]+)章(?:\s|$)/u)
        const groupKey = sequenceMatch === null
          ? `stem:${stem}`
          : `seq:${sequenceMatch[1] ?? stem}`
        const group = groups.get(groupKey) ?? []
        group.push(path)
        groups.set(groupKey, group)
      }
      for (const groupPaths of groups.values()) {
        const surface = resolveChapterSurfacePath(groupPaths)
        if (surface !== undefined) surfaceByDir.set(surface, surface)
      }
    }
    const foldedChapterFiles = chapterFiles.filter((entry) => surfaceByDir.has(entry.path))
    const inventory = [
      ...next.inventory.filter((entry) => !entry.path.startsWith("章节正文/") || entry.kind === "directory"),
      ...foldedChapterFiles,
    ].sort((left, right) => left.path.localeCompare(right.path, "zh-CN"))
    setReport({ ...next, inventory })
    const workspaceGateIssues = next.issues.filter((issue) => (
      issue.code === "invalid_synopsis_name"
      || issue.code === "chapter_missing_volume"
      || issue.code === "invalid_volume_name"
    ))
    const visibleIssues = workspaceGateIssues.filter((issue) => {
      const key = `${issue.code}:${issue.path}:${issue.message}`
      return !dismissedWorkspaceIssueKeysRef.current.has(key)
    })
    if (visibleIssues.length > 0) {
      setError(visibleIssues.map((issue) => `${issue.path}：${issue.message}`).join("\n"))
    }
  }, [project])

  const loadHistoryGraph = useCallback(async (anchorIds: readonly string[]): Promise<void> => {
    if (project === undefined || anchorIds.length === 0) {
      setGraphSlice(undefined)
      return
    }
    const slice = await invokeBackend<GraphSlice>("graph.neighborhood", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
      anchorIds,
      anchorOffset: 0,
      direction: "both",
      maxDepth: Math.max(1, projectSettings?.graph.preferredExpansionDepth ?? 2),
      maxNodes: projectSettings?.graph.maxVisitedNodes ?? 48,
      maxLinks: projectSettings?.graph.maxVisitedLinks ?? 96,
    })
    setGraphSlice(slice)
    if (slice.anchorWindow?.remainingCount !== undefined && slice.anchorWindow.remainingCount > 0) {
      setPostCommitNotice(`历史状态已恢复。世界图入口较多，当前显示首批 ${String(slice.anchorWindow.processedCount)} 个入口。`)
    }
  }, [project, projectSettings])

  const refreshHistory = useCallback(async (): Promise<HistoryOverview | undefined> => {
    if (project === undefined) return undefined
    setHistoryLoading(true)
    try {
      const overview = await invokeBackend<HistoryOverview>("history.list", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
      })
      setHistory(overview)
      await loadHistoryGraph(overview.graphAnchorIds)
      return overview
    } finally {
      setHistoryLoading(false)
    }
  }, [loadHistoryGraph, project])

  useEffect(() => { void refreshWorkspace() }, [refreshWorkspace])
  useEffect(() => { void refreshHistory() }, [refreshHistory])
  useEffect(() => {
    if (project === undefined || selectedPath !== undefined) return
    void refreshSynopsisConversation()
  }, [project, refreshSynopsisConversation, selectedPath])

  useEffect(() => {
    if (project === undefined) {
      setProjectSettings(undefined)
      setTask(undefined)
      setGraphSlice(undefined)
      setHistory(undefined)
      setPostCommitNotice(undefined)
      dismissedWorkspaceIssueKeysRef.current.clear()
      return
    }
    let active = true
    setProjectSettings(undefined)
    void invokeBackend<ProjectSettings>("project.settings.read", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
    }).then(async (settings) => {
      if (!active) return
      setProjectSettings(settings)
      const tasks = await invokeBackend<RecoverableTaskList>("turn.recoverable.list", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
      })
      if (!active) return
      const recoverable = tasks[0]
      if (recoverable !== undefined) {
        setTask(recoverable)
        if (recoverable.status === "awaiting_user_decision") {
          setPostCommitNotice("已恢复最近一次暂停的推演任务；请在弹出的检查点面板中决定重试、继续或回退本轮。")
        } else if (recoverable.status === "waiting_for_review") {
          setPostCommitNotice("正文已生成，请在弹出的检查点面板中确认设定抽取提案后再继续图治理。")
        }
      } else {
        const latest = await invokeBackend<TaskSnapshot | null>("turn.latest.get", {
          projectId: project.projectId,
          workspaceRootRef: project.workspaceRootRef,
        })
        if (!active) return
        setTask(latest ?? undefined)
      }
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { active = false }
  }, [project])

  useEffect(() => {
    void readModelProfiles().then((saved) => {
      setModelProfiles(saved.profiles)
      setActiveModelProfileId(saved.activeProfileId)
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [])

  useEffect(() => {
    const inGraphSyncRecovery = chapterRevision?.decision === "submit"
      && chapterRevision.graphSyncStatus !== "completed"
    const chapterConversationActive = selectedPath?.startsWith("章节正文/") === true
      && !inGraphSyncRecovery
    if (!chapterConversationActive) {
      setDiffFocusMessageId(undefined)
    }
  }, [selectedPath, chapterRevision])

  useEffect(() => {
    const handleCommand = (command: "project.new" | "project.open" | "turn.start"): void => {
      if (command === "project.new" || command === "project.open") resetWorkbenchForProject(undefined)
      if (command === "turn.start") void startTurn()
    }
    const unsubscribe = window.worldseed?.onCommand(handleCommand)
    const onLocal = (event: Event): void => {
      const detail = (event as CustomEvent<string>).detail
      if (detail === "project.new" || detail === "project.open" || detail === "turn.start") {
        handleCommand(detail)
      }
    }
    window.addEventListener("worldseed:local-command", onLocal)
    return () => {
      unsubscribe?.()
      window.removeEventListener("worldseed:local-command", onLocal)
    }
  })

  const openFile = async (path: string | undefined): Promise<void> => {
    if (project === undefined || !isWorkspaceFilePath(path)) {
      setError("无法打开文件：工作区文件路径为空或无效")
      return
    }
    setLineageMode(false)
    setError(undefined)
    try {
      // Synopsis/outline are planning markdown on disk; they are not committed chapter publish paths.
      if (isChapterPlanningMarkdownPath(path)) {
        const result = await invokeBackend<{ content: string }>("workspace.read", {
          projectId: project.projectId,
          workspaceRootRef: project.workspaceRootRef,
          relativePath: path,
        })
        setSelectedPath(path)
        setOpenedDocumentPath(path)
        setSelectedChapter(undefined)
        setChapterRevision(undefined)
        setChapterRevisionContent(undefined)
        setChapterConversation({ messages: [] })
        setChapterSynopsis(undefined)
        setSynopsisPanelOpen(false)
        setContent(result.content)
        setChapterBody("")
        setSavedContent(result.content)
        await loadRelatedChapterArtifacts(path)
        return
      }
      if (path.startsWith("章节正文/")) {
        const resolved = await invokeBackend<ResolvedChapter>("chapter.resolveByPath", {
          projectId: project.projectId,
          workspaceRootRef: project.workspaceRootRef,
          publishPath: path,
        })
        setSelectedPath(path)
        setOpenedDocumentPath(path)
        setSelectedChapter(resolved.committed)
        setChapterRevision(resolved.activeRevision)
        setChapterRevisionContent(resolved.activeRevision?.proposedBody)
        setContent(resolved.committed.content)
        setChapterBody(resolved.committed.body)
        setSavedContent(resolved.committed.content)
        if (resolved.activeRevision !== undefined && shouldMonitorChapterRevision(resolved.activeRevision.graphSyncStatus)) {
          void monitorChapterRevision(resolved.activeRevision.revisionTaskId)
        }
        await refreshChapterConversation(resolved.committed.chapterId)
        await refreshChapterSynopsis(resolved.committed.chapterId)
        await loadRelatedChapterArtifacts(path)
        setSynopsisPanelOpen(false)
        return
      }
      setChapterConversation({ messages: [] })
      setRelatedChapterArtifacts([])
      const result = await invokeBackend<{ content: string }>("workspace.read", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        relativePath: path,
      })
      setSelectedPath(path)
      setOpenedDocumentPath(path)
      setSelectedChapter(undefined)
      setChapterRevision(undefined)
      setChapterRevisionContent(undefined)
      setContent(result.content)
      setChapterBody("")
      setSavedContent(result.content)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const startChapterRevision = async (heading: string, body: string): Promise<ChapterRevision> => {
    if (project === undefined || selectedChapter === undefined) throw new Error("当前没有可修订章节")
    const revision = await invokeBackend<ChapterRevision>("chapter.startRevision", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
      chapterId: selectedChapter.chapterId,
      baseSourceId: selectedChapter.sourceId,
      heading,
      body,
      inputMode: "agent",
    })
    setChapterRevision(revision)
    setChapterRevisionContent(body)
    return revision
  }

  const ensureChapterRevision = async (heading: string, body: string): Promise<ChapterRevision | undefined> => {
    if (project === undefined || selectedChapter === undefined) return undefined
    if (chapterRevision !== undefined && chapterRevision.decision !== "submit" && chapterRevision.status === "editing") {
      return chapterRevision
    }
    const revision = await startChapterRevision(heading, body)
    await refreshChapterConversation(selectedChapter.chapterId)
    return revision
  }

  const updateChapterRevision = async (revisionTaskId: string, heading: string, body: string): Promise<ChapterRevision> => {
    if (project === undefined) throw new Error("当前没有打开项目")
    const revision = await invokeBackend<ChapterRevision>("chapter.updateRevision", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
      revisionTaskId,
      heading,
      body,
    })
    setChapterRevision(revision)
    setChapterRevisionContent(body)
    return revision
  }

  const reviewChapterRevision = async (revisionTaskId: string): Promise<ChapterRevision> => {
    if (project === undefined) throw new Error("当前没有打开项目")
    setError(undefined)
    try {
      const revision = await invokeBackend<ChapterRevision>("chapter.reviewRevision", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        revisionTaskId,
        ...(activeModelProfile === undefined ? {} : { model: modelSelection(activeModelProfile) }),
      })
      setChapterRevision(revision)
      return revision
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    }
  }

  const monitorChapterRevision = async (revisionTaskId: string): Promise<void> => {
    if (project === undefined || monitoredChapterRevisionIds.current.has(revisionTaskId)) return
    monitoredChapterRevisionIds.current.add(revisionTaskId)
    try {
      for (let attempt = 0; attempt < 1_200; attempt += 1) {
        const current = await invokeBackend<ChapterRevisionReadResult>("chapter.readRevision", {
          projectId: project.projectId,
          workspaceRootRef: project.workspaceRootRef,
          revisionTaskId,
        })
        setChapterRevision(current)
        setChapterRevisionContent(current.proposedBody)
        if (current.graphSyncStatus === "completed") {
          setPostCommitNotice("章节修订、上下文登记与世界图同步已完成。")
          await refreshHistory()
          return
        }
        if (current.graphSyncStatus === "failed") {
          setError("章节正文已提交，但世界图同步失败。可在章节顶部重试图同步。")
          setPostCommitNotice("章节正文已保留，世界图同步停在可恢复检查点。")
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      setError("世界图同步仍在运行，请稍后重新打开章节查看状态。")
    } finally {
      monitoredChapterRevisionIds.current.delete(revisionTaskId)
    }
  }

  const submitChapterRevision = async (input: Readonly<{
    revisionTaskId: string
    mode: "direct" | "reviewed"
    forced: boolean
    reviewId?: string
  }>): Promise<ChapterRevision> => {
    if (project === undefined) throw new Error("当前没有打开项目")
    setError(undefined)
    let revision: ChapterRevision
    try {
      revision = await invokeBackend<ChapterRevision>("chapter.submitRevision", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        ...input,
        ...(activeModelProfile === undefined ? {} : { model: modelSelection(activeModelProfile) }),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    }
    const current = await invokeBackend<ChapterSummary & { content: string; body: string }>("chapter.read", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
      chapterId: revision.chapterId,
    })
    setSelectedChapter(current)
    setSelectedPath(current.publishPath)
    setChapterRevision(revision)
    setContent(current.content)
    setChapterBody(current.body)
    setSavedContent(current.content)
    await refreshWorkspace()
    setPostCommitNotice(revision.graphSyncStatus === "completed"
      ? "章节修订、上下文登记与世界图同步已完成。"
      : "章节正文已提交，世界图正在后台同步。")
    if (revision.graphSyncStatus === "pending" || shouldMonitorChapterRevision(revision.graphSyncStatus)) {
      void monitorChapterRevision(revision.revisionTaskId).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    } else if (revision.graphSyncStatus === "completed") {
      await refreshHistory()
    }
    return revision
  }

  const retireChapterRevision = async (revisionTaskId: string): Promise<ChapterRevision> => {
    if (project === undefined) throw new Error("当前没有打开项目")
    const revision = await invokeBackend<ChapterRevision>("chapter.retireRevision", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
      revisionTaskId,
    })
    setChapterRevision(undefined)
    setChapterRevisionContent(undefined)
    if (selectedChapter !== undefined) await refreshChapterConversation(selectedChapter.chapterId)
    return revision
  }

  const sendChapterConversation = async (message: string): Promise<void> => {
    if (project === undefined || selectedChapter === undefined) throw new Error("当前没有可对话章节")
    const optimisticId = crypto.randomUUID()
    const optimisticMessage = {
      messageId: optimisticId,
      revisionTaskId: chapterConversation.revisionTaskId ?? crypto.randomUUID(),
      projectId: project.projectId,
      role: "user" as const,
      content: message,
      createdAtMs: Date.now(),
    }
    setChapterConversation((current) => ({
      ...current,
      messages: [...current.messages, optimisticMessage],
    }))
    setChapterConversationBusy(true)
    setError(undefined)
    try {
      const result = await invokeBackend<ChapterRevisionConversationSendResult>("chapter.revision.conversation.send", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        chapterId: selectedChapter.chapterId,
        message,
        ...(activeModelProfile === undefined ? {} : { model: modelSelection(activeModelProfile) }),
      })
      setChapterConversation({ revisionTaskId: result.revision.revisionTaskId, messages: result.messages })
      setChapterRevision(result.revision)
      const latestProposal = [...result.messages].reverse().find((entry) => entry.role === "assistant" && entry.proposal !== undefined)
      if (latestProposal !== undefined) {
        const revision = await invokeBackend<ChapterRevision>("chapter.revision.conversation.apply", {
          projectId: project.projectId,
          workspaceRootRef: project.workspaceRootRef,
          revisionTaskId: result.revision.revisionTaskId,
          messageId: latestProposal.messageId,
        })
        setChapterRevision(revision)
        const applied = await invokeBackend<ChapterRevisionReadResult>("chapter.readRevision", {
          projectId: project.projectId,
          workspaceRootRef: project.workspaceRootRef,
          revisionTaskId: revision.revisionTaskId,
        })
        setChapterRevisionContent(applied.proposedBody)
        setPostCommitNotice("Agent 建议已自动写入草稿。可在版本条查看 diff，或继续对话 / 审核提交。")
      } else {
        const detail = await invokeBackend<ChapterRevisionReadResult>("chapter.readRevision", {
          projectId: project.projectId,
          workspaceRootRef: project.workspaceRootRef,
          revisionTaskId: result.revision.revisionTaskId,
        })
        setChapterRevisionContent(detail.proposedBody)
      }
    } catch (cause) {
      setChapterConversation((current) => ({
        ...current,
        messages: current.messages.filter((entry) => entry.messageId !== optimisticId),
      }))
      setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    } finally {
      setChapterConversationBusy(false)
    }
  }

  const loadCommittedGraph = async (
    result: TurnResult,
    anchorOffset = 0,
    append = false,
  ): Promise<void> => {
    if (project === undefined || result.graphAnchorIds.length === 0) return
    try {
      const slice = await invokeBackend<GraphSlice>("graph.neighborhood", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        anchorIds: result.graphAnchorIds,
        anchorOffset,
        direction: "both",
        maxDepth: Math.max(1, projectSettings?.graph.preferredExpansionDepth ?? 2),
        maxNodes: projectSettings?.graph.maxVisitedNodes ?? 48,
        maxLinks: projectSettings?.graph.maxVisitedLinks ?? 96,
      })
      setGraphSlice((current) => append ? mergeGraphSlices(current, slice) : slice)
      if (slice.anchorWindow?.nextOffset !== undefined) {
        setPendingGraphLoad({
          result,
          anchorOffset: slice.anchorWindow.nextOffset,
          append: true,
          reason: "continue",
        })
        const loadedCount = slice.anchorWindow.requestedCount - slice.anchorWindow.remainingCount
        setPostCommitNotice(`本轮正文与图数据已提交。世界图共有 ${String(slice.anchorWindow.requestedCount)} 个查询入口，已按配置加载 ${String(loadedCount)} 个；是否继续加载下一批？`)
      } else {
        setPendingGraphLoad(undefined)
        setPostCommitNotice(undefined)
      }
    } catch (cause) {
      setPendingGraphLoad({ result, anchorOffset, append, reason: "retry" })
      setPostCommitNotice(`本轮正文与图数据已提交，但世界图展示加载失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  const saveFile = async (): Promise<void> => {
    if (project === undefined || selectedPath === undefined) return
    await invokeBackend("workspace.save", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
      relativePath: selectedPath,
      content,
    })
    setSavedContent(content)
  }

  const createWorkspaceMarkdown = (destinationOverride?: string): void => {
    if (project === undefined) return
    const destination = destinationOverride ?? resolveCreateDestination(selectedPath ?? openedDocumentPath)
    setWorkspaceCreatePrompt({ kind: "file", parentPath: destination })
  }

  const createWorkspaceDirectory = (parentPath?: string): void => {
    if (project === undefined) return
    const destination = parentPath ?? resolveCreateDestination(selectedPath ?? openedDocumentPath)
    setWorkspaceCreatePrompt({
      kind: "directory",
      parentPath: canCreateFolderInDirectory(destination) ? destination : "设定集",
    })
  }

  const confirmWorkspaceCreate = async (rawName: string): Promise<void> => {
    if (project === undefined || workspaceCreatePrompt === undefined) return
    const { kind, parentPath } = workspaceCreatePrompt
    setWorkspaceCreatePrompt(undefined)
    setError(undefined)
    try {
      if (kind === "file") {
        const trimmed = rawName.trim().replaceAll("\\", "/").split("/").at(-1) ?? ""
        const filename = trimmed.length === 0
          ? "未命名.md"
          : trimmed.toLowerCase().endsWith(".md")
            ? trimmed
            : `${trimmed}.md`
        const relativePath = `${parentPath}/${filename}`
        await invokeBackend("workspace.save", {
          projectId: project.projectId,
          workspaceRootRef: project.workspaceRootRef,
          relativePath,
          content: `# ${filename.replace(/\.md$/iu, "")}\n\n`,
        })
        await refreshWorkspace()
        await openFile(relativePath)
        setPostCommitNotice(`已新建「${relativePath}」`)
        return
      }
      const folderName = rawName.trim().replaceAll("\\", "/").split("/").filter((part) => part.length > 0).at(-1)
      if (folderName === undefined || folderName.length === 0) return
      if (parentPath === "章节正文" && !isValidVolumeFolderName(folderName)) {
        setError("卷文件夹必须命名为「第N卷 标题」，例如「第一卷 潮水退去时」")
        return
      }
      if (parentPath === "章节正文") {
        const existingVolumes = report.inventory
          .filter((entry) => entry.kind === "directory" && isVolumeDirectoryPath(entry.path))
          .map((entry) => entry.path.slice("章节正文/".length))
        const duplicate = findDuplicateVolumeSequence(folderName, existingVolumes)
        if (duplicate !== undefined) {
          setError(`卷序号重复：已存在「${duplicate}」，不能再创建「${folderName}」。同一序号只能有一个卷。`)
          return
        }
      }
      const relativePath = `${parentPath}/${folderName}`
      await invokeBackend("workspace.createDirectory", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        relativePath,
      })
      await refreshWorkspace()
      setSelectedPath(relativePath)
      setPostCommitNotice(`已新建文件夹「${relativePath}」`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const deleteWorkspaceMarkdown = async (path: string): Promise<void> => {
    if (project === undefined) return
    const isVolume = isChapterVolumeContainerPath(path)
    const confirmLabel = isVolume
      ? `确定删除卷文件夹「${path}」？其中的梗概/细纲会一并删除；若含正式正文则无法删除。`
      : `确定删除「${path}」？此操作不可撤销。`
    if (!window.confirm(confirmLabel)) return
    setError(undefined)
    try {
      await invokeBackend("workspace.delete", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        relativePath: path,
      })
      if (selectedPath === path || openedDocumentPath === path) {
        setSelectedPath(undefined)
        setOpenedDocumentPath(undefined)
        setContent("")
        setSavedContent("")
      }
      await refreshWorkspace()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const monitorTask = async (taskId: string): Promise<void> => {
    let consecutiveFailures = 0
    let chapterSurfaceOpened = false
    for (;;) {
      let snapshot: TaskSnapshot
      try {
        snapshot = await invokeBackend<TaskSnapshot>("turn.status", { taskId })
        consecutiveFailures = 0
      } catch (cause) {
        consecutiveFailures += 1
        if (consecutiveFailures >= 3) throw cause
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        continue
      }
      setTask(snapshot)

      const finalizationReady = snapshot.finalization !== undefined
        && (snapshot.finalization.status === "chapter_registered"
          || snapshot.finalization.status === "completed")
      if (!chapterSurfaceOpened && finalizationReady && snapshot.finalization !== undefined) {
        const chapterPath = snapshot.finalization.chapterPath
        try {
          await refreshWorkspace()
          await openFile(chapterPath)
          chapterSurfaceOpened = true
          if (snapshot.status !== "completed") {
            setPostCommitNotice("正文已写入工作区，正在完成梗概交接…")
          }
        } catch (cause) {
          setPostCommitNotice(`正文已提交，但打开章节失败：${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }

      if (snapshot.status === "completed") {
        setPrompt("")
        if (!chapterSurfaceOpened) {
          try {
            await refreshWorkspace()
          } catch (cause) {
            setPostCommitNotice(`本轮正文与图数据已提交，但工作区刷新失败：${cause instanceof Error ? cause.message : String(cause)}`)
          }
          const chapterPath = snapshot.result?.chapterPath ?? snapshot.finalization?.chapterPath
          if (chapterPath !== undefined) {
            await openFile(chapterPath)
            chapterSurfaceOpened = true
          } else if (snapshot.finalization !== undefined) {
            setPostCommitNotice("本轮已完成，但未找到可打开的章节路径；章节提交记录仍已保留。")
          }
        }
        if (snapshot.result !== undefined) await loadCommittedGraph(snapshot.result)
        try {
          const goals = await invokeBackend<DeductionGoalsSnapshot>("deduction.goals.list", {
            projectId: project!.projectId,
            workspaceRootRef: project!.workspaceRootRef,
          })
          const reviewCount = countPendingReviews(goals)
          setPendingReviewCount(reviewCount)
          if (reviewCount > 0) {
            setPostCommitNotice(`本轮已提交。有 ${String(reviewCount)} 条推演目标待复盘（已达成 / 部分达成 / 未达成）。`)
          } else if (chapterSurfaceOpened) {
            setPostCommitNotice(undefined)
          }
        } catch {
          // Review prompt is optional; turn completion already succeeded.
        }
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          const overview = await refreshHistory()
          if (overview?.entries.some((entry) => entry.taskId === taskId && entry.status === "ready") === true) break
        }
        return
      }
      if (["awaiting_user_decision", "waiting_for_review", "paused", "cancelled", "failed"].includes(snapshot.status)) return
      await new Promise((resolve) => setTimeout(resolve, 350))
    }
  }

  const sendSynopsisMessage = async (message: string): Promise<void> => {
    if (project === undefined || activeModelProfile === undefined) {
      setError("模型配置尚未加载完成，请稍候再发送")
      return
    }
    if (synopsisSendInFlightRef.current) {
      setError("上一轮回复仍在收尾，请稍候再发送")
      return
    }
    synopsisSendInFlightRef.current = true
    const optimisticId = crypto.randomUUID()
    const optimisticMessage: SynopsisConversationMessage = {
      messageId: optimisticId,
      sessionId: synopsisConversation.session?.sessionId ?? crypto.randomUUID(),
      projectId: project.projectId,
      role: "user",
      content: message,
      createdAtMs: Date.now(),
    }
    setSynopsisConversation((current) => ({
      ...current,
      messages: [...current.messages, optimisticMessage],
    }))
    setSynopsisConversationBusy(true)
    synopsisStopDraftRef.current = message
    setSynopsisStream({
      status: "running",
      thinking: "",
      thinkingRounds: [],
      content: "",
      searching: [],
      editing: [],
      updatedAtMs: Date.now(),
    })
    setError(undefined)
    let pollStopped = false
    let observedRunningStream = false
    const pollStream = async (): Promise<void> => {
      while (!pollStopped) {
        try {
          const peek = await invokeBackend<SynopsisConversationStreamSnapshot>("synopsis.conversation.streamPeek", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
            ...(synopsisConversation.session?.sessionId === undefined
              ? {}
              : { sessionId: synopsisConversation.session.sessionId }),
          }, {
            // Peeks must not inherit the long soft-wait used by send; a hung peek
            // would keep the Stop button stuck after the reply is already visible.
            waitTimeoutMs: 15_000,
            onWaitTimeout: async () => "abandon",
          })
          // Ignore idle until send() begins the hub; ignore stale completed/failed
          // leftovers from the previous turn until this send has been observed as running.
          if (peek.status === "idle") {
            await new Promise((resolve) => setTimeout(resolve, 200))
            continue
          }
          if (peek.status === "completed" || peek.status === "failed") {
            if (!observedRunningStream) {
              await new Promise((resolve) => setTimeout(resolve, 200))
              continue
            }
            setSynopsisStream(peek)
            if (peek.usage !== undefined) {
              setSynopsisUsage(peek.usage)
            }
            if (peek.budgetAdvisory !== undefined) {
              setSynopsisBudgetWarning(peek.budgetAdvisory)
            }
            // Keep peeking until send() sets pollStopped so post-discuss
            // staging search updates still reach the stream bubble.
          } else {
            observedRunningStream = true
            setSynopsisStream(peek)
            if (peek.usage !== undefined) {
              setSynopsisUsage(peek.usage)
            }
            if (peek.budgetAdvisory !== undefined) {
              setSynopsisBudgetWarning(peek.budgetAdvisory)
            }
          }
        } catch {
          // Peek is best-effort while the model streams.
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
    const pollTask = pollStream()
    try {
      if (synopsisConversation.session === undefined) {
        const started = await invokeBackend<SynopsisConversationStartResult>("synopsis.conversation.start", {
          projectId: project.projectId,
          workspaceRootRef: project.workspaceRootRef,
        })
        setSynopsisConversation((current) => ({
          ...current,
          session: started.session,
          messages: [...current.messages],
          ...(started.usage === undefined ? {} : { usage: started.usage }),
        }))
        if (started.usage !== undefined) setSynopsisUsage(started.usage)
      }
      const sent = await invokeBackend<SynopsisConversationSendResult>("synopsis.conversation.send", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        message,
        presentation: {
          ...(descriptionRule.length === 0 ? {} : { descriptionRulePath: descriptionRule }),
          ...(proseRule.length === 0 ? {} : { proseStyleRulePath: proseRule }),
          minimumWordCount: parsedMinimumWordCount,
          maximumWordCount: parsedMaximumWordCount,
        },
        chapterIntent: { boundaryPace, causalityFocus },
        model: {
          baseUrl: activeModelProfile.baseUrl,
          model: activeModelProfile.model,
          credentialRef: activeModelProfile.credentialRef,
          apiProtocol: activeModelProfile.apiProtocol,
          contextWindowTokens: activeModelProfile.contextWindowTokens,
          thinkingModeEnabled: true,
          reasoningEffort: activeModelProfile.reasoningEffort,
          jsonModeEnabled: activeModelProfile.jsonModeEnabled,
          disableResponseStorage: activeModelProfile.disableResponseStorage,
          serviceTier: activeModelProfile.serviceTier,
        },
      }, {
        waitTimeoutMs: projectSettings?.execution.backendRequestWaitTimeoutMs
          ?? 600_000,
        onRequestStarted: ({ requestId }) => {
          synopsisActiveRequestRef.current = requestId
        },
        onWaitTimeout: (info) => new Promise<"continue" | "abandon">((resolve) => {
          setBackendWaitPrompt({ info, decide: resolve })
        }),
      })
      setBackendWaitPrompt((current) => {
        current?.decide("continue")
        return undefined
      })
      pollStopped = true
      setSynopsisConversation(sent)
      setPendingStagingPromotes(sent.pendingStagingPromotes ?? [])
      if (sent.workDisplayName !== undefined) {
        setProject((current) => current === undefined
          ? current
          : { ...current, displayName: sent.workDisplayName! })
        rememberWorkName(project.projectId, sent.workDisplayName)
      }
      if (sent.budgetAdvisory !== undefined) {
        setSynopsisBudgetWarning(sent.budgetAdvisory)
      }
      if (sent.usage !== undefined) {
        setSynopsisUsage(sent.usage)
      }
      setSynopsisStream(undefined)
      setSynopsisConversationBusy(false)
      void refreshWorkspace().catch(() => undefined)
    } catch (cause) {
      pollStopped = true
      setBackendWaitPrompt((current) => {
        current?.decide("continue")
        return undefined
      })
      setSynopsisStream(undefined)
      if (cause instanceof BackendRequestAbandonedError || isSynopsisSendCancelledError(cause)) {
        setSynopsisConversation((current) => ({
          ...current,
          messages: current.messages.filter((entry) => entry.messageId !== optimisticId),
        }))
        setSynopsisDraftRestore({ text: message, token: Date.now() })
        try {
          const discarded = await invokeBackend<SynopsisConversationListResult>(
            "synopsis.conversation.discardLastUserTurn",
            {
              projectId: project.projectId,
              workspaceRootRef: project.workspaceRootRef,
              ...(synopsisConversation.session?.sessionId === undefined
                ? {}
                : { sessionId: synopsisConversation.session.sessionId }),
            },
          )
          setSynopsisConversation(discarded)
        } catch {
          // Best-effort context rollback; draft is already restored locally.
        }
        return
      }
      setSynopsisConversation((current) => ({
        ...current,
        messages: current.messages.filter((entry) => entry.messageId !== optimisticId),
      }))
      if (isSynopsisBudgetError(cause)) {
        setSynopsisBudgetWarning(parseSynopsisBudgetError(cause))
        return
      }
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      pollStopped = true
      synopsisSendInFlightRef.current = false
      synopsisActiveRequestRef.current = null
      synopsisStopDraftRef.current = null
      setBackendWaitPrompt((current) => {
        current?.decide("continue")
        return undefined
      })
      setSynopsisConversationBusy(false)
      void pollTask.catch(() => undefined)
    }
  }

  const stopSynopsisMessage = async (): Promise<void> => {
    if (project === undefined || !synopsisConversationBusy) return
    const requestId = synopsisActiveRequestRef.current
    const draftText = synopsisStopDraftRef.current
    setError(undefined)
    setBackendWaitPrompt((current) => {
      current?.decide("abandon")
      return undefined
    })
    try {
      const discarded = await invokeBackend<SynopsisConversationListResult>(
        "synopsis.conversation.discardLastUserTurn",
        {
          projectId: project.projectId,
          workspaceRootRef: project.workspaceRootRef,
          ...(synopsisConversation.session?.sessionId === undefined
            ? {}
            : { sessionId: synopsisConversation.session.sessionId }),
        },
      )
      setSynopsisConversation(discarded)
    } catch {
      // discard is best-effort; abandon below still unblocks the UI.
    }
    if (requestId !== null) {
      await abandonBackendRequest(requestId).catch(() => undefined)
    }
    if (draftText !== null && draftText.length > 0) {
      setSynopsisDraftRestore({ text: draftText, token: Date.now() })
    }
    setSynopsisStream(undefined)
    setSynopsisConversationBusy(false)
  }

  const acknowledgeSynopsisBudget = async (): Promise<void> => {
    if (project === undefined) return
    try {
      await invokeBackend("synopsis.conversation.acknowledgeBudget", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
      })
    } catch {
      // Local dismiss still improves UX if backend is unreachable.
    }
    setSynopsisBudgetWarning(undefined)
  }

  const refreshSynopsisChoices = async (messageId: string): Promise<void> => {
    if (project === undefined || activeModelProfile === undefined) {
      setError("模型配置尚未加载完成，请稍候再刷新选项")
      return
    }
    setError(undefined)
    try {
      const refreshed = await invokeBackend<SynopsisConversationSendResult>("synopsis.conversation.refreshChoices", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        messageId,
        presentation: {
          ...(descriptionRule.length === 0 ? {} : { descriptionRulePath: descriptionRule }),
          ...(proseRule.length === 0 ? {} : { proseStyleRulePath: proseRule }),
          minimumWordCount: parsedMinimumWordCount,
          maximumWordCount: parsedMaximumWordCount,
        },
        chapterIntent: { boundaryPace, causalityFocus },
        model: {
          baseUrl: activeModelProfile.baseUrl,
          model: activeModelProfile.model,
          credentialRef: activeModelProfile.credentialRef,
          apiProtocol: activeModelProfile.apiProtocol,
          contextWindowTokens: activeModelProfile.contextWindowTokens,
          thinkingModeEnabled: true,
          reasoningEffort: activeModelProfile.reasoningEffort,
          jsonModeEnabled: activeModelProfile.jsonModeEnabled,
          disableResponseStorage: activeModelProfile.disableResponseStorage,
          serviceTier: activeModelProfile.serviceTier,
        },
      })
      setSynopsisConversation(refreshed)
      if (refreshed.usage !== undefined) setSynopsisUsage(refreshed.usage)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const promoteStaging = async (): Promise<void> => {
    if (project === undefined) return
    setError(undefined)
    try {
      let proposals = pendingStagingPromotes
      if (proposals.length === 0) {
        const listed = await invokeBackend<{ proposals: SynopsisStagingPromoteProposal[] }>(
          "synopsis.staging.promote.list",
          {
            projectId: project.projectId,
            workspaceRootRef: project.workspaceRootRef,
            ...(synopsisConversation.session?.sessionId === undefined
              ? {}
              : { sessionId: synopsisConversation.session.sessionId }),
          },
        )
        proposals = listed.proposals
      }
      if (proposals.length === 0) {
        setError("当前没有可落盘的提案。请等 Agent 给出「确认落盘」类选项后再点底部按钮。")
        return
      }
      setSynopsisConversationBusy(true)
      await invokeBackend("synopsis.staging.promote.approve", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        proposalIds: proposals.map((proposal) => proposal.proposalId),
      })
      const writtenPaths = [...new Set(proposals.flatMap((proposal) => (
        proposal.settingsWrites.map((write) => write.relativePath)
      )))]
      setPendingStagingPromotes([])
      await refreshWorkspace()
      const reopenPath = writtenPaths.find((path) => path === selectedPath || path === openedDocumentPath)
        ?? writtenPaths[0]
      if (reopenPath !== undefined) {
        await openFile(reopenPath)
      }
      setPostCommitNotice(
        writtenPaths.length === 0
          ? "落盘已确认。"
          : `已落盘：${writtenPaths.join("、")}`,
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSynopsisConversationBusy(false)
    }
  }

  const rejectStagingPromote = async (proposalIds: readonly string[]): Promise<void> => {
    if (project === undefined || proposalIds.length === 0) return
    setSynopsisConversationBusy(true)
    setError(undefined)
    try {
      await invokeBackend("synopsis.staging.promote.reject", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        proposalIds,
      })
      setPendingStagingPromotes((current) => current.filter((proposal) => !proposalIds.includes(proposal.proposalId)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSynopsisConversationBusy(false)
    }
  }

  const startTurn = async (): Promise<void> => {
    if (project === undefined || task?.status === "running" || !wordCountValid) return
    if (activeModelProfile === undefined) {
      setError("模型配置尚未加载完成，请稍候再开始推演")
      return
    }
    setError(undefined)
    setPostCommitNotice(undefined)
    setPendingGraphLoad(undefined)
    try {
      const model = {
        baseUrl: activeModelProfile.baseUrl,
        model: activeModelProfile.model,
        credentialRef: activeModelProfile.credentialRef,
        apiProtocol: activeModelProfile.apiProtocol,
        contextWindowTokens: activeModelProfile.contextWindowTokens,
        thinkingModeEnabled: activeModelProfile.thinkingModeEnabled,
        reasoningEffort: activeModelProfile.reasoningEffort,
        jsonModeEnabled: activeModelProfile.jsonModeEnabled,
        disableResponseStorage: activeModelProfile.disableResponseStorage,
        serviceTier: activeModelProfile.serviceTier,
      }
      const presentation = {
        ...(descriptionRule.length === 0 ? {} : { descriptionRulePath: descriptionRule }),
        ...(proseRule.length === 0 ? {} : { proseStyleRulePath: proseRule }),
        minimumWordCount: parsedMinimumWordCount,
        maximumWordCount: parsedMaximumWordCount,
      }
      const chapterIntent = { boundaryPace, causalityFocus }
      let started: { taskId: string }
      if (selectedPath === undefined) {
        started = await invokeBackend<{ taskId: string }>("synopsis.conversation.beginTurn", {
          projectId: project.projectId,
          workspaceRootRef: project.workspaceRootRef,
          acknowledgeWarnings: true,
          ...(synopsisConversation.session?.sessionId === undefined
            ? {}
            : { sessionId: synopsisConversation.session.sessionId }),
          presentation,
          chapterIntent,
          model,
        })
      } else {
        let userInput = prompt.trim()
        const chapters = await invokeBackend<readonly ChapterSummary[]>("chapter.list", {
          projectId: project.projectId,
          workspaceRootRef: project.workspaceRootRef,
        })
        const chapterSequence = chapters.reduce((max, chapter) => Math.max(max, chapter.sequence ?? 0), 0) + 1
        if (userInput.length === 0) return
        started = await invokeBackend<{ taskId: string }>("turn.start", {
          projectId: project.projectId,
          workspaceRootRef: project.workspaceRootRef,
          userInput,
          chapterSequence,
          presentation,
          chapterIntent,
          model,
        })
      }
      setTask({ handle: { taskId: started.taskId, status: "running" }, status: "running" })
      await monitorTask(started.taskId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setTask((current) => current === undefined
        ? { status: "failed", error: { message: cause instanceof Error ? cause.message : String(cause) } }
        : { ...current, error: { message: cause instanceof Error ? cause.message : String(cause) } })
    }
  }

  const resumeTask = async (mode: "continue" | "retry_phase"): Promise<void> => {
    const taskId = task?.handle?.taskId
    if (taskId === undefined || projectSettings === undefined) throw new Error("当前任务没有可恢复标识")
    const handle = await invokeBackend<{ taskId: string; status: string }>("turn.resume", {
      taskId,
      mode,
      ...(activeModelProfile === undefined ? {} : {
        model: {
          baseUrl: activeModelProfile.baseUrl,
          model: activeModelProfile.model,
          credentialRef: activeModelProfile.credentialRef,
          apiProtocol: activeModelProfile.apiProtocol,
          contextWindowTokens: activeModelProfile.contextWindowTokens,
          thinkingModeEnabled: activeModelProfile.thinkingModeEnabled,
          reasoningEffort: activeModelProfile.reasoningEffort,
          jsonModeEnabled: activeModelProfile.jsonModeEnabled,
          disableResponseStorage: activeModelProfile.disableResponseStorage,
          serviceTier: activeModelProfile.serviceTier,
        },
      }),
      maxModelCalls: projectSettings.execution.maxModelCalls,
      deadlineMs: projectSettings.execution.maxWallTimeMs,
      maxRetrievalRounds: projectSettings.execution.maxRetrievalRounds,
    })
    setTask((current) => {
      const { interruption: _interruption, ...rest } = current ?? { status: "running" }
      void _interruption
      return { ...rest, handle, status: "running" }
    })
    void monitorTask(taskId).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const resetTaskMetrics = async (metricIds: readonly ResettableRuntimeMetricId[]): Promise<void> => {
    const taskId = task?.handle?.taskId
    if (taskId === undefined) throw new Error("当前任务没有可重置标识")
    const runtimeMetrics = await invokeBackend<NonNullable<TaskSnapshot["runtimeMetrics"]>>("turn.metrics.reset", {
      taskId,
      metricIds,
    })
    setTask((current) => current === undefined ? current : { ...current, runtimeMetrics })
  }

  const applyHistoryCheckout = async (method: "history.restore" | "history.continueFrom", entryId: string): Promise<void> => {
    if (project === undefined) return
    const result = await invokeBackend<HistoryCheckoutResult>(method, {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
      operationId: crypto.randomUUID(),
      entryId,
    })
    setSelectedPath(undefined)
    setOpenedDocumentPath(undefined)
    setSelectedChapter(undefined)
    setChapterRevision(undefined)
    setContent("")
    setChapterBody("")
    setSavedContent("")
    setChapterRevision(undefined)
    setChapterRevisionContent(undefined)
    await Promise.all([refreshWorkspace(), refreshHistory(), loadHistoryGraph(result.graphAnchorIds)])
    const recoverable = await invokeBackend<RecoverableTaskList>("turn.recoverable.list", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
    })
    setTask(result.restoredTaskId === undefined
      ? undefined
      : recoverable.find((candidate) => candidate.handle?.taskId === result.restoredTaskId))
    setPostCommitNotice(method === "history.continueFrom"
      ? `已从“${result.entry.name}”创建并切换到 ${result.branch.name}。`
      : `已加载“${result.entry.name}”，章节、世界图、Markdown 与上下文链已恢复。`)
  }

  const saveHistory = async (): Promise<void> => {
    if (project === undefined) return
    const now = new Date()
    await invokeBackend("history.saveManual", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
      operationId: crypto.randomUUID(),
      name: `手动保存 · ${now.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`,
    })
    await refreshHistory()
  }

  const returnPreviousRound = async (): Promise<void> => {
    if (project === undefined) return
    const payload = {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
      operationId: crypto.randomUUID(),
    }
    let result: HistoryCheckoutResult
    try {
      result = await invokeBackend<HistoryCheckoutResult>("history.returnPreviousRound", payload)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (!isRecoverableDatabaseDisconnect(message)) throw cause
      await invokeBackend<OpenProject>("project.open", { workspaceRootRef: project.workspaceRootRef })
      result = await invokeBackend<HistoryCheckoutResult>("history.returnPreviousRound", {
        ...payload,
      operationId: crypto.randomUUID(),
    })
    }
    if (task?.handle?.taskId !== undefined) {
      try {
        await invokeBackend("turn.cancel", { taskId: task.handle.taskId })
      } catch {
        // History already moved; ignore cancel failures on a dead task handle.
      }
    }
    setSelectedPath(undefined)
    setOpenedDocumentPath(undefined)
    setContent("")
    setSavedContent("")
    setTask(undefined)
    await Promise.all([refreshWorkspace(), refreshHistory(), loadHistoryGraph(result.graphAnchorIds)])
    setPostCommitNotice(`已返回上一轮“${result.entry.name}”；再次开始推演或编辑时会自动创建新世界线。`)
  }

  const continueGraphLoad = async (): Promise<void> => {
    if (pendingGraphLoad === undefined) return
    await loadCommittedGraph(
      pendingGraphLoad.result,
      pendingGraphLoad.anchorOffset,
      pendingGraphLoad.append,
    )
  }

  const saveModelProfiles = async (profiles: readonly ModelProfile[], activeProfileId: string): Promise<void> => {
    const saved = await persistModelProfiles({
      profiles,
      activeProfileId,
    })
    setModelProfiles(saved.profiles)
    setActiveModelProfileId(saved.activeProfileId)
    setModelDialogOpen(false)
  }

  const applyModelProfiles = async (
    profiles: readonly ModelProfile[],
    activeProfileId: string,
  ): Promise<void> => {
    const saved = await persistModelProfiles({
      profiles,
      activeProfileId,
    })
    setModelProfiles(saved.profiles)
    setActiveModelProfileId(saved.activeProfileId)
  }

  const updateActiveModelId = async (modelId: string): Promise<void> => {
    if (activeModelProfile === undefined) return
    const nextModel = modelId.trim()
    if (nextModel.length === 0 || activeModelProfile.model === nextModel) return
    const nextProfiles = modelProfiles.map((profile) => (
      profile.id !== activeModelProfile.id
        ? profile
        : { ...profile, model: nextModel }
    ))
    await applyModelProfiles(nextProfiles, activeModelProfileId)
  }

  const updateActiveReasoningEffort = async (effort: ModelProfile["reasoningEffort"]): Promise<void> => {
    if (activeModelProfile === undefined) return
    if (activeModelProfile.reasoningEffort === effort) return
    const nextProfiles = modelProfiles.map((profile) => (
      profile.id !== activeModelProfile.id
        ? profile
        : {
            ...profile,
            reasoningEffort: effort,
            ...(effort === "none" ? {} : { thinkingModeEnabled: true }),
          }
    ))
    await applyModelProfiles(nextProfiles, activeModelProfileId)
  }

  const saveProjectSettings = async (settings: ProjectSettings): Promise<void> => {
    if (project === undefined) return
    if (settings.history.retentionLimit !== projectSettings?.history.retentionLimit) {
      const preview = await invokeBackend<HistoryRetentionPreview>("history.retention.preview", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        retentionLimit: settings.history.retentionLimit,
      })
      if (preview.deleteCount > 0 && !window.confirm(`新的历史上限会删除最旧的 ${String(preview.deleteCount)} 个保存点，且无法从历史列表恢复。是否继续？`)) return
    }
    const saved = await invokeBackend<ProjectSettings>("project.settings.save", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
      settings,
    })
    setProjectSettings(saved)
    await refreshHistory()
    setProjectSettingsOpen(false)
  }

  const descriptionRules = useMemo(() => report.inventory.filter((entry) => entry.kind === "file" && entry.path.startsWith("表现输出/描写规则/")).map((entry) => entry.path), [report])
  const proseRules = useMemo(() => report.inventory.filter((entry) => entry.kind === "file" && entry.path.startsWith("表现输出/笔风规则/")).map((entry) => entry.path), [report])

  useEffect(() => {
    if (report.inventory.length === 0) return
    if (descriptionRule.length > 0 && !descriptionRules.includes(descriptionRule)) {
      updatePresentation({ descriptionRule: "" })
    }
  }, [descriptionRule, descriptionRules, report.inventory.length, updatePresentation])

  useEffect(() => {
    if (report.inventory.length === 0) return
    if (proseRule.length > 0 && !proseRules.includes(proseRule)) {
      updatePresentation({ proseRule: "" })
    }
  }, [proseRule, proseRules, report.inventory.length, updatePresentation])

  const synopsisTokenMetrics = useMemo((): TaskTokenMetrics => {
    const fromUsage = summarizeSynopsisUsageTokenMetrics(synopsisUsage)
    if (Object.keys(fromUsage).length > 0) return fromUsage
    return summarizeSynopsisStreamTokenMetrics(synopsisStream)
  }, [synopsisUsage, synopsisStream])

  const resetWorkbenchForProject = useCallback((next: OpenProject | undefined): void => {
    setProject(next)
    setReport({ inventory: [], issues: [] })
    setSelectedPath(undefined)
    setOpenedDocumentPath(undefined)
    setContent("")
    setChapterBody("")
    setSavedContent("")
    setSelectedChapter(undefined)
    setChapterRevision(undefined)
    setChapterRevisionContent(undefined)
    setChapterConversation({ messages: [] })
    setChapterConversationBusy(false)
    setSynopsisConversation({ messages: [] })
    setSynopsisConversationBusy(false)
    setSynopsisStream(undefined)
    setSynopsisUsage(undefined)
    setChapterSynopsis(undefined)
    setSynopsisPanelOpen(false)
    setPrompt("")
    setTask(undefined)
    setGraphSlice(undefined)
    setError(undefined)
    setPostCommitNotice(undefined)
    setProgressReviewOpen(false)
    setPendingReviewCount(0)
    setPendingGraphLoad(undefined)
    setProjectSettingsOpen(false)
    setProjectSettings(undefined)
    setHistory(undefined)
    setDiffFocusMessageId(undefined)
  }, [])

  const openWorkspaceHome = (): void => {
    setSelectedPath(undefined)
    setLineageMode(false)
    setSynopsisPanelOpen(false)
  }

  const openSettingsLineage = (): void => {
    setLineageMode(true)
    setSelectedPath(undefined)
    setSynopsisPanelOpen(false)
    setError(undefined)
  }

  const reopenOpenedDocument = (): void => {
    if (openedDocumentPath === undefined) return
    setLineageMode(false)
    setSelectedPath(openedDocumentPath)
  }

  if (project === undefined) {
    return <>
      <AppChrome
        rail={
          <ProjectRail
            onOpen={resetWorkbenchForProject}
            updateAvailable={appUpdate.available}
            onUpdateClick={() => {
              appUpdate.openUpdatePrompt()
            }}
          />
        }
      >
        <ProjectLauncher onOpen={resetWorkbenchForProject} />
      </AppChrome>
      {appUpdate.dialog !== null
        ? <AppUpdateDialog
            state={appUpdate.dialog}
            onClose={appUpdate.closeDialog}
            onConfirmDownload={() => { void appUpdate.confirmDownload() }}
            onCancelDownload={() => { void appUpdate.cancelDownload() }}
            onInstall={() => { void appUpdate.installAndQuit() }}
          />
        : null}
    </>
  }

  const readOnly = selectedPath?.startsWith("世界推演规则/基础规则/") === true
    || (selectedPath?.startsWith("章节正文/") === true && !isChapterPlanningMarkdownPath(selectedPath))
  const dirty = content !== savedContent
  const inGraphSyncRecovery = chapterRevision?.decision === "submit"
    && chapterRevision.graphSyncStatus !== "completed"
  const selectedChapterKind = selectedPath === undefined
    ? undefined
    : resolveChapterMarkdownKind(selectedPath)
  const showPlanningRelatedRail = selectedChapterKind === "plot_synopsis"
    || selectedChapterKind === "plot_outline"
  const showChapterConversation = selectedPath?.startsWith("章节正文/") === true
    && !isChapterPlanningMarkdownPath(selectedPath ?? "")
    && !inGraphSyncRecovery
  const showRightPanel = !lineageMode && (
    selectedPath === undefined
    || showChapterConversation
    || showPlanningRelatedRail
  )

  return <AppChrome
    rail={
      <ProjectRail
        activeProjectId={project.projectId}
        onOpen={resetWorkbenchForProject}
        updateAvailable={appUpdate.available}
        onUpdateClick={() => {
          appUpdate.openUpdatePrompt()
        }}
      />
    }
    titleLeading={
      <>
        <WorkNameControl
          project={project}
          running={task?.status === "running"}
          statusLabel={task?.status === "running" ? "推演中" : "就绪"}
          {...(activeModelProfile === undefined ? {} : { model: activeModelProfile })}
          onRenamed={(displayName) => {
            setProject((current) => current === undefined ? current : { ...current, displayName })
            rememberWorkName(project.projectId, displayName)
          }}
        />
        <UiTooltip label="配置与切换模型">
          <button className="model-config-trigger" data-testid="model-config-trigger" aria-label="配置与切换模型" onClick={() => { setModelDialogOpen(true); }}><Cpu size={14} /><span>{activeModelProfile?.name ?? "未配置模型"}</span><ChevronDown size={13} /></button>
        </UiTooltip>
        <UiTooltip label="项目设置">
          <button className="project-settings-trigger" data-testid="project-settings-trigger" aria-label="项目设置" disabled={projectSettings === undefined} onClick={() => { setProjectSettingsSection("execution"); setProjectSettingsOpen(true); }}><Settings2 size={15} /></button>
        </UiTooltip>
      </>
    }
  >
  <main className="app-shell">
    {synopsisBudgetWarning === undefined
      ? null
      : <div className="budget-warning-banner" role="status">
          <span>{synopsisBudgetWarning.message}</span>
          <button type="button" onClick={() => { void acknowledgeSynopsisBudget(); }}>已知晓</button>
        </div>}
    {error === undefined ? null : <div className="error-banner" role="alert">
      <span className="error-banner-text">{error}</span>
      <button
        type="button"
        className="error-banner-dismiss"
        aria-label="关闭提示"
        title="关闭"
        onClick={() => {
          for (const line of error.split("\n")) {
            const sep = line.indexOf("：")
            if (sep > 0) {
              const path = line.slice(0, sep)
              const message = line.slice(sep + 1)
              for (const code of ["invalid_synopsis_name", "chapter_missing_volume", "invalid_volume_name"] as const) {
                dismissedWorkspaceIssueKeysRef.current.add(`${code}:${path}:${message}`)
              }
            }
          }
          setError(undefined)
        }}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>}
    {workspaceCreatePrompt === undefined
      ? null
      : <WorkspaceNameDialog
          kind={workspaceCreatePrompt.kind}
          parentPath={workspaceCreatePrompt.parentPath}
          onCancel={() => { setWorkspaceCreatePrompt(undefined) }}
          onConfirm={(name) => { void confirmWorkspaceCreate(name) }}
        />}
    {postCommitNotice === undefined ? null : <div className="post-commit-notice" role="status">
      <span>{postCommitNotice}</span>
      <div>
        {pendingReviewCount > 0
          ? <button
              type="button"
              data-testid="post-commit-review-goals"
              onClick={() => { setProgressReviewOpen(true); }}
            >
              复盘目标
            </button>
          : null}
        {pendingGraphLoad === undefined ? null : <button onClick={() => { void continueGraphLoad(); }}>{pendingGraphLoad.reason === "continue" ? "继续加载世界图" : "重试世界图"}</button>}
        <button onClick={() => {
          setPostCommitNotice(undefined)
          setPendingGraphLoad(undefined)
          setPendingReviewCount(0)
        }}>只看正文</button>
      </div>
    </div>}
    {project !== undefined && progressReviewOpen
      ? <CreationDeskProgressReviewDialog
          open={progressReviewOpen}
          projectId={project.projectId}
          workspaceRootRef={project.workspaceRootRef}
          onClose={() => {
            setProgressReviewOpen(false)
            setPendingReviewCount(0)
            setPostCommitNotice(undefined)
          }}
          onReviewed={() => {
            setPendingReviewCount((count) => Math.max(0, count - 1))
          }}
        />
      : null}
    {backendWaitPrompt === undefined
      ? null
      : <BackendWaitTimeoutDialog
          method={backendWaitPrompt.info.method}
          waitTimeoutMs={backendWaitPrompt.info.waitTimeoutMs}
          elapsedMs={backendWaitPrompt.info.elapsedMs}
          onContinue={() => {
            const decide = backendWaitPrompt.decide
            setBackendWaitPrompt(undefined)
            decide("continue")
          }}
          onStop={() => {
            const decide = backendWaitPrompt.decide
            setBackendWaitPrompt(undefined)
            decide("abandon")
          }}
        />}
    <PanelGroup className="workbench-panels" direction="horizontal">
      <Panel defaultSize={19} minSize={14} maxSize={28} collapsible>
        <WorkspaceTree
          entries={report.inventory}
          selectedPath={selectedPath ?? openedDocumentPath}
          lineageActive={lineageMode}
          onSelect={(path) => void openFile(path)}
          onSelectLineage={openSettingsLineage}
          onRefresh={() => void refreshWorkspace()}
          onCreateMarkdown={(destination) => { createWorkspaceMarkdown(destination) }}
          onCreateDirectory={(parentPath) => { createWorkspaceDirectory(parentPath) }}
          onDeletePath={(path) => { void deleteWorkspaceMarkdown(path) }}
        />
      </Panel>
      <PanelResizeHandle className="resize-handle"><PanelLeftClose size={12} /></PanelResizeHandle>
      <Panel minSize={42}>
        {lineageMode
          ? <SettingsLineagePanel
              projectId={project.projectId}
              workspaceRootRef={project.workspaceRootRef}
            />
          : <EditorArea
          projectId={project.projectId}
          workspaceRootRef={project.workspaceRootRef}
          selectedPath={selectedPath}
          openedDocumentPath={openedDocumentPath}
          content={content}
          dirty={dirty}
          readOnly={readOnly}
          running={task?.status === "running"}
          prompt={prompt}
          descriptionRule={descriptionRule}
          proseRule={proseRule}
          minimumWordCount={minimumWordCount}
          maximumWordCount={maximumWordCount}
          wordCountValid={wordCountValid}
          descriptionRules={descriptionRules}
          proseRules={proseRules}
          boundaryPace={boundaryPace}
          causalityFocus={causalityFocus}
          onContentChange={setContent}
          onHome={openWorkspaceHome}
          onOpenDocument={reopenOpenedDocument}
          onPromptChange={setPrompt}
          onDescriptionRuleChange={(value) => { updatePresentation({ descriptionRule: value }); }}
          onProseRuleChange={(value) => { updatePresentation({ proseRule: value }); }}
          onMinimumWordCountChange={(value) => { updatePresentation({ minimumWordCount: value }); }}
          onMaximumWordCountChange={(value) => { updatePresentation({ maximumWordCount: value }); }}
          onBoundaryPaceChange={(value) => { updatePresentation({ boundaryPace: value }); }}
          onCausalityFocusChange={(value) => { updatePresentation({ causalityFocus: value }); }}
          modelProfiles={modelProfiles}
          activeModelProfileId={activeModelProfileId}
          onActiveModelIdChange={(modelId) => { void updateActiveModelId(modelId); }}
          onReasoningEffortChange={(effort) => { void updateActiveReasoningEffort(effort); }}
          onSave={() => void saveFile()}
          onRun={() => void startTurn()}
          chapter={selectedChapter}
          chapterBody={chapterBody}
          revision={chapterRevision}
          revisionContent={chapterRevisionContent}
          onEnsureRevision={ensureChapterRevision}
          onUpdateRevision={updateChapterRevision}
          onReviewRevision={reviewChapterRevision}
          onSubmitRevision={submitChapterRevision}
          onRetireRevision={retireChapterRevision}
          chapterConversationMessages={chapterConversation.messages}
          synopsisSession={synopsisConversation.session}
          synopsisMessages={synopsisConversation.messages}
          synopsisBusy={synopsisConversationBusy}
          synopsisStream={synopsisStream}
          synopsisDraftRestore={synopsisDraftRestore}
          synopsisTokenMetrics={{
            ...synopsisTokenMetrics,
            ...(activeModelProfile?.contextWindowTokens === undefined
              ? {}
              : { contextWindowTokens: activeModelProfile.contextWindowTokens }),
          }}
          pendingStagingPromotes={pendingStagingPromotes}
          onSynopsisSend={sendSynopsisMessage}
          onSynopsisStop={stopSynopsisMessage}
          onSynopsisRefreshChoices={refreshSynopsisChoices}
          onPromoteStaging={promoteStaging}
          onRejectStagingPromote={rejectStagingPromote}
          onOpenSynopsisFile={(path) => { void openFile(path); }}
          onOpenSettingsLineage={openSettingsLineage}
          diffFocusMessageId={diffFocusMessageId}
          onDiffFocusHandled={() => { setDiffFocusMessageId(undefined); }}
        />}
      </Panel>
      {showRightPanel
        ? <>
      <PanelResizeHandle className="resize-handle"><PanelRightClose size={12} /></PanelResizeHandle>
            <Panel defaultSize={25} minSize={20} maxSize={38} collapsible className="workbench-right-panel">
              <RightPanelViewport
                chapterMode={showChapterConversation || showPlanningRelatedRail}
                chapterPanel={showPlanningRelatedRail && selectedChapterKind !== undefined && selectedPath !== undefined
                  ? <ChapterArtifactRelatedRail
                      currentKind={selectedChapterKind}
                      currentPath={selectedPath}
                      related={[
                        {
                          kind: selectedChapterKind,
                          path: selectedPath,
                          present: true,
                          content,
                        },
                        ...relatedChapterArtifacts,
                      ]}
                      onOpen={(path) => { void openFile(path); }}
                    />
                  : <ChapterWorkspaceRail
                      messages={chapterConversation.messages}
                      revisionTaskId={chapterConversation.revisionTaskId}
                      busy={chapterConversationBusy}
                      chapterSynopsis={chapterSynopsis}
                      synopsisPanelOpen={synopsisPanelOpen}
                      relatedArtifacts={relatedChapterArtifacts}
                      {...(selectedChapterKind === undefined ? {} : { currentKind: selectedChapterKind })}
                      {...(selectedPath === undefined ? {} : { currentPath: selectedPath })}
                      onToggleSynopsisPanel={() => { setSynopsisPanelOpen((current) => !current); }}
                      onSend={sendChapterConversation}
                      onInspectDiff={(messageId) => { setDiffFocusMessageId(messageId); }}
                      onOpenRelated={(path) => { void openFile(path); }}
                    />}
                defaultPanel={<RightRail
          task={task}
                  project={project}
          graphSlice={graphSlice}
          graphSettings={projectSettings?.graph}
          historyRetentionLimit={projectSettings?.history.retentionLimit}
          history={history}
          historyLoading={historyLoading}
                  contextWindowTokens={activeModelProfile?.contextWindowTokens}
          onOpenProjectSettings={() => { setProjectSettingsOpen(true); }}
          onResumeTask={resumeTask}
          onResetTaskMetrics={resetTaskMetrics}
          onSaveHistory={saveHistory}
          onRestoreHistory={(entryId) => applyHistoryCheckout("history.restore", entryId)}
          onContinueFromHistory={(entryId) => applyHistoryCheckout("history.continueFrom", entryId)}
          onReturnPreviousRound={returnPreviousRound}
                  onRefreshTask={async () => {
                    const taskId = task?.handle?.taskId
                    if (taskId === undefined) return
                    const snapshot = await invokeBackend<TaskSnapshot>("turn.status", { taskId })
                    setTask(snapshot)
                  }}
                  onRefreshWorkspace={refreshWorkspace}
                />}
        />
      </Panel>
          </>
        : null}
    </PanelGroup>
    <footer className="statusbar">
      <span>UTF-8</span><span>LF</span><span>Markdown</span><span className={dirty ? "unsaved" : "saved"}>{dirty ? <Cloud size={13} /> : <Save size={13} />}{dirty ? "未保存" : "已保存"}</span>
      <span className="status-path"><FolderOpen size={13} />{selectedPath === undefined ? project.workspaceRootRef : `${project.workspaceRootRef}\\${selectedPath.replaceAll("/", "\\")}`}</span>
      <span>继承环境：本轮 RuleSnapshot</span><span>归档：空闲</span>
    </footer>
    {modelDialogOpen ? <ModelConfigurationDialog profiles={modelProfiles} activeProfileId={activeModelProfileId} onClose={() => { setModelDialogOpen(false); }} onSave={saveModelProfiles} /> : null}
    {projectSettingsOpen && projectSettings !== undefined ? <ProjectSettingsDialog
      projectName={project.displayName}
      settings={projectSettings}
      activeModelName={activeModelProfile?.name ?? "未配置模型"}
      historyEntryCount={history?.entries.length ?? 0}
      initialSection={projectSettingsSection}
      appUpdate={appUpdate}
      onClose={() => { setProjectSettingsOpen(false); }}
      onSave={saveProjectSettings}
      onOpenModelSettings={() => { setProjectSettingsOpen(false); setModelDialogOpen(true); }}
    /> : null}
    {appUpdate.dialog !== null
      ? <AppUpdateDialog
          state={appUpdate.dialog}
          onClose={appUpdate.closeDialog}
          onConfirmDownload={() => { void appUpdate.confirmDownload() }}
          onCancelDownload={() => { void appUpdate.cancelDownload() }}
          onInstall={() => { void appUpdate.installAndQuit() }}
        />
      : null}
  </main>
  </AppChrome>
}

function parseWordCount(value: string): number | undefined {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) return undefined
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function modelSelection(profile: ModelProfile) {
  return {
    baseUrl: profile.baseUrl,
    model: profile.model,
    credentialRef: profile.credentialRef,
    apiProtocol: profile.apiProtocol,
    contextWindowTokens: profile.contextWindowTokens,
    thinkingModeEnabled: profile.thinkingModeEnabled,
    reasoningEffort: profile.reasoningEffort,
    jsonModeEnabled: profile.jsonModeEnabled,
    disableResponseStorage: profile.disableResponseStorage,
    serviceTier: profile.serviceTier,
  }
}

export function shouldMonitorChapterRevision(status: ChapterRevision["graphSyncStatus"]): boolean {
  return status === "running"
}

function isSynopsisBudgetError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes("预算")
}

function parseSynopsisBudgetError(error: Error): SynopsisConversationBudgetAdvisory {
  return {
    message: error.message.includes("提醒阈值")
      ? error.message
      : "梗概讨论模型调用次数较多。可在右侧查看 Token 与上下文占用；点击「已知晓」后将重置计数，再次达到阈值时会重新提醒。",
    callsUsed: 0,
    softLimit: 1,
  }
}

function isSynopsisSendCancelledError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === "SynopsisSendCancelledError"
    || error.message.includes("SynopsisSendCancelled")
    || error.message.includes("用户停止")
}

function isWorkspaceFilePath(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0 && value.toLowerCase().endsWith(".md")
}

function isRecoverableDatabaseDisconnect(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes("driver has already been destroyed")
    || normalized.includes("no result")
    || normalized.includes("database connection is not open")
    || normalized.includes("sqlite") && normalized.includes("closed")
}

export function mergeGraphSlices(current: GraphSlice | undefined, next: GraphSlice): GraphSlice {
  if (current === undefined) return next
  return {
    nodes: [...new Map([...current.nodes, ...next.nodes].map((node) => [node.id, node])).values()],
    links: [...new Map([...current.links, ...next.links].map((link) => [link.id, link])).values()],
    truncated: next.truncated,
    ...(next.anchorWindow === undefined ? {} : { anchorWindow: next.anchorWindow }),
  }
}
