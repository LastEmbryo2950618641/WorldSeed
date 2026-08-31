import type { ProjectDatabase } from "../database-types.js"
import { defineSqlMigration } from "./migration-definition.js"

export const projectMigrations = Object.freeze([
  defineSqlMigration<ProjectDatabase>(1, "001_project_workspace", [
    `CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      digest TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`,
    `CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      manifest_version INTEGER NOT NULL,
      committed_sequence INTEGER NOT NULL DEFAULT 0 CHECK (committed_sequence >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE project_manifests (
      project_id TEXT PRIMARY KEY REFERENCES projects(id),
      schema_version INTEGER NOT NULL,
      fixed_entries_json TEXT NOT NULL,
      digest TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE workspace_operations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL,
      path_json TEXT NOT NULL,
      status TEXT NOT NULL,
      progress_json TEXT NOT NULL,
      error_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    "CREATE INDEX workspace_operations_project_status ON workspace_operations(project_id, status)",
  ]),
  defineSqlMigration<ProjectDatabase>(2, "002_scopes_tasks_events", [
    `CREATE TABLE artifact_scopes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('pending', 'committed', 'retired')),
      base_committed_sequence INTEGER NOT NULL CHECK (base_committed_sequence >= 0),
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      retired_at INTEGER,
      FOREIGN KEY (task_id) REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED
    )`,
    `CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      scope_id TEXT NOT NULL UNIQUE,
      config_snapshot_json TEXT NOT NULL,
      prompt_snapshot_json TEXT NOT NULL,
      last_phase TEXT,
      error_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (scope_id) REFERENCES artifact_scopes(id) DEFERRABLE INITIALLY DEFERRED
    )`,
    `CREATE TABLE operation_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0),
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(task_id, sequence_no)
    )`,
    "CREATE INDEX artifact_scopes_project_visibility ON artifact_scopes(project_id, visibility)",
    "CREATE INDEX artifact_scopes_task_id ON artifact_scopes(task_id, id)",
    "CREATE INDEX tasks_project_status ON tasks(project_id, status)",
  ]),
  defineSqlMigration<ProjectDatabase>(3, "003_context_phase_usage", [
    `CREATE TABLE turn_contexts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      turn_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      ledger_digest TEXT NOT NULL,
      token_usage_json TEXT NOT NULL,
      kv_usage_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(task_id, turn_id)
    )`,
    `CREATE TABLE context_segments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      context_id TEXT NOT NULL REFERENCES turn_contexts(id),
      sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0),
      kind TEXT NOT NULL,
      owner_ids_json TEXT NOT NULL,
      content_ref TEXT NOT NULL,
      digest TEXT NOT NULL,
      token_estimate INTEGER NOT NULL CHECK (token_estimate >= 0),
      created_at INTEGER NOT NULL,
      UNIQUE(context_id, sequence_no)
    )`,
    `CREATE TABLE phase_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      context_id TEXT NOT NULL REFERENCES turn_contexts(id),
      phase TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      status TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT,
      usage_json TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      UNIQUE(task_id, phase, attempt)
    )`,
    `CREATE TABLE kv_usage (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      turn_id TEXT NOT NULL,
      phase_run_id TEXT NOT NULL REFERENCES phase_runs(id),
      total_input_tokens INTEGER NOT NULL CHECK (total_input_tokens >= 0),
      cache_hit_input_tokens INTEGER CHECK (cache_hit_input_tokens >= 0),
      cache_miss_input_tokens INTEGER CHECK (cache_miss_input_tokens >= 0),
      output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
      latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(task_id, phase_run_id)
    )`,
  ]),
  defineSqlMigration<ProjectDatabase>(4, "004_graph_revisions", [
    `CREATE TABLE nodes (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
      visibility TEXT NOT NULL CHECK (visibility IN ('pending', 'committed', 'retired')),
      content_json TEXT NOT NULL,
      metadata_json TEXT,
      source_refs_json TEXT,
      revision_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(project_id, id, revision_id)
    )`,
    `CREATE TABLE links (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
      visibility TEXT NOT NULL CHECK (visibility IN ('pending', 'committed', 'retired')),
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      content_json TEXT,
      metadata_json TEXT,
      source_refs_json TEXT,
      revision_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(project_id, id, revision_id)
    )`,
    `CREATE TABLE node_heads (
      project_id TEXT NOT NULL REFERENCES projects(id),
      scope_key TEXT NOT NULL CHECK (length(scope_key) > 0),
      source_scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
      node_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('pending', 'committed', 'retired')),
      effective_at INTEGER NOT NULL,
      digest TEXT NOT NULL,
      UNIQUE(project_id, scope_key, node_id)
    )`,
    `CREATE TABLE link_heads (
      project_id TEXT NOT NULL REFERENCES projects(id),
      scope_key TEXT NOT NULL CHECK (length(scope_key) > 0),
      source_scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
      link_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('pending', 'committed', 'retired')),
      effective_at INTEGER NOT NULL,
      digest TEXT NOT NULL,
      UNIQUE(project_id, scope_key, link_id)
    )`,
    `CREATE TABLE graph_revisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
      target_kind TEXT NOT NULL CHECK (target_kind IN ('node', 'link')),
      target_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('create', 'edit', 'retire')),
      before_json TEXT,
      after_json TEXT,
      reason TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    "CREATE INDEX nodes_project_scope_visibility ON nodes(project_id, scope_id, visibility)",
    "CREATE INDEX links_project_scope_visibility ON links(project_id, scope_id, visibility)",
    "CREATE INDEX links_project_from_node ON links(project_id, from_node_id)",
    "CREATE INDEX links_project_to_node ON links(project_id, to_node_id)",
    "CREATE INDEX graph_revisions_target_history ON graph_revisions(project_id, target_kind, target_id, created_at)",
  ]),
  defineSqlMigration<ProjectDatabase>(5, "005_documents_settlement", [
    `CREATE TABLE document_versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
      source_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('pending', 'committed', 'retired')),
      content_ref TEXT NOT NULL,
      heading TEXT NOT NULL,
      publish_path TEXT NOT NULL,
      digest TEXT NOT NULL,
      predecessor_source_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(project_id, source_id)
    )`,
    `CREATE TABLE source_units (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      source_id TEXT NOT NULL,
      sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0),
      content_ref TEXT NOT NULL,
      digest TEXT NOT NULL,
      settlement_status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(source_id, sequence_no)
    )`,
    `CREATE TABLE settlement_records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
      source_unit_id TEXT NOT NULL REFERENCES source_units(id),
      graph_refs_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      digest TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(scope_id, source_unit_id)
    )`,
    "CREATE INDEX document_versions_chapter_visibility ON document_versions(project_id, chapter_id, visibility)",
  ]),
  defineSqlMigration<ProjectDatabase>(6, "006_retrieval_indexes", [
    `CREATE TABLE retrieval_projections (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      owner_revision_id TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('pending', 'committed', 'retired')),
      exact_keys_json TEXT NOT NULL,
      semantic_text TEXT NOT NULL,
      source_refs_json TEXT NOT NULL,
      digest TEXT NOT NULL,
      UNIQUE(project_id, scope_id, owner_kind, owner_id, owner_revision_id, visibility)
    )`,
    `CREATE TABLE retrieval_exact_keys (
      project_id TEXT NOT NULL REFERENCES projects(id),
      projection_id TEXT NOT NULL REFERENCES retrieval_projections(id),
      exact_key TEXT NOT NULL,
      owner_id TEXT NOT NULL
    )`,
    "CREATE INDEX retrieval_exact_keys_lookup ON retrieval_exact_keys(project_id, exact_key)",
    `CREATE VIRTUAL TABLE retrieval_fts USING fts5(
      projection_id UNINDEXED,
      project_id UNINDEXED,
      scope_id UNINDEXED,
      visibility UNINDEXED,
      semantic_text,
      tokenize = 'unicode61'
    )`,
  ]),
  defineSqlMigration<ProjectDatabase>(7, "007_rules_decisions_frontiers", [
    `CREATE TABLE rule_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      base_rule_version TEXT NOT NULL,
      source_versions_json TEXT NOT NULL,
      selection_reasons_json TEXT NOT NULL,
      digest TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(project_id, digest)
    )`,
    `CREATE TABLE ai_decision_records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
      phase_run_id TEXT NOT NULL REFERENCES phase_runs(id),
      decision_kind TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      digest TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE frontier_refs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
      anchor_id TEXT NOT NULL,
      last_effective_time INTEGER NOT NULL,
      deferral_count INTEGER NOT NULL CHECK (deferral_count >= 0),
      next_attempt_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )`,
    "CREATE INDEX ai_decision_records_scope_kind ON ai_decision_records(scope_id, decision_kind)",
    "CREATE INDEX frontier_refs_schedule ON frontier_refs(project_id, status, next_attempt_at)",
  ]),
  defineSqlMigration<ProjectDatabase>(8, "008_turn_context_snapshot", [
    "ALTER TABLE turn_contexts ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}'",
  ]),
  defineSqlMigration<ProjectDatabase>(9, "009_graph_revision_audit_fields", [
    "ALTER TABLE graph_revisions ADD COLUMN self_review TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE graph_revisions ADD COLUMN predecessor_revision_id TEXT",
    "ALTER TABLE graph_revisions ADD COLUMN archive_outlet_ids_json TEXT NOT NULL DEFAULT '[]'",
  ]),
  defineSqlMigration<ProjectDatabase>(10, "010_retrieval_trigram_fts", [
    "DROP TABLE retrieval_fts",
    `CREATE VIRTUAL TABLE retrieval_fts USING fts5(
      projection_id UNINDEXED,
      project_id UNINDEXED,
      scope_id UNINDEXED,
      visibility UNINDEXED,
      semantic_text,
      tokenize = 'trigram'
    )`,
    `INSERT INTO retrieval_fts(projection_id, project_id, scope_id, visibility, semantic_text)
      SELECT id, project_id, scope_id, visibility, semantic_text FROM retrieval_projections`,
  ]),
  defineSqlMigration<ProjectDatabase>(11, "011_catalog_snapshots_and_evidence", [
    `CREATE TABLE workspace_catalog_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      generated_at INTEGER NOT NULL,
      digest TEXT NOT NULL,
      entries_json TEXT NOT NULL
    )`,
    `CREATE TABLE task_workspace_catalog_snapshots (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id),
      snapshot_id TEXT NOT NULL REFERENCES workspace_catalog_snapshots(id),
      attached_at INTEGER NOT NULL
    )`,
    `CREATE TABLE evidence_objects (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      context_id TEXT,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('workspace', 'graph', 'revision', 'chapter')),
      owner_id TEXT NOT NULL,
      version TEXT NOT NULL,
      digest TEXT NOT NULL,
      locator TEXT NOT NULL,
      content_ref TEXT NOT NULL,
      read_reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    "CREATE INDEX workspace_catalog_snapshots_project ON workspace_catalog_snapshots(project_id, generated_at)",
    "CREATE INDEX evidence_objects_context ON evidence_objects(project_id, context_id, created_at)",
    "CREATE INDEX evidence_objects_source_version ON evidence_objects(project_id, source_kind, owner_id, version)",
  ]),
  defineSqlMigration<ProjectDatabase>(12, "012_project_settings", [
    `CREATE TABLE project_settings (
      project_id TEXT PRIMARY KEY REFERENCES projects(id),
      settings_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  ]),
  defineSqlMigration<ProjectDatabase>(13, "013_spacetime_records_and_frontier_refs", [
    `CREATE TABLE scene_spacetime_bindings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
      source_id TEXT,
      scene_index INTEGER NOT NULL CHECK (scene_index >= 0),
      scene_anchor_id TEXT NOT NULL,
      source_unit_indexes_json TEXT NOT NULL,
      temporal_reference_refs_json TEXT NOT NULL,
      time_anchor_refs_json TEXT NOT NULL,
      spatial_reference_refs_json TEXT NOT NULL,
      location_anchor_refs_json TEXT NOT NULL,
      predecessor_scene_indexes_json TEXT NOT NULL,
      predecessor_scene_refs_json TEXT NOT NULL,
      transition_path_refs_json TEXT NOT NULL,
      correspondence_refs_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      self_review TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('pending', 'committed', 'retired')),
      digest TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(scope_id, scene_index)
    )`,
    "CREATE INDEX scene_spacetime_bindings_anchor ON scene_spacetime_bindings(scope_id, scene_anchor_id)",
    "CREATE INDEX scene_spacetime_bindings_visibility ON scene_spacetime_bindings(project_id, visibility)",
    `CREATE TABLE graph_revision_spacetime (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
      graph_revision_id TEXT NOT NULL REFERENCES graph_revisions(id),
      effect_disposition TEXT NOT NULL CHECK (effect_disposition IN ('world_effect', 'representation_only')),
      effective_scene_binding_ids_json TEXT NOT NULL,
      effective_existing_scene_refs_json TEXT NOT NULL,
      current_entry_refs_json TEXT NOT NULL,
      predecessor_revision_required INTEGER NOT NULL CHECK (predecessor_revision_required IN (0, 1)),
      predecessor_revision_ids_json TEXT NOT NULL,
      historical_return_refs_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      self_review TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('pending', 'committed', 'retired')),
      digest TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(scope_id, graph_revision_id)
    )`,
    "CREATE INDEX graph_revision_spacetime_visibility ON graph_revision_spacetime(project_id, visibility)",
    "ALTER TABLE frontier_refs RENAME TO frontier_refs_legacy",
    `CREATE TABLE frontier_refs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
      frontier_anchor_ref TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN ('active', 'deferred', 'archived')),
      last_scene_anchor_refs_json TEXT NOT NULL,
      last_time_anchor_refs_json TEXT NOT NULL,
      last_location_anchor_refs_json TEXT NOT NULL,
      correspondence_refs_json TEXT NOT NULL,
      last_processed_at INTEGER NOT NULL,
      reason TEXT NOT NULL,
      revisit_condition TEXT
    )`,
    `INSERT INTO frontier_refs (
      id, project_id, scope_id, frontier_anchor_ref, disposition,
      last_scene_anchor_refs_json, last_time_anchor_refs_json,
      last_location_anchor_refs_json, correspondence_refs_json,
      last_processed_at, reason, revisit_condition
    ) SELECT id, project_id, scope_id, anchor_id, 'archived',
      '[]', '[]', '[]', '[]', next_attempt_at,
      'Legacy frontier archived during spacetime protocol migration', NULL
      FROM frontier_refs_legacy`,
    "DROP TABLE frontier_refs_legacy",
    "CREATE INDEX frontier_refs_schedule ON frontier_refs(project_id, disposition, last_processed_at)",
  ]),
  defineSqlMigration<ProjectDatabase>(14, "014_turn_finalization", [
    "ALTER TABLE artifact_scopes ADD COLUMN committed_sequence INTEGER CHECK (committed_sequence >= 0)",
    `CREATE TABLE turn_finalizations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
      turn_id TEXT NOT NULL,
      scope_id TEXT NOT NULL UNIQUE REFERENCES artifact_scopes(id),
      context_id TEXT NOT NULL REFERENCES turn_contexts(id),
      source_id TEXT NOT NULL,
      chapter_sequence INTEGER NOT NULL CHECK (chapter_sequence >= 1),
      chapter_path TEXT NOT NULL,
      chapter_heading TEXT NOT NULL,
      content_ref TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      canonical_message_id TEXT NOT NULL UNIQUE,
      graph_anchor_ids_json TEXT NOT NULL,
      model_calls INTEGER NOT NULL CHECK (model_calls >= 0),
      input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
      output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
      model_provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      kv_cache_hit_rate REAL CHECK (kv_cache_hit_rate >= 0 AND kv_cache_hit_rate <= 1),
      status TEXT NOT NULL CHECK (status IN ('prepared', 'scope_committed', 'chapter_published', 'chapter_registered', 'completed')),
      committed_sequence INTEGER,
      error_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE canonical_chapter_messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
      turn_id TEXT NOT NULL,
      context_id TEXT NOT NULL REFERENCES turn_contexts(id),
      source_id TEXT NOT NULL UNIQUE,
      chapter_sequence INTEGER NOT NULL CHECK (chapter_sequence >= 1),
      chapter_path TEXT NOT NULL,
      chapter_heading TEXT NOT NULL,
      content_ref TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    "CREATE INDEX turn_finalizations_project_status ON turn_finalizations(project_id, status, updated_at)",
    "CREATE INDEX canonical_chapter_messages_project_sequence ON canonical_chapter_messages(project_id, chapter_sequence)",
  ]),
  defineSqlMigration<ProjectDatabase>(15, "015_model_context_chain", [
    "ALTER TABLE turn_finalizations ADD COLUMN content_token_estimate INTEGER NOT NULL DEFAULT 0 CHECK (content_token_estimate >= 0)",
    `CREATE TABLE model_context_chains (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
      protocol_version TEXT NOT NULL,
      system_rules_digest TEXT NOT NULL,
      message_count INTEGER NOT NULL CHECK (message_count >= 0),
      token_estimate INTEGER NOT NULL CHECK (token_estimate >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE model_context_messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      chain_id TEXT NOT NULL REFERENCES model_context_chains(id),
      sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0),
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
      kind TEXT NOT NULL,
      task_id TEXT,
      turn_id TEXT,
      phase TEXT,
      content_text TEXT,
      content_ref TEXT,
      content_digest TEXT NOT NULL,
      token_estimate INTEGER NOT NULL CHECK (token_estimate >= 0),
      origin_phase_run_id TEXT REFERENCES phase_runs(id),
      origin_index INTEGER,
      created_at INTEGER NOT NULL,
      CHECK ((content_text IS NULL) <> (content_ref IS NULL)),
      CHECK ((origin_phase_run_id IS NULL) = (origin_index IS NULL)),
      UNIQUE(chain_id, sequence_no),
      UNIQUE(origin_phase_run_id, origin_index)
    )`,
    "CREATE INDEX model_context_messages_chain_sequence ON model_context_messages(chain_id, sequence_no)",
    "CREATE INDEX model_context_messages_project_kind ON model_context_messages(project_id, kind, sequence_no)",
  ]),
  defineSqlMigration<ProjectDatabase>(16, "016_project_id_counters", [
    `CREATE TABLE id_counters (
      project_id TEXT NOT NULL REFERENCES projects(id),
      prefix TEXT NOT NULL CHECK (prefix IN ('node', 'link', 'evidence', 'source', 'revision')),
      current_value INTEGER NOT NULL CHECK (current_value >= 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, prefix)
    )`,
  ]),
  defineSqlMigration<ProjectDatabase>(17, "017_model_context_visibility", [
    "ALTER TABLE model_context_messages ADD COLUMN hidden_at INTEGER",
    "CREATE INDEX model_context_messages_visible_chain_sequence ON model_context_messages(chain_id, sequence_no) WHERE hidden_at IS NULL",
  ]),
  defineSqlMigration<ProjectDatabase>(18, "018_world_history_foundation", [
    "ALTER TABLE projects ADD COLUMN active_generation INTEGER NOT NULL DEFAULT 0 CHECK (active_generation >= 0)",
    "ALTER TABLE artifact_scopes ADD COLUMN base_generation INTEGER NOT NULL DEFAULT 0 CHECK (base_generation >= 0)",
    `CREATE TABLE active_scope_refs (
      project_id TEXT NOT NULL REFERENCES projects(id),
      scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
      PRIMARY KEY (project_id, scope_id)
    )`,
    `INSERT INTO active_scope_refs(project_id, scope_id)
      SELECT project_id, id FROM artifact_scopes WHERE visibility = 'committed'`,
    `CREATE TABLE active_document_heads (
      project_id TEXT NOT NULL REFERENCES projects(id),
      chapter_id TEXT NOT NULL,
      document_version_id TEXT NOT NULL REFERENCES document_versions(id),
      scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
      PRIMARY KEY (project_id, chapter_id)
    )`,
    `INSERT INTO active_document_heads(project_id, chapter_id, document_version_id, scope_id)
      SELECT current.project_id, current.chapter_id, current.id, current.scope_id
      FROM document_versions current
      WHERE current.visibility = 'committed'
        AND current.id = (
          SELECT candidate.id FROM document_versions candidate
          WHERE candidate.project_id = current.project_id
            AND candidate.chapter_id = current.chapter_id
            AND candidate.visibility = 'committed'
          ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1
        )`,
    `CREATE TABLE world_branches (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      parent_branch_id TEXT REFERENCES world_branches(id),
      fork_entry_id TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      world_head_entry_id TEXT,
      history_head_entry_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE history_entries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      branch_id TEXT NOT NULL REFERENCES world_branches(id),
      parent_entry_id TEXT REFERENCES history_entries(id),
      kind TEXT NOT NULL CHECK (kind IN ('automatic', 'manual')),
      state TEXT NOT NULL CHECK (state IN ('complete_world', 'paused_checkpoint')),
      status TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'failed')),
      name TEXT NOT NULL,
      note TEXT,
      operation_id TEXT NOT NULL,
      git_commit_oid TEXT,
      manifest_digest TEXT,
      committed_sequence INTEGER NOT NULL CHECK (committed_sequence >= 0),
      checkpoint_id TEXT,
      task_id TEXT REFERENCES tasks(id),
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(project_id, operation_id)
    )`,
    `CREATE TABLE project_history_state (
      project_id TEXT PRIMARY KEY REFERENCES projects(id),
      active_branch_id TEXT NOT NULL REFERENCES world_branches(id),
      selected_entry_id TEXT REFERENCES history_entries(id),
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE history_finalizations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      entry_id TEXT REFERENCES history_entries(id),
      operation_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('save', 'restore', 'retention')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed')),
      step TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      error_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_id, operation_id)
    )`,
    `CREATE TABLE history_retention_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      entry_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      deleted_at INTEGER NOT NULL
    )`,
    "CREATE INDEX active_scope_refs_scope ON active_scope_refs(scope_id, project_id)",
    "CREATE INDEX history_entries_project_created ON history_entries(project_id, created_at DESC, id DESC)",
    "CREATE INDEX history_entries_branch_created ON history_entries(branch_id, created_at DESC, id DESC)",
    "CREATE INDEX history_finalizations_project_status ON history_finalizations(project_id, status, updated_at)",
  ]),
  defineSqlMigration<ProjectDatabase>(19, "019_verification_probe_checkpoints", [
    `CREATE TABLE verification_probe_executions (
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      phase_run_id TEXT NOT NULL REFERENCES phase_runs(id),
      probe_index INTEGER NOT NULL CHECK (probe_index >= 0),
      plan_digest TEXT NOT NULL,
      request_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      digest TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, probe_index),
      UNIQUE (task_id, plan_digest)
    )`,
    "CREATE INDEX verification_probe_executions_phase_run ON verification_probe_executions(phase_run_id, probe_index)",
  ]),
  defineSqlMigration<ProjectDatabase>(20, "020_verification_probe_generations", [
    "DROP INDEX verification_probe_executions_phase_run",
    "ALTER TABLE verification_probe_executions RENAME TO verification_probe_executions_v19",
    `CREATE TABLE verification_probe_executions (
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      phase_run_id TEXT NOT NULL REFERENCES phase_runs(id),
      probe_index INTEGER NOT NULL CHECK (probe_index >= 0),
      plan_digest TEXT NOT NULL,
      request_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      digest TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, phase_run_id, probe_index),
      UNIQUE (task_id, phase_run_id, plan_digest)
    )`,
    `INSERT INTO verification_probe_executions(
      project_id, task_id, phase_run_id, probe_index, plan_digest, request_id, payload_json, digest, created_at
    ) SELECT
      project_id, task_id, phase_run_id, probe_index, plan_digest, request_id, payload_json, digest, created_at
    FROM verification_probe_executions_v19`,
    "DROP TABLE verification_probe_executions_v19",
    "CREATE INDEX verification_probe_executions_phase_run ON verification_probe_executions(phase_run_id, probe_index)",
  ]),
  defineSqlMigration<ProjectDatabase>(21, "021_runtime_budget_windows", [
    `CREATE TABLE turn_budget_windows (
      task_id TEXT NOT NULL REFERENCES tasks(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      metric_id TEXT NOT NULL CHECK (metric_id IN ('model_calls', 'input_tokens', 'output_tokens', 'wall_time')),
      generation INTEGER NOT NULL CHECK (generation >= 0),
      baseline_value INTEGER NOT NULL CHECK (baseline_value >= 0),
      limit_value INTEGER CHECK (limit_value > 0),
      started_at INTEGER NOT NULL,
      last_reset_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, metric_id)
    )`,
    `CREATE TABLE turn_budget_resets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      metric_id TEXT NOT NULL CHECK (metric_id IN ('model_calls', 'input_tokens', 'output_tokens', 'wall_time')),
      previous_generation INTEGER NOT NULL CHECK (previous_generation >= 0),
      new_generation INTEGER NOT NULL CHECK (new_generation > previous_generation),
      previous_current INTEGER NOT NULL CHECK (previous_current >= 0),
      limit_value INTEGER NOT NULL CHECK (limit_value > 0),
      created_at INTEGER NOT NULL
    )`,
    "CREATE INDEX turn_budget_resets_task_created ON turn_budget_resets(task_id, created_at, id)",
  ]),
  defineSqlMigration<ProjectDatabase>(22, "022_stable_task_checkpoints", [
    `CREATE TABLE task_checkpoints (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      phase_run_id TEXT NOT NULL UNIQUE REFERENCES phase_runs(id),
      context_id TEXT NOT NULL REFERENCES turn_contexts(id),
      phase TEXT NOT NULL,
      model_context_chain_id TEXT NOT NULL REFERENCES model_context_chains(id),
      model_context_sequence INTEGER NOT NULL CHECK (model_context_sequence >= 0),
      context_json TEXT NOT NULL,
      budget_windows_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE task_checkpoint_heads (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      checkpoint_id TEXT NOT NULL REFERENCES task_checkpoints(id),
      updated_at INTEGER NOT NULL
    )`,
    "CREATE INDEX task_checkpoints_task_created ON task_checkpoints(task_id, created_at, id)",
  ]),
  defineSqlMigration<ProjectDatabase>(23, "023_settlement_records_are_authoritative", [
    "ALTER TABLE source_units DROP COLUMN settlement_status",
  ]),
  defineSqlMigration<ProjectDatabase>(24, "024_chapter_revisions", [
    `CREATE TABLE chapter_revision_tasks (
      id TEXT PRIMARY KEY REFERENCES tasks(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      chapter_id TEXT NOT NULL,
      base_source_id TEXT NOT NULL,
      proposed_source_id TEXT NOT NULL,
      predecessor_source_id TEXT,
      content_ref TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      submission_mode TEXT CHECK (submission_mode IN ('direct', 'reviewed')),
      decision TEXT NOT NULL CHECK (decision IN ('pending', 'submit', 'abandon')),
      review_id TEXT,
      graph_sync_status TEXT NOT NULL CHECK (graph_sync_status IN ('not_started', 'pending', 'running', 'completed', 'failed')),
      status TEXT NOT NULL CHECK (status IN (
        'editing', 'reviewing', 'ready_to_submit', 'committing_content',
        'content_committed', 'chapter_published', 'chapter_registered',
        'graph_sync_pending', 'graph_sync_running', 'completed', 'retired',
        'failed', 'awaiting_user_decision'
      )),
      content_scope_id TEXT REFERENCES artifact_scopes(id),
      graph_sync_scope_id TEXT REFERENCES artifact_scopes(id),
      decision_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    "CREATE INDEX chapter_revision_tasks_project_status ON chapter_revision_tasks(project_id, status, updated_at)",
    "CREATE UNIQUE INDEX chapter_revision_tasks_active_base ON chapter_revision_tasks(project_id, chapter_id, base_source_id) WHERE status NOT IN ('retired', 'completed', 'failed')",
    `CREATE TABLE chapter_revision_reviews (
      id TEXT PRIMARY KEY,
      revision_task_id TEXT NOT NULL REFERENCES chapter_revision_tasks(id),
      proposed_source_id TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      issues_json TEXT NOT NULL,
      recommendation TEXT NOT NULL CHECK (recommendation IN ('no_issue', 'review_suggested', 'material_conflict')),
      created_at INTEGER NOT NULL
    )`,
    "CREATE INDEX chapter_revision_reviews_task_created ON chapter_revision_reviews(revision_task_id, created_at DESC)",
    `CREATE TABLE chapter_revision_decisions (
      id TEXT PRIMARY KEY,
      revision_task_id TEXT NOT NULL REFERENCES chapter_revision_tasks(id),
      proposed_source_id TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('direct', 'reviewed')),
      action TEXT NOT NULL CHECK (action IN ('submit', 'abandon')),
      forced INTEGER NOT NULL CHECK (forced IN (0, 1)),
      reason TEXT NOT NULL CHECK (reason IN ('user_forced_edit', 'user_reviewed_edit')),
      review_id TEXT REFERENCES chapter_revision_reviews(id),
      note TEXT,
      created_at INTEGER NOT NULL
    )`,
    "CREATE INDEX chapter_revision_decisions_task_created ON chapter_revision_decisions(revision_task_id, created_at DESC)",
  ]),
  defineSqlMigration<ProjectDatabase>(25, "025_chapter_revision_base_digest", [
    "ALTER TABLE chapter_revision_tasks ADD COLUMN base_content_digest TEXT NOT NULL DEFAULT ''",
  ]),
  defineSqlMigration<ProjectDatabase>(26, "026_chapter_revision_graph_task", [
    "ALTER TABLE chapter_revision_tasks ADD COLUMN graph_sync_task_id TEXT",
    "CREATE UNIQUE INDEX chapter_revision_tasks_graph_sync_task ON chapter_revision_tasks(graph_sync_task_id) WHERE graph_sync_task_id IS NOT NULL",
  ]),
  defineSqlMigration<ProjectDatabase>(27, "027_chapter_revision_finalizations", [
    `CREATE TABLE chapter_revision_finalizations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      revision_task_id TEXT NOT NULL UNIQUE REFERENCES chapter_revision_tasks(id),
      proposed_source_id TEXT NOT NULL,
      content_scope_id TEXT NOT NULL REFERENCES artifact_scopes(id),
      graph_sync_task_id TEXT,
      content_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'prepared', 'content_committed', 'chapter_published', 'chapter_registered',
        'graph_sync_pending', 'graph_sync_running', 'completed'
      )),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    "CREATE INDEX chapter_revision_finalizations_project_status ON chapter_revision_finalizations(project_id, status, updated_at)",
    "CREATE UNIQUE INDEX chapter_revision_finalizations_graph_task ON chapter_revision_finalizations(graph_sync_task_id) WHERE graph_sync_task_id IS NOT NULL",
  ]),
  defineSqlMigration<ProjectDatabase>(28, "028_chapter_revision_headings", [
    "ALTER TABLE chapter_revision_tasks ADD COLUMN heading TEXT NOT NULL DEFAULT ''",
    "UPDATE chapter_revision_tasks SET heading = COALESCE((SELECT heading FROM document_versions WHERE document_versions.source_id = chapter_revision_tasks.base_source_id ORDER BY document_versions.created_at DESC LIMIT 1), '未命名章节') WHERE heading = ''",
  ]),
  defineSqlMigration<ProjectDatabase>(29, "029_chapter_index_and_context_metadata", [
    `CREATE TABLE chapter_index (
      project_id TEXT NOT NULL REFERENCES projects(id),
      chapter_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      current_source_id TEXT NOT NULL,
      current_publish_path TEXT NOT NULL,
      assigned_at_ms INTEGER NOT NULL,
      PRIMARY KEY (project_id, chapter_id),
      UNIQUE (project_id, sequence)
    )`,
    "CREATE INDEX chapter_index_project_sequence ON chapter_index(project_id, sequence)",
  `CREATE TABLE chapter_lineage_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      chapter_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      prior_chapter_source_ids_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )`,
    "CREATE INDEX chapter_lineage_snapshots_project_chapter ON chapter_lineage_snapshots(project_id, chapter_id, created_at_ms DESC)",
    "ALTER TABLE model_context_messages ADD COLUMN metadata_json TEXT",
    `INSERT INTO chapter_index (project_id, chapter_id, sequence, current_source_id, current_publish_path, assigned_at_ms)
      SELECT
        adh.project_id,
        adh.chapter_id,
        COALESCE((
          SELECT MIN(ccm.chapter_sequence)
          FROM canonical_chapter_messages ccm
          INNER JOIN document_versions dv_ccm
            ON dv_ccm.source_id = ccm.source_id
           AND dv_ccm.project_id = ccm.project_id
           AND dv_ccm.chapter_id = adh.chapter_id
          WHERE ccm.project_id = adh.project_id
        ), 1),
        head_dv.source_id,
        head_dv.publish_path,
        head_dv.created_at
      FROM active_document_heads adh
      INNER JOIN document_versions head_dv ON head_dv.id = adh.document_version_id`,
  ]),
  defineSqlMigration<ProjectDatabase>(30, "030_revision_conversation_messages", [
    "ALTER TABLE chapter_revision_tasks ADD COLUMN input_mode TEXT NOT NULL DEFAULT 'direct' CHECK (input_mode IN ('direct', 'agent'))",
    `CREATE TABLE revision_conversation_messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      revision_task_id TEXT NOT NULL REFERENCES chapter_revision_tasks(id),
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content_text TEXT NOT NULL,
      proposal_json TEXT,
      created_at_ms INTEGER NOT NULL
    )`,
    "CREATE INDEX revision_conversation_messages_revision ON revision_conversation_messages(revision_task_id, created_at_ms)",
  ]),
  defineSqlMigration<ProjectDatabase>(31, "031_synopsis_conversation_and_chapter_synopsis", [
    `CREATE TABLE synopsis_conversation_sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      chapter_sequence INTEGER NOT NULL,
      synopsis_path TEXT NOT NULL,
      title TEXT NOT NULL,
      last_agent_digest TEXT,
      turn_bootstrap_input TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      UNIQUE (project_id, chapter_sequence)
    )`,
    "CREATE INDEX synopsis_conversation_sessions_project ON synopsis_conversation_sessions(project_id, status, updated_at_ms DESC)",
    `CREATE TABLE synopsis_conversation_messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      session_id TEXT NOT NULL REFERENCES synopsis_conversation_sessions(session_id),
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content_text TEXT NOT NULL,
      choices_json TEXT,
      created_at_ms INTEGER NOT NULL
    )`,
    "CREATE INDEX synopsis_conversation_messages_session ON synopsis_conversation_messages(session_id, created_at_ms)",
    `CREATE TABLE chapter_synopsis (
      chapter_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      chapter_sequence INTEGER NOT NULL,
      chapter_path TEXT NOT NULL,
      synopsis_markdown TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('synopsis_file', 'conversation', 'turn_input')),
      original_synopsis_path TEXT,
      turn_bootstrap_input TEXT,
      linked_at_ms INTEGER NOT NULL
    )`,
    "CREATE INDEX chapter_synopsis_project_sequence ON chapter_synopsis(project_id, chapter_sequence)",
  ]),
  defineSqlMigration<ProjectDatabase>(32, "032_deduction_goals", [
    `CREATE TABLE deduction_goals (
      goal_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      content TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('user', 'agent')),
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'completed', 'removed')),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER,
      removed_at_ms INTEGER,
      removed_by TEXT CHECK (removed_by IN ('user', 'agent'))
    )`,
    "CREATE INDEX deduction_goals_project_lifecycle ON deduction_goals(project_id, lifecycle, created_at_ms DESC)",
    `CREATE TABLE deduction_goal_progress (
      progress_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      goal_id TEXT NOT NULL REFERENCES deduction_goals(goal_id),
      chapter_sequence INTEGER NOT NULL,
      chapter_id TEXT,
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('planned', 'achieved', 'partial', 'missed', 'superseded')),
      source TEXT NOT NULL CHECK (source IN ('synopsis_discuss', 'turn_review', 'user')),
      locked_at_ms INTEGER,
      recorded_at_ms INTEGER NOT NULL,
      superseded_by_progress_id TEXT REFERENCES deduction_goal_progress(progress_id)
    )`,
    `CREATE UNIQUE INDEX deduction_goal_progress_current
      ON deduction_goal_progress(project_id, goal_id, chapter_sequence)
      WHERE status != 'superseded'`,
    "CREATE INDEX deduction_goal_progress_chapter ON deduction_goal_progress(project_id, chapter_sequence, status)",
    `CREATE TABLE deduction_goal_proposals (
      proposal_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL CHECK (kind IN ('create', 'update_content', 'complete', 'remove', 'set_chapter_progress')),
      goal_id TEXT REFERENCES deduction_goals(goal_id),
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
      source_message_id TEXT,
      created_at_ms INTEGER NOT NULL,
      resolved_at_ms INTEGER
    )`,
    "CREATE INDEX deduction_goal_proposals_pending ON deduction_goal_proposals(project_id, status, created_at_ms DESC)",
  ]),
  defineSqlMigration<ProjectDatabase>(33, "033_settings_extraction_proposals", [
    `CREATE TABLE settings_extraction_proposals (
      proposal_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('create', 'update', 'merge')),
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
      phase_run_id TEXT,
      reason TEXT,
      conflict_notes TEXT,
      created_at_ms INTEGER NOT NULL,
      resolved_at_ms INTEGER
    )`,
    "CREATE INDEX settings_extraction_proposals_task ON settings_extraction_proposals(task_id, status, created_at_ms ASC)",
    "CREATE INDEX settings_extraction_proposals_pending ON settings_extraction_proposals(project_id, status, created_at_ms DESC)",
  ]),
  defineSqlMigration<ProjectDatabase>(34, "034_evidence_web_source_kind", [
    "DROP INDEX evidence_objects_context",
    "DROP INDEX evidence_objects_source_version",
    "ALTER TABLE evidence_objects RENAME TO evidence_objects_v33",
    `CREATE TABLE evidence_objects (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      context_id TEXT,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('workspace', 'graph', 'revision', 'chapter', 'web')),
      owner_id TEXT NOT NULL,
      version TEXT NOT NULL,
      digest TEXT NOT NULL,
      locator TEXT NOT NULL,
      content_ref TEXT NOT NULL,
      read_reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `INSERT INTO evidence_objects(
      id, project_id, context_id, source_kind, owner_id, version, digest, locator, content_ref, read_reason, created_at
    ) SELECT
      id, project_id, context_id, source_kind, owner_id, version, digest, locator, content_ref, read_reason, created_at
    FROM evidence_objects_v33`,
    "DROP TABLE evidence_objects_v33",
    "CREATE INDEX evidence_objects_context ON evidence_objects(project_id, context_id, created_at)",
    "CREATE INDEX evidence_objects_source_version ON evidence_objects(project_id, source_kind, owner_id, version)",
  ]),
  defineSqlMigration<ProjectDatabase>(35, "035_synopsis_message_reasoning_search", [
    "ALTER TABLE synopsis_conversation_messages ADD COLUMN reasoning_content TEXT",
    "ALTER TABLE synopsis_conversation_messages ADD COLUMN searching_json TEXT",
  ]),
  defineSqlMigration<ProjectDatabase>(36, "036_synopsis_staging_promote", [
    `CREATE TABLE synopsis_staging_promote_proposals (
      proposal_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
      settings_writes_json TEXT NOT NULL,
      goal_proposals_json TEXT,
      reason TEXT,
      source_message_id TEXT,
      created_at_ms INTEGER NOT NULL,
      resolved_at_ms INTEGER
    )`,
    "CREATE INDEX synopsis_staging_promote_pending ON synopsis_staging_promote_proposals(project_id, status, created_at_ms ASC)",
    "CREATE INDEX synopsis_staging_promote_session ON synopsis_staging_promote_proposals(session_id, status, created_at_ms ASC)",
  ]),
  defineSqlMigration<ProjectDatabase>(37, "037_synopsis_message_hidden", [
    "ALTER TABLE synopsis_conversation_messages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0",
  ]),
])
