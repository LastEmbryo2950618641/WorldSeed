import { useState } from "react"
import { Check, FolderOpen, Plus, Trash2 } from "lucide-react"

import { selectDirectory } from "../../api/client.js"
import { useWorkDirectory } from "../projects/use-work-directory.js"
import { RemoveWorkDirectoryDialog } from "./RemoveWorkDirectoryDialog.js"

export function WorkDirectorySettingsPanel(): React.JSX.Element {
  const workDirectoryState = useWorkDirectory()
  const [pendingRemovePath, setPendingRemovePath] = useState<string>()

  const addDirectory = async (): Promise<void> => {
    const picked = await selectDirectory({
      title: "添加工作目录",
      ...(workDirectoryState.activeWorkDirectory === undefined
        ? {}
        : { defaultPath: workDirectoryState.activeWorkDirectory ?? workDirectoryState.defaultWorkDirectory }),
    })
    if (picked === undefined) return
    await workDirectoryState.addWorkDirectory(picked)
  }

  return <>
    <section className="settings-page">
      <header>
        <span><FolderOpen size={18} /></span>
        <div>
          <h2>工作目录</h2>
          <p>管理书籍存放位置；标记为「默认」的目录用于新建书籍。</p>
        </div>
      </header>
      <div className="settings-fields work-directory-settings">
        {workDirectoryState.loading
          ? <p className="work-directory-settings-status">正在加载…</p>
          : null}
        {!workDirectoryState.loading && workDirectoryState.workDirectories.length === 0
          ? <p className="work-directory-settings-status">尚未配置工作目录，请添加一个目录。</p>
          : null}
        {workDirectoryState.workDirectories.map((directoryPath) => {
          const isActive = directoryPath === workDirectoryState.activeWorkDirectory
          return <div className="work-directory-row" data-testid="work-directory-row" key={directoryPath}>
            <div className="work-directory-row-main">
              <code>{directoryPath}</code>
              {isActive ? <span className="work-directory-active-badge"><Check size={12} />默认</span> : null}
            </div>
            <div className="work-directory-row-actions">
              {!isActive
                ? <button
                  type="button"
                  className="secondary-command"
                  data-testid="work-directory-set-active"
                  disabled={workDirectoryState.saving}
                  onClick={() => { void workDirectoryState.setActiveWorkDirectory(directoryPath) }}
                >
                  设为默认
                </button>
                : null}
              <button
                type="button"
                className="secondary-command work-directory-remove"
                data-testid="work-directory-remove"
                disabled={workDirectoryState.saving}
                aria-label={`移除 ${directoryPath}`}
                onClick={() => { setPendingRemovePath(directoryPath) }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        })}
        <div className="work-directory-toolbar">
          <button
            type="button"
            className="secondary-command"
            data-testid="work-directory-add"
            disabled={workDirectoryState.saving}
            onClick={() => { void addDirectory() }}
          >
            <Plus size={14} />添加目录
          </button>
        </div>
        {workDirectoryState.error === undefined
          ? null
          : <p className="form-error work-directory-settings-error" role="alert">{workDirectoryState.error}</p>}
      </div>
    </section>
    {pendingRemovePath === undefined
      ? null
      : <RemoveWorkDirectoryDialog
        directoryPath={pendingRemovePath}
        busy={workDirectoryState.saving}
        onCancel={() => { setPendingRemovePath(undefined) }}
        onConfirm={(mode) => {
          void workDirectoryState.removeWorkDirectory({ directoryPath: pendingRemovePath, mode })
            .then(() => { setPendingRemovePath(undefined) })
            .catch(() => undefined)
        }}
      />}
  </>
}
