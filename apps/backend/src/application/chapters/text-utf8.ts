import { readFile, writeFile } from "node:fs/promises"

/**
 * App text contract: all worldseed-owned strings are Unicode in memory;
 * disk and IPC text is UTF-8 without BOM (unless an external tool adds one).
 *
 * The only intentional exception is Windows shell *stdout/stderr* decoding:
 * after we force `chcp 65001`, output is preferably UTF-8, with a GBK fallback
 * for child processes that still emit the legacy OEM/ANSI code page.
 */

export const TEXT_ENCODING_UTF8 = "utf8" as const

/** Drop a leading UTF-8 BOM so paths/content compare and display cleanly. */
export function stripUtf8Bom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text
}

export async function readTextFileUtf8(path: string): Promise<string> {
  return stripUtf8Bom(await readFile(path, TEXT_ENCODING_UTF8))
}

/** Write UTF-8 without BOM (BOM breaks some cmd parsers on the first line). */
export async function writeTextFileUtf8(path: string, content: string): Promise<void> {
  await writeFile(path, stripUtf8Bom(content), TEXT_ENCODING_UTF8)
}

/** Env overrides that nudge common child runtimes toward UTF-8 on Windows. */
export function windowsUtf8ProcessEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  }
}
