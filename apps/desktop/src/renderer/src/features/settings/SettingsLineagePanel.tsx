import { useEffect, useState } from "react"

import type {
  SettingsLineageCommitResult,
  SettingsLineageEntry,
} from "@worldseed/contracts"

import { invokeBackend } from "../../api/client.js"
import { computeLineDiff } from "../editor/chapter-draft-versions-prototype.js"

const RESTORE_CONFIRM_PHRASE = "恢复为当前"

type Props = Readonly<{
  projectId: string
  workspaceRootRef: string
  initialPath?: string
}>

export function SettingsLineagePanel({
  projectId,
  workspaceRootRef,
  initialPath,
}: Props): React.JSX.Element {
  const [paths, setPaths] = useState<readonly string[]>([])
  const [selectedPath, setSelectedPath] = useState<string | undefined>(initialPath)
  const [entries, setEntries] = useState<readonly SettingsLineageEntry[]>([])
  const [expanded, setExpanded] = useState<SettingsLineageCommitResult | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [restorePhrase, setRestorePhrase] = useState("")
  const [storyTimeDraft, setStoryTimeDraft] = useState("")
  const [savingAnnotate, setSavingAnnotate] = useState(false)

  const refreshEntries = async (path: string): Promise<void> => {
    const result = await invokeBackend("settings.lineage.list", {
      projectId,
      workspaceRootRef,
      relativePath: path,
      limit: 50,
    }) as { entries: readonly SettingsLineageEntry[] }
    setEntries(result.entries)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = await invokeBackend("settings.lineage.paths", {
          projectId,
          workspaceRootRef,
        }) as { paths: readonly string[] }
        if (cancelled) return
        setPaths(result.paths)
        if (selectedPath === undefined && result.paths[0] !== undefined) {
          setSelectedPath(result.paths[0])
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => { cancelled = true }
  }, [projectId, workspaceRootRef])

  useEffect(() => {
    if (selectedPath === undefined) {
      setEntries([])
      setExpanded(undefined)
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        await refreshEntries(selectedPath)
        if (cancelled) return
        setExpanded(undefined)
        setRestoreOpen(false)
        setRestorePhrase("")
        setError(undefined)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [projectId, workspaceRootRef, selectedPath])

  useEffect(() => {
    setStoryTimeDraft(expanded?.entry.storyTime ?? "")
    setRestoreOpen(false)
    setRestorePhrase("")
  }, [expanded?.entry.commitId])

  const openCommit = async (commitId: string): Promise<void> => {
    setLoading(true)
    try {
      const result = await invokeBackend("settings.lineage.getCommit", {
        projectId,
        workspaceRootRef,
        commitId,
      }) as SettingsLineageCommitResult
      setExpanded(result)
      setError(undefined)
      setNotice(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const saveStoryTime = async (): Promise<void> => {
    if (expanded === undefined) return
    setSavingAnnotate(true)
    try {
      const trimmed = storyTimeDraft.trim()
      const result = await invokeBackend("settings.lineage.annotate", {
        projectId,
        workspaceRootRef,
        commitId: expanded.entry.commitId,
        storyTime: trimmed.length === 0 ? null : trimmed,
      }) as { entry: SettingsLineageEntry }
      setExpanded({ ...expanded, entry: result.entry })
      if (selectedPath !== undefined) await refreshEntries(selectedPath)
      setNotice("故事时间备注已保存（可选，不影响写入与召回）")
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingAnnotate(false)
    }
  }

  const confirmRestore = async (): Promise<void> => {
    if (expanded === undefined) return
    setLoading(true)
    try {
      await invokeBackend("settings.lineage.restoreAsCurrent", {
        projectId,
        workspaceRootRef,
        commitId: expanded.entry.commitId,
        confirmPhrase: restorePhrase.trim(),
      })
      setRestoreOpen(false)
      setRestorePhrase("")
      setNotice("已将此版本写回当前设定文件，并记入沿革。")
      if (selectedPath !== undefined) {
        await refreshEntries(selectedPath)
        const latest = (await invokeBackend("settings.lineage.list", {
          projectId,
          workspaceRootRef,
          relativePath: selectedPath,
          limit: 1,
        }) as { entries: readonly SettingsLineageEntry[] }).entries[0]
        if (latest !== undefined) await openCommit(latest.commitId)
      }
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const diffLines = expanded === undefined
    ? []
    : computeLineDiff(expanded.previousMarkdown ?? "", expanded.markdown)
  const canRestore = restorePhrase.trim() === RESTORE_CONFIRM_PHRASE

  return <div className="settings-lineage-panel">
    <header className="settings-lineage-header">
      <div>
        <h2>设定沿革</h2>
        <p>只读查看变动历史；当前真相仍在「设定集」文件中编辑。从沿革覆盖当前属于危险操作，需二次确认。</p>
      </div>
    </header>
    {error !== undefined ? <p className="settings-lineage-error">{error}</p> : null}
    {notice !== undefined ? <p className="settings-lineage-notice">{notice}</p> : null}
    <div className="settings-lineage-layout">
      <aside className="settings-lineage-paths">
        <div className="settings-lineage-section-title">设定文件</div>
        {paths.length === 0
          ? <p className="settings-lineage-empty">尚无沿革记录；采纳提案或保存设定后会出现。</p>
          : paths.map((path) => <button
              key={path}
              type="button"
              className={`settings-lineage-path ${selectedPath === path ? "active" : ""}`}
              onClick={() => { setSelectedPath(path); }}
            >
              {path.replace(/^设定集\//u, "")}
            </button>)}
      </aside>
      <section className="settings-lineage-timeline">
        <div className="settings-lineage-section-title">
          {selectedPath === undefined ? "时间线" : `时间线 · ${selectedPath.replace(/^设定集\//u, "")}`}
          {loading ? " · 加载中" : ""}
        </div>
        {entries.length === 0
          ? <p className="settings-lineage-empty">该文件还没有变动记录。</p>
          : <div className="settings-lineage-entries">
              {entries.map((entry) => {
                const active = expanded?.entry.commitId === entry.commitId
                return <article key={entry.commitId} className={`settings-lineage-entry ${active ? "open" : ""}`}>
                  <button
                    type="button"
                    className="settings-lineage-entry-head"
                    onClick={() => {
                      if (active) {
                        setExpanded(undefined)
                        return
                      }
                      void openCommit(entry.commitId)
                    }}
                  >
                    <strong>{formatEntryTitle(entry)}</strong>
                    <span>
                      {formatSourceLabel(entry.sourceKind)}
                      {entry.storyTime === undefined ? "" : ` · 故事时间 ${entry.storyTime}`}
                      {" · "}
                      {formatTime(entry.createdAtMs)}
                    </span>
                  </button>
                  {active && expanded !== undefined
                    ? <div className="settings-lineage-diff">
                        <div className="settings-lineage-tools">
                          <label className="settings-lineage-annotate">
                            <span>故事时间备注（可选）</span>
                            <input
                              type="text"
                              value={storyTimeDraft}
                              maxLength={200}
                              placeholder="如：盐雾城 · 觉醒后第三日"
                              onChange={(event) => { setStoryTimeDraft(event.target.value); }}
                            />
                            <button
                              type="button"
                              className="settings-lineage-secondary"
                              disabled={savingAnnotate || storyTimeDraft.trim() === (expanded.entry.storyTime ?? "")}
                              onClick={() => { void saveStoryTime(); }}
                            >
                              保存备注
                            </button>
                          </label>
                          {expanded.entry.op === "delete"
                            ? null
                            : <button
                                type="button"
                                className="settings-lineage-danger"
                                onClick={() => { setRestoreOpen((open) => !open); setRestorePhrase(""); }}
                              >
                                {restoreOpen ? "取消恢复" : "恢复为当前真相…"}
                              </button>}
                        </div>
                        {restoreOpen
                          ? <div className="settings-lineage-restore-confirm" role="group" aria-label="恢复确认">
                              <p>
                                这将<strong>覆盖</strong>工作区里的当前设定文件，并用该历史版本内容写回。
                                沿革不会被改写，只会追加一条「从沿革恢复」记录。
                              </p>
                              <label>
                                <span>请输入「{RESTORE_CONFIRM_PHRASE}」以确认</span>
                                <input
                                  type="text"
                                  value={restorePhrase}
                                  autoComplete="off"
                                  placeholder={RESTORE_CONFIRM_PHRASE}
                                  onChange={(event) => { setRestorePhrase(event.target.value); }}
                                />
                              </label>
                              <button
                                type="button"
                                className="settings-lineage-danger solid"
                                disabled={!canRestore || loading}
                                onClick={() => { void confirmRestore(); }}
                              >
                                确认覆盖当前设定
                              </button>
                            </div>
                          : null}
                        {diffLines.length === 0
                          ? <pre className="settings-lineage-full">{expanded.markdown}</pre>
                          : diffLines.map((line, index) => <div
                              key={`${entry.commitId}-${String(index)}`}
                              className={`chapter-draft-diff-line chapter-draft-diff-${line.type}`}
                            >
                              <span className="chapter-draft-diff-gutter">
                                {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
                              </span>
                              <span className="chapter-draft-diff-text">{line.text.length === 0 ? " " : line.text}</span>
                            </div>)}
                      </div>
                    : null}
                </article>
              })}
            </div>}
      </section>
    </div>
  </div>
}

function formatEntryTitle(entry: SettingsLineageEntry): string {
  if (entry.causingChapterSequence !== undefined) {
    return `因第 ${String(entry.causingChapterSequence)} 章${entry.summary === undefined ? "" : ` · ${entry.summary}`}`
  }
  if (entry.summary !== undefined && entry.summary.trim().length > 0) return entry.summary
  return formatSourceLabel(entry.sourceKind)
}

function formatSourceLabel(kind: SettingsLineageEntry["sourceKind"]): string {
  switch (kind) {
    case "extraction_approve": return "设定抽取采纳"
    case "staging_promote": return "暂存落盘"
    case "workspace_save": return "你保存了文件"
    case "migration_seed": return "收录现有设定"
    case "history_restore": return "世界历史恢复"
    default: return kind
  }
}

function formatTime(createdAtMs: number): string {
  return new Date(createdAtMs).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
