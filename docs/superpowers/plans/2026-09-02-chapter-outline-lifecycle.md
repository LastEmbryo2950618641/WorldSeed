# 章细纲生命周期 Implementation Plan

> **For agentic workers:** Implement task-by-task; checkboxes track progress.

**Goal:** 同章 `[剧情梗概]` → `[剧情细纲]` → 正文三档留盘；树折叠；推演细纲为主+梗概附录；发布不删前档；正文回退到细纲级。

**Architecture:** 扩展 `synopsis-path` 族识别细纲；workspace policy 放行细纲写入；`linkAfterPublish` 保留文件；`resolveBootstrapInput` 组装细纲+附录；桌面树按表面文件折叠；右侧栏展示关联路径。Stage 先由路径存在性推导，会话可增 `outline_path`/`artifact_stage`。

**Tech Stack:** TypeScript monorepo、SQLite/Kysely、React desktop、prompt-contracts。

**Spec:** `docs/superpowers/specs/2026-09-02-chapter-outline-lifecycle-design.md`

## Global Constraints

- 前档永不因进入后档而删除
- 冲突以细纲为准；正文回退默认到 outline
- 细纲与梗概同目录，不进暂存区

---

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `apps/backend/src/core/chapters/synopsis-path.ts`（或拆 outline） | 细纲后缀、derive/parse/is |
| `workspace-policy.ts` + desktop locks | 细纲可写 |
| `chapter-synopsis-service.ts` | 发布后不删；可选归档细纲 |
| `synopsis-conversation-service.ts` | bootstrap 细纲为主；写 outlineBody |
| `App.tsx` / WorkspaceTree / ChapterWorkspaceRail | 折叠与右侧栏 |
| prompt-contracts | 细纲模板与讨论规则 |

---

## Tasks

- [x] T1: 路径 helpers + 单测（`[剧情细纲]`）
- [x] T2: workspace policy + desktop `isOutlineMarkdownPath`
- [x] T3: `linkAfterPublish` 停止删除梗概；测发布后文件仍在
- [x] T4: `resolveBootstrapInput` 细纲为主+梗概附录
- [x] T5: discuss 写入 `outlineBody`（artifact + service）
- [x] T6: 桌面树折叠 + 创作台识别细纲（右侧栏关联 P1 可增强）
- [x] T7: 提示词（正文回退 API 仍为 P1）
- [ ] T8: 回归测跑通

---
