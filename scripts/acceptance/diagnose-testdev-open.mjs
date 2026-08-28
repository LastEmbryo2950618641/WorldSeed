import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { PROTOCOL_VERSION } from "../../packages/contracts/dist/index.js"

const workspaceRootRef = "C:\\Users\\liuqi\\Documents\\NBook\\TestDev"
const applicationDataRoot = join(process.env.APPDATA ?? "", "@worldseed", "desktop", "runtime")
const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..")
const backendEntry = pathToFileURL(join(repoRoot, "apps/backend/dist/index.js")).href

const {
  NodeInternalStoreAdapter,
  NodeWorkspaceAdapter,
  openRegistryDatabase,
  ProjectLifecycleService,
  SqliteProjectRegistryRepository,
  SqliteProjectRepositoryFactory,
  digest,
  fixedWorkspaceEntries,
  PROJECT_MANIFEST_VERSION,
} = await import(backendEntry)

const registryDatabase = await openRegistryDatabase(join(applicationDataRoot, "registry.sqlite"))
const registry = new SqliteProjectRegistryRepository(registryDatabase)
const registered = await registry.findByWorkspaceRoot(resolve(workspaceRootRef))
if (registered === undefined) {
  console.log(JSON.stringify({ status: "not_registered", workspaceRootRef }, null, 2))
  process.exit(0)
}

const workspace = new NodeWorkspaceAdapter()
const report = await workspace.validate(workspaceRootRef)
const internalStore = new NodeInternalStoreAdapter(applicationDataRoot)
const store = await internalStore.inspectProject(registered.projectId, report.workspaceRootRef, registered.internalStoreRef)
const session = await new SqliteProjectRepositoryFactory().open(store, report.workspaceRootRef)
const manifest = await session.repository.readManifest(registered.projectId)
await session.close()

const digestInput = {
  projectId: registered.projectId,
  displayName: manifest?.displayName ?? "",
  workspaceRootRef: report.workspaceRootRef,
  internalStoreRef: store.internalStoreRef,
  baseRulesDigest: report.baseRulesDigest,
}
const expectedDigest = digest({
  protocolVersion: PROTOCOL_VERSION,
  manifestVersion: PROJECT_MANIFEST_VERSION,
  fixedEntries: fixedWorkspaceEntries,
  ...digestInput,
})
const legacyDigest = manifest === undefined ? undefined : digest({
  protocolVersion: PROTOCOL_VERSION,
  manifestVersion: PROJECT_MANIFEST_VERSION,
  fixedEntries: manifest.fixedEntries,
  ...digestInput,
})

const lifecycle = new ProjectLifecycleService(
  registry,
  workspace,
  internalStore,
  new SqliteProjectRepositoryFactory(),
)

let openResult = "pending"
try {
  await lifecycle.openByWorkspace(workspaceRootRef, Date.now(), {
    baseRules: "",
    plotSynopsisGuide: "# plot\n",
    settingsQueryGuide: "# settings query\n",
    settingsRevisionGuide: "# settings revision\n",
    settingsReadme: "",
    referencesReadme: "",
    descriptionRules: "",
    proseStyleRules: "",
  })
  openResult = "pass"
} catch (error) {
  openResult = error instanceof Error ? error.message : String(error)
}

console.log(JSON.stringify({
  workspaceIssues: report.issues,
  baseRulesDigest: report.baseRulesDigest,
  storedDigest: manifest?.manifestDigest,
  expectedDigest,
  legacyDigest,
  legacyMatchesStored: legacyDigest === manifest?.manifestDigest,
  expectedMatchesStored: expectedDigest === manifest?.manifestDigest,
  storedFixedEntryCount: manifest?.fixedEntries.length,
  currentFixedEntryCount: fixedWorkspaceEntries.length,
  hasPlotSynopsisGuideInStored: manifest?.fixedEntries.some((entry) => entry.key === "plot-synopsis-guide"),
  openResult,
}, null, 2))

await registryDatabase.destroy()
