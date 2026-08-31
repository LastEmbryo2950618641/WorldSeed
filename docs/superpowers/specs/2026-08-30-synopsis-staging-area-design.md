# 创作台暂存区（设定中间态）设计

> **状态：** 设计草案（2026-08-30）  
> **范围：** 工作区新增顶层 `暂存区/`；梗概讨论每轮自动抽取中间信息落暂存；讨论成熟后由用户确认，再写入 `设定集/` 与推演目标。  
> **关联：** [剧情梗概讨论](./2026-08-27-plot-synopsis-discussion-design.md) · [推演目标](./2026-08-27-creation-desk-deduction-goals-design.md) · `settings-revision-guide.md` · `settings-extraction` 提案采纳流

---

## 1. 用户目标

防止创作台多轮讨论中 Agent「忘记」已确认的世界细节：

1. 每轮讨论结束后，Agent **自动**把可沉淀信息写入工作区 **`暂存区/`**（中间态，非权威设定）；
2. 讨论差不多时，Agent 提议落盘；**用户点击确认**后，才写入 **`设定集/`** 与 **推演目标**；
3. 已落盘条目在暂存区标记为 **已落盘（settled）**，仍可被检索；
4. 暂存区有 **字数上限**；超限时按规则自动删除旧数据。

**非目标（本阶段）：**

- 不替代正式推演中的 `settings_extraction`（正文后抽取仍保留）；
- 不静默写入 `设定集/`；
- 不把暂存区当作图状态权威。

---

## 2. 决策记录（已确认）

| 议题 | 选择 |
| --- | --- |
| 落盘确认方式 | **A**：用户点击「确认落盘」（对齐设定抽取「采纳并写入」） |
| 暂存文件形态 | **A**：固定几份结构化 Markdown，每轮合并更新 |
| 落盘后暂存处理 | **C**：标记已落盘，仍可查询；超字数上限删旧数据 |
| 实现主路径 | 工作区第六顶层目录 + `send` 时抽取写入 + 落盘提案 |

---

## 3. 工作区布局

### 3.1 新增顶层根

在 `fixedTopLevelDirectories` 中增加：

```text
暂存区/
```

与现有五根并列。旧项目在 `open` / `ensurePlatformDocuments` 时补建缺失目录与固定文件。

### 3.2 固定文件

| 路径 | 用途 |
| --- | --- |
| `暂存区/readme.md` | 用途说明、状态约定、字数上限策略（平台种子，可更新） |
| `暂存区/本章讨论笔记.md` | 基调、选项结论、本章叙事要点、与梗概的交叉引用 |
| `暂存区/人物草稿.md` | 人物身份/关系/信息边界等未正式入设定集的草稿 |
| `暂存区/世界与规则草稿.md` | 地点、势力、规则、术语等 |
| `暂存区/待落盘清单.md` | 待写入设定集/目标的条目索引、目标路径建议、settled 状态 |

**写权限：** Agent（platform）与用户均可改 `.md` 内容；不得出现非 `.md` 文件；目录结构暂不要求用户自建子文件夹（第一期固定五文件即可）。

### 3.3 Catalog

- 新增 role：`staging`（`workspaceCatalogRoleValues`）
- `classifyRole("暂存区") → staging`
- 梗概 ReAct 可读 `staging`（`sourceKinds` 扩展或默认在 synopsis 循环中允许读 staging 角色文件），以便续轮不忘

---

## 4. 条目模型（文件内约定）

各草稿文件内使用可解析的条目块（实现可用 front-matter 小节或固定标题块）。逻辑字段：

```ts
type StagingEntryStatus = "open" | "pending_promote" | "settled"

type StagingEntry = Readonly<{
  entryId: string              // 稳定 id，合并时复用
  title: string
  body: string                 // Markdown 正文
  status: StagingEntryStatus
  updatedAtMs: number
  settledAtMs?: number
  promoteTargetPath?: string   // 建议落入的 设定集/….md
  sourceMessageId?: string     // 来源助手消息（可选审计）
}>
```

