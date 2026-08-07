import { useEffect, useMemo, useState } from "react"
import {
  Binary,
  Bot,
  Database,
  Gauge,
  Network,
  Search,
  X,
  type LucideIcon,
} from "lucide-react"

import { projectSettingsSchema, type ProjectSettings } from "@worldseed/contracts"

type SettingsSection = "execution" | "retrieval" | "graph" | "model"
type NumericExecutionSetting = Exclude<keyof ProjectSettings["execution"], "outputTokenLimitMode">

type Props = Readonly<{
  projectName: string
  settings: ProjectSettings
  activeModelName: string
  onClose(): void
  onSave(settings: ProjectSettings): void | Promise<void>
  onOpenModelSettings(): void
}>

type SectionDefinition = Readonly<{
  id: SettingsSection
  label: string
  group: "项目" | "应用"
  keywords: string
  icon: LucideIcon
}>

const sections: readonly SectionDefinition[] = [
  { id: "execution", label: "推演执行", group: "项目", keywords: "模型调用 token 耗时 预算 检索轮次", icon: Gauge },
  { id: "retrieval", label: "资料检索", group: "项目", keywords: "读取 请求 候选 深度 证据 token", icon: Database },
  { id: "graph", label: "世界图", group: "项目", keywords: "出度 入度 合并 预警 展开 节点 连接 入口 布局", icon: Network },
  { id: "model", label: "模型服务", group: "应用", keywords: "base url api key deepseek 模型", icon: Bot },
]

