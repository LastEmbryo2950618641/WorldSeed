/** Artifact keys that continue after `assistantMessage` in synopsis_discuss JSON. */
export const DISCUSS_RESULT_FIELDS = [
  { id: "synopsisBody", label: "剧情梗概" },
  { id: "outlineBody", label: "剧情细纲" },
  { id: "bodyEdits", label: "细纲修订" },
  { id: "presentationWrites", label: "本作品描写" },
  { id: "arcPlan", label: "弧大纲" },
  { id: "stagingDelta", label: "暂存区" },
  { id: "stagingPromote", label: "落盘提案" },
  { id: "choices", label: "选项" },
  { id: "goalProposals", label: "剧情目标" },
  { id: "finalSelfReview", label: "自检" },
] as const

export type DiscussStreamFieldProgress = Readonly<{
  id: string
  label: string
  present: boolean
}>

export type DiscussStreamProgress = Readonly<{
  receivedChars: number
  fields: readonly DiscussStreamFieldProgress[]
  presentCount: number
}>

export function inspectDiscussStreamPayload(raw: string | undefined): DiscussStreamProgress {
  const text = raw ?? ""
  const fields = DISCUSS_RESULT_FIELDS.map((field) => ({
    id: field.id,
    label: field.label,
    present: hasJsonKey(text, field.id),
  }))
  return {
    receivedChars: text.length,
    fields,
    presentCount: fields.filter((field) => field.present).length,
  }
}

export function formatDiscussReceivedChars(count: number): string {
  if (count >= 10_000) return `${(count / 10_000).toFixed(1)} 万字`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k 字`
  return `${String(count)} 字`
}

function hasJsonKey(raw: string, key: string): boolean {
  return new RegExp(`"${key}"\\s*:`, "u").test(raw)
}
