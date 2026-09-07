-- Munhae Studio Phase 1 fresh-only baseline (SQLite STRICT).
-- Historical project schemas are rejected rather than upgraded in place.
-- Intentionally omitted for Phase 1:
--   import_jobs, import_items, external_mappings
--   export_jobs, export_items, background_jobs, derived_artifacts
--   translation_split_plans, translation_split_plan_parts, translation_split_plan_results
--   ai_token_preflights, translation_quality_checks
-- glossary_entries.term_kind is included (plan.md); schema.md 13.1 omits it.

CREATE TABLE IF NOT EXISTS meta_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE meta_project_state (
  project_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  format_version INTEGER NOT NULL,
  last_compacted_at TEXT,
  integrity_hash TEXT
) STRICT;

CREATE TABLE core_actors (
  id TEXT PRIMARY KEY,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'llm', 'importer', 'system')),
  display_name TEXT NOT NULL,
  subject_uri TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE core_projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT,
  description TEXT,
  default_target_locale TEXT NOT NULL DEFAULT 'ko',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
) STRICT;

CREATE INDEX idx_core_projects_created_by ON core_projects (created_by_actor_id);

CREATE TABLE core_project_settings (
  project_id TEXT PRIMARY KEY REFERENCES core_projects (id),
  active_document_node_id TEXT,
  autosave_interval_ms INTEGER NOT NULL DEFAULT 3000,
  ai_data_policy_json TEXT CHECK (ai_data_policy_json IS NULL OR json_valid(ai_data_policy_json)),
  settings_json TEXT CHECK (settings_json IS NULL OR json_valid(settings_json)),
  lock_version INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE core_translation_policies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_core_translation_policies_project ON core_translation_policies (project_id);

CREATE TABLE core_translation_policy_versions (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES core_translation_policies (id),
  parent_version_id TEXT REFERENCES core_translation_policy_versions (id),
  version_no INTEGER NOT NULL,
  source_language TEXT NOT NULL,
  target_locale TEXT NOT NULL,
  audience TEXT,
  hanja_policy TEXT,
  supplement_policy TEXT,
  uncertainty_policy TEXT,
  style_guide_md TEXT,
  rules_json TEXT CHECK (rules_json IS NULL OR json_valid(rules_json)),
  state TEXT NOT NULL CHECK (state IN ('draft', 'confirmed', 'rejected', 'superseded')),
  content_hash TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_policy_versions_policy ON core_translation_policy_versions (policy_id);
CREATE INDEX idx_policy_versions_parent ON core_translation_policy_versions (parent_version_id);
CREATE INDEX idx_policy_versions_actor ON core_translation_policy_versions (created_by_actor_id);

CREATE TABLE core_translation_policy_heads (
  policy_id TEXT PRIMARY KEY REFERENCES core_translation_policies (id),
  current_version_id TEXT NOT NULL REFERENCES core_translation_policy_versions (id),
  confirmed_version_id TEXT REFERENCES core_translation_policy_versions (id),
  lock_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE persons (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  preferred_name TEXT NOT NULL,
  hanja_name TEXT,
  reading TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json)),
  description_md TEXT,
  date_text TEXT,
  content_hash TEXT NOT NULL,
  lock_version INTEGER NOT NULL DEFAULT 1,
  created_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  updated_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
) STRICT;

CREATE INDEX idx_persons_project ON persons (project_id);
CREATE INDEX idx_persons_project_active ON persons (project_id) WHERE archived_at IS NULL;

CREATE TABLE document_nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  parent_node_id TEXT REFERENCES document_nodes (id),
  node_role TEXT NOT NULL DEFAULT 'container' CHECK (node_role IN ('container', 'source_unit')),
  is_master INTEGER NOT NULL DEFAULT 0 CHECK (is_master IN (0, 1)),
  title TEXT NOT NULL,
  original_title TEXT,
  ordinal INTEGER NOT NULL,
  author_person_id TEXT REFERENCES persons (id),
  language TEXT,
  period_text TEXT,
  date_text TEXT,
  description_md TEXT,
  source_reference TEXT,
  lock_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
) STRICT;

CREATE INDEX idx_document_nodes_project ON document_nodes (project_id);
CREATE INDEX idx_document_nodes_parent ON document_nodes (parent_node_id);
CREATE UNIQUE INDEX uq_document_nodes_parent_ordinal ON document_nodes (project_id, parent_node_id, ordinal) WHERE parent_node_id IS NOT NULL;
CREATE UNIQUE INDEX uq_document_nodes_root_ordinal ON document_nodes (project_id, ordinal) WHERE parent_node_id IS NULL;
CREATE INDEX idx_document_nodes_author ON document_nodes (project_id, author_person_id) WHERE author_person_id IS NOT NULL;
CREATE UNIQUE INDEX uq_document_nodes_project_master ON document_nodes (project_id) WHERE is_master = 1 AND archived_at IS NULL;

CREATE TABLE src_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  asset_kind TEXT NOT NULL,
  original_filename TEXT,
  mime_type TEXT,
  byte_size INTEGER,
  sha256 TEXT,
  width INTEGER,
  height INTEGER,
  page_count INTEGER,
  source_uri TEXT,
  acquired_at TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES core_actors (id)
) STRICT;

