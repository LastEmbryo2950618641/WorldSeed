import { useCallback, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { Plus } from "lucide-react"

import { invokeBackend, type OpenProject } from "../../api/client.js"
import projectDefaultIcon from "../../assets/project-default-icon.png"
import { folderLabelFromPath, isUnderWorkDirectories } from "./book-path.js"
import { type ProjectRailItem } from "./ProjectRail.js"
import { useWorkDirectory } from "./use-work-directory.js"
import { WorkNamePromptDialog } from "./WorkNamePromptDialog.js"
import { WorkDirectoryPromptDialog } from "./WorkDirectoryPromptDialog.js"
import { rememberWorkName } from "./work-name-history.js"

type Props = Readonly<{ onOpen(project: OpenProject): void }>

function formatOpenedAgo(lastOpenedAtMs: number, nowMs: number): string {
  const deltaMs = Math.max(0, nowMs - lastOpenedAtMs)
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 1) return "刚刚打开"
  if (minutes < 60) return `${String(minutes)} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${String(days)} 天前`
  return new Date(lastOpenedAtMs).toLocaleDateString()
}

export function ProjectLauncher({ onOpen }: Props): React.JSX.Element {
  const workDirectoryState = useWorkDirectory()
  const [projects, setProjects] = useState<readonly ProjectRailItem[]>([])
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<"new" | string>()
  const [pendingCreatePath, setPendingCreatePath] = useState<string>()
  const [nowMs, setNowMs] = useState(() => Date.now())

  const refreshProjects = useCallback(async (): Promise<void> => {
    setLoadingProjects(true)
    try {
      const result = await invokeBackend<{ projects: readonly ProjectRailItem[] }>("project.list", {})
      const filtered = result.projects
        .filter((project) => isUnderWorkDirectories(project.workspaceRootRef, workDirectoryState.workDirectories))
        .sort((left, right) => right.lastOpenedAtMs - left.lastOpenedAtMs)
      setProjects(filtered)
      setNowMs(Date.now())
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoadingProjects(false)
    }
  }, [workDirectoryState.workDirectories])

  useEffect(() => {
    if (workDirectoryState.workDirectory === undefined) return
    void refreshProjects()
  }, [refreshProjects, workDirectoryState.workDirectory])

  const finishCreate = async (workspaceRootRef: string, displayName: string): Promise<void> => {
    setBusy("new")
    setError(undefined)
    try {
      const project = await invokeBackend<OpenProject>("project.create", {
        projectId: crypto.randomUUID(),
        displayName,
        workspaceRootRef,
      })
      rememberWorkName(project.projectId, project.displayName)
      await refreshProjects()
      onOpen(project)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
      setPendingCreatePath(undefined)
    }
  }

  const createBook = async (): Promise<void> => {
    if (workDirectoryState.workDirectory === undefined) {
      setError("请先配置软件工作目录")
      return
    }
    setBusy("new")
    setError(undefined)
    try {
      const workspaceRootRef = await workDirectoryState.allocateBookWorkspacePath()
      setPendingCreatePath(workspaceRootRef)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const openBookCard = async (item: ProjectRailItem): Promise<void> => {
    setBusy(item.projectId)
    setError(undefined)
    try {
      const project = await invokeBackend<OpenProject>("project.open", {
        workspaceRootRef: item.workspaceRootRef,
      })
      rememberWorkName(project.projectId, project.displayName)
      onOpen(project)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  if (workDirectoryState.loading || (workDirectoryState.workDirectory === undefined && workDirectoryState.defaultWorkDirectory.length === 0)) {
    return <main className="launcher"><p className="launcher-loading">正在加载工作目录…</p></main>
  }

  if (workDirectoryState.workDirectory === undefined) {
    return <>
      <WorkDirectoryPromptDialog
        defaultDirectory={workDirectoryState.defaultWorkDirectory}
        busy={workDirectoryState.saving}
        onConfirmDefault={() => {
          void workDirectoryState.confirmWorkDirectory(workDirectoryState.defaultWorkDirectory).catch((cause) => {
            setError(cause instanceof Error ? cause.message : String(cause))
          })
        }}
        onChooseDirectory={() => { void workDirectoryState.chooseWorkDirectory() }}
      />
      {error === undefined && workDirectoryState.error === undefined
        ? null
        : <p className="form-error launcher-error" role="alert">{error ?? workDirectoryState.error}</p>}
    </>
  }

  const interactionLocked = busy !== undefined || pendingCreatePath !== undefined

  return (
    <main className="launcher launcher--library">
      <header className="launcher-library-header">
        <h1>我的书籍</h1>
        <p>选择一本书继续创作，或添加新书</p>
      </header>

      {loadingProjects
        ? <p className="launcher-loading">正在加载书籍…</p>
        : null}
      <div className="launcher-book-grid" data-testid="launcher-book-grid">
        {projects.map((item) => (
          <button
            key={item.projectId}
            type="button"
            className="launcher-book-card"
            data-testid="launcher-book-card"
            disabled={interactionLocked}
            onClick={() => { void openBookCard(item) }}
          >
            <span className="launcher-book-cover" aria-hidden>
              <img src={item.iconUrl ?? projectDefaultIcon} alt="" draggable={false} />
            </span>
            <strong className="launcher-book-title">{item.displayName}</strong>
            <span className="launcher-book-meta">{formatOpenedAgo(item.lastOpenedAtMs, nowMs)}</span>
          </button>
        ))}
        <button
          type="button"
          className="launcher-book-card launcher-book-card--add"
          data-testid="launcher-create-project"
          disabled={interactionLocked}
          onClick={() => { void createBook() }}
        >
          <span className="launcher-book-cover launcher-book-cover--add" aria-hidden>
            <span className="launcher-book-add-icon">
              <Plus size={22} strokeWidth={2.25} />
            </span>
          </span>
          <strong className="launcher-book-title">{busy === "new" ? "正在创建…" : "添加书籍"}</strong>
        </button>
      </div>

      {error === undefined ? null : <div className="form-error launcher-error" role="alert">
        <span>{error}</span>
        <button
          type="button"
          className="launcher-error-dismiss"
          aria-label="关闭提示"
          title="关闭"
          onClick={() => { setError(undefined) }}
        >
          ×
        </button>
      </div>}
      {pendingCreatePath === undefined ? null : createPortal(
        <WorkNamePromptDialog
          folderLabel={folderLabelFromPath(pendingCreatePath)}
          onCancel={() => { setPendingCreatePath(undefined) }}
          onConfirm={(displayName) => { void finishCreate(pendingCreatePath, displayName) }}
        />,
        document.body,
      )}
    </main>
  )
}
