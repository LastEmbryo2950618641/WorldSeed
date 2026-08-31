# Synopsis Staging Area Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox syntax.

**Goal:** Add workspace `暂存区/` so synopsis discuss auto-extracts intermediate facts, then user-confirmed promote writes `设定集/` (+ goal proposals).

**Architecture:** Sixth fixed root + `staging` catalog role; `stagingDelta` merged into fixed Markdown files on send; promote proposals approved via IPC; settled entries retained until char-budget eviction.

**Tech Stack:** TypeScript monorepo (`@worldseed/contracts`, backend workspace core, synopsis service, desktop creation desk).

**Spec:** `docs/superpowers/specs/2026-08-30-synopsis-staging-area-design.md`

## Global Constraints

- No silent writes to `设定集/` — only `promote.approve`
- Settled entries stay queryable; eviction prefers oldest settled first
- Default `staging.maxChars` = 80_000 (exclude readme from count)
- Goals on promote: create pending goal proposals (not auto-apply) per §6.4

---

## Task 1: Workspace root + catalog role (P0)

- [x] Add `暂存区` to `fixedTopLevelDirectories` + `fixedWorkspaceEntries` (+ staging role)
- [x] Update policy message (six roots); fix workspace-policy tests
- [x] Catalog: `staging` in contracts + `classifyRole`
- [x] Seed fixed files in `createLayout` / `ensurePlatformDocuments`
- [x] Project settings `staging.maxChars`
- [x] Verify: create project → `暂存区/*.md` exist; typecheck

## Task 2: Staging file merge + send delta (P1)

- [x] `staging-entries.ts` parse/serialize/merge/evict
- [x] Extend `synopsisDiscussArtifactSchema` with `stagingDelta`
- [x] Wire merge after discuss in `SynopsisConversationService.send`
- [x] Allow synopsis reads of `staging` role
- [x] Tests for merge + eviction
- [x] Update Fake adapter to emit light stagingDelta

## Task 3: Promote proposals + IPC + UI (P2)

- [x] SQLite proposals table + service approve/reject (settings write + goal proposals)
- [x] Choice action `promote_staging`; contracts methods/payloads
- [x] Creation-desk UI: confirm/reject promote
- [x] Tests for approve writes 设定集 and marks settled

## Task 4: Prompts (P3)

- [x] Update synopsis-discuss + settings-revision-guide for staging
- [x] Prompt-contracts tests still pass