- `open`：讨论中草案  
- `pending_promote`：已进入「待确认落盘」提案  
- `settled`：用户已确认写入设定集/目标；**保留可读**

`待落盘清单.md` 维护 entryId → 状态 / 目标路径的索引视图（可与分文件条目双向同步）。

---

## 5. 每轮讨论：自动抽取写入暂存

### 5.1 触发

`synopsis.conversation.send` 成功路径中，在解析 `assistantMessage` / `synopsisBody` / `goalProposals` 之外，增加 **`stagingDelta`**：

```ts
stagingDelta?: Readonly<{
  notes?: readonly StagingEntryPatch[]           // → 本章讨论笔记
  characters?: readonly StagingEntryPatch[]    // → 人物草稿
  worldRules?: readonly StagingEntryPatch[]    // → 世界与规则草稿
  promoteHints?: readonly StagingEntryPatch[]  // → 待落盘清单（预标注）
}>
```

`StagingEntryPatch`：`{ entryId?: string; title: string; body: string; promoteTargetPath?: string }`  
无 `entryId` 则新建；有则合并（同 id 覆盖 body/title，刷新 `updatedAtMs`，不降级 `settled` 为 `open` 除非模型显式「重开」——第一期禁止重开 settled）。

### 5.2 后端合并

1. 读当前暂存文件 → 解析条目  
2. 应用 `stagingDelta`  
3. 执行字数上限清理（§7）  
4. 写回 Markdown  
5. 流式 UI：`searching` 可增加一条「已更新暂存区」摘要（可选）

若本轮无新世界事实（纯寒暄/仅选按钮），`stagingDelta` 可为空，不强制造条目。

### 5.3 提示词

更新 `synopsis-discuss.md` + `settings-revision-guide.md`：

- 每轮在回复用户的同时产出抽取增量；  
- **禁止**把「我先去读」当最终回复；可读暂存与设定集；  
- **禁止**声称已写入设定集；落盘须用户确认。

---

## 6. 讨论完毕：确认落盘

### 6.1 Agent 侧

当暂存中有足够 `open`/`pending_promote` 条目且用户意图接近定稿时：

- `choices` 增加例如：`{ label: "确认落盘到设定集与目标", action: "promote_staging" }`  
  - 需扩展 `synopsisConversationChoiceSchema.action`：现有 `start_turn` | `continue_discuss` + **`promote_staging`**
- 同时产出 **`stagingPromoteProposal`**（结构化，入库 pending）：

```ts
type StagingPromoteProposal = Readonly<{
  proposalId: string
  projectId: string
  sessionId: string
  createdAtMs: number
  status: "pending" | "approved" | "rejected"
  settingsWrites: readonly Readonly<{
    entryId: string
    relativePath: string   // ^设定集/.+\.md$
    markdown: string
    readmeEntry?: string
    mode: "create" | "update"
  }>[]
  goalProposals?: SynopsisDiscussArtifact["goalProposals"]  // 复用现有目标提案形状
  reason?: string
}>
```

### 6.2 用户侧

创作台提供确认 UI（可与推演目标提案区并列，或 choice 点击后弹出摘要）：

- **确认落盘**：调用 `synopsis.staging.promote.approve`  
- **暂不落盘 / 拒绝**：`reject`，条目从 `pending_promote` 回到 `open`

### 6.3 Approve 效果

1. 对每条 `settingsWrites`：写入 `设定集/…`（对齐 `SettingsExtractionService.applyProposal` 的路径校验与 readme 索引更新）  
2. 若有 `goalProposals`：走现有 `createProposalsFromArtifact` **或** 直接作为待采纳目标提案（与今日 goal 流一致：仍建议 pending → 用户采纳目标；**第一期推荐**：落盘设定与目标提案一并生成，目标仍需现有「采纳」按钮，避免一次点击改太多——见 §6.4）  
3. 对应暂存条目 `status → settled`，写 `settledAtMs`  
4. **不删除** settled 条目正文

