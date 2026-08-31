import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"

import {
  ProjectLifecycleService,
  type AIModelPort,
  type ModelCatalogPort,
  type ModelProfileStorePort,
  type CreatedProject,
  type CreateProjectInput,
} from "../application/index.js"
import type { InternalProjectStore, ProjectRepositoryFactory, WorkspaceDefaultDocuments, WorkspacePort } from "../application/workspace/index.js"
import type { RegisteredProject } from "../application/projects/index.js"
import { NodeInternalStoreAdapter, NodeWorkspaceAdapter } from "../infrastructure/filesystem/index.js"
import {
  createModelFromEnvironment,
  createModelFromSelection,
  DeepSeekModelCatalogAdapter,
  type DeepSeekModelSelection,
} from "../infrastructure/models/index.js"
import { NodePromptResourceAdapter } from "../infrastructure/prompts/index.js"
import {
  SqliteProjectRegistryRepository,
  SqliteModelProfileStore,
  SqliteProjectRepositoryFactory,
  openRegistryDatabase,
} from "../infrastructure/sqlite/index.js"
import type { Kysely } from "kysely"
import type { RegistryDatabase } from "../infrastructure/sqlite/database-types.js"
import { ProjectRuntime } from "./project-runtime.js"

export type BackendContainerOptions = Readonly<{
  applicationDataRoot: string
  promptPackageRoot: string
  model?: AIModelPort
  modelCatalog?: ModelCatalogPort
  modelProfiles?: ModelProfileStorePort
  workspaceDefaults?: WorkspaceDefaultDocuments
  createId?: () => string
  now?: () => number
}>

export class BackendContainer {
  public readonly workspace = new NodeWorkspaceAdapter()
  public readonly internalStore: NodeInternalStoreAdapter
  public readonly model: AIModelPort
  public readonly modelCatalog: ModelCatalogPort
  public readonly modelProfiles: ModelProfileStorePort
  public readonly createId: () => string
  public readonly now: () => number
  private readonly lifecycle: ProjectLifecycleService
  private readonly registryDatabase: Kysely<RegistryDatabase>
  private readonly projectRepositoryFactory: ProjectRepositoryFactory
  private readonly promptPackageRoot: string
  private readonly workspaceDefaults: WorkspaceDefaultDocuments | undefined
  private currentRuntime: ProjectRuntime | undefined

  private constructor(
    options: BackendContainerOptions,
    registryDatabase: Kysely<RegistryDatabase>,
  ) {
    this.registryDatabase = registryDatabase
    this.internalStore = new NodeInternalStoreAdapter(options.applicationDataRoot)
    this.model = options.model ?? createModelFromEnvironment(
      options.promptPackageRoot,
    )
    this.modelCatalog = options.modelCatalog ?? new DeepSeekModelCatalogAdapter()
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
    this.modelProfiles = options.modelProfiles ?? new SqliteModelProfileStore(this.registryDatabase, this.now)
    this.promptPackageRoot = resolve(options.promptPackageRoot)
    this.workspaceDefaults = options.workspaceDefaults
    this.projectRepositoryFactory = new SqliteProjectRepositoryFactory()
    this.lifecycle = new ProjectLifecycleService(
      new SqliteProjectRegistryRepository(this.registryDatabase),
      this.workspace,
      this.internalStore,
      this.projectRepositoryFactory,
    )
  }

  public static async open(options: BackendContainerOptions): Promise<BackendContainer> {
    const applicationDataRoot = resolve(options.applicationDataRoot)
    const registryDatabase = await openRegistryDatabase(join(applicationDataRoot, "registry.sqlite"))
    return new BackendContainer(options, registryDatabase)
  }

  public async createProject(input: Omit<CreateProjectInput, "defaults" | "nowMs">): Promise<CreatedProject> {
    const defaults = await this.resolveWorkspaceDefaults()
    const created = await this.lifecycle.create({
      ...input,
      defaults,
      nowMs: this.now(),
    })
    await this.openRuntime(created.internalStore, input.workspaceRootRef, input.projectId)
    return created
  }

  public async openProject(workspaceRootRef: string): Promise<CreatedProject> {
    const defaults = await this.resolveWorkspaceDefaults()
    const opened = await this.lifecycle.openByWorkspace(workspaceRootRef, this.now(), defaults)
    await this.openRuntime(opened.internalStore, opened.manifest.workspaceRootRef, opened.manifest.id)
    return opened
  }

