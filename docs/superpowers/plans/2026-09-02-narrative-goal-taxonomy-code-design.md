# 叙事目标分类 — 详细代码设计与补全计划

> **For agentic workers:** 按任务勾选实施；本文件是 [`2026-09-02-narrative-goal-taxonomy-design.md`](../specs/2026-09-02-narrative-goal-taxonomy-design.md) 的**代码层**设计。  
> **Goal:** 补全 v1：用户可在 UI 设置分类/尺度/章窗；校验与注入/提示对齐；补测试。  
> **Architecture:** 权威在 SQLite `deduction_goals`；API 已通；缺口集中在桌面写入与校验/测试。  
> **Tech Stack:** Zod contracts、Kysely SQLite、React creation-desk、prompt-contracts。

**审计结论（2026-09-02）：** 管道已通；维护主路径为 Agent `goalProposals` + 用户采纳，手动添加为次要纠错入口。

---

## 1. 调用链（现状）

```
UI CreationDeskGoalsPopover
  → useDeductionGoals.addGoal(content) / updateContent(goalId, content)
  → IPC deduction.goals.create|update
  → backend-facade (Zod payload)
  → DeductionGoalsService.create|update
  → SqliteDeductionGoalsRepository.insertGoal|updateGoal
  → deduction_goals (migration 039 columns)

Agent synopsis_discuss artifact.goalProposals
  → createProposalsFromArtifact → pending
  → user approve → applyProposal → 同上表

Discuss / Turn inject
  → selectGoalsForChapterContext(goals, chapterSequence, K=24)
  → synopsisDiscuss.activeGoals | TurnDeductionGoalBundle
```

---

## 2. 数据与 API（已冻结，勿改名）

| 字段 | 存储列 | 默认 | 备注 |
| --- | --- | --- | --- |
| `narrativeKind` | `narrative_kind` | `general` | 勿与 proposal `kind` 混淆 |
| `scale` | `scale` | `short` | |
| `plantChapterSequence` | `plant_chapter_sequence` | null | |
| `payoffChapterSequence` | `payoff_chapter_sequence` | null | plant≤payoff |

**类型别名（桌面复用）：**

```ts
type GoalTaxonomyInput = Readonly<{
  narrativeKind?: "general" | "foreshadow" | "climax"
  scale?: "short" | "medium" | "long"
  plantChapterSequence?: number
  payoffChapterSequence?: number
}>
```

---

## 3. 缺口 → 代码改动

### 3.1 Desktop hook（P0）

**文件：** `apps/desktop/src/renderer/src/features/editor/use-deduction-goals.ts`

```ts
addGoal(content: string, taxonomy?: GoalTaxonomyInput): Promise<void>
updateGoal(goalId: string, patch: { content?: string } & GoalTaxonomyInput): Promise<void>
```

- `addGoal` → `deduction.goals.create` 展开 taxonomy  
- `updateGoal` 替代仅 content 的 `updateContent`（保留 `updateContent` 为薄封装调用 `updateGoal`）

### 3.2 Popover UI（P0）

**文件：** `CreationDeskGoalsPopover.tsx`

新增目标区：

- `select` 类型：目标 / 伏笔 / 高潮  
- `select` 尺度：短 / 中 / 长（`general` 时仍可选，默认短）  
- 类型为伏笔/高潮时显示可选「起势章」「兑现章」number input  

编辑行：

- 非 chapter-progress 编辑模式下，可打开小面板改 taxonomy，调 `updateGoal`  
- 或：编辑保存时若 taxonomy 控件有变一并提交  

提案卡：

- `payload.kind === "create"` 时展示 `narrativeKind·scale` 芯片（若有）

**Props 变更：**

```ts
onAdd(content: string, taxonomy?: GoalTaxonomyInput): Promise<void>
onUpdateGoal(goalId: string, patch: { content?: string } & GoalTaxonomyInput): Promise<void>
```

`SynopsisConversationComposer` / `CreationDeskToolbar` 若透传，同步签名。

### 3.3 校验对齐（P1）

| 点 | 文件 | 做法 |
| --- | --- | --- |
| artifact 提案 | `prompt-contracts/.../artifacts.ts` | 与 contracts 同级 refine（plant≤payoff；update 至少 content 或 taxonomy） |
| createProposalsFromArtifact | `deduction-goals-service.ts` | `goalProposalPayloadSchema.safeParse`，失败 skip |
| applyProposal create | 同上 | plant≤payoff 校验 |
| AIModelPort | `ai-model-port.ts` | `activeGoals` 扩 taxonomy 字段 |
| turn markdown | `turn-orchestrator.ts` `formatDeductionGoalConstraintMarkdown` | 前缀 `[伏笔·长]` 等 |

### 3.4 测试（P0）

| 包 | 用例 |
| --- | --- |
| contracts | relevance 矩阵；select cap；plant>payoff reject |
| backend | create foreshadow+window；bundle 过滤；importLegacy defaults |
| desktop | listChapterRelevantGoals；labels |
| prompt-contracts | schema 含 narrativeKind；prompt 含戏核 |

---

## 4. 文件职责表

| 文件 | 职责 |
| --- | --- |
| `packages/contracts/src/deduction-goals.ts` | 模型、提案、helpers（已完成） |
| `packages/contracts/src/backend-payloads.ts` | IPC 载荷（已完成） |
| `039_deduction_goal_taxonomy` | 列迁移（已完成） |
| `sqlite-deduction-goals-repository.ts` | 持久化（已完成） |
| `deduction-goals-service.ts` | 业务 + 过滤注入（补校验） |
| `synopsis-conversation-service.ts` | discuss 注入（已完成） |
| `use-deduction-goals.ts` | **补** taxonomy API |
| `CreationDeskGoalsPopover.tsx` | **补** 控件 |
| `creation-desk-goals.ts` | helpers（已有 labels/filter） |
| `ai-model-port.ts` / `turn-orchestrator.ts` | **补** 类型与 markdown |
| 各 `*.test.ts` | **补** |

---

## 5. 任务清单

- [x] T1: 扩展 `use-deduction-goals` + popover 父级透传  
- [x] T2: Popover 新建/编辑 taxonomy UI + 提案芯片  
- [x] T3: Service/artifact/port/markdown 硬化  
- [x] T4: 测试补全并跑通  

---

## 6. 非本计划

- `thread` kind、动态区目录、弧线看板、硬门禁清单表单  
