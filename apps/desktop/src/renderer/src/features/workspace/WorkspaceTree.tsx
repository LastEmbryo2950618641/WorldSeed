import { useEffect, useMemo, useState } from "react"
import { FilePlus2, Folder, FolderOpen, FolderPlus, History, LockKeyhole, RefreshCw, Trash2 } from "lucide-react"

import type { InventoryEntry } from "../../api/client.js"
import { UiTooltip } from "../../components/UiTooltip.js"
import {
  canCreateFolderInDirectory,
  canCreateMarkdownInDirectory,
  canDeleteWorkspacePath,
  isChapterVolumeContainerPath,
  lockTooltip,
  resolveWorkspaceLockKind,
  type WorkspaceLockKind,
} from "./workspace-locks.js"
import { isChapterBodyMarkdownPath } from "../editor/synopsis-path.js"

export const SETTINGS_LINEAGE_VIRTUAL_PATH = "__virtual__/设定沿革"

type Props = Readonly<{
  entries: readonly InventoryEntry[]
  selectedPath: string | undefined
  lineageActive?: boolean
  onSelect: (path: string) => void
  onSelectLineage: () => void
  onRefresh: () => void
  onCreateMarkdown?: (destination?: string) => void
  onCreateDirectory?: (parentPath?: string) => void
  onDeletePath?: (path: string) => void
}>

type TreeNode = {
  name: string
  path: string
  kind: "directory" | "file" | "virtual"
  children: TreeNode[]
}

function ancestorDirectoryPaths(path: string | undefined): ReadonlySet<string> {
  if (path === undefined || path.trim().length === 0) return new Set()
  const parts = path.replaceAll("\\", "/").split("/").filter((part) => part.length > 0)
  const result = new Set<string>()
  for (let index = 1; index < parts.length; index += 1) {
    result.add(parts.slice(0, index).join("/"))
  }
  return result
}

export function WorkspaceTree({
  entries,
  selectedPath,
  lineageActive = false,
  onSelect,
  onSelectLineage,
  onRefresh,
  onCreateMarkdown,
  onCreateDirectory,
  onDeletePath,
}: Props): React.JSX.Element {
  const tree = useMemo(() => buildTree(entries), [entries])
  const expandedBySelection = useMemo(() => ancestorDirectoryPaths(selectedPath), [selectedPath])

  return <aside className="workspace-tree">
    <div className="workspace-tree-header">
      <span className="workspace-tree-title">工作目录</span>
      <div className="workspace-tree-actions">
        <UiTooltip label="新建 Markdown（相对当前选中位置）">
          <button
            type="button"
            aria-label="新建 Markdown"
            disabled={onCreateMarkdown === undefined}
            onClick={() => { onCreateMarkdown?.() }}
          >
            <FilePlus2 size={15} />
          </button>
        </UiTooltip>
        <UiTooltip label="新建文件夹（相对当前选中位置）">
          <button
            type="button"
            aria-label="新建文件夹"
            disabled={onCreateDirectory === undefined}
            onClick={() => { onCreateDirectory?.() }}
          >
            <FolderPlus size={15} />
          </button>
        </UiTooltip>
        <UiTooltip label="刷新"><button type="button" aria-label="刷新" onClick={() => { onRefresh(); }}><RefreshCw size={15} /></button></UiTooltip>
      </div>
    </div>
    <div className="tree-scroll">{tree.map((node) => <TreeRow
      key={node.path}
      node={node}
      selectedPath={selectedPath}
      lineageActive={lineageActive}
      expandedBySelection={expandedBySelection}
      onSelect={onSelect}
      onSelectLineage={onSelectLineage}
      onCreateMarkdown={onCreateMarkdown}
      onCreateDirectory={onCreateDirectory}
      onDeletePath={onDeletePath}
      depth={0}
    />)}</div>
  </aside>
}

