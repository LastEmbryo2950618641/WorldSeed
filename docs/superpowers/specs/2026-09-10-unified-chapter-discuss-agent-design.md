# 统一章节讨论 Agent（创作台 + 右栏）

> **状态：** 已确认（2026-09-10；同日修订：改正文自动落草稿）  
> **范围：** 创作台讨论与右栏「Agent 对话」合并为同一 Agent；草稿版本落库；正式正文仅用户提交后变更。  
> **关联：** [剧情梗概讨论](./2026-08-27-plot-synopsis-discussion-design.md) · [草稿版本](./2026-08-26-chapter-draft-versions-design.md) · [章节修改协同](../../chapter-modification-coordination.md) · [正文修订与用户最高权限](../../chapter-revision-and-user-authority.md) · [暂存区](./2026-08-30-synopsis-staging-area-design.md)

本文 **取代** 2026-08-27 §2「讨论 / 修订两个 Agent」的分工，以及 2026-08-26 中「主路径仍走 `conversation.apply`」的 Agent 入口描述。草稿 **数据模型**（append-only 版本表、不入正式链）仍以 2026-08-26 为准。**改正文**：Agent 产出完整修订正文后 **当轮自动追加草稿**（无需用户确认）；覆盖 `章节正文/*.md` 仍须用户确认后走 `submitRevision`。

---

## 1. 用户目标

作者在创作台或右栏与 **同一个 Agent** 连续讨论全书：写完第 1 章再聊第 2 章时，**接着同一条会话**，不新开聊天。改草稿时若涉及设定，走已有设定暂存 / 落盘，不要第二套设定协议。

Agent **不能改正式正文文件**。所谓「修改正文」= 以当前正式正文（或最新草稿）为底，**当轮自动写入新草稿**；磁盘上的 `章节正文/第N章….md` 不变。草稿成为正式正文，只走用户确认后的 `submitRevision`（旧 `sourceId` 留作正文备份链，界面列为正文旧版本）。

---

## 2. 决策记录

| 议题 | 选择 |
| --- | --- |
| Agent 数量 | **一个**：协议为 `synopsis_discuss`。右栏不再跑 `revision_assist`。 |
| 会话 | **本作品一条连续讨论**（一个 active `synopsis_conversation_sessions`）。换章不换会话。 |
| 焦点 | **创作台**：输入框上方那条就是当前焦点（可搜索/下拉选章）。显示第 N 章则只允许改第 N 章。Agent 若要换章，必须出确认 choice，用户点了才 `setFocus`。正文推演完毕后焦点自动进下一章。**打开某章文件（右栏入口）**：焦点锁定为该章，Agent 不能提议换章。 |
| 打开文件钮 | 创作台焦点条右侧仍为「打开…文件」：焦点在梗概/细纲/正文时分别打开对应文件。 |
| 两处 UI | 创作台中央 = 完整时间线；右栏 = 同一会话的紧凑视图。发送都走 `synopsis.conversation.send`。 |
| 改正文 | **自动**：正文只读副本 → 新草稿版本。正式文件不动。禁止改写成「修订清单」再推用户去修订助手。 |
| 改已有草稿 | 未指定则最新草稿为父；指定版本号则以该版为父。**自动追加** 新草稿，不改写旧节点。 |
| 覆盖为正文 | 用户确认后 `submitRevision`。Agent 禁止 `replacePublishedChapter`。 |
| 章节文件右栏入口 | 与创作台同一 Agent、同一会话、同一改正文流程。**焦点锁定为本文件所属章**，忽略 `set_focus`；send 须带 `focusLocked` + `lockedChapterSequence`。 |
| 设定集 | 复用 `stagingPromote` + 用户点落盘。不在右栏另做一套。 |
| 正式推演链 | 讨论仍不写入 `model_context_chains` UNIQUE。 |
| `revision_assist` 删除时机 | **最后**：草稿入库、右栏改接讨论并验收后再删。 |

---

## 3. 概念：会话 vs 焦点 vs 正文轴 vs 草稿轴

```text
本作品讨论会话（一条，换章接着聊）
├── 消息 / choices / 设定提案 / synopsis_discuss_context_messages
└── 当前焦点 chapter_sequence  →  本章规划文件 + 本章修订任务

本章正式正文轴（document_versions + predecessor_source_id）
└── 正文 v1 → v2 → vN（head）     备份 / 恢复用，只读除非 submit

本章草稿轴（revision_draft_versions，挂 chapter_revision_tasks）
└── 草稿 v0(正文快照) → v1 → v2   给作者改的；未提交不进正式链
```

