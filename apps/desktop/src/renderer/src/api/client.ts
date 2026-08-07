import {
  PROTOCOL_VERSION,
  type BackendMethod,
  type ClientRequest,
  type ModelListResult,
  type ModelProfileDraft,
  type ProjectSettings,
} from "@worldseed/contracts"
import { defaultProjectSettings } from "@worldseed/config"

export type OpenProject = Readonly<{
  projectId: string
  displayName: string
  workspaceRootRef: string
}>

export type DesktopModelProfile = Readonly<ModelProfileDraft>

export type DesktopModelProfiles = Readonly<{
  profiles: readonly DesktopModelProfile[]
  activeProfileId: string
}>

export type InventoryEntry = Readonly<{ path: string; kind: "directory" | "file" }>
export type WorkspaceReport = Readonly<{ inventory: readonly InventoryEntry[]; issues: readonly unknown[] }>

export type TurnResult = Readonly<{
  chapterPath: string
  chapterHeading: string
  graphAnchorIds: readonly string[]
  modelCalls: number
  inputTokens: number
  outputTokens: number
  modelProvider: string
  modelName: string
  kvCacheHitRate?: number
}>

export type TaskSnapshot = Readonly<{
  status: string
  lastPhase?: string
  result?: TurnResult
  error?: { message?: string }
  phaseRuns?: readonly PhaseRunSnapshot[]
}>

export type PhaseRunSnapshot = Readonly<{
  phaseRunId: string
  phase: string
  status: string
  attempt: number
  result?: unknown
  usage: unknown
  startedAtMs: number
  finishedAtMs?: number
}>

export type GraphSlice = Readonly<{
  nodes: readonly { id: string; content: unknown; metadata?: Record<string, unknown> }[]
  links: readonly { id: string; fromNodeId: string; toNodeId: string; content?: unknown }[]
  truncated: boolean
  anchorWindow?: Readonly<{
    requestedCount: number
    processedCount: number
    offset: number
    limit: number
    remainingCount: number
    nextOffset?: number
  }>
}>

export async function invokeBackend<T>(method: BackendMethod, payload: unknown): Promise<T> {
  const bridge = getWorldseedBridge()
  if (bridge === undefined) return demoInvoke(method, payload) as T
  const request: ClientRequest = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    method,
    payload,
  }
  const response = await bridge.invoke(request)
  if (!response.ok) throw new Error(response.error.message)
  return response.data as T
}

export async function selectDirectory(): Promise<string | undefined> {
  return getWorldseedBridge()?.selectDirectory() ?? "C:\\Worldseed\\雾港纪事"
}

export async function readModelProfiles(): Promise<DesktopModelProfiles> {
  const bridge = getWorldseedBridge()
  if (bridge !== undefined) return bridge.readModelProfiles()
  return invokeBackend<DesktopModelProfiles>("model.profiles.read", {})
}

export async function saveModelProfiles(input: { profiles: readonly DesktopModelProfile[]; activeProfileId: string }): Promise<DesktopModelProfiles> {
  const bridge = getWorldseedBridge()
  if (bridge !== undefined) return bridge.saveModelProfiles(input)
  return invokeBackend<DesktopModelProfiles>("model.profiles.save", input)
}

export async function listModelCatalog(input: { baseUrl: string; credentialRef: string; apiKey?: string }): Promise<ModelListResult> {
  const bridge = getWorldseedBridge()
  if (bridge !== undefined) return bridge.listModels(input)
  return invokeBackend<ModelListResult>("model.list", { baseUrl: input.baseUrl, apiKey: input.apiKey?.trim() || "browser-demo" })
}

export const browserDemoProject: OpenProject | undefined = getWorldseedBridge() === undefined ? {
  projectId: "11111111-1111-4111-8111-111111111111",
  displayName: "雾港纪事",
  workspaceRootRef: "C:\\Worldseed\\雾港纪事",
} : undefined

function getWorldseedBridge(): typeof window.worldseed | undefined {
  return typeof window === "undefined" ? undefined : window.worldseed
}

