CREATE TABLE document_translation_versions_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_translation_id TEXT NOT NULL REFERENCES document_translations (id),
  parent_version_id TEXT REFERENCES document_translation_versions (id),
  version_no INTEGER NOT NULL,
  source_text_version_id TEXT NOT NULL REFERENCES src_text_versions (id),
  punctuation_version_id TEXT REFERENCES punctuation_versions (id),
  translation_anchor_set_id TEXT REFERENCES translation_anchor_sets (id),
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

INSERT INTO document_translation_versions_new SELECT * FROM document_translation_versions;
DROP TABLE document_translation_versions;
ALTER TABLE document_translation_versions_new RENAME TO document_translation_versions;
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


CREATE TABLE translation_text_layouts (
 version_id TEXT PRIMARY KEY REFERENCES document_translation_versions(id),
 alignment_state TEXT NOT NULL DEFAULT 'pending' CHECK(alignment_state IN ('pending','running','ready','needs_review','failed')),
 sentences_json TEXT NOT NULL CHECK(json_valid(sentences_json)),
 links_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(links_json)),
 alignment_request TEXT,
 alignment_response TEXT,
 alignment_error TEXT,
 skill_manifest_json TEXT NOT NULL CHECK(json_valid(skill_manifest_json))
) STRICT;
UPDATE meta_project_state SET schema_version=2;
