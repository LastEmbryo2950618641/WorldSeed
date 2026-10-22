import type { DiscussFocusChapterOption } from "./synopsis-path.js"
import { groupChaptersByVolume } from "./synopsis-path.js"

/** Platform rule: batch deduction chain-of-thought for the Agent. */
export const BATCH_VOLUME_PLAN_DOC_PATH =
  "世界推演规则/基础规则/batch-volume-deduction-plan.md"

export const VOLUME_OUTLINE_ROOT = "大纲"

/** `大纲/{卷文件夹名}.md` — name must match `章节正文/{卷文件夹名}/` exactly. */
export function volumeOutlinePath(volumeFolderName: string): string {
  return `${VOLUME_OUTLINE_ROOT}/${volumeFolderName}.md`
}

/** Heuristic: volume outline is complete enough to unlock batch deduction. */
export function isVolumeOutlineReady(markdown: string | undefined): boolean {
  const text = markdown?.trim() ?? ""
  if (text.length < 60) return false
  const chapterMarkers = text.match(/第\s*[0-9一二三四五六七八九十百千]+\s*章/gu) ?? []
  const headingCount = (text.match(/^#{1,3}\s+\S+/gmu) ?? []).length
  if (chapterMarkers.length >= 2) return true
  if (headingCount >= 3 && text.length >= 120) return true
  return false
}

export type VolumeBatchProgressRow = Readonly<{
  sequence: number
  label: string
  stage: "empty" | "synopsis" | "outline" | "draft" | "publishing" | "body"
  done: boolean
}>

/** Revision statuses that mean "submitted, graph revision / publication still running". */
export const PUBLISHING_REVISION_STATUSES: ReadonlySet<string> = new Set([
  "committing_content",
  "content_committed",
  "chapter_published",
  "chapter_registered",
  "graph_sync_pending",
  "graph_sync_running",
])

export function resolveChapterStageForProgress(
  chapter: DiscussFocusChapterOption,
  hasDraft: boolean,
): VolumeBatchProgressRow["stage"] {
  if (chapter.bodyPath !== undefined) return "body"
  if (hasDraft) return "draft"
  if (chapter.outlinePath !== undefined) return "outline"
  if (chapter.synopsisPath !== undefined) return "synopsis"
  return "empty"
}

export function buildVolumeBatchProgress(
  chapters: readonly DiscussFocusChapterOption[],
  draftSequences: ReadonlySet<number>,
  publishingSequences: ReadonlySet<number> = new Set(),
): readonly VolumeBatchProgressRow[] {
  return chapters.map((chapter) => {
    const stage = publishingSequences.has(chapter.sequence)
      ? "publishing"
      : resolveChapterStageForProgress(chapter, draftSequences.has(chapter.sequence))
    return {
      sequence: chapter.sequence,
      label: chapter.label,
      stage,
      done: stage === "body",
    }
  })
}

export function volumeBatchProgressStageLabel(stage: VolumeBatchProgressRow["stage"]): string {
  if (stage === "empty") return "未开始"
  if (stage === "synopsis") return "梗概"
  if (stage === "outline") return "细纲"
  if (stage === "draft") return "草稿"
  if (stage === "publishing") return "图修订中"
  return "正文"
}

/**
 * First incomplete volume from volume 1 upward: any chapter without published body.
 * Returns undefined when every chapter in every volume has a body.
 */
export function findFirstIncompleteVolume(
  chapters: readonly DiscussFocusChapterOption[],
): Readonly<{ volumeFolderName: string, chapters: readonly DiscussFocusChapterOption[] }> | undefined {
  const groups = groupChaptersByVolume(chapters)
  for (const group of groups) {
    if (group.volumeFolderName === "未分卷") continue
    const incomplete = group.chapters.some((chapter) => chapter.bodyPath === undefined)
    if (incomplete) {
      return { volumeFolderName: group.volumeFolderName, chapters: group.chapters }
    }
  }
  return undefined
}

export function chaptersInVolume(
  chapters: readonly DiscussFocusChapterOption[],
  volumeFolderName: string,
): readonly DiscussFocusChapterOption[] {
  return chapters
    .filter((chapter) => (chapter.volumeFolderName ?? "未分卷") === volumeFolderName)
    .slice()
    .sort((left, right) => left.sequence - right.sequence)
}