CREATE INDEX idx_src_assets_project ON src_assets (project_id);
CREATE INDEX idx_src_assets_actor ON src_assets (created_by_actor_id);

CREATE TABLE src_asset_locations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  asset_id TEXT NOT NULL REFERENCES src_assets (id),
  relative_path TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'present',
  verified_at TEXT
) STRICT;

CREATE INDEX idx_src_asset_locations_project ON src_asset_locations (project_id);
CREATE INDEX idx_src_asset_locations_asset ON src_asset_locations (asset_id);

CREATE TABLE src_asset_pages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  asset_id TEXT NOT NULL REFERENCES src_assets (id),
  page_no INTEGER NOT NULL,
  label TEXT,
  width INTEGER,
  height INTEGER,
  rotation INTEGER NOT NULL DEFAULT 0,
  derivative_asset_id TEXT REFERENCES src_assets (id)
) STRICT;

CREATE INDEX idx_src_asset_pages_project ON src_asset_pages (project_id);
CREATE INDEX idx_src_asset_pages_asset ON src_asset_pages (asset_id);
CREATE INDEX idx_src_asset_pages_derivative ON src_asset_pages (derivative_asset_id);

CREATE TABLE src_node_assets (
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_node_id TEXT NOT NULL REFERENCES document_nodes (id),
  asset_id TEXT NOT NULL REFERENCES src_assets (id),
  role TEXT NOT NULL DEFAULT 'reference',
  page_from INTEGER,
  page_to INTEGER,
  locator_text TEXT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (document_node_id, asset_id, ordinal)
) STRICT;

CREATE INDEX idx_src_node_assets_project ON src_node_assets (project_id);
CREATE INDEX idx_src_node_assets_asset ON src_node_assets (asset_id);
CREATE UNIQUE INDEX uq_src_node_assets ON src_node_assets (document_node_id, asset_id, ordinal);

CREATE TABLE src_texts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_node_id TEXT NOT NULL REFERENCES document_nodes (id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  tombstoned_at TEXT
) STRICT;

CREATE INDEX idx_src_texts_project ON src_texts (project_id);
CREATE INDEX idx_src_texts_node ON src_texts (document_node_id);

CREATE TABLE src_text_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  source_text_id TEXT NOT NULL REFERENCES src_texts (id),
  parent_version_id TEXT REFERENCES src_text_versions (id),
  version_no INTEGER NOT NULL,
  content_text TEXT NOT NULL,
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('manual', 'paste', 'import', 'derived_part')),
  source_asset_id TEXT REFERENCES src_assets (id),
  page_from INTEGER,
  page_to INTEGER,
  locator_text TEXT,
  change_summary TEXT,
  state TEXT NOT NULL CHECK (state IN ('draft', 'confirmed', 'rejected', 'superseded')),
  content_hash TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_src_text_versions_project ON src_text_versions (project_id);
CREATE INDEX idx_src_text_versions_source ON src_text_versions (source_text_id);
CREATE INDEX idx_src_text_versions_parent ON src_text_versions (parent_version_id);
CREATE INDEX idx_src_text_versions_actor ON src_text_versions (created_by_actor_id);
CREATE INDEX idx_src_text_versions_asset ON src_text_versions (source_asset_id);

CREATE TABLE src_text_heads (
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  source_text_id TEXT PRIMARY KEY REFERENCES src_texts (id),
  current_version_id TEXT NOT NULL REFERENCES src_text_versions (id),
  confirmed_version_id TEXT REFERENCES src_text_versions (id),
  lock_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_src_text_heads_project ON src_text_heads (project_id);
CREATE INDEX idx_src_text_heads_current ON src_text_heads (current_version_id);
CREATE INDEX idx_src_text_heads_confirmed ON src_text_heads (confirmed_version_id);

CREATE TABLE punctuation_sets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  source_text_id TEXT NOT NULL REFERENCES src_texts (id),
  name TEXT NOT NULL,
  policy_version_id TEXT REFERENCES core_translation_policy_versions (id),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_punctuation_sets_project ON punctuation_sets (project_id);
CREATE INDEX idx_punctuation_sets_source ON punctuation_sets (source_text_id);
CREATE INDEX idx_punctuation_sets_policy ON punctuation_sets (policy_version_id);

CREATE TABLE punctuation_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  punctuation_set_id TEXT NOT NULL REFERENCES punctuation_sets (id),
  source_text_version_id TEXT NOT NULL REFERENCES src_text_versions (id),
  parent_version_id TEXT REFERENCES punctuation_versions (id),
  version_no INTEGER NOT NULL,
  punctuated_text TEXT NOT NULL,
  structure_json TEXT CHECK (structure_json IS NULL OR json_valid(structure_json)),
  change_summary TEXT,
  state TEXT NOT NULL CHECK (state IN ('draft', 'confirmed', 'rejected', 'superseded')),
  content_hash TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_punctuation_versions_project ON punctuation_versions (project_id);
CREATE INDEX idx_punctuation_versions_set ON punctuation_versions (punctuation_set_id);
CREATE INDEX idx_punctuation_versions_source ON punctuation_versions (source_text_version_id);
CREATE INDEX idx_punctuation_versions_parent ON punctuation_versions (parent_version_id);
CREATE INDEX idx_punctuation_versions_actor ON punctuation_versions (created_by_actor_id);

CREATE TABLE punctuation_structure_spans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  punctuation_version_id TEXT NOT NULL REFERENCES punctuation_versions (id),
  span_kind TEXT NOT NULL,
  parent_span_id TEXT REFERENCES punctuation_structure_spans (id),
  ordinal INTEGER NOT NULL,
  codepoint_from INTEGER NOT NULL,
  codepoint_to INTEGER NOT NULL,
  quote TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('manual', 'rule', 'ai', 'import')),
  confidence REAL,
  label TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_punc_spans_project ON punctuation_structure_spans (project_id);