  public async listProjects(): Promise<readonly RegisteredProject[]> {
    return this.lifecycle.listRegistered()
  }

  public async peekProjectDisplayName(project: RegisteredProject): Promise<string | undefined> {
    return this.lifecycle.peekDisplayName(project)
  }

  public async getRuntime(projectId: string, workspaceRootRef: string): Promise<ProjectRuntime> {
    const resolvedRoot = resolve(workspaceRootRef)
    if (
      this.currentRuntime !== undefined
      && this.currentRuntime.projectId === projectId
      && this.currentRuntime.workspaceRootRef === resolvedRoot
      && !this.currentRuntime.isClosed()
    ) {
      return this.currentRuntime
    }
    const opened = await this.openProject(workspaceRootRef)
    if (opened.manifest.id !== projectId) {
      throw new Error("The workspace belongs to a different project")
    }
    if (this.currentRuntime === undefined || this.currentRuntime.isClosed()) {
      throw new Error("Project runtime failed to open")
    }
    return this.currentRuntime
  }

  public async validateProject(workspaceRootRef: string): Promise<Awaited<ReturnType<WorkspacePort["validate"]>>> {
    return this.workspace.validate(workspaceRootRef)
  }

  public getCurrentRuntime(): ProjectRuntime | undefined {
    return this.currentRuntime
  }

  public createModelFromSelection(selection: DeepSeekModelSelection): AIModelPort {
    return createModelFromSelection(this.promptPackageRoot, selection)
  }

  public async close(): Promise<void> {
    await this.currentRuntime?.close()
    await this.registryDatabase.destroy()
  }

  private async openRuntime(store: InternalProjectStore, workspaceRootRef: string, projectId: string): Promise<void> {
    const previous = this.currentRuntime
    this.currentRuntime = undefined
    if (previous !== undefined && !previous.isClosed()) {
      await previous.close()
    }
    this.currentRuntime = await ProjectRuntime.open(
      projectId,
      resolve(workspaceRootRef),
      store,
      this.internalStore,
      this.promptPackageRoot,
      this.workspace,
    )
  }

  private async resolveWorkspaceDefaults(): Promise<WorkspaceDefaultDocuments> {
    if (this.workspaceDefaults !== undefined) return this.workspaceDefaults
    const prompts = new NodePromptResourceAdapter(this.promptPackageRoot)
    const [baseRules, plotSynopsisGuide, settingsQueryGuide, settingsRevisionGuide] = await Promise.all([
      prompts.loadBaseRules(),
      prompts.loadPlotSynopsisGuide(),
      prompts.loadSettingsQueryGuide(),
      prompts.loadSettingsRevisionGuide(),
    ])
    return {
      baseRules: baseRules.text,
      plotSynopsisGuide: plotSynopsisGuide.text,
      settingsQueryGuide: settingsQueryGuide.text,
      settingsRevisionGuide: settingsRevisionGuide.text,
      settingsReadme: "# 设定集索引\n\n请在这里说明设定文件的内容、路径与适用条件，供 AI 按需选择读取。\n",
      referencesReadme: "# 参考文件索引\n\n请在这里说明参考资料的内容、路径与使用条件，供 AI 按需选择读取。\n",
      descriptionRules: "# 默认描写规则\n\n由用户在表现输出目录中继续定义。\n",
      proseStyleRules: "# 默认笔风规则\n\n由用户在表现输出目录中继续定义。\n",
      stagingReadme: [
        "# 暂存区",
        "",
        "创作台讨论中的**中间态**草稿。权威设定仍以 `设定集/` 为准。",
        "",
        "- 每轮讨论后 Agent 自动更新本目录固定文件",
        "- 用户确认「落盘」后写入设定集；对应条目标记 `settled`，仍可检索",
        "- 超字数上限时优先清理最旧的已落盘条目",
        "",
      ].join("\n"),
      stagingNotes: "# 本章讨论笔记\n\n（尚无条目）\n",
      stagingCharacters: "# 人物草稿\n\n（尚无条目）\n",
      stagingWorld: "# 世界与规则草稿\n\n（尚无条目）\n",
      stagingPromoteIndex: "# 待落盘清单\n\n（尚无条目）\n",
    }
  }
}