### 6.4 第一期目标落盘策略（建议）

- **设定集**：确认落盘时立即写入文件  
- **推演目标**：确认落盘时生成/刷新 goal proposals（pending），用户在目标 UI 二次采纳  

若产品希望「一键两处都生效」，可在实现计划中改为 approve 时直接 `apply` goals；本设计默认 **设定立即写、目标仍提案**，降低误操作面。

---

## 7. 字数上限与自动删除

### 7.1 配置

项目设置新增：

```ts
staging: {
  maxChars: number  // 默认 80_000；统计 暂存区/ 下除 readme 外全部 .md 的字符数（或含 readme，实现时固定一种并文档化）
}
```

### 7.2 清理顺序（超限时循环直到 ≤ maxChars）

1. 删除最旧的 **`settled`** 条目（按 `settledAtMs` / `updatedAtMs`）  
2. 若仍超限：删除最旧的 **`open`** 条目（排除 `pending_promote`）  
3. **`pending_promote` 最后删**（尽量保住待确认落盘）  
4. 每次删除在 `本章讨论笔记.md` 末尾追加一行系统注记：`[系统] 已清理暂存条目 {title}（超字数上限）`

不整文件删固定文件；只删条目块。

---

## 8. 与现有流程关系

| 阶段 | 设定权威 | 暂存区 |
| --- | --- | --- |
| 创作台讨论中 | 仍以已落盘 `设定集/` + 图为准；暂存为草稿记忆 | 每轮更新 |
| 用户确认落盘 | 写入 `设定集/` | 标记 settled |
| 正式推演 `settings_extraction` | 从正文再抽提案 | 可只读暂存作参考，但不取代抽取 |

右侧「抽取设定提案」仍是推演链路能力；暂存落盘是 **推演前** 的创作台能力。

---

## 9. IPC / 合约增量（摘要）

| Method | 作用 |
| --- | --- |
| （现有）`synopsis.conversation.send` | 返回中可含 `stagingUpdated: true` / 摘要 |
| `synopsis.staging.list` | 可选：返回解析后的条目与字数占用 |
| `synopsis.staging.promote.approve` | 确认落盘 |
| `synopsis.staging.promote.reject` | 拒绝本次落盘提案 |
| `synopsis.staging.promote.list` | 列出 pending 落盘提案 |

Choice `promote_staging`：renderer 调用 approve 前可先 `list` 展示摘要，或 send 已带 pending proposalId。

---

## 10. UI

- 左侧工作目录自动出现 `暂存区/`（inventory）  
- 创作台：落盘提案卡片（路径列表 + 确认/拒绝），类似目标提案  
- Choice「确认落盘到设定集与目标」可点（修复后的 choice 行为：`promote_staging` → approve 流，而非空操作）

---

## 11. 测试要点

- 新建/打开旧项目均存在 `暂存区` 固定文件  
- send 带 `stagingDelta` 合并进文件且 settled 不被降级  
- promote approve 写入设定集 + readme；条目变 settled  
- 超 maxChars 时按 §7.2 顺序删除  
- catalog 含 `staging`；synopsis 可读暂存  
- workspace-policy 接受第六根；拒绝第七未知根

---

## 12. 实现分期

| 期 | 内容 |
| --- | --- |
| P0 | 目录/manifest/catalog/role；固定文件种子；旧项目补建 |
| P1 | artifact `stagingDelta` + 合并写入 + 字数清理 |
| P2 | `stagingPromoteProposal` + approve/reject IPC + 创作台确认 UI |
| P3 | 提示词与 Fake 适配；验收脚本 |

---

## 13. 开放细节（实现计划可定默认）

- `maxChars` 是否计入 `readme.md`（建议：**不计**）  
- 条目序列化格式：YAML front-matter 块 vs `## entry:{id}` 标题约定（建议：**标题约定**，易手改）  
- 确认落盘是否一键 apply goals（本设计默认否，见 §6.4）
