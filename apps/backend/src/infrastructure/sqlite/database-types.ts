import type { ColumnType } from "kysely"

type JsonText = string
type Timestamp = number
type NullableTimestamp = number | null
type GeneratedNumber = ColumnType<number, number | undefined, number>

export type SchemaMigrationRow = {
  version: number
  name: string
  digest: string
  applied_at: Timestamp
}

export type RegisteredProjectRow = {
  project_id: string
  workspace_root_ref: string
  internal_store_ref: string
  last_opened_at: Timestamp
  created_at: Timestamp
}

export type ModelProfileRow = {
  id: string
  name: string
  base_url: string
  model: string
  credential_ref: string
  api_protocol: string
  context_window_tokens: number
  is_active: number
  position: number
  created_at: Timestamp
  updated_at: Timestamp
  thinking_mode_enabled: number
  reasoning_effort: string
  json_mode_enabled: number
  disable_response_storage: number
  service_tier: string
}

export type RegistryDatabase = {
  schema_migrations: SchemaMigrationRow
  registered_projects: RegisteredProjectRow
  model_profiles: ModelProfileRow
}

export type ProjectRow = {
  id: string
  name: string
  manifest_version: number
  committed_sequence: number
  active_generation: GeneratedNumber
  created_at: Timestamp
  updated_at: Timestamp
}

export type ProjectManifestRow = {
  project_id: string
  schema_version: number
  fixed_entries_json: JsonText
  digest: string
  updated_at: Timestamp
}

export type ProjectSettingsRow = {
  project_id: string
  settings_json: JsonText
  updated_at: Timestamp
}

export type IdCounterRow = {
  project_id: string
  prefix: string
  current_value: number
  updated_at: Timestamp
}

export type WorkspaceOperationRow = {
  id: string
  project_id: string
  kind: string
  path_json: JsonText
  status: string
  progress_json: JsonText
  error_json: JsonText | null
  created_at: Timestamp
  updated_at: Timestamp
}

export type ArtifactScopeRow = {
  id: string
  project_id: string
  task_id: string
  turn_id: string
  visibility: "pending" | "committed" | "retired"
  base_committed_sequence: number
  base_generation: GeneratedNumber
  committed_sequence: number | null
  reason: string
  created_at: Timestamp
  retired_at: NullableTimestamp
}

export type TurnFinalizationRow = {
  id: string
  project_id: string
  task_id: string
  turn_id: string
  scope_id: string
  context_id: string
  source_id: string
  chapter_sequence: number
  chapter_path: string
  chapter_heading: string
  content_ref: string
  content_digest: string
  content_token_estimate: number
  canonical_message_id: string
  graph_anchor_ids_json: JsonText
  model_calls: number
  input_tokens: number
  output_tokens: number
  model_provider: string
  model_name: string
  kv_cache_hit_rate: number | null
  status: string
  committed_sequence: number | null
  error_json: JsonText | null
  created_at: Timestamp
  updated_at: Timestamp
}

export type CanonicalChapterMessageRow = {
  id: string
  project_id: string
  task_id: string
  turn_id: string
  context_id: string
  source_id: string
  chapter_sequence: number
  chapter_path: string
  chapter_heading: string
  content_ref: string
  content_digest: string
  created_at: Timestamp
}