| 名称 | 是什么 | 换章时 |
| --- | --- | --- |
| **会话** | 一条聊天 + 讨论模型链 | **不换** |
| **焦点** | `session.chapterSequence` + 对应梗概/细纲路径 | **换成打开的那一章** |
| **正文版本** | 已提交 `sourceId` 链 | 跟着焦点章 |
| **草稿版本** | 该章当前修订任务内的工作稿链 | 跟着焦点章 |

打开第 1 章正文说话：焦点=1（右栏锁定），草稿打在第 1 章修订任务上，聊天历史仍含第 2 章讨论。  
创作台下拉选到第 2 章：焦点=2，改第 2 章梗概/细纲；若第 2 章尚无正式正文，则没有「改正文为新草稿」。  
创作台焦点停在第 3 章时，不能改第 1 章文件；要改第 1 章须自己下拉选章，或让 Agent 给出「是否将焦点调整到第 1 章」并点确认。

---

## 4. 禁止与允许的写入

| 目标 | Agent `send` 当轮 | 用户确认后 |
| --- | --- | --- |
| `[剧情梗概].md` / `[剧情细纲].md` | 维持现有自动覆盖（手改 digest 门禁仍有效） | — |
| `暂存区/` | 维持自动 `stagingDelta` | — |
| `设定集/` | 禁止 | `promote_staging` |
| 正式 `章节正文/第N章….md` | **禁止** | 仅 `submitRevision` / `chapter_publisher` |
| 修订工作稿 / 草稿版本 | **自动追加**（`chapterDraftProposal` 或等价完整修订正文） | — |
| 恢复某次正文为当前正式版 | 禁止 | 确认后 `submitRevision`（append 新 head，内容=旧版；不拨回旧 sourceId 指针） |

确认钮文案（创作台正式输出下与右栏同一组 choices；草稿入库不再出确认钮）：

- 覆盖正式章：`是否确认用草稿(vN)覆盖正文（当前正文将备份为旧版本）`
- 恢复正文：`是否确认恢复正文(vM)为当前正文`

工作区政策不变：非规划章路径仅 `chapter_publisher` 可写。

---

## 5. 协议

保留并扩展 `synopsis_discuss`。不把完整 `proposedBody` 无门禁塞进每轮 artifact。

新增（名称可微调，语义不可变）：

```text
choices.action:
  promote_draft_to_body
  restore_body_version
  set_focus                   // 仅创作台渲染；须带 chapterSequence；点确认才换焦点。章节右栏入口禁止出现。

artifact.chapterDraftProposal?: {
  base: "body" | "draft"
  baseDraftVersionId?: string
  heading: string
  body: string
}
```

`send` 若带 `chapterDraftProposal`：**立即** `ensureRevision` + `appendDraftVersion`（source=agent），并给 `promote_draft_to_body`。正式 `.md` 仍不动。  
点「覆盖正文」：renderer 调 `submitRevision`（对齐 `start_turn` / `promote_staging`），不要 `onSend(按钮文案)` 当唯一通道。

预发布焦点（尚无正式正文）：禁止 `chapterDraftProposal` / `promote_draft_to_body`；允许梗概细纲、暂存、设定、`start_turn`。  
已发布焦点：禁止 Agent 自行 `start_turn` 覆盖本章；草稿针对 **本轮有效焦点章**（创作台=session 焦点；章节右栏=`lockedChapterSequence`）。

`bodyEdits` 保持 `target: "outline"`。若扩展，只允许 `target: "draft"`，禁止 `"chapter"` 打正式文件。

---

## 6. 会话与焦点（实现要点）

今日 `ensureActiveSession` 已是「每项目一条 active」。换章继续聊 **不需要** 按 `chapter_sequence` 新建 session。

要改的是：

1. 打开某章正文 / 梗概 / 细纲时，把该章序号设为焦点（更新 `chapter_sequence`、`synopsis_path`、`title`、`focusKind`），**不** `createSession`。右栏此焦点**锁定**，忽略 `set_focus` choice。
2. 创作台焦点条：可搜索的章节下拉；选中即 `setFocus`。右侧钮按 `focusKind` 打开梗概 / 细纲 / 正文。
3. Agent 换章只允许 `choices.action=set_focus`（文案「是否将焦点调整到第 N 章…」）；点确认才调用 `setFocus`。
4. 正式推演完成并交接后，焦点自动 `setFocus(N+1)`（创作台接着规划下一章）。用户若要改刚完成的章，自己下拉或让 Agent 出确认钮。
5. `list` / `send` 按 **该 active sessionId** 列消息；右栏与创作台绑定同一条 session。
6. 模型可见 Evidence：讨论链（跨章历史）+ **焦点章** 的规划文件 / 正式正文（只读）/ 最新草稿。