const demoInventory: InventoryEntry[] = [
  { path: "世界推演规则", kind: "directory" },
  { path: "世界推演规则/基础规则", kind: "directory" },
  { path: "世界推演规则/基础规则/base-rules.md", kind: "file" },
  { path: "世界推演规则/用户规则", kind: "directory" },
  { path: "世界推演规则/用户规则/人物出场节奏.md", kind: "file" },
  { path: "设定集", kind: "directory" },
  { path: "设定集/盐雾城.md", kind: "file" },
  { path: "参考文件", kind: "directory" },
  { path: "参考文件/港口航运参考.md", kind: "file" },
  { path: "表现输出", kind: "directory" },
  { path: "表现输出/描写规则", kind: "directory" },
  { path: "表现输出/描写规则/近景跟随.md", kind: "file" },
  { path: "表现输出/笔风规则", kind: "directory" },
  { path: "表现输出/笔风规则/克制叙述.md", kind: "file" },
  { path: "章节正文", kind: "directory" },
  { path: "章节正文/第一章 雨夜来信.md", kind: "file" },
]

const demoNodeIds = [
  "21111111-1111-4111-8111-111111111111",
  "31111111-1111-4111-8111-111111111111",
  "41111111-1111-4111-8111-111111111111",
  "51111111-1111-4111-8111-111111111111",
]

const demoMarkdownByPath: Readonly<Record<string, string>> = {
  "世界推演规则/基础规则/base-rules.md": "# Worldseed V1 基础规则\n\n本文件是平台锁定的只读基础规则投影，用于让用户查看底层推演约束。\n\n## 底层原则\n\n- 每轮推演只能依赖本轮实际读取的旧图、资料和本轮新产生的内容。\n- 用户输入是意图、行动或假设；若与已读事实冲突，不能直接当作世界真相提交。\n- 正式场景变化必须具有时间锚点和空间锚点，保证时间与空间连续。\n- 任何出现在正文中的对象、关系、状态和事件都应进入动态图，并优先复用已有节点。\n- 图治理以归档和重构为主，不物理删除仍有历史追溯价值的资料。\n",
  "世界推演规则/用户规则/人物出场节奏.md": "# 人物出场节奏\n\n- 优先复用已出现人物，让关系随行动和共同事件自然变化。\n- 新人物出现前，应说明其与当前场景、地点、势力或事件的连接理由。\n",
  "设定集/盐雾城.md": "# 盐雾城\n\n城市沿旧海堤向内河展开。雨季时，港区钟声会比城区早半刻钟传来。\n\n## 当前约束\n\n- 旧港封锁仍然有效。\n- 北桥是进入内河码头的唯一公开通道。\n",
  "参考文件/港口航运参考.md": "# 港口航运参考\n\n- 港口封锁会改变货物流向、城市物价和势力冲突密度。\n- 内河码头通常比外港更容易形成灰色交易网络。\n",
  "表现输出/描写规则/近景跟随.md": "# 近景跟随\n\n使用贴近角色感官的近景视角，优先描写角色能直接看到、听到、触碰和误解的事物。\n",
  "表现输出/笔风规则/克制叙述.md": "# 克制叙述\n\n减少解释性旁白，用动作、物件和对话暗示关系变化；避免一次性揭露过多设定。\n",
}

