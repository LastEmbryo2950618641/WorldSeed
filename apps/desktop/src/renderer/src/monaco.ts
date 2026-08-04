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
