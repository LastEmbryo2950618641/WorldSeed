import { useCallback, useEffect, useMemo, useState } from "react"
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels"
import { Cloud, FolderOpen, Menu, PanelLeftClose, PanelRightClose, Save, Sprout } from "lucide-react"

import {
  browserDemoProject,
  invokeBackend,
  type GraphSlice,
  type OpenProject,
  type TaskSnapshot,
  type WorkspaceReport,
} from "../api/client.js"
import { ProjectLauncher } from "../features/projects/ProjectLauncher.js"
import { WorkspaceTree } from "../features/workspace/WorkspaceTree.js"
import { EditorArea } from "../features/editor/EditorArea.js"
import { RightRail } from "../features/status/RightRail.js"

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
    setError(undefined)
    try {
      const presentation = [descriptionRule, proseRule].filter(Boolean)
      const userInput = [
        prompt,
        `本轮正文长度约束：正文主体控制在 ${String(parsedMinimumWordCount)}-${String(parsedMaximumWordCount)} 字之间，标题不计入字数。`,
        ...(presentation.length === 0 ? [] : [`本轮表现规则引用：\n${presentation.map((path) => `- ${path}`).join("\n")}`]),
      ].join("\n\n")
      const started = await invokeBackend<{ taskId: string }>("turn.start", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        userInput,
        chapterSequence: chapterCount(report) + 1,
      })
      setTask({ status: "running" })
      for (;;) {
        const snapshot = await invokeBackend<TaskSnapshot>("turn.status", { taskId: started.taskId })
        setTask(snapshot)
        if (snapshot.status === "completed") {
          setPrompt("")
          await refreshWorkspace()
          if (snapshot.result?.graphAnchorIds.length !== 0 && snapshot.result !== undefined) {
            const slice = await invokeBackend<GraphSlice>("graph.neighborhood", {
              projectId: project.projectId,
              workspaceRootRef: project.workspaceRootRef,
              anchorIds: snapshot.result.graphAnchorIds,
              direction: "both",
              maxDepth: 2,
              maxNodes: 48,
              maxLinks: 96,
            })
            setGraphSlice(slice)
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
      <div className="project-indicator"><span>{project.displayName}</span><i className={task?.status === "running" ? "running" : ""} />{task?.status === "running" ? "推演中" : "就绪"}</div>
    </header>
    {error === undefined ? null : <div className="error-banner">{error}</div>}
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
        <RightRail task={task} graphSlice={graphSlice} />
      </Panel>
    </PanelGroup>
    <footer className="statusbar">
      <span>UTF-8</span><span>LF</span><span>Markdown</span><span className={dirty ? "unsaved" : "saved"}>{dirty ? <Cloud size={13} /> : <Save size={13} />}{dirty ? "未保存" : "已保存"}</span>
      <span className="status-path"><FolderOpen size={13} />{selectedPath === undefined ? project.workspaceRootRef : `${project.workspaceRootRef}\\${selectedPath.replaceAll("/", "\\")}`}</span>
      <span>继承环境：本轮 RuleSnapshot</span><span>归档：空闲</span>
    </footer>
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
