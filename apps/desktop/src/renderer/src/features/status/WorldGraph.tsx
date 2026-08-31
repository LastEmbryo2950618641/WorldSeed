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

/** Sigma 默认 hover 在 label 为字符串时会画出右侧标签白底框；空字符串也会触发，变成小白方块。 */
function drawNodeSelectionRing(
  context: CanvasRenderingContext2D,
  data: { x: number; y: number; size: number },
): void {
  const padding = 2
  context.fillStyle = "#FFF"
  context.shadowOffsetX = 0
  context.shadowOffsetY = 0
  context.shadowBlur = 8
  context.shadowColor = "#000"
  context.beginPath()
  context.arc(data.x, data.y, data.size + padding, 0, Math.PI * 2)
  context.closePath()
  context.fill()
  context.shadowBlur = 0
}

export function WorldGraph({ slice, settings = defaultProjectSettings.graph }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<MultiDirectedGraph | null>(null)
  const rendererRef = useRef<Sigma | null>(null)
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
        color: depth === 0 ? "#5865f2" : depth === 1 ? "#00a8fc" : "#f0b232",
        highlighted: false,
      })
    })
    for (const link of slice.links) {
      if (!graph.hasNode(link.fromNodeId) || !graph.hasNode(link.toNodeId)) continue
      graph.addEdgeWithKey(link.id, link.fromNodeId, link.toNodeId, {
        color: "#a0a7b0",
        size: 1.6,
        type: "arrow",
      })
    }
    const renderer = new Sigma(graph, containerRef.current, {
      renderLabels: false,
      renderEdgeLabels: false,
      defaultEdgeType: "arrow",
      stagePadding: 54,
      defaultDrawNodeHover: drawNodeSelectionRing,
    })
    graphRef.current = graph
    rendererRef.current = renderer
    renderer.on("clickNode", ({ node }) => { setFocusId(node); })
    renderer.on("clickStage", () => { setFocusId(undefined); })
    return () => {
      renderer.kill()
      graphRef.current = null
      rendererRef.current = null
    }
  }, [slice])

  useEffect(() => {
    const graph = graphRef.current
    const renderer = rendererRef.current
    if (graph === null || renderer === null) return
    graph.forEachNode((nodeId) => {
      const highlighted = nodeId === focusId
      if (graph.getNodeAttribute(nodeId, "highlighted") !== highlighted) {
        graph.setNodeAttribute(nodeId, "highlighted", highlighted)
      }
    })
    renderer.refresh()
  }, [focusId, slice])

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
        <small>节点详情</small>
        {focusSummary === undefined
          ? <>
              <strong>未选中节点</strong>
              <p>点击图中节点后，在此查看该节点内容。</p>
            </>
          : <>
              <strong>{graphContentLabel(focusSummary.content)}</strong>
              <code className="graph-inspector-id">{focusSummary.id}</code>
              <GraphContentView content={focusSummary.content} />
            </>}
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

const GRAPH_FIELD_LABELS: Readonly<Record<string, string>> = {
  identity: "身份",
  knowledge: "知识",
  name: "名称",
  title: "标题",
  label: "标签",
  text: "文本",
  note: "备注",
  anchor: "锚点",
  calendarDate: "历法日期",
  summary: "摘要",
  description: "描述",
  type: "类型",
  status: "状态",
  location: "地点",
  place: "地点",
  time: "时间",
  role: "角色",
}

export function graphFieldLabel(key: string): string {
  return GRAPH_FIELD_LABELS[key] ?? key
}

export function graphContentLabel(content: unknown): string {
  if (typeof content === "string") {
    const trimmed = content.trim()
    return trimmed.length === 0 ? "未命名节点" : trimmed
  }
  if (typeof content !== "object" || content === null || Array.isArray(content)) return "未命名节点"
  const record = content as Record<string, unknown>
  for (const key of ["name", "title", "label", "identity", "text", "anchor", "note", "calendarDate"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim().length > 0) return value.trim()
  }
  return "未命名节点"
}

export function formatGraphContent(content: unknown): string {
  if (typeof content === "string") return content
  if (content === undefined) return ""
  try {
    return JSON.stringify(content, null, 2)
  } catch {
    return String(content)
  }
}

export function GraphContentView({ content }: Readonly<{ content: unknown }>): React.JSX.Element {
  if (typeof content === "string") {
    const trimmed = content.trim()
    return <p className="graph-inspector-text">{trimmed.length === 0 ? "无内容" : trimmed}</p>
  }
  if (content === null || content === undefined) {
    return <p className="graph-inspector-text">无内容</p>
  }
  if (typeof content !== "object") {
    return <p className="graph-inspector-text">{String(content)}</p>
  }
  if (Array.isArray(content)) {
    if (content.length === 0) return <p className="graph-inspector-text">空列表</p>
    return <ul className="graph-inspector-list">
      {content.map((item, index) => <li key={index}><GraphFieldValue value={item} /></li>)}
    </ul>
  }
  const entries = Object.entries(content as Record<string, unknown>)
  if (entries.length === 0) return <p className="graph-inspector-text">无内容</p>
  return <dl className="graph-inspector-fields">
    {entries.map(([key, value]) => <div className="graph-inspector-field" key={key}>
      <dt>{graphFieldLabel(key)}</dt>
      <dd><GraphFieldValue value={value} /></dd>
    </div>)}
  </dl>
}

function GraphFieldValue({ value }: Readonly<{ value: unknown }>): React.JSX.Element {
  if (value === null || value === undefined) return <span className="graph-inspector-empty">—</span>
  if (typeof value === "string") return <>{value}</>
  if (typeof value === "number" || typeof value === "boolean") return <>{String(value)}</>
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
      return <span className="graph-inspector-chips">
        {value.map((item, index) => <span className="graph-inspector-chip" key={index}>{item === null ? "—" : String(item)}</span>)}
      </span>
    }
    return <pre className="graph-inspector-nested">{formatGraphContent(value)}</pre>
  }
  if (typeof value === "object") {
    const nested = Object.entries(value as Record<string, unknown>)
    if (nested.length === 0) return <span className="graph-inspector-empty">—</span>
    return <dl className="graph-inspector-fields graph-inspector-fields-nested">
      {nested.map(([key, nestedValue]) => <div className="graph-inspector-field" key={key}>
        <dt>{graphFieldLabel(key)}</dt>
        <dd><GraphFieldValue value={nestedValue} /></dd>
      </div>)}
    </dl>
  }
  return <pre className="graph-inspector-nested">{formatGraphContent(value)}</pre>
}