async function demoInvoke(method: BackendMethod, payload: unknown): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 120))
  switch (method) {
    case "project.create":
    case "project.open":
      return browserDemoProject
    case "project.validate":
    case "workspace.list":
      return { inventory: demoInventory, issues: [] }
    case "project.settings.read":
      return structuredClone(defaultProjectSettings)
    case "project.settings.save":
      return typeof payload === "object" && payload !== null && "settings" in payload
        ? (payload as { settings: ProjectSettings }).settings
        : structuredClone(defaultProjectSettings)
    case "workspace.read": {
      const relativePath = typeof payload === "object" && payload !== null && "relativePath" in payload
        ? String((payload as { relativePath: unknown }).relativePath)
        : ""
      if (relativePath.startsWith("章节正文/")) {
        const heading = relativePath.split("/").at(-1)?.replace(/\.md$/u, "") ?? "未命名章节"
        return {
          content: `# ${heading}\n\n雨落在北桥斑驳的石缝里，林序停住脚步，看见桥洞深处有一盏被风压低的灯。\n\n旧港封锁令仍然沿着水路发酵，内河码头的钟声比城区早半刻传来，像在提醒他：这里已经不是昨夜那个安静的入口。\n`,
        }
      }
      const content = demoMarkdownByPath[relativePath]
      if (content === undefined) throw new Error(`Browser demo missing Markdown fixture for ${relativePath}`)
      return { content }
    }
    case "workspace.save":
      return { saved: true }
    case "model.list":
      return {
        models: [
          { id: "deepseek-v4-flash", ownedBy: "deepseek" },
          { id: "deepseek-v4-pro", ownedBy: "deepseek" },
        ],
      }
    case "model.profiles.read":
      return {
        profiles: [
          { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", credentialRef: "model-profile:deepseek-v4-flash", apiKey: "", hasApiKey: false, thinkingModeEnabled: true, reasoningEffort: "high", jsonModeEnabled: false },
          { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", credentialRef: "model-profile:deepseek-v4-pro", apiKey: "", hasApiKey: false, thinkingModeEnabled: true, reasoningEffort: "high", jsonModeEnabled: false },
        ],
        activeProfileId: "deepseek-v4-flash",
      }
    case "model.profiles.save":
      return payload
    case "turn.start":
      return { taskId: "61111111-1111-4111-8111-111111111111", status: "created" }
    case "turn.status":
      return {
        status: "completed",
        result: {
          chapterPath: "章节正文/第二章 北桥灯火.md",
          chapterHeading: "第二章 北桥灯火",
          graphAnchorIds: demoNodeIds,
          modelCalls: 11,
          inputTokens: 18420,
          outputTokens: 3720,
          modelProvider: "demo",
          modelName: "browser-prototype",
          kvCacheHitRate: 0.68,
        },
      }
    case "graph.neighborhood": {
      const anchorIds = typeof payload === "object" && payload !== null && "anchorIds" in payload
        && Array.isArray((payload as { anchorIds: unknown }).anchorIds)
        ? (payload as { anchorIds: unknown[] }).anchorIds
        : demoNodeIds
      const offset = typeof payload === "object" && payload !== null && "anchorOffset" in payload
        ? Number((payload as { anchorOffset: unknown }).anchorOffset)
        : 0
      const limit = defaultProjectSettings.graph.maxNeighborhoodAnchors
      const nextOffset = Math.min(offset + limit, anchorIds.length)
      return {
        nodes: [
          { id: demoNodeIds[0], content: { text: "北桥灯火下的会面" } },
          { id: demoNodeIds[1], content: { anchor: "第十二日 21:10" } },
          { id: demoNodeIds[2], content: { anchor: "盐雾城北桥" } },
          { id: demoNodeIds[3], content: { text: "旧港封锁令" } },
        ],
        links: [
          { id: crypto.randomUUID(), fromNodeId: demoNodeIds[0], toNodeId: demoNodeIds[1], content: { note: "发生时间" } },
          { id: crypto.randomUUID(), fromNodeId: demoNodeIds[0], toNodeId: demoNodeIds[2], content: { note: "发生地点" } },
          { id: crypto.randomUUID(), fromNodeId: demoNodeIds[3], toNodeId: demoNodeIds[0], content: { note: "促成" } },
        ],
        truncated: nextOffset < anchorIds.length,
        anchorWindow: {
          requestedCount: anchorIds.length,
          processedCount: nextOffset - offset,
          offset,
          limit,
          remainingCount: anchorIds.length - nextOffset,
          ...(nextOffset < anchorIds.length ? { nextOffset } : {}),
        },
      }
    }
    default:
      throw new Error(`Browser demo does not implement ${method}`)
  }
}
