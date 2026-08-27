/**
 * Builds, launches Electron with fake model + CDP, runs dom-deduction-goals-e2e.mjs.
 *
 * Usage (repo root):
 *   node scripts/acceptance/run-deduction-goals-dom-e2e.mjs
 */
import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..")
const cdpPort = process.env.WORLDSEED_CDP_PORT ?? "9230"
const resolvedCdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? `http://127.0.0.1:${cdpPort}`
const reportDir = resolve(repoRoot, ".worldseed-data/acceptance/current")

function pnpmCommand() {
  return process.platform === "win32" ? "corepack.cmd" : "corepack"
}

function pnpmArgs(args) {
  return ["pnpm", ...args]
}

async function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const useShell = process.platform === "win32" && command.includes(" ")
    const child = spawn(useShell ? `"${command}"` : command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: useShell,
      ...options,
    })
    child.on("error", rejectRun)
    child.on("exit", (code) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${command} ${args.join(" ")} exited with ${String(code)}`))
    })
  })
}

async function waitForCdp(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/json/version`)
      if (response.ok) return
    } catch {
      // Electron still starting.
    }
    await delay(500)
  }
  throw new Error(`CDP not ready at ${url} within ${String(timeoutMs)} ms`)
}

await mkdir(reportDir, { recursive: true })

if (process.env.WORLDSEED_SKIP_BUILD !== "1") {
  console.log("Building packages for DOM deduction-goals e2e…")
  await run(pnpmCommand(), pnpmArgs(["--filter", "@worldseed/contracts", "build"]))
  await run(pnpmCommand(), pnpmArgs(["--filter", "@worldseed/prompt-contracts", "build"]))
  await run(pnpmCommand(), pnpmArgs(["--filter", "@worldseed/backend", "build"]))
  await run(pnpmCommand(), pnpmArgs(["--filter", "@worldseed/desktop", "build"]))
}

const electronVite = join(repoRoot, "apps/desktop/node_modules/.bin/electron-vite.CMD")
const electronEnv = {
  ...process.env,
  WORLDSEED_FAKE_MODEL: "1",
  WORLDSEED_CDP_PORT: cdpPort,
  WORLDSEED_PROMPT_ROOT: join(repoRoot, "packages/prompt-contracts"),
  WORLDSEED_LOG_LEVEL: process.env.WORLDSEED_LOG_LEVEL ?? "warn",
}

console.log(`Launching Electron (fake model, CDP ${resolvedCdpUrl})…`)
const electron = spawn(electronVite, ["dev", "--remoteDebuggingPort", String(cdpPort)], {
  cwd: join(repoRoot, "apps/desktop"),
  env: electronEnv,
  stdio: "inherit",
  shell: true,
})

let exitCode = 1
try {
  await waitForCdp(resolvedCdpUrl)
  await delay(4000)
  console.log("Running dom-deduction-goals-e2e…")
  await run("node", [join(repoRoot, "scripts/acceptance/dom-deduction-goals-e2e.mjs")], {
    env: {
      ...process.env,
      WORLDSEED_ACCEPTANCE_CDP_URL: resolvedCdpUrl,
      WORLDSEED_DOM_DEDUCTION_GOALS_REPORT: join(reportDir, "dom-deduction-goals-trace.json"),
      WORLDSEED_DOM_DEDUCTION_GOALS_SCREENSHOT: join(reportDir, "dom-deduction-goals-trace.png"),
    },
  })
  exitCode = 0
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  exitCode = 1
} finally {
  if (!electron.killed) {
    electron.kill("SIGTERM")
    await delay(1500)
    if (!electron.killed) electron.kill("SIGKILL")
  }
}

process.exit(exitCode)
