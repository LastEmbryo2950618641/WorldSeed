# Adaptive Graph Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce unnecessary graph-governance work for committed chapter revisions while preserving the existing full workflow as a safe fallback.

**Architecture:** Add a small adaptive routing boundary around the existing `graph_governance` contract. The AI returns a generic execution mode; the application validates the mode and either completes a no-change sync, commits a locally complete governance artifact, or enters the existing full `revision` phase chain. Normal `turn` and `evolution` execution remain unchanged in this milestone.

**Tech Stack:** TypeScript, Zod prompt contracts, existing `TurnOrchestrator`, SQLite task checkpoints, Vitest.

---

### Task 1: Add the generic execution-mode contract

**Files:**
- Modify: `packages/prompt-contracts/src/phase-schemas/artifacts.ts`
- Modify: `packages/prompt-contracts/resources/v1/phases/graph-governance.md`
- Modify: `apps/backend/src/infrastructure/models/fake-ai-model-adapter.ts`
- Test: `packages/prompt-contracts/test/prompt-contracts.test.ts`

- [x] Add `executionMode` to `graphGovernanceArtifactSchema` with the values `no_change`, `local_governance`, and `full_governance`; default omitted legacy artifacts to `full_governance` so existing persisted runs remain safe.
- [x] State in the phase prompt that the mode is a routing decision, not a domain category, and that `no_change` must contain no mutations.
- [x] Make the deterministic fake return `no_change` for revision inputs with no graph mutation and `local_governance` for its minimal graph fixture.
- [x] Add schema tests for valid modes and reject `no_change` with mutations through a refinement.
- [x] Run the prompt-contract tests and confirm the new tests pass after the implementation.

### Task 2: Add an isolated adaptive route decision helper

**Files:**
- Create: `apps/backend/src/application/turns/adaptive-graph-governance-coordinator.ts`
- Modify: `apps/backend/src/application/turns/index.ts`
- Test: `apps/backend/test/adaptive-graph-governance-coordinator.test.ts`

- [x] Define a pure coordinator result with `no_change`, `local_governance`, and `full_governance`, plus a reason and fallback reason.
- [x] Parse the generic governance artifact through the existing Zod schema; never inspect narrative field names or semantic categories.
- [x] Return `full_governance` for malformed, legacy, or structurally incomplete local candidates so the existing path remains authoritative.
- [x] Test no-change, local, full, and malformed candidates with no database or model dependency.

### Task 3: Route revision graph synchronization with minimal intrusion

**Files:**
- Modify: `apps/backend/src/application/turns/turn-orchestrator.ts`
- Modify: `apps/backend/src/bootstrap/project-runtime.ts`
- Test: `apps/backend/test/turn-orchestrator.test.ts`

- [x] Add an internal adaptive flag to `TurnOrchestratorInput` and enable it only from `ProjectRuntime.runGraphSync`.
- [x] Keep normal turn/evolution phase arrays unchanged; use the adaptive coordinator only at the revision graph-sync entry point.
- [x] Execute the existing `graph_governance` contract first with the same context chain and bounded read loop.
- [x] For `no_change`, finish the revision graph-sync task without staging graph revisions.
- [x] For `local_governance`, use the existing generic graph staging and final scope commit path; reject unsafe local results into the existing recoverable interruption path.
- [x] For `full_governance`, restart from the existing `revision` phase chain using the same task, scope, context chain, and checkpoint persistence; do not change normal turn/evolution routing.
- [x] Add debug logs for mode, read rounds, mutation count, fallback reason, and usage.
- [x] Add integration tests proving no-change skips the fixed chain and local governance stages once; the existing recovery test covers full-governance fallback.

### Task 4: Preserve recovery and finalization behavior

**Files:**
- Modify: `apps/backend/src/application/turns/turn-orchestrator.ts`
- Modify: `apps/backend/src/bootstrap/project-runtime.ts`
- Test: `apps/backend/test/chapter-document.test.ts`
- Test: `apps/backend/test/turn-orchestrator.test.ts`

- [x] Persist the adaptive phase run and task checkpoint before returning or falling back.
- [x] Ensure a process restart resumes the adaptive phase or the full-chain checkpoint without a second content submission.
- [x] Ensure `no_change` does not create an empty graph revision or change the committed chapter.
- [x] Ensure a local graph commit remains idempotent and a failed local commit enters the existing recoverable task status.
- [x] Run targeted revision and recovery tests.

### Task 5: Verify the unchanged workflows and build

**Files:**
- Modify: `docs/implementation-status.md` only if the repository status format requires it.

- [ ] Run `pnpm --filter @worldseed/prompt-contracts test`.
- [ ] Run `pnpm --filter @worldseed/backend test`.
- [ ] Run `pnpm typecheck` and `pnpm build`.
- [ ] Run the focused revision acceptance path with the fake model and inspect adaptive routing logs.
- [ ] Confirm no `turn` or `evolution` phase-order regression before reporting completion.
