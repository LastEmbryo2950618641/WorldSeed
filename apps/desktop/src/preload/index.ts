import { contextBridge } from "electron"

import { worldseedBridge } from "./worldseed-bridge.js"

contextBridge.exposeInMainWorld("worldseed", worldseedBridge)
