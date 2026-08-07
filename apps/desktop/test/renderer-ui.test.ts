import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { defaultProjectSettings } from "@worldseed/config"

import { invokeBackend } from "../src/renderer/src/api/client.js"
import { EditorArea } from "../src/renderer/src/features/editor/EditorArea.js"
import { RightRail } from "../src/renderer/src/features/status/RightRail.js"
import { ProjectSettingsDialog } from "../src/renderer/src/features/settings/ProjectSettingsDialog.js"
import { ModelConfigurationDialog } from "../src/renderer/src/features/settings/ModelConfigurationDialog.js"
import {
  mergeGraphSlices,
} from "../src/renderer/src/app/App.js"
import {
  buildGraphLevelsForLayout,
  graphContentLabel,
  WorldGraph,
} from "../src/renderer/src/features/status/WorldGraph.js"

vi.mock("@monaco-editor/react", () => ({
  Editor: (props: { value: string; options?: { readOnly?: boolean } }) => React.createElement(
    "div",
    {
      "data-testid": "mock-monaco-editor",
      "data-readonly": String(props.options?.readOnly ?? false),
    },
    props.value,
  ),
}))

vi.mock("sigma", () => ({
  default: class MockSigma {
    public on(): void {}
    public kill(): void {}
  },
}))

function editorDefaults(overrides: Partial<React.ComponentProps<typeof EditorArea>> = {}): React.ComponentProps<typeof EditorArea> {
  return {
    selectedPath: undefined,
    content: "",
    dirty: false,
    readOnly: false,
    running: false,
    prompt: "",
    descriptionRule: "",
    proseRule: "",
    minimumWordCount: "2000",
    maximumWordCount: "3000",
    wordCountValid: true,
    descriptionRules: ["表现输出/描写规则/近景跟随.md"],
    proseRules: ["表现输出/笔风规则/克制叙述.md"],
    onContentChange: vi.fn(),
    onHome: vi.fn(),
    onPromptChange: vi.fn(),
    onDescriptionRuleChange: vi.fn(),
    onProseRuleChange: vi.fn(),
    onMinimumWordCountChange: vi.fn(),
    onMaximumWordCountChange: vi.fn(),
    onSave: vi.fn(),
    onRun: vi.fn(),
    ...overrides,
  }
}

describe("renderer workbench UI contract", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders the creation desk as a distinct home state with prompt controls", () => {
    const html = renderToStaticMarkup(React.createElement(EditorArea, editorDefaults()))

    expect(html).toContain("创作台首页")
    expect(html).toContain("动态图召回")
    expect(html).toContain("表现控制")
    expect(html).toContain("本轮推演输入")
    expect(html).toContain("近景跟随.md")
    expect(html).toContain("克制叙述.md")
    expect(html).toContain("2000")
    expect(html).toContain("3000")
  })

  it("renders committed chapters through the chapter reader instead of the editor", () => {
    const html = renderToStaticMarkup(React.createElement(EditorArea, editorDefaults({
      selectedPath: "章节正文/第一章 雨夜来信.md",
      content: "# 第一章 雨夜来信\n\n雨落在旧港的铁皮屋顶上。\n\n林序听见桥下有人喊他的名字。",
      readOnly: true,
    })))

    expect(html).toContain("已提交章节")
    expect(html).toContain("第一章 雨夜来信")
    expect(html).toContain("雨落在旧港的铁皮屋顶上。")
    expect(html).not.toContain("mock-monaco-editor")
  })

  it("renders non-chapter Markdown through a read-only aware editor", () => {
    const html = renderToStaticMarkup(React.createElement(EditorArea, editorDefaults({
      selectedPath: "世界推演规则/基础规则/base-rules.md",
      content: "# 基础规则",
      readOnly: true,
    })))

    expect(html).toContain("mock-monaco-editor")
    expect(html).toContain("data-readonly=\"true\"")
    expect(html).toContain("# 基础规则")
  })

  it("exposes persisted thinking strength and JSON protocol controls per model", () => {
    const html = renderToStaticMarkup(React.createElement(ModelConfigurationDialog, {
      profiles: [{
        id: "deepseek-flash",
        name: "DeepSeek Flash",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        credentialRef: "model-profile:deepseek-flash",
        apiKey: "",
        hasApiKey: true,
        thinkingModeEnabled: true,
        reasoningEffort: "low",
        jsonModeEnabled: false,
      }],
      activeProfileId: "deepseek-flash",
      onClose: vi.fn(),
      onSave: vi.fn(),
    }))

    expect(html).toContain("深度思考")
    expect(html).toContain("思考强度")
    expect(html).toContain("value=\"low\" selected=\"\"")
    expect(html).toContain("JSON Mode")
  })
})

describe("right rail process UI contract", () => {
  it("shows an explicit model-in-flight state before a phase result returns", () => {
    const html = renderToStaticMarkup(React.createElement(RightRail, {
      graphSlice: undefined,
      task: {
        status: "running",
        lastPhase: "interpret",
        phaseRuns: [{
          phaseRunId: "phase-running",
          phase: "interpret",
          status: "running",
          attempt: 1,
          usage: {},
          startedAtMs: 1,
        }],
      },
    }))

    expect(html).toContain("已向模型发起请求")
    expect(html).toContain("等待 AI 返回结构化思考与输出")
  })

  it("shows cost, KV cache hit rate, and collapsible AI panels", () => {
    const html = renderToStaticMarkup(React.createElement(RightRail, {
      graphSlice: undefined,
      task: {
        status: "completed",
        result: {
          chapterPath: "章节正文/第二章 北桥灯火.md",
          chapterHeading: "第二章 北桥灯火",
          graphAnchorIds: [],
          modelCalls: 3,
          inputTokens: 1200,
          outputTokens: 450,
          modelProvider: "deepseek",
          modelName: "deepseek-v4-flash",
          kvCacheHitRate: 0.68,
        },
        phaseRuns: [{
          phaseRunId: "phase-1",
          phase: "interpret",
          status: "completed",
          attempt: 1,
          result: {
            reason: "读取当前场景锚点",
            selfReview: "依赖合理",
            artifact: { intent: "观察周围" },
          },
          usage: {},
          startedAtMs: 1,
          finishedAtMs: 2,
        }],
      },
    }))

    expect(html).toContain("deepseek / deepseek-v4-flash")
    expect(html).toContain("68%")
    expect(html).toContain("AI 思考")
    expect(html).toContain("AI 输出")
    expect(html).toContain("读取当前场景锚点")
    expect(html).toContain("审查正文响应")
    expect(html).toContain("压缩动态上下文")
    expect(html).toContain("尚未进入该阶段")
  })
})

