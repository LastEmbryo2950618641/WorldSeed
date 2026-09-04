import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdir, unlink } from "node:fs/promises"
import { basename, join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import { app, shell } from "electron"

export type UpdateDownloadProgress = Readonly<{
  receivedBytes: number
  totalBytes: number
  percent: number
}>

export type UpdateDownloadHandle = Readonly<{
  cancel(): void
  done: Promise<string>
}>

let activeDownload: { cancel(): void } | undefined

export function resolveUpdateDownloadPath(downloadUrl: string, version: string, buildNumber: string): string {
  const fromUrl = basename(new URL(downloadUrl).pathname)
  const safeName = fromUrl.toLowerCase().endsWith(".exe")
    ? fromUrl
    : `WorldSeed-${version}-b${buildNumber}-Setup.exe`
  return join(app.getPath("temp"), "worldseed-updates", safeName)
}

export async function startUpdateInstallerDownload(input: Readonly<{
  downloadUrl: string
  destinationPath: string
  onProgress: (progress: UpdateDownloadProgress) => void
}>): Promise<UpdateDownloadHandle> {
  if (activeDownload !== undefined) {
    activeDownload.cancel()
    activeDownload = undefined
  }

  const controller = new AbortController()
  const destinationPath = input.destinationPath
  await mkdir(join(destinationPath, ".."), { recursive: true })
  try {
    await unlink(destinationPath)
  } catch {
    // ok if missing
  }

  const done = (async (): Promise<string> => {
    const response = await fetch(input.downloadUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "WorldSeed-Updater" },
    })
    if (!response.ok) {
      throw new Error(`下载失败（HTTP ${String(response.status)}）`)
    }
    if (response.body === null) {
      throw new Error("下载失败：响应没有内容")
    }
    const totalBytes = Number(response.headers.get("content-length") ?? "0")
    let receivedBytes = 0
    const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)
    nodeStream.on("data", (chunk: Buffer | string) => {
      receivedBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength
      const percent = totalBytes > 0
        ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100))
        : 0
      input.onProgress({ receivedBytes, totalBytes, percent })
    })
    await pipeline(nodeStream, createWriteStream(destinationPath))
    if (totalBytes <= 0) {
      input.onProgress({ receivedBytes, totalBytes: receivedBytes, percent: 100 })
    } else {
      input.onProgress({ receivedBytes, totalBytes, percent: 100 })
    }
    return destinationPath
  })()

  const handle = {
    cancel(): void {
      controller.abort()
    },
    done: done.finally(() => {
      if (activeDownload === handle) activeDownload = undefined
    }),
  }
  activeDownload = handle
  return handle
}

export function cancelActiveUpdateDownload(): void {
  activeDownload?.cancel()
  activeDownload = undefined
}

/** Option A: launch NSIS wizard then quit the running app. */
export function launchInstallerAndQuit(installerPath: string): void {
  const path = installerPath.trim()
  if (path.length === 0) throw new Error("安装包路径为空")
  const child = spawn(path, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  })
  child.unref()
  app.quit()
}

export async function openUpdateDownloadExternal(downloadUrl: string): Promise<void> {
  const url = downloadUrl.trim()
  if (url.length === 0) throw new Error("下载地址为空")
  await shell.openExternal(url)
}
