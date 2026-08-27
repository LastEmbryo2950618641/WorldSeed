# 章节草稿版本（Draft Versions）设计

> 状态：草案（待评审）  
> 日期：2026-08-26  
> 关联：[章节修改协同](../../chapter-modification-coordination.md) §4.3、[正文修订与用户最高权限](../../chapter-revision-and-user-authority.md)、[推演历史与版本恢复](../../world-history-versioning.md)

## 1. 问题与动机

当前 Agent 对话修订存在两个体验断层：

1. **「写入草稿」需用户点击**：Agent 回复里虽有 `proposal`，但正式进入可审核/可提交的工作稿依赖显式 `conversation.apply`。若不写入，用户在草稿区看不到（或只能靠渲染进程内存里的临时预览看到）AI 改了什么，按钮语义与「先看见再决定」冲突。
2. **缺少草稿级版本轴**：一次修订任务内可能多轮 AI 改稿、人工再改。用户需要知道「相对上一稿改了什么」，并能回到某一过渡稿继续改，而不是只有「当前 working buffer」一条线。

本设计解决：**AI 默认落入草稿**，并以 **草稿版本 + 与前一版 diff + 可回退** 支撑可审查的修订过程。仍遵守既有硬边界：**未提交草稿不进入全局 `ModelContextChain`**；只有 `submitRevision` 后才产生正式 `chapter_revision` / head。

## 2. 目标与非目标

### 2.1 目标

| ID | 目标 |
| --- | --- |
| G1 | Agent 每轮产出可用 `proposal` 后，**自动**成为当前工作草稿（无需点「写入草稿」） |
| G2 | 每次 AI 落稿在上一版草稿之上 **追加一个草稿版本**（线性版本链） |
| G3 | 新版本相对 **父版本** 提供类 Git 的文本 diff，供用户审阅「改了什么」 |
| G4 | 可浏览本修订任务内全部历史草稿版本；选中后可 **回退为当前最新工作稿** 并继续对话/编辑 |
| G5 | 人工在 Monaco 中的编辑仍落在「当前最新工作稿」上；提交/审核仍针对最新工作稿 |

### 2.2 非目标

- 不替代 [推演历史与版本恢复](../../world-history-versioning.md) 的世界线 / `history.git`（那是 **已提交世界状态**）。
- 不把草稿版本写入 `ModelContextChain`。
- 不做多分支草稿树（本期只做 **线性版本 + 回退产生新节点**）。
- 不自动 `submitRevision`；审核/直接提交门禁不变。
- 不要求 diff 语义理解（角色/情节级）；本期为 **纯文本行级/字符级 diff**。

## 3. 概念澄清

### 3.1 进程边界与数据权威（无远程服务端）

Worldseed 桌面端是 **单机架构**，没有独立远程服务端。

| 进程 | 职责 |
| --- | --- |
| **渲染进程（UI）** | 只负责展示与交互；**不作为领域数据的权威存储** |
| **utility 后端 + SQLite / 对象存储** | **唯一权威**：章节、修订、对话、草稿版本、图、上下文链等均经 IPC 读写落库 |

**原则：** 所有业务数据放在本机后端；渲染进程可以有短暂的 React 内存镜像用于编辑体验（如 Monaco 正在输入的字符串），但：

- 刷新、重开章节、切换文件后，必须以后端读回的结果重建 UI；
- AI 落稿、回退、审核、提交的结果必须以后端返回为准覆盖内存镜像；
- 不得仅把「重要草稿」留在渲染进程 state / localStorage 里当作真相。

**当前例外（非领域数据）：** 阅读样式偏好（字体/字号/行距）暂存在渲染进程 `localStorage`，属 UI 偏好，不是章节/修订事实。若未来要多端一致，可再迁到项目设置。

下文「持久化」「权威工作稿」均指 **本机后端落库**。所谓「双源」风险仅指：编辑过程中内存镜像可能暂时领先于落库；事件边界（send 完成、restore、blur/保存检查点、提交前）必须以落库结果对齐 UI。

