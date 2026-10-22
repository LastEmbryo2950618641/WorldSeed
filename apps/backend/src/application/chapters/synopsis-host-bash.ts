import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { writeTextFileUtf8, windowsUtf8ProcessEnv } from "./text-utf8.js"

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_CHARS = 48_000
const MAX_COMMAND_CHARS = 8_000
const LEGACY_SHELL_ENCODINGS = ["gb18030", "gbk", "windows-936"] as const

export type SynopsisBashResult = Readonly<{
  cwd: string
  command: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  stdout: string
  stderr: string
  truncated: boolean
}>

/**
 * Resolve and validate bash cwd: must stay inside the project workspace root.
 * Relative cwd is resolved against the workspace root.
 */
export async function resolveBashCwdInsideWorkspace(
  workspaceRootRef: string,
  cwd: string | undefined,
): Promise<string> {
  const workspaceRoot = await realpath(resolve(workspaceRootRef))
  const requested = cwd === undefined || cwd.trim().length === 0
    ? workspaceRoot
    : resolve(isAbsolute(cwd.trim()) ? cwd.trim() : resolve(workspaceRoot, cwd.trim()))
  let resolved: string
  try {
    resolved = await realpath(requested)
  } catch {
    // Allow creating into an existing parent that is still inside the workspace.
    const parent = await realpath(resolve(requested, ".."))
    assertPathInsideWorkspace(workspaceRoot, parent, "bash cwd 父目录")
    resolved = requested
    assertPathInsideWorkspace(workspaceRoot, resolved, "bash cwd")
    return resolved.replaceAll("\\", "/")
  }
  assertPathInsideWorkspace(workspaceRoot, resolved, "bash cwd")
  return resolved.replaceAll("\\", "/")
}

export function assertPathInsideWorkspace(
  workspaceRoot: string,
  candidate: string,
  label: string,
): void {
  const root = workspaceRoot.replaceAll("/", sep)
  const target = candidate.replaceAll("/", sep)
  const rel = relative(root, target)
  if (rel === "") return
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`${label} 必须位于项目工作区内：${candidate}`)
  }
}

/**
 * Best-effort reject of shell redirects / writes that clearly target absolute paths
 * outside the workspace. Copy/move *into* the workspace remains allowed by prompt;
 * this only blocks obvious absolute write destinations outside the root.
 */
export function assertBashCommandRespectsWorkspaceWrites(
  workspaceRootRef: string,
  command: string,
): void {
  const trimmed = command.trim()
  if (trimmed.length === 0) throw new Error("command 不能为空")
  if (trimmed.length > MAX_COMMAND_CHARS) {
    throw new Error(`command 超过 ${String(MAX_COMMAND_CHARS)} 字符上限`)
  }
  if (trimmed.includes("\0")) throw new Error("command 含非法空字节")

  const workspaceNorm = resolve(workspaceRootRef).replaceAll("\\", "/").toLocaleLowerCase()
  const redirectPattern = /(?:^|[\s;|&])(?:>|>>)\s*([^\s;|&]+)/gu
  for (const match of trimmed.matchAll(redirectPattern)) {
    const target = (match[1] ?? "").replaceAll("\\", "/")
    if (target.length === 0 || target === "/dev/null" || target.startsWith("/dev/")) continue
    if (!looksAbsolutePath(target)) continue
    const resolved = resolve(target).replaceAll("\\", "/").toLocaleLowerCase()
    if (resolved === workspaceNorm || resolved.startsWith(`${workspaceNorm}/`)) continue
    throw new Error(`禁止把 bash 输出重定向到工作区外：${target}`)
  }
}

/**
 * Decode shell stdout/stderr into a JS string.
 * We always *send* commands as UTF-8 (`chcp 65001` + UTF-8 `.cmd`); prefer UTF-8
 * decode, then fall back to GBK/CP936 only when bytes are clearly not UTF-8.
 */
export function decodeShellOutputBuffer(buffer: Buffer): string {
  if (buffer.length === 0) return ""
  const utf8 = buffer.toString("utf8")
  if (!shouldTryLegacyChineseEncoding(buffer, utf8)) {
    return normalizeShellNewlines(utf8)
  }
  for (const encoding of LEGACY_SHELL_ENCODINGS) {
    try {
      const decoded = new TextDecoder(encoding, { fatal: false }).decode(buffer)
      if (decoded.includes("\uFFFD") && utf8.includes("\uFFFD")) continue
      if (decoded.includes("\uFFFD") && !utf8.includes("\uFFFD") && /[\u4e00-\u9fff]/u.test(utf8)) {
        continue
      }
      return normalizeShellNewlines(decoded)
    } catch {
      // Encoding unsupported in this Node build.
    }
  }
  return normalizeShellNewlines(utf8)
}

