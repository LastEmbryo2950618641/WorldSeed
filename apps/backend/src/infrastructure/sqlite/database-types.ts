import type { ColumnType } from "kysely"

type JsonText = string
type Timestamp = number
type NullableTimestamp = number | null

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

export type RegistryDatabase = {
  schema_migrations: SchemaMigrationRow
  registered_projects: RegisteredProjectRow
}

export type ProjectRow = {
  id: string
  name: string
  manifest_version: number
  committed_sequence: number
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
  reason: string
  created_at: Timestamp
  retired_at: NullableTimestamp
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
  settlement_status: string
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
  anchor_id: string
  last_effective_time: Timestamp
  deferral_count: number
  next_attempt_at: Timestamp
  status: string
  payload_json: JsonText
}

export type ProjectDatabase = {
  schema_migrations: SchemaMigrationRow
  projects: ProjectRow
  project_manifests: ProjectManifestRow
  workspace_operations: WorkspaceOperationRow
  artifact_scopes: ArtifactScopeRow
  tasks: TaskRow
  operation_events: OperationEventRow
  turn_contexts: TurnContextRow
  context_segments: ContextSegmentRow
  phase_runs: PhaseRunRow
  kv_usage: KvUsageRow
  nodes: NodeRow
  links: LinkRow
  node_heads: NodeHeadRow
  link_heads: LinkHeadRow
  graph_revisions: GraphRevisionRow
  document_versions: DocumentVersionRow
  source_units: SourceUnitRow
  settlement_records: SettlementRecordRow
  retrieval_projections: RetrievalProjectionRow
  retrieval_exact_keys: RetrievalExactKeyRow
  retrieval_fts: RetrievalFtsRow
  rule_snapshots: RuleSnapshotRow
  ai_decision_records: AiDecisionRecordRow
  frontier_refs: FrontierRefRow
}