CREATE INDEX idx_punc_spans_version ON punctuation_structure_spans (punctuation_version_id);
CREATE INDEX idx_punc_spans_parent ON punctuation_structure_spans (parent_span_id);
CREATE INDEX idx_punc_spans_actor ON punctuation_structure_spans (created_by_actor_id);
CREATE UNIQUE INDEX uq_punc_spans_parent_kind_ord ON punctuation_structure_spans (punctuation_version_id, parent_span_id, span_kind, ordinal) WHERE parent_span_id IS NOT NULL;
CREATE UNIQUE INDEX uq_punc_spans_root_kind_ord ON punctuation_structure_spans (punctuation_version_id, span_kind, ordinal) WHERE parent_span_id IS NULL;

CREATE TABLE punctuation_heads (
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  punctuation_set_id TEXT PRIMARY KEY REFERENCES punctuation_sets (id),
  current_version_id TEXT NOT NULL REFERENCES punctuation_versions (id),
  confirmed_version_id TEXT REFERENCES punctuation_versions (id),
  lock_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_punctuation_heads_project ON punctuation_heads (project_id);
CREATE INDEX idx_punctuation_heads_current ON punctuation_heads (current_version_id);
CREATE INDEX idx_punctuation_heads_confirmed ON punctuation_heads (confirmed_version_id);

CREATE TABLE translation_anchor_sets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_node_id TEXT NOT NULL REFERENCES document_nodes (id),
  source_text_version_id TEXT NOT NULL REFERENCES src_text_versions (id),
  punctuation_version_id TEXT NOT NULL REFERENCES punctuation_versions (id),
  strategy_key TEXT NOT NULL,
  strategy_version INTEGER NOT NULL,
  coverage_policy TEXT NOT NULL,
  anchor_set_hash TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_anchor_sets_project ON translation_anchor_sets (project_id);
CREATE INDEX idx_anchor_sets_node ON translation_anchor_sets (document_node_id);
CREATE INDEX idx_anchor_sets_source ON translation_anchor_sets (source_text_version_id);
CREATE INDEX idx_anchor_sets_actor ON translation_anchor_sets (created_by_actor_id);
CREATE UNIQUE INDEX uq_anchor_sets_strategy ON translation_anchor_sets (punctuation_version_id, strategy_key, strategy_version, coverage_policy);

CREATE TABLE translation_anchors (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  anchor_set_id TEXT NOT NULL REFERENCES translation_anchor_sets (id),
  anchor_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  boundary_kind TEXT NOT NULL,
  punctuation_codepoint_from INTEGER NOT NULL,
  punctuation_codepoint_to INTEGER NOT NULL,
  punctuated_quote TEXT NOT NULL,
  punctuated_quote_hash TEXT NOT NULL,
  source_codepoint_from INTEGER NOT NULL,
  source_codepoint_to INTEGER NOT NULL,
  source_quote TEXT NOT NULL,
  source_quote_hash TEXT NOT NULL,
  context_before_hash TEXT,
  context_after_hash TEXT,
  display_label TEXT,
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_translation_anchors_project ON translation_anchors (project_id);
CREATE UNIQUE INDEX uq_translation_anchors_ordinal ON translation_anchors (anchor_set_id, ordinal);
CREATE UNIQUE INDEX uq_translation_anchors_key ON translation_anchors (anchor_set_id, anchor_key);
CREATE INDEX idx_translation_anchors_punc_range ON translation_anchors (anchor_set_id, punctuation_codepoint_from, punctuation_codepoint_to);
CREATE INDEX idx_translation_anchors_src_range ON translation_anchors (anchor_set_id, source_codepoint_from, source_codepoint_to);

CREATE TABLE translation_anchor_structure_spans (
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  anchor_id TEXT NOT NULL REFERENCES translation_anchors (id),
  punctuation_structure_span_id TEXT NOT NULL REFERENCES punctuation_structure_spans (id),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (anchor_id, punctuation_structure_span_id)
) STRICT;

CREATE INDEX idx_anchor_span_bridge_project ON translation_anchor_structure_spans (project_id);
CREATE INDEX idx_anchor_span_bridge_span ON translation_anchor_structure_spans (punctuation_structure_span_id);
CREATE UNIQUE INDEX uq_anchor_span_bridge_ordinal ON translation_anchor_structure_spans (anchor_id, ordinal);
CREATE UNIQUE INDEX uq_anchor_span_bridge_span ON translation_anchor_structure_spans (anchor_id, punctuation_structure_span_id);

CREATE TABLE document_translations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_node_id TEXT NOT NULL REFERENCES document_nodes (id),
  source_text_id TEXT NOT NULL REFERENCES src_texts (id),
  target_locale TEXT NOT NULL,
  created_at TEXT NOT NULL,
  tombstoned_at TEXT
) STRICT;

CREATE INDEX idx_document_translations_project ON document_translations (project_id);
CREATE INDEX idx_document_translations_node ON document_translations (document_node_id);
CREATE UNIQUE INDEX uq_document_translations_locale ON document_translations (source_text_id, target_locale);

CREATE TABLE provenance_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  artifact_kind TEXT NOT NULL,
  media_type TEXT,
  payload_text TEXT,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  storage_asset_id TEXT REFERENCES src_assets (id),
  raw_sha256 TEXT NOT NULL,
  canonical_sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  schema_name TEXT,
  schema_version INTEGER,
  classification TEXT,
  retention_class TEXT,
  redaction_state TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_provenance_artifacts_project ON provenance_artifacts (project_id);
CREATE INDEX idx_provenance_artifacts_asset ON provenance_artifacts (storage_asset_id);
CREATE UNIQUE INDEX uq_provenance_artifacts_hash ON provenance_artifacts (project_id, artifact_kind, canonical_sha256);

CREATE TABLE chat_threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  title TEXT,
  scope_kind TEXT,
  scope_id TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_chat_threads_project ON chat_threads (project_id);
CREATE INDEX idx_chat_threads_actor ON chat_threads (created_by_actor_id);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  thread_id TEXT NOT NULL REFERENCES chat_threads (id),
  parent_message_id TEXT REFERENCES chat_messages (id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  actor_id TEXT REFERENCES core_actors (id),
  state TEXT,
  agent_id TEXT,
  requested_model TEXT,
  resolved_model TEXT,
  reasoning_level TEXT,
  service_tier TEXT,
  runtime_version TEXT,
  task_kind TEXT,
  output_contract TEXT,
  prompt_contract_version TEXT,
  request_manifest_json TEXT CHECK (request_manifest_json IS NULL OR json_valid(request_manifest_json)),
  request_manifest_hash TEXT,
  request_artifact_id TEXT REFERENCES provenance_artifacts (id),
  response_artifact_id TEXT REFERENCES provenance_artifacts (id),
  events_artifact_id TEXT REFERENCES provenance_artifacts (id),
  output_validation_state TEXT,
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_chat_messages_project ON chat_messages (project_id);
CREATE INDEX idx_chat_messages_thread_created ON chat_messages (thread_id, created_at);
CREATE INDEX idx_chat_messages_parent ON chat_messages (parent_message_id);
CREATE INDEX idx_chat_messages_actor ON chat_messages (actor_id);
CREATE INDEX idx_chat_messages_request_art ON chat_messages (request_artifact_id);
CREATE INDEX idx_chat_messages_response_art ON chat_messages (response_artifact_id);
CREATE INDEX idx_chat_messages_events_art ON chat_messages (events_artifact_id);

CREATE TABLE chat_message_parts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  message_id TEXT NOT NULL REFERENCES chat_messages (id),
  ordinal INTEGER NOT NULL,
  part_kind TEXT NOT NULL,
  text_content TEXT,
  structured_json TEXT CHECK (structured_json IS NULL OR json_valid(structured_json)),
  artifact_id TEXT REFERENCES provenance_artifacts (id)
) STRICT;

CREATE INDEX idx_chat_message_parts_project ON chat_message_parts (project_id);
CREATE INDEX idx_chat_message_parts_message ON chat_message_parts (message_id);
CREATE INDEX idx_chat_message_parts_artifact ON chat_message_parts (artifact_id);

CREATE TABLE chat_agent_sessions (
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  thread_id TEXT NOT NULL REFERENCES chat_threads (id),
  agent_id TEXT NOT NULL,
  model TEXT,
  cwd_hash TEXT,
  last_message_id TEXT REFERENCES chat_messages (id),
  stable_prompt_hash TEXT,
  state TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, agent_id)
) STRICT;

