# 创作台推演目标 — 最终设计方案（Brief）

> **状态：** 终稿（2026-08-27，三 Agent 代码梳理 + 评审收敛）  
> **权威来源：** 本文为实施 brief；细节见 [完整设计](./2026-08-27-creation-desk-deduction-goals-design.md)  
> **建议：** **Go-with-scope-cut** — 立即启动 **P1**，P2/P3 独立里程碑

---

## 1. 一句话定位

**梗概**定「这章发生什么」；**推演目标**定「各条叙事线在每章结束时应推进到哪」。二者在 `beginTurn` 打包注入 turn，形成讨论对齐 → 锁定 → 约束 → 复盘闭环，约束长篇推演漂移。

---

## 2. 代码现状（梳理结论）

| 层 | 已有 | 缺失 |
| --- | --- | --- |
| **桌面原型** | Popover、toolbar、localStorage、add/complete、Agent pending 卡片骨架 | progress、edit/remove、`removed`、确认条、IPC；`proposeAgentGoal` 无调用方 |
| **梗概后端** | migration **031**、`synopsis.conversation.*`、synopsis_discuss phase | 与目标零耦合 |
| **Turn** | `resolveTurnInput` → `turn.start`（**非原子**） | `deductionGoalBundle`、lock、enforcement |
| **契约** | `synopsis.ts` | 无 `deduction-goals.ts` |

**原型须废弃：** `Goal.status = "pending"` → 独立 `deduction_goal_proposals` 表。

---

## 3. 最终设计方案

### 3.1 数据模型（Migration 032）

三表 + turn 快照（非第四表）：

- **`deduction_goals`** — 项目级目的；`lifecycle: active | completed | removed`；`updatedAtMs`
- **`deduction_goal_progress`** — 按 `chapterSequence`；`planned → achieved/partial/missed`；partial unique index（`WHERE status != 'superseded'`）
- **`deduction_goal_proposals`** — Agent 门禁；五种 kind + **zod discriminated union payload**（禁止 `unknown`）；可选 `source_message_id` 溯源

**变更权限：**

| 操作 | 用户 | Agent |
| --- | --- | --- |
| 改 content / progress | 随时，即时生效 | 提案 → 采纳后生效 |
| 完成 / 删除 | 即时（删除 + undo toast） | 提案 → 「采纳移除」 |
| 锁定后 | 改库作用于下一轮 | 同左 |

### 3.2 API

**P1 — `deduction.goals.*`（6 个 IPC）：**

- `list` · `create` · `update` · `progress.set` · `proposal.approve` · `proposal.reject`

**P2 — 梗概扩展：**

- `synopsis.conversation.send` 返回 `goalProposals[]`（**唯一** Agent 通道）

**P3 — 原子推演：**

- `synopsis.conversation.beginTurn` = reconcile + resolveTurnInput + lockForTurn + bundle snapshot + turn.start  
- `lockForTurn` **不** 暴露公开 IPC

### 3.3 UI

- **Popover**：维护 + Agent 提案（sticky 待处理区 + 活跃目标 + 当前章 progress 默认展开）
- **Footer 确认条**：本章 progress 统计 +「开始推演」主路径（移出 `⋯` 菜单）
- **Toolbar badge**：pending + 未填 progress 数

### 3.4 Turn 衔接（P3）

1. `beginTurn` 锁定 planned，写入 `TurnDeductionGoalBundle` 快照  
2. `interpret` / `rule_assembly` 注入 Markdown 约束  
3. 扩展 `semantic_review` → `goalCompliance` artifact（satisfied / partial / violated）

---

## 4. 决标项

| 问题 | 选择 |
| --- | --- |
| **梗概 vs 目标冲突** | beginTurn **reconcile**：语义明显矛盾 → **阻断**；未提及 → **警告可跳过**；turn 后偏离 → review 标记 violated |
| **Proposals 存储** | **独立表** + `source_message_id`（非 message-attached 真相源） |
| **P1 边界** | 三表 + 用户 CRUD/progress/remove + IPC + 确认条；**不含** Agent 写 proposals、turn 注入 |
| **Agent progress 通道** | 仅 `set_chapter_progress` 提案，取消独立 `suggestedProgress[]` |

---

## 5. 分期与工作量

| 期 | 范围 | 人日（1 人粗估） | 验收 |
| --- | --- | --- | --- |
| **P1** | 032 + 6 IPC + UI 接后端 + import + 确认条 + edit/remove/progress | **5–7** | 目标持久化、本章 progress、用户随时改 |
| **P2** | synopsis artifact + send 写 proposals + 提案 UI | **2–3** | Agent 变更须采纳 |
| **P3** | beginTurn + bundle + semantic_review | **3–5** | 防漂移闭环 |
| **P4** | 章后复盘 UI | **2** | planned → achieved/partial/missed |

**P1 单独 ROI：中等**（解决丢数据 + 结构化维护，但不约束 turn）  
**P1+P2+P3 ROI：高**（完整防漂移价值链）

---

## 6. 可行性

| 维度 | 评级 | 说明 |
| --- | --- | --- |
| P1 持久化 | **高** | 同 synopsis/revision CRUD 模式 |
| P2 Agent 输出 | **中** | artifact 扩展 + fake model |
| P3 beginTurn | **中** | 须合并现有两步 IPC；turn 元数据扩展 |
| reconcile 语义 | **中** | 初期 heuristic，误阻断可 override |

**Top 风险：** P3 前用户误以为已约束推演 → UI 须标注「约束将于正式推演生效」；beginTurn 事务 rollback；原型 pending 语义迁移。

---

## 7. 价值论证

**值得做：** 长篇连载的跨章叙事线无法只靠单章梗概追踪；讨论口头对齐在 turn 长链路中必然衰减；无 enforcement 则梗概讨论越完善、用户信任落差越大。

**1+1>2：** 梗概 = 场景蓝图；目标 = 各线在本章的完成态；`beginTurn` 打包二者才是 turn 的完整输入。

**不做：** localStorage 永远是 demo；漂移只能靠肉眼；无法章后结构化复盘。

---

## 8. 建议

### Go-with-scope-cut

1. **立即 P1** — 用户侧闭环，验证 progress UX  
2. **并行决标 reconcile 规则**（P3 前文档化即可）  
3. **P3 分水岭** — `beginTurn` 原子化是防漂移从 prompt 变为系统能力的关键  
4. **三 PR 切 P1 UI：** contracts+hook → Popover CRUD/progress → 确认条+测试

### 最小 MVP（资源极紧）

P1 去掉 proposals 表写入（结构预留），保留 progress + 用户 CRUD + 确认条。

---

## 9. 实施顺序（8 步）

1. `packages/contracts/src/deduction-goals.ts` + backend-payloads  
2. Migration 032 + `database-types.ts`  
3. `sqlite-deduction-goals-repository.ts`  
4. `deduction-goals-service.ts`  
5. `backend-facade.ts` + `project-runtime.ts` + ipc-router  
6. 桌面：`use-deduction-goals.ts` + Popover/ConfirmBar 改造 + import  
7. P2：`synopsisDiscussArtifactSchema` + `synopsis-conversation-service`  
8. P3：`beginTurn` + `TurnPhaseInput.deductionGoalBundle` + semantic_review  

---

## 10. 变更记录

| 日期 | 说明 |
| --- | --- |
| 2026-08-27 | 三 Agent 梳理代码后收敛终稿 |
