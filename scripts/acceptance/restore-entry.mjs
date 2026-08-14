import { randomUUID } from "node:crypto"

import { connectElectron, invokeBackend } from "./lib/electron-backend.mjs"

const [workspaceRootRef, projectId, entryId, cdpUrl = "http://127.0.0.1:9232"] = process.argv.slice(2)
if (workspaceRootRef === undefined || projectId === undefined || entryId === undefined) {
  throw new Error("Usage: node restore-entry.mjs <workspace> <projectId> <entryId> [cdpUrl]")
}

const { browser, page } = await connectElectron(cdpUrl, workspaceRootRef)
try {
  const result = await invokeBackend(page, "history.restore", {
    projectId,
    workspaceRootRef,
    operationId: randomUUID(),
    entryId,
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  await browser.close()
}
