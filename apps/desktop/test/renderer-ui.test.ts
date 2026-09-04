import React, { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { defaultProjectSettings } from "@worldseed/config"
import type { RuntimeMetricsSnapshot } from "@worldseed/contracts"

import { invokeBackend } from "../src/renderer/src/api/client.js"
import { EditorArea } from "../src/renderer/src/features/editor/EditorArea.js"
import { ChapterWorkspaceRail } from "../src/renderer/src/features/editor/ChapterWorkspaceRail.js"
import { ChapterWorkspaceToolbar } from "../src/renderer/src/features/editor/ChapterWorkspaceToolbar.js"
import { ChapterDraftVersionsPrototype } from "../src/renderer/src/features/editor/ChapterDraftVersionsPrototype.js"
import { CreationDeskProgressReview } from "../src/renderer/src/features/editor/CreationDeskProgressReview.js"
import { RightRail } from "../src/renderer/src/features/status/RightRail.js"
import { RightPanelViewport } from "../src/renderer/src/features/status/RightPanelViewport.js"
import { HistoryPanel } from "../src/renderer/src/features/status/HistoryPanel.js"
import { TaskCheckpointDialog, resolveCheckpointPauseReason } from "../src/renderer/src/features/status/TaskCheckpointPrototype.js"
import { ProjectSettingsDialog } from "../src/renderer/src/features/settings/ProjectSettingsDialog.js"
import { ModelConfigurationDialog } from "../src/renderer/src/features/settings/ModelConfigurationDialog.js"
import {
  mergeGraphSlices,
  shouldMonitorChapterRevision,
} from "../src/renderer/src/app/App.js"
import {
  buildGraphLevelsForLayout,
  GraphContentView,
  graphContentLabel,
  graphFieldLabel,
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
  loader: { config: () => {} },
}))

vi.mock("monaco-editor", () => ({
  editor: {
    defineTheme: () => {},
    setTheme: () => {},
  },
}))

vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  default: class {},
}))

vi.mock("../src/renderer/src/monaco.js", () => ({
  WORLDSEED_EDITOR_THEME: "worldseed-dark",
  ensureWorldseedEditorTheme: () => {},
}))

vi.mock("sigma", () => ({
  default: class MockSigma {
    public on(): void {}
    public kill(): void {}
    public refresh(): void {}
  },
}))

function renderPortaledHtml(element: React.ReactElement): string {
  const mount = document.createElement("div")
  document.body.appendChild(mount)
  const root = createRoot(mount)
  act(() => { root.render(element) })
  const html = document.body.innerHTML
  act(() => { root.unmount() })
  mount.remove()
  return html
}

function editorDefaults(overrides: Partial<React.ComponentProps<typeof EditorArea>> = {}): React.ComponentProps<typeof EditorArea> {
  return {
    selectedPath: undefined,
    content: "",
    chapterBody: "",
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
    boundaryPace: "advance_allowed",
    causalityFocus: "auto",
    onContentChange: vi.fn(),
    onHome: vi.fn(),
    onPromptChange: vi.fn(),
    onDescriptionRuleChange: vi.fn(),
    onProseRuleChange: vi.fn(),
    onMinimumWordCountChange: vi.fn(),
    onMaximumWordCountChange: vi.fn(),
    onBoundaryPaceChange: vi.fn(),
    onCausalityFocusChange: vi.fn(),
    onSave: vi.fn(),
    onRun: vi.fn(),
    onEnsureRevision: vi.fn(async () => undefined),
    onUpdateRevision: vi.fn(async () => { throw new Error("updateRevision not mocked") }),
    onReviewRevision: vi.fn(async () => { throw new Error("reviewRevision not mocked") }),
    onSubmitRevision: vi.fn(async () => { throw new Error("submitRevision not mocked") }),
    onRetireRevision: vi.fn(async () => { throw new Error("retireRevision not mocked") }),
    chapterConversationMessages: [],
    projectId: "project-test",
    workspaceRootRef: "C:\\Worldseed\\test",
    synopsisSession: undefined,
    synopsisMessages: [],
    synopsisBusy: false,
    onSynopsisSend: vi.fn(async () => {}),
    onOpenSynopsisFile: vi.fn(),
    diffFocusMessageId: undefined,
    onDiffFocusHandled: vi.fn(),
    ...overrides,
  }
}