export type ChapterRevisionTaskRow = {
  id: string
  project_id: string
  chapter_id: string
  base_source_id: string
  proposed_source_id: string
  predecessor_source_id: string | null
  heading: string
  content_ref: string
  content_digest: string
  base_content_digest: string
  submission_mode: "direct" | "reviewed" | null
  input_mode: "direct" | "agent"
  decision: "pending" | "submit" | "abandon"
  review_id: string | null
  graph_sync_status: "not_started" | "pending" | "running" | "completed" | "failed"
  status: string
  content_scope_id: string | null
  graph_sync_scope_id: string | null
  graph_sync_task_id: string | null
  decision_id: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

export type ChapterRevisionReviewRow = {
  id: string
  revision_task_id: string
  proposed_source_id: string
  content_digest: string
  issues_json: JsonText
  recommendation: "no_issue" | "review_suggested" | "material_conflict"
  created_at: Timestamp
}

export type ChapterRevisionDecisionRow = {
  id: string
  revision_task_id: string
  proposed_source_id: string
  content_digest: string
  mode: "direct" | "reviewed"
  action: "submit" | "abandon"
  forced: number
  reason: "user_forced_edit" | "user_reviewed_edit"
  review_id: string | null
  note: string | null
  created_at: Timestamp
}

export type ChapterRevisionFinalizationRow = {
  id: string
  project_id: string
  revision_task_id: string
  proposed_source_id: string
  content_scope_id: string
  graph_sync_task_id: string | null
  content_digest: string
  status: "prepared" | "content_committed" | "chapter_published" | "chapter_registered" | "graph_sync_pending" | "graph_sync_running" | "completed"
  created_at: Timestamp
  updated_at: Timestamp
}

export type ModelContextChainRow = {
  id: string
  project_id: string
  protocol_version: string
  system_rules_digest: string
  message_count: number
  token_estimate: number
  created_at: Timestamp
  updated_at: Timestamp
}

export type ModelContextMessageRow = {
  id: string
  project_id: string
  chain_id: string
  sequence_no: number
  role: "system" | "user" | "assistant"
  kind: string
  task_id: string | null
  turn_id: string | null
  phase: string | null
  content_text: string | null
  content_ref: string | null
  content_digest: string
  token_estimate: number
  origin_phase_run_id: string | null
  origin_index: number | null
  hidden_at: NullableTimestamp
  metadata_json: string | null
  created_at: Timestamp
}

export type ChapterIndexRow = {
  project_id: string
  chapter_id: string
  sequence: number
  current_source_id: string
  current_publish_path: string
  assigned_at_ms: Timestamp
}

export type ChapterLineageSnapshotRow = {
  id: string
  project_id: string
  chapter_id: string
  source_id: string
  prior_chapter_source_ids_json: string
  created_at_ms: Timestamp
}

export type RevisionConversationMessageRow = {
  id: string
  project_id: string
  revision_task_id: string
  role: "user" | "assistant" | "system"
  content_text: string
  proposal_json: string | null
  created_at_ms: Timestamp
}

export type SynopsisConversationSessionRow = {
  session_id: string
  project_id: string
  chapter_sequence: number
  synopsis_path: string
  title: string
  last_agent_digest: string | null
  turn_bootstrap_input: string | null
  status: "active" | "completed"
  created_at_ms: Timestamp
  updated_at_ms: Timestamp
}

export type SynopsisConversationMessageRow = {
  id: string
  project_id: string
  session_id: string
  role: "user" | "assistant" | "system"
  content_text: string
  choices_json: string | null
  created_at_ms: Timestamp
}

export type ChapterSynopsisRow = {
  chapter_id: string
  project_id: string
  chapter_sequence: number
  chapter_path: string
  synopsis_markdown: string
  source: "synopsis_file" | "conversation" | "turn_input"
  original_synopsis_path: string | null
  turn_bootstrap_input: string | null
  linked_at_ms: Timestamp
}

export type DeductionGoalRow = {
  goal_id: string
  project_id: string
  content: string
  source: "user" | "agent"
  lifecycle: "active" | "completed" | "removed"
  created_at_ms: Timestamp
  updated_at_ms: Timestamp
  completed_at_ms: Timestamp | null
  removed_at_ms: Timestamp | null
  removed_by: "user" | "agent" | null
}

export type DeductionGoalProgressRow = {
  progress_id: string
  project_id: string
  goal_id: string
  chapter_sequence: number
  chapter_id: string | null
  summary: string
  status: "planned" | "achieved" | "partial" | "missed" | "superseded"
  source: "synopsis_discuss" | "turn_review" | "user"
  locked_at_ms: Timestamp | null
  recorded_at_ms: Timestamp
  superseded_by_progress_id: string | null
}

export type DeductionGoalProposalRow = {
  proposal_id: string
  project_id: string
  kind: "create" | "update_content" | "complete" | "remove" | "set_chapter_progress"
  goal_id: string | null
  payload_json: string
  status: "pending" | "approved" | "rejected"
  source_message_id: string | null
  created_at_ms: Timestamp
  resolved_at_ms: Timestamp | null
}

export type SettingsExtractionProposalRow = {
  proposal_id: string
  project_id: string
  task_id: string
  kind: "create" | "update" | "merge"
  payload_json: string
  status: "pending" | "approved" | "rejected"
  phase_run_id: string | null
  reason: string | null
  conflict_notes: string | null
  created_at_ms: Timestamp
  resolved_at_ms: Timestamp | null
}

export type ActiveScopeRefRow = {
  project_id: string
  scope_id: string
}

export type ActiveDocumentHeadRow = {
  project_id: string
  chapter_id: string
  document_version_id: string
  scope_id: string
}

export type WorldBranchRow = {
  id: string
  project_id: string
  parent_branch_id: string | null
  fork_entry_id: string | null
  name: string
  status: "active" | "archived"
  world_head_entry_id: string | null
  history_head_entry_id: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

export type HistoryEntryRow = {
  id: string
  project_id: string
  branch_id: string
  parent_entry_id: string | null
  kind: "automatic" | "manual"
  state: "complete_world" | "paused_checkpoint"
  status: "preparing" | "ready" | "failed"
  name: string
  note: string | null
  operation_id: string
  git_commit_oid: string | null
  manifest_digest: string | null
  committed_sequence: number
  checkpoint_id: string | null
  task_id: string | null
  created_at: Timestamp
  completed_at: NullableTimestamp
}

export type ProjectHistoryStateRow = {
  project_id: string
  active_branch_id: string
  selected_entry_id: string | null
  updated_at: Timestamp
}

export type HistoryFinalizationRow = {
  id: string
  project_id: string
  entry_id: string | null
  operation_id: string
  operation: "save" | "restore" | "retention"
  status: "pending" | "running" | "paused" | "completed" | "failed"
  step: string
  payload_json: JsonText
  error_json: JsonText | null
  created_at: Timestamp
  updated_at: Timestamp
}

export type HistoryRetentionEventRow = {
  id: string
  project_id: string
  entry_id: string
  reason: string
  deleted_at: Timestamp
}

export type TaskRow = {
  id: string
  project_id: string
  kind: string
  status: string
  scope_id: string
  config_snapshot_json: JsonText
  prompt_snapshot_json: JsonText
  last_phase: string | null
  error_json: JsonText | null
  created_at: Timestamp
  updated_at: Timestamp
}

export type TurnBudgetWindowRow = {
  task_id: string
  project_id: string
  metric_id: string
  generation: number
  baseline_value: number
  limit_value: number | null
  started_at: Timestamp
  last_reset_at: NullableTimestamp
  updated_at: Timestamp
}

export type TurnBudgetResetRow = {
  id: string
  project_id: string
  task_id: string
  metric_id: string
  previous_generation: number
  new_generation: number
  previous_current: number
  limit_value: number
  created_at: Timestamp
}

export type TaskCheckpointRow = {
  id: string
  project_id: string
  task_id: string
  phase_run_id: string
  context_id: string
  phase: string
  model_context_chain_id: string
  model_context_sequence: number
  context_json: JsonText
  budget_windows_json: JsonText
  created_at: Timestamp
  updated_at: Timestamp
}

export type TaskCheckpointHeadRow = {
  task_id: string
  project_id: string
  checkpoint_id: string
  updated_at: Timestamp
}

export type OperationEventRow = {
  id: string
  project_id: string
  task_id: string
  sequence_no: number
  event_type: string
  payload_json: JsonText
  created_at: Timestamp
}

export type TurnContextRow = {
  id: string
  project_id: string
  task_id: string
  turn_id: string
  schema_version: number
  ledger_digest: string
  token_usage_json: JsonText
  kv_usage_json: JsonText
  context_json: JsonText
  created_at: Timestamp
  updated_at: Timestamp
}

export type ContextSegmentRow = {
  id: string
  project_id: string
  context_id: string
  sequence_no: number
  kind: string
  owner_ids_json: JsonText
  content_ref: string
  digest: string
  token_estimate: number
  created_at: Timestamp
}

export type PhaseRunRow = {
  id: string
  project_id: string
  task_id: string
  context_id: string
  phase: string
  attempt: number
  status: string
  request_json: JsonText
  result_json: JsonText | null
  usage_json: JsonText
  started_at: Timestamp
  finished_at: NullableTimestamp
}

export type VerificationProbeExecutionRow = {
  project_id: string
  task_id: string
  phase_run_id: string
  probe_index: number
  plan_digest: string
  request_id: string
  payload_json: JsonText
  digest: string
  created_at: Timestamp
}

export type KvUsageRow = {
  id: string
  project_id: string
  task_id: string
  turn_id: string
  phase_run_id: string
  total_input_tokens: number
  cache_hit_input_tokens: number | null
  cache_miss_input_tokens: number | null
  output_tokens: number
  latency_ms: number
  provider: string
  model: string
  created_at: Timestamp
}

export type NodeRow = {
  id: string
  project_id: string
  scope_id: string
  visibility: "pending" | "committed" | "retired"
  content_json: JsonText
  metadata_json: JsonText | null
  source_refs_json: JsonText | null
  revision_id: string
  created_at: Timestamp
}

export type LinkRow = Omit<NodeRow, "content_json"> & {
  from_node_id: string
  to_node_id: string
  content_json: JsonText | null
}

export type NodeHeadRow = {
  project_id: string
  scope_key: string
  source_scope_id: string
  node_id: string
  revision_id: string
  visibility: "pending" | "committed" | "retired"
  effective_at: Timestamp
  digest: string
}

export type LinkHeadRow = Omit<NodeHeadRow, "node_id"> & {
  link_id: string
}

export type GraphRevisionRow = {
  id: string
  project_id: string
  scope_id: string
  target_kind: "node" | "link"
  target_id: string
  operation: "create" | "edit" | "retire"
  before_json: JsonText | null
  after_json: JsonText | null
  reason: string
  self_review: string
  predecessor_revision_id: string | null
  archive_outlet_ids_json: JsonText
  evidence_ids_json: JsonText
  created_at: Timestamp
}

export type DocumentVersionRow = {
  id: string
  project_id: string
  scope_id: string
  source_id: string
  chapter_id: string
  visibility: "pending" | "committed" | "retired"
  content_ref: string
  heading: string
  publish_path: string
  digest: string
  predecessor_source_id: string | null
  created_at: Timestamp
}

export type SourceUnitRow = {
  id: string
  project_id: string
  source_id: string
  sequence_no: number
  content_ref: string
  digest: string
  created_at: Timestamp
}

export type SettlementRecordRow = {
  id: string
  project_id: string
  scope_id: string
  source_unit_id: string
  graph_refs_json: JsonText
  reason: string
  status: string
  digest: string
  created_at: Timestamp
}

export type SceneSpacetimeBindingRow = {
  id: string
  project_id: string
  scope_id: string
  source_id: string | null
  scene_index: number
  scene_anchor_id: string
  source_unit_indexes_json: JsonText
  temporal_reference_refs_json: JsonText
  time_anchor_refs_json: JsonText
  spatial_reference_refs_json: JsonText
  location_anchor_refs_json: JsonText
  predecessor_scene_indexes_json: JsonText
  predecessor_scene_refs_json: JsonText
  transition_path_refs_json: JsonText
  correspondence_refs_json: JsonText
  reason: string
  self_review: string
  visibility: "pending" | "committed" | "retired"
  digest: string
  created_at: Timestamp
}

export type GraphRevisionSpacetimeRow = {
  id: string
  project_id: string
  scope_id: string
  graph_revision_id: string
  effect_disposition: "world_effect" | "representation_only"
  effective_scene_binding_ids_json: JsonText
  effective_existing_scene_refs_json: JsonText
  current_entry_refs_json: JsonText
  predecessor_revision_required: number
  predecessor_revision_ids_json: JsonText
  historical_return_refs_json: JsonText
  reason: string
  self_review: string
  visibility: "pending" | "committed" | "retired"
  digest: string
  created_at: Timestamp
}

export type RetrievalProjectionRow = {
  id: string
  project_id: string
  scope_id: string
  owner_kind: string
  owner_id: string
  owner_revision_id: string
  visibility: "pending" | "committed" | "retired"
  exact_keys_json: JsonText
  semantic_text: string
  source_refs_json: JsonText
  digest: string
}

export type RetrievalExactKeyRow = {
  project_id: string
  projection_id: string
  exact_key: string
  owner_id: string
}

export type RetrievalFtsRow = {
  rowid: ColumnType<number, never, never>
  projection_id: string
  project_id: string
  scope_id: string
  visibility: string
  semantic_text: string
}

export type RuleSnapshotRow = {
  id: string
  project_id: string
  task_id: string
  base_rule_version: string
  source_versions_json: JsonText
  selection_reasons_json: JsonText
  digest: string
  created_at: Timestamp
}

export type AiDecisionRecordRow = {
  id: string
  project_id: string
  task_id: string
  scope_id: string
  phase_run_id: string
  decision_kind: string
  reason: string
  evidence_ids_json: JsonText
  payload_json: JsonText
  digest: string
  created_at: Timestamp
}

export type FrontierRefRow = {
  id: string
  project_id: string
  scope_id: string
  frontier_anchor_ref: string
  disposition: "active" | "deferred" | "archived"
  last_scene_anchor_refs_json: JsonText
  last_time_anchor_refs_json: JsonText
  last_location_anchor_refs_json: JsonText
  correspondence_refs_json: JsonText
  last_processed_at: Timestamp
  reason: string
  revisit_condition: string | null
}

export type WorkspaceCatalogSnapshotRow = {
  id: string
  project_id: string
  generated_at: Timestamp
  digest: string
  entries_json: JsonText
}

export type TaskWorkspaceCatalogSnapshotRow = {
  task_id: string
  snapshot_id: string
  attached_at: Timestamp
}

export type EvidenceObjectRow = {
  id: string
  project_id: string
  context_id: string | null
  source_kind: "workspace" | "graph" | "revision" | "chapter"
  owner_id: string
  version: string
  digest: string
  locator: string
  content_ref: string
  read_reason: string
  created_at: Timestamp
}

export type ProjectDatabase = {
  schema_migrations: SchemaMigrationRow
  projects: ProjectRow
  project_manifests: ProjectManifestRow
  project_settings: ProjectSettingsRow
  id_counters: IdCounterRow
  workspace_operations: WorkspaceOperationRow
  artifact_scopes: ArtifactScopeRow
  turn_finalizations: TurnFinalizationRow
  canonical_chapter_messages: CanonicalChapterMessageRow
  chapter_revision_tasks: ChapterRevisionTaskRow
  chapter_revision_reviews: ChapterRevisionReviewRow
  chapter_revision_decisions: ChapterRevisionDecisionRow
  chapter_revision_finalizations: ChapterRevisionFinalizationRow
  chapter_index: ChapterIndexRow
  chapter_lineage_snapshots: ChapterLineageSnapshotRow
  revision_conversation_messages: RevisionConversationMessageRow
  synopsis_conversation_sessions: SynopsisConversationSessionRow
  synopsis_conversation_messages: SynopsisConversationMessageRow
  chapter_synopsis: ChapterSynopsisRow
  deduction_goals: DeductionGoalRow
  deduction_goal_progress: DeductionGoalProgressRow
  deduction_goal_proposals: DeductionGoalProposalRow
  settings_extraction_proposals: SettingsExtractionProposalRow
  model_context_chains: ModelContextChainRow
  model_context_messages: ModelContextMessageRow
  active_scope_refs: ActiveScopeRefRow
  active_document_heads: ActiveDocumentHeadRow
  world_branches: WorldBranchRow
  history_entries: HistoryEntryRow
  project_history_state: ProjectHistoryStateRow
  history_finalizations: HistoryFinalizationRow
  history_retention_events: HistoryRetentionEventRow
  tasks: TaskRow
  turn_budget_windows: TurnBudgetWindowRow
  turn_budget_resets: TurnBudgetResetRow
  task_checkpoints: TaskCheckpointRow
  task_checkpoint_heads: TaskCheckpointHeadRow
  operation_events: OperationEventRow
  turn_contexts: TurnContextRow
  context_segments: ContextSegmentRow
  phase_runs: PhaseRunRow
  verification_probe_executions: VerificationProbeExecutionRow
  kv_usage: KvUsageRow
  nodes: NodeRow
  links: LinkRow
  node_heads: NodeHeadRow
  link_heads: LinkHeadRow
  graph_revisions: GraphRevisionRow
  document_versions: DocumentVersionRow
  source_units: SourceUnitRow
  settlement_records: SettlementRecordRow
  scene_spacetime_bindings: SceneSpacetimeBindingRow
  graph_revision_spacetime: GraphRevisionSpacetimeRow
  retrieval_projections: RetrievalProjectionRow
  retrieval_exact_keys: RetrievalExactKeyRow
  retrieval_fts: RetrievalFtsRow
  rule_snapshots: RuleSnapshotRow
  ai_decision_records: AiDecisionRecordRow
  frontier_refs: FrontierRefRow
  workspace_catalog_snapshots: WorkspaceCatalogSnapshotRow
  task_workspace_catalog_snapshots: TaskWorkspaceCatalogSnapshotRow
  evidence_objects: EvidenceObjectRow
}
