# Arc Planning + Continuity + Turn Handoff (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Arc outline via discuss artifact, claim prebuilt synopsis files, keep discussion history across chapters, read-only turn monitor digests, and post-publish handoff into the arc discussion (no auto beginTurn).

**Architecture:** Persist `arcPlan` to `暂存区/弧线规划.md`. Continuity via project-wide message list + new active session per next sequence after publish. Handoff runs after `linkAfterPublish` as best-effort (must not fail finalization). Monitor digests reuse public phase-run snapshots.

**Tech Stack:** Zod prompt-contracts, SQLite synopsis repos, Vitest harness, existing facade/orchestrator hooks.

**Spec:** `docs/superpowers/specs/2026-08-31-chapter-intent-and-arc-planning-design.md` §6 / §8 P1.

## Global Constraints

- Publish must not delete `暂存区/`
- beginTurn must not inherit `synopsis-discuss:` contextViewRef
- Handoff must not auto `beginTurn`
- Monitor MVP = phase summaries only
- Auto handoff analysis default on (no settings UI yet)

---

### Task 1: `arcPlan` artifact + write `暂存区/弧线规划.md`

**Files:** prompt-contracts artifacts + synopsis-discuss.md; contracts choice enum; fake adapter; synopsis-conversation-service

- [ ] Add optional `arcPlan` to `synopsisDiscussArtifactSchema` (markdown body + optional chapterBeats)
- [ ] Add choice `confirm_arc_plan`
- [ ] On successful discuss, if `arcPlan` present → `saveUserMarkdown(..., "暂存区/弧线规划.md", ...)`
- [ ] Prompt: outline-first guidance + arcPlan field

### Task 2: Claim existing synopsis on `start`

**Files:** synopsis-conversation-service.ts; tests

- [ ] Before placeholder: `workspace.validate` inventory → find synopsis path with `parseSynopsisMarkdownPath.sequence === nextSequence`
- [ ] If found: hang that path/title; do **not** overwrite
- [ ] Else: existing placeholder create

### Task 3: Arc discussion continuity

**Files:** sqlite-synopsis-conversation-repository; synopsis-conversation-service list/send returns

- [ ] `listMessagesForProject(projectId)` ordered by createdAtMs
- [ ] `list` / send results use project-wide messages; `session` remains active binding
- [ ] After publish complete: ensure next-sequence active session (claim/create) so UI can continue

### Task 4: Post-publish handoff

**Files:** contracts TurnHandoffBrief; synopsis-conversation-service.recordTurnHandoff; chapter-synopsis or orchestrator hook; project-runtime wiring

- [ ] After successful `linkAfterPublish`, best-effort handoff
- [ ] Append `role=system` message with brief
- [ ] Optional auto `runSynopsisDiscuss` with `trigger: turn_handoff` (no user text / no beginTurn)
- [ ] Swallow errors after publish success

### Task 5: Turn monitor digest

**Files:** contracts types; synopsis service dependency; inject into synopsisDiscuss input; optional backend method

- [ ] Build short phase summaries from public phase runs for running task
- [ ] Attach to discuss input; never write into turn chain

### Task 6: Tests

- [ ] Claim existing file
- [ ] Staging file survives linkAfterPublish
- [ ] Arc messages visible after chapter complete + next start
- [ ] Handoff system message; no beginTurn side effect
- [ ] beginTurn contextViewRef ≠ synopsis-discuss (assert in prepare/startWorkflow path if easy)

**Out of scope (P2):** advanced monitor UI, auto-analysis settings toggle, front-matter intent persistence.
