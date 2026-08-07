import { useCallback, useEffect, useMemo, useState } from "react"
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels"
import { ChevronDown, Cloud, Cpu, FolderOpen, Menu, PanelLeftClose, PanelRightClose, Save, Settings2, Sprout } from "lucide-react"
import type { ProjectSettings } from "@worldseed/contracts"

import {
  browserDemoProject,
  invokeBackend,
  readModelProfiles,
  saveModelProfiles as persistModelProfiles,
  type GraphSlice,
  type OpenProject,
  type TaskSnapshot,
  type TurnResult,
  type WorkspaceReport,
} from "../api/client.js"
import { ProjectLauncher } from "../features/projects/ProjectLauncher.js"
import { WorkspaceTree } from "../features/workspace/WorkspaceTree.js"
import { EditorArea } from "../features/editor/EditorArea.js"
import { RightRail } from "../features/status/RightRail.js"
import { ModelConfigurationDialog, type ModelProfile } from "../features/settings/ModelConfigurationDialog.js"
import { ProjectSettingsDialog } from "../features/settings/ProjectSettingsDialog.js"

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
  const [content, setContent] = useState("")
  const [savedContent, setSavedContent] = useState("")
  const [prompt, setPrompt] = useState("")
  const [descriptionRule, setDescriptionRule] = useState("")
  const [proseRule, setProseRule] = useState("")
  const [minimumWordCount, setMinimumWordCount] = useState("2000")
  const [maximumWordCount, setMaximumWordCount] = useState("3000")
  const [task, setTask] = useState<TaskSnapshot>()
  const [graphSlice, setGraphSlice] = useState<GraphSlice>()
  const [error, setError] = useState<string>()
  const [postCommitNotice, setPostCommitNotice] = useState<string>()
  const [pendingGraphLoad, setPendingGraphLoad] = useState<PendingGraphLoad>()
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false)
  const [projectSettings, setProjectSettings] = useState<ProjectSettings>()
  const [modelProfiles, setModelProfiles] = useState<readonly ModelProfile[]>([])
  const [activeModelProfileId, setActiveModelProfileId] = useState("")
  const activeModelProfile = modelProfiles.find((profile) => profile.id === activeModelProfileId)
  const parsedMinimumWordCount = parseWordCount(minimumWordCount)
  const parsedMaximumWordCount = parseWordCount(maximumWordCount)
  const wordCountValid = parsedMinimumWordCount !== undefined
    && parsedMaximumWordCount !== undefined
    && parsedMinimumWordCount <= parsedMaximumWordCount

  const refreshWorkspace = useCallback(async (): Promise<void> => {
    if (project === undefined) return
    const next = await invokeBackend<WorkspaceReport>("workspace.list", { workspaceRootRef: project.workspaceRootRef })
    setReport(next)
  }, [project])

  useEffect(() => { void refreshWorkspace() }, [refreshWorkspace])

  useEffect(() => {
    if (project === undefined) {
      setProjectSettings(undefined)
      return
    }
    let active = true
    setProjectSettings(undefined)
    void invokeBackend<ProjectSettings>("project.settings.read", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
    }).then((settings) => {
      if (active) setProjectSettings(settings)
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
    return window.worldseed?.onCommand((command) => {
      if (command === "project.new" || command === "project.open") setProject(undefined)
      if (command === "turn.start") void startTurn()
    })
  })

  const openFile = async (path: string): Promise<void> => {
    if (project === undefined) return
    setError(undefined)
    try {
      const result = await invokeBackend<{ content: string }>("workspace.read", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        relativePath: path,
      })
      setSelectedPath(path)
      setContent(result.content)
      setSavedContent(result.content)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
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
        setPostCommitNotice(`本轮正文与图数据已提交。世界图共有 ${slice.anchorWindow.requestedCount} 个查询入口，已按配置加载 ${loadedCount} 个；是否继续加载下一批？`)
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

  const startTurn = async (): Promise<void> => {
    if (project === undefined || prompt.trim().length === 0 || task?.status === "running" || !wordCountValid) return
    if (activeModelProfile === undefined) {
      setError("模型配置尚未加载完成，请稍候再开始推演")
      return
    }
    setError(undefined)
    setPostCommitNotice(undefined)
    setPendingGraphLoad(undefined)
    try {
      const started = await invokeBackend<{ taskId: string }>("turn.start", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        userInput: prompt,
        chapterSequence: chapterCount(report) + 1,
        presentation: {
          ...(descriptionRule.length === 0 ? {} : { descriptionRulePath: descriptionRule }),
          ...(proseRule.length === 0 ? {} : { proseStyleRulePath: proseRule }),
          minimumWordCount: parsedMinimumWordCount,
          maximumWordCount: parsedMaximumWordCount,
        },
        ...(activeModelProfile === undefined ? {} : {
          model: {
            baseUrl: activeModelProfile.baseUrl,
            model: activeModelProfile.model,
            credentialRef: activeModelProfile.credentialRef,
            thinkingModeEnabled: activeModelProfile.thinkingModeEnabled,
            reasoningEffort: activeModelProfile.reasoningEffort,
            jsonModeEnabled: activeModelProfile.jsonModeEnabled,
          },
        }),
      })
      setTask({ status: "running" })
      for (;;) {
        const snapshot = await invokeBackend<TaskSnapshot>("turn.status", { taskId: started.taskId })
        setTask(snapshot)
        if (snapshot.status === "completed") {
          setPrompt("")
          try {
            await refreshWorkspace()
          } catch (cause) {
            setPostCommitNotice(`本轮正文与图数据已提交，但工作区刷新失败：${cause instanceof Error ? cause.message : String(cause)}`)
          }
          if (snapshot.result !== undefined) {
            await loadCommittedGraph(snapshot.result)
            await openFile(snapshot.result.chapterPath)
          }
          break
        }
        if (snapshot.status === "failed") break
        await new Promise((resolve) => setTimeout(resolve, 350))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setTask({ status: "failed", error: { message: cause instanceof Error ? cause.message : String(cause) } })
    }
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

  const saveProjectSettings = async (settings: ProjectSettings): Promise<void> => {
    if (project === undefined) return
    const saved = await invokeBackend<ProjectSettings>("project.settings.save", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
      settings,
    })
    setProjectSettings(saved)
    setProjectSettingsOpen(false)
  }

  const descriptionRules = useMemo(() => report.inventory.filter((entry) => entry.kind === "file" && entry.path.startsWith("表现输出/描写规则/")).map((entry) => entry.path), [report])
  const proseRules = useMemo(() => report.inventory.filter((entry) => entry.kind === "file" && entry.path.startsWith("表现输出/笔风规则/")).map((entry) => entry.path), [report])
  if (project === undefined) return <ProjectLauncher onOpen={setProject} />

  const readOnly = selectedPath?.startsWith("世界推演规则/基础规则/") === true || selectedPath?.startsWith("章节正文/") === true
  const dirty = content !== savedContent
  const openWorkspaceHome = (): void => {
    if (dirty && !window.confirm("当前 Markdown 尚未保存，确定返回创作台吗？")) return
    setSelectedPath(undefined)
    setContent("")
    setSavedContent("")
  }
  return <main className="app-shell">
    <header className="topbar">
      <div className="topbar-brand"><Sprout size={18} /><strong>Worldseed</strong></div>
      <nav><button><Menu size={15} /> 文件</button><button>编辑</button><button>查看</button><button>推演</button></nav>
      <button className="model-config-trigger" data-testid="model-config-trigger" title="配置与切换模型" onClick={() => { setModelDialogOpen(true); }}><Cpu size={14} /><span>{activeModelProfile?.name ?? "未配置模型"}</span><ChevronDown size={13} /></button>
      <button className="project-settings-trigger" data-testid="project-settings-trigger" title="项目设置" aria-label="项目设置" disabled={projectSettings === undefined} onClick={() => { setProjectSettingsOpen(true); }}><Settings2 size={15} /></button>
      <div className="project-indicator"><span>{project.displayName}</span><i className={task?.status === "running" ? "running" : ""} />{task?.status === "running" ? "推演中" : "就绪"}</div>
    </header>
    {error === undefined ? null : <div className="error-banner">{error}</div>}
    {postCommitNotice === undefined ? null : <div className="post-commit-notice" role="status">
      <span>{postCommitNotice}</span>
      <div>
        {pendingGraphLoad === undefined ? null : <button onClick={() => { void continueGraphLoad(); }}>{pendingGraphLoad.reason === "continue" ? "继续加载世界图" : "重试世界图"}</button>}
        <button onClick={() => { setPostCommitNotice(undefined); setPendingGraphLoad(undefined); }}>只看正文</button>
      </div>
    </div>}
    <PanelGroup className="workbench-panels" direction="horizontal">
      <Panel defaultSize={19} minSize={14} maxSize={28} collapsible>
        <WorkspaceTree entries={report.inventory} selectedPath={selectedPath} onSelect={(path) => void openFile(path)} onRefresh={() => void refreshWorkspace()} />
      </Panel>
      <PanelResizeHandle className="resize-handle"><PanelLeftClose size={12} /></PanelResizeHandle>
      <Panel minSize={42}>
        <EditorArea
          selectedPath={selectedPath}
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
          onContentChange={setContent}
          onHome={openWorkspaceHome}
          onPromptChange={setPrompt}
          onDescriptionRuleChange={setDescriptionRule}
          onProseRuleChange={setProseRule}
          onMinimumWordCountChange={setMinimumWordCount}
          onMaximumWordCountChange={setMaximumWordCount}
          onSave={() => void saveFile()}
          onRun={() => void startTurn()}
        />
      </Panel>
      <PanelResizeHandle className="resize-handle"><PanelRightClose size={12} /></PanelResizeHandle>
      <Panel defaultSize={25} minSize={20} maxSize={38} collapsible>
        <RightRail task={task} graphSlice={graphSlice} graphSettings={projectSettings?.graph} />
      </Panel>
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
      onClose={() => { setProjectSettingsOpen(false); }}
      onSave={saveProjectSettings}
      onOpenModelSettings={() => { setProjectSettingsOpen(false); setModelDialogOpen(true); }}
    /> : null}
  </main>
}

function chapterCount(report: WorkspaceReport): number {
  return report.inventory.filter((entry) => entry.kind === "file" && entry.path.startsWith("章节正文/")).length
}

function parseWordCount(value: string): number | undefined {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) return undefined
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
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
