import type { ProjectSettings } from "@worldseed/contracts"

import { ModelConfigurationDialog, type ModelProfile } from "./ModelConfigurationDialog.js"
import { ProjectSettingsDialog } from "./ProjectSettingsDialog.js"
import { useWorkbenchStore, type ProjectSettingsSection } from "../../state/workbench-store.js"
import type { UpdateCheckResult, AppUpdateInfoResult, UpdateManifest } from "../../api/client.js"

type Props = Readonly<{
  projectName: string
  projectSettings: ProjectSettings | undefined
  historyEntryCount: number
  modelProfiles: readonly ModelProfile[]
  activeModelProfileId: string
  activeModelName: string
  appUpdate: Readonly<{
    info: AppUpdateInfoResult | null
    checking: boolean
    error: string | null
    statusMessage: string | null
    remote: UpdateManifest | null
    refreshInfo: () => Promise<void>
    checkNow: (force?: boolean) => Promise<UpdateCheckResult | null>
  }>
  onSaveModelProfiles: (profiles: readonly ModelProfile[], activeProfileId: string) => Promise<void> | void
  onSaveProjectSettings: (settings: ProjectSettings) => void | Promise<void>
}>

/**
 * Subscribes only to dialog open flags so opening Settings/Model does not
 * re-render the Monaco / tree / right-rail workbench owned by App.
 */
export function AppDialogsHost(props: Props): React.JSX.Element | null {
  const modelDialogOpen = useWorkbenchStore((state) => state.modelDialogOpen)
  const projectSettingsOpen = useWorkbenchStore((state) => state.projectSettingsOpen)
  const projectSettingsSection = useWorkbenchStore((state) => state.projectSettingsSection)
  const closeModelDialog = useWorkbenchStore((state) => state.closeModelDialog)
  const closeProjectSettings = useWorkbenchStore((state) => state.closeProjectSettings)
  const openModelFromSettings = useWorkbenchStore((state) => state.openModelFromSettings)

  if (!modelDialogOpen && !projectSettingsOpen) return null

  return (
    <>
      {modelDialogOpen
        ? <ModelConfigurationDialog
            profiles={props.modelProfiles}
            activeProfileId={props.activeModelProfileId}
            onClose={closeModelDialog}
            onSave={props.onSaveModelProfiles}
          />
        : null}
      {projectSettingsOpen && props.projectSettings !== undefined
        ? <ProjectSettingsDialog
            projectName={props.projectName}
            settings={props.projectSettings}
            activeModelName={props.activeModelName}
            historyEntryCount={props.historyEntryCount}
            initialSection={projectSettingsSection as ProjectSettingsSection}
            appUpdate={props.appUpdate}
            onClose={closeProjectSettings}
            onSave={props.onSaveProjectSettings}
            onOpenModelSettings={openModelFromSettings}
          />
        : null}
    </>
  )
}
