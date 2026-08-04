import { useMemo, useState } from "react"
import { ChevronDown, ChevronRight, FilePlus2, FileText, Folder, FolderOpen, FolderUp, LockKeyhole, RefreshCw } from "lucide-react"

import type { InventoryEntry } from "../../api/client.js"

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
    <div className="panel-title"><span>工作目录</span><div><button title="刷新" onClick={() => { onRefresh(); }}><RefreshCw size={15} /></button></div></div>
    <div className="tree-toolbar">
      <button title="新建 Markdown"><FilePlus2 size={15} /></button>
      <button title="上传 Markdown 文件或文件夹"><FolderUp size={15} /></button>
    </div>
    <div className="tree-scroll">{tree.map((node) => <TreeRow key={node.path} node={node} selectedPath={selectedPath} onSelect={onSelect} depth={0} />)}</div>
  </aside>
}

function TreeRow({ node, selectedPath, onSelect, depth }: { node: TreeNode; selectedPath: string | undefined; onSelect: (path: string) => void; depth: number }): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const locked = node.path.startsWith("世界推演规则/基础规则") || node.path === "章节正文"
  if (node.kind === "file") {
    return <button className={`tree-row ${selectedPath === node.path ? "selected" : ""}`} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => { onSelect(node.path); }}>
      <FileText size={14} /><span>{node.name}</span>{locked ? <LockKeyhole className="row-lock" size={12} /> : null}
    </button>
  }
  return <div>
    <button className="tree-row directory" style={{ paddingLeft: 6 + depth * 14 }} onClick={() => { setExpanded((value) => !value); }}>
      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{expanded ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{node.name}</span>{depth === 0 || locked ? <LockKeyhole className="row-lock" size={12} /> : null}
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
