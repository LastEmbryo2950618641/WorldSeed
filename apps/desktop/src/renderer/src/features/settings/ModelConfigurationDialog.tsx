import { useCallback, useEffect, useMemo, useState } from "react"
import { Check, CheckCircle2, Eye, EyeOff, KeyRound, LoaderCircle, Plus, RefreshCw, Server, Trash2, X } from "lucide-react"

import type { ModelDescriptor, ModelListResult } from "@worldseed/contracts"

import { listModelCatalog } from "../../api/client.js"
import { UiTooltip } from "../../components/UiTooltip.js"

export type ModelProfile = Readonly<{
  id: string
  name: string
  baseUrl: string
  model: string
  credentialRef: string
  apiProtocol: "openai_chat_completions" | "openai_responses"
  contextWindowTokens: number
  apiKey: string
  hasApiKey: boolean
  thinkingModeEnabled: boolean
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  jsonModeEnabled: boolean
  disableResponseStorage: boolean
  serviceTier: "auto" | "default" | "flex" | "priority" | "fast"
}>

type Props = Readonly<{
  profiles: readonly ModelProfile[]
  activeProfileId: string
  onClose(): void
  onSave(profiles: readonly ModelProfile[], activeProfileId: string): void | Promise<void>
}>

type TestState = "idle" | "testing" | "success" | "error"
type CatalogState = Readonly<{
  signature: string
  status: "loading" | "success" | "error"
  models: readonly ModelDescriptor[]
}>