CREATE INDEX idx_chat_agent_sessions_project ON chat_agent_sessions (project_id);
CREATE INDEX idx_chat_agent_sessions_last ON chat_agent_sessions (last_message_id);
CREATE UNIQUE INDEX uq_chat_agent_sessions ON chat_agent_sessions (thread_id, agent_id);

CREATE TABLE document_translation_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_translation_id TEXT NOT NULL REFERENCES document_translations (id),
  parent_version_id TEXT REFERENCES document_translation_versions (id),
  version_no INTEGER NOT NULL,
  source_text_version_id TEXT NOT NULL REFERENCES src_text_versions (id),
  punctuation_version_id TEXT NOT NULL REFERENCES punctuation_versions (id),
  translation_anchor_set_id TEXT NOT NULL REFERENCES translation_anchor_sets (id),
  translation_policy_version_id TEXT NOT NULL REFERENCES core_translation_policy_versions (id),
  text_content TEXT NOT NULL,
  origin_kind TEXT NOT NULL,
  generated_by_message_id TEXT REFERENCES chat_messages (id),
  validation_state TEXT NOT NULL CHECK (validation_state IN ('valid', 'needs_review')),
  needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('draft', 'confirmed', 'rejected', 'superseded')),
  content_hash TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_dt_versions_project ON document_translation_versions (project_id);
