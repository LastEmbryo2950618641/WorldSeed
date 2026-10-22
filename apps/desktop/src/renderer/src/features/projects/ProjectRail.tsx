import { useCallback, useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { Library } from "lucide-react"

import {
  invokeBackend,
  type OpenProject,
} from "../../api/client.js"
import { UiTooltip, uiTooltipRich } from "../../components/UiTooltip.js"
import appBrandIcon from "../../assets/app-brand-icon.png"
import projectDefaultIcon from "../../assets/project-default-icon.png"
import { isUnderWorkDirectories } from "./book-path.js"
import { BrowseAllBooksDialog } from "./BrowseAllBooksDialog.js"
import { useWorkDirectory } from "./use-work-directory.js"

export type ProjectRailItem = Readonly<{
  projectId: string
  displayName: string
  workspaceRootRef: string
  lastOpenedAtMs: number
  iconUrl?: string
}>

type Props = Readonly<{
  activeProjectId?: string | undefined
  updateAvailable?: boolean
  onOpen(project: OpenProject): void
  /** Leave current book and return to the all-books launcher. */
  onBrowseAllBooks?(): void
  onUpdateClick?: () => void
}>

const RECENT_PROJECT_LIMIT = 5

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

function projectIconSrc(item: ProjectRailItem): string {
  return item.iconUrl ?? projectDefaultIcon
}

export function ProjectRail(props: Props): React.JSX.Element {
  const { activeProjectId, onOpen, onBrowseAllBooks, updateAvailable = false, onUpdateClick } = props
  const workDirectoryState = useWorkDirectory()
  const [projects, setProjects] = useState<readonly ProjectRailItem[]>([])
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [confirmBrowseAll, setConfirmBrowseAll] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await invokeBackend<{ projects: readonly ProjectRailItem[] }>("project.list", {})
      const sorted = [...result.projects]
        .filter((project) => isUnderWorkDirectories(project.workspaceRootRef, workDirectoryState.workDirectories))
        .sort((left, right) => right.lastOpenedAtMs - left.lastOpenedAtMs)
        .slice(0, RECENT_PROJECT_LIMIT)
      setProjects(sorted)
      setNowMs(Date.now())
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [workDirectoryState.workDirectories])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const switchTo = async (item: ProjectRailItem): Promise<void> => {
    if (item.projectId === activeProjectId) return
    setBusy(item.projectId)
    setError(undefined)
    try {
      const project = await invokeBackend<OpenProject>("project.open", {
        workspaceRootRef: item.workspaceRootRef,
      })
      onOpen(project)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const emptyHint = useMemo(() => projects.length === 0, [projects.length])
  const canBrowseAll = activeProjectId !== undefined && onBrowseAllBooks !== undefined

  return (
    <aside className="project-rail" aria-label="最近书籍" data-testid="project-rail">
      <div className="project-rail-header">
        <div className="project-rail-brand" title="Worldseed">
          <img className="project-rail-brand-mark" src={appBrandIcon} alt="" draggable={false} />
          {updateAvailable
            ? <button
                type="button"
                className="project-rail-update"
                data-testid="project-rail-update"
                aria-label="有可用更新"
                onClick={() => { onUpdateClick?.() }}
              >
                更新
              </button>
            : null}
        </div>
        <div className="project-rail-separator" aria-hidden="true" />
      </div>

      <div className="project-rail-scroll">
        {emptyHint
          ? <p className="project-rail-empty">暂无最近书籍</p>
          : projects.map((item) => {
              const active = item.projectId === activeProjectId
              const openedAgo = formatOpenedAgo(item.lastOpenedAtMs, nowMs)
              return (
                <UiTooltip key={item.projectId} label={uiTooltipRich(item.displayName, openedAgo)} rich>
                  <button
                    type="button"
                    className={`project-rail-item${active ? " active" : ""}`}
                    aria-label={`${item.displayName}，${openedAgo}`}
                    aria-current={active ? "page" : undefined}
                    disabled={busy !== undefined || confirmBrowseAll}
                    onClick={() => { void switchTo(item); }}
                  >
                    <span className="project-rail-pill" aria-hidden="true" />
                    <span className="project-rail-icon project-rail-icon--image">
                      <img src={projectIconSrc(item)} alt="" draggable={false} />
                    </span>
                  </button>
                </UiTooltip>
              )
            })}
      </div>

      <div className="project-rail-footer">
        <div className="project-rail-separator" aria-hidden="true" />
        <UiTooltip label={canBrowseAll ? "浏览所有书籍" : "已在书籍浏览界面"}>
          <button
            type="button"
            className="project-rail-item project-rail-action"
            aria-label="浏览所有书籍"
            data-testid="project-rail-browse-all"
            disabled={busy !== undefined || !canBrowseAll || confirmBrowseAll}
            onClick={() => { setConfirmBrowseAll(true) }}
          >
            <span className="project-rail-icon project-rail-icon--action">
              <Library size={17} strokeWidth={2.25} />
            </span>
          </button>
        </UiTooltip>
      </div>

      {error === undefined ? null : <div className="project-rail-error" role="alert">{error}</div>}
      {confirmBrowseAll
        ? createPortal(
            <BrowseAllBooksDialog
              onCancel={() => { setConfirmBrowseAll(false) }}
              onConfirm={() => {
                setConfirmBrowseAll(false)
                onBrowseAllBooks?.()
              }}
            />,
            document.body,
          )
        : null}
    </aside>
  )
}