function runtimeMetricsFixture(modelCalls: number, inputTokens: number, outputTokens: number, kvRate = 0): RuntimeMetricsSnapshot {
  return {
    taskId: "task-runtime",
    capturedAtMs: 10,
    metrics: [
      { metricId: "model_calls", label: "模型调用", scope: "turn_window", unit: "count", current: modelCalls, limit: 400, cumulative: modelCalls, state: "normal", blocking: false, resettable: true, resetMode: "new_window", resetGeneration: 0, lastResetAt: null, description: "调用窗口" },
      { metricId: "input_tokens", label: "输入 Token", scope: "turn_window", unit: "tokens", current: inputTokens, limit: null, cumulative: inputTokens, state: "fixed", blocking: false, resettable: false, resetMode: "provider_fixed", resetGeneration: 0, lastResetAt: null, description: "输入累计" },
      { metricId: "output_tokens", label: "输出 Token", scope: "turn_window", unit: "tokens", current: outputTokens, limit: null, cumulative: outputTokens, state: "fixed", blocking: false, resettable: false, resetMode: "provider_fixed", resetGeneration: 0, lastResetAt: null, description: "输出累计" },
      { metricId: "wall_time", label: "执行时间", scope: "turn_window", unit: "milliseconds", current: 60_000, limit: 120_000, cumulative: 60_000, state: "normal", blocking: false, resettable: true, resetMode: "new_window", resetGeneration: 0, lastResetAt: null, description: "执行时间" },
      { metricId: "context_tokens", label: "活动上下文", scope: "context_window", unit: "tokens", current: 100_000, limit: 970_000, cumulative: 100_000, state: "normal", blocking: false, resettable: false, resetMode: "provider_fixed", resetGeneration: 0, lastResetAt: null, description: "活动上下文" },
      { metricId: "retrieval_rounds", label: "当前阶段检索轮次", scope: "phase", unit: "count", current: 1, limit: 10, cumulative: null, state: "normal", blocking: false, resettable: false, resetMode: "provider_fixed", resetGeneration: 0, lastResetAt: null, description: "检索轮次" },
      { metricId: "compression_generation", label: "上下文压缩代次", scope: "context_window", unit: "generation", current: 1, limit: null, cumulative: 1, state: "fixed", blocking: false, resettable: false, resetMode: "provider_fixed", resetGeneration: 0, lastResetAt: null, description: "压缩代次" },
      { metricId: "kv_cache_hit_rate", label: "KV 缓存命中率", scope: "task_total", unit: "ratio", current: kvRate, limit: null, cumulative: kvRate, state: "fixed", blocking: false, resettable: false, resetMode: "provider_fixed", resetGeneration: 0, lastResetAt: null, description: "缓存命中" },
    ],
  }
}

