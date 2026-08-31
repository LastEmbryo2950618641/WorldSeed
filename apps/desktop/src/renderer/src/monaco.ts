import { loader } from "@monaco-editor/react"
import * as monaco from "monaco-editor"
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker"

type WorkerConstructor = new () => Worker
const createEditorWorker = (): Worker => {
  const Constructor = editorWorker as unknown as WorkerConstructor
  return new Constructor()
}

const monacoEnvironment = {
  getWorker: createEditorWorker,
}

Object.assign(globalThis, { MonacoEnvironment: monacoEnvironment })

loader.config({ monaco })

export const WORLDSEED_EDITOR_THEME = "worldseed-dark"

let themeRegistered = false

export function ensureWorldseedEditorTheme(monacoApi: typeof monaco = monaco): void {
  if (themeRegistered) return
  monacoApi.editor.defineTheme(WORLDSEED_EDITOR_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "FFFFFF" },
      { token: "comment", foreground: "C4C9CE" },
      { token: "keyword", foreground: "C9D1FF" },
      { token: "string", foreground: "B8F0C8" },
      { token: "number", foreground: "F0D9A0" },
      { token: "emphasis", fontStyle: "italic" },
      { token: "strong", fontStyle: "bold", foreground: "FFFFFF" },
    ],
    colors: {
      "editor.background": "#313338",
      "editor.foreground": "#FFFFFF",
      "editorLineNumber.foreground": "#C4C9CE",
      "editorLineNumber.activeForeground": "#F2F3F5",
      "editorCursor.foreground": "#FFFFFF",
      "editor.selectionBackground": "#5865F255",
      "editor.inactiveSelectionBackground": "#5865F233",
      "editor.lineHighlightBackground": "#35373C66",
      "editorIndentGuide.background1": "#3F4147",
      "editorIndentGuide.activeBackground1": "#4E5058",
      "editorWidget.background": "#2B2D31",
      "editorWidget.foreground": "#FFFFFF",
      "editorSuggestWidget.foreground": "#FFFFFF",
      "editorGutter.background": "#313338",
    },
  })
  themeRegistered = true
}

ensureWorldseedEditorTheme()