`UNIQUE (project_id, chapter_sequence)`：焦点改序号时若库里已有 completed 同行会撞车。迁移为 **每项目至多一条 active**（部分唯一索引）；允许历史 completed 行保留，焦点只改 active 行。

讨论上下文仍用 `synopsis_discuss_context_messages`，不写入正式 `model_context_chains`。

---

## 7. 草稿版本（落库，替换原型）

表 `revision_draft_versions`（任务局部）：

```text
version_id, project_id, revision_task_id, parent_version_id,
source (baseline | agent | manual | rollback),
message_id?, heading, content_ref, body_digest, created_at_ms
```

`chapter_revision_tasks.latest_draft_version_id` 指向已固化链尾。  
工作稿仍是 `updateRevision` 的 `proposed`；digest 与链尾不同 = 脏编辑。

- `ensureRevision` / `startRevision`：若无版本，打 `baseline` = 当时正式正文。
- 确认「修改正文为新草稿」：父 = baseline 或当前正文快照；`source=agent`；`updateRevision`。
- 确认「修改草稿(vK)为新草稿」：父 = vK；新节点成为 latest。
- 用户「创建新草稿」检查点：`source=manual`。
- 回退：append `rollback`，不改写历史。
- Monaco 键入：只脏化工作稿，不逐键打版本；提交前若脏则自动打 `manual`。

渲染进程 `ChapterDraftVersionsPrototype` 内存链 **不再作为权威**；刷新后以后端 list 重建。

---

## 8. 正文版本（已有链，补 UI）

不新建表。对焦点章 `document_versions` 按 `predecessor_source_id` 投影 **正文 v1…vN**。  
恢复 = 以该版正文再 `submitRevision`（新 head，前驱=当前 head）。不把 `active_document_heads` 拨回旧 id（避免图与正文分叉）。  
`chapter-body-rematerialize` 仍只修复缺失文件，不是版本回滚。

编辑器：**草稿下拉** 与 **正文下拉** 分开。创作台顶栏只读：`正文 vN · 草稿 vM`。

---

## 9. UI

- 确认：正式输出下方 `synopsis-conversation-choices`；右栏同样渲染该消息的 choices。
- 创作台输入框上方焦点条：可搜索章节下拉 + 「打开梗概/细纲/正文文件」。
- 创作台顶栏文件名旁：焦点章的 `正文 vN · 草稿 vM`。
- 右栏：抽创作台 composer 的紧凑变体（时间线可折、choices、发送）；**不渲染** `set_focus`。删除 `ChapterConversationComposer` 作为独立协议 UI。
- 纸飞机「直接提交」、审核修订：保留，不放进讨论 Agent。
- 右栏运行监控：仍只订阅正式推演，不订阅讨论。

---

## 10. 删除清单（接线稳定后）

- `ChapterRevisionConversationService`、`SqliteRevisionConversationRepository`
- IPC `chapter.revision.conversation.list|send|apply`
- 阶段 `revision_assist`（prompt / schema / fake adapter / phase-transitions / fiction-delivery）
- `ChapterConversationComposer.tsx`；`App.tsx` 的 `chapterConversation` 与自动 `apply`
- 表 `revision_conversation_messages`（停写后迁移 drop）
- 测试 `chapter-revision-conversation.test.ts` 等专用用例

**保留：** `ChapterRevisionService`、`submitRevision`、`revision_review`、图同步、Monaco 自动保存。

---

## 11. 实施顺序

1. `revision_draft_versions` + list/append/restore API；`startRevision` 打 baseline；UI 下拉改读后端。
2. 焦点 API：打开章路径时 `setFocus(sequence)`；send 的规划读写用焦点，不新建 session。
3. `synopsis_discuss` 改正文自动 append 草稿 + `promote_draft_to_body` 确认覆盖。
4. 右栏改接 `synopsis.conversation.*`（`focusLocked`）；去掉 `revision_assist` 发送。
5. 正文 vN 列表与恢复确认。
6. 删除 `revision_assist` 栈。

---

## 12. 验收

- 创作台发一条、右栏可见同一条；反之亦然。
- 推演第 1 章后再聊第 2 章：同一 `sessionId`，消息连续；焦点变为 2。
- 讨论要求改正文：正式 `.md` digest 不变；草稿 v1（或下一版）自动出现；给出覆盖正文确认钮。
- 再改一次：旧草稿仍在，latest 为新节点。
- `send` 未带 `chapterDraftProposal`：不追加草稿。
- 覆盖正文：新 `sourceId`，旧版可列为正文备份。
- 章节右栏 send 带 `lockedChapterSequence=N`：草稿打在第 N 章；`set_focus` 不出现、不生效。
- 讨论 `send` 不向 `model_context_messages` 追加。
- 描写「自动」仍为注入全部场面卡。
