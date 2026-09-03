/** In-flight synopsis.conversation.send cancellation flags (per project). */
const cancelledProjects = new Set<string>()

export function clearSynopsisSendCancellation(projectId: string): void {
  cancelledProjects.delete(projectId)
}

export function markSynopsisSendCancelled(projectId: string): void {
  cancelledProjects.add(projectId)
}

export function isSynopsisSendCancelled(projectId: string): boolean {
  return cancelledProjects.has(projectId)
}

export class SynopsisSendCancelledError extends Error {
  public constructor() {
    super("Synopsis conversation send cancelled by user")
    this.name = "SynopsisSendCancelledError"
  }
}