### 3.2 草稿版本轴

```text
正式正文 (committed)
    └── 一次 ChapterRevision 任务 (editing)
            ├── 草稿版本 v0 = 打开修订时的 committed 快照
            ├── 草稿版本 v1 = 第 1 次 AI 落稿
            ├── 草稿版本 v2 = 第 2 次 AI 落稿 或 回退产生的新节点
            └── 当前工作稿 (working draft) = 默认指向链尾；可含未打版本的人工脏编辑
```

| 概念 | 含义 |
| --- | --- |
| **草稿版本 (draft version)** | 修订任务内一次可命名的正文快照（标题+正文），append-only |
| **当前工作稿** | 编辑器正在编辑、审核/提交读取的内容；通常等于最新版本，或「最新版本 + 未存盘人工修改」 |
| **父版本** | 生成该版本时的基线；AI 落稿时父 = 当时工作稿对应版本；回退时父 = 回退前的链尾 |
| **正式提交** | `submitRevision`，与草稿版本链无关地进入事实层 |

与对话消息的关系：`revision_conversation_messages` 仍保存对话与可选 `proposal`；草稿版本是 **可导航的正文时间线**，不以聊天气泡替代。

## 4. 行为设计

### 4.1 AI 默认写入草稿（取消强制「写入草稿」）

```text
conversation.send(...):
  1. 既有：用户消息入对话；revision_assist；助手消息 + proposal 入对话
  2. 新增：若 proposal 存在：
       a. 以「当前工作稿」为父（若工作稿相对链尾有脏编辑，先自动打一个 manual 版本，见 §4.4）
       b. 追加 draft version（source=agent，关联 messageId）
       c. updateRevision(heading, body) ← 持久化工作稿
       d. 返回 messages + newVersion + diffAgainstParent
  3. UI：草稿 Tab 立即显示新正文；展示 diff；不再要求点「写入草稿」
```

UI：

- 去掉（或降级为「已自动写入」状态标签）主路径上的「写入草稿」按钮。
- Agent 气泡可保留「查看本轮 diff」入口。
- `conversation.apply`：保留为兼容/幂等 API（对已自动落稿的 message 再 apply 应为 no-op 或返回同一版本），新 UI 不依赖它。

### 4.2 版本列表与查看

```text
draftVersion.list(revisionTaskId) →
  [{ versionId, parentVersionId, source, messageId?, headingPreview, bodyDigest, charCount, createdAtMs, isLatest }]

draftVersion.read(versionId) → { heading, body, ... }
```

UI（建议在草稿工具栏旁或 Agent 面板侧栏）：

- 时间线列表：v0（基线）→ v1（AI）→ v2 …
- 点击某版本：只读预览正文；可与「当前最新」或「其父版本」切换 diff 基线。

### 4.3 Diff 展示

```text
draftVersion.diff(versionId, { against: "parent" | versionId }) →
  { baseVersionId, headVersionId, hunks: DiffHunk[] }
```

- 默认 `against: "parent"`（相对生成时的上一版）。
- UI：Unified 或 Side-by-side（可用 Monaco DiffEditor）；中文正文以行级为主，必要时字符级。
- AI 刚落稿后，在对话区或工具栏下方 **自动弹出本轮 diff 摘要**（可折叠），解决「瞬间出结果但看不见改了什么」。

### 4.4 回退

用户选中历史版本 vK，点击「回退到此版本」：

```text
draftVersion.restore(revisionTaskId, versionId):
  1. 读取 vK 的 heading/body
  2. 追加新版本 vN：
       parent = 当前链尾
       source = rollback
       body/heading = vK 的快照
  3. updateRevision 到 vN
  4. 返回 vN + diff(vN, parent)
```

**不采用**「移动 latest 指针并改写历史」：保持 append-only，便于审计，也与 Git「revert 产生新提交」一致。用户感知上「当前草稿 = 过去某一稿的内容」。