export function ProjectSettingsDialog({
  projectName,
  settings,
  activeModelName,
  onClose,
  onSave,
  onOpenModelSettings,
}: Props): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>("execution")
  const [query, setQuery] = useState("")
  const [draft, setDraft] = useState<ProjectSettings>(settings)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const validation = projectSettingsSchema.safeParse(draft)
  const validationMessage = validation.success ? undefined : validation.error.issues[0]?.message
  const visibleSections = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (normalized.length === 0) return sections
    return sections.filter((item) => `${item.label} ${item.keywords}`.toLocaleLowerCase().includes(normalized))
  }, [query])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => { window.removeEventListener("keydown", handleKeyDown) }
  }, [onClose])

  useEffect(() => {
    if (visibleSections.length > 0 && !visibleSections.some((item) => item.id === section)) {
      setSection(visibleSections[0]?.id ?? "execution")
    }
  }, [section, visibleSections])

  const updateExecution = (key: NumericExecutionSetting, value: number): void => {
    setDraft((current) => ({ ...current, execution: { ...current.execution, [key]: value } }))
    setSaveError(undefined)
  }
  const updateRetrieval = (key: keyof ProjectSettings["retrieval"], value: number): void => {
    setDraft((current) => ({ ...current, retrieval: { ...current.retrieval, [key]: value } }))
    setSaveError(undefined)
  }
  const updateGraph = (key: Exclude<keyof ProjectSettings["graph"], "layoutMode">, value: number): void => {
    setDraft((current) => ({ ...current, graph: { ...current.graph, [key]: value } }))
    setSaveError(undefined)
  }

  const save = async (): Promise<void> => {
    if (!validation.success) return
    setSaving(true)
    setSaveError(undefined)
    try {
      await onSave(validation.data)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="project-settings-dialog" data-testid="project-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="project-settings-title">
      <header className="model-dialog-header">
        <div><strong id="project-settings-title">设置 / {projectName}</strong><span>项目推演参数与应用服务入口</span></div>
        <button title="关闭" aria-label="关闭项目设置" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="project-settings-layout">
        <aside className="settings-navigation">
          <label className="settings-search"><Search size={14} /><input value={query} onChange={(event) => { setQuery(event.target.value); }} placeholder="搜索设置" /></label>
          <div className="settings-section-list">
            {(["项目", "应用"] as const).map((group) => {
              const grouped = visibleSections.filter((item) => item.group === group)
              if (grouped.length === 0) return null
              return <div className="settings-section-group" key={group}>
                <small>{group}</small>
                {grouped.map((item) => {
                  const Icon = item.icon
                  return <button className={section === item.id ? "active" : ""} key={item.id} onClick={() => { setSection(item.id); }}><Icon size={14} /><span>{item.label}</span></button>
                })}
              </div>
            })}
            {visibleSections.length === 0 ? <p className="settings-no-match">没有匹配的设置</p> : null}
          </div>
        </aside>
        <div className="settings-editor">
          {section === "execution" ? <ExecutionSettings value={draft.execution} onChange={updateExecution} /> : null}
          {section === "retrieval" ? <RetrievalSettings value={draft.retrieval} onChange={updateRetrieval} /> : null}
          {section === "graph" ? <GraphSettings value={draft.graph} onChange={updateGraph} /> : null}
          {section === "model" ? <ModelSettings activeModelName={activeModelName} onOpen={onOpenModelSettings} /> : null}
        </div>
      </div>
      <footer className="model-dialog-footer settings-footer">
        <p>{saveError ?? validationMessage ?? "项目参数保存到内部数据库；新设置从下一轮推演开始生效。"}</p>
        <button className="secondary-command" onClick={onClose}>取消</button>
        <button className="dialog-primary-command" data-testid="save-project-settings" onClick={() => void save()} disabled={saving || !validation.success}>{saving ? "保存中..." : "应用"}</button>
      </footer>
    </section>
  </div>
}

function ExecutionSettings({ value, onChange }: {
  value: ProjectSettings["execution"]
  onChange(key: NumericExecutionSetting, value: number): void
}): React.JSX.Element {
  return <SettingsPage icon={Gauge} title="推演执行" description="默认按每轮可能失败并保留约 30% 重试冗余计算。">
    <NumberSetting label="最大模型调用次数" description="包含阶段调用和业务 Schema 修复调用" value={value.maxModelCalls} min={1} max={200} onChange={(next) => { onChange("maxModelCalls", next); }} />
    <NumberSetting label="模型上下文窗口" description="当前模型单次请求可接受的上下文上限" value={value.contextWindowTokens} min={1} max={2_000_000} step={1000} onChange={(next) => { onChange("contextWindowTokens", next); }} />
    <NumberSetting label="主动压缩阈值" description={`达到 ${Math.floor(value.contextWindowTokens * value.contextCompactionThresholdRatio).toLocaleString()} Token 前由系统接管压缩`} value={Math.round(value.contextCompactionThresholdRatio * 100)} min={50} max={99} suffix="%" onChange={(next) => { onChange("contextCompactionThresholdRatio", next / 100); }} />
    <div className="settings-field-row">
      <span><strong>输出 Token 上限</strong><small>应用不设置累计输出上限，也不向接口固定 max_tokens</small></span>
      <div className="settings-readonly-value"><Binary size={14} />由模型决定</div>
    </div>
    <NumberSetting label="最长运行时间" description="墙钟时间上限，单位毫秒" value={value.maxWallTimeMs} min={1} max={1_800_000} step={1000} suffix="ms" onChange={(next) => { onChange("maxWallTimeMs", next); }} />
    <NumberSetting label="最大检索轮次" description="同一阶段允许模型补充读取资料的轮数" value={value.maxRetrievalRounds} min={1} max={10} onChange={(next) => { onChange("maxRetrievalRounds", next); }} />
  </SettingsPage>
}

function RetrievalSettings({ value, onChange }: {
  value: ProjectSettings["retrieval"]
  onChange(key: keyof ProjectSettings["retrieval"], value: number): void
}): React.JSX.Element {
  return <SettingsPage icon={Database} title="资料检索" description="限制每轮选择性读取的广度、深度和证据体积。">
    <NumberSetting label="每轮最大读取请求" description="模型一次返回中可执行的资料读取请求数" value={value.maxRequestsPerRound} min={1} max={50} onChange={(next) => { onChange("maxRequestsPerRound", next); }} />
    <NumberSetting label="单请求最大候选" description="每个检索请求最多返回的候选资料数" value={value.maxCandidates} min={1} max={200} onChange={(next) => { onChange("maxCandidates", next); }} />
    <NumberSetting label="最大检索深度" description="图检索请求允许使用的最大局部深度" value={value.maxDepth} min={1} max={8} onChange={(next) => { onChange("maxDepth", next); }} />
    <NumberSetting label="证据 Token 上限" description="单轮组装进动态上下文的证据预算" value={value.maxEvidenceTokens} min={1} max={200_000} step={1000} onChange={(next) => { onChange("maxEvidenceTokens", next); }} />
  </SettingsPage>
}

function GraphSettings({ value, onChange }: {
  value: ProjectSettings["graph"]
  onChange(key: Exclude<keyof ProjectSettings["graph"], "layoutMode">, value: number): void
}): React.JSX.Element {
  return <SettingsPage icon={Network} title="世界图" description="控制局部图容量、递归展开与可视化读取边界。">
    <NumberSetting label="直接出度上限" description="节点直接出口达到上限后，AI 应先合并相近出口" value={value.maxDirectOutDegree} min={1} max={64} onChange={(next) => { onChange("maxDirectOutDegree", next); }} />
    <NumberSetting label="直接入度上限" description="节点直接入口达到上限后，AI 应建立递归汇聚结构" value={value.maxDirectInDegree} min={1} max={64} onChange={(next) => { onChange("maxDirectInDegree", next); }} />
    <NumberSetting label="合并预警阈值" description="接近入度或出度上限时提前提示 AI 治理局部结构" value={value.mergeWarningThreshold} min={1} max={64} onChange={(next) => { onChange("mergeWarningThreshold", next); }} />
    <NumberSetting label="推荐展开深度" description="正常局部召回优先使用的深度" value={value.preferredExpansionDepth} min={0} max={8} onChange={(next) => { onChange("preferredExpansionDepth", next); }} />
    <NumberSetting label="最大展开深度" description="局部图查询不可超过的递归深度" value={value.maxExpansionDepth} min={1} max={8} onChange={(next) => { onChange("maxExpansionDepth", next); }} />
    <NumberSetting label="最大访问节点数" description="一次局部图读取最多访问的节点" value={value.maxVisitedNodes} min={1} max={2000} onChange={(next) => { onChange("maxVisitedNodes", next); }} />
    <NumberSetting label="最大访问连接数" description="一次局部图读取最多访问的连接" value={value.maxVisitedLinks} min={1} max={4000} onChange={(next) => { onChange("maxVisitedLinks", next); }} />
    <NumberSetting label="世界图查询入口数" description="提交后刷新世界图时最多使用多少个起点，不等于节点出度上限" value={value.maxNeighborhoodAnchors} min={1} max={64} onChange={(next) => { onChange("maxNeighborhoodAnchors", next); }} />
    <div className="settings-field-row">
      <span><strong>显示布局</strong><small>只影响世界图显示，不改变图数据</small></span>
      <div className="settings-readonly-value"><Binary size={14} />分层避碰</div>
    </div>
  </SettingsPage>
}

function ModelSettings({ activeModelName, onOpen }: { activeModelName: string; onOpen(): void }): React.JSX.Element {
  return <SettingsPage icon={Bot} title="模型服务" description="模型配置属于应用级安全设置，可被多个项目复用。">
    <div className="settings-model-summary">
      <span><Bot size={18} /></span>
      <div><small>当前模型</small><strong>{activeModelName}</strong><p>Base URL、模型列表与 API Key 在独立模型配置中管理；API Key 不写入项目数据库。</p></div>
      <button className="secondary-command" onClick={onOpen}>管理模型配置</button>
    </div>
  </SettingsPage>
}

function SettingsPage({ icon: Icon, title, description, children }: {
  icon: LucideIcon
  title: string
  description: string
  children: React.ReactNode
}): React.JSX.Element {
  return <section className="settings-page">
    <header><span><Icon size={18} /></span><div><h2>{title}</h2><p>{description}</p></div></header>
    <div className="settings-fields">{children}</div>
  </section>
}

function NumberSetting({ label, description, value, min, max, step = 1, suffix, onChange }: {
  label: string
  description: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  onChange(value: number): void
}): React.JSX.Element {
  return <label className="settings-field-row">
    <span><strong>{label}</strong><small>{description}</small></span>
    <span className="settings-number-input"><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => { onChange(Number(event.target.value)); }} />{suffix === undefined ? null : <em>{suffix}</em>}</span>
  </label>
}
