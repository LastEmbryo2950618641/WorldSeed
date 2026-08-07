import type { AIModelPort, PhaseModelExecution } from "../../application/index.js"

const missingDeepSeekMessage = "DeepSeek 模型未配置：请在顶部“模型配置”中填写 API Key，或设置 DEEPSEEK_API_KEY 后重启 Worldseed。应用运行时已禁止自动回退到 Fake AI。"

export class UnavailableAiModelAdapter implements AIModelPort {
  public readonly info = {
    provider: "deepseek",
    model: "unconfigured",
    available: false,
    contextWindowTokens: 64_000,
    detail: missingDeepSeekMessage,
  } as const

  public execute(): Promise<PhaseModelExecution> {
    return Promise.reject(new Error(missingDeepSeekMessage))
  }
}
