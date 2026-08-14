import type { HistoryRetentionPreview, ProjectId } from "@worldseed/contracts"

import { digest } from "../../core/index.js"
import type {
  HistoryRepository,
  HistoryRetentionRewrite,
  HistoryVcsPort,
} from "./ports/index.js"

export class HistoryRetentionService {
  public constructor(
    private readonly repository: HistoryRepository,
    private readonly vcs: HistoryVcsPort,
    private readonly now: () => number = Date.now,
  ) {}

  public preview(projectId: ProjectId, retentionLimit: number | null): Promise<HistoryRetentionPreview> {
    return this.repository.previewRetention(projectId, retentionLimit)
  }

  public async apply(projectId: ProjectId, retentionLimit: number | null): Promise<HistoryRetentionPreview> {
    const plan = await this.repository.readRetentionPlan(projectId, retentionLimit)
    if (plan.preview.deleteCount === 0) return plan.preview
    const retainedIds = new Set(plan.retained.map((candidate) => candidate.entry.entryId))
    const rewrites: HistoryRetentionRewrite[] = []
    let parentCommitOid: string | undefined
    for (const candidate of plan.retained) {
      const snapshot = await this.vcs.readSnapshot(candidate.commitOid)
      const { digest: ignoredDigest, parentEntryId, ...content } = snapshot.manifest
      void ignoredDigest
      const nextParentEntryId = parentEntryId !== undefined && retainedIds.has(parentEntryId)
        ? parentEntryId
        : undefined
      const nextManifestContent = {
        ...content,
        ...(nextParentEntryId === undefined ? {} : { parentEntryId: nextParentEntryId }),
      }
      const manifest = { ...nextManifestContent, digest: digest(nextManifestContent) }
      const commitOid = await this.vcs.writeSnapshot({
        manifest,
        files: snapshot.files,
        ...(parentCommitOid === undefined ? {} : { parentCommitOid }),
      })
      rewrites.push({
        entryId: candidate.entry.entryId,
        commitOid,
        manifestDigest: manifest.digest,
        ...(nextParentEntryId === undefined ? {} : { parentEntryId: nextParentEntryId }),
      })
      parentCommitOid = commitOid
    }
    return this.repository.applyRetention(projectId, retentionLimit, this.now(), rewrites)
  }
}