CREATE INDEX idx_dt_versions_created ON document_translation_versions (document_translation_id, created_at);
CREATE INDEX idx_dt_versions_parent ON document_translation_versions (parent_version_id);
CREATE INDEX idx_dt_versions_source ON document_translation_versions (source_text_version_id);
CREATE INDEX idx_dt_versions_punc ON document_translation_versions (punctuation_version_id);
CREATE INDEX idx_dt_versions_anchor_set ON document_translation_versions (translation_anchor_set_id);
CREATE INDEX idx_dt_versions_policy ON document_translation_versions (translation_policy_version_id);
CREATE INDEX idx_dt_versions_actor ON document_translation_versions (created_by_actor_id);
CREATE INDEX idx_dt_versions_message ON document_translation_versions (generated_by_message_id);
CREATE UNIQUE INDEX uq_dt_versions_generation ON document_translation_versions (generated_by_message_id) WHERE generated_by_message_id IS NOT NULL;

CREATE TABLE document_translation_heads (
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_translation_id TEXT PRIMARY KEY REFERENCES document_translations (id),
  current_version_id TEXT NOT NULL REFERENCES document_translation_versions (id),
  confirmed_version_id TEXT REFERENCES document_translation_versions (id),
  lock_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX uq_document_translation_heads ON document_translation_heads (document_translation_id);
CREATE INDEX idx_dt_heads_project ON document_translation_heads (project_id);
CREATE INDEX idx_dt_heads_current ON document_translation_heads (current_version_id);
CREATE INDEX idx_dt_heads_confirmed ON document_translation_heads (confirmed_version_id);

CREATE TABLE translation_blocks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_translation_version_id TEXT NOT NULL REFERENCES document_translation_versions (id),
  block_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  block_kind TEXT NOT NULL,
  target_codepoint_from INTEGER NOT NULL,
  target_codepoint_to INTEGER NOT NULL,
  target_hash TEXT NOT NULL,
  validation_state TEXT NOT NULL CHECK (validation_state IN ('valid', 'needs_review'))
) STRICT;

CREATE INDEX idx_translation_blocks_project ON translation_blocks (project_id);
CREATE UNIQUE INDEX uq_translation_blocks_ordinal ON translation_blocks (document_translation_version_id, ordinal);
CREATE UNIQUE INDEX uq_translation_blocks_key ON translation_blocks (document_translation_version_id, block_key);

CREATE TABLE translation_block_anchors (
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  translation_block_id TEXT NOT NULL REFERENCES translation_blocks (id),
  translation_anchor_id TEXT NOT NULL REFERENCES translation_anchors (id),
  ordinal INTEGER NOT NULL,
  relation_kind TEXT NOT NULL DEFAULT 'full',
  confidence REAL,
  PRIMARY KEY (translation_block_id, translation_anchor_id)
) STRICT;

CREATE INDEX idx_tba_project ON translation_block_anchors (project_id);
CREATE INDEX idx_tba_anchor ON translation_block_anchors (translation_anchor_id);
CREATE UNIQUE INDEX uq_tba_ordinal ON translation_block_anchors (translation_block_id, ordinal);
CREATE UNIQUE INDEX uq_tba_anchor ON translation_block_anchors (translation_block_id, translation_anchor_id);

CREATE TABLE document_translation_validations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_translation_version_id TEXT NOT NULL REFERENCES document_translation_versions (id),
  source_message_id TEXT REFERENCES chat_messages (id),
  validator_version TEXT NOT NULL,
  result TEXT NOT NULL,
  needs_review INTEGER NOT NULL CHECK (needs_review IN (0, 1)),
  summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
  validated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_dt_validations_project ON document_translation_validations (project_id);
CREATE INDEX idx_dt_validations_version ON document_translation_validations (document_translation_version_id);
CREATE INDEX idx_dt_validations_message ON document_translation_validations (source_message_id);

CREATE TABLE document_translation_validation_findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  validation_id TEXT NOT NULL REFERENCES document_translation_validations (id),
  finding_kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  block_key TEXT,
  anchor_id TEXT REFERENCES translation_anchors (id),
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json))
) STRICT;

CREATE INDEX idx_dt_val_findings_project ON document_translation_validation_findings (project_id);
CREATE INDEX idx_dt_val_findings_validation ON document_translation_validation_findings (validation_id);
CREATE INDEX idx_dt_val_findings_anchor ON document_translation_validation_findings (anchor_id);

CREATE TABLE translation_staleness (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_translation_version_id TEXT NOT NULL REFERENCES document_translation_versions (id),
  cause_kind TEXT NOT NULL,
  old_dependency_id TEXT,
  new_dependency_id TEXT,
  detected_at TEXT NOT NULL,
  resolved_by_document_translation_version_id TEXT REFERENCES document_translation_versions (id)
) STRICT;

