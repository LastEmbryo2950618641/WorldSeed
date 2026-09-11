# Unified Chapter Discuss Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `synopsis_discuss` agent, one project-long session, two UI placements; drafts persist in SQLite; official 正文 files change only via `submitRevision`.

**Architecture:** Extend discuss session focus + `revision_draft_versions`. Right rail switches to `synopsis.conversation.send`. Retire `revision_assist` last.

**Tech Stack:** TypeScript, Kysely/SQLite, Electron renderer, Vitest.

**Spec:** [2026-09-10-unified-chapter-discuss-agent-design.md](../specs/2026-09-10-unified-chapter-discuss-agent-design.md)

## Global Constraints

- Agent never writes official `章节正文/*.md` (non-planning); only `chapter_publisher` / `submitRevision`.
- Discuss does not append to official `model_context_chains`.
- 描写「自动」= inject all description presets.
- Do not add 享受/自愿 regex.
- One active discuss session per project; changing chapter updates focus, not session id.
- Auto-append draft on discuss body edit; confirm only `promote_draft_to_body` → `submitRevision`.
- Chapter-file rail send is focus-locked (`focusLocked` + `lockedChapterSequence`); ignore `set_focus`.
- No renderer auto-`conversation.apply` via `revision_assist`.
- Do not delete `revision_assist` until rail is on discuss and tests pass.

---

## File map

| File | Responsibility |
| --- | --- |
| `apps/backend/src/infrastructure/sqlite/migrations/project-migrations.ts` | 046 draft versions + latest_draft_version_id; 047 optional one-active index |
| `apps/backend/src/infrastructure/sqlite/database-types.ts` | Row types |
| `apps/backend/src/infrastructure/sqlite/repositories/sqlite-revision-draft-version-repository.ts` | Draft version CRUD |
| `packages/contracts/src/chapter.ts` | Draft version DTOs |
| `packages/contracts/src/backend-methods.ts` + `backend-payloads.ts` | IPC |
| `apps/backend/src/application/chapters/chapter-revision-service.ts` | start baseline; append/restore |
| `apps/backend/src/bootstrap/backend-facade.ts` | Dispatch |
| `apps/desktop/.../App.tsx` | Drop auto-apply; rail send → discuss; setFocus on open |
| `apps/desktop/.../ChapterWorkspaceRail.tsx` | Compact discuss composer |
| `packages/prompt-contracts/.../artifacts.ts` + `synopsis-discuss.md` | Draft proposal + choices |

---

## Task 1: Persist draft versions

- [x] Migration 046: `revision_draft_versions` + `chapter_revision_tasks.latest_draft_version_id`
- [x] Update `sqlite-migrations.test.ts` version list and table names
- [x] Repository + contracts `chapter.revision.draftVersion.list|read|restore|append`
- [x] `ChapterRevisionService.start` writes baseline version (source=baseline, body=committed)
- [x] `append` updates latest pointer + `updateRevision`
- [x] Test: start → list has v0; append agent → latest changes; restore appends rollback; committed file unchanged

## Task 2: Session focus without new session

- [x] `synopsis.conversation.setFocus({ chapterSequence })` updates active session path/title/sequence in place
- [x] App: opening 正文/梗概/细纲 calls setFocus
- [x] Test: start ch1, setFocus(2), same sessionId, send still lists prior messages

## Task 3: Auto-append draft proposal on discuss

- [ ] Artifact `chapterDraftProposal` + choice `promote_draft_to_body`
- [ ] `send` with proposal: ensure revision, append draft, official file unchanged
- [ ] `send` without proposal does not append
- [ ] Tests: body unchanged + new draft; second send parents previous; locked sequence pins chapter

## Task 4: Right rail uses discuss session

- [ ] `ChapterWorkspaceRail` renders compact discuss UI with same messages/choices
- [ ] Send via `synopsis.conversation.send` with `focusLocked` + `lockedChapterSequence`
- [ ] Hide/ignore `set_focus`; keep paper-plane submit / review

## Task 5: 正文 version picker

- [ ] List committed versions via predecessor chain
- [ ] Restore confirm → submitRevision with old body
- [ ] Toolbar chip `正文 vN · 草稿 vM`

## Task 6: Remove revision_assist

- [x] Delete service, IPC, prompt, composer, tests listed in spec §10
- [ ] Drop `revision_conversation_messages` in a later migration
