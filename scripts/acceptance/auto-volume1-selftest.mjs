/**
 * Self-test: create a new book, pause once for volume outline, then Auto one-shot volume 1.
 *
 * Requires Electron with CDP:
 *   WORLDSEED_CDP_PORT=9230 corepack pnpm --filter @worldseed/desktop dev
 *
 * Usage (repo root):
 *   node scripts/acceptance/auto-volume1-selftest.mjs
 */
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import { chromium } from "playwright-core"

import { invokeBackend, readActiveModel } from "./lib/electron-backend.mjs"

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..")
const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9230"
const reportPath = resolve(
  process.env.WORLDSEED_AUTO_VOLUME1_REPORT
    ?? join(repoRoot, ".worldseed-data/acceptance/current/auto-volume1-selftest.json"),
)
const screenshotDir = resolve(dirname(reportPath))
const bookTitle = process.env.WORLDSEED_AUTO_VOLUME1_TITLE
  ?? `自测第一卷·${new Date().toISOString().slice(0, 16).replace("T", " ")}`
const volumeFolderName = process.env.WORLDSEED_AUTO_VOLUME1_VOLUME ?? "第一卷 开局"
const resumeWorkspace = process.env.WORLDSEED_AUTO_VOLUME1_RESUME_WORKSPACE
const premise = process.env.WORLDSEED_AUTO_VOLUME1_PREMISE ?? [
  "都市修仙爽文：主角重生回大学入学日，记得前世仇敌与机缘。",
  "第一卷主题：开局立仇、立规矩、立三女主拉扯线；目标约 6–9 章。",
].join("")

const report = {
  startedAt: new Date().toISOString(),
  status: "running",
  cdpUrl,
  bookTitle,
  volumeFolderName,
  steps: [],
}

function step(id, status, evidence) {
  report.steps.push({ id, status, evidence, at: new Date().toISOString() })
  console.log(`[${status}] ${id}: ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`)
}