function shouldTryLegacyChineseEncoding(buffer: Buffer, utf8: string): boolean {
  if (utf8.includes("\uFFFD")) return true
  if (process.platform !== "win32") return false
  let high = 0
  for (const byte of buffer) {
    if (byte >= 0x80) high += 1
  }
  if (high < 2) return false
  if (/[\u4e00-\u9fff]/u.test(utf8)) return false
  return high >= Math.max(2, Math.floor(buffer.length * 0.08))
}

function normalizeShellNewlines(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
}

function looksAbsolutePath(pathLike: string): boolean {
  const normalized = pathLike.replaceAll("\\", "/")
  if (normalized.startsWith("//")) return true
  if (/^[A-Za-z]:\//u.test(normalized)) return true
  if (normalized.startsWith("/")) return true
  return isAbsolute(pathLike)
}

/**
 * On Windows, passing Unicode paths (esp. fullwidth punctuation / trailing `!`)
 * via `cmd /c <inline>` often gets mangled and yields 「文件名、目录名或卷标语法不正确」.
 * Writing the command into a UTF-8 `.cmd` then executing that file keeps paths intact.
 */
export function buildWindowsUtf8CmdScript(command: string): string {
  return [
    "@echo off",
    "chcp 65001>nul",
    command,
    "exit /b %ERRORLEVEL%",
  ].join("\r\n")
}

async function prepareWindowsShellInvocation(command: string): Promise<Readonly<{
  file: string
  args: string[]
  cleanupDir: string
}>> {
  const cleanupDir = await mkdtemp(join(tmpdir(), "worldseed-bash-"))
  const scriptPath = join(cleanupDir, `run-${randomUUID()}.cmd`)
  await writeTextFileUtf8(scriptPath, buildWindowsUtf8CmdScript(command))
  return {
    file: "cmd.exe",
    args: ["/d", "/c", scriptPath],
    cleanupDir,
  }
}

export async function executeSynopsisHostBash(input: Readonly<{
  workspaceRootRef: string
  command: string
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
}>): Promise<SynopsisBashResult> {
  const command = input.command.trim()
  assertBashCommandRespectsWorkspaceWrites(input.workspaceRootRef, command)
  const cwd = await resolveBashCwdInsideWorkspace(input.workspaceRootRef, input.cwd)
  const timeoutMs = Math.min(
    Math.max(1_000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    120_000,
  )

  const isWindows = process.platform === "win32"
  const windowsInvocation = isWindows ? await prepareWindowsShellInvocation(command) : undefined
  const file = windowsInvocation?.file ?? "/bin/bash"
  const args = windowsInvocation?.args ?? ["-lc", command]
  const cleanupDir = windowsInvocation?.cleanupDir

  try {
    return await new Promise<SynopsisBashResult>((resolvePromise, rejectPromise) => {
      const child = spawn(file, args, {
        cwd,
        env: isWindows ? windowsUtf8ProcessEnv() : process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let truncated = false
      let timedOut = false
      let settled = false

      const append = (kind: "stdout" | "stderr", chunk: Buffer): void => {
        if (kind === "stdout") {
          if (stdoutBytes >= MAX_OUTPUT_CHARS) {
            truncated = true
            return
          }
          const room = MAX_OUTPUT_CHARS - stdoutBytes
          if (chunk.length > room) {
            stdoutChunks.push(chunk.subarray(0, room))
            stdoutBytes += room
            truncated = true
            return
          }
          stdoutChunks.push(chunk)
          stdoutBytes += chunk.length
          return
        }
        if (stderrBytes >= MAX_OUTPUT_CHARS) {
          truncated = true
          return
        }
        const room = MAX_OUTPUT_CHARS - stderrBytes
        if (chunk.length > room) {
          stderrChunks.push(chunk.subarray(0, room))
          stderrBytes += room
          truncated = true
          return
        }
        stderrChunks.push(chunk)
        stderrBytes += chunk.length
      }

      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGTERM")
        setTimeout(() => {
          if (!settled) child.kill("SIGKILL")
        }, 2_000).unref()
      }, timeoutMs)
      timer.unref()

      const onAbort = (): void => {
        child.kill("SIGTERM")
      }
      input.signal?.addEventListener("abort", onAbort, { once: true })

      child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk))
      child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk))
      child.on("error", (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        input.signal?.removeEventListener("abort", onAbort)
        rejectPromise(error)
      })
      child.on("close", (exitCode, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        input.signal?.removeEventListener("abort", onAbort)
        if (input.signal?.aborted) {
          rejectPromise(input.signal.reason instanceof Error ? input.signal.reason : new Error("bash cancelled"))
          return
        }
        resolvePromise({
          cwd,
          command,
          exitCode,
          signal,
          timedOut,
          stdout: decodeShellOutputBuffer(Buffer.concat(stdoutChunks)),
          stderr: decodeShellOutputBuffer(Buffer.concat(stderrChunks)),
          truncated,
        })
      })
    })
  } finally {
    if (cleanupDir !== undefined) {
      await rm(cleanupDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