回退后可继续 Agent 对话 / 人工编辑；下一轮 AI 以回退后的工作稿为父。

### 4.5 人工编辑与打版本时机

| 事件 | 是否产生新草稿版本 |
| --- | --- |
| 打开修订 / ensureRevision | v0 = committed 快照（若尚无版本） |
| Agent 自动落稿 | 是（source=agent） |
| 用户点「回退」 | 是（source=rollback） |
| Monaco 连续键入 | **否**（只脏化工作稿） |
| 审核 / 直接提交前 | 若工作稿相对链尾有脏编辑 → **自动打** source=manual 版本再提交 |
| 可选：「保存草稿检查点」按钮 | 是（source=manual）— 本期可选 |

理由：避免每个按键一个版本；又保证提交物与 AI 轮次在版本轴上可追溯。

## 5. 数据模型（建议）

新表 `revision_draft_versions`（任务局部，不进模型链）：

```text
version_id          TEXT PK
project_id          TEXT NOT NULL
revision_task_id    TEXT NOT NULL  -- FK chapter_revision_tasks
parent_version_id   TEXT NULL     -- v0 为空
source              TEXT NOT NULL  -- agent | manual | rollback | baseline
message_id          TEXT NULL     -- source=agent 时关联对话
heading             TEXT NOT NULL
body                TEXT NOT NULL  -- 或 content_ref 指向 objects；首期可直接存 TEXT
body_digest         TEXT NOT NULL
created_at_ms       INTEGER NOT NULL
```

`chapter_revision_tasks` 可增：

```text
latest_draft_version_id  TEXT NULL
```

工作稿仍以现有 `proposed` / `updateRevision` 为准；`latest_draft_version_id` 指向「已固化的链尾」。若 `proposed` digest ≠ latest version digest，则工作稿为脏。

## 6. API（建议）

| Method | 说明 |
| --- | --- |
| `chapter.revision.draftVersion.list` | 列出版本 |
| `chapter.revision.draftVersion.read` | 读某一版全文 |
| `chapter.revision.draftVersion.diff` | 两版或相对 parent 的 diff |
| `chapter.revision.draftVersion.restore` | 回退（追加 rollback 版本） |
| `chapter.revision.conversation.send` | **扩展返回** `draftVersion` + `diff`；并自动落稿 |

废弃主路径依赖：`conversation.apply`（保留兼容）。

## 7. UI 草图（落位结论）

**MVP 推荐：方案 C — 放在「草稿编辑器」与「Agent 对话」之间的桥接区**（工具栏上下），不要放进右侧「历史」。

```text
┌─ 草稿编辑器（Monaco，当前工作稿）─────────────────┐
├─ 草稿版本  [v0 基线] [v1 AI] [v2 最新]  [对比][回退] ┤
├─ 本轮变更（可折叠 unified diff，相对父版）──────────┤
├─ 工具栏：样式 | 审核 / 提交 / 放弃 | 字数 ──────────┤
└─ Agent 对话（无「写入草稿」；气泡可「查看本轮 diff」）─┘
```

| 方案 | 位置 | MVP？ |
| --- | --- | --- |
| **C（推荐）** | 文档与 Agent 之间的版本条 + 可折叠 diff | 是 |
| A | `正文 \| 草稿 \| 对比` 第三 Tab | P1（大 diff） |
| B | 草稿区左侧版本 timeline | P1（多版本浏览） |
| 右侧「历史」 | **否** — 那是世界线推演历史 | 禁止混用 |

评估画布与原型图见会话产物：`draft-versions-ui-placement` canvas、推荐/备选原型图。

## 8. 与既有设计的关系

| 既有机制 | 关系 |
| --- | --- |
| §4.3 Agent 对话 / `proposal` | 保留；落稿从「显式 apply」改为「send 成功即落稿」 |
| `proposed` buffer | 仍是审核/提交唯一正文来源；与 latest draft version 对齐 |
| ModelContextChain | **不变**：仅 submit 后入链 |
| `history.git` / 世界线 | **不变**：草稿版本不是世界历史点 |
| 渲染进程已有「suggestion → 内存 draft」同步 | 升级为 **本机后端持久化的草稿版本**，避免刷新/重开章节丢失 |

