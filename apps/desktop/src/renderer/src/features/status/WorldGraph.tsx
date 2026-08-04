import { useEffect, useRef } from "react"
import { MultiDirectedGraph } from "graphology"
import Sigma from "sigma"
import { LocateFixed, RefreshCw, Search } from "lucide-react"

import type { GraphSlice } from "../../api/client.js"

type Props = Readonly<{ slice: GraphSlice | undefined }>

export function WorldGraph({ slice }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (containerRef.current === null || slice === undefined || slice.nodes.length === 0) return
    const graph = new MultiDirectedGraph()
    slice.nodes.forEach((node, index) => {
      const angle = index === 0 ? 0 : (index - 1) / Math.max(1, slice.nodes.length - 1) * Math.PI * 2
      const radius = index === 0 ? 0 : 8 + Math.floor((index - 1) / 10) * 5
      graph.addNode(node.id, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        size: index === 0 ? 16 : 12,
        label: contentLabel(node.content),
        color: index === 0 ? "#176b57" : index % 2 === 0 ? "#3b6fa1" : "#8b6b2d",
      })
    })
    for (const link of slice.links) {
      if (!graph.hasNode(link.fromNodeId) || !graph.hasNode(link.toNodeId)) continue
      graph.addEdgeWithKey(link.id, link.fromNodeId, link.toNodeId, {
        label: contentLabel(link.content),
        color: "#9ca3af",
        size: 1.6,
        type: "arrow",
      })
    }
    const renderer = new Sigma(graph, containerRef.current, {
      renderEdgeLabels: true,
      labelDensity: 0.9,
      labelRenderedSizeThreshold: 8,
      defaultEdgeType: "arrow",
      stagePadding: 42,
    })
    return () => { renderer.kill(); }
  }, [slice])

  return <div className="graph-view">
    <div className="graph-toolbar">
      <div className="graph-search"><Search size={14} /><input placeholder="搜索节点或原文" /></div>
      <button title="定位当前场景"><LocateFixed size={15} /></button>
      <button title="重新布局"><RefreshCw size={15} /></button>
    </div>
    <div className="graph-config"><span>出度 12</span><span>入度 12</span><span>合并预警 10</span><span>分层避碰</span></div>
    {slice === undefined || slice.nodes.length === 0 ? <div className="empty-state">完成一轮推演后，这里显示从本轮锚点读取的真实局部图。</div> : <div className="sigma-canvas" ref={containerRef} />}
  </div>
}

function contentLabel(content: unknown): string {
  if (typeof content === "string") return content
  if (typeof content !== "object" || content === null) return "未命名节点"
  const record = content as Record<string, unknown>
  for (const key of ["name", "title", "text", "anchor", "note"]) {
    if (typeof record[key] === "string") return record[key]
  }
  return JSON.stringify(content).slice(0, 30)
}
