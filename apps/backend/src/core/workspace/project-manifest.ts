import type { PROTOCOL_VERSION, ProjectId } from "@worldseed/contracts"

export const PROJECT_MANIFEST_VERSION = 1 as const

export type WorkspaceEntryRole =
  | "world_rules"
  | "base_rules"
  | "user_rules"
  | "settings"
  | "references"
  | "chapters"
  | "presentation"
  | "description_rules"
  | "prose_style_rules"

export type FixedWorkspaceEntry = Readonly<{
  key: string
  role: WorkspaceEntryRole
  relativePath: string
  entryKind: "directory" | "file"
  immutablePath: boolean
  allowedExtensions: readonly string[]
  allowUserFolders: boolean
  allowUserMarkdown: boolean
}>

export type ProjectManifest = Readonly<{
  id: ProjectId
  protocolVersion: typeof PROTOCOL_VERSION
  manifestVersion: typeof PROJECT_MANIFEST_VERSION
  predecessorManifestId?: string
  displayName: string
  workspaceRootRef: string
  fixedEntries: readonly FixedWorkspaceEntry[]
  internalStoreRef: string
  manifestDigest: string
}>

export const fixedWorkspaceEntries: readonly FixedWorkspaceEntry[] = Object.freeze([
  {
    key: "world-rules",
    role: "world_rules",
    relativePath: "世界推演规则",
    entryKind: "directory",
    immutablePath: true,
    allowedExtensions: [".md"],
    allowUserFolders: false,
    allowUserMarkdown: false,
  },
  {
    key: "base-rules",
    role: "base_rules",
    relativePath: "世界推演规则/基础规则",
    entryKind: "directory",
    immutablePath: true,
    allowedExtensions: [".md"],
    allowUserFolders: false,
    allowUserMarkdown: false,
  },
  {
    key: "base-rules-document",
    role: "base_rules",
    relativePath: "世界推演规则/基础规则/base-rules.md",
    entryKind: "file",
    immutablePath: true,
    allowedExtensions: [".md"],
    allowUserFolders: false,
    allowUserMarkdown: false,
  },
  {
    key: "plot-synopsis-guide",
    role: "base_rules",
    relativePath: "世界推演规则/基础规则/plot-synopsis-guide.md",
    entryKind: "file",
    immutablePath: true,
    allowedExtensions: [".md"],
    allowUserFolders: false,
    allowUserMarkdown: false,
  },
  {
    key: "user-rules",
    role: "user_rules",
    relativePath: "世界推演规则/用户规则",
    entryKind: "directory",
    immutablePath: true,
    allowedExtensions: [".md"],
    allowUserFolders: true,
    allowUserMarkdown: true,
  },
  {
    key: "settings",
    role: "settings",
    relativePath: "设定集",
    entryKind: "directory",
    immutablePath: true,
    allowedExtensions: [".md"],
    allowUserFolders: true,
    allowUserMarkdown: true,
  },
  {
    key: "settings-readme",
    role: "settings",
    relativePath: "设定集/readme.md",
    entryKind: "file",
    immutablePath: true,
    allowedExtensions: [".md"],
    allowUserFolders: false,
    allowUserMarkdown: true,
  },
  {
    key: "references",
    role: "references",
    relativePath: "参考文件",
    entryKind: "directory",
    immutablePath: true,
    allowedExtensions: [".md"],
    allowUserFolders: true,
    allowUserMarkdown: true,
  },
  {
    key: "references-readme",
    role: "references",
    relativePath: "参考文件/readme.md",
    entryKind: "file",
    immutablePath: true,
    allowedExtensions: [".md"],
    allowUserFolders: false,
    allowUserMarkdown: true,
  },
  {
    key: "chapters",
    role: "chapters",
    relativePath: "章节正文",
    entryKind: "directory",
    immutablePath: true,
    allowedExtensions: [".md"],
    allowUserFolders: false,
    allowUserMarkdown: false,
  },
  {
    key: "presentation",
    role: "presentation",
    relativePath: "表现输出",
    entryKind: "directory",
    immutablePath: true,
    allowedExtensions: [".md"],
    allowUserFolders: false,
    allowUserMarkdown: false,
  },
  {
    key: "description-rules",
    role: "description_rules",
    relativePath: "表现输出/描写规则",
    entryKind: "directory",
    immutablePath: true,
    allowedExtensions: [".md"],
    allowUserFolders: true,
    allowUserMarkdown: true,
  },
  {
    key: "prose-style-rules",
    role: "prose_style_rules",
    relativePath: "表现输出/笔风规则",
    entryKind: "directory",
    immutablePath: true,
    allowedExtensions: [".md"],
    allowUserFolders: true,
    allowUserMarkdown: true,
  },
])

export const fixedTopLevelDirectories = Object.freeze([
  "世界推演规则",
  "设定集",
  "参考文件",
  "章节正文",
  "表现输出",
] as const)