CREATE INDEX idx_translation_staleness_project ON translation_staleness (project_id);
CREATE INDEX idx_translation_staleness_version ON translation_staleness (document_translation_version_id);
CREATE INDEX idx_translation_staleness_resolved ON translation_staleness (resolved_by_document_translation_version_id);

CREATE TABLE glossary_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  source_term TEXT NOT NULL,
  target_locale TEXT NOT NULL,
  target_term TEXT NOT NULL,
  term_kind TEXT NOT NULL CHECK (term_kind IN ('general', 'office', 'book_title', 'institution', 'era', 'technical', 'other')),
  reading TEXT,
  note_md TEXT,
  usage_status TEXT NOT NULL CHECK (usage_status IN ('preferred', 'allowed', 'forbidden')),
  content_hash TEXT NOT NULL,
  lock_version INTEGER NOT NULL DEFAULT 1,
  created_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  updated_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
) STRICT;

CREATE INDEX idx_glossary_project ON glossary_entries (project_id);
CREATE INDEX idx_glossary_actors_c ON glossary_entries (created_by_actor_id);
CREATE INDEX idx_glossary_actors_u ON glossary_entries (updated_by_actor_id);
CREATE UNIQUE INDEX uq_glossary_triple ON glossary_entries (project_id, source_term, target_locale, target_term) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX uq_glossary_preferred ON glossary_entries (project_id, source_term, target_locale) WHERE usage_status = 'preferred' AND archived_at IS NULL;
CREATE INDEX idx_glossary_usage ON glossary_entries (project_id, source_term, usage_status) WHERE archived_at IS NULL;

CREATE TABLE places (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  preferred_name TEXT NOT NULL,
  hanja_name TEXT,
  reading TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json)),
  place_kind TEXT,
  location_note_md TEXT,
  description_md TEXT,
  content_hash TEXT NOT NULL,
  lock_version INTEGER NOT NULL DEFAULT 1,
  created_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  updated_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
) STRICT;

CREATE INDEX idx_places_project ON places (project_id);
CREATE INDEX idx_places_actors_c ON places (created_by_actor_id);
CREATE INDEX idx_places_actors_u ON places (updated_by_actor_id);
CREATE INDEX idx_places_active ON places (project_id) WHERE archived_at IS NULL;

