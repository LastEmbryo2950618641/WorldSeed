import { useState } from "react"
import { BookOpen, FolderOpen, Plus, Sprout } from "lucide-react"

import { invokeBackend, selectDirectory, type OpenProject } from "../../api/client.js"

type Props = Readonly<{ onOpen(project: OpenProject): void }>

export function ProjectLauncher({ onOpen }: Props): React.JSX.Element {
  const [mode, setMode] = useState<"new" | "open">("new")
  const [name, setName] = useState("")
  const [workspaceRootRef, setWorkspaceRootRef] = useState("")
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const chooseDirectory = async (): Promise<void> => {
    const selected = await selectDirectory()
    if (selected !== undefined) setWorkspaceRootRef(selected)
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const project = mode === "new"
        ? await invokeBackend<OpenProject>("project.create", {
            projectId: crypto.randomUUID(),
            displayName: name,
            workspaceRootRef,
          })
        : await invokeBackend<OpenProject>("project.open", { workspaceRootRef })
      onOpen(project)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return <main className="launcher">
    <section className="launcher-brand">
      <div className="brand-mark"><Sprout size={28} /></div>
      <h1>Worldseed</h1>
      <p>让每一轮正文都从已读取的世界继续生长。</p>
      <div className="launcher-principles">
        <span><BookOpen size={16} /> Markdown 工作目录</span>
        <span><FolderOpen size={16} /> 持久化动态图</span>
      </div>
    </section>
    <section className="launcher-form">
      <div className="launcher-switch">
        <button className={mode === "new" ? "active" : ""} onClick={() => { setMode("new"); }}><Plus size={16} /> 新建项目</button>
        <button className={mode === "open" ? "active" : ""} onClick={() => { setMode("open"); }}><FolderOpen size={16} /> 打开项目</button>
      </div>
      <h2>{mode === "new" ? "建立一个新世界" : "打开已有世界"}</h2>
      {mode === "new" ? <label>项目名称<input value={name} onChange={(event) => { setName(event.target.value); }} placeholder="例如：雾港纪事" /></label> : null}
      <label>工作目录<div className="path-input"><input value={workspaceRootRef} onChange={(event) => { setWorkspaceRootRef(event.target.value); }} placeholder="选择一个空目录或已有项目目录" /><button title="选择目录" onClick={() => void chooseDirectory()}><FolderOpen size={17} /></button></div></label>
      {error === undefined ? null : <p className="form-error">{error}</p>}
      <button className="primary-command" disabled={busy || workspaceRootRef.length === 0 || (mode === "new" && name.length === 0)} onClick={() => void submit()}>{busy ? "正在打开..." : mode === "new" ? "创建并进入" : "打开项目"}</button>
    </section>
  </main>
}
