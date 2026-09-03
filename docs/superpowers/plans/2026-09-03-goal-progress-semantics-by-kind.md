# 按类型区分的目标进度语义 — 实施计划

> **规格：** [2026-09-03-goal-progress-semantics-by-kind-design.md](../specs/2026-09-03-goal-progress-semantics-by-kind-design.md)

## 文件

| 文件 | 职责 |
| --- | --- |
| `packages/contracts/src/deduction-goals.ts` | 共享文案 helper |
| `apps/desktop/.../creation-desk-goals.ts` | `resolveGoalRowStatus` 接 kind 映射 |
| `CreationDeskGoalsPopover.tsx` | 展开区标题 / 空态提示 |
| `CreationDeskProgressReview.tsx` | 复盘按钮文案 |
| `synopsis-discuss.md` / `plot-synopsis-guide.md` | Agent 约定 |
| `2026-09-02-narrative-goal-taxonomy-design.md` | 交叉引用 |

## 任务

1. contracts helper + 单测  
2. desktop 接入 + popover/复盘文案  
3. 提示词 + taxonomy 交叉引用  
4. build / 相关 vitest  
