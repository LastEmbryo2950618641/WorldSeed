/// <reference types="vite/client" />

import type { WorldseedBridge } from "../../preload/worldseed-bridge.js"

declare global {
  interface Window {
    worldseed?: WorldseedBridge
  }
}

export {}