async function safeScreenshot(page, fileName) {
  try {
    await page.screenshot({
      path: join(screenshotDir, fileName),
      fullPage: true,
      timeout: 8_000,
      animations: "disabled",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    step("screenshot", "skip", `${fileName}: ${message.split("\n")[0] ?? message}`)
  }
}

async function waitForCdp(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/json/version`)
      if (response.ok) return
    } catch {
      // still starting
    }
    await delay(500)
  }
  throw new Error(`CDP not ready at ${url}`)
}

async function closeKnownDialogs(page) {
  const closeModel = page.getByRole("button", { name: "关闭模型配置" })
  if (await closeModel.count() > 0 && await closeModel.first().isVisible()) {
    await closeModel.first().evaluate((button) => { button.click() })
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const dialog = page.getByTestId("checkpoint-dialog")
    if (await dialog.count() === 0 || !await dialog.first().isVisible()) return
    await dialog.locator('button[title="保持暂停并关闭"]').click()
    await delay(300)
  }
}

async function ensureAutoMode(page) {
  await page.evaluate(() => {
    localStorage.setItem("worldseed.creation-desk.discuss-agent-mode", "auto")
  })
  const autoOpt = page.getByRole("button", { name: "Auto", exact: true }).first()
  if (await autoOpt.count() > 0 && await autoOpt.isVisible()) {
    await autoOpt.click().catch(() => undefined)
  }
}

async function ensureSession(page, project) {
  const listed = await invokeBackend(page, "synopsis.conversation.list", {
    projectId: project.projectId,
    workspaceRootRef: project.workspaceRootRef,
  })
  if (listed?.session !== undefined) return listed.session
  const started = await invokeBackend(page, "synopsis.conversation.start", {
    projectId: project.projectId,
    workspaceRootRef: project.workspaceRootRef,
  })
  return started.session
}

async function settleProjectRuntime(page, project) {
  // UI open races with IPC send and can close the sqlite driver mid-request.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await invokeBackend(page, "synopsis.conversation.list", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
      })
      await delay(500)
      await invokeBackend(page, "project.validate", {
        workspaceRootRef: project.workspaceRootRef,
      })
      return
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (!/driver has already been destroyed|Project runtime failed/u.test(text) && attempt > 2) throw error
      await delay(1_000)
    }
  }
  throw new Error("Project runtime did not settle")
}

async function sendDiscuss(page, project, message, options = {}) {
  await settleProjectRuntime(page, project)
  await ensureSession(page, project)
  const model = await readActiveModel(page)
  const payload = {
    projectId: project.projectId,
    workspaceRootRef: project.workspaceRootRef,
    message,
    presentation: {
      minimumWordCount: 2_000,
      maximumWordCount: 4_000,
    },
    chapterIntent: {
      boundaryPace: "advance_allowed",
      causalityFocus: "auto",
    },
    model: {
      baseUrl: model.baseUrl,
      model: model.model,
      credentialRef: model.credentialRef,
      apiProtocol: model.apiProtocol,
      contextWindowTokens: model.contextWindowTokens,
      thinkingModeEnabled: true,
      reasoningEffort: model.reasoningEffort,
      jsonModeEnabled: model.jsonModeEnabled,
      disableResponseStorage: model.disableResponseStorage,
      serviceTier: model.serviceTier,
    },
    agentMode: "auto",
    ...(options.automation === undefined ? {} : { automation: options.automation }),
  }
  const box = page.getByPlaceholder("告诉 Agent 下一章想怎么推进…")
  if (await box.count() > 0) await box.fill(message).catch(() => undefined)

  let lastError
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await invokeBackend(page, "synopsis.conversation.send", payload)
    } catch (error) {
      lastError = error
      const text = error instanceof Error ? error.message : String(error)
      if (!/driver has already been destroyed/u.test(text)) throw error
      console.log(`[retry] send after destroyed driver (attempt ${String(attempt + 1)})`)
      await delay(2_000)
      await settleProjectRuntime(page, project)
      await ensureSession(page, project)
    }
  }
  throw lastError
}

/** Follow Auto continueTurn / choice self-decide until the chain stops or max hops. */
async function drainAutoContinues(page, project, initialResult, maxHops = 20) {
  let result = initialResult
  for (let hop = 0; hop < maxHops; hop += 1) {
    const message = result?.autoContinue?.message
    if (typeof message !== "string" || message.trim().length === 0) return result
    console.log(`[autoContinue ${String(hop + 1)}] ${message.slice(0, 120)}`)
    result = await sendDiscuss(page, project, message)
  }
  return result
}

function isVolumeOutlineReady(markdown) {
  const text = markdown?.trim() ?? ""
  if (text.length < 60) return false
  const chapterMarkers = text.match(/第\s*[0-9一二三四五六七八九十百千]+\s*章/gu) ?? []
  const headingCount = (text.match(/^#{1,3}\s+\S+/gmu) ?? []).length
  if (chapterMarkers.length >= 2) return true
  if (headingCount >= 3 && text.length >= 120) return true
  return false
}

async function readWorkspaceFile(page, project, relativePath) {
  try {
    const read = await invokeBackend(page, "workspace.read", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
      relativePath,
    })
    return typeof read?.content === "string" ? read.content : ""
  } catch {
    return ""
  }
}

async function listChapterBodies(workspaceRootRef, volumeFolder) {
  const dir = join(workspaceRootRef, "章节正文", volumeFolder)
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.includes("["))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, "zh-CN"))
  } catch {
    return []
  }
}

await waitForCdp(cdpUrl)
const browser = await chromium.connectOverCDP(cdpUrl)
const page = browser.contexts()[0]?.pages()[0]
if (page === undefined) throw new Error(`No Electron renderer page at ${cdpUrl}`)

try {
  await closeKnownDialogs(page)
  await page.waitForTimeout(1_000)

  const outlinePath = `大纲/${volumeFolderName}.md`
  let project

  if (typeof resumeWorkspace === "string" && resumeWorkspace.length > 0) {
    const listed = await invokeBackend(page, "project.list", {})
    project = [...(listed.projects ?? [])].find((item) => (
      item.workspaceRootRef.replaceAll("/", "\\") === resumeWorkspace.replaceAll("/", "\\")
    )) ?? [...(listed.projects ?? [])].find((item) => item.displayName === bookTitle)
    if (project === undefined) throw new Error(`Resume workspace not in project.list: ${resumeWorkspace}`)

    const alreadyOpen = await page.getByTestId("synopsis-conversation").isVisible().catch(() => false)
    if (!alreadyOpen) {
      if (await page.getByTestId("launcher-create-project").count() === 0) {
        await page.evaluate(() => {
          window.dispatchEvent(new CustomEvent("worldseed:local-command", { detail: "project.new" }))
        })
        await page.getByTestId("launcher-book-grid").waitFor({ state: "visible", timeout: 20_000 })
      }
      const card = page.getByTestId("launcher-book-card").filter({ hasText: project.displayName }).first()
      if (await card.count() === 0) throw new Error(`Book card not found: ${project.displayName}`)
      await card.click()
      await page.getByTestId("synopsis-conversation").waitFor({ state: "visible", timeout: 90_000 })
    }
    await closeKnownDialogs(page)
    await ensureAutoMode(page)
    await delay(3_000)
    await settleProjectRuntime(page, project)
    report.projectId = project.projectId
    report.workspaceRootRef = project.workspaceRootRef
    step("create_book", "pass", { via: "resume", projectId: project.projectId, workspaceRootRef: project.workspaceRootRef })
  } else {
    // --- Create book via launcher UI only (avoids reload / destroyed sqlite driver) ---
    if (await page.getByTestId("launcher-create-project").count() === 0) {
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent("worldseed:local-command", { detail: "project.new" }))
      })
      await page.getByTestId("launcher-create-project").waitFor({ state: "visible", timeout: 20_000 })
    }
    await page.getByTestId("launcher-create-project").click()
    await page.getByTestId("work-name-prompt-dialog").waitFor({ state: "visible", timeout: 20_000 })
    await page.getByTestId("work-name-prompt-dialog").locator("input").fill(bookTitle)
    await page.getByTestId("work-name-prompt-confirm").click()
    await page.getByTestId("synopsis-conversation").waitFor({ state: "visible", timeout: 90_000 })
    await closeKnownDialogs(page)
    await ensureAutoMode(page)
    await delay(5_000)

    const listed = await invokeBackend(page, "project.list", {})
    project = [...(listed.projects ?? [])]
      .filter((item) => item.displayName === bookTitle)
      .sort((a, b) => (b.lastOpenedAtMs ?? 0) - (a.lastOpenedAtMs ?? 0))[0]
    if (project === undefined || project.workspaceRootRef === undefined) {
      throw new Error(`Created project not found: ${bookTitle}`)
    }
    report.projectId = project.projectId
    report.workspaceRootRef = project.workspaceRootRef
    step("create_book", "pass", {
      via: "launcher",
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
    })
    await settleProjectRuntime(page, project)
  }

  const model = await readActiveModel(page)
  report.model = { id: model.id, model: model.model }
  step("open_creation_desk", "pass", { model: model.model })
  await safeScreenshot(page, "auto-volume1-01-desk.png")

  // --- Phase 1: volume outline only (the sole confirmation gate) ---
  let outlineMarkdown = await readWorkspaceFile(page, project, outlinePath)
  if (!isVolumeOutlineReady(outlineMarkdown)) {
    const outlinePrompt = [
      "【自测·仅卷大纲】开写正文之前必须先落盘作品风格。",
      "开书第一步：用 presentationWrites 把 `表现输出/本作品描写/作品风格.md` 的 1→6 维全部定好写入（缺一维不合格，不得只用禁止列表顶替）：（1）语体/笔风——读 `表现输出/笔风规则/` 点名主锚并写清叙述腔；（2）时代·科技·生活层；（3）规则称谓·能力写法；（4）命名（人/地/势力/物/号+示例）；（5）角色声口；（6）尺度·意象·章钩。",
      "风格落盘后，再只完成本卷大纲，不要写各章梗概/细纲/正文，也不要开始批量推演。",
      `卷文件夹名必须是：${volumeFolderName}`,
      `请把完整卷大纲写入：\`${outlinePath}\`（文件名须与卷文件夹名完全一致）。`,
      "大纲至少列出 6 章以上节点（含每章一句话戏核），并给出卷主题与目标字数。",
      `题材设定：${premise}`,
      "写完后在 assistantMessage 里说明「作品风格与卷大纲已落盘，等待确认后再批量推演」；不要给「开始批量推演」之外的岔路。",
    ].join("\n")

    const outlineSend = await sendDiscuss(page, project, outlinePrompt)
    step("outline_requested", "pass", {
      path: outlinePath,
      autoContinue: outlineSend?.autoContinue?.message ?? null,
    })

    const outlineDeadline = Date.now() + 20 * 60_000
    while (Date.now() < outlineDeadline) {
      outlineMarkdown = await readWorkspaceFile(page, project, outlinePath)
      if (isVolumeOutlineReady(outlineMarkdown)) break
      const peek = await invokeBackend(page, "synopsis.conversation.streamPeek", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
      }).catch(() => undefined)
      if (peek?.status === "failed") {
        throw new Error(`Outline discuss failed: ${peek.error ?? "unknown"}`)
      }
      await delay(5_000)
    }
    if (!isVolumeOutlineReady(outlineMarkdown)) {
      await safeScreenshot(page, "auto-volume1-outline-fail.png")
      throw new Error(`Volume outline not ready at ${outlinePath} (len=${String(outlineMarkdown.length)})`)
    }
    step("outline_ready", "pass", { path: outlinePath, chars: outlineMarkdown.length })
    step("outline_confirmed", "pass", "scripted sole confirmation")
  } else {
    step("outline_ready", "pass", { path: outlinePath, chars: outlineMarkdown.length, resumed: true })
    step("outline_confirmed", "pass", "already confirmed / resumed")
  }
  await safeScreenshot(page, "auto-volume1-02-outline.png")

  const plannedBodies = await listChapterBodies(project.workspaceRootRef, volumeFolderName).catch(() => [])
  const planFiles = await readdir(join(project.workspaceRootRef, "章节正文", volumeFolderName), { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isFile() && entry.name.includes("[剧情细纲]")).length)
    .catch(() => 0)
  if (planFiles < 3) {
    const planMessage = [
      "【批量推演·卷规划】卷大纲已就绪。请在同一次回复中完成本卷规划并落盘：",
      "1) 给出目标字数、章节数（可用 volumePlanMeta）；",
      "2) 用 volumeChapterPlans 为本卷每一章写出完整 synopsisBody + outlineBody（勿只写当前焦点章）；",
      "3) 不要调用 chapter_workflow / publish_draft；不要输出 set_focus / focusChange；",
      "4) 规划落盘齐后等待系统进入正文阶段。",
    ].join("")
    const planResult = await sendDiscuss(page, project, planMessage, { automation: "batch_chapter" })
    await drainAutoContinues(page, project, planResult, 8)
    step("volume_plan_started", "pass", "batch_chapter volume plan")
  } else {
    step("volume_plan_started", "pass", { resumed: true, outlineFiles: planFiles, plannedBodies: plannedBodies.length })
  }

  const targetBodies = Number(process.env.WORLDSEED_AUTO_VOLUME1_MIN_BODIES ?? 8)
  const publishModel = await readActiveModel(page)
  const maxChapterRounds = Number(process.env.WORLDSEED_AUTO_VOLUME1_MAX_ROUNDS ?? 24)

  for (let round = 0; round < maxChapterRounds; round += 1) {
    let bodies = await listChapterBodies(project.workspaceRootRef, volumeFolderName)
    report.bodyFiles = bodies
    if (bodies.length >= targetBodies) {
      step("volume_bodies", "pass", { count: bodies.length, bodies, round })
      break
    }

    let drafts = await invokeBackend(page, "chapter.draft.list", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
    })
    let publishable = (Array.isArray(drafts) ? drafts : [])
      .filter((item) => (
        item.status !== "completed"
        && item.status !== "graph_sync_running"
        && item.status !== "graph_sync_pending"
        && typeof item.proposedBody === "string"
        && item.proposedBody.trim().length > 0
      ))
      .sort((a, b) => a.chapterSequence - b.chapterSequence)

    if (publishable.length === 0) {
      const draftMessage = [
        "【批量推演·正文草稿·逐章补齐】",
        `当前正式正文 ${String(bodies.length)} 章，目标至少 ${String(targetBodies)} 章。`,
        "请用 chapterDraftProposals 为下一章（或尚未有正文的最早章）写出完整 heading+body 草稿；",
        "硬约束：严格遵守 `世界推演规则/基础规则/webnovel-prose-logic.md`——去AI味、逻辑八链、短快狠、章末有钩；",
        "可读优先：口语对话、动作推进、禁止喊情绪与空话升华；selfReview 点明已避套话与已核逻辑。",
        "可一次写多章；不要 publish_draft；不要 set_focus；写不完就 continueTurn=true。",
      ].join("")
      const draftResult = await sendDiscuss(page, project, draftMessage, { automation: "batch_chapter" })
      await drainAutoContinues(page, project, draftResult, 10)
      drafts = await invokeBackend(page, "chapter.draft.list", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
      })
      publishable = (Array.isArray(drafts) ? drafts : [])
        .filter((item) => (
          item.status !== "completed"
          && typeof item.proposedBody === "string"
          && item.proposedBody.trim().length > 0
        ))
        .sort((a, b) => a.chapterSequence - b.chapterSequence)
      step("volume_draft_round", "pass", {
        round: round + 1,
        drafts: publishable.length,
        bodies: bodies.length,
      })
    }

    if (publishable.length === 0) {
      step("volume_draft_round", "fail", { round: round + 1, bodies: bodies.length })
      continue
    }

    const draft = publishable[0]
    const beforeCount = bodies.length
    await invokeBackend(page, "chapter.submitRevision", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
      revisionTaskId: draft.revisionTaskId,
      mode: "direct",
      forced: true,
      model: {
        baseUrl: publishModel.baseUrl,
        model: publishModel.model,
        credentialRef: publishModel.credentialRef,
        apiProtocol: publishModel.apiProtocol,
        contextWindowTokens: publishModel.contextWindowTokens,
        thinkingModeEnabled: publishModel.thinkingModeEnabled,
        reasoningEffort: publishModel.reasoningEffort,
        jsonModeEnabled: publishModel.jsonModeEnabled,
        disableResponseStorage: publishModel.disableResponseStorage,
        serviceTier: publishModel.serviceTier,
      },
    })
    step(`publish_${String(draft.chapterSequence)}`, "pass", draft.revisionTaskId)

    const bodyDeadline = Date.now() + 25 * 60_000
    let graphRetries = 0
    while (Date.now() < bodyDeadline) {
      bodies = await listChapterBodies(project.workspaceRootRef, volumeFolderName)
      if (bodies.length > beforeCount) break
      const status = await invokeBackend(page, "chapter.draft.list", {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
      }).catch(() => [])
      const current = (Array.isArray(status) ? status : []).find((item) => item.revisionTaskId === draft.revisionTaskId)
      if (current?.status === "completed") break
      if (
        (current?.status === "awaiting_user_decision" || current?.graphSyncStatus === "failed")
        && graphRetries < 4
      ) {
        graphRetries += 1
        step(`graph_retry_${String(draft.chapterSequence)}`, "pass", { attempt: graphRetries })
        try {
          await invokeBackend(page, "chapter.graphRevision.retry", {
            projectId: project.projectId,
            workspaceRootRef: project.workspaceRootRef,
            revisionTaskId: draft.revisionTaskId,
            model: {
              baseUrl: publishModel.baseUrl,
              model: publishModel.model,
              credentialRef: publishModel.credentialRef,
              apiProtocol: publishModel.apiProtocol,
              contextWindowTokens: publishModel.contextWindowTokens,
              thinkingModeEnabled: publishModel.thinkingModeEnabled,
              reasoningEffort: publishModel.reasoningEffort,
              jsonModeEnabled: publishModel.jsonModeEnabled,
              disableResponseStorage: publishModel.disableResponseStorage,
              serviceTier: publishModel.serviceTier,
            },
          })
        } catch {
          await invokeBackend(page, "chapter.submitRevision", {
            projectId: project.projectId,
            workspaceRootRef: project.workspaceRootRef,
            revisionTaskId: draft.revisionTaskId,
            mode: "direct",
            forced: true,
            model: {
              baseUrl: publishModel.baseUrl,
              model: publishModel.model,
              credentialRef: publishModel.credentialRef,
              apiProtocol: publishModel.apiProtocol,
              contextWindowTokens: publishModel.contextWindowTokens,
              thinkingModeEnabled: publishModel.thinkingModeEnabled,
              reasoningEffort: publishModel.reasoningEffort,
              jsonModeEnabled: publishModel.jsonModeEnabled,
              disableResponseStorage: publishModel.disableResponseStorage,
              serviceTier: publishModel.serviceTier,
            },
          }).catch(() => undefined)
        }
      }
      await delay(5_000)
    }
  }

  const bodies = await listChapterBodies(project.workspaceRootRef, volumeFolderName)
  report.bodyFiles = bodies
  await safeScreenshot(page, "auto-volume1-03-final.png")
  if (bodies.length < targetBodies) {
    step("volume_bodies", "fail", { count: bodies.length, bodies, targetBodies })
    throw new Error(`Expected >=${String(targetBodies)} published chapter bodies, got ${String(bodies.length)}`)
  }
  if (!report.steps.some((item) => item.id === "volume_bodies" && item.status === "pass")) {
    step("volume_bodies", "pass", { count: bodies.length, bodies })
  }

  report.status = "pass"
  report.completedAt = new Date().toISOString()
} catch (error) {
  report.status = "fail"
  report.error = error instanceof Error ? error.message : String(error)
  report.completedAt = new Date().toISOString()
  step("fatal", "fail", report.error)
} finally {
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(report.status === "pass" ? 0 : 1)
}
