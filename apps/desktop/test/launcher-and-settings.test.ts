import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { ProjectLauncher } from "../src/renderer/src/features/projects/ProjectLauncher.js"
import { RemoveWorkDirectoryDialog } from "../src/renderer/src/features/settings/RemoveWorkDirectoryDialog.js"
import { WorkDirectorySettingsPanel } from "../src/renderer/src/features/settings/WorkDirectorySettingsPanel.js"
import {
  ModelConfigurationDialog,
  catalogSignature,
  hasValidBaseUrl,
  isOfficialDeepSeekEndpoint,
  normalizeProfile,
  type ModelProfile,
} from "../src/renderer/src/features/settings/ModelConfigurationDialog.js"

describe("ProjectLauncher", () => {
  it("renders book library grid with add card", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectLauncher, { onOpen: vi.fn() }))

    expect(html).toContain("我的书籍")
    expect(html).toContain("launcher-book-grid")
    expect(html).toContain("添加书籍")
    expect(html).toContain("launcher-create-project")
    expect(html).not.toContain("在工作目录下新建")
    expect(html).not.toContain("打开其他目录中的书籍")
    expect(html).not.toContain("建立一个新世界")
    expect(html).not.toContain("创建并进入")
    expect(html).not.toContain("项目名称")
  })
})

describe("Work directory settings", () => {
  it("renders remove dialog with both removal options visible", () => {
    const html = renderToStaticMarkup(React.createElement(RemoveWorkDirectoryDialog, {
      directoryPath: "C:\\Users\\Example\\.worldseed",
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }))

    expect(html).toContain("remove-work-directory-dialog")
    expect(html).toContain("不包括数据")
    expect(html).toContain("包括数据(高危)")
  })

  it("renders work directory settings panel without bridge", () => {
    const html = renderToStaticMarkup(React.createElement(WorkDirectorySettingsPanel))
    expect(html).toContain("工作目录")
    expect(html).toContain("添加目录")
    expect(html).toContain("C:\\Users\\Example\\.worldseed")
  })
})

describe("ModelConfigurationDialog", () => {
  const profiles: readonly ModelProfile[] = [
    {
      id: "deepseek-chat",
      name: "DeepSeek Chat",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      credentialRef: "model-profile:deepseek-chat",
      apiKey: "",
      hasApiKey: false,
    },
    {
      id: "deepseek-reasoner",
      name: "DeepSeek Reasoner",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-reasoner",
      credentialRef: "model-profile:deepseek-reasoner",
      apiKey: "",
      hasApiKey: false,
    },
  ]

  it("renders the model list and DeepSeek-specific selector hints", () => {
    const html = renderToStaticMarkup(React.createElement(ModelConfigurationDialog, {
      profiles,
      activeProfileId: "deepseek-chat",
      onClose: vi.fn(),
      onSave: vi.fn(),
    }))

    expect(html).toContain("模型配置")
    expect(html).toContain("模型列表")
    expect(html).toContain("DeepSeek Chat")
    expect(html).toContain("DeepSeek Reasoner")
    expect(html).toContain("输入密钥后自动读取 DeepSeek 模型列表")
    expect(html).toContain("API Key")
  })

  it("normalizes profile data and validates DeepSeek endpoints", () => {
    expect(normalizeProfile({
      id: "profile",
      name: "  主账号  ",
      baseUrl: " https://api.deepseek.com ",
      model: " deepseek-chat ",
      credentialRef: "model-profile:profile",
      apiKey: " secret ",
      hasApiKey: true,
    })).toMatchObject({
      name: "主账号",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      apiKey: "secret",
    })

    expect(isOfficialDeepSeekEndpoint("https://api.deepseek.com/v1")).toBe(true)
    expect(isOfficialDeepSeekEndpoint("https://example.com")).toBe(false)
    expect(hasValidBaseUrl("https://api.deepseek.com")).toBe(true)
    expect(hasValidBaseUrl("http://api.deepseek.com")).toBe(false)
    expect(catalogSignature(profiles[0])).toBe("https://api.deepseek.com\u0000model-profile:deepseek-chat")
  })
})
