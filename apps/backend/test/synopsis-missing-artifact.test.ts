import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"

import {
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  type PhaseRequestEnvelope,
  type PhaseResultEnvelope,
} from "@worldseed/contracts"

import {
  SynopsisConversationService,
  type SynopsisConversationServiceDependencies,
} from "../src/application/chapters/synopsis-conversation-service.js"
import type { AIModelPort, PhaseModelExecution } from "../src/application/turns/ports/ai-model-port.js"
import type { WorkspaceCatalogPort } from "../src/application/retrieval/ports/workspace-catalog.js"
import type { WorkspacePort } from "../src/application/workspace/index.js"
import type { PromptResourcePort } from "../src/application/turns/ports/ai-model-port.js"

function emptyCatalog(projectId: string) {
  return {
    snapshotId: randomUUID(),
    projectId,
    generatedAtMs: Date.now(),
    entries: [
      {
        relativePath: "设定集/readme.md",
        entryKind: "file" as const,
        role: "settings" as const,
        version: "v1",
        digest: "d1",
        size: 12,
      },
    ],
    digest: "catalog",
  }
}

describe("synopsis discuss missing artifact recovery", () => {
  it("retries when continue omits artifact, then accepts a valid artifact", async () => {
    const projectId = randomUUID()
    const sessionId = randomUUID()
    let calls = 0
    const model: AIModelPort = {
      info: {
        provider: "fake",
        model: "missing-artifact",
        available: true,
        contextWindowTokens: 8_000,
      },
      async execute(request: PhaseRequestEnvelope): Promise<PhaseModelExecution> {
        calls += 1
        const base = {
          schemaVersion: SCHEMA_VERSION,
          envelopeId: request.envelopeId,
          contextId: request.contextId,
          phase: request.phase,
          requestedReads: [],
          citedReadIds: [...request.committedReadIds],
          producedArtifactIds: [],
          decisionRecordIds: [],
          unresolvedDependencies: [],
        } as const
        const result: PhaseResultEnvelope = calls === 1
          ? {
              ...base,
              outcome: "continue",
              reason: "omit artifact",
              selfReview: "first pass",
            }
          : {
              ...base,
              outcome: "continue",
              artifact: {
                assistantMessage: "已根据设定索引整理第一章方向。",
                finalSelfReview: "Recovered after missing artifact.",
              },
              reason: "complete",
              selfReview: "second pass",
            }
        return {
          result,
          usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, latencyMs: 1 },
        }
      },
    }
    const storedMessages: Array<{
      messageId: string
      sessionId: string
      projectId: string
      role: "user" | "assistant" | "system"
      content: string
      createdAtMs: number
      reasoningContent?: string
      searching?: unknown
      choices?: unknown
    }> = []
    const conversation = {
      async findActiveSession() {
        return {
          sessionId,
          projectId,
          chapterSequence: 1,
          synopsisPath: "章节正文/第一卷 待命名/第一章 待命名 [剧情梗概].md",
          title: "第一章 待命名",
          status: "active" as const,
          createdAtMs: 1,
          updatedAtMs: 1,
        }
      },
      async listMessages() {
        return [...storedMessages]
      },
      async listMessagesForProject() {
        return [...storedMessages]
      },
      async appendMessage(input: (typeof storedMessages)[number]) {
        storedMessages.push({ ...input })
        return input
      },
      async updateSession() {
        return undefined
      },
      async findSession() {
        return {
          sessionId,
          projectId,
          chapterSequence: 1,
          synopsisPath: "章节正文/第一卷 待命名/第一章 待命名 [剧情梗概].md",
          title: "第一章 待命名",
          status: "active" as const,
          createdAtMs: 1,
          updatedAtMs: 1,
        }
      },
    }
    const workspace: WorkspacePort = {
      async validate() {
        return { workspaceRootRef: "ws", inventory: [], issues: [] }
      },
      async readMarkdown() {
        return "# 设定集索引\n"
      },
      async saveSynopsisMarkdown() {
        return undefined
      },
      async removeSynopsisMarkdown() {
        return undefined
      },
    } as unknown as WorkspacePort
    const catalog: WorkspaceCatalogPort = {
      async createSnapshot() {
        return emptyCatalog(projectId)
      },
    }
    const prompts: PromptResourcePort = {
      async loadPhase() {
        return { ref: "synopsis_discuss", digest: "d", text: "phase" }
      },
      async loadSynopsisDiscussSystemRules() {
        return { ref: "rules", digest: "d", text: "rules" }
      },
    } as unknown as PromptResourcePort
    const dependencies = {
      chapters: {
        async nextChapterSequence() {
          return 1
        },
      },
      conversation,
      goals: {
        async list() {
          return { goals: [], progress: [], proposals: [] }
        },
        async createProposalsFromArtifact() {
          return []
        },
      },
      workspace,
      catalog,
      prompts,
      createId: randomUUID,
      now: () => Date.now(),
    } as unknown as SynopsisConversationServiceDependencies
    const service = new SynopsisConversationService(dependencies)
    const sent = await service.send({
      projectId,
      workspaceRootRef: "ws",
      message: "我想写修仙小说",
      model,
      maxModelCalls: 4,
    })
    expect(calls).toBe(2)
    expect(sent.messages.some((message) => (
      message.role === "assistant" && message.content.includes("设定索引")
    ))).toBe(true)
  })
})
