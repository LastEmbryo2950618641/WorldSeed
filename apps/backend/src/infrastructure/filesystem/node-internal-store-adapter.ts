import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"

import { idSchema, type ProjectId } from "@worldseed/contracts"

import type {
  InternalProjectStore,
  InternalStorePort,
} from "../../application/index.js"

export class NodeInternalStoreAdapter implements InternalStorePort {
  private readonly applicationDataRoot: string

  public constructor(applicationDataRoot: string) {
    this.applicationDataRoot = resolve(applicationDataRoot)
  }

  public async prepareProject(projectId: ProjectId, workspaceRootRef: string): Promise<InternalProjectStore> {
    idSchema.parse(projectId)
    await mkdir(this.applicationDataRoot, { recursive: true })
    const appRoot = await realpath(this.applicationDataRoot)
    const workspaceRoot = await realpath(resolve(workspaceRootRef))
    const store = buildStore(appRoot, projectId)
    assertRootsSeparated(workspaceRoot, store.internalStoreRef)
    await Promise.all([
      mkdir(store.documentsRef, { recursive: true }),
      mkdir(store.promptsRef, { recursive: true }),
      mkdir(store.externalContentRef, { recursive: true }),
      mkdir(store.indexesRef, { recursive: true }),
      mkdir(store.modelCacheRef, { recursive: true }),
      mkdir(store.recoveryRef, { recursive: true }),
    ])
    return { ...store, internalStoreRef: await realpath(store.internalStoreRef) }
  }

  public async inspectProject(
    projectId: ProjectId,
    workspaceRootRef: string,
    internalStoreRef: string,
  ): Promise<InternalProjectStore> {
    idSchema.parse(projectId)
    const workspaceRoot = await realpath(resolve(workspaceRootRef))
    const internalRoot = await realpath(resolve(internalStoreRef))
    assertRootsSeparated(workspaceRoot, internalRoot)
    const expected = buildStore(await realpath(this.applicationDataRoot), projectId)
    if (internalRoot !== await realpath(expected.internalStoreRef)) {
      throw new Error("Registered internal store does not match the application project location")
    }
    await Promise.all([
      access(expected.projectDatabaseRef),
      access(expected.documentsRef),
      access(expected.promptsRef),
      access(expected.externalContentRef),
      access(expected.indexesRef),
      access(expected.modelCacheRef),
      access(expected.recoveryRef),
    ])
    return { ...expected, internalStoreRef: internalRoot }
  }

  public async writeImmutableDocument(
    store: InternalProjectStore,
    sourceId: string,
    content: string,
  ): Promise<string> {
    idSchema.parse(sourceId)
    const path = join(store.documentsRef, `${sourceId}.md`)
    assertContained(store.documentsRef, path)
    await writeFile(path, content, { encoding: "utf8", flag: "wx" })
    return path
  }

  public async readDocument(contentRef: string): Promise<string> {
    const path = await realpath(resolve(contentRef))
    assertContained(this.applicationDataRoot, path)
    return readFile(path, "utf8")
  }
}

function buildStore(applicationDataRoot: string, projectId: ProjectId): InternalProjectStore {
  const internalStoreRef = join(applicationDataRoot, "projects", projectId)
  const objectsRef = join(internalStoreRef, "objects")
  return {
    projectId,
    internalStoreRef,
    projectDatabaseRef: join(internalStoreRef, "project.sqlite"),
    documentsRef: join(objectsRef, "documents"),
    promptsRef: join(objectsRef, "prompts"),
    externalContentRef: join(objectsRef, "external-content"),
    indexesRef: join(internalStoreRef, "indexes"),
    modelCacheRef: join(internalStoreRef, "model-cache"),
    recoveryRef: join(internalStoreRef, "recovery"),
  }
}

function assertRootsSeparated(workspaceRoot: string, internalRoot: string): void {
  if (isContained(workspaceRoot, internalRoot) || isContained(internalRoot, workspaceRoot)) {
    throw new Error("User workspace and internal project storage must be physically separate")
  }
}

function assertContained(root: string, target: string): void {
  if (!isContained(resolve(root), resolve(target))) {
    throw new Error("Internal object path escapes the application data root")
  }
}

function isContained(root: string, target: string): boolean {
  const fromRoot = relative(root, target)
  return fromRoot.length === 0 || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
}
