export class SettingsExtractionReviewPendingError extends Error {
  public readonly kind = "settings_extraction_review" as const

  public constructor(public readonly proposalCount: number) {
    super(`Settings extraction produced ${String(proposalCount)} proposal(s) awaiting user confirmation`)
  }
}
