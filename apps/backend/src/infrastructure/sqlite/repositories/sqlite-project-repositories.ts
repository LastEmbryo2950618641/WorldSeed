import type { Kysely } from "kysely"

import {
  PROTOCOL_VERSION,
  type ProjectId,
} from "@worldseed/contracts"

import type {
  ProjectManifest,
  ProjectRegistryRepository,
  ProjectRepository,
  RegisteredProject,
  StoredProject,
} from "../../../index.js"
import type { ProjectDatabase, RegistryDatabase } from "../database-types.js"
import { decodeJson, encodeJson } from "../json-codec.js"

export class SqliteProjectRegistryRepository implements ProjectRegistryRepository {
  public constructor(private readonly database: Kysely<RegistryDatabase>) {}

  public async register(project: RegisteredProject): Promise<void> {
    await this.database.insertInto("registered_projects").values({
      project_id: project.projectId,
      workspace_root_ref: project.workspaceRootRef,
      internal_store_ref: project.internalStoreRef,
      last_opened_at: project.lastOpenedAtMs,
      created_at: project.createdAtMs,
    }).executeTakeFirstOrThrow()
  }

  public async findById(projectId: ProjectId): Promise<RegisteredProject | undefined> {
    const row = await this.database.selectFrom("registered_projects")
      .selectAll()
      .where("project_id", "=", projectId)
      .executeTakeFirst()
    return row === undefined ? undefined : mapRegisteredProject(row)
  }

  public async findByWorkspaceRoot(workspaceRootRef: string): Promise<RegisteredProject | undefined> {
    const row = await this.database.selectFrom("registered_projects")
      .selectAll()
      .where("workspace_root_ref", "=", workspaceRootRef)
      .executeTakeFirst()
    return row === undefined ? undefined : mapRegisteredProject(row)
  }

  public async touch(projectId: ProjectId, lastOpenedAtMs: number): Promise<void> {
    const result = await this.database.updateTable("registered_projects")
      .set({ last_opened_at: lastOpenedAtMs })
      .where("project_id", "=", projectId)
      .executeTakeFirst()
    if (result.numUpdatedRows !== 1n) {
      throw new Error(`Registered project does not exist: ${projectId}`)
    }
  }
}

function mapRegisteredProject(row: RegistryDatabase["registered_projects"]): RegisteredProject {
  return {
    projectId: row.project_id,
    workspaceRootRef: row.workspace_root_ref,
    internalStoreRef: row.internal_store_ref,
    lastOpenedAtMs: row.last_opened_at,
    createdAtMs: row.created_at,
  }
}

export class SqliteProjectRepository implements ProjectRepository {
  public constructor(
    private readonly database: Kysely<ProjectDatabase>,
    private readonly workspaceRootRef: string,
    private readonly internalStoreRef: string,
  ) {}

  public async create(project: StoredProject, manifest: ProjectManifest): Promise<void> {
    if (manifest.id !== project.projectId) {
      throw new Error("Project and manifest identifiers must match")
    }
    if (manifest.workspaceRootRef !== this.workspaceRootRef || manifest.internalStoreRef !== this.internalStoreRef) {
      throw new Error("Manifest storage references do not match the registered project")
    }

    await this.database.transaction().execute(async (transaction) => {
      await transaction.insertInto("projects").values({
        id: project.projectId,
        name: project.name,
        manifest_version: project.manifestVersion,
        committed_sequence: project.committedSequence,
        created_at: project.createdAtMs,
        updated_at: project.updatedAtMs,
      }).executeTakeFirstOrThrow()
      await transaction.insertInto("project_manifests").values({
        project_id: project.projectId,
        schema_version: manifest.manifestVersion,
        fixed_entries_json: encodeJson(manifest.fixedEntries),
        digest: manifest.manifestDigest,
        updated_at: project.updatedAtMs,
      }).executeTakeFirstOrThrow()
    })
  }

  public async find(projectId: ProjectId): Promise<StoredProject | undefined> {
    const row = await this.database.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirst()
    if (row === undefined) {
      return undefined
    }
    return {
      projectId: row.id,
      name: row.name,
      manifestVersion: row.manifest_version,
      committedSequence: row.committed_sequence,
      createdAtMs: row.created_at,
      updatedAtMs: row.updated_at,
    }
  }

  public async readManifest(projectId: ProjectId): Promise<ProjectManifest | undefined> {
    const row = await this.database.selectFrom("project_manifests")
      .innerJoin("projects", "projects.id", "project_manifests.project_id")
      .select([
        "project_manifests.project_id",
        "project_manifests.schema_version",
        "project_manifests.fixed_entries_json",
        "project_manifests.digest",
        "projects.name",
      ])
      .where("project_manifests.project_id", "=", projectId)
      .executeTakeFirst()
    if (row === undefined) {
      return undefined
    }

    return {
      id: row.project_id,
      protocolVersion: PROTOCOL_VERSION,
      manifestVersion: 1,
      displayName: row.name,
      workspaceRootRef: this.workspaceRootRef,
      fixedEntries: decodeJson(row.fixed_entries_json) as ProjectManifest["fixedEntries"],
      internalStoreRef: this.internalStoreRef,
      manifestDigest: row.digest,
    }
  }
}