describe("browser demo client contract", () => {
  it("returns the platform base rules for the base-rules path", async () => {
    const result = await invokeBackend<{ content: string }>("workspace.read", {
      relativePath: "世界推演规则/基础规则/base-rules.md",
    })

    expect(result.content).toContain("# Worldseed V1 基础规则")
    expect(result.content).toContain("平台锁定")
    expect(result.content).not.toContain("# 盐雾城")
  })

  it("returns chapter Markdown whose heading follows the requested chapter path", async () => {
    const result = await invokeBackend<{ content: string }>("workspace.read", {
      relativePath: "章节正文/第二章 北桥灯火.md",
    })

    expect(result.content).toContain("# 第二章 北桥灯火")
  })

  it("loads and saves project settings through the same backend contract", async () => {
    const loaded = await invokeBackend("project.settings.read", {})
    const saved = await invokeBackend("project.settings.save", {
      settings: {
        ...defaultProjectSettings,
        graph: { ...defaultProjectSettings.graph, maxDirectOutDegree: 18 },
      },
    })

    expect(loaded).toEqual(defaultProjectSettings)
    expect(saved).toMatchObject({ graph: { maxDirectOutDegree: 18 } })
  })
})

describe("project settings UI contract", () => {
  it("provides one IDEA-style entry for execution, retrieval, graph, and model settings", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectSettingsDialog, {
      projectName: "雾港纪事",
      settings: defaultProjectSettings,
      activeModelName: "DeepSeek Chat",
      onClose: vi.fn(),
      onSave: vi.fn(),
      onOpenModelSettings: vi.fn(),
    }))

    expect(html).toContain("设置 / 雾港纪事")
    expect(html).toContain("推演执行")
    expect(html).toContain("资料检索")
    expect(html).toContain("世界图")
    expect(html).toContain("模型服务")
    expect(html).toContain("最大模型调用次数")
    expect(html).toContain("下一轮推演开始生效")
  })
})

describe("world graph layout contract", () => {
  const graphSlice = {
    nodes: [
      { id: "scene", content: { text: "北桥灯火下的会面" } },
      { id: "time", content: { anchor: "第十二日 21:10" } },
      { id: "place", content: { anchor: "盐雾城北桥" } },
      { id: "policy", content: { note: "旧港封锁令" } },
    ],
    links: [
      { id: "l1", fromNodeId: "scene", toNodeId: "time", content: { note: "发生时间" } },
      { id: "l2", fromNodeId: "scene", toNodeId: "place", content: { note: "发生地点" } },
      { id: "l3", fromNodeId: "policy", toNodeId: "scene", content: { note: "促成" } },
    ],
    truncated: false,
  }

  it("creates deterministic layered levels without dropping disconnected roots", () => {
    expect(buildGraphLevelsForLayout(graphSlice)).toEqual([
      ["policy"],
      ["scene"],
      ["time", "place"],
    ])
  })

  it("extracts readable labels from generic graph payloads", () => {
    expect(graphContentLabel({ name: "林序" })).toBe("林序")
    expect(graphContentLabel({ title: "旧港封锁" })).toBe("旧港封锁")
    expect(graphContentLabel({ note: "桥下钥匙" })).toBe("桥下钥匙")
    expect(graphContentLabel(null)).toBe("未命名节点")
  })

  it("merges confirmed graph windows without duplicating nodes or links", () => {
    const merged = mergeGraphSlices({
      nodes: graphSlice.nodes.slice(0, 2),
      links: graphSlice.links.slice(0, 1),
      truncated: true,
    }, {
      nodes: graphSlice.nodes.slice(1, 4),
      links: graphSlice.links,
      truncated: false,
      anchorWindow: {
        requestedCount: 40,
        processedCount: 8,
        offset: 32,
        limit: 32,
        remainingCount: 0,
      },
    })

    expect(merged.nodes).toHaveLength(4)
    expect(merged.links).toHaveLength(3)
    expect(merged.truncated).toBe(false)
    expect(merged.anchorWindow?.remainingCount).toBe(0)
  })

  it("renders an empty state before a graph slice is available", () => {
    const html = renderToStaticMarkup(React.createElement(WorldGraph, { slice: undefined }))

    expect(html).toContain("完成一轮推演后")
    expect(html).toContain("出度 12")
    expect(html).toContain("分层避碰")
  })

  it("renders graph capacity values from project settings instead of fixed chips", () => {
    const html = renderToStaticMarkup(React.createElement(WorldGraph, {
      slice: undefined,
      settings: {
        ...defaultProjectSettings.graph,
        maxDirectOutDegree: 18,
        maxDirectInDegree: 16,
        mergeWarningThreshold: 14,
      },
    }))

    expect(html).toContain("出度 18")
    expect(html).toContain("入度 16")
    expect(html).toContain("合并预警 14")
  })
})
