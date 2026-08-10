import { create } from "zustand"

export type RightTab = "process" | "graph" | "evolution" | "history"

type WorkbenchState = Readonly<{
  rightTab: RightTab
  setRightTab: (tab: RightTab) => void
}>

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  rightTab: "process",
  setRightTab: (rightTab) => { set({ rightTab }); },
}))
