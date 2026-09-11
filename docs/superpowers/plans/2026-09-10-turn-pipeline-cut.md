# Turn Pipeline Cut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. This cut is tightly coupled in `TurnOrchestrator`; do not split across independent subagents.

**Goal:** Cut official chapter 推演 (`workflow=turn`) from ~16–17 model calls to ~10 by removing advisory reviews and the mid-turn settings pause, while keeping retrieve → draft → graph writes → mechanical submit.

**Architecture:** Only `turnExecutionPhases` changes. Query / evolution / revision keep their current review stacks. Skipped turn phases still produce **synthesized artifacts** so `stageGraphAndSettlement` mechanical gates stay intact. Discuss read evidence is copied into the turn’s initial evidence set.

**Tech Stack:** TypeScript, Vitest, existing `TurnOrchestrator` + `RightRail`.

## Global Constraints

- Do not merge `graph_structure_plan` / spacetime / retrieval in this cut.
- AI review still cannot block commit.
- Do not delete phase schemas, prompts, or evolution/revision paths.
- Official `章节正文/*.md` still only changes via existing submit/publish.
- Do not add 享受/自愿 regex.

## New turn hot path (model calls)

```text
interpret → rule_assembly → source_retrieval
→ emergence_planning
→ draft → chapter_naming → dependency_audit
→ graph_structure_plan → [graph_capacity_rewrite skip-unless]
→ graph_spacetime_settlement → graph_retrieval_design
→ frontier_settlement
→ code completeTurn
```

## Synthesize (no model)

| After | Artifact |
| --- | --- |
| `emergence_planning` | `emergence_review` pass-all decisions |
| `graph_retrieval_design` | `graph_governance` assemble + `semantic_review` all-approve + `settlement_review` all source units settled |

## Removed from turn only

`emergence_review`, `settings_extraction`, `graph_governance_review`, `settlement_review`, `commit_review` as model phases.

## File map

| File | Change |
| --- | --- |
| `apps/backend/src/application/turns/turn-orchestrator.ts` | Phase list, synthesize helpers, skip settings pause, inherit discuss evidence, resume mapping, completeTurn without commit_review parse |
| `apps/backend/src/application/chapters/synopsis-conversation-service.ts` | `listInheritedReadEvidence(projectId)` |
| `apps/desktop/src/renderer/src/features/status/RightRail.tsx` | Hide skipped turn phases; attach graph group after `dependency_audit` |
| `apps/backend/test/turn-orchestrator.test.ts` | Expected phase lists / artifact deps |
| `apps/desktop/test/renderer-ui.test.ts` | Phase list still renders remaining rows |

## Resume of old in-flight turns

If checkpoint phase is no longer in `turnExecutionPhases`, map:

- `emergence_review` → `draft`
- `settings_extraction` → `graph_structure_plan` (after `assertTaskReadyToContinue` if `waiting_for_review`)
- `graph_governance_review` / `settlement_review` → `frontier_settlement`
- `commit_review` → complete immediately (`startPhaseIndex = executionPhases.length`)

## Out of scope (next cut)

- Merge interpret + rule_assembly
- Skip `chapter_naming` when planning title exists
- Merge graph write stages
- Drop `frontier_settlement` when evolution is off
- Lower `maxRetrievalRounds`
