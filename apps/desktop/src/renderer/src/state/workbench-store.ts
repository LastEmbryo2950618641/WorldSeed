import { create } from "zustand"

export type RightTab = "process" | "graph" | "evolution" | "history"

export type ProjectSettingsSection =
  | "execution"
  | "retrieval"
  | "graph"
  | "history"
  | "model"
  | "workDirectory"
  | "about"

type WorkbenchState = Readonly<{
  rightTab: RightTab
  setRightTab: (tab: RightTab) => void
  modelDialogOpen: boolean
  projectSettingsOpen: boolean
  projectSettingsSection: ProjectSettingsSection
  openModelDialog: () => void
  closeModelDialog: () => void
  openProjectSettings: (section?: ProjectSettingsSection) => void
  closeProjectSettings: () => void
  openModelFromSettings: () => void
  closeAllDialogs: () => void
}>

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  rightTab: "process",
  setRightTab: (rightTab) => { set({ rightTab }); },
  modelDialogOpen: false,
  projectSettingsOpen: false,
  projectSettingsSection: "execution",
  openModelDialog: () => { set({ modelDialogOpen: true }); },
  closeModelDialog: () => { set({ modelDialogOpen: false }); },
  openProjectSettings: (section = "execution") => {
    set({ projectSettingsOpen: true, projectSettingsSection: section });
  },
  closeProjectSettings: () => { set({ projectSettingsOpen: false }); },
  openModelFromSettings: () => {
    set({ projectSettingsOpen: false, modelDialogOpen: true });
  },
  closeAllDialogs: () => {
    set({ modelDialogOpen: false, projectSettingsOpen: false });
  },
}))
