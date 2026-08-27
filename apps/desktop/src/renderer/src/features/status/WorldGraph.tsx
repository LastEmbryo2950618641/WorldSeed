import { useEffect, useMemo, useRef, useState } from "react"
import { MultiDirectedGraph } from "graphology"
import Sigma from "sigma"
import { LocateFixed, RefreshCw, Search } from "lucide-react"
import { defaultProjectSettings } from "@worldseed/config"
import type { ProjectSettings } from "@worldseed/contracts"

import type { GraphSlice } from "../../api/client.js"
import { UiTooltip } from "../../components/UiTooltip.js"

type Props = Readonly<{
  slice: GraphSlice | undefined
  settings?: ProjectSettings["graph"] | undefined
}>

export function WorldGraph({ slice, settings = defaultProjectSettings.graph }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [focusId, setFocusId] = useState<string | undefined>()
  const focusSummary = useMemo(() => slice?.nodes.find((node) => node.id === focusId), [focusId, slice])

  useEffect(() => {
    if (containerRef.current === null || slice === undefined || slice.nodes.length === 0) return
    const graph = new MultiDirectedGraph()
    const levels = buildGraphLevelsForLayout(slice)
    const levelIndex = new Map<string, number>()
    levels.forEach((level, index) => level.forEach((nodeId) => { levelIndex.set(nodeId, index) }))
    const offsets = new Map<number, number>()

    slice.nodes.forEach((node, index) => {
      const depth = levelIndex.get(node.id) ?? (index === 0 ? 0 : 2)
      const width = levels[depth]?.length ?? 1
      const horizontal = (offsets.get(depth) ?? 0) - (width - 1) / 2
      offsets.set(depth, (offsets.get(depth) ?? 0) + 1)
      const x = depth * 10
      const y = horizontal * 4.2 + (depth % 2 === 0 ? 0 : 2.1)
      graph.addNode(node.id, {
        x,
        y,
        size: depth === 0 ? 18 : depth === 1 ? 14 : 12,
        label: graphContentLabel(node.content),
        color: depth === 0 ? "#176b57" : depth === 1 ? "#2f6f9f" : "#8b6b2d",
      })
    })
    for (const link of slice.links) {
      if (!graph.hasNode(link.fromNodeId) || !graph.hasNode(link.toNodeId)) continue
      graph.addEdgeWithKey(link.id, link.fromNodeId, link.toNodeId, {
        label: graphContentLabel(link.content),
        color: "#a0a7b0",
        size: 1.6,
        type: "arrow",
      })
    }
    const renderer = new Sigma(graph, containerRef.current, {
      renderEdgeLabels: false,
      labelDensity: 0.75,
      labelRenderedSizeThreshold: 8,
      defaultEdgeType: "arrow",
      stagePadding: 54,
    })
    renderer.on("clickNode", ({ node }) => { setFocusId(node); })
    return () => { renderer.kill(); }
  }, [slice])

  return <div className="graph-view">
    <div className="graph-toolbar">
      <div className="graph-search"><Search size={14} /><input placeholder="搜索节点或原文" /></div>
      <UiTooltip label="定位当前场景"><button aria-label="定位当前场景"><LocateFixed size={15} /></button></UiTooltip>
      <UiTooltip label="重新布局"><button aria-label="重新布局"><RefreshCw size={15} /></button></UiTooltip>
    </div>
    <div className="graph-config"><span>出度 {settings.maxDirectOutDegree}</span><span>入度 {settings.maxDirectInDegree}</span><span>查询入口 {settings.maxNeighborhoodAnchors}</span><span>合并预警 {settings.mergeWarningThreshold}</span><span>{settings.layoutMode === "layered_collision_avoidance" ? "分层避碰" : settings.layoutMode}</span></div>
    {slice === undefined || slice.nodes.length === 0 ? <div className="empty-state">完成一轮推演后，这里显示从本轮锚点读取的真实局部图。</div> : <div className="graph-stage">
      <div className="sigma-canvas" ref={containerRef} />
      <aside className="graph-inspector">
        <small>局部详情</small>
        <strong>{focusSummary === undefined ? "点击一个节点查看" : graphContentLabel(focusSummary.content)}</strong>
        <p>{focusSummary === undefined ? "右侧显示当前节点、来源和局部连接说明。" : JSON.stringify(focusSummary.content, null, 2)}</p>
      </aside>
    </div>}
  </div>
}

export function buildGraphLevelsForLayout(slice: GraphSlice): string[][] {
  if (slice.nodes.length === 0) return []
  const nodes = new Map(slice.nodes.map((node) => [node.id, node]))
  const indegree = new Map<string, number>(slice.nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, string[]>()
  for (const link of slice.links) {
    if (!nodes.has(link.fromNodeId) || !nodes.has(link.toNodeId)) continue
    indegree.set(link.toNodeId, (indegree.get(link.toNodeId) ?? 0) + 1)
    const list = outgoing.get(link.fromNodeId) ?? []
    list.push(link.toNodeId)
    outgoing.set(link.fromNodeId, list)
  }
  const roots = slice.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id)
  const start = roots[0] ?? slice.nodes[0]?.id
  const visited = new Set<string>()
  const levels: string[][] = []
  let frontier = start === undefined ? [] : [start]
  while (frontier.length > 0) {
    const next: string[] = []
    const level: string[] = []
    for (const id of frontier) {
      if (visited.has(id)) continue
      visited.add(id)
      level.push(id)
      for (const candidate of outgoing.get(id) ?? []) {
        if (!visited.has(candidate)) next.push(candidate)
      }
    }
    if (level.length > 0) levels.push(level)
    frontier = next
  }
  const remaining = slice.nodes.map((node) => node.id).filter((id) => !visited.has(id))
  if (remaining.length > 0) levels.push(remaining)
  return levels
}

export function graphContentLabel(content: unknown): string {
  if (typeof content === "string") return content
  if (typeof content !== "object" || content === null) return "未命名节点"
  const record = content as Record<string, unknown>
  for (const key of ["name", "title", "text", "anchor", "note"]) {
    if (typeof record[key] === "string") return record[key]
  }
  return JSON.stringify(content).slice(0, 30)
}
