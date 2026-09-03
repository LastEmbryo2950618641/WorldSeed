# 设定沿革与按章召回设计

> **状态：** 设计草案（2026-08-31）；多 agent 可行性评审后修订  
> **范围：** `设定集/` 写入记账（沿革）、目录虚拟入口 + 时间线 UI、作者按章回忆、AI 按需加载过去设定/章节。  
> **关联：** [暂存区](./2026-08-30-synopsis-staging-area-design.md) · [章节草稿版本](./2026-08-26-chapter-draft-versions-design.md) · `settings-extraction` · `settings-revision-guide.md` · 世界历史 `history.*`  
> **原型：** [settings-lineage.html](../../prototypes/settings-lineage.html)

---

## 0. 可行性结论（评审摘要）

| 维度 | 结论 |
| --- | --- |
| 总体 | **可行（risky，非 blocked）**；主险是多路径写设定漏记账，不是存不下 |
| 后端 | M；UI 全做完 P0 为 L |
| 桌面 UI | 可行：虚拟树节点 + 独立沿革面板，**禁止**走 `openFile(.md)` |

**编码前约束（评审采纳）：**

1. **单一写入记账入口** `recordSettingsUpsert`（或装饰所有 `设定集/` 的 `saveUserMarkdown`），禁止只在个别 service 散落挂钩。  
2. 磁盘 + SQLite **尽力一致**，不宣称同一 ACID 事务；`head`/`open` 可对账 digest。  
3. 迁移 seed 在 **项目打开** 时幂等扫描，不放进纯 SQL migration。  
4. `history.restore` 后重对齐：**P0 尽力做**（restore 后对 `设定集/` 差异补 `history_restore`）；若工期不够则文档标明 defer，且不声称 heads≡磁盘。  
5. P0 API 可缩为 `list` + `getCommit`（+ `headMeta`）；`readAsOf` 可跟 P1 AI。  
6. 章序：能解析则写，否则 **NULL**；不编造。

---

## 1. 用户目标

长篇写作中设定会演变。系统需要：

1. **能回忆过去设定**：某文件在「写到第 N 章时」是怎么说的，以及每次因何而改；
2. **AI 可按需加载**：闪回、防剧透、对账时，按「第 N 章视角」取设定片段或旧章正文，充实真实性；
3. **目录可发现**：设定沿革以**特殊入口**出现在工作区目录中；点入后选文件，以**时间线**展示变动。

**非目标（本阶段）：**

- 不强制抽取/维护故事日历时间线；
- 不对作者暴露 git / commit / branch 话术；
- 不用整库世界历史 checkout 充当日常「翻旧设定」；
- 不在 v1 做逐句版本、多分支合并、从沿革一键覆盖当前（危险操作另立）。

---

## 2. 决策记录（已确认）

| 议题 | 选择 |
| --- | --- |
| 回忆主键 | **章因果序**（as-of 第 N 章）；故事时间可选、永不挡写入 |
| 当前真相 | 仍为工作区 `设定集/*.md` 物化文件 |
| 沿革存储 | 项目 SQLite 账本 + 内容寻址正文；与 `history.git` 正交 |
| 写入时机 | 抽取批准、暂存落盘、作者保存设定、世界历史 restore 后重对齐 |
| 目录形态 | **虚拟入口**（非磁盘真文件）；点文件 → 时间线面板 |
| AI 读取 | 扩展现有 `ReadRequest`（`purpose` / `asOfChapterSequence`），先做创作台 |
| 批准 UX | 静默记账；变更说明可选，不强制填表 |

---

## 3. 产品体验

### 3.1 目录

工作区树在固定根旁（或紧挨 `设定集/`）展示虚拟节点，文案建议：

```text
设定集/          ← 普通目录，点文件 = 编辑当前真相
设定沿革          ← 虚拟入口（特殊形态，非 .md）
```

- 虚拟节点**不**写入 `inventory` 真路径、**不**出现在磁盘；
- 视觉可区分（图标/标签「沿革」），避免与普通文件混淆。

### 3.2 点击流

```text
点击「设定沿革」
  → 进入沿革浏览（列出设定集下文件树，或扁平近期变动）
点击某一设定文件（如 设定集/人物/林照.md）
  → 读取该路径账本
  → 以时间线渲染历次变动（新→旧或旧→新，默认新在上）
```

时间线每一项展示：

| 元素 | 说明 |
| --- | --- |
| 次序/时间 | 写入时刻 |
| 因第 N 章 | 有则显示；无则「手工保存 / 落盘 / 迁移」等来源 |
| 说明 | 可选一句话 |
| 内容对比 | 相对上一版：删行红、增行绿（复用章节草稿 diff 观感） |
| 当时全文 | 只读展开；**不**默认写回当前文件 |