CREATE TABLE uncertainties (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  category TEXT NOT NULL CHECK (category IN ('textual', 'interpretive', 'identification')),
  severity TEXT NOT NULL,
  blocking INTEGER NOT NULL DEFAULT 0 CHECK (blocking IN (0, 1)),
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_uncertainties_project ON uncertainties (project_id);

CREATE TABLE uncertainty_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  uncertainty_id TEXT NOT NULL REFERENCES uncertainties (id),
  parent_version_id TEXT REFERENCES uncertainty_versions (id),
  version_no INTEGER NOT NULL,
  statement_md TEXT NOT NULL,
  rationale_md TEXT,
  confidence_label TEXT,
  content_hash TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_uncertainty_versions_project ON uncertainty_versions (project_id);
CREATE INDEX idx_uncertainty_versions_unc ON uncertainty_versions (uncertainty_id);
CREATE INDEX idx_uncertainty_versions_parent ON uncertainty_versions (parent_version_id);
CREATE INDEX idx_uncertainty_versions_actor ON uncertainty_versions (created_by_actor_id);
CREATE UNIQUE INDEX uq_uncertainty_versions_number ON uncertainty_versions (uncertainty_id, version_no);

CREATE TABLE uncertainty_options (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  uncertainty_version_id TEXT NOT NULL REFERENCES uncertainty_versions (id),
  label TEXT NOT NULL,
  interpretation_md TEXT,
  ordinal INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_uncertainty_options_project ON uncertainty_options (project_id);
CREATE INDEX idx_uncertainty_options_version ON uncertainty_options (uncertainty_version_id);
CREATE UNIQUE INDEX uq_uncertainty_options_ordinal ON uncertainty_options (uncertainty_version_id, ordinal);

CREATE TABLE uncertainty_anchors (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  uncertainty_version_id TEXT NOT NULL REFERENCES uncertainty_versions (id),
  target_kind TEXT NOT NULL,
  target_version_id TEXT,
  codepoint_from INTEGER,
  codepoint_to INTEGER,
  quote TEXT,
  quote_hash TEXT
) STRICT;

CREATE INDEX idx_uncertainty_anchors_project ON uncertainty_anchors (project_id);
CREATE INDEX idx_uncertainty_anchors_version ON uncertainty_anchors (uncertainty_version_id);

CREATE TABLE context_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  item_kind TEXT NOT NULL,
  scope_kind TEXT,
  scope_id TEXT,
  title TEXT NOT NULL,
  content_md TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  content_hash TEXT NOT NULL,
  lock_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
) STRICT;

CREATE INDEX idx_context_items_project ON context_items (project_id);
CREATE INDEX idx_context_items_enabled ON context_items (project_id, enabled, priority) WHERE archived_at IS NULL;

CREATE TABLE provenance_lineage_edges (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  from_artifact_id TEXT NOT NULL REFERENCES provenance_artifacts (id),
  to_artifact_id TEXT NOT NULL REFERENCES provenance_artifacts (id),
  relation_kind TEXT NOT NULL,
  message_id TEXT REFERENCES chat_messages (id),
  ordinal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_lineage_project ON provenance_lineage_edges (project_id);
CREATE INDEX idx_lineage_from ON provenance_lineage_edges (from_artifact_id);
CREATE INDEX idx_lineage_to ON provenance_lineage_edges (to_artifact_id);
CREATE INDEX idx_lineage_message ON provenance_lineage_edges (message_id);

CREATE TABLE user_edits (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_translation_id TEXT REFERENCES document_translations (id),
  base_document_translation_version_id TEXT REFERENCES document_translation_versions (id),
  result_document_translation_version_id TEXT REFERENCES document_translation_versions (id),
  base_translation_block_id TEXT REFERENCES translation_blocks (id),
  target_codepoint_from INTEGER,
  target_codepoint_to INTEGER,
  base_artifact_id TEXT REFERENCES provenance_artifacts (id),
  result_artifact_id TEXT REFERENCES provenance_artifacts (id),
  patch_artifact_id TEXT REFERENCES provenance_artifacts (id),
  patch_format TEXT,
  edit_kind TEXT,
  reason TEXT,
  actor_id TEXT NOT NULL REFERENCES core_actors (id),
  client_version TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_user_edits_project ON user_edits (project_id);
CREATE INDEX idx_user_edits_dt ON user_edits (document_translation_id);
CREATE INDEX idx_user_edits_base_v ON user_edits (base_document_translation_version_id);
CREATE INDEX idx_user_edits_result_v ON user_edits (result_document_translation_version_id);
CREATE INDEX idx_user_edits_block ON user_edits (base_translation_block_id);
CREATE INDEX idx_user_edits_actor ON user_edits (actor_id);
CREATE INDEX idx_user_edits_base_art ON user_edits (base_artifact_id);
CREATE INDEX idx_user_edits_result_art ON user_edits (result_artifact_id);
CREATE INDEX idx_user_edits_patch_art ON user_edits (patch_artifact_id);

-- Rebuildable local full-text search index. Ledger/version tables remain the
-- source of truth; this table can be deleted and repopulated at any time.
CREATE VIRTUAL TABLE search_documents_fts USING fts5(
  project_id UNINDEXED,
  document_node_id UNINDEXED,
  result_kind UNINDEXED,
  aggregate_id UNINDEXED,
  version_id UNINDEXED,
  content_hash UNINDEXED,
  stage UNINDEXED,
  state UNINDEXED,
  is_current UNINDEXED,
  is_confirmed UNINDEXED,
  title,
  content,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '1 2'
);

CREATE TRIGGER trg_document_nodes_parent_container_insert
BEFORE INSERT ON document_nodes
WHEN NEW.parent_node_id IS NOT NULL
  AND (SELECT node_role FROM document_nodes WHERE id = NEW.parent_node_id) <> 'container'
BEGIN
  SELECT RAISE(ABORT, 'source_unit nodes cannot contain child nodes');
END;

CREATE TRIGGER trg_document_nodes_parent_container_update
BEFORE UPDATE OF parent_node_id ON document_nodes
WHEN NEW.parent_node_id IS NOT NULL
  AND (SELECT node_role FROM document_nodes WHERE id = NEW.parent_node_id) <> 'container'
BEGIN
  SELECT RAISE(ABORT, 'source_unit nodes cannot contain child nodes');
END;

CREATE TRIGGER trg_document_nodes_role_container
BEFORE UPDATE OF node_role ON document_nodes
WHEN NEW.node_role = 'container'
  AND EXISTS (SELECT 1 FROM src_texts source WHERE source.document_node_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'container nodes cannot contain source text');
END;

CREATE TRIGGER trg_document_nodes_role_source_unit
BEFORE UPDATE OF node_role ON document_nodes
WHEN NEW.node_role = 'source_unit'
  AND EXISTS (SELECT 1 FROM document_nodes child WHERE child.parent_node_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'source_unit nodes cannot contain child nodes');
END;

CREATE TRIGGER trg_src_texts_source_unit_insert
BEFORE INSERT ON src_texts
WHEN (SELECT node_role FROM document_nodes WHERE id = NEW.document_node_id) <> 'source_unit'
BEGIN
  SELECT RAISE(ABORT, 'container nodes cannot contain source text');
END;

CREATE TRIGGER trg_src_texts_source_unit_update
BEFORE UPDATE OF document_node_id ON src_texts
WHEN (SELECT node_role FROM document_nodes WHERE id = NEW.document_node_id) <> 'source_unit'
BEGIN
  SELECT RAISE(ABORT, 'container nodes cannot contain source text');
END;

CREATE TRIGGER trg_src_texts_one_active_insert
BEFORE INSERT ON src_texts
WHEN NEW.tombstoned_at IS NULL
  AND EXISTS (
    SELECT 1 FROM src_texts source
    WHERE source.document_node_id = NEW.document_node_id
      AND source.tombstoned_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'source_unit nodes can contain only one active source text');
END;

CREATE TRIGGER trg_src_texts_one_active_update
BEFORE UPDATE OF document_node_id, tombstoned_at ON src_texts
WHEN NEW.tombstoned_at IS NULL
  AND EXISTS (
    SELECT 1 FROM src_texts source
    WHERE source.document_node_id = NEW.document_node_id
      AND source.tombstoned_at IS NULL
      AND source.id <> NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'source_unit nodes can contain only one active source text');
END;

CREATE TRIGGER trg_anchor_sets_source_unit_insert
BEFORE INSERT ON translation_anchor_sets
WHEN (SELECT node_role FROM document_nodes WHERE id = NEW.document_node_id) <> 'source_unit'
BEGIN
  SELECT RAISE(ABORT, 'container nodes cannot contain translation anchors');
END;

CREATE TRIGGER trg_document_translations_source_unit_insert
BEFORE INSERT ON document_translations
WHEN (SELECT node_role FROM document_nodes WHERE id = NEW.document_node_id) <> 'source_unit'
BEGIN
  SELECT RAISE(ABORT, 'container nodes cannot contain translations');
END;

CREATE TRIGGER trg_document_nodes_master_shape_insert
BEFORE INSERT ON document_nodes
WHEN NEW.is_master = 1
  AND (NEW.parent_node_id IS NOT NULL OR NEW.node_role <> 'container' OR NEW.archived_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'project master must be an active root container');
END;

CREATE TRIGGER trg_document_nodes_only_master_root_insert
BEFORE INSERT ON document_nodes
WHEN NEW.parent_node_id IS NULL AND NEW.is_master <> 1
BEGIN
  SELECT RAISE(ABORT, 'all document nodes must be inside the project master');
END;

CREATE TRIGGER trg_document_nodes_only_master_root_update
BEFORE UPDATE OF parent_node_id, is_master ON document_nodes
WHEN NEW.parent_node_id IS NULL AND NEW.is_master <> 1
BEGIN
  SELECT RAISE(ABORT, 'all document nodes must be inside the project master');
END;

CREATE TRIGGER trg_document_nodes_master_immutable
BEFORE UPDATE OF parent_node_id, node_role, is_master, archived_at ON document_nodes
WHEN OLD.is_master = 1
  AND (
    NEW.parent_node_id IS NOT NULL OR
    NEW.node_role <> 'container' OR
    NEW.is_master <> 1 OR
    NEW.archived_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'project master cannot be moved, archived, or changed from a container');
END;

CREATE TRIGGER trg_document_nodes_master_delete
BEFORE DELETE ON document_nodes
WHEN OLD.is_master = 1
BEGIN
  SELECT RAISE(ABORT, 'project master cannot be deleted');
END;

CREATE TRIGGER trg_context_items_document_scope_insert
BEFORE INSERT ON context_items
WHEN COALESCE(NEW.scope_kind, '') <> 'document_node'
  OR NEW.scope_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM document_nodes node
    WHERE node.id = NEW.scope_id AND node.project_id = NEW.project_id AND node.archived_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'context items must belong to a document container or source unit');
END;

CREATE TRIGGER trg_context_items_document_scope_update
BEFORE UPDATE OF project_id, scope_kind, scope_id ON context_items
WHEN COALESCE(NEW.scope_kind, '') <> 'document_node'
  OR NEW.scope_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM document_nodes node
    WHERE node.id = NEW.scope_id AND node.project_id = NEW.project_id AND node.archived_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'context items must belong to a document container or source unit');
END;

CREATE TRIGGER trg_uncertainty_versions_owner_insert
BEFORE INSERT ON uncertainty_versions
WHEN NOT EXISTS (
  SELECT 1 FROM uncertainties uncertainty
  WHERE uncertainty.id = NEW.uncertainty_id
    AND uncertainty.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'uncertainty version must belong to its project uncertainty');
END;

CREATE TRIGGER trg_uncertainty_versions_parent_insert
BEFORE INSERT ON uncertainty_versions
WHEN NEW.parent_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM uncertainty_versions parent
    WHERE parent.id = NEW.parent_version_id
      AND parent.project_id = NEW.project_id
      AND parent.uncertainty_id = NEW.uncertainty_id
      AND parent.version_no < NEW.version_no
  )
BEGIN
  SELECT RAISE(ABORT, 'uncertainty version parent must be an earlier version of the same uncertainty');
END;

CREATE TRIGGER trg_uncertainty_options_owner_insert
BEFORE INSERT ON uncertainty_options
WHEN NOT EXISTS (
  SELECT 1 FROM uncertainty_versions version
  WHERE version.id = NEW.uncertainty_version_id
    AND version.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'uncertainty option must belong to its project version');
END;

CREATE TRIGGER trg_uncertainty_anchors_owner_insert
BEFORE INSERT ON uncertainty_anchors
WHEN NOT EXISTS (
  SELECT 1 FROM uncertainty_versions version
  WHERE version.id = NEW.uncertainty_version_id
    AND version.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'uncertainty anchor must belong to its project version');
END;
