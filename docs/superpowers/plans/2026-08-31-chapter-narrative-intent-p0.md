# Chapter Narrative Intent (P0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add creation-desk「边界节奏」「因果焦点」controls, thread `ChapterNarrativeIntent` through send / beginTurn / turn.start, and inject prompt appendices into `synopsis_discuss` + `draft`.

**Architecture:** Mirror presentation: renderer session state → contracts payloads → facade → discuss service / turn orchestrator. Appendix helper sibling to `worldDivergencePhaseAppendix`. Intent is orthogonal to `worldDivergenceMode`.

**Tech Stack:** Zod contracts, Vitest, React renderer, existing phase-prompt append pattern.

**Spec:** `docs/superpowers/specs/2026-08-31-chapter-intent-and-arc-planning-design.md` §4–5, §8 P0.

## Global Constraints

- Defaults: `boundaryPace=advance_allowed`, `causalityFocus=auto`
- Session-only UI state (no project settings write)
- Inject appendix for `synopsis_discuss` and `draft` only (not semantic_review in P0)
- Do not mix discuss/turn writable context chains
- ChapterConversationComposer does **not** get these controls

---

### Task 1: Contracts — `ChapterNarrativeIntent`

**Files:**
- Modify: `packages/contracts/src/backend-payloads.ts`
- Test: covered via backend schema parse in later tests

**Interfaces:**
- Produces: `chapterNarrativeIntentSchema`, `ChapterNarrativeIntent`

- [x] **Step 1: Add schema beside presentation**
- [x] **Step 2: Build contracts package**

---

### Task 2: Appendix helper + unit tests

**Files:**
- Create: `apps/backend/src/application/settings/chapter-narrative-intent-policy.ts`
- Modify: `apps/backend/src/application/settings/index.ts`
- Test: `apps/backend/test/chapter-narrative-intent-policy.test.ts`

**Interfaces:**
- Consumes: `ChapterNarrativeIntent`, `AIPhase`
- Produces: `resolveChapterNarrativeIntent`, `chapterNarrativeIntentPhaseAppendix`

- [ ] **Step 1: Write failing test**

Assert appendix contains 边界节奏 / 因果焦点 for `draft` + `synopsis_discuss`; undefined for `rule_assembly`; hold_without_resolution forbids irreversible closure wording; defaults when undefined.

- [ ] **Step 2: Implement helper** (Chinese markdown, same style as world-divergence)

- [ ] **Step 3: Run** `corepack pnpm --filter @worldseed/backend exec vitest run test/chapter-narrative-intent-policy.test.ts`

---

### Task 3: Wire discuss + draft injection + persistence

**Files:**
- Modify: `apps/backend/src/application/turns/ports/ai-model-port.ts` (`TurnPhaseInput.chapterIntent?`)
- Modify: `apps/backend/src/application/turns/turn-orchestrator.ts` (`TurnOrchestratorInput` + `executePhase` append)
- Modify: `apps/backend/src/application/chapters/synopsis-conversation-service.ts` (`send` + `runSynopsisDiscuss`)
- Modify: `apps/backend/src/bootstrap/backend-facade.ts` (send / beginTurn / startTurn / startWorkflow / resume recover)

- [ ] **Step 1: Pass `chapterIntent` through facade → orchestrator / discuss**
- [ ] **Step 2: Append appendix after base phase prompt (compose with worldDivergence when both present)**
- [ ] **Step 3: Persist on `TurnPhaseInput` so resume recovers via `readRecoverablePhaseInput`
- [ ] **Step 4: Test appendix presence in policy tests; smoke beginTurn/send payload parse if easy

---

### Task 4: Desktop UI + payload send

**Files:**
- Modify: `apps/desktop/src/renderer/src/features/editor/SynopsisConversationComposer.tsx`
- Modify: `apps/desktop/src/renderer/src/features/editor/EditorArea.tsx`
- Modify: `apps/desktop/src/renderer/src/app/App.tsx`
- Modify: `apps/desktop/test/renderer-ui.test.ts`

- [ ] **Step 1: State defaults + two selects with tooltips**
- [ ] **Step 2: Include `chapterIntent` on `synopsis.conversation.send`, `beginTurn`, `turn.start`
- [ ] **Step 3: Assert UI labels in renderer-ui test

---

### Task 5: Verify

- [ ] Run backend policy + synopsis/turn smoke tests as needed
- [ ] Run desktop `renderer-ui.test.ts` creation-desk case

**Out of scope (P1+):** arc plan, monitor, handoff, intent persistence to session/front-matter.