function TreeRow({
  node,
  selectedPath,
  lineageActive,
  expandedBySelection,
  onSelect,
  onSelectLineage,
  onCreateMarkdown,
  onCreateDirectory,
  onDeletePath,
  depth,
}: {
  node: TreeNode
  selectedPath: string | undefined
  lineageActive: boolean
  expandedBySelection: ReadonlySet<string>
  onSelect: (path: string) => void
  onSelectLineage: () => void
  onCreateMarkdown?: (destination?: string) => void
  onCreateDirectory?: (parentPath?: string) => void
  onDeletePath?: (path: string) => void
  depth: number
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(() => expandedBySelection.has(node.path))
  const lockKind = resolveWorkspaceLockKind(node.path)
  const selected = node.kind === "file" && !lineageActive && selectedPath === node.path
  const virtualSelected = node.kind === "virtual" && lineageActive
  const hasChapterBodies = node.kind === "directory"
    && node.children.some((child) => child.kind === "file" && isChapterBodyMarkdownPath(child.path))
  const deletable = (
    (node.kind === "file" && canDeleteWorkspacePath(node.path))
    || (node.kind === "directory"
      && isChapterVolumeContainerPath(node.path)
      && canDeleteWorkspacePath(node.path, { hasChapterBodies }))
  ) && onDeletePath !== undefined
  const canCreateFile = node.kind === "directory"
    && canCreateMarkdownInDirectory(node.path)
    && onCreateMarkdown !== undefined
  const canCreateFolder = node.kind === "directory"
    && canCreateFolderInDirectory(node.path)
    && onCreateDirectory !== undefined

  useEffect(() => {
    if (expandedBySelection.has(node.path)) setExpanded(true)
  }, [expandedBySelection, node.path])

  if (node.kind === "virtual") {
    return <button
      type="button"
      className={`tree-row tree-row-virtual ${virtualSelected ? "selected" : ""}`}
      style={{ paddingLeft: 8 + depth * 10 }}
      aria-label={node.name}
      onClick={() => { onSelectLineage(); }}
    >
      <span className="tree-row-icon tree-row-virtual-icon" aria-hidden="true">
        <History size={14} strokeWidth={1.5} />
      </span>
      <span className="tree-row-label">{node.name}</span>
      <span className="tree-row-virtual-badge">变动</span>
    </button>
  }

  if (node.kind === "file") {
    return <div
      className={`tree-row tree-row-file ${selected ? "selected" : ""}`}
      style={{ paddingLeft: 8 + depth * 10 }}
      data-tree-path={node.path}
    >
      <button
        type="button"
        className="tree-row-main"
        aria-label={lockKind === undefined ? node.name : `${node.name}（${lockTooltip(lockKind)}）`}
        onClick={() => { onSelect(node.path); }}
      >
        <span className="tree-row-icon tree-row-file-dot" aria-hidden="true" />
        <span className="tree-row-label">{node.name}</span>
      </button>
      {lockKind === undefined
        ? null
        : <LockBadge kind={lockKind} />}
      {deletable
        ? <UiTooltip label="删除">
            <button
              type="button"
              className="tree-row-action"
              aria-label={`删除 ${node.name}`}
              onClick={(event) => {
                event.stopPropagation()
                onDeletePath?.(node.path)
              }}
            >
              <Trash2 size={13} aria-hidden="true" />
            </button>
          </UiTooltip>
        : null}
    </div>
  }

  return <div className="tree-node">
    <div className="tree-row tree-row-directory" style={{ paddingLeft: 8 + depth * 10 }}>
      <button
        type="button"
        className="tree-row-main"
        aria-expanded={expanded}
        aria-label={lockKind === "platform_readonly" || lockKind === "chapter_workflow"
          ? `${node.name}（${lockTooltip(lockKind)}）`
          : node.name}
        onClick={() => { setExpanded((value) => !value); }}
      >
        <span className="tree-row-icon tree-row-folder-icon" aria-hidden="true">
          {expanded
            ? <FolderOpen size={14} strokeWidth={1.5} />
            : <Folder size={14} strokeWidth={1.5} />}
        </span>
        <span className="tree-row-label">{node.name}</span>
      </button>
      {lockKind === "platform_readonly" || lockKind === "chapter_workflow"
        ? <LockBadge kind={lockKind} />
        : null}
      {canCreateFile
        ? <UiTooltip label={`在「${node.name}」下新建 Markdown`}>
            <button
              type="button"
              className="tree-row-action"
              aria-label={`在 ${node.name} 下新建 Markdown`}
              onClick={(event) => {
                event.stopPropagation()
                setExpanded(true)
                onCreateMarkdown?.(node.path)
              }}
            >
              <FilePlus2 size={14} aria-hidden="true" />
            </button>
          </UiTooltip>
        : null}
      {canCreateFolder
        ? <UiTooltip label={`在「${node.name}」下新建文件夹`}>
            <button
              type="button"
              className="tree-row-action"
              aria-label={`在 ${node.name} 下新建文件夹`}
              onClick={(event) => {
                event.stopPropagation()
                setExpanded(true)
                onCreateDirectory?.(node.path)
              }}
            >
              <FolderPlus size={14} aria-hidden="true" />
            </button>
          </UiTooltip>
        : null}
      {deletable
        ? <UiTooltip label="删除卷文件夹">
            <button
              type="button"
              className="tree-row-action"
              aria-label={`删除 ${node.name}`}
              onClick={(event) => {
                event.stopPropagation()
                onDeletePath?.(node.path)
              }}
            >
              <Trash2 size={13} aria-hidden="true" />
            </button>
          </UiTooltip>
        : null}
    </div>
    {expanded ? node.children.map((child) => <TreeRow
      key={child.path}
      node={child}
      selectedPath={selectedPath}
      lineageActive={lineageActive}
      expandedBySelection={expandedBySelection}
      onSelect={onSelect}
      onSelectLineage={onSelectLineage}
      onCreateMarkdown={onCreateMarkdown}
      onCreateDirectory={onCreateDirectory}
      onDeletePath={onDeletePath}
      depth={depth + 1}
    />) : null}
  </div>
}

function LockBadge({ kind }: { kind: WorkspaceLockKind }): React.JSX.Element {
  return <UiTooltip label={lockTooltip(kind)}>
    <span className="tree-row-lock"><LockKeyhole size={11} aria-hidden="true" /></span>
  </UiTooltip>
}

/** Order-independent tree assembly: ensure parent directories exist before linking children. */
export function buildTree(entries: readonly InventoryEntry[]): TreeNode[] {
  const rootOrder = new Map(
    ["世界推演规则", "设定集", "设定沿革", "暂存区", "参考文件", "表现输出", "章节正文"]
      .map((path, index): readonly [string, number] => [path, index]),
  )
  const nodes = new Map<string, TreeNode>()

  const ensureDirectory = (path: string): TreeNode => {
    const existing = nodes.get(path)
    if (existing !== undefined) return existing
    const parts = path.split("/")
    const node: TreeNode = {
      name: parts.at(-1) ?? path,
      path,
      kind: "directory",
      children: [],
    }
    nodes.set(path, node)
    return node
  }

  for (const entry of entries) {
    const parts = entry.path.split("/").filter((part) => part.length > 0)
    if (parts.length === 0) continue
    for (let index = 1; index < parts.length; index += 1) {
      ensureDirectory(parts.slice(0, index).join("/"))
    }
    const existing = nodes.get(entry.path)
    if (existing === undefined) {
      nodes.set(entry.path, {
        name: parts.at(-1) ?? entry.path,
        path: entry.path,
        kind: entry.kind,
        children: [],
      })
    } else if (entry.kind === "file") {
      existing.kind = "file"
    }
  }

  const roots: TreeNode[] = []
  for (const node of nodes.values()) {
    node.children = []
  }
  for (const node of nodes.values()) {
    const parentPath = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : ""
    if (parentPath.length === 0) {
      roots.push(node)
      continue
    }
    const parent = nodes.get(parentPath)
    if (parent === undefined) roots.push(node)
    else parent.children.push(node)
  }

  for (const node of nodes.values()) {
    node.children.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1
      return left.name.localeCompare(right.name, "zh-CN")
    })
  }

  const settingsIndex = roots.findIndex((node) => node.path === "设定集")
  const lineageNode: TreeNode = {
    name: "设定沿革",
    path: SETTINGS_LINEAGE_VIRTUAL_PATH,
    kind: "virtual",
    children: [],
  }
  if (settingsIndex >= 0) roots.splice(settingsIndex + 1, 0, lineageNode)
  else roots.unshift(lineageNode)
  return roots.sort((left, right) => {
    const leftKey = left.path === SETTINGS_LINEAGE_VIRTUAL_PATH ? "设定沿革" : left.path
    const rightKey = right.path === SETTINGS_LINEAGE_VIRTUAL_PATH ? "设定沿革" : right.path
    return (rootOrder.get(leftKey) ?? 99) - (rootOrder.get(rightKey) ?? 99)
  })
}