export function ModelConfigurationDialog({ profiles, activeProfileId, onClose, onSave }: Props): React.JSX.Element {
  const [drafts, setDrafts] = useState<readonly ModelProfile[]>(profiles)
  const [selectedId, setSelectedId] = useState(activeProfileId)
  const [nextActiveId, setNextActiveId] = useState(activeProfileId)
  const [showApiKey, setShowApiKey] = useState(false)
  const [testState, setTestState] = useState<TestState>("idle")
  const [message, setMessage] = useState("选择一个配置进行编辑")
  const [saving, setSaving] = useState(false)
  const [catalogs, setCatalogs] = useState<Readonly<Record<string, CatalogState>>>({})
  const selectedProfile = useMemo(() => drafts.find((profile) => profile.id === selectedId) ?? drafts[0], [drafts, selectedId])
  const selectedCatalog = selectedProfile === undefined ? undefined : catalogs[selectedProfile.id]
  const deepSeekSelected = selectedProfile !== undefined && isOfficialDeepSeekEndpoint(selectedProfile.baseUrl)

  const loadDeepSeekModels = useCallback(async (profile: ModelProfile): Promise<ModelListResult | undefined> => {
    const signature = catalogSignature(profile)
    setCatalogs((current) => ({
      ...current,
      [profile.id]: { signature, status: "loading", models: [] },
    }))
    setTestState("testing")
    setMessage("正在从 DeepSeek 获取可用模型...")
    try {
      const result = await listModelCatalog({
        baseUrl: profile.baseUrl.trim(),
        credentialRef: profile.credentialRef,
        apiKey: profile.apiKey.trim(),
      })
      if (result.models.length === 0) throw new Error("DeepSeek 未返回可用模型")
      setCatalogs((current) => current[profile.id]?.signature !== signature ? current : {
        ...current,
        [profile.id]: { signature, status: "success", models: result.models },
      })
      const availableModelIds = new Set(result.models.map((model) => model.id))
      setDrafts((current) => current.map((item) => (
        item.id === profile.id
          && catalogSignature(item) === signature
          && (item.model.trim().length === 0 || !availableModelIds.has(item.model.trim()))
          ? { ...item, model: result.models[0]?.id ?? "" }
          : item
      )))
      setTestState("success")
      setMessage(`已从 DeepSeek 获取 ${String(result.models.length)} 个可用模型`)
      return result
    } catch (error) {
      setCatalogs((current) => current[profile.id]?.signature !== signature ? current : {
        ...current,
        [profile.id]: { signature, status: "error", models: [] },
      })
      setTestState("error")
      setMessage(error instanceof Error ? error.message : String(error))
      return undefined
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => { window.removeEventListener("keydown", handleKeyDown) }
  }, [onClose])

  useEffect(() => {
    if (selectedProfile === undefined || !isOfficialDeepSeekEndpoint(selectedProfile.baseUrl)) return
    if ((!selectedProfile.hasApiKey && selectedProfile.apiKey.trim().length === 0) || !hasValidBaseUrl(selectedProfile.baseUrl)) return
    const signature = catalogSignature(selectedProfile)
    if (selectedCatalog?.signature === signature) return
    const timeout = window.setTimeout(() => { void loadDeepSeekModels(selectedProfile) }, 500)
    return () => { window.clearTimeout(timeout) }
  }, [loadDeepSeekModels, selectedCatalog?.signature, selectedProfile])

  const updateSelected = (changes: Partial<Omit<ModelProfile, "id">>): void => {
    setDrafts((current) => current.map((profile) => profile.id === selectedId ? { ...profile, ...changes } : profile))
    if ("baseUrl" in changes || "apiKey" in changes) {
      setCatalogs((current) => Object.fromEntries(Object.entries(current).filter(([profileId]) => profileId !== selectedId)))
    }
    setTestState("idle")
    setMessage("配置已修改，尚未保存")
  }

  const validate = (profile: ModelProfile | undefined, requireModel = true): string | undefined => {
    if (profile === undefined) return "请先创建一个模型配置"
    if (profile.name.trim().length === 0) return "请输入配置名称"
    try {
      const parsedUrl = new URL(profile.baseUrl)
      if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost" && parsedUrl.hostname !== "127.0.0.1") {
        return "远程模型地址必须使用 HTTPS"
      }
    } catch {
      return "请输入有效的 Base URL"
    }
    if (requireModel && profile.model.trim().length === 0) return "请选择模型"
    if (!Number.isInteger(profile.contextWindowTokens) || profile.contextWindowTokens <= 0 || profile.contextWindowTokens > 2_000_000) return "最大上下文必须是 1 到 2,000,000 之间的整数"
    if (profile.apiKey.trim().length === 0 && !profile.hasApiKey) return "请输入 API Key"
    return undefined
  }

  const addProfile = (): void => {
    const profile: ModelProfile = {
      id: crypto.randomUUID(),
      name: `新模型 ${String(drafts.length + 1)}`,
      baseUrl: "https://api.deepseek.com",
      model: "",
      credentialRef: `model-profile:${crypto.randomUUID()}`,
      apiProtocol: "openai_responses",
      contextWindowTokens: 1_000_000,
      apiKey: "",
      hasApiKey: false,
      thinkingModeEnabled: true,
      reasoningEffort: "high",
      jsonModeEnabled: false,
      disableResponseStorage: true,
      serviceTier: "auto",
    }
    setDrafts((current) => [...current, profile])
    setSelectedId(profile.id)
    setTestState("idle")
    setMessage("新配置尚未保存")
  }

  const removeSelected = (): void => {
    if (selectedProfile === undefined || drafts.length <= 1) return
    const remaining = drafts.filter((profile) => profile.id !== selectedProfile.id)
    const fallback = remaining[0]
    setDrafts(remaining)
    setCatalogs((current) => Object.fromEntries(Object.entries(current).filter(([profileId]) => profileId !== selectedProfile.id)))
    setSelectedId(fallback?.id ?? "")
    if (nextActiveId === selectedProfile.id) setNextActiveId(fallback?.id ?? "")
    setTestState("idle")
    setMessage("配置已删除，尚未保存")
  }

  const testConnection = async (): Promise<void> => {
    const validationError = validate(selectedProfile, !deepSeekSelected)
    if (validationError !== undefined) {
      setTestState("error")
      setMessage(validationError)
      return
    }
    if (selectedProfile !== undefined && deepSeekSelected) {
      await loadDeepSeekModels(selectedProfile)
      return
    }
    setTestState("testing")
    setMessage("正在检查配置格式...")
    await new Promise((resolve) => setTimeout(resolve, 650))
    setTestState("success")
    setMessage("配置格式有效；正式版本将由后端执行连接测试")
  }

  const activateSelected = (): void => {
    const validationError = validate(selectedProfile)
    if (validationError !== undefined) {
      setTestState("error")
      setMessage(validationError)
      return
    }
    setNextActiveId(selectedProfile?.id ?? "")
    setTestState("success")
    setMessage(`已切换为 ${selectedProfile?.name ?? "当前配置"}，保存后生效`)
  }

  const save = async (): Promise<void> => {
    const activeProfile = drafts.find((profile) => profile.id === nextActiveId)
    const validationError = validate(activeProfile)
    if (validationError !== undefined) {
      if (activeProfile !== undefined) setSelectedId(activeProfile.id)
      setTestState("error")
      setMessage(`当前模型：${validationError}`)
      return
    }
    setSaving(true)
    try {
      await onSave(drafts.map(normalizeProfile), nextActiveId)
    } finally {
      setSaving(false)
    }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="model-dialog model-dialog-wide" data-testid="model-configuration-dialog" role="dialog" aria-modal="true" aria-labelledby="model-dialog-title">
      <header className="model-dialog-header">
        <div><strong id="model-dialog-title">模型配置</strong><span>管理并切换 OpenAI 兼容模型接口</span></div>
        <UiTooltip label="关闭"><button aria-label="关闭模型配置" onClick={onClose}><X size={16} /></button></UiTooltip>
      </header>
      <div className="model-dialog-layout">
        <aside className="model-profile-panel">
          <div className="model-profile-heading"><span>模型列表<small>{String(drafts.length)} 个配置</small></span><UiTooltip label="新增模型配置"><button data-testid="add-model-profile" aria-label="新增模型配置" onClick={addProfile}><Plus size={15} /></button></UiTooltip></div>
          <div className="model-profile-list">{drafts.map((profile) => <button className={`${profile.id === selectedProfile?.id ? "selected" : ""} ${profile.id === nextActiveId ? "active" : ""}`} key={profile.id} onClick={() => { setSelectedId(profile.id); setTestState("idle"); setMessage("选择一个配置进行编辑"); }}>
            <span className="profile-state">{profile.id === nextActiveId ? <Check size={12} /> : null}</span>
            <span><strong>{profile.name || "未命名配置"}</strong><small>{profile.model || "未选择模型"}</small></span>
          </button>)}</div>
          <button className="remove-profile" disabled={drafts.length <= 1} onClick={removeSelected}><Trash2 size={13} />删除选中配置</button>
        </aside>
        <div className="model-editor">
          {selectedProfile === undefined ? <div className="empty-model-editor">请先新增一个模型配置</div> : <>
            <div className="model-dialog-summary">
              <span className="model-summary-icon"><Server size={17} /></span>
              <span><strong>{selectedProfile.model.trim() || "尚未选择模型"}</strong><small>{selectedProfile.baseUrl.trim() || "尚未配置服务地址"}</small></span>
              <em>{selectedProfile.id === nextActiveId ? "当前使用" : !selectedProfile.hasApiKey && selectedProfile.apiKey.trim().length === 0 ? "未配置密钥" : "可切换"}</em>
            </div>
            <label className="model-field">
              <span>配置名称<small>用于区分不同服务与账号</small></span>
              <input value={selectedProfile.name} onChange={(event) => { updateSelected({ name: event.target.value }); }} placeholder="例如：DeepSeek 主账号" spellCheck={false} />
            </label>
            <label className="model-field">
              <span>API 协议<small>按服务能力选择，不依赖供应商品牌</small></span>
              <select className="model-enum-select" value={selectedProfile.apiProtocol} onChange={(event) => { updateSelected({ apiProtocol: event.target.value as ModelProfile["apiProtocol"] }); }}>
                <option value="openai_responses">OpenAI Responses</option><option value="openai_chat_completions">OpenAI Chat Completions</option>
              </select>
            </label>
            <label className="model-field">
              <span>Base URL<small>模型服务的 API 根地址</small></span>
              <input value={selectedProfile.baseUrl} onChange={(event) => { updateSelected({ baseUrl: event.target.value }); }} placeholder="https://api.deepseek.com" spellCheck={false} />
            </label>
            <label className="model-field">
              <span>API Key<small>使用系统安全存储，不写入项目 Markdown 或数据库</small></span>
              <div className="secret-input"><KeyRound size={15} /><input type={showApiKey ? "text" : "password"} value={selectedProfile.apiKey} onChange={(event) => { updateSelected({ apiKey: event.target.value, hasApiKey: event.target.value.trim().length > 0 }); }} placeholder={selectedProfile.hasApiKey ? "已保存（重新输入可替换）" : "输入 API Key"} autoComplete="off" spellCheck={false} /><UiTooltip label={showApiKey ? "隐藏密钥" : "显示密钥"}><button type="button" aria-label={showApiKey ? "隐藏密钥" : "显示密钥"} onClick={() => { setShowApiKey((visible) => !visible); }}>{showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></UiTooltip></div>
            </label>
            <label className="model-field">
              <span>模型<small>{deepSeekSelected ? "输入密钥后自动读取 DeepSeek 模型列表" : "输入兼容服务支持的模型名称"}</small></span>
              {deepSeekSelected ? <div className="model-select-input">
                <select value={selectedProfile.model} disabled={selectedCatalog?.status === "loading" || selectedCatalog?.models.length === 0} onChange={(event) => { updateSelected({ model: event.target.value }); }}>
                  {selectedCatalog?.models.length === 0 || selectedCatalog === undefined ? <option value="">{selectedCatalog?.status === "loading" ? "正在获取模型..." : selectedCatalog?.status === "error" ? "获取模型失败" : "等待 API Key"}</option> : null}
                  {selectedCatalog?.models.map((model) => <option value={model.id} key={model.id}>{model.id}</option>)}
                </select>
                <UiTooltip label="重新获取 DeepSeek 模型列表"><button type="button" aria-label="重新获取 DeepSeek 模型列表" disabled={(!selectedProfile.hasApiKey && selectedProfile.apiKey.trim().length === 0) || selectedCatalog?.status === "loading"} onClick={() => { void loadDeepSeekModels(selectedProfile) }}><RefreshCw size={14} /></button></UiTooltip>
              </div> : <input value={selectedProfile.model} onChange={(event) => { updateSelected({ model: event.target.value }); }} placeholder="输入模型名称" spellCheck={false} />}
            </label>
            <label className="model-field">
              <span>最大上下文<small>该模型单次请求支持的上下文容量，是压缩计算的唯一来源</small></span>
              <input type="number" value={selectedProfile.contextWindowTokens} min={1} max={2_000_000} step={1000} onChange={(event) => { updateSelected({ contextWindowTokens: Number(event.target.value) }); }} />
            </label>
            <div className="model-field">
              <span>深度思考<small>使用当前协议支持的原生推理能力</small></span>
              <button className={`model-toggle ${selectedProfile.thinkingModeEnabled ? "enabled" : ""}`} type="button" role="switch" aria-checked={selectedProfile.thinkingModeEnabled} onClick={() => { updateSelected({ thinkingModeEnabled: !selectedProfile.thinkingModeEnabled }); }}><i /><strong>{selectedProfile.thinkingModeEnabled ? "已开启" : "已关闭"}</strong></button>
            </div>
            <label className="model-field">
              <span>思考强度<small>可选值取决于模型与兼容服务</small></span>
              <select className="model-enum-select" value={selectedProfile.reasoningEffort} disabled={!selectedProfile.thinkingModeEnabled} onChange={(event) => { updateSelected({ reasoningEffort: event.target.value as ModelProfile["reasoningEffort"] }); }}>
                <option value="none">无</option><option value="minimal">最小</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option><option value="max">最大</option>
              </select>
            </label>
            <label className="model-field">
              <span>服务等级<small>兼容服务不支持时使用自动</small></span>
              <select className="model-enum-select" value={selectedProfile.serviceTier} onChange={(event) => { updateSelected({ serviceTier: event.target.value as ModelProfile["serviceTier"] }); }}>
                <option value="auto">自动</option><option value="default">默认</option><option value="flex">Flex</option><option value="priority">Priority</option><option value="fast">Fast</option>
              </select>
            </label>
            <div className="model-field">
              <span>服务端响应存储<small>关闭后仅保留 Worldseed 本地历史</small></span>
              <button className={`model-toggle ${selectedProfile.disableResponseStorage ? "" : "enabled"}`} type="button" role="switch" aria-checked={!selectedProfile.disableResponseStorage} onClick={() => { updateSelected({ disableResponseStorage: !selectedProfile.disableResponseStorage }); }}><i /><strong>{selectedProfile.disableResponseStorage ? "已关闭" : "已开启"}</strong></button>
            </div>
            <div className="model-field">
              <span>JSON Mode<small>默认关闭；输出仍由业务 Schema 校验</small></span>
              <button className={`model-toggle ${selectedProfile.jsonModeEnabled ? "enabled" : ""}`} type="button" role="switch" aria-checked={selectedProfile.jsonModeEnabled} onClick={() => { updateSelected({ jsonModeEnabled: !selectedProfile.jsonModeEnabled }); }}><i /><strong>{selectedProfile.jsonModeEnabled ? "已开启" : "已关闭"}</strong></button>
            </div>
            <div className={`model-test-status ${testState}`}>
              {testState === "testing" ? <LoaderCircle size={14} /> : testState === "success" ? <CheckCircle2 size={14} /> : <span />}
              <p>{message}</p>
            </div>
          </>}
        </div>
      </div>
      <footer className="model-dialog-footer">
        <p>配置写入应用数据库；API Key 由系统安全存储保护。</p>
        <button className="secondary-command" onClick={() => void testConnection()} disabled={testState === "testing"}>{testState === "testing" ? "测试中..." : "测试连接"}</button>
        <button className="secondary-command" onClick={activateSelected}>设为当前</button>
        <button className="dialog-primary-command" onClick={() => void save()} disabled={saving}>{saving ? "保存中..." : "保存更改"}</button>
      </footer>
    </section>
  </div>
}

export function normalizeProfile(profile: ModelProfile): ModelProfile {
  return {
    ...profile,
    name: profile.name.trim(),
    baseUrl: profile.baseUrl.trim(),
    model: profile.model.trim(),
    apiKey: profile.apiKey.trim(),
  }
}

export function isOfficialDeepSeekEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.deepseek.com"
  } catch {
    return false
  }
}

export function hasValidBaseUrl(baseUrl: string): boolean {
  try {
    const parsedUrl = new URL(baseUrl)
    return parsedUrl.protocol === "https:" || parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1"
  } catch {
    return false
  }
}

export function catalogSignature(profile: ModelProfile): string {
  return `${profile.baseUrl.trim()}\u0000${profile.apiKey.trim() || profile.credentialRef}`
}