编辑器打开 `设定集/*.md` 时行为不变（改当前真相）。沿革视图与编辑视图分流。

### 3.3 作者批准

「采纳并写入」/「确认落盘」语义不变 → 后台记一笔沿革并更新当前文件。  
可选折叠：「变更说明（可选）」。

### 3.4 AI 透明（P1）

若本轮实际注入了「第 N 章视角」证据，右栏/脚注提示：  
**「本次参考了第 N 章时的说法（非当前设定全文）」**；点击可打开对应时间线条目。

---

## 4. 原理（人话）

- **当前本子**：`设定集/` 文件，给人接着写。  
- **流水账**：每次改设定多记一笔（哪份文件、变成什么、因哪章、为何）。  
- **回忆**：按「第 N 章」把账本叠回去，得到当时说法。  
- **AI**：默认读当前；需要时按同一把「第 N 章」尺子按需取一小段。

---

## 5. 存储方案

### 5.1 选型

| 内容 | 技术 | 理由 |
| --- | --- | --- |
| 当前设定 | 工作区 Markdown | 已有编辑/树/检索 |
| 沿革元数据 + 版本正文 | 项目 SQLite（blobs + commits + heads） | 本地、按路径/章序查询、与现有提案表一致 |
| 过去章节正文 | 现有 `document_versions` / `source_units` / `chapter_lineage_snapshots` | 不重复造轮子 |
| 整库备份 | 现有 `history.*` | 灾难恢复；不承担细粒度沿革 |

### 5.2 逻辑表（实现名可微调）

**settings_blobs**：`digest` → markdown 正文（相同内容去重）

**settings_commits**（只增不改）：

- `commit_id`, `project_id`, `commit_seq`（项目内单调）
- `relative_path`（如 `设定集/人物/林照.md`）
- `op`：`upsert` | `delete`
- `blob_digest`
- `causing_chapter_id` / `causing_chapter_sequence`（可空）
- `story_time`（可空，永不校验必填）
- `source_kind`：`extraction_approve` | `staging_promote` | `workspace_save` | `migration_seed` | `history_restore`
- `source_ref`, `summary`/`reason`, `created_at_ms`

**settings_heads**：`(project_id, relative_path)` → 当前 commit / digest（与磁盘文件一致）

### 5.3 写入规则

凡成功写入 `设定集/` 的路径，**同一事务意图**内：写文件 + append commit + 更新 head。

| 触发 | causing chapter |
| --- | --- |
| settings extraction 批准 | 从 task → 章序；否则空 |
| staging promote 批准 | 从 session/章上下文；否则空 |
| `workspace.save` 且路径 ∈ `设定集/` | 当前活动章（有则写） |
| `history.restore` 后设定文件变化 | 追加 `history_restore`，与磁盘重对齐 |

拒绝提案：不记账。

### 5.4 读取语义

- **head**：当前真相（优先磁盘，与 heads 校验）
- **asOfChapter(N)**：对该路径，在「`causing_chapter_sequence` 为空或 ≤ N」的 commits 中取最大 `commit_seq`；若最后为 delete 则无文件
- **listHistory(path)**：时间线条目（可先不带全文）
- **getCommitMarkdown(commitId)**：展开某一版

迁移：首次建表后扫描现有 `设定集/**/*.md` 作为 `migration_seed`（更早被覆盖的版本无法找回）。

---

## 6. AI 按需加载（P1）

扩展现有 `ReadRequest.query`（不新造平行工具协议）：

```ts
purpose?: "current" | "as_of_chapter" | "past_chapter_text"
asOfChapterSequence?: number
entityHints?: string[]
maxChars?: number
```

| purpose | 行为 |
| --- | --- |
| `as_of_chapter` | 设定沿革 as-of N + 切片/grep；证据标「过去视角」 |
| `past_chapter_text` | 按章序解析正式 source（创作台仍禁止直接读工作区章文件） |

预算：每轮时态读次数上限、单次字数上限、证据 token 账本照旧。  
垂直切片：**先 synopsis_discuss**，再正式 `source_retrieval`。

双时钟：故事/章游标 ≠ 批准写入序；默认上下文仍是**当前真相**，as-of 仅用于过去向声明。

---

## 7. UI / 原型结构

### 7.1 可复用现有