describe("renderer workbench UI contract", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders the creation desk as a full-height conversation workspace", () => {
    const html = renderToStaticMarkup(React.createElement(EditorArea, editorDefaults()))

    expect(html).toContain("data-testid=\"synopsis-conversation\"")
    expect(html).toContain("creation-desk-workspace")
    expect(html).toContain("剧情梗概讨论")
    expect(html).toContain("data-testid=\"creation-desk-toolbar\"")
    expect(html).toContain("data-testid=\"creation-desk-goals-trigger\"")
    expect(html).toContain("data-testid=\"creation-desk-advanced-trigger\"")
    expect(html).not.toContain("data-testid=\"creation-desk-start-turn\"")
    expect(html).not.toContain("创作台首页")
    expect(html).not.toContain("从本轮输入开始")
    expect(html).toContain("近景跟随.md")
    expect(html).toContain("克制叙述.md")
    expect(html).toContain("2000")
    expect(html).toContain("3000")
    expect(html).toContain("边界节奏")
    expect(html).toContain("可推进（仍贴梗概）")
    expect(html).toContain("因果焦点")
    expect(html).toContain("自动")
    expect(html).not.toContain("data-testid=\"creation-desk-jump-latest\"")
  })

  it("detects when the creation-desk thread is away from the latest messages", async () => {
    const { isCreationDeskNearBottom } = await import("../src/renderer/src/features/editor/SynopsisConversationComposer.js")
    expect(isCreationDeskNearBottom({ scrollHeight: 1200, scrollTop: 1100, clientHeight: 100 })).toBe(true)
    expect(isCreationDeskNearBottom({ scrollHeight: 1200, scrollTop: 200, clientHeight: 100 })).toBe(false)
  })

  it("renders post-turn progress review actions for locked planned rows", () => {
    const html = renderToStaticMarkup(React.createElement(CreationDeskProgressReview, {
      items: [{
        goal: {
          goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          projectId: "11111111-1111-4111-8111-111111111111",
          content: "林序查清名单来源",
          source: "user",
          lifecycle: "active",
          createdAtMs: 1,
          updatedAtMs: 1,
        },
        progress: {
          progressId: "22222222-2222-4222-8222-222222222222",
          projectId: "11111111-1111-4111-8111-111111111111",
          goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          chapterSequence: 1,
          summary: "获得登记簿副本",
          status: "planned",
          source: "synopsis_discuss",
          lockedAtMs: 100,
          recordedAtMs: 100,
        },
      }],
      onReview: async () => {},
    }))

    expect(html).toContain("data-testid=\"creation-desk-progress-review\"")
    expect(html).toContain("data-testid=\"creation-desk-progress-review-card\"")
    expect(html).toContain("data-testid=\"creation-desk-review-achieved\"")
    expect(html).toContain("data-testid=\"creation-desk-review-partial\"")
    expect(html).toContain("data-testid=\"creation-desk-review-missed\"")
    expect(html).toContain("获得登记簿副本")
  })

  it("renders committed chapters through the chapter reader instead of the editor", () => {
    const html = renderToStaticMarkup(React.createElement(EditorArea, editorDefaults({
      selectedPath: "章节正文/第一章 雨夜来信.md",
      content: "# 第一章 雨夜来信\n\n雨落在旧港的铁皮屋顶上。\n\n林序听见桥下有人喊他的名字。",
      chapterBody: "雨落在旧港的铁皮屋顶上。\n\n林序听见桥下有人喊他的名字。",
      chapter: { chapterId: "chapter-1", sourceId: "source-1", heading: "第一章 雨夜来信" },
      readOnly: true,
    })))

    expect(html).toContain("章节草稿")
    expect(html).not.toContain("data-testid=\"chapter-workspace-toolbar\"")
    expect(html).toContain("data-testid=\"chapter-reading-toolbar\"")
    expect(html).toContain("data-testid=\"chapter-editor-chrome-toggle\"")
    expect(html).toContain("aria-expanded=\"false\"")
    expect(html).toContain("第一章 雨夜来信")
    expect(html).toContain("雨落在旧港的铁皮屋顶上。")
    expect(html).toContain("mock-monaco-editor")
  })

  it("renders committed and draft document tabs during agent revision", () => {
    const html = renderToStaticMarkup(React.createElement(EditorArea, editorDefaults({
      selectedPath: "章节正文/第一章 世界种子.md",
      content: "# 第一章 世界种子\n\n正式正文。",
      chapterBody: "正式正文。",
      chapter: { chapterId: "chapter-1", sourceId: "source-1", heading: "第一章 世界种子" },
      revision: {
        revisionTaskId: "revision-1",
        projectId: "project-1",
        chapterId: "chapter-1",
        baseSourceId: "source-1",
        proposedSourceId: "source-2",
        heading: "第一章 世界种子",
        contentDigest: "digest-2",
        inputMode: "agent",
        decision: "pending",
        graphSyncStatus: "not_started",
        status: "editing",
        createdAtMs: 1,
        updatedAtMs: 2,
      },
      chapterConversationMessages: [{
        messageId: "message-1",
        revisionTaskId: "revision-1",
        projectId: "project-1",
        role: "assistant",
        content: "我已扩展正文。",
        proposal: { heading: "第一章 世界种子", body: "正式正文。\n\nAgent 扩写段落。" },
        createdAtMs: 2,
      }],
    })))

    expect(html).toContain("data-testid=\"chapter-document-switch\"")
    expect(html).toContain("data-testid=\"chapter-document-committed\"")
    expect(html).toContain("data-testid=\"chapter-document-draft\"")
    expect(html).toContain("data-testid=\"chapter-draft-version-create\"")
    expect(html).toContain("data-testid=\"chapter-editor-status-bar\"")
    expect(html).toContain("data-testid=\"chapter-editor-status-saved\"")
    expect(html).toContain("data-testid=\"chapter-editor-status-words\"")
    expect(html).toContain("aria-label=\"创建新草稿\"")
    expect(html).toContain("Agent 扩写段落。")
    expect(html).not.toContain("data-testid=\"chapter-conversation\"")
  })

  it("renders revision actions in the chapter header toolbar", () => {
    const html = renderToStaticMarkup(React.createElement(ChapterDraftVersionsPrototype, {
      versions: [{
        versionId: "proto-v0",
        parentVersionId: undefined,
        source: "baseline",
        label: "正文",
        heading: "第一章",
        body: "正文。",
        messageId: undefined,
        createdAtMs: 0,
      }, {
        versionId: "proto-v1",
        parentVersionId: "proto-v0",
        source: "manual",
        label: "v1 最新",
        heading: "第一章",
        body: "草稿。",
        messageId: undefined,
        createdAtMs: 1,
      }],
      latestVersionId: "proto-v1",
      selectedVersionId: "proto-v1",
      displayMode: "edit",
      busy: false,
      showRevisionActions: true,
      revisionStage: "idle",
      draftChanged: true,
      onReview: vi.fn(),
      onDirectSubmit: vi.fn(),
      onReviewedSubmit: vi.fn(),
      onSelectVersion: vi.fn(),
      onEnterDiff: vi.fn(),
      onReturnEdit: vi.fn(),
      onRestore: vi.fn(async () => {}),
      onCreateDraft: vi.fn(),
    }))

    expect(html).toContain("data-testid=\"chapter-revision-actions\"")
    expect(html).toContain("aria-label=\"审核修订\"")
    expect(html).toContain("aria-label=\"直接提交\"")
    expect(html).not.toContain("放弃修订")
  })

  it("renders chapter workspace rail with conversation only", () => {
    const html = renderToStaticMarkup(React.createElement(ChapterWorkspaceRail, {
      messages: [],
      revisionTaskId: "revision-1",
      busy: false,
      chapterSynopsis: undefined,
      synopsisPanelOpen: false,
      onToggleSynopsisPanel: vi.fn(),
      onSend: vi.fn(),
      onInspectDiff: vi.fn(),
    }))

    expect(html).toContain("data-testid=\"chapter-workspace-rail\"")
    expect(html).toContain("剧情梗概")
    expect(html).not.toContain("章节修订")
    expect(html).not.toContain("data-testid=\"chapter-revision-actions\"")
    expect(html).not.toContain("data-testid=\"chapter-reading-toolbar\"")
    expect(html).toContain("data-testid=\"chapter-conversation\"")
    expect(html).toContain("Agent 对话")
  })

  it("mounts only the active right panel layer", () => {
    const html = renderToStaticMarkup(React.createElement(RightPanelViewport, {
      chapterMode: true,
      chapterPanel: React.createElement("div", { "data-testid": "chapter-panel" }, "chapter"),
      defaultPanel: React.createElement("div", { "data-testid": "default-panel" }, "default"),
    }))

    expect(html).toContain("data-testid=\"right-panel-viewport\"")
    expect(html).toContain("right-panel-layer active")
    expect(html).toContain("data-testid=\"chapter-panel\"")
    expect(html).not.toContain("right-panel-layer inactive")
    expect(html).not.toContain("data-testid=\"default-panel\"")
  })

  it("renders draft workspace with unified revision actions", () => {
    const html = renderToStaticMarkup(React.createElement(EditorArea, editorDefaults({
      selectedPath: "章节正文/第一章 雨夜来信.md",
      content: "# 第一章 雨夜来信\n\n正式正文。",
      chapter: { chapterId: "chapter-1", sourceId: "source-1", heading: "第一章 雨夜来信" },
      revision: {
        revisionTaskId: "revision-1",
        projectId: "project-1",
        chapterId: "chapter-1",
        baseSourceId: "source-1",
        proposedSourceId: "source-2",
        heading: "第一章 雨夜来信",
        contentDigest: "digest-2",
        inputMode: "agent",
        decision: "pending",
        graphSyncStatus: "not_started",
        status: "editing",
        createdAtMs: 1,
        updatedAtMs: 2,
      },
      chapterBody: "正式正文。",
      revisionContent: "修改后的正文。",
    })))

    expect(html).toContain("修改后的正文。")
    expect(html).toContain("mock-monaco-editor")
    expect(html).not.toContain("revision-workspace")
    expect(html).not.toContain("data-testid=\"chapter-workspace-toolbar\"")
  })

  it("disables review and direct submit when draft matches committed body", () => {
    const html = renderToStaticMarkup(React.createElement(ChapterWorkspaceToolbar, {
      preferences: { fontFamily: "serif", fontSize: 16, lineHeight: "relaxed" },
      paneLabel: "草稿",
      wordCount: 4,
      onReadingChange: vi.fn(),
      showActions: true,
      statusHint: undefined,
      stage: "idle",
      changed: false,
      busy: false,
      error: undefined,
      onReview: vi.fn(),
      onDirectSubmit: vi.fn(),
      onReviewedSubmit: vi.fn(),
    }))

    expect(html).toContain("修改草稿后可审核或提交")
    expect(html).toMatch(/revision-secondary-command"[^>]*disabled/)
    expect(html).toMatch(/revision-primary-command"[^>]*disabled/)
  })

  it("shows blocked revision hint in the default chapter toolbar", () => {
    const html = renderToStaticMarkup(React.createElement(ChapterWorkspaceToolbar, {
      preferences: { fontFamily: "serif", fontSize: 16, lineHeight: "relaxed" },
      paneLabel: "草稿",
      wordCount: 4,
      onReadingChange: vi.fn(),
      showActions: false,
      statusHint: "历史草稿仅可查看，请返回最新版本后再审核或提交",
      stage: "idle",
      changed: true,
      busy: false,
      error: undefined,
      onReview: vi.fn(),
      onDirectSubmit: vi.fn(),
      onReviewedSubmit: vi.fn(),
    }))

    expect(html).toContain("data-testid=\"chapter-revision-blocked-hint\"")
    expect(html).toContain("历史草稿仅可查看")
    expect(html).not.toContain("data-testid=\"chapter-revision-actions\"")
  })

  it("does not expose editing controls after chapter content enters graph synchronization", () => {
    const html = renderToStaticMarkup(React.createElement(EditorArea, editorDefaults({
      selectedPath: "章节正文/第一章 雨夜来信.md",
      content: "# 第一章 雨夜来信\n\n修改后的正文。",
      chapterBody: "修改后的正文。",
      chapter: { chapterId: "chapter-1", sourceId: "source-2", heading: "第一章 雨夜来信" },
      revision: {
        revisionTaskId: "revision-1",
        projectId: "project-1",
        chapterId: "chapter-1",
        baseSourceId: "source-1",
        proposedSourceId: "source-2",
        heading: "第一章 雨夜来信",
        contentDigest: "digest-2",
        decision: "submit",
        graphSyncStatus: "pending",
        status: "graph_sync_pending",
        createdAtMs: 1,
        updatedAtMs: 2,
      },
      revisionContent: "修改后的正文。",
      readOnly: true,
    })))

    expect(html).toContain("继续图同步")
    expect(html).not.toContain("图同步中")
    expect(html).not.toContain("修订检查")
    expect(html).not.toContain("审核后提交")
  })

  it("only monitors graph synchronization after the backend reports it running", () => {
    expect(shouldMonitorChapterRevision("pending")).toBe(false)
    expect(shouldMonitorChapterRevision("running")).toBe(true)
    expect(shouldMonitorChapterRevision("completed")).toBe(false)
    expect(shouldMonitorChapterRevision("failed")).toBe(false)
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
  it("renders backend runtime descriptors instead of front-end default limits", () => {
    const html = renderToStaticMarkup(React.createElement(RightRail, {
      graphSlice: undefined,
      task: {
        handle: { taskId: "task-metrics", status: "paused" },
        status: "paused",
        runtimeMetrics: {
          taskId: "task-metrics",
          capturedAtMs: 10,
          metrics: [{
            metricId: "model_calls",
            label: "模型调用",
            scope: "turn_window",
            unit: "count",
            current: 7,
            limit: 9,
            cumulative: 17,
            state: "warning",
            blocking: false,
            resettable: true,
            resetMode: "new_window",
            resetGeneration: 2,
            lastResetAt: 9,
            description: "后端额度窗口",
          }],
        },
      },
    }))

    expect(html).not.toContain("7 / 9")
    expect(html).not.toContain("累计 17")
    expect(html).not.toContain("0 / 10")
    expect(html.split("class=\"phase-list\"")[0]).not.toContain("当前阶段检索轮次")
    expect(html).toContain("压缩次数")
  })

  it("shows task token summary under world-summary", () => {
    const html = renderToStaticMarkup(React.createElement(RightRail, {
      graphSlice: undefined,
      contextWindowTokens: 128_000,
      task: {
        handle: { taskId: "task-tokens", status: "completed" },
        status: "completed",
        phaseRuns: [
          {
            phaseRunId: "pr1",
            phase: "interpret",
            status: "completed",
            startedAtMs: 1,
            finishedAtMs: 2,
            usage: {
              inputTokens: 1_000,
              outputTokens: 200,
              cacheHitInputTokens: 700,
              cacheMissInputTokens: 300,
              lastRequestInputTokens: 1_000,
            },
          },
          {
            phaseRunId: "pr2",
            phase: "draft",
            status: "completed",
            startedAtMs: 3,
            finishedAtMs: 4,
            usage: {
              inputTokens: 2_000,
              outputTokens: 800,
              cacheHitInputTokens: 1_000,
              cacheMissInputTokens: 1_000,
              lastRequestInputTokens: 2_000,
            },
          },
        ],
      },
    }))
    expect(html).toContain("推演 KV 命中率")
    expect(html).toContain("57%")
    expect(html).toContain("推演总 Token")
    expect(html).toContain("4.0k")
    expect(html).toContain("推演上下文 / 最大上下文")
    expect(html).toContain("2.0k / 128.0k")
  })

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
    expect(html).toContain("等待 AI 返回思考记录与正式输出")
    expect(html).toContain("等待后端返回运行指标")
  })

  it("omits the redundant text status column from phase rows", () => {
    const html = renderToStaticMarkup(React.createElement(RightRail, {
      graphSlice: undefined,
      task: { status: "paused" },
    }))

    const phaseList = html.slice(html.indexOf('class="phase-list"'))
    expect(phaseList).not.toContain("<em>")
    expect(phaseList).toContain("<span class=\"phase-icon\"><svg")
  })

  it("keeps phase status icons without rendering text labels", () => {
    const html = renderToStaticMarkup(React.createElement(RightRail, {
      graphSlice: undefined,
      task: {
        status: "running",
        phaseRuns: [
          { phaseRunId: "completed", phase: "interpret", status: "completed", attempt: 1, usage: {}, startedAtMs: 1, finishedAtMs: 2 },
          { phaseRunId: "running", phase: "rule_assembly", status: "running", attempt: 1, usage: {}, startedAtMs: 3 },
          { phaseRunId: "failed", phase: "source_retrieval", status: "failed", attempt: 1, usage: {}, startedAtMs: 4 },
        ],
      },
    }))

    expect(html).not.toContain("<em>已完成</em>")
    expect(html).not.toContain("<em>进行中</em>")
    expect(html).not.toContain("<em>失败</em>")
    expect(html).toContain("class=\"phase-icon\"")
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
            modelReasoning: "**正在判断当前场景所需的时空锚点。**",
            modelReasoningKind: "provider_summary",
            reason: "读取当前场景锚点",
            selfReview: "依赖合理",
            artifact: { intent: "观察周围" },
          },
          usage: {
            modelCalls: 3,
            inputTokens: 1200,
            outputTokens: 450,
            cacheHitInputTokens: 816,
            cacheMissInputTokens: 384,
          },
          startedAtMs: 1,
          finishedAtMs: 2,
        }],
        runtimeMetrics: runtimeMetricsFixture(3, 1200, 450, 0.68),
      },
    }))

    expect(html).not.toContain("实际运行模型")
    expect(html).not.toContain("3 / 400")
    expect(html).not.toContain("1.2k / 只读")
    expect(html).not.toContain("450 / 只读")
    expect(html).toContain("68%")
    expect((html.match(/class=\"runtime-ring-card/g) ?? []).length).toBe(4)
    expect(html).not.toContain("runtime-counter")
    expect(html).not.toContain("1 / 10 / 10")
    expect(html).toContain("执行时间")
    expect(html).toContain("活动上下文长度")
    expect(html).toContain("KV 缓存平均命中率")
    expect(html).toContain("ui-tooltip-anchor")
    expect(html.split("class=\"phase-list\"")[0]).not.toContain("当前阶段检索轮次")
    expect(html).toContain("压缩次数")
    expect(html).toContain("1 活动链累计")
    expect(html).toContain("AI 思考摘要")
    expect(html).toContain("AI 输出")
    expect(html).toContain("<strong>正在判断当前场景所需的时空锚点。</strong>")
    expect(html).not.toContain("**正在判断")
    expect(html).not.toContain("modelReasoning")
    expect(html).not.toContain("modelReasoningKind")
    expect(html).toContain("运行监控")
    expect(html).not.toContain("最近稳定检查点")
    expect(html).not.toContain("实时状态")
    expect(html).toContain("全部重置")
    expect(html).toContain("读取当前场景锚点")
    expect(html).toContain("审查正文响应")
    expect(html).toContain("尚未进入该阶段")
    expect(html).toContain("平均上下文请求 Token 数")
    expect(html).toContain("平均 AI 请求数")
    expect(html).toContain("平均 KV 缓存命中率")
    expect(html).toContain("平均请求时间")
    expect(html).toContain("当前阶段检索轮次")
    expect(html).toContain("ui-tooltip-anchor")
    expect(html).toContain("平均上下文请求 Token 数: 400")
    expect(html).toContain("68%")
  })

  it("shows advisory continuity results collapsed without changing the completed task state", () => {
    const html = renderToStaticMarkup(React.createElement(RightRail, {
      graphSlice: undefined,
      task: {
        status: "completed",
        lastPhase: "commit_review",
        phaseRuns: [{
          phaseRunId: "phase-commit",
          phase: "commit_review",
          status: "completed",
          attempt: 1,
          result: {
            artifact: {
              recommendation: "commit",
              continuityAdvice: [{
                claimRef: "claim:one",
                proseExcerpt: "昨天留下的痕迹仍在。",
                verdict: "conflict",
                summary: "相对时间与当前场景入口不一致",
                evidenceRefs: ["evidence_1"],
                suggestedDirection: "改成与当前场景时间一致的表达。",
              }],
              finalSelfReview: "建议不阻断提交",
            },
          },
          usage: {},
          startedAtMs: 1,
          finishedAtMs: 2,
        }],
      },
    }))

    expect(html).toContain("连续性建议")
    expect(html).toContain("昨天留下的痕迹仍在。")
    expect(html).toContain("冲突")
    expect(html).toContain("改成与当前场景时间一致的表达。")
    expect(html).toContain("completed")
    expect(html).not.toContain("class=\"task-error\"")
    expect(html).not.toContain("<details class=\"continuity-advice\" open=\"\"")
  })

  it("updates the process view when another phase run is returned", () => {
    const baseTask = {
      status: "running",
      lastPhase: "interpret",
      phaseRuns: [{
        phaseRunId: "phase-1",
        phase: "interpret",
        status: "completed",
        attempt: 1,
        usage: { modelCalls: 1, inputTokens: 100, outputTokens: 40 },
        startedAtMs: 1,
        finishedAtMs: 2,
      }],
      runtimeMetrics: runtimeMetricsFixture(1, 100, 40),
    } as const
    const updatedTask = {
      ...baseTask,
      lastPhase: "rule_assembly",
      phaseRuns: [...baseTask.phaseRuns, {
        phaseRunId: "phase-2",
        phase: "rule_assembly",
        status: "completed",
        attempt: 1,
        usage: { modelCalls: 2, inputTokens: 250, outputTokens: 60 },
        startedAtMs: 3,
        finishedAtMs: 4,
      }],
      runtimeMetrics: runtimeMetricsFixture(3, 350, 100),
    } as const

    const initialHtml = renderToStaticMarkup(React.createElement(RightRail, { graphSlice: undefined, task: baseTask }))
    const updatedHtml = renderToStaticMarkup(React.createElement(RightRail, { graphSlice: undefined, task: updatedTask }))

    expect(initialHtml).toContain("interpret")
    expect(initialHtml).toContain("1 活动链累计")
    expect(updatedHtml).toContain("rule_assembly")
    expect(updatedHtml).toContain("1 活动链累计")
    expect(updatedHtml).not.toContain("3 / 400")
  })

  it("summarizes repeated phase requests into compact phase metrics", () => {
    const html = renderToStaticMarkup(React.createElement(RightRail, {
      graphSlice: undefined,
      task: {
        status: "completed",
        lastPhase: "interpret",
        phaseRuns: [{
          phaseRunId: "phase-read",
          phase: "interpret",
          status: "completed",
          attempt: 1,
          result: { outcome: "request_read" },
          usage: { modelCalls: 1, inputTokens: 100, latencyMs: 1000, cacheHitInputTokens: 50, cacheMissInputTokens: 50 },
          startedAtMs: 1,
          finishedAtMs: 1001,
        }, {
          phaseRunId: "phase-final",
          phase: "interpret",
          status: "completed",
          attempt: 2,
          result: { outcome: "complete" },
          usage: { modelCalls: 3, inputTokens: 300, latencyMs: 3000, cacheHitInputTokens: 150, cacheMissInputTokens: 150 },
          startedAtMs: 1002,
          finishedAtMs: 4002,
        }],
      },
    }))

    expect(html).toContain("平均上下文请求 Token 数: 100")
    expect(html).toContain("平均 AI 请求数: 2")
    expect(html).toContain("平均 KV 缓存命中率: 50%")
    expect(html).toContain("平均请求时间: 1.0s")
    expect(html).toContain("当前阶段检索轮次: 1")
  })

  it("renders a blocked checkpoint with explicit user-controlled recovery", () => {
    const html = renderPortaledHtml(React.createElement(TaskCheckpointDialog, {
      task: {
        handle: { taskId: "task-1", status: "awaiting_user_decision" },
        status: "awaiting_user_decision",
        lastPhase: "draft",
        interruption: {
          kind: "limit_exhausted",
          message: "Turn deadline exceeded",
          blockedMetrics: ["wall_time"],
          phase: "draft",
        },
        phaseRuns: [{
          phaseRunId: "phase-1",
          phase: "interpret",
          status: "completed",
          attempt: 1,
          usage: { modelCalls: 1, inputTokens: 100, outputTokens: 30 },
          startedAtMs: 1,
          finishedAtMs: 2,
        }],
      },
      onClose: vi.fn(),
      onResume: vi.fn(() => Promise.resolve()),
      onRollbackRound: vi.fn(() => Promise.resolve()),
    }))

    expect(html).toContain("推演已暂停")
    expect(html).toContain("draft")
    expect(html).toContain("暂停原因")
    expect(html).toContain("本轮执行时间已到上限")
    expect(html).not.toContain("Turn deadline exceeded")
    expect(html).toContain("请先在运行监控中重置 1 项限制后再继续")
    expect(html).toContain("回退本轮")
    expect(html).toContain("重试")
    expect(html).toContain("继续")
    expect(html).not.toContain("保持暂停")
    expect(html.match(/disabled=""/gu)?.length).toBeGreaterThanOrEqual(2)
  })

  it("renders settings extraction review checkpoint without blocked metrics", () => {
    const html = renderPortaledHtml(React.createElement(TaskCheckpointDialog, {
      task: {
        handle: { taskId: "task-settings", status: "waiting_for_review" },
        status: "waiting_for_review",
        lastPhase: "settings_extraction",
        interruption: {
          kind: "settings_extraction_review",
          message: "正文已生成，抽取了 1 条设定修订提案，请确认后再继续图治理",
          blockedMetrics: [],
          phase: "settings_extraction",
        },
        phaseRuns: [{
          phaseRunId: "phase-settings",
          phase: "settings_extraction",
          status: "completed",
          attempt: 1,
          usage: { modelCalls: 1, inputTokens: 100, outputTokens: 30 },
          startedAtMs: 1,
          finishedAtMs: 2,
        }],
      },
      project: {
        projectId: "project-test",
        displayName: "测试",
        workspaceRootRef: "C:\\Worldseed\\test",
      },
      onClose: vi.fn(),
      onResume: vi.fn(() => Promise.resolve()),
      onRollbackRound: vi.fn(() => Promise.resolve()),
    }))

    expect(html).toContain("设定抽取待确认")
    expect(html).toContain("settings_extraction")
    expect(html).toContain("暂停原因")
    expect(html).toContain("正文已生成，抽取了 1 条设定修订提案，请确认后再继续图治理")
    expect(html).toContain("继续图治理")
    expect(html).toContain("回退本轮")
    expect(html).not.toContain("保持暂停")
    expect(html).not.toContain("阻塞指标")
    expect(html).toContain("checkpoint-settings-review")
    expect(html).toContain("没有待确认的设定提案")
  })

  it("renders finalization recovery without implying another AI request", () => {
    const html = renderPortaledHtml(React.createElement(TaskCheckpointDialog, {
      task: {
        handle: { taskId: "task-finalize", status: "awaiting_user_decision" },
        status: "awaiting_user_decision",
        lastPhase: "commit_review",
        finalization: {
          finalizationId: "finalization-1",
          status: "scope_committed",
          chapterPath: "章节正文/第一章 世界种子.md",
          chapterHeading: "第一章 世界种子",
          sourceId: "source-1",
          contentDigest: "digest-1",
          committedSequence: 1,
        },
        interruption: {
          kind: "execution_error",
          message: "Chapter publish failed",
          blockedMetrics: [],
          phase: "commit_review",
        },
        phaseRuns: [],
      },
      onClose: vi.fn(),
      onResume: vi.fn(() => Promise.resolve()),
      onRollbackRound: vi.fn(() => Promise.resolve()),
    }))

    expect(html).toContain("正式章节收尾 · 等待发布章节")
    expect(html).toContain("暂停原因")
    expect(html).toContain("章节发布失败")
    expect(html).not.toContain("Chapter publish failed")
    expect(html).toContain("重试收尾步骤")
    expect(html).toContain("回退本轮")
    expect(html).toContain("committed")
    expect(html).not.toContain("继续执行会重发当前模型请求")
    expect(html).not.toContain("此前阶段、读取结果和待提交作用域均已保存")
    expect(html).not.toContain("保持暂停")
  })
})