需修订 [章节修改协同](../../chapter-modification-coordination.md) §4.3：删除「不自动 commit 到 proposed、须 apply」的表述，改为本设计的自动落稿 + 草稿版本语义（「commit」一词仍仅指正式 submit）。

## 9. 可行性与合理性评估

### 9.1 可行性：**高**

| 层面 | 评估 |
| --- | --- |
| 本机后端 | 已有 `revision_conversation_messages.proposal`、`updateRevision`、任务局部表模式（迁移 030 同类）；新增一表 + send 事务内写版本即可 |
| Diff | 成熟方案（如 `diff` / Monaco DiffEditor）；无需自研算法 |
| 渲染进程 UI | 工具栏与 Agent 面板已统一；增版本列表与 diff 面板为增量 UI |
| 隔离 | 完全落在 revision 任务局部，不触碰 hydration / 压缩 / 图同步关键路径 |
| 工作量（粗估） | 本机后端 1.5–2.5 人日；UI 2–3 人日；测试与 DOM 验收 1 人日 → **约一周内可落地 MVP** |

### 9.2 合理性：**高（且修正当前产品矛盾）**

- **自动写入**：符合「先看见 AI 写了什么，再决定审不审、提不提」；当前强制点击与双文档预览目标冲突，应改。
- **版本 ≠ 世界历史**：避免与 `history.git` 概念打架；用户回退的是「这一次修订会话里的稿」，不是整棵世界线。
- **Append-only 回退**：比改指针更安全，和 Git 心智一致。
- **人工不逐键打版本**：避免版本爆炸，合理性好。

### 9.3 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 正文很大导致版本表膨胀 | body 可改存 object store + digest；可配置保留最近 N 版 |
| 自动落稿后用户「不想要这轮」 | 回退到父版；或「放弃本轮」= restore(parent) |
| 渲染进程内存 draft 与本机持久化不同步 | send 响应以本机后端返回的 version 为准覆盖编辑器 |
| 旧 UI 仍点「写入草稿」 | apply 幂等；文档标明废弃主路径 |
| Diff 对超长章性能 | 仅对变更窗口渲染；大文件可先摘要「+/- 行数」再展开 |

### 9.4 建议分期

| 期次 | 范围 |
| --- | --- |
| **MVP** | send 自动落稿；版本表；list/read；相对 parent 的 diff UI；restore；去掉主路径「写入草稿」 |
| **P1** | 人工「保存检查点」；版本侧栏；Side-by-side diff；版本数上限与清理 |
| **P2** | 可选：版本备注、与某任意版本 diff、导出补丁 |

## 10. 验收标准（设计级）

1. 用户发送 Agent 消息后，**无需点击**即可在草稿 Tab 看到新正文，且 `updateRevision` 已持久化。  
2. 每轮成功 AI 落稿，`draft_versions` 增加一条，`parent` 指向落稿前链尾（或先打的 manual）。  
3. UI 能展示相对父版的增删行。  
4. 回退到 vK 后，工作稿内容等于 vK，且版本列表出现新的 rollback 节点为最新。  
5. 回退后继续对话，下一版父节点为 rollback 节点。  
6. 全程无新的 `canonical_chapter` / `chapter_revision` 链消息，直至用户正式提交。  
7. 假模型与真模型两条路径行为一致（仅正文质量不同）。

## 11. 待评审结论

- **建议采纳**本设计作为 §4.3 Agent 修订体验的下一增量。  
- 实现前需产品确认：回退是否必须 append-only（推荐是）；人工编辑是否需要 MVP 就带「保存检查点」（推荐 P1）。

---

## 修订记录

| 日期 | 说明 |
| --- | --- |
| 2026-08-26 | 初稿：自动落稿 + 线性草稿版本 + diff + 回退；可行性评估 |
