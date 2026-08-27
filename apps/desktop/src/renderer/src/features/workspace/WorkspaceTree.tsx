import { useMemo, useState } from "react"
import { FilePlus2, Folder, FolderOpen, FolderUp, LockKeyhole, RefreshCw } from "lucide-react"

import type { InventoryEntry } from "../../api/client.js"
import { UiTooltip } from "../../components/UiTooltip.js"

type Props = Readonly<{
  entries: readonly InventoryEntry[]
  selectedPath: string | undefined
  onSelect: (path: string) => void
  onRefresh: () => void
}>

type TreeNode = { name: string; path: string; kind: "directory" | "file"; children: TreeNode[] }

export function WorkspaceTree({ entries, selectedPath, onSelect, onRefresh }: Props): React.JSX.Element {
  const tree = useMemo(() => buildTree(entries), [entries])
  return <aside className="workspace-tree">
    <div className="workspace-tree-header">
      <span className="workspace-tree-title">工作目录</span>
      <div className="workspace-tree-actions">
        <UiTooltip label="新建 Markdown"><button type="button" aria-label="新建 Markdown"><FilePlus2 size={14} /></button></UiTooltip>
        <UiTooltip label="上传 Markdown 文件或文件夹"><button type="button" aria-label="上传 Markdown 文件或文件夹"><FolderUp size={14} /></button></UiTooltip>
        <UiTooltip label="刷新"><button type="button" aria-label="刷新" onClick={() => { onRefresh(); }}><RefreshCw size={14} /></button></UiTooltip>
      </div>
    </div>
    <div className="tree-scroll">{tree.map((node) => <TreeRow key={node.path} node={node} selectedPath={selectedPath} onSelect={onSelect} depth={0} />)}</div>
  </aside>
}

function TreeRow({ node, selectedPath, onSelect, depth }: { node: TreeNode; selectedPath: string | undefined; onSelect: (path: string) => void; depth: number }): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const locked = node.path.startsWith("世界推演规则/基础规则") || node.path === "章节正文"
  const selected = node.kind === "file" && selectedPath === node.path
  const rowLabel = locked ? `${node.name}（只读）` : node.name

  if (node.kind === "file") {
    return <button
      type="button"
      className={`tree-row tree-row-file ${selected ? "selected" : ""}`}
      style={{ paddingLeft: 8 + depth * 10 }}
      aria-label={rowLabel}
      onClick={() => { onSelect(node.path); }}
    >
      <span className="tree-row-icon tree-row-file-dot" aria-hidden="true" />
      <span className="tree-row-label">{node.name}</span>
      {locked
        ? <UiTooltip label="只读">
            <span className="tree-row-lock"><LockKeyhole size={11} aria-hidden="true" /></span>
          </UiTooltip>
        : null}
    </button>
  }

  return <div className="tree-node">
    <button
      type="button"
      className="tree-row tree-row-directory"
      style={{ paddingLeft: 8 + depth * 10 }}
      aria-expanded={expanded}
      aria-label={rowLabel}
      onClick={() => { setExpanded((value) => !value); }}
    >
      <span className="tree-row-icon tree-row-folder-icon" aria-hidden="true">
        {expanded
          ? <FolderOpen size={14} strokeWidth={1.5} />
          : <Folder size={14} strokeWidth={1.5} />}
      </span>
      <span className="tree-row-label">{node.name}</span>
      {depth === 0 || locked
        ? <UiTooltip label="只读">
            <span className="tree-row-lock"><LockKeyhole size={11} aria-hidden="true" /></span>
          </UiTooltip>
        : null}
    </button>
    {expanded ? node.children.map((child) => <TreeRow key={child.path} node={child} selectedPath={selectedPath} onSelect={onSelect} depth={depth + 1} />) : null}
  </div>
}

function buildTree(entries: readonly InventoryEntry[]): TreeNode[] {
  const rootOrder = new Map(
    ["世界推演规则", "设定集", "参考文件", "表现输出", "章节正文"]
      .map((path, index): readonly [string, number] => [path, index]),
  )
  const roots: TreeNode[] = []
  const nodes = new Map<string, TreeNode>()
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path, "zh-CN"))) {
    const parts = entry.path.split("/")
    const node: TreeNode = { name: parts.at(-1) ?? entry.path, path: entry.path, kind: entry.kind, children: [] }
    nodes.set(entry.path, node)
    const parentPath = parts.slice(0, -1).join("/")
    const parent = nodes.get(parentPath)
    if (parent === undefined) roots.push(node)
    else parent.children.push(node)
  }
  return roots.sort((left, right) => (rootOrder.get(left.path) ?? 99) - (rootOrder.get(right.path) ?? 99))
}
