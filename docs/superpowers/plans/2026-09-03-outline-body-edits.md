# Outline bodyEdits Implementation Plan

> **For agentic workers:** IMPLEMENT THIS PLAN AS WRITTEN. Spec: `docs/superpowers/specs/2026-09-03-outline-body-edits-design.md`

**Goal:** Fine-outline local `searchReplace` via JSON `bodyEdits`, loud failures, outline digest guard; synopsis stays full overwrite.

**Architecture:** Pure `applySearchReplace` → synopsis conversation apply path → schema/prompts/fake adapter/tests. Migration adds `last_outline_agent_digest`.

**Tech stack:** Zod schemas in prompt-contracts; SQLite migration 041; Vitest.

---

## File map

| File | Role |
| --- | --- |
| `apps/backend/src/application/chapters/markdown-search-replace.ts` | Pure apply helper |
| `apps/backend/test/markdown-search-replace.test.ts` | Unit tests |
| `packages/prompt-contracts/.../artifacts.ts` | `bodyEdits` schema + refine mutex |
| `packages/contracts/src/synopsis.ts` | `lastOutlineAgentDigest` |
| `apps/backend/.../project-migrations.ts` | 041 |
| `sqlite-synopsis-conversation-repository.ts` + database-types | Persist digest |
| `synopsis-conversation-service.ts` | Apply + loud fail + inject |
| `synopsis-discuss.md` + `plot-synopsis-guide.md` | Prompt rules |
| `fake-ai-model-adapter.ts` | Optional bodyEdits path |
| `apps/backend/test/outline-body-edits.test.ts` | Gate/integration-ish |

---

### Task 1: `applySearchReplace` + tests

**Files:** create helper + test as above.

- Normalize `\r\n` → `\n` for matching and output.
- Each `oldText` must occur exactly once; else fail with Chinese reason.
- Atomic: all-or-nothing.

### Task 2: Schema + migration + session field

**Files:** artifacts, contracts, migration 041, repo, database-types.

### Task 3: Service wiring

**Files:** `synopsis-conversation-service.ts`

- Read outline before discuss; compute digest / userEditedOutline.
- Inject into model payload.
- After assist: apply bodyEdits or outlineBody with gates.
- Prepend failure notes into returned content / assistant path.

### Task 4: Prompts + fake adapter

### Task 5: Tests green

Run: `npx vitest run apps/backend/test/markdown-search-replace.test.ts apps/backend/test/outline-body-edits.test.ts`
