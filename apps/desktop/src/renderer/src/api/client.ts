import {
  PROTOCOL_VERSION,
  type BackendMethod,
  type ClientRequest,
} from "@worldseed/contracts"

export type OpenProject = Readonly<{
  projectId: string
  displayName: string
  workspaceRootRef: string
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
  kvCacheHitRate?: number
}>

export type TaskSnapshot = Readonly<{
  status: string
  lastPhase?: string
  result?: TurnResult
  error?: { message?: string }
}>

export type GraphSlice = Readonly<{
  nodes: readonly { id: string; content: unknown; metadata?: Record<string, unknown> }[]
  links: readonly { id: string; fromNodeId: string; toNodeId: string; content?: unknown }[]
  truncated: boolean
}>

export async function invokeBackend<T>(method: BackendMethod, payload: unknown): Promise<T> {
  if (window.worldseed === undefined) return demoInvoke(method) as T
  const request: ClientRequest = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    method,
    payload,
  }
  const response = await window.worldseed.invoke(request)
  if (!response.ok) throw new Error(response.error.message)
  return response.data as T
}

export async function selectDirectory(): Promise<string | undefined> {
  return window.worldseed?.selectDirectory() ?? "C:\\Worldseed\\雾港纪事"
}

export const browserDemoProject: OpenProject | undefined = window.worldseed === undefined ? {
  projectId: "11111111-1111-4111-8111-111111111111",
  displayName: "雾港纪事",
  workspaceRootRef: "C:\\Worldseed\\雾港纪事",
} : undefined

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

async function demoInvoke(method: BackendMethod): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 120))
  switch (method) {
    case "project.create":
    case "project.open":
      return browserDemoProject
    case "project.validate":
    case "workspace.list":
      return { inventory: demoInventory, issues: [] }
    case "workspace.read":
      return { content: "# 盐雾城\n\n城市沿旧海堤向内河展开。雨季时，港区钟声会比城区早半刻钟传来。\n\n## 当前约束\n\n- 旧港封锁仍然有效。\n- 北桥是进入内河码头的唯一公开通道。\n" }
    case "workspace.save":
      return { saved: true }
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
          kvCacheHitRate: 0.68,
        },
      }
    case "graph.neighborhood":
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
        truncated: false,
      }
    default:
      throw new Error(`Browser demo does not implement ${method}`)
  }
}
