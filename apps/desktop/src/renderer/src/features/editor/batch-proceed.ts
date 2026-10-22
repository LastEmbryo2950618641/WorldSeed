const STORAGE_KEY = "worldseed.creation-desk.batch-proceed"

/** When true: skip synopsis/outline/body confirmation stops and auto-advance chapters. */
export function loadBatchProceedEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === "1" || raw === "true") return true
    if (raw === "0" || raw === "false") return false
  } catch {
    // ignore
  }
  return false
}

export function persistBatchProceedEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0")
  } catch {
    // ignore
  }
}
