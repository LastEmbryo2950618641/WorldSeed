import { useEffect, useRef, useState } from "react"
import { ChevronDown, History, PencilLine, RefreshCw } from "lucide-react"

import type { DesktopModelProfile, OpenProject } from "../../api/client.js"
import { invokeBackend } from "../../api/client.js"
import { rememberWorkName, readWorkNameHistory } from "./work-name-history.js"

type Props = Readonly<{
  project: OpenProject
  statusLabel: string
  running: boolean
  model?: DesktopModelProfile
  onRenamed(displayName: string): void
}>

export function WorkNameControl({ project, statusLabel, running, model, onRenamed }: Props): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(project.displayName)
  const [history, setHistory] = useState<readonly string[]>(() => readWorkNameHistory(project.projectId))
  const [busy, setBusy] = useState<"refresh" | "save">()
  const [error, setError] = useState<string>()

  useEffect(() => {
    setDraft(project.displayName)
    setHistory(readWorkNameHistory(project.projectId))
    setEditing(false)
    setError(undefined)
  }, [project.displayName, project.projectId])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
        setEditing(false)
      }
    }
    document.addEventListener("mousedown", onPointerDown)
    return () => { document.removeEventListener("mousedown", onPointerDown) }
  }, [open])

  const applyName = async (displayName: string): Promise<void> => {
    const trimmed = displayName.trim()
    if (trimmed.length === 0 || trimmed === project.displayName) {
      setEditing(false)
      return
    }
    setBusy("save")
    setError(undefined)
    try {
      const renamed = await invokeBackend<OpenProject>("project.rename", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        displayName: trimmed,
      })
      setHistory(rememberWorkName(project.projectId, renamed.displayName))
      onRenamed(renamed.displayName)
      setEditing(false)
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const refreshGenerate = async (): Promise<void> => {
    if (model === undefined) {
      setError("模型配置尚未加载完成，请稍候再刷新生成")
      return
    }
    setBusy("refresh")
    setError(undefined)
    try {
      const suggested = await invokeBackend<{ displayName: string; alternatives?: readonly string[] }>("project.suggestDisplayName", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        historyNames: readWorkNameHistory(project.projectId),
        model: {
          baseUrl: model.baseUrl,
          model: model.model,
          credentialRef: model.credentialRef,
          apiProtocol: model.apiProtocol,
          contextWindowTokens: model.contextWindowTokens,
          thinkingModeEnabled: false,
          reasoningEffort: model.reasoningEffort,
          jsonModeEnabled: model.jsonModeEnabled,
          disableResponseStorage: model.disableResponseStorage,
          serviceTier: model.serviceTier,
        },
      })
      setDraft(suggested.displayName)
      setBusy(undefined)
      await applyName(suggested.displayName)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(undefined)
    }
  }

  return <div className={`work-name-control${open ? " open" : ""}`} ref={rootRef} data-testid="work-name-control">
    <button
      type="button"
      className="work-name-trigger"
      aria-expanded={open}
      aria-haspopup="menu"
      onClick={() => { setOpen((current) => !current); setEditing(false); setError(undefined) }}
    >
      <span className="work-name-trigger-label">{project.displayName}</span>
      <i className={running ? "running" : ""} />
      <em>{statusLabel}</em>
      <ChevronDown size={13} />
    </button>
    {open ? <div className="work-name-menu" role="menu">
      <div className="work-name-menu-actions">
        <button type="button" disabled={busy !== undefined} data-testid="work-name-refresh" onClick={() => { void refreshGenerate() }}>
          <RefreshCw size={13} className={busy === "refresh" ? "work-name-spin" : undefined} />
          刷新生成
        </button>
        <button type="button" disabled={busy !== undefined} data-testid="work-name-edit" onClick={() => {
          setEditing(true)
          setDraft(project.displayName)
        }}>
          <PencilLine size={13} />
          输入
        </button>
      </div>
      {editing ? <form className="work-name-edit-row" onSubmit={(event) => {
        event.preventDefault()
        void applyName(draft)
      }}>
        <input
          value={draft}
          maxLength={200}
          autoFocus
          disabled={busy !== undefined}
          data-testid="work-name-input"
          onChange={(event) => { setDraft(event.target.value) }}
        />
        <button type="submit" disabled={busy !== undefined || draft.trim().length === 0}>保存</button>
      </form> : null}
      {history.length === 0 ? <p className="work-name-empty"><History size={12} />暂无历史作品名</p> : <ul className="work-name-history">
        {history.map((entry) => <li key={entry}>
          <button
            type="button"
            disabled={busy !== undefined || entry === project.displayName}
            onClick={() => { void applyName(entry) }}
          >
            {entry}
          </button>
        </li>)}
      </ul>}
      {error === undefined ? null : <p className="work-name-error" role="alert">{error}</p>}
    </div> : null}
  </div>
}