| 现有 | 复用方式 |
| --- | --- |
| `WorkspaceTree.tsx` | 注入虚拟节点；独立 `onVirtualSelect`，不走 `openFile(.md)` |
| `ChapterDraftDiffView` / `computeLineDiff` | 时间线条目内红删绿增 |
| `HistoryPanel` 时间线条样式 | 视觉参考（文案用「沿革」，不与世界历史混为一谈） |
| `EditorArea` markdown 模式 | 当前设定编辑不变 |

### 7.2 新增（建议）

| 组件 | 职责 |
| --- | --- |
| `SettingsLineageEntry`（树虚拟节点） | 目录「设定沿革」 |
| `SettingsLineageBrowser` | 入口落地页：选文件 / 近期变动 |
| `SettingsLineageTimeline` | 单文件时间线 + diff + 只读当时全文 |
| （P1）`SettingsAsOfChip` | AI 用过过去游标时的透明提示 |

### 7.3 线框（ASCII）

```text
┌────────────┬──────────────────────────────┬──────────┐
│ 工作区     │ 设定沿革 · 人物/林照.md       │ 右栏     │
│ 设定集/    │                              │          │
│ 设定沿革 ◀ │ ▼ 因第 42 章 · 身份揭晓后     │          │
│ 章节正文/  │   − 他仍是凡人……               │          │
│ …          │   + 他已觉醒……                 │          │
│            │ ▼ 因第 18 章 · 初次登场       │          │
│            │   + （初版全文摘要/diff）      │          │
└────────────┴──────────────────────────────┴──────────┘
```

### 7.4 API（contracts）

```text
settings.lineage.list
settings.lineage.readAsOf
settings.lineage.headMeta
settings.lineage.getCommit   // 或并入 list 的 expand
settings.lineage.annotate    // P3：可选 storyTime / summary
settings.lineage.restoreAsCurrent  // P3：危险；confirmPhrase 必须为「恢复为当前」
```

Approve payload 可选：`reasonOverride?: string`。

**P3 危险操作约定：**

1. 「恢复为当前」只覆盖工作区当前设定文件，并**追加**一条沿革（`workspace_save` + 说明「从沿革恢复为当前真相」），**不改写**既有 commits。  
2. API 与 UI 均要求 `confirmPhrase === "恢复为当前"`；错字/缺省一律拒绝。  
3. 故事时间备注可随时补写/清空，永不挡写入、as-of 或恢复。

---

## 8. 分期

| 阶段 | 交付 |
| --- | --- |
| **P0** | SQLite 沿革表 + 写入挂钩 + 迁移 seed；树虚拟入口；单文件时间线 + diff；`settings.lineage.*` |
| **P1** | `ReadRequest` 时态字段；创作台 as-of / 旧章；证据 chip；可选 `reasonOverride` |
| **P2** | 章节 lineage 硬钉「当时正文」；turn `source_retrieval` 时态读；`history.restore` 重对齐；`readAsOf`；chip → 沿革面板 |
| **P3** | 可选故事时间备注（`annotate`）；危险「恢复为当前」确认流（须手输「恢复为当前」） |

---

## 9. 风险与约束

| 风险 | 缓解 |
| --- | --- |
| 磁盘与 heads 不一致 | 写入同路径助手；restore 后重对齐 |
| 作者误删「沿革文件」 | 虚拟节点，无磁盘实体 |
| as-of 与当前混淆 | UI/证据强制标注「非当前真相」 |
| AI 灌爆上下文 | 按需 + 字数/次数帽 |
| 与世界历史概念混淆 | 文案与面板分离；禁止互相替代 |

---

## 10. 验收（P0）

1. 采纳设定提案或确认暂存落盘后，对应路径沿革多一条，磁盘为最新内容。  
2. 目录可见「设定沿革」；点文件见时间线与红绿 diff。  
3. 直接保存 `设定集/` 文件也会记账。  
4. 旧项目打开后 seed 一条迁移记录，可打开沿革。  
5. 全文案无 git 术语；不要求填写故事时间。

---

## 11. 代码接缝（实施索引）

| 层 | 路径 |
| --- | --- |
| 迁移 / 类型 | `apps/backend/.../project-migrations.ts`, `database-types.ts` |
| 仓储 / 服务 | 新建 `sqlite-settings-lineage-repository.ts`, `settings-lineage-service.ts` |
| 写入挂钩 | `settings-extraction-service.ts`, `staging-promote-service.ts`, workspace save / history restore |
| 契约 / IPC | `packages/contracts`, `backend-facade.ts`, desktop bridge / client |
| 树 / UI | `WorkspaceTree.tsx`, `App.tsx`, 新建沿革面板组件；diff 复用 editor 原型 |
| AI（P1） | `reads.ts`, `synopsis-workspace-reads.ts`, `synopsis-discuss.md`, `settings-query-guide.md` |