describe("checkpoint pause reason copy", () => {
  it("localizes technical interruption messages into Chinese pause reasons", () => {
    expect(resolveCheckpointPauseReason({
      isSettingsReview: false,
      blockedMetricCount: 0,
      interruptionKind: "execution_error",
      interruptionMessage: "driver has already been destroyed",
    })).toBe("本地数据库连接已关闭")
  })
})

describe("history panel contract", () => {
  it("renders persisted history controls, retention status, and branch actions", () => {
    const projectId = "11111111-1111-4111-8111-111111111111"
    const branchId = "21111111-1111-4111-8111-111111111111"
    const entryId = "31111111-1111-4111-8111-111111111111"
    const html = renderToStaticMarkup(React.createElement(HistoryPanel, {
      entries: [{
        entryId,
        projectId,
        branchId,
        kind: "manual",
        state: "paused_checkpoint",
        status: "ready",
        name: "手动保存 · 码头会面前",
        committedSequence: 7,
        checkpointId: "41111111-1111-4111-8111-111111111111",
        createdAtMs: 1_800_000,
      }],
      branches: [{
        branchId,
        projectId,
        name: "主世界线",
        status: "active",
        historyHeadEntryId: entryId,
        createdAtMs: 1,
        updatedAtMs: 2,
      }],
      activeBranchId: branchId,
      selectedEntryId: entryId,
      graphAnchorIds: [],
      retentionLimit: null,
      taskRunning: false,
      onOpenSettings: vi.fn(),
      onOpenCheckpoint: vi.fn(),
      onSave: vi.fn(() => Promise.resolve()),
      onRestore: vi.fn(() => Promise.resolve()),
      onContinueFrom: vi.fn(() => Promise.resolve()),
      onReturnPreviousRound: vi.fn(() => Promise.resolve()),
    }))

    expect(html).toContain("推演历史")
    expect(html).toContain("1 / 无上限")
    expect(html).toContain("返回上一轮")
    expect(html).toContain("手动保存 · 码头会面前")
    expect(html).toContain("恢复后保持暂停")
    expect(html).toContain("加载")
    expect(html).toContain("从这里继续")
    expect(html).not.toContain("模拟多历史切换")
  })

  it("uses the browser backend contract for real history overview and branching", async () => {
    const overview = await invokeBackend<{ entries: readonly { entryId: string }[] }>("history.list", {})
    const entryId = overview.entries[0]?.entryId
    expect(entryId).toBeDefined()
    const result = await invokeBackend<{ branch: { forkEntryId?: string } }>("history.continueFrom", { entryId })
    expect(result.branch.forkEntryId).toBe(entryId)
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
      appUpdate: {
        info: null,
        checking: false,
        error: null,
        statusMessage: null,
        remote: null,
        refreshInfo: async () => undefined,
        checkNow: async () => null,
        openDownload: async () => undefined,
      },
      onClose: vi.fn(),
      onSave: vi.fn(),
      onOpenModelSettings: vi.fn(),
    }))

    expect(html).toContain("设置 / 雾港纪事")
    expect(html).toContain("推演执行")
    expect(html).toContain("资料检索")
    expect(html).toContain("世界图")
    expect(html).toContain("推演历史")
    expect(html).toContain("模型服务")
    expect(html).toContain("关于")
    expect(html).toContain("最大模型调用次数")
    expect(html).toContain("推演发散程度")
    expect(html).toContain("基于世界观生成设定")
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
    expect(graphContentLabel({ identity: "向桐镇二" })).toBe("向桐镇二")
    expect(graphContentLabel(null)).toBe("未命名节点")
  })

  it("renders object graph content as labeled fields instead of raw JSON", () => {
    expect(graphFieldLabel("identity")).toBe("身份")
    expect(graphFieldLabel("knowledge")).toBe("知识")
    expect(graphFieldLabel("customKey")).toBe("customKey")
    const html = renderToStaticMarkup(React.createElement(GraphContentView, {
      content: { identity: "向桐镇二", knowledge: "保留原人生记忆" },
    }))
    expect(html).toContain("身份")
    expect(html).toContain("向桐镇二")
    expect(html).toContain("知识")
    expect(html).toContain("保留原人生记忆")
    expect(html).not.toContain("\"identity\"")
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
